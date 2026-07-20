import type { Job } from '../models/types.js'
import { checkpointJobState } from './job-queue.js'

export type GenStudioRecoveryState =
  | 'prepared'
  | 'accepted'
  | 'reserved'
  | 'dispatched'
  | 'running'
  | 'reconciling'
  | 'validating'
  | 'succeeded'
  | 'failed'

interface GenStudioAssetRecovery {
  operation: 'tts' | 'transcription'
  idempotency_key: string
  job_id?: string
  state: GenStudioRecoveryState
  updated_at: string
}

interface GenStudioRecoveryCheckpoint {
  version: 1
  route: 'genstudio'
  assets: Record<string, GenStudioAssetRecovery>
}

/**
 * Persist non-secret GenStudio request diagnostics on the Story job. This is
 * the restart marker used by the queue; the per-asset task manifest remains
 * the authoritative provider recovery record beside the expected output.
 */
export async function checkpointGenStudioAsset(
  job: Job,
  assetKey: string,
  entry: Omit<GenStudioAssetRecovery, 'updated_at'>,
): Promise<void> {
  const existing = job.params?.genstudio_recovery as GenStudioRecoveryCheckpoint | undefined
  const checkpoint: GenStudioRecoveryCheckpoint = existing?.version === 1
    && existing.route === 'genstudio'
    && existing.assets
    ? existing
    : { version: 1, route: 'genstudio', assets: {} }
  checkpoint.assets[assetKey] = {
    ...entry,
    updated_at: new Date().toISOString(),
  }
  job.params.genstudio_recovery = checkpoint
  await checkpointJobState(job)
}

export function hasRecoverableGenStudioCheckpoint(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const checkpoint = value as Partial<GenStudioRecoveryCheckpoint>
  if (checkpoint.version !== 1 || checkpoint.route !== 'genstudio') return false
  if (!checkpoint.assets || typeof checkpoint.assets !== 'object') return false
  return Object.values(checkpoint.assets).some(asset => {
    if (!asset || typeof asset !== 'object') return false
    const item = asset as Partial<GenStudioAssetRecovery>
    return (item.operation === 'tts' || item.operation === 'transcription')
      && typeof item.idempotency_key === 'string'
      && item.idempotency_key.startsWith('story-')
      && item.state !== 'failed'
  })
}
