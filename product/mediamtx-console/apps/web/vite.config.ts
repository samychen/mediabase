import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build output (dist/) is served by the console host. During `vite dev`,
// proxy the control plane (WS /rpc) and data plane (/api) to it — the product
// bundle moves the default port to 3091 so a base host (:3088) and the
// OpenVideo host (:3090) can run beside it.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5175,
    proxy: {
      '/rpc': { target: 'ws://127.0.0.1:3091', ws: true },
      '/api': { target: 'http://127.0.0.1:3091' },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
})
