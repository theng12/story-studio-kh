/**
 * HMH0001 (2026-10-21): a plan already on disk whose rows are below the renderer's
 * window (saved by an older build, or hand-edited) is caught at Video Assembly,
 * where each runt would be clamped to the 0.5 s floor and the scene track would
 * run past the narration.
 *
 * The guard rides the existing owner-controlled "Every second of narration has a
 * scene" switch — the same one the coverage audit uses — not a hidden gate: Block
 * stops, Off/Warn carry on and log the floor expansion.
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'

const SLUG = 'unrenderable-plan'
const CODE = 'EP0001'
let tmp: { dir: string; cleanup: () => Promise<void> }
let projectDir = ''

/** Rewrite the channel's switch for "Every second of narration has a scene". */
async function setNarrationCovered(mode: 'off' | 'warn' | 'block' | undefined): Promise<void> {
  await fs.writeFile(path.join(projectDir, 'config.json'), JSON.stringify(
    mode ? { safety_checks: { narration_covered: mode } } : {},
  ))
}

const job = () => ({ project_slug: SLUG, output_lines: [], result: {} }) as any

before(async () => {
  tmp = await useTempDataDir()
  projectDir = path.join(tmp.dir, 'projects', SLUG)
  const episodeDir = path.join(projectDir, 'episodes', 'Season 001', `${CODE} - Unrenderable`)
  const mergedDir = path.join(episodeDir, `${CODE} - 08 Audio Merge Output`)
  const imagesDir = path.join(episodeDir, 'scene_images')
  await fs.mkdir(mergedDir, { recursive: true })
  await fs.mkdir(imagesDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    slug: SLUG,
    name: 'Unrenderable plan',
    episode_prefix: 'EP',
    season_size: 20,
    season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
  }))
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [{ id: 'idea-1', title: 'Unrenderable', status: 'accepted', episode_code: CODE }],
    next_episode_number: 2,
    recycled_numbers: [],
  }))
  const firstImage = path.join(imagesDir, 's1.png')
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=16x16', '-frames:v', '1', firstImage])
  for (const id of ['s2', 's3', 's4']) await fs.writeFile(path.join(imagesDir, `${id}.png`), await fs.readFile(firstImage))
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=8000', '-t', '20',
    '-codec:a', 'libmp3lame', '-q:a', '9', path.join(mergedDir, `${CODE}_merged_audio.mp3`),
  ])
  await fs.writeFile(path.join(mergedDir, `${CODE}_merged_audio.completion.json`), JSON.stringify({
    output_filename: `${CODE}_merged_audio.mp3`, bytes: (await fs.stat(path.join(mergedDir, `${CODE}_merged_audio.mp3`))).size,
    duration_sec: 20, opening: { lead_in_sec: 0 },
  }))
  // Two mid-plan rows are ~10 ms each — a window no renderer can play. The total
  // still reaches the 20 s narration, so every coverage check passes; only the
  // renderer-floor invariant catches it.
  const rows = [
    { id: 's1', scene_index: 1, start_sec: 0, end_sec: 5 },
    { id: 's2', scene_index: 2, start_sec: 5, end_sec: 5.01 },
    { id: 's3', scene_index: 3, start_sec: 5.01, end_sec: 5.02 },
    { id: 's4', scene_index: 4, start_sec: 5.02, end_sec: 20 },
  ]
  await fs.writeFile(path.join(episodeDir, 'scene_plan.json'), JSON.stringify({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    research_used: false,
    opening_mode: 'from-start',
    total_duration_sec: 20,
    scenes: rows.map(row => ({
      ...row, transcript_segment: `Row ${row.scene_index} narration.`, visual_prompt: `Picture ${row.scene_index}.`, approved: true,
    })),
  }))
})

after(async () => { await tmp.cleanup() })

test('Block stops a saved plan whose rows are below the renderer window', async () => {
  await setNarrationCovered('block')
  const { prepareUnifiedVideoAssemblyInputs } = await import('../generators/video.js')
  await assert.rejects(
    () => prepareUnifiedVideoAssemblyInputs(SLUG, CODE, { subtitles: { enabled: false } } as any, job()),
    (error: any) => {
      assert.match(error.message, /2 of 4 scene\(s\) are below the 0\.5s window/)
      assert.match(error.message, /holds each such scene for the 0\.5s floor/, 'names the floor expansion')
      assert.match(error.message, /Reconcile timings on the Scene Plan page/, 'names the repair that keeps images')
      assert.match(error.message, /does not carry the existing images/, 'no false image-preservation promise')
      assert.doesNotMatch(error.message, /nothing rendered/i)
      return true
    },
  )
})

test('Warn carries on and records the floor expansion on the job', async () => {
  await setNarrationCovered('warn')
  const { prepareUnifiedVideoAssemblyInputs } = await import('../generators/video.js')
  const render = job()
  await prepareUnifiedVideoAssemblyInputs(SLUG, CODE, { subtitles: { enabled: false } } as any, render)
  assert.equal(render.result.safety_warnings[0].check, 'narration_covered', 'rides the owner switch, not a hidden gate')
  assert.ok(render.output_lines.some((line: string) => /0\.5s floor/.test(line)), 'logs the floor expansion')
})

test('Off carries on quietly but still logs the floor expansion', async () => {
  await setNarrationCovered('off')
  const { prepareUnifiedVideoAssemblyInputs } = await import('../generators/video.js')
  const render = job()
  await prepareUnifiedVideoAssemblyInputs(SLUG, CODE, { subtitles: { enabled: false } } as any, render)
  assert.equal(render.result.safety_warnings, undefined, 'Off does not raise a warning')
  assert.ok(render.output_lines.some((line: string) => /0\.5s floor/.test(line)), 'still says what will happen')
})
