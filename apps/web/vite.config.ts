import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build output (dist/) is served by the Node host. During `vite dev`, proxy the
// control plane (WS /rpc) and data plane (/api) to the running host.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/rpc': { target: 'ws://127.0.0.1:3088', ws: true },
      '/api': { target: 'http://127.0.0.1:3088' },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
})
