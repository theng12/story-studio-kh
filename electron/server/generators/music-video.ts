/**
 * Assemble one music video from the library (v1.4.37).
 *
 * THIS JOB SPENDS NOTHING. It picks tracks the owner already owns, stitches
 * them, loops a background under them, and writes a tracklist. Every credit
 * this format costs was spent earlier, deliberately, by `music_generate`.
 *
 * That separation is the point and it is structural, not a promise: a shortfall
 * is REPORTED and the run stops, rather than quietly topping the library up
 * mid-assembly. A button that spends money as a side effect of doing something
 * else is the v1.0.114 bug that cost the owner real duplicate charges, and it
 * is not being rebuilt here.
 *
 * WHY LOOPING A STILL IS THE WHOLE TRICK. `-stream_loop -1` with `-c:v copy`
 * repeats a few seconds of footage without re-encoding a single frame, so a
 * two-hour video is minutes of work rather than hours. That is what makes the
 * format viable at all: the music is bought once and reused, and the picture
 * costs almost nothing to stretch to any runtime.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import os from 'os'
import path from 'path'
import { homogenizeForConcat } from '../lib/audio-concat.js'

import * as jq from '../services/job-queue.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import { listLibrary, recordMixUsage } from '../services/music-library.js'
import {
  DEFAULT_MIX_RULES,
  buildMusicMix,
  renderTracklist,
  type MixCandidate,
} from '../services/music-mix.js'
import {
  buildConcatList,
  buildLoopArgs,
  buildStitchArgs,
  buildMusicDescription,
  musicRenderPaths,
} from '../services/music-render.js'
import type { Job } from '../models/types.js'

export interface MusicVideoParams {
  episode_id: string
  /** Target runtime in seconds. Owner-settable; never a hardcoded ladder. */
  target_seconds: number
  /** The looping background. One still or short clip. */
  background_path: string
  /** Minimum tracks between two takes of one request. */
  sibling_gap_tracks?: number
  /** Seconds of crossfade. 0 — the owner's default — butt-joins. */
  crossfade_sec?: number
  /** Appended under the tracklist in the description. */
  description_footer?: string
}

export async function generateMusicVideo(job: Job): Promise<void> {
  const params = job.params as unknown as MusicVideoParams
  const episodeId = (params.episode_id || '').trim()
  if (!episodeId) throw new Error('episode_id is required')
  const targetSeconds = Math.max(60, Math.floor(params.target_seconds || 0))
  if (!targetSeconds) throw new Error('Choose how long the video should be.')
  if (!params.background_path || !existsSync(params.background_path)) {
    throw new Error('Choose a background image or clip for this video.')
  }

  const paths = await resolveEpisodePathsByCode(job.project_slug, episodeId)
  const library = await listLibrary(job.project_slug)

  const candidates: MixCandidate[] = library.tracks.map(track => ({
    filename: track.filename,
    title: track.title,
    duration_sec: track.duration_sec || 0,
    enabled: track.enabled,
    ...(track.sibling_group ? { sibling_group: track.sibling_group } : {}),
    times_used: track.times_used,
  }))

  const plan = buildMusicMix(candidates, targetSeconds, episodeId, {
    ...DEFAULT_MIX_RULES,
    siblingGapTracks: params.sibling_gap_tracks ?? DEFAULT_MIX_RULES.siblingGapTracks,
  })
  for (const note of plan.notes) job.output_lines.push(note)

  // A short library STOPS the run. It does not silently make a shorter video,
  // and it does not buy the difference — topping up is a separate, deliberate
  // action with its own cost shown before it starts.
  if (plan.shortfall_sec > 0) {
    throw new Error(
      `The library is ${Math.ceil(plan.shortfall_sec / 60)} minute(s) short of a `
      + `${Math.round(targetSeconds / 60)}-minute video (${plan.entries.length} track(s) available). `
      + 'Nothing was generated and nothing was charged — top up the music library, then build again.',
    )
  }

  job.output_lines.push(
    `${plan.entries.length} track(s) chosen, ${Math.round(plan.total_sec / 60)} minute(s) total. `
    + 'Nothing is bought by this step.',
  )
  job.progress = 10

  const render = musicRenderPaths(paths.episode_dir, episodeId)
  await fs.mkdir(paths.episode_dir, { recursive: true })

  jq.throwIfPauseRequested(job.job_id)
  if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')

  // ── Stitch ──
  // A library can hold MP3 takes beside AAC ones; the concat demuxer silently drops what it cannot read.
  const normDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssk-music-norm-'))
  try {
    const { files: stitchInputs, reencoded } = await homogenizeForConcat(
      plan.entries.map(entry => path.join(library.folder, entry.filename)), normDir)
    if (reencoded) job.output_lines.push(`Tracks differ in format; re-encoded ${reencoded} to one format so none are dropped.`)
    await fs.writeFile(render.concatList, buildConcatList(stitchInputs), 'utf8')
    job.output_lines.push(
      params.crossfade_sec ? 'Stitching with crossfades…' : 'Stitching (no crossfades)…',
    )
    await runFfmpeg(buildStitchArgs(render.concatList, render.stitchedAudio, params.crossfade_sec || 0))
  } finally {
    await fs.rm(normDir, { recursive: true, force: true }).catch(() => {})
  }
  job.progress = 55

  jq.throwIfPauseRequested(job.job_id)
  if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')

  // ── Loop the background under it ──
  job.output_lines.push('Looping the background to the full length (the frames are copied, not re-encoded)…')
  await runFfmpeg(buildLoopArgs(params.background_path, render.stitchedAudio, render.video))
  job.progress = 90

  // ── Tracklist ──
  const description = buildMusicDescription(renderTracklist(plan), params.description_footer || '')
  await fs.writeFile(path.join(paths.episode_dir, `${episodeId}-description.txt`), description, 'utf8')

  // Recorded only now, because the video exists. The same peek/record split the
  // narration-bed pool uses: "times used" must mean heard, not considered.
  await recordMixUsage(job.project_slug, episodeId, plan.entries.map(entry => entry.filename))

  await fs.rm(render.concatList, { force: true })
  job.output_dir = paths.episode_dir
  job.result = {
    video: render.video,
    tracks: plan.entries.length,
    total_sec: plan.total_sec,
  }
  job.progress = 100

  const stat = await fs.stat(render.video).catch(() => null)
  requireJobCompletion(job, {
    label: 'Music video',
    expected: 1,
    completed: stat?.isFile() && stat.size > 0 ? 1 : 0,
    missing: stat?.isFile() && stat.size > 0 ? [] : [path.basename(render.video)],
    retry_hint: 'The chosen tracks and the background are unchanged; Retry re-runs only the render.',
  })
}
