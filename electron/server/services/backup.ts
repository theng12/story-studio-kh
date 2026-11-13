/**
 * Backup and restore (1.4.287).
 *
 * The owner, 2026-10-11: *"say i plug in an SSD and points it at the SSD to create a backup … the
 * backup should be background music, presets, all stuff that's not generate-able … so we can start
 * new and continue on a new machine."*
 *
 * ── Shape on the drive ──
 *
 *     <chosen folder>/Story Studio Backup/
 *     ├── manifest.json          checksums, Story version, date, per-channel counts
 *     ├── app/…                  app-wide stores, as they are in Story's own data folder
 *     ├── library/…              the Library: channels, _Project Assets, …
 *     ├── _versions/<stamp>/…    every copy a later backup replaced or no longer needed
 *     └── _partial/              copies in flight (a file lands under its real name only once whole)
 *
 * A plain folder mirror: JSON, Markdown, audio and images as they are, readable without Story.
 *
 * ── What goes in ──
 *
 * Everything that cannot be generated again plus every record: see `classifyLibraryFile` and
 * `APP_STORES`. Scene images, narration, merged audio, masters, rendered videos, preview caches and
 * `_trash` stay out; finished videos, narration audio and every thumbnail are opt-in extras.
 * Secrets never go in (`app-secrets.json`, `secrets.json`, YouTube tokens, server-mode
 * credentials): after a restore the owner signs in again.
 *
 * ── The two rules that make it safe ──
 *
 *   1. NOTHING on the drive is ever deleted. A file that changed or vanished at the source moves to
 *      `_versions/<stamp>/…`; only the owner prunes `_versions`, with a confirm, from Settings.
 *   2. An unplugged drive never leaves a corrupt state. Each file is written into `_partial/` and
 *      renamed into place only when whole; the manifest is checkpointed as it goes and rewritten
 *      atomically. A stopped or interrupted run resumes: files already on the drive with the same
 *      size and modification time are not copied again.
 *
 * It runs in this process on async streams, one file at a time, never through the job queue: it
 * neither waits behind Video Assembly nor holds a slot Video Assembly needs.
 */

import { createHash } from 'crypto'
import { createReadStream, createWriteStream, existsSync } from 'fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Transform } from 'stream'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import { hasFinalRenderRemoteWaitMarker } from '../lib/final-render-remote-wait.js'
import { isFinalVideoFilename } from '../lib/final-video-name.js'
import { APP_TRASH, TRASH_DIRNAME, libraryTrashDir, moveToTrashSync } from '../lib/trash-move.js'

export const BACKUP_DIR_NAME = 'Story Studio Backup'
export const MANIFEST_NAME = 'manifest.json'
export const VERSIONS_DIR = '_versions'
export const PARTIAL_DIR = '_partial'
export const BACKUP_FORMAT = 'story-studio-backup'
/** The app-settings key holding the owner's backup choices and the last result. */
export const BACKUP_SETTINGS_KEY = 'backup'

export type BackupCategory = 'records' | 'final_videos' | 'narration_audio' | 'all_thumbnails'
export const OPTIONAL_CATEGORIES: Exclude<BackupCategory, 'records'>[] = ['final_videos', 'narration_audio', 'all_thumbnails']

export interface BackupOptions {
  final_videos?: boolean
  narration_audio?: boolean
  all_thumbnails?: boolean
}

interface SourceFile {
  /** Path inside the backup: `app/…` or `library/…`, always `/`-separated. */
  rel: string
  abs: string
  size: number
  mtimeMs: number
  category: BackupCategory
  /** Channel slug for `library/<slug>/…`; '' for app-wide and Library-wide files. */
  channel: string
  /** Written with its secret keys removed rather than copied byte for byte. */
  sanitize?: boolean
}

export interface ManifestFile { size: number; mtime: number; sha256: string }
export interface ChannelCounts { name: string; episodes: number; files: number; bytes: number; uploaded_episodes: number; last_episode_code: string }
export interface Manifest {
  format: typeof BACKUP_FORMAT
  format_version: 1
  story_version: string
  machine: string
  created_at: string
  updated_at: string
  /** False while a run is in progress or after one that was interrupted. */
  complete: boolean
  options: BackupOptions
  counts: { app: { files: number; bytes: number }; library: { files: number; bytes: number }; channels: Record<string, ChannelCounts> }
  files: Record<string, ManifestFile>
}

// ── Classification ──────────────────────────────────────────────────────────

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|heic|tiff?|bmp|avif)$/i
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|opus|aiff?|caf)$/i
const VIDEO_EXT = /\.(mp4|mov|mkv|webm|m4v|avi|ts|mxf)$/i
const isMedia = (name: string) => IMAGE_EXT.test(name) || AUDIO_EXT.test(name) || VIDEO_EXT.test(name)

/** Never worth a byte on the drive, wherever they appear. */
const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', '.localized'])
/**
 * Folders that only ever hold removed, temporary or rebuildable things (inventory in DELIVERY.md):
 * trash, preview and thumbnail caches, narration part files, audio-quality candidates, resumable
 * upload sessions (they carry a session URL), content-pack staging.
 */
const SKIP_DIRS = new Set([
  TRASH_DIRNAME, '.Trash', 'Trash Folder', '.cache', 'cache', '.parts', '.tmp', 'tmp', '.preview-cache', 'preview-cache',
  'image-previews', 'style-previews', 'effect-loops', 'node_modules', '.git', 'uploads-in-progress', '.incoming',
  '.staging', 'quarantine', '.audio-quality-candidates', '.audio-quality-checks', '.render-fit', '.restore-partial',
])
/** Transient files: render/task progress, recovery plans, locks. Rebuilt by Story as it works. */
const TRANSIENT_FILE = /^(\.render_status\.json|\.task-manifest\.json|.*_chunked-progress\.json|episode-recovery-plans\.json|running\.flag|.*\.lock)$/i
const isTempName = (name: string) => /\.(tmp|partial|part|crdownload)$/i.test(name) || name.startsWith('.story-studio-write-test-') || TRANSIENT_FILE.test(name)

