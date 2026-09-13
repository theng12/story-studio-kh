import fs from 'fs/promises'
import { devNull } from 'node:os'
import path from 'path'
import sharp from 'sharp'

export interface DecodableImageInfo {
  width: number
  height: number
  format: string
}

interface CachedValidation {
  signature: string
  result: Promise<DecodableImageInfo>
}

const validationCache = new Map<string, CachedValidation>()
const MAX_CACHE_ENTRIES = 5_000

function remember(filePath: string, entry: CachedValidation): void {
  if (validationCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = validationCache.keys().next().value
    if (oldest) validationCache.delete(oldest)
  }
  validationCache.set(filePath, entry)
}

/**
 * Fully decode a still image rather than trusting its extension, magic bytes,
 * or non-zero file size. Provider downloads can end cleanly after a truncated
 * body, leaving a plausible PNG header that fails only when FFmpeg asks for the
 * first frame. Cache by size + mtime so repeated completion checks stay cheap
 * while replacements at the same path are always revalidated.
 */
export async function assertDecodableImage(
  filePath: string,
  label = 'Image',
): Promise<DecodableImageInfo> {
  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat?.isFile() || stat.size <= 0) {
    throw new Error(`${label} is missing or empty: ${filePath}`)
  }

  const signature = `${stat.size}:${stat.mtimeMs}`
  const cached = validationCache.get(filePath)
  if (cached?.signature === signature) return cached.result

  const result = (async (): Promise<DecodableImageInfo> => {
    try {
      const image = sharp(filePath, { failOn: 'error' })
      const metadata = await image.metadata()
      // Decode every pixel to catch truncated bodies; metadata alone cannot.
      // Discard an uncompressed PNG through the native file sink: stats() also
      // computes unused histograms/entropy/sharpness, while raw().toBuffer()
      // (including Sharp's stream output) allocates the whole decoded image.
      // No resize, input rewrite, temporary file, or retained output buffer.
      if (['png', 'jpeg', 'webp'].includes(metadata.format || '')) {
        await image.png({ compressionLevel: 0 }).toFile(devNull)
      } else {
        // Keep the existing validator for other imported/reference formats;
        // their validity must not depend on whether PNG can represent them.
        await image.stats()
      }
      if (!metadata.width || !metadata.height || !metadata.format) {
        throw new Error('decoded image has no usable dimensions or format')
      }
      return { width: metadata.width, height: metadata.height, format: metadata.format }
    } catch (error: any) {
      throw new Error(
        `${label} is corrupt or incomplete and cannot be decoded: ${filePath}. ` +
        `Repair or regenerate this image, then retry. (${error?.message || error})`,
      )
    }
  })()

  remember(filePath, { signature, result })
  return result
}

export async function isDecodableImage(filePath: string): Promise<boolean> {
  try {
    await assertDecodableImage(filePath, path.basename(filePath))
    return true
  } catch {
    return false
  }
}

/**
 * The decodable image's identity for cache-busting URLs: `size-mtime`, or null
 * when the file is missing, empty or corrupt. Shares the validation cache, so a
 * page that polls every few seconds stats each image once per poll and decodes
 * it once per replacement. Scene Review keys `<img>` on this, so an unchanged
 * image keeps its element and the browser keeps its bytes.
 */
/**
 * The same answer when it can be given without decoding: the file is absent,
 * or its size/mtime match an already verified decode. `pending` means a decode
 * is needed — callers keep those to a small concurrency, because a decode is a
 * full pixel pass in the app's main process.
 */
export async function peekDecodableImageSignature(
  filePath: string,
): Promise<{ state: 'missing' } | { state: 'known'; signature: string | null } | { state: 'pending' }> {
  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat?.isFile() || stat.size <= 0) return { state: 'missing' }
  const signature = `${stat.size}:${stat.mtimeMs}`
  const cached = validationCache.get(filePath)
  if (cached?.signature !== signature) return { state: 'pending' }
  try {
    await cached.result
    return { state: 'known', signature: `${stat.size}-${Math.trunc(stat.mtimeMs)}` }
  } catch {
    return { state: 'known', signature: null }
  }
}

export async function decodableImageSignature(filePath: string): Promise<string | null> {
  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat?.isFile() || stat.size <= 0) return null
  try {
    await assertDecodableImage(filePath, path.basename(filePath))
  } catch {
    return null
  }
  return `${stat.size}-${Math.trunc(stat.mtimeMs)}`
}

export function clearImageValidationCache(filePath?: string): void {
  if (filePath) validationCache.delete(filePath)
  else validationCache.clear()
}
