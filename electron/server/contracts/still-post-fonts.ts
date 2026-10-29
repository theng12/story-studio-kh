/**
 * Still Posts — the channel's lettering font pool, per writing system.
 *
 * Owner, 2026-10-29: *"using different font for different post. say i add 1 font only. so all the post
 * use that font, then i add 5 fonts to it so it's randomize by that 5 fonts or serial or one after
 * another, these are usage options."*
 *
 * The rules this module encodes, each one a plain function so the server, the page and the tests all
 * answer the same way:
 *
 *  - **No pool means today's behaviour.** An empty pool for a script leaves the format's own face in
 *    place, so every channel and every post written before this feature is lettered exactly as it
 *    was (AGENTS §1: nothing here invents a face).
 *  - **One face means every post uses it** — serial over a one-entry pool.
 *  - **Serial is the default** (owner, 2026-10-29): the pool rotates one after another in pool order
 *    and wraps, with no configuration. `weighted` is the opt-in alternative and is the only mode
 *    where percentages mean anything.
 *  - **Only weighted avoids a repeat.** It will not draw the same face twice in a row unless the
 *    customer opts in to true random. Serial has no such rule.
 *  - **A pool edit never repeats or skips.** The cursor stores the last used face AND its index:
 *    the next face is the entry after that id in the CURRENT pool order, and if that id was removed,
 *    the entry now sitting at the stored index (the face that slid into its place).
 *  - **Weights are normalised and shown.** An enforced limit that is not visible is a mystery; the
 *    picker prints the effective percentage of every entry, computed by THIS function.
 *
 * This file is shared with the page through `@shared/still-post-fonts`, so the percentages the
 * customer reads are the percentages the server draws with — one implementation, never two.
 */

/** How a channel's pool rotates across posts. `serial` is the default and needs no configuration. */
export type StillPostFontUsageMode = 'serial' | 'weighted'

export const STILL_POST_FONT_USAGE_MODES: readonly StillPostFontUsageMode[] = ['serial', 'weighted']

/** What a customer reads for each mode, in the picker and in a job log. */
export const STILL_POST_FONT_USAGE_LABELS: Record<StillPostFontUsageMode, string> = {
  serial: 'One after another',
  weighted: 'By percentage',
}

/** The default when a preset names nothing, or names something this build does not know. */
export const DEFAULT_FONT_USAGE_MODE: StillPostFontUsageMode = 'serial'

/** One face in a pool, with the relative weight used only by `weighted`. */
export interface StillPostFontChoice {
  font_id: string
  /** Relative weight. Ignored in serial; normalised for picking and for the percentage shown. */
  weight: number
}

/** A channel's pool for ONE writing system. */
export interface StillPostFontPool {
  usage_mode: StillPostFontUsageMode
  /** Weighted only: allow the same face twice in a row. Serial never needs this. */
  allow_repeat: boolean
  /** In pool order. Serial walks this order and wraps. */
  fonts: StillPostFontChoice[]
}

/** Pools per ISO 15924 script, as the format's lettering names them. */
export type StillPostFontPools = Partial<Record<string, StillPostFontPool>>

/**
 * Where the rotation stands: the last face a post was actually given, and the index it sat at.
 *
 * Both are stored because the pool can change between posts. The id alone cannot answer "what came
 * next" after a removal; the index alone cannot answer it after a reorder.
 */
export interface StillPostFontCursor {
  last_font_id: string | null
  last_index: number | null
}

/** An empty pool: the honest "this script uses the format's own face". */
export function emptyFontPool(): StillPostFontPool {
  return { usage_mode: DEFAULT_FONT_USAGE_MODE, allow_repeat: false, fonts: [] }
}

export function isFontUsageMode(value: unknown): value is StillPostFontUsageMode {
  return typeof value === 'string' && (STILL_POST_FONT_USAGE_MODES as readonly string[]).includes(value)
}

/** A usage mode from stored or posted data. Unknown or absent is `serial`, never a guess. */
export function normaliseUsageMode(value: unknown): StillPostFontUsageMode {
  return isFontUsageMode(value) ? value : DEFAULT_FONT_USAGE_MODE
}

/**
 * A pool from stored or posted data, made safe: a face id repeated is kept once (first wins), a
 * weight that is not a positive finite number becomes 0 (and is then treated as equal-share when
 * every entry is 0), and the mode falls back to serial.
 */
export function normaliseFontPool(value: unknown): StillPostFontPool {
  const raw = value && typeof value === 'object' ? value as Record<string, any> : {}
  const seen = new Set<string>()
  const fonts: StillPostFontChoice[] = []
  for (const entry of Array.isArray(raw.fonts) ? raw.fonts : []) {
    const id = typeof entry?.font_id === 'string' ? entry.font_id.trim() : typeof entry === 'string' ? entry.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const weight = Number(entry?.weight)
    fonts.push({ font_id: id, weight: Number.isFinite(weight) && weight > 0 ? weight : 0 })
  }
  return {
    usage_mode: normaliseUsageMode(raw.usage_mode),
    allow_repeat: raw.allow_repeat === true,
    fonts,
  }
}

