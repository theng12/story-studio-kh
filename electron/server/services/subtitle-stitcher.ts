/**
 * Subtitle stitcher (v1.0.143+).
 *
 * Combines per-chapter SRTs in an episode's subtitles_dir into a single
 * global-timeline SRT, accounting for the inter-chapter silence gap the
 * audio-merge job inserted (v1.0.140+ persists this as
 * `audio_chapters.json.gap_duration_s`).
 *
 * Why this matters:
 *   - Per-chapter SRTs have timestamps RELATIVE to each chapter (each
 *     starts at 00:00:00).
 *   - The merged audio file plays the chapters back-to-back with the
 *     configured gap between them.
 *   - For the timestamp-driven scene planner to do its job, it needs
 *     ONE SRT whose timestamps line up with the merged audio's actual
 *     timeline.
 *
 * Input requirements:
 *   - `audio_chapters.json` exists (audio merge has run). Provides
 *     per-section duration + gap_duration_s.
 *   - At least one per-chapter SRT exists in subtitles_dir. The
 *     stitcher matches each chapter's audio filename to a SRT named
 *     `<chapter_slug>.srt` (or `<code>_<chapter_slug>.srt`).
 *
 * Output:
 *   - `<subtitles_dir>/<code>_stitched.srt` — the unified SRT
 *   - `<subtitles_dir>/<code>_stitched.srt.json` — companion meta:
 *     which source SRTs were stitched, the gap used, generated_at.
 *     Powers drift detection like v1.0.140's chapters meta.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { parseSrt, formatSrtTime, type SrtCue } from '../lib/subtitle-builder.js'

export interface StitcherInputs {
  /** Episode dir — where audio_chapters.json lives. */
  episode_dir: string
  /** Subtitles dir — where per-chapter SRTs live + the stitched
   *  output will be written. */
  subtitles_dir: string
  /** Episode code, used to name the stitched output + match
   *  per-chapter SRT files. */
  episode_code: string
  /** v1.0.397 — seconds of intro audio (intro + its gap) prepended to the
   *  merged track. The stitched timeline starts at this offset so the burned
   *  captions line up with the video instead of running ahead by the intro
   *  length. Default 0 (no intro) — Scene Plan's stitch passes nothing, so
   *  scene timing is unchanged. */
  lead_in_sec?: number
}

export interface StitchedSection {
  slug: string
  /** Which on-disk SRT file we stitched in. Empty when no SRT was
   *  found for this chapter — that section's audio still consumes
   *  its duration in the global timeline but contributes no cues. */
  source_srt?: string
  /** Cumulative second offset at the start of this section. */
  offset_sec: number
  /** Duration of this section's audio (drives where the NEXT
   *  section starts after the gap is added). */
  duration_sec: number
  /** Number of cues this section contributed to the stitched output. */
  cues_added: number
}

export interface StitchResult {
  /** Absolute path to the stitched SRT. */
  output_path: string
  /** How many cues ended up in the stitched output. */
  total_cues: number
  /** Per-section breakdown — useful for the Scene Plan UI to show
   *  "chapter 3's SRT is missing" etc. */
  sections: StitchedSection[]
  /** Total duration covered by the stitched timeline (last section's
   *  end + gap, minus the final trailing gap). */
  total_duration_sec: number
  /** Gap value the stitch was performed with. Matches what's in
   *  audio_chapters.json at the time. */
  gap_sec: number
  /** v1.0.397 — intro lead-in the timeline was offset by (0 = none). */
  lead_in_sec: number
}

interface AudioChaptersSidecar {
  sections?: Array<{ slug: string; duration_s: number; source_file?: string }>
  gap_duration_s?: number
}

/**
 * Find the SRT file for a given chapter slug. Tries common naming
 * conventions in priority order. Returns the filename (not full path)
 * or undefined when no match.
 */
