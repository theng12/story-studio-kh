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

import { GenStudioApiError, GenStudioTerminalFailureError, hasFullyReleasedZeroSettlement } from './genstudio-client.js'
import { FREE_MAC_WAIT_REASON, isFreeFleetModelId } from '../contracts/provider-task-state.js'

/** Codes GenStudio uses when no machine could take the job. */
export const FLEET_BUSY_FAILURE_CODES: ReadonlySet<string> = new Set([
  'SITE_PLACEMENT_EXHAUSTED',
  'SITE_CAPACITY_UNAVAILABLE',
])

/**
 * On FREE fleet work (`studio-hub::…`), every way the Gateway says "no Mac took it": busy, not
 * ready, unreachable, or a submit that timed out (filed as SITE_CAPACITY_UNAVAILABLE with an unknown
 * outcome). Owner, 2026-10-03: "if it's waiting, it should be waiting, not failed." A second request
 * for free work can never cost anything, and the Gateway keeps the first result that lands, so the
 * unknown-outcome lock that protects paid work does not apply here.
 */
export const FREE_MAC_WAIT_CODES: ReadonlySet<string> = new Set([
  ...FLEET_BUSY_FAILURE_CODES,
  'LOCATION_NOT_READY',
  'LOCATION_UNREACHABLE',
  'MACHINE_BUSY',
])

function isFreeMacWait(error: GenStudioTerminalFailureError): boolean {
  return isFreeFleetModelId(error.modelId)
    && FREE_MAC_WAIT_CODES.has(String(error.failureCode || ''))
    && !(typeof error.settledCredits === 'number' && error.settledCredits > 0)
}

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
  // The Gateway can also refuse at SUBMIT time — HTTP 503 SITE_CAPACITY_UNAVAILABLE, "No
  // location offering this model can take work right now — 1 location offline" — before any
  // job exists, so nothing can have been made or charged. Seen when the one Mac that holds a
  // cloned voice restarted for an update: the episode's eight remaining chapters were each
  // refused and dropped within a minute (Dreamlands E2E, 2026-10-03). Wait like a busy fleet.
  if (error instanceof GenStudioApiError) {
    return error.status === 503 && FLEET_BUSY_FAILURE_CODES.has(String(error.code || ''))
  }
  if (!(error instanceof GenStudioTerminalFailureError)) return false
  if (modality !== undefined && error.modality !== modality) return false
  // Cancellation is the owner's instruction; retrying it would overrule him.
  if (error.cancelled) return false
  if (isFreeMacWait(error)) return true
  // The gateway files an ambiguous read-timeout submit under the same code. It may have started
  // real work, so it is not "never reached a machine" and must not be resubmitted.
  if (error.unknownOutcome) return false
  if (!FLEET_BUSY_FAILURE_CODES.has(String(error.failureCode || ''))) return false
  return hasFullyReleasedZeroSettlement(error)
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

/**
 * Free fleet work keeps waiting after the ladder, every five minutes, for as long as the Gateway
 * itself keeps free work queued (its three-hour queue ceiling). Paid work stays bounded above.
 */
export const FREE_MAC_WAIT_MAX_RETRIES = 3 + 35

export interface FleetBusyRetryPlan {
  waitMs: number
  /** Item reason shown on the job card. */
  reason: string
  /** 1-based attempt ceiling for the job card's "attempt N of M". */
  maxAttempts: number
  /** True for the owner's free fleet: no credit talk, no failure while a Mac may still free up. */
  free: boolean
}

/**
 * The one busy-fleet decision every generator uses: wait how long, and say what.
 * @param retriesUsed busy-fleet retries already granted for this item (0 for the first).
 */
export function fleetBusyRetryPlan(error: unknown, modality: string, retriesUsed: number): FleetBusyRetryPlan | null {
  if (!isFleetBusyFailure(error, modality)) return null
  const free = error instanceof GenStudioTerminalFailureError ? isFreeFleetModelId(error.modelId) : false
  const ceiling = free ? FREE_MAC_WAIT_MAX_RETRIES : FLEET_BUSY_RETRY_DELAYS_MS.length
  if (retriesUsed < 0 || retriesUsed >= ceiling) return null
  const waitMs = FLEET_BUSY_RETRY_DELAYS_MS[Math.min(retriesUsed, FLEET_BUSY_RETRY_DELAYS_MS.length - 1)]!
  // Paid work keeps the capacity-neutral wording (see WAITING_FALLBACK_REASON on the job card).
  return { waitMs, reason: free ? FREE_MAC_WAIT_REASON : 'High demand right now', maxAttempts: ceiling + 1, free }
}

/**
 * Why no Mac took it, in the owner's words — for the job log line that announces the wait.
 * Never a code, never credits.
 */
export function freeMacWaitCause(error: unknown): string {
  const code = String((error as { failureCode?: unknown; code?: unknown })?.failureCode
    ?? (error as { code?: unknown })?.code ?? '')
  const reason = String((error as { failureReason?: unknown })?.failureReason ?? '')
  if (/didn't answer in time|timed? ?out/i.test(reason)) return 'the Mac didn\'t answer in time'
  if (code === 'LOCATION_UNREACHABLE') return 'the Mac could not be reached'
  if (code === 'LOCATION_NOT_READY') return 'no Mac is ready for this model right now'
  return 'every Mac that can do this is busy or offline'
}

/** "Chapter 11: the Mac didn't answer in time — will try another Mac in 30s." */
export function freeMacWaitLine(label: string, error: unknown, waitMs: number): string {
  return `${label}: ${freeMacWaitCause(error)} — will try another Mac in ${formatWait(waitMs)}.`
}

function formatWait(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)} min`
}

/**
 * v1.4.35 — sleep for `ms`, but stop early when `stop()` says to.
 *
 * WHY THIS IS SHARED. Five generators now wait minutes for a busy fleet, and
 * the waits are the longest single stretch in the app where the owner is
 * holding a button that has to work. Written per-generator it drifted
 * immediately: three had a 2-second-sliced copy that honoured Cancel AND
 * Pause, subtitles.ts had a bare `setTimeout` that honoured neither and slept
 * out the full five minutes, and images.ts passed an AbortController that was
 * only ever aborted on Cancel. Same wait, three different answers to "does
 * Pause work".
 *
 * `stop` is a predicate rather than an AbortSignal on purpose. Pause is polled
 * state on the job queue, not an event, and the generator that tried to model
 * it as a signal is exactly the one that got it wrong.
 *
 * Returns rather than throws: the caller knows whether a stop means "fail this
 * item as it fails today" or "raise JobPausedError", and that differs by
 * generator. Deciding it here would flatten the distinction.
 */
export async function waitUnlessStopped(
  ms: number,
  stop: () => boolean,
  sliceMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (stop()) return
    await new Promise(resolve => setTimeout(resolve, Math.min(sliceMs, deadline - Date.now())))
  }
}

/** A wait for the owner's free fleet — its log line says why in plain words and never mentions credits. */
export function isFreeMacPlan(plan: object | null | undefined): boolean {
  return !!plan && (plan as { free?: unknown }).free === true
}
