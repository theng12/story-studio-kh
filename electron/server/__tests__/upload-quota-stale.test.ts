/**
 * Stale-ledger tests for upload-quota — per-account JSONL edition.
 *
 * Pins the M2 fix from audit-reports/10-uploads.md, but adapted to the
 * post-migration storage layout: stale state lives in
 * `<userData>/youtube-quota/<accountId>.meta.json`, not in the project's
 * config.json. The behavioural contract is the same:
 *
 *   1. recordQuotaUsage THROWS on append failure (caller logs).
 *   2. recordQuotaUsage attempts to set `stale: true` in the meta file
 *      so the UI can warn even when the failure is silent.
 *   3. recordQuotaUsage clears that flag on the next successful append.
 *   4. readQuota surfaces `stale: true` so the upload page chip can
 *      render the muted-yellow state.
 *
 * We exercise the real code paths against a temp-dir project. The "make
 * the append fail" trick is to replace the `<accountId>.jsonl` file with
 * a directory of the same name — fs.appendFile then rejects with EISDIR,
 * which is a deterministic stand-in for "disk full / lock contention /
 * permissions drift".
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let quotaMod: typeof import('../services/upload-quota.js')

const TEST_ACCOUNT_ID = 'test-account-uuid'

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  quotaMod = await import('../services/upload-quota.js')
})

after(async () => { await cleanup() })

beforeEach(async () => {
  const projectsDir = path.join(tempDir, 'projects')
  const quotaDir = path.join(tempDir, 'youtube-quota')
  await fs.rm(projectsDir, { recursive: true, force: true })
  await fs.rm(quotaDir, { recursive: true, force: true })
  await fs.mkdir(projectsDir, { recursive: true })
  quotaMod.__resetQuotaCache()
})

async function makeProjectWithAccount(name: string): Promise<string> {
  const p = await pm.createProject({ name })
  await pm.updateConfig(p.slug, {
    upload_default_account: { youtube: TEST_ACCOUNT_ID },
  } as any)
  return p.slug
}

function metaFilePath(): string {
  return path.join(tempDir, 'youtube-quota', `${TEST_ACCOUNT_ID}.meta.json`)
}

function ledgerFilePath(): string {
  return path.join(tempDir, 'youtube-quota', `${TEST_ACCOUNT_ID}.jsonl`)
}

describe('readQuota — stale flag surfacing', () => {
  test('returns stale: true when meta file says so', async () => {
    const slug = await makeProjectWithAccount('StaleRead')
    await fs.mkdir(path.dirname(metaFilePath()), { recursive: true })
    await fs.writeFile(metaFilePath(), JSON.stringify({ stale: true }))

    const snap = await quotaMod.readQuota(slug)
    assert.equal(snap.stale, true, 'readQuota must surface the persisted stale flag')
  })

  test('returns stale: false when meta file is absent', async () => {
    const slug = await makeProjectWithAccount('StaleAbsent')
    const snap = await quotaMod.readQuota(slug)
    assert.notEqual(snap.stale, true, 'fresh account should not look stale')
  })

  test('returns stale: false when flag is explicitly false', async () => {
    const slug = await makeProjectWithAccount('StaleFalse')
    await fs.mkdir(path.dirname(metaFilePath()), { recursive: true })
    await fs.writeFile(metaFilePath(), JSON.stringify({ stale: false, ceiling: 10000 }))
    const snap = await quotaMod.readQuota(slug)
    assert.notEqual(snap.stale, true)
  })
})

describe('recordQuotaUsage — clears stale flag on success', () => {
  test('a successful ledger append resets stale to false', async () => {
    const slug = await makeProjectWithAccount('StaleClear')
    // Plant a stale flag as if a prior append had failed.
    await fs.mkdir(path.dirname(metaFilePath()), { recursive: true })
    await fs.writeFile(metaFilePath(), JSON.stringify({ stale: true }))
    let snap = await quotaMod.readQuota(slug)
    assert.equal(snap.stale, true, 'precondition: flag is set')

    // A successful recordQuotaUsage should clear it.
    await quotaMod.recordQuotaUsage(slug, 'videos_update')

    snap = await quotaMod.readQuota(slug)
    assert.notEqual(snap.stale, true, 'stale flag should be cleared after a successful append')
    assert.equal(snap.used, 50, 'videos_update costs 50 units; ledger advanced')
  })

  test('repeated successful appends keep stale flag clear', async () => {
    const slug = await makeProjectWithAccount('StaleRepeat')
    await quotaMod.recordQuotaUsage(slug, 'videos_update')
    await quotaMod.recordQuotaUsage(slug, 'videos_update')
    const snap = await quotaMod.readQuota(slug)
    assert.notEqual(snap.stale, true)
    assert.equal(snap.used, 100)
  })
})

describe('recordQuotaUsage — propagates write failures instead of swallowing', () => {
  test('throws when the JSONL append fails', async () => {
    // M2 fix proof: the old `.catch(() => {})` in youtube-client.ts hid
    // exactly this kind of failure. With the new behaviour, recordQuotaUsage
    // surfaces the error so the call site can log it and so the meta file
    // gets marked stale.
    const slug = await makeProjectWithAccount('StaleThrow')

    // Replace `<accountId>.jsonl` (a file that doesn't exist yet) with a
    // directory of the same name. fs.appendFile then rejects with EISDIR
    // — a deterministic stand-in for disk full / lock contention.
    await fs.mkdir(path.dirname(ledgerFilePath()), { recursive: true })
    await fs.mkdir(ledgerFilePath())

    await assert.rejects(
      () => quotaMod.recordQuotaUsage(slug, 'videos_insert'),
      /EISDIR|illegal operation|directory/i,
      'recordQuotaUsage must propagate the underlying append error'
    )

    // The meta file should now carry the stale flag so the chip warns.
    // We read it directly rather than via readQuota, because readQuota's
    // ledger read would also hit EISDIR in this contrived setup.
    const metaText = await fs.readFile(metaFilePath(), 'utf-8')
    const meta = JSON.parse(metaText)
    assert.equal(meta.stale, true, 'failed append must mark the meta stale')
  })
})
