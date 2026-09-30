import fs from 'fs/promises'
import path from 'path'
import { assertDecodableImage, clearImageValidationCache } from './image-validation.js'

/** Persist the verified private image (PNG, JPEG or WebP) returned by GenStudio's image API. */
export async function saveGenStudioImage(
  artifact: string,
  savePath: string,
  onProgress?: (bytesReceived: number, totalBytes?: number) => void,
): Promise<void> {
  const temporaryPath = await stageGenStudioImage(artifact, savePath)
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
    return temporaryPath
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}
