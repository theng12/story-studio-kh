import fs from 'fs/promises'
import path from 'path'
import { parseNarrationDocx } from '../lib/docx-parser.js'
import { parseSrt } from '../lib/subtitle-builder.js'
import { normalizeForTts } from '../lib/tts-text.js'
import { hashInput } from './task-manifest.js'
import { ensureCorrectedTranscript, type ChapterCorrectionReport } from './subtitle-correction.js'
import { hashSubtitleAudioSources, inspectSubtitleCompletion, inspectSubtitleSourceFreshness } from './subtitle-completion.js'
import {
  readAudioQualityProvenance,
  type AudioQualityChapterProvenance,
  type AudioQualityEvidenceState,
  type AudioQualityProvenanceState,
} from './audio-quality-store.js'

export interface ChapterAudioQuality {
  slug: string
  state: AudioQualityEvidenceState
  provenance: AudioQualityProvenanceState
  transcript_fresh: boolean
  reason_code: string
  /** Present for Review needed rows, from the current raw evidence only. */
  inspected_at?: string
  reason?: string
  review?: { scope?: 'chapter'; start_sec?: number; end_sec?: number; excerpt?: string; script_excerpt?: string }
  receipt?: { model_id?: string; voice_id?: string; provider_name?: string }
}

export interface ChapterAudioQualityReport {
  chapters: ChapterAudioQuality[]
}

/** Exact local facts a later confirmed candidate must still match. */
export interface AudioQualityActionScope {
  sections: string[]
  scope_fingerprint: string
  source_fingerprint: string
  script_fingerprint: string
  source_audio_hashes: Record<string, string>
  source_files: Record<string, string[]>
  quality: ChapterAudioQuality[]
}

export interface InspectChapterAudioQualityInput {
  episodeDir: string
  audioDir: string
  subtitlesDir: string
  scriptDir: string
  episodeCode: string
}

interface AudioChapter {
  slug: string
  source_files: string[]
}

function normalizeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

async function activeChapters(episodeDir: string): Promise<AudioChapter[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(episodeDir, 'audio_chapters.json'), 'utf8')) as {
      sections?: Array<{ slug?: unknown; source_file?: unknown; source_files?: unknown }>
    }
    return (parsed.sections || []).flatMap(section => {
      const slug = typeof section.slug === 'string' ? section.slug.trim() : ''
      const listed = Array.isArray(section.source_files)
        ? section.source_files.filter((file): file is string => typeof file === 'string' && path.basename(file) === file && !!file.trim())
        : []
      const source = typeof section.source_file === 'string' && path.basename(section.source_file) === section.source_file
        ? section.source_file : ''
      return slug && (listed.length || source) ? [{ slug, source_files: listed.length ? listed : [source] }] : []
    })
  } catch {
    return []
  }
}

/**
 * The durable fingerprint of one chapter's script.
 *
 * X-01. The freshness check compares a value recorded at generation time with
 * one recomputed from the script file later, so BOTH sides must describe the
 * SCRIPT ON DISK and nothing else. The generator used to record
 * `hashInput(section.text)` AFTER it had transformed that text in memory for
 * the run (expression and pause tags, since removed), so such a run learned at
 * quality-check time that "the script changed" when the customer had changed nothing.
 *
 * The recomputation trims before normalizing (`currentScript()` returns a
 * trimmed string), so this does too: the two must be byte-identical inputs.
 */
export function chapterScriptFingerprint(rawSectionText: string): string {
  return hashInput(normalizeForTts(rawSectionText.trim()).text)
}

async function currentScriptHash(scriptDir: string, episodeCode: string, slug: string): Promise<string | null> {
  return currentChapterScriptHash(scriptDir, episodeCode, slug)
}

/** Shared with the local post-promotion refresh before it records active provenance. */
export async function currentChapterScriptHash(scriptDir: string, episodeCode: string, slug: string): Promise<string | null> {
  const current = await currentScript(scriptDir, episodeCode, slug)
  return current ? chapterScriptFingerprint(current) : null
}

async function currentScript(scriptDir: string, episodeCode: string, slug: string): Promise<string | null> {
  const code = episodeCode.toUpperCase()
  const entries = await fs.readdir(scriptDir).catch(() => [] as string[])
  const exact = entries.find(file => file.toLowerCase() === `${code}_${slug}.md`.toLowerCase()
    || file.toLowerCase() === `${code}_${slug}.docx`.toLowerCase())
  const unified = entries.find(file => /^.+_script_narration\.(md|docx)$/i.test(file)
    && file.toLowerCase().startsWith(`${code}_script_narration.`.toLowerCase()))
  for (const file of [exact, unified]) {
    if (!file) continue
    try {
      const sections = await parseNarrationDocx(path.join(scriptDir, file))
      const section = sections.find(value => normalizeSlug(value.slug) === normalizeSlug(slug))
        || (exact ? sections[0] : undefined)
      if (section?.text.trim()) return section.text.trim()
    } catch { /* Missing or unreadable script is review-needed evidence. */ }
  }
  return null
}

