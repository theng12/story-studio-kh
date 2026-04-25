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
import { resolveEpisodePaths, resolveSubfolderNames } from './utils.js'
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
  // Sidecar JSON written by generateIntroductionOnly. Cheap O(1) check.
  if (filename.endsWith('.intro.json')) return true
  // Legacy file from the pre-merge era. Kept as a fallback so older
  // projects keep reporting introduction: true; new runs replace these
  // by overwriting the unified narration + writing the sidecar.
  if (filename.endsWith('_Introduction.docx')) return true
  return false
}

export function isScriptChaptersDocx(filename: string): boolean {
  // Any .docx not part of the legacy separate-intro file. The unified
  // narration docx (which now may contain the intro section inside)
  // counts as "script present" — that's the chapters file, by spec.
  return filename.endsWith('.docx') && !filename.endsWith('_Introduction.docx')
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
      `${code}_Video_Prompts.docx`,
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
      path.join(pm.PROJECTS_ROOT, slug, 'project.json'), 'utf-8',
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
  script: boolean
  introduction: boolean
  scene_prompts: boolean
  thumb_prompts: boolean
  metadata: boolean
  images: boolean
  thumbnails: boolean
  audio: boolean
  merged_audio: boolean
  video: boolean
  // Video-assembly final render — the single merged output that the
  // Video Assembly page produces. Named `{code}_final_video.{ext}` under
  // the episode's video_dir (same folder the per-scene clips live in).
  // Detected by file presence; absent = user still needs to run assembly.
  video_assembly: boolean
}

function emptyStatus(): EpisodeStatus {
  return {
    script: false, introduction: false,
    scene_prompts: false, thumb_prompts: false,
    metadata: false,
    images: false, thumbnails: false,
    audio: false, merged_audio: false,
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

    const [scriptFiles, scenePromptFiles, thumbPromptFiles, metadataFiles] = await Promise.all([
      safeReaddir(paths.script_dir),
      safeReaddir(paths.scene_prompts_dir),
      safeReaddir(paths.thumb_prompts_dir),
      safeReaddir(paths.metadata_dir),
    ])

    const scriptState = deriveScriptFolderState(scriptFiles)
    status.script = scriptState.script
    status.introduction = scriptState.introduction
    status.scene_prompts = scenePromptFiles.some(f => f.endsWith('.docx') || f.endsWith('.json'))
    status.thumb_prompts = thumbPromptFiles.some(f => f.endsWith('.docx') || f.endsWith('.json'))
    status.metadata = metadataFiles.some(f => f.endsWith('.txt') || f.endsWith('.json') || f.endsWith('.md'))

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
              if (files.some((f: string) => f.endsWith('.docx') || f.endsWith('.json'))) status.scene_prompts = true
            }
            if (cleanSub.includes('thumbnail prompt')) {
              if (files.some((f: string) => f.endsWith('.docx') || f.endsWith('.json'))) status.thumb_prompts = true
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

    // Path A + B — inside video_dir
    const videoDirFiles = await safeReaddir(paths.video_dir)
    const hasFinalInVideoDir = videoDirFiles.some(f =>
      isVideoFile(f) && (f.startsWith(`${code}_final_video.`) || !isPerSceneClip(f)),
    )

    // Path C — episode_dir root + "final"/"assembled"/"output" subfolders
    let hasFinalAtEpisodeLevel = false
    if (!hasFinalInVideoDir) {
      try {
        const epEntries = await fs.readdir(paths.episode_dir, { withFileTypes: true })
        // Root-level videos (user dropped the finished file next to the folders)
        if (epEntries.some(e => e.isFile() && isVideoFile(e.name))) {
          hasFinalAtEpisodeLevel = true
        } else {
          // Sibling folders like "Final", "Assembled Output", "Exports"
          const finalishFolders = epEntries.filter(e => e.isDirectory()
            && /(final|assembl|output|export)/i.test(e.name))
          for (const f of finalishFolders) {
            const inner = await safeReaddir(path.join(paths.episode_dir, f.name))
            if (inner.some(n => isVideoFile(n))) { hasFinalAtEpisodeLevel = true; break }
          }
        }
      } catch { /* ignore */ }
    }

    status.video_assembly = hasFinalInVideoDir || hasFinalAtEpisodeLevel
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
      for (const k of Object.keys(idea.status_overrides) as Array<keyof EpisodeStatus>) {
        const v = idea.status_overrides[k]
        if (typeof v === 'boolean') status[k] = v
      }
    }
  } catch { /* if we can't load ideas, fall through with detected status — back-compat */ }

  return status
}

/** Phase 1 helper — returns an EpisodeStatus with every field set to true. */
function allDoneStatus(): EpisodeStatus {
  return {
    script: true, introduction: true,
    scene_prompts: true, thumb_prompts: true,
    metadata: true,
    images: true, thumbnails: true,
    audio: true, merged_audio: true,
    video: true,
    video_assembly: true,
  }
}


