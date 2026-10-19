import { isFinalVideoFilename } from '../lib/final-video-name.js'
import { randomUUID } from 'node:crypto'
import { episodeDirNameMatchesCode } from './asset-status.js'
import { closeSync, constants as fsConstants, existsSync, lstatSync, openSync, readSync, realpathSync, renameSync, unlinkSync, utimesSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import { assertDecodableImage } from '../lib/image-validation.js'
import { moveToTrashSync, trashRootFor } from '../lib/trash-move.js'
import { SCENE_ANALYSIS_DIR } from './outline-masks.js'
import type { Job } from '../models/types.js'
import { isUpdateHoldingForRestart } from './app-update.js'
import * as im from './idea-manager.js'
import * as jq from './job-queue.js'
import * as pm from './project-manager.js'
import { getProjectYouTubeAssignment } from './youtube-connection-store.js'
import { withFinalVideoPathLock } from './final-video-lock.js'
import { listVideoPublicationDetails, registryCredentialFor } from '../lib/youtube-client.js'
import { clearImageValidationCache } from '../lib/image-validation.js'
import { readSidecarStrict, type UploadSidecar } from './upload-sidecar.js'
import { isYouTubeVideoRemoved } from './youtube-project-publishing-store.js'
import { exportsAnchorFor, resolveExternalFinalVideoDir } from './external-video-store.js'
import { resolveAssetPath } from './path-resolver.js'
import { videoAssemblySourceStampPath } from './video-visual-source.js'
import { narrationPartsToFree, PARTS_DIRNAME, trashEpisodeParts, trashTargetFor } from './chapter-parts.js'
import { listStorageLeftovers, trashStorageLeftovers, type LeftoverKind } from './storage-leftovers.js'
import {
  createProjectFactsCache,
  resolveEpisodePathsByCode,
  resolveEpisodePathsByCodeWithSidecar,
  resolveEpisodeTitleByCode,
  type ProjectFactsCache,
} from './utils.js'
import { readYouTubeRetentionStores, youtubeRetentionEvidenceFor, youtubeRetentionProofForFile } from './youtube-remote-video.js'
import { isConfirmedGoneFromYouTube, syncYouTubePublicationState } from './youtube-publication-status.js'
import { resolveYouTubeSourceRevision, resolveYouTubeSourceRevisionCached } from './youtube-source-video.js'
import { verifyTimeoutMs, withTimeout } from '../lib/with-timeout.js'

export const MEDIA_CLEANUP_SIDECAR = 'local_media_cleanup.json'
export type MediaCleanupCategory = 'images' | 'chapter_audio' | 'narration_parts' | 'merged_audio' | 'master_audio' | 'motion_clips' | 'final_video' | 'scene_analysis'
/**
 * `remove` moves to `_trash` (never a hard delete); `compress` re-encodes scene
 * images as JPEG in place (originals to `_trash`) and moves every other
 * selected category to `_trash`.
 */
export type MediaCleanupMode = 'archive' | 'remove' | 'compress'
/**
 * The one-click preset: shrink scene images, trash clips, chapter narration and the uploaded final.
 * Chapter narration always took the kept narration parts with it (they live in the audio folder),
 * so the preset keeps doing so through their own category, whole folders at a time.
 */
export const ARCHIVE_EPISODE_CATEGORIES: MediaCleanupCategory[] = ['images', 'chapter_audio', 'narration_parts', 'motion_clips', 'final_video']
/** Measured 2026-09-30: mozjpeg q90 of a generated scene PNG is 11.7% of its size. */
const JPEG_SIZE_RATIO = 0.117
const MIN_COMPRESSION_GAIN = 0.8
const ALREADY_JPEG = 'Already a JPEG.'
/**
 * "Convert PNG Scenes to JPEG": scene images only, ANY episode, uploaded or not.
 * It changes the file format and nothing else — the JPEG keeps the ORIGINAL
 * filename (the app sniffs real bytes, exactly as "Smaller files" already
 * stores new scenes), its dimensions and its mtime — so scene_plan,
 * task-manifest, review approvals and Video Assembly inputs need no update and
 * nothing is regenerated. Originals go to `_trash`.
 */
export const CONVERT_PNG_PRESET = 'convert_png'
/**
 * All-channel maintenance (owner request 2026-10-17): one control that shrinks
 * scene images across every channel, and one that clears uploaded final videos
 * across every channel. The backend enumerates the channels itself
 * (`pm.listProjects()`), so the frontend never passes a channel list.
 *
 * The clear control only touches a final video that is BOTH a freshly verified
 * upload on its own channel AND older than this many days of PRODUCTION age.
 * Production age, not upload age: a video uploaded today that was produced two
 * weeks ago still qualifies, and a video produced yesterday does not.
 */
export const LIBRARY_PRODUCTION_AGE_MS = 7 * 24 * 60 * 60 * 1000
/**
 * `cleanup_all` is the merged all-channel sweep the owner asked for (2026-10-17):
 * the verified-and-older-than-7-days final videos of `clear_uploaded_finals`
 * AND the unused leftovers `storage-leftovers` already offers, in one review and
 * one run. It is a distinct action rather than a widening of
 * `clear_uploaded_finals`, so an old client that asks to clear finals never
 * silently starts trashing leftover folders too.
 */
export type LibraryCleanupAction = 'shrink_images' | 'clear_uploaded_finals' | 'cleanup_all'
/** `project_slug` sentinel for an all-channel (Library) operation; never a real channel slug. */
export const LIBRARY_SCOPE = '*'
/** Upload proof for an upload made before receipts existed, once "Check All Uploads" confirmed it. */
const LEGACY_PROOF_PREFIX = 'legacy_sidecar:'

export interface MediaCleanupUploadProof {
  platform: 'youtube'
  video_id: string
  operation_id: string
  channel_id: string
  uploaded_at: string
}

export interface MediaCleanupFile {
  path: string
  real_path: string
  relative_path: string
  source_kind: string
  category: MediaCleanupCategory
  bytes: number
  sha256: string
  mtime_ms: number
  /** Null only for narration parts of an episode that is not uploaded (they never need an upload). */
  upload_proof: MediaCleanupUploadProof | null
  /** Where a trash move lands (before any collision suffix). Same volume as the file. */
  trash_path: string
  /** Scene images only: already JPEG bytes, so compressing skips it. */
  already_jpeg?: boolean
}

export interface MediaCleanupEpisodePreview {
  episode_code: string
  upload_proof: MediaCleanupUploadProof | null
  files: MediaCleanupFile[]
  excluded: Array<{ path: string; category: MediaCleanupCategory; reason: string }>
  blocked_reasons: string[]
}

export interface MediaCleanupPreview {
  preview_id: string
  project_slug: string
  created_at: string
  expires_at: string
  categories: MediaCleanupCategory[]
  episodes: MediaCleanupEpisodePreview[]
  files: MediaCleanupFile[]
  total_bytes: number
  blocked_reasons: string[]
  preset?: 'archive_episode' | typeof CONVERT_PNG_PRESET
  /** The `_trash` folder(s) removed files land in, shown in the confirm text so the owner never has to choose a destination. */
  trash_roots: string[]
  /** What `compress` mode would do; the JPEG figure is an estimate from the measured ratio. */
  estimate: {
    compress_files: number
    compress_bytes_before: number
    compress_bytes_after: number
    already_jpeg_files: number
    trash_files: number
    trash_bytes: number
  }
}

/**
 * How many of a group's files a summary carries.
 *
 * The review shows what will move; the operation GET is not where the whole list
 * travels. A whole-Library preview is ~160k files, and the operation used to
 * carry every one of them TWICE — `files` flat and again inside
 * `channels[].files` — which measured 276 MB and ~8 minutes over the network on
 * the production mini. The full list stays in the server-side preview map; the
 * run reads it from there by `preview_id`.
 *
 * The same bound applies to a RUN's own outcome list (`MediaCleanupRunResult.items`
 * and `CleanupResult.items`): one entry per file is the same payload through a
 * different field, and a whole-Library run touches every file the preview listed.
 * A run carries `item_count` beside the capped sample.
 */
export const PREVIEW_SAMPLE_FILES = 50

/** One episode of a per-channel preview as the operation carries it: the count, plus a sample. */
export interface MediaCleanupEpisodeSummary {
  episode_code: string
  upload_proof: MediaCleanupUploadProof | null
  blocked_reasons: string[]
  /** Every file this episode contributes; `files` holds only the first `PREVIEW_SAMPLE_FILES`. */
  file_count: number
  files: MediaCleanupFile[]
  /** Files left out during discovery. Their reasons are already in `blocked_reasons`. */
  excluded_count: number
}

/**
 * The per-channel preview as the operation GET (and every other read of the
 * operation) carries it: `MediaCleanupPreview` without the whole file list.
 */
export type MediaCleanupPreviewSummary = Omit<MediaCleanupPreview, 'files' | 'episodes'> & {
  episodes: MediaCleanupEpisodeSummary[]
  file_count: number
}

export interface MediaCleanupRunResult {
  mode: MediaCleanupMode
  destination?: string
  items: Array<{
    path: string
    category: MediaCleanupCategory
    outcome: 'archived' | 'removed' | 'compressed' | 'skipped' | 'failed' | 'pending'
    bytes_reclaimed: number
    bytes_moved: number
    bytes_after?: number
    destination_path?: string
    reason?: string
  }>
  /** Every outcome this run produced; `items` holds only the first `PREVIEW_SAMPLE_FILES`. */
  item_count: number
  archived_count: number
  removed_count: number
  compressed_count: number
  skipped_count: number
  failed_count: number
  pending_count: number
  /** Bytes freed on the source drive. A trash move frees nothing until the owner empties `_trash`. */
  bytes_reclaimed: number
  /** Bytes archived to another folder. */
  bytes_moved: number
  /** Bytes now waiting in `_trash` (removed files and compressed originals). */
  bytes_trashed: number
  /** Bytes of the JPEGs that replaced the compressed originals. */
  bytes_after: number
  /** `cleanup_all` only: leftover folders moved to `_trash`, their bytes, and any left in place. */
  leftovers_moved?: number
  leftovers_bytes_moved?: number
  leftovers_left?: number
}

/** One reviewed file of an all-channel preview; the channel travels with the file. */
export interface LibraryCleanupFile extends MediaCleanupFile {
  project_slug: string
  channel_name: string
  episode_code: string
  /**
   * The app's render-completed production time in ms, or null when it is unknown.
   * Only the final-clearing actions (`clear_uploaded_finals`, `cleanup_all`) use
   * it; the shrink action leaves it null.
   */
  production_ms: number | null
}

export interface LibraryCleanupChannel {
  slug: string
  name: string
  files: LibraryCleanupFile[]
  total_bytes: number
  /** Why some of this channel's episodes were left out, in words. */
  blocked_reasons: string[]
}

/** One unused leftover offered by `cleanup_all`, with the channel it belongs to. */
export interface LibraryLeftover {
  project_slug: string
  channel_name: string
  kind: LeftoverKind
  episode_code: string
  path: string
  bytes: number
  /** Where it moves: a `_trash` the owner empties himself. */
  trash_path: string
}

/**
 * Two channels can name the same physical leftover folder (a shared or symlinked
 * episode folder). It is one folder, so it is offered, counted and moved once.
 * Identity is the real path when it exists, the resolved path otherwise; the
 * first owner keeps the entry so a reported path is never rewritten.
 */
export function dedupeLibraryLeftovers(items: LibraryLeftover[]): LibraryLeftover[] {
  const seen = new Set<string>()
  const out: LibraryLeftover[] = []
  for (const item of items) {
    let key: string
    try { key = realpathSync(item.path) } catch { key = path.resolve(item.path) }
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

export interface LibraryCleanupPreview {
  preview_id: string
  action: LibraryCleanupAction
  created_at: string
  expires_at: string
  channels: LibraryCleanupChannel[]
  files: LibraryCleanupFile[]
  total_bytes: number
  blocked_reasons: string[]
  /** The `_trash` folder(s) removed files land in (clear) or the JPEG originals go to (shrink). */
  trash_roots: string[]
  estimate: MediaCleanupPreview['estimate']
  /**
   * `cleanup_all` only: the unused leftovers offered alongside the finals,
   * reported separately so the review never presents a leftover folder as an
   * uploaded video. Absent for the single-purpose actions.
   */
  leftovers?: { count: number; total_bytes: number; items: LibraryLeftover[] }
}

/** One channel of an all-channel preview as the operation carries it: the count, plus a sample. */
export interface LibraryCleanupChannelSummary {
  slug: string
  name: string
  total_bytes: number
  /** Why some of this channel's episodes were left out, in words. */
  blocked_reasons: string[]
  /** Every file this channel contributes; `files` holds only the first `PREVIEW_SAMPLE_FILES`. */
  file_count: number
  files: LibraryCleanupFile[]
}

/**
 * The all-channel preview as the operation GET (and every other read of the
 * operation) carries it: `LibraryCleanupPreview` without the whole file list.
 */
export type LibraryCleanupPreviewSummary = Omit<LibraryCleanupPreview, 'files' | 'channels'> & {
  channels: LibraryCleanupChannelSummary[]
  file_count: number
}

export interface MediaCleanupOperation {
  id: string
  project_slug: string
  kind: 'preview' | 'run'
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stopping' | 'stopped'
  /** `verifying`: reading final videos to match them with their YouTube uploads. */
  stage: 'checking' | 'verifying' | 'archiving' | 'removing' | 'compressing' | null
  /** Episodes (preview), final videos (verifying) or files (run) done of total. */
  done: number
  total: number
  /** Bytes done of total: finals read (verifying), files handled (run). 0/0 while listing. */
  bytes_done: number
  bytes_total: number
  current: string
  /** What is happening right now, in words ("Reading TN0137_final_video.mp4 — 1.2 of 4.8 GB"). */
  detail: string
  created_at: string
  updated_at: string
  error?: string
  preview?: MediaCleanupPreviewSummary
  result?: MediaCleanupRunResult
  /** Clear Uploaded Videos' outcome (`startTrackedCleanup`). */
  final_cleanup?: import('./storage-audit.js').CleanupResult
  stop_requested?: boolean
  /** Set on an all-channel (Library) maintenance operation; `project_slug` is then `LIBRARY_SCOPE`. */
  library?: boolean
  library_action?: LibraryCleanupAction
  /** The all-channel preview, when `library` is set (`preview` stays for the per-channel path). Bounded: the run reads the full list by `preview_id`. */
  library_preview?: LibraryCleanupPreviewSummary
  /** Channels walked so far of the total, so the all-channel progress line can name its place. */
  channels_done?: number
  channels_total?: number
}

export interface LocalMediaCleanupCategoryStatus {
  category: MediaCleanupCategory
  removed_files: number
  archived_files: number
  pending_files: number
  bytes_reclaimed: number
  /** Removed files that sit in `_trash` (not yet freed). */
  bytes_trashed: number
}

export interface LocalMediaCleanupStatus {
  state: 'available' | 'archived' | 'partially_removed' | 'removed'
  updated_at: string | null
  has_retired_media: boolean
  /** Set when the "Archive episode" preset finished cleanly for this episode. */
  preset_archived_at: string | null
  categories: LocalMediaCleanupCategoryStatus[]
  blocked_reason?: string
}

type SidecarOutcome = 'pending_archive' | 'pending_remove' | 'archived' | 'removed' | 'compressed' | 'skipped' | 'failed'

interface MediaCleanupSidecarEntry {
  entry_id: string
  source_path: string
  relative_path: string
  source_kind?: string
  category: MediaCleanupCategory
  bytes: number
  bytes_reclaimed: number
  sha256: string
  preview_id: string
  operation_id: string
  mode: MediaCleanupMode
  outcome: SidecarOutcome
  recorded_at: string
  updated_at: string
  destination_path?: string
  reason?: string
  upload_proof: MediaCleanupUploadProof
}

interface MediaCleanupSidecar {
  version: 1
  project_slug: string
  episode_code: string
  updated_at: string
  archived_at?: string
  entries: MediaCleanupSidecarEntry[]
}

interface CleanupHooks {
  getJobs?: (slug: string) => Promise<Array<Pick<Job, 'project_slug' | 'episode_id' | 'type' | 'status'>>>
  afterArchiveCopy?: (source: string, target: string) => Promise<void>
  beforeDestructiveMutation?: () => Promise<void>
  afterFile?: () => Promise<void>
}

interface RootSpec {
  root: string
  anchor: string
  source_kind: string
  category: MediaCleanupCategory
  /** `<trash root>/<code>/<category>/<source_kind>`: files land here under their relative path. */
  trash_dir: string
  accepts(name: string): boolean
  /** A subfolder this root never walks into (chapter audio leaves `.parts` to Narration parts). */
  skip_dir?: string
}

const operations = new Map<string, MediaCleanupOperation>()
const previews = new Map<string, MediaCleanupPreview>()
const libraryPreviews = new Map<string, LibraryCleanupPreview>()
const consumedPreviews = new Set<string>()
const PREVIEW_TTL_MS = 30 * 60 * 1_000
const OPERATION_RETENTION_MS = 2 * 60 * 60 * 1_000
const MAX_OPERATIONS = 200
/**
 * The statuses at which an operation no longer holds this Mac. Everything else counts as holding it,
 * so a status this build does not recognise keeps the Mac held rather than releasing it by accident.
 * One predicate, used by the start gate, the retention prune and the updater's wait alike, so the
 * three can never disagree about whether a cleanup is running.
 */
const TERMINAL_OPERATION_STATUSES = new Set<MediaCleanupOperation['status']>(['completed', 'failed', 'stopped'])
function isActiveOperation(operation: MediaCleanupOperation): boolean {
  return !TERMINAL_OPERATION_STATUSES.has(operation.status)
}
const CATEGORIES = new Set<MediaCleanupCategory>(['images', 'chapter_audio', 'narration_parts', 'merged_audio', 'master_audio', 'motion_clips', 'final_video', 'scene_analysis'])
/** 1.4.281's levelled lossless master beside the merged mp3 (`lib/level-audio.ts`): `{name}.master.flac`. */
const MASTER_AUDIO = /\.master\.flac$/i
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac)$/i
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i
const ACTIVE_STATUSES = new Set(['queued', 'running', 'paused'])
let hooks: CleanupHooks = {}

function fail(message: string, statusCode = 400): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode })
}

