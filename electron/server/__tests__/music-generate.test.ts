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
import fsp, { mkdir, mkdtemp, readFile, stat, writeFile, readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { GenStudioMusicTerminalFailureError } from '../lib/genstudio-client.js'
import {
  MUSIC_GENSTUDIO_MODALITY,
  musicFleetBusyRetryPlan,
  musicTrackFilename,
  saveMusicTrack,
  resolveMusicModel,
} from '../generators/music-generate.js'
import { FLEET_BUSY_RETRY_DELAYS_MS } from '../lib/genstudio-fleet-busy.js'
import { pickDefaultMusicModel } from '../contracts/music-model-choice.js'

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

  test('(b) legacy settlement never decides a capacity retry, but an unknown outcome stops it', () => {
    assert.deepEqual(musicFleetBusyRetryPlan(failure({ settled_credits: 100, released_credits: 0 }), 1), musicFleetBusyRetryPlan(failure(), 1))
    assert.equal(musicFleetBusyRetryPlan(failure({ recovery_required: true }), 1), null)
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
    assert.match(a, /take1\.m4a$/)
    assert.match(musicTrackFilename('x', 'job_music_abcdef12', 1, 'mp3'), /take1\.mp3$/)
  })

  test('a title of pure punctuation still yields a usable filename', () => {
    assert.match(musicTrackFilename('!!! ???', 'job_music_abcdef12', 1), /^track-/)
  })
})

