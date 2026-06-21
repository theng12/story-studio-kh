/**
 * Storage audit + cleanup helpers.
 *
 * Surfaces per-episode local size broken down by category so the user
 * can see where the disk goes and free space safely. Cleanup actions
 * have a sidecar safety guard — they refuse to delete a final video
 * that hasn't been confirmed-uploaded to YouTube unless the caller
 * explicitly opts in via `force: true`.
 *
 * Categories surfaced:
 *   - final_video       — `*_final_video.*` (the cleanup target by default)
 *   - per_scene_clips   — Veo/fal-generated `{code}_Scene*_v*.mp4` (NEVER
 *                          auto-cleaned; user opts in per-episode)
 *   - audio             — chunk + merged narration mp3s
 *   - images            — scene + thumbnail PNGs / JPGs
 *   - other             — scripts, prompts, metadata, sidecars (small
 *                          stuff the user wouldn't want to delete from
 *                          this UI; surfaced as a single number)
 *
 * Reads the YouTube sidecar to mark each episode as "uploaded" or not
 * — drives the safety guard + the bulk-cleanup filter.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { resolveEpisodePaths } from './utils.js'
import { readSidecar } from './upload-sidecar.js'
import {
  getExternalFinalVideoRoot,
  resolveExternalFinalVideoDir,
} from './external-video-store.js'

export interface StorageEntry {
  episode_code: string
  title: string
  /** Absolute path to the project-tree episode dir (always set). */
  project_episode_dir: string
  /**
   * When the user has external_final_video_root configured AND a final
   * video exists at the external location for this episode, this points
   * at that external dir. Empty otherwise. The Storage UI uses this to
   * show "→ external" markers + offer migration.
   */
  external_episode_dir: string
  /** Per-category byte counts (project tree). */
  bytes_final_video: number
  bytes_per_scene_clips: number
  bytes_audio: number
  bytes_images: number
  bytes_other: number
  bytes_total: number
  /** Bytes occupied by the final video at the external root (when set). */
  bytes_external_final_video: number
  /** The actual final-video filenames found (for the per-row display). */
  final_video_filenames: string[]
  /** True when the YouTube sidecar shows `video_id` set. */
  uploaded_to_youtube: boolean
  /** Empty when no upload, otherwise the YouTube video id. */
  youtube_video_id: string
}

export interface StorageAuditResult {
  /** Sum of bytes_total across every accepted episode. */
  project_bytes_total: number
  /** Sum of bytes_final_video across accepted episodes. The cleanup target. */
  project_bytes_final_video: number
  /** Sum of bytes_per_scene_clips. Surfaced separately so the UI can
   *  flag the "$$$ to regenerate" warning. */
  project_bytes_per_scene_clips: number
  /** Sum of bytes_external_final_video — what already lives outside the project tree. */
  project_bytes_external_final_video: number
  /** True when external_final_video_root is configured (drives UI hints). */
  external_root_configured: boolean
  /** The configured root path (resolved with ~ expansion). Empty if unset. */
  external_root: string
  episodes: StorageEntry[]
}

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v'])
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

function ext(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

function isFinalVideoName(code: string, name: string): boolean {
  return name.startsWith(`${code}_final_video.`) && VIDEO_EXTS.has(ext(name))
}

function isPerSceneClipName(code: string, name: string): boolean {
  // Per-scene clip pattern matches either canonical Veo/fal output
  // (`{code}_Scene01_v1.mp4`) or hand-named `{code}_Scene_01.mp4`.
  // Case-insensitive on "scene" because user-renames sometimes lowercase.
  if (!VIDEO_EXTS.has(ext(name))) return false
  if (!name.startsWith(code)) return false
  return /[_\- ]scene[_\- ]?\d+/i.test(name)
}

/**
 * Recursively size a directory in bytes. Returns 0 on missing dir or
 * any read failure — never throws (the audit shouldn't crash a single
 * page load over a permission glitch on a stray subfolder).
 */
async function dirSize(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0
  let total = 0
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        total += await dirSize(p)
      } else if (e.isFile()) {
        try { total += (await fs.stat(p)).size } catch { /* skip */ }
      }
    }
  } catch { /* skip unreadable dir */ }
  return total
}

