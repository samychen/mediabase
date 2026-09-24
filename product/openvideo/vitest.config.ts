// product/openvideo / vitest config — the product's own suites (tests/).
// `root` pins the project so the repo-root script
// (`vitest run --config product/openvideo/vitest.config.ts`) collects exactly
// these tests and never the base suite. Client suites opt into jsdom with a
// `// @vitest-environment jsdom` docblock, like the base does.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
})