/**
 * Secrets that must never be copied, wherever they sit. YouTube OAuth tokens live in a channel's
 * `secrets.json`; app-wide keys in `app-secrets.json`.
 */
const SECRET_FILE = /^(secrets\.json|app-secrets\.json|.*\.(key|pem|p12)|youtube-tokens?.*\.json)$/i

/** Episode subfolder keys → default folder names; a channel may rename them in project.json. */
const SUBFOLDER_DEFAULTS: Record<string, string> = {
  images: '{code} - 05 Scene Images',
  thumbnails: '{code} - 06 Thumbnail Images',
  audio: '{code} - 07 Audio Assets',
  merged_audio: '{code} - 08 Audio Merge Output',
  video: '{code} - 10 Video Assembly Output',
  video_assets: '{code} - 11 Video Assets',
}

interface ChannelFacts {
  slug: string
  name: string
  prefix: string
  /** Subfolder key by folder name for one episode code. */
  subfolderKey: (folderName: string) => { key: string; code: string } | null
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function readJson(file: string): Promise<any> {
  try { return JSON.parse(await fs.readFile(file, 'utf-8')) } catch { return null }
}

async function channelFacts(dir: string, slug: string): Promise<ChannelFacts> {
  const meta = (await readJson(path.join(dir, 'project.json'))) || {}
  const names: Record<string, string> = { ...SUBFOLDER_DEFAULTS }
  for (const key of Object.keys(names)) {
    const custom = meta.subfolder_names?.[key]
    if (typeof custom === 'string' && custom.includes('{code}')) names[key] = custom
  }
  const matchers = Object.entries(names).map(([key, template]) => {
    const [before, after] = template.split('{code}')
    return { key, re: new RegExp(`^${escapeRegex(before)}([A-Za-z]{1,8}\\d{2,6})${escapeRegex(after ?? '')}$`) }
  })
  return {
    slug,
    name: typeof meta.name === 'string' && meta.name ? meta.name : slug,
    prefix: typeof meta.episode_prefix === 'string' && meta.episode_prefix ? meta.episode_prefix : 'EP',
    subfolderKey(folderName) {
      for (const m of matchers) {
        const hit = m.re.exec(folderName)
        if (hit) return { key: m.key, code: hit[1] }
      }
      return null
    },
  }
}

/**
 * Which file an episode's thumbnail record is: the one pinned for upload, else the one the upload
 * picker would choose (`listUploadThumbnails`: highest `_v{N}`, then name, descending).
 */
async function recordThumbnail(thumbDir: string, episodeDir: string): Promise<string> {
  let names: string[] = []
  try { names = (await fs.readdir(thumbDir)).filter(n => /\.(png|jpe?g)$/i.test(n)) } catch { return '' }
  const overrides = await readJson(path.join(episodeDir, 'upload_metadata_overrides.json'))
  const pinned = overrides?.youtube?.selected_thumbnail
  if (typeof pinned === 'string' && names.includes(pinned)) return pinned
  const versionOf = (n: string) => Number(/_v(\d+)\./i.exec(n)?.[1] ?? 0)
  names.sort((a, b) => versionOf(b) - versionOf(a) || b.localeCompare(a))
  return names[0] ?? ''
}

/**
 * Decide one file inside an episode folder. `sub` is the episode subfolder it sits in (or null for
 * the episode folder itself and any folder Story does not name). Returns null to leave it out.
 */
export function classifyEpisodeFile(
  name: string,
  sub: { key: string; code: string } | null,
  thumbRecord: string,
  /** Folder names between the episode folder and the file. */
  dirs: string[] = [],
): BackupCategory | null {
  if (!isMedia(name)) return 'records'
  // Owner-made, not generated: Living Picture outlines and img2img reference images.
  if (dirs.includes('living_masks') || dirs.includes('img2img-references')) return 'records'
  if (!sub) return null
  switch (sub.key) {
    case 'thumbnails':
      return name === thumbRecord ? 'records' : 'all_thumbnails'
    case 'audio':
      return AUDIO_EXT.test(name) ? 'narration_audio' : null
    case 'video':
      return VIDEO_EXT.test(name) && isFinalVideoFilename(sub.code, name) ? 'final_videos' : null
    default:
      return null
  }
}

// ── Scanning ────────────────────────────────────────────────────────────────

export interface ScanResult {
  files: SourceFile[]
  /** Folders that could not be read: nothing under them may be treated as removed. */
  unreadable: string[]
  channels: Record<string, ChannelCounts>
  /** Bytes per category, overall and per channel, for the "what would this take" view. */
  sizes: Record<BackupCategory, number>
  channel_sizes: Record<string, Record<BackupCategory, number>>
  /** Folders in the Library that are not channels and so were left out, for honesty in the UI. */
  skipped_folders: string[]
}

const emptySizes = (): Record<BackupCategory, number> => ({ records: 0, final_videos: 0, narration_audio: 0, all_thumbnails: 0 })

export interface ScanSources {
  /** Story's own data folder (`app-settings.json` lives here). */
  dataDir: string
  /** The Library. */
  libraryRoot: string
  shouldStop?: () => boolean
  onProgress?: (checked: number, current: string) => void
}

/**
 * App-wide stores worth keeping, relative to Story's data folder. Everything else in that folder is
 * Chromium state, caches, logs or update downloads. `app-settings.json` is written without its
 * secret and machine-only keys (see `sanitizeAppSettings`), so it is not copied byte for byte.
 */
export const APP_STORES: string[] = [
  // Installed content packs and the owner's own style packs (`content-packs/user-style-packs`).
  'content-packs',
  // Which YouTube channel each project uploads to, and which video ids are claimed. No tokens.
  'youtube/connections.json',
  'youtube/video-claims.json',
  // Where the B-roll pools are.
  'broll-pools.json',
]
// Voice presets and favourites live inside app-settings.json. Character library, series formulas,
// thumbnail templates, topic packs and niches live in dot-folders at the Library root, which the
// Library walk keeps. Custom voices are GenStudio ids (no audio on disk); metadata formulas and the
// effects library are built in or come from content packs.

export async function scanSources(src: ScanSources): Promise<ScanResult> {
  const result: ScanResult = {
    files: [], unreadable: [], channels: {}, sizes: emptySizes(), channel_sizes: {}, skipped_folders: [],
  }
  let checked = 0
  const libraryAbs = path.resolve(src.libraryRoot)

  const add = (file: Omit<SourceFile, 'channel'> & { channel?: string }) => {
    const entry: SourceFile = { channel: '', ...file }
    result.files.push(entry)
    result.sizes[entry.category] += entry.size
    if (entry.channel) {
      const sizes = result.channel_sizes[entry.channel] ??= emptySizes()
      sizes[entry.category] += entry.size
    }
  }

  async function list(dir: string): Promise<import('fs').Dirent[] | null> {
    try { return await fs.readdir(dir, { withFileTypes: true }) } catch (e: any) {
      if (e?.code !== 'ENOENT') result.unreadable.push(dir)
      return null
    }
  }

  async function statFile(abs: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const st = await fs.stat(abs)
      return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null
    } catch { return null }
  }

