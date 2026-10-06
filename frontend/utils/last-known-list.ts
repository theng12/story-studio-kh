/**
 * The last list this browser successfully loaded, kept across launches.
 *
 * Purpose is narrow and worth stating, because the obvious misuse is one line
 * away: this exists so a page can PAINT something the instant it opens instead
 * of showing a spinner over a blank screen while a local read completes. It is a
 * display cache and nothing else.
 *
 * It is never the basis for a decision that costs money or changes data. Any
 * screen whose next action is a submission must still hold that action behind a
 * live read — a cached list is by definition a list nobody has confirmed, and
 * the money-fence that refuses a submission against an unconfirmed catalogue is
 * untouched by anything in this file.
 */

const PREFIX = 'story_studio_last_known_'
/** Enough for a very large channel list; a bigger payload is not worth storing. */
const MAX_BYTES = 512 * 1024

/**
 * The store, or null where there isn't one.
 *
 * Deliberately a capability check rather than `import.meta.client`. What this
 * code needs to know is whether a storage exists, and asking that question
 * directly is both more honest and testable — a Nuxt build constant is neither.
 * Private windows, cleared site data and browsers configured to block site data
 * all land here too, and all get the same answer: no cache, old behaviour.
 */
function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readLastKnownList<T = unknown>(name: string): T[] {
  const storage = store()
  if (!storage) return []
  try {
    const raw = storage.getItem(PREFIX + name)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as T[] : []
  } catch {
    return []
  }
}

/**
 * `maxBytes` raises the size cap for a list that is legitimately large (a
 * 400-episode channel's rows). `evictPrefix` names the family this entry
 * belongs to: when the store is full, the family's OTHER entries are dropped
 * and the write tried once more, so the list being written wins.
 */
export function writeLastKnownList(name: string, rows: unknown[], options: { maxBytes?: number; evictPrefix?: string } = {}): void {
  const storage = store()
  if (!storage) return
  // A non-array is refused outright rather than stored and read back as junk —
  // and refused WITHOUT disturbing whatever good value is already there.
  if (!Array.isArray(rows)) return
  try {
    const raw = JSON.stringify(rows)
    // An oversized payload is dropped rather than truncated: half a list is
    // worse than a spinner, because it looks complete.
    if (raw.length > (options.maxBytes ?? MAX_BYTES)) {
      storage.removeItem(PREFIX + name)
      return
    }
    try {
      storage.setItem(PREFIX + name, raw)
    } catch (error) {
      if (!options.evictPrefix) throw error
      for (let i = storage.length - 1; i >= 0; i--) {
        const key = storage.key(i)
        if (key?.startsWith(PREFIX + options.evictPrefix) && key !== PREFIX + name) storage.removeItem(key)
      }
      storage.setItem(PREFIX + name, raw)
    }
  } catch { /* best effort — a full or blocked store must never break a page */ }
}

export function clearLastKnownList(name: string): void {
  const storage = store()
  if (!storage) return
  try { storage.removeItem(PREFIX + name) } catch { /* best effort */ }
}
