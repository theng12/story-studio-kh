import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'

const SLUG = 'reconcile-duration'
const CODE = 'EP0001'
let tmp: { dir: string; cleanup: () => Promise<void> }
let planPath = ''

before(async () => {
  tmp = await useTempDataDir()
  const projectDir = path.join(tmp.dir, 'projects', SLUG)
  const episodeDir = path.join(projectDir, 'episodes', 'Season 001', `${CODE} - Duration`)
  const mergedDir = path.join(episodeDir, `${CODE} - 08 Audio Merge Output`)
  const subtitlesDir = path.join(episodeDir, `${CODE} - 09 Subtitles Output`)
  await fs.mkdir(mergedDir, { recursive: true })
  await fs.mkdir(subtitlesDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    slug: SLUG,
    name: 'Reconcile duration',
    episode_prefix: 'EP',
    season_size: 20,
    season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
  }))
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [{ id: 'idea-1', title: 'Duration', status: 'accepted', episode_code: CODE }],
    next_episode_number: 2,
    recycled_numbers: [],
  }))
  await fs.writeFile(path.join(subtitlesDir, `${CODE}_stitched.srt`),
    '1\n00:00:00,000 --> 00:00:03,003\nA paper kite climbs over the quiet hill.\n')
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=8000', '-t', '3',
    '-codec:a', 'pcm_s16le', path.join(mergedDir, `${CODE}_merged_audio.wav`),
  ])
  planPath = path.join(episodeDir, 'scene_plan.json')
  await fs.writeFile(planPath, JSON.stringify({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    research_used: false,
    opening_mode: 'from-start',
    total_duration_sec: 3,
    scenes: [{
      id: 'kept-scene',
      scene_index: 1,
      start_sec: 0,
      end_sec: 3,
      transcript_segment: 'A paper kite climbs over the quiet hill.',
      visual_prompt: 'An approved paper kite above a quiet hill.',
      approved: true,
      image_path: '/episode/approved-kite.png',
    }],
  }))
})

after(async () => { await tmp.cleanup() })

test('reconcile keeps the later subtitle end when measured audio is 3 ms shorter', async () => {
  const { reconcileScenePlanTimings } = await import('../services/scene-plan-reconcile.js')
  const result = await reconcileScenePlanTimings(SLUG, CODE)
  const saved = JSON.parse(await fs.readFile(planPath, 'utf8'))

  assert.equal(saved.total_duration_sec, 3.003)
  assert.equal(saved.scenes[0].end_sec, 3.003)
  assert.equal(saved.source_merged_audio.duration_sec, 3)
  assert.ok(saved.total_duration_sec >= saved.source_timeline.last_cue_end_sec - 0.001)
  assert.deepEqual(
    (({ id, visual_prompt, approved, image_path }) => ({ id, visual_prompt, approved, image_path }))(saved.scenes[0]),
    {
      id: 'kept-scene',
      visual_prompt: 'An approved paper kite above a quiet hill.',
      approved: true,
      image_path: '/episode/approved-kite.png',
    },
  )
  assert.equal(result.coverage_after.uncoveredTotalSec, 0)
})
