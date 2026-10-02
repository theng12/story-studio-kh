/**
 * What a model costs, in the provider's own USD (gateway 0.2.82+).
 *
 * A row carries three additive keys:
 *   price_source  "provider" | "local" | "unpublished"
 *   price_usd     USD by unit (`input_per_1m_tokens`, `per_image`, ...) or null
 *   price_as_of   when the provider last stated it
 *
 * The zero-valued `credits_*` fields on the same row are parser shapes, NOT
 * prices. Nothing here (or anywhere that calls this) may read one as "free".
 * A row without `price_source` (an older gateway) has no USD truth at all and
 * the credit display keeps working exactly as before.
 *
 * Pure functions of the row: a model switch recomputes them, no cache.
 */
import type { CreditDisplay } from './genstudio-credit-cost.js'

/** One stated number for a row: USD, or the page's own words (`unit_text`) for a unit that is not USD per contract unit. */
export interface PriceVariant { unit: string; variant: string; usd?: number; unit_text?: string; source_url?: string }

export interface PriceTruth {
  price_source?: 'provider' | 'provider_page' | 'local' | 'unpublished'
  price_usd?: Record<string, number> | null
  price_as_of?: string | null
  /** `provider_page` (gateway 0.2.83): the pricing page the number was read from. */
  price_url?: string | null
  /** `provider_page`: a unit the page prices several ways (size / quality / tier). Never picked between. */
  price_variants?: PriceVariant[] | null
}

export function hasPriceTruth(model: PriceTruth | null | undefined): boolean {
  const source = model?.price_source
  return source === 'provider' || source === 'provider_page' || source === 'local' || source === 'unpublished'
}

/** 0.075 -> "0.075", 2 -> "2.00", 1e-7 -> "0.0000001"; ten places so a job cost is not truncated. Never rounds a stated price away. */
export function formatUsd(amount: number): string {
  const fixed = amount.toFixed(10).replace(/0+$/, '')
  const [whole, fraction = ''] = fixed.split('.')
  return `$${whole}.${fraction.padEnd(2, '0')}`
}

const UNIT_ORDER: Array<[string, string]> = [
  ['input_per_1m_tokens', '/ 1M input tokens'],
  ['output_per_1m_tokens', '/ 1M output tokens'],
  ['per_image', '/ image'],
  ['per_video', '/ video'],
  ['per_second', '/ second'],
  ['per_1k_chars', '/ 1,000 characters'],
  ['per_request', '/ request'],
]
const CACHED_INPUT = 'cached_input_per_1m_tokens'

function asOfDate(value: string | null | undefined): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return text && !Number.isNaN(Date.parse(text)) ? text.slice(0, 10) : null
}

/** "$0.04 / image" for one stated number, in the unit's own words. */
function priced(unit: string, amount: number): string {
  const suffix = UNIT_ORDER.find(([key]) => key === unit)?.[1]
  return suffix ? `${formatUsd(amount)} ${suffix}` : `${formatUsd(amount)} (${unit})`
}

