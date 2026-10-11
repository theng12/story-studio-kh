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
  /** Combined title/logline/theme overlap above this → same concept. Default 0.5. */
  concept?: number
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
  const tConcept = thresholds.concept ?? 0.5

  const titleSim = jaccard(tokenize(candidate.title), tokenize(existing.title))
  if (titleSim > tTitle) return true

  const aThemes = (candidate.themes || []).map(x => x.toLowerCase().trim())
  const bThemes = (existing.themes || []).map(x => x.toLowerCase().trim())
  if (aThemes.length >= 2 && bThemes.length >= 2) {
    const themeSim = jaccard(aThemes, bThemes)
    if (themeSim > tThemes) return true
  }

  const candidateConcept = tokenize([
    candidate.title,
    candidate.logline || '',
    ...(candidate.themes || []),
  ].join(' '))
  const existingConcept = tokenize([
    existing.title,
    existing.logline || '',
    ...(existing.themes || []),
  ].join(' '))
  if (candidateConcept.length >= 5 && existingConcept.length >= 5) {
    const conceptSim = jaccard(candidateConcept, existingConcept)
    if (conceptSim > tConcept) return true
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

// ── Duplicate watch (1.4.285, per-channel `idea_upgrades.semantic_dedupe = 'shadow'`) ────────────
//
// Watch-only: reports what a meaning-based check WOULD reject and never rejects anything itself.
// The Jaccard filter above stays the only thing that drops ideas, unchanged.

/**
 * A channel's title wrapper ("… | Soothing Bedtime Adventures", "Daily Prayer | …") is shared by
 * every title, so it made unrelated stories look alike. A ` | ` segment that recurs in at least a
 * fifth of the pool (and 3+ titles) is treated as wrapper and left out of the comparison, along
 * with the request's own prefix and suffix.
 */
export function titleWrapperSegments(titles: string[]): Set<string> {
  const counts = new Map<string, number>()
  for (const title of titles) {
    for (const segment of new Set(title.split(' | ').map(part => part.trim().toLowerCase()).filter(Boolean))) {
      if (title.includes(' | ')) counts.set(segment, (counts.get(segment) || 0) + 1)
    }
  }
  const floor = Math.max(3, titles.length * 0.2)
  return new Set([...counts].filter(([, count]) => count >= floor).map(([segment]) => segment))
}

export function coreTitle(title: string, wrappers: Set<string>, prefix = '', suffix = ''): string {
  let text = title.trim()
  if (prefix.trim() && text.startsWith(prefix.trim())) text = text.slice(prefix.trim().length)
  if (suffix.trim() && text.endsWith(suffix.trim())) text = text.slice(0, -suffix.trim().length)
  const parts = text.split(' | ').map(part => part.trim()).filter(part => part && !wrappers.has(part.toLowerCase()))
  return parts.join(' | ') || text.trim()
}

export interface DuplicateWatchHit<T> { candidate: T; matched: SimilarityCandidate; score: number }
export interface DuplicateWatchResult<T> {
  /** `meaning` = embeddings; `words` = the improved word check (wrapper-stripped Jaccard). */
  method: 'meaning' | 'words'
  /** Why the meaning check was not used, when it was not. */
  fallback_reason?: string
  hits: DuplicateWatchHit<T>[]
  /** Every candidate's closest earlier idea and its score (meaning only), so the threshold can be tuned. */
  nearest: Array<{ candidate: T; matched: SimilarityCandidate | null; score: number }>
}

export interface DuplicateWatchOptions {
  /** Embedding call; absent = no embeddings model chosen. */
  embed?: (texts: string[]) => Promise<number[][]>
  threshold: number
  prefix?: string
  suffix?: string
  /** Text → vector cache shared across batches of one run. */
  vectorCache?: Map<string, number[]>
}

function dot(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length && i < b.length; i++) sum += a[i]! * b[i]!
  return sum
}

/**
 * Which candidates look like a repeat of the pool or of an earlier candidate in the same batch.
 * Never throws: an embedding failure falls back to the word check and says why.
 */
export async function watchDuplicates<T extends SimilarityCandidate>(
  candidates: T[],
  pool: SimilarityCandidate[],
  options: DuplicateWatchOptions,
): Promise<DuplicateWatchResult<T>> {
  const wrappers = titleWrapperSegments([...pool, ...candidates].map(item => item.title))
  const core = (item: SimilarityCandidate) => coreTitle(item.title, wrappers, options.prefix, options.suffix)
  const text = (item: SimilarityCandidate) => `${core(item)} — ${item.logline || ''}`.trim()
  let fallback_reason = options.embed ? '' : 'no embeddings model chosen'
  if (options.embed) {
    try {
      const cache = options.vectorCache || new Map<string, number[]>()
      const all = [...pool, ...candidates].map(text)
      const missing = [...new Set(all.filter(value => !cache.has(value)))]
      if (missing.length) {
        const vectors = await options.embed(missing)
        missing.forEach((value, index) => cache.set(value, vectors[index]!))
      }
      const hits: DuplicateWatchHit<T>[] = []
      const nearest: DuplicateWatchResult<T>['nearest'] = []
      const earlier: SimilarityCandidate[] = []
      for (const candidate of candidates) {
        const vector = cache.get(text(candidate))!
        let best: { matched: SimilarityCandidate; score: number } | null = null
        for (const other of [...pool, ...earlier]) {
          const score = dot(vector, cache.get(text(other))!)
          if (!best || score > best.score) best = { matched: other, score }
        }
        nearest.push({ candidate, matched: best?.matched ?? null, score: best?.score ?? 0 })
        if (best && best.score >= options.threshold) hits.push({ candidate, ...best })
        else earlier.push(candidate)
      }
      return { method: 'meaning', hits, nearest }
    } catch (error) {
      fallback_reason = error instanceof Error ? error.message : String(error)
    }
  }
  const stripped = (item: SimilarityCandidate): SimilarityCandidate => ({ ...item, title: core(item) })
  const hits: DuplicateWatchHit<T>[] = []
  const earlier: SimilarityCandidate[] = []
  for (const candidate of candidates) {
    const mine = stripped(candidate)
    const matched = [...pool, ...earlier].find(other => isTooSimilar(mine, stripped(other)))
    if (matched) hits.push({ candidate, matched, score: jaccard(tokenize(mine.title), tokenize(core(matched))) })
    else earlier.push(candidate)
  }
  return { method: 'words', fallback_reason, hits, nearest: [] }
}
