/**
 * 1.4.415 — a transfer longer than 300 s must import.
 *
 * The defect was two wall clocks set to the SAME 300 000 ms: `download-video.ts` aborted the transfer
 * there, and the final-render phase ceiling raced the same phase at the same instant. So a large
 * render could never import, and the row named whichever timer fired first — a stall while the file
 * was still arriving.
 *
 * This test uses a REAL clock on purpose. A fake one would prove that a fake clock fires, not that a
 * five-minute transfer finishes: the assertion is that a server which keeps sending bytes for longer
 * than the old bound produces a complete file. **It takes about five and a half minutes** and is in
 * `SERIAL_TEST_FILES` for that reason.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { downloadVideo, DOWNLOAD_IDLE_TIMEOUT_MS } from '../lib/download-video.js'

const OLD_CEILING_MS = 300_000
/** Comfortably past the old bound, so a passing test cannot be an artefact of timer rounding. */
const TRANSFER_MS = OLD_CEILING_MS + 6_000
const CHUNK_BYTES = 64
const CHUNK_EVERY_MS = 1_000

test('a transfer that keeps delivering bytes for longer than the old 300 s ceiling completes', { timeout: TRANSFER_MS + 120_000 }, async () => {
  const started = Date.now()
  const expectedChunks = Math.ceil(TRANSFER_MS / CHUNK_EVERY_MS)

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4', connection: 'close' })
    let sent = 0
    const timer = setInterval(() => {
      res.write(Buffer.alloc(CHUNK_BYTES))
      sent += 1
      if (sent >= expectedChunks) {
        clearInterval(timer)
        res.end()
      }
    }, CHUNK_EVERY_MS)
    res.on('close', () => clearInterval(timer))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'download-idle-'))
  const dest = path.join(dir, 'transfer.mp4')
  try {
    await downloadVideo(`http://127.0.0.1:${port}/render.mp4`, dest)
    const elapsed = Date.now() - started
    const stat = await fs.stat(dest)
    assert.ok(elapsed > OLD_CEILING_MS, `the transfer really took longer than the old ceiling (${elapsed} ms)`)
    assert.equal(stat.size, expectedChunks * CHUNK_BYTES, 'every byte the server sent is on disk')
    assert.equal(stat.size > 0, true)
  } finally {
    ;(server as any).closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a transfer that stops delivering bytes is aborted at the idle bound, not left running', async () => {
  // The idle bound is shortened here on purpose: the mechanism is what this proves, and the
  // production value is asserted below so the two cannot drift apart.
  assert.equal(DOWNLOAD_IDLE_TIMEOUT_MS >= 60_000, true, 'the production idle bound stays generous')
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4', connection: 'close' })
    res.write(Buffer.alloc(CHUNK_BYTES)) // one chunk, then silence and no end
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'download-idle-stall-'))
  const dest = path.join(dir, 'stalled.mp4')
  const started = Date.now()
  try {
    await assert.rejects(
      () => downloadVideo(`http://127.0.0.1:${port}/render.mp4`, dest, undefined, undefined, { idleTimeoutMs: 700 }),
      /stalled|aborted|abort/i,
    )
    assert.ok(Date.now() - started < 30_000, 'the stall is noticed by the idle bound, not by a test timeout')
    await assert.rejects(() => fs.stat(dest), 'no partial file is left behind')
  } finally {
    ;(server as any).closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await fs.rm(dir, { recursive: true, force: true })
  }
})
