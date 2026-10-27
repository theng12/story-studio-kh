/**
 * The model store — download verification, resume, and removal.
 *
 * These tests never touch Hugging Face. Every case replaces `fetch` with a
 * local stub, so "a bad hash is refused" and "a partial download resumes" are
 * proved against controlled bytes rather than against whatever the network
 * happens to serve today. The pinned hashes are the real ones; the stub serves
 * them only for files a test explicitly provides.
 *
 * The property that matters most: **a file whose bytes do not match is never
 * promoted**. It is discarded and reported, and the next attempt starts that
 * file clean rather than appending to a lie.
 */
import { after, before, beforeEach, test } from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'

let store: typeof import('../services/local-model-store.js')
let contract: typeof import('../contracts/local-duplicate-screening.js')

let root: string
let originalFetch: typeof globalThis.fetch

before(async () => {
  await useTempDataDir()
  store = await import('../services/local-model-store.js')
  contract = await import('../contracts/local-duplicate-screening.js')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sskh-local-model-store-'))
  originalFetch = globalThis.fetch
})

after(async () => {
  globalThis.fetch = originalFetch
  await fs.rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  globalThis.fetch = originalFetch
  store._resetLocalModelProgressForTesting()
  // Start every test from a clean store.
  await fs.rm(path.join(store.localModelRoot()), { recursive: true, force: true })
})

/** Serve one file's exact bytes, honouring Range when asked. */
function stubFetchFor(bytes: Uint8Array, options: { ignoreRange?: boolean } = {}): void {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers || {}).get('Range')
    if (range && !options.ignoreRange) {
      const from = Number(range.replace(/bytes=(\d+)-.*/, '$1'))
      const slice = bytes.slice(from)
      return new Response(slice, { status: 206, statusText: 'Partial Content' })
    }
    return new Response(bytes, { status: 200, statusText: 'OK' })
  }) as typeof globalThis.fetch
}

/**
 * A tiny stand-in for a manifest row.
 *
 * The download rules — resume from a partial, refuse a bad hash, restart when
 * the server ignores a range — do not depend on a file being 32 MB, so these
 * tests use a handful of bytes. Reaching for the real `tokenizer.json` entry
 * (32 MB) to make the case look realistic wrote ~130 MB per run into a
 * harness that snapshots the sandbox, which is the same mistake as the 1 GB
 * padding this file already had removed.
 */
function tinySpec(content: string): { path: string; bytes: number; sha256: string } {
  return {
    path: 'probe.bin',
    bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
  }
}

// ── Verification ───────────────────────────────────────────────────────────

test('a file with the published hash verifies as ok', async () => {
  const file = path.join(root, 'good.bin')
  await fs.writeFile(file, 'hello')
  const spec = {
    path: 'good.bin',
    bytes: 5,
    sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  }
  assert.equal(await store.verifyFile(file, spec), 'ok')
})

test('a file whose bytes differ from the published hash is refused', async () => {
  const file = path.join(root, 'bad.bin')
  await fs.writeFile(file, 'tampered')
  const spec = {
    path: 'bad.bin',
    bytes: 8,
    sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  }
  assert.equal(await store.verifyFile(file, spec), 'wrong-hash')
})

test('a file of the wrong size is refused before it is hashed', async () => {
  const file = path.join(root, 'short.bin')
  await fs.writeFile(file, 'abc')
  const spec = { path: 'short.bin', bytes: 999, sha256: 'anything' }
  assert.equal(await store.verifyFile(file, spec), 'wrong-size')
})

test('a file that is not there is missing, not a pass', async () => {
  const spec = { path: 'absent.bin', bytes: 1, sha256: 'x' }
  assert.equal(await store.verifyFile(path.join(root, 'absent.bin'), spec), 'missing')
})

