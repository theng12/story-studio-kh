/**
 * Credit cost, always in GenStudio's own published terms.
 *
 * Story Studio never computes what a customer will be charged. It shows the
 * unit price GenStudio publishes for the SELECTED model and option, and after
 * a run it shows the `credit_cost` GenStudio reported. Every figure carries a
 * basis so the customer can tell a rate from a quote from an actual, and
 * "not reported" is a real answer — never a locally derived stand-in.
 *
 * Everything here is a pure function of the live catalogue entry, so a model
 * switch recomputes it with no cache to invalidate.
 */

export type CreditBasis =
  /** Published per-unit price. Total depends on how much is generated. */
  | 'rate'
  /** Rate multiplied by a count Story Studio knows. Clearly not the charge. */
  | 'estimate'
  /** Returned by a GenStudio quote endpoint for this exact request. */
  | 'quote'
  /**
   * The sum of several GenStudio quotes — one per request that will actually
   * be submitted. Distinct from `estimate` because nothing was derived here:
   * every addend is GenStudio's own exact figure for a real job, and the only
   * local operation is the addition. Distinct from `quote` because it covers
   * more than one job, each with its own published minimum.
   */
  | 'quoted-total'
  /** The `credit_cost` GenStudio reported for a finished job. */
  | 'actual'
  /** The plan covers this action, so no credits will be spent. */
  | 'free'
  /** GenStudio published no price. Shown as such, never filled in. */
  | 'unpublished'

export interface CreditDisplay {
  /** Short line for a badge or a form row. */
  text: string
  basis: CreditBasis
  /** Longer explanation for a tooltip. Always says where the figure came from. */
  title: string
}

export const CREDIT_BASIS_LABEL: Record<CreditBasis, string> = {
  rate: 'Rate',
  estimate: 'Estimate',
  quote: 'Quote',
  'quoted-total': 'Quoted total',
  actual: 'Actual',
  free: 'Included',
  unpublished: 'Not reported',
}

export function formatCredits(credits: number): string {
  const rounded = Math.round(credits * 100) / 100
  return `${rounded.toLocaleString()} credit${rounded === 1 ? '' : 's'}`
}

function publishedNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** GenStudio published nothing — say exactly that, and stop. */
export function unpublishedCost(what = 'This action'): CreditDisplay {
  return {
    text: 'Price not reported',
    basis: 'unpublished',
    title: `${what} has no published price in the GenStudio catalogue. Story Studio does not estimate one. `
      + 'The charge GenStudio reports on the finished job is the authoritative figure.',
  }
}

export interface PricedImageModel {
  display_name?: string
  chargeable?: boolean
  unlimited_relaxed?: boolean
  credits_per_image?: number | null
  base_credits_per_image?: number | null
  promotion_name?: string
  promotion_discount_percent?: number
  reference_generation_credits?: number
}

export interface PricedImageOption {
  resolution?: string
  aspect_ratio?: string
  credits_per_image?: number
  base_credits_per_image?: number
  reference_generation_credits?: number
}

/**
 * Per-image price for the CURRENT model and output option.
 *
 * The option's own price wins — that is the price of the combination the
 * customer is looking at. The model-level figure is the fallback for a model
 * publishing no options, not an average to blend in.
 */
export function describeImageUnitCost(
  model: PricedImageModel | null | undefined,
  option: PricedImageOption | null | undefined,
  opts: { referenceGuided?: boolean } = {},
): CreditDisplay {
  if (!model) return unpublishedCost()
  const label = model.display_name || 'This model'
  if (model.chargeable === false) {
    return {
      text: 'No credit charge',
      basis: 'free',
      title: `GenStudio publishes ${label} as non-chargeable, so this render will not spend credits.`,
    }
  }

  const unit = publishedNumber(option?.credits_per_image) ?? publishedNumber(model.credits_per_image)
  if (unit === null) return unpublishedCost(label)

  const where = option?.resolution && option?.aspect_ratio
    ? `${option.resolution} at ${option.aspect_ratio}`
    : label
  let text = `${formatCredits(unit)} / image`
  const parts = [`GenStudio publishes ${formatCredits(unit)} per image for ${where}.`]

  const base = publishedNumber(option?.base_credits_per_image) ?? publishedNumber(model.base_credits_per_image)
  if (base !== null && base > unit) {
    const promotion = model.promotion_name?.trim()
    const percent = publishedNumber(model.promotion_discount_percent)
    text += ` (was ${formatCredits(base)})`
    parts.push(
      `The undiscounted price is ${formatCredits(base)}`
      + (promotion ? `, discounted by ${promotion}` : '')
      + (percent !== null ? ` (−${Math.round(percent * 10) / 10}%)` : '')
      + '.',
    )
  }

  if (opts.referenceGuided) {
    const reference = publishedNumber(option?.reference_generation_credits)
      ?? publishedNumber(model.reference_generation_credits)
    if (reference !== null) {
      text += ` + ${formatCredits(reference)} reference`
      parts.push(`Reference-guided renders carry a published surcharge of ${formatCredits(reference)}.`)
    }
  }

  if (model.unlimited_relaxed) {
    parts.push(
      'This model is Unlimited Relaxed eligible: GenStudio spends credits first and may run it at no credit cost '
      + 'once available credits cannot cover the request.',
    )
  }
  parts.push('GenStudio reports the charge it actually applied on the finished job.')
  return { text, basis: 'rate', title: parts.join(' ') }
}

