/**
 * NASA Image and Video Library adapter (v1.0.136+).
 *
 * API docs: https://api.nasa.gov/ (NASA Image & Video Library section)
 * Base URL: https://images-api.nasa.gov/
 *
 * Auth: **None required.** NASA's media API is public, no key needed.
 * Rate limit per IP is generous (~5000 req/hr) — well above what an
 * interactive search workflow generates.
 *
 * License: **Most content is public domain.** NASA's policy: media
 * created by NASA personnel using government resources is generally PD.
 * Exceptions exist (third-party contributors, logos, mission insignia)
 * and the per-item metadata sometimes carries restrictions in the
 * `description_508` or `secondary_creator` fields. We surface the NASA
 * Media Usage Guidelines URL as the license link on every result — the
 * user is responsible for re-checking any specific clip's metadata
 * before use in a derived work. Same as how we'd treat Wikimedia
 * Commons multi-license content.
 *
 * Two-stage fetch:
 *   1. `/search?q=…&media_type=video` returns items with a thumbnail +
 *      title + an `href` pointing at an asset MANIFEST JSON.
 *   2. The manifest lists every file variant for that item (orig.mp4,
 *      large.mp4, medium.mp4, small.mp4, mobile.mp4, thumb.jpg, etc.).
 *
 * We resolve up to N manifests in parallel (bounded concurrency) so the
 * search response carries usable file URLs. Items whose manifest fails
 * or has no playable video are dropped from the results — the UI never
 * shows a result we can't actually download.
 */

import { createWriteStream } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type {
  DownloadOptions,
  FetchAdapter,
  FetchFile,
  FetchQuality,
  FetchResult,
  SearchOptions,
} from './types.js'
import { pickFile } from './types.js'

const NASA_API_BASE = 'https://images-api.nasa.gov/search'
const NASA_LICENSE = 'NASA Media Usage Guidelines (public domain, with exceptions)'
const NASA_LICENSE_URL = 'https://www.nasa.gov/nasa-brand-center/images-and-media/'

/** Parallel manifest-fetch cap. NASA's rate limit allows much more, but
 *  20 simultaneous opens is plenty for a 20-per-page search. */
const MANIFEST_CONCURRENCY = 5

interface NasaSearchItem {
  href: string                       // URL of the asset manifest JSON
  data: Array<{
    nasa_id: string
    title?: string
    description?: string
    description_508?: string
    date_created?: string
    media_type?: string              // "video" / "image" / "audio"
    center?: string                  // creator NASA center
    keywords?: string[]
    secondary_creator?: string
  }>
  links?: Array<{
    href: string                     // thumbnail URL (when rel === 'preview')
    rel: string                      // 'preview' | …
    render?: string                  // 'image' | …
  }>
}

interface NasaSearchResponse {
  collection: {
    href: string
    items: NasaSearchItem[]
    metadata?: { total_hits: number }
  }
}

/**
 * Map a NASA filename suffix to our canonical FetchQuality. NASA's
 * convention (verified across many items in 2026-05): the original
 * upload always has `~orig.mp4`; downscaled variants follow
 * `~large.mp4` (≤1920w), `~medium.mp4` (≤640w), `~small.mp4` (≤256w),
 * `~mobile.mp4`. Width metadata isn't in the manifest, so we infer
 * quality from the suffix alone — accurate enough for the picker's
 * sort + the assembler's downscale-to-1080p step.
 */
function classifyByFilename(filename: string): FetchQuality | null {
  const f = filename.toLowerCase()
  if (/~orig\.mp4$/.test(f)) return 'uhd'      // could be 4K, could be 1080p — mapped to uhd because it's the largest available
  if (/~large\.mp4$/.test(f)) return 'hd'      // typically ≤1920w
  if (/~medium\.mp4$/.test(f)) return 'sd'     // typically ≤640w
  if (/~small\.mp4$/.test(f)) return 'tiny'    // typically ≤256w
  if (/~mobile\.mp4$/.test(f)) return 'sd'     // mobile is roughly SD
  return null
}

/** Width estimate per quality bucket — used only for FetchFile.width
 *  (the picker UI sorts by width). NASA doesn't expose real dims in the
 *  manifest; these are conservative typical values. */
const QUALITY_WIDTH_ESTIMATE: Record<FetchQuality, { w: number; h: number }> = {
  uhd:  { w: 3840, h: 2160 },
  hd:   { w: 1920, h: 1080 },
  sd:   { w:  640, h:  360 },
  tiny: { w:  256, h:  144 },
}

class NasaAdapter implements FetchAdapter {
  readonly provider = 'nasa' as const

  /** No key required — NASA's API is public. Always configured.
   *  (Network reachability is checked on the first call; a down DNS
   *  would surface as a search error, not a config error.) */
  async isConfigured(): Promise<boolean> {
    return true
  }