/** Collapse a slug/filename to bare alphanumerics for tolerant comparison. */
function normSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findSrtForChapter(
  available: string[],
  episodeCode: string,
  slug: string,
): string | undefined {
  // 1. Exact filename variants, in priority order.
  const candidates = [
    `${slug}.srt`,
    `${episodeCode}_${slug}.srt`,
    `${slug}_whisper.srt`,
    `${episodeCode}_${slug}_whisper.srt`,
  ]
  for (const candidate of candidates) {
    if (available.includes(candidate)) return candidate
  }
  // 2. Case-insensitive match of those same variants.
  const lowerCandidates = candidates.map(c => c.toLowerCase())
  const ciExact = available.find(f => lowerCandidates.includes(f.toLowerCase()))
  if (ciExact) return ciExact

  // 3. v1.0.218 — normalized match. Strip the optional "{code}_" prefix, the
  //    ".srt" suffix and a trailing "_whisper", then compare alphanumerics
  //    only. This tolerates the real-world drift between an audio section
  //    slug (e.g. "chapter_1") and the SRT filename ("EP0001_Chapter1.srt",
  //    "Chapter 1.srt", etc.) that otherwise silently produced an empty
  //    stitch. This is the common cause of the "blank stitched SRT" bug.
  const target = normSlug(slug)
  const codeStrip = new RegExp(`^${escapeRegExp(episodeCode)}[ _-]*`, 'i')
  const normMatch = available.find(f => {
    if (!f.toLowerCase().endsWith('.srt')) return false
    let base = f.replace(/\.srt$/i, '').replace(codeStrip, '').replace(/[ _-]*whisper$/i, '')
    return normSlug(base) === target
  })
  if (normMatch) return normMatch

  // 4. Last resort: a normalized "contains" (slug appears within the name).
  return available.find(f =>
    f.toLowerCase().endsWith('.srt') && normSlug(f).includes(target) && target.length >= 3,
  )
}

/**
 * Build the stitched SRT. Returns the cue array + the per-section
 * provenance so callers can also write a meta sidecar.
 */
