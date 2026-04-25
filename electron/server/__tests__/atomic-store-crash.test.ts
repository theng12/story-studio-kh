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

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
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
