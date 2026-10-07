/** "Updated just now" / "Updated 4 min ago" / "Updated 2h 5m ago"; "Not loaded yet" before the first load. */
export function updatedAgoLabel(at: number | string | Date | null | undefined, nowMs: number = Date.now()): string {
  if (at === null || at === undefined || at === '') return 'Not loaded yet'
  const ms = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at)
  if (!Number.isFinite(ms)) return 'Not loaded yet'
  const minutes = Math.floor(Math.max(0, nowMs - ms) / 60_000)
  if (minutes < 1) return 'Updated just now'
  if (minutes < 60) return `Updated ${minutes} min ago`
  return `Updated ${Math.floor(minutes / 60)}h ${minutes % 60}m ago`
}
