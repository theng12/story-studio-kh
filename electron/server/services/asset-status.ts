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

import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { parseImagePromptsDocx } from '../lib/docx-parser.js'
import {
  resolveEpisodePaths,
  resolveEpisodePathsByCodeWithSidecar,
  resolveSubfolderNames,
  projectConfigOnce,
  type ProjectFactsCache,
  resolveScenePlanPath,
} from './utils.js'
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
import { getAudioStatus } from './audio-reconciler.js'
import { inspectChunkedScriptCompletion } from '../lib/chunked-narration.js'
import { inspectScenePromptIntegrity } from './scene-prompt-integrity.js'
import { readSubtitleTimelineIntegrity } from './scene-timeline-integrity.js'
import { inspectSubtitleCompletion } from './subtitle-completion.js'
import { inspectPromptCompletion } from './prompt-completion.js'
import { inspectMetadataCompletion } from './metadata-completion.js'
import { inspectScenePlanCoverage } from './scene-planner.js'
import { inspectSceneReviewCompletion } from './scene-review-completion.js'
import { normalizeContextualCueConfig, readContextualCueTimeline, validateContextualCueTimeline } from './contextual-cues.js'
import { DEFAULT_SOUND_DESIGN_SETTINGS, normalizeSoundDesignConfig, readSoundDesignTimeline, validateSoundDesignTimeline } from './sound-design.js'

// ── Shared helpers ─────────────────────────────────────────────────────────

async function safeReaddir(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir) } catch { return [] }
}

/**
 * v1.0.78 — readdir variant that distinguishes "folder is empty" from
 * "couldn't read folder". The status-detection compute uses the rich
 * variant for the four primary watched folders (script / scene_prompts /
 * thumb_prompts / metadata) so the cache can refuse to persist a
 * `script: false` result that came from an iCloud-truncated readdir.
 *
 * `errored` distinguishes TRANSIENT failures (EBUSY, EPERM, EACCES,
 * EIO — typically iCloud transience) from PERMANENT "not there yet"
 * states (ENOENT, ENOTDIR — folder hasn't been created because the user
 * hasn't run the generator yet, or iCloud hasn't synced the episode at
 * all). The `not there yet` state is correctly a `false` we should
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
    // Anything else (EBUSY / EPERM / EACCES / EIO / EMFILE / iCloud
    // transient) is unreliable — the folder may exist with files, we
    // just couldn't enumerate them. Don't let the cache freeze that.
    return { files: [], errored: true }
  }
}

/**
 * Users (and cloud-sync tools) sometimes prefix folders with ✅, ✔️, or other
 * decorative marks to signal completion. Strip them before matching the
 * episode code so detection doesn't silently flip to false.
 */
