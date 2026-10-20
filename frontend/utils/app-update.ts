/** Words for a staged update (Settings → About → Updates, and the banner). Updates install promptly (1.4.265). */

const jobs = (n: number) => `${n} job${n === 1 ? '' : 's'}`

export const PROMPT_INSTALL_TEXT = "Installs as soon as it's ready (work resumes after the restart)"

/** Free up space is a media cleanup; the read-only file review is what it is. */
const maintenanceName = (kind: string): string => kind === 'preview' ? 'file review' : 'media cleanup'

/**
 * The ready line: about to install, held by the owner's own queue pause, or waiting for a storage
 * operation. The last is NOT a queue pause — the queue keeps running through it (2026-10-19/20: a
 * staged release waited ~9 h on an all-channel Free Up Space run with production stopped).
 */
export function readyText(version: string, queuePaused: boolean, maintenance?: { kind: string } | null): string {
  if (queuePaused) return `Update ${version} ready. You paused the queue, so it waits for you: resume the queue, or press Install Now.`
  if (maintenance) {
    return `Update ${version} ready. It waits for the ${maintenanceName(maintenance.kind)} to finish before installing;`
      + ' the queue keeps running.'
  }
  return `Update ${version} ready. ${PROMPT_INSTALL_TEXT}.`
}

/** While a prompt install waits: what for (requests already sent, jobs that could not resume, a storage operation). */
export function waitingText(
  version: string,
  waitingFor?: {
    submits: number
    jobs: string[]
    /** Final checks still measuring a finished video: local ffmpeg work a restart would kill. */
    finalChecks?: number
    maintenance?: { kind: string; status: string } | null
  } | null,
): string {
  const parts: string[] = []
  const submits = waitingFor?.submits ?? 0
  const left = waitingFor?.jobs ?? []
  if (submits) parts.push(`${submits} request${submits === 1 ? '' : 's'} already sent to the Gateway to be answered`)
  if (left.length) {
    const kinds = [...new Set(left.map(type => type.replace(/_/g, ' ')))].join(', ')
    parts.push(`${jobs(left.length)} that cannot pick up where ${left.length === 1 ? 'it' : 'they'} stopped (${kinds})`)
  }
  const checks = waitingFor?.finalChecks ?? 0
  if (checks) {
    // Also not a queue job: the on-demand check runs in the background and takes minutes, and a
    // restart would lose the whole measurement rather than resume it.
    parts.push(`${checks} final check${checks === 1 ? '' : 's'} still measuring a finished video`)
  }
  const maintenance = waitingFor?.maintenance
  if (maintenance) {
    // Not a queue job: it is Free up space or Clear Uploaded Videos, and a restart kills it mid-file.
    parts.push(`the ${maintenanceName(maintenance.kind)} to finish (it cannot pick up where it stopped)`)
  }
  return `Installing Story Studio ${version}: new work is paused${parts.length ? `; waiting for ${parts.join(' and ')}` : ''}. Everything else resumes after the restart.`
}

/** Install Now; asked only when the queue holds jobs, worded like Quit's question. Null = install without asking. */
export function installNowQuestion(version: string, jobsLeft: number): { title: string; message: string } | null {
  if (!(jobsLeft > 0)) return null
  return {
    title: `${jobs(jobsLeft)} ${jobsLeft === 1 ? 'is' : 'are'} in the queue; ${jobsLeft === 1 ? 'it' : 'they'}'ll continue after the update.`,
    message: `Install Now pauses new work, waits for requests already sent to the Gateway and for jobs that cannot pick up where they stopped (up to 30 minutes), installs ${version} and restarts. Work resumes after the restart; anything that cannot shows Retry in Jobs.`,
  }
}

/** "Install now (don't wait)": offered while a release is downloading, ready or waiting on the drain. */
export const INSTALL_IMMEDIATELY_LABEL = "Install now (don't wait)"
export const canInstallImmediately = (phase: string | undefined): boolean => ['downloading', 'ready', 'draining'].includes(phase || '')

export function installImmediatelyQuestion(version: string): { title: string; message: string } {
  return {
    title: INSTALL_IMMEDIATELY_LABEL,
    message: `Running jobs are stopped now and pick up again after the restart (paid work that cannot resume waits for Retry). Install Story Studio ${version} now?`,
  }
}
