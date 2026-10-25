/**
 * The ONE rule that decides whether a chapter's narration is out of date.
 *
 * Between Audio narration and every reader of it, "is this audio still the audio
 * for this chapter?" was answered by comparing the chapter file's mtime with its
 * audio chunks' mtimes. That made a chapter's TEXT irrelevant: a re-import, an
 * eager migration, or any save that rewrote the file with the very same words
 * marked every chapter stale, and the owner re-narrated 12 chapters of MANU0002
 * (2026-10-25) whose text had not changed by a character.
 *
 * So the comparison is by CONTENT. When narration is activated, the fingerprint
 * of the exact text it was made from is recorded beside the episode; staleness is
 * the current chapter text fingerprint differing from that record.
 *
 *   recorded  + text differs   → stale   (content)
 *   recorded  + text identical → fresh   (content)
 *   no record + script newer   → stale   (legacy_mtime)   ← honest fallback
 *   no record + audio newer    → fresh   (legacy_mtime)
 *   nothing to read            → unknown (AGENTS.md §6: "not stale" and "cannot
 *                                tell" must never be the same answer)
 *
 * The fingerprint implementation is NOT redefined here: `chapterScriptFingerprint`
 * / `currentChapterScriptHash` (services/audio-quality.ts) are the single
 * implementation both sides use, which is exactly what X-01 (v1.4.216) fixed for
 * the audio-quality check. A second copy of that normalization would be the same
 * defect with a new name.
 *
 * The record is additive: an episode narrated before this shipped has no record,
 * keeps the old mtime answer, and is reported as `legacy_mtime`. Nothing
 * backfills it — the text an old narration was made from is not recoverable, and
 * project data is never rewritten to compensate (AGENTS.md §5).
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveArtifact } from '../lib/episode-artifacts.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { currentChapterScriptHash } from './audio-quality.js'
import type {
  NarrationStaleness,
  NarrationStalenessBasis,
  NarrationStalenessReason,
  NarrationStalenessState,
} from '../contracts/narration-staleness.js'

export type {
  NarrationStaleness,
  NarrationStalenessBasis,
  NarrationStalenessReason,
  NarrationStalenessState,
}

/** Sibling of `audio_chapters.json` / `audio_quality.json` in the episode folder. */
const FILE = 'audio_narration_source.json'

/**
 * Which fingerprint contract a record was written under. A record carrying any
 * other value is ignored (never silently compared), so a future change to the
 * fingerprint's definition cannot make honest audio look stale.
 */
export const NARRATION_SOURCE_FINGERPRINT = 'chapter-text-v1'

interface NarrationSourceRecord {
  sha256: string
  recorded_at: string
}

export interface NarrationSourceSet {
  version: 1
  fingerprint: string
  sections: Record<string, NarrationSourceRecord>
}

/** A fresh empty record. Never a shared object: a caller merging into it would
 *  otherwise hand the next reader sections it never read. */
function emptyRead(): NarrationSourceSet {
  return { version: 1, fingerprint: NARRATION_SOURCE_FINGERPRINT, sections: {} }
}

function filePath(episodeDir: string): string {
  return path.join(episodeDir, FILE)
}

function isSectionSlug(slug: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(slug)
}

/**
 * The shape the ONE fingerprint implementation produces: `hashInput` in
 * services/task-manifest.ts, i.e. `sha256:` + 16 hex characters. A value of any
 * other shape is treated as no record at all — comparing it would report "the
 * text changed" on evidence nobody can read (AGENTS.md §6). If that
 * implementation ever changes the digest it prints, this pattern AND
 * `NARRATION_SOURCE_FINGERPRINT` move together.
 */
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{16}$/

function record(value: unknown): NarrationSourceRecord | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const sha256 = typeof row.sha256 === 'string' && FINGERPRINT_PATTERN.test(row.sha256) ? row.sha256 : null
  const recorded_at = typeof row.recorded_at === 'string' && row.recorded_at.trim() ? row.recorded_at : null
  return sha256 && recorded_at ? { sha256, recorded_at } : null
}

/**
 * Read the episode's narration-text record. A missing, unreadable, or malformed
 * file is an empty record, never an error: an unreadable record is reported as
 * `legacy_mtime` (honest fallback), not as "the text changed".
 */
export async function readNarrationSource(episodeDir: string): Promise<NarrationSourceSet> {
  let raw: unknown
  try { raw = JSON.parse(await fs.readFile(filePath(episodeDir), 'utf8')) }
  catch { return emptyRead() }
  if (!raw || typeof raw !== 'object') return emptyRead()
  const source = raw as Record<string, unknown>
  // A record written under a different fingerprint contract is not comparable.
  if (source.fingerprint !== NARRATION_SOURCE_FINGERPRINT) return emptyRead()
  const sections: Record<string, NarrationSourceRecord> = {}
  for (const [slug, value] of Object.entries(source.sections && typeof source.sections === 'object'
    ? source.sections as Record<string, unknown> : {})) {
    if (!isSectionSlug(slug)) continue
    const entry = record(value)
    if (entry) sections[slug] = entry
  }
  return { version: 1, fingerprint: NARRATION_SOURCE_FINGERPRINT, sections }
}

