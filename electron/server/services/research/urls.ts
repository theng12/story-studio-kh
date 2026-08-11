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

export function sanitizeResearchCitations(citations: readonly ResearchCitation[]): ResearchCitation[] {
  const seen = new Set<string>()
  return citations.flatMap(citation => {
    const url = canonicalHttpUrl(citation?.url)
    if (!url || seen.has(url)) return []
    seen.add(url)
    return [{ ...citation, title: citation.title || url, url }]
  })
}

/** Last defensive boundary before any generated research sidecar is written. */
export function sanitizeResearchOutputUrls(output: ResearchOutput): ResearchOutput {
  return {
    ...output,
    citations: sanitizeResearchCitations(output.citations || []),
    ...(output.web_run ? {
      web_run: {
        ...output.web_run,
        source_urls: canonicalHttpUrls(output.web_run.source_urls),
      },
    } : {}),
  }
}
