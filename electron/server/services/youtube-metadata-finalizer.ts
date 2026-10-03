/**
 * Late-stage YouTube package finalization.
 *
 * Metadata is generated only after Audio Assembly + Subtitles in the normal
 * production flow. This service deterministically adds the two pieces an LLM
 * must never invent:
 *   - chapter timestamps from Audio Assembly's measured durations, named from
 *     the approved outline whenever possible;
 *   - selected, real research citations from research.json.
 *
 * Subtitle coverage verifies the timeline but is warning-only. Operators can
 * still publish a package when subtitles are incomplete; the result records
 * exactly what could not be verified.
 */

import fs from 'fs/promises'
import path from 'path'
import { readSidecar } from '../lib/chunked-narration.js'
import { resolveEpisodeIntroLeadIn } from '../lib/intro-lead-in.js'
import { readSelectedResearchSources, type SelectedResearchSource } from '../lib/research-sources.js'
import { chaptersFromDurations, formatChapterTimestamps, type Chapter } from '../lib/subtitle-builder.js'
import { inspectAudioAssemblyReadiness } from './audio-workflow-readiness.js'
import { resolveEpisodePathsByCode } from './utils.js'
import { inspectSubtitleCompletion } from './subtitle-completion.js'
import { inspectMusicStitch, type MusicStitchState } from './music-episode-store.js'

export const CHAPTERS_BEGIN = '<!-- youtube:chapters:start -->'
export const CHAPTERS_END = '<!-- youtube:chapters:end -->'
export const SOURCES_BEGIN = '<!-- youtube:sources:start -->'
export const SOURCES_END = '<!-- youtube:sources:end -->'

interface AudioChapterSection {
  slug?: unknown
  duration_s?: unknown
}

interface AudioChapterManifest {
  sections?: AudioChapterSection[]
  gap_duration_s?: unknown
}

export interface YouTubeFinalizationStatus {
  audio_assembly_ready: boolean
  subtitle_complete: boolean
  subtitle_mode: 'per-section' | 'full-track' | 'none'
  subtitle_missing_sections: string[]
  outline_title_count: number
  chapter_count: number
  source_count: number
  lead_in_seconds: number
  warnings: string[]
  /** Present for an Episode Builder (music) episode: chapters come from its tracklist. */
  music_episode?: { songs: number; tracklist_ready: boolean }
}

export interface YouTubeFinalizationResult extends YouTubeFinalizationStatus {
  description: string
  chapters: Array<{ title: string; start_sec: number }>
  sources: SelectedResearchSource[]
  finalized_at: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Replace one owned block without touching prose around it. */
export function refreshManagedBlock(
  description: string,
  begin: string,
  end: string,
  visibleContent: string,
): string {
  const current = description || ''
  const re = new RegExp(`\\s*${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\s*`, 'g')
  const without = current.replace(re, '\n\n').trim()
  if (!visibleContent.trim()) return without
  const block = `${begin}\n${visibleContent.trim()}\n${end}`
  return [without, block].filter(Boolean).join('\n\n').trim()
}

function humanizeSlug(slug: string, index: number): string {
  if (/^introduction$/i.test(slug)) return 'Introduction'
  return slug
    .replace(/^chapter[_\s-]*/i, 'Chapter ')
    .replace(/[_-]+/g, ' ')
    .replace(/\b0+(\d+)\b/g, '$1')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim() || `Chapter ${index + 1}`
}

function outlineTitleForSlug(
  slug: string,
  index: number,
  outline: Array<{ n: number; title: string }>,
): string {
  if (/^introduction$/i.test(slug)) return 'Introduction'
  const numberMatch = slug.match(/(?:chapter[_\s-]*)?(\d+)/i)
  const n = numberMatch ? Number(numberMatch[1]) : index + 1
  const approved = outline.find(item => Number(item.n) === n)?.title?.trim()
  return approved || humanizeSlug(slug, index)
}

export function buildYouTubeChapters(options: {
  sections: Array<{ slug: string; duration_sec: number }>
  outline: Array<{ n: number; title: string }>
  gapSec?: number
  leadInSec?: number
}): Chapter[] {
  const gapSec = Number.isFinite(options.gapSec) ? Math.max(0, Number(options.gapSec)) : 0
  const leadInSec = Number.isFinite(options.leadInSec) ? Math.max(0, Number(options.leadInSec)) : 0
  let chapters = chaptersFromDurations(
    options.sections.map((section, index) => ({
      title: outlineTitleForSlug(section.slug, index, options.outline),
      duration_sec: section.duration_sec,
    })),
    gapSec,
    leadInSec,
  )
  if (leadInSec > 0.3 && chapters.length) {
    chapters = [
      { title: 'Opening', start_sec: 0, end_sec: leadInSec },
      ...chapters,
    ]
  }
  return chapters
}

/** YouTube's chapter rules: the first chapter at 0:00, at least three, each at least 10 s long. */
export const YOUTUBE_MIN_CHAPTERS = 3
export const YOUTUBE_MIN_CHAPTER_SEC = 10

/**
 * Chapters from an Episode Builder tracklist (`0:00 Title` / `1:02:03 Title`, one song per line).
 * The first chapter is pinned to 0:00; a song that starts less than 10 s after the previous kept
 * chapter (or less than 10 s before the end) is folded into its neighbour and named in `dropped`.
 */
export function chaptersFromTracklist(text: string, totalSec?: number | null): { chapters: Chapter[]; dropped: string[] } {
  const rows: Array<{ title: string; start_sec: number }> = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})\s+(.+)$/)
    if (!m) continue
    rows.push({ title: m[4]!.trim(), start_sec: Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) })
  }
  const dropped: string[] = []
  const kept: Array<{ title: string; start_sec: number }> = []
  for (const row of rows) {
    if (!kept.length) { kept.push({ ...row, start_sec: 0 }); continue }
    if (row.start_sec - kept[kept.length - 1]!.start_sec < YOUTUBE_MIN_CHAPTER_SEC) { dropped.push(row.title); continue }
    kept.push(row)
  }
  const end = Number(totalSec)
  while (kept.length > 1 && Number.isFinite(end) && end > 0 && end - kept[kept.length - 1]!.start_sec < YOUTUBE_MIN_CHAPTER_SEC) {
    dropped.push(kept.pop()!.title)
  }
  const chapters = kept.map((row, i) => ({
    title: row.title,
    start_sec: row.start_sec,
    end_sec: kept[i + 1]?.start_sec ?? (Number.isFinite(end) && end > 0 ? end : row.start_sec),
  }))
  return { chapters, dropped }
}

