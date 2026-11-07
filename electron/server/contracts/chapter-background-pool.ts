/**
 * Chapter Background Pool — reusable backgrounds with SERIAL rotation per channel
 * (release 1.4.386, item 14; HANDOFF "channel-owned four-background serial chapter
 * rotation").
 *
 * Owner / Production semantics (HANDOFF.md + release-384 production ledger):
 *  - Serial only — one background after another in pool order, wrapping. No other
 *    mode was asked for, so none exists here.
 *  - Rotation crosses BOTH boundaries: chapter-to-chapter inside one episode, and
 *    episode-to-episode across the channel. Identity is a stable pair —
 *    (episode_code, chapter_slug) — never the episode alone: two chapters in the
 *    same episode take two successive backgrounds, and a retry of the same
 *    (episode, chapter) keeps its background and does not move the rotation.
 *  - **No pool means today's behaviour.** An empty pool returns no decision and
 *    no caller invents a background (AGENTS §1).
 *  - **A pool edit never repeats or skips.** The cursor stores the last used id
 *    AND its index: the next entry follows that id in the CURRENT enabled order;
 *    if the id was removed, the entry now at the stored index is next.
 *  - Disabled items are skipped without rewriting the stored order.
 *
 * This file is shared server↔page, so the "Next" the editor shows and the pick
 * the render records are one answer (AGENTS §1).
 */

/** Where the rotation stands: the last background actually given, and its index in the enabled list. */
export interface ChapterBackgroundCursor {
  last_background_id: string | null
  last_index: number | null
}

/** One background in a channel's pool. */
export interface ChapterBackgroundItem {
  /** Stable id: catalog id (`deep-space`) or channel file name (`plate.jpg`). */
  id: string
  /** Display name. */
  name: string
  /** Portable reference: `${BACKGROUND}/<id>` or `${CHANNEL}/backgrounds/<file>`. */
  reference: string
  /** Media kind if known (`image` | `video` | `catalog` | `color`), display only. */
  kind?: string
  /** Whether the item participates in rotation (default true). Off = kept, skipped. */
  enabled: boolean
}

/** A channel's pool, in rotation order. Serial is the only mode. */
export interface ChapterBackgroundPool {
  items: ChapterBackgroundItem[]
}

/** One recorded pick, keyed by the stable (episode, chapter) pair. */
export interface ChapterBackgroundUsageEntry {
  episode_code: string
  /** The chapter's stable slug from the Scene Plan; empty string when the boundary has no chapter. */
  chapter_slug: string
  background_id: string
  reference: string
  picked_at: string
}

export interface ChapterBackgroundDecision {
  item: ChapterBackgroundItem
  /** Index within the ENABLED list the cursor moves to. */
  index: number
  cursor: ChapterBackgroundCursor
}

/** The rotation key for idempotence: a chapter is one boundary of one episode. */
export function chapterRotationKey(episodeCode: string, chapterSlug: string | null | undefined): string {
  return `${episodeCode}\u0000${typeof chapterSlug === 'string' ? chapterSlug.trim() : ''}`
}

/** An empty pool: honest "no background pool configured". */
export function emptyChapterBackgroundPool(): ChapterBackgroundPool {
  return { items: [] }
}

/**
 * Normalise a single item. Missing id → null; a name falls back to the id;
 * enabled defaults true (absent means participating).
 */
export function normaliseBackgroundItem(value: unknown): ChapterBackgroundItem | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, any>
  const id = typeof raw.id === 'string' && raw.id.trim()
    ? raw.id.trim()
    : typeof raw.reference === 'string' && raw.reference.trim() ? raw.reference.trim() : ''
  if (!id) return null
  const reference = typeof raw.reference === 'string' && raw.reference.trim() ? raw.reference.trim() : id
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id
  const kind = typeof raw.kind === 'string' && raw.kind ? raw.kind : undefined
  return { id, name, reference, kind, enabled: raw.enabled !== false }
}

/**
 * A pool from stored or posted data, made safe: duplicate ids kept once
 * (first wins), malformed entries dropped, stored extras (older shapes)
 * ignored. An absent pool normalises to empty — nothing is invented.
 */
export function normaliseChapterBackgroundPool(value: unknown): ChapterBackgroundPool {
  const raw = value && typeof value === 'object' ? value as Record<string, any> : {}
  const seen = new Set<string>()
  const items: ChapterBackgroundItem[] = []
  for (const entry of Array.isArray(raw.items) ? raw.items : []) {
    const item = normaliseBackgroundItem(entry)
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }
  return { items }
}

/** The enabled items, in pool order — the list the rotation walks. */
export function enabledBackgroundItems(pool: ChapterBackgroundPool | null | undefined): ChapterBackgroundItem[] {
  return (pool?.items || []).filter(item => item.enabled)
}

/** Ids of enabled backgrounds, in pool order (what the editor's Next line counts). */
export function poolBackgroundIds(pool: ChapterBackgroundPool | null | undefined): string[] {
  return enabledBackgroundItems(pool).map(item => item.id)
}

/**
 * Normalise a cursor from stored or posted data: the object shape, a bare
 * index (an early stored shape), or nothing at all.
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

export function cursorAfter(id: string, index: number): ChapterBackgroundCursor {
  return { last_background_id: id, last_index: index >= 0 ? index : 0 }
}

/**
 * The index serial mode takes next, over the enabled list:
 *  - no cursor yet: the first entry;
 *  - the last used id is still present: the entry AFTER it in the CURRENT order, wrapping;
 *  - it was removed: the entry now at the stored index (the one that slid into its place), wrapping.
 *
 * That is why adding an item never repeats, removing the last used item never skips,
 * and reordering still moves forward from where the last pick actually landed.
 */
export function nextSerialIndex(
  items: readonly ChapterBackgroundItem[],
  cursor: ChapterBackgroundCursor | null | undefined,
): number {
  const length = items.length
  if (!length) return 0
  if (cursor) {
    const at = cursor.last_background_id ? items.findIndex(item => item.id === cursor.last_background_id) : -1
    if (at >= 0) return (at + 1) % length
    if (typeof cursor.last_index === 'number' && Number.isInteger(cursor.last_index) && cursor.last_index >= 0) {
      return cursor.last_index % length
    }
  }
  return 0
}

/**
 * The next background in the serial rotation. Null when the pool has no
 * enabled items — the caller then behaves exactly as it did with no pool.
 */
export function decideChapterBackground(
  pool: ChapterBackgroundPool | null | undefined,
  cursor: ChapterBackgroundCursor | null | undefined,
): ChapterBackgroundDecision | null {
  const items = enabledBackgroundItems(pool)
  if (!items.length) return null
  const index = nextSerialIndex(items, cursor)
  const item = items[index]
  if (!item) return null
  return { item, index, cursor: cursorAfter(item.id, index) }
}
