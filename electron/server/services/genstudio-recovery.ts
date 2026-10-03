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
export type GenStudioRecoveryOperation = 'tts' | 'transcription' | 'image' | 'video'

interface GenStudioAssetRecovery {
  operation: GenStudioRecoveryOperation
  idempotency_key: string
  job_id?: string
  /** Exact expected artifact path. Required where one provider task maps to one file. */
  output_path?: string
  /** Exact request fingerprint used to reject a stale manifest for this asset. */
  input_hash?: string
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