  /** Walk a folder, asking `decide` about every file. Skips junk, temp files, secrets and `SKIP_DIRS`. */
  async function walk(
    dir: string,
    rel: string,
    decide: (name: string, abs: string, dir: string) => Promise<BackupCategory | null> | BackupCategory | null,
    channel = '',
    descend?: (name: string, abs: string) => boolean,
  ): Promise<void> {
    if (src.shouldStop?.()) return
    // Never walk into the Library from the data folder, or into the backup itself.
    if (path.resolve(dir) === libraryAbs && rel.startsWith('app/')) return
    const entries = await list(dir)
    if (!entries) return
    for (const entry of entries) {
      if (src.shouldStop?.()) return
      const name = entry.name
      if (JUNK_NAMES.has(name) || isTempName(name)) continue
      const abs = path.join(dir, name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name) || name === BACKUP_DIR_NAME) continue
        if (descend && !descend(name, abs)) continue
        await walk(abs, `${rel}/${name}`, decide, channel, descend)
        continue
      }
      if (!entry.isFile() || SECRET_FILE.test(name)) continue
      const category = await decide(name, abs, dir)
      if (!category) continue
      const st = await statFile(abs)
      if (!st) continue
      // A channel's config.json can still hold a legacy provider key: written without it.
      const sanitize = name === 'config.json' && !!channel && rel === `library/${channel}`
      add({ rel: `${rel}/${name}`, abs, size: st.size, mtimeMs: st.mtimeMs, category, channel, ...(sanitize ? { sanitize } : {}) })
      if (++checked % 200 === 0) {
        src.onProgress?.(checked, `${rel}/${name}`)
        await new Promise(resolve => setImmediate(resolve))
      }
    }
  }

  // 1. App-wide stores.
  for (const store of APP_STORES) {
    const abs = path.join(src.dataDir, ...store.split('/'))
    if (path.resolve(abs) === libraryAbs) continue
    const st = await statFile(abs)
    if (st) add({ rel: `app/${store}`, abs, size: st.size, mtimeMs: st.mtimeMs, category: 'records' })
    else await walk(abs, `app/${store}`, () => 'records')
  }

  // 2. The Library.
  const top = await list(src.libraryRoot)
  for (const entry of top ?? []) {
    if (src.shouldStop?.()) break
    const name = entry.name
    const abs = path.join(src.libraryRoot, name)
    if (JUNK_NAMES.has(name) || isTempName(name)) continue
    if (!entry.isDirectory()) {
      // Loose files at the Library root (a marker, a note). Small; keep unless media or secret.
      if (entry.isFile() && !SECRET_FILE.test(name) && !isMedia(name)) {
        const st = await statFile(abs)
        if (st) add({ rel: `library/${name}`, abs, size: st.size, mtimeMs: st.mtimeMs, category: 'records' })
      }
      continue
    }
    if (SKIP_DIRS.has(name) || name === BACKUP_DIR_NAME) continue
    if (name === 'Exports') {
      // Finished videos (Library-wide). Opt-in.
      await walk(abs, `library/${name}`, n => (VIDEO_EXT.test(n) ? 'final_videos' : null))
      continue
    }
    if (existsSync(path.join(abs, 'project.json'))) {
      await scanChannel(abs, name)
      continue
    }
    if (name.startsWith('.') || name === '_Project Assets') {
      // Shared stores the loaders keep at the Library root, and files shared between channels.
      await walk(abs, `library/${name}`, () => 'records')
      continue
    }
    result.skipped_folders.push(name)
  }

  async function scanChannel(dir: string, slug: string): Promise<void> {
    const facts = await channelFacts(dir, slug)
    const counts: ChannelCounts = { name: facts.name, episodes: 0, files: 0, bytes: 0, uploaded_episodes: 0, last_episode_code: '' }
    result.channels[slug] = counts
    const before = result.files.length
    const codes = new Set<string>()
    const thumbRecords = new Map<string, string>()
    const uploadedCodes = new Set<string>()

    await walk(dir, `library/${slug}`, async (name, abs, parent) => {
      const relToChannel = path.relative(dir, parent).split(path.sep)
      const inEpisodes = relToChannel[0] === 'episodes'
      if (!inEpisodes) {
        // Channel level. Exports holds finished videos (opt-in); everything else — config, presets,
        // ideas, plans, Music Pool tracks, logos, intro/outro clips, backgrounds — is kept.
        if (relToChannel[0] === 'Exports') return VIDEO_EXT.test(name) ? 'final_videos' : isMedia(name) ? null : 'records'
        if (relToChannel[0] === 'youtube' && relToChannel[1] === 'operations' && name.endsWith('.json') && name !== 'index.json') {
          const op = await readJson(abs)
          if (op?.video_id && op.episode_code && op.lifecycle === 'ready') uploadedCodes.add(op.episode_code)
        }
        return 'records'
      }
      // Inside episodes/: find the nearest Story-named episode subfolder above this file.
      let sub: { key: string; code: string } | null = null
      let subDir = parent
      for (let d = parent; d.startsWith(dir) && d !== dir; d = path.dirname(d)) {
        const hit = facts.subfolderKey(path.basename(d))
        if (hit) { sub = hit; subDir = d; break }
      }
      if (sub?.key === 'thumbnails') {
        let pick = thumbRecords.get(subDir)
        if (pick === undefined) {
          pick = await recordThumbnail(subDir, path.dirname(subDir))
          thumbRecords.set(subDir, pick)
        }
        return classifyEpisodeFile(name, sub, pick)
      }
      if (name === 'youtube_upload.json') {
        const sidecar = await readJson(abs)
        const code = /^([A-Za-z]{1,8}\d{2,6}) - /.exec(path.basename(parent))?.[1]
        if (sidecar?.video_id && code && !sidecar.deleted_at) uploadedCodes.add(code)
      }
      const episodeDir = relToChannel.findIndex(part => /^[A-Za-z]{1,8}\d{2,6} - /.test(part))
      const dirs = episodeDir >= 0 ? relToChannel.slice(episodeDir + 1) : []
      // An episode's own `music/` is a render cache, not the channel's Music Pool.
      if (dirs.includes('music') && isMedia(name)) return null
      return classifyEpisodeFile(name, sub, '', dirs)
    }, slug)

    // Episodes: every `<CODE> - <title>` folder under episodes/, however deep the season nesting.
    const prefixRe = new RegExp(`^(${escapeRegex(facts.prefix)}\\d{2,6}) - `)
    for (let i = before; i < result.files.length; i++) {
      const f = result.files[i]
      counts.files += 1
      counts.bytes += f.size
      for (const part of f.rel.split('/')) {
        const hit = prefixRe.exec(part)
        if (hit) {
          codes.add(hit[1])
          break
        }
      }
    }
    counts.episodes = codes.size
    counts.uploaded_episodes = uploadedCodes.size
    counts.last_episode_code = [...codes].sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''))).pop() ?? ''
  }

  return result
}

