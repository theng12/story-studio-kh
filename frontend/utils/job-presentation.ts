export interface JobControlLike {
  action: string
  enabled: boolean
}

export interface JobFilterLike {
  type?: string
  status?: string
  project_slug?: string
  params?: { pipeline_batch_id?: unknown }
}

export interface CapacitySnapshotLike {
  capacity_verified?: boolean
  limitSource?: string
  refreshed_at?: string | null
}

const LIVE_CAPACITY_MAX_AGE_MS = 30_000

export function primaryControl<T extends JobControlLike>(controls: readonly T[]): T | null {
  return controls.find(control => control.action !== 'force-abandon') || controls[0] || null
}

export function secondaryControls<T extends JobControlLike>(controls: readonly T[]): T[] {
  const primary = primaryControl(controls)
  return controls.filter(control => control !== primary)
}

export function filterJobsForView<T extends JobFilterLike>(
  jobs: readonly T[],
  filters: { type: string; status: string; project: string; batch: string | null },
): T[] {
  return jobs.filter(job => {
    if (filters.project !== 'all' && job.project_slug !== filters.project) return false
    if (filters.type !== 'all' && job.type !== filters.type) return false
    if (filters.status !== 'all' && job.status !== filters.status) return false
    if (filters.batch && job.params?.pipeline_batch_id !== filters.batch) return false
    return true
  })
}

export function isVerifiedLiveCapacity(snapshot: CapacitySnapshotLike | null | undefined, nowMs: number): boolean {
  if (snapshot?.capacity_verified !== true || snapshot.limitSource !== 'account-overview' || !snapshot.refreshed_at) return false
  const refreshedAt = Date.parse(snapshot.refreshed_at)
  if (!Number.isFinite(refreshedAt)) return false
  const age = nowMs - refreshedAt
  return age >= -5_000 && age <= LIVE_CAPACITY_MAX_AGE_MS
}

/** Remove request identities only from presentation; the source job evidence is untouched. */
export function customerSafeJobText(value: unknown, exactIds: readonly string[] = []): string {
  let text = String(value || '')
  for (const id of [...new Set(exactIds.filter(id => id.length >= 6))].sort((a, b) => b.length - a.length)) {
    text = text.split(id).join('[request hidden]')
  }
  return text
    .replace(/\b((?:provider[ _-]?)?(?:job|task|request)[ _-]?id)\s*[:=#]\s*[A-Za-z0-9._:-]{6,}/gi, '$1: hidden')
    .replace(/\b((?:story\s+)?(?:job|task|request))\s+(?=[A-Za-z0-9._:-]{6,}\b)(?=[A-Za-z0-9._:-]*\d)(?=[A-Za-z0-9._:-]*[_.:-])[A-Za-z0-9._:-]+\b/gi, '$1 [request hidden]')
}
