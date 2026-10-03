/**
 * v1.4.37 — the GenStudio music path.
 *
 * Music is the first modality where ONE settled, once-charged job yields MORE
 * THAN ONE paid artefact. Measured on the first music job ever run through
 * GenStudio (2026-08-23, `job_4da3074488384d49b363802ed0aa478a`): Suno V5.5
 * reserved 100 credits, captured 100, and returned two complete tracks — 2:50
 * and 3:09. Both are the owner's.
 *
 * The failure this file exists to prevent is silent: a caller taking
 * `outputs[0]` and throwing away a song that was paid for. Nothing would error,
 * nothing would appear in a log, and the only symptom would be a library that
 * fills at half the expected rate. So the result type carries an ARRAY, and
 * these tests pin that it is read whole.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  GenStudioMusicTerminalFailureError,
  buildGenStudioMusicIdempotencyKey,
} from '../lib/genstudio-client.js'
import { isFleetBusyFailure } from '../lib/genstudio-fleet-busy.js'

const CLIENT = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'genstudio-client.ts')

const settled = (over: Record<string, unknown> = {}) => ({
  id: 'job_music_1',
  state: 'failed',
  cancelled: false,
  failure_code: 'SITE_PLACEMENT_EXHAUSTED',
  reserved_credits: 100,
  settled_credits: 0,
  released_credits: 100,
  ...over,
}) as any

describe('a music failure is an ordinary Gateway failure', () => {
  test('it carries the modality the fleet-busy rule will be asked about', () => {
    assert.equal(new GenStudioMusicTerminalFailureError(settled()).modality, 'music')
  })

  test('a busy fleet with the credits returned whole is retryable', () => {
    // The register now fails any generator that handles a terminal failure
    // without waiting for a busy fleet, so the music generator will have to
    // pass its own modality here. This proves the rule accepts it.
    assert.equal(isFleetBusyFailure(new GenStudioMusicTerminalFailureError(settled()), 'music'), true)
  })

  test('the same code with credits SETTLED is never retryable', () => {
    const paid = new GenStudioMusicTerminalFailureError(settled({ settled_credits: 100, released_credits: 0 }))
    assert.equal(isFleetBusyFailure(paid, 'music'), false)
  })

  test('a busy fleet in another modality is not licence to resubmit a song', () => {
    assert.equal(isFleetBusyFailure(new GenStudioMusicTerminalFailureError(settled()), 'image'), false)
  })

  test('a cancelled job is the owner speaking and is never resubmitted', () => {
    const cancelled = new GenStudioMusicTerminalFailureError(settled({ cancelled: true }))
    assert.equal(isFleetBusyFailure(cancelled, 'music'), false)
  })

  test('the settlement it reports is the Gateway\'s, never derived locally', () => {
    const e = new GenStudioMusicTerminalFailureError(settled())
    assert.equal(e.reservedCredits, 100)
    assert.equal(e.settledCredits, 0)
    assert.equal(e.releasedCredits, 100)
  })
})

describe('the idempotency key describes the song that was bought', () => {
  const base = { title: 'Adagio', prompt: 'string orchestra, slow', instrumental: true, modelId: 'suno-v5-5' }

  test('the same request produces the same key, so a lost response replays', () => {
    assert.equal(
      buildGenStudioMusicIdempotencyKey(base),
      buildGenStudioMusicIdempotencyKey({ ...base }),
    )
  })

  test('vocals make it a DIFFERENT song, so the key must move', () => {
    // Otherwise asking for the vocal version of a brief would replay the
    // instrumental job and hand back the wrong audio as if it were new.
    assert.notEqual(
      buildGenStudioMusicIdempotencyKey(base),
      buildGenStudioMusicIdempotencyKey({ ...base, instrumental: false }),
    )
  })

  test('lyrics change the key', () => {
    assert.notEqual(
      buildGenStudioMusicIdempotencyKey({ ...base, instrumental: false }),
      buildGenStudioMusicIdempotencyKey({ ...base, instrumental: false, lyrics: 'a verse' }),
    )
  })

  test('the retry identity moves the key, which is what makes a retry possible', () => {
    // A settled-failed job can never be reopened. Without this component a
    // retry would replay the dead key forever and return the same failure.
    assert.notEqual(
      buildGenStudioMusicIdempotencyKey(base),
      buildGenStudioMusicIdempotencyKey({ ...base, requestIdentity: 'retry:abc123' }),
    )
  })

  test('whitespace around a title or prompt does not buy a second song', () => {
    assert.equal(
      buildGenStudioMusicIdempotencyKey(base),
      buildGenStudioMusicIdempotencyKey({ ...base, title: '  Adagio  ', prompt: ' string orchestra, slow ' }),
    )
  })
})

describe('every track a job returned is kept', () => {
  test('the result type is an array, not a single url', async () => {
    const body = await readFile(CLIENT, 'utf8')
    assert.match(body, /export interface GenStudioMusicResult \{[\s\S]{0,400}?tracks: GenStudioMusicTrack\[\]/,
      'a single-url result would let a caller drop a paid song without noticing')
  })

  test('the reader maps EVERY output, and never indexes the first', async () => {
    const body = await readFile(CLIENT, 'utf8')
    const fn = body.slice(body.indexOf('function musicResult('))
    const end = fn.indexOf('\n}')
    const source = fn.slice(0, end)
    assert.match(source, /\(completed\.outputs \|\| \[\]\)[\s\S]*?\.map\(/,
      'tracks must come from mapping the whole outputs list')
    assert.doesNotMatch(source, /outputs\[0\]|outputs\?\.\[0\]/,
      'taking the first output is the exact silent data loss this modality invites')
  })

  test('a succeeded job with no tracks is refused, not returned empty', async () => {
    const body = await readFile(CLIENT, 'utf8')
    assert.match(body, /but sent no tracks/,
      'an empty result would look to a caller exactly like a song deliberately not kept')
  })

  test('music is not registered as a /v1/models capability operation', async () => {
    // Music has its own catalogue at /v1/music/models. Widening the capability
    // union to satisfy evidence recording would make that type claim a row
    // shape GenStudio never emits.
    const body = await readFile(CLIENT, 'utf8')
    assert.match(body, /const operations = new Set\(\['voice\.tts', 'audio\.transcription', 'image\.generation', 'chat\.response', 'video\.generation'\]\)/)
    assert.match(body, /type GenStudioOperation = GenStudioModelCapability\['operation'\] \| 'music\.generation'/)
  })
})
