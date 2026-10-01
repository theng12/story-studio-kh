/**
 * Story's parsers against the envelopes the REAL gateway publishes.
 *
 * `fixtures/gateway-envelopes.json` is written by the gateway repo's
 * `tests/dump_story_envelopes.py`: `api._job_envelope` over real `JobStore` rows, one per modality
 * and state, plus a waiting job and a held (unknown-outcome) one. Every other envelope test in
 * this repo feeds a hand-written shape to Story, which is exactly how a field name that nothing
 * publishes survives for months; this one reads what the producer actually emits.
 *
 * Regenerate the fixture when the gateway's envelope changes (see the script's docstring).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  GenStudioChatTerminalFailureError,
  GenStudioImageTerminalFailureError,
  GenStudioTransportTimeoutError,
  GenStudioTtsTerminalFailureError,
  createGenStudioJobPoller,
  evidenceHoldsUnknownOutcome,
  getGenStudioCancellationStatus,
  holdsUnknownOutcome,
  isGenStudioSubmissionUncertain,
} from '../lib/genstudio-client.js'
import { isSafePipelineModelAdvance } from '../lib/ai-client.js'
import { isTransportFailure } from '../lib/http-retry.js'
import { classifyJobControl } from '../services/job-control.js'
import type { Job } from '../models/types.js'

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gateway-envelopes.json')
const envelopes = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<string, { id: string } & Record<string, any>>

const OPERATIONS = {
  chat: 'chat.response', image: 'image.generation', tts: 'voice.tts',
  music: 'music.generation', transcription: 'audio.transcription', video: 'video.generation',
} as const

async function read(key: string) {
  const body = envelopes[key]
  const modality = key.split('.')[0] as keyof typeof OPERATIONS
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json(body)
  try {
    return await getGenStudioCancellationStatus(OPERATIONS[modality], 'http://gateway.test', 'key', body.id, {}, Date.now() + 5_000)
  } finally { globalThis.fetch = original }
}

describe('every state of every modality parses, and settles the way the gateway means it', () => {
  for (const key of Object.keys(envelopes)) {
    const [modality, state] = key.split('.')
    if (!(modality in OPERATIONS)) continue
    test(key, async () => {
      const job = await read(key)
      const settled = createGenStudioJobPoller().settled(job as any)
      if (state === 'succeeded') {
        assert.equal(job.state, 'succeeded')
        assert.equal(settled, true)
      } else if (state === 'cancelled') {
        // The gateway publishes a cancel as `failed` + `cancelled: true`; Story must stop polling.
        assert.equal(job.state, 'failed')
        assert.equal(job.cancelled, true)
        assert.equal(settled, true)
      } else if (state === 'failed') {
        assert.equal(settled, true)
        assert.equal(job.cancelled, false)
      } else if (state === 'held') {
        assert.equal(holdsUnknownOutcome(job as any), true)
        assert.equal(settled, false, 'an unknown outcome is not final inside its grace window')
      } else {
        assert.equal(settled, false, `${key} is still in flight`)
      }
    })
  }
})

describe('the fields Story reads exist on the real envelope', () => {
  test('a succeeded job names its artifact where Story looks for it', () => {
    assert.match(envelopes['tts.succeeded'].audio_url, /^\/v1\/jobs\/.+\/audio$/)
    assert.match(envelopes['image.succeeded'].image_url, /^\/v1\/images\/.+\/file$/)
    assert.match(envelopes['transcription.succeeded'].srt_url, /^\/v1\/transcriptions\/.+\/srt$/)
    assert.match(envelopes['video.succeeded'].video_url, /^\/v1\/videos\/.+\/file$/)
    assert.equal(envelopes['music.succeeded'].outputs[0].asset_id, '0')
    assert.equal(envelopes['chat.succeeded'].output_text, 'hello')
    assert.equal(envelopes['chat.succeeded'].finish_reason, 'stop')
  })

  test('every envelope carries the contract fields with the right types', () => {
    for (const [key, body] of Object.entries(envelopes)) {
      assert.ok(['pre_dispatch', 'dispatched'].includes(body.dispatch_state), key)
      assert.equal(typeof body.cancellable, 'boolean', key)
      assert.equal(typeof body.cancellation_requested, 'boolean', key)
      assert.equal(typeof body.cancelled, 'boolean', key)
      assert.ok(body.waiting === null || typeof body.waiting === 'object', key)
      assert.equal(body.settled_credits, 0, key)
    }
  })

  test('no address or Hub route leaks into a published text field', () => {
    for (const [key, body] of Object.entries(envelopes)) {
      const text = [body.failure_reason, body.recovery_detail, body.waiting?.reason].filter(Boolean).join(' ')
      assert.doesNotMatch(text, /\d+\.\d+\.\d+\.\d+|:47873|\/api\/hub/, key)
    }
  })
})

describe('a job waiting for a Mac can be cancelled, and a rendering one cannot', () => {
  const asEntry = (key: string): Job['genstudio_jobs'] => {
    const body = envelopes[key]
    return [{
      id: body.id, operation: 'voice.tts', state: body.state, updated_at: '2026-10-01T09:00:00Z',
      dispatch_state: body.dispatch_state, cancellable: body.cancellable, waiting: body.waiting,
    }] as Job['genstudio_jobs']
  }
  const base = { status: 'running', type: 'audio', params: {} } as const

  test('the real waiting envelope offers remote cancel', () => {
    assert.equal(
      classifyJobControl({ ...base, genstudio_jobs: asEntry('tts.waiting') }, { remoteCancellationAudited: true }).action,
      'request-remote-cancel')
  })

  test('a job that is just running does not', () => {
    assert.notEqual(
      classifyJobControl({ ...base, genstudio_jobs: asEntry('tts.running') }, { remoteCancellationAudited: true }).action,
      'request-remote-cancel')
  })
})

describe('a job the gateway holds as an unknown outcome is never read as a settled failure', () => {
  // The held envelope carries `failure_code: UNKNOWN_OUTCOME` — not one of the three codes the
  // uncertain list names — plus `recovery_required` / `recovery_state`.
  const held = envelopes['tts.held']
  const plain = envelopes['tts.failed']

  test('every terminal-failure class reads the hold as uncertain, and a plain failure as not', () => {
    for (const make of [
      (job: any) => new GenStudioTtsTerminalFailureError(job),
      (job: any) => new GenStudioImageTerminalFailureError(job),
      (job: any) => new GenStudioChatTerminalFailureError(job),
    ]) {
      assert.equal(isGenStudioSubmissionUncertain(make(held)), true)
      assert.equal(isGenStudioSubmissionUncertain(make(plain)), false)
    }
  })

  test('a held chat job never advances the model lineup as if it were proven uncharged', () => {
    // 0/0/0 settlement is what the gateway publishes on every failure, so it proves nothing.
    assert.equal(isSafePipelineModelAdvance(new GenStudioChatTerminalFailureError(held)), false)
    assert.equal(isSafePipelineModelAdvance(new GenStudioChatTerminalFailureError(plain)), true)
  })

  test('recorded evidence of a hold keeps its task reclaimable instead of retired', () => {
    assert.equal(evidenceHoldsUnknownOutcome({ failure_code: held.failure_code, recovery_required: held.recovery_required, recovery_state: held.recovery_state }), true)
    assert.equal(evidenceHoldsUnknownOutcome({ failure_code: 'PROVIDER_SUBMISSION_UNCERTAIN' }), true)
    assert.equal(evidenceHoldsUnknownOutcome({ failure_code: plain.failure_code, recovery_required: false, recovery_state: null }), false)
    assert.equal(evidenceHoldsUnknownOutcome(undefined), false)
  })
})

describe('a gateway that does not answer in time is a dropped answer, not a cancel', () => {
  test('the 30 s request timeout is a transport failure and does not read as a user abort', () => {
    const timeout = AbortSignal.timeout(1)
    return new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        try {
          const error = new GenStudioTransportTimeoutError(timeout.reason as DOMException)
          assert.equal(isTransportFailure(error), true)
          // Every cancel check in the app is this pattern (audio.ts, http-retry.ts).
          assert.doesNotMatch(error.message, /cancell?ed|abort/i)
          resolve()
        } catch (e) { reject(e) }
      }, 20)
    })
  })
})
