/**
 * Script-timed subtitles, disk side (owner decision 2026-10-05). See
 * `lib/script-timed-cues.ts` for the cue rules.
 *
 * The timing comes from what narration already knows:
 *   - the Studio Hub's section timeline (each ≤250-character section's start and
 *     end in the delivered audio and its place in the request text), kept per
 *     audio file in `<audio>/section_timelines.json` when the request finished
 *     (Hub `section_quality.timeline`, passed through by the Gateway);
 *   - Story's own part seams (`.parts/<stem>/manifest.json`: each part's trimmed
 *     edges and the pause after it).
 * A file without a timeline for ITS bytes (an older Hub, a re-made part) is
 * timed proportionally over its own speech between its seams, and the chapter
 * says so (`timing: 'proportional'`).
 *
 * Refinement hook: a forced aligner can later replace the proportional share
 * inside each span; the spans (and every exact boundary) stay as built here.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { cuesForSpans, scriptWordsFor, type TimedSpan } from '../lib/script-timed-cues.js'
import type { SrtCue } from '../lib/subtitle-builder.js'
import { EDGE_FADE_S, measurePart, readPartsManifest, sha256File, textSha } from './chapter-parts.js'

/** Recorded as the subtitle "model" (`.subtitle-recovery.json`), with `:proportional` when a fallback was used. */
export const SCRIPT_TIMED = 'script-timed'
export const SECTION_TIMELINES = 'section_timelines.json'

export interface SectionTimelineRow { start_s: number; end_s: number; text_start: number; text_end: number }
interface TimelineRecord { sha256: string; text: string; timeline: SectionTimelineRow[] }
interface TimelinesFile { schema_version: 1; files: Record<string, TimelineRecord> }

/** The Hub's `section_quality.timeline`, or null when it is absent or not usable. */
export function sectionTimelineRows(sectionQuality: unknown): SectionTimelineRow[] | null {
  const raw = (sectionQuality as { timeline?: unknown } | null)?.timeline
  if (!Array.isArray(raw) || !raw.length) return null
  const rows: SectionTimelineRow[] = []
  for (const row of raw as Array<Record<string, unknown>>) {
    const { start_s, end_s, text_start, text_end } = row || {}
    if (![start_s, end_s, text_start, text_end].every(v => typeof v === 'number' && Number.isFinite(v))) return null
    const last = rows.at(-1)
    if ((end_s as number) < (start_s as number) || (text_end as number) < (text_start as number)
      || (last && ((start_s as number) < last.end_s || (text_start as number) < last.text_end))) return null
    rows.push({ start_s, end_s, text_start, text_end } as SectionTimelineRow)
  }
  return rows
}

async function readTimelines(audioDir: string): Promise<TimelinesFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(audioDir, SECTION_TIMELINES), 'utf8'))
    if (parsed && typeof parsed.files === 'object') return parsed as TimelinesFile
  } catch { /* none yet */ }
  return { schema_version: 1, files: {} }
}

/** Keep a finished request's section timeline beside its audio, bound to the file's bytes. */
export async function recordSectionTimeline(audioDir: string, filename: string, text: string, sectionQuality: unknown): Promise<void> {
  const timeline = sectionTimelineRows(sectionQuality)
  if (!timeline) return
  const sha256 = await sha256File(path.join(audioDir, filename))
  const file = path.join(audioDir, SECTION_TIMELINES)
  await withLock(file, async () => {
    const current = await readTimelines(audioDir)
    current.files[filename] = { sha256, text, timeline }
    await writeJsonAtomic(file, current)
  })
}

export interface ScriptTimedChapterInput {
  audioDir: string
  code: string
  slug: string
  /** The chapter's active audio files, in order (Audio Assembly's selection). */
  files: string[]
  /** The chapter as sent to the voice (`normalizeForTts`). */
  spokenText: string
  /** The request texts the chapter was narrated as, when known. */
  partTexts?: string[]
  /** The script's own words, shown where the spoken text differs only by normalisation. */
  scriptText: string
}

export interface ScriptTimedChapter {
  cues: SrtCue[]
  /** 'sections': every file had its Hub section timeline; 'proportional': at least one was timed over its whole speech. */
  timing: 'sections' | 'proportional'
}

