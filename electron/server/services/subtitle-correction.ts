/**
 * Corrected-transcript pass — the disk side of `lib/srt-correction.ts`.
 *
 * Produces `<CODE>_stitched.corrected.srt`: the ASR timings from
 * `<CODE>_stitched.srt` carrying the words from the per-chapter narration
 * script that was fed to TTS. The original stitched file is never modified —
 * it stays on disk as evidence of what Whisper actually heard.
 *
 * This module also owns the ONE answer to "where is the transcript for this
 * episode". Before v1.0.797 that question was answered by seven separate
 * copies of `path.join(subtitles_dir, `${CODE}_stitched.srt`)`, which is
 * exactly the shape of bug this codebase has been bitten by repeatedly. Every
 * planning consumer now calls `resolveTranscriptSrtPath`, so the correction
 * reaches Scene Plan — and through `scene_plan.json`'s `transcript_segment`,
 * the scene visual prompts and the Contextual Cues generator — without any of
 * them knowing this pass exists.
 *
 * Chapter bounding: the stitcher's companion sidecar
 * (`<CODE>_stitched.srt.json`) records each section's `cues_added`, so the
 * stitched cue list partitions back into chapters exactly. Alignment is then
 * per chapter, which means one bad chapter cannot corrupt the others.
 *
 * Burn-in is deliberately untouched. `resolveBurnSubtitle` matches
 * `_stitched.(srt|ass|vtt)$`, which neither `_stitched.corrected.srt` nor the
 * hand-built `_stitched.burnin.srt` satisfy, so adding this file cannot
 * change what gets burned into a video. A user who wants the corrected text
 * burned can pin it with the existing `.selected_subtitle` sidecar.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { parseSrt, formatSrtTime, type SrtCue } from '../lib/subtitle-builder.js'
import { parseNarrationDocx } from '../lib/docx-parser.js'
import { chapterFilePath } from '../lib/narration-assembly.js'
import { resolveReadPath } from '../lib/episode-artifacts.js'
import {
  correctChapterCues,
  DEFAULT_CORRECTION_THRESHOLDS,
  type ChapterTrust,
  type CorrectionThresholds,
} from '../lib/srt-correction.js'

/** Schema version of the corrected sidecar. Bump when its shape changes. */
export const CORRECTED_SCHEMA_VERSION = 1

// ── Path helpers — the single source of truth ──────────────────────────────

/** The raw Whisper stitch. Kept as evidence; never rewritten by this pass. */
export function stitchedSrtPath(subtitlesDir: string, episodeCode: string): string {
  return path.join(subtitlesDir, `${episodeCode.toUpperCase()}_stitched.srt`)
}

/** The corrected transcript: ASR timings, script words. */
export function correctedSrtPath(subtitlesDir: string, episodeCode: string): string {
  return path.join(subtitlesDir, `${episodeCode.toUpperCase()}_stitched.corrected.srt`)
}

// ── Result shapes ──────────────────────────────────────────────────────────

export interface ChapterCorrectionReport {
  slug: string
  script_file: string
  accepted: boolean
  reason: string
  cues_in: number
  cues_out: number
  cues_dropped: number
  cues_rewritten: number
  trust: ChapterTrust
}

export interface CorrectionReport {
  /** True when a corrected file exists on disk and is safe to read. */
  written: boolean
  /** Absolute path to the corrected file, or null when none was written. */
  path: string | null
  cues_in: number
  cues_out: number
  cues_dropped: number
  cues_rewritten: number
  chapters_total: number
  chapters_corrected: number
  chapters_refused: number
  warnings: string[]
  chapters: ChapterCorrectionReport[]
  samples: Array<{ from: string; to: string }>
  /** Set when no corrected file could be produced at all. */
  skipped_reason?: string
}

interface StitchMetaSection {
  slug?: string
  source_srt?: string
  offset_sec?: number
  duration_sec?: number
  cues_added?: number
}

// ── Build ──────────────────────────────────────────────────────────────────

export interface BuildCorrectedInputs {
  subtitles_dir: string
  script_dir: string
  episode_code: string
  thresholds?: CorrectionThresholds
}

/**
 * Build `<CODE>_stitched.corrected.srt` from the stitched SRT + the script.
 *
 * Never throws for data reasons: an episode that cannot be corrected simply
 * reports `written: false` and callers fall back to the original. The one
 * thing this must never do is write a corrupted file, so a chapter that fails
 * the trust gate is passed through with its ORIGINAL cues rather than
 * rewritten, and a file where nothing could be corrected is not written at
 * all.
 */
