/**
 * Storage audit + cleanup helpers.
 *
 * Surfaces per-episode local size broken down by category so the user
 * can see where the disk goes and free space safely. Cleanup actions
 * have a remote-proof safety guard — they refuse to delete a final video
 * whose exact render and current YouTube processing state cannot be freshly
 * verified.
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
 * Accepted provider IDs drive the uploaded badge. Only a current content-hash
 * operation can become a cleanup candidate; deletion separately verifies the
 * exact bytes and current remote processing state.
 */

import { isFinalVideoFilename } from '../lib/final-video-name.js'
import fs from 'fs/promises'
import { constants, existsSync } from 'fs'
import path from 'path'
import * as pm from './project-manager.js'
import { thumbCacheBytes } from '../lib/thumbnail-cache.js'
import { PARTS_DIRNAME } from './chapter-parts.js'
import * as im from './idea-manager.js'
import { resolveEpisodePaths } from './utils.js'
import {
  youtubeRetentionEvidenceFor,
  youtubeRetentionProofForFile,
  readYouTubeRetentionStores,
} from './youtube-remote-video.js'
import { getProjectYouTubeAssignment } from './youtube-connection-store.js'
import { registryCredentialFor } from '../lib/youtube-client.js'
import { syncYouTubePublicationState } from './youtube-publication-status.js'
import {
  isContentSha256Revision,
  resolveYouTubeSourceRevision,
  resolveYouTubeSourceRevisionFromHandle,
} from './youtube-source-video.js'
import { withFinalVideoPathLock } from './final-video-lock.js'
import { moveToTrashSync, trashRootFor } from '../lib/trash-move.js'
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
  /** Kept narration parts (`<audio>/.parts`), already inside `bytes_audio`; shown on their own line. */
  bytes_narration_parts: number
  bytes_images: number
  bytes_other: number
  bytes_total: number
  /** Bytes occupied by the final video at the external root (when set). */
  bytes_external_final_video: number
  /** The actual final-video filenames found (for the per-row display). */
  final_video_filenames: string[]
  /** True when canonical or historical evidence carries an accepted video id. */
  uploaded_to_youtube: boolean
  /** Empty when no upload, otherwise the YouTube video id. */
  youtube_video_id: string
  /** A current content-hash receipt exists; deletion still verifies bytes + YouTube live. */
  cleanup_eligible: boolean
  /** Why ordinary cleanup is blocked when a final exists. */
  cleanup_reason?: string
}

export interface StorageAuditResult {
  /** Sum of bytes_total across every accepted episode. */
  project_bytes_total: number
  /** Sum of bytes_final_video across accepted episodes. The cleanup target. */
  project_bytes_final_video: number
  /** Sum of bytes_per_scene_clips. Surfaced separately so the UI can
   *  flag the "$$$ to regenerate" warning. */
  project_bytes_per_scene_clips: number
  /** Sum of bytes_narration_parts (Free up space › Narration parts). */
  project_bytes_narration_parts: number
  /** Sum of bytes_external_final_video — what already lives outside the project tree. */
  project_bytes_external_final_video: number
  /** Regenerable review-grid thumbnails under `<project>/.cache/thumbs`; not part of any episode. */
  project_bytes_thumbnail_cache: number
  /** Free disk and what waits in `_trash` (the owner empties it himself). */
  space: StorageSpaceSummary
  /** True when external_final_video_root is configured (drives UI hints). */
  external_root_configured: boolean
  /** The configured root path (resolved with ~ expansion). Empty if unset. */
  external_root: string
  episodes: StorageEntry[]
}

export interface StorageSpaceSummary {
  /** Free space on the drive holding the project folder; null when it could not be measured (never 0 for "unknown"). */
  free_bytes: number | null
  /** This project's `_trash` folders (project, media drive, exports folder). */
  project_trash_bytes: number
  /** Every project's `_trash` plus the Library's own `_trash`. */
  library_trash_bytes: number
}

