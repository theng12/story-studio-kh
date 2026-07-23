import fs from 'fs/promises'
import path from 'path'
import { assertDecodableImage, clearImageValidationCache } from './image-validation.js'

/** Persist the verified private PNG returned by GenStudio's image API. */
export async function saveGenStudioImage(
  artifact: string,
  savePath: string,
  onProgress?: (bytesReceived: number, totalBytes?: number) => void,
): Promise<void> {
  if (!artifact.startsWith('data:image/png;base64,')) {
    throw new Error('GenStudio returned an unsupported image artifact.')
  }
  const bytes = Buffer.from(artifact.slice('data:image/png;base64,'.length), 'base64')
  if (!bytes.length) throw new Error('GenStudio returned an empty image artifact.')

  await fs.mkdir(path.dirname(savePath), { recursive: true })
  const temporaryPath = `${savePath}.partial-${process.pid}-${Date.now()}`
  try {
    await fs.writeFile(temporaryPath, bytes, { flag: 'wx' })
    await assertDecodableImage(temporaryPath, 'GenStudio image')
    await fs.rename(temporaryPath, savePath)
    clearImageValidationCache(savePath)
    onProgress?.(bytes.length, bytes.length)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}
