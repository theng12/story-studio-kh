/**
 * An appended outro must play under the ORIGINAL episode mix — the bed, levels and narration that
 * were actually merged — never today's Audio Assembly preset and never a new Music Pool pick.
 * The evidence is the merge record's own snapshot, or (for a merge made before that snapshot) exactly
 * one completed Audio Assembly job whose output line names this exact file. Anything ambiguous or
 * missing is refused before a write; a merge that recorded no bed leaves the outro silent.
 *
 * Pure selection and span arithmetic: no FFmpeg, no queue, no network.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  closingTailRemixSpan, originalMixSettings, selectOriginalMix,
} from '../services/closing-tail-remix.js'

const CODE = 'EP001'
const MERGED = '/episodes/Season 001/EP001 - Test/merged/EP001_merged_audio.mp3'

const record = (extra: Record<string, any> = {}) => ({
  output_filename: 'EP001_merged_audio.mp3',
  duration_sec: 100,
  background_music: true,
  ...extra,
})

const doneJob = (params: any, lines: string[] = [`Output: ${MERGED}`]) => ({
  status: 'done' as const, episode_id: 'EP001', output_lines: lines, params,
})

const mixOf = (evidence: ReturnType<typeof selectOriginalMix>) => {
  assert.equal(evidence.action, 'mix')
  return evidence.action === 'mix' ? evidence.mix : {}
}

test('the completion record snapshot is the original mix, ahead of any job', () => {
  const evidence = selectOriginalMix({
    record: record({
      original_mix: {
        music: { enabled: true, files: ['/music/original.mp3'], volume: 0.12 },
        narration_volume: 0.9, normalize_volume: false,
      },
    }),
    jobs: [doneJob({ music: { enabled: true, files: ['/music/other.mp3'], volume: 0.9 } })],
    code: CODE, mergedPath: MERGED,
  })
  const mix = mixOf(evidence)
  assert.equal(mix.music.files[0], '/music/original.mp3')
  assert.equal(mix.music.volume, 0.12)
  assert.equal(mix.narration_volume, 0.9)
  assert.equal(evidence.action === 'mix' && evidence.source, 'record')
})

test('a legacy merge is proven by exactly one done job whose output line names this exact file', () => {
  const evidence = selectOriginalMix({
    record: record(),
    jobs: [doneJob({ music: { enabled: true, files: ['/music/original.mp3'], volume: 0.08 } })],
    code: CODE, mergedPath: MERGED,
  })
  const mix = mixOf(evidence)
  assert.equal(mix.music.volume, 0.08)
  assert.equal(evidence.action === 'mix' && evidence.source, 'job')
})

test('two jobs claiming the same output are ambiguous and refused, never guessed', () => {
  const evidence = selectOriginalMix({
    record: record(),
    jobs: [
      doneJob({ music: { enabled: true, files: ['/a.mp3'], volume: 0.1 } }),
      doneJob({ music: { enabled: true, files: ['/b.mp3'], volume: 0.2 } }),
    ],
    code: CODE, mergedPath: MERGED,
  })
  assert.equal(evidence.action, 'refuse')
  assert.match(evidence.action === 'refuse' ? evidence.reason : '', /2 completed Audio Assembly jobs/)
})

test('a job naming a different file (even a prefix/suffix) is not evidence', () => {
  for (const line of [`Output: ${MERGED}.bak`, `Output: ${MERGED.replace('EP001', 'EP002')}`, 'Output: somewhere/EP001_merged_audio.mp3']) {
    const evidence = selectOriginalMix({ record: record(), jobs: [doneJob({ music: { files: ['/a.mp3'] } }, [line])], code: CODE, mergedPath: MERGED })
    assert.equal(evidence.action, 'refuse', line)
    assert.match(evidence.action === 'refuse' ? evidence.reason : '', /no completed Audio Assembly job records the mix/)
  }
})

test('a job from another episode is not evidence', () => {
  const evidence = selectOriginalMix({
    record: record(),
    jobs: [{ ...doneJob({ music: { files: ['/a.mp3'] } }), episode_id: 'EP002' }],
    code: CODE, mergedPath: MERGED,
  })
  assert.equal(evidence.action, 'refuse')
})

test('missing evidence and empty job params are refused', () => {
  assert.equal(selectOriginalMix({ record: record(), jobs: [], code: CODE, mergedPath: MERGED }).action, 'refuse')
  assert.equal(selectOriginalMix({ record: record(), jobs: [doneJob({})], code: CODE, mergedPath: MERGED }).action, 'refuse')
  assert.equal(selectOriginalMix({ record: record(), jobs: [doneJob({ chapters: ['/x.mp3'] })], code: CODE, mergedPath: MERGED }).action, 'refuse')
})

test('the original merge recorded no bed: the outro stays silent even when a job has music', () => {
  const evidence = selectOriginalMix({
    record: record({ background_music: false }),
    jobs: [doneJob({ music: { enabled: true, files: ['/a.mp3'], volume: 0.1 } })],
    code: CODE, mergedPath: MERGED,
  })
  assert.equal(evidence.action, 'none')
})

test('a record that does not say whether it had a bed is unknown, never "none"', () => {
  const unknown: Record<string, any> = { ...record() }
  delete unknown.background_music
  const evidence = selectOriginalMix({ record: unknown, jobs: [doneJob({ music: { files: ['/a.mp3'] } })], code: CODE, mergedPath: MERGED })
  assert.equal(evidence.action, 'refuse')
  assert.match(evidence.action === 'refuse' ? evidence.reason : '', /does not say whether this audio carries a music bed/)
})

test('only mix settings are copied; chapters, paths and secrets are not', () => {
  const mix = originalMixSettings({
    chapters: ['/episode/EP001_Chapter_01.mp3'],
    api_key: 'secret',
    music: { enabled: true, files: ['/music/a.mp3'], volume: 0.1 },
    narration_volume: 1,
    effects_tracks: [{ source_path: '/fx/a.wav', volume: 0.2 }],
  })
  assert.deepEqual(Object.keys(mix || {}).sort(), ['effects_tracks', 'music', 'narration_volume'])
  assert.equal((mix as any).api_key, undefined)
  assert.equal((mix as any).chapters, undefined)
})

test('the original held tail is the truth when an outro extends it', () => {
  // A 15 s held tail baked earlier, a preset that now says 25 s, a 10 s outro: keep 15 + 10.
  assert.deepEqual(
    closingTailRemixSpan({ currentTailSec: 15, currentOutroSec: 0, postRollSec: 25, outroSec: 10 }),
    { heldSec: 15, totalSec: 25 },
  )
  // An existing outro is replaced by the new span, not stacked on itself.
  assert.deepEqual(
    closingTailRemixSpan({ currentTailSec: 25, currentOutroSec: 10, postRollSec: 25, outroSec: 10 }),
    { heldSec: 15, totalSec: 25 },
  )
  // No outro: the ordinary path is unchanged.
  assert.deepEqual(
    closingTailRemixSpan({ currentTailSec: 0, currentOutroSec: 0, postRollSec: 25, outroSec: 0 }),
    { heldSec: 25, totalSec: 25 },
  )
})

test('a pooled original bed is pinned to manual with its exact files, so no new pick is taken', () => {
  const evidence = selectOriginalMix({
    record: record({
      original_mix: {
        music: { enabled: true, source: 'pool', files: ['/music/original-pool.mp3'], volume: 0.1 },
        narration_volume: 0.9,
      },
    }),
    jobs: [],
    code: CODE, mergedPath: MERGED,
  })
  const mix = mixOf(evidence)
  assert.equal(mix.music.source, 'manual')
  assert.deepEqual(mix.music.files, ['/music/original-pool.mp3'])
  assert.equal(mix.narration_volume, 0.9)
})

test('an enabled bed with no exact files is refused, never proven by levels alone', () => {
  const snapshots = [
    { narration_volume: 0.8 },
    { music: { enabled: true, files: [] } },
    { music: { enabled: false, files: ['/music/a.mp3'] } },
    { music: { enabled: true, files: [''] } },
  ]
  for (const original_mix of snapshots) {
    const evidence = selectOriginalMix({ record: record({ original_mix }), jobs: [], code: CODE, mergedPath: MERGED })
    assert.equal(evidence.action, 'refuse', JSON.stringify(original_mix))
    assert.match(evidence.action === 'refuse' ? evidence.reason : '', /no enabled background music files/)
  }
  const legacy = selectOriginalMix({
    record: record(),
    jobs: [doneJob({ narration_volume: 0.8 })],
    code: CODE, mergedPath: MERGED,
  })
  assert.equal(legacy.action, 'refuse')
  assert.match(legacy.action === 'refuse' ? legacy.reason : '', /records no enabled background music files/)
})