// ── App settings ────────────────────────────────────────────────────────────

/**
 * Keys that are secret or only mean something on this Mac. Left out of the backup, and never
 * overwritten by a restore. Server-mode credentials, automation keys, the Gateway key and Telegram
 * tokens are secrets; the Library, exports and FFmpeg paths are this machine's.
 */
const SECRET_SETTING = /(secret|token|password|passcode|credential|api_?key|private|auth|session|automation|bearer|cookie|salt|hash)/i
export const MACHINE_SETTINGS = new Set([
  'library_root', 'projects_root_override', 'exports_root', 'exports_root_previous', 'ffmpeg_path', 'ffprobe_path',
  'linked_project_paths', 'external_final_video_root', 'last_seen_version', BACKUP_SETTINGS_KEY,
  'server_mode', 'genstudio_catalog_last_good_v1',
])

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_SETTING.test(k)) continue
    out[k] = stripSecrets(v)
  }
  return out
}

/** Secret-looking keys anywhere in a channel's config.json (legacy `genstudio_api_key`, `google_api_key`). */
const CONFIG_SECRET = /(api_?keys?|secret|token|password)$/i
export function sanitizeChannelConfig(config: unknown): unknown {
  if (Array.isArray(config)) return config.map(sanitizeChannelConfig)
  if (!config || typeof config !== 'object') return config
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config)) {
    if (CONFIG_SECRET.test(k)) continue
    out[k] = sanitizeChannelConfig(v)
  }
  return out
}

export function sanitizeAppSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(settings || {})) {
    if (MACHINE_SETTINGS.has(k) || SECRET_SETTING.test(k)) continue
    out[k] = stripSecrets(v)
  }
  return out
}

// ── Copying ─────────────────────────────────────────────────────────────────

/** The folder a backup lives in, given the folder the owner picked. */
export function resolveBackupRoot(picked: string): string {
  const abs = path.resolve(picked)
  if (path.basename(abs) === BACKUP_DIR_NAME || existsSync(path.join(abs, MANIFEST_NAME))) return abs
  return path.join(abs, BACKUP_DIR_NAME)
}

export async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/** Copy into `_partial`, hashing as it streams, then rename into place. Never a half file under its real name. */
async function copyHashed(from: string, to: string, partialDir: string, rel: string, mtimeMs: number): Promise<string> {
  await fs.mkdir(partialDir, { recursive: true })
  const partial = path.join(partialDir, createHash('sha1').update(rel).digest('hex'))
  const hash = createHash('sha256')
  const tap = new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); cb(null, chunk) } })
  // `flags: 'w'` truncates a leftover partial from an interrupted run; that file was never a backup.
  await pipeline(createReadStream(from), tap, createWriteStream(partial, { flags: 'w' }))
  const fd = await fs.open(partial, 'r+')
  try { await fd.sync() } finally { await fd.close() }
  const when = new Date(mtimeMs)
  await fs.utimes(partial, when, when)
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.rename(partial, to)
  return hash.digest('hex')
}

