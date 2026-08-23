/**
 * Which generators know that "every machine was busy" is worth waiting for.
 *
 * THE OWNER'S QUESTION, and the reason this register exists:
 *
 *   "we actually already reached render parts and we are only discovering this
 *    subtitle bugs right now. so i don't know what about the other generators
 *    and it's possible bugs that i don't get the chance to test yet."
 *
 * He is right, and an audit answered him: EIGHT generators handle GenStudio
 * terminal failures and, before 1.4.24, exactly ZERO waited when the fleet was
 * merely full. Every one of them drops the item and asks the owner to re-run.
 *
 * It has already happened twice, and only one of them was noticed:
 *   AUDIO_TRANSCRIPTION  122 refusals  2026-08-22   (found, because he ran 30 at once)
 *   VOICE_TTS              5 refusals  2026-08-13..15 (never noticed at all)
 *
 * The second line is the point. The symptom is a MISSING SECTION that a later
 * manual retry quietly fills in, so the failure looks like ordinary flakiness
 * and never gets investigated. That is why this is a register and not a note:
 * a gap nobody can see is a gap nobody fixes.
 *
 * AS OF 1.4.34 THE ANSWER TO HIS QUESTION IS "ALL OF THEM" (eight then, nine
 * since music arrived in 1.4.37). The debt list is
 * gone rather than left standing empty, because an empty list is a reassurance
 * nobody re-reads. What remains is stricter: EVERY generator that handles a
 * GenStudio terminal failure must use the shared rule. A new one that does not
 * fails this test the day it is written, so the question "what about the
 * others?" can never quietly go stale again.
 *
 * If a generator ever genuinely must not wait, add it to `EXEMPT` below WITH
 * the reason. Do not reintroduce a debt list — the whole point is that the gap
 * has to be argued for, not merely recorded.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  isFleetBusyFailure,
  FLEET_BUSY_FAILURE_CODES,
  FLEET_BUSY_RETRY_DELAYS_MS,
} from '../lib/genstudio-fleet-busy.js'
import {
  GenStudioTranscriptionTerminalFailureError,
  GenStudioTtsTerminalFailureError,
} from '../lib/genstudio-client.js'

const GENERATORS = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'generators')

/** Generators that wait and retry when the fleet is full. */
const PROTECTED = new Set([
  'subtitles.ts',   // 1.4.24 — the 122-refusal run that started this
  'audio.ts',       // 1.4.25 — the 5 refusals nobody noticed on 13-15 Aug
  'images.ts',      // 1.4.26 — 7,419 fleet-placed attempts in 30 days, the highest
                    //          volume in the app and it had never met a burst
  'scene-images-batch.ts', // 1.4.30 — also had to stop an in-memory manifest
                    //          entry diverging from disk, or an in-process
                    //          retry would derive a different identity than a
                    //          crash-replay: two identities for one retry.
  'continuity-render.ts', // 1.4.29 — Scene Review. Also had to suppress the
                    //          10-minute stall watchdog while waiting: a busy
                    //          fleet is exactly what trips it, and the pause it
                    //          raises would have cancelled the retry itself.
  'scene-clip.ts',  // 1.4.31 — Motion Review, and the worst shape of the six:
                    //          generateSceneClipsBatchJob loops every scene with
                    //          no per-scene catch, so one refusal on scene 3 of
                    //          50 threw out of the batch and ended the episode's
                    //          entire motion pass. Video is also the priciest
                    //          modality, so retrying anything wider would cost
                    //          the most here.
  'contextual-cues.ts', // 1.4.33 — the only one that already retried a
                    //          DIFFERENT capacity code. Its 15s backpressure
                    //          ladder was kept separate rather than widened: a
                    //          15s retry rejoins a jam GenStudio already waited
                    //          15 minutes on, and sharing a counter would have
                    //          let a fleet wait eat a backpressure attempt.
  'image-pool-generate.ts', // 1.4.34 — the last one, and the easiest to lose
                    //          work in unnoticed: a pool has no script or scene
                    //          list to check a shortfall against, so "40
                    //          images" quietly returning 31 has nothing to
                    //          contradict it.
  'music-generate.ts', // 1.4.37 — the ninth. Music is the first modality where
                    //          ONE charge yields TWO paid tracks, so a dropped
                    //          request loses twice as much as it looks like.
])

