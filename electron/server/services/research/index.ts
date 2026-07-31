/** GenStudio-only Research execution boundary. */

import type { ResearchAdapter } from './types.js'
import type { ResearchMode, ResearchSourceProvider } from '../../models/types.js'
import { genStudioResearch } from './genstudio.js'
import { genStudioWebResearch, GENSTUDIO_WEB_RESEARCH_PROVIDER } from './genstudio-web.js'

/**
 * `llm-only` is retained as the persisted schema value because existing
 * research sidecars use the ResearchSourceProvider union. Its execution is
 * GenStudio-only; it no longer means "choose any locally configured LLM".
 */
export const GENSTUDIO_RESEARCH_PROVIDER = 'llm-only' as const

export { GENSTUDIO_WEB_RESEARCH_PROVIDER }

/**
 * Both adapters run through the same GenStudio boundary and the same API key.
 * They are NOT a provider choice — they are the two research MODES:
 *
 *   'llm-only'      → "Model knowledge only" (default, no web access)
 *   'genstudio-web' → "Search the web" (qualified, citation-returning product)
 */
export const RESEARCH_ADAPTERS: Readonly<Record<ResearchModeProvider, ResearchAdapter>> = {
  [GENSTUDIO_RESEARCH_PROVIDER]: genStudioResearch,
  [GENSTUDIO_WEB_RESEARCH_PROVIDER]: genStudioWebResearch,
}

/** The provider ids that can actually be executed today. `perplexity` is a
 *  migration alias only and never appears here. */
export type ResearchModeProvider = typeof GENSTUDIO_RESEARCH_PROVIDER | typeof GENSTUDIO_WEB_RESEARCH_PROVIDER

/** The default mode. A sidecar, preset, or job with no mode came from before
 *  web search existed, so it can only have been model knowledge. */
export const DEFAULT_RESEARCH_MODE: ResearchMode = 'model-knowledge'

/**
 * Normalize only known historical values. This keeps saved `perplexity`
 * presets and jobs usable after upgrade without retaining a direct provider
 * path. Missing values normalize to the model-knowledge route, which is what
 * every sidecar written before web search existed actually used.
 */
export function normalizeResearchSourceProvider(provider: unknown): ResearchModeProvider {
  if (provider === GENSTUDIO_WEB_RESEARCH_PROVIDER) return GENSTUDIO_WEB_RESEARCH_PROVIDER
  if (
    provider == null
    || provider === ''
    || provider === GENSTUDIO_RESEARCH_PROVIDER
    || provider === 'perplexity'
    || provider === 'genstudio'
    || provider === 'genstudio-llm'
  ) {
    return GENSTUDIO_RESEARCH_PROVIDER
  }
  throw new Error(`Unknown research source: ${String(provider)}`)
}

/**
 * Read a persisted / submitted research mode.
 *
 * ABSENT AND UNKNOWN BOTH MEAN 'model-knowledge'. That is the whole legacy
 * contract: a sidecar or preset with no mode predates web search, and an
 * unrecognised value must never be optimistically upgraded into a mode that
 * promises live sources.
 */
export function normalizeResearchMode(mode: unknown): ResearchMode {
  return mode === 'web-search' ? 'web-search' : DEFAULT_RESEARCH_MODE
}

/** The persisted provider id a given mode writes. */
export function providerForResearchMode(mode: ResearchMode): ResearchModeProvider {
  return mode === 'web-search' ? GENSTUDIO_WEB_RESEARCH_PROVIDER : GENSTUDIO_RESEARCH_PROVIDER
}

/** The mode a persisted provider id represents. */
export function researchModeForProvider(provider: unknown): ResearchMode {
  return normalizeResearchSourceProvider(provider) === GENSTUDIO_WEB_RESEARCH_PROVIDER
    ? 'web-search'
    : DEFAULT_RESEARCH_MODE
}

export function getResearchAdapter(provider: ResearchSourceProvider | string | undefined): ResearchAdapter {
  return RESEARCH_ADAPTERS[normalizeResearchSourceProvider(provider)]
}

export function getResearchAdapterForMode(mode: unknown): ResearchAdapter {
  return RESEARCH_ADAPTERS[providerForResearchMode(normalizeResearchMode(mode))]
}

export type { ResearchAdapter } from './types.js'
