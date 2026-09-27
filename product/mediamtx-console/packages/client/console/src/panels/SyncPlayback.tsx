import React, { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { RecordingSegment } from '@mtxconsole/protocol';

export function SyncPlayback() {
  const { sync, setSync } = useStore();
  const videosRef = useRef<(HTMLVideoElement | null)[]>([]);
  const rafRef = useRef<number>();

  // 全局主时钟驱动 (requestAnimationFrame)
  useEffect(() => {
    let lastTs = performance.now();
    const loop = (now: number) => {
      if (sync.playing) {
        const dt = now - lastTs;
        const newGlobalTime = sync.globalTime + dt;
        const maxTime = sync.masterDuration * 1000;
        setSync({ globalTime: Math.min(newGlobalTime, maxTime) });
        if (newGlobalTime >= maxTime) setSync({ playing: false });
      }
      lastTs = now;
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current!);
  }, [sync.playing, sync.globalTime, sync.masterDuration, setSync]);

  // 将全局时间映射到各个 video 元素的 currentTime
  useEffect(() => {
    sync.slots.forEach((seg, i) => {
      const video = videosRef.current[i];
      if (!video || !seg) return;
      
      const relTime = (sync.globalTime - seg.startTime) / 1000;
      if (relTime >= 0 && relTime <= seg.duration) {
        if (Math.abs(video.currentTime - relTime) > 0.5) {
          video.currentTime = relTime;
        }
        if (sync.playing && video.paused) video.play().catch(() => {});
        if (!sync.playing && !video.paused) video.pause();
      } else {
        if (!video.paused) video.pause();
      }
    });
  }, [sync.globalTime, sync.slots, sync.playing]);

  const handleDrop = (e: React.DragEvent, slotIndex: number) => {
    e.preventDefault();
    try {
      const segData = JSON.parse(e.dataTransfer.getData('text/plain'));
      const newSlots = [...sync.slots];
      newSlots[slotIndex] = segData;
      
      // 自动计算全局时间轴范围
      let minStart = Infinity, maxEnd = 0;
      newSlots.forEach(s => {
        if (s) {
          minStart = Math.min(minStart, s.startTime);
          maxEnd = Math.max(maxEnd, s.startTime + s.duration * 1000);
        }
      });
      
      setSync({ 
        slots: newSlots,
        masterStart: minStart === Infinity ? 0 : minStart,
        masterDuration: (maxEnd - minStart) / 1000,
        globalTime: 0 
      });
    } catch {}
  };

  const gridCols = sync.layout === 1 ? 1 : sync.layout === 4 ? 2 : 3;

  return (
    <div className="flex flex-col h-full p-4 gap-4 bg-[var(--bg)]">
      <div className="flex items-center gap-4 bg-[var(--panel)] p-3 rounded-lg border border-[var(--border)]">
        <button 
          onClick={() => setSync({ playing: !sync.playing })}
          className="px-4 py-1 bg-[var(--accent)] text-white rounded hover:opacity-90"
        >
          {sync.playing ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <input 
          type="range" 
          min={0} 
          max={sync.masterDuration * 1000 || 1} 
          value={sync.globalTime} 
          onChange={(e) => setSync({ globalTime: Number(e.target.value), playing: false })}
          className="flex-1 accent-[var(--accent)]"
        />
        <select 
          value={sync.layout} 
          onChange={(e) => setSync({ layout: Number(e.target.value) as any })}
          className="bg-[var(--inset)] border border-[var(--border)] rounded px-2 py-1"
        >
          <option value={1}>1x1 单画面</option>
          <option value={4}>2x2 四宫格</option>
          <option value={9}>3x3 九宫格</option>
        </select>
      </div>
      
      <div 
        className="flex-1 grid gap-2" 
        style={{ gridTemplateColumns: `repeat(${gridCols}, 1fr)` }}
      >
        {Array.from({ length: sync.layout }).map((_, i) => (
          <div 
            key={i}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => handleDrop(e, i)}
            className="bg-black border-2 border-dashed border-[var(--border)] flex items-center justify-center relative overflow-hidden rounded"
          >
            {sync.slots[i] ? (
              <>
                <video 
                  ref={(el) => { videosRef.current[i] = el; }}
                  src={sync.slots[i].playbackUrl}
                  className="w-full h-full object-contain"
                  muted
                  playsInline
                />
                <div className="absolute top-2 left-2 bg-black/60 text-white text-xs px-2 py-1 rounded">
                  {sync.slots[i].path}
                </div>
              </>
            ) : (
              <span className="text-[var(--muted)]">从录像列表拖入片段</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