/**
 * A music (Episode Builder) episode: chapters come from its tracklist, there is no narration
 * timing and no subtitle track to verify, and the stitch must match today's song list.
 */
async function finalizeMusicDescription(options: {
  slug: string
  episodeId: string
  description: string
  stitch: MusicStitchState
}): Promise<YouTubeFinalizationResult> {
  const { stitch } = options
  const warnings: string[] = []
  let chapters: Chapter[] = []
  if (!stitch.current) {
    warnings.push(stitch.reason)
  } else {
    const text = await fs.readFile(stitch.tracklist_path!, 'utf-8').catch(() => '')
    const parsed = chaptersFromTracklist(text, stitch.total_sec)
    chapters = parsed.chapters
    if (parsed.dropped.length) {
      warnings.push(`${parsed.dropped.length} song(s) start less than ${YOUTUBE_MIN_CHAPTER_SEC} s after the one before (or before the end), so they share a chapter: ${parsed.dropped.slice(0, 3).join(', ')}.`)
    }
    if (chapters.length < YOUTUBE_MIN_CHAPTERS) {
      warnings.push(`Only ${chapters.length} song(s) are long enough to be chapters; YouTube needs at least ${YOUTUBE_MIN_CHAPTERS}, so no chapters are added.`)
    }
  }
  const description = refreshManagedBlock(
    refreshManagedBlock(options.description, CHAPTERS_BEGIN, CHAPTERS_END, renderChapters(chapters)),
    SOURCES_BEGIN, SOURCES_END, '',
  )
  const usable = chapters.length >= YOUTUBE_MIN_CHAPTERS ? chapters : []
  return {
    description,
    audio_assembly_ready: stitch.current,
    // Nothing to verify: a music episode has no narration and no subtitle track.
    subtitle_complete: true,
    subtitle_mode: 'none',
    subtitle_missing_sections: [],
    outline_title_count: 0,
    chapter_count: usable.length,
    source_count: 0,
    lead_in_seconds: 0,
    warnings,
    music_episode: { songs: stitch.songs, tracklist_ready: stitch.current },
    chapters: usable.map(chapter => ({ title: chapter.title, start_sec: chapter.start_sec })),
    sources: [],
    finalized_at: new Date().toISOString(),
  }
}

function renderSources(sources: SelectedResearchSource[]): string {
  if (!sources.length) return ''
  return ['SOURCES & FURTHER READING', ...sources.map(source => `• ${source.title} — ${source.url}`)].join('\n')
}

function renderChapters(chapters: Chapter[]): string {
  const formatted = formatChapterTimestamps(chapters)
  return formatted ? `CHAPTERS\n${formatted}` : ''
}

/**
 * Build final chapter/source sections and a readiness report. Missing subtitle
 * coverage never throws and never suppresses timing derived from audio.
 */