export async function buildCorrectedTranscript(inputs: BuildCorrectedInputs): Promise<CorrectionReport> {
  const { subtitles_dir, script_dir, episode_code } = inputs
  const thresholds = inputs.thresholds || DEFAULT_CORRECTION_THRESHOLDS
  const code = episode_code.toUpperCase()
  const srcPath = stitchedSrtPath(subtitles_dir, code)
  const outPath = correctedSrtPath(subtitles_dir, code)

  const empty = (reason: string): CorrectionReport => ({
    written: false, path: null,
    cues_in: 0, cues_out: 0, cues_dropped: 0, cues_rewritten: 0,
    chapters_total: 0, chapters_corrected: 0, chapters_refused: 0,
    warnings: [reason], chapters: [], samples: [], skipped_reason: reason,
  })

  if (!existsSync(srcPath)) return empty('No stitched subtitle timeline to correct.')

  // Sidecar first. This function is reached from a polled status route, so the
  // cheap disqualifiers must run before the SRT is read and parsed.
  let sections: StitchMetaSection[] = []
  try {
    const meta = JSON.parse(await fs.readFile(`${srcPath}.json`, 'utf-8'))
    if (Array.isArray(meta?.sections)) sections = meta.sections as StitchMetaSection[]
  } catch { /* handled below */ }
  if (!sections.length) {
    return empty('The stitched subtitle timeline has no chapter sidecar, so chapters cannot be bounded for alignment.')
  }

  let cues: SrtCue[]
  try {
    cues = parseSrt(await fs.readFile(srcPath, 'utf-8'))
  } catch (err) {
    return empty(`Could not read the stitched subtitle timeline: ${errText(err)}`)
  }
  if (!cues.length) return empty('The stitched subtitle timeline has no cues.')

  const partition = partitionCuesByCueCount(cues, sections)
  if (!partition) {
    return empty('The chapter sidecar does not account for every stitched cue, so chapter boundaries are unreliable.')
  }

  const warnings: string[] = []
  const chapterReports: ChapterCorrectionReport[] = []
  const samples: Array<{ from: string; to: string }> = []
  const outCues: SrtCue[] = []
  let dropped = 0
  let rewritten = 0
  let corrected = 0
  let refused = 0

  for (let s = 0; s < sections.length; s++) {
    const section = sections[s]!
    const slug = String(section.slug || `Section_${s + 1}`)
    const chapterCues = partition[s]!
    if (!chapterCues.length) continue

    const script = await readChapterScript(script_dir, code, slug, section.source_srt)
    if (!script.text) {
      refused++
      warnings.push(`${slug}: ${script.reason} — its original transcription was kept.`)
      chapterReports.push({
        slug, script_file: script.file, accepted: false, reason: script.reason,
        cues_in: chapterCues.length, cues_out: chapterCues.length, cues_dropped: 0, cues_rewritten: 0,
        trust: emptyTrust(script.reason),
      })
      for (const c of chapterCues) outCues.push({ ...c })
      continue
    }

    const result = correctChapterCues(chapterCues, script.text, thresholds)
    if (result.trust.accepted) {
      corrected++
      dropped += result.dropped.length
      rewritten += result.rewritten
      for (const c of result.cues) outCues.push(c)
      for (const sample of result.samples) if (samples.length < 100) samples.push(sample)
    } else {
      refused++
      warnings.push(
        `${slug}: refused to correct because ${result.trust.reason}. `
        + 'Its original transcription was kept — regenerate the audio from the current script, or re-transcribe, to correct it.',
      )
      for (const c of result.cues) outCues.push({ ...c })
    }
    chapterReports.push({
      slug,
      script_file: script.file,
      accepted: result.trust.accepted,
      reason: result.trust.reason,
      cues_in: chapterCues.length,
      cues_out: result.cues.length,
      cues_dropped: result.dropped.length,
      cues_rewritten: result.rewritten,
      trust: result.trust,
    })
  }

  if (!corrected) {
    // Nothing was improved. Writing a byte-identical copy under a name that
    // promises correction would be a lie the generators then trust.
    await Promise.all([
      fs.unlink(outPath).catch(() => undefined),
      fs.unlink(`${outPath}.json`).catch(() => undefined),
    ])
    const reason = refused
      ? 'No chapter passed the script/audio agreement check, so no corrected transcript was written.'
      : 'No chapter could be matched to a script file, so no corrected transcript was written.'
    return {
      written: false, path: null,
      cues_in: cues.length, cues_out: 0, cues_dropped: 0, cues_rewritten: 0,
      chapters_total: chapterReports.length, chapters_corrected: 0, chapters_refused: refused,
      warnings: [reason, ...warnings], chapters: chapterReports, samples: [], skipped_reason: reason,
    }
  }

  // Renumber sequentially — indices are cosmetic, timestamps are the contract.
  const lines: string[] = []
  outCues.forEach((c, i) => {
    lines.push(String(i + 1))
    lines.push(`${formatSrtTime(c.start_sec)} --> ${formatSrtTime(c.end_sec)}`)
    lines.push(c.text)
    lines.push('')
  })
  await fs.writeFile(outPath, lines.join('\n'), 'utf-8')

  const srcStat = await fs.stat(srcPath).catch(() => null)
  const report: CorrectionReport = {
    written: true,
    path: outPath,
    cues_in: cues.length,
    cues_out: outCues.length,
    cues_dropped: dropped,
    cues_rewritten: rewritten,
    chapters_total: chapterReports.length,
    chapters_corrected: corrected,
    chapters_refused: refused,
    warnings,
    chapters: chapterReports,
    samples,
  }
  await fs.writeFile(`${outPath}.json`, JSON.stringify({
    srt: path.basename(outPath),
    schema_version: CORRECTED_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    source_srt: path.basename(srcPath),
    source_mtime_ms: srcStat ? srcStat.mtimeMs : null,
    source_size: srcStat ? srcStat.size : null,
    thresholds,
    ...report,
    path: undefined,
  }, null, 2), 'utf-8')

  return report
}