/**
 * Record the text fingerprints behind narration that just became active. Merges
 * per section: sections this run did not narrate keep the record they had, and
 * nothing is ever deleted to make a stale answer disappear.
 */
export async function recordNarrationSource(
  episodeDir: string,
  entries: Array<{ slug: string; sha256: string }>,
): Promise<void> {
  const usable = entries.filter(entry => isSectionSlug(entry.slug) && FINGERPRINT_PATTERN.test(entry.sha256))
  if (!usable.length) return
  const target = filePath(episodeDir)
  await withLock(target, async () => {
    const current = await readNarrationSource(episodeDir)
    const recorded_at = new Date().toISOString()
    const sections: Record<string, NarrationSourceRecord> = { ...current.sections }
    for (const entry of usable) sections[entry.slug] = { sha256: entry.sha256, recorded_at }
    await writeJsonAtomic(target, { version: 1, fingerprint: NARRATION_SOURCE_FINGERPRINT, sections })
  })
}

/** The fingerprint of the chapter text on disk right now, or null when it can't be read. */
export async function currentNarrationSourceHash(
  scriptDir: string | null,
  episodeCode: string,
  slug: string,
): Promise<string | null> {
  if (!scriptDir || !isSectionSlug(slug)) return null
  return currentChapterScriptHash(scriptDir, episodeCode, slug)
}

/** The chapter/intro source file the legacy mtime rule compares against, if it exists. */
export function narrationSourcePath(scriptDir: string, episodeCode: string, slug: string): string | null {
  if (!isSectionSlug(slug)) return null
  return resolveArtifact(scriptDir, `${episodeCode.toUpperCase()}_${slug}`)
}

export interface NarrationStalenessInput {
  episodeCode: string
  slug: string
  /** The episode's Script folder, or null when it could not be resolved. */
  scriptDir: string | null
  /** The episode folder holding `audio_narration_source.json`, or null when unknown. */
  episodeDir: string | null
  /** Absolute paths of the audio chunks that currently carry this section. */
  audioFilePaths: string[]
}

async function mtimeMs(file: string): Promise<number | null> {
  try { return (await fs.stat(file)).mtimeMs } catch { return null }
}

/**
 * Answer the one question, with the reason it was answered that way. Every
 * consumer (Audio page, Chapters panel, Pipeline/Production Board filters) reads
 * THIS and nothing else.
 */
export async function narrationStaleness(input: NarrationStalenessInput): Promise<NarrationStaleness> {
  const { episodeCode, slug, scriptDir, episodeDir, audioFilePaths } = input
  if (!audioFilePaths.length) {
    return { state: 'unknown', basis: 'none', reason: 'no_audio', detail: 'This chapter has no narration on disk yet.' }
  }

  const recorded = episodeDir ? (await readNarrationSource(episodeDir)).sections[slug]?.sha256 ?? null : null
  const current = await currentNarrationSourceHash(scriptDir, episodeCode, slug)

  if (recorded) {
    if (!current) {
      return {
        state: 'unknown', basis: 'none', reason: 'script_absent',
        detail: 'This chapter\'s script could not be read, so its narration cannot be compared with it.',
      }
    }
    return current === recorded
      ? {
        state: 'fresh', basis: 'content', reason: 'text_unchanged',
        detail: 'This narration matches the chapter\'s current text.',
      }
      : {
        state: 'stale', basis: 'content', reason: 'text_changed',
        detail: 'This chapter\'s text changed after its narration was generated. Regenerate this section to refresh it.',
      }
  }

  // Legacy fallback: narration made before Story Studio recorded the text behind
  // it. Its mtime is the only evidence there is, so it is used — and reported as
  // legacy, because "the script changed" would not be true.
  const sourcePath = scriptDir ? narrationSourcePath(scriptDir, episodeCode, slug) : null
  const sourceMtime = sourcePath ? await mtimeMs(sourcePath) : null
  if (sourceMtime === null) {
    return {
      state: 'unknown', basis: 'none', reason: 'script_absent',
      detail: 'This chapter\'s script could not be read, so its narration cannot be compared with it.',
    }
  }
  const audioMtimes = (await Promise.all(audioFilePaths.map(mtimeMs))).filter((value): value is number => value !== null)
  if (!audioMtimes.length) {
    return { state: 'unknown', basis: 'none', reason: 'no_audio', detail: 'This chapter\'s narration files could not be read.' }
  }
  const scriptIsNewer = audioMtimes.every(chunk => chunk < sourceMtime)
  if (!scriptIsNewer) {
    return {
      state: 'fresh', basis: 'legacy_mtime', reason: 'legacy_script_not_newer',
      detail: 'This narration predates text-based checking, and its audio is at least as new as the chapter file.',
    }
  }
  return {
    state: 'stale', basis: 'legacy_mtime', reason: 'legacy_script_newer_than_audio',
    detail: 'This narration predates text-based checking, and the chapter file is newer than its audio. '
      + 'Regenerate this section to refresh it — Story Studio cannot tell whether the words changed.',
  }
}
