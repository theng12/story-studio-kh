/**
 * Web-research capability boundary.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * A GenStudio language product may be used for evidence-backed ("Search the
 * web") research ONLY when it passes ALL SEVEN published conditions, which are
 * GenStudio's own picker filter, in its order:
 *
 *   1. available                        — the product is usable at all
 *   2. !locked                          — this account may use it
 *   3. !qualification_only              — it is customer-live, not internal review
 *   4. supports_web_search              — it can search
 *   5. returns_citations                — it reports what it read
 *   6. citation_format === 'structured' — those citations are machine-readable
 *   7. research_qualified               — GenStudio has qualified it for research
 *
 * Condition 2 is DEFENSIVE. GenStudio states it should never publish a
 * research-qualified product that is also qualification-only, so this should
 * never be the deciding condition — but a product visible only for internal
 * qualification must not become selectable here if that ever slips.
 *
 * The filter is CAPABILITY-ONLY. Never match on provider or model name: a name
 * is not a promise, and hardcoding one would silently break the moment
 * GenStudio renames or re-routes a product.
 *
 * ── Availability is the catalogue's answer, never a snapshot ────────────────
 * Web search is LIVE on GenStudio and qualified products are in use. It was not
 * always: this shipped with every product publishing `research_qualified:
 * false`, and it turned itself on with no Story Studio code change and no
 * release when GenStudio flipped the flag — which is the whole design. Both
 * states are first-class. "Nothing qualifies" is still rendered as a plain
 * explanation rather than an error, because a catalogue can go back to it.
 * Nothing in Story Studio may assume either answer ahead of the read.
 *
 * ── What this module does NOT do ────────────────────────────────────────────
 * It never computes a customer charge. `web_search_credits_per_search` and
 * `web_research_credits_per_request` are both RATES that are quoted to the
 * user before the run; the provider decides how many searches to make, so no
 * honest total exists in advance. The ACTUAL charge comes back from GenStudio
 * after the run, or is reported as unknown.
 */

import type { GenStudioChatModel, GenStudioCitation, GenStudioWebSearchBlock } from '../../lib/genstudio-client.js'
import type { ResearchCitation, ResearchWebSearchSettings } from '../../models/types.js'
import { sanitizeResearchCitations } from './urls.js'

/** Shown wherever web mode is offered but nothing qualifies. Deliberately
 *  explains the situation instead of reading as a failure. */
export const WEB_MODE_UNAVAILABLE_REASON =
  'No evidence-backed model is currently available. Searching the web needs a Gateway model that '
  + 'returns structured citations and has been qualified for research; none of your published models offers '
  + 'that yet. It turns on by itself here as soon as one does.'

/** Shown when the catalogue itself could not be read. Distinct from "nothing
 *  qualifies" — an unreachable catalogue is a connection problem, and telling
 *  the user "nothing qualifies" would be a guess. */
export const WEB_MODE_CATALOG_UNAVAILABLE_REASON =
  'Could not check which models can search the web — the Gateway catalog was unreachable. '
  + 'Model-knowledge research still works.'

/** The seven published conditions, one per entry, so a caller (or a test) can
 *  ask WHICH condition excluded a product rather than only that it failed. */
export const WEB_RESEARCH_CONDITIONS: ReadonlyArray<{
  readonly id: string
  readonly label: string
  readonly test: (model: GenStudioChatModel) => boolean
}> = [
  { id: 'available', label: 'published and available', test: m => m.available === true },
  { id: 'account_unlocked', label: 'unlocked for this account', test: m => m.locked !== true },
  {
    id: 'qualification_only',
    label: 'released to customers (not qualification-only)',
    test: m => m.qualification_only !== true,
  },
  { id: 'supports_web_search', label: 'can search the web', test: m => m.supports_web_search === true },
  { id: 'returns_citations', label: 'returns citations', test: m => m.returns_citations === true },
  {
    id: 'citation_format',
    label: 'returns machine-readable (structured) citations',
    test: m => m.citation_format === 'structured',
  },
  { id: 'research_qualified', label: 'qualified by the Gateway for research', test: m => m.research_qualified === true },
]

