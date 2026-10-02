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
    hint: 'Asks the gateway about jobs already sent, saves anything that finished, and settles the dead ones. Never starts new work or charges.',
  }
}

export interface RedoCounts {
  /** Failed jobs Retry may start again now. */
  redo: number
  /** Failed jobs held back until a check proves nothing is still running. */
  waitingForCheck: number
  /** Failed jobs whose files were all found by a check — nothing to redo. */
  alreadyComplete: number
}

export function redoFailedJobsAction(counts: RedoCounts, busy: { self: boolean; other: boolean; progress?: string }): PrimaryAction {
  if (busy.self) return { label: busy.progress || 'Redoing…', disabled: true, hint: 'Starting the failed jobs again.' }
  const label = `Redo failed jobs (${counts.redo})`
  if (busy.other) return { label, disabled: true, hint: 'Wait for the action that is running to finish.' }
  const waiting = counts.waitingForCheck
    ? ` ${counts.waitingForCheck} more wait${counts.waitingForCheck === 1 ? 's' : ''} for "Check on running jobs" first.`
    : ''
  if (!counts.redo) {
    if (counts.waitingForCheck) {
      return { label, disabled: true, hint: `${counts.waitingForCheck} failed job${counts.waitingForCheck === 1 ? '' : 's'} may still be finishing — click "Check on running jobs" first.` }
    }
    if (counts.alreadyComplete) return { label, disabled: true, hint: 'Nothing to redo — the check found every file. Clear failed removes the rows.' }
    return { label, disabled: true, hint: 'Nothing failed.' }
  }
  return {
    label, disabled: false,
    hint: `Starts each failed job again with a fresh request. Never resubmits work a provider may still be finishing, so paid work is not charged twice.${waiting}`,
  }
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