// ── Freshness + resolution ─────────────────────────────────────────────────

/**
 * Rebuild the corrected transcript when it is missing or stale relative to the
 * stitched file. Cheap and idempotent when fresh (one stat comparison), so it
 * is safe to call from a status route.
 */
export async function ensureCorrectedTranscript(inputs: BuildCorrectedInputs): Promise<CorrectionReport | null> {
  const code = inputs.episode_code.toUpperCase()
  const srcPath = stitchedSrtPath(inputs.subtitles_dir, code)
  const outPath = correctedSrtPath(inputs.subtitles_dir, code)
  if (!existsSync(srcPath)) return null

  if (existsSync(outPath)) {
    try {
      const meta = JSON.parse(await fs.readFile(`${outPath}.json`, 'utf-8'))
      const srcStat = await fs.stat(srcPath)
      if (
        meta?.schema_version === CORRECTED_SCHEMA_VERSION
        && meta?.source_mtime_ms === srcStat.mtimeMs
        && meta?.source_size === srcStat.size
      ) {
        return { ...(meta as CorrectionReport), written: true, path: outPath }
      }
    } catch { /* stale or unreadable → rebuild */ }
  }
  return buildCorrectedTranscript(inputs)
}

export interface ResolvedTranscript {
  /** The file planning should read. */
  path: string
  /** True when `path` is the corrected file. */
  corrected: boolean
  report: CorrectionReport | null
}

/**
 * THE resolver: which SRT should a planning consumer read?
 *
 * Returns the corrected transcript when one could be produced, and the raw
 * stitched file otherwise. Never throws — a correction failure degrades to the
 * original rather than blocking Scene Plan.
 */
export async function resolveTranscriptSrt(inputs: BuildCorrectedInputs): Promise<ResolvedTranscript> {
  const code = inputs.episode_code.toUpperCase()
  const fallback = stitchedSrtPath(inputs.subtitles_dir, code)
  try {
    const report = await ensureCorrectedTranscript(inputs)
    if (report?.written && report.path && existsSync(report.path)) {
      return { path: report.path, corrected: true, report }
    }
    return { path: fallback, corrected: false, report: report || null }
  } catch {
    return { path: fallback, corrected: false, report: null }
  }
}

/** Convenience wrapper for callers that only need the path. */
export async function resolveTranscriptSrtPath(inputs: BuildCorrectedInputs): Promise<string> {
  return (await resolveTranscriptSrt(inputs)).path
}

/**
 * Operator-facing lines describing what the correction pass did, for a job's
 * output log. A silent correction would be worse than none: the whole point is
 * that the words on screen came from the script, and that must be visible.
 */
