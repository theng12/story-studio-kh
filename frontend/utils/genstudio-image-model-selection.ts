/**
 * Renderer-side image-model identity helpers.
 *
 * The owner-published retired table lives in `contracts/` so the electron server
 * and the page resolve a saved id the SAME way: a preset that heals on the page
 * must not then fail in the queue. This is the house pattern already used for
 * video models (`utils/genstudio-video-model-selection.ts`).
 *
 * Resolving an id is NOT permission to use it. The caller must still confirm the
 * replacement is in the LIVE catalogue before selecting it — a replacement can be
 * retired in turn, and selecting a dead id is the defect this exists to avoid.
 */
export { resolveRetiredImageModelId } from '../../electron/server/contracts/retired-image-models'

/**
 * The id to select for a saved `intended_image_model`, or `''` when nothing in
 * the live catalogue answers to it.
 *
 * Tried in this order, and the first hit wins:
 *   1. the live catalogue, alias-aware (id, customer handle, public model id,
 *      published legacy ids) — the general case, and the only one that needs no
 *      table;
 *   2. the owner-published retired table, whose target must ITSELF be published
 *      by the live catalogue.
 *
 * Anything else returns `''`: "no model selected", which the caller must show as
 * "choose another" rather than substituting one of its own choosing (AGENTS.md
 * §6 — an unmatched id is not a model).
 */
export function resolveSavedImageModelId(
  saved: unknown,
  find: (id: string) => { id: string } | undefined,
  retired: (value: unknown) => string | null,
): string {
  if (typeof saved !== 'string' || !saved.trim()) return ''
  const direct = find(saved)
  if (direct) return direct.id
  const replacement = retired(saved)
  if (!replacement) return ''
  return find(replacement)?.id || ''
}
