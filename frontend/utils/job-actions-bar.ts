/**
 * The two main buttons of the Jobs page's action bar (owner, 2026-10-03):
 * "I don't know which one is for what. All I need is 2 main ones: (1) recheck
 * the old jobs that are still generating, (2) redo it all over again. Others
 * are supplementary and I want proper hints."
 *
 * Pure so the wording, counts and disabled reasons are tested without
 * mounting the 4,000-line page.
 */

export interface PrimaryAction {
  label: string
  disabled: boolean
  /** One plain line under the button: what it does, what it never does, or why it is off. */
  hint: string
}

export interface CheckCounts {
  /** Finished jobs whose provider work GenStudio has not yet confirmed as settled. */
  unsettled: number
  /** Failed jobs with recorded provider requests that can be re-asked (Repair). */
  repairable: number
  /** Episodes whose audio/images can be re-checked and downloaded (Recover). */
  episodes: number
  /** Jobs running right now — watched automatically, never part of the count. */
  running: number
}

export function checkRunningJobsAction(counts: CheckCounts, busy: { self: boolean; other: boolean }): PrimaryAction {
  const total = counts.unsettled + counts.repairable + counts.episodes
  if (busy.self) return { label: 'Checking…', disabled: true, hint: 'Asking the gateway about each job and collecting finished results.' }
  const label = `Check on running jobs (${total})`
  if (busy.other) return { label, disabled: true, hint: 'Wait for the action that is running to finish.' }
  if (!total) {
    return {
      label, disabled: true,
      hint: counts.running
        ? `Nothing to check — the ${counts.running} running job${counts.running === 1 ? ' is' : 's are'} watched automatically.`
        : 'Nothing to check — no failed or unfinished jobs here.',
    }
  }
  return {
    label, disabled: false,
    hint: 'Asks the Gateway about jobs already sent, saves anything that finished, and settles failed jobs whose files now exist. Never generates anything new or charges.',
  }
}

export interface RedoCounts {
  /** Failed jobs Retry may start again now. */
  redo: number
  /** Failed jobs held back that "Check on running jobs" has not looked at yet. */
  waitingForCheck: number
  /** Held back because the Gateway says their work is still running. */
  stillRunning?: number
  /** Held back because the last check could not get an answer for them. */
  couldNotCheck?: number
  /** Failed jobs whose files were all found by a check — nothing to redo. */
  alreadyComplete: number
}

export function redoFailedJobsAction(counts: RedoCounts, busy: { self: boolean; other: boolean; progress?: string }): PrimaryAction {
  if (busy.self) return { label: busy.progress || 'Redoing…', disabled: true, hint: 'Starting the failed jobs again.' }
  const label = `Redo failed jobs (${counts.redo})`
  if (busy.other) return { label, disabled: true, hint: 'Wait for the action that is running to finish.' }
  // Each held-back job gets its own real reason. A job the check already
  // looked at is never told to wait for the check again (Dreamlands loop).
  const running = counts.stillRunning || 0
  const unchecked = counts.couldNotCheck || 0
  const held = [
    running ? `${running} ${running === 1 ? 'is' : 'are'} still running on the Macs — Redo waits for ${running === 1 ? 'it' : 'them'} so nothing is paid twice.` : '',
    unchecked ? `${unchecked} could not be checked — open ${unchecked === 1 ? 'it' : 'them'} to see why, or check again later.` : '',
  ].filter(Boolean).join(' ')
  const waiting = counts.waitingForCheck
    ? `${counts.waitingForCheck} more wait${counts.waitingForCheck === 1 ? 's' : ''} for "Check on running jobs" first.`
    : ''
  if (!counts.redo) {
    if (counts.waitingForCheck) {
      return { label, disabled: true, hint: [`${counts.waitingForCheck} failed job${counts.waitingForCheck === 1 ? '' : 's'} may still be finishing — click "Check on running jobs" first.`, held].filter(Boolean).join(' ') }
    }
    if (held) return { label, disabled: true, hint: held }
    if (counts.alreadyComplete) return { label, disabled: true, hint: 'Nothing to redo — the check found every file. Clear failed removes the rows.' }
    return { label, disabled: true, hint: 'Nothing failed.' }
  }
  return {
    label, disabled: false,
    hint: ['Starts each failed job again with a fresh request. Never resubmits work a provider may still be finishing, so paid work is not charged twice.', waiting, held].filter(Boolean).join(' '),
  }
}