/**
 * Walk an episode's video_dir, classify files by category. We do this
 * one folder at a time rather than calling `dirSize` blindly so
 * per-scene clips and the final video get their own counters.
 */
async function auditVideoDir(code: string, dir: string): Promise<{
  bytes_final_video: number
  bytes_per_scene_clips: number
  bytes_other_video: number
  final_video_filenames: string[]
}> {
  const out = { bytes_final_video: 0, bytes_per_scene_clips: 0, bytes_other_video: 0, final_video_filenames: [] as string[] }
  if (!existsSync(dir)) return out
  let entries: string[] = []
  try { entries = await fs.readdir(dir) } catch { return out }
  for (const name of entries) {
    const full = path.join(dir, name)
    let size = 0
    try { size = (await fs.stat(full)).size } catch { continue }
    if (isFinalVideoName(code, name)) {
      out.bytes_final_video += size
      out.final_video_filenames.push(name)
    } else if (isPerSceneClipName(code, name)) {
      out.bytes_per_scene_clips += size
    } else if (VIDEO_EXTS.has(ext(name))) {
      out.bytes_other_video += size
    }
  }
  return out
}

/**
 * Build the per-episode storage audit for a project. Reads from disk
 * for every accepted episode in parallel (bounded concurrency to avoid
 * fanning out 200 stat calls at once on big libraries).
 */
