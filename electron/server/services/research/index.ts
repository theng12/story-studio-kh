/**
 * Research adapter registry. Routes go through this so they never
 * reference a specific adapter directly — same pattern as
 * services/broll-fetchers/index.ts.
 */

import type { ResearchAdapter } from './types.js'
import type { ResearchSourceProvider } from '../../models/types.js'
import { perplexity } from './perplexity.js'
import { llmOnly } from './llm-only.js'

export const RESEARCH_ADAPTERS: Record<ResearchSourceProvider, ResearchAdapter> = {
  'perplexity': perplexity,
  'llm-only': llmOnly,
}

export function getResearchAdapter(provider: ResearchSourceProvider): ResearchAdapter {
  const a = RESEARCH_ADAPTERS[provider]
  if (!a) throw new Error(`Unknown research source provider: ${provider}`)
  return a
}

export type { ResearchAdapter } from './types.js'
