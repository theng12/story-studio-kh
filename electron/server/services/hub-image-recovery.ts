/**
 * Durable identity for Story Studio image batches accepted by Studio Hub.
 *
 * The checkpoint is written before POST /jobs and updated with the batch id
 * immediately after acceptance.  If Story Studio crashes in either window,
 * the same clientRequestId is replayed (Hub idempotency) or the accepted batch
 * is polled directly.  A terminal partial batch is never reused for fresh
 * work: the next normal attempt receives a new id and only the generator's
 * authoritative missing target list is submitted.
 */

import { createHash, randomUUID } from 'crypto'
import type { Job } from '../models/types.js'
import { checkpointJobState } from './job-queue.js'
import type { HubBatchStatus } from '../lib/studiohub-client.js'

export const HUB_IMAGE_RECOVERY_PARAM = 'hub_image_recovery'

export type HubImageRecoveryState = 'prepared' | 'accepted' | 'terminal' | 'complete'

export interface HubImageRecoveryCheckpoint {
  version: 1
  logical_id: string
  root_id: string
  attempt: number
  client_request_id: string
  request_hash: string
  target_ids: string[]
  hub_url: string
  batch_id?: string
  state: HubImageRecoveryState
  created_at: string
  updated_at: string
  accepted_at?: string
  terminal_at?: string
  completed_at?: string
  terminal_error_count?: number
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => typeof item !== 'function' && item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)]),
    )
  }
  return value
}

export function hubImageRequestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')
}

function parseCheckpoint(value: unknown): HubImageRecoveryCheckpoint | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<HubImageRecoveryCheckpoint>
  if (item.version !== 1 || typeof item.logical_id !== 'string') return null
  if (typeof item.client_request_id !== 'string' || typeof item.request_hash !== 'string') return null
  if (!Array.isArray(item.target_ids) || !item.target_ids.every(id => typeof id === 'string')) return null
  if (!['prepared', 'accepted', 'terminal', 'complete'].includes(String(item.state))) return null
  return item as HubImageRecoveryCheckpoint
}

export function getHubImageRecovery(job: Pick<Job, 'params'>): HubImageRecoveryCheckpoint | null {
  return parseCheckpoint((job.params as Record<string, unknown> | undefined)?.[HUB_IMAGE_RECOVERY_PARAM])
}

/** A checkpoint that can still be reattached. Terminal batches are included
 * for Repair-only runs, which may re-download successful artifacts but must
 * never submit replacement work. */
export function getReconnectableHubImageRecovery(
  job: Pick<Job, 'params'>,
  logicalId?: string,
): HubImageRecoveryCheckpoint | null {
  const checkpoint = getHubImageRecovery(job)
  if (!checkpoint || checkpoint.state === 'complete') return null
  if (logicalId && checkpoint.logical_id !== logicalId) return null
  return checkpoint
}

export async function prepareHubImageRecovery(
  job: Job,
  input: {
    logicalId: string
    targetIds: string[]
    hubUrl: string
    requestIdentity: unknown
    repairOnly?: boolean
  },
): Promise<HubImageRecoveryCheckpoint> {
  const existing = getHubImageRecovery(job)
  const requestHash = hubImageRequestHash(input.requestIdentity)

  if (input.repairOnly) {
    if (!existing?.batch_id || existing.logical_id !== input.logicalId) {
      throw new Error('Repair cannot find an accepted Studio Hub image batch. Use Retry; its saved idempotency key will safely replay an uncertain submission.')
    }
    return existing
  }

  // Prepared means POST may have reached the Hub before Story Studio lost the
  // response. Reuse only when the exact body identity still matches. Accepted
  // batches are addressed by batch_id and do not need the request rebuilt.
  if (existing?.logical_id === input.logicalId && (existing.state === 'prepared' || existing.state === 'accepted')) {
    if (existing.batch_id || existing.request_hash === requestHash) return existing
    throw new Error(
      'The saved Studio Hub submission is ambiguous and its image inputs changed. ' +
      'Story Studio stopped instead of risking duplicate work. Restore the original prompts/settings or dismiss this job and start a deliberate fresh render.',
    )
  }

  const now = new Date().toISOString()
  const rootId = existing?.root_id || randomUUID()
  const attempt = existing?.logical_id === input.logicalId ? existing.attempt + 1 : 1
  const suffix = hubImageRequestHash({ rootId, logicalId: input.logicalId, attempt }).slice(0, 24)
  const checkpoint: HubImageRecoveryCheckpoint = {
    version: 1,
    logical_id: input.logicalId,
    root_id: rootId,
    attempt,
    client_request_id: `storystudio-image-${suffix}`,
    request_hash: requestHash,
    target_ids: [...input.targetIds],
    hub_url: input.hubUrl,
    state: 'prepared',
    created_at: now,
    updated_at: now,
  }
  job.params[HUB_IMAGE_RECOVERY_PARAM] = checkpoint
  await checkpointJobState(job)
  return checkpoint
}

export async function acceptHubImageRecovery(
  job: Job,
  checkpoint: HubImageRecoveryCheckpoint,
  batchId: string,
): Promise<void> {
  const current = getHubImageRecovery(job)
  if (!current || current.client_request_id !== checkpoint.client_request_id) return
  const now = new Date().toISOString()
  current.batch_id = batchId
  current.state = 'accepted'
  current.accepted_at ||= now
  current.updated_at = now
  job.params[HUB_IMAGE_RECOVERY_PARAM] = current
  await checkpointJobState(job)
}

export async function finishHubImageRecoveryPoll(
  job: Job,
  checkpoint: HubImageRecoveryCheckpoint,
  status: HubBatchStatus,
): Promise<void> {
  const current = getHubImageRecovery(job)
  if (!current || current.client_request_id !== checkpoint.client_request_id) return
  const errorCount = status.items.filter(item => item.state === 'error' || item.state === 'cancelled').length
  current.terminal_error_count = errorCount
  current.updated_at = new Date().toISOString()
  if (errorCount > 0 || status.cancelled) {
    current.state = 'terminal'
    current.terminal_at = current.updated_at
  }
  job.params[HUB_IMAGE_RECOVERY_PARAM] = current
  await checkpointJobState(job)
}

export async function completeHubImageRecovery(
  job: Job,
  checkpoint: HubImageRecoveryCheckpoint,
): Promise<void> {
  const current = getHubImageRecovery(job)
  if (!current || current.client_request_id !== checkpoint.client_request_id) return
  const now = new Date().toISOString()
  current.state = 'complete'
  current.completed_at = now
  current.updated_at = now
  current.terminal_error_count = 0
  job.params[HUB_IMAGE_RECOVERY_PARAM] = current
  await checkpointJobState(job)
}

export function isInterruptedHubImageJobRecoverable(job: Pick<Job, 'type' | 'params'>): boolean {
  if (!new Set(['scene_images_batch', 'continuity_render', 'image_pool_generate']).has(job.type)) return false
  const checkpoint = getHubImageRecovery(job)
  return !!checkpoint && (checkpoint.state === 'prepared' || checkpoint.state === 'accepted')
}
