/**
 * HTTP server timeouts, and the last-resort guard that turns a hung request into
 * an answer.
 *
 * ── Why this exists ──
 *
 * The API server had no timeouts of any kind. Every default Node gives you was
 * left in place, which for `server.timeout` means "none": a socket waiting on
 * work that will never finish stayed open for the life of the process, and the
 * page waiting on it spun forever with nothing on screen to say what had
 * happened. That is how a disk stall during a video render presented itself —
 * not as an error anyone could act on, but as an app that had simply stopped.
 *
 * The point of this file is that the failure class becomes LOUD and stays loud,
 * permanently, without anyone having to remember it.
 *
 * ── Why the numbers are what they are ──
 *
 * These are ceilings on genuinely stuck work, NOT a performance budget. Several
 * things this app does legitimately take minutes inside a single request, and
 * cutting one of them off is a worse bug than the one being fixed:
 *
 *   - Image previews go to GenStudio with a documented five-minute per-attempt
 *     ceiling (`GENSTUDIO_ARTIFACT_REQUEST_TIMEOUT_MS`).
 *   - A content-store kit install chains one download per piece, each with its
 *     own sixty-second budget.
 *   - Local ffmpeg previews are deliberately allowed ninety seconds before they
 *     are treated as wedged.
 *   - Language routes call a provider with no ceiling of their own at all.
 *
 * So the wall-clock limit clears all of those with room to spare. Anything under
 * it is somebody's real work; anything over it is not coming back.
 *
 * Every value is a setting the owner can change, because a number chosen today
 * against today's providers is not a law — see `services/app-settings.ts`.
 *
 * ── What the wall-clock guard deliberately does NOT touch ──
 *
 * A response that has already begun. The job-event streams
 * (`/api/**\/jobs/stream` and friends) are open for as long as a dashboard tab
 * is, by design, and the media routes stream video and audio to a player at
 * whatever pace the client reads. Both send their headers immediately, so
 * `res.headersSent` separates "this connection is doing its job" from "this
 * request never started answering" without needing a list of paths to keep in
 * step with the router.
 */

import type { Server } from 'http'
import type { Request, Response, NextFunction } from 'express'
import { getAppSetting, onAppSettingWritten } from '../services/app-settings.js'
import { applyStallWatchSettings, describeRequestHold, runWithWaitScope } from './stall-watch.js'

export const REQUEST_DEADLINE_SECONDS_KEY = 'server_request_deadline_seconds'
/** Ten minutes: clears the five-minute image preview and the four-minute kit
 *  install with margin, and still bounds a request that is never coming back. */
export const REQUEST_DEADLINE_SECONDS_DEFAULT = 600
export const REQUEST_DEADLINE_SECONDS_MIN = 60
export const REQUEST_DEADLINE_SECONDS_MAX = 86_400

export const SOCKET_TIMEOUT_SECONDS_KEY = 'server_socket_timeout_seconds'
/** Fifteen minutes of NO socket activity at all. Above every legitimate quiet
 *  stretch this app has (a provider thinking for five minutes writes nothing to
 *  the socket meanwhile), below "forever". */
export const SOCKET_TIMEOUT_SECONDS_DEFAULT = 900
export const SOCKET_TIMEOUT_SECONDS_MIN = 60
export const SOCKET_TIMEOUT_SECONDS_MAX = 86_400

export const KEEP_ALIVE_SECONDS_KEY = 'server_keep_alive_seconds'
/** How long an IDLE keep-alive connection is held between requests. Nothing is
 *  in flight during this window, so it is safe to keep short. */
export const KEEP_ALIVE_SECONDS_DEFAULT = 65
export const KEEP_ALIVE_SECONDS_MIN = 5
export const KEEP_ALIVE_SECONDS_MAX = 3_600

function clampSeconds(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n < min || n > max) return fallback
  return n
}

/**
 * The deadline, held in memory so the guard costs nothing per request.
 *
 * The request path NEVER reads this from disk — not lazily, not in the
 * background, not once. Reading a setting is a file read, and putting a file
 * read on the path of every request to decide how long a request may take would
 * be a smaller copy of the exact mistake this whole change exists to undo.
 *
 * It is read at boot by `applyServerTimeouts`, and re-read when the owner
 * changes it — an announcement that arrives on a settings write, which is not a
 * request. Until a boot has happened the default stands, which is why tests
 * (which never bind a port) see the default and never touch a settings file
 * through this module.
 */
let cachedDeadlineMs = REQUEST_DEADLINE_SECONDS_DEFAULT * 1_000
let deadlineWired = false

