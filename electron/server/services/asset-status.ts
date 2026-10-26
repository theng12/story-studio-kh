/**
 * Asset-presence status helpers for the "integrity pill" UI.
 *
 * For each asset type we compute (expected, present, missing) without
 * triggering any provider calls. The pill renders from this, and the
 * Repair button on the frontend just re-submits the normal generate
 * endpoint — every generator already skips existing non-empty files
 * (`fileExistsWithContent`), so a re-submit naturally fills only the gaps.
 *
 * Audio TTS has its own reconciler (services/audio-reconciler.ts) because
 * GenAIPro retains tasks for only ~1 day, so we recover via task-history
 * lookup rather than regeneration. Images/Video/AudioMerge don't have that
 * constraint, so we just regenerate.
 */

import { isFinalVideoFilename } from '../lib/final-video-name.js'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { findDirLevelOrder, findDirsLevelOrder } from '../lib/dir-search.js'
import { parseImagePromptsDocx } from '../lib/docx-parser.js'
import {
  resolveEpisodePaths,
  resolveEpisodePathsByCode,
  resolveEpisodePathsByCodeWithSidecar,
  resolveSubfolderNames,
  projectConfigOnce,
  projectOutputRootOnce,
  projectFactsFor,
  type ProjectFactsCache,
  resolveScenePlanPath,
} from './utils.js'
import { MUSIC_EPISODE_FILENAME } from './music-episode.js'
import type { EpisodePaths } from './utils.js'
import { resolveReadPath, resolveArtifact, matchChapterFile, introMarkerPath } from '../lib/episode-artifacts.js'
import { resolveEpisodeSubfolderDir } from './media-root.js'
import { resolveResearchPaths } from '../lib/research-paths.js'
import {
  hasResearchEvidence,
  isResearchComplete,
  readResearchReview,
  readResearchTriage,
} from '../lib/research-verification.js'
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import {
  findScenePromptsFile, findThumbPromptsFile, resolveImageDirs,
} from '../generators/images.js'
import { resolveSceneImagesDir, SCENE_IMAGES_SUBFOLDER } from '../generators/scene-image.js'
import { resolveVideoAssetsDir } from '../generators/scene-clip.js'
import { resolveEpisodeMotionSceneIds } from './episode-motion-scope.js'
import { sceneClipStaleReason, resolveSketchDrawSettings } from './scene-media-checkpoint.js'
import { getAudioStatus } from './audio-reconciler.js'
import { inspectChunkedScriptCompletion } from '../lib/chunked-narration.js'
import { inspectScenePromptIntegrity } from './scene-prompt-integrity.js'
import { readSubtitleTimelineIntegrity } from './scene-timeline-integrity.js'
import { allowedSubtitleCueGapSec } from './scene-plan-pacing.js'
import { inspectSubtitleCompletion, inspectSubtitleSourceFreshness } from './subtitle-completion.js'
import { inspectExistingTranscriptSource } from './subtitle-correction.js'
import { safetyModeFromConfig } from './safety-checks.js'
import { inspectPromptCompletion, legacyPromptsPresent } from './prompt-completion.js'
import { inspectMetadataCompletion, legacyMetadataPresent } from './metadata-completion.js'
import { COVERAGE_FAIL_SEC, inspectScenePlanCoverage } from './scene-planner.js'
import { planMergedAudioDrift, planNarrationShortfallSec, readNarrationRecord } from '../lib/scene-plan-timeline.js'
import { selectMergedAudioFilename } from '../lib/intro-lead-in.js'
import { isEpisodeMergedAudioFilename, resolveEpisodeMergedAudioChoice } from '../lib/merged-audio-selection.js'
import { inspectSceneReviewCompletion } from './scene-review-completion.js'
import { normalizeContextualCueConfig, readContextualCueTimeline, validateContextualCueTimeline } from './contextual-cues.js'
import { DEFAULT_SOUND_DESIGN_SETTINGS, normalizeSoundDesignConfig, readSoundDesignTimeline, validateSoundDesignTimeline } from './sound-design.js'
import {
  inspectBrollAssemblyOutput,
  readVideoVisualSource,
  videoVisualSourceRequiresBrollProof,
  videoAssemblySourceStampMatches,
  videoAssemblySourceStampPath,
  type VideoAssemblySourceStamp,
} from './video-visual-source.js'

// ── Shared helpers ─────────────────────────────────────────────────────────

async function safeReaddir(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir) } catch { return [] }
}

/**
 * v1.0.78 — readdir variant that distinguishes "folder is empty" from
 * "couldn't read folder". The status-detection compute uses the rich
 * variant for the four primary watched folders (script / scene_prompts /
 * thumb_prompts / metadata) so the cache can refuse to persist a
 * `script: false` result that came from a failed or truncated readdir.
 *
 * `errored` distinguishes TRANSIENT failures (EBUSY, EPERM, EACCES,
 * EIO — a busy, slow or disconnected drive) from PERMANENT "not there yet"
 * states (ENOENT, ENOTDIR — folder hasn't been created because the user
 * hasn't run the generator yet). The `not there yet` state is correctly a `false` we should
 * cache — when the folder eventually appears, snapshotMtimes will see a
 * new key in the next snapshot and the cache will correctly stale.
 *
 * The cheap `safeReaddir` above is fine for places where the caller
 * doesn't need to distinguish — most asset-presence checks treat both as
 * "no files", which is semantically correct outside the cache-poisoning
 * path. See episode-status-cache.computeAndStore for how `errored` flows
 * up through the `_unreliable` flag on EpisodeStatus.
 */
interface SafeReaddirResult { files: string[]; errored: boolean }
async function safeReaddirRich(dir: string): Promise<SafeReaddirResult> {
  try {
    return { files: await fs.readdir(dir), errored: false }
  } catch (e: any) {
    const code = e?.code
    // ENOENT / ENOTDIR are legitimate "this folder doesn't exist (yet)"
    // states — happens for any episode whose user hasn't run the
    // corresponding generator. Caching `false` for these is correct;
    // when the folder appears, the snapshot delta will trigger STALE.
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { files: [], errored: false }
    }
    // Anything else (EBUSY / EPERM / EACCES / EIO / EMFILE, e.g. an external
    // drive that stalls or drops) is unreliable — the folder may exist with files, we
    // just couldn't enumerate them. Don't let the cache freeze that.
    return { files: [], errored: true }
  }
}

/**
 * A read that failed for any reason other than "not there" (EBUSY, EIO,
 * EACCES, a stalled external drive…) says nothing about the episode. Flag the status
 * `_unreliable` so the cache never stores that error as "pending"; the next
 * read recomputes. ENOENT/ENOTDIR and non-fs errors keep today's `false`.
 */
function flagTransientReadError(status: EpisodeStatus, error: unknown): void {
  // Only real filesystem failures (they carry a syscall); app errors such as
  // NARRATION_MISSING are answers, not failed reads.
  const { code, syscall } = (error ?? {}) as { code?: unknown; syscall?: unknown }
  if (typeof syscall === 'string' && code !== 'ENOENT' && code !== 'ENOTDIR') status._unreliable = true
}

/**
 * Users sometimes prefix folders with ✅, ✔️, or other
 * decorative marks to signal completion. Strip them before matching the
 * episode code so detection doesn't silently flip to false.
 */
export function stripDecorativePrefix(name: string): string {
  return name.replace(/^[\s\p{Emoji}\p{Symbol}✅✔️]+/u, '').trim()
}

/**
 * Does this directory name belong to episode `code`?
 *
 * Four separate searches used a bare `name.toUpperCase().startsWith(CODE)` to
 * answer this. That cannot collide while every episode code in a project is the
 * same width — and `episode_digits` is project-wide — but it is one setting
 * change away from `EP0001` claiming `EP00012`'s folder, silently, first-hit-
 * wins, in traversal order.
 *
 * MEASURED 2026-09-20 against the live library before tightening it: of 4,971
 * distinct episode folders, **4,971** are exactly `{CODE} - {Title}` — the count
 * matching `^EP\d{4} - ` is all of them, and the count with any other character
 * after the code is zero. So exact equality or `{code} + " - "` matches every
 * real folder, and the strict rule costs nothing today while removing the
 * dependency on codes staying fixed-width.
 *
 * Decorative prefixes are stripped first and the already-stripped input is
 * accepted too, because `buildEpisodeDirOrder` stores names pre-cleaned.
 * Stripping is idempotent, so callers need not care which form they hold.
 */
export function episodeDirNameMatchesCode(dirName: string, code: string): boolean {
  const clean = stripDecorativePrefix(dirName).toUpperCase()
  const wanted = code.toUpperCase()
  if (!wanted) return false
  return clean === wanted || clean.startsWith(`${wanted} - `)
}

// ── Script / Introduction detection (asset-readiness contract) ────────────
//
// Centralised here so `buildRow` in routes/ideas.ts and any future caller
// agree on what counts as "script present" vs "introduction present".
//
// IMPORTANT — single canonical narration file:
// Introduction is NOT a separate asset. It's part of the unified narration
// docx. `generateIntroductionOnly` reads the existing chapters docx,
// inserts an "Introduction" section at the top, and rewrites the same
// file. Audio / subtitles / video assembly all read that one file.
//
// To flip `episode.status.introduction` without re-parsing the docx on
// every list call, the intro generator drops a sibling sidecar:
//   {code}_Script_Narration.intro.json
// Existence of any `*.intro.json` in the script folder = intro present.
// `generateScriptOnly` deletes the sidecar before regenerating chapters
// so the flag stays honest after a script-only re-run.
//
// Legacy note: pre-refactor episodes wrote a separate
// `*_Script_Narration_Introduction.docx`. We keep matching that filename
// pattern as a fallback so existing projects don't suddenly report
// `introduction: false`. New runs always use the sidecar.

export function isIntroductionMarker(filename: string): boolean {
  // v1.4.3 — iCloud placeholder names are no longer unwrapped here. The app
  // does not expect to live in a synced folder, so a `.foo.intro.json.icloud`
  // stub is not a file that is on its way; it is just not the file.
  const name = filename
  // Sidecar JSON written by generateIntroductionOnly. Cheap O(1) check.
  if (name.endsWith('.intro.json')) return true
  // Legacy / pre-sidecar intro source file (either extension). Kept as a
  // fallback so older projects keep reporting introduction: true; new runs
  // replace these by overwriting the unified narration + writing the sidecar.
  if (/_Introduction\.(?:md|docx)$/i.test(name)) return true
  return false
}

export function isScriptChaptersDocx(filename: string): boolean {
  // Any narration artifact (.md current, .docx legacy) that isn't the
  // separate-intro file counts as "script present" — that's the chapters /
  // unified-narration file, by spec. (v1.4.3: no placeholder unwrapping — see
  // `isIntroductionMarker`.)
  const name = filename
  return /\.(?:md|docx)$/i.test(name) && !/_Introduction\.(?:md|docx)$/i.test(name)
}