/** Free bytes on the drive holding `dir`, or null when the drive cannot be asked. */
export async function measureFreeBytes(dir: string): Promise<number | null> {
  try {
    const stat = await fs.statfs(dir)
    return Number(stat.bsize) * Number(stat.bavail)
  } catch { return null }
}

/** Every `_trash` that belongs to one project: its own, and the ones on a media drive or the exports folder. */
async function projectTrashDirs(slug: string): Promise<string[]> {
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) return []
  const dirs = [path.join(projectDir, '_trash')]
  const meta = await pm.getProject(slug).catch(() => null) as { media_root?: string; output_root?: string } | null
  if (meta?.media_root) {
    try {
      const { resolveAssetPath } = await import('./path-resolver.js')
      const anchor = resolveAssetPath(String(meta.media_root), await pm.getProjectOutputRoot(slug) || projectDir)
      if (anchor) dirs.push(trashRootFor(anchor, projectDir, slug))
    } catch { /* media drive not defined on this Mac */ }
  }
  const exportsRoot = await getExternalFinalVideoRoot().catch(() => '')
  if (exportsRoot) dirs.push(trashRootFor(exportsRoot, projectDir, slug))
  return [...new Set(dirs.map(dir => path.resolve(dir)))]
}

/** Free disk and `_trash` sizes for Settings → Free up space and "What's using space". */
export async function storageSpaceSummary(slug: string): Promise<StorageSpaceSummary> {
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) throw new Error('Project not found')
  const sizeOf = async (dirs: string[]) => (await Promise.all(dirs.map(dirSize))).reduce((a, b) => a + b, 0)
  const project = await sizeOf(await projectTrashDirs(slug))
  const others: string[] = [path.join(pm.projectsRoot(), '_trash')]
  for (const summary of await pm.listProjects().catch(() => [])) {
    if (summary.slug !== slug) others.push(...await projectTrashDirs(summary.slug))
  }
  return {
    free_bytes: await measureFreeBytes(projectDir),
    project_trash_bytes: project,
    library_trash_bytes: project + await sizeOf([...new Set(others.map(dir => path.resolve(dir)))]),
  }
}

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v'])
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

