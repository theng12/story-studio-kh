/**
 * DL0011 — one duration authority for the Scene Plan's end.
 *
 * "Repair coverage" persisted the MEASURED AUDIO duration as the plan's total,
 * while the scenes it had just repaired and the continuation reader that judges
 * the plan both follow the later of audio and verified captions
 * (`generators/scene-plan.ts`: `plan.total_duration_sec < current.last_cue_end_sec - 0.001`).
 * For Dreamlands DL0011 the merged track measured 6083.290 s and the captions
 * ended at 6083.292 s, so the repair wrote a plan 2 ms shorter than its own
 * timeline, Scene Plan read it as not covering the narration, and the job became
 * non-retryable and asked for a rebuild of a plan that was already complete.
 *
 * The same 3 ms gap, on the same route, with the same outcome. Asserted on the
 * persisted plan AND on the continuation gate's own predicate, because the gate
 * is what turned it into a dead end.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'

const SLUG = 'repair-coverage-duration'
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
    name: 'Repair coverage duration',
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
  // The captions reach 3.003 s; the merged track measures 3.000 s. Three
  // milliseconds is exactly the gap that made DL0011 non-retryable.
  await fs.writeFile(path.join(subtitlesDir, `${CODE}_stitched.srt`),
    '1\n00:00:00,000 --> 00:00:03,003\nA paper kite climbs over the quiet hill.\n')
  await fs.writeFile(path.join(subtitlesDir, `${CODE}_stitched.srt.json`),
    JSON.stringify({ complete: true, sections: [], missing_sections: [] }))
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
    total_duration_sec: 2.5,
    scenes: [{
      id: 'kept-scene',
      scene_index: 1,
      start_sec: 0,
      end_sec: 2.5,
      transcript_segment: 'A paper kite climbs over the quiet hill.',
      visual_prompt: 'An approved paper kite above a quiet hill.',
      approved: true,
      image_path: '/episode/approved-kite.png',
    }],
  }))
})

after(async () => { await tmp.cleanup() })

test('repair coverage keeps the later caption end, so Scene Plan can continue its own repair', async () => {
  const app = (await import('../app.js')).app
  const { isBootComplete } = await import('../boot/migrations.js')
  await waitFor(() => isBootComplete(), { label: 'backend boot before repair-coverage fixture' })

  const response = await request(app)
    .post(`/api/projects/${SLUG}/scene-plan/${CODE}/repair-coverage`)
    .send({})
  assert.equal(response.status, 200, JSON.stringify(response.body))

  const saved = JSON.parse(await fs.readFile(planPath, 'utf8'))
  const { stampFromCues } = await import('../lib/scene-plan-timeline.js')
  const captionEnd = stampFromCues([
    { index: 1, start_sec: 0, end_sec: 3.003, text: 'A paper kite climbs over the quiet hill.' },
  ]).last_cue_end_sec

  assert.equal(saved.total_duration_sec, 3.003)
  assert.equal(saved.scenes[0].end_sec, 3.003)
  // The continuation reader's own predicate, run against what was persisted.
  assert.ok(saved.total_duration_sec >= captionEnd - 0.001,
    `Scene Plan would reject the repair it just wrote (${saved.total_duration_sec} < ${captionEnd})`)
  // The measured audio stays its own fact, and the reviewed scene keeps its media.
  assert.equal(response.body.audio_duration_sec, 3)
  assert.deepEqual(
    (({ id, visual_prompt, approved, image_path }) => ({ id, visual_prompt, approved, image_path }))(saved.scenes[0]),
    {
      id: 'kept-scene',
      visual_prompt: 'An approved paper kite above a quiet hill.',
      approved: true,
      image_path: '/episode/approved-kite.png',
    },
  )
})
