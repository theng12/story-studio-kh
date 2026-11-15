/**
 * Continuation ownership for a standalone image repair (1.4.402, EP0018/HMH0107).
 *
 * A failed pipeline step keeps the steps that depended on it in its own `pipeline_chain`; a
 * standalone repair job (Scene Review's missing-images render) is created with no chain at all.
 * When that repair finishes the images, nothing drains the failed parent's saved Final Video step —
 * the exact EP0018 row shape: repair `2476fd2e` chain=[] / done / 231 images, parent `0cb6378e`
 * status=error / local_execution_complete / chain=[video_assembly] / no handoff marker.
 *
 * The repair CHILD adopts that saved continuation once. The failed parent stays a historical row:
 * it is never edited, retried or re-queued by this path, and nothing is copied except the chain and
 * its batch id. If an assembly already exists for the episode, or a chain was already adopted from
 * the same parent, nothing is adopted and the caller says why.
 */
import type { Job } from '../models/types.js'

export interface RepairContinuation {
  chain: unknown[]
  batchId: string | null
  fromJobId: string
}

/** The newest failed job whose saved chain starts with Final Video, when no assembly exists yet. */
export function repairContinuationFrom(
  jobs: readonly Job[],
  episodeId: string,
  options: { assemblyExists: boolean },
): RepairContinuation | null {
  if (options.assemblyExists) return null
  const adoptedFrom = new Set(
    jobs
      .map(job => job.params?.pipeline_chain_adopted_from)
      .filter((value): value is string => typeof value === 'string'),
  )
  const candidate = jobs
    .filter(job => job.episode_id === episodeId)
    .filter(job => job.status === 'error' && job.local_execution_complete === true)
    .filter(job => Array.isArray(job.params?.pipeline_chain) && job.params.pipeline_chain.length > 0)
    .filter(job => (job.params.pipeline_chain as Array<{ type?: unknown }>)[0]?.type === 'video_assembly')
    .filter(job => !adoptedFrom.has(job.job_id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]
  if (!candidate) return null
  const batchId = typeof candidate.params?.pipeline_batch_id === 'string'
    ? candidate.params.pipeline_batch_id
    : null
  return {
    chain: structuredClone(candidate.params.pipeline_chain as unknown[]),
    batchId,
    fromJobId: candidate.job_id,
  }
}

/** A finished assembly (queued, running or done) means the episode already owns this step. */
export function assemblyAlreadyExists(jobs: readonly Job[], episodeId: string): boolean {
  return jobs.some(job => job.episode_id === episodeId
    && job.type === 'video_assembly'
    && ['queued', 'running', 'done'].includes(job.status))
}
