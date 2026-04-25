/**
 * Stale-ledger tests for upload-quota.
 *
 * Pins the M2 fix from audit-reports/10-uploads.md: a swallowed
 * `recordQuotaUsage` failure used to leave the local "X / 10,000 used"
 * banner stale while YouTube's real counter ticked up. The fix:
 *   1. recordQuotaUsage now THROWS on write failure (caller logs).
 *   2. recordQuotaUsage attempts to set `youtube_quota_ledger_stale: true`
 *      in config.json so the UI can warn even when the failure is silent.
 *   3. recordQuotaUsage clears that flag on the next successful write.
 *   4. readQuota surfaces `stale: true` so the upload page shows a badge.
 *
 * We can't cleanly mock `pm.updateConfig` here — ES module namespaces are
 * frozen, so mock.method on the imported namespace is a no-go. Instead we
 * exercise the real code paths against a temp-dir project:
 *   - planting the flag through pm.updateConfig and checking readQuota
 *     surfaces it (covers the "stale-true is visible to UI" path)
 *   - calling recordQuotaUsage on a clean ledger and checking the flag is
 *     cleared (covers the "successful write clears stale" path)
 *   - corrupting config.json into a directory so the read-modify-write
 *     fails, and checking recordQuotaUsage throws rather than silently
 *     swallowing (covers the "no more silent failure" path).
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
  await fs.rm(projectsDir, { recursive: true, force: true })
  await fs.mkdir(projectsDir, { recursive: true })
})

describe('readQuota — stale flag surfacing', () => {
  test('returns stale: true when youtube_quota_ledger_stale is true in config', async () => {
    const p = await pm.createProject({ name: 'StaleRead' })
    await pm.updateConfig(p.slug, { youtube_quota_ledger_stale: true } as any)

    const snap = await quotaMod.readQuota(p.slug)
    assert.equal(snap.stale, true, 'readQuota must surface the persisted stale flag')
  })

  test('returns stale: false when flag is absent', async () => {
    const p = await pm.createProject({ name: 'StaleAbsent' })
    const snap = await quotaMod.readQuota(p.slug)
    assert.notEqual(snap.stale, true, 'fresh project should not look stale')
  })

  test('returns stale: false when flag is explicitly false', async () => {
    const p = await pm.createProject({ name: 'StaleFalse' })
    await pm.updateConfig(p.slug, { youtube_quota_ledger_stale: false } as any)
    const snap = await quotaMod.readQuota(p.slug)
    assert.notEqual(snap.stale, true)
  })

  test('stale flag is preserved across the day-rollover branch of readQuota', async () => {
    // The "tracking_day rolled over" branch returns a fresh-snapshot object;
    // make sure we don't lose the stale flag in that path.
    const p = await pm.createProject({ name: 'StaleRollover' })
    await pm.updateConfig(p.slug, {
      youtube_quota: { used: 9000, ceiling: 10000, tracking_day: '1999-01-01' },
      youtube_quota_ledger_stale: true,
    } as any)
    const snap = await quotaMod.readQuota(p.slug)
    assert.equal(snap.used, 0, 'old day should reset to zero')
    assert.equal(snap.stale, true, 'stale flag still surfaces after day reset')
  })
})

describe('recordQuotaUsage — clears stale flag on success', () => {
  test('a successful ledger write resets youtube_quota_ledger_stale to false', async () => {
    const p = await pm.createProject({ name: 'StaleClear' })
    // Plant a stale flag as if a prior write had failed.
    await pm.updateConfig(p.slug, { youtube_quota_ledger_stale: true } as any)
    let snap = await quotaMod.readQuota(p.slug)
    assert.equal(snap.stale, true, 'precondition: flag is set')

    // A successful recordQuotaUsage should clear it.
    await quotaMod.recordQuotaUsage(p.slug, 'videos_update')

    snap = await quotaMod.readQuota(p.slug)
    assert.notEqual(snap.stale, true, 'stale flag should be cleared after a successful write')
    assert.equal(snap.used, 50, 'videos_update costs 50 units; ledger advanced')
  })

  test('repeated successful writes keep stale flag clear', async () => {
    const p = await pm.createProject({ name: 'StaleRepeat' })
    await quotaMod.recordQuotaUsage(p.slug, 'videos_update')
    await quotaMod.recordQuotaUsage(p.slug, 'videos_update')
    const snap = await quotaMod.readQuota(p.slug)
    assert.notEqual(snap.stale, true)
    assert.equal(snap.used, 100)
  })
})

describe('recordQuotaUsage — propagates write failures instead of swallowing', () => {
  test('throws when config.json read-modify-write fails', async () => {
    // M2 fix proof: the old `.catch(() => {})` in youtube-client.ts hid
    // exactly this kind of failure. With the new behaviour, recordQuotaUsage
    // surfaces the error so the call site can log it and so the per-route
    // wrapper can mark the ledger stale.
    const p = await pm.createProject({ name: 'StaleThrow' })
    const configPath = path.join(tempDir, 'projects', p.slug, 'config.json')

    // Replace config.json (a regular file) with a directory of the same
    // name. existsSync() still returns true, so updateConfig enters the
    // read-modify-write branch — and then fs.readFile rejects with EISDIR.
    // This is a deterministic stand-in for "disk full / lock contention /
    // permissions drift" — the audit-reports/10-uploads.md M2 scenario.
    await fs.unlink(configPath)
    await fs.mkdir(configPath)

    await assert.rejects(
      () => quotaMod.recordQuotaUsage(p.slug, 'videos_insert'),
      /EISDIR|illegal operation|directory/i,
      'recordQuotaUsage must propagate the underlying write error'
    )
  })
})
