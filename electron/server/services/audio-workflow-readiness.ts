import fs from 'fs/promises'
import path from 'path'
import { getAudioDuration } from '../lib/ffmpeg-utils.js'
import { getAudioStatus } from './audio-reconciler.js'
import { inspectAudioMergeAtPaths } from './asset-status.js'
import { resolveEpisodePathsByCodeWithSidecar } from './utils.js'
import { INTRODUCTION_SEGMENT_ID, SEGMENT_KINDS } from '../lib/episode-segments.js'

export interface ChapterAudioReadiness {
  ready: boolean
  expected_files: string[]
  present_files: string[]
  missing_files: string[]
  issues: string[]
}

export interface AudioAssemblyReadiness extends ChapterAudioReadiness {
  audio_assembly_ready: boolean
  merged_audio_ready: boolean
  timeline_manifest_ready: boolean
  expected_sections: string[]
  timeline_sections: string[]
  missing_timeline_sections: string[]
  merged_audio_path: string | null
}

export { isScopedChapterTranscription } from '../contracts/subtitle-gaps.js'

interface AudioChaptersManifest {
  sections?: Array<{ slug?: unknown; duration_s?: unknown }>
}

export interface AudioTimelineManifestEvaluation {
  expected_sections: string[]
  timeline_sections: string[]
  missing_timeline_sections: string[]
  ready: boolean
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values))
}

export function chapterKeyOf(filename: string, code: string): string {
  let base = filename.replace(/\.[^.]+$/, '')
  if (base.toUpperCase().startsWith(`${code.toUpperCase()}_`)) {
    base = base.slice(code.length + 1)
  }
  base = base.replace(/_normalized$/i, '')
  while (/(?:_part\d+|_v\d+)$/i.test(base)) {
    base = base.replace(/(?:_part\d+|_v\d+)$/i, '')
  }
  return base
}

/**
 * 1.4.280 — an episode assembled without an Introduction. Brain Wise EP0036-EP0050 were narrated and
 * merged before the channel had one; a later intro script made every chapter check demand
 * `Introduction.mp3`, so Subtitles stopped. The Introduction is optional, and Audio Assembly's active
 * selection (`audio_chapters.json`) is what the episode IS: when it lists sections and none is the
 * Introduction, the Introduction is not part of this episode. An intro file on disk that was never
 * activated is not pulled in, and none is added.
 */
export function timelineOmitsIntroduction(manifest: AudioChaptersManifest | null | undefined): boolean {
  const sections = Array.isArray(manifest?.sections) ? manifest!.sections : []
  return sections.length > 0 && !sections.some(section =>
    typeof section?.slug === 'string' && section.slug.trim().toLowerCase() === INTRODUCTION_SLUG)
}

const INTRODUCTION_SLUG = SEGMENT_KINDS[INTRODUCTION_SEGMENT_ID]!.filenameStem.toLowerCase()

function withoutIntroduction(readiness: ChapterAudioReadiness, code: string): ChapterAudioReadiness {
  const keep = (file: string) => chapterKeyOf(file, code).toLowerCase() !== INTRODUCTION_SLUG
  const expected = readiness.expected_files.filter(keep)
  const missing = readiness.missing_files.filter(keep)
  if (expected.length === readiness.expected_files.length) return readiness
  return {
    ready: expected.length > 0 && missing.length === 0,
    expected_files: expected,
    present_files: readiness.present_files.filter(keep),
    missing_files: missing,
    issues: !expected.length
      ? ['No required narration sections could be found. Finish the Script step first.']
      : missing.length
        ? [`${missing.length} required audio file(s) are missing: ${missing.join(', ')}. Generate or repair Audio before running Audio Assembly.`]
        : [],
  }
}

export function evaluateAudioTimelineManifest(
  expectedFiles: string[],
  code: string,
  manifest: AudioChaptersManifest,
): AudioTimelineManifestEvaluation {
  const expectedSections = unique(expectedFiles.map(filename => chapterKeyOf(filename, code)))
  const sections = Array.isArray(manifest.sections) ? manifest.sections : []
  const timelineSections = unique(sections
    .filter(section =>
      typeof section?.slug === 'string'
      && section.slug.trim().length > 0
      && Number(section.duration_s) > 0,
    )
    .map(section => String(section.slug).trim()))
  const normalizedTimeline = new Set(timelineSections.map(section => section.toLowerCase()))
  const missingTimelineSections = expectedSections.filter(
    section => !normalizedTimeline.has(section.toLowerCase()),
  )
  return {
    expected_sections: expectedSections,
    timeline_sections: timelineSections,
    missing_timeline_sections: missingTimelineSections,
    ready: expectedSections.length > 0
      && timelineSections.length > 0
      && missingTimelineSections.length === 0,
  }
}

