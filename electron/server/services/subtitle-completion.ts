import fs from 'fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'crypto'
import path from 'path'
import { readSelectedSubtitle } from '../lib/subtitle-selection.js'
import { parseSrt } from '../lib/subtitle-builder.js'
import { readStitchPlan } from './subtitle-stitcher.js'
import { allowedSubtitleCueGapSec } from './scene-plan-pacing.js'
import { readSubtitleSourceAudioHashes } from './subtitle-recovery.js'

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

export interface PipelineSubtitleRepairReadiness {
  expected_sections: string[]
  completed_sections: string[]
  affected_sections: string[]
}

const BURNABLE = /\.(srt|ass|vtt)$/i

interface AudioChapterManifest {
  sections?: Array<{ slug?: unknown; source_file?: unknown; source_files?: unknown }>
}

export interface SubtitleSourceFreshness {
  stale_sections: string[]
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

/**
 * Stable local source identity for one active chapter. This deliberately hashes
 * source bytes rather than duration or mtime: a same-length replacement still
 * needs a new transcript. Multi-part chapters retain their source-file order.
 */
export async function hashSubtitleAudioSources(sourceFiles: string[]): Promise<string | null> {
  if (!sourceFiles.length) return null
  // Bound memory while keeping the exact byte-based identity. Reading all
  // chapter parts at once held entire audio files in RAM and hashed them in
  // one synchronous turn during ordinary status refreshes.
  const parts: string[] = []
  for (const file of sourceFiles) {
    try {
      const hash = createHash('sha256')
      // Match the existing upload hasher's 4 MiB reads: bounded buffers
      // without a separate event-loop turn for every 64 KiB of long audio.
      for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk)
      parts.push(hash.digest('hex'))
    } catch {
      return null
    }
  }
  return `sha256:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`
}

function audioFilesForSection(
  section: { slug?: unknown; source_file?: unknown; source_files?: unknown },
  audioDir: string,
  code: string,
): string[] {
  const listed = Array.isArray(section.source_files)
    ? section.source_files.filter((file): file is string => typeof file === 'string' && path.basename(file) === file)
    : []
  const source = typeof section.source_file === 'string' && path.basename(section.source_file) === section.source_file
    ? section.source_file
    : ''
  const files = listed.length ? listed : source ? [source] : [
    `${code}_${String(section.slug || '').trim()}.mp3`,
  ]
  return files.map(file => path.join(audioDir, file))
}

/**
 * Compare each active chapter audio source with the hash recorded only after
 * its SRT was successfully saved. Legacy SRTs use mtime solely as a migration
 * fallback: an audio write newer than its SRT is stale, while an imported
 * whole-track never enters this per-section check.
 */