export interface ScriptFolderState {
  script: boolean        // chapters docx present (the unified narration)
  introduction: boolean  // intro merged into narration (sidecar present, or legacy file)
}

/**
 * Given the list of filenames in an episode's script folder, return whether
 * the chapters docx exists and whether an introduction has been merged in.
 *
 * Pure function over the file-list — fixture-friendly, no fs calls.
 */
export function deriveScriptFolderState(files: string[]): ScriptFolderState {
  return {
    script: files.some(isScriptChaptersDocx),
    introduction: files.some(isIntroductionMarker),
  }
}

async function hasValidIntroduction(dir: string, files: string[]): Promise<boolean> {
  for (const file of files.filter(isIntroductionMarker)) {
    // v1.4.3 — the "this is a placeholder, treat it as present" shortcut is
    // gone with iCloud support. Every candidate is now judged on its contents,
    // which is what the check was always meant to do.
    const candidate = path.join(dir, file)
    if (!await fileHasContent(candidate)) continue
    if (!file.endsWith('.intro.json')) return true
    try {
      const marker = JSON.parse(await fs.readFile(candidate, 'utf-8'))
      if (Number(marker?.word_count) > 0) return true
    } catch { /* corrupt marker is not completion */ }
  }
  return false
}

/**
 * Recover an introduction that exists ONLY inside the unified narration.
 *
 * THE DAMAGE THIS PREVENTS. `isIntroductionMarker` answers from filenames
 * alone and never opens the narration — so an introduction living only in the
 * narration reads as ABSENT. `isStepAlreadyDone` then lets the batch run
 * `introduction-only`, which writes a freshly generated introduction straight
 * over the real one (generators/episode.ts). Credits spent, and the original
 * gone: there is no versioning on that path and no backup. Measured on a
 * 302-episode fixture where every episode genuinely had one: 0 of 302 detected.
 *
 * WHY THIS DOES NOT PUT A PARSE ON THE STATUS PATH. Only ONE population can be
 * in that state — episodes written before the per-chapter refactor, whose
 * narration was never split. Every writer since emits `{code}_Introduction.md`,
 * and `assembleUnifiedNarration` only puts an Introduction section into the
 * unified file when that source file exists. So the gate is "no chapter source
 * files", a test over a list already in memory: no syscall, and for a modern
 * episode the narration is never opened.
 *
 * When it does fire it reads once and writes the sidecar the intro generator
 * would have written, so detection is O(1) filename matching from then on.
 * It never runs twice for the same episode. (The sidecar write bumps the
 * folder mtime, so that episode recomputes once more — once, ever.)
 *
 * `splitNarrationIntoChapters`, never `parseNarrationDocx`: the latter labels
 * ANY leading level-1 heading "Introduction", including `# Title — Narration`.
 * That would report a phantom introduction and SKIP a generation the owner
 * actually wanted, which is the worse failure of the two.
 */
async function backfillLegacyIntroMarker(
  scriptDir: string, code: string, files: string[],
): Promise<boolean> {
  if (files.some(name => matchChapterFile(name, code) !== null)) return false
  const narration = resolveArtifact(scriptDir, `${code}_Script_Narration`)
  if (!narration) return false
  try {
    const { narrationDocxToMarkdown } = await import('../lib/docx-parser.js')
    const { splitNarrationIntoChapters } = await import('../lib/narration-assembly.js')
    const intro = splitNarrationIntoChapters(await narrationDocxToMarkdown(narration)).intro
    const wordCount = intro ? intro.text.trim().split(/\s+/).filter(Boolean).length : 0
    if (wordCount === 0) return false
    await fs.writeFile(introMarkerPath(narration), JSON.stringify({
      generated_at: new Date().toISOString(),
      word_count: wordCount,
      recovered_from: 'unified narration',
    }, null, 2))
    return true
  } catch {
    // A narration we cannot read is not evidence of an introduction. Report
    // absent, exactly as before this existed.
    return false
  }
}

/**
 * Does this script folder have an introduction? The single answer, used by
 * both the normal path and the legacy fuzzy scan.
 *
 * A marker settles it outright. Only when there is NO marker is the narration
 * considered at all, and only then for the one population that can hide an
 * introduction inside it — see `backfillLegacyIntroMarker`.
 */
export async function computeScriptFolderIntroduction(
  dir: string, code: string, files: string[],
): Promise<boolean> {
  return deriveScriptFolderState(files).introduction
    ? await hasValidIntroduction(dir, files)
    : await backfillLegacyIntroMarker(dir, code, files)
}

/**
 * "Is this artifact present AND usable?" — one syscall, and the single
 * definition of the question every completion check in this module asks.
 *
 * Exported so its contract is pinned directly rather than only through an
 * end-to-end status computation: an absent path is false, a zero-byte file is
 * false, a non-empty file is true — including a directory, which stated as a
 * real size before the redundant `existsSync` in front of it was removed and
 * still does.
 */
export async function fileHasContent(p: string): Promise<boolean> {
  try {
    // `fs.stat` already answers "does this exist?", so the `existsSync` that
    // used to guard it was a second syscall for an answer we were about to ask
    // for anyway. The two agree on every case that reaches here: a directory
    // stats to a real size (as it did before), and a broken symlink or a
    // permission failure throws and returned false before.
    //
    // MEASURED 2026-09-18, cold `/episodes` on the 302-episode project: this is
    // the single hottest function on the route — it accounted for 69,860
    // `existsSync` calls plus 53,840 `stat` calls of ~181,000 total filesystem
    // operations. Dropping the redundant probe removes ~54,000 of them.
    const st = await fs.stat(p)
    return st.size > 0
  } catch { return false }
}

/**
 * Every directory under `projectDir`, in the order `search()` below visits
 * them: all children of a directory first, then a depth-first descent through
 * those children in the same order. Reproducing that order exactly is what
 * lets an index lookup return the identical folder the walk would have.
 */
async function buildEpisodeDirOrder(projectDir: string): Promise<Array<{ upper: string; path: string }>> {
  const out: Array<{ upper: string; path: string }> = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    const subs: string[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = path.join(dir, e.name)
      out.push({ upper: stripDecorativePrefix(e.name).toUpperCase(), path: full })
      subs.push(full)
    }
    for (const s of subs) await walk(s, depth + 1)
  }
  await walk(projectDir, 0)
  return out
}

/**
 * Resolve an episode's folder by code.
 *
 * v1.4.76 — when the caller supplies its request-scoped project facts, the
 * project tree is walked ONCE for the whole request and every subsequent
 * lookup is an in-memory scan. This used to recurse the entire episodes tree
 * on every call, and a cold 302-episode `/episodes` calls it several times per
 * episode: measured at ~832,000 `readdir` calls, over half of the endpoint's
 * total filesystem traffic, all of it re-deriving the same directory layout.
 *
 * Without a cache the behaviour is byte-for-byte the original walk, so every
 * caller that has no request scope (single-episode routes, generators) is
 * unaffected.
 */
async function findEpisodeDir(
  projectDir: string,
  code: string,
  cache?: ProjectFactsCache,
  slug?: string,
): Promise<string | null> {
  const CODE = code.toUpperCase()
  // The episode's own "{code} - {title}" folder first, as Audio and every titled reader do: a
  // same-code leftover (boundful EP0100 beside the old folder of what is now EP0116) is not it.
  if (slug) {
    const own = (await resolveEpisodePathsByCode(slug, CODE, cache).catch(() => null))?.episode_dir
    if (own && existsSync(own)) return own
  }

  if (cache) {
    // Keyed by root as well as slug: a project whose media_root moves mid-cache
    // must not be answered from the previous root's index.
    if (!cache.episodeDirs || cache.episodeDirs.root !== projectDir) {
      cache.episodeDirs = { root: projectDir, index: buildEpisodeDirOrder(projectDir) }
    }
    try {
      for (const entry of await cache.episodeDirs.index) {
        if (episodeDirNameMatchesCode(entry.upper, CODE)) return entry.path
      }
      return null
    } catch {
      // A failed walk must not be remembered as "no such episode" for the rest
      // of the request — drop it and fall through to the direct search.
      cache.episodeDirs = undefined
    }
  }

  return findDirLevelOrder(projectDir, 4, (entries, dir) => {
    for (const e of entries) {
      if (e.isDirectory() && episodeDirNameMatchesCode(e.name, CODE)) return path.join(dir, e.name)
    }
    return null
  })
}

// ── Images ─────────────────────────────────────────────────────────────────

export interface ImageStatus {
  mode: 'scenes' | 'thumbnails' | 'all'
  scenes?: { total: number; present: number; missing: number[] }  // missing[i] = scene number
  thumbnails?: { total: number; present: number; missing: number[] }
  dir?: { bg: string; thumb: string }
}

/**
 * For each expected scene (and thumbnail) prompt, does at least one
 * `{code}_Scene{NN}_v*.png` (or `_Thumb{NN}_v*.png`) file exist in the
 * output dir with non-zero size? If so → present. Otherwise → missing.
 *
 * We count "at least one variant present" as success: the generator may
 * return 1-4 variants per scene depending on provider config, and the
 * user only needs ≥1 to not have a visual gap in their video.
 */
