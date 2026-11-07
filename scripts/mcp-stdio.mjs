#!/usr/bin/env node
// MCP stdio bridge — speaks the stdio transport (newline-delimited JSON-RPC,
// what Claude Desktop / Cursor spawn) and forwards every request to the host's
// Streamable HTTP MCP endpoint over HTTP POST.
//
// Why this exists: an MCP client that cannot natively speak Streamable HTTP
// can still drive the host's tool surface — it spawns THIS as the "server",
// and each request becomes one POST to /mcp. Responses come back on stdout in
// arrival order (JSON-RPC over stdio does not require ordering).
//
// Environment:
//   MEDIABASE_URL       host base (default http://127.0.0.1:3088)
//   MEDIABASE_TOKEN     ${prefix}TOKEN value, when the deployment set one
//   MEDIABASE_MCP_PATH  endpoint path   (default /mcp)
//
// stdio framing: one JSON message per line; notifications (no id) are
// forwarded but never answered, per the transport.

import { createInterface } from 'node:readline'

const base = (process.env.MEDIABASE_URL ?? 'http://127.0.0.1:3088').replace(/\/+$/, '')
const token = process.env.MEDIABASE_TOKEN
const path = process.env.MEDIABASE_MCP_PATH ?? '/mcp'
const url = `${base}${path}${token !== undefined && token !== '' ? `?token=${encodeURIComponent(token)}` : ''}`

const reply = (id, payload) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`)
}

const forward = async (msg) => {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) })
    const text = await res.text()
    if (text !== '') reply(msg.id, JSON.parse(text))
    // An empty 202 body was a notification acknowledgement: nothing to answer.
  } catch (e) {
    reply(msg.id, { error: { code: -32603, message: `mcp-stdio: 无法连接 ${url}(${e instanceof Error ? e.message : String(e)})` } })
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed === '') return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return // not a JSON line: the stdio transport carries nothing else, ignore
  }
  if (msg === null || typeof msg !== 'object' || msg.id === undefined || msg.id === null) return
  void forward(msg)
})
