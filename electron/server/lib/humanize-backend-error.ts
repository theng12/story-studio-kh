/**
 * Humanize raw Node / provider errors before they hit the toast layer.
 *
 * Routes used to do `res.status(500).json({ detail: e.message })` which
 * surfaced strings like "spawn ENOENT" or
 * "EACCES: permission denied, open '/path/to/file'" to the operator —
 * accurate for engineers, useless for the user.
 *
 * This helper recognizes the common failure shapes (filesystem errors,
 * spawn errors, network errors, FFmpeg issues) and rewrites them into a
 * single sentence the user can act on, optionally with a follow-up
 * `hint` line. The original raw message is logged via `logger.ts` so
 * `userData/logs/server-*.log` still carries the engineer-readable trace
 * for support cases.
 *
 * Routes call it like:
 *   res.status(500).json(humanizeBackendError(e, 'Voice preview failed'))
 *
 * The fallback string is shown verbatim if the error has no message and
 * no recognizable code — picks up the per-route context the old `||`
 * fallback used to provide.
 */

import type { Response } from 'express'
import { logLine } from '../services/logger.js'

export interface HumanizedError {
  detail: string
  hint?: string
  /**
   * Stable string the frontend can match on instead of regex-parsing
   * `detail`. Set when the thrown error has both an `expose: true`
   * marker (matching the JsonCorruptError pattern) and a string `code`
   * field — typical of domain-defined errors like NARRATION_MISSING.
   * Plain Node errnos (ENOENT, EACCES…) are NOT forwarded here; those
   * get folded into a friendlier message above.
   */
  code?: string
}

/**
 * Convenience: write a humanized error to an Express response, picking
 * the right status code from `e.statusCode` (set by services that throw
 * domain-tagged errors) or defaulting to 500. Replaces the boilerplate
 *
 *   const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
 *   res.status(status).json(humanizeBackendError(e, fallback))
 *
 * which got copy-pasted a lot. Keeps the error → response mapping in
 * one place so future tweaks (e.g. adding a request-id, scrubbing
 * paths) only need one edit.
 */
export function respondWithError(res: Response, e: unknown, fallback?: string): void {
  const status = typeof (e as any)?.statusCode === 'number' ? (e as any).statusCode : 500
  res.status(status).json(humanizeBackendError(e, fallback))
}

/**
 * Try to extract a Node-style errno code from a thrown value.
 * Covers both classic `err.code === 'ENOENT'` and message-embedded codes
 * like "spawn ENOENT" coming from child_process.
 */
function extractCode(e: any): string | null {
  if (!e) return null
  if (typeof e.code === 'string' && e.code.length) return e.code
  const msg = typeof e.message === 'string' ? e.message : String(e || '')
  // Common forms: "spawn ENOENT", "ENOENT: no such file …", "EACCES:".
  const m = msg.match(/\b(ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|EBUSY|ENOSPC|EMFILE|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH)\b/)
  return m ? m[1] : null
}

/** Try to extract a path mentioned in the error message. */
function extractPath(e: any): string | null {
  if (!e) return null
  if (typeof e.path === 'string' && e.path.length) return e.path
  const msg = typeof e.message === 'string' ? e.message : String(e || '')
  // Node's fs errors look like: "ENOENT: no such file or directory, open '/path'"
  const quoted = msg.match(/'([^']+)'/)
  if (quoted) return quoted[1]
  return null
}

/** Try to extract the syscall (open/spawn/stat/…) for finer hints. */
function extractSyscall(e: any): string | null {
  if (!e) return null
  if (typeof e.syscall === 'string' && e.syscall.length) return e.syscall
  const msg = typeof e.message === 'string' ? e.message : String(e || '')
  if (/^spawn\s+/i.test(msg)) return 'spawn'
  return null
}

