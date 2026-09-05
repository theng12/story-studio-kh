import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'

const APPLICATION_ID = 'youtube_app_quota_test'

type QuotaModule = typeof import('../services/youtube-quota-ledger.js')
let quota: QuotaModule
let tempDir = ''
let cleanup: (() => Promise<void>) | undefined

beforeEach(async () => {
  const temp = await useTempDataDir()
  tempDir = temp.dir
  cleanup = temp.cleanup
  quota = await import('../services/youtube-quota-ledger.js')
  quota.__setYouTubeQuotaClockForTests(new Date('2026-09-01T20:00:00.000Z'))
})

afterEach(async () => {
  quota.__resetYouTubeQuotaClockForTests()
  await cleanup?.()
  cleanup = undefined
})

function metaPath(applicationId = APPLICATION_ID): string {
  return path.join(tempDir, 'youtube', 'quota', applicationId, 'meta.json')
}

function eventsPath(applicationId = APPLICATION_ID): string {
  return path.join(tempDir, 'youtube', 'quota', applicationId, 'events.jsonl')
}

describe('YouTube Cloud-project quota ledger', () => {
  test('initializes four independent default buckets and records unknown-before honestly', async () => {
    const snapshot = await quota.readYouTubeQuota(APPLICATION_ID)

    assert.deepEqual(snapshot.buckets, {
      video_uploads: {
        used: 0,
        limit: 100,
        remaining: 100,
        unit: 'calls',
        stale: false,
        by_channel: {},
        limit_verified: true,
      },
      search: {
        used: 0,
        limit: 100,
        remaining: 100,
        unit: 'calls',
        stale: false,
        by_channel: {},
        limit_verified: true,
      },
      other_endpoints: {
        used: 0,
        limit: 10_000,
        remaining: 10_000,
        unit: 'units',
        stale: false,
        by_channel: {},
        limit_verified: true,
      },
      analytics: {
        used: 0,
        // Null, not a plausible placeholder: the allowance is per Cloud
        // project and genuinely unknown until the owner reads it from his
        // console. A number here would invite a future reader to gate on it.
        limit: null,
        remaining: null,
        unit: 'units',
        stale: false,
        by_channel: {},
        limit_verified: false,
      },
    })
    assert.equal(snapshot.application_id, APPLICATION_ID)
    assert.equal(snapshot.tracking_day, '2026-09-01')
    assert.equal(snapshot.unknown_before, '2026-09-01T20:00:00.000Z')
    assert.equal(snapshot.external_usage_known, false)
    assert.match(snapshot.external_usage_note, /other installations|other clients|same.*Cloud project/i)
    assert.equal(snapshot.resets_at, '2026-09-02T07:00:00.000Z')

    const meta = JSON.parse(await fs.readFile(metaPath(), 'utf8')) as Record<string, unknown>
    assert.equal(meta.unknown_before, '2026-09-01T20:00:00.000Z')
  })

  test('aggregates channels in one application while exposing only derived per-channel counts', async () => {
    await quota.recordYouTubeQuotaAttempt({
      application_id: APPLICATION_ID,
      channel_id: 'channel-a',
      bucket: 'video_uploads',
      operation: 'videos.insert',
      amount: 10,
      attempted_at: '2026-09-01T20:01:00.000Z',
    })
    await quota.recordYouTubeQuotaAttempt({
      application_id: APPLICATION_ID,
      channel_id: 'channel-b',
      bucket: 'video_uploads',
      operation: 'videos.insert',
      amount: 7,
      attempted_at: '2026-09-01T20:02:00.000Z',
    })
    await quota.recordYouTubeQuotaAttempt({
      application_id: APPLICATION_ID,
      channel_id: 'channel-a',
      bucket: 'search',
      operation: 'search.list',
      amount: 3,
      attempted_at: '2026-09-01T20:03:00.000Z',
    })

    const snapshot = await quota.readYouTubeQuota(APPLICATION_ID)
    assert.equal(snapshot.buckets.video_uploads.used, 17)
    assert.deepEqual(snapshot.buckets.video_uploads.by_channel, {
      'channel-a': 10,
      'channel-b': 7,
    })
    assert.equal(snapshot.buckets.search.used, 3)
    assert.deepEqual(snapshot.buckets.search.by_channel, { 'channel-a': 3 })
    assert.deepEqual(snapshot.buckets.other_endpoints.by_channel, {})
  })

  test('derives counts safely for channel ids that match object prototype names', async () => {
    await quota.recordYouTubeQuotaAttempt({
      application_id: APPLICATION_ID,
      channel_id: 'toString',
      bucket: 'search',
      operation: 'search.list',
      amount: 2,
    })

    const snapshot = await quota.readYouTubeQuota(APPLICATION_ID)
    assert.equal(snapshot.buckets.search.by_channel.toString, 2)
  })

  test('keeps a different application id in an independent ledger', async () => {
    await quota.recordYouTubeQuotaAttempt({
      application_id: APPLICATION_ID,
      channel_id: 'channel-a',
      bucket: 'search',
      operation: 'search.list',
      amount: 9,
    })
    await quota.recordYouTubeQuotaAttempt({
      application_id: 'youtube_app_other_quota_test',
      channel_id: 'channel-a',
      bucket: 'search',
      operation: 'search.list',
      amount: 4,
    })

    assert.equal((await quota.readYouTubeQuota(APPLICATION_ID)).buckets.search.used, 9)
    assert.equal(
      (await quota.readYouTubeQuota('youtube_app_other_quota_test')).buckets.search.used,
      4,
    )
  })


  test('uses Pacific midnight as the reset boundary across spring DST', async () => {
    quota.__setYouTubeQuotaClockForTests(new Date('2026-03-08T20:00:00.000Z'))
    await quota.recordYouTubeQuotaAttempt({
      application_id: APPLICATION_ID,
      channel_id: 'channel-dst',
      bucket: 'search',
      operation: 'search.list',
      amount: 1,
      attempted_at: '2026-03-08T07:59:59.000Z',
    })
    await quota.recordYouTubeQuotaAttempt({
      application_id: APPLICATION_ID,
      channel_id: 'channel-dst',
      bucket: 'search',
      operation: 'search.list',
      amount: 2,
      attempted_at: '2026-03-08T08:00:00.000Z',
    })

    const snapshot = await quota.readYouTubeQuota(APPLICATION_ID)
    assert.equal(snapshot.buckets.search.used, 2)
    assert.equal(snapshot.tracking_day, '2026-03-08')
    assert.equal(snapshot.resets_at, '2026-03-09T07:00:00.000Z')
  })

  test('uses Pacific midnight as the reset boundary across fall DST', async () => {
    quota.__setYouTubeQuotaClockForTests(new Date('2026-11-01T20:00:00.000Z'))
    await quota.recordYouTubeQuotaAttempt({
      application_id: APPLICATION_ID,
      channel_id: 'channel-dst-fall',
      bucket: 'search',
      operation: 'search.list',
      amount: 2,
      attempted_at: '2026-11-01T07:00:00.000Z',
    })

    const snapshot = await quota.readYouTubeQuota(APPLICATION_ID)
    assert.equal(snapshot.buckets.search.used, 2)
    assert.equal(snapshot.tracking_day, '2026-11-01')
    assert.equal(snapshot.resets_at, '2026-11-02T08:00:00.000Z')
  })

  test('marks only the failed bucket stale and does not count an unappended attempt', async () => {
    await quota.readYouTubeQuota(APPLICATION_ID)
    const mutableFs = fs as typeof fs & { appendFile: typeof fs.appendFile }
    const originalAppendFile = mutableFs.appendFile
    mutableFs.appendFile = async () => {
      throw Object.assign(new Error('injected append failure'), { code: 'EIO' })
    }
    try {
      await assert.rejects(
        quota.recordYouTubeQuotaAttempt({
          application_id: APPLICATION_ID,
          channel_id: 'channel-write-failure',
          bucket: 'video_uploads',
          operation: 'videos.insert',
          amount: 40,
        }),
        /injected append failure|EIO/i,
      )
    } finally {
      mutableFs.appendFile = originalAppendFile
    }

    const snapshot = await quota.readYouTubeQuota(APPLICATION_ID)
    assert.equal(snapshot.buckets.video_uploads.used, 0)
    assert.equal(snapshot.buckets.video_uploads.stale, true)
    assert.equal(snapshot.buckets.search.stale, false)
    assert.equal(snapshot.buckets.other_endpoints.stale, false)
    assert.equal(await fs.readFile(eventsPath(), 'utf8').then(() => true, () => false), false)
  })

  test('marks a bucket stale when the append path itself cannot be opened', async () => {
    await quota.readYouTubeQuota(APPLICATION_ID)
    await fs.mkdir(eventsPath())

    await assert.rejects(
      quota.recordYouTubeQuotaAttempt({
        application_id: APPLICATION_ID,
        channel_id: 'channel-directory-failure',
        bucket: 'video_uploads',
        operation: 'videos.insert',
        amount: 1,
      }),
      /EISDIR|directory|ledger/i,
    )

    const meta = JSON.parse(await fs.readFile(metaPath(), 'utf8')) as {
      stale: Record<string, boolean>
    }
    assert.equal(meta.stale.video_uploads, true)
    assert.equal(meta.stale.search, false)
    assert.equal(meta.stale.other_endpoints, false)
  })

  test('clears only the affected bucket stale flag after a later successful append', async () => {
    await quota.readYouTubeQuota(APPLICATION_ID)
    const mutableFs = fs as typeof fs & { appendFile: typeof fs.appendFile }
    const originalAppendFile = mutableFs.appendFile
    mutableFs.appendFile = async () => {
      throw new Error('one failed append')
    }
    try {
      await assert.rejects(() => quota.recordYouTubeQuotaAttempt({
        application_id: APPLICATION_ID,
        channel_id: 'channel-stale-video',
        bucket: 'video_uploads',
        operation: 'videos.insert',
        amount: 1,
      }))
    } finally {
      mutableFs.appendFile = originalAppendFile
    }
    await quota.recordYouTubeQuotaAttempt({
      application_id: APPLICATION_ID,
      channel_id: 'channel-stale-video',
      bucket: 'video_uploads',
      operation: 'videos.insert',
      amount: 1,
    })

    const snapshot = await quota.readYouTubeQuota(APPLICATION_ID)
    assert.equal(snapshot.buckets.video_uploads.used, 1)
    assert.equal(snapshot.buckets.video_uploads.stale, false)
  })

  test('blocks only an exhausted bucket', async () => {
    await quota.recordYouTubeQuotaAttempt({
      application_id: APPLICATION_ID,
      channel_id: 'channel-exhausted',
      bucket: 'video_uploads',
      operation: 'videos.insert',
      amount: 100,
    })

    await assert.rejects(
      quota.checkYouTubeQuota(APPLICATION_ID, 'video_uploads', 1),
      (error: any) => error?.code === 'YOUTUBE_QUOTA_EXHAUSTED' && error?.bucket === 'video_uploads',
    )
    await quota.checkYouTubeQuota(APPLICATION_ID, 'search', 1)
    await quota.checkYouTubeQuota(APPLICATION_ID, 'other_endpoints', 1)
  })

  test('serializes concurrent appends without losing events', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => quota.recordYouTubeQuotaAttempt({
      application_id: APPLICATION_ID,
      channel_id: `channel-${index % 2}`,
      bucket: 'search',
      operation: 'search.list',
      amount: 1,
    })))

    const snapshot = await quota.readYouTubeQuota(APPLICATION_ID)
    assert.equal(snapshot.buckets.search.used, 20)
    assert.deepEqual(snapshot.buckets.search.by_channel, {
      'channel-0': 10,
      'channel-1': 10,
    })
  })

  test('a ledger written before the analytics bucket existed still decodes', async () => {
    // Every ledger on disk predates this bucket. `assertExactKeys` only rejects
    // UNKNOWN keys, so the file passed that check and then died in the loop
    // below it, which read a missing limit as an invalid one. A bucket added
    // later is absent, not corrupt — otherwise adding one condemns every
    // installation's quota history on upgrade.
    await fs.mkdir(path.dirname(metaPath()), { recursive: true })
    await fs.writeFile(metaPath(), JSON.stringify({
      schema_version: 1,
      application_id: APPLICATION_ID,
      initialized_at: '2026-09-01T20:00:00.000Z',
      unknown_before: '2026-09-01T20:00:00.000Z',
      limits: { video_uploads: 100, search: 100, other_endpoints: 10_000 },
      stale: { video_uploads: false, search: false, other_endpoints: true },
    }))

    const snapshot = await quota.readYouTubeQuota(APPLICATION_ID)
    // The buckets it DID record keep their stored values...
    assert.equal(snapshot.buckets.other_endpoints.limit, 10_000)
    assert.equal(snapshot.buckets.other_endpoints.stale, true)
    // ...and the new one appears at its default rather than failing the read.
    assert.equal(snapshot.buckets.analytics.limit, null)
    assert.equal(snapshot.buckets.analytics.stale, false)
    assert.equal(snapshot.buckets.analytics.limit_verified, false)
  })

  test('reports malformed meta bytes and preserves them', async () => {
    const corrupt = '{"schema_version":1, bad json\n'
    await fs.mkdir(path.dirname(metaPath()), { recursive: true })
    await fs.writeFile(metaPath(), corrupt)

    await assert.rejects(quota.readYouTubeQuota(APPLICATION_ID), /corrupt|JSON|parse/i)
    assert.equal(await fs.readFile(metaPath(), 'utf8'), corrupt)
  })

  test('reports malformed JSONL bytes and preserves them', async () => {
    await quota.readYouTubeQuota(APPLICATION_ID)
    const corrupt = '{"bucket":"search","amount":"not-a-number"}\nnot json\n'
    await fs.writeFile(eventsPath(), corrupt)

    await assert.rejects(quota.readYouTubeQuota(APPLICATION_ID), /corrupt|JSON|parse/i)
    assert.equal(await fs.readFile(eventsPath(), 'utf8'), corrupt)
  })

  test('reports invalid UTF-8 in JSONL as corruption and preserves the raw bytes', async () => {
    await quota.readYouTubeQuota(APPLICATION_ID)
    const corrupt = Buffer.from(`${JSON.stringify({
      attempted_at: '2026-09-01T20:01:00.000Z',
      channel_id: 'channel-invalid-utf8',
      bucket: 'search',
      operation: 'search.list',
      amount: 1,
    })}\n`)
    const operationByte = corrupt.indexOf(Buffer.from('search.list'))
    assert.ok(operationByte >= 0)
    corrupt[operationByte + 1] = 0xff
    const metaBefore = await fs.readFile(metaPath())
    await fs.writeFile(eventsPath(), corrupt)

    await assert.rejects(
      quota.readYouTubeQuota(APPLICATION_ID),
      (error: any) => error?.code === 'YOUTUBE_QUOTA_LEDGER_CORRUPT',
    )
    assert.deepEqual(await fs.readFile(eventsPath()), corrupt)
    assert.deepEqual(await fs.readFile(metaPath()), metaBefore)
  })

  test('reports invalid UTF-8 in meta as corruption without defaulting or rewriting', async () => {
    // Use U+FFFD in the expected application id so replacement decoding would
    // otherwise make this malformed byte sequence look valid.
    const applicationId = 'youtube_app_\ufffd_meta_test'
    const valid = Buffer.from(`${JSON.stringify({
      schema_version: 1,
      application_id: applicationId,
      initialized_at: '2026-09-01T20:00:00.000Z',
      unknown_before: '2026-09-01T20:00:00.000Z',
      limits: { video_uploads: 100, search: 100, other_endpoints: 10_000 },
      stale: { video_uploads: false, search: false, other_endpoints: false },
    })}\n`)
    const replacement = Buffer.from('\ufffd')
    const replacementAt = valid.indexOf(replacement)
    assert.ok(replacementAt >= 0)
    const corrupt = Buffer.concat([
      valid.subarray(0, replacementAt),
      Buffer.from([0xff]),
      valid.subarray(replacementAt + replacement.length),
    ])
    await fs.mkdir(path.dirname(metaPath(applicationId)), { recursive: true })
    await fs.writeFile(metaPath(applicationId), corrupt)

    await assert.rejects(
      quota.readYouTubeQuota(applicationId),
      (error: any) => error?.code === 'YOUTUBE_QUOTA_LEDGER_CORRUPT',
    )
    assert.deepEqual(await fs.readFile(metaPath(applicationId)), corrupt)
    assert.equal(await fs.access(eventsPath(applicationId)).then(() => true, () => false), false)
  })

  test('rejects invalid identifiers, buckets, amounts, and timestamps before mutation', async () => {
    await assert.rejects(() => quota.readYouTubeQuota('../escape'), /invalid|identifier|application/i)
    await assert.rejects(() => quota.readYouTubeQuota('__proto__'), /invalid|identifier|application/i)
  })


})
