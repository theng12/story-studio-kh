/**
 * Crash-cleanup invariant for `writeJsonAtomic` (Session 02 M11).
 *
 * The writer's contract: stringify → fsync → rename. If `rename` fails (disk
 * full, EXDEV, permission flip), the half-written `.tmp` sibling MUST be
 * unlinked before the error propagates. Otherwise repeated writes pile up
 * orphan tmp files in the data dir, and a later disk-full read of the
 * project folder gets noisier and noisier.
 *
 * We monkey-patch `fs.rename` to throw ENOSPC and assert:
 *   1. the original error propagates verbatim (no "Internal" wrapping),
 *   2. no `.tmp` sibling remains in the directory after the throw,
 *   3. a subsequent successful write contains the new payload — i.e. the
 *      orphan tmp wasn't somehow promoted in place of the real write.
 */

import { spawn } from 'node:child_process'
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let store: typeof import('../lib/atomic-store.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  store = await import('../lib/atomic-store.js')
})

after(async () => { await cleanup() })

beforeEach(async () => {
  // Each test gets a fresh subdir so the orphan-scan assertions can't see
  // tmp files left by other tests.
  await fs.rm(path.join(tempDir, 'crash'), { recursive: true, force: true })
  await fs.mkdir(path.join(tempDir, 'crash'), { recursive: true })
})

async function siblingTmpFiles(target: string): Promise<string[]> {
  const dir = path.dirname(target)
  const base = path.basename(target)
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  // The writer names tmp files `<basename>.<pid>.<ts>.<rand>.tmp`.
  return entries.filter(e => e.startsWith(`${base}.`) && e.endsWith('.tmp'))
}

describe('writeJsonAtomic — rename failure cleanup', () => {
  test('rejects with original error and unlinks the .tmp sibling', async () => {
    const target = path.join(tempDir, 'crash', 'a.json')
    const origRename = fs.rename.bind(fs)
    const enospc: any = new Error('ENOSPC: no space left on device')
    enospc.code = 'ENOSPC'
    ;(fs as any).rename = async (src: string, dest: string) => {
      // Only sabotage the final tmp → target rename. Directory creation
      // doesn't go through fs.rename, but we keep the filter strict so
      // any nested rename in the writer is handled deterministically.
      if (typeof dest === 'string' && dest === target) throw enospc
      return origRename(src, dest)
    }

    try {
      await assert.rejects(
        () => store.writeJsonAtomic(target, { value: 'first' }),
        (err: any) => {
          assert.equal(err.code, 'ENOSPC', 'original error must propagate verbatim')
          assert.match(String(err.message), /ENOSPC/)
          return true
        },
      )
    } finally {
      ;(fs as any).rename = origRename
    }

    // Target file must NOT exist (rename never landed).
    await assert.rejects(() => fs.stat(target), /ENOENT/)
    // No orphan tmp sibling left behind.
    const tmps = await siblingTmpFiles(target)
    assert.deepEqual(tmps, [], 'no .tmp sibling should remain after a failed rename')
  })

  test('writeFile ENOSPC mid-write: rejects + no target file lands + later write succeeds', async () => {
    // Audit gap: only the rename-ENOSPC path was covered. If the initial
    // tmp-file write itself fails (disk full at the moment of write), we
    // need to confirm: (a) the error propagates verbatim — caller can decide
    // what to do, and (b) no target file lands at the canonical path, so
    // the next read still sees the old (or no) value rather than a
    // partial/empty file.
    const target = path.join(tempDir, 'crash', 'c.json')
    // Pre-existing payload so we can prove the canonical file isn't touched.
    await store.writeJsonAtomic(target, { value: 'pre-existing' })

    const origWriteFile = fs.writeFile.bind(fs)
    const enospc: any = new Error('ENOSPC: no space left on device')
    enospc.code = 'ENOSPC'
    ;(fs as any).writeFile = async (...args: any[]) => {
      // Sabotage only writes to .tmp siblings of our target — leaves the
      // rest of the test infra alone (mkdtemp / colliding files in this
      // file's other tests still need real writeFile).
      const dest = String(args[0])
      if (dest.startsWith(target + '.') && dest.endsWith('.tmp')) throw enospc
      return origWriteFile(...args as Parameters<typeof origWriteFile>)
    }

    try {
      await assert.rejects(
        () => store.writeJsonAtomic(target, { value: 'doomed' }),
        (err: any) => {
          assert.equal(err.code, 'ENOSPC', 'original ENOSPC propagates verbatim')
          return true
        },
      )
    } finally {
      ;(fs as any).writeFile = origWriteFile
    }

    // Canonical target still holds the pre-existing payload — atomic-write's
    // load-bearing promise: a failed write doesn't truncate the live file.
    const txt = await fs.readFile(target, 'utf-8')
    assert.equal(JSON.parse(txt).value, 'pre-existing')

    // Recovery write succeeds normally.
    await store.writeJsonAtomic(target, { value: 'recovered' })
    const txt2 = await fs.readFile(target, 'utf-8')
    assert.equal(JSON.parse(txt2).value, 'recovered')
  })

  test('subsequent successful write produces the new payload (no stale revival)', async () => {
    const target = path.join(tempDir, 'crash', 'b.json')

    // 1. First write fails partway with ENOSPC on rename.
    const origRename = fs.rename.bind(fs)
    const enospc: any = new Error('ENOSPC: no space left on device')
    enospc.code = 'ENOSPC'
    ;(fs as any).rename = async (src: string, dest: string) => {
      if (typeof dest === 'string' && dest === target) throw enospc
      return origRename(src, dest)
    }
    try {
      await assert.rejects(
        () => store.writeJsonAtomic(target, { value: 'stale-payload' }),
      )
    } finally {
      ;(fs as any).rename = origRename
    }

    // No orphan tmp survived the failure.
    assert.deepEqual(await siblingTmpFiles(target), [])

    // 2. Second write succeeds normally.
    await store.writeJsonAtomic(target, { value: 'fresh-payload' })

    const txt = await fs.readFile(target, 'utf-8')
    const parsed = JSON.parse(txt)
    assert.equal(parsed.value, 'fresh-payload', 'live file must contain the second write, not the failed-attempt payload')
    // And no tmp sibling lingers after the successful path either.
    assert.deepEqual(await siblingTmpFiles(target), [])
  })
})

