/**
 * Chapter background byte import (release 1.4.386, item 14).
 *
 * Why this exists: `PATCH /projects/:slug/chapter-background-pool` accepts only
 * a reference that `resolveChapterBackground` can resolve inside the channel's
 * OWN `backgrounds/` folder (`chapter-background-pool.ts`), and no route ever
 * wrote bytes there — the adopt path places files in `assets/`, and the only
 * `backgrounds/` writer was "open the folder in Finder" on the mini. A Desktop
 * absolute path from another Mac cannot be passed as a mini path, so the PNG
 * bytes have to arrive over the authenticated server and land in `backgrounds/`.
 *
 * What this owns: exactly that one step. It decodes the bytes, validates them
 * as a real, fully-decodable image inside the same bounds the channel profile
 * uses, stores them in the channel's own `backgrounds/` folder under a
 * content-addressed generated name, and returns the canonical
 * `${CHANNEL}/backgrounds/<file>` reference plus its sha256/width/height/bytes.
 *
 * It touches NOTHING else — no config, no pool, no cursor (AGENTS §5: the
 * caller PATCHes the pool explicitly). The caller's filename is never used:
 * the stored name is generated from the digest.
 */

import { createHash } from 'node:crypto'
import fs from 'fs/promises'
import path from 'node:path'
import sharp from 'sharp'

import * as pm from './project-manager.js'
import { decodeStrictBase64, MAX_CHANNEL_PROFILE_IMAGE_BYTES } from './channel-profile.js'

/** The image formats the pool accepts (mirrors the pool's own extension list). */
const EXTENSION_BY_FORMAT: Record<string, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' }

/** A ceiling on decoded pixels, matching the profile's own guard. */
const MAX_IMAGE_PIXELS = 40_000_000

/** The folder inside the channel that holds chapter backgrounds. */
const BACKGROUNDS_SUBDIR = 'backgrounds'

/** An error that carries the HTTP status the route answers with. */
export class ChapterBackgroundImportError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ChapterBackgroundImportError'
    this.status = status
  }
}

export interface ImportedChapterBackground {
  /** `${CHANNEL}/backgrounds/<file>` — the canonical reference the pool PATCH accepts. */
  reference: string
  name: string
  sha256: string
  width: number
  height: number
  bytes: number
}

/**
 * The channel's own `backgrounds` folder, or null when it is not a real folder
 * inside the channel.
 *
 * `backgrounds` must be a REAL directory: a symlink there would put the written
 * file outside the channel while every path check still looked inside it, so a
 * symlinked folder is refused outright — before the write. The parent channel
 * folder is checked by `resolveChannelDir`-equivalent containment below.
 */
async function backgroundsDirFor(slug: string, create: boolean): Promise<string | null> {
  const channelDir = pm.getProjectDir(slug)
  if (!channelDir) return null
  const root = path.resolve(pm.projectsRoot())
  const channelResolved = path.resolve(channelDir)
  if (channelResolved !== root && !channelResolved.startsWith(root + path.sep)) return null
  if (path.basename(channelResolved) !== slug) return null

  const dir = path.join(channelDir, BACKGROUNDS_SUBDIR)
  const stat = await fs.lstat(dir).catch(() => null)
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null
  } else {
    if (!create) return null
    await fs.mkdir(dir, { recursive: true })
  }
  const channelReal = await fs.realpath(channelDir).catch(() => null)
  const dirReal = await fs.realpath(dir).catch(() => null)
  if (!channelReal || !dirReal) return null
  if (dirReal !== path.join(channelReal, BACKGROUNDS_SUBDIR)) return null
  return dirReal
}

/**
 * Write the bytes under a name that carries their own digest, and never
 * overwrite anything. The same bytes always land on the same name, so
 * re-importing an identical PNG is a no-op reuse (dedupe); a same-name
 * different file is never overwritten — the full digest name is used instead.
 */
async function storeContentAddressed(
  dir: string,
  base: string,
  extension: string,
  bytes: Buffer,
  digest: string,
): Promise<string> {
  const candidates = [`${base}-${digest.slice(0, 16)}.${extension}`, `${base}-${digest}.${extension}`]
  for (const candidate of candidates) {
    const filePath = path.join(dir, candidate)
    try {
      await fs.writeFile(filePath, bytes, { flag: 'wx' })
      return candidate
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
      const existing = await fs.readFile(filePath).catch(() => null)
      if (existing && createHash('sha256').update(existing).digest('hex') === digest) return candidate
      // A different file is already at that name — try the longer digest.
    }
  }
  throw new ChapterBackgroundImportError(409, 'The background could not be stored: a different file already uses that name.')
}

/**
 * Import one chapter-background image's bytes into this channel's own
 * `backgrounds/` folder. Validates format, size and a FULL decode (so a
 * truncated upload is refused here, not at render), then stores
 * content-addressed. Writes no config, pool or cursor.
 */
export async function importChapterBackgroundBytes(
  slug: string,
  dataBase64: unknown,
): Promise<ImportedChapterBackground> {
  const dir = await backgroundsDirFor(slug, true)
  if (!dir) {
    throw new ChapterBackgroundImportError(409, `Channel "${slug}" has no backgrounds folder inside its own directory.`)
  }

  const bytes = decodeStrictBase64(dataBase64)
  if (bytes.length > MAX_CHANNEL_PROFILE_IMAGE_BYTES) {
    throw new ChapterBackgroundImportError(413, `The image is larger than the ${Math.round(MAX_CHANNEL_PROFILE_IMAGE_BYTES / (1024 * 1024))} MB limit.`)
  }

  // Format and size come from the decoder, never from the caller's filename.
  const meta = await sharp(bytes, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS })
    .metadata()
    .catch(() => { throw new ChapterBackgroundImportError(400, 'That file could not be read as an image.') })
  const extension = EXTENSION_BY_FORMAT[String(meta.format || '').toLowerCase()]
  if (!extension) throw new ChapterBackgroundImportError(400, 'The image must be a PNG, JPEG or WebP.')
  const width = Number(meta.width || 0)
  const height = Number(meta.height || 0)
  if (!width || !height) throw new ChapterBackgroundImportError(400, 'That image has no usable size.')
  if (width * height > MAX_IMAGE_PIXELS) {
    throw new ChapterBackgroundImportError(400, 'That image is too large to use as a chapter background.')
  }
  try {
    await sharp(bytes, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).stats()
  } catch {
    throw new ChapterBackgroundImportError(400, 'That image is incomplete or corrupt. Choose another file.')
  }

  const base = 'background'
  const digest = createHash('sha256').update(bytes).digest('hex')
  const fileName = await storeContentAddressed(dir, base, extension, bytes, digest)

  return {
    reference: `\${CHANNEL}/backgrounds/${fileName}`,
    name: fileName,
    sha256: digest,
    width,
    height,
    bytes: bytes.length,
  }
}
