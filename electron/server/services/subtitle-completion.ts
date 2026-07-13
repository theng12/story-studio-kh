import fs from 'fs/promises'
import path from 'path'
import { readSelectedSubtitle } from '../lib/subtitle-selection.js'

export interface SubtitleCompletion {
  complete: boolean
  mode: 'per-section' | 'full-track' | 'none'
  expected_sections: string[]
  completed_sections: string[]
  missing_sections: string[]
  full_track_filename?: string
}

export interface SubtitleCompletionOptions {
  /** Transcription jobs must produce one source SRT per expected audio section. */
  require_per_section?: boolean
}

const BURNABLE = /\.(srt|ass|vtt)$/i

interface AudioChapterManifest {
  sections?: Array<{ slug?: unknown }>
}

interface StitchedCompletionMeta {
  complete?: boolean
  missing_sections?: unknown[]
  sections?: Array<{ slug?: unknown; source_srt?: unknown; cues_added?: unknown }>
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/\d+/g, digits => String(Number(digits)))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sectionForFile(filename: string, episodeCode: string, expected: string[]): string | null {
  const codePrefix = new RegExp(`^${escapeRegExp(episodeCode)}[ _-]*`, 'i')
  const base = filename
    .replace(/\.(srt|ass|vtt)$/i, '')
    .replace(codePrefix, '')
    .replace(/[ _-]*whisper$/i, '')
  const candidate = normalize(base)
  return expected.find(section => normalize(section) === candidate) || null
}

async function nonEmptySubtitleFiles(subtitlesDir: string): Promise<string[]> {
  const entries = await fs.readdir(subtitlesDir).catch(() => [] as string[])
  const candidates = entries.filter(filename => BURNABLE.test(filename) && !filename.startsWith('.tmp_'))
  const stats = await Promise.all(candidates.map(async filename => {
    try {
      const stat = await fs.stat(path.join(subtitlesDir, filename))
      return stat.isFile() && stat.size > 0 ? filename : null
    } catch {
      return null
    }
  }))
  return stats.filter((filename): filename is string => !!filename)
}

async function readExpectedSections(episodeDir: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(episodeDir, 'audio_chapters.json'), 'utf-8'),
    ) as AudioChapterManifest
    if (!Array.isArray(parsed?.sections)) return []
    return Array.from(new Set(
      parsed.sections
        .map(section => typeof section?.slug === 'string' ? section.slug.trim() : '')
        .filter(Boolean),
    )) as string[]
  } catch {
    return []
  }
}

async function stitchedCoverage(
  subtitlesDir: string,
  filename: string,
  expected: string[],
): Promise<{ complete: boolean; covered: Set<string> } | null> {
  try {
    const meta = JSON.parse(
      await fs.readFile(path.join(subtitlesDir, `${filename}.json`), 'utf-8'),
    ) as StitchedCompletionMeta
    if (!Array.isArray(meta?.sections) || !meta.sections.length) return null
    const covered = new Set<string>(
      meta.sections
        .filter(section => section?.source_srt && Number(section?.cues_added) > 0)
        .map(section => normalize(String(section.slug || ''))),
    )
    const metadataAllowsComplete = meta.complete !== false
      && !(Array.isArray(meta.missing_sections) && meta.missing_sections.length)
    const complete = metadataAllowsComplete && (expected.length
      ? expected.every(section => covered.has(normalize(section)))
      : covered.size === meta.sections.length)
    return { complete, covered }
  } catch {
    return null
  }
}

/**
 * A subtitle step is complete only when every audio section has a usable
 * transcript, or when an intentional whole-episode track exists. A partial
 * stitched file never hides missing chapter transcripts.
 */
export async function inspectSubtitleCompletion(
  episodeDir: string,
  subtitlesDir: string,
  episodeCode: string,
  options: SubtitleCompletionOptions = {},
): Promise<SubtitleCompletion> {
  const code = episodeCode.toUpperCase()
  const [expected, files, pinned] = await Promise.all([
    readExpectedSections(episodeDir),
    nonEmptySubtitleFiles(subtitlesDir),
    readSelectedSubtitle(subtitlesDir),
  ])

  const sectionByFile = new Map(files.map(filename => [filename, sectionForFile(filename, code, expected)]))
  const fullTrackPattern = new RegExp(`^${escapeRegExp(code)}(?:_(?:imported|whisper|chapters))?\\.(?:srt|ass|vtt)$`, 'i')
  let fullTrack = options.require_per_section
    ? undefined
    : files.find(filename => fullTrackPattern.test(filename))

  // A custom pinned file is an explicit whole-track choice unless its name
  // maps to one expected chapter. This preserves hand-imported legacy tracks.
  if (!options.require_per_section && !fullTrack && pinned && files.includes(pinned) && !sectionByFile.get(pinned) && !/_stitched\./i.test(pinned)) {
    fullTrack = pinned
  }

  const stitchedCovered = new Set<string>()
  if (!options.require_per_section && !fullTrack) {
    for (const filename of files.filter(name => /_stitched\.(srt|ass|vtt)$/i.test(name))) {
      const coverage = await stitchedCoverage(subtitlesDir, filename, expected)
      for (const section of coverage?.covered || []) stitchedCovered.add(section)
      if (coverage?.complete) {
        fullTrack = filename
        break
      }
    }
  }

  if (fullTrack) {
    return {
      complete: true,
      mode: 'full-track',
      expected_sections: expected,
      completed_sections: expected,
      missing_sections: [],
      full_track_filename: fullTrack,
    }
  }

  const completed = expected.filter(section =>
    stitchedCovered.has(normalize(section))
    || Array.from(sectionByFile.values()).some(found => found != null && normalize(found) === normalize(section)),
  )
  const completedSet = new Set(completed.map(normalize))
  const missing = expected.filter(section => !completedSet.has(normalize(section)))
  return {
    complete: expected.length > 0 && missing.length === 0,
    mode: completed.length ? 'per-section' : 'none',
    expected_sections: expected,
    completed_sections: completed,
    missing_sections: missing,
  }
}
