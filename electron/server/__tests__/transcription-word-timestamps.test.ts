/**
 * Story Studio asks GenStudio for per-word timings on every transcription
 * (v1.1.0), and the request identity has to CHANGE when it does.
 *
 * Why this file exists at all: the flag is free and the words are stored
 * upstream, so banking them from now on costs nothing. But the request is
 * deduplicated in two independent places, and both were hardcoded to `false`:
 *
 *   - the LOCAL task-reuse hash, which decides whether to reconnect to a
 *     previously-submitted GenStudio task, and
 *   - the GenStudio IDEMPOTENCY KEY, which decides whether GenStudio runs the
 *     work or replays a stored result.
 *
 * Leave either at `false` and a with-timestamps request hashes identically to
 * the word-less job that already ran. GenStudio replays the old transcript,
 * the customer is charged nothing and told nothing, every status reports
 * success — and the words never arrive. That is the exact silent-success
 * failure the Verified Completion Contract exists to prevent, so it gets a
 * test rather than a comment.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { buildGenStudioTranscriptionIdempotencyKey } from '../lib/genstudio-client.js'
import { TRANSCRIPTION_WORD_TIMESTAMPS } from '../generators/subtitles.js'

const generatorSource = readFileSync(
  fileURLToPath(new URL('../generators/subtitles.ts', import.meta.url)),
  'utf8',
)
const recoverySource = readFileSync(
  fileURLToPath(new URL('../services/subtitle-recovery.ts', import.meta.url)),
  'utf8',
)

const BASE = {
  requestIdentity: 'demo:TN0001:transcription:TN0001_stitched.srt',
  fileSha256: 'a'.repeat(64),
  modelId: 'whisper-large-v3-turbo',
  language: 'en',
}

describe('per-word timings change the request, not just the payload', () => {
  test('Story Studio asks for word timings', () => {
    assert.equal(TRANSCRIPTION_WORD_TIMESTAMPS, true)
  })

  test('the Gateway idempotency key differs with and without word timings', () => {
    const without = buildGenStudioTranscriptionIdempotencyKey({ ...BASE, wordTimestamps: false })
    const with_ = buildGenStudioTranscriptionIdempotencyKey({ ...BASE, wordTimestamps: true })
    assert.notEqual(without, with_, 'same key = Gateway replays the word-less result')
  })

  test('an omitted flag hashes as false, so old keys stay stable', () => {
    // Existing accepted work must remain reconnectable; only the NEW shape is
    // a new identity.
    assert.equal(
      buildGenStudioTranscriptionIdempotencyKey(BASE),
      buildGenStudioTranscriptionIdempotencyKey({ ...BASE, wordTimestamps: false }),
    )
  })

  test('no transcription hash input is left hardcoded to false', () => {
    assert.ok(
      !/wordTimestamps:\s*false/.test(`${generatorSource}\n${recoverySource}`),
      'a hardcoded false in the reuse hash or idempotency key replays the old, word-less job',
    )
  })

  test('the recovery service folds the requested flag into every new provider identity', () => {
    const calls = [...recoverySource.matchAll(/buildGenStudioTranscriptionIdempotencyKey\(\{([\s\S]*?)\n\s*\}\)/g)]
    assert.ok(calls.length >= 1, `expected the shared identity builder, found ${calls.length}`)
    for (const [, body] of calls) {
      assert.match(body!, /wordTimestamps: input\.request\.wordTimestamps/)
    }
  })

  test('both local reuse hashes fold the flag in', () => {
    const hashes = [...generatorSource.matchAll(/hashInput\(JSON\.stringify\(\{([\s\S]*?)\n\s*\}\)\)/g)]
    assert.ok(hashes.length >= 2, `expected the merged and per-chapter reuse hashes, found ${hashes.length}`)
    for (const [, body] of hashes) {
      assert.match(body!, /wordTimestamps: TRANSCRIPTION_WORD_TIMESTAMPS/)
    }
  })

  test('both generator modes send the flag into the shared recovery boundary', () => {
    const requests = [...generatorSource.matchAll(/request:\s*\{([\s\S]*?)\n\s*\},/g)]
    assert.ok(requests.length >= 2, `expected the merged and per-chapter requests, found ${requests.length}`)
    for (const [, body] of requests) {
      assert.match(body!, /wordTimestamps: TRANSCRIPTION_WORD_TIMESTAMPS/)
    }
  })

  test('the manifest records what was asked for, so the UI can show it', () => {
    // Without this, a transcript made before v1.1.0 and one made after are
    // indistinguishable on disk, and the customer sees two episodes with
    // different caption quality and no explanation. Every transcription task
    // the shared durable writer must carry the request marker. Later immutable
    // provenance writes spread that already-validated manifest entry.
    assert.match(
      recoverySource,
      /recordTaskStrict\(outDir, manifestKey,[\s\S]{0,360}?word_timestamps: input\.request\.wordTimestamps/,
    )
  })
})
