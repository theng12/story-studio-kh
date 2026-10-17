/**
 * Compare and canonicalize YouTube publish instants.
 *
 * YouTube serializes the same instant differently from `toISOString()` — it
 * commonly returns `2031-01-02T03:04:05Z` where Story Studio sent
 * `2031-01-02T03:04:05.000Z`, and either side may use an offset — so two
 * strings that mean the same moment are not equal as strings. Everything that
 * decides whether YouTube confirmed a schedule must compare the instant, not
 * its spelling.
 */

/**
 * Whether two schedule values denote the same instant.
 *
 * `null` and `undefined` both mean "no schedule" and agree only with each
 * other. Two non-null values agree only when BOTH parse to a real instant and
 * those instants are equal — so a malformed value never matches anything (not
 * even another malformed value), and a genuinely different instant is still a
 * difference.
 */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = a ?? null
  const right = b ?? null
  if (left === null || right === null) return left === right
  const leftMs = Date.parse(left)
  const rightMs = Date.parse(right)
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs
}

/**
 * Rewrite a parseable schedule value to one canonical spelling, so two
 * serializations of the same instant compare equal.
 *
 * `null` stays `null`. A value that does not parse to a real instant is
 * returned UNCHANGED, so a malformed value keeps its own distinct spelling and
 * stays visible as a difference rather than collapsing into a shared blank.
 */
export function canonicalInstant(value: string | null): string | null {
  if (value === null) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value
}