function isoNow(): string { return new Date().toISOString() }

function cloneOperation(operation: MediaCleanupOperation): MediaCleanupOperation {
  return structuredClone(operation)
}

/**
 * What an operation carries in place of a whole preview. The preview itself
 * stays in `previews` / `libraryPreviews` (the run reads it by `preview_id`), so
 * everything that hands an operation to a caller — the operation GETs, the stop
 * routes, and retention's own read — hands out counts and a capped sample
 * instead of every file. See `PREVIEW_SAMPLE_FILES` for the measurement.
 */
function summarizeMediaCleanupPreview(preview: MediaCleanupPreview): MediaCleanupPreviewSummary {
  const { files, episodes, ...rest } = preview
  return {
    ...rest,
    file_count: files.length,
    episodes: episodes.map(episode => ({
      episode_code: episode.episode_code,
      upload_proof: episode.upload_proof,
      blocked_reasons: episode.blocked_reasons,
      file_count: episode.files.length,
      files: episode.files.slice(0, PREVIEW_SAMPLE_FILES),
      excluded_count: episode.excluded.length,
    })),
  }
}

function summarizeLibraryPreview(preview: LibraryCleanupPreview): LibraryCleanupPreviewSummary {
  const { files, ...rest } = preview
  return {
    ...rest,
    file_count: files.length,
    channels: preview.channels.map(channel => ({
      ...channel,
      file_count: channel.files.length,
      files: channel.files.slice(0, PREVIEW_SAMPLE_FILES),
    })),
  }
}

function pruneState(): void {
  const now = Date.now()
  for (const [id, preview] of previews) {
    if (Date.parse(preview.expires_at) <= now) {
      previews.delete(id)
      consumedPreviews.delete(id)
    }
  }
  for (const [id, preview] of libraryPreviews) {
    if (Date.parse(preview.expires_at) <= now) {
      libraryPreviews.delete(id)
      consumedPreviews.delete(id)
    }
  }
  for (const [id, operation] of operations) {
    if (!isActiveOperation(operation)
      && now - Date.parse(operation.updated_at) > OPERATION_RETENTION_MS) operations.delete(id)
  }
  if (operations.size <= MAX_OPERATIONS) return
  const removable = [...operations.values()]
    .filter(operation => !isActiveOperation(operation))
    .sort((left, right) => Date.parse(left.updated_at) - Date.parse(right.updated_at))
  for (const operation of removable) {
    if (operations.size <= MAX_OPERATIONS) break
    operations.delete(operation.id)
  }
}

function validateCategories(value: unknown): MediaCleanupCategory[] {
  if (!Array.isArray(value) || value.length === 0) throw fail('Choose at least one media category.')
  const categories = [...new Set(value)]
  if (categories.some(category => typeof category !== 'string' || !CATEGORIES.has(category as MediaCleanupCategory))) {
    throw fail('Media cleanup categories contain an unsupported value.')
  }
  return categories as MediaCleanupCategory[]
}

function resolveCategories(input: { categories: unknown; preset?: unknown }): MediaCleanupCategory[] {
  if (input.preset === undefined || input.preset === null || input.preset === '') return validateCategories(input.categories)
  if (input.preset === CONVERT_PNG_PRESET) return ['images']
  if (input.preset !== 'archive_episode') throw fail('Unknown media cleanup preset.')
  return [...ARCHIVE_EPISODE_CATEGORIES]
}

function validateEpisodeCodes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw fail('Choose at least one episode.')
  const codes = [...new Set(value.map(code => typeof code === 'string' ? code.trim().toUpperCase() : ''))]
  if (codes.some(code => !/^[A-Z]{1,12}\d{1,8}$/.test(code))) throw fail('Episode codes contain an unsupported value.')
  return codes
}

interface UploadInventory {
  channel_id: string | null
  records: Awaited<ReturnType<typeof readYouTubeRetentionStores>>['records']
  /** Legacy (pre-receipt) uploads YouTube confirmed `processed` on this channel. */
  legacy: Map<string, MediaCleanupUploadProof>
  /** Why an uploaded episode has no proof yet, by code — shown instead of silence. */
  why: Map<string, string>
}

const CHECK_ALL = 'press Check All Uploads (Upload Center) so YouTube can confirm it'

function operationWhy(record: UploadInventory['records'][number]): string {
  switch (record.lifecycle) {
    case 'accepted':
    case 'processing': return `YouTube has not confirmed this upload yet — ${CHECK_ALL}.`
    case 'failed': return 'YouTube reports this upload failed.'
    case 'rejected': return 'YouTube rejected this upload.'
    case 'status_unavailable': return isConfirmedGoneFromYouTube(record)
      ? 'YouTube no longer has this video.'
      : `YouTube's last answer about this upload was unclear — ${CHECK_ALL}.`
    default: return 'The upload has not finished.'
  }
}

/** The legacy proof, or why there is none. Only YouTube's own `processed` answer on this channel counts. */
function legacyProof(
  sidecar: UploadSidecar | null,
  channel: string,
  state: Awaited<ReturnType<typeof readYouTubeRetentionStores>>['state'],
  code: string,
): MediaCleanupUploadProof | string | null {
  const videoId = sidecar?.video_id?.trim()
  if (!sidecar || !videoId) return null
  if (sidecar.deleted_at || isYouTubeVideoRemoved(state, code, sidecar.channel_id || channel, videoId)) return 'Its YouTube video is marked as deleted.'
  const check = sidecar.youtube_check
  if ((sidecar.channel_id || check?.channel_id) && (sidecar.channel_id || check?.channel_id) !== channel) {
    return 'It was uploaded to a different YouTube channel.'
  }
  if (!check) return `Uploaded before Story Studio kept upload receipts — ${CHECK_ALL}.`
  if (check.upload_status !== 'processed' || check.channel_id !== channel) {
    return check.upload_status === 'not_found'
      ? 'YouTube no longer has this video.'
      : `YouTube's last answer was "${check.upload_status}", not processed — ${CHECK_ALL}.`
  }
  if (!Number.isFinite(Date.parse(sidecar.uploaded_at))) return 'Its upload receipt has no upload time.'
  return {
    platform: 'youtube', video_id: videoId, operation_id: `${LEGACY_PROOF_PREFIX}${videoId}`,
    channel_id: channel, uploaded_at: sidecar.uploaded_at,
  }
}

async function loadUploadInventory(slug: string, codes?: string[]): Promise<UploadInventory> {
  const [assignment, stores] = await Promise.all([
    getProjectYouTubeAssignment(slug),
    readYouTubeRetentionStores(slug),
  ])
  const channel = assignment?.channel_id ?? null
  const legacy = new Map<string, MediaCleanupUploadProof>()
  const why = new Map<string, string>()
  if (!channel) return { channel_id: null, records: stores.records, legacy, why }
  const wanted = codes ?? (await im.getIdeas(slug, 'accepted'))
    .map(idea => String(idea.episode_code || '').toUpperCase()).filter(Boolean)
  for (const code of wanted) {
    const records = stores.records.filter(record => record.episode_code.toUpperCase() === code && !!record.video_id)
    if (records.length) {
      // The operation record rules when there is one.
      const onChannel = records.filter(record => record.channel_id === channel)
        .sort((a, b) => Date.parse(b.accepted_at || '') - Date.parse(a.accepted_at || ''))
      if (!onChannel.some(record => record.lifecycle === 'ready')) {
        why.set(code, onChannel[0] ? operationWhy(onChannel[0]) : 'It was uploaded to a different YouTube channel.')
      }
      continue
    }
    const found = legacyProof(await readSidecarStrict(slug, code, 'youtube').catch(() => null), channel, stores.state, code)
    if (typeof found === 'string') why.set(code, found)
    else if (found) legacy.set(code, found)
  }
  return { channel_id: channel, records: stores.records, legacy, why }
}

function currentUploadProof(code: string, inventory: UploadInventory): MediaCleanupUploadProof | null {
  const assignment = inventory.channel_id
  if (!assignment) return null
  const record = inventory.records
    .filter(candidate => candidate.episode_code.toUpperCase() === code.toUpperCase()
      && candidate.channel_id === assignment
      && candidate.lifecycle === 'ready'
      && !!candidate.video_id?.trim()
      && !!candidate.accepted_at
      && Number.isFinite(Date.parse(candidate.accepted_at)))
    .sort((a, b) => Date.parse(b.accepted_at!) - Date.parse(a.accepted_at!))[0]
  return record ? {
    platform: 'youtube',
    video_id: record.video_id!,
    operation_id: record.operation_id,
    channel_id: record.channel_id,
    uploaded_at: record.accepted_at!,
  } : inventory.legacy.get(code.toUpperCase()) ?? null
}