async function currentRawEvidence(subtitlesDir: string, episodeCode: string, slug: string): Promise<{ scope?: 'chapter'; start_sec?: number; end_sec?: number; excerpt?: string }> {
  try {
    const raw = await fs.readFile(path.join(subtitlesDir, `${episodeCode.toUpperCase()}_${slug}.srt`), 'utf8')
    const cues = parseSrt(raw).filter(cue => cue.text.trim())
    if (!cues.length) return {}
    return {
      scope: 'chapter',
      start_sec: cues[0]!.start_sec,
      end_sec: cues.at(-1)!.end_sec,
      excerpt: cues.map(cue => cue.text.trim()).join(' ').slice(0, 280),
    }
  } catch {
    return {}
  }
}

function reviewRow(
  slug: string,
  provenance: AudioQualityProvenanceState,
  transcriptFresh: boolean,
  reasonCode: string,
  reason: string,
  review: Awaited<ReturnType<typeof currentRawEvidence>>,
  scriptExcerpt: string | undefined,
  saved: AudioQualityChapterProvenance | undefined,
): ChapterAudioQuality {
  return {
    ...row(slug, 'review_needed', provenance, transcriptFresh, reasonCode),
    inspected_at: new Date().toISOString(),
    reason,
    ...(Object.keys(review).length || scriptExcerpt ? { review: { ...review, ...(scriptExcerpt ? { script_excerpt: scriptExcerpt } : {}) } } : {}),
    ...(saved?.tts ? { receipt: {
      ...(saved.tts.model_id ? { model_id: saved.tts.model_id } : {}),
      ...(saved.tts.voice_id ? { voice_id: saved.tts.voice_id } : {}),
      ...(saved.tts.provider ? { provider_name: saved.tts.provider } : {}),
    } } : {}),
  }
}

function row(
  slug: string,
  state: AudioQualityEvidenceState,
  provenance: AudioQualityProvenanceState,
  transcript_fresh: boolean,
  reason_code: string,
): ChapterAudioQuality {
  return { slug, state, provenance, transcript_fresh, reason_code }
}

/**
 * Local-only chapter evidence. It reads the raw SRT through the correction
 * report; the corrected SRT is never evidence because it may contain words
 * rewritten from the current script.
 */
export async function inspectChapterAudioQuality(input: InspectChapterAudioQualityInput): Promise<ChapterAudioQualityReport> {
  const code = input.episodeCode.toUpperCase()
  const [chapters, provenance, freshness, completion] = await Promise.all([
    activeChapters(input.episodeDir),
    readAudioQualityProvenance(input.episodeDir),
    inspectSubtitleSourceFreshness(input.episodeDir, input.audioDir, input.subtitlesDir, code, input.scriptDir),
    inspectSubtitleCompletion(input.episodeDir, input.subtitlesDir, code, { require_per_section: true }),
  ])
  const stale = new Set(freshness.stale_sections.map(normalizeSlug))
  const completed = new Set(completion.completed_sections.map(normalizeSlug))
  const reports = new Map<string, ChapterCorrectionReport>()

  const result: ChapterAudioQuality[] = []
  for (const chapter of chapters) {
    const key = normalizeSlug(chapter.slug)
    const saved = provenance.chapters[chapter.slug]
    const transcriptFresh = completed.has(key) && !stale.has(key)
    if (!saved) {
      // Missing historical receipts are not detector evidence. Keep the row
      // neutral and let an explicitly confirmed repair remain available.
      result.push(row(chapter.slug, 'not_checked', 'legacy', transcriptFresh, 'provenance_missing'))
      continue
    }
    if (!transcriptFresh) {
      result.push(row(chapter.slug, 'not_checked', 'known', false,
        completed.has(key) ? 'subtitle_stale' : 'subtitle_missing'))
      continue
    }
    const activeHash = await hashSubtitleAudioSources(chapter.source_files.map(file => path.join(input.audioDir, file)))
    if (!activeHash || activeHash !== saved.source_audio_hash) {
      result.push(row(chapter.slug, 'not_checked', 'known', false, 'active_source_changed'))
      continue
    }
    const scriptHash = await currentScriptHash(input.scriptDir, code, chapter.slug)
    if (!scriptHash || scriptHash !== saved.normalized_script_hash) {
      result.push(row(chapter.slug, 'not_checked', 'script_changed', true, 'script_changed'))
      continue
    }
    if (!reports.size) {
      const correction = await ensureCorrectedTranscript({
        subtitles_dir: input.subtitlesDir, script_dir: input.scriptDir, episode_code: code,
      })
      for (const report of correction?.chapters || []) reports.set(normalizeSlug(report.slug), report)
    }
    const correction = reports.get(key)
    if (!correction?.accepted) {
      const [review, script] = await Promise.all([
        currentRawEvidence(input.subtitlesDir, code, chapter.slug),
        currentScript(input.scriptDir, code, chapter.slug),
      ])
      result.push(reviewRow(
        chapter.slug,
        'known',
        true,
        correction?.reason_code || 'raw_alignment_inconclusive',
        correction?.reason || 'The raw transcript could not be aligned confidently with the saved script.',
        review,
        script?.slice(0, 280),
        saved,
      ))
      continue
    }
    result.push(row(chapter.slug, 'no_issue_detected', 'known', true, 'fresh_alignment_accepted'))
  }
  return { chapters: result }
}

