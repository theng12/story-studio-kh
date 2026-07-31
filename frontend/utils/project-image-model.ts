/**
 * Which image model this project is already set up to render with.
 *
 * Scene Review is where scene images are actually generated, and it remembers
 * its render settings per-Mac under a `useRememberedForm` key. The prompt-
 * writing screens need that same id as a STARTING POINT for "which model are
 * these prompts being written for?", so Auto has something to follow before the
 * user has thought about image models at all.
 *
 * It is only a default. The prompt screens keep their own selection (a writing
 * hint), never write back here, and never change what Scene Review will
 * actually render with. An unreadable, absent, or corrupt entry yields '' —
 * "nothing selected" — which the caller must treat as "no cap, no warning"
 * rather than substituting a model of its own choosing.
 */

/** Mirrors `useRememberedForm('scene-review-genstudio', slug, form)`. */
export function rememberedImageModelStorageKey(slug: string): string {
  return `ssk:form:${slug}:scene-review-genstudio:v1`
}

/** Minimal shape of the Web Storage API this reader needs. */
export interface ReadableStorage {
  getItem(key: string): string | null
}

export function readRememberedImageModelId(
  slug: string,
  storage: ReadableStorage | null | undefined,
): string {
  if (!slug || !storage) return ''
  try {
    const raw = storage.getItem(rememberedImageModelStorageKey(slug))
    if (!raw) return ''
    const saved = JSON.parse(raw)
    const model = saved && typeof saved === 'object' ? (saved as Record<string, unknown>).model : ''
    return typeof model === 'string' ? model.trim() : ''
  } catch {
    return ''
  }
}
