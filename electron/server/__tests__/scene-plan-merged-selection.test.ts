import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

// Must be set before ../app.js is imported so the throwaway server does not listen.
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

/**
 * PR0002/PR0003 (2026-10-16): a Final Video run was refused `missing_prerequisite
 * scene_plan` although the plan read complete. Root cause: `write_mode: 'new'`
 * left `{CODE}_merged_audio_v2.mp3` beside the base track. The completion record
 * is written once per episode code and OVERWRITTEN, so it described the `_v2`,
 * while the plan, the subtitle stitcher and the renderer all select the base
 * `{CODE}_merged_audio.mp3`. `readMergedAudioRecord` used the record without
 * checking `output_filename`, so the drift / shortfall predicates compared the
 * plan against a file the app does not render with and reported it stale.
 *
 * These pin the selection, the record guard, the admission outcome, and the
 * Video/Subtitles status route that carries the same advisory.
 */

let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let episodeStatusCache: typeof import('../services/episode-status-cache.js').episodeStatusCache
let resolveEpisodePathsByCode: typeof import('../services/utils.js').resolveEpisodePathsByCode

// A minimal complete plan: one scene covering the whole narration, a prompt.
function plan(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    generated_at: '2026-10-16T09:27:47.852Z',
    total_duration_sec: 952.58229,
    source_timeline: { sha256: 'a'.repeat(64), total_cues: 1, first_cue_start_sec: 0, last_cue_end_sec: 952.582 },
    source_merged_audio: { duration_sec: 952.582 },
    opening_mode: 'from-start',
    opening_reserved_sec: 0,
    scenes: [{ id: 'scene-0001', scene_index: 1, start_sec: 0, end_sec: 952.58229, visual_prompt: 'A quiet archive.' }],
    ...overrides,
  }
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
  ;({ app } = await import('../app.js'))
  ;({ episodeStatusCache } = await import('../services/episode-status-cache.js'))
  ;({ resolveEpisodePathsByCode } = await import('../services/utils.js'))
})

after(async () => { await cleanup() })

async function seedEpisode(name: string) {
  const project = await pm.createProject({ name })
  const [idea] = await im.addIdeas(project.slug, [{
    title: 'Merged selection', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
  }], 'test-model')
  const accepted = await im.acceptIdea(project.slug, idea!.id, false)
  const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify(plan()))
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  const stitched = path.join(paths.subtitles_dir, `${accepted.episode_code}_stitched.srt`)
  await fs.writeFile(stitched, '1\n00:00:00,000 --> 00:00:01,000\nok\n')
  await fs.writeFile(`${stitched}.json`, JSON.stringify({
    schema_version: 1, gap_duration_s: 1.5, lead_in_sec: 0,
    timeline: { sha256: 'a'.repeat(64), total_cues: 1, first_cue_start_sec: 0, last_cue_end_sec: 952.582 },
    total_cues: 1, total_duration_sec: 952.5822089999999, complete: true, missing_sections: [],
    sections: [{ slug: 'Chapter_01', source_srt: `${accepted.episode_code}_Chapter_01.srt`, offset_sec: 0, duration_sec: 952.58, cues_added: 1 }],
  }))
  return { slug: project.slug, code: accepted.episode_code, paths }
}

