/**
 * The Launcher's hold credential (contract: _orchestra/youtube-stack/update-hold/CONTRACT.md).
 *
 * The hold pauses dispatch, and it answers on a fixed loopback port, so before this gate any process
 * on the Mac could pause Story's queue — and a shim that branches on status alone read a refusal as
 * permission. The Launcher mints a 0600 64-hex token on first use at
 * `~/Library/KHUpdater/state/hold-token` and sends it on every hold request as `X-Hub-Token` (and as
 * a bearer). Read it fresh per request: a rotated token is never cached.
 *
 * A missing, wrong or unreadable token is a 401 and nothing is paused — refusing a hold must never
 * stall Story, so the app keeps taking work and one plain log line says why it cannot be held.
 */

import { lstat, readFile } from 'fs/promises'
import { timingSafeEqual } from 'crypto'
import os from 'os'
import path from 'path'
import type express from 'express'

export function holdTokenFile(): string {
  const override = process.env.KHU_HOLD_TOKEN_FILE?.trim()
  return override || path.join(os.homedir(), 'Library', 'KHUpdater', 'state', 'hold-token')
}

export const HOLD_METHODS_DETAIL =
  'update hold answers POST (hold) and DELETE (resume) only; this request did nothing'

function presentedToken(req: express.Request): string | null {
  const header = req.headers['x-hub-token']
  if (typeof header === 'string' && header.trim()) return header.trim()
  const auth = req.headers.authorization
  if (typeof auth === 'string' && /^Bearer /i.test(auth)) return auth.slice(7).trim() || null
  return null
}

// One line per distinct reason, not per request: a holder that polls must not flood the log, and a
// silent refusal is indistinguishable from a working hold.
const logged = new Set<string>()

export type HoldRefusal = { status: number, body: { detail: string } }

export async function holdRefusal(req: express.Request): Promise<HoldRefusal | null> {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return { status: 405, body: { detail: HOLD_METHODS_DETAIL } }
  }
  const file = holdTokenFile()
  const refuse = (why: string): HoldRefusal => {
    const detail = `update blocked: hold token ${why}. Nothing was paused; Story keeps taking work.`
    if (!logged.has(detail)) {
      logged.add(detail)
      console.warn(`[update-hold] ${detail}`)
    }
    return { status: 401, body: { detail } }
  }

  // A web page on this Mac can reach loopback too (DNS rebinding); the Launcher's native request
  // carries neither header, so a browser-shaped request is refused before the token is even read.
  if (req.headers.origin || req.headers.cookie) {
    return refuse(`requests must come from the Launcher, not a browser (${file})`)
  }

  let expected: string
  try {
    const info = await lstat(file)
    if (!info.isFile()) return refuse(`is not a private regular file at ${file}`)
    if (info.uid !== os.userInfo().uid) return refuse(`is owned by another user at ${file}`)
    if ((info.mode & 0o077) !== 0) {
      return refuse(`is not private (mode ${(info.mode & 0o777).toString(8)}) at ${file}`)
    }
    if (info.size > 257) return refuse(`is too long at ${file}`)
    expected = (await readFile(file, 'utf8')).trim()
  } catch {
    return refuse(`missing at ${file}`)
  }
  if (!/^[0-9a-fA-F]{64}$/.test(expected)) return refuse(`unreadable at ${file}`)

  const offered = presentedToken(req)
  if (!offered) return refuse(`was not sent by this request (expected the Launcher's 64-hex token for ${file})`)
  const a = Buffer.from(offered)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return refuse(`does not match the Launcher's token at ${file}`)
  return null
}

// Any other method on the hold path answers 405 instead of falling through to a bare 404: a route
// that exists must say what it does.
export function maintenanceHoldOtherMethod(_req: express.Request, res: express.Response) {
  res.status(405).json({ detail: HOLD_METHODS_DETAIL })
}