export async function stitchSubtitles(inputs: StitcherInputs): Promise<StitchResult> {
  const { episode_dir, subtitles_dir, episode_code } = inputs

  // Read audio_chapters.json — required input.
  const audioChaptersPath = path.join(episode_dir, 'audio_chapters.json')
  if (!existsSync(audioChaptersPath)) {
    throw new Error(
      `audio_chapters.json not found at ${audioChaptersPath}. ` +
      `Run Audio Assembly first — the stitcher needs per-section durations + the gap value.`,
    )
  }
  const sidecarRaw = await fs.readFile(audioChaptersPath, 'utf-8')
  const sidecar = JSON.parse(sidecarRaw) as AudioChaptersSidecar
  const sectionsMeta = sidecar.sections || []
  const gapSec = typeof sidecar.gap_duration_s === 'number' ? sidecar.gap_duration_s : 0
  if (!sectionsMeta.length) {
    throw new Error('audio_chapters.json has no sections — re-run Audio Assembly.')
  }

  // Survey the subtitles dir for available SRTs.
  if (!existsSync(subtitles_dir)) {
    throw new Error(
      `Subtitles dir not found at ${subtitles_dir}. ` +
      `Generate subtitles first — open the Subtitles tab (after Audio Assembly) ` +
      `and run "Transcribe (Whisper)".`,
    )
  }
  const allFiles = await fs.readdir(subtitles_dir)
  const srtFiles = allFiles.filter(f => f.toLowerCase().endsWith('.srt'))

  // Walk sections, offset each chapter's cues, accumulate. The timeline
  // starts at the intro lead-in (v1.0.397) so the captions line up with the
  // merged audio (which plays the intro before any narration). 0 when there's
  // no intro — identical to the pre-1.0.397 timeline.
  const leadIn = Math.max(0, Number(inputs.lead_in_sec) || 0)
  const stitchedCues: SrtCue[] = []
  const sectionsResult: StitchedSection[] = []
  let cursor = leadIn
  let cueIdx = 0
  for (const sec of sectionsMeta) {
    const sourceSrt = findSrtForChapter(srtFiles, episode_code, sec.slug)
    let cuesAdded = 0
    if (sourceSrt) {
      const raw = await fs.readFile(path.join(subtitles_dir, sourceSrt), 'utf-8')
      const cues = parseSrt(raw)
      for (const c of cues) {
        // Clamp end_sec to the section's duration so a slightly-too-
        // long Whisper cue doesn't bleed into the silence gap.
        const start = cursor + Math.max(0, c.start_sec)
        const end = cursor + Math.min(c.end_sec, sec.duration_s)
        if (end <= start) continue
        stitchedCues.push({
          index: ++cueIdx,
          start_sec: start,
          end_sec: end,
          text: c.text,
        })
        cuesAdded++
      }
    }
    sectionsResult.push({
      slug: sec.slug,
      source_srt: sourceSrt,
      offset_sec: cursor,
      duration_sec: sec.duration_s,
      cues_added: cuesAdded,
    })
    cursor += sec.duration_s + gapSec
  }
  // Total duration is the cursor minus the trailing gap (no audio
  // follows the last section).
  const totalDuration = Math.max(0, cursor - gapSec)

  // v1.0.218 — FAIL LOUDLY on an empty stitch instead of writing a blank
  // SRT. Previously a 0-cue stitch silently wrote an empty file, which the
  // Scene Plan LLM step then choked on ("nothing to send"). Distinguish the
  // two failure modes so the message tells the user exactly what to fix.
  if (stitchedCues.length === 0) {
    const wantedSlugs = sectionsMeta.map(s => s.slug)
    const matchedCount = sectionsResult.filter(s => s.source_srt).length
    if (matchedCount === 0) {
      throw new Error(
        `Subtitle stitch produced 0 cues: no per-chapter subtitle file matched any audio section.\n` +
        `Audio sections (from audio_chapters.json): ${wantedSlugs.join(', ') || '(none)'}\n` +
        `SRT files present in the subtitles folder: ${srtFiles.length ? srtFiles.join(', ') : '(none)'}\n\n` +
        `Fix: open the Subtitles tab and run "Transcribe (Whisper)" for this episode — it writes one ` +
        `"{code}_{slug}.srt" per chapter that the stitcher offsets onto the timeline. A single merged ` +
        `"{code}_whisper.srt" can't be stitched per section.`,
      )
    }
    throw new Error(
      `Subtitle stitch produced 0 cues: matched ${matchedCount} per-chapter SRT file(s) ` +
      `(${sectionsResult.filter(s => s.source_srt).map(s => s.source_srt).join(', ')}) ` +
      `but none contained usable cues — they're empty or unparseable. ` +
      `Re-run "Transcribe (Whisper)" in the Subtitles tab for this episode, then stitch again.`,
    )
  }

  // Serialize the stitched SRT.
  const srtLines: string[] = []
  for (const c of stitchedCues) {
    srtLines.push(String(c.index))
    srtLines.push(`${formatSrtTime(c.start_sec)} --> ${formatSrtTime(c.end_sec)}`)
    srtLines.push(c.text)
    srtLines.push('')
  }
  const outputPath = path.join(subtitles_dir, `${episode_code}_stitched.srt`)
  await fs.writeFile(outputPath, srtLines.join('\n'), 'utf-8')

  // Companion meta sidecar — same pattern as the chapters-derived
  // SRT meta from v1.0.140. Powers drift detection in the Scene Plan
  // UI ("merge gap changed since this was stitched — re-stitch").
  const meta = {
    srt: path.basename(outputPath),
    schema_version: 1,
    generated_at: new Date().toISOString(),
    gap_duration_s: gapSec,
    lead_in_sec: leadIn,
    total_cues: stitchedCues.length,
    total_duration_sec: totalDuration,
    sections: sectionsResult,
  }
  await fs.writeFile(`${outputPath}.json`, JSON.stringify(meta, null, 2), 'utf-8')

  return {
    output_path: outputPath,
    total_cues: stitchedCues.length,
    sections: sectionsResult,
    total_duration_sec: totalDuration,
    gap_sec: gapSec,
    lead_in_sec: leadIn,
  }
}
