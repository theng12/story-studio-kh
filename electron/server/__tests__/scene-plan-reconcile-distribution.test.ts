/**
 * HMH0001 (2026-10-21): "Reconcile timings" matched 35 of 899 scenes to the
 * current captions, interpolated the other 864, and reported success because
 * the total still reached the narration. The saved rows were not a timeline:
 * one scene held 2196 s, nine held 38.4 s, and 855 were about 11 ms each.
 * Video Assembly clamped every runt to 0.5 s, turning a 2823.8 s plan into a
 * 3241.8 s scene track.
 *
 * This pins the write boundary: a sparse re-anchoring must refuse and leave
 * the plan on disk untouched, not save a plan that can only render flashing
 * frames.
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'

const SLUG = 'reconcile-distribution'
const CODE = 'EP0001'
let tmp: { dir: string; cleanup: () => Promise<void> }
let planPath = ''

const FIRST = 'A paper kite climbs over the quiet hill before the storm.'
const LAST = 'The last light leaves the valley and the river goes dark.'

before(async () => {
  tmp = await useTempDataDir()
  const projectDir = path.join(tmp.dir, 'projects', SLUG)
  const episodeDir = path.join(projectDir, 'episodes', 'Season 001', `${CODE} - Distribution`)
  const mergedDir = path.join(episodeDir, `${CODE} - 08 Audio Merge Output`)
  const subtitlesDir = path.join(episodeDir, `${CODE} - 09 Subtitles Output`)
  await fs.mkdir(mergedDir, { recursive: true })
  await fs.mkdir(subtitlesDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    slug: SLUG,
    name: 'Reconcile distribution',
    episode_prefix: 'EP',
    season_size: 20,
    season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
  }))
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [{ id: 'idea-1', title: 'Distribution', status: 'accepted', episode_code: CODE }],
    next_episode_number: 2,
    recycled_numbers: [],
  }))
  await fs.writeFile(path.join(subtitlesDir, `${CODE}_stitched.srt`), [
    '1',
    '00:00:00,000 --> 00:00:05,000',
    FIRST,
    '',
    '2',
    '00:00:05,000 --> 00:00:15,000',
    'Rain drums on the roof while the kettle begins to sing.',
    '',
    '3',
    '00:00:15,000 --> 00:00:20,000',
    LAST,
    '',
  ].join('\n'))
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=8000', '-t', '20',
    '-codec:a', 'pcm_s16le', path.join(mergedDir, `${CODE}_merged_audio.wav`),
  ])
  // 100 scenes. Only the first and the third caption match; the other 98 keep
  // today's captions out of reach, exactly as a stale plan does.
  const scenes = Array.from({ length: 100 }, (_, index) => ({
    id: `scene-${index + 1}`,
    scene_index: index + 1,
    start_sec: index * 0.2,
    end_sec: (index + 1) * 0.2,
    transcript_segment: index === 0 ? FIRST : index === 1 ? LAST : `Unrelated narration row ${index + 1} that is not in the captions at all.`,
    visual_prompt: `Approved picture ${index + 1}.`,
    approved: true,
    image_path: `/episode/scene-${index + 1}.png`,
  }))
  planPath = path.join(episodeDir, 'scene_plan.json')
  await fs.writeFile(planPath, JSON.stringify({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    research_used: false,
    opening_mode: 'from-start',
    total_duration_sec: 20,
    scenes,
  }))
})

after(async () => { await tmp.cleanup() })

test('a sparse re-anchoring is refused and the plan on disk is untouched', async () => {
  const original = await fs.readFile(planPath, 'utf8')
  const { reconcileScenePlanTimings } = await import('../services/scene-plan-reconcile.js')

  await assert.rejects(
    () => reconcileScenePlanTimings(SLUG, CODE),
    (error: any) => {
      assert.equal(error?.statusCode, 409, 'refused, not a 500')
      assert.match(error.message, /Reconcile timings did not save/)
      assert.match(error.message, /are below the 0\.5s window the renderer plays/, 'names the renderer window it broke')
      assert.match(error.message, /run Reconcile timings again/, 'asks for review / another reconcile')
      assert.match(error.message, /rebuild the Scene Plan timeline/, 'names the rebuild as the other repair')
      assert.match(error.message, /does not carry the existing images/, 'no false image-preservation promise')
      assert.doesNotMatch(error.message, /nothing rendered/)
      return true
    },
  )
  assert.equal(await fs.readFile(planPath, 'utf8'), original, 'refusal writes nothing')
  const saved = JSON.parse(await fs.readFile(planPath, 'utf8'))
  assert.equal(saved.scenes.length, 100)
  assert.equal(saved.total_duration_sec, 20)
})
