/**
 * Historical B-Roll fetch job compatibility. Direct provider downloads are
 * intentionally disabled: Story Studio retains only its GenStudio credential,
 * and GenStudio does not yet expose a typed stock/SFX asset-fetch route.
 */
import type { FetchProvider, FetchResult, FetchQuality } from '../services/broll-fetchers/types.js'
import type { Job } from '../models/types.js'

export interface BrollFetchParams {
  pool_id: string
  provider: FetchProvider
  /** Serialised FetchResult — the route layer hands the search-result
   *  object back to the executor so we don't need to re-search for
   *  it. Includes the full `files` array so the executor picks the
   *  quality without another API roundtrip. */
  result: FetchResult
  search_keywords: string[]
  /** Preferred quality — defaults to 'hd' on the route layer. */
  quality?: FetchQuality
}

export async function fetchBroll(job: Job): Promise<void> {
  job.output_lines.push('Direct stock/SFX provider fetching is disabled. Add files to the local pool and re-scan it.')
  throw new Error('GENSTUDIO_CAPABILITY_UNAVAILABLE: Stock and SFX fetching requires a qualified typed GenStudio KH asset-fetch route.')
}
