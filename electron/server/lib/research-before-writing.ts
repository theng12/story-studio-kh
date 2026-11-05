import type { ProjectConfig } from '../models/types.js'
import { getEffectiveNiche } from '../services/niche-loader.js'

/** A read-time default; existing channel files are never backfilled. */
export async function researchBeforeWritingEnabled(
  slug: string,
  config: Pick<ProjectConfig, 'research_before_writing'>,
): Promise<boolean> {
  if (typeof config.research_before_writing === 'boolean') return config.research_before_writing
  const niche = await getEffectiveNiche(slug) as { musicFormat?: unknown } | null
  return !niche?.musicFormat
}
