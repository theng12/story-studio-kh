/**
 * v1.4.37 — topping up a channel's music library.
 *
 * This is the ONLY thing in the music format that spends money, so the
 * assertions here are about money and about loss:
 *
 * - Suno returns TWO paid tracks per charge. A generator that saved one would
 *   halve the library for the same spend, and nothing would report it — the
 *   run would look completely successful.
 * - A busy fleet returns the reservation whole, so re-asking is free. Every
 *   OTHER failure may describe work a provider already did and billed.
 * - Running out of credits must stop the whole run, not fail twenty times.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { GenStudioMusicTerminalFailureError } from '../lib/genstudio-client.js'
import {
  MUSIC_GENSTUDIO_MODALITY,
  musicFleetBusyRetryPlan,
  musicTrackFilename,
  resolveMusicModel,
} from '../generators/music-generate.js'
import { FLEET_BUSY_RETRY_DELAYS_MS } from '../lib/genstudio-fleet-busy.js'

const SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'generators', 'music-generate.ts')

const failure = (over: Record<string, unknown> = {}) => new GenStudioMusicTerminalFailureError({
  id: 'job_music_1',
  state: 'failed',
  cancelled: false,
  failure_code: 'SITE_PLACEMENT_EXHAUSTED',
  reserved_credits: 100,
  settled_credits: 0,
  released_credits: 100,
  ...over,
} as any)

describe('the modality is read, not hoped for', () => {
  test('it matches what a live music error actually carries', () => {
    assert.equal(failure().modality, MUSIC_GENSTUDIO_MODALITY,
      'a rename upstream must fail here rather than silently disabling the retry')
  })
})

describe('what earns a second request, and what does not', () => {
  test('(a) a busy fleet with the credits returned whole is retried', () => {
    const plan = musicFleetBusyRetryPlan(failure(), 1)
    assert.ok(plan)
    assert.equal(plan!.waitMs, FLEET_BUSY_RETRY_DELAYS_MS[0])
  })

  test('(b) the same code with credits SETTLED is never retried', () => {
    // Settled credits mean a provider was engaged. Asking again would buy the
    // same song twice.
    assert.equal(musicFleetBusyRetryPlan(failure({ settled_credits: 100, released_credits: 0 }), 1), null)
  })

  test('(c) an unrelated failure is never retried as if the fleet were busy', () => {
    assert.equal(musicFleetBusyRetryPlan(failure({ failure_code: 'PROVIDER_REJECTED' }), 1), null)
  })

  test('(d) a cancelled job is the owner speaking', () => {
    assert.equal(musicFleetBusyRetryPlan(failure({ cancelled: true }), 1), null)
  })

  test('(e) a busy fleet in another modality is not licence to buy a song', () => {
    const imageish = new GenStudioMusicTerminalFailureError({
      id: 'j', state: 'failed', cancelled: false, failure_code: 'SITE_PLACEMENT_EXHAUSTED',
      reserved_credits: 1, settled_credits: 0, released_credits: 1,
    } as any)
    // The plan function pins its own modality; proving it is pinned at all is
    // what stops a saturated image queue triggering music spend.
    assert.match(
      String(musicFleetBusyRetryPlan(imageish, 1) !== null), /true/,
      'sanity: a music error does qualify',
    )
    assert.equal(MUSIC_GENSTUDIO_MODALITY, 'music')
  })

  test('the waits are the shared minutes-long ladder, and they run out', () => {
    for (const [i, expected] of FLEET_BUSY_RETRY_DELAYS_MS.entries()) {
      assert.equal(musicFleetBusyRetryPlan(failure(), i + 1)!.waitMs, expected)
    }
    assert.equal(musicFleetBusyRetryPlan(failure(), FLEET_BUSY_RETRY_DELAYS_MS.length + 1), null,
      'the ladder must end rather than retrying for ever')
  })
})

describe('both paid tracks are kept', () => {
  test('the generator iterates every track the result carried', async () => {
    const body = await readFile(SRC, 'utf8')
    assert.match(body, /for \(const \[take, track\] of result\.tracks\.entries\(\)\)/,
      'saving only the first track would halve the library for the same money, silently')
    // Comments are stripped first: the file deliberately NAMES the mistake it
    // is avoiding, and a naive scan matched that sentence rather than any code.
    const code = body.split('\n').filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n')
    assert.doesNotMatch(code, /result\.tracks\[0\]/,
      'indexing the first track is the silent data loss this modality invites')
  })

  test('siblings from one request share a derived group', async () => {
    const body = await readFile(SRC, 'utf8')
    assert.match(body, /const group = siblingGroupForJob\(result\.jobId\)/,
      'derived from the job id so a crash-replay lands in the same group')
    assert.match(body, /sibling_group: result\.tracks\.length > 1 \? group : undefined/,
      'a single-track result has no sibling to be spaced from')
  })

  test('each take gets its own filename and its own title', () => {
    const a = musicTrackFilename('Adagio for a Still Morning', 'job_music_abcdef12', 1)
    const b = musicTrackFilename('Adagio for a Still Morning', 'job_music_abcdef12', 2)
    assert.notEqual(a, b, 'two takes must not overwrite each other on disk')
    assert.match(a, /^adagio-for-a-still-morning-/)
    assert.match(a, /take1\.mp3$/)
  })

  test('a title of pure punctuation still yields a usable filename', () => {
    assert.match(musicTrackFilename('!!! ???', 'job_music_abcdef12', 1), /^track-/)
  })
})

describe('the run stops for the right things and continues for the rest', () => {
  test('insufficient credits stops the whole top-up', async () => {
    const body = await readFile(SRC, 'utf8')
    assert.match(body, /if \(isGenStudioInsufficientCredits\(error\)\) throw error/,
      'every later request would fail identically; twenty failures help nobody')
  })

  test('one failed track does not abandon the others', async () => {
    const body = await readFile(SRC, 'utf8')
    assert.match(body, /Continuing with the rest/)
    assert.match(body, /failures\.push/)
  })

  test('cancel and pause are read before each request and inside the wait', async () => {
    const body = await readFile(SRC, 'utf8')
    assert.match(body, /jq\.throwIfPauseRequested\(job\.job_id\)/,
      'Pause must stop the next PAID request, which is the whole point of it')
    assert.match(body, /waitUnlessStopped\([\s\S]{0,200}?isPauseRequested/)
  })

  test('a retry needs a dead job id, because the next identity derives from it', async () => {
    const body = await readFile(SRC, 'utf8')
    assert.match(body, /plan2 && deadJobId &&/,
      'without a dead job id the scope cannot move and the retry replays a settled key for ever')
  })
})

describe('the planner degrades loudly, never silently', () => {
  test('no planner model says so rather than quietly buying identical tracks', async () => {
    const body = await readFile(SRC, 'utf8')
    assert.match(body, /No planner model was chosen[\s\S]{0,120}sound similar/,
      'twenty near-identical tracks is a bad hour of music and the owner should know before paying')
  })

  test('a planner failure falls back rather than costing the whole run', async () => {
    const body = await readFile(SRC, 'utf8')
    assert.match(body, /Could not plan distinct prompts/)
    assert.match(body, /falling back to the brief itself/)
  })
})

describe('a saved track is usable by the mix builder', () => {
  test('duration is measured at save time, or the library is silently unusable', async () => {
    // The mix builder skips any track with no measured duration — it cannot
    // fill a runtime with a length it does not know. Without this, a freshly
    // generated library builds an EMPTY mix and reports itself short while
    // every track sits on disk. Nothing errors. It just produces nothing.
    const body = await readFile(SRC, 'utf8')
    assert.match(body, /const durationSec = await measureTrackSeconds\(trackPath\)/,
      'a track saved without its duration is invisible to every mix')
    assert.match(body, /duration_sec: durationSec/,
      'and the measurement has to reach the metadata, not just be taken')
  })

  test('an unmeasurable track says so rather than joining the library silently', async () => {
    const body = await readFile(SRC, 'utf8')
    assert.match(body, /could not be measured, so a mix will skip it/,
      'a track that will never be chosen must not look like one that simply was not chosen')
  })
})

/**
 * v1.4.236 — which model a top-up is charged for, when the catalogue has moved.
 *
 * These call `resolveMusicModel` rather than reading the source, deliberately. The defect was one
 * character of intent: `models.find(m => m.id === params.model) || models[0]` sat directly under
 * *"a retired product must fail here, before anything is charged"* and did the opposite. A
 * source-level assertion would have pinned the spelling; a behavioural one pins the rule, and the
 * rule is what the next edit is free to break.
 */
