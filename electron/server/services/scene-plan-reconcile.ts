/**
 * Scene Plan "Reconcile timings" (v1.0.523): re-anchor an existing plan's scene timings to the
 * CURRENT stitched subtitles by matching each scene's transcript text. Keeps every scene id,
 * image and prompt. Shared by the Scene Plan button and Video Assembly's automatic repair of
 * small timing overlaps (1.4.278).
 */
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { parseSrt } from '../lib/subtitle-builder.js'
import { getAudioDuration } from '../lib/ffmpeg-utils.js'
import { resolveEpisodePathsByCodeWithSidecar, resolveScenePlanPath } from './utils.js'
import { resolveTranscriptSrtPath, stitchedSrtPath } from './subtitle-correction.js'
import { computePlanCoverage, reconcilePlanToSubtitles } from './scene-planner.js'
import type { ScenePlan } from '../models/types.js'

function refusal(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode })
}

export async function reconcileScenePlanTimings(slug: string, episodeId: string) {
  const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, 'scene_plan.json')
  const sidecarPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
  if (!existsSync(sidecarPath)) throw refusal(404, 'No scene_plan.json — run Scene Plan first.')
  const plan = JSON.parse(await fs.readFile(sidecarPath, 'utf-8')) as ScenePlan
  if (!plan.scenes?.length) throw refusal(400, 'scene_plan.json has no scenes.')

  const stitchedPath = stitchedSrtPath(paths.subtitles_dir, episodeId)
  if (!existsSync(stitchedPath)) {
    throw refusal(400, 'No stitched subtitles found — stitch subtitles on the Subtitles page first, then reconcile.')
  }
  // Re-anchoring matches each scene's stored transcript_segment against the
  // cue word stream. Reading the corrected transcript keeps both sides in the
  // same vocabulary and removes hallucinated words that could false-match.
  const transcriptPath = await resolveTranscriptSrtPath({
    subtitles_dir: paths.subtitles_dir, script_dir: paths.script_dir, episode_code: episodeId,
  })
  const cues = parseSrt(await fs.readFile(transcriptPath, 'utf-8'))
  if (!cues.length) throw refusal(400, 'The stitched SRT has no cues.')

  // Prefer the real audio duration for the last scene's end; fall back to
  // the SRT end inside the helper when it's absent.
  let audioDur = 0
  if (existsSync(paths.merged_audio_dir)) {
    let best = 0
    for (const f of await fs.readdir(paths.merged_audio_dir).catch(() => [] as string[])) {
      if (!/\.(mp3|wav|m4a)$/i.test(f) || f.startsWith('.tmp_')) continue
      const st = await fs.stat(path.join(paths.merged_audio_dir, f)).catch(() => null)
      if (st && st.size > best) { best = st.size; audioDur = (await getAudioDuration(path.join(paths.merged_audio_dir, f))) || 0 }
    }
  }

  // Prep (transcript parse, ffprobe) is outside the lock; the read-transform-write
  // is inside it, and the reported before/after coverage is measured on the same
  // document that was actually saved.
  const { before, r, after } = await withLock(sidecarPath, async () => {
    // Re-read under the lock: the plan was read before the checks above, and a
    // job or another request may have written the file since.
    const fresh = JSON.parse(await fs.readFile(sidecarPath, 'utf-8')) as ScenePlan
    const coverageBefore = computePlanCoverage(fresh.scenes, audioDur || cues[cues.length - 1]!.end_sec)
    const result = reconcilePlanToSubtitles(fresh.scenes, cues, audioDur || undefined)
    fresh.scenes = result.scenes
    fresh.total_duration_sec = audioDur || cues[cues.length - 1]!.end_sec
    await writeJsonAtomic(sidecarPath, fresh)
    return {
      before: coverageBefore,
      r: result,
      after: computePlanCoverage(fresh.scenes, fresh.total_duration_sec),
    }
  })
  const { episodeStatusCache } = await import('./episode-status-cache.js')
  episodeStatusCache.invalidate(slug, episodeId)
  return {
    matched: r.matchedCount,
    total: r.scenes.length,
    unmatched_ids: r.unmatchedIds,
    median_shift_sec: r.medianShiftSec,
    changes: r.changes,
    coverage_before: before,
    coverage_after: after,
  }
}