export async function listMediaCleanupEpisodes(slug: string): Promise<{
  /** Uploaded episodes, plus not-uploaded ones with kept narration parts (`video_id` null: only Narration parts apply). */
  episodes: Array<{ episode_code: string; title: string; video_id: string | null; local_media_status: LocalMediaCleanupStatus }>
  /** Why there is less (or nothing) to offer, in counts the owner can act on. */
  blocked_reasons: string[]
  /** Uploaded episodes that are NOT offered, each with its reason. */
  not_offered: Array<{ episode_code: string; title: string; reason: string }>
  /** Every accepted episode: "Convert PNG Scenes to JPEG" applies to all of them. */
  all_episodes: Array<{ episode_code: string; title: string }>
}> {
  if (!await pm.getProject(slug)) throw fail('Project not found', 404)
  const accepted = await im.getIdeas(slug, 'accepted')
  const inventory = await loadUploadInventory(slug, accepted.map(idea => String(idea.episode_code || '').toUpperCase()).filter(Boolean))
  const projectFacts = createProjectFactsCache(slug)
  const episodes = (await Promise.all(accepted.map(async (idea) => {
    const code = String(idea.episode_code || '').toUpperCase()
    if (!code) return null
    const proof = currentUploadProof(code, inventory)
    if (!proof && !await hasNarrationParts(slug, code, projectFacts)) return null
    return {
      episode_code: code,
      title: idea.title || code,
      video_id: proof?.video_id ?? null,
      local_media_status: await readLocalMediaCleanupStatus(slug, code, projectFacts),
    }
  }))).filter((episode): episode is NonNullable<typeof episode> => episode !== null)
  const titleOf = new Map(accepted.map(idea => [String(idea.episode_code || '').toUpperCase(), idea.title || String(idea.episode_code)]))
  const notOffered = [...inventory.why].map(([code, reason]) => ({ episode_code: code, title: titleOf.get(code) || code, reason }))
  const counts = new Map<string, number>()
  for (const row of notOffered) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1)
  const blocked = [...counts].sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${count} uploaded ${count === 1 ? 'episode' : 'episodes'}: ${reason}`)
  if (!inventory.channel_id) blocked.unshift('This project has no YouTube channel assigned, so no upload can be confirmed. Assign one in Settings → YouTube.')
  else if (!episodes.some(episode => episode.video_id) && !notOffered.length) blocked.unshift('No episode of this project has been uploaded to YouTube yet.')
  return {
    episodes,
    blocked_reasons: blocked,
    not_offered: notOffered,
    all_episodes: accepted.filter(idea => idea.episode_code)
      .map(idea => ({ episode_code: String(idea.episode_code).toUpperCase(), title: idea.title || String(idea.episode_code) })),
  }
}

async function hasNarrationParts(slug: string, code: string, cache: ProjectFactsCache): Promise<boolean> {
  const paths = await resolveEpisodePathsByCode(slug, code, cache).catch(() => null)
  return !!paths && (await fs.readdir(path.join(paths.audio_dir, PARTS_DIRNAME)).catch(() => [])).length > 0
}

/** Where heavy media lives: the project, or the `media_root` folder on its own drive. */
async function mediaAnchorFor(slug: string, paths: Awaited<ReturnType<typeof resolveEpisodePathsByCode>>): Promise<string> {
  const projectDir = pm.getProjectDir(slug)!
  const meta = await pm.getProject(slug)
  if (!(meta as any)?.media_root || paths.bg_dir.startsWith(`${projectDir}${path.sep}`)) return projectDir
  try { return resolveAssetPath(String((meta as any).media_root), paths.output_root) }
  catch { return path.dirname(path.dirname(paths.bg_dir)) }
}

async function relevantActiveJobs(slug: string, code: string, categories: MediaCleanupCategory[]) {
  void categories
  const getJobs = hooks.getJobs ?? jq.getJobs
  const jobs = await getJobs(slug)
  // Only THIS episode's own work matters (1.4.289). A render of another episode used to refuse
  // every check and run (the Mac mini always has one going), and a run held every new render:
  // Free up space and Video Assembly no longer wait for each other. Moves are renames; the one
  // image at a time a shrink re-encodes (sharp concurrency 1, no cache) fits beside a render.
  return jobs.filter(job => String(job.episode_id || '').toUpperCase() === code.toUpperCase()
    && ACTIVE_STATUSES.has(job.status))
}

/** Why an episode is skipped while its own work is queued or running, and what to do. */
function busyReason(code: string, active: Array<Pick<Job, 'type'>>): string {
  const kinds = [...new Set(active.map(job => job.type.replaceAll('_', ' ')))].join(', ')
  return `${code} has ${kinds} queued or running for this episode. Let it finish (or cancel it in Jobs), then check again.`
}

function isFinalName(code: string, name: string): boolean {
  return isFinalVideoFilename(code, name) && VIDEO_EXT.test(name)
}

async function rootsFor(slug: string, code: string, title: string, categories: MediaCleanupCategory[]): Promise<RootSpec[]> {
  const paths = await resolveEpisodePathsByCode(slug, code)
  const projectDir = pm.getProjectDir(slug)!
  const heavyAnchor = await mediaAnchorFor(slug, paths)
  const selected = new Set(categories)
  const roots: RootSpec[] = []
  const add = (root: string, anchor: string, source_kind: string, category: MediaCleanupCategory, accepts: (name: string) => boolean, skip_dir?: string) =>
    roots.push({ root, anchor, source_kind, category, accepts, skip_dir, trash_dir: path.join(trashRootFor(anchor, projectDir, slug), code, category, source_kind) })
  // Thumbnails (`thumb_dir`) are never cleanup candidates: the originals stay.
  if (selected.has('images')) add(paths.bg_dir, heavyAnchor, 'scene_images', 'images', name => IMAGE_EXT.test(name))
  // Kept narration parts are their own category, moved a whole `.parts/<chapter>` folder at a time
  // (a half-moved folder would make a later Generate remake every part).
  if (selected.has('chapter_audio')) add(paths.audio_dir, heavyAnchor, 'chapter_audio', 'chapter_audio', name => AUDIO_EXT.test(name), PARTS_DIRNAME)
  // "Full-quality audio of uploaded episodes" (1.4.285) is the `.master.flac` alone; when both are
  // chosen, merged audio leaves the master to its own category so no file is listed twice.
  if (selected.has('merged_audio')) add(paths.merged_audio_dir, heavyAnchor, 'merged_audio', 'merged_audio', name => AUDIO_EXT.test(name) && !(selected.has('master_audio') && MASTER_AUDIO.test(name)))
  if (selected.has('master_audio')) add(paths.merged_audio_dir, heavyAnchor, 'master_audio', 'master_audio', name => MASTER_AUDIO.test(name))
  if (selected.has('motion_clips')) add(paths.video_assets_dir, heavyAnchor, 'motion_clips', 'motion_clips', name => VIDEO_EXT.test(name))
  // E2–E4 (1.4.288) — depth maps and found outlines beside the episode (Q12).
  if (selected.has('scene_analysis')) add(path.join(paths.episode_dir, SCENE_ANALYSIS_DIR), projectDir, 'scene_analysis', 'scene_analysis', name => /\.(json|png)$/i.test(name))
  if (selected.has('final_video')) {
    add(paths.video_dir, heavyAnchor, 'final_video', 'final_video', name => isFinalName(code, name))
    const external = await resolveExternalFinalVideoDir(slug, code, title).catch(() => null)
    if (external && path.resolve(external) !== path.resolve(paths.video_dir)) {
      const externalAnchor = await exportsAnchorFor(slug, external).catch(() => '')
      add(external, externalAnchor || path.dirname(external), 'external_final_video', 'final_video', name => isFinalName(code, name))
    }
  }
  return roots
}

function isPngFile(file: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const head = Buffer.alloc(4)
    return readSync(fd, head, 0, 4, 0) === 4 && head.readUInt32BE(0) === 0x89504e47
  } catch { return false } finally { if (fd !== undefined) closeSync(fd) }
}

function isJpegFile(file: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const head = Buffer.alloc(3)
    return readSync(fd, head, 0, 3, 0) === 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
  } catch { return false } finally { if (fd !== undefined) closeSync(fd) }
}

/**
 * Content identity. Cached by size, mtime and inode (a move to the Trash can always be
 * undone, so a file is read once, not three times); `fresh` re-reads every byte, for
 * archiving, which removes the original.
 */
async function sha256(file: string, onBytes?: (bytes: number) => void, fresh = false): Promise<string> {
  const revision = fresh ? await resolveYouTubeSourceRevision(file, onBytes) : await resolveYouTubeSourceRevisionCached(file, onBytes)
  return revision.slice('sha256:'.length)
}

const GB = 1024 ** 3
const sizeText = (bytes: number) => bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`

/** Bytes-read callback that keeps `operation.detail` saying which file is being read and how far. */
export function readingProgress(operation: MediaCleanupOperation, file: { path: string; bytes: number }, verb: string): (bytes: number) => void {
  let read = 0
  operation.detail = `${verb} ${path.basename(file.path)} — 0 of ${sizeText(file.bytes)}`
  return (bytes) => {
    read += bytes
    operation.detail = `${verb} ${path.basename(file.path)} — ${sizeText(read)} of ${sizeText(file.bytes)} read`
    operation.updated_at = isoNow()
  }
}

/**
 * Run other Free up space work (Clear Uploaded Videos) as an operation of this same
 * registry: one at a time on this Mac, followed with `GET …/media-cleanup/operations/:id`,
 * stopped with its `/stop`. `work` updates the progress fields as it goes.
 */
export async function startTrackedCleanup(
  slug: string,
  stage: MediaCleanupOperation['stage'],
  work: (operation: MediaCleanupOperation) => Promise<NonNullable<MediaCleanupOperation['final_cleanup']>>,
): Promise<{ operation_id: string }> {
  pruneState()
  if (!await pm.getProject(slug)) throw fail('Project not found', 404)
  if (hasActiveOperation()) throw fail('A media cleanup check or operation is already running on this Mac. Wait for it to finish.', 409)
  const operation = beginOperation(slug, 'run', stage)
  setImmediate(() => void (async () => {
    operation.status = 'running'
    operation.updated_at = isoNow()
    try {
      operation.final_cleanup = await work(operation)
      operation.detail = ''
      finishOperation(operation, operation.stop_requested ? 'stopped' : 'completed')
    } catch (error) {
      finishOperation(operation, 'failed', error)
    }
  })())
  return { operation_id: operation.id }
}

async function discoverRoot(
  spec: RootSpec,
  /** Null only for "Convert PNG Scenes to JPEG", which needs no upload. */
  proof: MediaCleanupUploadProof | null,
  shouldStop: () => boolean,
  episodeCode: string,
  pngOnly = false,
): Promise<{ files: MediaCleanupFile[]; excluded: MediaCleanupEpisodePreview['excluded'] }> {
  const files: MediaCleanupFile[] = []
  const excluded: MediaCleanupEpisodePreview['excluded'] = []
  let rootStat: Awaited<ReturnType<typeof fs.lstat>>
  try { rootStat = await fs.lstat(spec.root) } catch (error: any) {
    if (error?.code === 'ENOENT') return { files, excluded }
    throw error
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    excluded.push({ path: spec.root, category: spec.category, reason: 'The media root is not a private regular directory.' })
    return { files, excluded }
  }
  const absoluteRoot = path.resolve(spec.root)
  const absoluteAnchor = path.resolve(spec.anchor)
  const relativeFromAnchor = path.relative(absoluteAnchor, absoluteRoot)
  if (relativeFromAnchor.startsWith('..') || path.isAbsolute(relativeFromAnchor)) {
    excluded.push({ path: spec.root, category: spec.category, reason: 'This media root is outside its configured private storage root.' })
    return { files, excluded }
  }
  const ownerSegments = relativeFromAnchor.split(path.sep).filter(Boolean)
  // v1.4.192 — this gate decides whether a media root may be DELETED, so a
  // bare prefix here is worse than the read-side copies: episode EP0001 would
  // accept an `EP00012 - ...` ancestor as its own and enumerate another
  // episode's media for removal. Same strict rule as `episodeDirNameMatchesCode`.
  if (!ownerSegments.some(segment => episodeDirNameMatchesCode(segment, episodeCode))) {
    excluded.push({ path: spec.root, category: spec.category, reason: 'This media root cannot be proven to belong only to this episode.' })
    return { files, excluded }
  }
  const segments = [absoluteAnchor, ...ownerSegments.map((_, index) => path.join(absoluteAnchor, ...ownerSegments.slice(0, index + 1)))]
  for (const ancestor of segments) {
    const stat = await fs.lstat(ancestor).catch(() => null)
    if (!stat || stat.isSymbolicLink()) {
      excluded.push({ path: ancestor, category: spec.category, reason: 'A symbolic-link ancestor makes this media root shared or ambiguous.' })
      return { files, excluded }
    }
  }

  async function walk(dir: string): Promise<void> {
    if (shouldStop()) return
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (shouldStop()) return
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        excluded.push({ path: full, category: spec.category, reason: 'Symbolic links are never cleanup candidates.' })
        continue
      }
      if (entry.isDirectory()) { if (entry.name !== spec.skip_dir) await walk(full); continue }
      if (!entry.isFile() || !spec.accepts(entry.name)) continue
      // Converting needs real PNG bytes; a JPEG (even under .png) is never hashed or listed.
      if (pngOnly && !isPngFile(full)) continue
      const stat = await fs.lstat(full)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        excluded.push({ path: full, category: spec.category, reason: 'Only regular files may be cleaned.' })
        continue
      }
      if (stat.nlink !== 1) {
        excluded.push({ path: full, category: spec.category, reason: 'Files with another hard link are shared and were left alone.' })
        continue
      }
      if (proof && Math.floor(stat.mtimeMs) > Date.parse(proof.uploaded_at)) {
        excluded.push({ path: full, category: spec.category, reason: 'This media is newer than the verified upload and may be regenerated.' })
        continue
      }
      files.push({
        path: full,
        real_path: await fs.realpath(full),
        relative_path: path.relative(spec.root, full),
        source_kind: spec.source_kind,
        category: spec.category,
        bytes: stat.size,
        sha256: '', // read once, when the file is acted on (mutateReviewedFile)
        mtime_ms: stat.mtimeMs,
        upload_proof: proof,
        trash_path: path.join(spec.trash_dir, path.relative(spec.root, full)),
        ...(spec.source_kind === 'scene_images' ? { already_jpeg: isJpegFile(full) } : {}),
      })
    }
  }
  await walk(spec.root)
  return { files, excluded }
}