export async function auditProjectStorage(slug: string): Promise<StorageAuditResult> {
  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')

  const ideas = await im.getIdeas(slug, 'accepted')
  const externalRoot = await getExternalFinalVideoRoot()

  const CONCURRENCY = 8
  const results: StorageEntry[] = new Array(ideas.length)
  let cursor = 0

  async function auditOne(idea: any): Promise<StorageEntry> {
    const code = idea.episode_code
    let paths: any
    try {
      paths = await resolveEpisodePaths(slug, code, idea.title || '')
    } catch {
      // Episode dir unresolvable (idea exists but path math failed).
      // Return a zero entry so the UI still lists the episode rather
      // than the audit silently dropping it.
      return {
        episode_code: code, title: idea.title || code,
        project_episode_dir: '', external_episode_dir: '',
        bytes_final_video: 0, bytes_per_scene_clips: 0,
        bytes_audio: 0, bytes_images: 0, bytes_other: 0,
        bytes_total: 0, bytes_external_final_video: 0,
        final_video_filenames: [],
        uploaded_to_youtube: false, youtube_video_id: '',
      }
    }

    // Video dir — classified breakdown.
    const v = await auditVideoDir(code, paths.video_dir)

    // Audio (per-chapter chunks + merged) and images (scenes + thumbs)
    // — these are bulk numbers; the user isn't cleaning at this level.
    const [audioBytes, mergedBytes, sceneBytes, thumbBytes] = await Promise.all([
      dirSize(paths.audio_dir),
      dirSize(paths.merged_audio_dir),
      dirSize(paths.bg_dir),
      dirSize(paths.thumb_dir),
    ])

    // "Other" = sum of script + scene_prompts + thumb_prompts +
    // metadata + subtitles. These are tiny — surface as one number.
    const [scriptBytes, scenePromptsBytes, thumbPromptsBytes, metadataBytes, subtitlesBytes] = await Promise.all([
      dirSize(paths.script_dir),
      dirSize(paths.scene_prompts_dir),
      dirSize(paths.thumb_prompts_dir),
      dirSize(paths.metadata_dir),
      dirSize(paths.subtitles_dir),
    ])

    // External root presence check + size for THIS episode's external dir.
    let externalEpisodeDir = ''
    let bytesExternalFinal = 0
    if (externalRoot) {
      try {
        const extDir = await resolveExternalFinalVideoDir(slug, code, idea.title || '')
        if (extDir && existsSync(extDir)) {
          externalEpisodeDir = extDir
          // Only count the final-video files at the external location;
          // we don't expect other categories to live there, but if a
          // user manually drops other files we ignore them for the
          // purposes of "external final size".
          let entries: string[] = []
          try { entries = await fs.readdir(extDir) } catch { /* ignore */ }
          for (const name of entries) {
            if (!isFinalVideoName(code, name)) continue
            try { bytesExternalFinal += (await fs.stat(path.join(extDir, name))).size } catch { /* skip */ }
          }
        }
      } catch { /* unresolvable; leave 0 */ }
    }

    // Sidecar — the upload-confirmation signal.
    let uploaded = false
    let videoId = ''
    try {
      const sc = await readSidecar(slug, code, idea.title || '', 'youtube')
      if (sc?.video_id) {
        uploaded = true
        videoId = sc.video_id
      }
    } catch { /* missing or unreadable → not uploaded */ }

    const audioTotal = audioBytes + mergedBytes
    const imageTotal = sceneBytes + thumbBytes
    const otherTotal = scriptBytes + scenePromptsBytes + thumbPromptsBytes + metadataBytes + subtitlesBytes
    const total = v.bytes_final_video + v.bytes_per_scene_clips + v.bytes_other_video
      + audioTotal + imageTotal + otherTotal

    return {
      episode_code: code,
      title: idea.title || code,
      project_episode_dir: paths.episode_dir,
      external_episode_dir: externalEpisodeDir,
      bytes_final_video: v.bytes_final_video,
      bytes_per_scene_clips: v.bytes_per_scene_clips,
      bytes_audio: audioTotal,
      bytes_images: imageTotal,
      bytes_other: otherTotal + v.bytes_other_video,
      bytes_total: total,
      bytes_external_final_video: bytesExternalFinal,
      final_video_filenames: v.final_video_filenames,
      uploaded_to_youtube: uploaded,
      youtube_video_id: videoId,
    }
  }

  async function worker() {
    while (cursor < ideas.length) {
      const i = cursor++
      results[i] = await auditOne(ideas[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ideas.length) }, worker))

  // Summary aggregates.
  let projectBytesTotal = 0
  let projectBytesFinal = 0
  let projectBytesScenes = 0
  let projectBytesExternalFinal = 0
  for (const r of results) {
    projectBytesTotal += r.bytes_total
    projectBytesFinal += r.bytes_final_video
    projectBytesScenes += r.bytes_per_scene_clips
    projectBytesExternalFinal += r.bytes_external_final_video
  }

  return {
    project_bytes_total: projectBytesTotal,
    project_bytes_final_video: projectBytesFinal,
    project_bytes_per_scene_clips: projectBytesScenes,
    project_bytes_external_final_video: projectBytesExternalFinal,
    external_root_configured: !!externalRoot,
    external_root: externalRoot,
    episodes: results,
  }
}

export interface CleanupItem {
  episode_code: string
  /** Path of the file deleted, or attempted. */
  file: string
  status: 'deleted' | 'skipped' | 'failed'
  /** Bytes recovered when status === 'deleted'. */
  bytes_freed: number
  reason?: string
}

export interface CleanupResult {
  items: CleanupItem[]
  bytes_freed: number
  deleted_count: number
  skipped_count: number
  failed_count: number
}

export interface CleanupOptions {
  /**
   * When false (default), the cleanup refuses to delete a final video
   * unless the YouTube sidecar shows it's uploaded. Lets users bulk-
   * cleanup safely without accidentally deleting an unpublished render.
   * Set true to override (manual per-row cleanup with explicit confirm).
   */
  force?: boolean
}

/**
 * Delete the final video files for a single episode at both the
 * project-tree location and the external root (if configured + present).
 *
 * Per-scene clips are never touched by this function — those are a
 * separate concern (cost-to-regenerate via Veo/fal API). The Storage UI
 * surfaces them as a separate row with its own per-episode action.
 */