export function humanizeBackendError(e: unknown, fallback?: string): HumanizedError {
  // Always log the raw error so support can still grep for the literal
  // string the operator pasted in. This stays one-to-one with the old
  // behaviour where `e.message` flowed straight to the response.
  const rawMessage = (e as any)?.message ?? String(e ?? '')
  try {
    logLine('error', 'Backend error surfaced to user', {
      raw: rawMessage,
      code: (e as any)?.code,
      path: (e as any)?.path,
      syscall: (e as any)?.syscall,
      stack: (e as any)?.stack,
    })
  } catch { /* logger must never throw out of an error path */ }

  const code = extractCode(e)
  const syscall = extractSyscall(e)
  const path = extractPath(e)

  // ── Spawn errors (child_process) ─────────────────────────────────────
  // Most commonly bubbles up as "spawn ENOENT" when the bundled FFmpeg
  // binary is missing or its path is wrong.
  if (syscall === 'spawn' && code === 'ENOENT') {
    return {
      detail: 'A required binary (likely FFmpeg) is missing or not executable.',
      hint: 'Re-check Settings → FFmpeg, or reinstall the app to restore the bundled binary.',
    }
  }
  if (syscall === 'spawn' && code === 'EACCES') {
    return {
      detail: 'A required binary exists but is not executable.',
      hint: 'Open Settings → FFmpeg and re-validate the path; on macOS run `chmod +x` on the binary.',
    }
  }

  // ── Filesystem errors ────────────────────────────────────────────────
  if (code === 'ENOENT') {
    return {
      detail: path
        ? `File not found at ${path}.`
        : 'A required file was not found.',
      hint: 'The asset may have been deleted or moved. Re-scan the project or pick the file again.',
    }
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return {
      detail: path
        ? `Permission denied accessing ${path}.`
        : 'Permission denied while accessing a file.',
      hint: 'Check file ownership or sharing — the project folder may be on a read-only volume or owned by another user.',
    }
  }
  if (code === 'EISDIR') {
    return { detail: path ? `Expected a file but ${path} is a directory.` : 'Expected a file but found a directory.' }
  }
  if (code === 'ENOTDIR') {
    return { detail: path ? `Expected a directory but ${path} is a file.` : 'Expected a directory but found a file.' }
  }
  if (code === 'EBUSY') {
    return {
      detail: path ? `${path} is in use by another process.` : 'A file is in use by another process.',
      hint: 'Close any other app that may have it open and try again.',
    }
  }
  if (code === 'ENOSPC') {
    return {
      detail: 'Out of disk space.',
      hint: 'Free up storage on the volume where projects live and try again.',
    }
  }
  if (code === 'EMFILE') {
    return {
      detail: 'Too many files open at once.',
      hint: 'Wait for in-flight jobs to finish, then retry.',
    }
  }

  // ── Network errors (provider calls, fetch) ───────────────────────────
  if (code === 'ECONNREFUSED') {
    return { detail: 'Connection refused by the remote service.', hint: 'Check your internet connection or try again shortly.' }
  }
  if (code === 'ECONNRESET') {
    return { detail: 'The connection to the remote service was reset.', hint: 'Try again — this is usually transient.' }
  }
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return { detail: 'Could not reach the remote service.', hint: 'Check your internet connection and try again.' }
  }
  if (code === 'ENOTFOUND') {
    return { detail: 'The remote service host could not be resolved.', hint: 'Check your internet connection or DNS settings.' }
  }

  // ── Provider / FFmpeg patterns surfaced by message text ──────────────
  if (/FFmpeg not found|ffmpeg.*not.*installed/i.test(rawMessage)) {
    return { detail: 'FFmpeg is required but not found.', hint: 'Install or locate it via Settings → FFmpeg.' }
  }
  if (/libass/i.test(rawMessage) && /lacks|missing|not built/i.test(rawMessage)) {
    return { detail: 'This FFmpeg build does not include libass — subtitles cannot be rendered.', hint: 'Install an FFmpeg build with libass enabled.' }
  }

  // ── Default: prefer the raw error message; fallback is for the
  //    truly-empty case (error with no .message). The previous order
  //    (fallback first) silently masked actionable detail like
  //    "Destination already exists with content: …" behind the route's
  //    generic banner ("Asset migration failed"), forcing the user to
  //    open the log file to diagnose anything. We log the raw message
  //    via logLine above either way, but the front-line UX should also
  //    carry the signal.
  const exposed = (e as any)?.expose === true && typeof (e as any)?.code === 'string'
    ? { code: (e as any).code as string }
    : {}
  if (rawMessage) return { detail: rawMessage, ...exposed }
  if (fallback) return { detail: fallback, ...exposed }
  return { detail: 'Something went wrong. Please try again.', ...exposed }
}
