/**
 * Pure helpers for the Publish page's bulk actions, kept out of the page so
 * they can be tested on their own.
 */

/**
 * A checkbox click, with shift-click range selection.
 *
 * `ordered` is the rows in the order they are on screen. With an anchor (the
 * last row clicked) every row between the anchor and the clicked row takes the
 * clicked row's new state; without one only the clicked row changes. Rows not
 * on screen are never added by a range — they are not in `ordered`.
 */
export function applyRowSelection(
  selected: readonly string[],
  ordered: readonly string[],
  anchor: string | null,
  target: string,
  checked: boolean,
): string[] {
  const from = anchor === null ? -1 : ordered.indexOf(anchor)
  const to = ordered.indexOf(target)
  const range = from >= 0 && to >= 0
    ? ordered.slice(Math.min(from, to), Math.max(from, to) + 1)
    : [target]
  if (checked) return [...new Set([...selected, ...range])]
  const removed = new Set(range)
  return selected.filter(code => !removed.has(code))
}

/**
 * Publish times spread from a first local date and time, one every
 * `everyDays` days at the same wall-clock time on this computer.
 *
 * `firstLocal` is an `<input type="datetime-local">` value. Day steps use the
 * local calendar, so a daylight-saving change keeps the chosen time of day.
 * Returns [] for anything that is not a usable request.
 */
export function spreadPublishTimes(firstLocal: string, count: number, everyDays: number): string[] {
  const first = new Date(firstLocal)
  if (!firstLocal || !Number.isFinite(first.getTime())) return []
  if (!Number.isInteger(count) || count < 1) return []
  if (!Number.isInteger(everyDays) || everyDays < 1) return []
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(first)
    at.setDate(first.getDate() + index * everyDays)
    return at.toISOString()
  })
}
