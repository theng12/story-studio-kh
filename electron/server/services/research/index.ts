/** GenStudio-only Research execution boundary. */

import type { ResearchAdapter } from './types.js'
import type { ResearchSourceProvider } from '../../models/types.js'
import { genStudioResearch } from './genstudio.js'

/**
 * `llm-only` is retained as the persisted schema value because existing
 * research sidecars use the ResearchSourceProvider union. Its execution is
 * GenStudio-only; it no longer means "choose any locally configured LLM".
 */
export const GENSTUDIO_RESEARCH_PROVIDER = 'llm-only' as const

export const RESEARCH_ADAPTERS: Readonly<Record<typeof GENSTUDIO_RESEARCH_PROVIDER, ResearchAdapter>> = {
  [GENSTUDIO_RESEARCH_PROVIDER]: genStudioResearch,
}

/**
 * Normalize only known historical values. This keeps saved `perplexity`
 * presets and jobs usable after upgrade without retaining a direct provider
 * path. Missing values are accepted for new clients because there is no
 * provider choice anymore.
 */
export function normalizeResearchSourceProvider(provider: unknown): typeof GENSTUDIO_RESEARCH_PROVIDER {
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

export function getResearchAdapter(provider: ResearchSourceProvider | string | undefined): ResearchAdapter {
  normalizeResearchSourceProvider(provider)
  return genStudioResearch
}

export type { ResearchAdapter } from './types.js'