test('withCrossProcessLock serializes one read-modify-write across processes', async () => {
  const target = path.join(tempDir, 'crash', 'shared.json')
  const ready = path.join(tempDir, 'crash', 'ready')
  const release = path.join(tempDir, 'crash', 'release')
  await store.writeJsonAtomic(target, { initial: true })
  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'atomic-store-lock-worker.ts')
  const child = spawn(process.execPath, ['--import', 'tsx', worker], {
    env: { ...process.env, TARGET: target, READY: ready, RELEASE: release },
    stdio: 'pipe',
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = new Promise<void>((resolve, reject) => {
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`lock worker exited ${code}: ${stderr}`)))
  })
  await Promise.race([
    (async () => {
      while (true) {
        try { await fs.stat(ready); return } catch { await new Promise(resolve => setTimeout(resolve, 5)) }
      }
    })(),
    exited.then(() => { throw new Error('lock worker exited before release') }),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('lock worker did not become ready')), 2_000)),
  ])

  const mainWrite = store.withCrossProcessLock(target, async () => {
    const current = JSON.parse(await fs.readFile(target, 'utf8'))
    await store.writeJsonAtomic(target, { ...current, main: true })
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { initial: true })
  await fs.writeFile(release, 'release')
  await exited
  await mainWrite

  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { initial: true, worker: true, main: true })
})

test('withCrossProcessLock removes its private temporary file when lock publication fails', async () => {
  const target = path.join(tempDir, 'crash', 'publication.json')
  const originalLink = fs.link.bind(fs)
  const failure = Object.assign(new Error('synthetic link failure'), { code: 'ENOSPC' })
  ;(fs as any).link = async (from: string, to: string) => {
    if (to === `${target}.lock`) throw failure
    return originalLink(from, to)
  }
  try {
    await assert.rejects(store.withCrossProcessLock(target, async () => {}), (error: unknown) => error === failure)
  } finally {
    ;(fs as any).link = originalLink
  }
  assert.deepEqual((await fs.readdir(path.dirname(target))).filter(name => name.includes('publication.json.lock')), [])
})

test('withCrossProcessLock removes its own published lock when directory sync fails', async () => {
  const target = path.join(tempDir, 'crash', 'directory-sync.json')
  const directoryPath = path.dirname(target)
  const originalOpen = fs.open.bind(fs)
  const failure = Object.assign(new Error('synthetic directory sync failure'), { code: 'EIO' })
  let workCalls = 0
  let injected = false
  ;(fs as any).open = async (file: string, flags: string, ...rest: unknown[]) => {
    if (!injected && file === directoryPath && flags === 'r') {
      injected = true
      throw failure
    }
    return (originalOpen as any)(file, flags, ...rest)
  }
  try {
    await assert.rejects(store.withCrossProcessLock(target, async () => { workCalls += 1 }), (error: unknown) => error === failure)
  } finally {
    ;(fs as any).open = originalOpen
  }
  assert.equal(workCalls, 0)
  await assert.rejects(fs.stat(`${target}.lock`), /ENOENT/)
  await store.withCrossProcessLock(target, async () => { workCalls += 1 })
  assert.equal(workCalls, 1)
})
