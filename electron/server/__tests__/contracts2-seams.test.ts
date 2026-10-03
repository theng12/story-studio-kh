/**
 * Owner decisions of 2026-10-01 on the Story / Gateway / Hub seams: human failure text, the shelved
 * Whisper sentence, music length, the music download, and "the Gateway decides, Story follows".
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  DEFAULT_INSTRUMENTAL_TRACK_SECONDS,
  lyricSectionCount,
  musicDurationPlan,
  pickDefaultMusicModel,
} from '../contracts/music-model-choice.js'
import {
  GENSTUDIO_LONG_JOB_TIMEOUT_MS,
  GenStudioMusicArtifactUnavailableError,
  buildGenStudioMusicIdempotencyKey,
  customerSafeRemoteDetail,
  downloadGenStudioMusicTrack,
} from '../lib/genstudio-client.js'
import { carriesCapacityFacts, humanGatewayText, withoutControllerIds } from '../lib/gateway-failure-text.js'
import { unavailableTranscriptionModelMessage } from '../services/genstudio-model-migration.js'

describe('Whisper base/small are shelved: the failure says what to do', () => {
  test('a saved base or small id gets the sentence, in either namespace', () => {
    for (const id of ['studio-hub::mlx-community/whisper-small-mlx', 'studio-hub-local::mlx-community/whisper-base-mlx']) {
      assert.match(unavailableTranscriptionModelMessage(id), /Whisper base\/small are no longer offered — choose Whisper turbo in this preset/)
    }
  })
  test('any other missing model keeps a generic, still actionable sentence', () => {
    assert.match(unavailableTranscriptionModelMessage('groq-main::whisper-large-v3'), /no longer available\. Choose a current model/)
  })
})

describe('music length', () => {
  const stable = { id: 's', display_name: 'Stable Audio 3', min_duration_seconds: 1, max_duration_seconds: 380, default_duration_seconds: 30 }
  const yue = { id: 'y', display_name: 'YuE2', requires_lyrics: true, supports_vocals: true, min_duration_seconds: 8, max_duration_seconds: 360, default_duration_seconds: 36 }

  test('an instrumental track defaults to four minutes and the owner can change it', () => {
    assert.equal(DEFAULT_INSTRUMENTAL_TRACK_SECONDS, 240)
    assert.equal(musicDurationPlan(stable, {}).seconds, 240)
    assert.equal(musicDurationPlan(stable, { requestedSeconds: 120 }).seconds, 120)
  })
  test('a length past the model\'s own maximum is clamped and explained', () => {
    const plan = musicDurationPlan(stable, { requestedSeconds: 600 })
    assert.equal(plan.seconds, 380)
    assert.match(plan.note || '', /Stable Audio 3 makes tracks of 1–380 s, so 600 s was set to 380 s/)
  })
  test('a singing model\'s length follows its lyric sections, 30 s each', () => {
    const lyrics = '[Verse]\na\nb\n[Chorus]\nc\nd\n[Verse]\ne\nf\n[Chorus]\ng\nh\n[Outro]\ni'
    assert.equal(lyricSectionCount(lyrics), 5)
    const plan = musicDurationPlan(yue, { lyrics })
    assert.equal(plan.seconds, 150)
    assert.match(plan.note || '', /5 sections × 30 s = 150 s/)
  })
  test('a very long sheet is held to the model\'s maximum, a lone line to its minimum', () => {
    assert.equal(musicDurationPlan(yue, { lyrics: Array.from({ length: 20 }, () => '[Verse]\nx').join('\n') }).seconds, 360)
    assert.equal(lyricSectionCount('just one line'), 1)
    assert.equal(lyricSectionCount('a\nb\nc\nd\ne'), 2, 'no markers: a four-line stanza each')
  })
  test('a request for vocals prefers the model that sings; an instrumental one never lands on it', () => {
    assert.equal(pickDefaultMusicModel([stable, yue], { instrumental: false, hasLyrics: true })?.id, 'y')
    assert.equal(pickDefaultMusicModel([yue, stable], { instrumental: true, hasLyrics: false })?.id, 's')
  })
  test('with no model named, a free fleet model wins over a paid row listed first (Dreamlands E2E)', () => {
    const suno = { id: 'kie-ai-images::V6', price_source: 'provider_page' }
    const fleet = { ...stable, price_source: 'local' }
    assert.equal(pickDefaultMusicModel([suno, fleet], { instrumental: true, hasLyrics: false })?.id, 's')
    // Only paid rows: still served (the page says "may cost credits"), never silently refused.
    assert.equal(pickDefaultMusicModel([suno], { instrumental: true, hasLyrics: false })?.id, 'kie-ai-images::V6')
  })
  test('the idempotency key moves with the length but is unchanged when none is sent', () => {
    const base = { title: 't', prompt: 'p', instrumental: true, modelId: 'm', requestIdentity: 'r' }
    assert.equal(buildGenStudioMusicIdempotencyKey(base), buildGenStudioMusicIdempotencyKey({ ...base, durationSeconds: undefined }))
    assert.notEqual(buildGenStudioMusicIdempotencyKey(base), buildGenStudioMusicIdempotencyKey({ ...base, durationSeconds: 240 }))
    assert.notEqual(buildGenStudioMusicIdempotencyKey({ ...base, durationSeconds: 120 }), buildGenStudioMusicIdempotencyKey({ ...base, durationSeconds: 240 }))
  })
})

describe('the music download has a time limit and a retry', () => {
  const original = globalThis.fetch
  const restore = () => { globalThis.fetch = original }

  test('a dropped connection is retried and the track still arrives', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls < 3) throw new TypeError('fetch failed')
      return new Response(Buffer.from('RIFFWAVE'), { status: 200 })
    }) as typeof fetch
    try {
      const bytes = await downloadGenStudioMusicTrack('http://gw.test/t', {}, {}, 1)
      assert.equal(bytes.toString(), 'RIFFWAVE')
      assert.equal(calls, 3)
    } finally { restore() }
  })
  test('a pruned artifact is a clear, terminal answer, not a retry loop', async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls++; return new Response('gone', { status: 410 }) }) as typeof fetch
    try {
      await assert.rejects(downloadGenStudioMusicTrack('http://gw.test/t', {}, {}, 2), (error: unknown) =>
        error instanceof GenStudioMusicArtifactUnavailableError && /Track 2 is no longer on the gateway/.test(error.message))
      assert.equal(calls, 1)
    } finally { restore() }
  })
  test('a cancel stops it at once', async () => {
    globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    try {
      await assert.rejects(downloadGenStudioMusicTrack('http://gw.test/t', {}, { isCancelled: () => true }, 1), /Cancelled by user/)
    } finally { restore() }
  })
})

describe('the Gateway decides when a job is over; Story follows', () => {
  test('Story has no independent give-up shorter than a week', () => {
    assert.ok(GENSTUDIO_LONG_JOB_TIMEOUT_MS >= 7 * 24 * 60 * 60_000)
  })
})

describe('Gateway and Hub wording reaches the owner as plain sentences', () => {
  test('a worker error loses its operator prefix', () => {
    assert.equal(
      humanGatewayText('hub item error: WORKER_TERMINAL_ERROR: Generation hit repeated memory failures. Voice Studio is restarting automatically to recover.'),
      'Generation hit repeated memory failures. Voice Studio is restarting automatically to recover.')
  })
  test('refusal JSON, even cut off at 200 characters, becomes a sentence', () => {
    const raw = 'hub submit HTTP 409: {"detail":{"code":"MODEL_PAUSED","detail":"model is paused by the owner","readiness":{"state":"paus'
    assert.equal(humanGatewayText(raw), 'This model is paused on that Mac. model is paused by the owner')
    assert.doesNotMatch(humanGatewayText(raw), /[{}]|HTTP 409|MODEL_PAUSED/)
  })
  test('the retry-policy wrapper names no controller ids', () => {
    const raw = 'tried 2 machines and every one failed - studio-hub-9701220bf30f (PROVIDER_FAILED: hub item error: WORKER_TERMINAL_ERROR: out of memory); studio-hub-de7250e146a7 (LOCATION_NOT_READY: the location cannot serve this model right now (MACHINE_BUSY)). This is the end of the retry policy, not a queue wait.'
    const text = humanGatewayText(raw)
    assert.doesNotMatch(text, /studio-hub-|WORKER_TERMINAL_ERROR|PROVIDER_FAILED|retry policy/)
    assert.match(text, /^All 2 Macs that could run this tried and failed\./)
    assert.match(text, /out of memory/)
    assert.match(text, /busy with other work/)
  })
  test('the memory sentence is kept: it is the thing to read', () => {
    const waiting = 'waiting for memory: needs ~3.2GB, ~1.1GB free'
    assert.equal(carriesCapacityFacts(waiting), true)
    assert.equal(customerSafeRemoteDetail(waiting), waiting)
    const skip = 'image@mac-1: needs a ~16GB machine; this one has 8GB — trying other machines'
    assert.equal(customerSafeRemoteDetail(skip), 'image@mac-1: needs a ~16GB Mac; this one has 8GB — trying other Macs')
  })
  test('INSUFFICIENT_MEMORY reads as a sentence and keeps the Hub\'s figures', () => {
    assert.equal(
      humanGatewayText('the location cannot serve this model right now (INSUFFICIENT_MEMORY): needs ~16GB free, 6GB available'),
      'No Mac that can run this model has enough free memory right now. needs ~16GB free, 6GB available')
  })
  test('the gateway\'s restart suffix is replaced by what actually happens', () => {
    const text = humanGatewayText('The gateway restarted while this job was in flight, so its outcome is unknown. Upstream outcome is unknown; reconcile the provider request before retrying; the gateway will not resubmit it automatically.')
    assert.match(text, /being checked; nothing was run twice/)
    assert.doesNotMatch(text, /reconcile the provider request/)
  })
  test('controller ids are never shown, whatever the sentence', () => {
    assert.equal(withoutControllerIds('failed on studio-hub-9701220bf30f today'), 'failed on a Mac today')
  })
  test('plain text with nothing to translate is untouched', () => {
    assert.equal(humanGatewayText('The prompt was refused by the safety filter.'), 'The prompt was refused by the safety filter.')
  })
})

describe('a countdown does not re-persist the whole job', () => {
  test('ETA changes inside one 30 s bucket keep the same fingerprint; a new position or reason does not', async () => {
    const { providerQueueFingerprint } = await import('../lib/genstudio-client.js')
    const base = { id: 'j', state: 'accepted', queue_position: 3, queue_reason: 'provider_pace', queue_eta_seconds: 59 } as any
    assert.equal(providerQueueFingerprint(base), providerQueueFingerprint({ ...base, queue_eta_seconds: 31 }))
    assert.notEqual(providerQueueFingerprint(base), providerQueueFingerprint({ ...base, queue_eta_seconds: 29 }))
    assert.notEqual(providerQueueFingerprint(base), providerQueueFingerprint({ ...base, queue_position: 2 }))
    assert.notEqual(providerQueueFingerprint(base), providerQueueFingerprint({ ...base, queue_reason: null }))
  })
})