/** Null when the row has no price truth (older gateway): the caller falls back to its credit display. */
export function describeUsdPrice(model: (PriceTruth & { display_name?: string }) | null | undefined): CreditDisplay | null {
  if (!model || !hasPriceTruth(model)) return null
  const label = model.display_name || 'This model'
  if (model.price_source === 'local') {
    return {
      text: 'Free — your fleet',
      basis: 'local',
      title: `${label} runs on your own Macs, so it costs nothing per use.`,
    }
  }
  const usd = model.price_usd ?? {}
  const variants = Array.isArray(model.price_variants) ? model.price_variants : []
  if (model.price_source === 'unpublished' || (!Object.keys(usd).length && !variants.length)) {
    return {
      text: 'Price not published',
      basis: 'not-published',
      title: `Nobody has published a price for ${label}. Story Studio does not estimate one. `
        + 'The cost the provider reports on a finished job is shown when it states one.',
    }
  }
  const parts = [
    ...UNIT_ORDER.filter(([key]) => key in usd).map(([key]) => priced(key, usd[key]!)),
    // A unit this build does not know is shown by its own name, never dropped.
    ...Object.keys(usd).filter(key => !UNIT_ORDER.some(([known]) => known === key) && key !== CACHED_INPUT).map(key => priced(key, usd[key]!)),
  ]
  const date = asOfDate(model.price_as_of)
  const isPage = model.price_source === 'provider_page'
  const url = isPage && typeof model.price_url === 'string' && /^https?:\/\//i.test(model.price_url) ? model.price_url : undefined
  // A unit the page prices several ways is "varies": every stated number is listed, none is picked.
  // Only the ones `price_usd` does not already state as a single number.
  const varying = variants.filter(v => !(v.unit in usd))
  const variantLines = varying.map(v => `${typeof v.usd === 'number' ? priced(v.unit, v.usd) : v.unit_text} — ${v.variant}`)
  const shown = parts.length ? parts.join(' · ') : 'Price varies'
  const origin = isPage ? `from pricing page${date ? `, ${date}` : ''}` : (date ? `as of ${date}` : '')
  const cached = usd[CACHED_INPUT]
  const title = `${isPage ? 'The provider\'s pricing page' : 'The provider'} states ${parts.join(' and ') || 'several prices'} for ${label}`
    + (cached === undefined ? '' : `, and ${formatUsd(cached)} / 1M cached input tokens`)
    + (variantLines.length ? `. It varies: ${variantLines.join('; ')}` : '')
    + (date ? `, ${isPage ? 'read on' : 'as of'} ${date}` : '')
    + (isPage ? `. Read from ${url ?? 'the provider\'s pricing page'}, not from the provider\'s API, so it can be out of date.`
      : '. It refreshes with the model list, so it can be a few days old.')
    + ' The provider reports the actual charge on the finished job.'
  const free = !variants.length && parts.length > 0 && Object.values(usd).every(amount => amount === 0)
  return {
    text: free ? 'Free — the provider states $0' : `${shown}${origin ? ` · ${origin}` : ''}`,
    basis: free ? 'free' : isPage ? 'provider-page' : 'provider',
    title,
    ...(url ? { url } : {}),
    ...(variantLines.length ? { variants: variantLines } : {}),
  }
}

/** A finished job's cost, only when the provider stated it. Absent means "not stated", never $0. */
export function describeJobCostUsd(job: { cost_usd?: unknown; cost_source?: unknown } | null | undefined): string {
  const cost = job?.cost_usd
  return job?.cost_source === 'provider' && typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
    ? `${formatUsd(cost)} provider cost`
    : ''
}

// ── Pipeline Run Batch estimate ─────────────────────────────────────────

/** Which catalogue prices a paid step, and the price unit that matches what the step consumes. */
export type EstimateCatalog = 'chat' | 'image' | 'tts' | 'video'
export const ESTIMATE_STEPS: Record<string, { catalog: EstimateCatalog; unit?: string; unitNote: string }> = {
  research: { catalog: 'chat', unitNote: 'priced per token; length is not known before the run' },
  'script-only': { catalog: 'chat', unitNote: 'priced per token; length is not known before the run' },
  'introduction-only': { catalog: 'chat', unitNote: 'priced per token; length is not known before the run' },
  image_prompts: { catalog: 'chat', unitNote: 'priced per token; length is not known before the run' },
  metadata: { catalog: 'chat', unitNote: 'priced per token; length is not known before the run' },
  scene_plan: { catalog: 'chat', unitNote: 'priced per token; length is not known before the run' },
  contextual_cues: { catalog: 'chat', unitNote: 'priced per token; length is not known before the run' },
  thumb_images: { catalog: 'image', unit: 'per_image', unitNote: 'the number of thumbnails is not known before the run' },
  scene_review: { catalog: 'image', unit: 'per_image', unitNote: 'the number of scenes is not known until Scene Plan has run' },
  audio: { catalog: 'tts', unit: 'per_1k_chars', unitNote: 'the narration length is not known before the run' },
  motion_review: { catalog: 'video', unit: 'per_video', unitNote: 'the number of scenes is not known until Scene Plan has run' },
}

/** One episode that still has work to do for the step (finished ones are left out by the caller). */
export interface EstimateEpisode { scenesTotal: number; scenesPresent: number }

