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
import { unwrapICloudPlaceholderName } from '../lib/sync-safe.js'
import { resolveEpisodePaths, resolveEpisodePathsByCode, resolveSubfolderNames } from './utils.js'
import { resolveResearchPaths } from '../lib/research-paths.js'
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import {
  findScenePromptsFile, findThumbPromptsFile, resolveImageDirs,
} from '../generators/images.js'
import { DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'
import { getAudioStatus } from './audio-reconciler.js'

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
  // Match against the unwrapped name so an iCloud placeholder
  // (`.foo.intro.json.icloud`) still counts as "introduction present"
  // — the file exists, it just hasn't been materialized locally yet.
  const name = unwrapICloudPlaceholderName(filename)
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
  // unified-narration file, by spec. Unwrap iCloud placeholder names so a
  // synced-but-not-yet-downloaded file is still detected as present
  // (otherwise the app would offer to regenerate over a file that's mid-sync).
  const name = unwrapICloudPlaceholderName(filename)
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

async function fileHasContent(p: string): Promise<boolean> {
  try {
    if (!existsSync(p)) return false
    const st = await fs.stat(p)
    return st.size > 0
  } catch { return false }
}

async function findEpisodeDir(projectDir: string, code: string): Promise<string | null> {
  const CODE = code.toUpperCase()
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
 * Looser-detection fallback: when no prompts docx exists, scan the
 * canonical bg + thumb directories for `{code}_Scene{NN}_v*.png` and
 * `{code}_Thumb{NN}_v*.png` files. Each unique scene/thumb number with at
 * least one non-empty variant counts as "present". Total === present so
 * the caller treats the asset bundle as complete.
 *
 * Used by Situation B (pre-Story-Studio episodes whose user has placed
 * hand-named files in the canonical folders but never had us generate
 * prompts docs for them). Additive — episodes that DO have prompts go
 * through the strict expected-vs-present path above.
 */
async function detectImagesWithoutPrompts(slug: string, code: string): Promise<ImageStatus> {
  // Resolve the canonical bg + thumb dirs without going through
  // resolveImageDirs (which derives them from a prompts file path). We
  // need an episode title to plug into the folder template — pull it
  // from the accepted-ideas list. If the title can't be resolved we just
  // bail to the empty `{ mode: 'all' }` shape the original code returned.
  const ideas = await im.getIdeas(slug, 'accepted')
  const idea = ideas.find(i => (i.episode_code || '').toUpperCase() === code.toUpperCase())
  if (!idea) return { mode: 'all' }

  let paths: any
  try {
    paths = await resolveEpisodePaths(slug, code, idea.title || '')
  } catch {
    return { mode: 'all' }
  }
  const bgDir: string = paths.bg_dir
  const thumbDir: string = paths.thumb_dir

  // For each *_Scene{NN}_v*.png present (with content), bucket by NN. If
  // any bucket has ≥1 non-empty variant, it counts. We treat the SET of
  // discovered numbers as the expected set (no docx = no expectation gap).
  async function discoverNumbers(dir: string, kind: 'Scene' | 'Thumb'): Promise<number[]> {
    const files = await safeReaddir(dir)
    const re = new RegExp(`^${code}_${kind}(\\d{1,3})_v\\d+\\.png$`, 'i')
    const buckets = new Map<number, string[]>()
    for (const f of files) {
      const m = f.match(re)
      if (!m) continue
      const n = parseInt(m[1], 10)
      const arr = buckets.get(n) || []
      arr.push(f)
      buckets.set(n, arr)
    }
    const present: number[] = []
    for (const [n, fs] of buckets.entries()) {
      // Need ≥1 variant with content for the scene/thumb to count.
      let ok = false
      for (const f of fs) {
        if (await fileHasContent(path.join(dir, f))) { ok = true; break }
      }
      if (ok) present.push(n)
    }
    return present.sort((a, b) => a - b)
  }

  const sceneNumbers = await discoverNumbers(bgDir, 'Scene')
  const thumbNumbers = await discoverNumbers(thumbDir, 'Thumb')

  // Empty + empty → unchanged "no signal" shape so consumers see the
  // same `{ mode: 'all' }` they used to. Only emit per-bucket counts when
  // we actually found files.
  const result: ImageStatus = { mode: 'all', dir: { bg: bgDir, thumb: thumbDir } }
  if (sceneNumbers.length > 0) {
    result.scenes = { total: sceneNumbers.length, present: sceneNumbers.length, missing: [] }
  }
  if (thumbNumbers.length > 0) {
    result.thumbnails = { total: thumbNumbers.length, present: thumbNumbers.length, missing: [] }
  }
  return result
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
export async function getImageStatus(slug: string, episodeId: string): Promise<ImageStatus> {
  const code = episodeId.toUpperCase()

  // Resolve prompts + dirs. Either file may be missing (e.g. only scene
  // prompts generated so far); the mode reflects what we actually found.
  let scenePromptsPath: string | null = null
  let thumbPromptsPath: string | null = null
  try { scenePromptsPath = await findScenePromptsFile(slug, episodeId) } catch { /* no scene prompts yet */ }
  try { thumbPromptsPath = await findThumbPromptsFile(slug, episodeId) } catch { /* no thumb prompts yet */ }

  if (!scenePromptsPath && !thumbPromptsPath) {
    // Fallback: looser, prompts-less detection (Situation B).
    // Pre-Story-Studio episodes often have hand-named scene/thumb PNGs on
    // disk without an accompanying prompts docx (because the user authored
    // them outside our flow). Treat the files themselves as authoritative
    // — count every {code}_Scene{NN}_v*.png as one present scene with NO
    // expectation gap (total = present, missing = []), so the pipeline
    // treats it as "complete" and stops asking for regenerations.
    //
    // We only fall through to this path when BOTH prompts are absent —
    // if even one prompts docx exists, the existing expected-vs-present
    // logic above is honoured (so partial gens still flag correctly).
    return await detectImagesWithoutPrompts(slug, code)
  }

  const promptsPathForDirs = scenePromptsPath || thumbPromptsPath!
  const { bgDir, thumbDir } = await resolveImageDirs(slug, promptsPathForDirs, episodeId)

  const result: ImageStatus = { mode: 'all', dir: { bg: bgDir, thumb: thumbDir } }

  if (scenePromptsPath) {
    const parsed = await parseImagePromptsDocx(scenePromptsPath)
    const expected = parsed.scenes.map(s => s.number)
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
    const expected = parsed.thumbnails.map(t => t.number)
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
    // Looser-detection fallback (Situation B): no prompts docx but the
    // user may have hand-placed `{code}_Video{NN}_v*.mp4` clips into the
    // canonical video dir. Treat each present clip as one expected slot
    // (total === present), so the pipeline reports video as complete and
    // stops nagging. Episodes WITH a prompts docx still hit the strict
    // expected-vs-present path below.
    const names = await resolveSubfolderNames(slug, code)
    const epDir = await findEpisodeDir(outputRoot, code)
    if (!epDir) return { total: 0, present: 0, missing: [] }
    const videoDir = path.join(epDir, names.video)
    const files = await safeReaddir(videoDir)
    const re = new RegExp(`^${code}_Video(\\d{1,3})_v\\d+\\.mp4$`, 'i')
    const buckets = new Map<number, string[]>()
    for (const f of files) {
      const m = f.match(re)
      if (!m) continue
      const n = parseInt(m[1], 10)
      const arr = buckets.get(n) || []
      arr.push(f)
      buckets.set(n, arr)
    }
    const present: number[] = []
    for (const [n, fs] of buckets.entries()) {
      let ok = false
      for (const f of fs) {
        if (await fileHasContent(path.join(videoDir, f))) { ok = true; break }
      }
      if (ok) present.push(n)
    }
    if (present.length === 0) return { total: 0, present: 0, missing: [], dir: videoDir }
    return { total: present.length, present: present.length, missing: [], dir: videoDir }
  }

  const parsed = await parseImagePromptsDocx(promptsPath)
  // Video generator uses the same "scenes" numbering from the prompts doc;
  // see ai-video.ts loadPrompts(). Scene prompts carry `number` + `title`.
  const expected = parsed.scenes.map(s => s.number)

  const names = await resolveSubfolderNames(slug, code)
  const epDir = await findEpisodeDir(outputRoot, code)
  if (!epDir) return { total: expected.length, present: 0, missing: expected }
  const videoDir = path.join(epDir, names.video)

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
export async function getAudioMergeStatus(slug: string, episodeId: string): Promise<AudioMergeStatus> {
  const code = episodeId.toUpperCase()
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) return { present: false }

  const epDir = await findEpisodeDir(outputRoot, code)
  if (!epDir) return { present: false }

  // Resolve merged_audio subfolder name from project config (same logic
  // as audio-merge generator's resolveMergedAudioName).
  let subfolder: string
  try {
    const metaRaw = await fs.readFile(
      // Linked-aware: read project.json from the actual project dir,
      // not the default-location guess.
      path.join(pm.getProjectDir(slug) || path.join(pm.PROJECTS_ROOT, slug), 'project.json'), 'utf-8',
    )
    const meta = JSON.parse(metaRaw)
    const tmpl = meta.subfolder_names?.merged_audio || DEFAULT_SUBFOLDER_NAMES.merged_audio
    subfolder = tmpl.replace('{code}', code)
  } catch {
    subfolder = DEFAULT_SUBFOLDER_NAMES.merged_audio.replace('{code}', code)
  }

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
export async function auditProjectAssets(slug: string): Promise<EpisodeAuditRow[]> {
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
  const queue = ideas.filter(i => i.episode_code)
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
//   - script / introduction / scene_prompts / thumb_prompts / metadata:
//     cheap source-doc presence checks in the episode folder
//   - images / thumbnails / audio / merged_audio / video: authoritative
//     asset-reconciler checks (partial generations report as NOT done)

export interface EpisodeStatus {
  // Research sidecar (`research.json`) present at the episode_dir root.
  // Only the research-driven formats (timestamp-driven, continuity-chain)
  // produce it; it's the field the Research page filters its "pending"
  // episode list by, so a finished research run drops out of pending.
  // NOT folded into all_done — research is optional for most formats.
  research: boolean
  // v1.0.273 — timestamp/continuity scene plan (`scene_plan.json` at the
  // episode_dir root). This is what the Scene Plan page filters its "pending"
  // list by — distinct from `scene_prompts` (the legacy image-prompts docx) and
  // from `script` (an episode can have a full script + subtitles but no scene
  // plan yet). NOT folded into all_done — only the timestamp/continuity
  // pipelines produce it.
  scene_plan: boolean
  // v1.0.276 — Scene Review "done" for the timestamp/continuity pipeline: the
  // scene plan exists AND every scene has a generated image (image_path set in
  // the plan). Matches "I've generated all the scene images" — approval/
  // greenlight is a separate gate handled on the Video Assembly page. Distinct
  // from `images` (legacy naming, unreliable for the per-scene
  // scene_images/<id>.png layout). Drives the Scene Review "pending" filter.
  // NOT folded into all_done.
  scene_review: boolean
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
  // v1.0.352 — subtitle track present: at least one .srt/.vtt in the
  // subtitles_dir. The Subtitles page filters its "pending" list by this.
  // Previously the page borrowed `audio` as a proxy, so episodes that HAD
  // audio (i.e. were ready FOR subtitles) were wrongly hidden from pending.
  // Optional like research/scene_plan — NOT folded into all_done.
  subtitles: boolean
  video: boolean
  // Video-assembly final render — the single merged output that the
  // Video Assembly page produces. Named `{code}_final_video.{ext}` under
  // the episode's video_dir (same folder the per-scene clips live in).
  // Detected by file presence; absent = user still needs to run assembly.
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
    scene_plan: false, scene_review: false,
    character_sheet: false,
    script: false, introduction: false,
    scene_prompts: false, thumb_prompts: false,
    metadata: false,
    images: false, thumbnails: false,
    audio: false, merged_audio: false,
    subtitles: false,
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
function _isPerSceneClip(name: string): boolean {
  return /[_\- ]scene[_\- ]?\d+/i.test(name)
}

export async function hasFinalVideoFast(
  slug: string,
  code: string,
  title: string,
): Promise<boolean> {
  try {
    // Path A: project tree (canonical _final_video, or any non-scene mp4).
    const paths = await resolveEpisodePaths(slug, code, title || '')
    const videoDirFiles = await safeReaddir(paths.video_dir)
    if (videoDirFiles.some(f =>
      _isVideoFile(f) && (f.startsWith(`${code}_final_video.`) || !_isPerSceneClip(f)),
    )) return true

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
        const extFiles = await safeReaddir(externalDir)
        if (extFiles.some(f => _isVideoFile(f) && f.startsWith(`${code}_final_video.`))) return true
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
    const videoDirFiles = await safeReaddir(paths.video_dir)
    const localMatch = videoDirFiles.find(f =>
      _isVideoFile(f) && (f.startsWith(`${code}_final_video.`) || !_isPerSceneClip(f)),
    )
    if (localMatch) {
      const st = await fs.stat(path.join(paths.video_dir, localMatch)).catch(() => null)
      if (st?.isFile() && st.size > 0) return st.size
    }
    try {
      const { resolveExternalFinalVideoDir } = await import('./external-video-store.js')
      const externalDir = await resolveExternalFinalVideoDir(slug, code, title || '')
      if (externalDir) {
        const extFiles = await safeReaddir(externalDir)
        const extMatch = extFiles.find(f => _isVideoFile(f) && f.startsWith(`${code}_final_video.`))
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
): Promise<EpisodeStatus> {
  const { getProjectOutputRoot } = await import('./project-manager.js')
  const outputRoot = await getProjectOutputRoot(slug)
  if (!outputRoot) return emptyStatus()

  const status = emptyStatus()

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
    const paths = await resolveEpisodePaths(slug, code, title)

    // v1.0.78: use the rich `safeReaddirRich` variant so we can tell apart
    // "folder is genuinely empty" from "couldn't read folder" (iCloud
    // transience: subfolder evicted, EBUSY mid-sync, ENOENT during a
    // just-delivered move). The four primary watched folders directly
    // determine the boolean status fields below; an errored read on any
    // of them poisons the result and we surface that via `_unreliable`
    // so the cache can refuse to persist it.
    const [scriptR, scenePromptR, thumbPromptR, metadataR] = await Promise.all([
      safeReaddirRich(paths.script_dir),
      safeReaddirRich(paths.scene_prompts_dir),
      safeReaddirRich(paths.thumb_prompts_dir),
      safeReaddirRich(paths.metadata_dir),
    ])
    const scriptFiles = scriptR.files
    const scenePromptFiles = scenePromptR.files
    const thumbPromptFiles = thumbPromptR.files
    const metadataFiles = metadataR.files

    const scriptState = deriveScriptFolderState(scriptFiles)
    status.script = scriptState.script
    status.introduction = scriptState.introduction
    status.scene_prompts = scenePromptFiles.some(f => f.endsWith('.docx') || f.endsWith('.md') || f.endsWith('.json'))
    status.thumb_prompts = thumbPromptFiles.some(f => f.endsWith('.docx') || f.endsWith('.md') || f.endsWith('.json'))
    status.metadata = metadataFiles.some(f => f.endsWith('.txt') || f.endsWith('.json') || f.endsWith('.md'))

    // v1.0.352 — subtitles done = at least one .srt/.vtt in the subtitles
    // folder (per-chapter {code}_{slug}.srt, {code}_whisper.srt, a stitched
    // SRT, or an imported track all count). Scanned separately so a transient
    // subtitles-folder read error doesn't poison the four-folder _unreliable
    // check above — it just leaves subtitles:false to recompute next pass.
    const subtitleR = await safeReaddirRich(paths.subtitles_dir)
    status.subtitles = subtitleR.files.some(f => f.endsWith('.srt') || f.endsWith('.vtt'))

    // Research sidecar now lives in the "{code} - 11 Research" folder
    // (resolveResearchPaths auto-migrates any legacy loose copy). episode_dir
    // is a watched folder for the cache, so a freshly written research file
    // advances its mtime and invalidates the entry.
    status.research = await fileHasContent((await resolveResearchPaths(paths.episode_dir, code)).jsonPath)

    // v1.0.278 — scene_plan + scene_review resolve the REAL episode dir BY CODE
    // (how the generators write these), not the title-template path
    // resolveEpisodePaths builds. With the title path, a planned/rendered
    // episode whose idea title doesn't exactly match its folder (rename,
    // apostrophe/colon, empty title) resolved to a phantom dir → scene_plan.json
    // never found → episode wrongly read as pending. By-code is rename-proof.
    try {
      const byCode = await resolveEpisodePathsByCode(slug, code)
      // v1.0.361 — character sheet "done" = the episode's continuity config has
      // been saved (continuity.json at the episode_dir root). Same by-code
      // resolution as scene_plan so a renamed-folder episode still resolves.
      status.character_sheet = await fileHasContent(path.join(byCode.episode_dir, 'continuity.json'))
      const planPath = path.join(byCode.episode_dir, 'scene_plan.json')
      status.scene_plan = await fileHasContent(planPath)
      if (status.scene_plan) {
        const plan = JSON.parse(await fs.readFile(planPath, 'utf-8'))
        const scenes = Array.isArray(plan?.scenes) ? plan.scenes : []
        // Scene Review done = plan exists AND every scene has a generated image.
        status.scene_review = scenes.length > 0
          && scenes.every((s: any) => typeof s?.image_path === 'string' && s.image_path.length > 0)
      }
    } catch { /* unresolved / unreadable plan → leave both false */ }

    // If ANY of the four primary readdirs errored, mark the entire status
    // unreliable. The cache will skip persistence and the next read will
    // recompute — by which point iCloud has usually settled. False
    // positives are cheap (~10 fs ops to recompute). False negatives
    // (cached `script: false` for an episode whose script lives on disk)
    // are the actual user-visible bug we're closing.
    if (scriptR.errored || scenePromptR.errored || thumbPromptR.errored || metadataR.errored) {
      status._unreliable = true
    }

    authoritativeHit = status.script || status.introduction || status.scene_prompts
      || status.thumb_prompts || status.metadata

    if (process.env.SSKH_STATUS_DEBUG === '1') {
      console.log('[status-debug]', code, {
        script_dir: paths.script_dir, scriptFiles,
        scene_prompts_dir: paths.scene_prompts_dir,
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
    const dir = await findEpisodeDir(outputRoot, code)
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
              if (state.script) status.script = true
              if (state.introduction) status.introduction = true
            }
            if (cleanSub.includes('scene prompt')) {
              if (files.some((f: string) => f.endsWith('.docx') || f.endsWith('.md') || f.endsWith('.json'))) status.scene_prompts = true
            }
            if (cleanSub.includes('thumbnail prompt')) {
              if (files.some((f: string) => f.endsWith('.docx') || f.endsWith('.md') || f.endsWith('.json'))) status.thumb_prompts = true
            }
            if (cleanSub.includes('metadata') || cleanSub.includes('description')) {
              if (files.some((f: string) => f.endsWith('.txt') || f.endsWith('.json') || f.endsWith('.md'))) status.metadata = true
            }
          } catch {}
        }
      } catch {}
    }
  }

  // Authoritative completion checks. Partial generations (e.g. 9 of 10
  // audio chunks present) correctly resolve to false here.
  const { getAudioStatus } = await import('./audio-reconciler.js')
  const [audioS, imageS, videoS, mergedS] = await Promise.allSettled([
    getAudioStatus(slug, code),
    getImageStatus(slug, code),
    getVideoStatus(slug, code),
    getAudioMergeStatus(slug, code),
  ])

  status.audio = audioS.status === 'fulfilled'
    && audioS.value.expected.length > 0
    && audioS.value.missing.length === 0

  status.images = imageS.status === 'fulfilled'
    && !!imageS.value.scenes
    && imageS.value.scenes.total > 0
    && imageS.value.scenes.missing.length === 0

  status.thumbnails = imageS.status === 'fulfilled'
    && !!imageS.value.thumbnails
    && imageS.value.thumbnails.total > 0
    && imageS.value.thumbnails.missing.length === 0

  status.video = videoS.status === 'fulfilled'
    && videoS.value.total > 0
    && videoS.value.missing.length === 0

  status.merged_audio = mergedS.status === 'fulfilled' && mergedS.value.present

  // Video-assembly completion. Three detection paths, any one is enough:
  //   A. `{code}_final_video.*` in video_dir — what our native assembly writes.
  //   B. Any other video file in video_dir that's NOT a per-scene clip
  //      (per-scene clips are named `{code}_Scene*.{ext}` by the video
  //      generator, so anything else = likely a merged/manually-produced final).
  //   C. Any video file at the episode_dir root, OR inside a sibling folder
  //      whose name contains "final" / "assembled" / "output" — common places
  //      users drop a hand-made render. Case-insensitive.
  //
  // Broader than the original `{code}_final_video.*`-only check so that a
  // user who assembled the episode outside Story Studio (DaVinci, Premiere,
  // etc.) and copied the result into the episode folder stops appearing as
  // "pending" on the Pipeline page. Detection is intentionally loose rather
  // than conservative: false positives here just mean "Video Assembly" won't
  // auto-queue for that episode — easy to fix by deleting the stray file.
  const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v'])
  const isVideoFile = (name: string) => {
    const i = name.lastIndexOf('.')
    return i >= 0 && VIDEO_EXTS.has(name.slice(i).toLowerCase())
  }
  const isPerSceneClip = (name: string) => {
    // Matches `{code}_Scene_01.mp4`, `{code}_Scene01_v2.mov`, etc.
    // Case-insensitive on "scene" because user-renames sometimes lowercase it.
    return /[_\- ]scene[_\- ]?\d+/i.test(name)
  }
  try {
    const ideasList = await getIdeasOnce()
    const CODE = code.toUpperCase()
    const idea = ideasList.find(i => (i.episode_code || '').toUpperCase() === CODE)
    const title = idea?.title || ''
    const paths = await resolveEpisodePaths(slug, code, title)

    // Track the absolute path of whichever final-video candidate matched
    // first. Used at the end to stat the file and surface its size on the
    // upload page. Null when only the sidecar path (D) confirmed assembly.
    let finalVideoAbsPath: string | null = null

    // Path A + B — inside video_dir
    const videoDirFiles = await safeReaddir(paths.video_dir)
    const finalInVideoDir = videoDirFiles.find(f =>
      isVideoFile(f) && (f.startsWith(`${code}_final_video.`) || !isPerSceneClip(f)),
    )
    const hasFinalInVideoDir = !!finalInVideoDir
    if (finalInVideoDir) finalVideoAbsPath = path.join(paths.video_dir, finalInVideoDir)

    // Path C — episode_dir root + "final"/"assembled"/"output" subfolders
    let hasFinalAtEpisodeLevel = false
    if (!hasFinalInVideoDir) {
      try {
        const epEntries = await fs.readdir(paths.episode_dir, { withFileTypes: true })
        // Root-level videos (user dropped the finished file next to the folders)
        const rootVideo = epEntries.find(e => e.isFile() && isVideoFile(e.name))
        if (rootVideo) {
          hasFinalAtEpisodeLevel = true
          finalVideoAbsPath = path.join(paths.episode_dir, rootVideo.name)
        } else {
          // Sibling folders like "Final", "Assembled Output", "Exports"
          const finalishFolders = epEntries.filter(e => e.isDirectory()
            && /(final|assembl|output|export)/i.test(e.name))
          for (const f of finalishFolders) {
            const innerDir = path.join(paths.episode_dir, f.name)
            const inner = await safeReaddir(innerDir)
            const innerVideo = inner.find(n => isVideoFile(n))
            if (innerVideo) {
              hasFinalAtEpisodeLevel = true
              finalVideoAbsPath = path.join(innerDir, innerVideo)
              break
            }
          }
        }
      } catch { /* ignore */ }
    }

    // Path D — YouTube sidecar shows uploaded. Once `video_id` is set in
    // {episode_dir}/youtube_upload.json, the local final video is
    // operationally redundant — the canonical copy lives on YouTube.
    // Treating sidecar-uploaded as `video_assembly: true` lets the user
    // delete the local file (manually or via the Storage UI) without
    // the pipeline nagging about a "missing" assembly. The sidecar
    // itself is small (a few KB) and is always inside episode_dir, so
    // it survives any iCloud-sync cleanup the user did on the videos.
    let hasSidecarUploaded = false
    if (!hasFinalInVideoDir && !hasFinalAtEpisodeLevel) {
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
    if (!hasFinalInVideoDir && !hasFinalAtEpisodeLevel && !hasSidecarUploaded) {
      try {
        const { resolveExternalFinalVideoDir } = await import('./external-video-store.js')
        const externalDir = await resolveExternalFinalVideoDir(slug, code, title)
        if (externalDir) {
          const extFiles = await safeReaddir(externalDir)
          const extFinal = extFiles.find(f =>
            isVideoFile(f) && f.startsWith(`${code}_final_video.`),
          )
          if (extFinal) {
            hasFinalAtExternalRoot = true
            finalVideoAbsPath = path.join(externalDir, extFinal)
          }
        }
      } catch { /* external root unset or unreadable → leave false */ }
    }

    status.video_assembly = hasFinalInVideoDir
      || hasFinalAtEpisodeLevel
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
      return allDoneStatus()
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

/** Phase 1 helper — returns an EpisodeStatus with every field set to true. */
function allDoneStatus(): EpisodeStatus {
  return {
    research: true,
    scene_plan: true, scene_review: true,
    character_sheet: true,
    script: true, introduction: true,
    scene_prompts: true, thumb_prompts: true,
    metadata: true,
    images: true, thumbnails: true,
    audio: true, merged_audio: true,
    subtitles: true,
    video: true,
    video_assembly: true,
  }
}