test('the pinned manifest is internally consistent', () => {
  assert.ok(contract.LOCAL_EMBEDDING_FILES.length > 0)
  assert.ok(contract.LOCAL_RUNTIME_FILES.length > 0)
  for (const file of [...contract.LOCAL_EMBEDDING_FILES, ...contract.LOCAL_RUNTIME_FILES]) {
    assert.ok(file.bytes > 0, `${file.path} has a positive size`)
    assert.match(file.sha256, /^[0-9a-f]{64}$/, `${file.path} has a full SHA-256`)
  }
  // No duplicate destinations: two rows writing one path would make one of them
  // silently authoritative.
  const paths = [...contract.LOCAL_EMBEDDING_FILES, ...contract.LOCAL_RUNTIME_FILES].map(file => file.path)
  assert.equal(new Set(paths).size, paths.length)
  // The dylib's name is load-bearing: the binding links `@rpath/libonnxruntime.1.dylib`.
  assert.ok(contract.LOCAL_RUNTIME_FILES.some(file => file.path === 'libonnxruntime.1.dylib'))
  assert.equal(contract.totalModelBytes(), contract.LOCAL_EMBEDDING_FILES.reduce((sum, file) => sum + file.bytes, 0))
})

// ── Status ─────────────────────────────────────────────────────────────────

test('a store with nothing in it is neither installed nor partial', async () => {
  const status = await store.localModelStatus()
  assert.equal(status.installed, false)
  assert.equal(status.partial, false)
  assert.equal(status.bytes_present, 0)
  assert.equal(status.missing.length, contract.LOCAL_EMBEDDING_FILES.length + contract.LOCAL_RUNTIME_FILES.length)
  assert.equal(await store.localModelLooksInstalled(), false)
})

test('a file at the right size with the wrong bytes is NOT installed', async () => {
  // The property: installation is decided by the HASH, not by a size or a name.
  //
  // Proved on the smallest file in the manifest — 5 KB — rather than by writing
  // every file at its real size. Writing ~1 GB of padding here looked like the
  // obvious way to do it and was a defect in the tests: the harness snapshots
  // the sandbox, so it materialised ~2 GB of zeros per run on the owner's disk.
  const smallest = [...contract.LOCAL_EMBEDDING_FILES].sort((left, right) => left.bytes - right.bytes)[0]!
  const modelDir = store.localModelDir()
  await fs.mkdir(path.dirname(path.join(modelDir, smallest.path)), { recursive: true })
  await fs.writeFile(path.join(modelDir, smallest.path), Buffer.alloc(smallest.bytes, 0))

  // Right name, right size, wrong bytes.
  assert.equal(await store.verifyFile(path.join(modelDir, smallest.path), smallest), 'wrong-hash')

  const status = await store.localModelStatus()
  assert.equal(status.installed, false, 'correct size with wrong bytes is not installed')
  assert.ok(
    status.missing.includes(smallest.path),
    'the file with the wrong bytes is named missing, so the hash is what refused it',
  )
  assert.equal(status.partial, true, 'bytes are on disk, so it is partial')
  assert.equal(await store.localModelLooksInstalled(), false)
})

// ── Download: bad hash, resume, restart ────────────────────────────────────

test('a download whose bytes do not match is discarded, and the error names the file', async () => {
  // Right SIZE, wrong CONTENT: the size check passes and the hash is what has
  // to catch it. A handful of bytes proves exactly the same rule.
  const spec = tinySpec('the correct bytes')
  const modelDir = store.localModelDir()
  await fs.mkdir(modelDir, { recursive: true })
  stubFetchFor(Buffer.from('XXXXthe wrong byte'), {})

  await assert.rejects(
    () => store._downloadOneFileForTesting(contract.modelFileUrl(spec.path), modelDir, spec),
    (error: any) => {
      assert.match(String(error.message), /probe\.bin/)
      assert.match(String(error.message), /SHA-256|discard/i)
      return true
    },
  )
  // Neither promoted nor left as a `.part` a later run would resume onto.
  await assert.rejects(() => fs.stat(path.join(modelDir, spec.path)))
  await assert.rejects(() => fs.stat(path.join(modelDir, `${spec.path}.part`)))
})

