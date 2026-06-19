/**
 * Intro lead-in detection for subtitle timing (v1.0.398).
 *
 * Audio Assembly can start the merged track with non-narration audio before
 * the voice begins — a prepended intro file + gap, OR (v1.0.397) a background
 * music "lead-in" that delays the narration via adelay. Either way the merged
 * audio your video uses starts the narration a few seconds in. But subtitle
 * timelines built from the CLEAN per-chapter narration (the stitched SRT, the
 * chapters-derived SRT) start at t=0 — so the burned captions run AHEAD of the
 * video by exactly the lead-in. That's the "I added an intro and the subtitles
 * are now mismatched" report.
 *
 * The merge has no outro / trailing pad (music after narration is trimmed), so
 * the lead-in is simply:  mergedDuration − narrationExtent, where
 * narrationExtent = Σ section durations + (n−1) inter-section gaps. Section
 * durations already fold in inter-part chunk silences (audio_chapters.json,
 * v1.0.317). This is agnostic to HOW the lead-in was produced (intro file or
 * music lead-in) — it measures the real offset the narration starts at.
 *
 * Read-only against the merged file + the audio_chapters.json sidecar — it
 * does NOT touch the Audio Assembly / merge code.
 */

import { getAudioDuration } from './ffmpeg-utils.js'

/** Σ section durations + (n−1) inter-section gaps. Section durations already
 *  include inter-part chunk silences (see audio-merge v1.0.317). */
export function narrationExtentSec(
  sections: Array<{ duration_s?: number }>,
  gapSec: number,
): number {
  if (!sections.length) return 0
  const sum = sections.reduce((a, s) => a + (Number(s.duration_s) || 0), 0)
  return sum + Math.max(0, sections.length - 1) * Math.max(0, gapSec)
}

/**
 * Seconds of non-narration audio (intro / music lead-in + its gap) prepended
 * to the merged track — the offset subtitle timelines must add so captions
 * line up with the video. Returns 0 when there's no merged audio, no
 * measurable lead-in, or on any error (so an intro-less episode is unaffected).
 */
export async function computeIntroLeadInSec(
  mergedAudioPath: string | null | undefined,
  sections: Array<{ duration_s?: number }>,
  gapSec: number,
): Promise<number> {
  if (!mergedAudioPath) return 0
  const dur = await getAudioDuration(mergedAudioPath).catch(() => undefined)
  if (typeof dur !== 'number' || !Number.isFinite(dur)) return 0
  const extent = narrationExtentSec(sections, gapSec)
  if (extent <= 0) return 0
  const lead = dur - extent
  // Ignore sub-0.3s noise (encoder padding / rounding); round to ms.
  return lead > 0.3 ? Math.round(lead * 1000) / 1000 : 0
}

/**
 * Where the STORY begins on the final video / stitched-SRT timeline (v1.0.423).
 *
 * Sleep-story episodes bundle the welcome / context / CTA / breathing into a
 * leading audio chapter literally named "Introduction". That chapter is spoken
 * narration (so it IS transcribed and DOES produce subtitle cues + would be
 * planned into scenes), but it's not story. To skip it everywhere consistently
 * we need ONE timeline position: the moment the first story chapter starts.
 *
 * This mirrors the subtitle-stitcher's cursor math EXACTLY (cursor = leadIn,
 * then per section `cursor += duration_s + gap`), so the value lines up with
 * both the stitched SRT cue timestamps (→ scene-plan skip) and video time
 * (→ title-card hold + intro-caption trim). Returns null when there's no
 * section matching "Introduction" — callers then apply no skip.
 */
export async function computeStoryStartSec(
  mergedAudioPath: string | null | undefined,
  sections: Array<{ slug?: string; duration_s?: number }>,
  gapSec: number,
): Promise<{ story_start_sec: number; intro_index: number; intro_label: string } | null> {
  if (!sections?.length) return null
  // Strict "Introduction" first; fall back to any leading "*intro*" slug.
  let introIndex = sections.findIndex(s => /^introduction$/i.test(s.slug || ''))
  if (introIndex < 0) introIndex = sections.findIndex(s => /intro/i.test(s.slug || ''))
  if (introIndex < 0) return null
  const leadIn = await computeIntroLeadInSec(mergedAudioPath, sections, gapSec)
  const gap = Math.max(0, gapSec)
  // Walk to the START of the section AFTER the Introduction — i.e. the first
  // story chapter — which equals the cursor after adding the intro's duration
  // and its trailing gap. Same accumulation the stitcher uses.
  let cursor = leadIn
  for (let i = 0; i <= introIndex; i++) {
    cursor += (Number(sections[i]?.duration_s) || 0) + gap
  }
  return {
    story_start_sec: Math.round(cursor * 1000) / 1000,
    intro_index: introIndex,
    intro_label: sections[introIndex]?.slug || 'Introduction',
  }
}
