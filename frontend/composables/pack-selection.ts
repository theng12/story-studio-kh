/**
 * A channel's SAVED Formula / Topic Pack selection, read against a list that
 * now carries installed pack items only (owner ruling, 2026-10-29 — "no custom,
 * no built in, all from packs").
 *
 * Two honest outcomes, and they are different answers (AGENTS §6):
 *
 *  - the saved id READS AS a listed pack item (`alias`) — the channel's choice
 *    is served by a pack, so the picker simply shows that item selected;
 *  - nothing installed publishes it (`add`) — the old source still answers, so
 *    the entry is shown with `not_in_pack` and its own real name, never dropped
 *    from the picker and never invented.
 *
 * A saved id whose source has gone returns neither: callers keep their existing
 * "unavailable saved selection" state rather than printing a made-up name.
 * Nothing here writes the saved value.
 */

import type { ContentCatalogMetadata } from './useNiches.js'

export interface SavedSelectionItem {
  id: string
  catalog?: ContentCatalogMetadata
}

export interface SavedSelectionResolution<T extends SavedSelectionItem> {
  /** Rows to append to the list: saved entries no installed pack publishes. */
  add: T[]
  /** Saved id → the listed pack item id it reads as. */
  alias: Record<string, string>
}

export async function resolveSavedSelection<T extends SavedSelectionItem>(
  ids: readonly (string | null | undefined)[],
  isListed: (id: string) => boolean,
  load: (id: string) => Promise<T | null>,
): Promise<SavedSelectionResolution<T>> {
  const add: T[] = []
  const alias: Record<string, string> = {}
  const seen = new Set<string>()
  for (const raw of ids) {
    const id = (raw || '').trim()
    if (!id || seen.has(id) || isListed(id)) continue
    seen.add(id)
    let document: T | null = null
    try {
      document = await load(id)
    } catch {
      continue
    }
    if (!document?.id) continue
    if (document.id !== id) alias[id] = document.id
    if (!isListed(document.id)) {
      add.push({ ...document, catalog: { ...document.catalog, not_in_pack: true } })
    }
  }
  return { add, alias }
}
