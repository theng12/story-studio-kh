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

import type { ResearchMode } from '../../models/types.js'

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