export async function getImageStatus(
  slug: string,
  episodeId: string,
  mode: 'all' | 'thumbnails' = 'all',
  knownPaths?: EpisodePaths,
  // The single-episode route may walk the whole output tree to find a misplaced prompts file; bulk callers never do.
  options: { treeFallback?: boolean } = {},
): Promise<ImageStatus> {
  const code = episodeId.toUpperCase()

  // Resolve prompts + dirs. Either file may be missing (e.g. only scene
  // prompts generated so far); the mode reflects what we actually found.
  let scenePromptsPath: string | null = null
  let thumbPromptsPath: string | null = null
  if (mode === 'all') {
    try { scenePromptsPath = await findScenePromptsFile(slug, episodeId) } catch { /* no scene prompts yet */ }
  }
  // The same resolver the generator and repair use: the canonical prompts file when it exists, otherwise their search.
  // With known paths this runs for every episode in bulk passes, so it never walks the whole output tree; the
  // single-episode route (treeFallback) has no such limit.
  try {
    thumbPromptsPath = await findThumbPromptsFile(slug, episodeId, {
      preferred: knownPaths?.thumb_prompts_docx,
      noTreeFallback: !!knownPaths && !options.treeFallback,
    })
  } catch { /* no thumb prompts yet */ }
  const thumbFromCanonical = !!knownPaths && !!thumbPromptsPath
    && path.resolve(thumbPromptsPath) === path.resolve(resolveReadPath(knownPaths.thumb_prompts_docx))

  if (!scenePromptsPath && !thumbPromptsPath) {
    // No prompt manifest means there is no authoritative expected set. A
    // handful of hand-dropped files must not silently complete an unknown-size
    // generation step. Import/Mark Done remains the explicit legacy pathway.
    return { mode: 'all' }
  }

  const promptsPathForDirs = scenePromptsPath || thumbPromptsPath!
  const dirs = knownPaths
    ? { bgDir: knownPaths.bg_dir, thumbDir: knownPaths.thumb_dir }
    : await resolveImageDirs(slug, promptsPathForDirs, episodeId)
  const { bgDir } = dirs
  let thumbDir = dirs.thumbDir
  if (knownPaths && thumbPromptsPath && (!thumbFromCanonical || !existsSync(thumbDir))) {
    thumbDir = (await resolveImageDirs(slug, thumbPromptsPath, episodeId)).thumbDir
  }

  const result: ImageStatus = { mode: 'all', dir: { bg: bgDir, thumb: thumbDir } }

  if (scenePromptsPath) {
    const parsed = await parseImagePromptsDocx(scenePromptsPath)
    const promptAudit = await inspectPromptCompletion(path.dirname(scenePromptsPath), code, 'scene')
    const expected = promptAudit.authoritative
      ? Array.from({ length: promptAudit.expected }, (_, index) => index + 1)
      : parsed.scenes.map(s => s.number)
    const presentFiles = await safeReaddir(bgDir)
    const missing: number[] = []
    let present = 0
    for (const n of expected) {
      const stem = `${code}_Scene${n.toString().padStart(2, '0')}`
      const hasAny = presentFiles.some(f =>
        f.startsWith(stem + '_v') && f.endsWith('.png') &&
        existsSync(path.join(bgDir, f))
      )
      // Deeper check: at least one variant with content
      let ok = false
      if (hasAny) {
        for (const f of presentFiles) {
          if (f.startsWith(stem + '_v') && f.endsWith('.png')) {
            if (await fileHasContent(path.join(bgDir, f))) { ok = true; break }
          }
        }
      }
      if (ok) present++; else missing.push(n)
    }
    result.scenes = { total: expected.length, present, missing }
  }

  if (thumbPromptsPath) {
    const parsed = await parseImagePromptsDocx(thumbPromptsPath)
    const promptAudit = await inspectPromptCompletion(path.dirname(thumbPromptsPath), code, 'thumbnail')
    const expected = promptAudit.authoritative
      ? Array.from({ length: promptAudit.expected }, (_, index) => index + 1)
      : parsed.thumbnails.map(t => t.number)
    const presentFiles = await safeReaddir(thumbDir)
    const missing: number[] = []
    let present = 0
    for (const n of expected) {
      const stem = `${code}_Thumb${n.toString().padStart(2, '0')}`
      let ok = false
      for (const f of presentFiles) {
        if (f.startsWith(stem + '_v') && f.endsWith('.png')) {
          if (await fileHasContent(path.join(thumbDir, f))) { ok = true; break }
        }
      }
      if (ok) present++; else missing.push(n)
    }
    result.thumbnails = { total: expected.length, present, missing }
  }

  return result
}

// ── Video (clips animated from scene images) ───────────────────────────────

export interface VideoStatus {
  total: number
  present: number
  missing: number[]       // missing prompt numbers
  dir?: string
}

/**
 * For each video prompt, does at least one `{code}_Video{NN}_v*.mp4` exist?
 * Looks for prompts in `{code}_Video_Prompts.docx` first, then falls back
 * to `{code}_Scene_Prompts.docx` (the generator does the same).
 */
export async function getVideoStatus(slug: string, episodeId: string): Promise<VideoStatus> {
  const code = episodeId.toUpperCase()
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) return { total: 0, present: 0, missing: [] }
  // Re-bind to a `string` local so TS narrowing survives the async closure.
  const root: string = outputRoot

  // Look for a video prompts docx; fall back to scene prompts as the
  // generator does (loadPrompts in ai-video.ts).
  async function findFirstPrompts(): Promise<string | null> {
    const candidates = [
      `${code}_Video_Prompts.md`,
      `${code}_Video_Prompts.docx`,
      `${code}_Scene_Prompts.md`,
      `${code}_Scene_Prompts.docx`,
    ]
    async function recurse(dir: string, depth = 0): Promise<string | null> {
      if (depth > 6) return null
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (e.isFile() && candidates.includes(e.name)) return path.join(dir, e.name)
        if (e.isDirectory()) {
          const found = await recurse(path.join(dir, e.name), depth + 1)
          if (found) return found
        }
      }
      return null
    }
    // Search the episode's own folder, not the whole library: this used to walk
    // every directory under the root (scene-image folders included) until it hit
    // the first match, so each episode's audit cost grew with the episodes before it.
    const ownDirs = await findDirsLevelOrder(root, 4, name => episodeDirNameMatchesCode(name, code))
    for (const ownDir of ownDirs) {
      const found = await recurse(ownDir)
      if (found) return found
    }
    return ownDirs.length ? null : recurse(root)
  }

  const promptsPath = await findFirstPrompts()
  if (!promptsPath) {
    // Files alone cannot establish how many clips were expected. Keep this
    // pending until prompts provide an authoritative target set.
    return { total: 0, present: 0, missing: [] }
  }

  const parsed = await parseImagePromptsDocx(promptsPath)
  // Video generator uses the same "scenes" numbering from the prompts doc;
  // see ai-video.ts loadPrompts(). Scene prompts carry `number` + `title`.
  const expected = parsed.scenes.map(s => s.number)

  const names = await resolveSubfolderNames(slug, code)
  const epDir = await findEpisodeDir(outputRoot, code, undefined, slug)
  if (!epDir) return { total: expected.length, present: 0, missing: expected }
  const videoDir = await resolveEpisodeSubfolderDir(slug, code, 'video', epDir, names.video, false)

  const presentFiles = await safeReaddir(videoDir)
  const missing: number[] = []
  let present = 0
  for (const n of expected) {
    const stem = `${code}_Video${n.toString().padStart(2, '0')}`
    let ok = false
    for (const f of presentFiles) {
      if (f.startsWith(stem + '_v') && f.endsWith('.mp4')) {
        if (await fileHasContent(path.join(videoDir, f))) { ok = true; break }
      }
    }
    if (ok) present++; else missing.push(n)
  }
  return { total: expected.length, present, missing, dir: videoDir }
}

// ── Audio-Merge ────────────────────────────────────────────────────────────

/**
 * Why a merged track is not `present`, in words a reader can act on. One rule decides it
 * (`inspectAudioMergeAtPaths`); episode status, the Audio Assembly page and Video Assembly's scan
 * all report this value rather than each re-deriving "stale".
 *   missing                 no usable merged file (or the pinned file is gone)
 *   completion-mismatch     the completion record does not describe this file
 *   chapter-changed:<file>  an active chapter is newer than the merge (or gone)
 *   chapter-rejected:<file> the merge was built from a take the owner rejected (owner, 2026-10-26)
 *   chapter-record-unreadable  audio_chapters.json cannot say which chapters the merge used
 */
export type AudioMergeReason = 'missing' | 'completion-mismatch' | 'chapter-record-unreadable' | `chapter-changed:${string}` | `chapter-rejected:${string}` | `script-changed:${string}`

/** The refusal Video Assembly shows for a merged track the freshness rule rejects, naming why and the repair. */
export function staleMergedAudioMessage(episodeId: string, file: string | null | undefined, reason: AudioMergeReason): string {
  const code = episodeId.toUpperCase()
  const track = file ? `"${file}"` : 'merged audio'
  if (reason.startsWith('script-changed:')) {
    return `Video Assembly is blocked: ${code}'s ${track} uses old chapter text for ${reason.slice('script-changed:'.length)}. `
      + 'Regenerate that chapter’s narration, then re-run Audio Assembly, transcription and subtitle stitching before retrying.'
  }
  if (reason.startsWith('chapter-rejected:')) {
    return `Video Assembly is blocked: ${code}'s ${track} was assembled from a narration take that was rejected `
      + `("${reason.slice('chapter-rejected:'.length)}"). Restore it or use another version on the Audio page, then re-run Audio Assembly.`
  }
  const why = reason === 'completion-mismatch'
    ? 'its completion record does not match the file (the merge may be unfinished or replaced)'
    : reason === 'chapter-record-unreadable'
      ? 'audio_chapters.json cannot be read, so it is unknown which chapters it was built from'
      : reason.startsWith('chapter-changed:')
        ? `chapter audio "${reason.slice('chapter-changed:'.length)}" changed (or is gone) after it was merged`
        : 'it is not current'
  return `Video Assembly is blocked: ${code}'s ${track} is out of date because ${why}. `
    + 'Re-run Audio Assembly for this episode, then retry.'
}

export interface AudioMergeStatus {
  present: boolean            // is there at least one merged file with content?
  file?: string               // filename of newest merged output (v1 or v{N})
  dir?: string
  path?: string
  /** Set exactly when `present` is false. */
  reason?: AudioMergeReason
}

/** A changed active chapter invalidates the assembled track even at the same duration. Null = current, else the reason. */
async function mergedAudioSourcesStaleReason(
  episodeDir: string,
  audioDir: string,
  mergedPath: string,
  code: string,
  /** The episode's resolved Script folder — a renamed folder must still be seen (AGENTS §6). */
  scriptDir?: string,
): Promise<AudioMergeReason | null> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(episodeDir, 'audio_chapters.json'), 'utf8')
  } catch (error) {
    // Merges created before source sidecars existed remain compatible. An
    // existing sidecar that cannot be read is unknown, never proof of freshness.
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : 'chapter-record-unreadable'
  }

  let sidecar: { sections?: Array<{ slug?: unknown; source_file?: unknown; source_files?: unknown }> }
  try {
    sidecar = JSON.parse(raw)
  } catch {
    return 'chapter-record-unreadable'
  }
  if (!Array.isArray(sidecar.sections)) return 'chapter-record-unreadable'

  try {
    const { staleNarrationSections } = await import('../lib/narration-source-freshness.js')
    const stale = await staleNarrationSections(episodeDir, code, sidecar.sections, { audioDir }, scriptDir)
    if (stale.length) return `script-changed:${stale.join(', ')}`
    const names = (sidecar.sections || []).flatMap(section => {
      const listed = Array.isArray(section.source_files)
        ? section.source_files.filter((file): file is string => typeof file === 'string' && path.basename(file) === file)
        : []
      if (listed.length) return listed
      return typeof section.source_file === 'string' && path.basename(section.source_file) === section.source_file
        ? [section.source_file]
        : []
    })
    if (!names.length) return 'chapter-record-unreadable'
    // A merge built from a take the owner has since rejected is not current,
    // even though its bytes are untouched: Video Assembly must never render it
    // (owner, 2026-10-26). Checked before the mtime rule, which cannot see it.
    const { rejectedTakeFileSet } = await import('./audio-take-rejection.js')
    const rejected = await rejectedTakeFileSet(episodeDir)
    const rejectedSource = names.find(name => rejected.has(name))
    if (rejectedSource) return `chapter-rejected:${rejectedSource}`
    const [merged, sources] = await Promise.all([
      fs.stat(mergedPath),
      Promise.all(names.map(name => fs.stat(path.join(audioDir, name)).catch(() => null))),
    ])
    const changed = names.find((_, index) => !sources[index] || sources[index]!.mtimeMs > merged.mtimeMs)
    return changed === undefined ? null : `chapter-changed:${changed}`
  } catch {
    return 'chapter-record-unreadable'
  }
}

