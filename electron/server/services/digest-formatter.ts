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
 *   - One compact section per active project. Long briefs are skimmed,
 *     so direct operational labels beat conversational filler.
 *   - Publishing today is shown first because it is the most time-sensitive.
 *   - Low schedule coverage is called out without decorative emoji or
 *     pressure-heavy language.
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

  const lines: string[] = [p.name]

  // Today's launches — most actionable, lead with it.
  if (p.going_live_today.length > 0) {
    const items = p.going_live_today
      .map(e => `${e.episode_code} at ${formatTimeOfDay(e.scheduled_for)}`)
      .join(', ')
    lines.push(`  Publishing today: ${items}`)
  }

  // Forward-looking schedule summary includes both the next release and
  // coverage horizon without repeating the same date on another line.
  if (p.total_scheduled_future > 0) {
    const parts: string[] = [`${p.total_scheduled_future} future upload(s)`]
    if (p.next_scheduled) parts.push(`next ${formatDateOnly(p.next_scheduled.scheduled_for)}`)
    if (p.last_scheduled) {
      parts.push(`coverage through ${formatDateOnly(p.last_scheduled.scheduled_for)}`)
    }
    lines.push(`  Schedule: ${parts.join(' · ')}`)
  }

  // Backlog cue — only worth surfacing when there's work to do.
  if (p.total_not_uploaded > 0) {
    lines.push(`  Awaiting upload: ${p.total_not_uploaded} accepted episode(s)`)
  }

  // A factual coverage warning is useful without turning the brief into a
  // productivity nudge. Zero is intentionally included.
  if (p.total_scheduled_future <= 2) {
    lines.push(`  Schedule low: ${p.total_scheduled_future} future upload(s) remain`)
  }

  return lines.join('\n')
}

export function formatDigestMessage(data: DigestData): NotificationPayload {
  const sections: string[] = []
  for (const p of data.projects) {
    const s = renderProjectSection(p)
    if (s) sections.push(s)
  }

  // Top-line summary across all projects. When everything is dormant, the
  // message stays neutral and does not manufacture an action item.
  const totalsLine = sections.length === 0
    ? 'Nothing is scheduled across your projects.'
    : `Across all projects: ${data.totals.going_live_today} publishing today · ${data.totals.scheduled_future} scheduled · ${data.totals.not_uploaded} awaiting upload`

  // No reading says so; it never reads as an empty or a healthy disk.
  const diskLine = data.free_disk_bytes === undefined ? ''
    : data.free_disk_bytes === null ? '\nFree disk: could not be read'
      : `\nFree disk: ${(data.free_disk_bytes / 1e9).toFixed(1)} GB`
  const body = (sections.length > 0
    ? `${sections.join('\n\n')}\n\n${totalsLine}`
    : totalsLine) + diskLine

  return {
    title: `Daily production brief — ${data.local_today_label}`,
    body,
  }
}
