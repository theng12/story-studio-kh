/**
 * Web-research capability boundary.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * A GenStudio language product may be used for evidence-backed ("Search the
 * web") research ONLY when it passes ALL FIVE published conditions:
 *
 *   1. available                        — the product is usable at all
 *   2. supports_web_search              — it can search
 *   3. returns_citations                — it reports what it read
 *   4. citation_format === 'structured' — those citations are machine-readable
 *   5. research_qualified               — GenStudio has qualified it for research
 *
 * The filter is CAPABILITY-ONLY. Never match on provider or model name: a name
 * is not a promise, and hardcoding one would silently break the moment
 * GenStudio renames or re-routes a product.
 *
 * ── The expected launch state ───────────────────────────────────────────────
 * Every product currently publishes `research_qualified: false`, so web mode
 * ships VISIBLY UNAVAILABLE with a plain explanation. That is a first-class
 * state, not an error: the moment GenStudio flips the flag, web mode switches
 * itself on with no Story Studio code change and no release.
 *
 * ── What this module does NOT do ────────────────────────────────────────────
 * It never computes a customer charge. `web_search_credits_per_search` is a
 * RATE that is quoted to the user before the run; the provider decides how
 * many searches to make, so no honest total exists in advance. The ACTUAL
 * charge comes back from GenStudio after the run, or is reported as unknown.
 */

import type { GenStudioChatModel, GenStudioCitation, GenStudioWebSearchBlock } from '../../lib/genstudio-client.js'
import type { ResearchCitation, ResearchWebSearchSettings } from '../../models/types.js'

/** Shown wherever web mode is offered but nothing qualifies. Deliberately
 *  explains the situation instead of reading as a failure. */
export const WEB_MODE_UNAVAILABLE_REASON =
  'No evidence-backed model is currently available. Searching the web needs a GenStudio model that '
  + 'returns structured citations and has been qualified for research; none of your published models offers '
  + 'that yet. It turns on by itself here as soon as one does.'

/** Shown when the catalogue itself could not be read. Distinct from "nothing
 *  qualifies" — an unreachable catalogue is a connection problem, and telling
 *  the user "nothing qualifies" would be a guess. */
export const WEB_MODE_CATALOG_UNAVAILABLE_REASON =
  'Could not check which models can search the web — the GenStudio catalog was unreachable. '
  + 'Model-knowledge research still works.'

/** The five published conditions, one per entry, so a caller (or a test) can
 *  ask WHICH condition excluded a product rather than only that it failed. */
export const WEB_RESEARCH_CONDITIONS: ReadonlyArray<{
  readonly id: string
  readonly label: string
  readonly test: (model: GenStudioChatModel) => boolean
}> = [
  { id: 'available', label: 'published and available', test: m => m.available === true },
  { id: 'supports_web_search', label: 'can search the web', test: m => m.supports_web_search === true },
  { id: 'returns_citations', label: 'returns citations', test: m => m.returns_citations === true },
  {
    id: 'citation_format',
    label: 'returns machine-readable (structured) citations',
    test: m => m.citation_format === 'structured',
  },
  { id: 'research_qualified', label: 'qualified by GenStudio for research', test: m => m.research_qualified === true },
]

/** Does this product pass ALL five conditions? Capability only. */
export function isWebResearchQualified(model: GenStudioChatModel): boolean {
  return WEB_RESEARCH_CONDITIONS.every(condition => condition.test(model))
}

/** Which published conditions this product FAILS. Empty means it qualifies.
 *  Used for diagnostics; never rendered as a demand on the user, who cannot
 *  change any of these flags. */
export function failedWebResearchConditions(model: GenStudioChatModel): string[] {
  return WEB_RESEARCH_CONDITIONS.filter(condition => !condition.test(model)).map(condition => condition.id)
}

/** The web-mode model list: every product passing all five conditions. */
export function selectWebResearchModels(catalog: readonly GenStudioChatModel[]): GenStudioChatModel[] {
  return catalog.filter(isWebResearchQualified)
}

/** What the Research page needs to render one selectable web model. */
export interface WebResearchModelOption {
  id: string
  display_name: string
  /** Per-search RATE, or null when unpublished. Quoted, never multiplied. */
  credits_per_search: number | null
  /** Enforceable search cap, or null when GenStudio cannot enforce one. Null
   *  means the depth control is hidden — there is nothing honest to offer. */
  max_web_searches: number | null
  /** Show the domain allow/block inputs only when this is true. */
  supports_domain_filters: boolean
}

export function toWebResearchModelOption(model: GenStudioChatModel): WebResearchModelOption {
  return {
    id: model.id,
    display_name: model.display_name,
    credits_per_search: model.web_search_credits_per_search,
    max_web_searches: model.max_web_searches,
    supports_domain_filters: model.supports_domain_filters === true,
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
 * but blank attribute. `start_index`/`end_index` are stored for a future
 * span-mapping release and are not used for per-claim linking today.
 *
 * There is no `retrieved_at`: GenStudio does not fetch the page, so a
 * per-source timestamp would be falsely precise. Run recency is
 * ResearchOutput.generated_at.
 */
export function toResearchCitations(citations: readonly GenStudioCitation[]): ResearchCitation[] {
  return citations.map(citation => ({
    // A citation with no title still has to be openable and identifiable, so
    // fall back to the URL rather than rendering an empty row.
    title: citation.title || citation.url,
    url: citation.url,
    ...(citation.quote ? { snippet: citation.quote } : {}),
    ...(citation.publisher ? { publisher: citation.publisher } : {}),
    ...(citation.published_at ? { published_at: citation.published_at } : {}),
    ...(citation.start_index !== null ? { start_index: citation.start_index } : {}),
    ...(citation.end_index !== null ? { end_index: citation.end_index } : {}),
  }))
}
