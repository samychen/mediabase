// avstudio / vitest config — unit + integration suites in tests/.
// Integration tests spawn real processes (engine binary, whole host), so time
// out generously. Files inside a file run sequentially (default). Client-shell
// suites opt into jsdom with a `// @vitest-environment jsdom` docblock.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
})