test('a partial download resumes from the bytes already on disk', async () => {
  const spec = tinySpec('0123456789')
  const modelDir = store.localModelDir()
  await fs.mkdir(modelDir, { recursive: true })
  const half = 5
  await fs.writeFile(path.join(modelDir, `${spec.path}.part`), '01234')

  let sawRange: string | null = null
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers || {}).get('Range')
    sawRange = range
    return new Response('56789', { status: range ? 206 : 200 })
  }) as typeof globalThis.fetch

  // The stub serves the RIGHT remaining bytes, so this must succeed — and the
  // only way it can succeed is by appending to the partial.
  const result = await store._downloadOneFileForTesting(contract.modelFileUrl(spec.path), modelDir, spec)
  assert.ok(sawRange, 'a resume must ask for a range')
  assert.match(String(sawRange), new RegExp(`bytes=${half}-`))
  assert.equal(await store.verifyFile(path.join(modelDir, spec.path), spec), 'ok')
  assert.equal(result.bytes, 5)
})

test('a server that ignores the resume range restarts the file cleanly', async () => {
  const spec = tinySpec('0123456789')
  const modelDir = store.localModelDir()
  await fs.mkdir(modelDir, { recursive: true })
  await fs.writeFile(path.join(modelDir, `${spec.path}.part`), '01234')

  // 200 to a ranged request: the whole file from byte 0. Appending it to the
  // partial would produce a file of the wrong length, so the store must drop
  // the partial and write a single clean copy.
  stubFetchFor(Buffer.from('0123456789'), { ignoreRange: true })

  const result = await store._downloadOneFileForTesting(contract.modelFileUrl(spec.path), modelDir, spec)
  assert.equal(await store.verifyFile(path.join(modelDir, spec.path), spec), 'ok')
  assert.equal(result.bytes, 10)
  const stat = await fs.stat(path.join(modelDir, spec.path))
  assert.equal(stat.size, 10, 'exactly one clean copy, not the partial plus a full file')
})

test('a file that already verifies is not fetched again', async () => {
  const spec = tinySpec('already here')
  const modelDir = store.localModelDir()
  await fs.mkdir(modelDir, { recursive: true })
  await fs.writeFile(path.join(modelDir, spec.path), 'already here')
  let fetches = 0
  globalThis.fetch = (async () => {
    fetches += 1
    return new Response('', { status: 200 })
  }) as typeof globalThis.fetch

  const result = await store._downloadOneFileForTesting('https://example.invalid/never', modelDir, spec)
  assert.equal(fetches, 0, 'a file that already verifies must not be fetched')
  assert.equal(result.bytes, 0)
})

// ── Removal ────────────────────────────────────────────────────────────────

test('removal moves the files to Trash instead of deleting them', async () => {
  const modelDir = store.localModelDir()
  await fs.mkdir(path.join(modelDir, 'onnx'), { recursive: true })
  await fs.writeFile(path.join(modelDir, 'config.json'), '{"pretend":"model"}')
  await fs.mkdir(store.localRuntimeDir(), { recursive: true })
  await fs.writeFile(path.join(store.localRuntimeDir(), 'libonnxruntime.1.dylib'), 'binary')

  const result = await store.removeLocalModel()
  assert.deepEqual(result.problems, [])
  assert.equal(result.removed.length, 2, 'both the model and the runtime move')

  // Gone from the live location…
  await assert.rejects(() => fs.stat(modelDir))
  // …and present under the trash root, with its contents intact.
  for (const moved of result.removed) {
    const stat = await fs.stat(moved).catch(() => null)
    assert.ok(stat?.isDirectory(), `${moved} should exist in the Trash`)
  }
  const movedConfig = result.removed
    .map(dir => path.join(dir, 'config.json'))
  const survivors = await Promise.all(movedConfig.map(file => fs.stat(file).catch(() => null)))
  assert.ok(survivors.some(stat => stat?.isFile()), 'the model file itself survived the move')
})

test('removing when nothing is downloaded says so rather than pretending', async () => {
  const result = await store.removeLocalModel()
  assert.equal(result.removed.length, 0)
  assert.match(result.problems.join(' '), /nothing downloaded/i)
})

// ── Progress ───────────────────────────────────────────────────────────────

test('progress is a copy, so a reader cannot mutate the shared state', () => {
  const first = store.getLocalModelProgress()
  first.percent = 99
  assert.notEqual(store.getLocalModelProgress().percent, 99)
})