/** YouTube's answer within `verifyTimeoutMs()`, or a clear "no answer" instead of a hang. */
function askYouTube<T>(work: Promise<T>): Promise<T> {
  const seconds = Math.round(verifyTimeoutMs() / 1000)
  return withTimeout(work, verifyTimeoutMs(), `YouTube did not answer within ${seconds} seconds, so this file stays where it is. Check the internet connection and try again later.`)
}

const youtubeFailure = (error: any, fallback: string) => error?.code === 'ETIMEDOUT' ? error.message : fallback

async function verifyFinalProof(
  slug: string, code: string, title: string, file: MediaCleanupFile, onBytes?: (bytes: number) => void,
): Promise<string | null> {
  const assignment = await getProjectYouTubeAssignment(slug)
  if (!assignment) return 'No current YouTube channel is assigned.'
  if (file.upload_proof?.operation_id.startsWith(LEGACY_PROOF_PREFIX)) {
    // Uploaded before receipts recorded a content hash, so the local file is
    // matched the way archive proofs are: not changed after the upload time
    // (checked when listed and again before moving). YouTube is asked afresh,
    // and the file only ever moves to _trash, so nothing is lost.
    try {
      const details = (await askYouTube(listVideoPublicationDetails(slug, registryCredentialFor(assignment.channel_id), [file.upload_proof.video_id])))[file.upload_proof.video_id]
      if (!details) return 'YouTube no longer has this video.'
      if (details.uploadStatus !== 'processed') return `YouTube currently reports ${details.uploadStatus || 'no status'}.`
      if (details.channelId !== assignment.channel_id) return 'YouTube did not confirm the video on the current channel.'
    } catch (error) {
      return youtubeFailure(error, 'YouTube could not freshly verify the uploaded final video. Check that this channel is still connected in Settings → YouTube, then try again.')
    }
    return null
  }
  const evidence = await youtubeRetentionEvidenceFor(slug, code, title)
  const exact = await youtubeRetentionProofForFile(evidence, file.path, onBytes)
  if (!exact.usable || !file.upload_proof || exact.operation_id !== file.upload_proof.operation_id
    || exact.video_id !== file.upload_proof.video_id || exact.channel_id !== assignment.channel_id) {
    return exact.reason || 'The final video is not the exact render in the current ready upload receipt.'
  }
  try {
    const remote = await askYouTube(syncYouTubePublicationState({
      project_slug: slug,
      operation_id: exact.operation_id,
      account_id: registryCredentialFor(assignment.channel_id),
    }))
    if (remote.state.lifecycle !== 'ready') return `YouTube currently reports ${remote.state.lifecycle}.`
    if (remote.details?.channelId !== assignment.channel_id) return 'YouTube did not confirm the video on the current channel.'
  } catch (error) {
    return youtubeFailure(error, 'YouTube could not freshly verify the exact uploaded final video. Check that this channel is still connected in Settings → YouTube, then try again.')
  }
  return null
}

/** Free up space › Narration parts for one episode: whole kept folders and joined loose parts (`narrationPartsToFree`). */
async function narrationPartsFiles(slug: string, code: string, proof: MediaCleanupUploadProof | null): Promise<MediaCleanupFile[]> {
  const paths = await resolveEpisodePathsByCode(slug, code)
  const projectDir = pm.getProjectDir(slug)!
  const anchor = await mediaAnchorFor(slug, paths)
  return (await narrationPartsToFree(paths.audio_dir)).map(item => ({
    path: item.path, real_path: item.path, relative_path: item.relative_path,
    source_kind: 'narration_parts', category: 'narration_parts' as const,
    bytes: item.bytes, sha256: '', mtime_ms: 0, upload_proof: proof,
    trash_path: trashTargetFor(projectDir, item.path, anchor),
  }))
}

/**
 * Narration parts move whole (a `.parts/<chapter>` folder in one rename) through `trashEpisodeParts`,
 * which checks again that the joined chapter is still there. Never archived, never recorded in the
 * cleanup sidecar (they are not upload-backed media), never hard-deleted.
 */
async function trashReviewedNarrationParts(
  slug: string, code: string, file: MediaCleanupFile, mode: MediaCleanupMode,
): Promise<MediaCleanupRunResult['items'][number]> {
  const skipped = (reason: string) => ({ path: file.path, category: file.category, outcome: 'skipped' as const, bytes_reclaimed: 0, bytes_moved: 0, reason })
  if (mode === 'archive') return skipped('Narration parts only move to _trash; nothing was copied or removed.')
  const paths = await resolveEpisodePathsByCode(slug, code)
  const { moved, left } = await trashEpisodeParts(pm.getProjectDir(slug)!, paths.audio_dir, [file.path], await mediaAnchorFor(slug, paths))
  if (!moved.length) return skipped(left[0]?.reason || 'Left where it is.')
  return { path: file.path, category: file.category, outcome: 'removed', bytes_reclaimed: 0, bytes_moved: file.bytes, destination_path: moved[0]!.to }
}

async function buildPreview(
  slug: string,
  input: { episode_codes: unknown; categories: unknown; preset?: unknown },
  operation: MediaCleanupOperation,
): Promise<MediaCleanupPreview> {
  const categories = resolveCategories(input)
  const codes = validateEpisodeCodes(input.episode_codes)
  const convert = input.preset === CONVERT_PNG_PRESET
  if (!await pm.getProject(slug)) throw fail('Project not found', 404)
  const accepted = await im.getIdeas(slug, 'accepted')
  const inventory = await loadUploadInventory(slug, codes)
  const acceptedByCode = new Map(accepted.map(idea => [String(idea.episode_code || '').toUpperCase(), idea]))
  const unknown = codes.filter(code => !acceptedByCode.has(code))
  if (unknown.length) throw fail(`No accepted episode matches ${unknown.join(', ')}.`, 404)

  // Pass 1, listing: names and sizes only (no file is read), so it is quick.
  operation.total = codes.length
  const episodeResults: MediaCleanupEpisodePreview[] = []
  for (const code of codes) {
    if (operation.stop_requested) break
    operation.current = code
    operation.detail = `Listing ${code}'s files`
    operation.updated_at = isoNow()
    const proof = currentUploadProof(code, inventory)
    const episode: MediaCleanupEpisodePreview = {
      episode_code: code, upload_proof: proof, files: [], excluded: [], blocked_reasons: [],
    }
    // Narration parts need no upload (owner decision 2026-10-06): any episode with a joined chapter may free them.
    const partsOnly = !proof && !input.preset && categories.includes('narration_parts')
    const active = await relevantActiveJobs(slug, code, categories)
    if (active.length) {
      episode.blocked_reasons.push(busyReason(code, active))
    } else if (!proof && !partsOnly && !convert) {
      episode.blocked_reasons.push(inventory.why.get(code) || 'This episode has no ready canonical upload on the current YouTube channel.')
    } else {
      const idea = acceptedByCode.get(code)!
      if (categories.includes('narration_parts')) episode.files.push(...await narrationPartsFiles(slug, code, proof))
      if (partsOnly && categories.length > 1) {
        episode.blocked_reasons.push('Not uploaded yet: only its narration parts are offered.')
      }
      for (const root of partsOnly ? [] : await rootsFor(slug, code, idea.title || '', categories.filter(category => category !== 'narration_parts'))) {
        const discovered = await discoverRoot(root, convert ? null : proof!, () => operation.stop_requested === true, code, convert)
        // A loose part already offered as a narration part is not listed twice.
        episode.files.push(...discovered.files.filter(file => !episode.files.some(listed => listed.path === file.path)))
        episode.excluded.push(...discovered.excluded)
      }
    }
    episodeResults.push(episode)
    operation.done += 1
  }

  // Pass 2, verifying: each final video is read once (sha256) and matched with its upload,
  // and YouTube is asked about it, with bytes read shown and a time limit on each answer.
  const finals = episodeResults.flatMap(episode => episode.files.filter(file => file.category === 'final_video')
    .map(file => ({ episode, file })))
  operation.stage = 'verifying'
  operation.done = 0
  operation.total = finals.length
  operation.bytes_total = finals.reduce((n, { file }) => n + file.bytes, 0)
  for (const { episode, file } of finals) {
    if (operation.stop_requested) break
    operation.current = file.path
    operation.updated_at = isoNow()
    const title = acceptedByCode.get(episode.episode_code)?.title || ''
    const reason = await verifyFinalProof(slug, episode.episode_code, title, file, readingProgress(operation, file, 'Matching'))
      .catch((error: any) => `${error?.message || error}`)
    operation.bytes_done = finals.slice(0, operation.done + 1).reduce((n, item) => n + item.file.bytes, 0)
    operation.done += 1
    if (reason) {
      episode.files.splice(episode.files.indexOf(file), 1)
      episode.excluded.push({ path: file.path, category: file.category, reason })
    }
  }
  operation.detail = ''
  for (const episode of episodeResults) episode.blocked_reasons.push(...[...new Set(episode.excluded.map(item => item.reason))])
  const files = episodeResults.flatMap(episode => episode.files)
  const shrinkable = files.filter(file => file.category === 'images' && !file.already_jpeg)
  const trashed = files.filter(file => file.category !== 'images')
  const sum = (list: MediaCleanupFile[]) => list.reduce((total, file) => total + file.bytes, 0)
  const createdAt = isoNow()
  return {
    preview_id: randomUUID(),
    project_slug: slug,
    created_at: createdAt,
    expires_at: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
    categories,
    episodes: episodeResults,
    files,
    total_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    blocked_reasons: [...new Set(episodeResults.flatMap(episode => episode.blocked_reasons))],
    ...(input.preset === 'archive_episode' ? { preset: 'archive_episode' as const } : {}),
    ...(convert ? { preset: CONVERT_PNG_PRESET } : {}),
    trash_roots: [...new Set(files.map((file) => {
      const at = file.trash_path.indexOf(`${path.sep}_trash${path.sep}`)
      return at < 0 ? path.dirname(file.trash_path) : file.trash_path.slice(0, at + '/_trash'.length)
    }))],
    estimate: {
      compress_files: shrinkable.length,
      compress_bytes_before: sum(shrinkable),
      compress_bytes_after: Math.round(sum(shrinkable) * JPEG_SIZE_RATIO),
      already_jpeg_files: files.filter(file => file.already_jpeg).length,
      trash_files: trashed.length,
      trash_bytes: sum(trashed),
    },
  }
}

function beginOperation(slug: string, kind: MediaCleanupOperation['kind'], stage: MediaCleanupOperation['stage']): MediaCleanupOperation {
  pruneState()
  // An update that owns the Mac will restart it in a moment, and a restart kills this work mid-file:
  // it cannot resume. Refusing here — the one place every start path routes through — closes the
  // window between the updater's "nothing is running" check and its quit, in which a new operation
  // would otherwise begin and then be interrupted. Nothing was started, so the caller retries after
  // the restart. This never touches an operation already running: only new ones are refused.
  if (isUpdateHoldingForRestart()) {
    throw fail('Story Studio is installing an update and will restart in a moment, so nothing was started. Try again once it has restarted.', 409)
  }
  const now = isoNow()
  const operation: MediaCleanupOperation = {
    id: randomUUID(), project_slug: slug, kind, status: 'queued', stage,
    done: 0, total: 0, bytes_done: 0, bytes_total: 0, current: '', detail: '', created_at: now, updated_at: now,
  }
  operations.set(operation.id, operation)
  return operation
}

// Server-wide, not per project: one cleanup (hashing, re-encoding) at a time on the Mac mini.
function hasActiveOperation(): boolean {
  return [...operations.values()].some(isActiveOperation)
}

/**
 * The one cleanup/maintenance operation holding this Mac, or null. The same predicate as
 * `hasActiveOperation()`; this form exists so a caller that has to WAIT can say what it is waiting
 * for. The global gate above allows at most one, so the first match is the whole answer.
 */
export function activeMaintenanceOperation(): Pick<MediaCleanupOperation, 'id' | 'kind' | 'status'> | null {
  pruneState()
  const operation = [...operations.values()].find(isActiveOperation)
  return operation ? { id: operation.id, kind: operation.kind, status: operation.status } : null
}

function finishOperation(operation: MediaCleanupOperation, status: 'completed' | 'failed' | 'stopped', error?: unknown): void {
  operation.status = status
  operation.updated_at = isoNow()
  if (error) operation.error = error instanceof Error ? error.message : String(error)
}