/**
 * A batch's cost, labelled an ESTIMATE because it is one.
 *
 * The multiplication is Story Studio's arithmetic on GenStudio's published
 * unit price, not a charge GenStudio has agreed to. It is never presented as
 * the amount that will be billed, and the unit rate stays visible beside it.
 */
export function describeImageBatchEstimate(
  model: PricedImageModel | null | undefined,
  option: PricedImageOption | null | undefined,
  imageCount: number,
  opts: { referenceGuided?: boolean } = {},
): CreditDisplay {
  const unitDisplay = describeImageUnitCost(model, option, opts)
  const count = Math.max(0, Math.floor(imageCount))
  if (unitDisplay.basis !== 'rate' || count < 1) return unitDisplay

  const unit = publishedNumber(option?.credits_per_image) ?? publishedNumber(model?.credits_per_image)
  if (unit === null) return unitDisplay
  // Reference guidance is priced separately, and an unpublished surcharge is
  // NOT a free one. Adding 0 here quietly told the customer that reference-
  // guided generation costs the same as plain generation — the same "silent 0
  // reads as free" mistake as `credits ?? 0` on a quote. With no published
  // surcharge there is no total to state, so the unit rate stands alone.
  const reference = opts.referenceGuided
    ? (publishedNumber(option?.reference_generation_credits) ?? publishedNumber(model?.reference_generation_credits))
    : 0
  if (reference === null) return unitDisplay
  const estimate = (unit + reference) * count
  return {
    text: `Estimate ${formatCredits(estimate)} (${unitDisplay.text} × ${count.toLocaleString()})`,
    basis: 'estimate',
    title: `${unitDisplay.title} This total is Story Studio's own arithmetic over ${count.toLocaleString()} image(s) `
      + 'at that published rate — it is an estimate, not a charge GenStudio has quoted. '
      + 'Retries, replays and Relaxed eligibility all change what is actually spent.',
  }
}

/**
 * Chat cannot be estimated before it runs.
 *
 * The price is per token and the output length is unknown until the model has
 * written it, so there is no honest total to show. The rate is shown and the
 * total is explicitly deferred — a made-up number here would be worse than no
 * number at all.
 */
export function describeChatRate(model: {
  display_name?: string
  chargeable?: boolean
  unlimited_relaxed?: boolean
  input_credits_per_million_tokens?: number | null
  output_credits_per_million_tokens?: number | null
  minimum_credits?: number | null
} | null | undefined): CreditDisplay {
  if (!model) return unpublishedCost()
  const label = model.display_name || 'This model'
  if (model.chargeable === false) {
    return {
      text: 'No credit charge',
      basis: 'free',
      title: `GenStudio publishes ${label} as non-chargeable.`,
    }
  }
  const input = publishedNumber(model.input_credits_per_million_tokens)
  const output = publishedNumber(model.output_credits_per_million_tokens)
  if (input === null && output === null) return unpublishedCost(label)

  const rates: string[] = []
  if (input !== null) rates.push(`${formatCredits(input)} / 1M input tokens`)
  if (output !== null) rates.push(`${formatCredits(output)} / 1M output tokens`)
  const minimum = publishedNumber(model.minimum_credits)
  const parts = [
    `GenStudio publishes ${rates.join(' and ')} for ${label}.`,
    'The total depends on how long the prompt and the generated text turn out to be, '
    + 'which is not known until the model has written it, so Story Studio shows no up-front total. '
    + 'GenStudio reports the actual charge on the finished job.',
  ]
  if (minimum !== null && minimum > 0) parts.splice(1, 0, `A minimum of ${formatCredits(minimum)} applies per request.`)
  return {
    text: rates.join(' · '),
    basis: 'rate',
    title: parts.join(' '),
  }
}

