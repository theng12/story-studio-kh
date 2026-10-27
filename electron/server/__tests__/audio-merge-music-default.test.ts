/**
 * Background music default (owner, 2026-10-26, after DM0018/PR0039 were mixed
 * with an 8% bed that buried the Khmer narration): 6% under the narration is
 * the starting level, and it applies to an UNSET value only. A stated value —
 * the page's control, a saved preset — is the customer's choice and is never
 * rewritten (AGENTS.md §5).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_BACKGROUND_MUSIC_VOLUME_PERCENT } from '../contracts/music-bed-defaults.js'
import { useTempDataDir } from './_helpers.js'
import { applyNicheToFormat, loadFormat } from '../services/format-loader.js'
import { loadNiche } from '../services/niche-loader.js'
import { resolveStepParams } from '../routes/pipeline.js'
import type { Format } from '../models/types.js'

const { DEFAULT_BACKGROUND_MUSIC_VOLUME, resolveBackgroundMusicVolume } = await import('../generators/audio-merge.js')

let temp: Awaited<ReturnType<typeof useTempDataDir>>
before(async () => { temp = await useTempDataDir() })
after(async () => { await temp.cleanup() })

test('an unset level starts at 6%', () => {
  assert.equal(DEFAULT_BACKGROUND_MUSIC_VOLUME, 0.06)
  assert.deepEqual(resolveBackgroundMusicVolume(undefined), { volume: 0.06, defaulted: true })
  assert.deepEqual(resolveBackgroundMusicVolume(null), { volume: 0.06, defaulted: true })
  assert.deepEqual(resolveBackgroundMusicVolume(''), { volume: 0.06, defaulted: true })
  assert.deepEqual(resolveBackgroundMusicVolume(Number.NaN), { volume: 0.06, defaulted: true })
})

/**
 * ONE default, not three copies. The generator mixes in linear gain, the page and the pool panel
 * show a percentage, and all of them read `contracts/music-bed-defaults.ts`; a copy in each is how
 * "6%" silently became "8%" in the first place (DM0018/PR0039).
 */
test('the generator and the UI read the same 6%', () => {
  assert.equal(DEFAULT_BACKGROUND_MUSIC_VOLUME_PERCENT, 6)
  assert.equal(DEFAULT_BACKGROUND_MUSIC_VOLUME, DEFAULT_BACKGROUND_MUSIC_VOLUME_PERCENT / 100)
})

test('a stated level — a preset at 8%, a customer at 3% — passes through untouched', () => {
  assert.deepEqual(resolveBackgroundMusicVolume(0.08), { volume: 0.08, defaulted: false })
  assert.deepEqual(resolveBackgroundMusicVolume(0.03), { volume: 0.03, defaulted: false })
  assert.deepEqual(resolveBackgroundMusicVolume(0), { volume: 0, defaulted: false }, '0 is a real choice (music muted)')
  assert.deepEqual(resolveBackgroundMusicVolume('0.5'), { volume: 0.5, defaulted: false })
})

/**
 * A stated value above unity is a percentage that skipped its one conversion (a mix saved before
 * 1.4.361). It is refused before any FFmpeg work instead of being replayed as 8× the voice or being
 * squeezed silently into range — the DM0018/PR0039 defect either way (lib/audio-gain.ts).
 */
test('a stated level above unity is refused before any work', async () => {
  const { generateAudioMerge } = await import('../generators/audio-merge.js')
  const job = {
    job_id: 'legacy-percent-level', project_slug: 'no-such-project', episode_id: 'EP0001', type: 'audio_merge',
    status: 'running', created_at: new Date().toISOString(), output_lines: [],
    params: {
      episode_id: 'EP0001', chapters: [], gap_duration: 0, normalize_volume: false,
      music: { enabled: true, source: 'manual', files: [], volume: 8 },
    },
  }
  await assert.rejects(generateAudioMerge(job as never), /Background music level 8 is not a gain Story can apply/)
})

/**
 * A REGULAR narrated channel reaches the one default by STATING NOTHING: its Formula (Sleep, and
 * every other narrated built-in) names no `starting_music_volume`, so the effective format carries
 * no `musicVolume` and nothing overrides the generator's 6%.
 */
test('a regular narrated Formula names no music level, so the 6% default is the one that applies', async () => {
  const shell = await loadFormat('continuity-chain')
  assert.ok(shell, 'the shell format loads')
  const sleep = await loadNiche('sleep')
  assert.ok(sleep, 'the sleep Formula loads')
  const format = applyNicheToFormat(shell!, sleep!)
  // The shell's own chapter pause survives; no music level is invented.
  assert.equal(format.script.audioMergeDefaults?.gapDurationSec, 3)
  assert.equal(format.script.audioMergeDefaults?.musicVolume, undefined)
})

test('a Formula that names its own level keeps it (Quote Shorts: prominent music at 55%)', async () => {
  const shell = await loadFormat('continuity-chain')
  const shorts = await loadNiche('quote-shorts')
  const format = applyNicheToFormat(shell!, shorts!)
  assert.equal(format.script.audioMergeDefaults?.musicVolume, shorts!.startingMusicVolume)
  assert.equal(format.script.audioMergeDefaults?.musicVolume, 55)
})

/**
 * The Pipeline batch path: an Audio Assembly preset that states no level leaves `music.volume`
 * unset rather than writing the historical 8% (or any other number), which is what lets the
 * generator apply 6%. A preset that states one is converted once and wins (§5).
 */
test('a batch with no stated level forwards nothing, so the generator uses 6%; a stated one wins', () => {
  const format = { script: { audioMergeDefaults: { normalizeVolume: true, gapDurationSec: 3 } } } as unknown as Format
  const preset = (data: Record<string, unknown>) => ({ id: 'p1', name: 'Preset', data })

  const unstated = resolveStepParams('audio_merge', 'EP0001', 'Merge', preset({
    music: { enabled: true, source: 'manual', files: [] },
  }), format)
  assert.equal(unstated.music?.volume, undefined, 'no level is invented at the batch boundary')
  assert.deepEqual(resolveBackgroundMusicVolume(unstated.music?.volume), { volume: 0.06, defaulted: true })

  const stated = resolveStepParams('audio_merge', 'EP0001', 'Merge', preset({
    music: { enabled: true, source: 'manual', files: [], volume: 12 },
  }), format)
  assert.equal(stated.music?.volume, 0.12, '12% converted once to linear gain')

  // A Formula that names its own level reaches the batch through the format defaults.
  const shorts = { script: { audioMergeDefaults: { musicVolume: 55, gapDurationSec: 3 } } } as unknown as Format
  const fromFormula = resolveStepParams('audio_merge', 'EP0001', 'Merge', preset({
    music: { enabled: true, source: 'manual', files: [] },
  }), shorts)
  assert.equal(fromFormula.music?.volume, 0.55)
})
