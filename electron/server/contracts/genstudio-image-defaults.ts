/**
 * The Story Studio default for image-generation aspect ratio.
 *
 * Owner decision, 2026-10-17 — a request that names NO ratio prefers 16:9,
 * but only when the live catalogue actually publishes it for the selected
 * model. This deliberately reverses the earlier "never default to 16:9
 * locally" rule, which left the provider's own flagged default (the reported
 * case was a 1:1 row) in charge of a choice the customer never made.
 *
 * "Published" is not enough on its own: when the model publishes
 * `output_options[]`, a 16:9 ROW must exist. Choosing a ratio that appears in
 * `aspect_ratios` but has no row would build a request the submit boundary
 * then refuses, which is the failure this module exists to prevent.
 *
 * Every value here comes from the model's published fields. Nothing invents a
 * ratio, a resolution, or an `(resolution, aspect_ratio)` pair, and no row is
 * picked by position when the catalogue names no default. An explicit ratio
 * the model does not publish is still refused by the callers — this module
 * only answers "what should an omitted ratio be?".
 *
 * Shared by the frontend picker (`frontend/utils/genstudio-output-options.ts`)
 * and the backend resolvers, so both boundaries apply one policy. Stored
 * presets and project data are never rewritten by it: an explicit choice is
 * carried through by the callers, not migrated here.
 */

/** The ratio Story Studio prefers when nothing was chosen. */
export const PREFERRED_IMAGE_ASPECT_RATIO = '16:9'

/**
 * The picture size Story Studio writes at when nothing was chosen (owner 2026-11-19: 1024x576,
 * "both should be added for both models ... and defaults to 1024x576").
 *
 * Sized, not labelled: FLUX2 publishes this as its own row `16:9 small` (720 height is not a
 * multiple of 32 and is invalid for the video lane), while qwen publishes it as `16:9`. Matching on
 * pixels finds it on both; matching on the label would find it on neither.
 */
export const DEFAULT_IMAGE_SIZE = { width: 1024, height: 576 } as const

/** `16:9 small` belongs to the 16:9 family — the catalogue's own way of saying "the smaller row". */
function ratioFamily(label: string): string {
  return label.trim().toLowerCase().replace(/\s+small$/, '')
}

/** The subset of a published output row this policy reads. */
export interface StoryDefaultOutputRow {
  resolution: string
  aspect_ratio: string
  width?: number
  height?: number
  is_default?: boolean
}

/** The subset of a live image model / resolved config this policy reads. */
export interface StoryDefaultModel<T extends StoryDefaultOutputRow = StoryDefaultOutputRow> {
  display_name?: string
  default_resolution?: string
  default_aspect_ratio?: string
  aspect_ratios?: string[]
  output_options?: T[]
}

function publishedRows<T extends StoryDefaultOutputRow>(
  model: StoryDefaultModel<T> | null | undefined,
): T[] {
  const published = model?.output_options
  return Array.isArray(published)
    ? published.filter(row => !!row?.resolution && !!row?.aspect_ratio)
    : []
}

/**
 * The ratios a model publishes, rows-first.
 *
 * When `output_options[]` exists, this is the distinct set taken from the
 * valid rows — the same set `isPublishedAspectRatio` accepts and the submit
 * boundary can actually render. A rowless model falls back to its
 * `aspect_ratios` list. Used for truthful error wording, not for choosing a
 * default.
 */
export function publishedAspectRatios(
  model: StoryDefaultModel | null | undefined,
): string[] {
  const published = publishedRows(model)
  if (published.length) return [...new Set(published.map(row => row.aspect_ratio))]
  return (model?.aspect_ratios || []).map(ratio => (ratio || '').trim()).filter(Boolean)
}

/**
 * True when `aspectRatio` is live-published AND renderable for this model.
 *
 * A model publishing output rows is judged on those rows: the row is the only
 * combination the submit boundary accepts. A model publishing no rows has no
 * resolution contract, so its published `aspect_ratios` list decides.
 */
export function isPublishedAspectRatio(
  model: StoryDefaultModel | null | undefined,
  aspectRatio: string | null | undefined,
): boolean {
  const wanted = (aspectRatio || '').trim()
  if (!wanted) return false
  const published = publishedRows(model)
  if (published.length) return published.some(row => row.aspect_ratio === wanted)
  return (model?.aspect_ratios || []).some(ratio => (ratio || '').trim() === wanted)
}