/**
 * Canonicalize a deliberate chapter selection and fingerprint the active
 * sources it names. This never reads a candidate or starts provider work.
 * The same source fingerprint is rechecked at confirmation and promotion, so
 * a changed script or selected-audio map cannot silently widen an old action.
 */
export async function inspectAudioQualityActionScope(
  input: InspectChapterAudioQualityInput,
  requestedSections: string[],
): Promise<AudioQualityActionScope> {
  const requested = [...new Set(requestedSections
    .filter(value => typeof value === 'string')
    .map(value => value.trim())
    .filter(Boolean))]
  if (!requested.length) throw new Error('Select one or more generated audio chapters to check.')

  const chapters = await activeChapters(input.episodeDir)
  const byNormalizedSlug = new Map(chapters.map(chapter => [normalizeSlug(chapter.slug), chapter]))
  const selected = requested.map(section => byNormalizedSlug.get(normalizeSlug(section))).filter((chapter): chapter is AudioChapter => !!chapter)
  if (selected.length !== requested.length) {
    const available = chapters.map(chapter => chapter.slug).join(', ') || '(none)'
    throw new Error(`One or more selected chapters have no active audio. Available: ${available}.`)
  }
  const canonical = [...new Map(selected.map(chapter => [normalizeSlug(chapter.slug), chapter.slug])).values()]
    .sort((left, right) => left.localeCompare(right))
  const provenance = await readAudioQualityProvenance(input.episodeDir)
  const source_audio_hashes: Record<string, string> = {}
  const source_files: Record<string, string[]> = {}
  const sourceFacts: Array<Record<string, string | null>> = []
  const scriptFacts: Array<Record<string, string | null>> = []
  for (const slug of canonical) {
    const chapter = byNormalizedSlug.get(normalizeSlug(slug))!
    const audioHash = await hashSubtitleAudioSources(chapter.source_files.map(file => path.join(input.audioDir, file)))
    if (!audioHash) throw new Error(`Could not fingerprint active audio for ${slug}; no repair was started.`)
    source_audio_hashes[slug] = audioHash
    source_files[slug] = [...chapter.source_files]
    const currentScriptDigest = await currentScriptHash(input.scriptDir, input.episodeCode, slug)
    sourceFacts.push({
      slug,
      active_audio_hash: audioHash,
      saved_audio_hash: provenance.chapters[slug]?.source_audio_hash || null,
      current_script_hash: currentScriptDigest,
      saved_script_hash: provenance.chapters[slug]?.normalized_script_hash || null,
    })
    scriptFacts.push({ slug, current_script_hash: currentScriptDigest })
  }
  const report = await inspectChapterAudioQuality(input)
  const selectedQuality = canonical.map(slug => report.chapters.find(row => normalizeSlug(row.slug) === normalizeSlug(slug))
    || row(slug, 'review_needed', 'legacy', false, 'provenance_missing'))
  return {
    sections: canonical,
    scope_fingerprint: hashInput(JSON.stringify({ episode_code: input.episodeCode.toUpperCase(), sections: canonical })),
    source_fingerprint: hashInput(JSON.stringify({
      episode_code: input.episodeCode.toUpperCase(),
      sections: sourceFacts,
    })),
    script_fingerprint: hashInput(JSON.stringify({ episode_code: input.episodeCode.toUpperCase(), sections: scriptFacts })),
    source_audio_hashes,
    source_files,
    quality: selectedQuality,
  }
}