export async function cleanupFinalVideoForEpisode(
  slug: string,
  episodeCode: string,
  opts: CleanupOptions = {},
): Promise<CleanupResult> {
  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')

  const ideas = await im.getIdeas(slug, 'accepted')
  const idea = ideas.find(
    i => (i.episode_code || '').toUpperCase() === episodeCode.toUpperCase(),
  )
  if (!idea) throw new Error(`No accepted episode with code ${episodeCode}`)

  const code = idea.episode_code!

  // Safety: refuse unless uploaded OR force=true. The route maps
  // !force + !uploaded → 412 Precondition Failed so the UI can show a
  // distinct "this isn't uploaded yet" warning rather than a generic 500.
  if (!opts.force) {
    const sc = await readSidecar(slug, code, idea.title || '', 'youtube')
    if (!sc?.video_id) {
      const err: any = new Error(
        `Final video for ${code} is not confirmed uploaded to YouTube. Pass force:true to delete anyway.`,
      )
      err.statusCode = 412
      throw err
    }
  }

  const items: CleanupItem[] = []
  const paths = await resolveEpisodePaths(slug, code, idea.title || '')

  // Collect candidate paths from the project tree video_dir.
  const candidates: string[] = []
  if (existsSync(paths.video_dir)) {
    let entries: string[] = []
    try { entries = await fs.readdir(paths.video_dir) } catch { /* ignore */ }
    for (const name of entries) {
      if (isFinalVideoName(code, name)) candidates.push(path.join(paths.video_dir, name))
    }
  }
  // Also collect from the external root, if the user has finals there.
  try {
    const extDir = await resolveExternalFinalVideoDir(slug, code, idea.title || '')
    if (extDir && existsSync(extDir)) {
      let entries: string[] = []
      try { entries = await fs.readdir(extDir) } catch { /* ignore */ }
      for (const name of entries) {
        if (isFinalVideoName(code, name)) candidates.push(path.join(extDir, name))
      }
    }
  } catch { /* external root unset → noop */ }

  if (candidates.length === 0) {
    return { items, bytes_freed: 0, deleted_count: 0, skipped_count: 0, failed_count: 0 }
  }

  let bytesFreed = 0
  let deleted = 0
  let failed = 0
  for (const file of candidates) {
    let size = 0
    try { size = (await fs.stat(file)).size } catch { /* file vanished mid-flight */ }
    try {
      await fs.rm(file, { force: true })
      items.push({ episode_code: code, file, status: 'deleted', bytes_freed: size })
      bytesFreed += size
      deleted++
    } catch (e: any) {
      items.push({
        episode_code: code, file, status: 'failed', bytes_freed: 0,
        reason: e?.message || 'rm failed',
      })
      failed++
    }
  }

  // Episode-status cache invalidation — the next read must recompute
  // video_assembly so it picks up the sidecar fallback (Phase A).
  try {
    const { episodeStatusCache } = await import('./episode-status-cache.js')
    episodeStatusCache.invalidate(slug, code)
  } catch { /* non-fatal */ }

  return {
    items,
    bytes_freed: bytesFreed,
    deleted_count: deleted,
    skipped_count: 0,
    failed_count: failed,
  }
}

/**
 * Bulk variant: cleanup final videos across multiple episodes in one
 * pass. Each episode's safety check runs independently (uploaded ones
 * delete; non-uploaded ones get skipped UNLESS force=true is set).
 *
 * `episode_codes` lists the codes to clean. When empty + `all_uploaded`
 * is true, every accepted episode whose sidecar shows uploaded gets
 * cleaned — the typical "free up space everywhere it's safe to do so"
 * one-click.
 */