/** Move a file on the drive into `_versions/<stamp>/<rel>`. Never replaces anything already there. */
async function moveToVersions(root: string, stamp: string, rel: string): Promise<boolean> {
  const from = path.join(root, rel)
  if (!existsSync(from)) return false
  let to = path.join(root, VERSIONS_DIR, stamp, rel)
  await fs.mkdir(path.dirname(to), { recursive: true })
  for (let n = 1; existsSync(to); n++) to = path.join(root, VERSIONS_DIR, stamp, `${rel}.${n}`)
  await fs.rename(from, to)
  return true
}

export function versionStamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

export async function readManifest(root: string): Promise<Manifest | null> {
  const m = await readJson(path.join(root, MANIFEST_NAME))
  return m && m.format === BACKUP_FORMAT && m.files && typeof m.files === 'object' ? m as Manifest : null
}

const sameTime = (a: number, b: number) => Math.floor(a / 1000) === Math.floor(b / 1000)

export interface BackupProgress {
  stage: 'scanning' | 'copying' | 'tidying' | 'verifying' | 'restoring'
  done: number
  total: number
  bytes_done: number
  bytes_total: number
  current: string
}

export interface BackupResult {
  root: string
  complete: boolean
  /** Set when the run stopped early: the drive went away, or the owner pressed Stop. */
  interrupted: string
  started_at: string
  finished_at: string
  files: number
  bytes: number
  added: number
  updated: number
  unchanged: number
  removed: number
  versions_stamp: string
  /** Up to 50 changed paths, for "what changed". */
  changes: Array<{ path: string; change: 'added' | 'updated' | 'removed' }>
  channels: Record<string, ChannelCounts>
  sizes: Record<BackupCategory, number>
  skipped_folders: string[]
  errors: string[]
}

export interface RunBackupInput extends ScanSources {
  destination: string
  options: BackupOptions
  storyVersion: string
  appSettings: Record<string, unknown>
  onCopyProgress?: (p: BackupProgress) => void
}

function driveGone(e: any): boolean {
  return ['ENOENT', 'EIO', 'ENXIO', 'ENODEV', 'EROFS', 'ENOSPC', 'EACCES', 'EPERM', 'ESTALE'].includes(e?.code)
}

