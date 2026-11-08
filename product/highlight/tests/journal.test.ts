// product/highlight — the job journal.
//
// This file is tested in isolation because its whole job is surviving the two
// situations that are awkward to stage in a host test: a process killed
// mid-append, and a file somebody has since edited. Both are one function call
// away here.
//
// The assertions are deliberately about behaviour a reader can check against the
// file: how many lines, which state comes back, whether a death is counted twice.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { asInterrupted, JobJournal } from '../packages/host/highlight/src/jobs-journal.ts'
import type { HighlightJob } from '../packages/host/highlight/src/index.ts'

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'vhl-journal-')), 'jobs.jsonl')
}

/** A clock that moves one second per read, so `atMs` is deterministic and distinct. */
function clock(start = 1_700_000_000_000): () => number {
  let t = start
  return () => {
    t += 1000
    return t
  }
}

function job(over: Partial<HighlightJob> = {}): HighlightJob {
  return {
    jobId: 'job-1',
    state: 'running',
    stage: 'vision',
    progress: 0.4,
    input: '/media/in.mp4',
    output: '/media/out/clip.mp4',
    error: '',
    createdAtMs: 1_000,
    startedAtMs: 1_100,
    finishedAtMs: null,
    durationSec: 600,
    fps: 25,
    segmentCount: 0,
    srtPath: '',
    reportPath: '',
    segments: [],
    ...over,
  }
}

describe('round trip', () => {
  it('replays a finished job with its segments intact', () => {
    const file = tmpFile()
    const writer = new JobJournal({ file, now: clock() })
    const succeeded = job({
      jobId: 'done',
      state: 'succeeded',
      stage: 'done',
      progress: 1,
      finishedAtMs: 2_000,
      segmentCount: 1,
      segments: [{ startSec: 12, endSec: 18, score: 0.87, signals: { audioRms: 0.9, sceneCut: 0.2 } }],
    })
    expect(writer.append(succeeded)).toBe(true)

    const read = new JobJournal({ file, now: clock() }).replay()
    expect(read.dropped).toBe(0)
    expect(read.interrupted).toBe(0)
    expect(read.jobs).toHaveLength(1)
    // The timeline must survive: a restored succeeded job that cannot draw its
    // segments is a row that says "done" and shows nothing.
    expect(read.jobs[0]!.segments).toEqual(succeeded.segments)
    expect(read.jobs[0]!.state).toBe('succeeded')
    expect(read.jobs[0]!.output).toBe(succeeded.output)
  })

  it('starts empty when the file does not exist', () => {
    const read = new JobJournal({ file: join(tmpdir(), 'vhl-nope', 'x.jsonl') }).replay()
    expect(read).toEqual({ jobs: [], read: 0, dropped: 0, interrupted: 0 })
  })

  it('returns jobs oldest first', () => {
    const file = tmpFile()
    const writer = new JobJournal({ file, now: clock() })
    writer.append(job({ jobId: 'b', createdAtMs: 2_000 }))
    writer.append(job({ jobId: 'a', createdAtMs: 1_000 }))
    expect(new JobJournal({ file }).replay().jobs.map((j) => j.jobId)).toEqual(['a', 'b'])
  })
})

describe('what gets written', () => {
  it('writes nothing when a poll observed nothing new', () => {
    const file = tmpFile()
    const writer = new JobJournal({ file, now: clock() })
    expect(writer.append(job())).toBe(true)
    expect(writer.append(job())).toBe(false)
    expect(writer.append(job())).toBe(false)
    expect(writer.size()).toBe(1)

    // A real change is a real event.
    expect(writer.append(job({ progress: 0.5 }))).toBe(true)
    expect(writer.size()).toBe(2)
  })

  it('keeps segments out of a running job line', () => {
    const file = tmpFile()
    new JobJournal({ file, now: clock() }).append(job({
      state: 'running',
      segments: [{ startSec: 1, endSec: 2, score: 0.5, signals: {} }],
    }))
    // A heartbeat carrying a 30-segment array is how a 40 KB journal becomes
    // megabytes without a reader.
    expect(readFileSync(file, 'utf8')).not.toContain('segments')
  })
})

describe('a process that died mid-job', () => {
  it('reports a running job as interrupted, and says how far it got', () => {
    const file = tmpFile()
    new JobJournal({ file, now: clock() }).append(job({ progress: 0.42 }))

    const read = new JobJournal({ file, now: clock() }).replay()
    expect(read.interrupted).toBe(1)
    const restored = read.jobs[0]!
    expect(restored.state).toBe('interrupted')
    expect(restored.stage).toBe('interrupted')
    // The job did not fail — the host left. The message must not accuse the job.
    expect(restored.error).toContain('42%')
    expect(restored.error).toContain('宿主')
    // A finished time is set so retention and duration math have something to use.
    expect(restored.finishedAtMs).not.toBeNull()
  })

  it('counts a death once, not once per boot', () => {
    const file = tmpFile()
    new JobJournal({ file, now: clock() }).append(job({ progress: 0.42 }))

    expect(new JobJournal({ file, now: clock() }).replay().interrupted).toBe(1)
    // The first replay persisted the interrupted state; a second boot must not
    // re-announce the same crash, or the gauge climbs with uptime instead of
    // measuring anything.
    expect(new JobJournal({ file, now: clock() }).replay().interrupted).toBe(0)
    // The row itself is still there — history, not an event.
    expect(new JobJournal({ file, now: clock() }).replay().jobs[0]!.state).toBe('interrupted')
  })

  it('does not touch a job that already finished', () => {
    const settled = job({ state: 'cancelled', finishedAtMs: 5_000 })
    expect(asInterrupted(settled, 9_999)).toBe(settled)
  })
})