/** Resolve the one canonical, completion-verified, current merge at known episode paths. */
export async function inspectAudioMergeAtPaths(
  paths: Pick<EpisodePaths, 'episode_dir' | 'audio_dir' | 'merged_audio_dir'> & Partial<Pick<EpisodePaths, 'script_dir'>>,
  episodeId: string,
): Promise<AudioMergeStatus> {
  const code = episodeId.toUpperCase()
  const files = await safeReaddir(paths.merged_audio_dir)

  // v1.4.314 — the owner's explicit choice wins over this module's own
  // "highest `_vN`" rule, so `audio-merge-status` and B-Roll report the very
  // track the Final Video path renders. No pin → the legacy highest-version rule
  // is kept exactly, so an episode nobody pinned is unchanged.
  const choice = await resolveEpisodeMergedAudioChoice(paths.merged_audio_dir, code)
  if (choice.source === 'invalid') {
    // A pin that names a file no longer here is not swapped for another track:
    // which narration the video carries is the owner's call. `present: false`
    // makes B-Roll's narration authority refuse rather than fall back to raw
    // audio, and the status carries the pin so the page can say what happened.
    return { present: false, file: choice.pinned ?? undefined, dir: paths.merged_audio_dir, reason: 'missing' }
  }

  const completionPath = path.join(paths.merged_audio_dir, `${code}_merged_audio.completion.json`)
  let best: { version: number; file: string } | null = null
  if (choice.source === 'selected') {
    const file = choice.filename!
    if (!await fileHasContent(path.join(paths.merged_audio_dir, file))) {
      return { present: false, file, dir: paths.merged_audio_dir, reason: 'missing' }
    }
    best = { version: 0, file }
  } else {
    // Membership is the canonical rule (lib/merged-audio-selection.ts), so a
    // recognised `.m4a`/`.wav` — a music episode's merged track — is not dropped
    // before the completion and freshness checks run. Only the ORDER stays this
    // site's own: the highest `_vN`, so an episode nobody pinned is unchanged.
    for (const file of files) {
      if (!isEpisodeMergedAudioFilename(file, code)) continue
      if (!await fileHasContent(path.join(paths.merged_audio_dir, file))) continue
      const version = Number(file.match(/_v(\d+)\./i)?.[1] ?? 1)
      if (!best || version > best.version) best = { version, file }
    }
  }

  if (!best) return { present: false, dir: paths.merged_audio_dir, reason: 'missing' }
  const mergedPath = path.join(paths.merged_audio_dir, best.file)
  if (existsSync(completionPath)) {
    try {
      const completion = JSON.parse(await fs.readFile(completionPath, 'utf-8'))
      // The record is written once per code and OVERWRITTEN, so it describes the
      // LAST merge. When the owner has pinned a different track it says nothing
      // about the pinned one and is skipped — comparing against the wrong file
      // is the misattribution this release is fixing.
      if (completion?.output_filename === best.file) {
        const stat = await fs.stat(mergedPath)
        const verified = Number(completion?.bytes) === stat.size
          && stat.size > 0
          && Number(completion?.duration_sec) > 0
        if (!verified) return { present: false, file: best.file, dir: paths.merged_audio_dir, reason: 'completion-mismatch' }
      } else if (choice.source !== 'selected') {
        // Legacy rule: with no pin the record must name the highest version.
        return { present: false, file: best.file, dir: paths.merged_audio_dir, reason: 'completion-mismatch' }
      }
    } catch { return { present: false, file: best.file, dir: paths.merged_audio_dir, reason: 'completion-mismatch' } }
  }
  const stale = await mergedAudioSourcesStaleReason(paths.episode_dir, paths.audio_dir, mergedPath, code, paths.script_dir)
  if (stale) return { present: false, file: best.file, dir: paths.merged_audio_dir, reason: stale }
  return { present: true, file: best.file, dir: paths.merged_audio_dir, path: mergedPath }
}

/**
 * Is there a `{code}_merged_audio(_v{N})?.{mp3,wav,m4a}` file with content?
 * We consider "any version" as present — users generate v2+ when doing
 * revisions, and the latest one is the one that matters.
 */
export async function getAudioMergeStatus(
  slug: string,
  episodeId: string,
  // v1.4.76 — the caller's request-scoped project facts, so a list response
  // reads project.json once rather than once per episode. See below.
  cache?: ProjectFactsCache,
): Promise<AudioMergeStatus> {
  const code = episodeId.toUpperCase()
  const outputRoot = await projectOutputRootOnce(slug, cache)
  if (!outputRoot) return { present: false }

  const epDir = await findEpisodeDir(outputRoot, code, cache, slug)
  if (!epDir) return { present: false }

  // Resolve merged_audio subfolder name from project config (same logic
  // as audio-merge generator's resolveMergedAudioName).
  //
  // v1.4.76 — this used to open, read and JSON.parse project.json itself,
  // bypassing the request-scoped facts cache every other resolver in this file
  // already goes through. On a 302-episode list that was 302 extra reads and
  // parses of a file that cannot change while one response is being built.
  // `resolveSubfolderNames` applies the identical rule (project override, else
  // the default template, then `{code}` substitution), resolves the project
  // directory the same linked-aware way, and falls back to the defaults on an
  // unreadable file exactly as the hand-rolled version did — so this is the
  // same answer, reached through the shared cached path.
  const subfolders = await resolveSubfolderNames(slug, code, cache)
  const subfolder = subfolders.merged_audio

  // Scan with/without decorative prefixes (✅, ✔️, etc.) for flexibility.
  const entries = await safeReaddir(epDir)
  let mergedDir: string | null = null
  for (const entry of entries) {
    const clean = stripDecorativePrefix(entry)
    if (clean === subfolder) { mergedDir = path.join(epDir, entry); break }
  }
  if (!mergedDir) return { present: false }

  const audioDir = await resolveEpisodeSubfolderDir(slug, code, 'audio', epDir, subfolders.audio, false, cache)
  return inspectAudioMergeAtPaths({
    episode_dir: epDir,
    audio_dir: audioDir,
    merged_audio_dir: mergedDir,
    script_dir: await resolveEpisodeSubfolderDir(slug, code, 'script', epDir, subfolders.script, false, cache),
  }, code)
}

// ── Project-wide audit ────────────────────────────────────────────────────

export interface EpisodeAuditRow {
  episode_id: string
  title: string
  audio:        { total: number; present: number; missing: number }
  scenes:       { total: number; present: number; missing: number }
  thumbnails:   { total: number; present: number; missing: number }
  video:        { total: number; present: number; missing: number }
  merged_audio: { present: boolean }
  errors?: Partial<Record<'audio' | 'images' | 'video' | 'merged_audio', string>>
}

/**
 * Audit every accepted episode in the project, returning per-episode counts
 * for audio / scene images / thumbnails / video clips / merged audio. Any
 * individual status computation that throws (e.g. no narration yet) is
 * swallowed and reported as zero with a reason in `errors`, so one bad
 * episode doesn't break the whole table.
 */
export async function auditProjectAssets(
  slug: string,
  /**
   * v1.2.8 — narrow the audit to named episodes.
   *
   * Repair is a SEARCH tool: it scans the library because the usual question
   * is "which episode has a problem?". When the answer is already known — the
   * user is looking straight at the job that failed — scanning seventy
   * episodes to fix one is the wrong shape, and slow enough that the owner
   * said he would never choose to use it. Filtering here, before the workers
   * start, is what makes the targeted path cheap; filtering the finished rows
   * afterwards saves nothing.
   *
   * Undefined means the whole project, so library-wide Repair is untouched.
   */
  episodeCodes?: readonly string[],
): Promise<EpisodeAuditRow[]> {
  const ideas = await im.getIdeas(slug, 'accepted')
  const rows: EpisodeAuditRow[] = []

  async function auditOne(code: string, title: string): Promise<EpisodeAuditRow> {
    const row: EpisodeAuditRow = {
      episode_id: code,
      title,
      audio: { total: 0, present: 0, missing: 0 },
      scenes: { total: 0, present: 0, missing: 0 },
      thumbnails: { total: 0, present: 0, missing: 0 },
      video: { total: 0, present: 0, missing: 0 },
      merged_audio: { present: false },
      errors: {},
    }

    // Settle each subcheck independently — one failure mustn't nuke the row.
    // Thumbnails use the same canonical paths computeEpisodeStatus does, so the table and the status agree.
    const [audio, images, video, merged, thumbs] = await Promise.allSettled([
      getAudioStatus(slug, code),
      getImageStatus(slug, code),
      getVideoStatus(slug, code),
      getAudioMergeStatus(slug, code),
      resolveEpisodePaths(slug, code, title).then(known => getImageStatus(slug, code, 'thumbnails', known)),
    ])

    if (audio.status === 'fulfilled') {
      row.audio = {
        total: audio.value.expected.length,
        present: audio.value.present.length,
        missing: audio.value.missing.length,
      }
    } else {
      row.errors!.audio = (audio.reason as any)?.message || 'audio check failed'
    }

    if (images.status === 'fulfilled') {
      if (images.value.scenes) {
        row.scenes = {
          total: images.value.scenes.total,
          present: images.value.scenes.present,
          missing: images.value.scenes.missing.length,
        }
      }
    } else {
      row.errors!.images = (images.reason as any)?.message || 'image check failed'
    }

    if (thumbs.status === 'fulfilled') {
      if (thumbs.value.thumbnails) {
        row.thumbnails = {
          total: thumbs.value.thumbnails.total,
          present: thumbs.value.thumbnails.present,
          missing: thumbs.value.thumbnails.missing.length,
        }
      }
    } else if (!row.errors!.images) {
      row.errors!.images = (thumbs.reason as any)?.message || 'thumbnail check failed'
    }

    if (video.status === 'fulfilled') {
      row.video = {
        total: video.value.total,
        present: video.value.present,
        missing: video.value.missing.length,
      }
    } else {
      row.errors!.video = (video.reason as any)?.message || 'video check failed'
    }

    if (merged.status === 'fulfilled') {
      row.merged_audio = { present: merged.value.present }
    } else {
      row.errors!.merged_audio = (merged.reason as any)?.message || 'merged-audio check failed'
    }

    if (!Object.keys(row.errors!).length) delete row.errors
    return row
  }

  // Run episodes in parallel (they touch different folders, no contention).
  // Keep it bounded so a 100-episode project doesn't open 400 concurrent
  // filesystem scans.
  const CONCURRENCY = 8
  const wanted = episodeCodes?.length ? new Set(episodeCodes) : null
  const queue = ideas.filter(i => i.episode_code && (!wanted || wanted.has(i.episode_code)))
  let idx = 0
  async function worker() {
    while (idx < queue.length) {
      const i = idx++
      const idea = queue[i]
      rows[i] = await auditOne(idea.episode_code!, idea.title)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))

  // Preserve the ideas order (Promise.all may finish out-of-order, but we
  // assigned by index so `rows` is already in the original order).
  return rows.filter(Boolean)
}

