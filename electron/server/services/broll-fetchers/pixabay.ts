/**
 * Pixabay Videos adapter.
 *
 * API docs: https://pixabay.com/api/docs/#api_videos
 *
 * Auth: API key as `?key=…` query parameter (NOT a header). Pixabay
 * rejects with 400 / "[ERROR 400] Invalid API key" when missing —
 * easier to debug than Pexels' silent 401.
 *
 * Rate limit (free tier): 100 requests / 60 seconds per IP. Effectively
 * unlimited for normal interactive use; large batch fetches via this
 * route are mediated by the job queue anyway.
 *
 * License: Pixabay License — free for commercial + personal use, no
 * attribution required, modifications allowed. CANNOT redistribute the
 * raw clips as-is (different from Pexels) — but we don't redistribute,
 * we ingest into rendered video output, so this is fine for our use.
 * We capture the license + license URL in every provenance sidecar.
 */

import { createWriteStream } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { getApiKey } from '../app-secrets-store.js'
import type {
  DownloadOptions,
  FetchAdapter,
  FetchFile,
  FetchQuality,
  FetchResult,
  SearchOptions,
} from './types.js'
import { pickFile } from './types.js'

const PIXABAY_API_BASE = 'https://pixabay.com/api/videos/'
const PIXABAY_LICENSE = 'Pixabay License'
const PIXABAY_LICENSE_URL = 'https://pixabay.com/service/license-summary/'

/**
 * Pixabay returns four named quality buckets — `large`, `medium`,
 * `small`, `tiny`. The named buckets DO NOT map cleanly to resolution
 * (e.g. `large` is sometimes 4K, sometimes 1920×1080). We classify by
 * width to align with our FetchQuality canonical set, same as the
 * Pexels adapter.
 */
function classifyQuality(width: number): FetchQuality {
  if (width >= 3840) return 'uhd'
  if (width >= 1920) return 'hd'
  if (width >= 640) return 'sd'
  return 'tiny'
}

interface PixabayVideoFile {
  url: string
  width: number
  height: number
  size: number
  thumbnail?: string
}

interface PixabayHit {
  id: number
  pageURL: string
  type: string  // "film" for videos
  tags: string  // comma-separated
  duration: number
  videos: {
    large?: PixabayVideoFile
    medium?: PixabayVideoFile
    small?: PixabayVideoFile
    tiny?: PixabayVideoFile
  }
  views: number
  downloads: number
  user_id: number
  user: string
  userImageURL?: string
}

interface PixabaySearchResponse {
  total: number
  totalHits: number
  hits: PixabayHit[]
}

class PixabayAdapter implements FetchAdapter {
  readonly provider = 'pixabay' as const

  async isConfigured(): Promise<boolean> {
    const key = await getApiKey('pixabay')
    return !!(key && key.trim())
  }

  async search(query: string, opts: SearchOptions = {}): Promise<FetchResult[]> {
    const key = await getApiKey('pixabay')
    if (!key) throw new Error('Pixabay API key not configured. Add it under App Settings → API Keys.')
    const q = query.trim()
    if (!q) return []
    const perPage = Math.min(Math.max(opts.perPage ?? 20, 3), 200)  // Pixabay min is 3
    const page = Math.max(opts.page ?? 1, 1)

    const url = new URL(PIXABAY_API_BASE)
    url.searchParams.set('key', key)
    url.searchParams.set('q', q)
    url.searchParams.set('per_page', String(perPage))
    url.searchParams.set('page', String(page))
    // Pixabay categories include 'backgrounds', 'nature', 'people' etc.
    // Leaving unset returns everything; the keyword query is doing the
    // filtering anyway.

    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) {
      const detail = await safeBody(res)
      throw new Error(`Pixabay search failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`)
    }
    const data = await res.json() as PixabaySearchResponse
    return data.hits.map(hit => pixabayToFetchResult(hit))
  }

  async download(result: FetchResult, destPath: string, opts: DownloadOptions = {}): Promise<void> {
    if (result.provider !== 'pixabay') {
      throw new Error(`PixabayAdapter.download called with non-Pixabay result (${result.provider})`)
    }
    const file = pickFile(result, opts.quality ?? 'hd')
    if (!file) throw new Error(`Pixabay result ${result.source_id} has no downloadable files`)

    const tempPath = `${destPath}.tmp-${Date.now()}`
    await fs.mkdir(path.dirname(destPath), { recursive: true })

    const res = await fetch(file.url, { signal: opts.signal })
    if (!res.ok) {
      throw new Error(`Pixabay download failed: ${res.status} ${res.statusText} for ${file.url}`)
    }
    if (!res.body) throw new Error('Pixabay download returned no body')
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

function pixabayToFetchResult(hit: PixabayHit): FetchResult {
  const files: FetchFile[] = []
  const buckets: Array<keyof PixabayHit['videos']> = ['large', 'medium', 'small', 'tiny']
  for (const b of buckets) {
    const v = hit.videos[b]
    if (!v || !v.url || v.width === 0) continue
    files.push({
      quality: classifyQuality(v.width),
      url: v.url,
      width: v.width,
      height: v.height,
      size_bytes: v.size,
    })
  }
  files.sort((a, b) => b.width - a.width)

  // Best-available dimensions = first (largest) file.
  const best = files[0]

  // Pixabay's thumbnail field is per-quality (each video file carries
  // its own). Fall back across buckets to find one. Worst case use a
  // constructed URL from the page (rare; the API populates `thumbnail`
  // reliably).
  const thumb = hit.videos.large?.thumbnail
    || hit.videos.medium?.thumbnail
    || hit.videos.small?.thumbnail
    || ''

  return {
    provider: 'pixabay',
    source_id: String(hit.id),
    source_url: hit.pageURL,
    thumbnail_url: thumb,
    duration: hit.duration,
    width: best?.width ?? 0,
    height: best?.height ?? 0,
    author: hit.user || '',
    license: PIXABAY_LICENSE,
    license_url: PIXABAY_LICENSE_URL,
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

export const pixabay: FetchAdapter = new PixabayAdapter()
