import fs from 'fs/promises'
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
      // metadata() only reads headers. stats() forces a complete pixel decode,
      // which catches truncated IDAT/WebP/JPEG payloads before they reach FFmpeg.
      await image.stats()
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

export function clearImageValidationCache(filePath?: string): void {
  if (filePath) validationCache.delete(filePath)
  else validationCache.clear()
}