  async search(query: string, opts: SearchOptions = {}): Promise<FetchResult[]> {
    const q = query.trim()
    if (!q) return []
    const perPage = Math.min(Math.max(opts.perPage ?? 20, 1), 100)  // NASA accepts up to 100
    const page = Math.max(opts.page ?? 1, 1)

    const url = new URL(NASA_API_BASE)
    url.searchParams.set('q', q)
    url.searchParams.set('media_type', 'video')
    url.searchParams.set('page', String(page))
    url.searchParams.set('page_size', String(perPage))

    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) {
      const detail = await safeBody(res)
      throw new Error(`NASA search failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`)
    }
    const data = await res.json() as NasaSearchResponse
    const items = Array.isArray(data?.collection?.items) ? data.collection.items : []
    if (items.length === 0) return []

    // Resolve manifests in bounded-parallel batches. Items whose manifest
    // fails or contains no usable video files get filtered out — never
    // surface an undownloadable result to the picker.
    const results: FetchResult[] = []
    for (let i = 0; i < items.length; i += MANIFEST_CONCURRENCY) {
      const batch = items.slice(i, i + MANIFEST_CONCURRENCY)
      const resolved = await Promise.all(batch.map(item => nasaItemToFetchResult(item).catch(() => null)))
      for (const r of resolved) if (r) results.push(r)
    }
    return results
  }

  async download(result: FetchResult, destPath: string, opts: DownloadOptions = {}): Promise<void> {
    if (result.provider !== 'nasa') {
      throw new Error(`NasaAdapter.download called with non-NASA result (${result.provider})`)
    }
    const file = pickFile(result, opts.quality ?? 'hd')
    if (!file) throw new Error(`NASA result ${result.source_id} has no downloadable files`)

    const tempPath = `${destPath}.tmp-${Date.now()}`
    await fs.mkdir(path.dirname(destPath), { recursive: true })

    const res = await fetch(file.url, { signal: opts.signal })
    if (!res.ok) {
      throw new Error(`NASA download failed: ${res.status} ${res.statusText} for ${file.url}`)
    }
    if (!res.body) throw new Error('NASA download returned no body')
    const nodeReadable = Readable.fromWeb(res.body as any)
    try {
      await pipeline(nodeReadable, createWriteStream(tempPath))
      await fs.rename(tempPath, destPath)
    } catch (e) {
      await fs.unlink(tempPath).catch(() => {})
      throw e
    }
  }
}

/** Resolve one NASA search item into a FetchResult. Fetches the asset
 *  manifest to discover the actual video file URLs. Throws when the
 *  item has no playable video or the manifest fetch fails (caller in
 *  search() catches + drops these items). */
async function nasaItemToFetchResult(item: NasaSearchItem): Promise<FetchResult> {
  const meta = item.data?.[0]
  if (!meta?.nasa_id) throw new Error('NASA item missing nasa_id')

  // Thumbnail: prefer the `links` entry with rel==='preview'.
  const thumbLink = (item.links || []).find(l => l.rel === 'preview' && l.render === 'image') || (item.links || [])[0]
  const thumbnail_url = thumbLink?.href || ''

  // Manifest fetch.
  const manRes = await fetch(item.href, { headers: { Accept: 'application/json' } })
  if (!manRes.ok) throw new Error(`Manifest fetch failed: ${manRes.status}`)
  const manifest = await manRes.json() as string[] | { items: Array<{ href: string }> }

  // The manifest is sometimes a flat array of URLs, sometimes a
  // collection-style object — handle both shapes defensively.
  const urls: string[] = Array.isArray(manifest)
    ? manifest
    : (manifest?.items || []).map(it => it.href).filter(Boolean) as string[]

  const files: FetchFile[] = []
  for (const u of urls) {
    const filename = u.split('/').pop() || ''
    const quality = classifyByFilename(filename)
    if (!quality) continue                       // skip non-video assets (jpg, srt, json…)
    const dims = QUALITY_WIDTH_ESTIMATE[quality]
    files.push({ quality, url: u, width: dims.w, height: dims.h })
  }
  if (files.length === 0) throw new Error('No playable video files in manifest')

  files.sort((a, b) => b.width - a.width)
  const best = files[0]

  // Page URL: NASA's site convention is `https://images.nasa.gov/details/<nasa_id>`.
  const source_url = `https://images.nasa.gov/details/${encodeURIComponent(meta.nasa_id)}`

  return {
    provider: 'nasa',
    source_id: meta.nasa_id,
    source_url,
    thumbnail_url,
    duration: 0,                                 // NASA's search response doesn't expose duration; would require an extra metadata.json fetch per item. Pickable, just shows as 0s in the UI.
    width: best?.width ?? 0,
    height: best?.height ?? 0,
    author: meta.secondary_creator || meta.center || 'NASA',
    license: NASA_LICENSE,
    license_url: NASA_LICENSE_URL,
    files,
  }
}

async function safeBody(res: Response): Promise<string> {
  try {
    const t = await res.text()
    return t.slice(0, 200)
  } catch {
    return ''
  }
}

export const nasa: FetchAdapter = new NasaAdapter()
