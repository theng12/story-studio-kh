/** Production Board selection and the "Hiding N finished episodes" count. */
interface Row { episode_code: string }

/** "Select Shown": add every row the current filters show (all pages) to the selection. */
export function selectShown(selected: ReadonlySet<string>, shown: readonly Row[]): Set<string> {
  return new Set([...selected, ...shown.map(row => row.episode_code)])
}

/** Apply "Needs work only" and say how many finished rows it hid. */
export function hideFinished<T>(rows: readonly T[], hiding: boolean, isDone: (row: T) => boolean): { rows: T[]; hidden: number } {
  if (!hiding) return { rows: [...rows], hidden: 0 }
  const kept = rows.filter(row => !isDone(row))
  return { rows: kept, hidden: rows.length - kept.length }
}

/** Pipeline link that arrives with these episodes already selected. */
export function pipelineLinkFor(slug: string, codes: Iterable<string>): string {
  const list = [...codes].sort()
  return `/projects/${slug}/pipeline${list.length ? `?episodes=${list.map(encodeURIComponent).join(',')}` : ''}`
}

/** Codes from `?episodes=EP0001,EP0002` (repeatable or comma-separated). */
export function episodesFromQuery(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : [raw]
  return [...new Set(values.flatMap(value => typeof value === 'string' ? value.split(',') : [])
    .map(code => code.trim()).filter(Boolean))]
}
