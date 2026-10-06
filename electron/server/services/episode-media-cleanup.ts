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
import type { Job } from '../models/types.js'
import * as im from './idea-manager.js'
import * as jq from './job-queue.js'
import * as pm from './project-manager.js'
import { getProjectYouTubeAssignment } from './youtube-connection-store.js'
import { withFinalVideoPathLock } from './final-video-lock.js'
import { registryCredentialFor } from '../lib/youtube-client.js'
import { getExternalFinalVideoRoot, resolveExternalFinalVideoDir } from './external-video-store.js'
import { resolveAssetPath } from './path-resolver.js'
import { narrationPartsToFree, PARTS_DIRNAME, trashEpisodeParts, trashTargetFor } from './chapter-parts.js'
import {
  createProjectFactsCache,
  resolveEpisodePathsByCode,
  resolveEpisodePathsByCodeWithSidecar,
  resolveEpisodeTitleByCode,
  type ProjectFactsCache,
} from './utils.js'
import { readYouTubeRetentionStores, youtubeRetentionEvidenceFor, youtubeRetentionProofForFile } from './youtube-remote-video.js'
import { syncYouTubePublicationState } from './youtube-publication-status.js'
import { resolveYouTubeSourceRevision } from './youtube-source-video.js'

export const MEDIA_CLEANUP_SIDECAR = 'local_media_cleanup.json'
export type MediaCleanupCategory = 'images' | 'chapter_audio' | 'narration_parts' | 'merged_audio' | 'motion_clips' | 'final_video'
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
  preset?: 'archive_episode'
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
}

export interface MediaCleanupOperation {
  id: string
  project_slug: string
  kind: 'preview' | 'run'
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stopping' | 'stopped'
  stage: 'checking' | 'archiving' | 'removing' | 'compressing' | null
  done: number
  total: number
  current: string
  created_at: string
  updated_at: string
  error?: string
  preview?: MediaCleanupPreview
  result?: MediaCleanupRunResult
  stop_requested?: boolean
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
const consumedPreviews = new Set<string>()
const PREVIEW_TTL_MS = 30 * 60 * 1_000
const OPERATION_RETENTION_MS = 2 * 60 * 60 * 1_000
const MAX_OPERATIONS = 200
const CATEGORIES = new Set<MediaCleanupCategory>(['images', 'chapter_audio', 'narration_parts', 'merged_audio', 'motion_clips', 'final_video'])
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

function pruneState(): void {
  const now = Date.now()
  for (const [id, preview] of previews) {
    if (Date.parse(preview.expires_at) <= now) {
      previews.delete(id)
      consumedPreviews.delete(id)
    }
  }
  for (const [id, operation] of operations) {
    if (!['queued', 'running', 'stopping'].includes(operation.status)
      && now - Date.parse(operation.updated_at) > OPERATION_RETENTION_MS) operations.delete(id)
  }
  if (operations.size <= MAX_OPERATIONS) return
  const removable = [...operations.values()]
    .filter(operation => !['queued', 'running', 'stopping'].includes(operation.status))
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
}

async function loadUploadInventory(slug: string): Promise<UploadInventory> {
  const [assignment, stores] = await Promise.all([
    getProjectYouTubeAssignment(slug),
    readYouTubeRetentionStores(slug),
  ])
  return { channel_id: assignment?.channel_id ?? null, records: stores.records }
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
  } : null
}

export async function listMediaCleanupEpisodes(slug: string): Promise<{
  /** Uploaded episodes, plus not-uploaded ones with kept narration parts (`video_id` null: only Narration parts apply). */
  episodes: Array<{ episode_code: string; title: string; video_id: string | null; local_media_status: LocalMediaCleanupStatus }>
  blocked_reasons: string[]
}> {
  if (!await pm.getProject(slug)) throw fail('Project not found', 404)
  const [accepted, inventory] = await Promise.all([
    im.getIdeas(slug, 'accepted'),
    loadUploadInventory(slug),
  ])
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
  return { episodes, blocked_reasons: [] }
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
  const own = jobs.filter(job => String(job.episode_id || '').toUpperCase() === code.toUpperCase()
    && ACTIVE_STATUSES.has(job.status))
  // The Mac mini has 16 GB: re-encoding images must not overlap a video render
  // for ANY project, so an active Video Assembly anywhere refuses the work.
  return [...own, ...jq.activeJobsOfType('video_assembly').filter(job => !own.includes(job as any))]
}

