/**
 * 1.4.276 — DL0004: Chapter 01 was re-narrated and the audio re-merged
 * (6321 s → 6377 s) after Scene Plan had run. The captions were not re-stitched,
 * so the plan's caption stamp still matched and Story called the plan current;
 * every later scene trailed the narration by ~56 s. The same re-narration's
 * recovery adopted the running Scene Review job and its Thumbnails + Metadata
 * were never queued.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { compareMergedAudio, compareTimeline, inspectPlanTimelineDrift, stampFromCues } from '../lib/scene-plan-timeline.js'
import { parseSrt } from '../lib/subtitle-builder.js'

const SLUG = 'merged-audio-stale'
let tmp: { dir: string; cleanup: () => Promise<void> }

before(async () => {
  tmp = await useTempDataDir()
  const projectDir = path.join(tmp.dir, 'projects', SLUG)
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'Merged Audio Stale', episode_prefix: 'EP', season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
  }))
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [1, 2].map(i => ({ id: `idea-${i}`, title: `Ep ${i}`, status: 'accepted', episode_code: `EP000${i}` })),
    next_episode_number: 3, recycled_numbers: [],
  }))
})

after(async () => { await tmp.cleanup() })

/** A finished plan stamped against `plannedSec` of merged narration, over a merge that is now `mergedSec`. */
async function episode(code: string, plannedSec: number, mergedSec: number) {
  const n = Number(code.slice(-1))
  const episodeDir = path.join(tmp.dir, 'projects', SLUG, 'episodes', 'Season 001', `${code} - Ep ${n}`)
  const imagesDir = path.join(episodeDir, 'scene_images')
  const mergedDir = path.join(episodeDir, `${code} - 08 Audio Merge Output`)
  await fs.mkdir(imagesDir, { recursive: true })
  await fs.mkdir(mergedDir, { recursive: true })
  const scenes = [[0, 5], [5, 10], [10, plannedSec]].map(([start_sec, end_sec], i) => ({
    id: `s${i + 1}`, scene_index: i + 1, start_sec, end_sec, transcript_segment: 'x', visual_prompt: 'x', approved: true,
  }))
  for (const scene of scenes) await fs.writeFile(path.join(imagesDir, `${scene.id}.png`), 'png')
  const planPath = path.join(episodeDir, 'scene_plan.json')
  await fs.writeFile(planPath, JSON.stringify({
    schema_version: 1, generated_at: new Date().toISOString(), research_used: false, opening_mode: 'from-start',
    total_duration_sec: plannedSec, source_merged_audio: { duration_sec: plannedSec }, scenes,
  }))
  const filename = `${code}_merged_audio.mp3`
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=8000,atrim=duration=${mergedSec}`,
    '-codec:a', 'libmp3lame', '-q:a', '9', path.join(mergedDir, filename),
  ])
  const completion = path.join(mergedDir, `${code}_merged_audio.completion.json`)
  await fs.writeFile(completion, JSON.stringify({ output_filename: filename, bytes: (await fs.stat(path.join(mergedDir, filename))).size, duration_sec: mergedSec, opening: { lead_in_sec: 0 } }))
  return { planPath, completion }
}

describe('a re-merged narration makes the Scene Plan stale', () => {
  test('the length rule: DL0004 is stale, a re-encode within tolerance and an unstamped plan are not', () => {
    const dl0004 = compareMergedAudio({ duration_sec: 6321 }, 6377)
    assert.equal(dl0004.stale, true)
    assert.match(dl0004.reason, /6321\.0s .* 6377\.0s \(\+56\.0s\)/)
    assert.equal(compareMergedAudio({ duration_sec: 6321 }, 6321.2).stale, false)
    assert.equal(compareMergedAudio(undefined, 6377).stale, false, 'a plan built before 1.4.276 is not known to be stale')
    assert.equal(compareMergedAudio({ duration_sec: 15 }, 23, 8).stale, false, 'a music lead-in the renderer shifts for is not a change')
  })

  test('the status read flags it even though the captions were never re-stitched', async () => {
    const { planPath, completion } = await episode('EP0001', 15, 21)
    const drift = await inspectPlanTimelineDrift(planPath, path.join(tmp.dir, 'no-stitched.srt'), completion)
    assert.equal(drift.checked, true)
    assert.equal(drift.stale, true)
    assert.match(drift.reason, /merged narration was 15\.0s .* now 21\.0s/)
  })

  test('Video Assembly refuses to render it when re-aligning cannot absorb the change', async () => {
    await episode('EP0002', 15, 21)
    const { scanEpisodeAssets, prepareUnifiedVideoAssemblyInputs } = await import('../generators/video.js')
    const assets = await scanEpisodeAssets(SLUG, 'EP0002')
    assert.match(assets.scene_plan_timing!.audio_stale_reason || '', /now 21\.0s/)
    assert.equal(assets.scene_plan_timing!.complete, false)
    await assert.rejects(
      prepareUnifiedVideoAssemblyInputs(SLUG, 'EP0002', {} as any, { output_lines: [] } as any),
      /Video Assembly is blocked: the Scene Plan is out of date — the merged narration was 15\.0s .*Nothing was rendered\./,
    )
  })
})

test('a narration-refresh recovery leaves a running Pipeline step its later steps', async () => {
  const jq = await import('../services/job-queue.js')
  const pm = await import('../services/project-manager.js')
  const project = await pm.createProject({ name: 'Refresh keeps the chain' })
  try {
    await jq.setQueuePaused(true)
    const row = (job_id: string, type: Job['type'], status: Job['status'], created_at: string, params: Record<string, unknown> = {}): Job => ({
      job_id, project_slug: project.slug, episode_id: 'EP0001', type, status, title: type, created_at,
      started_at: null, finished_at: null, error: null, output_lines: [], params,
    })
    const tail = [{ type: 'thumb_images', title: 'Pipeline: Thumbnails', params: {} }, { type: 'metadata', title: 'Pipeline: Metadata', params: {} }]
    const merge = row('pipeline-merge', 'audio_merge', 'done', '2026-10-09T00:00:00Z', { gap_duration: 0.5 })
    const plan = row('pipeline-plan', 'scene_plan_run', 'done', '2026-10-09T00:10:00Z')
    const narration = row('renarrate', 'audio', 'done', '2026-10-09T00:30:00Z', { then_subtitles: true })
    const check = { ...row('renarrate-check', 'subtitles_transcribe', 'done', '2026-10-09T00:40:00Z', {
      per_chapter: true, sections: ['Chapter_01'], narration_refresh_job_id: narration.job_id,
    }), result: { complete: true, scope_complete: true, episode_complete: false, stitch_complete: false } }
    for (const job of [merge, plan, narration, check]) await jq.writeAuthoritativeJob(job)
    // Scene Review is still waiting in the queue (in production: running) with the batch's tail.
    const review = await jq.enqueue({ project_slug: project.slug, type: 'continuity_render', episode_id: 'EP0001',
      title: 'Pipeline: Scene Review', params: { episode_id: 'EP0001', pipeline_chain: tail, pipeline_batch_id: 'b1' } })

    const { recoverEpisode } = await import('../services/episode-recovery.js')
    const recovery = (await recoverEpisode(project.slug, 'EP0001'))!
    assert.equal(recovery.continuation, undefined, 'a narration refresh owns no continuation')

    const jobs = await jq.getJobs(project.slug)
    const live = jobs.find(job => job.job_id === review.job_id)!
    assert.equal(live.params.episode_recovery_id, undefined, 'completion must still hand off its chain')
    assert.equal(live.params.episode_recovery?.id, recovery.id, 'the recovery status is still shown on it')
    assert.deepEqual(live.params.pipeline_chain.map((link: { type: string }) => link.type), ['thumb_images', 'metadata'])
    assert.equal(jobs.find(job => job.job_id === plan.job_id)!.params.episode_recovery_id, recovery.id, 'finished rows are adopted as before')
  } finally { await jq._waitForJobPersistenceForTesting() }
})

/**
 * Domnak DM0012/13/14 (2026-10-19) — the caption identity is judged against the transcript PLANNING
 * reads, and the correction pass DROPS hallucinated cues, so the corrected transcript and the raw
 * stitch are two different cue sets of one narration. Scene Plan is built from the corrected file
 * (`source_stitched_srt`), so comparing its stamp against the raw stitch reported drift on a stitch
 * that had not moved since the plan was built — 612 cues against a stamp of 609, 1013/1008 and
 * 1005/999, each plan `generated_at` newer than the stitched file's own. The recovery plan parked
 * on "Waiting for Scene Plan" forever, and a rebuild would have re-timed every scene.
 */
describe('the caption timeline is judged against the transcript planning reads', () => {
  const RAW = '1\n00:00:00,000 --> 00:00:02,000\nNeorion harbour\n\n'
    + '2\n00:00:02,000 --> 00:00:04,000\nHello there\n\n3\n00:00:04,000 --> 00:00:06,000\nThank you\n\n'
  // The same cues, minus the one no script word aligned to: the corrector keeps timings and drops
  // hallucinated cues, so the corrected file has one cue fewer.
  const CORRECTED = '1\n00:00:02,000 --> 00:00:04,000\nHello there\n\n2\n00:00:04,000 --> 00:00:06,000\nThank you\n\n'

  /** A raw stitch with its current corrected sibling, and a plan timed against one of them. */
  async function captions(source: 'raw' | 'corrected', rawText = RAW, correctedText = CORRECTED) {
    const dir = await fs.mkdtemp(path.join(tmp.dir, 'caption-drift-'))
    const subtitles = path.join(dir, 'EP0001 - 09 Subtitles Output')
    await fs.mkdir(subtitles, { recursive: true })
    const rawPath = path.join(subtitles, 'EP0001_stitched.srt')
    const correctedPath = path.join(subtitles, 'EP0001_stitched.corrected.srt')
    await fs.writeFile(rawPath, rawText)
    await fs.writeFile(correctedPath, correctedText)
    const rawStat = await fs.stat(rawPath)
    await fs.writeFile(`${correctedPath}.json`, JSON.stringify({ srt: path.basename(correctedPath),
      schema_version: 1, source_mtime_ms: rawStat.mtimeMs, source_size: rawStat.size }))
    const planPath = path.join(dir, 'scene_plan.json')
    await fs.writeFile(planPath, JSON.stringify({ schema_version: 1,
      source_stitched_srt: source === 'corrected' ? 'EP0001_stitched.corrected.srt' : 'EP0001_stitched.srt',
      source_timeline: stampFromCues(parseSrt(source === 'corrected' ? CORRECTED : RAW)) }))
    return { rawPath, correctedPath, planPath }
  }

  test('a plan timed against the corrected transcript is not stale against the raw stitch', async () => {
    const f = await captions('corrected')
    const stored = JSON.parse(await fs.readFile(f.planPath, 'utf8')).source_timeline
    assert.equal(compareTimeline(stored, stampFromCues(parseSrt(RAW))).stale, true,
      'the trap: the raw stitch alone calls this current plan stale')
    const drift = await inspectPlanTimelineDrift(f.planPath, f.rawPath)
    assert.equal(drift.checked, true)
    assert.equal(drift.stale, false, 'nothing on disk moved since the plan was built')
    assert.equal(drift.reason, '')
  })

  test('a plan timed against the raw stitch stays current when a correction appears later', async () => {
    const f = await captions('raw')
    assert.equal((await inspectPlanTimelineDrift(f.planPath, f.rawPath)).stale, false)
  })

  test('a re-stitch that moves the captions is still stale', async () => {
    // Both files moved: the stitch was re-made and the correction rebuilt from it.
    const movedRaw = '1\n00:00:00,000 --> 00:00:02,000\nNeorion harbour\n\n'
      + '2\n00:00:03,000 --> 00:00:05,000\nHello there\n\n3\n00:00:05,000 --> 00:00:07,000\nThank you\n\n'
    const movedCorrected = '1\n00:00:03,000 --> 00:00:05,000\nHello there\n\n2\n00:00:05,000 --> 00:00:07,000\nThank you\n\n'
    const f = await captions('corrected', movedRaw, movedCorrected)
    const drift = await inspectPlanTimelineDrift(f.planPath, f.rawPath)
    assert.equal(drift.stale, true)
    assert.match(drift.reason, /moved later by 1\.00s after the transcript was re-stitched/)
  })

  test('a re-narrated merged track is still stale while the captions have not moved', async () => {
    const f = await captions('corrected')
    const completion = path.join(path.dirname(f.rawPath), 'EP0001_merged_audio.completion.json')
    await fs.writeFile(completion, JSON.stringify({ output_filename: 'EP0001_merged_audio.mp3', duration_sec: 20, opening: { lead_in_sec: 0 } }))
    await fs.writeFile(f.planPath, JSON.stringify({ ...JSON.parse(await fs.readFile(f.planPath, 'utf8')),
      source_merged_audio: { duration_sec: 6 } }))
    const drift = await inspectPlanTimelineDrift(f.planPath, f.rawPath, completion, 'EP0001_merged_audio.mp3')
    assert.equal(drift.stale, true)
    assert.match(drift.reason, /merged narration was 6\.0s .* now 20\.0s/)
  })
})