describe('the run stops for the right things and continues for the rest', () => {
  test('insufficient credits stops the whole top-up', async () => {
    const body = await readFile(SRC, 'utf8')
    assert.match(body, /if \(isGenStudioPaymentRefusal\(error\)\) throw error/,
      'every later request would fail identically; twenty failures help nobody')
  })

  test('one failed track does not abandon the others', async () => {
    const body = await readFile(SRC, 'utf8')
    assert.match(body, /Continuing with the rest/)
    // 1.4.270: tracks run concurrently; failures are kept per track (behaviour: music-generate-concurrent.test.ts).
    assert.match(body, /failuresByIndex\[index\] = /)
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

/**
 * Contract audit 2026-10-01 — the default model must be one that can make what is asked.
 *
 * The gateway lists the Hub's models in catalogue order and YuE2 comes first. YuE2's lane states
 * `lyrics` required and "no instrumental switch", so `models[0]` for a lyric-less top-up is a
 * certain Hub refusal. The gateway now publishes `requires_lyrics` / `supports_instrumental` from
 * the lane contract; these pin that Story reads them.
 */
describe('the default music model can make a lyric-less track', () => {
  const yue2 = { id: 'studio-hub::vanch007/mlx-Yue2-3B', requires_lyrics: true, supports_instrumental: false, supports_vocals: true }
  const stable = { id: 'studio-hub::stabilityai/stable-audio-3-optimized' }
  test('a vocal-only first row is skipped when there are no lyrics', () => {
    assert.equal(resolveMusicModel([yue2, stable], '').id, stable.id)
  })
  test('the page and the generator choose the same row', () => {
    assert.equal(pickDefaultMusicModel([yue2, stable], { instrumental: true, hasLyrics: false })?.id, stable.id)
  })
  test('with lyrics the vocal model is a fair first choice again', () => {
    assert.equal(resolveMusicModel([yue2, stable], '', { instrumental: false, hasLyrics: true }).id, yue2.id)
  })
  test('unstated capabilities never rule a model out', () => {
    assert.equal(resolveMusicModel([{ id: 'a', requires_lyrics: null }, { id: 'b' }], '').id, 'a')
  })
  test('if every model needs lyrics it refuses before anything is charged', () => {
    assert.throws(() => resolveMusicModel([yue2], ''), /needs lyrics[\s\S]*Nothing was charged/)
  })
  test('a named model is never second-guessed', () => {
    assert.equal(resolveMusicModel([yue2, stable], yue2.id).id, yue2.id)
  })
})

describe('a WAV track is stored as AAC (v1.4.244)', () => {
  const tone = async (dir: string, seconds: number) => {
    const wav = path.join(dir, `tone-${seconds}.wav`)
    const r = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-ar', '44100', '-ac', '2', wav])
    assert.equal(r.status, 0)
    return { wav, bytes: await readFile(wav) }
  }
  const probe = (f: string) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout.toString())

  test('WAV -> .m4a, same duration, much smaller, no scratch left behind', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'music-aac-'))
    const { bytes } = await tone(dir, 20)
    const lib = await mkdtemp(path.join(os.tmpdir(), 'music-lib-'))
    const saved = await saveMusicTrack(lib, 'Rain', 'job_music_abcdef12', 1, bytes)
    assert.match(saved.filename, /take1\.m4a$/)
    assert.equal(saved.warning, undefined)
    assert.ok(Math.abs(probe(path.join(lib, saved.filename)) - 20) < 0.03, 'duration within 30 ms')
    const size = (await stat(path.join(lib, saved.filename))).size
    console.log(`music: 20 s WAV ${bytes.length} B -> m4a ${size} B (${(100 * size / bytes.length).toFixed(1)}%)`)
    assert.ok(size < bytes.length / 4)
    assert.deepEqual(await readdir(lib), [saved.filename])
  })

  test('an m4a body (the Hub already encoded it) is stored as .m4a byte for byte, with no ffmpeg run', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'music-m4a-'))
    const { wav } = await tone(dir, 10)
    const m4a = path.join(dir, 'hub.m4a')
    assert.equal(spawnSync('ffmpeg', ['-y', '-i', wav, '-c:a', 'aac', '-b:a', '256k', '-f', 'ipod', m4a]).status, 0)
    const body = await readFile(m4a)
    const lib = await mkdtemp(path.join(os.tmpdir(), 'music-lib-'))
    // A PATH with no ffmpeg proves the bytes are not re-encoded: a second lossy generation would need it.
    const realPath = process.env.PATH
    process.env.PATH = '/nonexistent'
    try {
      const saved = await saveMusicTrack(lib, 'Rain', 'job_music_abcdef12', 1, body)
      assert.match(saved.filename, /take1\.m4a$/)
      assert.equal(saved.warning, undefined)
      assert.deepEqual(await readFile(path.join(lib, saved.filename)), body)
      assert.deepEqual(await readdir(lib), [saved.filename])
    } finally {
      process.env.PATH = realPath
    }
    assert.ok(Math.abs(probe(path.join(lib, 'rain-abcdef12-take1.m4a')) - 10) < 0.03)
  })

  test('an MP3 body passes through unchanged under the old name', async () => {
    const lib = await mkdtemp(path.join(os.tmpdir(), 'music-lib-'))
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 7)])
    const saved = await saveMusicTrack(lib, 'Rain', 'job_music_abcdef12', 2, mp3)
    assert.match(saved.filename, /take2\.mp3$/)
    assert.deepEqual(await readFile(path.join(lib, saved.filename)), mp3)
  })

  test('an encode failure keeps the paid WAV bytes and warns instead of failing', async () => {
    const lib = await mkdtemp(path.join(os.tmpdir(), 'music-lib-'))
    // RIFF/WAVE header with no audio: ffmpeg cannot encode it.
    const broken = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(40, 1)])
    const saved = await saveMusicTrack(lib, 'Rain', 'job_music_abcdef12', 1, broken)
    assert.match(saved.filename, /take1\.mp3$/)
    assert.match(saved.warning ?? '', /kept the original WAV/)
    assert.deepEqual(await readFile(path.join(lib, saved.filename)), broken)
    assert.deepEqual(await readdir(lib), [saved.filename])
  })

  test('two m4a tracks still stitch to the sum of their lengths', async () => {
    const { buildStitchArgs, buildConcatList } = await import('../services/music-render.js')
    const dir = await mkdtemp(path.join(os.tmpdir(), 'music-stitch-'))
    const lib = path.join(dir, 'lib'); await import('node:fs/promises').then(f => f.mkdir(lib))
    const a = await saveMusicTrack(lib, 'A', 'job_music_aaaaaaaa', 1, (await tone(dir, 12)).bytes)
    const b = await saveMusicTrack(lib, 'B', 'job_music_bbbbbbbb', 1, (await tone(dir, 17)).bytes)
    const list = path.join(dir, 'list.txt')
    await writeFile(list, buildConcatList([path.join(lib, a.filename), path.join(lib, b.filename)]))
    const out = path.join(dir, 'mix.mp3')
    assert.equal(spawnSync('ffmpeg', buildStitchArgs(list, out, 0)).status, 0)
    assert.ok(Math.abs(probe(out) - 29) < 0.06, `stitched ${probe(out)}`)
  })
})

