/**
 * Local video models the owner has retired. Story Studio never lists, selects
 * or requests them, even if a catalogue (or a stale saved copy of one) still
 * carries a row for them.
 *
 * Retired 2026-10-01: the local LTX video model ("bad quality, can't use it").
 * Anything naming it falls through to the existing paths for an id GenStudio
 * does not publish: the picker offers the live models, and a scene with no clip
 * stays a still.
 *
 * Retired 2026-10-02 with it: Gemma 3 12B 4-bit (`gemma-3-12b-it-4bit`, LTX's text encoder; the owner: "it's bad").
 * Other Gemma models (gemma-4-*, gemma-3-27b) are different products and are not caught.
 *
 * Dependency-free so renderer code can import it (see nuxt.config.ts).
 */

/**
 * The retired model is LTX-2.3 (the local Studio Hub pack and anything else named for that version), plus the
 * local lane's own spellings (`local-ltx`, `baa-ai/LTX-...`). Deliberately NOT every id containing
 * `ltx`: a hosted cloud model such as fal's `ltx-video` is a different product and stays selectable.
 */
const RETIRED_VIDEO_TOKEN = /(^|[^a-z0-9])(ltx[-. ]?2[-. ]?3|local-ltx|baa-ai\/ltx|gemma[-. ]?3[-. ]?12b)/i

export function isRetiredVideoModelId(value: unknown): boolean {
  return typeof value === 'string' && RETIRED_VIDEO_TOKEN.test(value)
}

/** A catalogue row is retired when any name it answers to is. */
export function isRetiredVideoModel(row: {
  id?: unknown
  display_name?: unknown
  customer_handle?: unknown
  public_model_id?: unknown
  legacy_ids?: unknown
}): boolean {
  return [row.id, row.display_name, row.customer_handle, row.public_model_id]
    .some(isRetiredVideoModelId)
    || (Array.isArray(row.legacy_ids) && row.legacy_ids.some(isRetiredVideoModelId))
}
