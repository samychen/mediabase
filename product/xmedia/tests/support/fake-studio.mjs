// A Node stand-in for the HF Studio server (the vendored Python
// hf_studio.py --serve). It speaks just enough of the Studio's surface for
// the capability suite: `/` (the editor page) and `/api/projects` (the Home
// management API). The real server is exercised by scripts/verify.mjs when
// python3 is present. Test double, not a second implementation.
import { createServer } from 'node:http'

// The capability spawns: node fake-studio.mjs --serve --home --port <n> —
// parse the FLAG, not a positional (argv[2] is '--serve').
const argv = process.argv.slice(2)
const portIdx = argv.indexOf('--port')
const port = Number((portIdx >= 0 ? argv[portIdx + 1] : undefined) ??
  process.env.FAKE_STUDIO_PORT ?? 8120)
const server = createServer((req, res) => {
  const url = req.url ?? '/'
  if (url === '/api/projects') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ projects: [] }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><body><h1>fake hf-studio</h1></body></html>')
})
server.listen(port, '127.0.0.1')
