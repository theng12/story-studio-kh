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

import type { PriceTruth } from './genstudio-price-usd.js'
import { describeUsdPrice } from './genstudio-price-usd.js'

export type CreditBasis =
  /** The provider's own USD price (gateway `price_source: "provider"`). Never a credit figure. */
  | 'provider'
  /** Read from the provider's own pricing page (gateway `price_source: "provider_page"`). */
  | 'provider-page'
  /** Runs on the owner's own Macs (`price_source: "local"`): no per-use cost. */
  | 'local'
  /** Nobody stated a price. Neutral on purpose: unlike `unpublished`, not styled as a warning. */
  | 'not-published'
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
  /** Commercial terms that must remain visible without relying on hover. */
  notice?: string
  /** The pricing page a `provider-page` price was read from. */
  url?: string
  /** One line per stated variant when a unit is priced several ways ("$0.04 / image — 1K"). */
  variants?: string[]
}

export const CREDIT_BASIS_LABEL: Record<CreditBasis, string> = {
  provider: 'Provider price',
  'provider-page': 'Pricing page',
  local: 'Cost',
  'not-published': 'Cost',
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

/*
 * A row that carries gateway price truth (`price_source`) is priced in USD by what the provider
 * stated. Its `credits_*` fields are zero-valued parser shapes, so every describer below asks
 * `describeUsdPrice` first and never lets them reach a credit display.
 */
function publishedNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** GenStudio published nothing — say exactly that, and stop. */
export function unpublishedCost(what = 'This action'): CreditDisplay {
  return {
    text: 'Price not reported',
    basis: 'unpublished',
    title: `${what} has no published price in the Gateway catalogue. Story Studio does not estimate one. `
      + 'The charge the Gateway reports on the finished job is the authoritative figure.',
  }
}

export interface PricedImageModel extends PriceTruth {
  display_name?: string
  chargeable?: boolean
  credits_per_image?: number | null
  base_credits_per_image?: number | null
  promotion_name?: string
  promotion_discount_percent?: number
  reference_generation_credits?: number
  output_options?: PricedImageOption[]
}

export interface PricedImageOption {
  resolution?: string
  aspect_ratio?: string
  credits_per_image?: number
  base_credits_per_image?: number
  reference_generation_credits?: number
}

/**
 * Per-image rate summary for choosing a MODEL before choosing its output size.
 *
 * When every published output row carries a price, the model menu shows their
 * complete min–max range. This avoids presenting the default 1K price as if it
 * also covered a more expensive 2K choice. The exact selected row is still
 * priced separately by `describeImageUnitCost`.
 */
export function describeImageModelRate(
  model: PricedImageModel | null | undefined,
  opts: { referenceGuided?: boolean } = {},
): CreditDisplay {
  const usd = describeUsdPrice(model)
  if (usd) return usd
  if (!model || model.chargeable === false) return describeImageUnitCost(model, null, opts)

  const options = Array.isArray(model.output_options) ? model.output_options : []
  const label = model.display_name || 'This model'
  if (opts.referenceGuided) {
    const modelReferenceRate = publishedNumber(model.reference_generation_credits)
    const hasUnpricedReference = options.length
      ? options.some(option => publishedNumber(option.reference_generation_credits) === null && modelReferenceRate === null)
      : modelReferenceRate === null
    if (hasUnpricedReference) return unpublishedCost(label)
  }
  if (!options.length || options.some(option => publishedNumber(option.credits_per_image) === null)) {
    return describeImageUnitCost(model, null, opts)
  }

  const prices = options.map((option) => {
    if (!opts.referenceGuided) return publishedNumber(option.credits_per_image) as number
    return publishedNumber(option.reference_generation_credits)
      ?? publishedNumber(model.reference_generation_credits)
  })
  const minimum = Math.min(...prices)
  const maximum = Math.max(...prices)
  const text = minimum === maximum
    ? `${formatCredits(minimum)} / image`
    : `${formatCredits(minimum).replace(/ credits?$/, '')}–${formatCredits(maximum)} / image by output size`

  return {
    text,
    basis: 'rate',
    title: minimum === maximum
      ? `The Gateway publishes ${formatCredits(minimum)} per image for every listed output size for ${label}. `
        + 'The Gateway reports the charge it actually applied on the finished job.'
      : `The Gateway publishes rates from ${formatCredits(minimum)} to ${formatCredits(maximum)} per image for ${label}, depending on output size. `
        + 'The output-size picker shows the exact published rate for the output size you choose. '
        + 'The Gateway reports the charge it actually applied on the finished job.',
  }
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
  const usd = describeUsdPrice(model)
  if (usd) return usd
  if (!model) return unpublishedCost()
  const label = model.display_name || 'This model'
  if (model.chargeable === false) {
    return {
      text: 'No credit charge',
      basis: 'free',
      title: `The Gateway publishes ${label} as non-chargeable, so this render will not spend credits.`,
    }
  }

  const unit = opts.referenceGuided
    ? (publishedNumber(option?.reference_generation_credits) ?? publishedNumber(model.reference_generation_credits))
    : (publishedNumber(option?.credits_per_image) ?? publishedNumber(model.credits_per_image))
  if (unit === null) return unpublishedCost(label)

  const where = option?.resolution && option?.aspect_ratio
    ? `${option.resolution} at ${option.aspect_ratio}`
    : label
  let text = `${formatCredits(unit)} / image`
  const parts = [`The Gateway publishes ${formatCredits(unit)} per image for ${where}.`]

  const base = opts.referenceGuided
    ? null
    : (publishedNumber(option?.base_credits_per_image) ?? publishedNumber(model.base_credits_per_image))
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

  if (opts.referenceGuided) parts[0] = `The Gateway publishes ${formatCredits(unit)} per reference-guided image for ${where}.`

  parts.push('The Gateway reports the charge it actually applied on the finished job.')
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

  const unit = opts.referenceGuided
    ? (publishedNumber(option?.reference_generation_credits) ?? publishedNumber(model?.reference_generation_credits))
    : (publishedNumber(option?.credits_per_image) ?? publishedNumber(model?.credits_per_image))
  if (unit === null) return unitDisplay
  const estimate = unit * count
  return {
    text: `Estimate ${formatCredits(estimate)} (${unitDisplay.text} × ${count.toLocaleString()})`,
    basis: 'estimate',
    title: `${unitDisplay.title} This total is Story Studio's own arithmetic over ${count.toLocaleString()} image(s) `
      + 'at that published rate — it is an estimate, not a charge the Gateway has quoted. '
      + 'Retries and replays can change what is actually spent.',
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
export function describeChatRate(model: PriceTruth & {
  display_name?: string
  chargeable?: boolean
  input_credits_per_million_tokens?: number | null
  output_credits_per_million_tokens?: number | null
  /**
   * The undiscounted rates, published only while GenStudio is applying a sale
   * to this account. Same "(was X)" treatment images and music already give a
   * sale price — see `describeImageUnitCost` and `describeMusicUnitCost`.
   * Chat carries two of them because chat prices two rates, not one.
   */
  standard_input_credits_per_million_tokens?: number | null
  standard_output_credits_per_million_tokens?: number | null
  minimum_credits?: number | null
} | null | undefined): CreditDisplay {
  const usd = describeUsdPrice(model)
  if (usd) return usd
  if (!model) return unpublishedCost()
  const label = model.display_name || 'This model'
  if (model.chargeable === false) {
    return {
      text: 'No credit charge',
      basis: 'free',
      title: `The Gateway publishes ${label} as non-chargeable.`,
    }
  }
  const input = publishedNumber(model.input_credits_per_million_tokens)
  const output = publishedNumber(model.output_credits_per_million_tokens)
  if (input === null && output === null) return unpublishedCost(label)

  // A sale is only a sale when the list price is genuinely higher than what is
  // being charged — the rule music already applies. A `standard_` figure equal
  // to (or below) the charge is the same price restated, and printing "(was 8
  // credits)" beside 8 credits would be a discount tag on no discount.
  const wasSuffix = (unit: number | null, standard: number | null | undefined): string => {
    const listed = publishedNumber(standard)
    return unit !== null && listed !== null && listed > unit ? ` (was ${formatCredits(listed)})` : ''
  }
  const inputWas = wasSuffix(input, model.standard_input_credits_per_million_tokens)
  const outputWas = wasSuffix(output, model.standard_output_credits_per_million_tokens)

  const rates: string[] = []
  if (input !== null) rates.push(`${formatCredits(input)}${inputWas} / 1M input tokens`)
  if (output !== null) rates.push(`${formatCredits(output)}${outputWas} / 1M output tokens`)
  const minimum = publishedNumber(model.minimum_credits)
  const parts = [
    `The Gateway publishes ${rates.join(' and ')} for ${label}.`,
    'The total depends on how long the prompt and the generated text turn out to be, '
    + 'which is not known until the model has written it, so Story Studio shows no up-front total. '
    + 'The Gateway reports the actual charge on the finished job.',
  ]
  if (inputWas || outputWas) {
    parts.splice(1, 0, 'The figures in brackets are the undiscounted prices the Gateway publishes for this product; '
      + 'the rates above them are what this account is charged today.')
  }
  if (minimum !== null && minimum > 0) parts.splice(1, 0, `A minimum of ${formatCredits(minimum)} applies per request.`)
  return {
    text: rates.join(' · '),
    basis: 'rate',
    title: parts.join(' '),
  }
}

/**
 * Per-clip rate summary for choosing a VIDEO MODEL before its duration and
 * resolution variant. As with image output sizes, a range is only honest when
 * every published variant has a published price; the variant selector then
 * shows the exact row that will be submitted.
 */
export function describeVideoModelRate(model: PriceTruth & {
  display_name?: string
  variants?: Array<{
    credits_per_video?: number | null
  }>
} | null | undefined): CreditDisplay {
  const usd = describeUsdPrice(model)
  if (usd) return usd
  const label = model?.display_name || 'This video model'
  const variants = Array.isArray(model?.variants) ? model.variants : []
  if (!variants.length) return unpublishedCost(label)

  const prices = variants.map(variant => publishedNumber(variant.credits_per_video))
  if (prices.some(price => price === null)) return unpublishedCost(label)

  const minimum = Math.min(...prices as number[])
  const maximum = Math.max(...prices as number[])
  const text = minimum === maximum
    ? `${formatCredits(minimum)} / clip`
    : `${formatCredits(minimum).replace(/ credits?$/, '')}–${formatCredits(maximum)} / clip by duration and resolution`
  return {
    text,
    basis: 'rate',
    title: minimum === maximum
      ? `The Gateway publishes ${formatCredits(minimum)} per clip for every listed duration and resolution for ${label}. `
        + 'The variant selector shows that row’s published per-request minimum.'
      : `The Gateway publishes rates from ${formatCredits(minimum)} to ${formatCredits(maximum)} per clip for ${label}, depending on duration and resolution. `
        + 'The variant selector shows the exact published rate for the duration and resolution you choose, including its per-request minimum.',
  }
}

/**
 * Web research has two independently published rates. The provider chooses
 * how many searches a run makes, so these stay rates rather than a locally
 * multiplied total.
 */
export function describeWebResearchRate(model: {
  display_name?: string
  credits_per_request?: number | null
  credits_per_search?: number | null
} | null | undefined): CreditDisplay {
  const label = model?.display_name || 'This web-research model'
  const perRequest = publishedNumber(model?.credits_per_request)
  const perSearch = publishedNumber(model?.credits_per_search)
  if (perRequest === null && perSearch === null) return unpublishedCost(label)

  const rates = [
    perRequest === null ? '' : `${formatCredits(perRequest)} / request`,
    perSearch === null ? '' : `${formatCredits(perSearch)} / search`,
  ].filter(Boolean)
  return {
    text: rates.join(' · '),
    basis: perRequest === 0 && perSearch === 0 ? 'free' : 'rate',
    title: `The Gateway publishes ${rates.join(' and ')} for ${label}. `
      + 'The provider decides how many searches to make, so there is no up-front total. '
      + 'The Gateway reports the actual charge on the finished job.',
  }
}

/** TTS rate. A `/v1/tts/quotes` figure supersedes this — label that a quote. */
export function describeVoiceRate(model: PriceTruth & {
  display_name?: string
  credits_per_1000_characters?: number | null
  standard_credits?: number | null
  sale_credits?: number | null
  sale_ends_at?: string | null
  sale_disclaimer?: string | null
} | null | undefined): CreditDisplay {
  const usd = describeUsdPrice(model)
  if (usd) return usd
  const rate = publishedNumber(model?.credits_per_1000_characters)
  if (rate === null) return unpublishedCost(model?.display_name || 'This voice model')
  let text = `${formatCredits(rate)} / 1,000 characters`
  const parts = [
    `The Gateway publishes ${formatCredits(rate)} per 1,000 characters for ${model?.display_name || 'this model'}.`,
  ]
  const notices: string[] = []
  const standard = publishedNumber(model?.standard_credits)
  const sale = publishedNumber(model?.sale_credits)
  if (standard !== null && standard > rate) {
    text += ` (was ${formatCredits(standard)})`
    const priceNotice = `The undiscounted price is ${formatCredits(standard)}${sale === rate ? `, on sale at ${formatCredits(sale)}` : ''}.`
    parts.push(priceNotice)
    notices.push(priceNotice)
    const endsAt = model?.sale_ends_at?.trim()
    if (endsAt) {
      const when = new Date(endsAt)
      const endNotice = Number.isNaN(when.getTime()) ? `The sale ends ${endsAt}.` : `The sale ends ${when.toLocaleDateString()}.`
      parts.push(endNotice)
      notices.push(endNotice)
    }
  }
  const disclaimer = model?.sale_disclaimer?.trim()
  if (disclaimer) {
    parts.push(disclaimer)
    notices.push(disclaimer)
  }
  parts.push(
    'Ask the Gateway for a quote to get the exact figure for a specific script; '
      + 'the Gateway reports the actual charge on the finished job.',
  )
  return {
    text,
    basis: 'rate',
    title: parts.join(' '),
    notice: notices.join(' ') || undefined,
  }
}

/** An exact figure returned by a GenStudio quote endpoint. Never an estimate. */
export function describeQuotedCost(credits: number | null | undefined, what = 'this request'): CreditDisplay {
  const quoted = publishedNumber(credits)
  if (quoted === null) return unpublishedCost()
  return {
    text: `Quoted ${formatCredits(quoted)}`,
    basis: 'quote',
    title: `The Gateway quoted ${formatCredits(quoted)} for ${what}. This is the Gateway's own figure, not a Story Studio estimate.`,
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
    text: `Quoted ${formatCredits(credits)} · sum of ${count} the Gateway quotes`,
    basis: 'quoted-total',
    title: `${what.charAt(0).toUpperCase()}${what.slice(1)} will be submitted as ${count} separate Gateway jobs, `
      + `and the Gateway quoted every one of them — ${count} exact figures for ${count} requests that will actually be sent. `
      + 'Story Studio added those figures together and did nothing else: no rate was multiplied out and no number was '
      + 'derived here, so this is a total of quotes, not an estimate. Each job carries the Gateway\'s published per-job '
      + 'minimum in its own right, which is why the parts are quoted separately instead of the whole script being '
      + 'priced at once. The Gateway reports the actual charge on each finished job.',
  }
}

/** The `credit_cost` GenStudio reported for a job that has already run. */
export function describeActualCost(credits: number | null | undefined): CreditDisplay {
  const actual = publishedNumber(credits)
  if (actual === null) {
    return {
      text: 'Charge not reported',
      basis: 'unpublished',
      title: 'The Gateway reported no credit cost for this job. Story Studio does not reconstruct one; '
        + 'the Usage page carries the authoritative settlement.',
    }
  }
  return {
    text: `Charged ${formatCredits(actual)}`,
    basis: 'actual',
    title: `The Gateway reported ${formatCredits(actual)} for this job. Reservations settle on the Usage page.`,
  }
}

export interface PricedMusicModel extends PriceTruth {
  display_name?: string
  credits_per_request?: number | null
  /** Undiscounted list price. Present whether or not a sale is running. */
  standard_credits?: number | null
  /** Discounted price while the sale is on. */
  sale_credits?: number | null
  sale_ends_at?: string | null
  sale_disclaimer?: string | null
  outputs_per_request?: number | null
  /** Published capability facts; null/absent means not stated. */
  requires_lyrics?: boolean | null
  supports_instrumental?: boolean | null
}

/**
 * Per-song price for a music model, with the sale shown AS a sale.
 *
 * The owner's ruling, verbatim: "use the full price so the customer see the
 * full price with a discount tag on it." Images have done this since the first
 * promotion landed — `describeImageUnitCost` prints "4 credits / image (was 6
 * credits)". Music published the same information under different field names
 * (`standard_credits` / `sale_credits` / `sale_ends_at` / `sale_disclaimer`)
 * and the backend has parsed all four correctly the whole time; the music page
 * simply never showed a number at all, sale or otherwise. So a customer on a
 * sale price could not tell it was a sale, and a customer paying list could
 * not tell they had missed one.
 *
 * This deliberately mirrors the image function's SHAPE rather than inventing a
 * second pattern: same `CreditDisplay` return, same "(was X)" suffix in `text`,
 * same explanation folded into `title` for the native tooltip.
 *
 * The unit is "per song request" rather than "per song": `credits_per_request`
 * is what GenStudio charges per submitted request, and some music products
 * return more than one variation for that single charge. Calling it "per song"
 * would understate what the customer gets and overstate what a song costs.
 */
export function describeMusicUnitCost(model: PricedMusicModel | null | undefined): CreditDisplay {
  const usd = describeUsdPrice(model)
  if (usd) return usd
  if (!model) return unpublishedCost()
  const label = model.display_name || 'This model'

  const unit = publishedNumber(model.credits_per_request)
  if (unit === null) return unpublishedCost(label)

  let text = `${formatCredits(unit)} / song request`
  const parts = [`The Gateway publishes ${formatCredits(unit)} per song request for ${label}.`]

  // A sale is only a sale when the list price is genuinely higher than what is
  // being charged. `standard_credits` equal to the charge is just the list
  // price restated, and printing "(was 50 credits)" beside 50 credits would be
  // a discount tag on no discount.
  const standard = publishedNumber(model.standard_credits)
  const sale = publishedNumber(model.sale_credits)
  if (standard !== null && standard > unit) {
    text += ` (was ${formatCredits(standard)})`
    const saving = sale !== null && sale === unit
      ? `, on sale at ${formatCredits(sale)}`
      : ''
    parts.push(`The undiscounted price is ${formatCredits(standard)}${saving}.`)
    const endsAt = model.sale_ends_at?.trim()
    if (endsAt) {
      const when = new Date(endsAt)
      parts.push(Number.isNaN(when.getTime())
        ? `The sale ends ${endsAt}.`
        : `The sale ends ${when.toLocaleDateString()}.`)
    }
  }

  const disclaimer = model.sale_disclaimer?.trim()
  if (disclaimer) parts.push(disclaimer)

  parts.push('The Gateway reports the charge it actually applied on the finished job.')
  return { text, basis: 'rate', title: parts.join(' ') }
}