export async function bulkCleanupFinalVideos(
  slug: string,
  opts: {
    episode_codes?: string[]
    all_uploaded?: boolean
    force?: boolean
  },
): Promise<CleanupResult> {
  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')

  const ideas = await im.getIdeas(slug, 'accepted')
  let targets: string[] = []
  if (Array.isArray(opts.episode_codes) && opts.episode_codes.length) {
    const set = new Set(opts.episode_codes.map(c => c.toUpperCase()))
    targets = ideas
      .filter(i => set.has((i.episode_code || '').toUpperCase()))
      .map(i => i.episode_code!)
  } else if (opts.all_uploaded) {
    // Resolve via sidecar reads in parallel.
    const checks = await Promise.all(ideas.map(async (i) => {
      try {
        const sc = await readSidecar(slug, i.episode_code!, i.title || '', 'youtube')
        return sc?.video_id ? i.episode_code! : null
      } catch { return null }
    }))
    targets = checks.filter((c): c is string => !!c)
  }

  // Run per-episode cleanups serially. Bulk delete on a project with
  // 200 episodes has the potential to create file-lock contention if
  // we fan out — disk I/O isn't where we'd benefit from parallelism
  // here anyway (we're rm'ing, not encoding).
  const allItems: CleanupItem[] = []
  let bytesFreed = 0
  let deleted = 0
  let failed = 0
  let skipped = 0
  for (const code of targets) {
    try {
      const r = await cleanupFinalVideoForEpisode(slug, code, { force: opts.force })
      allItems.push(...r.items)
      bytesFreed += r.bytes_freed
      deleted += r.deleted_count
      failed += r.failed_count
    } catch (e: any) {
      // 412 = "not uploaded, force not set" — surface as a skip rather
      // than a failure so the UI distinguishes "we chose not to" from
      // "we tried and rm failed".
      if (e?.statusCode === 412) {
        allItems.push({
          episode_code: code, file: '', status: 'skipped', bytes_freed: 0,
          reason: 'Not confirmed uploaded; pass force:true to override.',
        })
        skipped++
      } else {
        allItems.push({
          episode_code: code, file: '', status: 'failed', bytes_freed: 0,
          reason: e?.message || 'cleanup failed',
        })
        failed++
      }
    }
  }

  return {
    items: allItems,
    bytes_freed: bytesFreed,
    deleted_count: deleted,
    skipped_count: skipped,
    failed_count: failed,
  }
}

/**
 * Migration: scan the project for final videos in the project tree,
 * move each to the configured external root. No-op when external root
 * isn't configured. Returns an item list so the UI can show what moved
 * vs failed.
 *
 * Per-scene clips are never moved — they stay in the project tree.
 */
export async function migrateFinalsToExternal(slug: string): Promise<{
  moved: Array<{ episode_code: string; from: string; to: string; bytes: number }>
  errors: Array<{ episode_code: string; reason: string }>
  bytes_moved: number
}> {
  const root = await getExternalFinalVideoRoot()
  if (!root) {
    throw new Error('External final-video root is not configured. Set it in app settings first.')
  }
  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')

  const ideas = await im.getIdeas(slug, 'accepted')
  const moved: Array<{ episode_code: string; from: string; to: string; bytes: number }> = []
  const errors: Array<{ episode_code: string; reason: string }> = []
  let bytesMoved = 0

  for (const idea of ideas) {
    const code = idea.episode_code!
    let paths: any
    try { paths = await resolveEpisodePaths(slug, code, idea.title || '') } catch (e: any) {
      errors.push({ episode_code: code, reason: e?.message || 'path resolve failed' })
      continue
    }
    if (!existsSync(paths.video_dir)) continue

    let entries: string[] = []
    try { entries = await fs.readdir(paths.video_dir) } catch { continue }
    const finals = entries.filter(n => isFinalVideoName(code, n))
    if (!finals.length) continue

    const extDir = await resolveExternalFinalVideoDir(slug, code, idea.title || '')
    if (!extDir) continue   // Shouldn't happen — root is set — but defensive.
    try {
      await fs.mkdir(extDir, { recursive: true })
    } catch (e: any) {
      errors.push({ episode_code: code, reason: `mkdir external dir failed: ${e?.message || e}` })
      continue
    }

    for (const name of finals) {
      const from = path.join(paths.video_dir, name)
      const to = path.join(extDir, name)
      let size = 0
      try { size = (await fs.stat(from)).size } catch { /* skip */ }
      try {
        // Same filesystem → fs.rename is atomic + free.
        await fs.rename(from, to)
      } catch (e: any) {
        if (e?.code === 'EXDEV') {
          // External root on another volume — copy + remove.
          try {
            await fs.copyFile(from, to)
            await fs.rm(from, { force: true })
          } catch (cpErr: any) {
            errors.push({ episode_code: code, reason: `cross-device move failed: ${cpErr?.message || cpErr}` })
            continue
          }
        } else {
          errors.push({ episode_code: code, reason: `move failed: ${e?.message || e}` })
          continue
        }
      }
      moved.push({ episode_code: code, from, to, bytes: size })
      bytesMoved += size
    }
  }

  // Cache invalidation — every moved episode's video_assembly path
  // changed, but our extended detector reads from both locations so
  // results stay correct. Invalidating just hastens the next refresh.
  try {
    const { episodeStatusCache } = await import('./episode-status-cache.js')
    episodeStatusCache.invalidateProject(slug)
  } catch { /* non-fatal */ }

  return { moved, errors, bytes_moved: bytesMoved }
}

