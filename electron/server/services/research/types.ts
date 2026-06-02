/**
 * Research adapter contract — common interface for the sources
 * the user can pick on the Research page (v1.0.142+):
 *
 *   - perplexity        — direct Perplexity API, live web search
 *   - llm-only          — any existing text provider (OpenAI /
 *                          Anthropic / kie), prompted to mark
 *                          uncertain claims for manual verify
 *
 * Adapters return the unified ResearchOutput shape so the Research
 * page UI + the script-generator consumer don't branch per source.
 *
 * Mirrors the broll-fetchers/ pattern (one adapter file per source,
 * a registry in index.ts).
 */

import type { ResearchOutput, ResearchRunOptions, ResearchSourceProvider } from '../../models/types.js'

export interface ResearchAdapter {
  /** Stable identifier — matches `source_provider` in the persisted
   *  output. */
  provider: ResearchSourceProvider

  /** True when the necessary key(s) are configured for this adapter.
   *  Perplexity needs its own key; llm-only needs at least one
   *  text-provider key. */
  isConfigured(): Promise<boolean>

  /** Human-readable label for the UI source-picker. */
  displayName: string

  /** Short helper text for the UI source-picker. */
  helperText: string

  /** Run the research pass. Throws on network / auth / quota failure;
   *  callers map errors into job_output_lines + job.status='error'.
   *  Returns the unified ResearchOutput shape with claims marked
   *  status='unreviewed' by default — the UI flips them before save. */
  run(opts: ResearchRunOptions): Promise<ResearchOutput>
}
