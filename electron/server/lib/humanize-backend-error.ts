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
import { redactSecrets } from './redact-secrets.js'

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
  /** Exact, bounded recovery requirements for a missing Content Pack. */
  requirements?: Array<{
    pack_id: string
    version: string
    item_ids: string[]
    item_kinds: string[]
  }>
}

function exposedContentPackRequirements(e: unknown): HumanizedError['requirements'] {
  if ((e as any)?.expose !== true || (e as any)?.code !== 'content-pack-missing') return undefined
  if (!Array.isArray((e as any)?.requirements)) return undefined
  return (e as any).requirements.slice(0, 64).flatMap((raw: any) => {
    if (!raw || typeof raw.pack_id !== 'string' || typeof raw.version !== 'string') return []
    const itemIds = Array.isArray(raw.item_ids)
      ? raw.item_ids.filter((value: unknown): value is string => typeof value === 'string').slice(0, 256)
      : []
    const itemKinds = Array.isArray(raw.item_kinds)
      ? raw.item_kinds.filter((value: unknown): value is string => typeof value === 'string').slice(0, 16)
      : []
    return [{ pack_id: raw.pack_id, version: raw.version, item_ids: itemIds, item_kinds: itemKinds }]
  })
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
  if (m) return m[1]
  // `AbortSignal.timeout()` rejects with a DOMException named TimeoutError, not an errno.
  if (e.name === 'TimeoutError') return 'ETIMEDOUT'
  // Node's fetch says only "fetch failed" and puts the real reason (ECONNREFUSED …) in `cause`;
  // the client's own wrappers ("… could not be reached after automatic reconnect attempts") nest it
  // once more. Follow the chain, but only for connection reasons — a file error found deep inside a
  // cause must not relabel an unrelated failure.
  const inner = e.cause ? extractCode(e.cause) : null
  return inner && NETWORK_CODES.has(inner) ? inner : null
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'])

/**
 * The plain "could not reach the Gateway" sentence when `e` (or its cause) is a connection failure,
 * else null — for routes that otherwise answer with a generic fallback and would hide the one fact
 * the owner can act on: the Gateway app is not running.
 */
export function gatewayConnectionFailure(e: unknown): HumanizedError | null {
  const code = extractCode(e)
  return code && NETWORK_CODES.has(code) ? networkSentence(code) : null
}

function networkSentence(code: string): HumanizedError {
  // Story Studio talks to one service, the Gateway, so a connection failure is almost always the
  // Gateway being stopped, restarting or busy. Most screens show only `detail`, so it carries the
  // whole sentence and the next step; `hint` repeats where to look.
  if (code === 'ECONNREFUSED') {
    return { detail: 'Could not reach the Gateway — is the Gateway app running?', hint: 'Open the Gateway app (or check its address in Settings → Connections), then try again.' }
  }
  if (code === 'ECONNRESET') {
    return { detail: 'The connection to the Gateway dropped. Try again — this is usually a restart in progress.', hint: 'If it keeps happening, check the Gateway app is running.' }
  }
  if (code === 'ENOTFOUND') {
    return { detail: 'The Gateway address could not be found.', hint: 'Check the Gateway address in Settings → Connections.' }
  }
  return { detail: 'The Gateway did not answer in time — it may be restarting or busy. Try again in a minute.', hint: 'If it keeps happening, check the Gateway app is running and its address in Settings → Connections.' }
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
  const safeMessage = redactSecrets(String(rawMessage || ''))
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

  // ── YouTube OAuth expiry (v1.0.501) ──────────────────────────────────
  // youtube-client's refreshAndPersist throws when Google returns
  // invalid_grant ("Token has been expired or revoked"). EVERY panel on the
  // Upload page (playlists, orphans, sync, statuses, analytics) hits this
  // independently, so a stable machine-matchable `code` lets the frontend
  // collapse the flood into ONE "reconnect the account" banner instead of
  // six identical raw-stack error toasts.
  if (/invalid_grant|Token has been expired or revoked|Token refresh failed/i.test(rawMessage)) {
    return {
      detail: 'YouTube session expired — the account\'s token was expired or revoked by Google.',
      hint: 'Open Upload Center → Accounts, Disconnect the account, then Connect it again. Everything else resumes automatically.',
      code: 'youtube_auth_expired',
    }
  }

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
  if (code && NETWORK_CODES.has(code)) return networkSentence(code)

  // ── Provider / FFmpeg patterns surfaced by message text ──────────────
  if (/FFmpeg not found|ffmpeg.*not.*installed/i.test(rawMessage)) {
    return { detail: 'FFmpeg is required but not found.', hint: 'Install or locate it via Settings → FFmpeg.' }
  }
  if (/libass/i.test(rawMessage) && /lacks|missing|not built/i.test(rawMessage)) {
    return { detail: 'This FFmpeg build does not include libass — subtitles cannot be rendered.', hint: 'Install an FFmpeg build with libass enabled.' }
  }

  // Content Pack trust/runtime failures intentionally carry absolute paths in
  // the support log, but those paths are never renderer-facing API data.
  // Missing-pack recovery is a separate exposed domain error handled below.
  if (/^(?:Content Pack|Invalid content-pack archive:)/i.test(rawMessage)) {
    return { detail: fallback || 'Local Content Pack verification failed.' }
  }

  // ── Default: prefer the raw error message; fallback is for the
  //    truly-empty case (error with no .message). The previous order
  //    (fallback first) silently masked actionable detail like
  //    "Destination already exists with content: …" behind the route's
  //    generic banner ("Asset migration failed"), forcing the user to
  //    open the log file to diagnose anything. We log the raw message
  //    via logLine above either way, but the front-line UX should also
  //    carry the signal.
  const contentPackRequirements = exposedContentPackRequirements(e)
  const exposed = (e as any)?.expose === true && typeof (e as any)?.code === 'string'
    ? {
        code: (e as any).code as string,
        ...(contentPackRequirements ? { requirements: contentPackRequirements } : {}),
      }
    : {}
  if (safeMessage) return { detail: safeMessage, ...exposed }
  if (fallback) return { detail: fallback, ...exposed }
  return { detail: 'Something went wrong. Please try again.', ...exposed }
}