export async function inspectSubtitleSourceFreshness(
  episodeDir: string,
  audioDir: string,
  subtitlesDir: string,
  episodeCode: string,
): Promise<SubtitleSourceFreshness> {
  let sidecar: AudioChapterManifest
  try {
    sidecar = JSON.parse(await fs.readFile(path.join(episodeDir, 'audio_chapters.json'), 'utf8')) as AudioChapterManifest
  } catch {
    return { stale_sections: [] }
  }
  const sections = Array.isArray(sidecar.sections) ? sidecar.sections : []
  const expected = sections
    .map(section => typeof section.slug === 'string' ? section.slug.trim() : '')
    .filter(Boolean)
  if (!expected.length) return { stale_sections: [] }

  const [files, recorded] = await Promise.all([
    nonEmptySubtitleFiles(subtitlesDir),
    readSubtitleSourceAudioHashes(subtitlesDir),
  ])
  const sourceSrt = new Map<string, string>()
  for (const filename of files) {
    const section = sectionForFile(filename, episodeCode.toUpperCase(), expected)
    if (section && !/_stitched\./i.test(filename)) sourceSrt.set(normalize(section), filename)
  }

  const stale: string[] = []
  for (const section of sections) {
    const slug = typeof section.slug === 'string' ? section.slug.trim() : ''
    if (!slug) continue
    const srt = sourceSrt.get(normalize(slug))
    if (!srt) continue // An intentional whole-track has no per-section source to stale.
    const audioFiles = audioFilesForSection(section, audioDir, episodeCode.toUpperCase())
    const savedHash = recorded[srt]
    if (savedHash) {
      const currentHash = await hashSubtitleAudioSources(audioFiles)
      // v1.4.193 — `hashSubtitleAudioSources` answers `null` for "I could not
      // read the audio" (a missing or unreadable file). The old test
      // `currentHash && savedHash !== currentHash` folded that together with
      // "the bytes are unchanged", so an episode whose narration had been
      // deleted was reported as *current* and its transcript was kept. Not
      // being able to measure the audio is not evidence that the audio matches.
      if (!currentHash || savedHash !== currentHash) stale.push(slug)
      continue
    }
    // Older SRTs have no byte identity. Do not call all old work stale; only
    // expose the real replacement shape where the active audio is newer.
    const [srtStat, audioStats] = await Promise.all([
      fs.stat(path.join(subtitlesDir, srt)).catch(() => null),
      Promise.all(audioFiles.map(file => fs.stat(file).catch(() => null))),
    ])
    // v1.4.193 — same conflation through `stat?.mtimeMs || 0`: a missing audio
    // file produced mtime 0, which is never newer than the SRT, so the section
    // read as fresh. An absent file is the strongest possible "this changed".
    if (!srtStat || audioStats.some(stat => !stat)) {
      stale.push(slug)
      continue
    }
    const newestAudio = Math.max(...audioStats.map(stat => stat!.mtimeMs))
    if (newestAudio > srtStat.mtimeMs) stale.push(slug)
  }
  return { stale_sections: stale }
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

/** A replacement must close the same cue-gap contract that blocks Scene Plan. */
export function isPipelineRepairTranscriptUsable(raw: string): boolean {
  const cues = parseSrt(raw).filter(cue => cue.text.trim() && cue.end_sec > cue.start_sec)
  if (!cues.length) return false
  const maxGap = allowedSubtitleCueGapSec()
  return cues.every((cue, index) => index === 0 || cue.start_sec - cues[index - 1]!.end_sec <= maxGap)
}

/**
 * Pipeline repair is intentionally narrower than ordinary subtitle presence:
 * it names only source sections with no usable cues or an internal pacing gap.
 * Boundary gaps are assessed after a local restitch, never inferred from a
 * stale stitched timeline as authority to transcribe source chapters again.
 */
export async function inspectPipelineSubtitleRepairReadiness(
  episodeDir: string,
  subtitlesDir: string,
  episodeCode: string,
): Promise<PipelineSubtitleRepairReadiness> {
  const stitch = await readStitchPlan(episodeDir, subtitlesDir, episodeCode)
  if (!stitch.ok) return { expected_sections: [], completed_sections: [], affected_sections: [] }
  const expected = stitch.sections.map(section => section.slug)
  const unusable = new Set<string>()
  await Promise.all(stitch.matched.map(async section => {
    const raw = section.source_srt
      ? await fs.readFile(path.join(subtitlesDir, section.source_srt), 'utf8').catch(() => '')
      : ''
    if (!isPipelineRepairTranscriptUsable(raw)) unusable.add(normalize(section.slug))
  }))

  const affected = expected.filter(section => unusable.has(normalize(section)))
  const affectedSet = new Set(affected.map(normalize))
  return {
    expected_sections: expected,
    completed_sections: expected.filter(section => !affectedSet.has(normalize(section))),
    affected_sections: affected,
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
  if (options.require_per_section) {
    const strict = await inspectPipelineSubtitleRepairReadiness(episodeDir, subtitlesDir, code)
    const completed = strict.completed_sections
    const missing = strict.affected_sections
    return {
      complete: strict.expected_sections.length > 0 && missing.length === 0,
      mode: completed.length ? 'per-section' : 'none',
      expected_sections: strict.expected_sections,
      completed_sections: completed,
      missing_sections: missing,
    }
  }
  const [expected, files, pinned] = await Promise.all([
    readExpectedSections(episodeDir),
    nonEmptySubtitleFiles(subtitlesDir),
    readSelectedSubtitle(subtitlesDir),
  ])

  const sectionByFile = new Map(files.map(filename => [filename, sectionForFile(filename, code, expected)]))
  const fullTrackPattern = new RegExp(`^${escapeRegExp(code)}(?:_(?:imported|whisper|chapters))?\\.(?:srt|ass|vtt)$`, 'i')
  let fullTrack = files.find(filename => fullTrackPattern.test(filename))

  // A custom pinned file is an explicit whole-track choice unless its name
  // maps to one expected chapter. This preserves hand-imported legacy tracks.
  if (!fullTrack && pinned && files.includes(pinned) && !sectionByFile.get(pinned) && !/_stitched\./i.test(pinned)) {
    fullTrack = pinned
  }

  const stitchedCovered = new Set<string>()
  if (!fullTrack) {
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