function ext(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

function isFinalVideoName(code: string, name: string): boolean {
  return isFinalVideoFilename(code, name) && VIDEO_EXTS.has(ext(name))
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
export async function dirSize(dir: string): Promise<number> {
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
  const [{ records: operations, state: publishingState }, assignment] = await Promise.all([
    readYouTubeRetentionStores(slug),
    getProjectYouTubeAssignment(slug),
  ])

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
        bytes_audio: 0, bytes_narration_parts: 0, bytes_images: 0, bytes_other: 0,
        bytes_total: 0, bytes_external_final_video: 0,
        final_video_filenames: [],
        uploaded_to_youtube: false, youtube_video_id: '', cleanup_eligible: false,
      }
    }

    // Video dir — classified breakdown.
    const v = await auditVideoDir(code, paths.video_dir)

    // Audio (per-chapter chunks + merged) and images (scenes + thumbs)
    // — these are bulk numbers; the user isn't cleaning at this level.
    const [audioBytes, partsBytes, mergedBytes, sceneBytes, thumbBytes, motionClipBytes] = await Promise.all([
      dirSize(paths.audio_dir),
      dirSize(path.join(paths.audio_dir, PARTS_DIRNAME)),
      dirSize(paths.merged_audio_dir),
      dirSize(paths.bg_dir),
      dirSize(paths.thumb_dir),
      // "11 Video Assets": the per-scene image-to-video clips, often the
      // heaviest folder after the final video. It used to be missing here.
      paths.video_assets_dir && path.resolve(paths.video_assets_dir) !== path.resolve(paths.video_dir)
        ? dirSize(paths.video_assets_dir) : Promise.resolve(0),
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
    const externalFinalPaths: string[] = []
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
            const candidate = path.join(extDir, name)
            try {
              bytesExternalFinal += (await fs.stat(candidate)).size
              externalFinalPaths.push(candidate)
            } catch { /* skip */ }
          }
        }
      } catch { /* unresolvable; leave 0 */ }
    }

    // Canonical operation/reconcile evidence plus the historical sidecar.
    let uploaded = false
    let videoId = ''
    const evidence = await youtubeRetentionEvidenceFor(
      slug, code, idea.title || '', operations, publishingState,
    )
    const remote = evidence.accepted_operations[0]
      ?? evidence.reconcile_link
      ?? evidence.legacy_sidecar
    if (remote?.video_id) {
      uploaded = true
      videoId = remote.video_id
    }
    const finalCandidates = [
      ...v.final_video_filenames.map(name => path.join(paths.video_dir, name)),
      ...externalFinalPaths,
    ]
    const cleanupEligible = finalCandidates.length > 0 && !!assignment
      && evidence.ready_operations.some(record => record.channel_id === assignment.channel_id
        && isContentSha256Revision(record.source_revision))
    const cleanupReason = finalCandidates.length > 0 && uploaded && !cleanupEligible
      ? 'No current-channel YouTube operation records a content SHA-256 for this final.'
      : cleanupEligible
        ? 'The exact local final and current YouTube processing state will be verified immediately before deletion.'
        : undefined

    const audioTotal = audioBytes + mergedBytes
    const imageTotal = sceneBytes + thumbBytes
    const otherTotal = scriptBytes + scenePromptsBytes + thumbPromptsBytes + metadataBytes + subtitlesBytes
    const clipsTotal = v.bytes_per_scene_clips + motionClipBytes
    const total = v.bytes_final_video + clipsTotal + v.bytes_other_video
      + audioTotal + imageTotal + otherTotal

    return {
      episode_code: code,
      title: idea.title || code,
      project_episode_dir: paths.episode_dir,
      external_episode_dir: externalEpisodeDir,
      bytes_final_video: v.bytes_final_video,
      bytes_per_scene_clips: clipsTotal,
      bytes_audio: audioTotal,
      bytes_narration_parts: partsBytes,
      bytes_images: imageTotal,
      bytes_other: otherTotal + v.bytes_other_video,
      bytes_total: total,
      bytes_external_final_video: bytesExternalFinal,
      final_video_filenames: v.final_video_filenames,
      uploaded_to_youtube: uploaded,
      youtube_video_id: videoId,
      cleanup_eligible: cleanupEligible,
      ...(cleanupReason ? { cleanup_reason: cleanupReason } : {}),
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
  let projectBytesParts = 0
  let projectBytesExternalFinal = 0
  for (const r of results) {
    projectBytesTotal += r.bytes_total
    projectBytesFinal += r.bytes_final_video
    projectBytesScenes += r.bytes_per_scene_clips
    projectBytesParts += r.bytes_narration_parts
    projectBytesExternalFinal += r.bytes_external_final_video
  }

  return {
    project_bytes_total: projectBytesTotal,
    project_bytes_final_video: projectBytesFinal,
    project_bytes_per_scene_clips: projectBytesScenes,
    project_bytes_narration_parts: projectBytesParts,
    project_bytes_external_final_video: projectBytesExternalFinal,
    project_bytes_thumbnail_cache: await thumbCacheBytes(pm.getProjectDir(slug) || ''),
    space: await storageSpaceSummary(slug),
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
  /** Retained for callers written before exact remote verification became mandatory; it cannot bypass it. */
  force?: boolean
}

function cleanupRefusal(code: string, reason: string): Error & { statusCode: number } {
  return Object.assign(
    new Error(`Final video for ${code} is not confirmed as the uploaded render (${reason}).`),
    { statusCode: 412 },
  )
}

async function verifyFinalCleanupCandidates(
  slug: string,
  code: string,
  title: string,
  candidates: string[],
): Promise<Map<string, string>> {
  const assignment = await getProjectYouTubeAssignment(slug)
  if (!assignment) throw cleanupRefusal(code, 'no current YouTube channel is assigned')
  const evidence = await youtubeRetentionEvidenceFor(slug, code, title)
  const verifiedOperations = new Map<string, Promise<void>>()
  const verifiedRevisions = new Map<string, string>()
  for (const file of candidates) {
    const proof = await youtubeRetentionProofForFile(evidence, file)
    if (!proof.usable || !proof.source_revision || !proof.operation_id || !proof.video_id || proof.channel_id !== assignment.channel_id) {
      throw cleanupRefusal(code, proof.reason || 'the exact local final has no ready content-hash receipt on the current channel')
    }
    let verified = verifiedOperations.get(proof.operation_id)
    if (!verified) {
      verified = (async () => {
        let fresh: Awaited<ReturnType<typeof syncYouTubePublicationState>>
        try {
          fresh = await syncYouTubePublicationState({
            project_slug: slug,
            operation_id: proof.operation_id!,
            account_id: registryCredentialFor(assignment.channel_id),
          })
        } catch {
          throw cleanupRefusal(code, 'YouTube could not freshly verify the exact uploaded video')
        }
        if (fresh.state.lifecycle !== 'ready') {
          throw cleanupRefusal(code, `YouTube currently reports ${fresh.state.lifecycle}`)
        }
        if (fresh.details?.channelId !== assignment.channel_id) {
          throw cleanupRefusal(code, 'YouTube did not confirm the video on the current channel')
        }
      })()
      verifiedOperations.set(proof.operation_id, verified)
    }
    await verified
    verifiedRevisions.set(file, proof.source_revision)
  }
  return verifiedRevisions
}

/**
 * Move the final video files for a single episode (never a hard delete: they
 * go to `_trash`) at both the project-tree location and the external root (if configured + present).
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
  void opts
  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')

  const ideas = await im.getIdeas(slug, 'accepted')
  const idea = ideas.find(
    i => (i.episode_code || '').toUpperCase() === episodeCode.toUpperCase(),
  )
  if (!idea) throw new Error(`No accepted episode with code ${episodeCode}`)

  const code = idea.episode_code!

  const items: CleanupItem[] = []
  const paths = await resolveEpisodePaths(slug, code, idea.title || '')

  // Collect candidate paths from the project tree video_dir.
  const candidates: string[] = []
  // Nothing is hard-deleted: each verified final moves to `_trash` on its own volume.
  const trashTargets = new Map<string, string>()
  const projectDir = pm.getProjectDir(slug)!
  if (existsSync(paths.video_dir)) {
    let entries: string[] = []
    try { entries = await fs.readdir(paths.video_dir) } catch { /* ignore */ }
    for (const name of entries) {
      if (isFinalVideoName(code, name)) {
        const full = path.join(paths.video_dir, name)
        candidates.push(full)
        trashTargets.set(full, path.join(trashRootFor(projectDir, projectDir, slug), code, 'final_video', name))
      }
    }
  }
  // Also collect from the external root, if the user has finals there.
  try {
    const extDir = await resolveExternalFinalVideoDir(slug, code, idea.title || '')
    if (extDir && existsSync(extDir)) {
      let entries: string[] = []
      try { entries = await fs.readdir(extDir) } catch { /* ignore */ }
      for (const name of entries) {
        if (isFinalVideoName(code, name)) {
          const full = path.join(extDir, name)
          candidates.push(full)
          const extRoot = await getExternalFinalVideoRoot().catch(() => '')
          trashTargets.set(full, path.join(trashRootFor(extRoot || path.dirname(extDir), projectDir, slug), code, 'final_video', name))
        }
      }
    }
  } catch { /* external root unset → noop */ }

  if (candidates.length === 0) {
    return { items, bytes_freed: 0, deleted_count: 0, skipped_count: 0, failed_count: 0 }
  }

  // Every deletion re-hashes THESE local bytes and refreshes that exact remote
  // video on the currently assigned channel. Historical receipts remain visible
  // in the audit but cannot authorize deletion without this fresh proof.
  const verifiedRevisions = await verifyFinalCleanupCandidates(slug, code, idea.title || '', candidates)

  // Check every candidate again before deleting any one of them. An episode can
  // have a project-tree and external final; discovering that the second changed
  // after deleting the first would leave an unreported partial cleanup.
  for (const file of candidates) {
    let revision: string
    try {
      revision = await withFinalVideoPathLock(file, () => resolveYouTubeSourceRevision(file))
    } catch {
      throw cleanupRefusal(code, `the local final is no longer readable: ${path.basename(file)}`)
    }
    if (revision !== verifiedRevisions.get(file)) {
      throw cleanupRefusal(code, 'the local final changed after its exact remote verification')
    }
  }

  let bytesFreed = 0
  let deleted = 0
  let failed = 0
  let skipped = 0
  for (const file of candidates) {
    const item = await withFinalVideoPathLock(file, async (): Promise<CleanupItem> => {
      let currentRevision: string
      let size: number
      try {
        currentRevision = await resolveYouTubeSourceRevision(file)
        size = (await fs.stat(file)).size
      } catch (error: any) {
        return {
          episode_code: code,
          file,
          status: 'skipped',
          bytes_freed: 0,
          reason: `the local final could not be reread after exact remote verification (${error?.message || 'file missing'})`,
        }
      }
      if (currentRevision !== verifiedRevisions.get(file)) {
        return {
          episode_code: code,
          file,
          status: 'skipped',
          bytes_freed: 0,
          reason: 'the local final changed after its exact remote verification',
        }
      }
      try {
        // status stays 'deleted' for API compatibility: the file left its place; it now waits in _trash.
        moveToTrashSync(file, trashTargets.get(file)!)
        return { episode_code: code, file, status: 'deleted', bytes_freed: size }
      } catch (error: any) {
        return {
          episode_code: code,
          file,
          status: 'failed',
          bytes_freed: 0,
          reason: error?.message || 'move to _trash failed',
        }
      }
    })
    items.push(item)
    if (item.status === 'deleted') {
      bytesFreed += item.bytes_freed
      deleted++
    } else if (item.status === 'skipped') {
      skipped++
    } else {
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
    skipped_count: skipped,
    failed_count: failed,
  }
}

