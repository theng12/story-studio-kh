/**
 * Daily digest scheduler (v1.0.62+).
 *
 * Single 60-second tick that checks the user's configured fire time
 * against the local clock. If we cross into the fire minute and we
 * haven't already fired today, build + dispatch the digest. Cheap by
 * design — no cron lib, no persistent timers, no waking the machine.
 *
 * Caveats:
 *   - App must be running for the digest to fire. Sleep stories are a
 *     home-server-style workflow, so the user keeps Story Studio open
 *     on the Mac mini overnight; this is fine.
 *   - Last-fired tracking lives in app-settings.json so a quick app
 *     restart inside the fire window doesn't double-send.
 *   - Manual "Send now" doesn't update last_fired_date — it's an
 *     out-of-band test that mustn't suppress the regular fire.
 */

import { getNotifierSettings, setNotifierSettings } from './job-notifier.js'
import { buildDigest } from './digest-builder.js'
import { formatDigestMessage } from './digest-formatter.js'
import type { NotificationPayload } from './job-notifier.js'

export interface DigestDispatcher {
  /** Sends a single payload to whichever channels are enabled for the
   *  digest (desktop and/or telegram). Wired by main.ts so this
   *  module stays side-effect-free at import time. */
  (payload: NotificationPayload, opts: { desktop: boolean; telegram: boolean }): Promise<void>
}

let timerHandle: ReturnType<typeof setInterval> | null = null
let dispatcherRef: DigestDispatcher | null = null

/** Local YYYY-MM-DD, mirroring digest-builder's helper. */
function localYmd(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Is the current local time at or just past the configured fire time
 *  for today? Returns true once per minute the wall clock matches.
 *  Intentionally lenient (>= rather than ==) so a tick that lands a
 *  hair late still fires. */
function isFireWindow(now: Date, timeLocal: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(timeLocal)
  if (!m) return false
  const targetH = Math.max(0, Math.min(23, parseInt(m[1]!, 10)))
  const targetMin = Math.max(0, Math.min(59, parseInt(m[2]!, 10)))
  const targetTotal = targetH * 60 + targetMin
  const nowTotal = now.getHours() * 60 + now.getMinutes()
  // Fire only inside a 5-minute window after the target — a wider
  // window risks firing the next day if the app was off through the
  // morning and woken at noon. last_fired_date guard catches the
  // dedupe within that window.
  return nowTotal >= targetTotal && nowTotal < targetTotal + 5
}

/**
 * Send the digest now, regardless of time/last-fired guards. Called
 * by the manual "Send digest now" button. Doesn't update
 * last_fired_date (so the regular schedule still fires today).
 */
export async function sendDigestNow(): Promise<{ ok: boolean; reason?: string; payload?: NotificationPayload }> {
  if (!dispatcherRef) return { ok: false, reason: 'Dispatcher not registered yet — restart the app and try again.' }
  const settings = await getNotifierSettings()
  const cfg = settings.digest
  if (!cfg) return { ok: false, reason: 'Digest config missing.' }
  // Manual sends always dispatch via desktop + telegram per saved
  // routing — even if the digest itself is "disabled" overall, a
  // test fire still goes out so the user can preview.
  const desktop = cfg.desktop_enabled && settings.enabled
  const telegram = cfg.telegram_enabled
    && !!(settings.telegram?.enabled && settings.telegram.bot_token && settings.telegram.chat_id)
  if (!desktop && !telegram) {
    return { ok: false, reason: 'No channel enabled for the digest. Tick desktop or Telegram routing in Settings.' }
  }
  const data = await buildDigest()
  const payload = formatDigestMessage(data)
  await dispatcherRef(payload, { desktop, telegram })
  return { ok: true, payload }
}

/**
 * Mounted by main.ts at boot. Stores the dispatcher reference and
 * starts the 60-second tick. Calling twice is safe — the second call
 * replaces the dispatcher and resets the tick.
 */
export function startDigestScheduler(dispatcher: DigestDispatcher): void {
  dispatcherRef = dispatcher
  if (timerHandle) clearInterval(timerHandle)
  timerHandle = setInterval(() => { void tick() }, 60_000)
  // Fire one tick immediately so a fresh boot can catch up if we're
  // already inside the fire window.
  void tick()
}

async function tick(): Promise<void> {
  if (!dispatcherRef) return
  let settings
  try { settings = await getNotifierSettings() } catch { return }
  const cfg = settings.digest
  if (!cfg || !cfg.enabled) return

  const now = new Date()
  if (!isFireWindow(now, cfg.time_local)) return

  const today = localYmd(now)
  if (cfg.last_fired_date === today) return  // already fired today

  // Determine target channels using the same routing the manual
  // "Send now" path uses.
  const desktop = cfg.desktop_enabled && settings.enabled
  const telegram = cfg.telegram_enabled
    && !!(settings.telegram?.enabled && settings.telegram.bot_token && settings.telegram.chat_id)
  if (!desktop && !telegram) return

  let data
  try {
    data = await buildDigest()
  } catch (e) {
    // Don't bump last_fired_date on failure — give the next minute's
    // tick a chance to retry. Logged at the dispatcher layer.
    console.error('[digest-scheduler] build failed:', e)
    return
  }

  // v1.0.367 — quiet-when-empty: on days with nothing going live, skip the
  // send but still mark today fired so we don't re-check every minute. Manual
  // "Send now" bypasses this (it doesn't run through tick).
  if (cfg.quiet_when_empty && data.totals.going_live_today === 0) {
    await setNotifierSettings({ digest: { ...cfg, last_fired_date: today } as any }).catch(() => {})
    return
  }

  const payload: NotificationPayload = formatDigestMessage(data)
  try {
    await dispatcherRef(payload, { desktop, telegram })
    await setNotifierSettings({ digest: { ...cfg, last_fired_date: today } as any })
  } catch (e) {
    console.error('[digest-scheduler] dispatch failed:', e)
  }
}
