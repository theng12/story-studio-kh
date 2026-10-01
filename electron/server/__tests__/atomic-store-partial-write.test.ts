/**
 * A write that dies half-way must not leave its temp file behind, and a compact write is compact.
 *
 * `writeFile` onto a nearly full disk writes SOME bytes and then fails with ENOSPC. The writer only
 * cleaned up after a failed rename, so that partial `.tmp` (megabytes, for jobs.json) stayed on the
 * volume; the queue retries the write, each retry stranded another one and the shortage got worse.
 * The existing crash test stubs `writeFile` to throw before writing anything, which is why it never
 * saw this.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let store: typeof import('../lib/atomic-store.js')

before(async () => {
  const temp = await useTempDataDir()
  tempDir = temp.dir
  cleanup = temp.cleanup
  store = await import('../lib/atomic-store.js')
})
after(async () => { await cleanup() })

test('a writeFile that fails after writing some bytes leaves no .tmp behind and keeps the old file', async () => {
  const dir = path.join(tempDir, 'partial')
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, 'jobs.json')
  await store.writeJsonAtomic(target, { value: 'old' })

  const realWriteFile = fs.writeFile.bind(fs)
  ;(fs as any).writeFile = async (file: string, data: string | Buffer, ...rest: any[]) => {
    if (String(file).endsWith('.tmp')) {
      await realWriteFile(file, String(data).slice(0, 16), ...rest) // the part that fit
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    }
    return realWriteFile(file, data, ...rest)
  }
  try {
    await assert.rejects(() => store.writeJsonAtomic(target, { value: 'x'.repeat(10_000) }), { code: 'ENOSPC' })
  } finally {
    ;(fs as any).writeFile = realWriteFile
  }
  assert.deepEqual((await fs.readdir(dir)).sort(), ['jobs.json'], 'only the real file remains')
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { value: 'old' })
})

test('compact writes one line of JSON that reads back identically; the default stays indented', async () => {
  const dir = path.join(tempDir, 'compact')
  await fs.mkdir(dir, { recursive: true })
  const value = { jobs: [{ id: 'a', lines: ['x', 'y'] }, { id: 'b', lines: [] }] }
  await store.writeJsonAtomic(path.join(dir, 'compact.json'), value, { compact: true })
  await store.writeJsonAtomic(path.join(dir, 'pretty.json'), value)
  const compact = await fs.readFile(path.join(dir, 'compact.json'), 'utf8')
  const pretty = await fs.readFile(path.join(dir, 'pretty.json'), 'utf8')
  assert.equal(compact.trimEnd().split('\n').length, 1)
  assert.ok(pretty.split('\n').length > 5)
  assert.deepEqual(JSON.parse(compact), value)
  assert.deepEqual(JSON.parse(pretty), value)
})