/**
 * Bulk variant: cleanup final videos across multiple episodes in one pass.
 * Each content-hash candidate is freshly verified; missing, stale, or non-ready
 * remote evidence skips deletion.
 *
 * `episode_codes` lists the codes to clean. When empty + `all_uploaded` is
 * true, every accepted episode with a current content-hash receipt is checked.
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
    const [{ records: operations, state: publishingState }, assignment] = await Promise.all([
      readYouTubeRetentionStores(slug),
      getProjectYouTubeAssignment(slug),
    ])
    const checks = await Promise.all(ideas.map(async (i) => {
      const evidence = await youtubeRetentionEvidenceFor(
        slug, i.episode_code!, i.title || '', operations, publishingState,
      )
      return assignment && evidence.ready_operations.some(record => record.channel_id === assignment.channel_id
        && isContentSha256Revision(record.source_revision))
        ? i.episode_code!
        : null
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
          reason: e?.message || 'The exact final was not freshly verified on YouTube.',
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
 * `migrateFinalsToExternal` was DELETED in v1.4.5, and deliberately not replaced.
 *
 * It moved finals out of the project tree into the exports root, and its
 * cross-volume branch was:
 *
 *     await fs.copyFile(from, to)
 *     await fs.rm(from, { force: true })
 *
 * No size check, no checksum, no upload check. A `copyFile` that throws was
 * handled — but one that reports success while truncating, which is what flaky
 * USB and network volumes actually do, deleted the master anyway. External
 * volumes are exactly where finished videos get moved to.
 *
 * It also had almost nothing left to do: at the time of removal ONE final
 * remained in a project tree across the whole library (0.6 GB), because since
 * v1.4.3 renders are written straight to `<Library>/Exports`.
 *
 * The job it did is covered by v1.4.4's archive sweep, which verifies by size
 * AND sha256 before removing anything, previews first, records a breadcrumb,
 * and refuses to touch a video that cannot be proven uploaded. Two ways to move
 * a finished video, one of them unverified, is not a choice worth keeping.
 *
 * Do not reinstate this. If a project-tree final ever needs relocating, point
 * the archive sweep at the Library.
 */

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