/** Per-variant video price. `minimum_credits` is part of the price, not a footnote. */
export function describeVideoVariantRate(variant: {
  label?: string
  credits_per_video?: number | null
  minimum_credits?: number | null
} | null | undefined): CreditDisplay {
  const perVideo = publishedNumber(variant?.credits_per_video)
  if (perVideo === null) return unpublishedCost(variant?.label || 'This variant')
  const minimum = publishedNumber(variant?.minimum_credits)
  return {
    text: `${formatCredits(perVideo)} / clip`,
    basis: 'rate',
    title: `GenStudio publishes ${formatCredits(perVideo)} per clip`
      + (minimum !== null && minimum > 0 ? `, with a minimum of ${formatCredits(minimum)} per request` : '')
      + '. GenStudio reports the actual charge on the finished job.',
  }
}

/** TTS rate. A `/v1/tts/quotes` figure supersedes this — label that a quote. */
export function describeVoiceRate(model: {
  display_name?: string
  credits_per_1000_characters?: number | null
} | null | undefined): CreditDisplay {
  const rate = publishedNumber(model?.credits_per_1000_characters)
  if (rate === null) return unpublishedCost(model?.display_name || 'This voice model')
  return {
    text: `${formatCredits(rate)} / 1,000 characters`,
    basis: 'rate',
    title: `GenStudio publishes ${formatCredits(rate)} per 1,000 characters for ${model?.display_name || 'this model'}. `
      + 'Ask GenStudio for a quote to get the exact figure for a specific script; '
      + 'GenStudio reports the actual charge on the finished job.',
  }
}

/** An exact figure returned by a GenStudio quote endpoint. Never an estimate. */
export function describeQuotedCost(credits: number | null | undefined, what = 'this request'): CreditDisplay {
  const quoted = publishedNumber(credits)
  if (quoted === null) return unpublishedCost()
  return {
    text: `Quoted ${formatCredits(quoted)}`,
    basis: 'quote',
    title: `GenStudio quoted ${formatCredits(quoted)} for ${what}. This is GenStudio's own figure, not a Story Studio estimate.`,
  }
}

/**
 * Several GenStudio quotes, added up — the honest way to price work that is
 * submitted as several jobs.
 *
 * A long narration is not one TTS request: Story Studio splits it at the
 * selected model's published `maximum_input_characters` and submits one job per
 * piece, each billed separately and each carrying that model's published
 * per-job minimum. So GenStudio is asked to quote every piece and those exact
 * figures are added together.
 *
 * This is deliberately NOT `estimate`. An estimate is Story Studio multiplying
 * a published rate by a count it happens to know — arithmetic GenStudio never
 * agreed to. Here every addend is a figure GenStudio returned for a request
 * that will actually be sent; the addition is the only local step, and the
 * caller is told so in as many words.
 */
export function describeQuotedTotal(
  parts: Array<{ credits: number | null | undefined }>,
  what = 'this narration',
): CreditDisplay {
  if (!parts.length) return unpublishedCost()
  // A part GenStudio did not price contributes NOTHING to a figure labelled
  // "sum of N GenStudio quotes" — and adding 0 for it produced a total that was
  // quietly too low while still claiming every job had been quoted. One
  // unpriced part means there is no total, only quotes for some of the work.
  const published = parts.map(part => publishedNumber(part.credits))
  if (published.some(credits => credits === null)) return unpublishedCost()
  const credits = published.reduce((sum: number, part) => sum + (part as number), 0)
  const count = parts.length
  if (count === 1) return describeQuotedCost(credits, what)
  return {
    text: `Quoted ${formatCredits(credits)} · sum of ${count} GenStudio quotes`,
    basis: 'quoted-total',
    title: `${what.charAt(0).toUpperCase()}${what.slice(1)} will be submitted as ${count} separate GenStudio jobs, `
      + `and GenStudio quoted every one of them — ${count} exact figures for ${count} requests that will actually be sent. `
      + 'Story Studio added those figures together and did nothing else: no rate was multiplied out and no number was '
      + 'derived here, so this is a total of quotes, not an estimate. Each job carries GenStudio\'s published per-job '
      + 'minimum in its own right, which is why the parts are quoted separately instead of the whole script being '
      + 'priced at once. GenStudio reports the actual charge on each finished job.',
  }
}

/** The `credit_cost` GenStudio reported for a job that has already run. */
export function describeActualCost(credits: number | null | undefined): CreditDisplay {
  const actual = publishedNumber(credits)
  if (actual === null) {
    return {
      text: 'Charge not reported',
      basis: 'unpublished',
      title: 'GenStudio reported no credit cost for this job. Story Studio does not reconstruct one; '
        + 'the Usage page carries the authoritative settlement.',
    }
  }
  return {
    text: `Charged ${formatCredits(actual)}`,
    basis: 'actual',
    title: `GenStudio reported ${formatCredits(actual)} for this job. Reservations settle on the Usage page.`,
  }
}