/**
 * Generators that handle a GenStudio terminal failure and deliberately do NOT
 * wait for the fleet. Empty, and it should stay that way: a name here needs a
 * reason beside it that survives being read aloud to the owner.
 */
const EXEMPT = new Map<string, string>([])

async function generatorsHandlingGenStudioFailures(): Promise<string[]> {
  const files = (await readdir(GENERATORS)).filter(f => f.endsWith('.ts'))
  const hits: string[] = []
  for (const f of files) {
    const body = await readFile(path.join(GENERATORS, f), 'utf8')
    if (/TerminalFailureError|isTerminalGenStudio/.test(body)) hits.push(f)
  }
  return hits.sort()
}

describe('the register of who waits for a busy fleet', () => {
  test('every generator that handles a GenStudio failure is accounted for', async () => {
    const handling = await generatorsHandlingGenStudioFailures()
    const unaccounted = handling.filter(f => !PROTECTED.has(f) && !EXEMPT.has(f))
    assert.deepEqual(unaccounted, [],
      `These generators handle GenStudio failures and do not wait for a busy fleet: ${unaccounted.join(', ')}. `
      + 'Add the fleet-busy retry and put them in PROTECTED, or argue the exemption in EXEMPT. '
      + 'Silently doing neither is how a generator drops the owner\'s work for a year without anyone noticing.')
  })

  test('a generator claiming protection actually imports the rule', async () => {
    // A name in PROTECTED that no longer uses the shared guard would be a
    // promise this file cannot keep.
    for (const f of PROTECTED) {
      const body = await readFile(path.join(GENERATORS, f), 'utf8')
      assert.match(body, /genstudio-fleet-busy/,
        `${f} is listed as protected but does not use the shared fleet-busy rule`)
    }
  })

  test('all nine are protected, and an exemption must carry its reason', async () => {
    const handling = await generatorsHandlingGenStudioFailures()
    assert.equal(handling.length, 9,
      `Expected the nine known GenStudio generators, found ${handling.length}: ${handling.join(', ')}. `
      + 'A new one is not a problem — add it to PROTECTED and update this count — but it must not '
      + 'arrive unnoticed.')
    assert.deepEqual([...handling].filter(f => !PROTECTED.has(f)), [],
      'every generator that handles a GenStudio failure now waits for a busy fleet')
    for (const [name, reason] of EXEMPT) {
      assert.ok(reason.trim().length > 20,
        `${name} is exempt without a reason worth reading. An exemption is an argument, not a list entry.`)
    }
  })
})

describe('the rule itself', () => {
  const job = (over: Record<string, unknown>) => ({
    id: 'j', state: 'failed', cancelled: false,
    reserved_credits: 20, settled_credits: 0, released_credits: 20, ...over,
  }) as any

  test('a busy fleet with the money returned is retryable', () => {
    for (const code of FLEET_BUSY_FAILURE_CODES) {
      assert.equal(isFleetBusyFailure(
        new GenStudioTranscriptionTerminalFailureError(job({ failure_code: code }))), true)
    }
  })

  test('modality is enforced, so one busy queue is not licence for another', () => {
    const tts = new GenStudioTtsTerminalFailureError(job({ failure_code: 'SITE_PLACEMENT_EXHAUSTED' }))
    assert.equal(isFleetBusyFailure(tts), true, 'unqualified, any modality qualifies')
    assert.equal(isFleetBusyFailure(tts, 'transcription'), false,
      'a busy TTS queue must not license a transcription resubmission')
    assert.equal(isFleetBusyFailure(tts, 'tts'), true)
  })

  test('money settled means stop, whatever the code says', () => {
    assert.equal(isFleetBusyFailure(new GenStudioTranscriptionTerminalFailureError(
      job({ failure_code: 'SITE_PLACEMENT_EXHAUSTED', settled_credits: 20, released_credits: 0 }))), false)
  })

  test('the waits are minutes and bounded', () => {
    assert.ok(FLEET_BUSY_RETRY_DELAYS_MS.every(d => d >= 30_000))
    assert.ok(FLEET_BUSY_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) <= 600_000)
  })
})
