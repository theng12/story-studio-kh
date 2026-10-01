/**
 * A file response lets go of the file when the client goes away, and survives a read error.
 *
 * `createReadStream(file).pipe(res)` left the source open (and its file descriptor with it) when the
 * response closed early: 30 aborted downloads measured 30 open descriptors. macOS gives a GUI app 256,
 * so scrubbing a video preview for a session ends in EMFILE. `pipe` also had no 'error' listener, so a
 * file removed mid-read was an uncaught exception.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { streamTo } from '../lib/stream-file.js'
import { waitFor } from './_timing.js'

test('the source is destroyed when the client aborts, with a real file and a real socket', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stream-file-')), 'big.bin')
  fs.writeFileSync(file, Buffer.alloc(8 * 1024 * 1024, 1))
  const sources: fs.ReadStream[] = []
  const server = http.createServer((_req, res) => {
    const source = fs.createReadStream(file)
    sources.push(source)
    streamTo(res, source)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  try {
    for (let i = 0; i < 5; i++) {
      await new Promise<void>(resolve => {
        const req = http.get({ port, host: '127.0.0.1' }, res => { res.once('data', () => { req.destroy(); resolve() }) })
        req.on('error', () => {})
      })
    }
    await waitFor(() => sources.length === 5 && sources.every(source => source.destroyed), { label: 'aborted downloads to release their files' })
    assert.equal(sources.length, 5)
    assert.ok(sources.every(source => source.destroyed), 'every aborted download released its file')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('a read error is contained: no uncaught exception, the response is torn down', async () => {
  const res = new PassThrough()
  const source = new Readable({ read() { this.destroy(Object.assign(new Error('EIO: read failed'), { code: 'EIO' })) } })
  let uncaught: unknown = null
  const onUncaught = (error: unknown) => { uncaught = error }
  process.once('uncaughtException', onUncaught)
  const warn = console.warn
  const warnings: string[] = []
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }
  try {
    streamTo(res as any, source)
    await waitFor(() => res.destroyed && warnings.length > 0, { label: 'the response to be torn down and the failure logged' })
    assert.equal(uncaught, null)
    assert.equal(res.destroyed, true)
    assert.match(warnings.join('\n'), /file response failed: EIO/)
  } finally {
    console.warn = warn
    process.off('uncaughtException', onUncaught)
  }
})