export async function inspectChapterAudioReadiness(
  slug: string,
  episodeId: string,
): Promise<ChapterAudioReadiness> {
  try {
    const status = await getAudioStatus(slug, episodeId)
    const expected = status.expected.map(item => item.filename)
    const missing = status.missing
    const issues: string[] = []
    if (!expected.length) {
      issues.push('No required narration sections could be found. Finish the Script step first.')
    } else if (missing.length) {
      issues.push(
        `${missing.length} required audio file(s) are missing: ${missing.join(', ')}. ` +
        'Generate or repair Audio before running Audio Assembly.',
      )
    }
    return {
      ready: expected.length > 0 && missing.length === 0,
      expected_files: expected,
      present_files: status.present,
      missing_files: missing,
      issues,
    }
  } catch (error: any) {
    return {
      ready: false,
      expected_files: [],
      present_files: [],
      missing_files: [],
      issues: [error?.message || 'Chapter audio coverage could not be verified.'],
    }
  }
}

export async function inspectAudioAssemblyReadiness(
  slug: string,
  episodeId: string,
): Promise<AudioAssemblyReadiness> {
  const code = episodeId.toUpperCase()
  let chapterAudio = await inspectChapterAudioReadiness(slug, code)
  const paths = await resolveEpisodePathsByCodeWithSidecar(slug, code, 'audio_chapters.json').catch(() => null)
  const manifest = paths
    ? await fs.readFile(path.join(paths.episode_dir, 'audio_chapters.json'), 'utf-8')
      .then(raw => JSON.parse(raw) as AudioChaptersManifest).catch(() => null)
    : null
  if (timelineOmitsIntroduction(manifest)) chapterAudio = withoutIntroduction(chapterAudio, code)
  const issues = [...chapterAudio.issues]
  let expectedSections = unique(chapterAudio.expected_files.map(filename => chapterKeyOf(filename, code)))

  let mergedAudioReady = false
  let mergedAudioPath: string | null = null
  let timelineManifestReady = false
  let timelineSections: string[] = []
  let missingTimelineSections = [...expectedSections]

  try {
    if (!paths) throw new Error('episode paths unavailable')
    const merge = await inspectAudioMergeAtPaths(paths, code)
    const duration = merge.present && merge.path
      ? await getAudioDuration(merge.path).catch(() => undefined)
      : undefined
    mergedAudioReady = Number.isFinite(duration) && Number(duration) > 0
    mergedAudioPath = mergedAudioReady ? merge.path! : null
    if (!mergedAudioReady) {
      issues.push('This episode has no playable merged narration yet. Run Audio Assembly first.')
    }

    if (!manifest) throw new Error('audio_chapters.json unavailable')
    const evaluation = evaluateAudioTimelineManifest(chapterAudio.expected_files, code, manifest)
    expectedSections = evaluation.expected_sections
    timelineSections = evaluation.timeline_sections
    missingTimelineSections = evaluation.missing_timeline_sections
    timelineManifestReady = evaluation.ready
    if (!timelineManifestReady) {
      const detail = missingTimelineSections.length
        ? ` Missing timeline section(s): ${missingTimelineSections.join(', ')}.`
        : ''
      issues.push(`Audio Assembly's record of where each chapter starts is missing or incomplete — run Audio Assembly again.${detail}`)
    }
  } catch {
    // With no merge at all, the missing chapter-timing record is the same problem said twice.
    if (!mergedAudioReady) {
      if (!issues.some(issue => issue.includes('merged narration'))) issues.push('This episode has no playable merged narration yet. Run Audio Assembly first.')
    } else if (!issues.some(issue => issue.includes('where each chapter starts'))) {
      issues.push('Audio Assembly has not saved where each chapter starts — run Audio Assembly again.')
    }
  }

  return {
    ...chapterAudio,
    audio_assembly_ready: chapterAudio.ready && mergedAudioReady && timelineManifestReady,
    merged_audio_ready: mergedAudioReady,
    timeline_manifest_ready: timelineManifestReady,
    expected_sections: expectedSections,
    timeline_sections: timelineSections,
    missing_timeline_sections: missingTimelineSections,
    merged_audio_path: mergedAudioPath,
    issues: unique(issues),
  }
}

export async function requireChapterAudioReady(
  slug: string,
  episodeId: string,
): Promise<ChapterAudioReadiness> {
  const readiness = await inspectChapterAudioReadiness(slug, episodeId)
  if (!readiness.ready) {
    throw new Error(`Audio Assembly is blocked: ${readiness.issues.join(' ')}`)
  }
  return readiness
}

export async function requireAudioAssemblyReady(
  slug: string,
  episodeId: string,
): Promise<AudioAssemblyReadiness> {
  const readiness = await inspectAudioAssemblyReadiness(slug, episodeId)
  if (!readiness.audio_assembly_ready) {
    throw new Error(
      `Transcription is blocked until Audio Assembly is complete. ${readiness.issues.join(' ')} ` +
      'Existing subtitle files are preserved.',
    )
  }
  return readiness
}