export async function startMediaCleanupPreview(
  slug: string,
  input: { episode_codes: unknown; categories: unknown; preset?: unknown },
): Promise<{ operation_id: string }> {
  resolveCategories(input)
  validateEpisodeCodes(input.episode_codes)
  if (!await pm.getProject(slug)) throw fail('Project not found', 404)
  if (hasActiveOperation()) throw fail('A media cleanup check or operation is already running on this Mac. Wait for it to finish.', 409)
  const operation = beginOperation(slug, 'preview', 'checking')
  setImmediate(() => void (async () => {
    operation.status = 'running'
    operation.updated_at = isoNow()
    try {
      const preview = await buildPreview(slug, input, operation)
      if (operation.stop_requested) { finishOperation(operation, 'stopped'); return }
      previews.set(preview.preview_id, preview)
      operation.preview = summarizeMediaCleanupPreview(preview)
      finishOperation(operation, 'completed')
    } catch (error) {
      finishOperation(operation, 'failed', error)
    }
  })())
  return { operation_id: operation.id }
}

function sidecarPath(slug: string, code: string, cache?: ProjectFactsCache): Promise<string> {
  return resolveEpisodePathsByCodeWithSidecar(slug, code, MEDIA_CLEANUP_SIDECAR, cache)
    .then(paths => path.join(paths.episode_dir, MEDIA_CLEANUP_SIDECAR))
}

async function readSidecar(
  file: string,
  strict: boolean,
  expected?: { slug: string; code: string },
): Promise<MediaCleanupSidecar | null> {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as MediaCleanupSidecar
    if (value?.version !== 1
      || typeof value.project_slug !== 'string' || !value.project_slug
      || typeof value.episode_code !== 'string' || !value.episode_code
      || !!expected && (value.project_slug !== expected.slug || value.episode_code.toUpperCase() !== expected.code.toUpperCase())
      || typeof value.updated_at !== 'string' || !Number.isFinite(Date.parse(value.updated_at))
      || value.archived_at !== undefined && (typeof value.archived_at !== 'string' || !Number.isFinite(Date.parse(value.archived_at)))
      || !Array.isArray(value.entries)
      || value.entries.some(entry => !entry
        || typeof entry.entry_id !== 'string' || !entry.entry_id
        || typeof entry.source_path !== 'string' || !path.isAbsolute(entry.source_path)
        || typeof entry.relative_path !== 'string' || path.isAbsolute(entry.relative_path)
        || entry.source_kind !== undefined && (typeof entry.source_kind !== 'string' || !entry.source_kind)
        || typeof entry.preview_id !== 'string' || !entry.preview_id
        || typeof entry.operation_id !== 'string' || !entry.operation_id
        || (entry.mode !== 'archive' && entry.mode !== 'remove' && entry.mode !== 'compress')
        || typeof entry.recorded_at !== 'string' || !Number.isFinite(Date.parse(entry.recorded_at))
        || !CATEGORIES.has(entry.category)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
        || !Number.isSafeInteger(entry.bytes_reclaimed) || entry.bytes_reclaimed < 0
        || !/^[a-f0-9]{64}$/.test(entry.sha256)
        || !['pending_archive', 'pending_remove', 'archived', 'removed', 'compressed', 'skipped', 'failed'].includes(entry.outcome)
        || typeof entry.updated_at !== 'string' || !Number.isFinite(Date.parse(entry.updated_at))
        || !entry.upload_proof || entry.upload_proof.platform !== 'youtube'
        || typeof entry.upload_proof.video_id !== 'string' || !entry.upload_proof.video_id
        || typeof entry.upload_proof.operation_id !== 'string' || !entry.upload_proof.operation_id
        || typeof entry.upload_proof.channel_id !== 'string' || !entry.upload_proof.channel_id
        || typeof entry.upload_proof.uploaded_at !== 'string' || !Number.isFinite(Date.parse(entry.upload_proof.uploaded_at))
        || entry.destination_path !== undefined && (typeof entry.destination_path !== 'string' || !path.isAbsolute(entry.destination_path)))) {
      throw new Error('invalid media cleanup record')
    }
    return value
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    if (strict) throw fail('The local media cleanup record is unreadable. Repair it before cleaning more files.', 409)
    return null
  }
}

async function putSidecarEntry(
  slug: string,
  code: string,
  entry: MediaCleanupSidecarEntry,
): Promise<void> {
  const file = await sidecarPath(slug, code)
  const episodeDir = path.dirname(file)
  const episodeStat = await fs.lstat(episodeDir).catch(() => null)
  if (!episodeStat?.isDirectory() || episodeStat.isSymbolicLink()) {
    throw fail('The episode folder is unavailable or unsafe; no cleanup record was written.', 409)
  }
  await withLock(file, async () => {
    const current = await readSidecar(file, true, { slug, code })
    const entries = current?.entries ? [...current.entries] : []
    const index = entries.findIndex(candidate => candidate.entry_id === entry.entry_id)
    if (index >= 0) entries[index] = entry
    else entries.push(entry)
    const next: MediaCleanupSidecar = {
      ...(current?.archived_at ? { archived_at: current.archived_at } : {}),
      version: 1, project_slug: slug, episode_code: code,
      updated_at: entry.updated_at, entries,
    }
    await writeJsonAtomic(file, next)
  })
  await invalidateEpisodeRow(slug, code)
}

/** The episode list caches this record's summary on the status row; drop it now. */
async function invalidateEpisodeRow(slug: string, code: string): Promise<void> {
  const { episodeStatusCache } = await import('./episode-status-cache.js')
  episodeStatusCache.invalidate(slug, code)
}

async function markEpisodeArchived(slug: string, code: string): Promise<void> {
  const file = await sidecarPath(slug, code)
  await withLock(file, async () => {
    const current = await readSidecar(file, true, { slug, code })
    const now = isoNow()
    await writeJsonAtomic(file, {
      version: 1, project_slug: slug, episode_code: code, entries: [],
      ...current, updated_at: now, archived_at: now,
    } satisfies MediaCleanupSidecar)
  })
  await invalidateEpisodeRow(slug, code)
}

async function currentSourceRoot(
  slug: string,
  code: string,
  entry: MediaCleanupSidecarEntry,
  cache?: ProjectFactsCache,
): Promise<string | null> {
  const paths = await resolveEpisodePathsByCode(slug, code, cache)
  switch (entry.source_kind) {
    case 'scene_images': return paths.bg_dir
    case 'thumbnail_images': return paths.thumb_dir
    case 'chapter_audio': return paths.audio_dir
    case 'merged_audio': return paths.merged_audio_dir
    case 'master_audio': return paths.merged_audio_dir
    case 'motion_clips': return paths.video_assets_dir
    case 'final_video': return paths.video_dir
    case 'external_final_video': {
      const title = await resolveEpisodeTitleByCode(slug, code, cache)
      return resolveExternalFinalVideoDir(slug, code, title).catch(() => null)
    }
    default: return null // Legacy records lack an exact source root, so preserve their retired status.
  }
}