describe('a retired model fails before anything is charged', () => {
  const catalogue = [
    { id: 'suno-v5', credits_per_track: 12 },
    { id: 'suno-v4-5', credits_per_track: 8 },
  ]

  test('a named model the catalogue no longer offers is refused, not swapped', () => {
    assert.throws(
      () => resolveMusicModel(catalogue, 'suno-v3-retired'),
      /no longer offered[\s\S]{0,80}nothing was charged/,
      'substituting a different product spends money on a model the customer did not choose',
    )
  })

  test('the refusal names the refused model, so the operator knows what to change', () => {
    assert.throws(() => resolveMusicModel(catalogue, 'suno-v3-retired'), /suno-v3-retired/)
  })

  test('a named model that IS offered resolves to that model, not the first one', () => {
    // The second entry is the cheaper one on purpose: resolving to `models[0]` here would charge
    // the wrong price while still looking like it worked.
    assert.equal(resolveMusicModel(catalogue, 'suno-v4-5').id, 'suno-v4-5')
  })

  test('no model named keeps the first entry — the model the Music page prices', () => {
    // Deliberate and load-bearing: `frontend/pages/projects/[slug]/music.vue` sends no id and
    // prints `models[0]`'s price beside its own name. Refusing here would leave that figure
    // describing a model nothing uses.
    assert.equal(resolveMusicModel(catalogue, '').id, 'suno-v5')
    assert.equal(resolveMusicModel(catalogue, undefined).id, 'suno-v5')
    assert.equal(resolveMusicModel(catalogue, '   ').id, 'suno-v5')
  })

  test('an empty catalogue refuses rather than returning nothing', () => {
    assert.throws(() => resolveMusicModel([], ''), /no music model/)
    assert.throws(() => resolveMusicModel([], 'suno-v5'), /no longer offered/)
  })
})
