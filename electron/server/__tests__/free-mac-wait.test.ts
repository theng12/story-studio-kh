/**
 * "If it's waiting, it should be waiting, not failed." (owner, 2026-10-03)
 *
 * The Dreamlands audio job narrating 18 chapters on Breeze dropped ten chapters within minutes:
 *
 *   Failed: Gateway generation failed (SITE_CAPACITY_UNAVAILABLE). GenStudio reports 0 credits
 *   released. No fallback route was attempted. Provider reason: hub submit failed: timed out The
 *   result is being checked; nothing was run twice.
 *
 * A Mac that did not answer a submit in time is held by the Gateway as an "unknown outcome", and the
 * shared busy-fleet rule refused to resubmit anything held that way — right for PAID work (a second
 * request may be a second charge), wrong for the owner's own free fleet, where a second request costs
 * nothing and the Gateway keeps whichever result lands first. These tests pin the free-fleet rule for
 * every generator that waits, and keep the paid rule exactly as it was.
 *
 * Old and new Gateways both covered: an old Gateway FAILS the job (handled here, Story waits and asks
 * again); a new one keeps free work queued and publishes `waiting` (the job card shows it already).
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FLEET_BUSY_RETRY_DELAYS_MS,
  FREE_MAC_WAIT_MAX_RETRIES,
  fleetBusyRetryPlan,
  freeMacWaitLine,
  isFleetBusyFailure,
} from '../lib/genstudio-fleet-busy.js'
import {
  GenStudioImageTerminalFailureError,
  GenStudioMusicTerminalFailureError,
  GenStudioTranscriptionTerminalFailureError,
  GenStudioTtsTerminalFailureError,
  GenStudioVideoTerminalFailureError,
  GenStudioChatTerminalFailureError,
} from '../lib/genstudio-client.js'
import { humanGatewayText } from '../lib/gateway-failure-text.js'
import { FREE_MAC_WAIT_REASON } from '../contracts/provider-task-state.js'
import { imageRetryPlan } from '../generators/images.js'
import { imagePoolFleetBusyRetryPlan } from '../generators/image-pool-generate.js'
import { continuityFleetBusyRetryPlan } from '../generators/continuity-render.js'
import { sceneClipFleetBusyRetryPlan } from '../generators/scene-clip.js'
import { musicFleetBusyRetryPlan } from '../generators/music-generate.js'
import { contextualCueFleetBusyRetryPlan } from '../generators/contextual-cues.js'
import { isFleetBusyTranscriptionFailure } from '../generators/subtitles.js'

const FREE = 'studio-hub::breeze-voice'
const PAID = 'genstudio::paid-model'

/** The exact Gateway answer from the screenshot: a submit timeout held as an unknown outcome. */
const submitTimeout = (model_id: string, over: Record<string, unknown> = {}) => ({
  id: 'gw-dead-1', state: 'failed', cancelled: false, model_id,
  failure_code: 'SITE_CAPACITY_UNAVAILABLE',
  failure_reason: 'hub submit failed: timed out Upstream outcome is unknown; reconcile the provider request before retrying; the gateway will not resubmit it automatically.',
  recovery_required: true, recovery_state: 'unknown_outcome',
  reserved_credits: 0, settled_credits: 0, released_credits: 0, ...over,
}) as any

