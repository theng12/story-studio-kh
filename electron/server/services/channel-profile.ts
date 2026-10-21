/**
 * The channel's own identity — handle, About text, and the logo/banner art.
 *
 * The channel's NAME is not here: it stays authoritative in `ProjectMeta.name`
 * (project.json) and is changed through `pm.updateProject`, so a channel has
 * one name and no second copy to drift.
 *
 * The handle, the About text and the art live in `config.json` under one key,
 * `channel_profile`. The art lives in the channel's own `assets/profile/`
 * folder and is referenced the way this app references every other channel
 * file: a portable `${CHANNEL}/assets/…` token, so it travels with the
 * channel folder when the channel is copied to another Mac.
 *
 * The art is CONTENT-ADDRESSED — the file name carries a digest of its own
 * bytes — so an upload is always a new file and nothing is overwritten.
 * Replacing or removing art moves the REFERENCE; the bytes stay on disk.
 *
 * Everything here is local, and the handle rules are the app's own input
 * rules, not a claim about what any platform accepts.
 */

import { createHash } from 'node:crypto'
import fs from 'fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { imageMediaTypeForBytes } from '../lib/image-media-type.js'
import * as pm from './project-manager.js'
import { resolveAssetPath, toPortablePath } from './path-resolver.js'
import type { ChannelProfileConfig } from '../models/types.js'

/** The closed set of art this profile owns. */
export const CHANNEL_PROFILE_ASSET_KINDS = ['logo', 'banner'] as const
export type ChannelProfileAssetKind = (typeof CHANNEL_PROFILE_ASSET_KINDS)[number]

export function isChannelProfileAssetKind(value: unknown): value is ChannelProfileAssetKind {
  return value === 'logo' || value === 'banner'
}

/** The folder inside the channel that holds the art. */
const PROFILE_SUBDIR = path.join('assets', 'profile')

/** The decoded-size cap for one uploaded image (the JSON body limit is 10 MB). */
export const MAX_CHANNEL_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024

/** A ceiling on decoded pixels, so a small file that expands into a huge
 *  bitmap cannot exhaust memory during validation. */
const MAX_CHANNEL_PROFILE_IMAGE_PIXELS = 40_000_000

export const MAX_CHANNEL_PROFILE_NAME_LENGTH = 200
export const MAX_CHANNEL_PROFILE_HANDLE_LENGTH = 100
export const MAX_CHANNEL_PROFILE_DESCRIPTION_LENGTH = 10_000

const EXTENSION_BY_FORMAT: Record<string, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' }

/** An error that carries the HTTP status the route answers with. */
export class ChannelProfileError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ChannelProfileError'
    this.status = status
  }
}

/** The flat shape every channel-profile route answers with. */
export interface ChannelProfileView {
  name: string
  handle: string
  description: string
  logo_url: string | null
  banner_url: string | null
}

// ── the channel folder ─────────────────────────────────────────────────────

/**
 * The channel's folder, or null when the slug does not name one.
 *
 * A slug is ONE folder name. `pm.getProjectDir` joins it to the Library
 * root, so a slug carrying a separator or a parent reference would resolve
 * to a folder outside the Library — and this module reads and writes
 * config.json there.
 */
export function resolveChannelDir(slug: string): string | null {
  if (typeof slug !== 'string' || !slug) return null
  if (slug.includes('/') || slug.includes('\\') || slug.includes('\0')) return null
  if (slug === '.' || slug === '..') return null
  const dir = pm.getProjectDir(slug)
  if (!dir) return null
  const root = path.resolve(pm.projectsRoot())
  const resolved = path.resolve(dir)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  if (path.basename(resolved) !== slug) return null
  return resolved
}

/**
 * The channel's `assets/profile` folder, or null when it is not a real
 * folder inside the channel.
 *
 * `assets` and `assets/profile` must both be REAL directories. A symlink
 * there would put the file outside the channel while every path check still
 * looked like it was inside it, so a symlinked parent is refused outright —
 * before a write, and before a read.
 */
