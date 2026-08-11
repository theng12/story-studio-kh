import fs from 'fs/promises'
import path from 'path'

const TERMINAL = new Set(['done', 'error', 'cancelled'])
const SETTLED_PROVIDER = new Set(['succeeded', 'failed', 'cancelled'])
const PENDING_CANCELLATION = new Set(['queued', 'submitting', 'requested', 'reconciling', 'unknown'])

/**
 * Project visibility/deletion must not sever the only local record of paid
 * work. This intentionally reads jobs.json directly: it remains available
 * after a project was hidden or unlinked and never starts a queue worker.
 */
export async function assertProjectJobsSafeToRemove(projectDir: string): Promise<void> {
  let records: unknown[]
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(projectDir, 'jobs.json'), 'utf8'))
    records = Array.isArray(parsed?.jobs) ? parsed.jobs : []
  } catch (error: any) {
    if (error?.code === 'ENOENT') return
    const failure: any = new Error('Project job history cannot be read safely. Resolve it before removing this project.')
    failure.statusCode = 409
    throw failure
  }

  const blocked = records.find((value: any) => {
    if (!value || typeof value !== 'object') return true
    if (!TERMINAL.has(value.status)) return true
    if (Object.values(value.remote_cancellations || {}).some((record: any) => PENDING_CANCELLATION.has(record?.status))) return true
    return Array.isArray(value.genstudio_jobs) && value.genstudio_jobs.some((entry: any) => (
      entry?.cancelled !== true && !SETTLED_PROVIDER.has(entry?.state)
    ))
  }) as any
  if (!blocked) return
  const failure: any = new Error(`Project has active or unsettled provider job ${typeof blocked.job_id === 'string' ? blocked.job_id : 'evidence'}. Return later until Story Studio confirms final settlement.`)
  failure.statusCode = 409
  throw failure
}
