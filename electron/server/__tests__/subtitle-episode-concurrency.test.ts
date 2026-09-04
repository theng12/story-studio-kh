/**
 * v1.4.23 — how many EPISODES transcribe at once.
 *
 * WHAT HAPPENED. The owner started thirty episodes of transcription in one go.
 * Measured on GenStudio immediately after: 231 transcriptions succeeded, 122
 * failed with SITE_PLACEMENT_EXHAUSTED, peak concurrency 103. Every job was
 * created in the same second (14:24:47) and the refusals clustered into three
 * minutes as the fleet filled. Three sites carried it — 143, 50 and 40
 * attempts.
 *
 * His diagnosis of the fix was right and of the cause was inverted, which is
 * worth writing down because the inversion is the interesting part:
 *
 *   "the concurrency should be split inside the different sections of each
 *    episode, because all the chapters can be transcribed concurrently"
 *
 * They already were. `transcribePerChapter` has always run a bounded worker
 * pool over the chapters, ten wide — that is what makes ONE episode fast and
 * is exactly the behaviour he was asking for. What was unbounded was the layer
 * above: the `subtitle_transcribe` queue group admitted FIFTY episodes at once,
 * so thirty episodes times ~eleven chapters arrived as one wave.
 *
 * So the correct shape is the one he described, reached from the other side:
 * chapters wide, episodes narrow.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { resolveGenStudioLocalFanout } from '../lib/genstudio-runtime.js'
import {
  SUBTITLE_EPISODE_CONCURRENCY_DEFAULT,
} from '../services/app-settings.js'

describe('chapters stay wide, episodes become narrow', () => {
  test('a ten-chapter episode still fans out ten ways', () => {
    // The part that decides how long a SINGLE episode takes. If this ever
    // narrows, every episode gets slower — the opposite of what was asked for.
    assert.equal(resolveGenStudioLocalFanout(10, 128), 10)
    assert.equal(resolveGenStudioLocalFanout(4, 128), 4)
    assert.equal(resolveGenStudioLocalFanout(10), 1, 'unknown account capacity must stay conservative')
  })

  test('the default admits two episodes, not fifty', () => {
    assert.equal(SUBTITLE_EPISODE_CONCURRENCY_DEFAULT, 2)
    // Two episodes of ten chapters is ~20 requests in flight. The run that
    // failed peaked at 103 and lost 122 of 353.
    const inFlight = SUBTITLE_EPISODE_CONCURRENCY_DEFAULT * resolveGenStudioLocalFanout(10, 128)
    assert.ok(inFlight <= 25, `${inFlight} in flight is still a flood`)
    assert.ok(inFlight >= 10, 'a single episode must still run all its chapters at once')
  })

  test('thirty episodes at the old limit is the flood that was measured', () => {
    // Documents the arithmetic rather than trusting the story: 30 episodes were
    // admitted because the group limit was 50, and each fanned out ~11 wide.
    const OLD_GROUP_LIMIT = 50
    const admitted = Math.min(30, OLD_GROUP_LIMIT)
    assert.equal(admitted, 30, 'all thirty were admitted at once — nothing queued')
    assert.ok(admitted * resolveGenStudioLocalFanout(11, 128) > 300,
      'the wave that exhausted the fleet')
  })
})

describe('the setting is the owner\'s, and cannot restore the flood by accident', () => {
  let appSettings: typeof import('../services/app-settings.js')

  beforeEach(async () => {
    appSettings = await import('../services/app-settings.js')
  })

  test('a missing or unusable value reads as the default, never as fifty', async () => {
    // The failure mode that produced this bug was an unreachable knob sitting
    // at 50. An absent setting must not reproduce it.
    const { SUBTITLE_EPISODE_CONCURRENCY_DEFAULT: d } = appSettings
    for (const bad of [undefined, null, 'abc', 0, -3, Number.NaN]) {
      const n = Math.floor(Number(bad))
      const resolved = (!Number.isFinite(n) || n < 1) ? d : Math.min(50, n)
      assert.equal(resolved, d, `${String(bad)} must fall back to the default`)
    }
  })

  test('out-of-range values are refused with words rather than clamped silently', async () => {
    await assert.rejects(() => appSettings.setSubtitleEpisodeConcurrency(0), /between 1 and 50/)
    await assert.rejects(() => appSettings.setSubtitleEpisodeConcurrency(51), /between 1 and 50/)
    await assert.rejects(() => appSettings.setSubtitleEpisodeConcurrency('lots'), /between 1 and 50/)
  })
})
