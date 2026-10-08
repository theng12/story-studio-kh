/** Words for a staged update that waits for an empty queue (Settings → About → Updates, and the banner). */

const jobs = (n: number) => `${n} job${n === 1 ? '' : 's'}`

/** "Update 1.4.261 ready — installs when the queue is empty (3 jobs left)", plus why a paused queue keeps it waiting. */
export function waitingForQueueText(version: string, jobsLeft: number, queuePaused: boolean): string {
  const line = `Update ${version} ready — installs when the queue is empty (${jobs(jobsLeft)} left).`
  return queuePaused && jobsLeft > 0
    ? `${line} The queue is paused with jobs still in it, so the update keeps waiting: resume the queue, or press Install Now.`
    : line
}

/** Install Now drains; asked only when the queue holds jobs, worded like Quit's question. Null = install without asking. */
export function installNowQuestion(version: string, jobsLeft: number): { title: string; message: string } | null {
  if (!(jobsLeft > 0)) return null
  return {
    title: `${jobs(jobsLeft)} ${jobsLeft === 1 ? 'is' : 'are'} in the queue; ${jobsLeft === 1 ? 'it' : 'they'}'ll continue after the update.`,
    message: `Install Now pauses the queue, lets running jobs finish (up to 30 minutes), installs ${version} and restarts. Saved work is kept. Anything that cannot pick up where it stopped shows Retry in Jobs.`,
  }
}
