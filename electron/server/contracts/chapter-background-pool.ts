/**
 * Chapter Background Pool — reusable background pools with serial rotation per channel.
 *
 * Owner / Production presentation work (2026-11-07):
 *   "Reusable chapter-background pools with serial rotation per channel."
 *
 * Rules:
 *  - **No pool means today's behaviour.** An empty or unconfigured pool leaves
 *    chapter backgrounds unmanaged (or uses single episode background if specified).
 *  - **One background means every chapter/episode uses that background.**
 *  - **Serial is the default:** the pool rotates one after another in pool order
 *    and wraps, requiring no complex configuration.
 *  - **A pool edit never repeats or skips.** The cursor stores both the last used
 *    background ID AND its index. The next background is the entry after that ID
 *    in the CURRENT enabled pool order; if that ID was removed, the entry now
 *    sitting at the stored index (the background that slid into its place).
 *  - **Disabled items are skipped during rotation** without altering the pool order.
 *  - **Weighted mode is opt-in:** percentages are calculated using largest-remainder
 *    rounding so displayed percentages always total 100%. Avoids consecutive repeats
 *    unless `allow_repeat: true`.
 *  - **References are portable:** accepts catalog backgrounds (`${BACKGROUND}/<id>`),
 *    channel assets (`${CHANNEL}/backgrounds/<file>`), or file paths.
 */

export type ChapterBackgroundUsageMode = 'serial' | 'weighted' | 'manual'

export const CHAPTER_BACKGROUND_USAGE_MODES: readonly ChapterBackgroundUsageMode[] = [
  'serial',
  'weighted',
  'manual',
]

export const CHAPTER_BACKGROUND_USAGE_LABELS: Record<ChapterBackgroundUsageMode, string> = {
  serial: 'One after another',
  weighted: 'By percentage',
  manual: 'Manual pick',
}

export const DEFAULT_BACKGROUND_USAGE_MODE: ChapterBackgroundUsageMode = 'serial'

export type ChapterBackgroundKind = 'image' | 'video' | 'catalog' | 'color'

export interface ChapterBackgroundItem {
  /** Unique identifier within the pool (e.g. catalog id or filename). */
  id: string
  /** Human-readable display label. */
  name: string
  /** Portable reference or path (e.g. `${BACKGROUND}/deep-space` or `${CHANNEL}/backgrounds/bg.mp4`). */
  reference: string
  /** Media kind if known. */
  kind?: ChapterBackgroundKind
  /** Whether this item participates in auto-rotation (default true). */
  enabled: boolean
  /** Relative weight for weighted mode (default 100). */
  weight?: number
}

export interface ChapterBackgroundPool {
  usage_mode: ChapterBackgroundUsageMode
  /** Weighted only: whether the same background can be picked twice consecutively. */
  allow_repeat: boolean
  /** Ordered list of background items in the pool. */
  items: ChapterBackgroundItem[]
}

export interface ChapterBackgroundCursor {
  last_background_id: string | null
  last_index: number | null
}

export interface ChapterBackgroundUsageEntry {
  episode_code: string
  background_id: string
  reference: string
  picked_at: string
}

export interface ChapterBackgroundDecision {
  item: ChapterBackgroundItem
  index: number
  cursor: ChapterBackgroundCursor
}

/**
 * Normalise a cursor from stored or posted data: accepts the object shape, a
 * bare index (how an early cursor was stored), or nothing at all.
 */
export function normaliseCursor(value: unknown): ChapterBackgroundCursor {
  if (value && typeof value === 'object') {
    const raw = value as Record<string, any>
    const lastId = typeof raw.last_background_id === 'string' ? raw.last_background_id : null
    const lastIndex = typeof raw.last_index === 'number' && Number.isInteger(raw.last_index) && raw.last_index >= 0
      ? raw.last_index
      : null
    return { last_background_id: lastId, last_index: lastIndex }
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return { last_background_id: null, last_index: value }
  }
  return { last_background_id: null, last_index: null }
}

/** Return an empty pool: honest "no background pool configured". */
export function emptyChapterBackgroundPool(): ChapterBackgroundPool {
  return {
    usage_mode: DEFAULT_BACKGROUND_USAGE_MODE,
    allow_repeat: false,
    items: [],
  }
}

