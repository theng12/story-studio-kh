/**
 * v1.4.314 — which merged track "Reconcile timings" measures.
 *
 * The reconcile records the measured narration length on the plan
 * (`source_merged_audio.duration_sec`) and uses it as the authoritative end. For
 * PR0002/PR0003 the base 14-voice test merge was the LARGER file, so measuring by
 * size re-anchored the plan to the track the owner had NOT chosen.
 *
 * The fix is the explicit pin, not a global re-ordering:
 *   - an episode the owner pinned measures the PINNED track (the same file the
 *     stitcher and the renderer use);
 *   - an episode nobody pinned keeps this site's own long-standing rule — the
 *     LARGEST audio file — so it behaves exactly as it did before the pin existed.
 *
 * The two merged tracks are real (ffmpeg), because the measured length is the
 * observable: base ≈ 5 s, `_v2` ≈ 25 s, and the plan/caption timeline runs to 30 s
 * so the auto-realign coverage check is satisfied either way.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'

const SLUG = 'reconcile-chosen-merge'
let tmp: { dir: string; cleanup: () => Promise<void> }

before(async () => {
  tmp = await useTempDataDir()
  const projectDir = path.join(tmp.dir, 'projects', SLUG)
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'Reconcile Chosen Merge', episode_prefix: 'EP', season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
  }))
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [1, 2].map(i => ({ id: `idea-${i}`, title: `Ep ${i}`, status: 'accepted', episode_code: `EP000${i}` })),
    next_episode_number: 3, recycled_numbers: [],
  }))
})

after(async () => { await tmp.cleanup() })

/** A 30 s plan/caption timeline beside two real merged tracks: base ≈ 5 s, `_v2` ≈ 25 s. */
async function episode(code: string) {
  const n = Number(code.slice(-1))
  const episodeDir = path.join(tmp.dir, 'projects', SLUG, 'episodes', 'Season 001', `${code} - Ep ${n}`)
  const mergedDir = path.join(episodeDir, `${code} - 08 Audio Merge Output`)
  const subtitlesDir = path.join(episodeDir, `${code} - 09 Subtitles Output`)
  for (const dir of [mergedDir, subtitlesDir]) await fs.mkdir(dir, { recursive: true })

  const make = (name: string, seconds: number) => runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=8000,atrim=duration=${seconds}`,
    '-codec:a', 'libmp3lame', '-q:a', '9', path.join(mergedDir, name),
  ])
  await make(`${code}_merged_audio.mp3`, 5)
  await make(`${code}_merged_audio_v2.mp3`, 25)
  await fs.writeFile(path.join(mergedDir, `${code}_merged_audio.completion.json`), JSON.stringify({
    output_filename: `${code}_merged_audio.mp3`, duration_sec: 5, opening: { lead_in_sec: 0 },
  }))

  const t = (sec: number) => `00:00:${String(sec).padStart(2, '0')},000`
  await fs.writeFile(path.join(subtitlesDir, `${code}_stitched.srt`),
    `1\n${t(0)} --> ${t(30)}\nalpha one two three\n`)

  await fs.writeFile(path.join(episodeDir, 'scene_plan.json'), JSON.stringify({
    schema_version: 1, generated_at: new Date().toISOString(), research_used: false, opening_mode: 'from-start',
    total_duration_sec: 30,
    scenes: [{ id: 's1', scene_index: 1, start_sec: 0, end_sec: 30, transcript_segment: 'alpha one two three', visual_prompt: 'alpha', approved: true }],
  }))
  return { episodeDir, mergedDir }
}

async function measuredSec(episodeDir: string): Promise<number> {
  const plan = JSON.parse(await fs.readFile(path.join(episodeDir, 'scene_plan.json'), 'utf-8'))
  return Number(plan.source_merged_audio?.duration_sec)
}

test('with no pin the reconcile measures the largest merged track (this site\'s legacy rule)', async () => {
  const { episodeDir } = await episode('EP0001')
  const { reconcileScenePlanTimings } = await import('../services/scene-plan-reconcile.js')
  await reconcileScenePlanTimings(SLUG, 'EP0001', { auto: true })
  const measured = await measuredSec(episodeDir)
  assert.ok(measured > 20, `the larger (_v2, ~25s) track must be measured, got ${measured}`)
})

test('with a pin the reconcile measures the pinned track instead', async () => {
  const { episodeDir, mergedDir } = await episode('EP0002')
  const { writeSelectedMergedAudio } = await import('../lib/merged-audio-selection.js')
  await writeSelectedMergedAudio(mergedDir, 'EP0002_merged_audio.mp3')
  const { reconcileScenePlanTimings } = await import('../services/scene-plan-reconcile.js')
  await reconcileScenePlanTimings(SLUG, 'EP0002', { auto: true })
  const measured = await measuredSec(episodeDir)
  assert.ok(measured > 0 && measured < 20, `the pinned base (~5s) track must be measured, got ${measured}`)
})