// ── External media root migration (Level B) ──────────────────────────────────

export interface MediaMigrationResult {
  dry_run: boolean
  /** Per heavy-subfolder summary of what moved (or would move, on dry-run). */
  folders: Array<{ episode_code: string; key: string; from: string; to: string; files: number; bytes: number }>
  /** scene_plan.json image_path values rewritten to the new media location. */
  scene_plan_rewrites: number
  errors: Array<{ episode_code: string; reason: string }>
  bytes_moved: number
  files_moved: number
}

/**
 * Move a project's existing HEAVY media subfolders (scene images, thumbnails,
 * audio, merged audio, final video) from the iCloud/project tree to the
 * configured `media_root` (e.g. an external SSD). iCloud→SSD is cross-volume,
 * so this is copy-verify-delete; it's resumable (a same-size file already at the
 * destination is treated as done) and reversible (clear media_root + run again
 * after swapping the source, or move the folders back by hand).
 *
 * Only `scene_plan.json`'s absolute `image_path` values need rewriting after the
 * move — classic scene images, thumbnails, and audio all self-heal via the
 * media-aware re-scan. Pass `{ dryRun: true }` to preview counts/bytes without
 * touching anything.
 */
export async function migrateMediaToExternal(
  slug: string,
  opts: { dryRun?: boolean } = {},
): Promise<MediaMigrationResult> {
  const dryRun = !!opts.dryRun
  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')
  const mediaRootRaw = (meta as any).media_root
  if (!mediaRootRaw || !String(mediaRootRaw).trim()) {
    throw new Error('No external media root is configured for this project. Set it in Settings → Storage first.')
  }
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) throw new Error('Project output root not found')

  // Resolve the media root up front so an undefined ${NAME} or unplugged drive
  // fails loud here, rather than silently no-op'ing (resolveEpisodePaths would
  // fall back to the iCloud tree, making source === dest and migrating nothing).
  const { resolveAssetPath } = await import('./path-resolver.js')
  let mediaRootAbs: string
  try {
    mediaRootAbs = resolveAssetPath(String(mediaRootRaw).trim(), outputRoot)
  } catch (e: any) {
    throw new Error(`Media root ${mediaRootRaw} can't be resolved on this machine — define it in Settings → Named Roots. ${e?.message || ''}`.trim(), { cause: e })
  }
  if (!mediaRootAbs || /^\$\{/.test(mediaRootAbs)) {
    throw new Error(`Media root ${mediaRootRaw} can't be resolved on this machine — define it in Settings → Named Roots.`)
  }

  const { findEpisodeDir, findSubfolder } = await import('../lib/folder-resolver.js')
  const { resolveSubfolderNames } = await import('./utils.js')

  const HEAVY: Array<{ key: string; destField: keyof EpisodePathsLike }> = [
    { key: 'images', destField: 'bg_dir' },
    { key: 'thumbnails', destField: 'thumb_dir' },
    { key: 'audio', destField: 'audio_dir' },
    { key: 'merged_audio', destField: 'merged_audio_dir' },
    { key: 'video', destField: 'video_dir' },
  ]

  const result: MediaMigrationResult = {
    dry_run: dryRun, folders: [], scene_plan_rewrites: 0, errors: [], bytes_moved: 0, files_moved: 0,
  }
  const ideas = await im.getIdeas(slug, 'accepted')

  for (const idea of ideas) {
    const code = idea.episode_code
    if (!code) continue
    const title = idea.title || ''
    let iCloudEpisodeDir: string | null
    let destPaths: EpisodePathsLike
    try {
      iCloudEpisodeDir = await findEpisodeDir(outputRoot, code, { titleHint: title })
      destPaths = await resolveEpisodePaths(slug, code, title) as unknown as EpisodePathsLike
    } catch (e: any) {
      result.errors.push({ episode_code: code, reason: e?.message || 'path resolve failed' })
      continue
    }
    if (!iCloudEpisodeDir) continue
    const names = await resolveSubfolderNames(slug, code) as unknown as Record<string, string>

    for (const { key, destField } of HEAVY) {
      const subName = names[key]
      const destDir = destPaths[destField]
      if (!subName || !destDir) continue
      let sourceDir: string | null
      try { sourceDir = await findSubfolder(iCloudEpisodeDir, subName) } catch { sourceDir = null }
      if (!sourceDir) continue
      // Nothing to do if dest is the same place (media root inactive) or if the
      // source already lives outside the project tree (already migrated).
      if (path.resolve(sourceDir) === path.resolve(destDir)) continue
      if (!path.resolve(sourceDir).startsWith(path.resolve(outputRoot))) continue

      let files: string[]
      try { files = await fs.readdir(sourceDir) } catch { continue }
      let folderBytes = 0
      let folderFiles = 0
      if (!dryRun) {
        try { await fs.mkdir(destDir, { recursive: true }) } catch (e: any) {
          result.errors.push({ episode_code: code, reason: `mkdir ${destDir} failed: ${e?.message || e}` })
          continue
        }
      }
      for (const name of files) {
        const from = path.join(sourceDir, name)
        let st
        try { st = await fs.stat(from) } catch { continue }
        if (!st.isFile()) continue   // heavy subfolders are flat; skip stray dirs
        folderBytes += st.size
        folderFiles++
        if (dryRun) continue
        const to = path.join(destDir, name)
        try {
          // Resumable: a same-size file already at the dest counts as copied.
          let needCopy = true
          try { if ((await fs.stat(to)).size === st.size) needCopy = false } catch { /* not there */ }
          if (needCopy) {
            await fs.copyFile(from, to)
            if ((await fs.stat(to)).size !== st.size) {
              result.errors.push({ episode_code: code, reason: `size mismatch copying ${name}` })
              continue
            }
          }
          await fs.rm(from, { force: true })
          result.bytes_moved += st.size
          result.files_moved++
        } catch (e: any) {
          result.errors.push({ episode_code: code, reason: `move ${name} failed: ${e?.message || e}` })
        }
      }
      if (folderFiles > 0) {
        result.folders.push({ episode_code: code, key, from: sourceDir, to: destDir, files: folderFiles, bytes: folderBytes })
      }
      if (!dryRun) {
        try { if (!(await fs.readdir(sourceDir)).length) await fs.rmdir(sourceDir) } catch { /* keep non-empty */ }
      }
    }

    // NB: scene_plan.json image_path values are intentionally NOT rewritten.
    // Those scene-plan / timestamp renders live in `episode_dir/scene_images`
    // (a flat folder, not one of the named HEAVY subfolders), which this tool
    // does not move — so the stored paths stay valid. Classic scene images,
    // thumbnails, and audio (the folders we DO move) self-heal via the
    // media-aware re-scan, so there's nothing to rewrite. (Routing the
    // timestamp `scene_images` folder to the media root is a separate, later
    // change — see docs/external-media-root-spec.md.)
  }

  if (!dryRun) {
    try {
      const { episodeStatusCache } = await import('./episode-status-cache.js')
      episodeStatusCache.invalidateProject(slug)
    } catch { /* non-fatal */ }
  }
  return result
}

/** Subset of EpisodePaths this migration reads (avoids importing the full type). */
interface EpisodePathsLike {
  bg_dir: string
  thumb_dir: string
  audio_dir: string
  merged_audio_dir: string
  video_dir: string
}