/**
 * Units a step will consume across the episodes, only where Story Studio
 * genuinely knows them: one image per missing scene, one clip per scene.
 * Anything else is null — "not known", which the estimate lists as not included.
 */
export function stepQuantity(stepId: string, episodes: EstimateEpisode[], force: boolean): number | null {
  if (stepId !== 'scene_review' && stepId !== 'motion_review') return null
  let total = 0
  for (const ep of episodes) {
    if (!(ep.scenesTotal > 0)) return null
    total += stepId === 'scene_review' && !force ? Math.max(0, ep.scenesTotal - ep.scenesPresent) : ep.scenesTotal
  }
  return total
}

export interface EstimateStep {
  id: string
  label: string
  /** The resolved model's price truth; null when the step's model could not be resolved. */
  model: PriceTruth | null
  /** The `price_usd` key that matches what the step consumes; absent when it maps to no single unit. */
  unit?: string
  /** Total units the step consumes across the run; null when not known. */
  quantity: number | null
  /** Why the step's price cannot be used even before looking at the model. */
  unitNote: string
  /** Set when something else decides the model for this run (a model policy). */
  modelOverride?: string
}

export interface BatchEstimate {
  totalUsd: number
  priced: Array<{ id: string; label: string; usd: number; detail: string }>
  free: Array<{ id: string; label: string }>
  notIncluded: Array<{ id: string; label: string; reason: string }>
}

/** Sum of known per-unit prices × units. A step that cannot be priced honestly is listed, never guessed. */
export function estimateBatchUsd(steps: EstimateStep[]): BatchEstimate {
  // model-drift-allow: the empty sum an estimate starts from, not a price
  const out: BatchEstimate = { totalUsd: 0, priced: [], free: [], notIncluded: [] }
  for (const step of steps) {
    const skip = (reason: string) => out.notIncluded.push({ id: step.id, label: step.label, reason })
    if (step.modelOverride) { skip(step.modelOverride); continue }
    const model = step.model
    if (!model || !hasPriceTruth(model)) { skip('no price from the gateway for the chosen model'); continue }
    if (model.price_source === 'local') { out.free.push({ id: step.id, label: step.label }); continue }
    const usd = model.price_usd
    const variants = Array.isArray(model.price_variants) ? model.price_variants : []
    if (model.price_source === 'unpublished' || (!usd || !Object.keys(usd).length) && !variants.length) { skip('price not published'); continue }
    if (!variants.length && Object.values(usd ?? {}).every(amount => amount === 0)) { out.free.push({ id: step.id, label: step.label }); continue }
    const price = step.unit ? usd?.[step.unit] : undefined
    if (price === undefined) {
      const varying = variants.filter(v => !(usd && v.unit in usd))
      skip(varying.length
        ? `price varies: see variants (${varying.map(v => v.variant).join(', ')})`
        : step.unit ? `the provider prices this model differently (${Object.keys(usd ?? {}).join(', ')})` : step.unitNote)
      continue
    }
    if (step.quantity === null || !Number.isFinite(step.quantity)) { skip(step.unitNote); continue }
    const cost = price * step.quantity
    out.totalUsd += cost
    out.priced.push({
      id: step.id, label: step.label, usd: cost,
      detail: `${formatUsd(price)} × ${step.quantity.toLocaleString()} ${step.unit!.replace('per_', '').replace('1k_chars', '1,000 characters')}${model.price_source === 'provider_page' ? ', from the provider’s pricing page' : ''}`,
    })
  }
  return out
}

/**
 * A model that costs nothing to run, so quote/credit UI is noise. The gateway
 * says `chargeable: false` for free chat; media rows from the owner's own Studio
 * Hub fleet still say `chargeable: true`, so a published `studio-hub*` provider
 * or `price_source: "local"` also counts as free. Display only, never dispatch.
 */
export function isFreeToRun(model: (PriceTruth & { chargeable?: boolean; provider_id?: string; provider?: string }) | null | undefined): boolean {
  if (!model) return false
  if (model.chargeable === false || model.price_source === 'local') return true
  return [model.provider_id, model.provider].some(id => typeof id === 'string' && id.startsWith('studio-hub'))
}