async function profileDirFor(channelDir: string, create: boolean): Promise<string | null> {
  const profileDir = path.join(channelDir, PROFILE_SUBDIR)
  const assetsDir = path.dirname(profileDir)
  for (const dir of [assetsDir, profileDir]) {
    const stat = await fs.lstat(dir).catch(() => null)
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) return null
      continue
    }
    if (!create) return null
    await fs.mkdir(dir, { recursive: true })
  }
  const channelReal = await fs.realpath(channelDir).catch(() => null)
  const profileReal = await fs.realpath(profileDir).catch(() => null)
  if (!channelReal || !profileReal) return null
  if (profileReal !== path.join(channelReal, PROFILE_SUBDIR)) return null
  return profileDir
}

// ── config storage ─────────────────────────────────────────────────────────

function configPathFor(slug: string): string | null {
  const dir = resolveChannelDir(slug)
  return dir ? path.join(dir, 'config.json') : null
}

/**
 * Read config.json RAW.
 *
 * Raw on purpose: `pm.getConfig` merges model catalogues and injects API
 * keys, which is right for the settings page and wrong here. A parse error
 * is thrown, not swallowed — a corrupt config must abort the write rather
 * than be replaced by a fresh one.
 */
async function readRawConfig(configPath: string): Promise<Record<string, any>> {
  let text: string
  try {
    text = await fs.readFile(configPath, 'utf-8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw new ChannelProfileError(409, 'This channel has no configuration file to update.')
    }
    throw error
  }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, any>
  } catch {
    throw new ChannelProfileError(
      409,
      'This channel\'s configuration file could not be read, so the profile was not changed. '
      + 'Repair or restore the file, then try again.',
    )
  }
}