describe('the screenshot: a free chapter whose Mac did not answer in time', () => {
  const error = new GenStudioTtsTerminalFailureError(submitTimeout(FREE))

  test('waits for a free Mac instead of failing', () => {
    assert.equal(isFleetBusyFailure(error, 'tts'), true)
    const plan = fleetBusyRetryPlan(error, 'tts', 0)
    assert.ok(plan)
    assert.equal(plan.free, true)
    assert.equal(plan.reason, FREE_MAC_WAIT_REASON)
    assert.equal(plan.waitMs, FLEET_BUSY_RETRY_DELAYS_MS[0])
  })

  test('the same answer on PAID work keeps the unknown-outcome lock', () => {
    const paid = new GenStudioTtsTerminalFailureError(submitTimeout(PAID))
    assert.equal(isFleetBusyFailure(paid, 'tts'), false)
    assert.equal(fleetBusyRetryPlan(paid, 'tts', 0), null)
  })

  test('its message has no credit or fallback talk, and says what happened in plain words', () => {
    assert.doesNotMatch(error.message, /credit|fallback|GenStudio/i)
    assert.match(error.message, /Provider reason: The Mac didn't answer in time\./)
    const paid = new GenStudioTtsTerminalFailureError(submitTimeout(PAID))
    assert.match(paid.message, /GenStudio reports 0 credits released\. No fallback route was attempted\./,
      'paid work keeps its honest settlement line')
  })

  test('the log line says why and what happens next', () => {
    assert.equal(freeMacWaitLine('Chapter 11', error, 30_000),
      'Chapter 11: the Mac didn\'t answer in time — will try another Mac in 30s.')
    const busy = new GenStudioTtsTerminalFailureError(submitTimeout(FREE, {
      failure_code: 'MACHINE_BUSY', failure_reason: null, recovery_required: false, recovery_state: null,
    }))
    assert.equal(freeMacWaitLine('Chapter 2', busy, 120_000),
      'Chapter 2: every Mac that can do this is busy or offline — will try another Mac in 2 min.')
  })
})

describe('every capacity answer on free work is a wait', () => {
  for (const code of ['SITE_CAPACITY_UNAVAILABLE', 'SITE_PLACEMENT_EXHAUSTED', 'LOCATION_NOT_READY', 'LOCATION_UNREACHABLE', 'MACHINE_BUSY']) {
    test(code, () => {
      const free = new GenStudioTtsTerminalFailureError(submitTimeout(FREE, { failure_code: code }))
      assert.equal(isFleetBusyFailure(free, 'tts'), true)
    })
  }

  test('a real failure on free work is still a failure', () => {
    for (const code of ['PROVIDER_FAILED', 'WORKER_TERMINAL_ERROR', 'MODEL_NOT_PACKAGED', 'IMAGE_CONTENT_REFUSED']) {
      assert.equal(isFleetBusyFailure(new GenStudioTtsTerminalFailureError(submitTimeout(FREE, { failure_code: code }))), false, code)
    }
  })

  test('a cancel is the owner speaking, free or not', () => {
    assert.equal(isFleetBusyFailure(new GenStudioTtsTerminalFailureError(submitTimeout(FREE, { cancelled: true }))), false)
  })

  test('LOCATION_* on paid work does not widen the paid rule', () => {
    const paid = new GenStudioTtsTerminalFailureError(submitTimeout(PAID, {
      failure_code: 'LOCATION_NOT_READY', recovery_required: false, recovery_state: null,
    }))
    assert.equal(isFleetBusyFailure(paid, 'tts'), false)
  })
})

describe('free work keeps waiting as long as the Gateway would; paid stays bounded', () => {
  const free = new GenStudioImageTerminalFailureError(submitTimeout(FREE))
  const paid = new GenStudioImageTerminalFailureError(submitTimeout(PAID, { recovery_required: false, recovery_state: null, reserved_credits: 20, released_credits: 20 }))

  test('paid: the three-step ladder, then a real failure', () => {
    assert.deepEqual([0, 1, 2].map(n => fleetBusyRetryPlan(paid, 'image', n)?.waitMs), FLEET_BUSY_RETRY_DELAYS_MS)
    assert.equal(fleetBusyRetryPlan(paid, 'image', 3), null)
    assert.equal(fleetBusyRetryPlan(paid, 'image', 0)?.reason, 'High demand right now')
  })

  test('free: the ladder, then every five minutes for about three hours', () => {
    const waits: number[] = []
    for (let n = 0; ; n++) {
      const plan = fleetBusyRetryPlan(free, 'image', n)
      if (!plan) break
      waits.push(plan.waitMs)
    }
    assert.equal(waits.length, FREE_MAC_WAIT_MAX_RETRIES)
    assert.deepEqual(waits.slice(0, 3), FLEET_BUSY_RETRY_DELAYS_MS)
    assert.ok(waits.slice(3).every(ms => ms === 300_000))
    const hours = waits.reduce((a, b) => a + b, 0) / 3_600_000
    assert.ok(hours >= 2.9 && hours <= 3.2, `about three hours, was ${hours.toFixed(2)}`)
  })
})

describe('every generator that waits uses the free-Mac rule (one test per job type)', () => {
  const freeOf = (Cls: new (job: any) => any, over: Record<string, unknown> = {}) => new Cls(submitTimeout(FREE, over))

  const cases: Array<[string, () => { reason: string } | null | boolean]> = [
    ['thumbnails / scene images (images.ts)', () => imageRetryPlan(freeOf(GenStudioImageTerminalFailureError), 1)],
    ['image pool', () => imagePoolFleetBusyRetryPlan(freeOf(GenStudioImageTerminalFailureError), 1)],
    ['scene review (continuity render)', () => continuityFleetBusyRetryPlan(freeOf(GenStudioImageTerminalFailureError), 1)],
    ['motion review / video clips', () => sceneClipFleetBusyRetryPlan(freeOf(GenStudioVideoTerminalFailureError), 1)],
    ['music', () => musicFleetBusyRetryPlan(freeOf(GenStudioMusicTerminalFailureError), 1)],
    ['contextual cues', () => contextualCueFleetBusyRetryPlan(freeOf(GenStudioChatTerminalFailureError), 0)],
    ['audio narration', () => fleetBusyRetryPlan(freeOf(GenStudioTtsTerminalFailureError), 'tts', 0)],
  ]
  for (const [name, plan] of cases) {
    test(name, () => {
      const result = plan()
      assert.ok(result && typeof result === 'object', `${name} must wait, not fail`)
      assert.equal(result.reason, FREE_MAC_WAIT_REASON)
    })
  }

  test('subtitles', () => {
    assert.equal(isFleetBusyTranscriptionFailure(freeOf(GenStudioTranscriptionTerminalFailureError)), true)
  })
})

describe('plain words from the Gateway', () => {
  test('a submit timeout', () => {
    assert.equal(humanGatewayText('hub submit failed: timed out'), 'The Mac didn\'t answer in time.')
    assert.equal(
      humanGatewayText('hub submit failed: timed out Upstream outcome is unknown; reconcile the provider request before retrying; the gateway will not resubmit it automatically.'),
      'The Mac didn\'t answer in time. The result is being checked; nothing was run twice.',
    )
    assert.equal(humanGatewayText('hub submit failed: Server disconnected'), 'The Mac could not take the request.')
  })
})