/**
 * The ratio an omitted request should use, or `''` when the model publishes
 * nothing usable. Callers turn the empty answer into their existing loud
 * failure; nothing is guessed here.
 */
export function storyDefaultAspectRatio(
  model: StoryDefaultModel | null | undefined,
): string {
  // 1. The owner's default SIZE, in the Story ratio family, whatever label the catalogue gave the row.
  const family = ratioFamily(PREFERRED_IMAGE_ASPECT_RATIO)
  const sized = publishedRows(model).find(row => (
    row.width === DEFAULT_IMAGE_SIZE.width
    && row.height === DEFAULT_IMAGE_SIZE.height
    && ratioFamily(row.aspect_ratio) === family
  ))
  if (sized) return sized.aspect_ratio
  // 2. Story Studio's ratio preference, but only when it is really renderable.
  if (isPublishedAspectRatio(model, PREFERRED_IMAGE_ASPECT_RATIO)) {
    return PREFERRED_IMAGE_ASPECT_RATIO
  }
  // 2. The provider's declared default, still only when published.
  const declared = (model?.default_aspect_ratio || '').trim()
  if (declared && isPublishedAspectRatio(model, declared)) return declared
  // 3. A row the provider flagged as its default (no declared field case).
  const published = publishedRows(model)
  const flagged = published.find(row => row.is_default)
  if (flagged) return flagged.aspect_ratio
  // 4. The first published row, in GenStudio's own order — this is the model's
  //    live option, not a locally invented fallback.
  if (published.length) return published[0]!.aspect_ratio
  // 5. No rows at all: the first published ratio. Still catalogue data.
  const firstRatio = (model?.aspect_ratios || [])
    .map(ratio => (ratio || '').trim())
    .find(Boolean)
  return firstRatio || ''
}

/**
 * The row to preselect at one ratio: its flagged row, then the published
 * `default_resolution` row, then the sole row at that ratio.
 *
 * `null` means "send the ratio only": either the ratio has no row, or several
 * rows exist and the catalogue names none as the default. Picking one by
 * position would silently commit the customer to a size and price they never
 * chose, so no row is returned instead.
 */
export function preferredOutputOptionAtRatio<T extends StoryDefaultOutputRow>(
  model: StoryDefaultModel<T> | null | undefined,
  aspectRatio: string | null | undefined,
): T | null {
  const ratio = (aspectRatio || '').trim()
  if (!ratio) return null
  const candidates = publishedRows(model).filter(row => row.aspect_ratio === ratio)
  if (!candidates.length) return null
  const flagged = candidates.find(row => row.is_default)
  if (flagged) return flagged
  const resolution = (model?.default_resolution || '').trim()
  if (resolution) {
    const declared = candidates.find(row => row.resolution === resolution)
    if (declared) return declared
  }
  return candidates.length === 1 ? candidates[0]! : null
}

/** The row the Story default lands on, or `null` when it stays ratio-only. */
export function storyDefaultOutputOption<T extends StoryDefaultOutputRow>(
  model: StoryDefaultModel<T> | null | undefined,
): T | null {
  return preferredOutputOptionAtRatio(model, storyDefaultAspectRatio(model))
}

export type OutputOptionDefaultRole = 'story-default' | 'gateway-default'

/**
 * Which truthful label a picker row may show:
 *
 * - `story-default` — this is the row Story Studio uses when nothing is
 *   chosen (possibly the same row the Gateway flags; it still gets ONE label).
 * - `gateway-default` — the Gateway's own flagged default, shown only when it
 *   is not the Story default, so the customer can tell the two apart.
 * - `null` — no default label.
 */
export function outputOptionDefaultRole<T extends StoryDefaultOutputRow>(
  option: T | null | undefined,
  model: StoryDefaultModel<T> | null | undefined,
): OutputOptionDefaultRole | null {
  if (!option) return null
  const storyDefault = storyDefaultOutputOption(model)
  if (storyDefault
    && storyDefault.resolution === option.resolution
    && storyDefault.aspect_ratio === option.aspect_ratio) {
    return 'story-default'
  }
  return option.is_default === true ? 'gateway-default' : null
}
