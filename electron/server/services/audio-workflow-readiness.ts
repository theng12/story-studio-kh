import fs from 'fs/promises'
import path from 'path'
import { getAudioDuration } from '../lib/ffmpeg-utils.js'
import { getAudioStatus } from './audio-reconciler.js'
import { inspectAudioMergeAtPaths } from './asset-status.js'
import { resolveEpisodePathsByCodeWithSidecar } from './utils.js'

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

function chapterKeyOf(filename: string, code: string): string {
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
  const chapterAudio = await inspectChapterAudioReadiness(slug, code)
  const issues = [...chapterAudio.issues]
  let expectedSections = unique(chapterAudio.expected_files.map(filename => chapterKeyOf(filename, code)))

  let mergedAudioReady = false
  let mergedAudioPath: string | null = null
  let timelineManifestReady = false
  let timelineSections: string[] = []
  let missingTimelineSections = [...expectedSections]

  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, code, 'audio_chapters.json')
    const merge = await inspectAudioMergeAtPaths(paths, code)
    const duration = merge.present && merge.path
      ? await getAudioDuration(merge.path).catch(() => undefined)
      : undefined
    mergedAudioReady = Number.isFinite(duration) && Number(duration) > 0
    mergedAudioPath = mergedAudioReady ? merge.path! : null
    if (!mergedAudioReady) {
      issues.push('This episode has no playable merged narration yet. Run Audio Assembly first.')
    }

    const manifest = JSON.parse(
      await fs.readFile(path.join(paths.episode_dir, 'audio_chapters.json'), 'utf-8'),
    ) as AudioChaptersManifest
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