export function stripDecorativePrefix(name: string): string {
  return name.replace(/^[\s\p{Emoji}\p{Symbol}✅✔️]+/u, '').trim()
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

async function fileHasContent(p: string): Promise<boolean> {
  try {
    if (!existsSync(p)) return false
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
): Promise<string | null> {
  const CODE = code.toUpperCase()

  if (cache) {
    // Keyed by root as well as slug: a project whose media_root moves mid-cache
    // must not be answered from the previous root's index.
    if (!cache.episodeDirs || cache.episodeDirs.root !== projectDir) {
      cache.episodeDirs = { root: projectDir, index: buildEpisodeDirOrder(projectDir) }
    }
    try {
      for (const entry of await cache.episodeDirs.index) {
        if (entry.upper.startsWith(CODE)) return entry.path
      }
      return null
    } catch {
      // A failed walk must not be remembered as "no such episode" for the rest
      // of the request — drop it and fall through to the direct search.
      cache.episodeDirs = undefined
    }
  }

  async function search(dir: string, depth: number): Promise<string | null> {
    if (depth > 4) return null
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const clean = stripDecorativePrefix(e.name).toUpperCase()
        if (clean.startsWith(CODE)) return path.join(dir, e.name)
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const found = await search(path.join(dir, e.name), depth + 1)
        if (found) return found
      }
    } catch { /* skip */ }
    return null
  }
  return search(projectDir, 0)
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
): Promise<ImageStatus> {
  const code = episodeId.toUpperCase()

  // Resolve prompts + dirs. Either file may be missing (e.g. only scene
  // prompts generated so far); the mode reflects what we actually found.
  let scenePromptsPath: string | null = null
  let thumbPromptsPath: string | null = null
  if (mode === 'all') {
    try { scenePromptsPath = await findScenePromptsFile(slug, episodeId) } catch { /* no scene prompts yet */ }
  }
  if (knownPaths) {
    const candidate = resolveReadPath(knownPaths.thumb_prompts_docx)
    if (existsSync(candidate)) thumbPromptsPath = candidate
  } else {
    try { thumbPromptsPath = await findThumbPromptsFile(slug, episodeId) } catch { /* no thumb prompts yet */ }
  }

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
  const { bgDir, thumbDir } = dirs

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

// ── Video (Veo / fal / kie-video) ──────────────────────────────────────────

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
    return recurse(root)
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
  const epDir = await findEpisodeDir(outputRoot, code)
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

export interface AudioMergeStatus {
  present: boolean            // is there at least one merged file with content?
  file?: string               // filename of newest merged output (v1 or v{N})
  dir?: string
}

/**
 * Is there a `{code}_merged_audio(_v{N})?.mp3` file with content?
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
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) return { present: false }

  const epDir = await findEpisodeDir(outputRoot, code, cache)
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
  const subfolder = (await resolveSubfolderNames(slug, code, cache)).merged_audio

  // Scan with/without decorative prefixes (✅, ✔️, etc.) for flexibility.
  const entries = await safeReaddir(epDir)
  let mergedDir: string | null = null
  for (const entry of entries) {
    const clean = stripDecorativePrefix(entry)
    if (clean === subfolder) { mergedDir = path.join(epDir, entry); break }
  }
  if (!mergedDir) return { present: false }

  const files = await safeReaddir(mergedDir)
  const re = new RegExp(`^${code}_merged_audio(?:_v(\\d+))?\\.mp3$`)
  let best: { version: number; file: string } | null = null
  for (const f of files) {
    const m = f.match(re)
    if (!m) continue
    if (!await fileHasContent(path.join(mergedDir, f))) continue
    const v = m[1] ? parseInt(m[1], 10) : 1
    if (!best || v > best.version) best = { version: v, file: f }
  }

  if (!best) return { present: false, dir: mergedDir }
  const completionPath = path.join(mergedDir, `${code}_merged_audio.completion.json`)
  if (existsSync(completionPath)) {
    try {
      const completion = JSON.parse(await fs.readFile(completionPath, 'utf-8'))
      const finalPath = path.join(mergedDir, best.file)
      const stat = await fs.stat(finalPath)
      const verified = completion?.output_filename === best.file
        && Number(completion?.bytes) === stat.size
        && stat.size > 0
        && Number(completion?.duration_sec) > 0
      if (!verified) return { present: false, file: best.file, dir: mergedDir }
    } catch { return { present: false, file: best.file, dir: mergedDir } }
  }
  return { present: true, file: best.file, dir: mergedDir }
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
    const [audio, images, video, merged] = await Promise.allSettled([
      getAudioStatus(slug, code),
      getImageStatus(slug, code),
      getVideoStatus(slug, code),
      getAudioMergeStatus(slug, code),
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
      if (images.value.thumbnails) {
        row.thumbnails = {
          total: images.value.thumbnails.total,
          present: images.value.thumbnails.present,
          missing: images.value.thumbnails.missing.length,
        }
      }
    } else {
      row.errors!.images = (images.reason as any)?.message || 'image check failed'
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
   * during this compute (typically iCloud transience: subfolder evicted,
   * EBUSY mid-sync, etc.). The episode-status cache reads this flag and
   * refuses to persist the entry, forcing a fresh recompute on the next
   * read. Underscore-prefixed so consumers know it's not a real status
   * boolean to render in the UI.
   */
  _unreliable?: boolean
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
    if (_isVideoFile(file) && file.startsWith(`${code}_final_video.`)
      && await fileHasContent(path.join(dir, file))) return file
  }
  return null
}