/** Why a held-back failed job is held back. `lookedAt` = the last check asked about it. */
export type HoldReason = 'waiting-for-check' | 'still-running' | 'could-not-check'

export function providerHoldReason(state: string | undefined, lookedAt: boolean): HoldReason {
  if (state === 'unsettled') return 'still-running'
  if (state === 'unreachable' || lookedAt) return 'could-not-check'
  return 'waiting-for-check'
}

/** What one check found about one job, read after the check has finished. */
export type CheckOutcome = 'finished' | 'still-running' | 'could-not-check' | 'needs-redo'

export interface CheckedJobFacts {
  /** `jobDisplayStatus` after the check ('done', 'recovered', 'error', …). */
  displayStatus: string
  /** Set while the job still waits on the Gateway: its HoldReason. */
  hold?: HoldReason
  /** The repair record for a repairable job, if one exists. */
  repair?: { outcome: 'measured'; result: { stillMissing: number } } | { outcome: 'inconclusive' | 'failed' }
  /** The job has a repair path, so no record means its repair did not answer. */
  repairable?: boolean
}

export function classifyCheckedJob(job: CheckedJobFacts): CheckOutcome {
  if (job.hold === 'still-running') return 'still-running'
  if (job.hold) return 'could-not-check'
  if (job.displayStatus === 'done' || job.displayStatus === 'recovered') return 'finished'
  if (job.repair?.outcome === 'measured') return job.repair.result.stillMissing === 0 ? 'finished' : 'needs-redo'
  if (job.repair || job.repairable) return 'could-not-check'
  return 'needs-redo'
}

/** The one plain line a check ends with, e.g. "Checked 5: 2 finished and saved, 1 still running, 2 need Redo." */
export function describeCheckResult(outcomes: readonly CheckOutcome[], recoveryJobsStarted = 0): string {
  const n = (outcome: CheckOutcome) => outcomes.filter(o => o === outcome).length
  const parts = [
    n('finished') ? `${n('finished')} finished and saved` : '',
    n('still-running') ? `${n('still-running')} still running` : '',
    n('could-not-check') ? `${n('could-not-check')} could not be checked` : '',
    n('needs-redo') ? `${n('needs-redo')} need${n('needs-redo') === 1 ? 's' : ''} Redo` : '',
  ].filter(Boolean)
  const started = recoveryJobsStarted
    ? ` Started ${recoveryJobsStarted} free image recovery job${recoveryJobsStarted === 1 ? '' : 's'} (downloads only, no charge).`
    : ''
  if (!outcomes.length) return `Checked: nothing needed a look.${started}`
  return `Checked ${outcomes.length}: ${parts.join(', ')}.${started}`
}

/** The quieter second row: one plain line per button, always visible. */
export const MORE_ACTION_HINTS = {
  // The owner "just clicks them randomly": the hints say WHAT each one looks at.
  recover: 'Per episode: looks for that episode’s missing narration and images and downloads any the Macs already finished. Never generates or charges.',
  repair: 'Per failed job: asks the gateway about that job’s own recorded requests and downloads any that finished late. Never generates or charges.',
  queue: 'Holds new work in every project. Work already sent keeps going.',
  resume: 'Continues paused jobs from where they stopped.',
  clearFinished: 'Removes finished rows from this list. Keeps files and billing records.',
  clearFailed: 'Removes failed rows whose provider work has settled. Keeps files and billing records.',
} as const