// ── Shared episode-status snapshot ──────────────────────────────────────────
//
// Single source of truth for "what's done on this episode". Consumed by
// `buildRow` in routes/ideas.ts (the `/episodes` endpoint that powers the UI)
// and by `run-batch` in routes/pipeline.ts (per-step idempotency skip). Both
// readers agree on the shape and semantics so the frontend's "pending"
// selector and the backend's chain-skip logic never disagree.
//
// Every field is a boolean. Derivation rules mirror what `buildRow` did
// inline before this was extracted:
//   - script / prompts / metadata: authoritative expected-output checks when
//     a completion manifest exists; legacy source-doc presence otherwise
//   - images / thumbnails / audio / merged_audio / video: authoritative
//     asset-reconciler checks (partial generations report as NOT done)

export interface EpisodeStatus {
  /** Internal scene-image scan detail. Routes may project this separately. */
  _scene_images?: { total: number, present: number, complete: boolean }
  /** Internal thumbnail-image scan detail. Routes may project this separately. */
  _thumbnail_images?: { total: number, present: number, complete: boolean }
  /** Research evidence exists. Claim triage remains separate editorial state. */
  research: boolean
  /** Raw artifact fact: the sidecar holds a real summary or a real claim.
   *  Independent of project completion — used for "generated, claims still to
   *  review" UI and to stop the Pipeline regenerating research it already has. */
  research_generated?: boolean
  /** Raw artifact fact: no claim is left pending (and there is at least one).
   *  v1.0.761 — derived from the per-claim triage, not from a separate
   *  attestation. */
  research_reviewed?: boolean
  /** Raw editorial fact: at least one claim was KEPT, so the script has
   *  evidence it may use. Reviewed-but-all-ignored is a real editorial
   *  outcome: reviewed = true and usable = false, without blocking progress. */
  research_has_usable_claims?: boolean
  /** 'human' | 'pipeline-auto' | 'auto-approval' — so the UI never implies a
   *  person read claims a machine accepted on its own, whether that was an
   *  unattended Pipeline run or the project's automatic-approval setting. */
  research_reviewed_by?: 'human' | 'pipeline-auto' | 'auto-approval'
  // Timestamp/continuity Scene Plan is complete when scene_plan.json has at
  // least one timeline row and every row has a non-empty visual prompt. A
  // timeline-only or partially prompted plan remains pending and resumable.
  // Distinct from `scene_prompts` (the legacy image-prompts document).
  scene_plan: boolean
  // v1.0.276 — Scene Review "done" for the timestamp/continuity pipeline: the
  // scene plan is complete AND every scene has a generated image on disk (or
  // a recorded image_path). Matches "I've generated all the scene images" — approval/
  // greenlight is a separate gate handled on the Video Assembly page. Distinct
  // from `images` (legacy naming, unreliable for the per-scene
  // scene_images/<id>.png layout). Drives the Scene Review "pending" filter.
  // NOT folded into all_done.
  scene_review: boolean
  /** Scenes whose image is ready but nobody approved yet: Scene Review waits on the owner. */
  scene_review_awaiting_approval?: number
  /**
   * Contextual Cues has NOTHING OUTSTANDING on this episode: the feature is
   * off, or no cue was ever proposed, or every proposed cue is resolved. It is
   * the readiness question every gate asks — Video Assembly, Pipeline
   * prerequisites, pending filters — and all of them get it from the one
   * `validateContextualCueTimeline` rule so they can never disagree.
   *
   * It is deliberately NOT "output exists": an optional feature that nobody
   * used has nothing to wait for. `contextual_cues_generated` answers that
   * separate question; conflating the two is what made an episode with no cues
   * both unrenderable and unrunnable.
   */
  contextual_cues?: boolean
  /** A cue timeline file exists for this plan — i.e. cues were actually
   *  proposed at some point. Only Pipeline's idempotency skip wants this: an
   *  explicitly selected Contextual Cues step must still RUN on an episode
   *  that has nothing outstanding precisely because it has nothing at all. */
  contextual_cues_generated?: boolean
  /** Sound Design has nothing outstanding on this episode — same rule as
   *  `contextual_cues` above. Sound Design is not a Pipeline step, so it needs
   *  no separate "was it generated" signal. */
  sound_design?: boolean
  // Motion Review is complete when every planned scene has either an approved,
  // fresh image-to-video clip or an explicit "use still" decision.
  motion_review: boolean
  // v1.0.361 — continuity-chain / narrated-scenes "character sheet" step: the
  // user has SAVED this episode's continuity config (continuity.json exists at
  // the episode_dir root — written only by the Character Sheet page's Save, the
  // GET returns defaults without creating it). Drives the Character Sheet page's
  // "pending" filter (was wrongly keyed to `script`, so every scripted episode
  // looked done). Only the continuity pipelines produce it — NOT in all_done.
  character_sheet: boolean
  script: boolean
  introduction: boolean
  scene_prompts: boolean
  thumb_prompts: boolean
  metadata: boolean
  images: boolean
  thumbnails: boolean
  audio: boolean
  merged_audio: boolean
  /** Why `merged_audio` is false when it is (see `AudioMergeReason`); absent when present or when nothing was inspected. */
  merged_audio_reason?: AudioMergeReason
  // Subtitle completion is chapter-aware: every audio_chapters.json section
  // needs a transcript, unless an intentional whole-episode track exists.
  // The Subtitles page filters its "pending" list by this.
  // Previously the page borrowed `audio` as a proxy, so episodes that HAD
  // audio (i.e. were ready FOR subtitles) were wrongly hidden from pending.
  // Optional like research/scene_plan — NOT folded into all_done.
  subtitles: boolean
  // v1.0.362 — independent B-Roll workflow: a selection has been picked
  // for this episode (broll-selection.json at the episode_dir root, written by
  // the /broll/pick route). Drives the B-Roll page's "pending" filter (was
  // wrongly keyed to `video`, which is AI clips — broll has none). Only the
  // broll pipeline produces it — NOT in all_done.
  broll_picked: boolean
  video: boolean
  // Video-assembly final render — the single merged output that the
  // Video Assembly page produces. Named `{code}_final_video.{ext}` under
  // the episode's video_dir (same folder the per-scene clips live in).
  // Detected only from a canonical non-empty output or confirmed upload.
  video_assembly: boolean
  /**
   * Music channels only (absent elsewhere): the Episode Builder's stitched mix, tracklist and scene
   * plan match today's song list. The music flow's "Episode Builder" step reads it; narration steps
   * (script, audio, subtitles…) are not part of a music episode's flow.
   */
  music_episode?: boolean
  /**
   * Size in bytes of the final assembled video file, when one was located
   * on disk. Undefined when only the YouTube sidecar (path D) flagged the
   * episode as assembled — the local file may have been deleted post-
   * upload, which is fine; the chip just renders as "—" in that case.
   * Surfaced on the upload page so the user knows how big the file is
   * before pressing Upload.
   */
  final_video_bytes?: number
  /**
   * v1.0.78 — internal cache-control flag (NOT a UI-facing status field).
   * Set to `true` when one or more of the watched-folder readdirs errored
   * during this compute (a busy, slow or disconnected drive: EBUSY, EIO,
   * etc.). The episode-status cache reads this flag and
   * refuses to persist the entry, forcing a fresh recompute on the next
   * read. Underscore-prefixed so consumers know it's not a real status
   * boolean to render in the UI.
   */
  _unreliable?: boolean
}

/** Whether this project is a music channel (its formula has `musicFormat`), read once per facts cache. */
async function musicChannelOnce(slug: string, cache?: ProjectFactsCache): Promise<boolean> {
  const scoped = projectFactsFor(cache, slug)
  const read = async () => {
    const { getEffectiveNiche } = await import('./niche-loader.js')
    return !!(await getEffectiveNiche(slug).catch(() => null) as { musicFormat?: unknown } | null)?.musicFormat
  }
  if (!scoped) return read()
  scoped.musicChannel ??= read()
  return scoped.musicChannel
}

function emptyStatus(): EpisodeStatus {
  return {
    research: false,
    research_generated: false, research_reviewed: false, research_has_usable_claims: false,
    scene_plan: false, contextual_cues: false, sound_design: false, scene_review: false, motion_review: false,
    character_sheet: false,
    script: false, introduction: false,
    scene_prompts: false, thumb_prompts: false,
    metadata: false,
    images: false, thumbnails: false,
    audio: false, merged_audio: false,
    subtitles: false,
    broll_picked: false,
    video: false,
    video_assembly: false,
  }
}

/**
 * Compute the full asset-readiness snapshot for a single episode.
 *
 * Runs the asset-reconciler helpers in parallel via `Promise.allSettled`
 * (same pattern buildRow uses today) — a missing prerequisite leaves that
 * asset false rather than throwing.
 *
 * Missing episode folder → all-false snapshot.
 *
 * Performance: pass `ideas` (the project's accepted-ideas array) when
 * calling this in a loop over many episodes — avoids re-reading and
 * re-parsing ideas.json once per episode (was 2× per call before, so a
 * 150-episode list-load did ~300 redundant ideas.json parses). When
 * omitted, the function loads ideas once internally for backward compat
 * with single-episode callers (pipeline.ts, upload.ts).
 */
/**
 * Fast video-presence check for queue + missing-video views. Skips the
 * expensive full-status computation in computeEpisodeStatus — checks
 * just the canonical Path A (`video/{code}_final_video.{ext}`). The
 * sidecar check (Path C: video lives on YouTube, local file may be
 * deleted) is the caller's responsibility — most callers already have
 * the sidecar in hand.
 *
 * On a 300+ episode project this is ~10x faster than computeEpisodeStatus
 * because it does 1 readdir per episode instead of 10-15 file ops.
 *
 * Misses Path B (sibling Final/Assembled folders) and Path D (external
 * root) — those are unusual layouts. The slower full computeEpisodeStatus
 * is still available; this is just for hot paths where speed matters.
 */
