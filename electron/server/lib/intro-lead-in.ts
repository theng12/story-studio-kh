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
