/**
 * Small shared helpers for generators: cancellable sleep, transport-failure
 * detection, and a non-empty file check.
 */

/**
 * Sleep in short steps so a user-cancelled job doesn't block for minutes
 * between retries. If `isCancelled` flips to true mid-sleep, we throw
 * immediately so the caller unwinds.
 */
export async function sleepCancellable(ms: number, isCancelled?: () => boolean): Promise<void> {
  if (ms <= 0) return
  const step = 200
  for (let t = 0; t < ms; t += step) {
    if (isCancelled?.()) throw new Error('Cancelled by user')
    await new Promise(r => setTimeout(r, Math.min(step, ms - t)))
  }
}

/**
 * Transport signatures: the connection failed, so the REQUEST was never
 * answered. Undici reports almost all of these as a bare `TypeError: fetch
 * failed` and hides the real cause one level down, which is why the cause
 * chain is walked rather than only the top-level message.
 */
const TRANSPORT_FAILURE_PATTERN =
  /\bfetch failed\b|\bECONNRESET\b|\bECONNREFUSED\b|\bETIMEDOUT\b|\bEPIPE\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bEHOSTUNREACH\b|\bENETUNREACH\b|\bENETDOWN\b|socket hang up|network socket disconnected|other side closed|\bUND_ERR_[A-Z_]+\b/i

/** A user cancel travels as an abort and must never be mistaken for a network drop. */
const CANCELLATION_PATTERN = /cancell?ed|abort/i

/**
 * Did this fail because the network dropped, rather than because the service
 * answered?
 *
 * WHY THE DISTINCTION EARNS ITS KEEP. A generator retries a failed item only
 * when the failure PROVES no provider did any work — otherwise a retry pays
 * twice for the same asset. That rule was written against GenStudio's settled
 * failure codes, so every check begins `error instanceof
 * GenStudioTerminalFailureError`. A dropped connection is not one, so it fell
 * through as "a provider may already have been paid" and the item was
 * abandoned on its FIRST attempt, with `fetch failed` shown verbatim.
 *
 * That is backwards. A transport failure is the case where retrying is most
 * clearly safe: every submission carries an idempotency key, and a replayed
 * key returns the job GenStudio already has instead of selling a second one.
 * The caller must replay the SAME identity for that to hold — see the audio
 * generator, which keeps its identity and its reclaim entry on this class of
 * failure and derives a fresh one on every other.
 *
 * Deliberately signature-based rather than `instanceof`: these arrive as bare
 * `TypeError`s from undici with no type to test. Matching a settled GenStudio
 * failure here would be the one dangerous mistake this can make, so note that
 * those carry their own messages (an HTTP status, a failure code) and match
 * none of these patterns.
 */
export function isTransportFailure(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    if (typeof current !== 'object') break
    const candidate = current as { message?: unknown; code?: unknown; cause?: unknown; name?: unknown }
    const text = [candidate.message, candidate.code, candidate.name]
      .filter(value => typeof value === 'string').join(' ')
    // A cancel can carry a transport-shaped cause once the socket is torn
    // down. The owner asked for it to stop; retrying would overrule him.
    if (CANCELLATION_PATTERN.test(text)) return false
    if (TRANSPORT_FAILURE_PATTERN.test(text)) return true
    current = candidate.cause
  }
  return false
}

/** Non-zero-size `existsSync` replacement — a 0-byte file is NOT a cache hit. */
export async function fileExistsWithContent(filePath: string): Promise<boolean> {
  const fs = await import('fs/promises')
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}
