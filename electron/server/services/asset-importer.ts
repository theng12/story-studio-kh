/**
 * Per-episode asset importer.
 *
 * Why this exists: pre-Story-Studio episodes (Situation B) often have
 * weirdly-named assets on disk — the user hand-titled their TTS chunks
 * `1.mp3`, `2.mp3`, `3.mp3`; their scene PNGs are `final_v3.png`,
 * `final_v3_alt.png`, etc. Looser detection (Part 2 of the mark-done
 * plan) only helps when the user has ALREADY named files canonically.
 *
 * This service handles the "weirdly-named" case: the user picks their
 * source files in the UI, maps each to a canonical Story Studio slot,
 * and we copy (or move) them into the right subfolder with the
 * canonical filename. The next pipeline read sees the new files via the
 * existing detection logic — no special-case code needed elsewhere.
 *
 * Type-system note: ImportItem is a discriminated union so each variant
 * can specify exactly the fields it needs. The `type` discriminator
 * decides which destination resolver runs.
 */

import fs from 'fs/promises'
import path from 'path'
import { resolveEpisodePaths } from './utils.js'
import * as im from './idea-manager.js'
import { episodeStatusCache } from './episode-status-cache.js'
import { withFinalVideoImportSelectionLock, withFinalVideoPathLock } from './final-video-lock.js'
import { isEpisodeMergedAudioFilename } from '../lib/merged-audio-selection.js'

const FINAL_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v'])

// ── Public types ────────────────────────────────────────────────────────────

export type AudioSectionSlug = string  // e.g. 'Introduction', 'Chapter_01'

export type ImportItem =
  | { type: 'audio',  source_path: string, section_slug: AudioSectionSlug }
  | { type: 'scene',  source_path: string, scene_number: number }
  | { type: 'thumb',  source_path: string, thumb_number: number }
  | { type: 'video',  source_path: string, scene_number: number }
  | { type: 'final',  source_path: string }
  | { type: 'merged', source_path: string }
  | { type: 'other',  source_path: string, dest_subpath: string }

export interface ImportOptions {
  mode: 'copy' | 'move'
}

export interface ImportItemResult {
  source: string
  destination: string
  status: 'copied' | 'moved' | 'renamed-copied' | 'renamed-moved' | 'failed'
  /** Set when status === 'failed' OR when an auto-rename was applied. */
  reason?: string
}

export interface ImportSummary {
  total: number
  copied: number
  moved: number
  renamed: number
  failed: number
}

export interface ImportResult {
  items: ImportItemResult[]
  summary: ImportSummary
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Sanitize a single filename segment (audio section_slug, etc.). Strips
 * anything that could escape its containing folder — slashes, NUL bytes,
 * collapsed `..`. Use for fields that MUST be one filename component.
 */
function sanitizeSegment(input: string): string {
  return input
    .replace(/\0/g, '')                  // NUL bytes
    .replace(/[\\/]+/g, '_')              // path separators → underscore
    .replace(/\.{2,}/g, '_')              // collapse repeated dots (incl. `..`)
    .trim()
}

/**
 * Sanitize a multi-segment subpath (the `other` type's dest_subpath, where
 * the user legitimately wants subfolders). Strips NUL bytes only — the
 * containment check downstream handles `..` via path.resolve comparison,
 * which is more robust than string-mangling here.
 */
function sanitizeSubpath(input: string): string {
  return input.replace(/\0/g, '').trim()
}

/**
 * Validate that the user-supplied `dest_subpath` for `other`-type imports
 * stays inside the episode dir after resolution. Throws on traversal.
 */
function ensureInsideEpisode(episodeDir: string, candidate: string): string {
  const abs = path.resolve(episodeDir, candidate)
  const epAbs = path.resolve(episodeDir)
  if (!abs.startsWith(epAbs + path.sep) && abs !== epAbs) {
    throw new Error(`dest_subpath escapes episode directory: ${candidate}`)
  }
  return abs
}

/**
 * Pad a positive integer to 2 digits (or more if needed) — `5` → "05",
 * `123` → "123". Matches the {NN} convention used elsewhere in the app.
 */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * Take a destination path and, if it exists with content, suffix it with
 * `_v2`, `_v3`… until we find an unused name. Used for collision
 * resolution on every type EXCEPT `other` (where the user supplied the
 * exact path on purpose — we honour it).
 */
async function resolveCollision(dest: string): Promise<{ dest: string; renamed: boolean }> {
  let renamed = false
  let final = dest
  const dir = path.dirname(dest)
  const ext = path.extname(dest)
  const stem = path.basename(dest, ext)

  // Strip any trailing _v{N} from the stem so we don't double-suffix
  // e.g. `EP0001_Scene01_v1.png` already exists → next is `_v2`, not `_v1_v2`.
  const vMatch = stem.match(/^(.*?)_v(\d+)$/)
  const baseStem = vMatch ? vMatch[1] : stem
  let v = vMatch ? parseInt(vMatch[2], 10) : 1

  while (true) {
    try {
      const st = await fs.stat(final)
      // Empty file = treat as no collision (fileHasContent semantics
      // elsewhere already counts zero-byte files as missing). Else bump.
      if (st.size === 0) break
      v++
      final = path.join(dir, `${baseStem}_v${v}${ext}`)
      renamed = true
    } catch {
      // ENOENT — slot's free.
      break
    }
  }
  return { dest: final, renamed }
}

function isCanonicalFinalDestination(code: string, destination: string): boolean {
  const name = path.basename(destination)
  return name.startsWith(`${code}_final_video.`)
    && FINAL_VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase())
}