interface MigrationDirectoryIdentity {
  path: string
  dev: bigint
  ino: bigint
}

interface MigrationFileIdentity {
  dev: number
  ino: number
  nlink: number
  size: number
  ctimeMs: number
  mtimeMs: number
}

function sameMigrationFileIdentity(left: MigrationFileIdentity, right: MigrationFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.size === right.size
    && left.ctimeMs === right.ctimeMs && left.mtimeMs === right.mtimeMs
}

function sameMigrationDirectoryChain(
  left: readonly MigrationDirectoryIdentity[],
  right: readonly MigrationDirectoryIdentity[],
): boolean {
  return left.length === right.length && left.every((entry, index) => (
    entry.path === right[index]?.path && entry.dev === right[index]?.dev && entry.ino === right[index]?.ino
  ))
}

/** Canonicalize the trusted root, then reject links in every owned descendant. */
async function snapshotMigrationDirectoryChain(
  root: string,
  target: string,
  createMissing = false,
  createdDirectories?: Set<string>,
): Promise<MigrationDirectoryIdentity[]> {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  const relative = path.relative(resolvedRoot, resolvedTarget)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('migration directory is outside its configured storage root')
  }
  if (createMissing) {
    const missing: string[] = []
    let cursor = resolvedRoot
    while (true) {
      try {
        await fs.lstat(cursor)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        missing.push(cursor)
        const parent = path.dirname(cursor)
        if (parent === cursor) throw new Error('migration storage root has no existing ancestor')
        cursor = parent
      }
    }
    await fs.mkdir(resolvedRoot, { recursive: true })
    for (const directory of missing) createdDirectories?.add(directory)
  }

  // macOS exposes platform aliases such as /var -> /private/var. The selected
  // root is trusted and canonicalized once; links below it remain forbidden.
  const canonicalRoot = await fs.realpath(resolvedRoot)
  const identities: MigrationDirectoryIdentity[] = []
  let cursor = canonicalRoot
  for (const segment of ['.', ...relative.split(path.sep).filter(Boolean)]) {
    if (segment !== '.') cursor = path.join(cursor, segment)
    if (createMissing && segment !== '.') {
      try {
        await fs.mkdir(cursor)
        createdDirectories?.add(cursor)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const stat = await fs.lstat(cursor, { bigint: true })
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`unsafe symbolic-link migration directory: ${cursor}`)
    }
    identities.push({ path: cursor, dev: stat.dev, ino: stat.ino })
  }
  return identities
}