// Hoisted from inside computeEpisodeStatus so hasFinalVideoFast can
// share the predicates without re-declaring them.
const _VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v'])
function _isVideoFile(name: string): boolean {
  const i = name.lastIndexOf('.')
  return i >= 0 && _VIDEO_EXTS.has(name.slice(i).toLowerCase())
}

async function findCanonicalFinal(dir: string, code: string): Promise<string | null> {
  const files = await safeReaddir(dir)
  for (const file of files) {
    if (_isVideoFile(file) && isFinalVideoFilename(code, file)
      && await fileHasContent(path.join(dir, file))) return file
  }
  return null
}

export async function hasFinalVideoFast(
  slug: string,
  code: string,
  title: string,
  cache?: ProjectFactsCache,
): Promise<boolean> {
  try {
    // Path A: project tree (canonical _final_video, or any non-scene mp4).
    const paths = await resolveEpisodePaths(slug, code, title || '', cache)
    if (await findCanonicalFinal(paths.video_dir, code)) return true

    // Path B: external_final_video_root (per-machine Settings → Storage).
    // Mirror Path E in computeEpisodeStatus so the upload queue and the
    // pipeline-status detector never disagree about whether a final
    // exists. Without this branch, an episode whose final lives at the
    // user's external root would have video_assembly: true on the
    // pipeline page but be missing from the upload queue.
    try {
      const { resolveExternalFinalVideoDir } = await import('./external-video-store.js')
      const externalDir = await resolveExternalFinalVideoDir(slug, code, title || '', cache)
      if (externalDir) {
        if (await findCanonicalFinal(externalDir, code)) return true
      }
    } catch { /* external store not configured / import failure → skip */ }

    return false
  } catch {
    return false
  }
}