export function isBackgroundUsageMode(value: unknown): value is ChapterBackgroundUsageMode {
  return typeof value === 'string' && (CHAPTER_BACKGROUND_USAGE_MODES as readonly string[]).includes(value)
}

export function normaliseUsageMode(value: unknown): ChapterBackgroundUsageMode {
  return isBackgroundUsageMode(value) ? value : DEFAULT_BACKGROUND_USAGE_MODE
}

export function inferBackgroundKind(reference: string): ChapterBackgroundKind {
  const ref = (reference || '').toLowerCase()
  if (ref.startsWith('${background}/') || ref.startsWith('catalog:')) return 'catalog'
  if (ref.startsWith('#') || ref.startsWith('rgb')) return 'color'
  if (/\.(mp4|mov|webm|mkv)$/i.test(ref)) return 'video'
  return 'image'
}

/** Normalise a single background item. */
export function normaliseBackgroundItem(value: unknown): ChapterBackgroundItem | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, any>
  const id = typeof raw.id === 'string' ? raw.id.trim() : typeof raw.reference === 'string' ? raw.reference.trim() : ''
  if (!id) return null
  const reference = typeof raw.reference === 'string' && raw.reference.trim() ? raw.reference.trim() : id
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id
  const enabled = raw.enabled !== false
  const weightNum = Number(raw.weight)
  const weight = Number.isFinite(weightNum) && weightNum > 0 ? weightNum : 100
  const kind: ChapterBackgroundKind = (raw.kind && ['image', 'video', 'catalog', 'color'].includes(raw.kind))
    ? raw.kind
    : inferBackgroundKind(reference)

  return { id, name, reference, kind, enabled, weight }
}

/**
 * Normalise a pool from stored or client data:
 * - De-duplicates IDs (first entry wins).
 * - Ensures valid usage mode.
 * - Enforces enabled flags and weights.
 */
export function normaliseChapterBackgroundPool(value: unknown): ChapterBackgroundPool {
  const raw = value && typeof value === 'object' ? value as Record<string, any> : {}
  const seen = new Set<string>()
  const items: ChapterBackgroundItem[] = []

  const rawItems = Array.isArray(raw.items) ? raw.items : []
  for (const entry of rawItems) {
    const normalised = normaliseBackgroundItem(entry)
    if (!normalised || seen.has(normalised.id)) continue
    seen.add(normalised.id)
    items.push(normalised)
  }

  return {
    usage_mode: normaliseUsageMode(raw.usage_mode),
    allow_repeat: raw.allow_repeat === true,
    items,
  }
}

/** Filter to only items that are enabled for rotation. */
export function enabledBackgroundItems(pool: ChapterBackgroundPool | null | undefined): ChapterBackgroundItem[] {
  return (pool?.items || []).filter(item => item.enabled)
}

/** IDs of enabled backgrounds, in pool order. */
export function poolBackgroundIds(pool: ChapterBackgroundPool | null | undefined): string[] {
  return enabledBackgroundItems(pool).map(item => item.id)
}

/**
 * Effective weights for enabled items:
 * Positive entries as given; if all are zero, share equally.
 */
export function effectiveWeights(pool: ChapterBackgroundPool | null | undefined): number[] {
  const items = enabledBackgroundItems(pool)
  if (!items.length) return []
  const weights = items.map(item => (Number.isFinite(item.weight) && (item.weight ?? 0) > 0 ? item.weight! : 0))
  return weights.some(w => w > 0) ? weights : weights.map(() => 1)
}

/**
 * Effective percentage for each enabled entry, rounded with largest-remainder
 * so they add up to exactly 100%.
 */
export function percentagesFor(pool: ChapterBackgroundPool | null | undefined): number[] {
  const weights = effectiveWeights(pool)
  if (!weights.length) return []
  const total = weights.reduce((sum, w) => sum + w, 0)
  if (total <= 0) return weights.map(() => 0)

  const exact = weights.map(w => (w / total) * 100)
  const whole = exact.map(val => Math.floor(val))
  let remainder = 100 - whole.reduce((sum, val) => sum + val, 0)

  const byFraction = exact
    .map((val, idx) => ({ idx, fraction: val - Math.floor(val) }))
    .sort((a, b) => b.fraction - a.fraction || a.idx - b.idx)

  for (const entry of byFraction) {
    if (remainder <= 0) break
    whole[entry.idx] += 1
    remainder -= 1
  }
  return whole
}