describe('direct M4A publication is one staged, synced, no-replace writer (2026-10-16)', () => {
  // `isMp4Audio` reads only the `ftyp` box marker; the fill makes each body's bytes distinct.
  const m4a = (fill: number) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A '), Buffer.alloc(4096, fill)])
  const projectLibrary = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'music-publish-'))
    const lib = path.join(root, 'projects', 'chan', 'music-library')
    await mkdir(lib, { recursive: true })
    return { lib, candidates: path.join(root, 'projects', '_trash', 'chan', 'music-library-publication-candidates') }
  }

  const candidateBytes = async (candidates: string) =>
    Promise.all((await readdir(candidates).catch(() => [] as string[])).map(name => readFile(path.join(candidates, name))))

  test('direct M4A publication exposes only a complete synced final file and drops its staging name', async () => {
    const { lib, candidates } = await projectLibrary()
    const body = m4a(1)
    const saved = await saveMusicTrack(lib, 'Rain', 'task-00000001', 1, body)
    assert.equal(saved.disposition, 'created')
    assert.equal(saved.size, body.length)
    assert.match(saved.sha256 || '', /^[0-9a-f]{64}$/)
    assert.deepEqual(await readFile(path.join(lib, saved.filename)), body)
    assert.deepEqual(await readdir(lib), [saved.filename], 'no staging file is left beside the library')
    assert.deepEqual(await candidateBytes(candidates), [], 'a successful save leaves nothing in Trash: the bytes live on under the final name')
  })

  test('normal and recovery writers racing the same destination admit one exact body; equal replay succeeds and different bytes are retained/refused', async () => {
    const { lib, candidates } = await projectLibrary()
    const winner = m4a(2)
    const other = m4a(3)
    const results = await Promise.allSettled([
      saveMusicTrack(lib, 'Rain', 'task-00000002', 1, winner),
      saveMusicTrack(lib, 'Rain', 'task-00000002', 1, winner),
      saveMusicTrack(lib, 'Rain', 'task-00000002', 1, other),
    ])
    assert.equal(results[0]!.status === 'fulfilled' && results[0]!.value.disposition, 'created')
    assert.equal(results[1]!.status === 'fulfilled' && results[1]!.value.disposition, 'equal-replay')
    assert.equal(results[2]!.status, 'rejected')
    const refusal = (results[2] as PromiseRejectedResult).reason
    assert.equal(refusal.statusCode, 409)
    assert.match(refusal.message, /different audio; it was kept and not replaced/)
    const filename = musicTrackFilename('Rain', 'task-00000002', 1)
    assert.deepEqual(await readFile(path.join(lib, filename)), winner, 'the final file is never replaced')
    assert.deepEqual(await readdir(lib), [filename])
    assert.deepEqual(await candidateBytes(candidates), [other], 'only the refused body is retained in Trash')
  })

  test('a crash before publication leaves no partial final-path file', async () => {
    const { lib, candidates } = await projectLibrary()
    const body = m4a(4)
    const realLink = fsp.link
    fsp.link = async () => { throw Object.assign(new Error('simulated crash before publication'), { code: 'EIO' }) }
    try {
      await assert.rejects(saveMusicTrack(lib, 'Rain', 'task-00000003', 1, body), /simulated crash before publication/)
    } finally {
      fsp.link = realLink
    }
    assert.deepEqual(await readdir(lib), [], 'no final file and no partial file')
    assert.deepEqual(await candidateBytes(candidates), [body], 'the failed publication keeps its only copy in Trash')
  })

  test('a failure after exclusive publication leaves a complete final file and its staging alias retained in Trash', async () => {
    const { lib, candidates } = await projectLibrary()
    const body = m4a(5)
    const filename = musicTrackFilename('Rain', 'task-00000004', 1)
    const realOpen = fsp.open
    fsp.open = (async (target: any, flags?: any, mode?: any) => {
      if (target === lib && flags === 'r') throw new Error('simulated crash after publication')
      return realOpen(target, flags, mode)
    }) as typeof fsp.open
    try {
      await assert.rejects(saveMusicTrack(lib, 'Rain', 'task-00000004', 1, body), /simulated crash after publication/)
    } finally {
      fsp.open = realOpen
    }
    assert.deepEqual(await readFile(path.join(lib, filename)), body, 'the published file is complete')
    assert.deepEqual(await readdir(lib), [filename])
    assert.deepEqual(await candidateBytes(candidates), [body])
    // A restart replays the same bytes harmlessly and adds nothing to Trash.
    assert.equal((await saveMusicTrack(lib, 'Rain', 'task-00000004', 1, body)).disposition, 'equal-replay')
    assert.deepEqual(await readdir(lib), [filename])
    assert.equal((await candidateBytes(candidates)).length, 1)
  })
})
