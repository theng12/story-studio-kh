import type { Job } from '../models/types.js'

/**
 * Cheap fingerprint for the fields that can change while a job is running.
 * The queue uses it to avoid broadcasting identical full job payloads when a
 * generator is waiting on a provider and has no new progress to show.
 */
export function jobStreamSignature(job: Job): string {
  const lines = job.output_lines || []
  return JSON.stringify([
    job.progress ?? null,
    job.bytes_done ?? null,
    job.bytes_total ?? null,
    job.speed_bps ?? null,
    job.eta_seconds ?? null,
    lines.length,
    lines.at(-1) || '',
    job.accounts_used || null,
    job.output_dir || '',
    // Included so a run that is waiting — the same section, the same
    // percentage, no new log line — still pushes the fact that it moved from
    // "running" to "waiting for the provider until 12:04:31". Without it the
    // one transition that distinguishes pacing from a hang is the one the
    // stream would swallow.
    job.item_progress || null,
  ])
}
