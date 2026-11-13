/**
 * Gateway submissions that have been sent and not yet answered (1.4.265). The answer carries the
 * task id that makes a request recoverable after a restart. Counted where the POST is physically sent.
 */
let inFlight = 0

export function inFlightSubmits(): number { return inFlight }

/** Call when the POST is physically sent; call the returned function once its answer is read (or it failed). */
export function submitSent(): () => void {
  inFlight++
  let done = false
  return () => {
    if (!done) inFlight--
    done = true
  }
}
