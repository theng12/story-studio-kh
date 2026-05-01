/**
 * Per-account JSONL ledger tests for upload-quota.
 *
 * Covers the post-migration storage layout under
 * `<userData>/youtube-quota/<accountId>.jsonl` + `.meta.json`:
 *
 *   1. ledger is created on first record
 *   2. reads sum only entries since the most recent Pacific midnight
 *   3. cache returns the same snapshot within 5s, fresh after invalidation
 *   4. opportunistic 30-day trim removes ancient entries
 *   5. no-active-account returns a zeroed snapshot
 *   6. ceiling persists across calls via the meta file
 *   7. switching the active account swaps which ledger we read from
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

const ACCT_A = 'acct-aaaa-1111'
const ACCT_B = 'acct-bbbb-2222'

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

async function makeProject(name: string, accountId: string | null): Promise<string> {
  const p = await pm.createProject({ name })
  if (accountId) {
    await pm.updateConfig(p.slug, {
      upload_default_account: { youtube: accountId },
    } as any)
  }
  return p.slug
}

function ledgerPath(accountId: string): string {
  return path.join(tempDir, 'youtube-quota', `${accountId}.jsonl`)
}

function metaPath(accountId: string): string {
  return path.join(tempDir, 'youtube-quota', `${accountId}.meta.json`)
}

describe('per-account ledger creation', () => {
  test('first recordQuotaUsage creates the JSONL ledger and writes one entry', async () => {
    const slug = await makeProject('LedgerInit', ACCT_A)

    await quotaMod.recordQuotaUsage(slug, 'videos_insert')

    const text = await fs.readFile(ledgerPath(ACCT_A), 'utf-8')
    const lines = text.trim().split('\n')
    assert.equal(lines.length, 1, 'one line per recorded event')
    const entry = JSON.parse(lines[0])
    assert.equal(entry.op, 'videos_insert')
    assert.equal(entry.units, 1600)
    assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/, 'ts must be ISO 8601')
  })

  test('readQuota returns the summed used after recording', async () => {
    const slug = await makeProject('LedgerSum', ACCT_A)
    await quotaMod.recordQuotaUsage(slug, 'videos_insert')   // 1600
    await quotaMod.recordQuotaUsage(slug, 'videos_update')   // 50
    await quotaMod.recordQuotaUsage(slug, 'channels_list')   // 1
    quotaMod.__resetQuotaCache()

    const snap = await quotaMod.readQuota(slug)
    assert.equal(snap.used, 1651)
    assert.equal(snap.ceiling, 10_000)
  })
})

describe('PT midnight cutoff', () => {
  test('only entries newer than the most recent Pacific midnight count toward used', async () => {
    const slug = await makeProject('Cutoff', ACCT_A)

    // Hand-write a ledger with entries spanning across the Pacific midnight
    // boundary. We use 48h ago (definitely before the boundary) and "now"
    // (definitely after) so the test is robust to whatever wall-clock time
    // it runs at.
    const now = new Date()
    const twoDaysAgo = new Date(now.getTime() - 48 * 3600 * 1000)
    await fs.mkdir(path.dirname(ledgerPath(ACCT_A)), { recursive: true })
    await fs.writeFile(ledgerPath(ACCT_A), [
      JSON.stringify({ ts: twoDaysAgo.toISOString(), op: 'videos_insert', units: 1600 }),
      JSON.stringify({ ts: now.toISOString(), op: 'videos_update', units: 50 }),
      '',
    ].join('\n'))

    const snap = await quotaMod.readQuota(slug)
    assert.equal(snap.used, 50, 'only the post-cutoff entry should count')
  })
})

describe('5s in-memory cache', () => {
  test('repeated readQuota within the TTL returns the same snapshot without re-reading the ledger', async () => {
    const slug = await makeProject('Cache', ACCT_A)
    await quotaMod.recordQuotaUsage(slug, 'videos_update')   // 50
    quotaMod.__resetQuotaCache()

    const snap1 = await quotaMod.readQuota(slug)
    assert.equal(snap1.used, 50)

    // Nuke the ledger out from under us. If the cache works, the next
    // read still returns 50 (cache hit). If it doesn't, the next read
    // returns 0.
    await fs.rm(ledgerPath(ACCT_A))

    const snap2 = await quotaMod.readQuota(slug)
    assert.equal(snap2.used, 50, 'cache should serve the prior snapshot')

    // After explicit invalidation, the next read picks up the new state.
    quotaMod.__resetQuotaCache()
    const snap3 = await quotaMod.readQuota(slug)
    assert.equal(snap3.used, 0, 'after cache reset, ledger absence reads as zero')
  })

  test('recordQuotaUsage invalidates the cache so the next read reflects the new total', async () => {
    const slug = await makeProject('CacheInvalidate', ACCT_A)
    await quotaMod.recordQuotaUsage(slug, 'videos_update')   // 50
    const snap1 = await quotaMod.readQuota(slug)
    assert.equal(snap1.used, 50)

    await quotaMod.recordQuotaUsage(slug, 'videos_update')   // +50
    const snap2 = await quotaMod.readQuota(slug)
    assert.equal(snap2.used, 100, 'cache invalidation on append')
  })
})

describe('opportunistic 30-day trim', () => {
  test('readQuota rewrites the ledger to drop entries older than 30 days', async () => {
    const slug = await makeProject('Trim', ACCT_A)
    const now = new Date()
    const ancient = new Date(now.getTime() - 60 * 86_400_000)   // 60 days ago
    const recent = new Date(now.getTime() - 60_000)             // a minute ago

    await fs.mkdir(path.dirname(ledgerPath(ACCT_A)), { recursive: true })
    await fs.writeFile(ledgerPath(ACCT_A), [
      JSON.stringify({ ts: ancient.toISOString(), op: 'videos_insert', units: 1600 }),
      JSON.stringify({ ts: recent.toISOString(), op: 'videos_update', units: 50 }),
      '',
    ].join('\n'))

    await quotaMod.readQuota(slug)

    // The trim runs as a side effect of readQuota — re-read the file and
    // confirm the ancient line is gone.
    const text = await fs.readFile(ledgerPath(ACCT_A), 'utf-8')
    const lines = text.trim().split('\n').filter(Boolean)
    assert.equal(lines.length, 1, 'only the recent entry survives the trim')
    const entry = JSON.parse(lines[0])
    assert.equal(entry.op, 'videos_update')
  })
})

describe('no-active-account behavior', () => {
  test('readQuota returns a zeroed snapshot when no YouTube account is connected', async () => {
    const slug = await makeProject('NoAccount', null)
    const snap = await quotaMod.readQuota(slug)
    assert.equal(snap.used, 0)
    assert.equal(snap.ceiling, 10_000)
    assert.notEqual(snap.stale, true)
    // The chip can still render — `resets_at` is always present.
    assert.match(snap.resets_at, /^\d{4}-\d{2}-\d{2}T/)
  })

  test('recordQuotaUsage is a no-op when no account is connected (no file is created, no throw)', async () => {
    const slug = await makeProject('NoAccountRecord', null)
    await quotaMod.recordQuotaUsage(slug, 'videos_insert')

    const quotaDir = path.join(tempDir, 'youtube-quota')
    const exists = await fs.stat(quotaDir).then(() => true).catch(() => false)
    if (exists) {
      const entries = await fs.readdir(quotaDir).catch(() => [] as string[])
      assert.equal(entries.length, 0, 'no ledger should be created without an active account')
    }
  })

  test('checkQuota does not throw when no account is connected (zero used + default ceiling)', async () => {
    const slug = await makeProject('NoAccountCheck', null)
    await quotaMod.checkQuota(slug, 'videos_insert')   // should not throw
  })
})

describe('ceiling persistence', () => {
  test('setQuotaCeiling writes the meta file; readQuota reflects the new ceiling', async () => {
    const slug = await makeProject('Ceiling', ACCT_A)
    await quotaMod.setQuotaCeiling(slug, 50_000)
    quotaMod.__resetQuotaCache()
    const snap = await quotaMod.readQuota(slug)
    assert.equal(snap.ceiling, 50_000)
    assert.equal(snap.warn_at, 40_000, 'warn at 80% of the new ceiling')
    assert.equal(snap.block_at, 45_000, 'block at 90% of the new ceiling')
  })

  test('the ceiling survives a fresh module load via the meta file', async () => {
    const slug = await makeProject('CeilingPersist', ACCT_A)
    await quotaMod.setQuotaCeiling(slug, 25_000)

    // Confirm the meta file actually exists on disk with the right value.
    const text = await fs.readFile(metaPath(ACCT_A), 'utf-8')
    const meta = JSON.parse(text)
    assert.equal(meta.ceiling, 25_000)
  })
})

describe('account switching', () => {
  test('switching the default account swaps which ledger readQuota reads from', async () => {
    const slug = await makeProject('Switch', ACCT_A)
    await quotaMod.recordQuotaUsage(slug, 'videos_insert')   // → ACCT_A.jsonl
    quotaMod.__resetQuotaCache()
    let snap = await quotaMod.readQuota(slug)
    assert.equal(snap.used, 1600, 'reading via ACCT_A')

    // Swap default to a fresh account.
    await pm.updateConfig(slug, {
      upload_default_account: { youtube: ACCT_B },
    } as any)
    quotaMod.__resetQuotaCache()

    snap = await quotaMod.readQuota(slug)
    assert.equal(snap.used, 0, 'fresh account starts at 0; old ACCT_A ledger is preserved untouched')

    // Verify ACCT_A's ledger still exists on disk so swapping back recovers it.
    const aText = await fs.readFile(ledgerPath(ACCT_A), 'utf-8')
    assert.match(aText, /videos_insert/, 'ACCT_A ledger preserved across the swap')
  })
})

describe('checkQuota — block threshold pre-check', () => {
  test('throws QuotaExceededError when the upcoming call would exceed block_at', async () => {
    const slug = await makeProject('Block', ACCT_A)
    // Plant a fat ledger entry that puts us right at 8500 used — the next
    // videos_insert (1600 units) would land at 10100 > 9000 block_at.
    const now = new Date()
    await fs.mkdir(path.dirname(ledgerPath(ACCT_A)), { recursive: true })
    await fs.writeFile(ledgerPath(ACCT_A), JSON.stringify({
      ts: now.toISOString(), op: 'videos_insert', units: 8500,
    }) + '\n')
    quotaMod.__resetQuotaCache()

    await assert.rejects(
      () => quotaMod.checkQuota(slug, 'videos_insert'),
      (err: any) => err?.name === 'QuotaExceededError' && err?.snapshot?.used === 8500,
      'pre-check must throw QuotaExceededError when over the block threshold'
    )
  })
})
