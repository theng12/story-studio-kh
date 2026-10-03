import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { findIncompleteSubtitleSections } from './subtitle-stitcher.js'
import { stitchedSrtPath } from './subtitle-correction.js'
import { parseSrt } from '../lib/subtitle-builder.js'
import { stampFromCues } from '../lib/scene-plan-timeline.js'
import { inspectSubtitleSourceFreshness } from './subtitle-completion.js'
import { MUSIC_EPISODE_FILENAME } from './music-episode.js'

export interface SubtitleTimelineIntegrity {
  complete: boolean
  missing_sections: string[]
  blocking_cue_gaps?: SubtitleCueGap[]
  max_cue_gap_sec?: number
}

export interface SubtitleCueGap {
  previous_end_sec: number
  next_start_sec: number
  gap_sec: number
  section_slugs: string[]
  section_local_start_sec?: number
  section_local_end_sec?: number
}

interface StitchSection {
  slug?: unknown
  offset_sec?: unknown
  duration_sec?: unknown
}

function sectionsForGap(sections: StitchSection[], start: number, end: number): string[] {
  return sections.filter(section => {
    const offset = Number(section.offset_sec)
    const duration = Number(section.duration_sec)
    return typeof section.slug === 'string' && section.slug.trim()
      && Number.isFinite(offset) && Number.isFinite(duration) && duration >= 0
      && end >= offset && start <= offset + duration
  }).map(section => String(section.slug))
}

function inspectCueGaps(
  cues: ReturnType<typeof parseSrt>,
  sections: StitchSection[],
  maxGap: number,
): SubtitleCueGap[] {
  const gaps: SubtitleCueGap[] = []
  for (let index = 1; index < cues.length; index++) {
    const previous = cues[index - 1]!
    const next = cues[index]!
    const gap = next.start_sec - previous.end_sec
    if (!(gap > maxGap)) continue
    const sectionSlugs = sectionsForGap(sections, previous.end_sec, next.start_sec)
    const one = sectionSlugs.length === 1
      ? sections.find(section => section.slug === sectionSlugs[0])
      : undefined
    const offset = Number(one?.offset_sec)
    gaps.push({
      previous_end_sec: previous.end_sec,
      next_start_sec: next.start_sec,
      gap_sec: gap,
      section_slugs: sectionSlugs,
      ...(Number.isFinite(offset) ? {
        section_local_start_sec: previous.end_sec - offset,
        section_local_end_sec: next.start_sec - offset,
      } : {}),
    })
  }
  return gaps
}

function writtenTimelineMatches(meta: any, cues: ReturnType<typeof parseSrt>): boolean {
  return meta?.complete === true
    && cues.length > 0
    && meta.total_cues === cues.length
    && meta.timeline?.sha256 === stampFromCues(cues).sha256
}

export async function readSubtitleTimelineIntegrity(
  subtitlesDir: string,
  episodeCode: string,
  options: { max_cue_gap_sec?: number; cue_source_path?: string } = {},
): Promise<SubtitleTimelineIntegrity> {
  // Deliberately the RAW stitch, not the corrected transcript: this checks
  // that every audio section produced subtitles at all. Correction happens
  // downstream of that guarantee and cannot substitute for it.
  const stitchedPath = stitchedSrtPath(subtitlesDir, episodeCode)
  const metaPath = `${stitchedPath}.json`
  if (!existsSync(stitchedPath)) {
    return { complete: false, missing_sections: ['stitched subtitle timeline'] }
  }
  if (!existsSync(metaPath)) {
    return { complete: false, missing_sections: ['subtitle timeline verification'] }
  }

  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
    const missing = Array.from(new Set([
      ...findIncompleteSubtitleSections(meta?.sections),
      ...(Array.isArray(meta?.missing_sections) ? meta.missing_sections : []),
    ]))
    if (meta?.complete === false && !missing.length) missing.push('subtitle timeline verification')
    const maxGap = Number(options.max_cue_gap_sec)
    if (!Number.isFinite(maxGap) || maxGap < 0) {
      return { complete: missing.length === 0, missing_sections: missing }
    }
    const rawCues = parseSrt(await fs.readFile(stitchedPath, 'utf-8'))
    if (!writtenTimelineMatches(meta, rawCues)) missing.push('subtitle timeline verification')
    const planningCues = options.cue_source_path && options.cue_source_path !== stitchedPath
      ? parseSrt(await fs.readFile(options.cue_source_path, 'utf-8'))
      : rawCues
    if (!planningCues.length) missing.push('planning transcript cues')
    const blocking_cue_gaps = inspectCueGaps(planningCues, Array.isArray(meta?.sections) ? meta.sections : [], maxGap)
    return {
      complete: missing.length === 0 && blocking_cue_gaps.length === 0,
      missing_sections: missing,
      blocking_cue_gaps,
      max_cue_gap_sec: maxGap,
    }
  } catch {
    return { complete: false, missing_sections: ['subtitle timeline verification'] }
  }
}

/**
 * Prove that the written stitch still matches the proof recorded beside it.
 * Coverage alone cannot catch a truncated or altered SRT whose sidecar remains.
 */
export async function verifyWrittenSubtitleTimeline(
  subtitlesDir: string,
  episodeCode: string,
): Promise<boolean> {
  if (!(await readSubtitleTimelineIntegrity(subtitlesDir, episodeCode)).complete) return false
  const stitchedPath = stitchedSrtPath(subtitlesDir, episodeCode)
  try {
    const meta = JSON.parse(await fs.readFile(`${stitchedPath}.json`, 'utf-8'))
    const cues = parseSrt(await fs.readFile(stitchedPath, 'utf-8'))
    return writtenTimelineMatches(meta, cues)
  } catch {
    return false
  }
}

export async function assertSubtitleTimelineComplete(
  subtitlesDir: string,
  episodeCode: string,
  source?: { episodeDir: string; audioDir: string },
): Promise<void> {
  // An Episode Builder (music) episode has no narration, so there is no subtitle
  // timeline to wait for; its scene times come from the stitched songs.
  if (source && existsSync(path.join(source.episodeDir, MUSIC_EPISODE_FILENAME))) return
  const integrity = await readSubtitleTimelineIntegrity(subtitlesDir, episodeCode)
  if (!integrity.complete) {
    throw new Error(
      `Subtitle timeline is incomplete: ${integrity.missing_sections.join(', ')}. `
      + 'Complete transcription and stitch subtitles again before generating scene images.',
    )
  }
  if (!source) return
  const freshness = await inspectSubtitleSourceFreshness(
    source.episodeDir,
    source.audioDir,
    subtitlesDir,
    episodeCode,
  )
  if (freshness.stale_sections.length) {
    throw new Error(
      `Subtitle timeline needs updating for ${freshness.stale_sections.join(', ')} because the active audio changed. `
      + 'Re-transcribe and stitch the listed chapter before generating downstream assets.',
    )
  }
}
