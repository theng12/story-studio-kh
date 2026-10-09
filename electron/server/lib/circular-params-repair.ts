/**
 * Before 1.4.266 the job redactor saved every SECOND reference to a shared object as the string
 * '[CIRCULAR]' (see redactSensitiveValue). A Pipeline's `pacing` / `motion_scope` objects were
 * shared by the first job and every `pipeline_chain[].params`, so jobs.json holds the marker where
 * those settings belong, and a job resumed from disk handed it down the chain until Scene Plan
 * failed with "pacing must be an object".
 *
 * Each marked field (top-level params and each chain link's params) is restored from, in order:
 *   1. the job's own params (its top-level copy was written first and survived);
 *   2. the same episode's other jobs of the same Pipeline batch / episode recovery (its parents);
 *   3. any job of the same Pipeline batch;
 * and otherwise the field is dropped, so the generator reads the project's saved setting itself.
 */
export const CIRCULAR_MARKER = '[CIRCULAR]'

export interface RepairableJob {
  job_id: string
  project_slug?: string
  episode_id?: string
  params?: Record<string, unknown>
}

type Bag = Record<string, unknown>

function paramBags(job: RepairableJob): Bag[] {
  const params = job.params
  if (!params || typeof params !== 'object') return []
  const bags = [params]
  if (Array.isArray(params.pipeline_chain)) {
    for (const link of params.pipeline_chain as Array<{ params?: unknown } | null>) {
      if (link?.params && typeof link.params === 'object') bags.push(link.params as Bag)
    }
  }
  return bags
}

function intactValue(job: RepairableJob, key: string): unknown {
  for (const bag of paramBags(job)) {
    const value = bag[key]
    if (value !== undefined && value !== CIRCULAR_MARKER) return value
  }
  return undefined
}

/** Repairs `targets` in place; `pool` is every job that may hold the intact value. Returns repaired job ids. */
export function repairCircularParams(
  targets: RepairableJob[],
  pool: RepairableJob[] = targets,
  log: (line: string) => void = line => console.warn(line),
): Set<string> {
  const repaired = new Set<string>()
  for (const job of targets) {
    const bags = paramBags(job)
    const keys = new Set(bags.flatMap(bag => Object.keys(bag).filter(key => bag[key] === CIRCULAR_MARKER)))
    if (!keys.size) continue
    const batch = job.params?.pipeline_batch_id
    const recovery = job.params?.episode_recovery_id
    const sameProject = (other: RepairableJob) => other !== job && other.project_slug === job.project_slug
    const sameRun = (other: RepairableJob) => sameProject(other)
      && ((!!batch && other.params?.pipeline_batch_id === batch) || (!!recovery && other.params?.episode_recovery_id === recovery))
    const sources: Array<[string, (other: RepairableJob) => boolean]> = [
      ['parent job', other => sameRun(other) && other.episode_id === job.episode_id],
      ['same Pipeline batch', other => sameProject(other) && !!batch && other.params?.pipeline_batch_id === batch],
    ]
    const notes: string[] = []
    for (const key of keys) {
      let value = intactValue(job, key)
      let from = 'own params'
      for (const [label, matches] of sources) {
        if (value !== undefined) break
        const donor = pool.find(other => matches(other) && intactValue(other, key) !== undefined)
        if (donor) { value = intactValue(donor, key); from = `${label} ${donor.job_id}` }
      }
      for (const bag of bags) {
        if (bag[key] !== CIRCULAR_MARKER) continue
        if (value === undefined) delete bag[key]
        else bag[key] = structuredClone(value)
      }
      notes.push(`${key} ← ${value === undefined ? 'dropped (project saved setting applies)' : from}`)
    }
    repaired.add(job.job_id)
    log(`[job-queue] repaired '[CIRCULAR]' params on job ${job.job_id} (${job.episode_id ?? '-'}): ${notes.join(', ')}`)
  }
  return repaired
}
