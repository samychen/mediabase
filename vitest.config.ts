// mediabase / vitest config — unit + integration suites in tests/.
// Integration tests spawn real processes (engine binary, whole host), so time
// out generously. Files inside a file run sequentially (default). Client-shell
// suites opt into jsdom with a `// @vitest-environment jsdom` docblock.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    // Half the cores, not all-but-one. Measured on an 8-core machine: with the
    // default 7 forks every test passed and the run still exited 1, because a
    // worker's `onTaskUpdate` ack missed vitest's 60s RPC window while the box was
    // saturated — a red gate that named no failing test. At `50%` the same suite is
    // clean. It costs nothing where it matters: a 2-core CI runner gets 1 worker,
    // which is what it already had.
    maxWorkers: '50%',
  },
})