async function assertScopesIdle(slug: string, codes: string[], categories: MediaCleanupCategory[]): Promise<void> {
  for (const code of codes) {
    const active = await relevantActiveJobs(slug, code, categories)
    if (active.length) {
      throw fail(`${code} has active ${active.map(job => job.type).join(', ')} work. Stop or finish it before cleanup.`, 409)
    }
  }
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
  if (selected.has('merged_audio')) add(paths.merged_audio_dir, heavyAnchor, 'merged_audio', 'merged_audio', name => AUDIO_EXT.test(name))
  if (selected.has('motion_clips')) add(paths.video_assets_dir, heavyAnchor, 'motion_clips', 'motion_clips', name => VIDEO_EXT.test(name))
  if (selected.has('final_video')) {
    add(paths.video_dir, heavyAnchor, 'final_video', 'final_video', name => isFinalName(code, name))
    const external = await resolveExternalFinalVideoDir(slug, code, title).catch(() => null)
    if (external && path.resolve(external) !== path.resolve(paths.video_dir)) {
      const externalAnchor = await getExternalFinalVideoRoot().catch(() => '')
      add(external, externalAnchor || path.dirname(external), 'external_final_video', 'final_video', name => isFinalName(code, name))
    }
  }
  return roots
}

function isJpegFile(file: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const head = Buffer.alloc(3)
    return readSync(fd, head, 0, 3, 0) === 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
  } catch { return false } finally { if (fd !== undefined) closeSync(fd) }
}

async function sha256(file: string): Promise<string> {
  const revision = await resolveYouTubeSourceRevision(file)
  return revision.slice('sha256:'.length)
}