export async function hasFinalVideoFast(
  slug: string,
  code: string,
  title: string,
): Promise<boolean> {
  try {
    // Path A: project tree (canonical _final_video, or any non-scene mp4).
    const paths = await resolveEpisodePaths(slug, code, title || '')
    if (await findCanonicalFinal(paths.video_dir, code)) return true

    // Path B: external_final_video_root (per-machine Settings → Storage).
    // Mirror Path E in computeEpisodeStatus so the upload queue and the
    // pipeline-status detector never disagree about whether a final
    // exists. Without this branch, an episode whose final lives at the
    // user's external root would have video_assembly: true on the
    // pipeline page but be missing from the upload queue.
    try {
      const { resolveExternalFinalVideoDir } = await import('./external-video-store.js')
      const externalDir = await resolveExternalFinalVideoDir(slug, code, title || '')
      if (externalDir) {
        if (await findCanonicalFinal(externalDir, code)) return true
      }
    } catch { /* external store not configured / import failure → skip */ }

    return false
  } catch {
    return false
  }
}

/**
 * Cheap byte-size lookup for the final assembled video. Mirrors the
 * project-tree + external-root paths used by `hasFinalVideoFast`, then
 * stats the matched file. Returns `undefined` when nothing was found —
 * the upload page renders that as an em-dash chip ("file not local").
 *
 * Two-path scan only (no episode_dir / sidecar / "Output" subfolder
 * walk like `computeEpisodeStatus`): the queue is paginated and runs
 * this per visible row, so we keep it tight. Anything more exotic that
 * the user produced themselves shows up as size-unknown — same UX as
 * sidecar-only uploads where the local file was deleted.
 */