async function copyOrMove(source: string, destination: string, mode: ImportOptions['mode']): Promise<void> {
  if (mode !== 'move') {
    await fs.copyFile(source, destination)
    return
  }
  // fs.rename can fail across filesystems with EXDEV. Fall back to
  // copy-then-unlink so cross-mount imports still work.
  try {
    await fs.rename(source, destination)
  } catch (error: any) {
    if (error?.code !== 'EXDEV') throw error
    await fs.copyFile(source, destination)
    await fs.unlink(source)
  }
}

/**
 * Choose and write an imported final while coordinating with final render and
 * cleanup. The initial collision plan is intentionally recomputed inside the
 * target lock: a renderer may publish between the batch preflight and this
 * mutation, in which case the imported file receives the next version.
 */
async function importFinal(
  source: string,
  canonicalDestination: string,
  code: string,
  mode: ImportOptions['mode'],
): Promise<{ dest: string; renamed: boolean }> {
  const videoDir = path.dirname(canonicalDestination)
  const extension = path.extname(canonicalDestination)
  return withFinalVideoImportSelectionLock(videoDir, code, extension, async () => {
    while (true) {
      const selected = await resolveCollision(canonicalDestination)
      const outcome = await withFinalVideoPathLock(selected.dest, async () => {
        const current = await resolveCollision(canonicalDestination)
        if (current.dest !== selected.dest) return null
        await copyOrMove(source, current.dest, mode)
        return current
      })
      if (outcome) return outcome
    }
  })
}

/**
 * Compute the canonical destination for a single ImportItem.
 *
 * paths is the result of resolveEpisodePaths — every dest dir we might
 * write to is one of its fields. The function is pure (no I/O); the
 * caller does the actual mkdir + collision check + copy.
 */
