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
 * The row a picker preselects: `is_default` first, then the published
 * `default_resolution` + `default_aspect_ratio` pair.
 *
 * Returns `null` when neither resolves. No row is chosen by position — "first
 * row wins" would silently commit the customer to a size and a price they
 * never picked.
 */
export function defaultOutputOption(
  model: OutputOptionSource | null | undefined,
): PublishedOutputOption | null {
  const published = rows(model)
  if (!published.length) return null
  const flagged = published.find(row => row.is_default)
  if (flagged) return flagged
  const resolution = (model?.default_resolution || '').trim()
  const ratio = (model?.default_aspect_ratio || '').trim()
  if (!resolution || !ratio) return null
  return published.find(row => row.resolution === resolution && row.aspect_ratio === ratio) || null
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

/**
 * Carry a customer's current pick across a model switch.
 *
 * The pair is preserved when the new model publishes that exact combination.
 * Otherwise it falls back to the new model's own default AND says so, because
 * submitting a different combination than the one on screen is how a customer
 * ends up paying for output they did not choose.
 */
export function reconcileOutputOption(
  previous: OutputOptionChoice | null | undefined,
  model: OutputOptionSource | null | undefined,
): OutputOptionReconciliation {
  const published = rows(model)
  // No published rows: this model has no resolution contract, so there is
  // nothing to keep, nothing to default to, and nothing to announce.
  if (!published.length) return { option: null, needsChoice: false, notice: '' }

  const label = model?.display_name || 'This model'
  const kept = findOutputOption(model, previous)
  if (kept) return { option: kept, needsChoice: false, notice: '' }

  const fallback = defaultOutputOption(model)
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
