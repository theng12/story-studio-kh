/**
 * upload-format.ts — compact display formatters shared by the Upload Center
 * page and its extracted tab components.
 *
 * v1.0.341 — lifted verbatim out of upload.vue (where they were inline) so the
 * tab components split out of that 8.3k-line page can reuse them without
 * duplication. Distinct from ~/composables/useFormat.ts (formatBytes /
 * formatDuration / formatDurationPrecise) — these are the count/minutes/
 * timecode/relative-time helpers the YouTube tabs need.
 */

export function formatNumber(n: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 10_000) return (n / 1_000).toFixed(0) + 'K'
  return n.toLocaleString()
}

export function formatMinutes(m: number): string {
  if (m < 60) return `${Math.round(m)}m`
  const h = Math.floor(m / 60)
  const rem = Math.round(m - h * 60)
  return `${h}h ${rem}m`
}

/**
 * Compact mm:ss timecode for tabular / chip-density displays where the
 * named-units format ("5m 23s") is too wide. (Named `formatTimecode` rather
 * than `formatDuration` so it doesn't shadow the helper of that name in
 * ~/composables/useFormat.ts.)
 */
export function formatTimecode(secs: number): string {
  if (!secs) return '0:00'
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs - m * 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm ago'
  if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + 'h ago'
  return Math.floor(ms / 86_400_000) + 'd ago'
}