export async function runBackup(input: RunBackupInput): Promise<BackupResult> {
  const started = new Date()
  const picked = path.resolve(input.destination)
  const parent = path.basename(picked) === BACKUP_DIR_NAME ? path.dirname(picked) : picked
  if (!existsSync(parent)) {
    throw Object.assign(new Error(`The backup folder "${parent}" is not there. If it is on a drive, plug the drive in and try again.`), { status: 409, expose: true })
  }
  if (!existsSync(input.libraryRoot)) {
    // Without this, every file on the drive would look "removed" and move to _versions.
    throw Object.assign(new Error(`Your Library "${input.libraryRoot}" is not available, so there is nothing to back up.`), { status: 409, expose: true })
  }
  const root = resolveBackupRoot(picked)
  const rootAbs = path.resolve(root)
  const libAbs = path.resolve(input.libraryRoot)
  if (rootAbs === libAbs || rootAbs.startsWith(libAbs + path.sep)) {
    throw Object.assign(new Error('Choose a backup folder outside your Library — a backup inside the thing it protects is lost with it.'), { status: 400, expose: true })
  }
  await fs.mkdir(root, { recursive: true })
  const partialDir = path.join(root, PARTIAL_DIR)
  const stamp = versionStamp(started)
  const previous = await readManifest(root)

  const report = (p: BackupProgress) => input.onCopyProgress?.(p)
  report({ stage: 'scanning', done: 0, total: 0, bytes_done: 0, bytes_total: 0, current: '' })
  const scan = await scanSources({
    ...input,
    onProgress: (checked, current) => report({ stage: 'scanning', done: checked, total: 0, bytes_done: 0, bytes_total: 0, current }),
  })
  const wanted = scan.files.filter(f => f.category === 'records' || input.options[f.category])

  const files: Record<string, ManifestFile> = {}
  const result: BackupResult = {
    root, complete: false, interrupted: '', started_at: started.toISOString(), finished_at: '',
    files: 0, bytes: 0, added: 0, updated: 0, unchanged: 0, removed: 0, versions_stamp: '',
    changes: [], channels: scan.channels, sizes: scan.sizes, skipped_folders: scan.skipped_folders, errors: [],
  }
  const note = (p: string, change: 'added' | 'updated' | 'removed') => {
    if (result.changes.length < 50) result.changes.push({ path: p, change })
  }

  const manifestOf = (complete: boolean): Manifest => {
    const appFiles = Object.entries(files).filter(([k]) => k.startsWith('app/'))
    const libFiles = Object.entries(files).filter(([k]) => k.startsWith('library/'))
    return {
      format: BACKUP_FORMAT,
      format_version: 1,
      story_version: input.storyVersion,
      machine: os.hostname(),
      created_at: previous?.created_at || started.toISOString(),
      updated_at: new Date().toISOString(),
      complete,
      options: { ...input.options },
      counts: {
        app: { files: appFiles.length, bytes: appFiles.reduce((n, [, f]) => n + f.size, 0) },
        library: { files: libFiles.length, bytes: libFiles.reduce((n, [, f]) => n + f.size, 0) },
        channels: scan.channels,
      },
      // While incomplete, keep what the previous manifest knew about files not yet reached: they
      // are still on the drive, and a resumed run must not mistake them for strangers.
      files: complete ? files : { ...(previous?.files ?? {}), ...files },
    }
  }

  const bytesTotal = wanted.reduce((n, f) => n + f.size, 0)
  let bytesDone = 0
  let lastCheckpoint = Date.now()
  let done = 0
  try {
    // Files written rather than copied (secrets removed): compared by content, not by date.
    const writeGenerated = async (rel: string, body: string, mtimeMs: number) => {
      const dest = path.join(root, rel)
      const sha = createHash('sha256').update(body).digest('hex')
      const prior = previous?.files[rel]
      if (prior?.sha256 === sha && existsSync(dest)) {
        files[rel] = prior
        result.unchanged++
        return
      }
      if (existsSync(dest)) { await moveToVersions(root, stamp, rel); result.versions_stamp = stamp; result.updated++; note(rel, 'updated') } else { result.added++; note(rel, 'added') }
      await fs.mkdir(partialDir, { recursive: true })
      const tmp = path.join(partialDir, createHash('sha1').update(rel).digest('hex'))
      await fs.writeFile(tmp, body)
      const when = new Date(mtimeMs)
      await fs.utimes(tmp, when, when)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.rename(tmp, dest)
      files[rel] = { size: Buffer.byteLength(body), mtime: Math.floor(mtimeMs), sha256: sha }
    }
    await writeGenerated('app/app-settings.json', JSON.stringify(sanitizeAppSettings(input.appSettings), null, 2) + '\n', started.getTime())

    for (const f of wanted) {
      if (input.shouldStop?.()) { result.interrupted = 'Stopped. Everything copied so far is safe; the next backup carries on from here.'; break }
      const dest = path.join(root, f.rel)
      report({ stage: 'copying', done, total: wanted.length, bytes_done: bytesDone, bytes_total: bytesTotal, current: f.rel })
      if (f.sanitize) {
        const raw = await readJson(f.abs)
        if (raw) {
          await writeGenerated(f.rel, JSON.stringify(sanitizeChannelConfig(raw), null, 2) + '\n', f.mtimeMs)
          done++
          continue
        }
        result.errors.push(`${f.rel}: could not be read as JSON; copied as it is.`)
      }
      let st: import('fs').Stats | null = null
      try { st = await fs.stat(dest) } catch (e: any) { if (e?.code !== 'ENOENT') throw e }
      if (st && st.size === f.size && sameTime(st.mtimeMs, f.mtimeMs)) {
        const prior = previous?.files[f.rel]
        files[f.rel] = prior && prior.size === f.size
          ? prior
          : { size: f.size, mtime: Math.floor(f.mtimeMs), sha256: await hashFile(dest) }
        result.unchanged++
      } else {
        let sha: string
        try {
          if (st) { await moveToVersions(root, stamp, f.rel); result.versions_stamp = stamp }
          sha = await copyHashed(f.abs, dest, partialDir, f.rel, f.mtimeMs)
        } catch (e: any) {
          // The drive is gone, full or failing: stop, and say so below.
          if (!existsSync(root) || ['ENOSPC', 'EROFS', 'EIO', 'ENXIO', 'ENODEV', 'ESTALE'].includes(e?.code)) throw e
          // Otherwise it is this one source file (regenerated, trashed or unreadable mid-run): note it
          // and carry on; the next backup tries it again.
          if (result.errors.length < 100) result.errors.push(`${f.rel}: could not be copied (${e?.code || e?.message}); it will be tried again next time.`)
          continue
        }
        files[f.rel] = { size: f.size, mtime: Math.floor(f.mtimeMs), sha256: sha }
        if (st) { result.updated++; note(f.rel, 'updated') } else { result.added++; note(f.rel, 'added') }
        bytesDone += f.size
      }
      done++
      if (Date.now() - lastCheckpoint > 15_000) {
        await writeJsonAtomic(path.join(root, MANIFEST_NAME), manifestOf(false), { compact: true })
        lastCheckpoint = Date.now()
      }
    }

    if (!result.interrupted) {
      // Gone from the source (or no longer chosen): move the drive's copy aside. Never under a
      // folder that could not be read this time — unreadable is not the same as removed.
      report({ stage: 'tidying', done, total: wanted.length, bytes_done: bytesDone, bytes_total: bytesTotal, current: '' })
      const unreadable = scan.unreadable.map(d => path.resolve(d))
      const unreadableRel = scan.files.length ? unreadable : []
      for (const rel of Object.keys(previous?.files ?? {})) {
        if (files[rel]) continue
        const src = sourceOf(rel, input)
        if (src && unreadableRel.some(u => src === u || src.startsWith(u + path.sep))) {
          files[rel] = previous!.files[rel]
          continue
        }
        if (await moveToVersions(root, stamp, rel)) {
          result.removed++
          result.versions_stamp = stamp
          note(rel, 'removed')
        }
      }
    }
  } catch (e: any) {
    if (!driveGone(e)) throw e
    result.interrupted = existsSync(root)
      ? `Could not write to the backup drive (${e.code}). Everything copied before this is safe; run the backup again to carry on.`
      : 'The backup drive went away. Everything copied before it did is safe; plug it back in and the next backup carries on from there.'
  }

  result.complete = !result.interrupted
  result.files = Object.keys(files).length
  result.bytes = Object.values(files).reduce((n, f) => n + f.size, 0)
  result.finished_at = new Date().toISOString()
  try {
    await writeJsonAtomic(path.join(root, MANIFEST_NAME), manifestOf(result.complete), { compact: true })
  } catch (e: any) {
    if (!driveGone(e)) throw e
    result.complete = false
    result.interrupted ||= 'The backup drive went away before the record of this backup was written. Run it again when the drive is back.'
  }
  return result
}

/** Absolute source path of a backup-relative path, for the unreadable-folder check. */
function sourceOf(rel: string, src: ScanSources): string | null {
  if (rel.startsWith('library/')) return path.resolve(src.libraryRoot, ...rel.slice('library/'.length).split('/'))
  if (rel.startsWith('app/')) return path.resolve(src.dataDir, ...rel.slice('app/'.length).split('/'))
  return null
}

// ── Check backup ────────────────────────────────────────────────────────────

export interface VerifyResult {
  root: string
  checked: number
  ok: number
  missing: string[]
  damaged: string[]
  /** True when the manifest records an interrupted backup. */
  incomplete: boolean
  finished_at: string
}

