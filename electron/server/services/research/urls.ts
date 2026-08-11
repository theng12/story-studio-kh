import type { ResearchCitation, ResearchOutput } from '../../models/types.js'

/** Canonical URL safe to persist or render as a customer-facing link. */
export function canonicalHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname
      ? url.toString()
      : null
  } catch {
    return null
  }
}

export function canonicalHttpUrls(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  return values.flatMap(value => {
    const url = canonicalHttpUrl(value)
    return url && !seen.has(url) ? (seen.add(url), [url]) : []
  })
}

function sanitizeResearchCitationsWithIndices(citations: readonly ResearchCitation[]) {
  const indexMap = new Map<number, number>()
  const sanitized: ResearchCitation[] = []
  citations.forEach((citation, index) => {
    const url = canonicalHttpUrl(citation?.url)
    if (!url) return
    const existing = sanitized.findIndex(item => item.url === url)
    if (existing >= 0) {
      indexMap.set(index, existing)
      return
    }
    indexMap.set(index, sanitized.length)
    sanitized.push({ ...citation, title: normalizedCitationTitle(citation.title, url), url })
  })
  return { citations: sanitized, indexMap }
}

function normalizedCitationTitle(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

export function sanitizeResearchCitations(citations: readonly ResearchCitation[]): ResearchCitation[] {
  return sanitizeResearchCitationsWithIndices(citations).citations
}

/** Last defensive boundary before any generated research sidecar is written. */
export function sanitizeResearchOutputUrls(output: ResearchOutput): ResearchOutput {
  const { citations, indexMap } = sanitizeResearchCitationsWithIndices(output.citations || [])
  return {
    ...output,
    citations,
    claims: (output.claims || []).map(claim => ({
      ...claim,
      citation_indices: (claim.citation_indices || []).flatMap(index => {
        const mapped = indexMap.get(index)
        return mapped === undefined ? [] : [mapped]
      }).filter((index, position, values) => values.indexOf(index) === position),
    })),
    ...(output.web_run ? {
      web_run: {
        ...output.web_run,
        source_urls: canonicalHttpUrls(output.web_run.source_urls),
      },
    } : {}),
  }
}
