/** Recovery is supported only for durable GenStudio image jobs. */

import type { ImageModelConfig } from '../models/types.js'
import type { TaskManifestEntry } from '../services/task-manifest.js'
import { recoverImageWithGenStudio } from './genstudio-client.js'

export interface RecoveryResult {
  urls: string[]
  taskId: string
  provider: string
}

export async function tryRecoverImageFromManifest(
  entry: TaskManifestEntry | null,
  apiKey: string,
  _modelConfig: ImageModelConfig,
  isCancelled?: () => boolean,
): Promise<RecoveryResult | null> {
  if (!entry?.task_id) return null
  if (entry.provider !== 'genstudio-image' && entry.provider !== 'genstudio') {
    throw new Error('This image job predates GenStudio-only operation. Submit a new GenStudio image job.')
  }
  if (!apiKey) throw new Error('A GenStudio API key is required to reconnect to this image job.')
  const result = await recoverImageWithGenStudio(apiKey, entry.task_id, { isCancelled })
  return { urls: [result.url], taskId: result.jobId, provider: entry.provider }
}

/** Old provider audio jobs are intentionally not recovered. */
export async function tryRecoverAudioFromManifest(
  _entry: TaskManifestEntry | null,
  _apiKey: string,
  _isCancelled?: () => boolean,
  _timeoutMs?: number,
): Promise<{ url: string; taskId: string; provider: string } | null> {
  return null
}

/** Old provider video jobs are intentionally not recovered. */
export async function tryRecoverVideoFromManifest(
  _entry: TaskManifestEntry | null,
  _config: unknown,
  _isCancelled?: () => boolean,
  _pollDeadlineMs?: number,
): Promise<RecoveryResult | null> {
  return null
}
