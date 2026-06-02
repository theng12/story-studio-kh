/**
 * Common interface for B-Roll fetcher adapters (Pexels, Pixabay,
 * future: NASA / Wikimedia / Internet Archive).
 *
 * Adapter contract:
 *   - `search(query, opts)` returns up to `perPage` results in
 *     provider-neutral shape (see `FetchResult`). Caller decides which
 *     ones to actually fetch.
 *   - `download(result, destPath)` writes the chosen quality's file to
 *     `destPath` atomically (writes to `<destPath>.tmp`, renames on
 *     success). Throws on network / disk error; never leaves a partial
 *     file in the final path.
 *   - `isConfigured()` returns false if the app secret store has no
 *     key for this provider — the route layer surfaces that as a
 *     "configure Pexels in App Settings → API Keys" hint instead of
 *     attempting a doomed call.
 *
 * The route layer adds two things on top of this interface that the
 * adapters deliberately don't know about:
 *   - **Provenance**: each downloaded clip gets a sidecar JSON written
 *     to `<pool>/.broll-provenance/<filename>.json`. The adapter
 *     populates the data; the sidecar service writes it.
 *   - **Dedupe**: the search route annotates each result with
 *     `already_have: boolean` by scanning provenance sidecars for a
 *     matching `provider + source_id` pair before returning.
 */

export type FetchProvider = 'pexels' | 'pixabay' | 'nasa'

export type FetchQuality = 'uhd' | 'hd' | 'sd' | 'tiny'

/** One downloadable file at a specific quality. */
export interface FetchFile {
  quality: FetchQuality
  url: string
  width: number
  height: number
  /** Size in bytes when the provider exposes it. Both Pixabay and
   *  Pexels do (Pexels via Content-Length; Pixabay returns `size` in
   *  the search response itself). Undefined when not yet known. */
  size_bytes?: number
}

/** Provider-neutral search result, ready for the UI grid to render. */
export interface FetchResult {
  provider: FetchProvider
  /** Provider's stable ID for this clip. Stringified because Pixabay
   *  returns numbers and Pexels could in theory return strings; we
   *  normalise to string for the provenance sidecar + dedupe key. */
  source_id: string
  /** Page URL on the provider's site (where the clip lives). Used as
   *  the canonical link in the asset log + hover tooltip. */
  source_url: string
  /** Single still-frame thumbnail URL, for the UI grid. */
  thumbnail_url: string
  /** Seconds. */
  duration: number
  /** Best-available original dimensions (typically the UHD/large file). */
  width: number
  height: number
  /** Display name of the person who uploaded the clip. */
  author: string
  author_url?: string
  /** Human-readable license name (e.g. "Pexels License"). */
  license: string
  license_url: string
  /** Downloadable files at multiple qualities, sorted best → worst. */
  files: FetchFile[]
}

export interface SearchOptions {
  /** Max results to return. Defaults vary per provider; UI clamps. */
  perPage?: number
  /** 1-indexed page number. */
  page?: number
}

export interface DownloadOptions {
  /** Preferred quality. Falls back to next-best when the preferred
   *  quality is not in `result.files`. Defaults to 'hd' — matches the
   *  normalize target so we don't waste bandwidth downloading UHD only
   *  to scale it down to 1080p at normalize time. */
  quality?: FetchQuality
  /** AbortSignal so the job-queue cancel watcher can interrupt a
   *  long-running download. */
  signal?: AbortSignal
}

export interface FetchAdapter {
  readonly provider: FetchProvider
  /** True iff the app secret store has a non-empty key for this provider. */
  isConfigured(): Promise<boolean>
  /** Throws on auth failure / network error; returns [] on no results. */
  search(query: string, opts?: SearchOptions): Promise<FetchResult[]>
  /** Writes to `destPath` atomically. Throws on failure (no half-file). */
  download(result: FetchResult, destPath: string, opts?: DownloadOptions): Promise<void>
}

/**
 * Pick the best-available file from a `FetchResult` given a quality
 * preference. Falls back along the chain `requested → hd → sd → tiny`
 * (and from uhd downward if a quality higher than hd was requested).
 * Returns null when the result has no files at all (shouldn't happen
 * for a well-formed adapter result, but defensive).
 */
export function pickFile(result: FetchResult, preferred: FetchQuality = 'hd'): FetchFile | null {
  if (result.files.length === 0) return null
  const tryOrder: FetchQuality[] = preferred === 'uhd'
    ? ['uhd', 'hd', 'sd', 'tiny']
    : preferred === 'hd'
      ? ['hd', 'uhd', 'sd', 'tiny']
      : preferred === 'sd'
        ? ['sd', 'hd', 'tiny', 'uhd']
        : ['tiny', 'sd', 'hd', 'uhd']
  for (const q of tryOrder) {
    const f = result.files.find(x => x.quality === q)
    if (f) return f
  }
  // Defensive fallback: take whatever's first.
  return result.files[0] ?? null
}
