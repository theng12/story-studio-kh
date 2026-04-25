/**
 * Lightweight similarity heuristics for the Ideas generator.
 *
 * No embeddings — token-set overlap (Jaccard) on titles and themes is enough
 * to catch the common "same noun phrases, different adjectives" pattern that
 * makes consecutive batches feel repetitive. If this proves too coarse, we
 * can swap in embedding-based cosine later without changing callers.
 */

export interface SimilarityCandidate {
  title: string
  logline?: string
  themes?: string[]
  mood?: string
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'its', 'it', 'that', 'this', 'these', 'those', 'their', 'there', 'where',
  'when', 'who', 'what', 'why', 'how', 'into', 'onto', 'upon', 'over', 'under',
  'within', 'without', 'between',
])

/**
 * Lowercase, strip punctuation, drop stopwords, crude suffix trim (s/es/ing/ed)
 * so "whispers" and "whispering" collapse to "whisper".
 */
export function tokenize(text: string): string[] {
  if (!text) return []
  const raw = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/)
  const out: string[] = []
  for (const word of raw) {
    if (!word || word.length < 3) continue
    if (STOPWORDS.has(word)) continue
    let stem = word
    if (stem.endsWith('ing') && stem.length > 5) stem = stem.slice(0, -3)
    else if (stem.endsWith('ed') && stem.length > 4) stem = stem.slice(0, -2)
    else if (stem.endsWith('es') && stem.length > 4) stem = stem.slice(0, -2)
    else if (stem.endsWith('s') && stem.length > 3) stem = stem.slice(0, -1)
    out.push(stem)
  }
  return out
}

/** Standard Jaccard similarity on two token arrays. 0..1, higher = more similar. */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  const setA = new Set(a)
  const setB = new Set(b)
  let intersection = 0
  for (const t of setA) if (setB.has(t)) intersection++
  const unionSize = setA.size + setB.size - intersection
  return unionSize === 0 ? 0 : intersection / unionSize
}

export interface SimilarityThresholds {
  /** Title-token Jaccard above this → too similar. Default 0.55. */
  title?: number
  /** Theme-set Jaccard above this → too similar. Default 0.6. */
  themes?: number
}

/**
 * Check if `candidate` is too similar to `existing`:
 *  - title Jaccard > threshold.title, OR
 *  - themes Jaccard > threshold.themes (only if both have themes), OR
 *  - candidate.logline literally contains the existing title (case-insensitive)
 */
export function isTooSimilar(
  candidate: SimilarityCandidate,
  existing: SimilarityCandidate,
  thresholds: SimilarityThresholds = {},
): boolean {
  const tTitle = thresholds.title ?? 0.55
  const tThemes = thresholds.themes ?? 0.6

  const titleSim = jaccard(tokenize(candidate.title), tokenize(existing.title))
  if (titleSim > tTitle) return true

  const aThemes = (candidate.themes || []).map(x => x.toLowerCase().trim())
  const bThemes = (existing.themes || []).map(x => x.toLowerCase().trim())
  if (aThemes.length >= 2 && bThemes.length >= 2) {
    const themeSim = jaccard(aThemes, bThemes)
    if (themeSim > tThemes) return true
  }

  if (candidate.logline && existing.title) {
    if (candidate.logline.toLowerCase().includes(existing.title.toLowerCase())) return true
  }
  return false
}

export interface FilterResult<T extends SimilarityCandidate> {
  kept: T[]
  rejected: Array<{ candidate: T; matched: SimilarityCandidate }>
}

/**
 * Filter a batch of newly-generated ideas against an existing pool.
 * Also dedupes within the batch itself so two near-duplicates from the same
 * generation don't both slip through.
 */
export function filterGenerated<T extends SimilarityCandidate>(
  candidates: T[],
  existing: SimilarityCandidate[],
  thresholds: SimilarityThresholds = {},
): FilterResult<T> {
  const kept: T[] = []
  const rejected: FilterResult<T>['rejected'] = []

  for (const cand of candidates) {
    const pool = [...existing, ...kept]
    const match = pool.find(e => isTooSimilar(cand, e, thresholds))
    if (match) rejected.push({ candidate: cand, matched: match })
    else kept.push(cand)
  }
  return { kept, rejected }
}