interface Piece {
  name: string
  sha: string
  /** Seconds of the file's own audio cut before it in the chapter. */
  lead: number
  /** Seconds of it that are in the chapter. */
  length: number
  /** Where its speech starts and ends inside that stretch, when the file was not trimmed. */
  speech?: [number, number]
  text?: string
}

/** Cues for one chapter, timed in the chapter file's own seconds (what the stitcher offsets). */
export async function scriptTimedChapter(input: ScriptTimedChapterInput): Promise<ScriptTimedChapter> {
  const { audioDir, files, spokenText, partTexts } = input
  const timelines = await readTimelines(audioDir)
  const pieces: Piece[] = []
  const gaps: number[] = []
  const manifest = files.length === 1 ? await readPartsManifest(audioDir, `${input.code}_${input.slug}`) : null
  if (manifest && manifest.stitched_file === files[0]
    && manifest.stitched_sha256 === await sha256File(path.join(audioDir, files[0]!))) {
    // A joined chapter: each part trimmed to its speech, then the seam's pause (chapter-parts stitchParts).
    for (const [i, part] of manifest.parts.entries()) {
      const end = Math.max(part.lead_silence_s + 2 * EDGE_FADE_S, part.duration_s - part.trail_silence_s)
      const slice = part.text_start !== undefined && part.text_end !== undefined ? spokenText.slice(part.text_start, part.text_end) : undefined
      pieces.push({
        name: part.source_name, sha: part.sha256, lead: part.lead_silence_s, length: end - part.lead_silence_s,
        text: slice !== undefined && (!part.text_sha256 || textSha(slice) === part.text_sha256) ? slice
          : partTexts?.length === manifest.parts.length ? partTexts[i] : undefined,
      })
      if (i < manifest.parts.length - 1) gaps.push(Math.max(0, (part.pause_after_s ?? 1) - 2 * EDGE_FADE_S))
    }
  } else {
    // Files played back to back (a single chapter file, or legacy loose parts concatenated as-is).
    for (const [i, name] of files.entries()) {
      const file = path.join(audioDir, name)
      const sha = await sha256File(file)
      const record = timelines.files[name]
      const timed = record?.sha256 === sha
      const needsMeasure = files.length > 1 || !timed
      const m = needsMeasure ? await measurePart(file) : null
      pieces.push({
        name, sha, lead: 0, length: m?.duration_s ?? Infinity,
        ...(m ? { speech: [m.lead_silence_s, Math.max(m.lead_silence_s, m.duration_s - m.trail_silence_s)] as [number, number] } : {}),
        text: timed ? record!.text : files.length === 1 ? spokenText : partTexts?.length === files.length ? partTexts[i] : undefined,
      })
      if (i < files.length - 1) gaps.push(0)
    }
  }

  const spans: TimedSpan[] = []
  let offset = 0
  let proportional = false
  for (const [i, piece] of pieces.entries()) {
    const record = timelines.files[piece.name]
    // The Hub's offsets count code points in the text it spoke (its own `strip()`ped request text).
    const spoken = Array.from(record?.sha256 === piece.sha ? record.text.trim() : '')
    const rows = spoken.length && record!.timeline.at(-1)!.text_end === spoken.length ? record!.timeline : null
    const at = (t: number) => offset + Math.min(Math.max(t - piece.lead, 0), piece.length)
    if (rows) {
      for (const row of rows) spans.push({ start_s: at(row.start_s), end_s: at(row.end_s), text: spoken.slice(row.text_start, row.text_end).join('') })
    } else if (piece.text) {
      proportional = true
      const [from, to] = piece.speech ?? [0, piece.length]
      spans.push({ start_s: offset + from, end_s: offset + to, text: piece.text })
    } else {
      // No text for this file: time the whole chapter over its speech, seams and all.
      const first = pieces[0]!.speech?.[0] ?? 0
      const total = pieces.reduce((sum, p) => sum + p.length, 0) + gaps.reduce((sum, g) => sum + g, 0)
      const last = pieces.at(-1)!
      const end = total - (last.speech ? last.length - last.speech[1] : 0)
      return { cues: scriptWordsFor(cuesForSpans([{ start_s: first, end_s: end, text: spokenText }]), input.scriptText), timing: 'proportional' }
    }
    offset += piece.length + (gaps[i] ?? 0)
  }
  return { cues: scriptWordsFor(cuesForSpans(spans), input.scriptText), timing: proportional ? 'proportional' : 'sections' }
}
