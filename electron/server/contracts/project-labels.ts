/**
 * Channel labels — the short free-text tags an owner puts on a channel
 * ("Khmer", "Sleep", "History") so the start page can be searched, filtered
 * and sorted by what a channel IS, not only by what it is called.
 *
 * ── Why this is its own module ──
 *
 * Both sides need the same rules, and the frontend needs them as VALUES:
 * `pages/index.vue` and the channel's Settings tab cap the label field, fold
 * "Sleep"/"sleep" together and offer the set already in use. `contracts/index.ts`
 * cannot serve that — it is a zod module, and a value import from it pulls zod
 * into the renderer bundle (see the note at the head of that file). This module
 * depends on nothing, so importing it costs the renderer nothing. Same shape as
 * `./pacing.ts`, for the same reason.
 *
 * ── The rules ──
 *
 *   - a label is trimmed, and inner runs of whitespace collapse to one space,
 *     so "Khmer  history" and "Khmer history" are one label rather than two;
 *   - an empty one is dropped, never stored;
 *   - labels are DE-DUPLICATED case-insensitively, keeping the FIRST spelling
 *     written — "Sleep" and "sleep" are one label, and it stays the way the
 *     owner typed it rather than being re-cased behind his back;
 *   - at most `MAX_PROJECT_LABEL_LENGTH` characters each, and at most
 *     `MAX_PROJECT_LABELS` on a channel.
 *
 * The two ceilings REFUSE at the HTTP boundary (`UpdateProjectSchema` → 400),
 * so a label that is too long is never quietly shortened into a different word.
 * This function is the backstop for the writes that reach `project.json`
 * without going through the schema; there it DROPS an over-long label rather
 * than truncating it, because half a word is not the label anyone typed.
 */

/** Longest a single label may be. */
export const MAX_PROJECT_LABEL_LENGTH = 40
/** Most labels one channel may carry. */
export const MAX_PROJECT_LABELS = 24

/**
 * The labels to store for a channel: trimmed, whitespace-collapsed, empty
 * entries dropped, case-insensitively de-duplicated (first spelling wins), and
 * bounded by both ceilings. Anything that is not a string is ignored; a value
 * that is not an array at all means "no labels".
 */
export function normalizeProjectLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const label = raw.trim().replace(/\s+/g, ' ')
    if (!label || label.length > MAX_PROJECT_LABEL_LENGTH) continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(label)
    if (out.length >= MAX_PROJECT_LABELS) break
  }
  return out
}