/** Keep only the fields this module owns, and only with the right types. */
function normalizeProfile(value: unknown): ChannelProfileConfig {
  const raw = (value && typeof value === 'object' && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {}
  const out: ChannelProfileConfig = {}
  if (typeof raw.handle === 'string') out.handle = raw.handle
  if (typeof raw.description === 'string') out.description = raw.description
  if (typeof raw.logo === 'string' && raw.logo) out.logo = raw.logo
  if (typeof raw.banner === 'string' && raw.banner) out.banner = raw.banner
  return out
}

/** The stored profile, or an empty one for a channel that never set one. */
export async function readChannelProfile(slug: string): Promise<ChannelProfileConfig> {
  const configPath = configPathFor(slug)
  if (!configPath) throw new ChannelProfileError(404, 'Project not found')
  if (!existsSync(configPath)) return {}
  const raw = await readRawConfig(configPath)
  return normalizeProfile(raw.channel_profile)
}

/**
 * Read-modify-write the ONE config key this module owns, inside the file's
 * own lock.
 *
 * The whole cycle is inside `withLock` on purpose: a text save and an image
 * upload can land at the same moment, and a read-then-replace loses whichever
 * finished second. Every unrelated key is written back exactly as it was read,
 * and a save that changes nothing does not rewrite the file at all — every
 * episode-status row depends on config.json's mtime.
 *
 * No manifest write here: the portable manifest (services/manifest.ts) carries
 * structural fields only, and the profile is not one of them. The channel's
 * NAME is in the manifest, and the name goes through `pm.updateProject`,
 * which already syncs it.
 */
export async function writeChannelProfile(
  slug: string,
  mutate: (current: ChannelProfileConfig) => ChannelProfileConfig,
): Promise<ChannelProfileConfig> {
  const configPath = configPathFor(slug)
  if (!configPath) throw new ChannelProfileError(404, 'Project not found')
  let result: ChannelProfileConfig = {}
  await withLock(configPath, async () => {
    const raw = await readRawConfig(configPath)
    const current = normalizeProfile(raw.channel_profile)
    const next = normalizeProfile(mutate(current))
    result = next
    // A no-op save must not touch config.json: every episode-status row
    // depends on its mtime, so a rewrite stales the whole Production Board.
    if (JSON.stringify(next) === JSON.stringify(current)) return
    raw.channel_profile = next
    await writeJsonAtomic(configPath, raw)
  })
  return result
}

// ── text fields ────────────────────────────────────────────────────────────

/** The channel's name. Trimmed, 1–200 characters. */
export function normalizeChannelName(value: unknown): string {
  const name = String(value ?? '').trim()
  if (!name) throw new ChannelProfileError(400, 'The channel name cannot be empty.')
  if (name.length > MAX_CHANNEL_PROFILE_NAME_LENGTH) {
    throw new ChannelProfileError(400, `The channel name can be at most ${MAX_CHANNEL_PROFILE_NAME_LENGTH} characters.`)
  }
  return name
}

/**
 * The channel's handle. Trimmed, at most 100 characters, an optional leading
 * "@" is dropped, and the rest must be letters, numbers, dot, dash or
 * underscore. Unicode letters count as letters.
 */
export function normalizeChannelHandle(value: unknown): string {
  const handle = String(value ?? '').trim().replace(/^@+/, '').trim()
  if (!handle) return ''
  if (handle.length > MAX_CHANNEL_PROFILE_HANDLE_LENGTH) {
    throw new ChannelProfileError(400, `The handle can be at most ${MAX_CHANNEL_PROFILE_HANDLE_LENGTH} characters.`)
  }
  if (!/^[\p{L}\p{N}._-]+$/u.test(handle)) {
    throw new ChannelProfileError(400, 'The handle can only contain letters, numbers, dots, dashes and underscores.')
  }
  return handle
}

/** The channel's About text. Trimmed, at most 10 000 characters. */
export function normalizeChannelDescription(value: unknown): string {
  const description = String(value ?? '').trim()
  if (description.length > MAX_CHANNEL_PROFILE_DESCRIPTION_LENGTH) {
    throw new ChannelProfileError(400, `The description can be at most ${MAX_CHANNEL_PROFILE_DESCRIPTION_LENGTH} characters.`)
  }
  return description
}

// ── assets ─────────────────────────────────────────────────────────────────

/**
 * The bytes of one profile asset, or null when there is none to serve.
 *
 * The stored token is expanded by the same resolver every other channel file
 * uses, then the result is checked against the channel: the file must be a
 * regular file (not a symlink), its folder must not be a symlink, and its
 * REAL path must still be inside the channel's real `assets/profile` folder.
 */
export async function readChannelProfileAsset(
  slug: string,
  kind: ChannelProfileAssetKind,
): Promise<{ bytes: Buffer; contentType: string; etag: string } | null> {
  const channelDir = resolveChannelDir(slug)
  if (!channelDir) return null
  const profile = await readChannelProfile(slug)
  const token = kind === 'logo' ? profile.logo : profile.banner
  if (!token) return null

  const episodesRoot = await pm.getProjectOutputRoot(slug)
  if (!episodesRoot) return null
  let filePath: string
  try {
    filePath = resolveAssetPath(token, episodesRoot)
  } catch {
    return null
  }

  const profileDir = await profileDirFor(channelDir, false)
  if (!profileDir) return null
  if (path.dirname(path.resolve(filePath)) !== path.resolve(profileDir)) return null

  const stat = await fs.lstat(filePath).catch(() => null)
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null

  const channelReal = await fs.realpath(channelDir).catch(() => null)
  const profileReal = await fs.realpath(profileDir).catch(() => null)
  const fileReal = await fs.realpath(filePath).catch(() => null)
  if (!channelReal || !profileReal || !fileReal) return null
  if (!profileReal.startsWith(channelReal + path.sep)) return null
  if (!fileReal.startsWith(profileReal + path.sep)) return null

  const bytes = await fs.readFile(filePath)
  return {
    bytes,
    contentType: imageMediaTypeForBytes(bytes, filePath),
    // The digest of the bytes actually served, so a client can revalidate.
    etag: createHash('sha256').update(bytes).digest('hex'),
  }
}

/**
 * Decode base64 strictly.
 *
 * `Buffer.from(text, 'base64')` is lenient: it drops characters it does not
 * recognise, so a mangled payload decodes to *something* instead of failing.
 * The round trip proves the bytes are exactly what was sent. The length is
 * checked first, so an oversized payload is refused before it is decoded.
 */
export function decodeStrictBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ChannelProfileError(400, 'No image data was received.')
  }
  let text = value.trim()
  const dataUrl = /^data:[^;,]*;base64,(.*)$/s.exec(text)
  if (dataUrl) text = dataUrl[1]!.trim()
  text = text.replace(/\s+/g, '')
  if (!text) throw new ChannelProfileError(400, 'No image data was received.')

  const maxBase64Length = Math.ceil(MAX_CHANNEL_PROFILE_IMAGE_BYTES / 3) * 4
  if (text.length > maxBase64Length) {
    throw new ChannelProfileError(413, `The image is larger than the ${megabytes()} MB limit.`)
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new ChannelProfileError(400, 'The image data is not valid base64.')
  }
  const bytes = Buffer.from(text, 'base64')
  if (bytes.toString('base64').replace(/=+$/, '') !== text.replace(/=+$/, '')) {
    throw new ChannelProfileError(400, 'The image data is not valid base64.')
  }
  return bytes
}

