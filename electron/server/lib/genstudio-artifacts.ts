import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import { assertDecodableImage, clearImageValidationCache } from './image-validation.js'

export interface GenStudioImageSaveOptions {
  /**
   * The owner's "smaller files" choice for this kind is on. If the bytes still arrive as a PNG
   * (an older Hub node ignores `output_format`), re-encode them to JPEG q90 under the SAME file
   * name — the app reads real bytes (see `stillDecoderArgs`), and `.png` names are matched in
   * many places, exactly as "Free up space" already does.
   */
  compress?: boolean
}

/**
 * PNG -> JPEG in place. Best effort: a failure, an image with real transparency, or a result that
 * is not smaller leaves the PNG that was already verified, so a paid image is never lost to this.
 */
async function recompressPngInPlace(filePath: string): Promise<void> {
  const partial = `${filePath}.jpg-${process.pid}`
  try {
    const before = await sharp(filePath).metadata()
    if (before.format !== 'png') return
    if (before.hasAlpha && !(await sharp(filePath).stats()).isOpaque) return
    await sharp(filePath).jpeg({ quality: 90, mozjpeg: true }).toFile(partial)
    const [after, original, smaller] = await Promise.all([
      assertDecodableImage(partial, 'Compressed image'),
      fs.stat(filePath), fs.stat(partial),
    ])
    if (after.width !== before.width || after.height !== before.height || smaller.size >= original.size) return
    await fs.rename(partial, filePath)
    clearImageValidationCache(filePath)
  } catch {
    // keep the verified original
  } finally {
    await fs.rm(partial, { force: true }).catch(() => {})
  }
}

/** Persist the verified private image (PNG, JPEG or WebP) returned by GenStudio's image API. */
export async function saveGenStudioImage(
  artifact: string,
  savePath: string,
  onProgress?: (bytesReceived: number, totalBytes?: number) => void,
  options: GenStudioImageSaveOptions = {},
): Promise<void> {
  const temporaryPath = await stageGenStudioImage(artifact, savePath, options)
  try {
    await fs.rename(temporaryPath, savePath)
    clearImageValidationCache(savePath)
    const bytes = await fs.stat(savePath).then(stat => stat.size)
    onProgress?.(bytes, bytes)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

/** Write and validate an image without making it visible at the final path. */
export async function stageGenStudioImage(
  artifact: string,
  savePath: string,
  options: GenStudioImageSaveOptions = {},
): Promise<string> {
  // The gateway relays each provider's own format; assertDecodableImage below checks the real bytes.
  const header = /^data:image\/(?:png|jpeg|webp);base64,/.exec(artifact)
  if (!header) {
    throw new Error('GenStudio returned an unsupported image artifact.')
  }
  const bytes = Buffer.from(artifact.slice(header[0].length), 'base64')
  if (!bytes.length) throw new Error('GenStudio returned an empty image artifact.')

  await fs.mkdir(path.dirname(savePath), { recursive: true })
  const temporaryPath = `${savePath}.partial-${process.pid}-${Date.now()}`
  try {
    await fs.writeFile(temporaryPath, bytes, { flag: 'wx' })
    await assertDecodableImage(temporaryPath, 'GenStudio image')
    if (options.compress && header[0].startsWith('data:image/png')) await recompressPngInPlace(temporaryPath)
    return temporaryPath
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}