export async function verifyBackup(
  picked: string,
  opts: { shouldStop?: () => boolean; onProgress?: (p: BackupProgress) => void } = {},
): Promise<VerifyResult> {
  const root = resolveBackupRoot(picked)
  const manifest = await readManifest(root)
  if (!manifest) throw Object.assign(new Error(`No Story Studio backup found in "${picked}".`), { status: 404, expose: true })
  const entries = Object.entries(manifest.files)
  const total = entries.reduce((n, [, f]) => n + f.size, 0)
  const out: VerifyResult = { root, checked: 0, ok: 0, missing: [], damaged: [], incomplete: !manifest.complete, finished_at: '' }
  let bytes = 0
  for (const [rel, f] of entries) {
    if (opts.shouldStop?.()) break
    opts.onProgress?.({ stage: 'verifying', done: out.checked, total: entries.length, bytes_done: bytes, bytes_total: total, current: rel })
    const abs = path.join(root, rel)
    out.checked++
    bytes += f.size
    if (!existsSync(abs)) { out.missing.push(rel); continue }
    try {
      if ((await hashFile(abs)) === f.sha256) out.ok++
      else out.damaged.push(rel)
    } catch {
      out.damaged.push(rel)
    }
  }
  out.finished_at = new Date().toISOString()
  return out
}

// ── _versions ───────────────────────────────────────────────────────────────

export async function dirBytes(dir: string): Promise<number> {
  let total = 0
  let entries: import('fs').Dirent[]
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) total += await dirBytes(abs)
    else if (e.isFile()) total += (await fs.stat(abs).catch(() => ({ size: 0 }))).size
  }
  return total
}