export async function computeEpisodeStatus(
  slug: string,
  code: string,
  ideas?: Awaited<ReturnType<typeof im.getIdeas>>,
  // v1.4.48 — the caller's request-scoped snapshot of the project's unchanging
  // facts, so a 302-episode list reads project.json and ideas.json once rather
  // than once per episode. Omitted, every read happens exactly as before.
  cache?: ProjectFactsCache,
): Promise<EpisodeStatus> {
  // One cached read of `<projectDir>/episodes` for the whole response: this
  // is asked once per episode and only ever answers `resolveOutputRoot(dir)`.
  const outputRoot = await projectOutputRootOnce(slug, cache)
  if (!outputRoot) return emptyStatus()

  // v1.4.76 — read config.json through the request-scoped facts cache. It is
  // only ever consulted here for two optional feature flags, but `getConfig`
  // re-parses config.json and rebuilds the image/audio/video model catalogues
  // on every call. Per episode, that was the largest block of synchronous CPU
  // in a cold 302-episode list — the work that stalls the event loop and makes
  // the whole API unresponsive while the list is being built. With no cache
  // passed it still calls getConfig exactly as before.
  const projectConfig = await projectConfigOnce(slug, cache)
  const cueConfig = normalizeContextualCueConfig(projectConfig?.contextual_cues)
  const soundConfig = normalizeSoundDesignConfig(projectConfig?.sound_design)

  const status = emptyStatus()
  status.contextual_cues = !cueConfig.enabled
  status.sound_design = !soundConfig.enabled
  let authoritativePaths: EpisodePaths | undefined
  let episodeTitle = ''

  // Hoist ideas.json load to ONCE per call. Previously this function
  // loaded it twice (lines 533 and 664) and the route's per-episode loop
  // multiplied that across every accepted episode. Caller may also pass
  // `ideas` to skip the load entirely (route.ts loads once and shares).
  let resolvedIdeas: Awaited<ReturnType<typeof im.getIdeas>> | null = ideas ?? null
  async function getIdeasOnce() {
    if (resolvedIdeas) return resolvedIdeas
    resolvedIdeas = await im.getIdeas(slug, 'accepted')
    return resolvedIdeas
  }

  // Authoritative source-doc checks: resolve the exact paths the generators
  // write to via resolveEpisodePaths() — same function generateEpisode /
  // generateScriptOnly / generateIntroductionOnly / generateMetadata use.
  // Removes the fuzzy subfolder-name matching that silently broke detection
  // when users renamed completed folders or project config set a custom
  // subfolder name.
  let authoritativeHit = false
  try {
    const ideasList = await getIdeasOnce()
    const CODE = code.toUpperCase()
    const idea = ideasList.find(i => (i.episode_code || '').toUpperCase() === CODE)
    const title = idea?.title || ''
    episodeTitle = title
    const paths = await resolveEpisodePaths(slug, code, title, cache)
    authoritativePaths = paths

    // v1.0.78: use the rich `safeReaddirRich` variant so we can tell apart
    // "folder is genuinely empty" from "couldn't read folder" (a busy,
    // slow or disconnected drive: EBUSY, EIO, EACCES). The four primary watched folders directly
    // determine the boolean status fields below; an errored read on any
    // of them poisons the result and we surface that via `_unreliable`
    // so the cache can refuse to persist it.
    const [scriptR, thumbPromptR, metadataR] = await Promise.all([
      safeReaddirRich(paths.script_dir),
      safeReaddirRich(paths.thumb_prompts_dir),
      safeReaddirRich(paths.metadata_dir),
    ])
    const scriptFiles = scriptR.files
    const thumbPromptFiles = thumbPromptR.files
    const metadataFiles = metadataR.files

    const scriptState = deriveScriptFolderState(scriptFiles)
    const scriptCompletion = await inspectChunkedScriptCompletion(paths.script_dir, code)
    const thumbPromptCompletion = await inspectPromptCompletion(paths.thumb_prompts_dir, code, 'thumbnail')
    status.script = scriptCompletion.complete
    // No marker is not the same as no introduction — see
    // `backfillLegacyIntroMarker`, which is what stops the batch regenerating
    // over an introduction that lives only inside the unified narration.
    status.introduction = await computeScriptFolderIntroduction(paths.script_dir, code, scriptFiles)
    status.thumb_prompts = thumbPromptCompletion.authoritative
      ? thumbPromptCompletion.complete
      : await legacyPromptsPresent(paths.thumb_prompts_dir, thumbPromptFiles, 'thumbnail')
    const metadataCompletion = await inspectMetadataCompletion(paths.metadata_dir, code)
    status.metadata = metadataCompletion.authoritative
      ? metadataCompletion.complete
      : await legacyMetadataPresent(paths.metadata_dir, metadataFiles)

    // One chapter SRT is not episode completion. Compare against the audio
    // assembly manifest so partial transcription remains in Pending. Resolve
    // by code to survive title/folder renames.
    try {
      const subtitlePaths = await resolveEpisodePathsByCodeWithSidecar(slug, code, 'audio_chapters.json', cache)
      const completion = await inspectSubtitleCompletion(
        subtitlePaths.episode_dir,
        subtitlePaths.subtitles_dir,
        code,
      )
      status.subtitles = completion.complete
      if (status.subtitles && completion.mode === 'per-section') {
        const freshness = await inspectSubtitleSourceFreshness(
          subtitlePaths.episode_dir,
          subtitlePaths.audio_dir,
          subtitlePaths.subtitles_dir,
          code,
          subtitlePaths.script_dir,
        )
        // A transcript can exist and still describe superseded narration. Keep
        // it on disk as evidence, but leave Pipeline's subtitle step pending.
        if (freshness.stale_sections.length) status.subtitles = false
      }
      const stitched = path.join(subtitlePaths.subtitles_dir, `${code.toUpperCase()}_stitched.srt`)
      // Per-chapter sources only become a usable Pipeline prerequisite once
      // their shared timeline is written and verified. An intentional imported
      // or whole-track transcript remains a complete standalone source.
      if (status.subtitles && completion.mode === 'per-section' && !existsSync(stitched)) {
        status.subtitles = false
      }
      if (status.subtitles && existsSync(stitched)) {
        const planningTranscript = await inspectExistingTranscriptSource(subtitlePaths.subtitles_dir, code)
        const integrity = await readSubtitleTimelineIntegrity(subtitlePaths.subtitles_dir, code, {
          max_cue_gap_sec: allowedSubtitleCueGapSec(),
          cue_source_path: planningTranscript.path,
          scriptDir: subtitlePaths.script_dir,
        })
        // A missing/stale correction is not a transcription failure. Scene Plan
        // rebuilds and validates that source before provider work; only a fresh,
        // exact planning transcript can move the Pending picker back to false.
        if (!planningTranscript.planning_source_revalidation_required) {
          const captionGapMode = safetyModeFromConfig(projectConfig, 'caption_gap')
          status.subtitles = integrity.missing_sections.length === 0
            && (captionGapMode !== 'block' || !integrity.blocking_cue_gaps?.length)
        }
      }
    } catch (error) {
      status.subtitles = false
      flagTransientReadError(status, error)
    }

    // Research sidecar now lives in the "{code} - 11 Research" folder
    // (resolveResearchPaths auto-migrates any legacy loose copy). The cache
    // watches research.json itself — verification flips REWRITE the file in
    // place, which moves the file's mtime but not episode_dir's.
    //
    // Research is evidence-only: its status is the shared evidence rule from
    // lib/research-verification.ts, never a project-completion gate. Triage
    // facts are surfaced alongside it so the UI can say "claims still to
    // review" or "every claim ignored" instead of "pending".
    try {
      const researchPath = (await resolveResearchPaths(paths.episode_dir, code)).jsonPath
      const research = JSON.parse(await fs.readFile(researchPath, 'utf-8'))
      const triage = readResearchTriage(research)
      const review = readResearchReview(research)
      status.research_generated = hasResearchEvidence(research)
      status.research_reviewed = triage.reviewed
      status.research_has_usable_claims = triage.hasUsableClaims
      // Only SET the actor when there is one. Assigning `undefined` would add
      // an undefined-valued key to the snapshot, which breaks the invariant
      // that every field of an empty status is a real boolean.
      if (review) status.research_reviewed_by = review.completed_by
      else delete status.research_reviewed_by
      status.research = isResearchComplete(research)
    } catch (error) {
      flagTransientReadError(status, error)
      status.research = false
      status.research_generated = false
      status.research_reviewed = false
      status.research_has_usable_claims = false
      delete status.research_reviewed_by
    }

    // v1.0.278 — scene_plan + scene_review resolve the REAL episode dir BY CODE
    // (how the generators write these), not the title-template path
    // resolveEpisodePaths builds. With the title path, a planned/rendered
    // episode whose idea title doesn't exactly match its folder (rename,
    // apostrophe/colon, empty title) resolved to a phantom dir → scene_plan.json
    // never found → episode wrongly read as pending. By-code is rename-proof.
    try {
      const byCode = await resolveEpisodePathsByCodeWithSidecar(slug, code, 'scene_plan.json', cache)
      // v1.0.361 — character sheet "done" = the episode's continuity config has
      // been saved (continuity.json at the episode_dir root). Same by-code
      // resolution as scene_plan so a renamed-folder episode still resolves.
      status.character_sheet = await fileHasContent(path.join(byCode.episode_dir, 'continuity.json'))
      // v1.0.362 — B-Roll workflow selection picked for this episode.
      try {
        const selection = JSON.parse(await fs.readFile(path.join(byCode.episode_dir, 'broll-selection.json'), 'utf-8'))
        status.broll_picked = Array.isArray(selection?.selection) && selection.selection.length > 0
      } catch { status.broll_picked = false }
      // A music (Episode Builder) episode, or any episode of a music channel: it has no narration,
      // so its Scene Plan needs no subtitle timeline, and its own step is the stitched mix.
      const musicDir = existsSync(path.join(byCode.episode_dir, MUSIC_EPISODE_FILENAME))
      if (musicDir || await musicChannelOnce(slug, cache)) {
        const { inspectMusicStitch } = await import('./music-episode-store.js')
        status.music_episode = (await inspectMusicStitch(slug, code)).current
      }
      const planPath = await resolveScenePlanPath(slug, code, byCode.episode_dir, cache)
      const hasPlanFile = await fileHasContent(planPath)
      if (hasPlanFile) {
        const plan = JSON.parse(await fs.readFile(planPath, 'utf-8'))
        const scenes = Array.isArray(plan?.scenes) ? plan.scenes : []
        // A deterministic timeline is only the first stage of Scene Plan. The
        // production step is complete only when every scene has a usable visual
        // prompt. This prevents failed/partial LLM runs from being promoted to
        // done merely because scene_plan.json exists (for example, 273/273
        // timestamp rows with 0 prompts).
        const promptIntegrity = inspectScenePromptIntegrity(scenes)
        const subtitleIntegrity = await readSubtitleTimelineIntegrity(byCode.subtitles_dir, code, { scriptDir: byCode.script_dir })
        const coverageIntegrity = inspectScenePlanCoverage(plan)
        // Which merged track is THIS episode's narration — the owner's explicit
        // choice when he made one, else the base track over a `_v2` (v1.4.314).
        // The completion record is written once per code and overwritten, so
        // without naming the file we are asking about, the drift / shortfall
        // checks below can compare the plan against a `_v2` the app does not
        // render with, and refuse a Final Video the renderer would accept
        // (PR0002/PR0003).
        const mergedChoice = await resolveEpisodeMergedAudioChoice(byCode.merged_audio_dir, code)
        const mergedFilename = mergedChoice.source === 'selected'
          ? mergedChoice.filename
          : mergedChoice.source === 'invalid'
            ? null
            : selectMergedAudioFilename(mergedChoice.entries, code)
        status.scene_plan = scenes.length > 0
          && promptIntegrity.complete
          && (musicDir || subtitleIntegrity.complete)
          && (!coverageIntegrity.authoritative || coverageIntegrity.complete)
          // A pin that no longer names a real track cannot certify the plan.
          && mergedChoice.source !== 'invalid'
          // 1.4.276 — a plan timed against an older merged narration is not done:
          // run-batch re-runs the step, which refuses to continue it (DL0004).
          && !(plan?.source_merged_audio && (await planMergedAudioDrift(plan,
            path.join(byCode.merged_audio_dir, `${code.toUpperCase()}_merged_audio.completion.json`),
            mergedFilename))?.stale)
          // 1.4.288 — nor is a plan that stops before today's narration ends (AF EP0136),
          // so Pipeline re-runs Scene Plan instead of finding it at Video Assembly.
          && (musicDir || planNarrationShortfallSec(scenes, await readNarrationRecord(
            path.join(byCode.merged_audio_dir, `${code.toUpperCase()}_merged_audio.completion.json`),
            path.join(byCode.subtitles_dir, `${code.toUpperCase()}_stitched.srt.json`),
            mergedFilename,
          )) <= COVERAGE_FAIL_SEC)
        // Both are OPTIONAL features. An episode that never proposed a cue has
        // nothing outstanding, so it is not pending — the same rule Video
        // Assembly now applies, kept identical here so the Production Board and
        // the renderer can never disagree about whether an episode is ready.
        // A timeline that DOES exist with unresolved cues still reports
        // incomplete, because there really is something waiting on a reviewer.
        const contextualCueTimeline = await readContextualCueTimeline(planPath)
        status.contextual_cues = !cueConfig.enabled
          || validateContextualCueTimeline(contextualCueTimeline, plan, { requireResolved: true }).length === 0
        status.contextual_cues_generated = !!contextualCueTimeline
        const soundDesignTimeline = await readSoundDesignTimeline(planPath)
        status.sound_design = !soundConfig.enabled
          || validateSoundDesignTimeline(
            soundDesignTimeline, plan,
            soundDesignTimeline?.settings || DEFAULT_SOUND_DESIGN_SETTINGS,
            { requireResolved: true },
          ).length === 0
        // Scene Review done = the plan is complete, every scene has a generated
        // image ON DISK, AND every scene is explicitly approved. Rendering is
        // not approval: even one unapproved scene must remain in Pending.
        // v1.0.519 — detect images by FILE EXISTENCE (`<scene_id>.png` in the
        // named or legacy scene-images folder), which is exactly how the Scene
        // Review page and unified Video Assembly already resolve scene images.
        // Previously this keyed off the plan's `image_path` field, which is only
        // written by the IN-APP renderer — so images produced externally (e.g. a
        // browser extension) and dropped into the folder with the correct
        // `<scene_id>.png` name left `image_path` empty and the episode stuck at
        // "pending" even though every image was present. The `image_path` check
        // is kept as a fallback so this is a strict superset of the old rule
        // (nothing that was complete before becomes pending).
        const namedDir = await resolveSceneImagesDir(slug, code.toUpperCase(), byCode.episode_dir, cache)
        const legacyDir = path.join(byCode.episode_dir, SCENE_IMAGES_SUBFOLDER)
        const imageReady = await Promise.all(scenes.map(async (s: any) => {
          if (typeof s?.id === 'string') {
            if (await fileHasContent(path.join(namedDir, `${s.id}.png`))) return true
            if (await fileHasContent(path.join(legacyDir, `${s.id}.png`))) return true
          }
          return typeof s?.image_path === 'string' && await fileHasContent(s.image_path)
        }))
        status._scene_images = {
          total: scenes.length,
          present: imageReady.filter(Boolean).length,
          complete: scenes.length > 0 && imageReady.every(Boolean),
        }
        const review = inspectSceneReviewCompletion(scenes, imageReady, status.scene_plan)
        status.scene_review = review.complete
        const missingImages = new Set(review.missingImageIds)
        status.scene_review_awaiting_approval = review.unapprovedIds.filter(id => !missingImages.has(id)).length
        const clipsDir = await resolveVideoAssetsDir(slug, code.toUpperCase(), byCode.episode_dir, cache)
        const scopedMotion = await resolveEpisodeMotionSceneIds(slug, code, scenes, byCode.episode_dir)
        const motionSketchSettings = scenes.some((scene: any) => scene?.clip_renderer === 'sketch_draw')
          ? await resolveSketchDrawSettings(slug, code).catch(() => undefined)
          : undefined
        const motionContext = { slug, episodeId: code, episodeDir: byCode.episode_dir, sketchSettings: motionSketchSettings, revealScenes: scenes.map((scene: any) => scene?.id).filter((id: unknown): id is string => typeof id === 'string') }
        const motionReady = await Promise.all(scenes.filter((s: any) => scopedMotion.scene_ids.includes(s.id)).map(async (s: any) => {
          if (s?.motion_choice === 'still') return true
          const hasClip = typeof s?.id === 'string' && await fileHasContent(path.join(clipsDir, `${s.id}.mp4`))
          if (!hasClip || s?.motion_choice === 'pending') return false
          if (await sceneClipStaleReason(s, motionContext)) return false
          return s?.motion_choice === 'clip' || s?.motion_choice == null
        }))
        status.motion_review = status.scene_plan && motionReady.every(Boolean)
      }
    } catch (error) {
      // unresolved / missing plan → leave both false; a failed read is not cached
      flagTransientReadError(status, error)
    }

    // If ANY of the four primary readdirs errored, mark the entire status
    // unreliable. The cache will skip persistence and the next read will
    // recompute — by which point the drive has usually settled. False
    // positives are cheap (~10 fs ops to recompute). False negatives
    // (cached `script: false` for an episode whose script lives on disk)
    // are the actual user-visible bug we're closing.
    if (scriptR.errored || thumbPromptR.errored || metadataR.errored) {
      status._unreliable = true
    }

    // Presence, not completion, decides whether this is the authoritative
    // folder. Otherwise a partial chunked script would fall through to the
    // legacy fuzzy scanner and be incorrectly promoted back to complete.
    authoritativeHit = scriptFiles.length > 0
      || thumbPromptFiles.length > 0 || metadataFiles.length > 0
      || status.introduction

    if (process.env.SSKH_STATUS_DEBUG === '1') {
      console.log('[status-debug]', code, {
        script_dir: paths.script_dir, scriptFiles,
        thumb_prompts_dir: paths.thumb_prompts_dir,
        metadata_dir: paths.metadata_dir,
        derived: { ...status },
      })
    }
  } catch {
    // resolveEpisodePaths can throw on missing project.json / bad code —
    // fall through to the legacy fuzzy scan so old/partial projects still
    // report correctly.
  }

  // Legacy-folder fallback: if authoritative detection came up empty (e.g.
  // episode predates the current subfolder config, or the folder was renamed
  // outside the app), fall back to the original fuzzy scan so these
  // episodes don't suddenly regress to "nothing done".
  if (!authoritativeHit) {
    const dir = await findEpisodeDir(outputRoot, code, cache, slug)
    if (dir) {
      try {
        const subs = await fs.readdir(dir)
        for (const sub of subs) {
          const cleanSub = sub.toLowerCase()
          const subPath = path.join(dir, sub)
          try {
            const stat = await fs.stat(subPath)
            if (!stat.isDirectory()) continue
            const files = await fs.readdir(subPath)
            // Script folder: contains both chapters + (optional) intro sidecar.
            if ((cleanSub.endsWith('script') || cleanSub.includes('01 script')) && !cleanSub.includes('prompt') && !cleanSub.includes('description')) {
              const state = deriveScriptFolderState(files)
              const completion = await inspectChunkedScriptCompletion(subPath, code)
              if (completion.complete) status.script = true
              if (await computeScriptFolderIntroduction(subPath, code, files)) status.introduction = true
            }
            if (cleanSub.includes('thumbnail prompt')) {
              const completion = await inspectPromptCompletion(subPath, code, 'thumbnail')
              status.thumb_prompts = completion.authoritative
                ? completion.complete
                : await legacyPromptsPresent(subPath, files, 'thumbnail')
            }
            if (cleanSub.includes('metadata') || cleanSub.includes('description')) {
              const completion = await inspectMetadataCompletion(subPath, code)
              status.metadata = completion.authoritative
                ? completion.complete
                : await legacyMetadataPresent(subPath, files)
            }
          } catch {}
        }
      } catch {}
    }
  }

  // Authoritative completion checks. Partial generations (e.g. 9 of 10
  // audio chunks present) correctly resolve to false here.
  const { getAudioStatus } = await import('./audio-reconciler.js')
  const [audioS, imageS, mergedS] = await Promise.allSettled([
    getAudioStatus(slug, code, undefined, cache),
    getImageStatus(slug, code, 'thumbnails', authoritativePaths),
    getAudioMergeStatus(slug, code, cache),
  ])

  status.audio = audioS.status === 'fulfilled'
    && audioS.value.expected.length > 0
    && audioS.value.missing.length === 0

  // Completion is the episode's OWN recorded count (the completion manifest,
  // written by the run that made the prompts), observed on disk — never the
  // app-wide default of three (contracts/thumbnail-counts.ts). That is what
  // keeps an episode that was complete — including one whose thumbnail a person
  // already accepted and pinned — from being REOPENED by today's default: its own
  // record still says what it was asked for, and nothing here re-derives it.
  // `missing` stays computed and reported, so a short set is never hidden; it is
  // simply not a reason to re-open finished work.
  status.thumbnails = imageS.status === 'fulfilled'
    && !!imageS.value.thumbnails
    && imageS.value.thumbnails.total > 0
    && imageS.value.thumbnails.missing.length === 0
  if (imageS.status === 'fulfilled' && imageS.value.thumbnails) {
    const thumbnails = imageS.value.thumbnails
    status._thumbnail_images = {
      total: thumbnails.total,
      present: thumbnails.present,
      complete: thumbnails.total > 0 && thumbnails.missing.length === 0,
    }
  }

  // A music episode's thumbnail has no prompt list to complete: one picture in its thumbnail folder
  // (a scene picture the owner chose, or one the image model drew) is a finished thumbnail.
  // A counted, incomplete prompt list (total > 0) is never overridden by it, except by a picture the owner pinned.
  if (status.music_episode !== undefined && !status.thumbnails && authoritativePaths) {
    const { readSelectedThumbnail } = await import('./upload-overrides.js')
    const pinned = await readSelectedThumbnail(slug, code, episodeTitle, 'youtube').catch(() => null)
    const pinnedPresent = !!pinned && /_Thumb_Scene\d+_v\d+\.\w+$/i.test(path.basename(pinned)) && await fileHasContent(path.join(authoritativePaths.thumb_dir, path.basename(pinned)))
    if (pinnedPresent || !status._thumbnail_images?.total) {
      const files = await safeReaddir(authoritativePaths.thumb_dir)
      for (const file of files) {
        if (/\.(png|jpe?g|webp)$/i.test(file) && await fileHasContent(path.join(authoritativePaths.thumb_dir, file))) {
          status.thumbnails = true
          break
        }
      }
    }
  }

  status.merged_audio = mergedS.status === 'fulfilled' && mergedS.value.present
  // Say WHY when a merge exists but is not current; a bare false made a rebuilt chapter look like a lost merge.
  if (mergedS.status === 'fulfilled' && !mergedS.value.present && mergedS.value.reason) status.merged_audio_reason = mergedS.value.reason
  for (const settled of [audioS, imageS, mergedS]) {
    if (settled.status === 'rejected') flagTransientReadError(status, settled.reason)
  }

  // Video-assembly completion requires the canonical final filename, usable
  // canonical/reconciled/legacy YouTube evidence, or the same canonical final
  // at the configured external root.
  try {
    const ideasList = await getIdeasOnce()
    const CODE = code.toUpperCase()
    const idea = ideasList.find(i => (i.episode_code || '').toUpperCase() === CODE)
    const title = idea?.title || ''
    const paths = await resolveEpisodePaths(slug, code, title, cache)

    // Track the absolute path of whichever final-video candidate matched
    // first. Used at the end to stat the file and surface its size on the
    // upload page. Null when only the sidecar path (D) confirmed assembly.
    let finalVideoAbsPath: string | null = null

    // Path A + B — inside video_dir
    const finalInVideoDir = await findCanonicalFinal(paths.video_dir, code)
    const hasFinalInVideoDir = !!finalInVideoDir
    if (finalInVideoDir) finalVideoAbsPath = path.join(paths.video_dir, finalInVideoDir)

    // Path D — a usable remote copy survives local cleanup. A merely accepted,
    // failed, rejected, or uncertain provider identity is not completion.
    let hasUsableRemote = false
    if (!hasFinalInVideoDir) {
      try {
        const { usableYouTubeRemoteEvidence, youtubeRetentionEvidenceFor } = await import('./youtube-remote-video.js')
        const evidence = await youtubeRetentionEvidenceFor(slug, code, title, undefined, undefined, cache)
        hasUsableRemote = usableYouTubeRemoteEvidence(evidence).usable
      } catch { /* unreadable/corrupt evidence cannot claim completion */ }
    }

    // Path E — external final-video root (per-machine app setting).
    // When the user configured `external_final_video_root` in
    // app-settings, video-assembly writes finals to
    //   {root}/{slug}/Season NNN/{code} - {title}/{code}_final_video.{ext}
    // mirroring the project tree. Detection looks there too so the
    // pipeline view sees finals that live outside the project folder.
    let hasFinalAtExternalRoot = false
    if (!hasFinalInVideoDir && !hasUsableRemote) {
      try {
        const { resolveExternalFinalVideoDir } = await import('./external-video-store.js')
        const externalDir = await resolveExternalFinalVideoDir(slug, code, title, cache)
        if (externalDir) {
          const extFinal = await findCanonicalFinal(externalDir, code)
          if (extFinal) {
            hasFinalAtExternalRoot = true
            finalVideoAbsPath = path.join(externalDir, extFinal)
          }
        }
      } catch { /* external root unset or unreadable → leave false */ }
    }

    // An explicit visual-source selection is part of the render's identity.
    // New Image Pool picks and source switches rewrite broll-selection.json;
    // a prior final must not keep the episode looking complete unless the
    // render left a matching source stamp beside that final. Legacy Scene
    // Plan finals without a stamp remain compatible with the old status rule.
    let sourceStampValid = true
    if (finalVideoAbsPath && (hasFinalInVideoDir || hasFinalAtExternalRoot)) {
      try {
        const source = await readVideoVisualSource(slug, CODE, cache)
        const requiresBrollProof = videoVisualSourceRequiresBrollProof(source)
        const stampPath = videoAssemblySourceStampPath(finalVideoAbsPath, CODE)
        const stampRaw = await fs.readFile(stampPath, 'utf8').catch(() => null)
        if (stampRaw) {
          const stamp = JSON.parse(stampRaw) as VideoAssemblySourceStamp
          if (stamp.broll_assembly || requiresBrollProof) {
            sourceStampValid = (await inspectBrollAssemblyOutput({
              project_slug: slug,
              episode_id: CODE,
              title,
              final_video_path: finalVideoAbsPath,
            })).complete
          } else {
            const finalStat = await fs.stat(finalVideoAbsPath)
            sourceStampValid = videoAssemblySourceStampMatches(stamp, source, CODE)
              && (!stamp.final_video
                || (stamp.final_video.size === finalStat.size
                  && stamp.final_video.mtime_ms === Math.round(finalStat.mtimeMs)))
          }
        } else if (source.source === 'image_pool' || requiresBrollProof) {
          // Explicit Image Pool renders are required to carry a stamp. This
          // also fails closed for a B-Roll pick whose rendered narration is
          // unknown, while unstamped legacy Scene Plan finals remain valid.
          sourceStampValid = false
        }
      } catch {
        sourceStampValid = false
      }
    }

    status.video_assembly = hasFinalInVideoDir
      || hasUsableRemote
      || hasFinalAtExternalRoot
    status.video_assembly = status.video_assembly && sourceStampValid

    // Surface file size for whichever local path matched. Sidecar-only
    // (path D) leaves this undefined — by design, since the local file
    // may have been deleted post-upload.
    if (finalVideoAbsPath) {
      try {
        const st = await fs.stat(finalVideoAbsPath)
        if (st.isFile() && st.size > 0) status.final_video_bytes = st.size
      } catch { /* file disappeared between readdir + stat — leave undefined */ }
    }
  } catch {
    status.video_assembly = false
  }

  // ── Per-episode overrides (Part 1 of mark-done plan) ───────────────────
  // Look up the idea record for this episode; apply marked_done short-circuit
  // first (returns all-true so the pipeline view stops nagging on YouTube
  // imports / hand-made legacy episodes), then per-asset overrides on top of
  // the file-detected status. Empty/absent overrides → today's behavior
  // unchanged.
  try {
    const ideasList = await getIdeasOnce()
    const CODE = code.toUpperCase()
    const idea = ideasList.find(i => (i.episode_code || '').toUpperCase() === CODE)
    if (idea?.marked_done === true) {
      return allDoneStatus(status)
    }
    if (idea?.status_overrides) {
      // Overrides only carry the boolean asset-presence flags — the
      // `final_video_bytes` numeric field is detected from disk, never
      // overridden.  Cast through `Record` to silence the union-narrowing
      // that the new optional number field introduces.
      const overrides = idea.status_overrides as Record<string, unknown>
      const target = status as unknown as Record<string, unknown>
      for (const k of Object.keys(overrides)) {
        const v = overrides[k]
        if (typeof v === 'boolean' && k in target) {
          target[k] = v
        }
      }
    }
  } catch { /* if we can't load ideas, fall through with detected status — back-compat */ }

  return status
}

/**
 * Phase 1 helper — marks the manually completed production assets true while
 * preserving independent evidence and optional-stage status from detection.
 *
 * Marking an episode done is not evidence that Research was generated or that
 * an enabled optional stage has a valid resolved artifact.
 */
function allDoneStatus(detected: EpisodeStatus): EpisodeStatus {
  const status: EpisodeStatus = {
    ...detected,
    scene_plan: true, scene_review: true, motion_review: true,
    character_sheet: true,
    script: true, introduction: true,
    scene_prompts: true, thumb_prompts: true,
    metadata: true,
    images: true, thumbnails: true,
    audio: true, merged_audio: true,
    subtitles: true,
    broll_picked: true,
    video: true,
    video_assembly: true,
    ...(detected.music_episode !== undefined ? { music_episode: true } : {}),
  }
  return status
}
