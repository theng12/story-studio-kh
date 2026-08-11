/**
 * Research sources → YouTube description (v1.0.197).
 *
 * Deterministically appends a SOURCES block to a generated description from the
 * episode's research.json citations. Deterministic on purpose: the URLs must
 * never be hallucinated or "tidied" by the LLM, so we build the block in code
 * from the real citation list (only the ones the user kept — see
 * `include_in_description`) and respect the description's char budget.
 *
 * Shared by the batch metadata generator AND the interactive Metadata page
 * route so both produce the same block.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import { resolveResearchPaths } from './research-paths.js'
import { canonicalHttpUrl } from '../services/research/urls.js'
import type { Format, ResearchOutput } from '../models/types.js'

const DIVIDER = '──────────────────────────────────────'

export interface SourcesAppendResult {
  description: string
  appended: number
  dropped: number
}

export interface SelectedResearchSource {
  title: string
  url: string
}

/**
 * Return only user-kept, real research citations for an episode. This is the
 * shared source boundary for both the legacy description appender and the
 * late-stage YouTube finalizer. It deliberately returns an empty list on
 * missing/malformed research so Research remains optional.
 */
export async function readSelectedResearchSources(
  slug: string,
  episodeId: string,
): Promise<SelectedResearchSource[]> {
  try {
    const paths = await resolveEpisodePathsByCode(slug, episodeId)
    const { jsonPath } = await resolveResearchPaths(paths.episode_dir, episodeId)
    if (!existsSync(jsonPath)) return []
    const research = JSON.parse(await fs.readFile(jsonPath, 'utf-8')) as ResearchOutput
    return (research.citations || []).flatMap(c => {
      const url = canonicalHttpUrl(c?.url)
      return c && url && c.include_in_description !== false
        ? [{ title: (c.title || '').trim() || url, url }]
        : []
    })
  } catch {
    return []
  }
}

/**
 * Should the SOURCES block be appended, given the description builder's
 * sections? Semantics (v1.0.198):
 *   - no sections array (legacy / batch without a config) → yes (back-compat)
 *   - sections present WITH an enabled 'sources' section → yes
 *   - sections present without a 'sources' section, or it's disabled → no
 *     (the user's template/template-edit deliberately omitted sources)
 */
export function sourcesSectionEnabled(sections: unknown): boolean {
  if (!Array.isArray(sections) || sections.length === 0) return true
  const s = sections.find((x: any) => x && x.id === 'sources')
  return !!s && (s as any).enabled !== false
}

/**
 * Append the selected research sources to `description`, if research.json
 * exists for the episode. No-op (returns the input unchanged) when there's no
 * research, no included citations, or none with a URL. Never throws.
 */
export async function appendSourcesToDescription(
  slug: string,
  episodeId: string,
  description: string,
  format: Format | null,
  maxChars: number,
  enabled: boolean = true,
): Promise<SourcesAppendResult> {
  try {
    if (!enabled) return { description, appended: 0, dropped: 0 }
    const cites = await readSelectedResearchSources(slug, episodeId)
    if (!cites.length) return { description, appended: 0, dropped: 0 }

    // Already has a sources block (e.g. re-running on an edited description)?
    // Don't double-append.
    const label = format?.metadata?.youtubeDescriptionStructure?.booksSectionLabel || '📚 SOURCES:'
    if (description.includes(label)) return { description, appended: 0, dropped: 0 }

    const header = `\n\n${DIVIDER}\n${label}\n`
    const lines: string[] = []
    let used = description.length + header.length
    let appended = 0
    let dropped = 0
    for (const c of cites) {
      const line = `- ${c.title} — ${c.url}\n`
      // Keep the description within the platform/format char budget. Always
      // emit at least one source if any fit; otherwise count the rest dropped.
      if (used + line.length > maxChars && appended > 0) { dropped++; continue }
      lines.push(line)
      used += line.length
      appended++
    }
    if (!appended) return { description, appended: 0, dropped: 0 }

    let block = header + lines.join('')
    if (dropped) block += `(+${dropped} more source${dropped === 1 ? '' : 's'})\n`
    return { description: description + block, appended, dropped }
  } catch {
    return { description, appended: 0, dropped: 0 }
  }
}