/** Does this product pass ALL seven conditions? Capability only. */
export function isWebResearchQualified(model: GenStudioChatModel): boolean {
  return WEB_RESEARCH_CONDITIONS.every(condition => condition.test(model))
}

/** Which published conditions this product FAILS. Empty means it qualifies.
 *  `qualification_only` appearing here means the product is visible for
 *  internal qualification only — not that the user must do anything.
 *  Used for diagnostics; never rendered as a demand on the user, who cannot
 *  change any of these flags. */
export function failedWebResearchConditions(model: GenStudioChatModel): string[] {
  return WEB_RESEARCH_CONDITIONS.filter(condition => !condition.test(model)).map(condition => condition.id)
}

/** The web-mode model list: every product passing all six conditions. */
export function selectWebResearchModels(catalog: readonly GenStudioChatModel[]): GenStudioChatModel[] {
  return catalog.filter(isWebResearchQualified)
}

/** What the Research page needs to render one selectable web model. */
export interface WebResearchModelOption {
  id: string
  display_name: string
  /** Per-search RATE, or null when unpublished. Quoted, never multiplied. */
  credits_per_search: number | null
  /** Flat per-REQUEST web-research RATE, charged on top of the per-search
   *  figure. Null when unpublished. Also quoted, also never multiplied. */
  credits_per_request: number | null
  /** Enforceable search cap, or null when GenStudio cannot enforce one. Null
   *  means the depth control is hidden — there is nothing honest to offer. */
  max_web_searches: number | null
  /** Show the domain allow/block inputs only when this is true. */
  supports_domain_filters: boolean
  /** Published `returns_citations`. Carried so the picker can state what the
   *  model gives back, rather than the reader having to infer it from the fact
   *  that the model appears in this list at all.
   *
   *  `null` means the provider did not state it — distinct from `false`, which
   *  would be a claim it does not cite (§6). The qualification test above still
   *  requires `=== true`: an unstated citation capability must not enable web
   *  research. */
  returns_citations: boolean | null
  /** GenStudio's published retirement flag and the date the product stops
   *  being available. Carried for the same reason every other picker carries
   *  them: this is a third place a customer commits to a chat product, and a
   *  payload that states the price but not the withdrawal date is how the
   *  first two went unnoticed. */
  deprecation_warning: boolean
  retires_at: string | null
  /**
   * Which shelf the product sells on, and the offer that shelf carries.
   *
   * Deliberately WITHOUT the standard/sale rate pair the language and vision
   * pickers carry. Web research is priced per search and per request, and
   * GenStudio publishes no undiscounted counterpart for either figure — so
   * there is no "was" price here to strike through, and this picker shows the
   * section and the hint without one rather than manufacturing a second
   * number out of the per-token rates, which are not what this page charges.
   */
  queue_class: GenStudioChatModel['queue_class']
  relaxed_queue_hint: GenStudioChatModel['relaxed_queue_hint']
}

export function toWebResearchModelOption(model: GenStudioChatModel): WebResearchModelOption {
  return {
    id: model.id,
    display_name: model.display_name,
    queue_class: model.queue_class === 'relaxed' ? 'relaxed' : 'direct',
    relaxed_queue_hint: model.relaxed_queue_hint ?? null,
    credits_per_search: model.web_search_credits_per_search,
    credits_per_request: model.web_research_credits_per_request,
    max_web_searches: model.max_web_searches,
    supports_domain_filters: model.supports_domain_filters === true,
    returns_citations: model.returns_citations ?? null,
    deprecation_warning: model.deprecation_warning === true,
    retires_at: model.retires_at ?? null,
  }
}

/** Availability of web research right now, plus everything the UI needs to
 *  explain itself when it is unavailable. */
export interface WebResearchAvailability {
  available: boolean
  /** Plain-language explanation when unavailable; empty when available. */
  reason: string
  models: WebResearchModelOption[]
}