export async function getFinalVideoBytes(
  slug: string,
  code: string,
  title: string,
): Promise<number | undefined> {
  try {
    const paths = await resolveEpisodePaths(slug, code, title || '')
    const localMatch = await findCanonicalFinal(paths.video_dir, code)
    if (localMatch) {
      const st = await fs.stat(path.join(paths.video_dir, localMatch)).catch(() => null)
      if (st?.isFile() && st.size > 0) return st.size
    }
    try {
      const { resolveExternalFinalVideoDir } = await import('./external-video-store.js')
      const externalDir = await resolveExternalFinalVideoDir(slug, code, title || '')
      if (externalDir) {
        const extMatch = await findCanonicalFinal(externalDir, code)
        if (extMatch) {
          const st = await fs.stat(path.join(externalDir, extMatch)).catch(() => null)
          if (st?.isFile() && st.size > 0) return st.size
        }
      }
    } catch { /* external store not configured → skip */ }
    return undefined
  } catch {
    return undefined
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
  const { getProjectOutputRoot } = await import('./project-manager.js')
  const outputRoot = await getProjectOutputRoot(slug)
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
    const paths = await resolveEpisodePaths(slug, code, title, cache)
    authoritativePaths = paths

    // v1.0.78: use the rich `safeReaddirRich` variant so we can tell apart
    // "folder is genuinely empty" from "couldn't read folder" (iCloud
    // transience: subfolder evicted, EBUSY mid-sync, ENOENT during a
    // just-delivered move). The four primary watched folders directly
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
      : thumbPromptFiles.some(f => f.endsWith('.docx') || f.endsWith('.md'))
    const metadataCompletion = await inspectMetadataCompletion(paths.metadata_dir, code)
    status.metadata = metadataCompletion.authoritative
      ? metadataCompletion.complete
      : metadataFiles.some(f => f.endsWith('.txt') || (f.endsWith('.json') && !f.endsWith('.completion.json')) || f.endsWith('.md'))

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
    } catch {
      status.subtitles = false
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
    } catch {
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
      const planPath = await resolveScenePlanPath(slug, code, byCode.episode_dir)
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
        const subtitleIntegrity = await readSubtitleTimelineIntegrity(byCode.subtitles_dir, code)
        const coverageIntegrity = inspectScenePlanCoverage(plan)
        status.scene_plan = scenes.length > 0
          && promptIntegrity.complete
          && subtitleIntegrity.complete
          && (!coverageIntegrity.authoritative || coverageIntegrity.complete)
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
        const namedDir = await resolveSceneImagesDir(slug, code.toUpperCase(), byCode.episode_dir)
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
        status.scene_review = inspectSceneReviewCompletion(
          scenes,
          imageReady,
          status.scene_plan,
        ).complete
        const clipsDir = await resolveVideoAssetsDir(slug, code.toUpperCase(), byCode.episode_dir)
        const motionReady = await Promise.all(scenes.map(async (s: any) => {
          if (s?.motion_choice === 'still') return true
          const hasClip = typeof s?.id === 'string' && await fileHasContent(path.join(clipsDir, `${s.id}.mp4`))
          if (!hasClip || s?.motion_choice === 'pending') return false
          if (typeof s?.rendered_motion_prompt === 'string' && s.rendered_motion_prompt !== (s.motion_prompt || '')) return false
          if (typeof s?.image_version === 'string' && s.clip_source_image_version !== s.image_version) return false
          return s?.motion_choice === 'clip' || s?.motion_choice == null
        }))
        status.motion_review = scenes.length > 0 && motionReady.every(Boolean)
      }
    } catch { /* unresolved / unreadable plan → leave both false */ }

    // If ANY of the four primary readdirs errored, mark the entire status
    // unreliable. The cache will skip persistence and the next read will
    // recompute — by which point iCloud has usually settled. False
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
    const dir = await findEpisodeDir(outputRoot, code, cache)
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
                : files.some((f: string) => f.endsWith('.docx') || f.endsWith('.md'))
            }
            if (cleanSub.includes('metadata') || cleanSub.includes('description')) {
              const completion = await inspectMetadataCompletion(subPath, code)
              status.metadata = completion.authoritative
                ? completion.complete
                : files.some((f: string) => f.endsWith('.txt') || (f.endsWith('.json') && !f.endsWith('.completion.json')) || f.endsWith('.md'))
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

  status.thumbnails = imageS.status === 'fulfilled'
    && !!imageS.value.thumbnails
    && imageS.value.thumbnails.total > 0
    && imageS.value.thumbnails.missing.length === 0

  status.merged_audio = mergedS.status === 'fulfilled' && mergedS.value.present

  // Video-assembly completion requires the canonical final filename, a valid
  // upload sidecar, or the same canonical final at the configured external root.
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

    // Path D — YouTube sidecar shows uploaded. Once `video_id` is set in
    // {episode_dir}/youtube_upload.json, the local final video is
    // operationally redundant — the canonical copy lives on YouTube.
    // Treating sidecar-uploaded as `video_assembly: true` lets the user
    // delete the local file (manually or via the Storage UI) without
    // the pipeline nagging about a "missing" assembly. The sidecar
    // itself is small (a few KB) and is always inside episode_dir, so
    // it survives any iCloud-sync cleanup the user did on the videos.
    let hasSidecarUploaded = false
    if (!hasFinalInVideoDir) {
      try {
        const { readSidecar } = await import('./upload-sidecar.js')
        const sc = await readSidecar(slug, code, title, 'youtube')
        if (sc?.video_id) hasSidecarUploaded = true
      } catch { /* sidecar missing or unreadable → leave false */ }
    }

    // Path E — external final-video root (per-machine app setting).
    // When the user configured `external_final_video_root` in
    // app-settings, video-assembly writes finals to
    //   {root}/{slug}/Season NNN/{code} - {title}/{code}_final_video.{ext}
    // mirroring the project tree. Detection looks there too so the
    // pipeline view sees finals that live outside the iCloud-synced
    // project folder.
    let hasFinalAtExternalRoot = false
    if (!hasFinalInVideoDir && !hasSidecarUploaded) {
      try {
        const { resolveExternalFinalVideoDir } = await import('./external-video-store.js')
        const externalDir = await resolveExternalFinalVideoDir(slug, code, title)
        if (externalDir) {
          const extFinal = await findCanonicalFinal(externalDir, code)
          if (extFinal) {
            hasFinalAtExternalRoot = true
            finalVideoAbsPath = path.join(externalDir, extFinal)
          }
        }
      } catch { /* external root unset or unreadable → leave false */ }
    }

    status.video_assembly = hasFinalInVideoDir
      || hasSidecarUploaded
      || hasFinalAtExternalRoot

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
  }
  return status
}
