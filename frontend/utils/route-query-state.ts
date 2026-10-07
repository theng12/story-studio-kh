/**
 * Keep a page's place (search, filters, page number) in the URL so Back and
 * reload return the owner to the same view. Pure: the page reads its initial
 * state with `readQueryState` and mirrors changes with
 * `router.replace({ query: writeQueryState(...) })` when `sameQuery` says it changed.
 *
 * The type of each default decides how its key is read: boolean ↔ '1'/'0',
 * number ↔ positive integer, string (or null) ↔ text. A value equal to its
 * default is left out of the URL; unrelated query keys are kept as they are.
 */
export type QueryStateValue = string | number | boolean | null

function first(raw: unknown): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value : undefined
}

export function readQueryState<T extends Record<string, QueryStateValue>>(query: Record<string, unknown>, defaults: T): T {
  const out: Record<string, QueryStateValue> = { ...defaults }
  for (const [key, fallback] of Object.entries(defaults)) {
    const raw = first(query[key])
    if (raw === undefined) continue
    if (typeof fallback === 'boolean') out[key] = raw === '1'
    else if (typeof fallback === 'number') out[key] = /^[1-9]\d{0,5}$/.test(raw) ? Number(raw) : fallback
    else out[key] = raw || fallback
  }
  return out as T
}

export function writeQueryState<T extends Record<string, QueryStateValue>>(
  query: Record<string, unknown>,
  state: T,
  defaults: T,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...query }
  for (const key of Object.keys(defaults)) {
    const value = state[key]
    if (value === defaults[key] || value === null || value === '') delete out[key]
    else out[key] = typeof value === 'boolean' ? (value ? '1' : '0') : String(value)
  }
  return out
}

export function sameQuery(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if (JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null)) return false
  return true
}