describe('a file that cannot be trusted', () => {
  it('drops a torn last line and keeps the rest', () => {
    const file = tmpFile()
    const writer = new JobJournal({ file, now: clock() })
    writer.append(job({ jobId: 'good', state: 'succeeded', finishedAtMs: 2_000 }))
    // Exactly what a killed append leaves behind.
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"v":1,"jobId":"torn"`, 'utf8')

    const drops: string[] = []
    const read = new JobJournal({ file, onDrop: (r) => drops.push(r) }).replay()
    expect(read.read).toBe(2)
    expect(read.dropped).toBe(1)
    expect(read.jobs.map((j) => j.jobId)).toEqual(['good'])
    expect(drops).toHaveLength(1)
  })

  it('drops a corrupt middle line without losing its neighbours', () => {
    const file = tmpFile()
    writeFileSync(file, [
      'not json at all',
      JSON.stringify({ v: 1, atMs: 1, jobId: 'kept', state: 'succeeded', createdAtMs: 10 }),
      '',
      '{"v":1}',
    ].join('\n'))

    const read = new JobJournal({ file }).replay()
    expect(read.dropped).toBe(2)
    expect(read.jobs.map((j) => j.jobId)).toEqual(['kept'])
  })

  it('refuses a record from a shape it does not understand', () => {
    const file = tmpFile()
    // A future version may mean something different by the same field names;
    // guessing is worse than dropping one row.
    writeFileSync(file, JSON.stringify({ v: 99, jobId: 'future', state: 'succeeded' }))
    const read = new JobJournal({ file }).replay()
    expect(read.jobs).toEqual([])
    expect(read.dropped).toBe(1)
  })

  it('survives an unwritable location instead of failing the job', () => {
    const blocker = join(mkdtempSync(join(tmpdir(), 'vhl-block-')), 'not-a-dir')
    writeFileSync(blocker, 'x')
    const errors: string[] = []
    const writer = new JobJournal({
      file: join(blocker, 'jobs.jsonl'),
      onError: (reason) => errors.push(reason),
    })
    // Persistence is bookkeeping; it must never become a dependency of the work.
    expect(writer.append(job())).toBe(false)
    expect(errors).toHaveLength(1)
  })
})

describe('compaction', () => {
  it('keeps the newest records and replaces the file atomically', () => {
    const file = tmpFile()
    const writer = new JobJournal({ file, keep: 2, now: clock() })
    for (let i = 0; i < 5; i += 1) {
      writer.append(job({ jobId: `j${i}`, state: 'succeeded', createdAtMs: 1_000 + i, finishedAtMs: 2_000 + i }))
    }
    expect(writer.compact()).toBe(2)
    // tmp + rename: a crash mid-compaction must leave the old file, never an empty one.
    expect(existsSync(`${file}.tmp`)).toBe(false)
    const rows = readFileSync(file, 'utf8').trim().split('\n')
    expect(rows).toHaveLength(2)
    expect(new JobJournal({ file }).replay().jobs.map((j) => j.jobId)).toEqual(['j3', 'j4'])
  })

  it('compacts automatically once the line ceiling is reached', () => {
    const file = tmpFile()
    const writer = new JobJournal({ file, keep: 2, maxRecords: 4, now: clock() })
    for (let i = 0; i < 6; i += 1) {
      writer.append(job({ jobId: `j${i}`, createdAtMs: 1_000 + i, progress: 0.1 * i }))
    }
    expect(writer.size()).toBeLessThanOrEqual(4)
    expect(readFileSync(file, 'utf8').trim().split('\n').length).toBeLessThanOrEqual(4)
  })

  it('forgets a pruned job so it does not resurrect on the next boot', () => {
    const file = tmpFile()
    const writer = new JobJournal({ file, keep: 0, now: clock() })
    writer.append(job({ jobId: 'gone', state: 'succeeded', finishedAtMs: 2_000 }))
    writer.append(job({ jobId: 'stays', state: 'succeeded', createdAtMs: 1_500, finishedAtMs: 2_500 }))

    writer.forget('gone')
    // Retention pruned the artifact directory; a record pointing at nothing is a
    // row that lies. The rewrite happens on the next write, not immediately.
    writer.append(job({ jobId: 'stays', state: 'succeeded', createdAtMs: 1_500, finishedAtMs: 2_500, error: 'touched' }))
    expect(new JobJournal({ file }).replay().jobs.map((j) => j.jobId)).toEqual(['stays'])
  })
})

describe('layout', () => {
  it('creates the parent directory on first write', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vhl-nested-')), 'a', 'b', 'jobs.jsonl')
    mkdirSync(join(file, '..', '..'), { recursive: true })
    expect(new JobJournal({ file, now: clock() }).append(job())).toBe(true)
    expect(existsSync(file)).toBe(true)
  })

  it('writes one JSON object per line and nothing else', () => {
    const file = tmpFile()
    new JobJournal({ file, now: clock() }).append(job())
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(1)
    expect(() => JSON.parse(lines[0]!)).not.toThrow()
  })
})
