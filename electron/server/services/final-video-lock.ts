/**
 * Serializes the short mutation window for one canonical final-video pathname.
 * Rendering and remote verification deliberately happen outside this lock.
 */
import path from 'node:path'

import { withLock } from '../lib/atomic-store.js'

export function withFinalVideoPathLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  return withLock(`final-video:${path.resolve(filePath)}`, fn)
}

/** Serialize final-name selection for concurrent imports of one episode/container. */
export function withFinalVideoImportSelectionLock<T>(
  videoDir: string,
  code: string,
  extension: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withLock(`final-video-import:${path.resolve(videoDir)}:${code.toLowerCase()}:${extension.toLowerCase()}`, fn)
}