async function loadDeadline(): Promise<number> {
  const seconds = clampSeconds(
    await getAppSetting(REQUEST_DEADLINE_SECONDS_KEY),
    REQUEST_DEADLINE_SECONDS_DEFAULT,
    REQUEST_DEADLINE_SECONDS_MIN,
    REQUEST_DEADLINE_SECONDS_MAX,
  )
  cachedDeadlineMs = seconds * 1_000
  return cachedDeadlineMs
}

/** Current deadline in ms. A plain read of a number; touches nothing. */
export function requestDeadlineMs(): number {
  return cachedDeadlineMs
}

/** Test-only: cross the deadline in milliseconds instead of ten minutes. */
export function _setRequestDeadlineForTests(ms: number | null): void {
  cachedDeadlineMs = ms ?? REQUEST_DEADLINE_SECONDS_DEFAULT * 1_000
}

/**
 * Answer 503 for a request that has produced nothing at all past the deadline.
 *
 * A 503 with a sentence in it is not a fix for whatever is stuck — it is the
 * difference between a user who knows something went wrong and a user watching a
 * spinner. The underlying work is NOT cancelled: this app has no way to unwind a
 * half-finished provider call, and pretending otherwise would be worse than
 * saying nothing. The sentence says the request never got its turn and names
 * what it was held by (see lib/stall-watch.ts) — observed, not diagnosed.
 */
export function requestDeadline() {
  return function requestDeadlineMiddleware(req: Request, res: Response, next: NextFunction): void {
    const limitMs = requestDeadlineMs()
    // The scope records which shared waits THIS request joined, so the 503 can
    // name them; timers created inside it inherit that scope.
    runWithWaitScope(() => {
      const timer = setTimeout(() => {
        // Already answering — a stream, a download, or a response mid-flight. This
        // guard has no business in any of those.
        if (res.headersSent || res.writableEnded) return
        const heldBy = describeRequestHold(req.path)
        res.status(503).json({
          code: 'REQUEST_TIMED_OUT',
          detail: `Story Studio never got its turn to answer this request within ${Math.round(limitMs / 1000)} seconds — the guard stopped waiting. `
            + `It was held by: ${heldBy}. `
            + 'Nothing was charged for a request that never completed. Try again in a moment.',
          path: req.path,
          held_by: heldBy,
        })
      }, limitMs)
      // `.unref()` so a pending guard never holds the process open at shutdown,
      // and cleared on the way out so nothing accumulates per request.
      timer.unref()
      const clear = () => clearTimeout(timer)
      res.on('finish', clear)
      res.on('close', clear)
      next()
    })
  }
}

/**
 * Apply the socket-level ceilings to a live server.
 *
 * `headersTimeout` must exceed `keepAliveTimeout`, or Node races itself and
 * drops connections that were about to send a perfectly good request.
 */
export async function applyServerTimeouts(server: Server): Promise<void> {
  const socketSeconds = clampSeconds(
    await getAppSetting(SOCKET_TIMEOUT_SECONDS_KEY),
    SOCKET_TIMEOUT_SECONDS_DEFAULT,
    SOCKET_TIMEOUT_SECONDS_MIN,
    SOCKET_TIMEOUT_SECONDS_MAX,
  )
  const keepAliveSeconds = clampSeconds(
    await getAppSetting(KEEP_ALIVE_SECONDS_KEY),
    KEEP_ALIVE_SECONDS_DEFAULT,
    KEEP_ALIVE_SECONDS_MIN,
    KEEP_ALIVE_SECONDS_MAX,
  )
  server.timeout = socketSeconds * 1_000
  server.keepAliveTimeout = keepAliveSeconds * 1_000
  server.headersTimeout = (keepAliveSeconds + 5) * 1_000
  // Time allowed to RECEIVE a request, not to answer one — an upload that
  // stalls mid-body is the case this covers. Matched to the socket ceiling so
  // there is one number to reason about rather than two.
  server.requestTimeout = socketSeconds * 1_000

  // Read the owner's deadline once, here, so the first request after boot uses
  // his number rather than the default — and so the request path never has to.
  await loadDeadline().catch(() => { /* the default is a fine answer */ })
  // The stall watcher's threshold is read the same way, at the same boot.
  applyStallWatchSettings()
  // And keep it current without ever reading from a request: a settings write
  // is not a request, so this is the right place to spend the read.
  if (!deadlineWired) {
    deadlineWired = true
    onAppSettingWritten((key) => {
      if (key === REQUEST_DEADLINE_SECONDS_KEY) {
        void loadDeadline().catch(() => { /* keep the last good value */ })
      }
    })
  }
}
