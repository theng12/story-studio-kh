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
import { computeEpisodeIntroLeadInSec } from '../lib/intro-lead-in.js'
import { readSelectedResearchSources, type SelectedResearchSource } from '../lib/research-sources.js'
import { chaptersFromDurations, formatChapterTimestamps, type Chapter } from '../lib/subtitle-builder.js'
import { inspectAudioAssemblyReadiness } from './audio-workflow-readiness.js'
import { resolveEpisodePathsByCode } from './utils.js'
import { inspectSubtitleCompletion } from './subtitle-completion.js'

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

  let leadIn = 0
  if (timedSections.length) {
    leadIn = await computeEpisodeIntroLeadInSec(
      paths.episode_dir,
      paths.merged_audio_dir,
      episodeId,
    ).catch(() => 0)
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
  }
}