async function restoredAtCurrentPath(
  slug: string,
  code: string,
  entry: MediaCleanupSidecarEntry,
  cache?: ProjectFactsCache,
): Promise<boolean> {
  const root = await currentSourceRoot(slug, code, entry, cache)
  if (!root) return false
  const candidate = path.resolve(root, entry.relative_path)
  const relative = path.relative(path.resolve(root), candidate)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false
  try {
    const stat = await fs.lstat(candidate)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch { return false }
}

async function statusForEntry(
  slug: string,
  code: string,
  entry: MediaCleanupSidecarEntry,
  cache?: ProjectFactsCache,
): Promise<'removed' | 'archived' | 'pending' | null> {
  try { await fs.lstat(entry.source_path); return null }
  catch (error: any) {
    if (error?.code !== 'ENOENT') return null
  }
  if (await restoredAtCurrentPath(slug, code, entry, cache)) return null
  if (entry.outcome === 'removed') return 'removed'
  if (entry.outcome === 'archived') return 'archived'
  if (entry.outcome === 'pending_remove' || entry.outcome === 'pending_archive') return 'pending'
  return null
}

export async function readLocalMediaCleanupStatus(
  slug: string,
  episodeCode: string,
  cache?: ProjectFactsCache,
): Promise<LocalMediaCleanupStatus> {
  cache ??= createProjectFactsCache(slug)
  const file = await sidecarPath(slug, episodeCode, cache)
  const sidecar = await readSidecar(file, false, { slug, code: episodeCode })
  if (!sidecar) {
    const unreadable = existsSync(file)
    return {
      state: 'available', updated_at: null, has_retired_media: false, preset_archived_at: null, categories: [],
      ...(unreadable ? { blocked_reason: 'The local media cleanup record is unreadable.' } : {}),
    }
  }
  const grouped = new Map<MediaCleanupCategory, LocalMediaCleanupCategoryStatus>()
  const latestByPath = new Map<string, MediaCleanupSidecarEntry>()
  for (const entry of sidecar.entries) {
    const key = entry.source_kind
      ? `${entry.category}:${entry.source_kind}:${entry.relative_path}`
      : `${entry.category}:${entry.source_path}`
    const previous = latestByPath.get(key)
    if (!previous || Date.parse(entry.updated_at) >= Date.parse(previous.updated_at)) latestByPath.set(key, entry)
  }
  for (const entry of latestByPath.values()) {
    const effective = await statusForEntry(slug, episodeCode, entry, cache)
    if (!effective) continue
    const row = grouped.get(entry.category) || {
      category: entry.category, removed_files: 0, archived_files: 0, pending_files: 0, bytes_reclaimed: 0, bytes_trashed: 0,
    }
    if (effective === 'removed') row.removed_files += 1
    if (effective === 'archived') row.archived_files += 1
    if (effective === 'pending') row.pending_files += 1
    if (effective !== 'pending') row.bytes_reclaimed += entry.bytes_reclaimed
    if (effective === 'removed' && entry.destination_path) row.bytes_trashed += entry.bytes
    grouped.set(entry.category, row)
  }
  const categories = [...grouped.values()]
  const removed = categories.reduce((sum, row) => sum + row.removed_files, 0)
  const archived = categories.reduce((sum, row) => sum + row.archived_files, 0)
  const pending = categories.reduce((sum, row) => sum + row.pending_files, 0)
  const hasRetired = removed + archived + pending > 0
  const state: LocalMediaCleanupStatus['state'] = !hasRetired ? 'available'
    : archived > 0 && removed === 0 && pending === 0 ? 'archived'
      : 'partially_removed'
  return { state, updated_at: sidecar.updated_at, has_retired_media: hasRetired, preset_archived_at: sidecar.archived_at ?? null, categories }
}

export function archiveDestinationFor(destination: string, projectSlug: string, episodeCode: string, file: MediaCleanupFile): string {
  return path.join(
    path.resolve(destination),
    projectSlug,
    episodeCode.toUpperCase(),
    file.upload_proof?.channel_id ?? 'not-uploaded',
    file.category,
    file.source_kind,
    path.basename(path.dirname(file.path)),
    file.relative_path,
  )
}

function sourceRootFor(file: MediaCleanupFile): string {
  return file.relative_path.split(path.sep).filter(Boolean)
    .reduce(current => path.dirname(current), path.resolve(file.path))
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`)
}

async function safeArchiveDestination(raw: string, preview: MediaCleanupPreview): Promise<string> {
  const requested = path.resolve(raw)
  let existing = requested
  const missing: string[] = []
  while (!existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) throw fail('The archive destination has no accessible parent folder.')
    missing.unshift(path.basename(existing))
    existing = parent
  }
  const existingStat = await fs.lstat(existing)
  if (existingStat.isSymbolicLink() || !existingStat.isDirectory()) {
    throw fail('The archive destination or its nearest existing ancestor is a symbolic link or not a folder.')
  }
  const canonical = path.join(await fs.realpath(existing), ...missing)
  for (const file of preview.files) {
    const sourceRoot = sourceRootFor(file)
    const canonicalSource = await fs.realpath(sourceRoot).catch(() => path.resolve(sourceRoot))
    if (pathsOverlap(canonical, canonicalSource)) {
      throw fail('The archive destination cannot overlap a reviewed media source folder.')
    }
  }
  return canonical
}

async function exactFileStillReviewed(file: MediaCleanupFile): Promise<string | null> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>
  try { stat = await fs.lstat(file.path) } catch { return 'The reviewed file is missing.' }
  if (!stat.isFile() || stat.isSymbolicLink()) return 'The reviewed path is no longer a regular file.'
  if (await fs.realpath(file.path) !== file.real_path) return 'The reviewed file location changed after preview.'
  if (stat.nlink !== 1) return 'The reviewed file now has another hard link.'
  // Size and modification time, not a re-read: the move is to the Trash and can be undone.
  if (stat.size !== file.bytes || stat.mtimeMs !== file.mtime_ms) return 'The reviewed file changed after preview. Check the files again.'
  return null
}

// Keep the final identity check and unlink in one event-loop turn. Episode
// admission is held by the caller; another in-app folder move cannot interleave
// an awaited operation between checking the parent path and removing the file.
function assertReviewedIdentitySync(file: MediaCleanupFile): void {
  const stat = lstatSync(file.path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size !== file.bytes || stat.mtimeMs !== file.mtime_ms
    // `.native`: the same resolver as the preview's `fs.realpath`. The JS `realpathSync`
    // keeps the caller's letter case, so on a case-insensitive disk it disagreed with the
    // reviewed path and refused every file (1.4.329 production: 488 of 488).
    || realpathSync.native(file.path) !== file.real_path) {
    throw fail('The reviewed file changed immediately before removal.', 409)
  }
}

// Only the verified-archive path may unlink: its bytes already sit, hash-checked, in the archive folder.
function unlinkReviewedFile(file: MediaCleanupFile): void {
  assertReviewedIdentitySync(file)
  unlinkSync(file.path)
}

// "Remove" is a move to `_trash`; the owner empties it. A failed move throws and the file stays.
function trashReviewedFile(file: MediaCleanupFile): string {
  assertReviewedIdentitySync(file)
  return moveToTrashSync(file.path, file.trash_path, file.category)
}

async function uploadProofStillCurrent(slug: string, code: string, file: MediaCleanupFile): Promise<string | null> {
  const proof = currentUploadProof(code, await loadUploadInventory(slug, [code.toUpperCase()]))
  if (!proof) return 'The ready canonical upload is no longer available on the current channel.'
  if (proof.operation_id !== file.upload_proof?.operation_id
    || proof.video_id !== file.upload_proof.video_id
    || proof.channel_id !== file.upload_proof.channel_id) {
    return 'The current upload changed after preview.'
  }
  return null
}

async function mutateReviewedFile(
  slug: string,
  preview: MediaCleanupPreview,
  operation: MediaCleanupOperation,
  file: MediaCleanupFile,
  mode: MediaCleanupMode,
  destination: string | undefined,
  /**
   * An extra, action-specific refusal re-checked at mutation, under the same
   * per-file lock and after the file's identity is confirmed. The all-channel
   * clear passes the production-age gate here, so an old preview can never
   * authorize a file whose age is no longer provable. The per-channel path
   * passes nothing and is unchanged.
   */
  gate?: () => Promise<string | null>,
): Promise<MediaCleanupRunResult['items'][number]> {
  const code = preview.episodes.find(episode => episode.files.some(candidate => candidate.path === file.path))!.episode_code
  const active = await relevantActiveJobs(slug, code, [file.category])
  if (active.length) return { path: file.path, category: file.category, outcome: 'skipped', bytes_reclaimed: 0, bytes_moved: 0, reason: busyReason(code, active) }
  if (file.category === 'narration_parts') return trashReviewedNarrationParts(slug, code, file, mode)
  // Converting PNG scenes needs no upload: the image itself is kept, as a JPEG.
  const formatOnly = preview.preset === CONVERT_PNG_PRESET
  const staleUpload = formatOnly ? null : await uploadProofStillCurrent(slug, code, file)
  if (staleUpload) return { path: file.path, category: file.category, outcome: 'skipped', bytes_reclaimed: 0, bytes_moved: 0, reason: staleUpload }
  const changed = await exactFileStillReviewed(file)
  if (changed) return { path: file.path, category: file.category, outcome: 'skipped', bytes_reclaimed: 0, bytes_moved: 0, reason: changed }
  if (gate) {
    const refused = await gate()
    if (refused) return { path: file.path, category: file.category, outcome: 'skipped', bytes_reclaimed: 0, bytes_moved: 0, reason: refused }
  }
  if (!formatOnly && Math.floor((await fs.stat(file.path)).mtimeMs) > Date.parse(file.upload_proof!.uploaded_at)) {
    return { path: file.path, category: file.category, outcome: 'skipped', bytes_reclaimed: 0, bytes_moved: 0, reason: 'The file is newer than its upload proof.' }
  }
  if (file.category === 'final_video') {
    const idea = (await im.getIdeas(slug, 'accepted')).find(candidate => candidate.episode_code === code)
    const reason = await verifyFinalProof(slug, code, idea?.title || '', file, readingProgress(operation, file, 'Matching'))
      .catch((error: any) => `${error?.message || error}`)
    if (reason) return { path: file.path, category: file.category, outcome: 'skipped', bytes_reclaimed: 0, bytes_moved: 0, reason }
  }
  // The cleanup record keeps each file's sha256: read once, here (finals reuse the match above).
  if (!file.sha256) {
    try { file.sha256 = await sha256(file.path, readingProgress(operation, file, 'Reading')) } catch (error: any) {
      return { path: file.path, category: file.category, outcome: 'skipped', bytes_reclaimed: 0, bytes_moved: 0, reason: `${error?.message || error}` }
    }
  }

  const entryBase: Omit<MediaCleanupSidecarEntry, 'outcome' | 'updated_at' | 'upload_proof'> & { upload_proof: MediaCleanupUploadProof | null } = {
    entry_id: randomUUID(), source_path: file.path, relative_path: file.relative_path,
    source_kind: file.source_kind,
    category: file.category, bytes: file.bytes, bytes_reclaimed: 0, sha256: file.sha256,
    preview_id: preview.preview_id, operation_id: operation.id, mode,
    recorded_at: isoNow(), upload_proof: file.upload_proof,
  }

  if (mode === 'compress' && file.category === 'images') return compressReviewedImage(slug, code, file, entryBase, formatOnly)
  if (!file.upload_proof) return { path: file.path, category: file.category, outcome: 'skipped', bytes_reclaimed: 0, bytes_moved: 0, reason: 'Only converting scene images works without an upload.' }
  const recorded = { ...entryBase, upload_proof: file.upload_proof }

  if (mode === 'archive') {
    const target = archiveDestinationFor(destination!, slug, code, file)
    // The copy is made under a scratch name and renamed once it has verified, so a copy that
    // dies half-way (full disk, unplugged drive) never sits under the real name where the next
    // run would read it as "a file already exists at the archive destination" and skip it.
    const partial = `${target}.partial`
    try {
      const sourceDevice = (await fs.stat(file.path)).dev
      await fs.mkdir(path.dirname(target), { recursive: true })
      const sameDevice = (await fs.stat(path.dirname(target))).dev === sourceDevice
      if (existsSync(target)) throw Object.assign(new Error('A file already exists at the archive destination.'), { code: 'EEXIST' })
      await fs.rm(partial, { force: true }) // a stale scratch file from an interrupted run
      await fs.copyFile(file.path, partial, fsConstants.COPYFILE_EXCL)
      await hooks.afterArchiveCopy?.(file.path, partial)
      const [sourceHash, targetHash] = await Promise.all([sha256(file.path, undefined, true), sha256(partial, undefined, true)])
      const targetStat = await fs.stat(partial)
      if (sourceHash !== file.sha256 || targetHash !== file.sha256 || targetStat.size !== file.bytes) {
        throw new Error('The archive copy does not match the reviewed source.')
      }
      const activeAfterCopy = await relevantActiveJobs(slug, code, [file.category])
      if (activeAfterCopy.length) throw new Error(`Active ${activeAfterCopy.map(job => job.type).join(', ')} work started while the archive copy was being verified.`)
      const uploadAfterCopy = await uploadProofStillCurrent(slug, code, file)
      if (uploadAfterCopy) throw new Error(uploadAfterCopy)
      if (file.category === 'final_video') {
        const idea = (await im.getIdeas(slug, 'accepted')).find(candidate => candidate.episode_code === code)
        const reason = await verifyFinalProof(slug, code, idea?.title || '', file)
        if (reason) throw new Error(reason)
      }
      await fs.rename(partial, target)
      const pending: MediaCleanupSidecarEntry = {
        ...recorded, bytes_reclaimed: sameDevice ? 0 : file.bytes,
        destination_path: target, outcome: 'pending_archive', updated_at: isoNow(),
      }
      await putSidecarEntry(slug, code, pending)
      const recheck = await exactFileStillReviewed(file)
      if (recheck) {
        await putSidecarEntry(slug, code, { ...pending, outcome: 'failed', reason: recheck, updated_at: isoNow() })
        return { path: file.path, category: file.category, outcome: 'failed', bytes_reclaimed: 0, bytes_moved: 0, destination_path: target, reason: recheck }
      }
      const finalActive = await relevantActiveJobs(slug, code, [file.category])
      const finalUpload = await uploadProofStillCurrent(slug, code, file)
      if (finalActive.length || finalUpload) {
        const reason = finalUpload || `Active ${finalActive.map(job => job.type).join(', ')} work started before archive removal.`
        await putSidecarEntry(slug, code, { ...pending, outcome: 'failed', reason, updated_at: isoNow() })
        return { path: file.path, category: file.category, outcome: 'failed', bytes_reclaimed: 0, bytes_moved: 0, destination_path: target, reason }
      }
      unlinkReviewedFile(file)
      try {
        await putSidecarEntry(slug, code, { ...pending, outcome: 'archived', updated_at: isoNow() })
        return { path: file.path, category: file.category, outcome: 'archived', bytes_reclaimed: sameDevice ? 0 : file.bytes, bytes_moved: file.bytes, destination_path: target }
      } catch (error: any) {
        return { path: file.path, category: file.category, outcome: 'pending', bytes_reclaimed: sameDevice ? 0 : file.bytes, bytes_moved: file.bytes, destination_path: target, reason: error?.message || String(error) }
      }
    } catch (error: any) {
      await fs.rm(partial, { force: true }).catch(() => {}) // our own scratch copy, never a verified archive
      const collision = error?.code === 'EEXIST'
      return {
        path: file.path, category: file.category, outcome: collision ? 'skipped' : 'failed',
        bytes_reclaimed: 0, bytes_moved: 0, destination_path: target,
        reason: collision ? 'A file already exists at the archive destination.' : error?.message || String(error),
      }
    }
  }

  const pending: MediaCleanupSidecarEntry = { ...recorded, outcome: 'pending_remove', updated_at: isoNow() }
  try {
    await putSidecarEntry(slug, code, pending)
    const activeBeforeRemove = await relevantActiveJobs(slug, code, [file.category])
    const uploadBeforeRemove = await uploadProofStillCurrent(slug, code, file)
    if (activeBeforeRemove.length || uploadBeforeRemove) {
      const reason = uploadBeforeRemove || `Active ${activeBeforeRemove.map(job => job.type).join(', ')} work started before removal.`
      await putSidecarEntry(slug, code, { ...pending, outcome: 'failed', reason, updated_at: isoNow() })
      return { path: file.path, category: file.category, outcome: 'failed', bytes_reclaimed: 0, bytes_moved: 0, reason }
    }
    const recheck = await exactFileStillReviewed(file)
    if (recheck) {
      await putSidecarEntry(slug, code, { ...pending, outcome: 'failed', reason: recheck, updated_at: isoNow() })
      return { path: file.path, category: file.category, outcome: 'failed', bytes_reclaimed: 0, bytes_moved: 0, reason: recheck }
    }
    const finalActive = await relevantActiveJobs(slug, code, [file.category])
    const finalUpload = await uploadProofStillCurrent(slug, code, file)
    if (finalActive.length || finalUpload) {
      const reason = finalUpload || `Active ${finalActive.map(job => job.type).join(', ')} work started before removal.`
      await putSidecarEntry(slug, code, { ...pending, outcome: 'failed', reason, updated_at: isoNow() })
      return { path: file.path, category: file.category, outcome: 'failed', bytes_reclaimed: 0, bytes_moved: 0, reason }
    }
    await hooks.beforeDestructiveMutation?.()
    const trashed = trashReviewedFile(file)
    try {
      await putSidecarEntry(slug, code, { ...pending, outcome: 'removed', destination_path: trashed, updated_at: isoNow() })
      return { path: file.path, category: file.category, outcome: 'removed', bytes_reclaimed: 0, bytes_moved: file.bytes, destination_path: trashed }
    } catch (error: any) {
      return { path: file.path, category: file.category, outcome: 'pending', bytes_reclaimed: 0, bytes_moved: file.bytes, destination_path: trashed, reason: error?.message || String(error) }
    }
  } catch (error: any) {
    // A failed move (or any earlier check) skips this file: it stays exactly where it was.
    await putSidecarEntry(slug, code, { ...pending, outcome: 'failed', reason: error?.message || String(error), updated_at: isoNow() }).catch(() => {})
    return { path: file.path, category: file.category, outcome: 'failed', bytes_reclaimed: 0, bytes_moved: 0, reason: error?.message || String(error) }
  }
}

/**
 * Re-encode one scene image as a JPEG under its ORIGINAL filename (the app
 * sniffs real bytes; renaming would break the `.png` name checks). The original
 * goes to `_trash`, the new file takes its place and its mtime. Idempotent:
 * JPEGs are skipped. Anything that does not decode, keeps its size, or saves
 * under 20% leaves the original untouched.
 */
async function compressReviewedImage(
  slug: string,
  code: string,
  file: MediaCleanupFile,
  entryBase: Omit<MediaCleanupSidecarEntry, 'outcome' | 'updated_at' | 'upload_proof'> & { upload_proof: MediaCleanupUploadProof | null },
  formatOnly = false,
): Promise<MediaCleanupRunResult['items'][number]> {
  const item = (over: Partial<MediaCleanupRunResult['items'][number]> & { outcome: MediaCleanupRunResult['items'][number]['outcome'] }) =>
    ({ path: file.path, category: file.category, bytes_reclaimed: 0, bytes_moved: 0, ...over })
  if (isJpegFile(file.path)) return item({ outcome: 'skipped', reason: ALREADY_JPEG })
  const partial = `${file.path}.partial-${process.pid}`
  let pending: MediaCleanupSidecarEntry | null = null
  try {
    const before = await assertDecodableImage(file.path, 'Scene image')
    const meta = await sharp(file.path).metadata()
    // JPEG has no alpha: a genuinely transparent image would flatten to black.
    if (meta.hasAlpha && !(await sharp(file.path).stats()).isOpaque) {
      return item({ outcome: 'skipped', reason: 'The image has transparency, which JPEG cannot keep.' })
    }
    await sharp(file.path).jpeg({ quality: 90, mozjpeg: true }).toFile(partial)
    const after = await assertDecodableImage(partial, 'Compressed image')
    if (after.width !== before.width || after.height !== before.height) throw new Error('The compressed image changed size.')
    const bytesAfter = (await fs.stat(partial)).size
    if (bytesAfter >= file.bytes * MIN_COMPRESSION_GAIN) {
      await fs.rm(partial, { force: true })
      return item({ outcome: 'skipped', reason: 'Compression would save less than 20%.' })
    }
    // Upload-backed shrinking is recorded in the episode's cleanup record; a
    // plain format conversion keeps the image, so there is nothing to record.
    if (entryBase.upload_proof) {
      pending = { ...entryBase, upload_proof: entryBase.upload_proof, outcome: 'pending_remove', updated_at: isoNow() }
      await putSidecarEntry(slug, code, pending)
    }
    const stillIdle = await relevantActiveJobs(slug, code, [file.category])
    const stillCurrent = formatOnly ? null : await uploadProofStillCurrent(slug, code, file)
    if (stillIdle.length || stillCurrent) throw new Error(stillCurrent || `Active ${stillIdle.map(job => job.type).join(', ')} work started before compression.`)
    const changed = await exactFileStillReviewed(file)
    if (changed) throw new Error(changed)
    await hooks.beforeDestructiveMutation?.()
    // No await from here to the swap: identity check, trash move, replace, mtime.
    const trashed = trashReviewedFile(file)
    try {
      renameSync(partial, file.path)
      utimesSync(file.path, file.mtime_ms / 1000, file.mtime_ms / 1000)
      clearImageValidationCache(file.path)
    } catch (error) {
      try { renameSync(trashed, file.path) } catch { /* the original is still in _trash */ }
      throw error
    }
    try {
      if (pending) await putSidecarEntry(slug, code, { ...pending, outcome: 'compressed', destination_path: trashed, updated_at: isoNow() })
      else await invalidateEpisodeRow(slug, code)
    } catch (error: any) {
      return item({ outcome: 'pending', bytes_moved: file.bytes, bytes_after: bytesAfter, destination_path: trashed, reason: error?.message || String(error) })
    }
    return item({ outcome: 'compressed', bytes_moved: file.bytes, bytes_after: bytesAfter, destination_path: trashed })
  } catch (error: any) {
    await fs.rm(partial, { force: true }).catch(() => {})
    if (pending) await putSidecarEntry(slug, code, { ...pending, outcome: 'failed', reason: error?.message || String(error), updated_at: isoNow() }).catch(() => {})
    return item({ outcome: 'failed', reason: error?.message || String(error) })
  }
}

async function runPreview(
  slug: string,
  preview: MediaCleanupPreview,
  operation: MediaCleanupOperation,
  mode: MediaCleanupMode,
  destination?: string,
): Promise<MediaCleanupRunResult> {
  const result: MediaCleanupRunResult = {
    mode, ...(destination ? { destination } : {}), items: [], item_count: 0,
    archived_count: 0, removed_count: 0, compressed_count: 0, skipped_count: 0, failed_count: 0, pending_count: 0,
    bytes_reclaimed: 0, bytes_moved: 0, bytes_trashed: 0, bytes_after: 0,
  }
  operation.result = result
  // Every outcome, server-side only. The operation carries counts plus the first
  // `PREVIEW_SAMPLE_FILES` (`result.items`), because a whole-Library run touches
  // every reviewed file and one entry per file is the 276 MB payload the preview
  // already stopped sending. This list is what the Archive-episode preset re-reads.
  const allItems: MediaCleanupRunResult['items'] = []
  operation.total = preview.files.length
  operation.bytes_total = preview.files.reduce((n, file) => n + file.bytes, 0)
  // Mac mini (16 GB): one image at a time, no libvips cache; put the app-wide settings back afterwards.
  const priorConcurrency = sharp.concurrency()
  if (mode === 'compress') { sharp.concurrency(1); sharp.cache(false) }
  try {
    for (const file of preview.files) {
      if (operation.stop_requested) break
      operation.current = file.path
      operation.updated_at = isoNow()
      const code = preview.episodes.find(episode => episode.files.some(candidate => candidate.path === file.path))!.episode_code
      const apply = () => jq.withEpisodeMediaCleanupLock(slug, code,
        () => mutateReviewedFile(slug, preview, operation, file, mode, destination))
      const item = file.category === 'final_video' ? await withFinalVideoPathLock(file.path, apply) : await apply()
      allItems.push(item)
      result.item_count = allItems.length
      if (result.items.length < PREVIEW_SAMPLE_FILES) result.items.push(item)
      if (item.outcome === 'archived') result.archived_count += 1
      else if (item.outcome === 'removed') result.removed_count += 1
      else if (item.outcome === 'compressed') result.compressed_count += 1
      else if (item.outcome === 'skipped') result.skipped_count += 1
      else if (item.outcome === 'failed') result.failed_count += 1
      else result.pending_count += 1
      result.bytes_reclaimed += item.bytes_reclaimed
      if (mode === 'archive') result.bytes_moved += item.bytes_moved
      else result.bytes_trashed += item.bytes_moved
      result.bytes_after += item.bytes_after ?? 0
      operation.done += 1
      operation.bytes_done += file.bytes
      operation.detail = ''
      await hooks.afterFile?.()
    }
  } finally {
    if (mode === 'compress') { sharp.concurrency(priorConcurrency); sharp.cache(true) }
  }
  if (preview.preset === 'archive_episode' && !operation.stop_requested) {
    for (const episode of preview.episodes) {
      const mine = allItems.filter(item => episode.files.some(file => file.path === item.path))
      const clean = episode.files.length === mine.length && mine.every(item =>
        item.outcome === 'removed' || item.outcome === 'compressed' || item.reason === ALREADY_JPEG)
      if (clean && episode.upload_proof) await markEpisodeArchived(slug, episode.episode_code).catch(() => {})
    }
  }
  return result
}

export async function startMediaCleanupRun(
  slug: string,
  input: { preview_id: unknown; mode: unknown; destination?: unknown },
): Promise<{ operation_id: string }> {
  pruneState()
  const previewId = typeof input.preview_id === 'string' ? input.preview_id.trim() : ''
  const preview = previews.get(previewId)
  if (!preview || preview.project_slug !== slug || Date.parse(preview.expires_at) <= Date.now()) {
    throw fail('That media cleanup preview is missing or expired. Check the files again.', 409)
  }
  if (consumedPreviews.has(previewId)) throw fail('That media cleanup preview was already used. Check the files again.', 409)
  if (input.mode !== 'archive' && input.mode !== 'remove' && input.mode !== 'compress') throw fail('Choose archive, remove or compress.')
  if (preview.preset && input.mode !== 'compress') throw fail(preview.preset === CONVERT_PNG_PRESET
    ? 'Converting PNG scenes only runs as a conversion.'
    : 'The Archive episode preset only runs as shrink-and-trash.')
  let destination: string | undefined
  if (input.mode === 'archive') {
    if (typeof input.destination !== 'string' || !input.destination.trim()) throw fail('Choose an archive destination.')
    destination = await safeArchiveDestination(input.destination.trim(), preview)
  }
  if (hasActiveOperation()) throw fail('A media cleanup check or operation is already running on this Mac. Wait for it to finish.', 409)
  const operation = beginOperation(slug, 'run', input.mode === 'archive' ? 'archiving' : input.mode === 'compress' ? 'compressing' : 'removing')
  consumedPreviews.add(previewId)
  setImmediate(() => void (async () => {
    operation.status = 'running'
    operation.updated_at = isoNow()
    // No hold on Video Assembly (1.4.289): each file checks its own episode is idle right before
    // it moves, under that episode's admission lock (jq.withEpisodeMediaCleanupLock).
    try {
      operation.result = await runPreview(slug, preview, operation, input.mode as MediaCleanupMode, destination)
      finishOperation(operation, operation.stop_requested ? 'stopped' : 'completed')
    } catch (error) {
      finishOperation(operation, 'failed', error)
    }
  })())
  return { operation_id: operation.id }
}

// ── All-channel (Library) maintenance ─────────────────────────────────────
//
// Owner request 2026-10-17: one control that shrinks scene images across every
// channel, and one that clears uploaded final videos across every channel,
// instead of changing channel-by-channel. Both reuse this file's operation
// registry, its one-operation-at-a-time global lock (`hasActiveOperation`) and
// its per-file mutation path (`mutateReviewedFile`), so they can never run
// beside a per-channel cleanup or a second all-channel run. The backend
// enumerates the channels itself (`pm.listProjects()`); the frontend never
// passes a channel list.

function validateLibraryAction(value: unknown): LibraryCleanupAction {
  if (value === 'shrink_images' || value === 'clear_uploaded_finals' || value === 'cleanup_all') return value
  throw fail('Choose an all-channel maintenance action.')
}

/**
 * The app's authoritative production time for a final video, or null with a reason.
 *
 * The only durable, per-final production record in the current contract is the
 * video-assembly source stamp the app writes beside the final when the render
 * completes (`{code}_video_assembly_source.json`, `writeVideoAssemblySourceStamp`).
 * It records the final's size and mtime the moment production finished. When both
 * still match the file on disk, the recorded time IS that render's production
 * time.
 *
 * A legacy or imported final with no stamp — or a stamp that no longer matches
 * the file — has NO authoritative production date: it is unknown, so the
 * all-channel clear leaves it alone and says why. A production time is never
 * guessed from a bare filesystem mtime or from the filename.
 */
async function finalVideoProductionTime(
  finalVideoPath: string,
  code: string,
): Promise<{ ms: number | null; reason?: string }> {
  let raw: string
  try {
    raw = await fs.readFile(videoAssemblySourceStampPath(finalVideoPath, code), 'utf8')
  } catch {
    return { ms: null, reason: 'No production record beside this final, so its production date is unknown.' }
  }
  let stamp: { final_video?: { size?: unknown; mtime_ms?: unknown } } | null
  try {
    stamp = JSON.parse(raw) as typeof stamp
  } catch {
    return { ms: null, reason: 'Its production record is unreadable, so its production date is unknown.' }
  }
  const recorded = stamp?.final_video
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(finalVideoPath)
  } catch {
    return { ms: null, reason: 'The final video is missing.' }
  }
  if (!recorded
    || !Number.isSafeInteger(recorded.size) || !Number.isFinite(recorded.mtime_ms)
    || recorded.size !== stat.size || recorded.mtime_ms !== Math.round(stat.mtimeMs)) {
    return { ms: null, reason: 'Its production record does not match the current file, so its production date is unknown.' }
  }
  return { ms: recorded.mtime_ms as number }
}

/** The production-age refusal for the all-channel clear, or null when the final is old enough. */
async function productionAgeRefusal(file: LibraryCleanupFile): Promise<string | null> {
  const produced = await finalVideoProductionTime(file.path, file.episode_code)
  if (produced.ms === null) return produced.reason ?? 'Its production date is unknown, so it is left where it is.'
  const now = Date.now()
  if (produced.ms > now) return 'Its production date is in the future, so it is left where it is.'
  if (produced.ms >= now - LIBRARY_PRODUCTION_AGE_MS) {
    return `Produced less than ${LIBRARY_PRODUCTION_AGE_MS / (24 * 60 * 60 * 1000)} days ago, so it is left where it is.`
  }
  return null
}

function libraryCategories(action: LibraryCleanupAction): MediaCleanupCategory[] {
  return action === 'shrink_images' ? ['images'] : ['final_video']
}

/**
 * What the all-channel action would do, without doing any of it: every channel,
 * every eligible file, with its channel, size and — for the clear action — its
 * production date, and a reason for everything left out.
 */
async function buildLibraryPreview(
  action: LibraryCleanupAction,
  operation: MediaCleanupOperation,
): Promise<LibraryCleanupPreview> {
  const shrink = action === 'shrink_images'
  const projects = await pm.listProjects()
  operation.channels_total = projects.length
  operation.channels_done = 0
  const channels: LibraryCleanupChannel[] = []
  const allFiles: LibraryCleanupFile[] = []
  const blocked: string[] = []
  // `cleanup_all` gathers the unused leftovers of every channel here; the other
  // actions never touch this list.
  const libraryLeftovers: LibraryLeftover[] = []
  for (const project of projects) {
    if (operation.stop_requested) break
    const slug = (project as { slug?: string }).slug
    if (!slug) continue
    const name = (project as { name?: string }).name || slug
    operation.channels_done = (operation.channels_done || 0) + 1
    operation.current = name
    operation.detail = `Listing ${name}`
    operation.updated_at = isoNow()
    let accepted: Awaited<ReturnType<typeof im.getIdeas>>
    try {
      accepted = await im.getIdeas(slug, 'accepted')
    } catch {
      blocked.push(`${name}: its episodes could not be read, so nothing here was offered.`)
      continue
    }
    const codes = accepted.map(idea => String(idea.episode_code || '').toUpperCase()).filter(Boolean)
    if (!codes.length) continue
    const acceptedByCode = new Map(accepted.map(idea => [String(idea.episode_code || '').toUpperCase(), idea]))
    const inventory = await loadUploadInventory(slug, codes)
    const channelFiles: LibraryCleanupFile[] = []
    const channelBlocked: string[] = []
    for (const code of codes) {
      if (operation.stop_requested) break
      operation.current = `${name}/${code}`
      operation.updated_at = isoNow()
      const idea = acceptedByCode.get(code)
      const proof = currentUploadProof(code, inventory)
      // The shrink control needs no upload (any episode); the clear control does.
      if (!shrink && !proof) {
        channelBlocked.push(`${code}: ${inventory.why.get(code) || 'no ready canonical upload on the current channel'}`)
        continue
      }
      const active = await relevantActiveJobs(slug, code, libraryCategories(action))
      if (active.length) { channelBlocked.push(busyReason(code, active)); continue }
      for (const root of await rootsFor(slug, code, idea?.title || '', libraryCategories(action))) {
        if (operation.stop_requested) break
        const discovered = await discoverRoot(root, shrink ? null : proof, () => operation.stop_requested === true, code, shrink)
        for (const file of discovered.files) {
          const base: LibraryCleanupFile = { ...file, project_slug: slug, channel_name: name, episode_code: code, production_ms: null }
          if (shrink) { channelFiles.push(base); continue }
          const reason = await verifyFinalProof(slug, code, idea?.title || '', file, readingProgress(operation, file, 'Matching'))
            .catch((error: any) => `${error?.message || error}`)
          if (reason) { channelBlocked.push(`${code} ${path.basename(file.path)}: ${reason}`); continue }
          const produced = await finalVideoProductionTime(file.path, code)
          if (produced.ms === null) { channelBlocked.push(`${code} ${path.basename(file.path)}: ${produced.reason}`); continue }
          const now = Date.now()
          if (produced.ms > now) { channelBlocked.push(`${code} ${path.basename(file.path)}: its production date is in the future, so it is left where it is.`); continue }
          if (produced.ms >= now - LIBRARY_PRODUCTION_AGE_MS) { channelBlocked.push(`${code} ${path.basename(file.path)}: produced less than 7 days ago, so it is left where it is.`); continue }
          channelFiles.push({ ...base, production_ms: produced.ms })
        }
        channelBlocked.push(...discovered.excluded.map(item => `${code}: ${item.reason}`))
      }
    }
    if (action === 'cleanup_all') {
      // The leftovers list is its own authority (fresh per read). A channel whose
      // episodes are busy or unreadable offers none of its own, and a scan that
      // fails is reported — never flattened to "nothing here".
      try {
        for (const item of await listStorageLeftovers(slug)) libraryLeftovers.push({ project_slug: slug, channel_name: name, ...item })
      } catch (error: any) {
        const reason = `${name}: its leftover files could not be read (${error?.message || error}), so none were offered.`
        channelBlocked.push(reason)
        blocked.push(reason)
      }
    }
    if (channelFiles.length || channelBlocked.length) {
      channels.push({ slug, name, files: channelFiles, total_bytes: channelFiles.reduce((n, f) => n + f.bytes, 0), blocked_reasons: channelBlocked })
      allFiles.push(...channelFiles)
    }
  }
  const shrinkable = allFiles.filter(file => file.category === 'images' && !file.already_jpeg)
  const trashed = allFiles.filter(file => file.category !== 'images')
  const sum = (list: MediaCleanupFile[]) => list.reduce((total, file) => total + file.bytes, 0)
  // Two channels naming one physical folder is one folder: dedupe before counting.
  const uniqueLeftovers = dedupeLibraryLeftovers(libraryLeftovers)
  return {
    preview_id: randomUUID(),
    action,
    created_at: isoNow(),
    expires_at: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
    channels,
    files: allFiles,
    total_bytes: sum(allFiles),
    blocked_reasons: blocked,
    ...(action === 'cleanup_all' ? { leftovers: { count: uniqueLeftovers.length, total_bytes: uniqueLeftovers.reduce((n, item) => n + item.bytes, 0), items: uniqueLeftovers } } : {}),
    trash_roots: [...new Set(allFiles.map(file => {
      const at = file.trash_path.indexOf(`${path.sep}_trash${path.sep}`)
      return at < 0 ? path.dirname(file.trash_path) : file.trash_path.slice(0, at + '/_trash'.length)
    }))],
    estimate: {
      compress_files: shrinkable.length,
      compress_bytes_before: sum(shrinkable),
      compress_bytes_after: Math.round(sum(shrinkable) * JPEG_SIZE_RATIO),
      already_jpeg_files: allFiles.filter(file => file.already_jpeg).length,
      trash_files: trashed.length,
      trash_bytes: sum(trashed),
    },
  }
}

/** A per-channel `MediaCleanupPreview` view of an all-channel preview, so the shared per-file path can run. */
function channelPreviewFor(preview: LibraryCleanupPreview, slug: string): MediaCleanupPreview {
  const channel = preview.channels.find(item => item.slug === slug)
  const files = channel?.files || []
  const byCode = new Map<string, MediaCleanupEpisodePreview>()
  for (const file of files) {
    const episode = byCode.get(file.episode_code)
      || { episode_code: file.episode_code, upload_proof: file.upload_proof, files: [], excluded: [], blocked_reasons: [] }
    episode.files.push(file)
    byCode.set(file.episode_code, episode)
  }
  return {
    preview_id: preview.preview_id,
    project_slug: slug,
    created_at: preview.created_at,
    expires_at: preview.expires_at,
    categories: libraryCategories(preview.action),
    episodes: [...byCode.values()],
    files,
    total_bytes: channel?.total_bytes || 0,
    blocked_reasons: channel?.blocked_reasons || [],
    ...(preview.action === 'shrink_images' ? { preset: CONVERT_PNG_PRESET } : {}),
    trash_roots: preview.trash_roots,
    estimate: preview.estimate,
  }
}

async function runLibraryPreview(
  preview: LibraryCleanupPreview,
  operation: MediaCleanupOperation,
  mode: MediaCleanupMode,
): Promise<MediaCleanupRunResult> {
  const result: MediaCleanupRunResult = {
    mode, items: [], item_count: 0,
    archived_count: 0, removed_count: 0, compressed_count: 0, skipped_count: 0, failed_count: 0, pending_count: 0,
    bytes_reclaimed: 0, bytes_moved: 0, bytes_trashed: 0, bytes_after: 0,
  }
  operation.result = result
  const leftovers = preview.action === 'cleanup_all' ? preview.leftovers?.items || [] : []
  // Leftover folders count toward the run's progress too, so a sweep that is
  // still moving leftovers never reads as 100% done.
  operation.total = preview.files.length + leftovers.length
  operation.bytes_total = preview.files.reduce((n, file) => n + file.bytes, 0) + leftovers.reduce((n, item) => n + item.bytes, 0)
  const priorConcurrency = sharp.concurrency()
  if (mode === 'compress') { sharp.concurrency(1); sharp.cache(false) }
  try {
    for (const file of preview.files) {
      if (operation.stop_requested) break
      operation.current = `${file.channel_name}/${file.path}`
      operation.updated_at = isoNow()
      // The clear action's age gate is re-checked at mutation, under the file's
      // own lock, so an old preview can never authorize a final whose production
      // date is no longer provable.
      const gate = preview.action === 'clear_uploaded_finals' || preview.action === 'cleanup_all' ? () => productionAgeRefusal(file) : undefined
      const apply = () => jq.withEpisodeMediaCleanupLock(file.project_slug, file.episode_code,
        () => mutateReviewedFile(file.project_slug, channelPreviewFor(preview, file.project_slug), operation, file, mode, undefined, gate))
      const item = file.category === 'final_video' ? await withFinalVideoPathLock(file.path, apply) : await apply()
      result.item_count += 1
      if (result.items.length < PREVIEW_SAMPLE_FILES) result.items.push(item)
      if (item.outcome === 'archived') result.archived_count += 1
      else if (item.outcome === 'removed') result.removed_count += 1
      else if (item.outcome === 'compressed') result.compressed_count += 1
      else if (item.outcome === 'skipped') result.skipped_count += 1
      else if (item.outcome === 'failed') result.failed_count += 1
      else result.pending_count += 1
      result.bytes_reclaimed += item.bytes_reclaimed
      result.bytes_trashed += item.bytes_moved
      result.bytes_after += item.bytes_after ?? 0
      operation.done += 1
      operation.bytes_done += file.bytes
      operation.detail = ''
      await hooks.afterFile?.()
    }
  } finally {
    if (mode === 'compress') { sharp.concurrency(priorConcurrency); sharp.cache(true) }
  }
  if (preview.action === 'cleanup_all' && preview.leftovers?.items.length) {
    await sweepLibraryLeftovers(preview.leftovers.items, operation, result)
  }
  return result
}

/**
 * `cleanup_all`'s second half: move the offered leftovers to `_trash`, channel by
 * channel. Each channel re-lists its own leftovers at move time (`trashStorageLeftovers`
 * re-reads before every move and honours a per-file stop), so a job that started
 * meanwhile keeps its folder and a folder that is gone is reported, never guessed.
 * Runs under the same operation, so Stop is honoured and progress keeps moving.
 */
async function sweepLibraryLeftovers(
  items: LibraryLeftover[],
  operation: MediaCleanupOperation,
  result: MediaCleanupRunResult,
): Promise<void> {
  const bySlug = new Map<string, LibraryLeftover[]>()
  for (const item of items) bySlug.set(item.project_slug, [...(bySlug.get(item.project_slug) || []), item])
  let moved = 0, bytesMoved = 0, left = 0
  for (const [slug, group] of bySlug) {
    if (operation.stop_requested) {
      // Stopped before this channel: everything still offered is reported as left,
      // and counted as accounted-for so progress matches the other stopped paths.
      left += group.length
      operation.done += group.length
      continue
    }
    operation.current = `${slug} · leftover files`
    operation.detail = 'Moving leftover files to the Trash'
    operation.updated_at = isoNow()
    try {
      const outcome = await trashStorageLeftovers(slug, group.map(item => item.path), { shouldStop: () => operation.stop_requested === true })
      const movedBytes = outcome.moved.reduce((n, item) => n + item.bytes, 0)
      moved += outcome.moved.length
      bytesMoved += movedBytes
      left += outcome.left.length
      operation.done += outcome.moved.length + outcome.left.length
      operation.bytes_done += movedBytes
    } catch {
      // A channel whose leftovers cannot be swept leaves all of them in place.
      left += group.length
      operation.done += group.length
    }
  }
  result.leftovers_moved = moved
  result.leftovers_bytes_moved = bytesMoved
  result.leftovers_left = left
}

export async function startLibraryMediaCleanupPreview(action: unknown): Promise<{ operation_id: string }> {
  const validated = validateLibraryAction(action)
  pruneState()
  if (hasActiveOperation()) throw fail('A media cleanup check or operation is already running on this Mac. Wait for it to finish.', 409)
  const operation = beginOperation(LIBRARY_SCOPE, 'preview', 'checking')
  operation.library = true
  operation.library_action = validated
  setImmediate(() => void (async () => {
    operation.status = 'running'
    operation.updated_at = isoNow()
    try {
      const preview = await buildLibraryPreview(validated, operation)
      if (operation.stop_requested) { finishOperation(operation, 'stopped'); return }
      libraryPreviews.set(preview.preview_id, preview)
      operation.library_preview = summarizeLibraryPreview(preview)
      finishOperation(operation, 'completed')
    } catch (error) {
      finishOperation(operation, 'failed', error)
    }
  })())
  return { operation_id: operation.id }
}

export async function startLibraryMediaCleanupRun(input: { preview_id: unknown }): Promise<{ operation_id: string }> {
  pruneState()
  const previewId = typeof input.preview_id === 'string' ? input.preview_id.trim() : ''
  const preview = libraryPreviews.get(previewId)
  if (!preview || Date.parse(preview.expires_at) <= Date.now()) {
    throw fail('That all-channel preview is missing or expired. Check the files again.', 409)
  }
  if (consumedPreviews.has(previewId)) throw fail('That all-channel preview was already used. Check the files again.', 409)
  if (hasActiveOperation()) throw fail('A media cleanup check or operation is already running on this Mac. Wait for it to finish.', 409)
  const mode: MediaCleanupMode = preview.action === 'shrink_images' ? 'compress' : 'remove'
  const operation = beginOperation(LIBRARY_SCOPE, 'run', mode === 'compress' ? 'compressing' : 'removing')
  operation.library = true
  operation.library_action = preview.action
  consumedPreviews.add(previewId)
  setImmediate(() => void (async () => {
    operation.status = 'running'
    operation.updated_at = isoNow()
    try {
      operation.result = await runLibraryPreview(preview, operation, mode)
      finishOperation(operation, operation.stop_requested ? 'stopped' : 'completed')
    } catch (error) {
      finishOperation(operation, 'failed', error)
    }
  })())
  return { operation_id: operation.id }
}

export function getLibraryMediaCleanupOperation(id: string): MediaCleanupOperation | null {
  pruneState()
  const operation = operations.get(id)
  return operation?.library ? cloneOperation(operation) : null
}

export function stopLibraryMediaCleanupOperation(id: string): MediaCleanupOperation | null {
  const operation = operations.get(id)
  if (!operation?.library) return null
  if (operation.status === 'queued' || operation.status === 'running' || operation.status === 'stopping') {
    operation.stop_requested = true
    operation.status = 'stopping'
    operation.updated_at = isoNow()
  }
  return cloneOperation(operation)
}

export function getMediaCleanupOperation(slug: string, id: string): MediaCleanupOperation | null {
  pruneState()
  const operation = operations.get(id)
  return operation?.project_slug === slug ? cloneOperation(operation) : null
}
export function stopMediaCleanupOperation(slug: string, id: string): MediaCleanupOperation | null {
  const operation = operations.get(id)
  if (!operation || operation.project_slug !== slug) return null
  if (operation.status === 'queued' || operation.status === 'running' || operation.status === 'stopping') {
    operation.stop_requested = true
    operation.status = 'stopping'
    operation.updated_at = isoNow()
  }
  return cloneOperation(operation)
}

export function _setMediaCleanupHooksForTests(next: CleanupHooks): () => void {
  const previous = hooks
  hooks = { ...hooks, ...next }
  return () => { hooks = previous }
}

export function _assertReviewedIdentityForTests(file: MediaCleanupFile): void {
  assertReviewedIdentitySync(file)
}

export function _resetMediaCleanupStateForTests(): void {
  operations.clear()
  previews.clear()
  libraryPreviews.clear()
  consumedPreviews.clear()
  hooks = {}
}
