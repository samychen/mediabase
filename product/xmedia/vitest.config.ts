// product/xmedia / vitest config — the product's own suites (tests/).
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
})
