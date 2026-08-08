/**
 * Research adapter contract. Research now has one execution source:
 * GenStudio's published LLM catalog. The persisted `llm-only` provider id is
 * retained strictly for sidecar compatibility.
 *
 * Adapters return the unified ResearchOutput shape so the Research
 * page UI + the script-generator consumer don't branch per source.
 *
 * A small adapter boundary keeps the two supported research modes behind one
 * response shape.
 */

import type { ResearchOutput, ResearchRunOptions, ResearchSourceProvider } from '../../models/types.js'

export interface ResearchAdapter {
  /** Stable identifier — matches `source_provider` in the persisted
   *  output. */
  provider: ResearchSourceProvider

  /** True when the GenStudio API credential is configured. */
  isConfigured(): Promise<boolean>

  /** Human-readable label for compatibility clients. */
  displayName: string

  /** Short helper text for compatibility clients. */
  helperText: string

  /** Run the research pass. Throws on network / auth / quota failure;
   *  callers map errors into job_output_lines + job.status='error'.
   *  Returns the unified ResearchOutput shape with claims marked
   *  status='unreviewed' by default — the UI flips them before save. */
  run(opts: ResearchRunOptions): Promise<ResearchOutput>
}
