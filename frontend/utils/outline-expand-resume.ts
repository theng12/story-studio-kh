/**
 * Expand on a row (or "Expand selected") while the last writing run is stopped
 * part-way resumes that run first: the server replays it exactly (so nothing is
 * paid twice) and the writer skips every chapter already on disk. This says
 * what will happen to the chapters the owner asked for.
 */
export function resumeExpandNotice(requested: number[], stoppedRunChapters: unknown): string {
  const list = requested.join(', ')
  const covered = !Array.isArray(stoppedRunChapters)
    || requested.every(n => stoppedRunChapters.map(Number).includes(n))
  return covered
    ? `Resuming the stopped writing run — it writes only the chapters still missing, including ${list}.`
    : `Resuming the stopped writing run first — it writes only the chapters still missing. Then press Expand on ${list} again.`
}
