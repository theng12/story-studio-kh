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

/** Durable GenStudio operations that carry a typed Story-side checkpoint. */
export type GenStudioRecoveryOperation = 'tts' | 'transcription' | 'image'

const RECOVERABLE_OPERATIONS: ReadonlySet<string> = new Set<GenStudioRecoveryOperation>([
  'tts',
  'transcription',
  'image',
])

interface GenStudioAssetRecovery {
  operation: GenStudioRecoveryOperation
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
    return typeof item.operation === 'string'
      && RECOVERABLE_OPERATIONS.has(item.operation)
      && typeof item.idempotency_key === 'string'
      && item.idempotency_key.startsWith('story-')
      // A terminal failure is never "recoverable": reconnecting to it just
      // re-reads the same settled job. Only a fresh identity can help.
      && item.state !== 'failed'
  })
}