async function discoverRoot(
  spec: RootSpec,
  proof: MediaCleanupUploadProof,
  shouldStop: () => boolean,
  episodeCode: string,
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
      const stat = await fs.lstat(full)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        excluded.push({ path: full, category: spec.category, reason: 'Only regular files may be cleaned.' })
        continue
      }
      if (stat.nlink !== 1) {
        excluded.push({ path: full, category: spec.category, reason: 'Files with another hard link are shared and were left alone.' })
        continue
      }
      if (Math.floor(stat.mtimeMs) > Date.parse(proof.uploaded_at)) {
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
        sha256: await sha256(full),
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

async function verifyFinalProof(slug: string, code: string, title: string, file: MediaCleanupFile): Promise<string | null> {
  const assignment = await getProjectYouTubeAssignment(slug)
  if (!assignment) return 'No current YouTube channel is assigned.'
  const evidence = await youtubeRetentionEvidenceFor(slug, code, title)
  const exact = await youtubeRetentionProofForFile(evidence, file.path)
  if (!exact.usable || !file.upload_proof || exact.operation_id !== file.upload_proof.operation_id
    || exact.video_id !== file.upload_proof.video_id || exact.channel_id !== assignment.channel_id) {
    return exact.reason || 'The final video is not the exact render in the current ready upload receipt.'
  }
  try {
    const remote = await syncYouTubePublicationState({
      project_slug: slug,
      operation_id: exact.operation_id,
      account_id: registryCredentialFor(assignment.channel_id),
    })
    if (remote.state.lifecycle !== 'ready') return `YouTube currently reports ${remote.state.lifecycle}.`
    if (remote.details?.channelId !== assignment.channel_id) return 'YouTube did not confirm the video on the current channel.'
  } catch {
    return 'YouTube could not freshly verify the exact uploaded final video.'
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
  if (!await pm.getProject(slug)) throw fail('Project not found', 404)
  const accepted = await im.getIdeas(slug, 'accepted')
  const inventory = await loadUploadInventory(slug)
  const acceptedByCode = new Map(accepted.map(idea => [String(idea.episode_code || '').toUpperCase(), idea]))
  const unknown = codes.filter(code => !acceptedByCode.has(code))
  if (unknown.length) throw fail(`No accepted episode matches ${unknown.join(', ')}.`, 404)
  await assertScopesIdle(slug, codes, categories)

  operation.total = codes.length
  const episodeResults: MediaCleanupEpisodePreview[] = []
  for (const code of codes) {
    if (operation.stop_requested) break
    operation.current = code
    operation.updated_at = isoNow()
    const proof = currentUploadProof(code, inventory)
    const episode: MediaCleanupEpisodePreview = {
      episode_code: code, upload_proof: proof, files: [], excluded: [], blocked_reasons: [],
    }
    // Narration parts need no upload (owner decision 2026-10-06): any episode with a joined chapter may free them.
    const partsOnly = !proof && !input.preset && categories.includes('narration_parts')
    if (!proof && !partsOnly) {
      episode.blocked_reasons.push('This episode has no ready canonical upload on the current YouTube channel.')
    } else {
      const idea = acceptedByCode.get(code)!
      if (categories.includes('narration_parts')) episode.files.push(...await narrationPartsFiles(slug, code, proof))
      if (partsOnly && categories.length > 1) {
        episode.blocked_reasons.push('Not uploaded yet: only its narration parts are offered.')
      }
      for (const root of partsOnly ? [] : await rootsFor(slug, code, idea.title || '', categories.filter(category => category !== 'narration_parts'))) {
        const discovered = await discoverRoot(root, proof!, () => operation.stop_requested === true, code)
        // A loose part already offered as a narration part is not listed twice.
        episode.files.push(...discovered.files.filter(file => !episode.files.some(listed => listed.path === file.path)))
        episode.excluded.push(...discovered.excluded)
      }
      for (const file of [...episode.files]) {
        if (file.category !== 'final_video') continue
        const reason = await verifyFinalProof(slug, code, idea.title || '', file)
        if (reason) {
          episode.files.splice(episode.files.indexOf(file), 1)
          episode.excluded.push({ path: file.path, category: file.category, reason })
        }
      }
      episode.blocked_reasons.push(...[...new Set(episode.excluded.map(item => item.reason))])
    }
    episodeResults.push(episode)
    operation.done += 1
  }
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
  const now = isoNow()
  const operation: MediaCleanupOperation = {
    id: randomUUID(), project_slug: slug, kind, status: 'queued', stage,
    done: 0, total: 0, current: '', created_at: now, updated_at: now,
  }
  operations.set(operation.id, operation)
  return operation
}

// Server-wide, not per project: one cleanup (hashing, re-encoding) at a time on the Mac mini.
function hasActiveOperation(): boolean {
  return [...operations.values()].some(operation => ['queued', 'running', 'stopping'].includes(operation.status))
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
      operation.preview = preview
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
  if (stat.size !== file.bytes || await sha256(file.path) !== file.sha256) return 'The reviewed file changed after preview.'
  return null
}

// Keep the final identity check and unlink in one event-loop turn. Episode
// admission is held by the caller; another in-app folder move cannot interleave
// an awaited operation between checking the parent path and removing the file.
function assertReviewedIdentitySync(file: MediaCleanupFile): void {
  const stat = lstatSync(file.path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size !== file.bytes || stat.mtimeMs !== file.mtime_ms
    || realpathSync(file.path) !== file.real_path) {
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
  return moveToTrashSync(file.path, file.trash_path)
}

async function uploadProofStillCurrent(slug: string, code: string, file: MediaCleanupFile): Promise<string | null> {
  const proof = currentUploadProof(code, await loadUploadInventory(slug))
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
): Promise<MediaCleanupRunResult['items'][number]> {
  const code = preview.episodes.find(episode => episode.files.some(candidate => candidate.path === file.path))!.episode_code
  const active = await relevantActiveJobs(slug, code, [file.category])
  if (active.length) return { path: file.path, category: file.category, outcome: 'skipped', bytes_reclaimed: 0, bytes_moved: 0, reason: `Active ${active.map(job => job.type).join(', ')} work started after preview.` }
  if (file.category === 'narration_parts') return trashReviewedNarrationParts(slug, code, file, mode)
  const staleUpload = await uploadProofStillCurrent(slug, code, file)
  if (staleUpload) return { path: file.path, category: file.category, outcome: 'skipped', bytes_reclaimed: 0, bytes_moved: 0, reason: staleUpload }
  const changed = await exactFileStillReviewed(file)
  if (changed) return { path: file.path, category: file.category, outcome: 'skipped', bytes_reclaimed: 0, bytes_moved: 0, reason: changed }
  if (Math.floor((await fs.stat(file.path)).mtimeMs) > Date.parse(file.upload_proof!.uploaded_at)) {
    return { path: file.path, category: file.category, outcome: 'skipped', bytes_reclaimed: 0, bytes_moved: 0, reason: 'The file is newer than its upload proof.' }
  }
  if (file.category === 'final_video') {
    const idea = (await im.getIdeas(slug, 'accepted')).find(candidate => candidate.episode_code === code)
    const reason = await verifyFinalProof(slug, code, idea?.title || '', file)
    if (reason) return { path: file.path, category: file.category, outcome: 'skipped', bytes_reclaimed: 0, bytes_moved: 0, reason }
  }

  const entryBase: Omit<MediaCleanupSidecarEntry, 'outcome' | 'updated_at'> = {
    entry_id: randomUUID(), source_path: file.path, relative_path: file.relative_path,
    source_kind: file.source_kind,
    category: file.category, bytes: file.bytes, bytes_reclaimed: 0, sha256: file.sha256,
    preview_id: preview.preview_id, operation_id: operation.id, mode,
    recorded_at: isoNow(), upload_proof: file.upload_proof!,
  }

  if (mode === 'compress' && file.category === 'images') return compressReviewedImage(slug, code, file, entryBase)

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
      const [sourceHash, targetHash] = await Promise.all([sha256(file.path), sha256(partial)])
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
        ...entryBase, bytes_reclaimed: sameDevice ? 0 : file.bytes,
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

  const pending: MediaCleanupSidecarEntry = { ...entryBase, outcome: 'pending_remove', updated_at: isoNow() }
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
  entryBase: Omit<MediaCleanupSidecarEntry, 'outcome' | 'updated_at'>,
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
    pending = { ...entryBase, outcome: 'pending_remove', updated_at: isoNow() }
    await putSidecarEntry(slug, code, pending)
    const stillIdle = await relevantActiveJobs(slug, code, [file.category])
    const stillCurrent = await uploadProofStillCurrent(slug, code, file)
    if (stillIdle.length || stillCurrent) throw new Error(stillCurrent || `Active ${stillIdle.map(job => job.type).join(', ')} work started before compression.`)
    const changed = await exactFileStillReviewed(file)
    if (changed) throw new Error(changed)
    await hooks.beforeDestructiveMutation?.()
    // No await from here to the swap: identity check, trash move, replace, mtime.
    const trashed = trashReviewedFile(file)
    try {
      renameSync(partial, file.path)
      utimesSync(file.path, file.mtime_ms / 1000, file.mtime_ms / 1000)
    } catch (error) {
      try { renameSync(trashed, file.path) } catch { /* the original is still in _trash */ }
      throw error
    }
    try {
      await putSidecarEntry(slug, code, { ...pending, outcome: 'compressed', destination_path: trashed, updated_at: isoNow() })
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
  await assertScopesIdle(slug, preview.episodes.map(episode => episode.episode_code), preview.categories)
  const result: MediaCleanupRunResult = {
    mode, ...(destination ? { destination } : {}), items: [],
    archived_count: 0, removed_count: 0, compressed_count: 0, skipped_count: 0, failed_count: 0, pending_count: 0,
    bytes_reclaimed: 0, bytes_moved: 0, bytes_trashed: 0, bytes_after: 0,
  }
  operation.result = result
  operation.total = preview.files.length
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
      result.items.push(item)
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
      await hooks.afterFile?.()
    }
  } finally {
    if (mode === 'compress') { sharp.concurrency(priorConcurrency); sharp.cache(true) }
  }
  if (preview.preset && !operation.stop_requested) {
    for (const episode of preview.episodes) {
      const mine = result.items.filter(item => episode.files.some(file => file.path === item.path))
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
  if (preview.preset && input.mode !== 'compress') throw fail('The Archive episode preset only runs as shrink-and-trash.')
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
    try {
      operation.result = await runPreview(slug, preview, operation, input.mode as MediaCleanupMode, destination)
      finishOperation(operation, operation.stop_requested ? 'stopped' : 'completed')
    } catch (error) {
      finishOperation(operation, 'failed', error)
    }
  })())
  return { operation_id: operation.id }
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

export function _resetMediaCleanupStateForTests(): void {
  operations.clear()
  previews.clear()
  consumedPreviews.clear()
  hooks = {}
}