export async function listVersions(picked: string): Promise<{ root: string; total_bytes: number; versions: Array<{ stamp: string; bytes: number }> }> {
  const root = resolveBackupRoot(picked)
  const dir = path.join(root, VERSIONS_DIR)
  let names: string[] = []
  try { names = (await fs.readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort() } catch { /* none yet */ }
  const versions = []
  for (const stamp of names) versions.push({ stamp, bytes: await dirBytes(path.join(dir, stamp)) })
  return { root, total_bytes: versions.reduce((n, v) => n + v.bytes, 0), versions }
}

/**
 * Permanently delete chosen `_versions/<stamp>` folders. The ONE place this feature deletes on the
 * drive, and only ever on the owner's confirmed request (the route refuses automation keys).
 */
export async function pruneVersions(picked: string, stamps: string[]): Promise<{ removed: string[]; freed_bytes: number }> {
  const root = resolveBackupRoot(picked)
  const dir = path.join(root, VERSIONS_DIR)
  const removed: string[] = []
  let freed = 0
  for (const stamp of stamps) {
    if (!/^\d{4}-\d{2}-\d{2}_\d{6}$/.test(stamp)) continue
    const target = path.join(dir, stamp)
    if (!existsSync(target)) continue
    freed += await dirBytes(target)
    await fs.rm(target, { recursive: true })
    removed.push(stamp)
  }
  return { removed, freed_bytes: freed }
}

// ── Restore ─────────────────────────────────────────────────────────────────

export interface RestorePreview {
  root: string
  story_version: string
  machine: string
  updated_at: string
  complete: boolean
  app: { files: number; bytes: number }
  shared: { files: number; bytes: number }
  channels: Array<ChannelCounts & { slug: string; restore_bytes: number; restore_files: number; exists_in_target: boolean }>
  target: string
}

export async function previewRestore(picked: string, target: string): Promise<RestorePreview> {
  const root = resolveBackupRoot(picked)
  const manifest = await readManifest(root)
  if (!manifest) throw Object.assign(new Error(`No Story Studio backup found in "${picked}". Choose the folder that holds "${BACKUP_DIR_NAME}".`), { status: 404, expose: true })
  const perChannel: Record<string, { files: number; bytes: number }> = {}
  const app = { files: 0, bytes: 0 }
  const shared = { files: 0, bytes: 0 }
  for (const [rel, f] of Object.entries(manifest.files)) {
    const parts = rel.split('/')
    if (parts[0] === 'app') { app.files++; app.bytes += f.size; continue }
    const slug = parts[1]
    if (parts.length > 2 && manifest.counts.channels[slug]) {
      const c = perChannel[slug] ??= { files: 0, bytes: 0 }
      c.files++
      c.bytes += f.size
    } else {
      shared.files++
      shared.bytes += f.size
    }
  }
  return {
    root,
    story_version: manifest.story_version,
    machine: manifest.machine,
    updated_at: manifest.updated_at,
    complete: manifest.complete,
    app,
    shared,
    target: path.resolve(target),
    channels: Object.entries(manifest.counts.channels).map(([slug, c]) => ({
      ...c,
      slug,
      restore_files: perChannel[slug]?.files ?? 0,
      restore_bytes: perChannel[slug]?.bytes ?? 0,
      exists_in_target: existsSync(path.join(target, slug, 'project.json')),
    })).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

async function isEmptyPackState(file: string): Promise<boolean> {
  const state = await readJson(file)
  return !!state && typeof state.packs === 'object' && state.packs !== null && Object.keys(state.packs).length === 0
}

export interface RestoreInput {
  source: string
  /** The Library to restore into. */
  target: string
  /** Channels to restore; `replace` must be true for one that already exists in the target. */
  channels: Array<{ slug: string; replace?: boolean }>
  /** Also restore app-wide stores and non-secret settings. */
  app: boolean
  dataDir: string
  currentSettings: Record<string, unknown>
  writeSetting: (key: string, value: unknown) => Promise<void>
  shouldStop?: () => boolean
  onProgress?: (p: BackupProgress) => void
}

export interface RestoreResult {
  target: string
  channels: string[]
  replaced: Array<{ slug: string; moved_to: string }>
  files: number
  bytes: number
  /** Files that already existed in the target and were left as they are (first 100, and the count). */
  kept_existing: string[]
  kept_existing_count: number
  damaged: string[]
  settings_restored: string[]
  interrupted: string
}

/**
 * Restore into a Library. Never overwrites: a channel that already exists is restored only with
 * `replace`, and then the existing folder is MOVED to Story's Trash (`<target>/_trash/<slug>/replaced-by-restore-<stamp>`)
 * first. Shared and app-wide files that already exist are kept as they are and listed.
 */
export async function restoreBackup(input: RestoreInput): Promise<RestoreResult> {
  const root = resolveBackupRoot(input.source)
  const manifest = await readManifest(root)
  if (!manifest) throw Object.assign(new Error(`No Story Studio backup found in "${input.source}".`), { status: 404, expose: true })
  const target = path.resolve(input.target)
  const stamp = versionStamp()
  const chosen = new Map(input.channels.map(c => [c.slug, !!c.replace]))
  for (const slug of chosen.keys()) {
    if (!manifest.counts.channels[slug]) throw Object.assign(new Error(`"${slug}" is not in this backup.`), { status: 400, expose: true })
    if (existsSync(path.join(target, slug)) && !chosen.get(slug)) {
      throw Object.assign(new Error(`"${slug}" already exists in "${target}". Confirm replacing it, or leave it out of the restore.`), { status: 409, expose: true })
    }
  }
  const out: RestoreResult = { target, channels: [], replaced: [], files: 0, bytes: 0, kept_existing: [], kept_existing_count: 0, damaged: [], settings_restored: [], interrupted: '' }
  await fs.mkdir(target, { recursive: true })

  for (const [slug, replace] of chosen) {
    const existing = path.join(target, slug)
    if (replace && existsSync(existing)) {
      const to = moveToTrashSync(existing, path.join(libraryTrashDir(target), slug, `replaced-by-restore-${stamp}`), 'replaced-by-restore')
      out.replaced.push({ slug, moved_to: to })
    }
  }

  const entries = Object.entries(manifest.files).filter(([rel]) => {
    const parts = rel.split('/')
    if (parts[0] === 'app') return input.app && rel !== 'app/app-settings.json'
    if (manifest.counts.channels[parts[1]] && parts.length > 2) return chosen.has(parts[1])
    return true // shared Library files: _Project Assets, dot-stores, Exports (when backed up)
  })
  const total = entries.reduce((n, [, f]) => n + f.size, 0)
  let done = 0
  try {
    for (const [rel, f] of entries) {
      if (input.shouldStop?.()) { out.interrupted = 'Stopped. What was restored so far is in place; run the restore again to finish.'; break }
      input.onProgress?.({ stage: 'restoring', done, total: entries.length, bytes_done: out.bytes, bytes_total: total, current: rel })
      done++
      const parts = rel.split('/')
      const dest = parts[0] === 'app'
        ? path.join(input.dataDir, ...parts.slice(1))
        : path.join(target, ...parts.slice(1))
      if (existsSync(dest)) {
        if (rel === 'app/content-packs/state.json' && await isEmptyPackState(dest)) {
          // A fresh install writes an empty pack list; the restored one replaces it (moved aside, not deleted).
          const name = `content-packs-state-replaced-by-restore-${stamp}.json`
          try {
            moveToTrashSync(dest, path.join(libraryTrashDir(target), APP_TRASH, 'restore', name), 'replaced-by-restore')
          } catch (e: any) {
            if (e?.code !== 'EXDEV') throw e
            // The data folder is on another drive than the Library: the app's own trash.
            const { trashDir } = await import('../lib/app-paths.js')
            moveToTrashSync(dest, path.join(trashDir(), 'restore', name), 'replaced-by-restore')
          }
        } else {
          out.kept_existing_count++
          if (out.kept_existing.length < 100) out.kept_existing.push(rel)
          continue
        }
      }
      const from = path.join(root, rel)
      if (!existsSync(from)) { out.damaged.push(`${rel} (missing from the backup)`); continue }
      if (/^library\/[^/]+\/jobs\.json$/.test(rel)) {
        // Job history comes back as history only: a queued or running job from the old machine
        // must never start (and spend) on the new one.
        if ((await hashFile(from)) !== f.sha256) out.damaged.push(`${rel} (does not match its checksum)`)
        const saved = await readJson(from)
        const jobs = Array.isArray(saved?.jobs)
          ? saved.jobs.filter((j: any) => ['done', 'error', 'cancelled'].includes(j?.status)
            || (j?.type === 'video_assembly' && hasFinalRenderRemoteWaitMarker(j)))
          : []
        await writeJsonAtomic(dest, { ...(saved || {}), jobs })
        out.files++
        out.bytes += f.size
        continue
      }
      const sha = await copyHashed(from, dest, path.join(parts[0] === 'app' ? input.dataDir : target, '.restore-partial'), rel, f.mtime)
      if (sha !== f.sha256) out.damaged.push(`${rel} (does not match its checksum)`)
      out.files++
      out.bytes += f.size
    }
    // The in-flight folders are empty once every rename has landed.
    for (const d of [target, input.dataDir]) await fs.rmdir(path.join(d, '.restore-partial')).catch(() => {})
  } catch (e: any) {
    if (!driveGone(e)) throw e
    out.interrupted = 'The backup drive went away during the restore. What was restored so far is in place; plug it back in and run the restore again.'
  }
  out.channels = [...chosen.keys()]

  if (input.app && !out.interrupted) {
    const saved = await readJson(path.join(root, 'app', 'app-settings.json'))
    for (const [key, value] of Object.entries(sanitizeAppSettings(saved || {}))) {
      if (input.currentSettings[key] !== undefined) continue
      await input.writeSetting(key, value)
      out.settings_restored.push(key)
    }
  }
  return out
}