/**
 * Compute the next serial index across active items.
 *
 * Cursor rules:
 *   - No cursor yet: starts at index 0.
 *   - Last used item is still in the active list: entry immediately AFTER it, wrapping.
 *   - Last used item was removed: entry now sitting at the stored index, wrapping.
 */
export function nextSerialIndex(
  items: readonly ChapterBackgroundItem[],
  cursor: ChapterBackgroundCursor | null | undefined,
): number {
  const length = items.length
  if (!length) return 0
  if (cursor) {
    const at = cursor.last_background_id ? items.findIndex(it => it.id === cursor.last_background_id) : -1
    if (at >= 0) return (at + 1) % length
    if (typeof cursor.last_index === 'number' && Number.isInteger(cursor.last_index) && cursor.last_index >= 0) {
      return cursor.last_index % length
    }
  }
  return 0
}

/**
 * Select a weighted index across items.
 *
 * Avoids repeating the last used item unless `allowRepeat` is true or only one item exists.
 */
export function pickWeightedIndex(
  items: readonly ChapterBackgroundItem[],
  cursor: ChapterBackgroundCursor | null | undefined,
  allowRepeat = false,
  rng: () => number = Math.random,
): number {
  if (!items.length) return -1
  if (items.length === 1) return 0

  const weights = items.map(it => (Number.isFinite(it.weight) && (it.weight ?? 0) > 0 ? it.weight! : 1))
  const avoidId = !allowRepeat && cursor?.last_background_id ? cursor.last_background_id : null

  let candidates = items
    .map((item, idx) => ({ item, idx, weight: weights[idx] ?? 1 }))
    .filter(c => c.item.id !== avoidId)

  if (!candidates.length) {
    candidates = items.map((item, idx) => ({ item, idx, weight: weights[idx] ?? 1 }))
  }

  const total = candidates.reduce((sum, c) => sum + c.weight, 0)
  if (total <= 0) {
    return candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))]!.idx
  }

  let roll = rng() * total
  for (const c of candidates) {
    roll -= c.weight
    if (roll < 0) return c.idx
  }
  return candidates[candidates.length - 1]!.idx
}

/**
 * Return cursor positioned after the given item and index.
 */
export function cursorAfter(id: string, index: number): ChapterBackgroundCursor {
  return {
    last_background_id: id,
    last_index: index >= 0 ? index : 0,
  }
}

/**
 * Decide the background to use from the pool given the standing cursor.
 *
 * Returns null if the pool has no enabled items or if mode is 'manual'.
 */
export function decideChapterBackground(
  pool: ChapterBackgroundPool | null | undefined,
  cursor: ChapterBackgroundCursor | null | undefined,
  rng: () => number = Math.random,
): ChapterBackgroundDecision | null {
  const activeItems = enabledBackgroundItems(pool)
  if (!activeItems.length) return null

  const mode = pool?.usage_mode ?? DEFAULT_BACKGROUND_USAGE_MODE
  if (mode === 'manual') return null

  let pickedIndex = 0
  if (mode === 'serial') {
    pickedIndex = nextSerialIndex(activeItems, cursor)
  } else if (mode === 'weighted') {
    pickedIndex = pickWeightedIndex(activeItems, cursor, pool?.allow_repeat ?? false, rng)
  }

  const item = activeItems[pickedIndex]
  if (!item) return null

  return {
    item,
    index: pickedIndex,
    cursor: cursorAfter(item.id, pickedIndex),
  }
}

/** Check if two background references match. */
export function matchesBackgroundReference(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const normA = a.replace(/^\${BACKGROUND}\//i, '').replace(/^\${CHANNEL}\/backgrounds\//i, '').toLowerCase()
  const normB = b.replace(/^\${BACKGROUND}\//i, '').replace(/^\${CHANNEL}\/backgrounds\//i, '').toLowerCase()
  return normA === normB
}