export function describeWebResearchAvailability(
  catalog: readonly GenStudioChatModel[],
): WebResearchAvailability {
  const models = selectWebResearchModels(catalog).map(toWebResearchModelOption)
  return models.length
    ? { available: true, reason: '', models }
    : { available: false, reason: WEB_MODE_UNAVAILABLE_REASON, models: [] }
}

/** Normalize a user-entered domain list: trimmed, de-duped, no empties.
 *  Bare hostnames are kept as typed — GenStudio owns the matching rules, so
 *  this must not "helpfully" rewrite what the user asked for. */
export function normalizeDomainList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : []
  const out: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    const domain = item.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
    if (!domain) continue
    if (!out.includes(domain)) out.push(domain)
  }
  return out
}

/**
 * Build the request's `web_search` block for a SELECTED product.
 *
 * Two rules, both from the published capability and neither negotiable:
 *
 *   • `max_searches` is included ONLY when the product publishes a non-null
 *     `max_web_searches`, and is clamped to it. GenStudio cannot enforce a
 *     provider-side search count today, so sending a cap it cannot honour
 *     would be a promise this app has no way to keep.
 *   • domain lists are sent ONLY when the product publishes
 *     `supports_domain_filters`. Otherwise they are dropped, because a filter
 *     the provider ignores is worse than no filter — the user would believe
 *     their sources were constrained when they were not.
 *   • `claim_attribution` is sent ONLY when the product publishes
 *     `supports_claim_attribution`. A GenStudio that predates the field
 *     rejects the whole request rather than ignoring it, and asking for
 *     per-claim sources that nothing will ground would be worse than not
 *     asking at all.
 */
export function buildWebSearchBlock(
  model: GenStudioChatModel,
  settings: ResearchWebSearchSettings | undefined,
  requestedMaxSearches?: number | null,
): GenStudioWebSearchBlock {
  const filtersSupported = model.supports_domain_filters === true
  const block: GenStudioWebSearchBlock = {
    enabled: true,
    allowed_domains: filtersSupported ? normalizeDomainList(settings?.allowed_domains) : [],
    blocked_domains: filtersSupported ? normalizeDomainList(settings?.blocked_domains) : [],
  }
  if (model.supports_claim_attribution === true) block.claim_attribution = true
  const cap = model.max_web_searches
  if (typeof cap === 'number' && Number.isInteger(cap) && cap > 0) {
    const requested = Number.isInteger(requestedMaxSearches) ? Number(requestedMaxSearches) : cap
    block.max_searches = Math.min(cap, Math.max(1, requested))
  }
  return block
}

/**
 * Convert envelope citations into the persisted ResearchCitation shape.
 *
 * Reliability, per the GenStudio contract: `url` and (usually) `title` are
 * dependable today; `quote`/`publisher`/`published_at` are not. Unreliable
 * fields are carried through ONLY when actually present, so a missing value
 * stays missing instead of becoming an empty string that renders as a real
 * but blank attribute. `start_index`/`end_index` are still stored only: in a
 * JSON answer they arrive as 0..0 and anchor nowhere, which is precisely why
 * per-claim linking comes from GenStudio's grounded `citation_claims` (keyed
 * by `source_id`) rather than from spans.
 *
 * There is no `retrieved_at`: GenStudio does not fetch the page, so a
 * per-source timestamp would be falsely precise. Run recency is
 * ResearchOutput.generated_at.
 */
export function toResearchCitations(citations: readonly GenStudioCitation[]): ResearchCitation[] {
  return sanitizeResearchCitations(citations.map(citation => ({
    // Carried so a grounded per-claim link has something to point at.
    ...(citation.id ? { source_id: citation.id } : {}),
    // A citation with no title still has to be openable and identifiable, so
    // fall back to the URL rather than rendering an empty row.
    title: citation.title || citation.url,
    url: citation.url,
    ...(citation.quote ? { snippet: citation.quote } : {}),
    ...(citation.publisher ? { publisher: citation.publisher } : {}),
    ...(citation.published_at ? { published_at: citation.published_at } : {}),
    ...(citation.start_index !== null ? { start_index: citation.start_index } : {}),
    ...(citation.end_index !== null ? { end_index: citation.end_index } : {}),
  })))
}
