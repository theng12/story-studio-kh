/**
 * Daily digest formatter (v1.0.62+).
 *
 * Turns a DigestData rollup into a NotificationPayload (title + body)
 * that both desktop notifications and Telegram messages can consume.
 * The same body string works for both — desktop renders multi-line
 * plain text fine; Telegram's HTML parse mode is handled at the
 * dispatch layer (telegram-notifier.formatTelegramText escapes the
 * body before assembly).
 *
 * Design choices:
 *   - One short paragraph per project, even when there are many. Long
 *     digests are skimmed, not read; trimmed lines beat exhaustive ones.
 *   - "Going live today" is highlighted at the top of each project's
 *     section because it's the most actionable info.
 *   - "Chill until X" framing for the next-scheduled gap is the
 *     gratifying part. Nudges only kick in when the queue is genuinely
 *     thin (≤ 2 future-scheduled).
 */

import type { DigestData, ProjectDigest } from './digest-builder.js'
import type { NotificationPayload } from './job-notifier.js'

function formatTimeOfDay(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function formatDateOnly(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * Produce one project's section as a multi-line string. Returns an
 * empty string when the project has nothing scheduled, nothing ready,
 * AND nothing uploaded — those projects are "dormant" and don't earn
 * a section in the daily digest.
 */
function renderProjectSection(p: ProjectDigest): string {
  // Skip dormant projects (zero of everything). Avoids cluttering the
  // digest with channels the user is no longer producing for.
  const hasAnyActivity = p.going_live_today.length > 0
    || p.total_scheduled_future > 0
    || p.total_not_uploaded > 0
    || p.total_uploaded > 0
  if (!hasAnyActivity) return ''

  const lines: string[] = [`📺 ${p.name}`]

  // Today's launches — most actionable, lead with it.
  if (p.going_live_today.length > 0) {
    const items = p.going_live_today
      .map(e => `${e.episode_code} at ${formatTimeOfDay(e.scheduled_for)}`)
      .join(', ')
    lines.push(`  · 🚀 Going live today: ${items}`)
  }

  // Forward-looking queue summary. "Chill until …" is the gratifying
  // framing — tells you when you can take a breath.
  if (p.total_scheduled_future > 0) {
    const parts: string[] = [`${p.total_scheduled_future} scheduled`]
    if (p.next_scheduled) parts.push(`next ${formatDateOnly(p.next_scheduled.scheduled_for)}`)
    if (p.last_scheduled && p.last_scheduled.episode_code !== p.next_scheduled?.episode_code) {
      parts.push(`last ${formatDateOnly(p.last_scheduled.scheduled_for)}`)
    }
    lines.push(`  · 📅 ${parts.join(' · ')}`)
    if (p.last_scheduled) {
      lines.push(`  · 🏖 Queue runs through ${formatDateOnly(p.last_scheduled.scheduled_for)} — chill until then`)
    }
  }

  // Backlog cue — only worth surfacing when there's work to do.
  if (p.total_not_uploaded > 0) {
    lines.push(`  · 📦 ${p.total_not_uploaded} accepted episode(s) not yet uploaded`)
  }

  // Nudge: queue thin / empty — useful prod prompt.
  if (p.total_scheduled_future <= 2) {
    lines.push(`  · ⚠️ Queue is thin (${p.total_scheduled_future} scheduled) — time to make more videos`)
  }

  return lines.join('\n')
}

export function formatDigestMessage(data: DigestData): NotificationPayload {
  const sections: string[] = []
  for (const p of data.projects) {
    const s = renderProjectSection(p)
    if (s) sections.push(s)
  }

  // Top-line summary across all projects. When everything is dormant,
  // we still emit a polite "all quiet" message rather than nothing.
  const totalsLine = sections.length === 0
    ? `Nothing scheduled across your projects. Time to plan the next batch.`
    : `📊 Across all projects: ${data.totals.going_live_today} going live today · ${data.totals.scheduled_future} scheduled · ${data.totals.not_uploaded} not uploaded`

  const body = sections.length > 0
    ? `${sections.join('\n\n')}\n\n${totalsLine}`
    : totalsLine

  return {
    title: `Daily digest — ${data.local_today_label}`,
    body,
  }
}
