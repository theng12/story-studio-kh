/**
 * Lightweight formatters for transfer-progress UI. Decimal (1000-based)
 * units are used everywhere — that matches what users see in YouTube Studio,
 * Google Drive, and macOS Finder, so 5 MB here means the same 5 MB they'll
 * see post-upload.
 *
 * All formatters tolerate `undefined`/`null` and return an em dash so the
 * caller can render them unconditionally (no v-if guards needed).
 */

export function formatBytes(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n < 1) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  // Whole-number bytes don't need a decimal; everything ≥100 in its unit
  // also reads cleaner without the .X.
  const dp = i === 0 ? 0 : v >= 100 ? 0 : 1
  return `${v.toFixed(dp)} ${units[i]}`
}

export function formatSpeed(bps?: number | null): string {
  if (bps == null || !Number.isFinite(bps) || bps <= 0) return '—'
  return `${formatBytes(bps)}/s`
}

export function formatDuration(sec?: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—'
  const s = Math.round(sec)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`
  const h = Math.floor(m / 60)
  const mr = m % 60
  return mr ? `${h}h ${mr}m` : `${h}h`
}

/** Convenience composable form — Nuxt auto-imports both the named exports
 *  above and `useFormat()` below. Returning the function bag lets callers
 *  use `const { formatBytes } = useFormat()` when they prefer that style. */
export function useFormat() {
  return { formatBytes, formatSpeed, formatDuration }
}