function megabytes(): number {
  return Math.round(MAX_CHANNEL_PROFILE_IMAGE_BYTES / (1024 * 1024))
}

/**
 * Read the real image out of the bytes: what format it is, how big it is, and
 * whether it decodes all the way through.
 *
 * The format and size come from the decoder, never from the file name the
 * browser sent. `stats()` forces every pixel through the decoder, so a
 * truncated download is refused here instead of failing later in the app.
 */
async function inspectImage(bytes: Buffer): Promise<{ extension: string }> {
  const meta = await sharp(bytes, { failOn: 'error', limitInputPixels: MAX_CHANNEL_PROFILE_IMAGE_PIXELS })
    .metadata()
    .catch(() => { throw new ChannelProfileError(400, 'That file could not be read as an image.') })
  const extension = EXTENSION_BY_FORMAT[String(meta.format || '').toLowerCase()]
  if (!extension) throw new ChannelProfileError(400, 'The image must be a PNG, JPEG or WebP.')
  const width = Number(meta.width || 0)
  const height = Number(meta.height || 0)
  if (!width || !height) throw new ChannelProfileError(400, 'That image has no usable size.')
  if (width * height > MAX_CHANNEL_PROFILE_IMAGE_PIXELS) {
    throw new ChannelProfileError(400, 'That image is too large to use as channel art.')
  }
  try {
    await sharp(bytes, { failOn: 'error', limitInputPixels: MAX_CHANNEL_PROFILE_IMAGE_PIXELS }).stats()
  } catch {
    throw new ChannelProfileError(400, 'That image is incomplete or corrupt. Choose another file.')
  }
  return { extension }
}

/**
 * The digest of a file's bytes, or null when the file cannot be trusted.
 *
 * A symlink is NOT read: reusing a symlink at the content-addressed name
 * would point the profile at something the read path then refuses to serve,
 * and the upload would answer 200 with a broken image.
 */
async function digestOf(filePath: string): Promise<string | null> {
  const stat = await fs.lstat(filePath).catch(() => null)
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null
  try {
    const bytes = await fs.readFile(filePath)
    return createHash('sha256').update(bytes).digest('hex')
  } catch {
    return null
  }
}

/**
 * Write the bytes under a name that carries their own digest, and never
 * overwrite anything.
 *
 * The same bytes always land on the same name, so uploading the same file
 * twice is a no-op. A file already at that name is reused only when its own
 * bytes hash to the same digest — a same-SIZE file with different content is
 * a different file, and the full digest is used instead.
 */
