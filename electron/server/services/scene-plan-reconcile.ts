/**
 * Scene Plan "Reconcile timings" (v1.0.523): re-anchor an existing plan's scene timings to the
 * CURRENT stitched subtitles by matching each scene's transcript text. Keeps the id, image and
 * prompt of every retained renderable scene. Shared by the Scene Plan button and Video Assembly's
 * automatic repair of small timing overlaps (1.4.278).
 */
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { parseSrt } from '../lib/subtitle-builder.js'
import { getAudioDuration } from '../lib/ffmpeg-utils.js'
import { resolveEpisodeMergedAudioChoice } from '../lib/merged-audio-selection.js'
import { resolveEpisodePathsByCodeWithSidecar, resolveScenePlanPath } from './utils.js'
import { resolveTranscriptSrtPath, stitchedSrtPath } from './subtitle-correction.js'
import { computePlanCoverage, reconcilePlanToSubtitles, removeNonRenderableScenes } from './scene-planner.js'
import { stampFromCues } from '../lib/scene-plan-timeline.js'
import type { ScenePlan } from '../models/types.js'

function refusal(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode })
}

/** Below this share of today's narration a plan is not "a little" out of step; it needs a rebuild. */
export const AUTO_REALIGN_MIN_COVERAGE = 0.9

export async function reconcileScenePlanTimings(
  slug: string,
  episodeId: string,
  /** 1.4.296 — automatic callers refuse a plan that covers less than 90% of today's narration. */
  options: { auto?: boolean } = {},
) {
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
  const subtitleEndSec = cues[cues.length - 1]!.end_sec

  // Keep the measured audio duration as its own fact. The authoritative plan
  // end below uses whichever reaches later: playable audio or verified captions.
  //
  // v1.4.314 — when the owner has pinned this episode's narration, measure the
  // pinned track: it is the same file the stitcher and the renderer use, so the
  // re-anchor measures the timeline the render will actually carry (for
  // PR0002/PR0003 the base 14-voice test merge was the LARGER file, so measuring
  // by size re-anchored to the track the owner had NOT chosen).
  //
  // An episode nobody pinned keeps this site's own long-standing rule unchanged:
  // the largest audio file. A pin that no longer names a real track measures
  // nothing (audioDur stays 0, so the plan end follows the captions) rather than
  // measuring some other track — the render refuses an invalid pin, and this
  // repair must not silently answer with a different narration.
  let audioDur = 0
  if (existsSync(paths.merged_audio_dir)) {
    const choice = await resolveEpisodeMergedAudioChoice(paths.merged_audio_dir, episodeId)
    if (choice.source === 'selected' && choice.filename) {
      audioDur = (await getAudioDuration(path.join(paths.merged_audio_dir, choice.filename))) || 0
    } else if (choice.source === 'unset') {
      let best = 0
      for (const f of await fs.readdir(paths.merged_audio_dir).catch(() => [] as string[])) {
        if (!/\.(mp3|wav|m4a)$/i.test(f) || f.startsWith('.tmp_')) continue
        const st = await fs.stat(path.join(paths.merged_audio_dir, f)).catch(() => null)
        if (st && st.size > best) { best = st.size; audioDur = (await getAudioDuration(path.join(paths.merged_audio_dir, f))) || 0 }
      }
    }
  }

  // Prep (transcript parse, ffprobe) is outside the lock; the read-transform-write
  // is inside it, and the reported before/after coverage is measured on the same
  // document that was actually saved.
  const { before, r, after, cleanup } = await withLock(sidecarPath, async () => {
    // Re-read under the lock: the plan was read before the checks above, and a
    // job or another request may have written the file since.
    const fresh = JSON.parse(await fs.readFile(sidecarPath, 'utf-8')) as ScenePlan
    // The final scene already follows the later of audio and subtitles. Persist
    // that same authority as the plan total so a millisecond container/SRT
    // difference cannot make the continuation reader reject its own repair.
    const narrationSec = Math.max(audioDur, subtitleEndSec)
    const planEndSec = Math.max(...fresh.scenes.map(scene => Number(scene.end_sec) || 0))
    if (options.auto && Math.min(planEndSec, narrationSec) / Math.max(planEndSec, narrationSec, 0.001) < AUTO_REALIGN_MIN_COVERAGE) {
      throw refusal(409, `the Scene Plan was built for ${planEndSec.toFixed(1)}s of narration and today's narration is `
        + `${narrationSec.toFixed(1)}s — too different to re-align, so rebuild the timeline`)
    }
    const coverageBefore = computePlanCoverage(fresh.scenes, narrationSec)
    const result = reconcilePlanToSubtitles(fresh.scenes, cues, narrationSec)
    // 1.4.298 — two scenes anchored inside one caption start at the same moment, which left a
    // zero-length scene that Video Assembly refused (Brain Wise EP0047). Its words go to a neighbour,
    // as the Scene Plan's own timeline cleanup does.
    const cleanup = removeNonRenderableScenes(result.scenes)
    if (cleanup.removed_ids.length) {
      result.changes.push(`Removed ${cleanup.removed_ids.length} scene(s) that ended up with no length; their words moved to the scene beside them.`)
    }
    fresh.scenes = cleanup.scenes
    fresh.total_duration_sec = narrationSec
    // 1.4.296 — the plan now follows today's captions and narration, so it says so. Without
    // this the "out of date" checks kept failing a plan that had just been re-aligned.
    fresh.source_timeline = stampFromCues(cues)
    if (audioDur > 0) fresh.source_merged_audio = { duration_sec: Math.round(audioDur * 1000) / 1000 }
    await writeJsonAtomic(sidecarPath, fresh)
    return {
      before: coverageBefore,
      r: result,
      after: computePlanCoverage(fresh.scenes, fresh.total_duration_sec),
      cleanup,
    }
  })
  const { episodeStatusCache } = await import('./episode-status-cache.js')
  episodeStatusCache.invalidate(slug, episodeId)
  const retainedIds = new Set(cleanup.scenes.map(scene => scene.id))
  const unmatchedIds = r.unmatchedIds.filter(id => retainedIds.has(id))
  return {
    matched: cleanup.scenes.length - unmatchedIds.length,
    total: cleanup.scenes.length,
    unmatched_ids: unmatchedIds,
    removed_count: cleanup.removed_ids.length,
    median_shift_sec: r.medianShiftSec,
    changes: r.changes,
    coverage_before: before,
    coverage_after: after,
  }
}

/**
 * 1.4.296 — owner: "Imperfection is often accepted." A plan a little out of step with today's
 * captions or narration is re-aligned and the work carries on instead of stopping for a person.
 * Returns an honest summary of the renderable rows that were actually saved.
 */
export async function realignDriftedScenePlan(
  slug: string, episodeId: string, reason: string,
  /** 1.4.300 — `auto: false` re-aligns past the 10% limit (the "Scene Plan in step" check on Off/Warn). */
  options: { auto?: boolean } = { auto: true },
): Promise<string> {
  const r = await reconcileScenePlanTimings(slug, episodeId, options)
  return `Scene Plan was a little out of step (${reason.replace(/\.$/, '')}). Re-aligned ${r.matched}/${r.total} retained scene(s) `
    + 'to the current captions and carried on; their saved prompts and images were kept.'
    + (r.removed_count ? ` Removed ${r.removed_count} non-renderable timing row(s); their narration moved to a neighbour.` : '')
}
