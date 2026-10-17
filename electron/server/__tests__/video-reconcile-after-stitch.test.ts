/**
 * v1.4.314 — a first-pass render stitches the CHOSEN track before it re-anchors
 * the plan.
 *
 * Video Assembly re-anchors an out-of-step Scene Plan against the episode's
 * stitched captions. Those captions are offset by the chosen merged track's
 * intro lead-in, so the stitch has to be current BEFORE the reconciliation runs.
 * The reverse order (reconcile, then stitch) re-anchored the plan to the
 * PREVIOUS track's captions and then rewrote them, leaving the plan a whole
 * lead-in out of step — and it was reachable on any render-only/batch run,
 * where the page's preflight never brought the stitch up to date first.
 *
 * This is the render-only/batch case exactly: no `{CODE}_stitched.srt` exists
 * yet, so the reconciliation has nothing to measure against until the pass
 * stitches the chosen track. Before the fix the reconcile ran first and gave up
 * ("could not be re-aligned"), then the branch stitched; the plan was never
 * re-anchored. After the fix the stitch comes first and the plan is re-anchored.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

const SLUG = 'reconcile-after-stitch'
const CODE = 'EP0001'
let tmp: { dir: string; cleanup: () => Promise<void> }

before(async () => {
  tmp = await useTempDataDir()
  const projectDir = path.join(tmp.dir, 'projects', SLUG)
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'Reconcile After Stitch', episode_prefix: 'EP', season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
  }))
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [{ id: 'idea-1', title: 'Ep 1', status: 'accepted', episode_code: CODE }],
    next_episode_number: 2, recycled_numbers: [],
  }))
})

after(async () => { await tmp.cleanup() })

/**
 * Two chapters, each one cue matching one scene's transcript, a merged track
 * whose lead-in the record can measure (so no ffprobe is needed), and a plan
 * whose two scenes overlap by a second — enough to trigger the auto-reconcile.
 * Deliberately NO `{CODE}_stitched.srt`: the pass must create it.
 */
async function episode() {
  const episodeDir = path.join(tmp.dir, 'projects', SLUG, 'episodes', 'Season 001', `${CODE} - Ep 1`)
  const imagesDir = path.join(episodeDir, 'scene_images')
  const mergedDir = path.join(episodeDir, `${CODE} - 08 Audio Merge Output`)
  const subtitlesDir = path.join(episodeDir, `${CODE} - 09 Subtitles Output`)
  for (const dir of [imagesDir, mergedDir, subtitlesDir]) await fs.mkdir(dir, { recursive: true })

  await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({
    gap_duration_s: 1,
    sections: [{ slug: 'chapter_1', duration_s: 6 }, { slug: 'chapter_2', duration_s: 6 }],
  }))
  await fs.writeFile(path.join(subtitlesDir, `${CODE}_chapter_1.srt`),
    '1\n00:00:00,000 --> 00:00:06,000\nalpha one two three\n')
  await fs.writeFile(path.join(subtitlesDir, `${CODE}_chapter_2.srt`),
    '1\n00:00:00,000 --> 00:00:06,000\nbravo one two three\n')

  await fs.writeFile(path.join(mergedDir, `${CODE}_merged_audio.mp3`), 'not really audio')
  await fs.writeFile(path.join(mergedDir, `${CODE}_merged_audio.completion.json`), JSON.stringify({
    output_filename: `${CODE}_merged_audio.mp3`,
    duration_sec: 13,
    opening: { lead_in_sec: 0, music_lead_in_sec: 0 },
  }))

  const scenes = [
    { id: 's1', scene_index: 1, start_sec: 0, end_sec: 7, transcript_segment: 'alpha one two three', visual_prompt: 'alpha', approved: true },
    { id: 's2', scene_index: 2, start_sec: 6, end_sec: 13, transcript_segment: 'bravo one two three', visual_prompt: 'bravo', approved: true },
  ]
  for (const scene of scenes) await fs.writeFile(path.join(imagesDir, `${scene.id}.png`), 'png')
  await fs.writeFile(path.join(episodeDir, 'scene_plan.json'), JSON.stringify({
    schema_version: 1, generated_at: new Date().toISOString(), research_used: false, opening_mode: 'from-start',
    total_duration_sec: 13, scenes,
  }))
  return { subtitlesDir }
}

test('a first-pass render stitches the chosen track before re-anchoring the plan', async () => {
  const { subtitlesDir } = await episode()
  const stitched = path.join(subtitlesDir, `${CODE}_stitched.srt`)
  assert.equal(existsSync(stitched), false, 'the fixture starts with no stitched transcript')

  const { prepareUnifiedVideoAssemblyInputs } = await import('../generators/video.js')
  const job = { output_lines: [] as string[] } as any
  // Whatever later gates this bare fixture does not satisfy are not the subject here.
  await prepareUnifiedVideoAssemblyInputs(SLUG, CODE, { subtitles: { enabled: true } } as any, job).catch(() => {})

  const stitchIdx = job.output_lines.findIndex((line: string) => /^Subtitles: stitched /.test(line))
  const reconcileIdx = job.output_lines.findIndex((line: string) => /^Scene Plan: .*re-anchored the timings/.test(line))

  assert.ok(stitchIdx >= 0, `the chosen track was stitched:\n${job.output_lines.join('\n')}`)
  assert.ok(
    reconcileIdx >= 0,
    `the plan was re-anchored against those captions:\n${job.output_lines.join('\n')}`,
  )
  assert.ok(
    stitchIdx < reconcileIdx,
    `the stitch must feed the reconciliation, not follow it:\n${job.output_lines.join('\n')}`,
  )
  assert.ok(existsSync(stitched), 'the pass produced the stitched timeline it re-anchored against')
})
