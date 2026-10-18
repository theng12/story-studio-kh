/**
 * Published image output options — the `(resolution, aspect_ratio)` rows.
 *
 * Each row GenStudio publishes is ONE VALID COMBINATION with its own real
 * pixel size and its own price. Nothing here splits a row into separate
 * resolution and ratio lists and recombines them: a ratio available at 1K but
 * not 2K is expressed simply by that row not existing, and inventing the
 * missing pairing would advertise output GenStudio has not declared valid.
 *
 * A model that publishes no rows gets no resolution control at all — the flow
 * degrades to aspect ratio alone and GenStudio applies its own default. No row
 * is ever synthesised to fill the gap.
 */

import {
  preferredOutputOptionAtRatio,
  storyDefaultOutputOption,
} from '@shared/genstudio-image-defaults'

// `export { ... }` without `from` binds LOCAL names; these four are re-exported
// directly from the shared contract because nothing in this module declares
// them. The two imported helpers above are exported locally below.
export {
  PREFERRED_IMAGE_ASPECT_RATIO,
  isPublishedAspectRatio,
  outputOptionDefaultRole,
  storyDefaultAspectRatio,
} from '@shared/genstudio-image-defaults'

export {
  preferredOutputOptionAtRatio,
  storyDefaultOutputOption,
}

export interface PublishedOutputOption {
  resolution: string
  aspect_ratio: string
  width: number
  height: number
  is_default: boolean
  credits_per_image?: number
  base_credits_per_image?: number
  price_version?: string
  reference_generation_credits?: number
}

/** The subset of a live image model this module reads. */
export interface OutputOptionSource {
  display_name?: string
  default_resolution?: string
  default_aspect_ratio?: string
  output_options?: PublishedOutputOption[]
}

/** A customer's current pick, kept as the PAIR because the pair is the row. */
export interface OutputOptionChoice {
  resolution: string
  aspect_ratio: string
}

function rows(model: OutputOptionSource | null | undefined): PublishedOutputOption[] {
  const published = model?.output_options
  return Array.isArray(published) ? published.filter(row => !!row?.resolution && !!row?.aspect_ratio) : []
}

/** Every published row, in GenStudio's own order. Empty = no control. */
export function publishedOutputOptions(model: OutputOptionSource | null | undefined): PublishedOutputOption[] {
  return rows(model)
}

/** Distinct published ratios, taken from the rows themselves. */
export function publishedOutputRatios(model: OutputOptionSource | null | undefined): string[] {
  return [...new Set(rows(model).map(row => row.aspect_ratio))]
}

/** The rows valid at one ratio. Never widened to rows of other ratios. */
export function outputOptionsForRatio(
  model: OutputOptionSource | null | undefined,
  aspectRatio: string,
): PublishedOutputOption[] {
  return rows(model).filter(row => row.aspect_ratio === aspectRatio)
}

/**
 * The row a picker preselects when nothing was chosen: the Story default
 * (16:9 when the model publishes a renderable 16:9 row), falling back through
 * the model's own published default. See
 * `electron/server/contracts/genstudio-image-defaults.ts` for the shared
 * policy the backend applies to omitted requests too.
 *
 * Returns `null` when no published row can be selected. No row is chosen by
 * position — "first row wins" would silently commit the customer to a size
 * and a price they never picked.
 */
export function defaultOutputOption(
  model: OutputOptionSource | null | undefined,
): PublishedOutputOption | null {
  return storyDefaultOutputOption(model)
}

/** The exact published row for a pair, or `null` when the model has none. */
export function findOutputOption(
  model: OutputOptionSource | null | undefined,
  choice: OutputOptionChoice | null | undefined,
): PublishedOutputOption | null {
  if (!choice?.resolution || !choice?.aspect_ratio) return null
  return rows(model).find(
    row => row.resolution === choice.resolution && row.aspect_ratio === choice.aspect_ratio,
  ) || null
}

/** "1K · 16:9 · 1920×1080" — the real output, not a marketing label. */
export function describeOutputOption(option: PublishedOutputOption): string {
  return `${option.resolution} · ${option.aspect_ratio} · ${option.width.toLocaleString()}×${option.height.toLocaleString()}`
}

export interface OutputOptionReconciliation {
  /** The row to submit, or `null` when there is nothing to submit. */
  option: PublishedOutputOption | null
  /** True when the model publishes rows but none could be defaulted to. */
  needsChoice: boolean
  /** Visible sentence whenever the selection changed under the customer. */
  notice: string
}

export interface ReconcileOutputOptionOptions {
  /**
   * The ratio currently on screen, remembered, or in the applied preset.
   *
   * It is a PREFERENCE, not a selection: an exact published pair still wins,
   * because that pair is the row the customer actually picked. The preference
   * only decides the first reconcile (no pair yet) and a deliberate ratio
   * change — without it, a null starting pair would let the Story default
   * overwrite a remembered 9:16 or 1:1 on mount.
   */
  preferredAspectRatio?: string
}

/**
 * Carry a customer's current pick across a model switch.
 *
 * The pair is preserved when the new model publishes that exact combination.
 * Otherwise it falls back to the row at the preferred ratio (the ratio on
 * screen) or the new model's Story default AND says so, because submitting a
 * different combination than the one on screen is how a customer ends up
 * paying for output they did not choose.
 */
export function reconcileOutputOption(
  previous: OutputOptionChoice | null | undefined,
  model: OutputOptionSource | null | undefined,
  reconcile: ReconcileOutputOptionOptions = {},
): OutputOptionReconciliation {
  const published = rows(model)
  // No published rows: this model has no resolution contract, so there is
  // nothing to keep, nothing to default to, and nothing to announce.
  if (!published.length) return { option: null, needsChoice: false, notice: '' }

  const label = model?.display_name || 'This model'
  const preferred = (reconcile.preferredAspectRatio || '').trim()
  const preferredPublished = !!preferred && published.some(row => row.aspect_ratio === preferred)
  const kept = findOutputOption(model, previous)

  // An exact published pair still wins, silently: it is the row the customer
  // actually picked. The preference only speaks when there is no pair to keep.
  if (kept) return { option: kept, needsChoice: false, notice: '' }

  const preferredRow = preferredPublished ? preferredOutputOptionAtRatio(model, preferred) : null
  // A published preferred ratio can still have NO unique row (several sizes,
  // none flagged or declared). That is ratio-only, never permission to fall
  // through to a DIFFERENT ratio's Story default — that would silently discard
  // the remembered/preset ratio the customer can still use.
  if (preferredPublished && !preferredRow) {
    return {
      option: null,
      needsChoice: true,
      notice: `${label} publishes ${preferred} at more than one size and names no default. `
        + 'Choose one of its published sizes; otherwise the ratio is sent without a resolution and the Gateway applies its own.',
    }
  }

  const fallback = preferredRow ?? storyDefaultOutputOption(model)
  if (!previous?.resolution || !previous?.aspect_ratio) {
    return fallback
      ? { option: fallback, needsChoice: false, notice: '' }
      : {
          option: null,
          needsChoice: true,
          notice: `${label} publishes no default output size. Choose one of its published sizes before generating.`,
        }
  }

  if (!fallback) {
    return {
      option: null,
      needsChoice: true,
      notice: `${label} does not publish ${previous.resolution} at ${previous.aspect_ratio}, and flags no default. `
        + 'Choose one of its published sizes before generating.',
    }
  }
  return {
    option: fallback,
    needsChoice: false,
    notice: `${label} does not publish ${previous.resolution} at ${previous.aspect_ratio}. `
      + `Switched to its default, ${describeOutputOption(fallback)}.`,
  }
}
