/**
 * Story's side of the gateway job-envelope contract (dispatch_state / cancellable / cancelled /
 * waiting / recovery_*): cancellation is terminal, an unknown outcome is not final inside a grace
 * window, the gateway's own failure codes are in the shared sets, and a held failure is never
 * auto-resubmitted.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import type { Job } from '../models/types.js'
import {
  GenStudioImageTerminalFailureError,
  UNKNOWN_OUTCOME_GRACE_MS,
  createGenStudioJobPoller,
  getGenStudioCancellationStatus,
  holdsUnknownOutcome,
  isGenStudioSubmissionUncertain,
  isQuotaExhaustedCode,
  isSubmissionUncertainCode,
  normalizeGenStudioWaiting,
  readCatalogRows,
  sniffImageMediaType,
} from '../lib/genstudio-client.js'
import { isFleetBusyFailure } from '../lib/genstudio-fleet-busy.js'
import { stageGenStudioImage } from '../lib/genstudio-artifacts.js'
import { classifyJobControl } from '../services/job-control.js'

const held = { state: 'failed', recovery_required: true, recovery_state: 'unknown_outcome' }

describe('cancellation is terminal, whichever way the gateway spells it', () => {
  test('failed + cancelled:true settles at once, and a legacy state:"cancelled" is read as that', async () => {
    const poller = createGenStudioJobPoller()
    assert.equal(poller.settled({ state: 'failed', cancelled: true }), true)
    assert.equal(poller.settled({ state: 'running' }), false)

    const original = globalThis.fetch
    try {
      globalThis.fetch = async () => Response.json({ id: 'job-1', state: 'cancelled' })
      const job = await getGenStudioCancellationStatus('chat.response', 'http://gateway.test', 'key', 'job-1', {}, Date.now() + 1_000)
      assert.equal(job.state, 'failed')
      assert.equal(job.cancelled, true)
    } finally { globalThis.fetch = original }
  })
})

describe('an unknown outcome is not final inside the grace window', () => {
  test('a held failure keeps the wait loop polling until the window closes; a later success is honoured', () => {
    let t = 1_000_000
    const poller = createGenStudioJobPoller(Math.random, () => t)
    assert.equal(poller.settled(held), false, 'held failure is not final')
    t += UNKNOWN_OUTCOME_GRACE_MS - 1
    assert.equal(poller.settled(held), false, 'still inside the window')
    assert.equal(poller.settled({ state: 'succeeded' }), true, 'adoption arrives as succeeded')
    t += 2
    assert.equal(poller.settled(held), true, 'the window closed, so the failure stands')
    assert.equal(createGenStudioJobPoller().settled({ state: 'failed' }), true, 'an ordinary failure is final at once')
  })

  test('the hold is read from either field and survives a gateway that never sends them', () => {
    assert.equal(holdsUnknownOutcome({ recovery_required: true }), true)
    assert.equal(holdsUnknownOutcome({ recovery_state: 'unknown_outcome' }), true)
    assert.equal(holdsUnknownOutcome({}), false)
    assert.equal(holdsUnknownOutcome({ recovery_required: false, recovery_state: 'none' }), false)
  })
})

describe('waiting for a Mac', () => {
  test('waiting is read tolerantly and null on an older gateway', () => {
    assert.equal(normalizeGenStudioWaiting(undefined), null)
    assert.deepEqual(
      normalizeGenStudioWaiting({ reason: 'all busy', next_try_at: '2026-09-30T10:00:00Z', since: '2026-09-30T09:00:00Z' }),
      { reason: 'all busy', next_try_at: '2026-09-30T10:00:00Z', since: '2026-09-30T09:00:00Z' },
    )
    assert.deepEqual(normalizeGenStudioWaiting({ reason: '', next_try_at: null }), { reason: null, next_try_at: null, since: null })
  })

  test('a dispatched job that is still waiting for a Mac can be cancelled when the gateway says so', () => {
    const entry = (extra: object): Job['genstudio_jobs'] => [{
      id: 'img-1', operation: 'image.generation', state: 'running', updated_at: '2026-09-30T09:00:00Z',
      dispatch_state: 'dispatched', cancellable: true, ...extra,
    }] as Job['genstudio_jobs']
    const base = { status: 'running', type: 'thumb_images', params: {} } as const
    const waiting = { reason: 'busy', next_try_at: null, since: '2026-09-30T09:00:00Z' }
    assert.equal(classifyJobControl({ ...base, genstudio_jobs: entry({ waiting }) }, { remoteCancellationAudited: true }).action, 'request-remote-cancel')
    assert.notEqual(classifyJobControl({ ...base, genstudio_jobs: entry({ cancellable: false }) }, { remoteCancellationAudited: true }).action, 'request-remote-cancel',
      'rendering work the gateway says it cannot stop is not cancellable')
  })
})

describe('the gateway\'s own failure codes', () => {
  test('uncertain and quota codes are recognised in every dialect, by list and not by luck', () => {
    for (const code of ['LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN', 'CLOUD_SUBMISSION_UNCERTAIN', 'PROVIDER_SUBMISSION_UNCERTAIN']) {
      assert.equal(isSubmissionUncertainCode(code), true, code)
    }
    assert.equal(isSubmissionUncertainCode('SITE_CAPACITY_UNAVAILABLE'), false)
    assert.equal(isQuotaExhaustedCode('PROVIDER_QUOTA_EXHAUSTED'), true)
    assert.equal(isQuotaExhaustedCode('LANGUAGE_PROVIDER_QUOTA_EXHAUSTED'), true)
    const uncertain = new GenStudioImageTerminalFailureError({ id: 'j', state: 'failed', failure_code: 'PROVIDER_SUBMISSION_UNCERTAIN' })
    assert.equal(isGenStudioSubmissionUncertain(uncertain), true)
  })

  test('a capacity failure the gateway holds as an unknown outcome is never auto-resubmitted', () => {
    const settled = { id: 'j', state: 'failed', failure_code: 'SITE_CAPACITY_UNAVAILABLE', reserved_credits: 0, settled_credits: 0, released_credits: 0 }
    assert.equal(isFleetBusyFailure(new GenStudioImageTerminalFailureError(settled), 'image'), true, 'a clean refusal still retries')
    assert.equal(isFleetBusyFailure(new GenStudioImageTerminalFailureError({ ...settled, ...held }), 'image'), false)
  })

  test('LOCATION_* endings are not fleet-busy, so they add no wait on top of the gateway\'s own', async () => {
    const { FLEET_BUSY_FAILURE_CODES } = await import('../lib/genstudio-fleet-busy.js')
    assert.equal(FLEET_BUSY_FAILURE_CODES.has('LOCATION_NOT_READY'), false)
    assert.equal(FLEET_BUSY_FAILURE_CODES.has('LOCATION_UNREACHABLE'), false)
  })
})

describe('image bytes and catalogue shape', () => {
  test('PNG, JPEG and WebP are accepted by their magic bytes; anything else is not', () => {
    assert.equal(sniffImageMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), 'image/png')
    assert.equal(sniffImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg')
    assert.equal(sniffImageMediaType(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')])), 'image/webp')
    assert.equal(sniffImageMediaType(Buffer.from('GIF89a......')), null)
  })

  test('a JPEG data URL is staged, not refused as "unsupported"', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-image-'))
    try {
      // Not a decodable image, so staging fails at the decode step, which is after the format gate.
      await assert.rejects(
        stageGenStudioImage(`data:image/jpeg;base64,${Buffer.from('not-a-jpeg').toString('base64')}`, path.join(dir, 'a.png')),
        (error: Error) => !/unsupported image artifact/.test(error.message),
      )
      await assert.rejects(
        stageGenStudioImage(`data:image/gif;base64,${Buffer.from('x').toString('base64')}`, path.join(dir, 'b.png')),
        /unsupported image artifact/,
      )
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  test('/v1/tts/models answers {models, freshness}; rows are read from under `models`', () => {
    assert.deepEqual(readCatalogRows({ models: [{ id: 'tts-a' }], freshness: { state: 'fresh' } }), [{ id: 'tts-a' }])
    assert.deepEqual(readCatalogRows([{ id: 'tts-b' }]), [{ id: 'tts-b' }])
    assert.equal(readCatalogRows({ nope: 1 }), null)
  })
})

describe('the wait loops and shared sets really use these rules (source pins)', () => {
  const read = (rel: string) => fs.readFile(new URL(rel, import.meta.url), 'utf8')

  test('every modality\'s wait loop exits through the poller, so none can end on a held failure', async () => {
    const client = await read('../lib/genstudio-client.ts')
    assert.equal((client.match(/while \(!poller\.settled\(current\)\)/g) || []).length, 6, 'video, image, chat, tts, transcription, music')
    assert.doesNotMatch(client, /while \(!isSettledGenStudioJob\(current\)\)|while \(!isTerminalGenStudioJobState\(current\.state\)\)/)
    // A held failure is recorded as still reconciling, so the Story job cannot settle under the loop.
    assert.match(client, /holdsUnknownOutcome\(job\) \? 'reconciling' : job\.state/)
  })

  test('the manual-retry set knows the gateway\'s codes and the Test connection probe reads {models}', async () => {
    const replacement = await read('../services/failed-item-replacement.ts')
    for (const code of ['LOCATION_NOT_READY', 'LOCATION_UNREACHABLE', 'PROVIDER_QUOTA_EXHAUSTED']) assert.match(replacement, new RegExp(`'${code}'`))
    assert.match(replacement, /isSubmissionUncertainCode\(failureCode\)/)
    assert.match(await read('../routes/app-settings.ts'), /readCatalogRows\(ttsCatalog\)/)
  })
})