export async function finalizeYouTubeDescription(options: {
  slug: string
  episodeId: string
  description: string
  includeSources?: boolean
}): Promise<YouTubeFinalizationResult> {
  const {
    slug,
    episodeId,
    includeSources = true,
  } = options
  const paths = await resolveEpisodePathsByCode(slug, episodeId)
  const stitch = await inspectMusicStitch(slug, episodeId)
  if (stitch.music) return finalizeMusicDescription({ slug, episodeId, description: options.description, stitch })
  const warnings: string[] = []
  const audioReadiness = await inspectAudioAssemblyReadiness(slug, episodeId)
  if (!audioReadiness.audio_assembly_ready) {
    warnings.push(...audioReadiness.issues)
  }

  let manifest: AudioChapterManifest = {}
  const manifestPath = path.join(paths.episode_dir, 'audio_chapters.json')
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as AudioChapterManifest
  } catch {
    warnings.push('Audio Assembly timing is unavailable. Run Audio Assembly to add verified YouTube chapters.')
  }

  const timedSections = Array.isArray(manifest.sections)
    ? manifest.sections
      .map((section, index) => ({
        slug: typeof section?.slug === 'string' ? section.slug.trim() : `Chapter_${index + 1}`,
        duration_sec: Number(section?.duration_s),
      }))
      .filter(section => Number.isFinite(section.duration_sec) && section.duration_sec > 0)
    : []
  const gapSec = Number.isFinite(Number(manifest.gap_duration_s))
    ? Math.max(0, Number(manifest.gap_duration_s))
    : 0

  const sidecar = await readSidecar(paths.script_dir, episodeId).catch(() => null)
  const outline = Array.isArray(sidecar?.outline) ? sidecar!.outline : []

  // v1.3.4 — every chapter timestamp is pushed later by whatever plays before
  // the narration, so an unmeasurable lead-in makes every chapter early by the
  // intro's length. That used to be swallowed into a silent 0; it is a warning
  // now, because a viewer clicking chapter three and landing mid-sentence is
  // exactly as wrong as a caption that fires early.
  let leadIn = 0
  if (timedSections.length) {
    const measured = await resolveEpisodeIntroLeadIn(
      paths.episode_dir,
      paths.merged_audio_dir,
      episodeId,
    )
    leadIn = measured.seconds
    if (measured.status === 'unmeasurable') {
      warnings.push(
        `Chapter timestamps assume nothing plays before the narration — ${measured.reason} `
        + 'If this episode opens with an intro, every chapter mark is early by its length.',
      )
    }
  }

  const chapters = buildYouTubeChapters({
    sections: timedSections,
    outline,
    gapSec,
    leadInSec: leadIn,
  })
  if (chapters.length > 0 && chapters.length < 3) {
    warnings.push('Fewer than three timed sections are available, so YouTube may not render clickable chapters.')
  }

  const subtitle = await inspectSubtitleCompletion(
    paths.episode_dir,
    paths.subtitles_dir,
    episodeId,
  ).catch(() => ({
    complete: false,
    mode: 'none' as const,
    expected_sections: [],
    completed_sections: [],
    missing_sections: [],
  }))
  if (!subtitle.complete) {
    const missing = subtitle.missing_sections.length
      ? ` Missing: ${subtitle.missing_sections.join(', ')}.`
      : ''
    warnings.push(`Subtitle coverage is incomplete, so chapter timing could not be cross-checked.${missing}`)
  }

  const sources = includeSources
    ? await readSelectedResearchSources(slug, episodeId)
    : []
  let description = refreshManagedBlock(
    options.description,
    CHAPTERS_BEGIN,
    CHAPTERS_END,
    renderChapters(chapters),
  )
  description = refreshManagedBlock(
    description,
    SOURCES_BEGIN,
    SOURCES_END,
    renderSources(sources),
  )

  return {
    description,
    audio_assembly_ready: audioReadiness.audio_assembly_ready,
    subtitle_complete: subtitle.complete,
    subtitle_mode: subtitle.mode,
    subtitle_missing_sections: subtitle.missing_sections,
    outline_title_count: outline.filter(item => item?.title?.trim()).length,
    chapter_count: chapters.length,
    source_count: sources.length,
    lead_in_seconds: leadIn,
    warnings,
    chapters: chapters.map(chapter => ({ title: chapter.title, start_sec: chapter.start_sec })),
    sources,
    finalized_at: new Date().toISOString(),
  }
}

export async function inspectYouTubeFinalizationStatus(
  slug: string,
  episodeId: string,
): Promise<YouTubeFinalizationStatus> {
  const result = await finalizeYouTubeDescription({
    slug,
    episodeId,
    description: '',
    includeSources: true,
  })
  return {
    audio_assembly_ready: result.audio_assembly_ready,
    subtitle_complete: result.subtitle_complete,
    subtitle_mode: result.subtitle_mode,
    subtitle_missing_sections: result.subtitle_missing_sections,
    outline_title_count: result.outline_title_count,
    chapter_count: result.chapter_count,
    source_count: result.source_count,
    lead_in_seconds: result.lead_in_seconds,
    warnings: result.warnings,
    ...(result.music_episode ? { music_episode: result.music_episode } : {}),
  }
}