function computeDestination(
  paths: Awaited<ReturnType<typeof resolveEpisodePaths>>,
  code: string,
  item: ImportItem,
): string {
  const sourceExt = path.extname(item.source_path).toLowerCase() || ''
  switch (item.type) {
    case 'audio': {
      const slug = sanitizeSegment(item.section_slug)
      // Audio is always .mp3 in our pipeline; the user's source may be
      // .wav/.aac/etc. but the canonical destination matches what the
      // generator + reconciler produce. We DO preserve the source ext,
      // though — the audio reconciler's `present` check uses .mp3 only,
      // so an imported .wav won't satisfy the chunk check, but the
      // looser detection (Part 2) doesn't apply to audio. Keep the .mp3
      // convention; users who import .wav are warned in the dialog.
      return path.join(paths.audio_dir, `${code}_${slug}.mp3`)
    }
    case 'scene': {
      const ext = sourceExt || '.png'
      return path.join(paths.bg_dir, `${code}_Scene${pad2(item.scene_number)}_v1${ext}`)
    }
    case 'thumb': {
      const ext = sourceExt || '.png'
      return path.join(paths.thumb_dir, `${code}_Thumb${pad2(item.thumb_number)}_v1${ext}`)
    }
    case 'video': {
      const ext = sourceExt || '.mp4'
      return path.join(paths.video_dir, `${code}_Video${pad2(item.scene_number)}_v1${ext}`)
    }
    case 'final': {
      const ext = sourceExt || '.mp4'
      return path.join(paths.video_dir, `${code}_final_video${ext}`)
    }
    case 'merged': {
      // Keep a recognised source extension: Audio Assembly writes `.mp3`, the
      // music builder `.m4a`, and imports may carry `.wav`. Renaming an m4a's
      // bytes to `.mp3` only ever existed to satisfy the retired .mp3-only
      // check; anything the canonical rule does not accept still lands as .mp3.
      const candidate = `${code}_merged_audio${sourceExt || '.mp3'}`
      return path.join(
        paths.merged_audio_dir,
        isEpisodeMergedAudioFilename(candidate, code) ? candidate : `${code}_merged_audio.mp3`,
      )
    }
    case 'other': {
      // Subpaths legitimately contain slashes (the user can target a
      // nested folder e.g. `notes/episode-notes.txt`). The containment
      // check handles `..` traversal robustly via path.resolve.
      const safe = sanitizeSubpath(item.dest_subpath)
      return ensureInsideEpisode(paths.episode_dir, safe)
    }
  }
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Import a batch of files into an episode's canonical asset folders.
 *
 * Pre-flight order matters:
 *  1. Resolve the episode (need paths + ideas record)
 *  2. Validate every source is readable (so a bad batch fails fast)
 *  3. Compute every destination + collision-resolve in one pass
 *  4. mkdir -p for any missing dirs (idempotent — copy/move ignores
 *     existing dirs)
 *  5. Execute copies/moves
 *  6. Invalidate the episode-status cache so the next read sees the
 *     new files
 *
 * If pre-flight (1–3) fails for ANY item, we bail before writing
 * anything. Once we're in step 5, individual file failures are
 * recorded but don't stop the batch — partial success is reportable.
 */
export async function importAssets(
  slug: string,
  episodeCode: string,
  items: ImportItem[],
  opts: ImportOptions,
): Promise<ImportResult> {
  const code = episodeCode.toUpperCase()

  if (!items.length) {
    return { items: [], summary: { total: 0, copied: 0, moved: 0, renamed: 0, failed: 0 } }
  }

  // 1. Resolve episode (need title for the folder template).
  const ideas = await im.getIdeas(slug, 'accepted')
  const idea = ideas.find(i => (i.episode_code || '').toUpperCase() === code)
  if (!idea) throw new Error(`Episode ${code} not found in accepted ideas`)
  const paths = await resolveEpisodePaths(slug, code, idea.title || '')

  // 2. Pre-flight: every source path must be a readable file. Fail fast.
  const sourceErrors: string[] = []
  for (const it of items) {
    try {
      const st = await fs.stat(it.source_path)
      if (!st.isFile()) sourceErrors.push(`${it.source_path}: not a file`)
    } catch (e: any) {
      sourceErrors.push(`${it.source_path}: ${e.message || 'unreadable'}`)
    }
  }
  if (sourceErrors.length) {
    throw new Error(`Pre-flight failed:\n${sourceErrors.join('\n')}`)
  }

  // 3. Compute destinations + collision-resolve. Final-video imports defer
  //    their collision decision until their locked write: a render may finish
  //    after this preflight, and must receive the canonical name instead.
  type Plan = { item: ImportItem; dest: string; renamed: boolean }
  const plans: Plan[] = []
  for (const it of items) {
    const initialDest = computeDestination(paths, code, it)
    if (isCanonicalFinalDestination(code, initialDest)) {
      plans.push({ item: it, dest: initialDest, renamed: false })
      continue
    }
    const { dest, renamed } = await resolveCollision(initialDest)
    plans.push({ item: it, dest, renamed })
  }

  // 4. Ensure destination dirs exist. Set-dedupe so we issue one mkdir
  //    per distinct dir even when 50 scene files target the same folder.
  const dirs = new Set(plans.map(p => path.dirname(p.dest)))
  for (const d of dirs) {
    await fs.mkdir(d, { recursive: true })
  }

  // 5. Execute. Record per-item outcomes.
  const results: ImportItemResult[] = []
  let copied = 0, moved = 0, renamed = 0, failed = 0
  for (const p of plans) {
    let destination = p.dest
    let wasRenamed = p.renamed
    try {
      if (isCanonicalFinalDestination(code, p.dest)) {
        const selected = await importFinal(p.item.source_path, p.dest, code, opts.mode)
        destination = selected.dest
        wasRenamed = selected.renamed
      } else {
        await copyOrMove(p.item.source_path, destination, opts.mode)
      }
      results.push({
        source: p.item.source_path,
        destination,
        status: opts.mode === 'move'
          ? wasRenamed ? 'renamed-moved' : 'moved'
          : wasRenamed ? 'renamed-copied' : 'copied',
        reason: wasRenamed ? 'destination already existed; auto-suffixed' : undefined,
      })
      if (opts.mode === 'move') moved++
      else copied++
      if (wasRenamed) renamed++
    } catch (e: any) {
      results.push({
        source: p.item.source_path,
        destination,
        status: 'failed',
        reason: e?.message || 'unknown error',
      })
      failed++
    }
  }

  // 6. Cache invalidation — the next /episodes read recomputes status
  //    for this episode (would happen anyway via mtime, but explicit
  //    invalidation avoids stale serves on the immediate refresh).
  episodeStatusCache.invalidate(slug, code)

  return {
    items: results,
    summary: { total: items.length, copied, moved, renamed, failed },
  }
}