/** Every script's pool, normalised. Absent entries stay absent (nothing is invented). */
export function normaliseFontPools(value: unknown): StillPostFontPools {
  const raw = value && typeof value === 'object' ? value as Record<string, any> : {}
  const pools: StillPostFontPools = {}
  for (const [script, pool] of Object.entries(raw)) {
    if (!pool || typeof pool !== 'object') continue
    const normalised = normaliseFontPool(pool)
    if (normalised.fonts.length) pools[script] = normalised
  }
  return pools
}

/** The pool's face ids, in pool order. */
export function poolFontIds(pool: StillPostFontPool | null | undefined): string[] {
  return (pool?.fonts || []).map(choice => choice.font_id)
}

/**
 * The weights actually used: positive entries as given, all-zero pools share equally.
 *
 * A pool where every weight is 0 is not an error the customer can act on — it is a pool they have
 * not assigned percentages to yet — so it draws evenly rather than refusing.
 */
export function effectiveWeights(pool: StillPostFontPool | null | undefined): number[] {
  const weights = (pool?.fonts || []).map(choice => (Number.isFinite(choice.weight) && choice.weight > 0 ? choice.weight : 0))
  if (!weights.length) return []
  return weights.some(weight => weight > 0) ? weights : weights.map(() => 1)
}

/**
 * The effective percentage of every entry, as whole numbers that add up to exactly 100.
 *
 * This is what the picker prints beside each entry (AGENTS §1: a limit that is enforced is shown).
 * Largest-remainder rounding, so 3 equal entries read 34 / 33 / 33 rather than 33 / 33 / 33.
 */
export function percentagesFor(pool: StillPostFontPool | null | undefined): number[] {
  const weights = effectiveWeights(pool)
  if (!weights.length) return []
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const exact = weights.map(weight => (weight / total) * 100)
  const whole = exact.map(value => Math.floor(value))
  let remainder = 100 - whole.reduce((sum, value) => sum + value, 0)
  const byFraction = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  for (const entry of byFraction) {
    if (remainder <= 0) break
    whole[entry.index] += 1
    remainder -= 1
  }
  return whole
}

/**
 * The index serial mode takes next.
 *
 * - No cursor yet: the first entry.
 * - The last used face is still in the pool: the entry AFTER it in the CURRENT order, wrapping.
 * - It was removed: the entry now at the stored index (the face that slid into its place), wrapping.
 *
 * That is why adding a face never repeats, removing the last used face never skips, and reordering
 * still moves forward from where the last post actually landed.
 */
export function nextSerialIndex(
  ids: readonly string[],
  cursor: StillPostFontCursor | null | undefined,
): number {
  const length = ids.length
  if (!length) return 0
  if (cursor) {
    const at = cursor.last_font_id ? ids.indexOf(cursor.last_font_id) : -1
    if (at >= 0) return (at + 1) % length
    if (typeof cursor.last_index === 'number' && Number.isInteger(cursor.last_index) && cursor.last_index >= 0) {
      return cursor.last_index % length
    }
  }
  return 0
}

/**
 * The index weighted mode takes next.
 *
 * Weighted will not repeat the face the previous post was given, unless the pool has only one face
 * or the customer opted in to true random (`allow_repeat`). `rng` is injected so the choice can be
 * pinned in a test instead of hoped at.
 */
export function pickWeightedIndex(
  pool: StillPostFontPool | null | undefined,
  cursor: StillPostFontCursor | null | undefined,
  rng: () => number = Math.random,
): number {
  const ids = poolFontIds(pool)
  const weights = effectiveWeights(pool)
  if (!ids.length) return -1
  const avoid = !pool?.allow_repeat && ids.length > 1 && cursor?.last_font_id
    ? cursor.last_font_id
    : null
  let candidates = ids
    .map((id, index) => ({ id, index, weight: weights[index] ?? 0 }))
    .filter(entry => entry.id !== avoid)
  if (!candidates.length) candidates = ids.map((id, index) => ({ id, index, weight: weights[index] ?? 0 }))

  const total = candidates.reduce((sum, entry) => sum + entry.weight, 0)
  if (total <= 0) return candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))]!.index
  let roll = rng() * total
  for (const entry of candidates) {
    roll -= entry.weight
    if (roll < 0) return entry.index
  }
  return candidates[candidates.length - 1]!.index
}

/**
 * The face one new post gets from this pool, with the index it occupies, or null when the pool is
 * empty (the format's own face is used and the cursor is not touched).
 */
export function decideFont(
  pool: StillPostFontPool | null | undefined,
  cursor: StillPostFontCursor | null | undefined,
  rng: () => number = Math.random,
): { font_id: string; index: number } | null {
  const ids = poolFontIds(pool)
  if (!ids.length) return null
  const index = normaliseUsageMode(pool?.usage_mode) === 'weighted'
    ? pickWeightedIndex(pool, cursor, rng)
    : nextSerialIndex(ids, cursor)
  if (index < 0 || index >= ids.length) return null
  return { font_id: ids[index]!, index }
}

/** The cursor after a post was given `font_id` at `index`. */
export function cursorAfter(fontId: string, index: number): StillPostFontCursor {
  return { last_font_id: fontId, last_index: index }
}