export function describeTranscriptCorrection(resolved: ResolvedTranscript): string[] {
  const report = resolved.report
  const lines: string[] = []
  if (!resolved.corrected || !report) {
    const why = report?.skipped_reason || 'no corrected transcript was available'
    lines.push(`Transcript: using Whisper's own words (${why}).`)
    return lines
  }
  lines.push(
    `Transcript: corrected against the narration script — ${report.cues_rewritten} cue(s) rewritten, `
    + `${report.cues_dropped} hallucinated cue(s) dropped, ${report.cues_out} of ${report.cues_in} kept. `
    + 'Timings are unchanged and the original stitch is untouched on disk.',
  )
  if (report.chapters_refused > 0) {
    lines.push(
      `Transcript: ${report.chapters_refused} of ${report.chapters_total} chapter(s) kept Whisper's words because `
      + 'the script and the audio did not agree closely enough to correct safely.',
    )
  }
  for (const warning of report.warnings.slice(0, 10)) lines.push(`Transcript: ${warning}`)
  return lines
}

// ── Internals ──────────────────────────────────────────────────────────────

/**
 * Split the stitched cues back into their source chapters using the sidecar's
 * per-section `cues_added`. The stitcher appends sections in order, so the
 * counts partition the list exactly. Returns null when the counts do not add
 * up — an unreliable boundary must refuse, not guess.
 */
export function partitionCuesByCueCount(
  cues: SrtCue[],
  sections: StitchMetaSection[],
): SrtCue[][] | null {
  let total = 0
  for (const s of sections) {
    const n = Number(s.cues_added)
    if (!Number.isFinite(n) || n < 0) return null
    total += n
  }
  if (total !== cues.length) return null
  const out: SrtCue[][] = []
  let cursor = 0
  for (const s of sections) {
    const n = Number(s.cues_added)
    out.push(cues.slice(cursor, cursor + n))
    cursor += n
  }
  return out
}

interface ChapterScript { text: string; file: string; reason: string }

/**
 * Read the clean narration for one chapter.
 *
 * `parseNarrationDocx` is reused rather than stripping the heading here: it is
 * the same reader the audio pipeline uses, it handles legacy `.docx` chapters,
 * and it normalises format vocabulary (Reason/Topic/Part…) back to
 * `Chapter_NN`. Its section `text` is the body WITHOUT the heading, which is
 * precisely what was spoken.
 */
async function readChapterScript(
  scriptDir: string,
  code: string,
  slug: string,
  sourceSrt: string | undefined,
): Promise<ChapterScript> {
  const num = chapterNumberFrom(slug) ?? chapterNumberFrom(sourceSrt || '')
  if (num === null) {
    return { text: '', file: '', reason: `no chapter number could be read from section "${slug}"` }
  }
  const file = resolveReadPath(chapterFilePath(scriptDir, code, num))
  if (!existsSync(file)) {
    return { text: '', file: path.basename(file), reason: `the script chapter ${path.basename(file)} is missing` }
  }
  try {
    const sections = await parseNarrationDocx(file)
    if (!sections.length) {
      return { text: '', file: path.basename(file), reason: `${path.basename(file)} has no readable narration` }
    }
    const wanted = `Chapter_${num.toString().padStart(2, '0')}`
    const match = sections.find(s => s.slug === wanted) || sections[0]!
    const text = (match.text || '').trim()
    if (!text) {
      return { text: '', file: path.basename(file), reason: `${path.basename(file)} has no narration body` }
    }
    return { text, file: path.basename(file), reason: '' }
  } catch (err) {
    return { text: '', file: path.basename(file), reason: `${path.basename(file)} could not be read: ${errText(err)}` }
  }
}

/** Pull the chapter number out of "Chapter_01", "chapter 1", "EP0067_Chapter_03.srt". */
export function chapterNumberFrom(value: string): number | null {
  const m = /(\d+)/.exec(String(value || '').replace(/^[A-Za-z]+\d{2,}[ _-]*/, ''))
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function emptyTrust(reason: string): ChapterTrust {
  return {
    accepted: false, reason,
    script_words: 0, asr_words: 0,
    substitutions: 0, deletions: 0, plausible_insertions: 0, fabricated_insertions: 0,
    mismatch_words: 0, mismatch_rate: 1, longest_mismatch_run: 0,
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
