/**
 * "Has this episode's opening finished, and did it work?" — the pure half.
 *
 * WHY THIS IS ITS OWN MODULE. The Introduction page's preview panel used to
 * fill in only on a manual reload. `generateForEpisode()` ENQUEUES a job and
 * then bumped the preview's refresh key immediately, so the panel re-read the
 * disk at queue time, correctly found nothing, and was never told again. The
 * owner's words: "i can't see the preview even after i click the refresh. it
 * should be automatic without me click the refresh though."
 *
 * The fix is to react to the job stream the dashboard layout already runs. But
 * the decision — which jobs are mine, which just reached a terminal state, and
 * which of those I have already reacted to — is the part that can be wrong,
 * and a .vue SFC cannot be imported by node:test. So the decision lives here
 * as a pure function with no Vue, no fetch, and no clock, and the SFC keeps
 * only the wiring. A grep-only assertion could not tell a key bumped at queue
 * time from a key bumped at completion; this can.
 */

/** The fields of a job this decision actually reads. */
export interface IntroductionJobLike {
  job_id: string
  type?: string
  status?: string
  episode_id?: string
  project_slug?: string
  error?: string
}

export interface IntroductionJobTransition {
  job_id: string
  /** `done` refreshes the preview; `error` says so instead of staying blank. */
  outcome: 'done' | 'error'
  /** Present only for `error` — the provider's reason, or a plain fallback. */
  message?: string
}

export const INTRODUCTION_JOB_TYPE = 'introduction-only'

export const INTRODUCTION_FAILED_FALLBACK =
  'The opening could not be written. Check the job on the Jobs page for the provider\'s reason.'

/** True for a job that belongs to THIS project and THIS episode's opening. */
export function isIntroductionJobFor(
  job: IntroductionJobLike,
  slug: string,
  episodeId: string,
): boolean {
  return job.type === INTRODUCTION_JOB_TYPE
    && !!episodeId
    && job.episode_id === episodeId
    && job.project_slug === slug
}

/**
 * A tiny string that changes ONLY when a relevant job changes state.
 *
 * Watching the jobs array deeply fires on every `output_lines` push from a
 * running job — hundreds of times a second — which is what froze the sidebar
 * once already. Watching this instead fires once per real transition.
 */
export function introductionJobSignal(
  jobs: readonly IntroductionJobLike[],
  slug: string,
  episodeId: string,
): string {
  return jobs
    .filter(job => isIntroductionJobFor(job, slug, episodeId))
    .map(job => `${job.job_id}:${job.status}`)
    .sort()
    .join('|')
}

/**
 * The transitions worth reacting to, exactly once each.
 *
 * `watching` is the caller's memory of jobs it has SEEN unfinished (queued,
 * running or paused); this function adds to it and removes from it. Only a
 * watched job can settle. A job that was already finished when the page first
 * saw it is history, not news: reacting to it replayed old results and old
 * errors every time the page opened or the episode changed. A job yields
 * nothing while unfinished — "not yet" is not an outcome — and nothing again
 * however many times the stream re-emits it.
 */
export function settleIntroductionJobs(
  jobs: readonly IntroductionJobLike[],
  slug: string,
  episodeId: string,
  watching: Set<string>,
): IntroductionJobTransition[] {
  const transitions: IntroductionJobTransition[] = []
  for (const job of jobs) {
    if (!isIntroductionJobFor(job, slug, episodeId)) continue
    if (job.status === 'queued' || job.status === 'running' || job.status === 'paused') {
      watching.add(job.job_id)
      continue
    }
    if (job.status !== 'done' && job.status !== 'error') continue
    if (!watching.delete(job.job_id)) continue
    transitions.push(job.status === 'done'
      ? { job_id: job.job_id, outcome: 'done' }
      : { job_id: job.job_id, outcome: 'error', message: job.error?.trim() || INTRODUCTION_FAILED_FALLBACK })
  }
  return transitions
}

/** True while an opening is queued or being written for the chosen episode. */
export function introductionInFlight(
  jobs: readonly IntroductionJobLike[],
  slug: string,
  episodeId: string,
): boolean {
  return jobs.some(job => isIntroductionJobFor(job, slug, episodeId)
    && (job.status === 'queued' || job.status === 'running'))
}