async function writeMerges(paths: any, code: string, opts: { recordNames: 'base' | 'v2'; recordDuration: number }) {
  await fs.mkdir(paths.merged_audio_dir, { recursive: true })
  await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio.mp3`), 'ID3')
  await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio_v2.mp3`), 'ID3')
  await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio.completion.json`), JSON.stringify({
    schema_version: 2,
    output_filename: opts.recordNames === 'v2' ? `${code}_merged_audio_v2.mp3` : `${code}_merged_audio.mp3`,
    duration_sec: opts.recordDuration,
    opening: { lead_in_sec: 0 },
  }))
}

async function statusFor(slug: string, code: string) {
  episodeStatusCache.invalidate(slug, code)
  const ideas = await im.getIdeas(slug, 'accepted')
  const { createProjectFactsCache } = await import('../services/utils.js')
  return await episodeStatusCache.get(slug, code, ideas, createProjectFactsCache(slug))
}

test('selectMergedAudioFilename prefers the base track over a _v2 by code-unit order', async () => {
  const { selectMergedAudioFilename } = await import('../lib/intro-lead-in.js')
  assert.equal(
    selectMergedAudioFilename(['PR0002_merged_audio_v2.mp3', 'PR0002_merged_audio.mp3'], 'PR0002'),
    'PR0002_merged_audio.mp3',
  )
  assert.equal(selectMergedAudioFilename(['PR0005_merged_audio_v2.mp3'], 'PR0005'), 'PR0005_merged_audio_v2.mp3')
  assert.equal(selectMergedAudioFilename(['notes.txt'], 'PR0005'), null)
})

test('readMergedAudioRecord ignores a record that names a different merged file', async () => {
  const { readMergedAudioRecord } = await import('../lib/scene-plan-timeline.js')
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'merged-rec-'))
  const recordPath = path.join(dir, 'PR0002_merged_audio.completion.json')
  await fs.writeFile(recordPath, JSON.stringify({ output_filename: 'PR0002_merged_audio_v2.mp3', duration_sec: 956, opening: { lead_in_sec: 0 } }))
  assert.equal(await readMergedAudioRecord(recordPath, 'PR0002_merged_audio.mp3'), null)
  assert.deepEqual(await readMergedAudioRecord(recordPath, 'PR0002_merged_audio_v2.mp3'), { duration_sec: 956, lead_in_sec: 0, closing_tail_sec: 0 })
  assert.equal((await readMergedAudioRecord(recordPath))?.duration_sec, 956)
})

test('readMergedAudioRecord reports the NARRATION, not the closing music tail after it', async () => {
  // 2026-10-19 — a merge with background music appends a closing tail and writes
  // down how long it is. Every reader of this record asks how long the NARRATION
  // is, so the tail is subtracted; the raw file length stays in the record.
  const { readMergedAudioRecord } = await import('../lib/scene-plan-timeline.js')
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'merged-tail-'))
  const recordPath = path.join(dir, 'PR0007_merged_audio.completion.json')
  await fs.writeFile(recordPath, JSON.stringify({
    output_filename: 'PR0007_merged_audio.mp3', duration_sec: 1236, closing_tail_sec: 25,
    opening: { lead_in_sec: 8, intro: null, music_lead_in_sec: 8 },
  }))
  assert.deepEqual(await readMergedAudioRecord(recordPath, 'PR0007_merged_audio.mp3'), {
    duration_sec: 1211, lead_in_sec: 8, closing_tail_sec: 25,
  })
  // A record written before the field existed still reads as it always did.
  await fs.writeFile(recordPath, JSON.stringify({
    output_filename: 'PR0007_merged_audio.mp3', duration_sec: 1211, opening: { lead_in_sec: 8 },
  }))
  assert.deepEqual(await readMergedAudioRecord(recordPath, 'PR0007_merged_audio.mp3'), {
    duration_sec: 1211, lead_in_sec: 8, closing_tail_sec: 0,
  })
})

test('status.scene_plan stays true when a _v2 record sits beside the selected base merge', async () => {
  const { slug, code, paths } = await seedEpisode('Merged v2 record')
  // The record describes the newer _v2 and disagrees with the plan — the PR2/3 shape.
  await writeMerges(paths, code, { recordNames: 'v2', recordDuration: 956 })
  const status = await statusFor(slug, code)
  assert.equal(status.scene_plan, true, 'a _v2 record must not make the plan read stale')
})

test('status.scene_plan is false when the record describes the SELECTED file and disagrees with the plan', async () => {
  const { slug, code, paths } = await seedEpisode('Merged real staleness')
  await writeMerges(paths, code, { recordNames: 'base', recordDuration: 956 })
  const status = await statusFor(slug, code)
  assert.equal(status.scene_plan, false, 'a genuinely stale plan must still be refused')
})

test('Scene Plan and subtitles status agree on changed captions and narration', async () => {
  const { slug, code, paths } = await seedEpisode('Timeline route agreement')
  const { stampFromCues } = await import('../lib/scene-plan-timeline.js')
  const { parseSrt } = await import('../lib/subtitle-builder.js')
  const stitched = path.join(paths.subtitles_dir, `${code}_stitched.srt`)
  const original = '1\n00:00:00,000 --> 00:00:01,000\nok\n'
  const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
  await fs.writeFile(planPath, JSON.stringify(plan({ source_timeline: stampFromCues(parseSrt(original)) })))
  await writeMerges(paths, code, { recordNames: 'base', recordDuration: 952.582 })
  const check = async (expected: boolean) => {
    const scene = await request(app).get(`/api/projects/${slug}/scene-plan/${code}?render_overhead=0`).expect(200)
    const video = await request(app).get(`/api/projects/${slug}/video-editor/subtitles/status/${code}`).expect(200)
    assert.equal(scene.body.plan_stale_vs_stitched, expected)
    assert.equal(video.body.scene_plan_timeline.stale, expected)
  }
  await check(false)
  await fs.writeFile(stitched, `${original}\n2\n00:00:02,000 --> 00:00:03,000\nmore\n`)
  await check(true)
  await fs.writeFile(stitched, original)
  await writeMerges(paths, code, { recordNames: 'base', recordDuration: 996 })
  await check(true)
})

test('GET video-editor/subtitles/status reports drift for the SELECTED merged file only', async () => {
  const { slug, code, paths } = await seedEpisode('Subtitles status merged selection')
  // A plan with no caption stamp, so this pins the merged-audio branch alone.
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
    schema_version: 1,
    generated_at: '2026-10-16T09:27:47.852Z',
    total_duration_sec: 952.58229,
    source_merged_audio: { duration_sec: 952.582 },
    opening_mode: 'from-start',
    scenes: [{ id: 'scene-0001', scene_index: 1, start_sec: 0, end_sec: 952.58229, visual_prompt: 'A quiet archive.' }],
  }))
  // Exactly ONE merged file on disk, so scanEpisodeAssets.merged_audio[0] is THIS file
  // whatever the filesystem readdir order — the name the route must hand to the drift
  // check. (A dummy file is enough; the status path never needs a real probe.)
  await fs.mkdir(paths.merged_audio_dir, { recursive: true })
  await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio.mp3`), 'ID3')
  const recordPath = path.join(paths.merged_audio_dir, `${code}_merged_audio.completion.json`)

  // (a) The record names a DIFFERENT file (the `_v2` shape) and disagrees with the plan:
  //     it must be ignored, not reported as this plan drifting.
  await fs.writeFile(recordPath, JSON.stringify({
    output_filename: `${code}_merged_audio_v2.mp3`, duration_sec: 956, opening: { lead_in_sec: 0 },
  }))
  const mismatch = await request(app).get(`/api/projects/${slug}/video-editor/subtitles/status/${code}`)
  assert.equal(mismatch.status, 200, JSON.stringify(mismatch.body))
  assert.equal(mismatch.body.scene_plan_timeline.stale, false, 'a record for another file must not report drift')

  // (b) The record names the SELECTED file and disagrees with the plan: the real drift is kept.
  await fs.writeFile(recordPath, JSON.stringify({
    output_filename: `${code}_merged_audio.mp3`, duration_sec: 956, opening: { lead_in_sec: 0 },
  }))
  const matching = await request(app).get(`/api/projects/${slug}/video-editor/subtitles/status/${code}`)
  assert.equal(matching.status, 200, JSON.stringify(matching.body))
  assert.equal(matching.body.scene_plan_timeline.stale, true, 'drift for the selected file must still be reported')
})