async function storeContentAddressed(
  targetDir: string,
  base: string,
  extension: string,
  bytes: Buffer,
  digest: string,
): Promise<string> {
  const candidates = [`${base}-${digest.slice(0, 16)}.${extension}`, `${base}-${digest}.${extension}`]
  for (const candidate of candidates) {
    const filePath = path.join(targetDir, candidate)
    try {
      await fs.writeFile(filePath, bytes, { flag: 'wx' })
      return candidate
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
      if (await digestOf(filePath) === digest) return candidate
      // A different file is already at that name — try the longer digest.
    }
  }
  throw new ChannelProfileError(409, 'The image could not be stored: a different file already uses that name.')
}

/**
 * Store one piece of channel art and point the profile at it.
 *
 * The bytes that were there before are not deleted. The reference moves; the
 * old file stays on disk.
 */
export async function storeChannelProfileImage(
  slug: string,
  kind: ChannelProfileAssetKind,
  dataBase64: unknown,
): Promise<void> {
  const channelDir = resolveChannelDir(slug)
  if (!channelDir) throw new ChannelProfileError(404, 'Project not found')

  const bytes = decodeStrictBase64(dataBase64)
  if (bytes.length > MAX_CHANNEL_PROFILE_IMAGE_BYTES) {
    throw new ChannelProfileError(413, `The image is larger than the ${megabytes()} MB limit.`)
  }
  const image = await inspectImage(bytes)

  const profileDir = await profileDirFor(channelDir, true)
  if (!profileDir) {
    throw new ChannelProfileError(
      409,
      'This channel\'s assets folder is not a real folder inside the channel, so the image was not stored.',
    )
  }

  const digest = createHash('sha256').update(bytes).digest('hex')
  const fileName = await storeContentAddressed(profileDir, kind, image.extension, bytes, digest)
  const episodesRoot = await pm.getProjectOutputRoot(slug)
  if (!episodesRoot) throw new ChannelProfileError(404, 'Project not found')
  const token = toPortablePath(path.join(profileDir, fileName), episodesRoot)
  if (!token.startsWith('${CHANNEL}/')) {
    throw new ChannelProfileError(409, 'The image could not be stored inside this channel.')
  }

  await writeChannelProfile(slug, (current) => ({ ...current, [kind]: token }))
}

/**
 * Point the profile away from one piece of art. The file itself is KEPT.
 */
export async function clearChannelProfileAsset(
  slug: string,
  kind: ChannelProfileAssetKind,
): Promise<void> {
  await writeChannelProfile(slug, (current) => {
    const next = { ...current }
    delete next[kind]
    return next
  })
}

// ── the view every route answers with ──────────────────────────────────────

/**
 * The channel's profile as the app shows it: the name from project.json (the
 * authoritative one), the handle and About text from config.json, and the art
 * URLs.
 *
 * The art URL carries a digest so a replaced image is a different URL and the
 * app's cache cannot show the old one. The URL names the KIND, never a file.
 */
export async function channelProfileView(slug: string): Promise<ChannelProfileView> {
  if (!resolveChannelDir(slug)) throw new ChannelProfileError(404, 'Project not found')
  const meta = await pm.getProject(slug)
  if (!meta) throw new ChannelProfileError(404, 'Project not found')
  const profile = await readChannelProfile(slug)
  return {
    name: meta.name,
    handle: profile.handle ?? '',
    description: profile.description ?? '',
    logo_url: assetUrl(slug, 'logo', profile.logo),
    banner_url: assetUrl(slug, 'banner', profile.banner),
  }
}

function assetUrl(slug: string, kind: ChannelProfileAssetKind, token: string | undefined): string | null {
  if (!token) return null
  const fileName = token.split('/').pop() || ''
  const digest = fileName.replace(new RegExp(`^${kind}-`), '').replace(/\.[^.]+$/, '')
  return `/api/projects/${encodeURIComponent(slug)}/channel-profile/asset/${kind}?v=${encodeURIComponent(digest)}`
}
