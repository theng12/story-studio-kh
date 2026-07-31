/**
 * Research provenance wording — ONE source of truth for what each mode is
 * allowed to claim.
 *
 * The two modes make genuinely different promises, and every surface (the
 * Research page, research.md, the job log) must make the same one:
 *
 *   model-knowledge — the model wrote this from what it already knows. That is
 *     dependable for well-established facts and unreliable for anything
 *     specific or recent. The earlier copy ("nothing backs this claim but the
 *     model") overstated the doubt; it read as if the output were worthless,
 *     which is both untrue and unhelpful when deciding what to check.
 *
 *   web-search — the provider searched and recorded what it read. Sources back
 *     the RUN, not any individual claim: claim-to-citation mapping is not
 *     available yet, so nothing may draw a per-claim link.
 *
 * The model-knowledge wording must never appear in web mode, and web wording
 * must never appear in model mode.
 */

import type { ResearchMode, ResearchWebRunReport } from '../../models/types.js'

/** Page / banner notice for the model-knowledge route. */
export const MODEL_KNOWLEDGE_NOTICE =
  'Based on the model’s own knowledge. Reliable on well-established facts, but it can’t cite live sources — '
  + 'worth checking anything specific or recent before you rely on it.'

/** Per-claim marker when a claim carries no citation. */
export const MODEL_KNOWLEDGE_CLAIM_NOTE = 'From model knowledge — no source cited'

/** Page / banner notice for the web-search route. */
export const WEB_SEARCH_NOTICE =
  'Searched the web and cited its sources below. Sources are listed for the whole run — individual claims '
  + 'aren’t linked to specific sources yet.'

/**
 * Honest wording for a web run that came back with NO sources. Silence here
 * would be the worst outcome: the page would promise "cited its sources" over
 * an empty list. Say plainly that the run produced no sources, so the claims
 * are only as good as model knowledge for now.
 */
export const WEB_SEARCH_NO_SOURCES_NOTICE =
  'This run searched the web but came back with no sources. Treat these claims as model knowledge until you '
  + 'find sources yourself, or run it again.'

export function researchModeNotice(mode: ResearchMode, citationCount = 0): string {
  if (mode !== 'web-search') return MODEL_KNOWLEDGE_NOTICE
  return citationCount > 0 ? WEB_SEARCH_NOTICE : WEB_SEARCH_NO_SOURCES_NOTICE
}

/** Customer-facing mode label. Deliberately avoids "LLM". */
export function researchModeLabel(mode: ResearchMode): string {
  return mode === 'web-search' ? 'Search the web' : 'Model knowledge only'
}

/** The literal every surface uses for a field GenStudio did not report. */
export const NOT_REPORTED = 'not reported'

/**
 * Read a persisted web-run report under the CONFIRMED field names, accepting
 * the two names v1.0.764 guessed so older sidecars still display.
 *
 * A field that is genuinely absent stays `null` and is rendered as
 * "not reported". Nothing here computes a charge.
 */
export function readResearchWebRun(run: ResearchWebRunReport | undefined | null): {
  searchesExecuted: number | null
  searchCreditCost: number | null
  researchRanAt: string | null
} {
  const int = (...values: unknown[]): number | null => {
    for (const value of values) {
      if (Number.isInteger(value) && (value as number) >= 0) return value as number
    }
    return null
  }
  return {
    searchesExecuted: int(run?.web_searches_executed, run?.searches_performed),
    searchCreditCost: int(run?.web_search_credit_cost, run?.credits_charged),
    researchRanAt: typeof run?.research_ran_at === 'string' && run.research_ran_at.trim()
      ? run.research_ran_at
      : null,
  }
}

/**
 * The one sentence every surface prints about what a web run did and cost.
 *
 * "Web search cost" — NOT "charged". The envelope field is
 * `web_search_credit_cost`, the web-search ADD-ON only, so calling it the
 * total charge would misreport the bill.
 */
export function webRunUsageSentence(run: ResearchWebRunReport | undefined | null): string {
  const { searchesExecuted, searchCreditCost } = readResearchWebRun(run)
  if (searchesExecuted === null && searchCreditCost === null) {
    return 'GenStudio did not report how many searches this run made or what the search cost.'
  }
  return `Searches executed: ${searchesExecuted ?? NOT_REPORTED}. `
    + `Web search cost: ${searchCreditCost === null ? NOT_REPORTED : `${searchCreditCost} credits`}.`
}

/**
 * When the research actually ran.
 *
 * GenStudio's `research_ran_at` is the run's own record and wins whenever the
 * envelope supplied it. `generated_at` — the moment this app wrote the file —
 * is the fallback, not the preference.
 */
export function researchRanAt(
  run: ResearchWebRunReport | undefined | null,
  generatedAt: string | undefined | null,
): string {
  return readResearchWebRun(run).researchRanAt || (generatedAt || '')
}
