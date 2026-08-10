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
 *   web-search — the provider searched and recorded what it read. Whether a
 *     source backs the RUN or an individual CLAIM depends on what came back,
 *     and the two are never conflated: a per-claim link is claimed only for
 *     claims GenStudio actually grounded, and the run-level wording is kept
 *     for everything else.
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
 * The mode picker's blurb, shown BEFORE a run exists.
 *
 * It describes the mechanism, not an outcome, because the outcome is not
 * knowable in advance: whether any given claim ends up linked depends on
 * whether the model can point it at a page it actually opened. Promising
 * per-claim citations here would be a promise this app cannot keep.
 */
export const WEB_SEARCH_MODE_BLURB =
  'Searches the web and cites what it read. Where the model can point a claim at a page it opened, '
  + 'that link is checked against what was really retrieved and shown on the claim.'

/**
 * Honest wording for a web run that came back with NO sources. Silence here
 * would be the worst outcome: the page would promise "cited its sources" over
 * an empty list. The run still succeeded as web research; GenStudio simply
 * did not publish structured citations or source URLs for it.
 */
export const WEB_SEARCH_NO_SOURCES_NOTICE =
  'Research ran, but GenStudio did not publish structured citations or source URLs for this run.'

/**
 * Web-search notice when GenStudio grounded at least one claim to a source.
 *
 * It states the attributed count rather than implying every claim is covered,
 * because it usually is not: a model that cannot support a claim is asked to
 * leave it unsourced, and that answer has to survive all the way to the page.
 */
export function webSearchAttributedNotice(attributed: number, total: number): string {
  const unattributed = Math.max(0, total - attributed)
  return `Searched the web and cited its sources below. ${attributed} of ${total} claims `
    + 'link to the specific sources that back them'
    + (unattributed > 0
      ? `; the other ${unattributed} carry no citation and are worth checking yourself.`
      : '.')
}

/** Per-claim marker in web mode when a claim was not linked to any source. */
export const WEB_SEARCH_CLAIM_UNCITED_NOTE = 'No source cited for this claim'

export function researchModeNotice(mode: ResearchMode, citationCount = 0): string {
  if (mode !== 'web-search') return MODEL_KNOWLEDGE_NOTICE
  return citationCount > 0 ? WEB_SEARCH_NOTICE : WEB_SEARCH_NO_SOURCES_NOTICE
}

/**
 * The notice for a web run, given how much of it was actually attributed.
 *
 * The run-level wording is NOT a fallback to be grown out of — it stays the
 * honest answer whenever nothing was grounded, including against a GenStudio
 * that cannot ground at all. Only a real, counted attribution earns the
 * stronger sentence.
 */
export function webResearchNotice(
  citationCount: number,
  attributedClaims: number,
  totalClaims: number,
): string {
  if (citationCount <= 0) return WEB_SEARCH_NO_SOURCES_NOTICE
  if (attributedClaims <= 0 || totalClaims <= 0) return WEB_SEARCH_NOTICE
  return webSearchAttributedNotice(attributedClaims, totalClaims)
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