/** Make the copied leaf name and every newly created ancestor entry durable. */
async function fsyncMigrationDestinationDirectories(
  destinationDir: string,
  createdDirectories: ReadonlySet<string>,
): Promise<void> {
  if (process.platform === 'win32') return
  const directories = new Set<string>([path.resolve(destinationDir)])
  for (const created of createdDirectories) {
    const resolved = path.resolve(created)
    directories.add(resolved)
    directories.add(path.dirname(resolved))
  }
  const ordered = [...directories].sort((left, right) => (
    right.split(path.sep).length - left.split(path.sep).length || right.localeCompare(left)
  ))
  for (const directory of ordered) {
    const handle = await fs.open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

async function openRegularMigrationFile(file: string, label: string, flags = constants.O_RDONLY) {
  const before = await fs.lstat(file)
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error(`unsafe ${label}: symbolic links, hard links, and non-files are not migration candidates`)
  }
  const handle = await fs.open(file, flags | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    const after = await fs.lstat(file)
    if (!opened.isFile() || opened.nlink !== 1
      || !sameMigrationFileIdentity(before, opened)
      || !sameMigrationFileIdentity(opened, after)) {
      throw new Error(`unsafe ${label}: it changed while being opened`)
    }
    return { handle, identity: opened }
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}

async function migrateVerifiedFile(input: {
  from: string
  to: string
  sourceRoot: string
  sourceDir: string
  destinationRoot: string
  destinationDir: string
  createdDestinationDirectories: Set<string>
  differentDestination: string
  changedSource: string
}): Promise<number> {
  const sourceDirectories = await snapshotMigrationDirectoryChain(input.sourceRoot, input.sourceDir)
  const destinationDirectories = await snapshotMigrationDirectoryChain(
    input.destinationRoot,
    input.destinationDir,
    true,
    input.createdDestinationDirectories,
  )
  const source = await openRegularMigrationFile(input.from, 'migration source')
  let destination: Awaited<ReturnType<typeof openRegularMigrationFile>> | null = null
  try {
    const sourceRevision = await resolveYouTubeSourceRevisionFromHandle(source.handle)
    try {
      destination = await openRegularMigrationFile(input.to, 'migration destination', constants.O_RDWR)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await fs.copyFile(input.from, input.to, constants.COPYFILE_EXCL)
      destination = await openRegularMigrationFile(input.to, 'copied migration destination', constants.O_RDWR)
    }
    if (!destination) throw new Error('migration destination could not be opened safely')

    if (await resolveYouTubeSourceRevisionFromHandle(destination.handle) !== sourceRevision) {
      throw new Error(input.differentDestination)
    }

    // A matching page-cache read is not crash durability. Flush the exact
    // no-follow destination handle, then revalidate both sides before deleting.
    await destination.handle.sync()

    const currentSourceRevision = await resolveYouTubeSourceRevisionFromHandle(source.handle)
    const currentSourceIdentity = await source.handle.stat()
    const currentSourcePathIdentity = await fs.lstat(input.from)
    if (currentSourceRevision !== sourceRevision
      || !sameMigrationFileIdentity(source.identity, currentSourceIdentity)
      || !sameMigrationFileIdentity(currentSourceIdentity, currentSourcePathIdentity)) {
      throw new Error(input.changedSource)
    }

    const currentDestinationRevision = await resolveYouTubeSourceRevisionFromHandle(destination.handle)
    const currentDestinationIdentity = await destination.handle.stat()
    const currentDestinationPathIdentity = await fs.lstat(input.to)
    if (currentDestinationRevision !== sourceRevision
      || !sameMigrationFileIdentity(destination.identity, currentDestinationIdentity)
      || !sameMigrationFileIdentity(currentDestinationIdentity, currentDestinationPathIdentity)) {
      throw new Error('the destination changed during migration; the source was kept')
    }

    const currentSourceDirectories = await snapshotMigrationDirectoryChain(input.sourceRoot, input.sourceDir)
    const currentDestinationDirectories = await snapshotMigrationDirectoryChain(
      input.destinationRoot,
      input.destinationDir,
    )
    if (!sameMigrationDirectoryChain(sourceDirectories, currentSourceDirectories)
      || !sameMigrationDirectoryChain(destinationDirectories, currentDestinationDirectories)) {
      throw new Error('a migration directory changed during verification; the source was kept')
    }

    await fsyncMigrationDestinationDirectories(
      input.destinationDir,
      input.createdDestinationDirectories,
    )
    input.createdDestinationDirectories.clear()

    // Hashing and directory walks are intentionally outside this final cheap
    // check. Re-pin both open leaves to their current pathnames immediately
    // before the path-based source removal.
    const [finalSourceIdentity, finalSourcePathIdentity, finalDestinationIdentity, finalDestinationPathIdentity] = await Promise.all([
      source.handle.stat(),
      fs.lstat(input.from),
      destination.handle.stat(),
      fs.lstat(input.to),
    ])
    if (!sameMigrationFileIdentity(source.identity, finalSourceIdentity)
      || !sameMigrationFileIdentity(finalSourceIdentity, finalSourcePathIdentity)) {
      throw new Error(input.changedSource)
    }
    if (!sameMigrationFileIdentity(destination.identity, finalDestinationIdentity)
      || !sameMigrationFileIdentity(finalDestinationIdentity, finalDestinationPathIdentity)) {
      throw new Error('the destination changed during migration; the source was kept')
    }

    await fs.rm(input.from)
    return source.identity.size
  } finally {
    await destination?.handle.close().catch(() => {})
    await source.handle.close().catch(() => {})
  }
}

/**
 * Move a project's existing HEAVY media subfolders (scene images, thumbnails,
 * audio, merged audio, final video) from the iCloud/project tree to the
 * configured `media_root` (e.g. an external SSD). iCloud→SSD is cross-volume,
 * so this is copy-verify-delete; it's resumable (byte-identical files already at
 * the destination need no new copy) and reversible (clear media_root + run again
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
    throw new Error(`Media root ${mediaRootRaw} can't be resolved on this Mac — change or clear it in Settings → Project files & behavior → Advanced. ${e?.message || ''}`.trim(), { cause: e })
  }
  if (!mediaRootAbs || /^\$\{/.test(mediaRootAbs)) {
    throw new Error(`Media root ${mediaRootRaw} can't be resolved on this Mac — change or clear it in Settings → Project files & behavior → Advanced.`)
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

      try {
        await snapshotMigrationDirectoryChain(outputRoot, sourceDir)
      } catch (e: any) {
        result.errors.push({ episode_code: code, reason: `unsafe source folder ${sourceDir}: ${e?.message || e}` })
        continue
      }
      let files: string[]
      try { files = await fs.readdir(sourceDir) } catch { continue }
      let folderBytes = 0
      let folderFiles = 0
      const createdDestinationDirectories = new Set<string>()
      if (!dryRun) {
        try {
          await snapshotMigrationDirectoryChain(
            mediaRootAbs,
            destDir,
            true,
            createdDestinationDirectories,
          )
        } catch (e: any) {
          result.errors.push({ episode_code: code, reason: `unsafe destination folder ${destDir}: ${e?.message || e}` })
          continue
        }
      }
      for (const name of files) {
        const from = path.join(sourceDir, name)
        let st
        try { st = await fs.lstat(from) } catch { continue }
        if (st.isSymbolicLink()) {
          result.errors.push({ episode_code: code, reason: `unsafe symbolic-link migration source: ${from}` })
          continue
        }
        if (!st.isFile()) continue   // heavy subfolders are flat; skip stray dirs
        folderBytes += st.size
        folderFiles++
        if (dryRun) continue
        const to = path.join(destDir, name)
        try {
          const versionPrefix = `${code}_final_video_v`
          const stem = path.basename(name, path.extname(name))
          const isVersionedFinal = stem.startsWith(versionPrefix)
            && /^\d+$/.test(stem.slice(versionPrefix.length)) && VIDEO_EXTS.has(ext(name))
          const finalVideo = key === 'video' && (isFinalVideoName(code, name) || isVersionedFinal)
          // Generic media and finals share one deletion-grade path: no linked
          // leaves or descendant directories, exact bytes, and stable inode,
          // timestamps and directory identities before the source is removed.
          const [first, second] = [from, to].map(file => path.resolve(file)).sort()
          await withFinalVideoPathLock(first!, () => withFinalVideoPathLock(second!, async () => {
            const movedBytes = await migrateVerifiedFile({
              from,
              to,
              sourceRoot: outputRoot,
              sourceDir,
              destinationRoot: mediaRootAbs,
              destinationDir: destDir,
              createdDestinationDirectories,
              differentDestination: finalVideo
                ? 'a different final already exists at the destination; both files were kept'
                : `a different ${name} already exists at the destination; both files were kept`,
              changedSource: finalVideo
                ? 'the source final changed during migration; the current source was kept'
                : `the source ${name} changed during migration; the current source was kept`,
            })
            result.bytes_moved += movedBytes
            result.files_moved++
          }))
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
