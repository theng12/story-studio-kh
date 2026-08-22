/**
 * "Every machine was busy" — the one GenStudio failure that is free to retry.
 *
 * WHY THIS IS SHARED AND NOT A DETAIL OF ONE GENERATOR (v1.4.25).
 *
 * The owner ran thirty episodes of transcription and 122 of 353 came back
 * `SITE_PLACEMENT_EXHAUSTED`, each dropped with "re-run to fill it in". 1.4.24
 * taught `subtitles.ts` to wait and ask again. His next question was the right
 * one:
 *
 *   "i don't know what about the other generators and it's possible bugs that
 *    i don't get the chance to test yet."
 *
 * He was right to ask. Eight generators handle GenStudio terminal failures and
 * exactly one knew about a busy fleet. It is not hypothetical either: VOICE_TTS
 * hit the same code five times on 13-15 August and nobody noticed, because the
 * only symptom is a missing section that a later manual retry quietly fills in.
 *
 * So the rule lives here, once, and `genstudio-fleet-busy.test.ts` keeps a
 * register of which generators have adopted it.
 *
 * ── Why retrying this is free, and nothing else is ──
 *
 * GenStudio raises the code from one place, having waited a fifteen-minute
 * placement window, and states there what happened to the money:
 *
 *   "The job never reached a worker, so there is nothing to settle: the
 *    reservation is returned whole."   — images/service.py, then billing.release()
 *
 * No provider was engaged and the credits came back, so a resubmission is a
 * fresh charge for work that never happened. That is the whole argument, and it
 * does not extend to any other failure: a provider that WAS engaged may have
 * done the work, and resubmitting over it is the double-charge every retry path
 * in this codebase is built to avoid. A "Repair & Retry all" button was removed
 * in v1.0.114 for exactly that reason.
 */

import { GenStudioTerminalFailureError } from './genstudio-client.js'

/** Codes GenStudio uses when no machine could take the job. */
export const FLEET_BUSY_FAILURE_CODES: ReadonlySet<string> = new Set([
  'SITE_PLACEMENT_EXHAUSTED',
  'SITE_CAPACITY_UNAVAILABLE',
])

/**
 * Was this refused for want of a free machine, with the money given back?
 *
 * BOTH conditions are required. A capacity code arriving with credits settled
 * would mean the guarantee above had stopped holding, and the response to an
 * assumption you can no longer verify is to stop, not to resubmit.
 *
 * @param modality when given, the failure must belong to it — a busy fleet on
 *   a TTS job is not licence for an image generator to resubmit.
 */
export function isFleetBusyFailure(error: unknown, modality?: string): boolean {
  if (!(error instanceof GenStudioTerminalFailureError)) return false
  if (modality !== undefined && error.modality !== modality) return false
  // Cancellation is the owner's instruction; retrying it would overrule him.
  if (error.cancelled) return false
  if (!FLEET_BUSY_FAILURE_CODES.has(String(error.failureCode || ''))) return false
  if (typeof error.settledCredits === 'number' && error.settledCredits > 0) return false
  return true
}

/**
 * How long to wait before asking again, per attempt.
 *
 * Minutes, not milliseconds. GenStudio already waits a FIFTEEN-MINUTE placement
 * window before declaring this, so anything reaching here means the fleet is
 * genuinely saturated; a two-second retry rejoins the same jam and burns an
 * attempt. Bounded under ten minutes total so no item is silently unreported
 * for longer than that.
 */
export const FLEET_BUSY_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 300_000]
