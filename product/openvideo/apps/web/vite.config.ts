import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build output (dist/) is served by the OpenVideo host. During `vite dev`,
// proxy the control plane (WS /rpc) and data plane (/api) to it — the product
// bundle moves the default port to 3090 so a base host can run beside it.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5174,
    proxy: {
      '/rpc': { target: 'ws://127.0.0.1:3090', ws: true },
      '/api': { target: 'http://127.0.0.1:3090' },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
})
