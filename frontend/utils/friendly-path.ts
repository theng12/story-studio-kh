/**
 * A short, readable version of a folder path for display next to a control.
 *
 *   /Users/theng/Documents/Story Studio KH/kh-boundless/episodes
 *     → ~/Documents/…/kh-boundless/episodes
 *
 * Display only: the full path is always kept for saving and shown on hover.
 * The home folder becomes `~`; when the result is still longer than `max`
 * characters, middle folders collapse into a single `…` so the start (which
 * drive / which top folder) and the end (the folder's own name) stay visible.
 */
export function friendlyPath(fullPath: string | null | undefined, max = 48): string {
  const raw = String(fullPath ?? '').trim()
  if (!raw) return ''
  const path = raw.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~').replace(/\/+$/, '') || '/'
  if (path.length <= max) return path

  const parts = path.split('/')
  // Head: `~/Documents`, `/Volumes/Drive` — the part that says where it lives.
  const headCount = parts[0] === '' ? 3 : 2
  const head = parts.slice(0, headCount)
  const rest = parts.slice(headCount)
  if (rest.length <= 1) return middleEllipsis(path, max)

  const tail: string[] = [rest[rest.length - 1]]
  for (let i = rest.length - 2; i >= 0; i -= 1) {
    const candidate = [...head, '…', rest[i], ...tail].join('/')
    if (candidate.length > max) break
    tail.unshift(rest[i])
  }
  const joined = tail.length === rest.length ? path : [...head, '…', ...tail].join('/')
  return joined.length <= max ? joined : middleEllipsis(joined, max)
}

/** `abcdefghij` → `abc…hij`, keeping both ends of a single long name. */
function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text
  const keep = Math.max(2, max - 1)
  const front = Math.ceil(keep / 2)
  return `${text.slice(0, front)}…${text.slice(text.length - (keep - front))}`
}
