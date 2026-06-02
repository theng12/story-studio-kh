/**
 * Pexels Videos adapter.
 *
 * API docs: https://www.pexels.com/api/documentation/#videos
 *
 * Auth: API key in the `Authorization` header (NO `Bearer ` prefix —
 * Pexels is one of the rare APIs that just wants the raw key).
 *
 * Rate limit (free tier): 200 requests/hour, 20,000 requests/month.
 * The X-Ratelimit-Limit / X-Ratelimit-Remaining / X-Ratelimit-Reset
 * response headers are surfaced via the route layer so the UI can warn
 * the user before they hit the cap.
 *
 * License: Pexels License — free for commercial + personal use, no
 * attribution required, modifications allowed. We capture the license
 * + license URL in every provenance sidecar regardless, so a future
 * license change at Pexels' end is recoverable from local data.
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

const PEXELS_API_BASE = 'https://api.pexels.com/videos'
const PEXELS_LICENSE = 'Pexels License'
const PEXELS_LICENSE_URL = 'https://www.pexels.com/license/'

/**
 * Map Pexels' `quality` string to our canonical `FetchQuality`.
 *   uhd → uhd  (3840×2160 or larger)
 *   hd  → hd   (≥1280×720, but Pexels also tags 1920×1080 as 'hd')
 *   sd  → sd   (smaller than 720p)
 *   hls / other → 'tiny' (low-res or streaming-only; rarely useful)
 *
 * Pexels also returns each `video_files` entry with explicit width +
 * height, so the consumer can pick by dimensions if the quality tag
 * disagrees. We bias by width: ≥3840 → uhd, ≥1920 → hd, ≥640 → sd,
 * else tiny. Tag-disagrees-with-dimensions is rare but happens
 * (uploader-controlled metadata).
 */
function classifyQuality(file: { quality?: string; width: number }): FetchQuality {
  if (file.width >= 3840) return 'uhd'
  if (file.width >= 1920) return 'hd'
  if (file.width >= 640) return 'sd'
  return 'tiny'
}

interface PexelsVideoFile {
  id: number
  quality: string
  file_type: string
  width: number
  height: number
  fps: number
  link: string
}

interface PexelsVideo {
  id: number
  width: number
  height: number
  url: string
  image: string  // thumbnail
  duration: number
  user: { id: number; name: string; url: string }
  video_files: PexelsVideoFile[]
}

interface PexelsSearchResponse {
  page: number
  per_page: number
  total_results: number
  videos: PexelsVideo[]
}

class PexelsAdapter implements FetchAdapter {
  readonly provider = 'pexels' as const

  async isConfigured(): Promise<boolean> {
    const key = await getApiKey('pexels')
    return !!(key && key.trim())
  }

  async search(query: string, opts: SearchOptions = {}): Promise<FetchResult[]> {
    const key = await getApiKey('pexels')
    if (!key) throw new Error('Pexels API key not configured. Add it under App Settings → API Keys.')
    const q = query.trim()
    if (!q) return []
    const perPage = Math.min(Math.max(opts.perPage ?? 20, 1), 80)
    const page = Math.max(opts.page ?? 1, 1)

    const url = new URL(`${PEXELS_API_BASE}/search`)
    url.searchParams.set('query', q)
    url.searchParams.set('per_page', String(perPage))
    url.searchParams.set('page', String(page))
    // Bias toward landscape since B-Roll is rendered into a 16:9 canvas.
    // (Pexels also has 'portrait' and 'square'; landscape is what we want.)
    url.searchParams.set('orientation', 'landscape')

    const res = await fetch(url, {
      headers: {
        // NOT `Bearer …` — Pexels takes the raw key. Mistake here returns
        // a 401 with no body, which is the easiest way to get this wrong.
        Authorization: key,
        Accept: 'application/json',
      },
    })
    if (!res.ok) {
      const detail = await safeBody(res)
      throw new Error(`Pexels search failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`)
    }
    const data = await res.json() as PexelsSearchResponse

    return data.videos.map(v => pexelsToFetchResult(v))
  }

  async download(result: FetchResult, destPath: string, opts: DownloadOptions = {}): Promise<void> {
    if (result.provider !== 'pexels') {
      throw new Error(`PexelsAdapter.download called with non-Pexels result (${result.provider})`)
    }
    const file = pickFile(result, opts.quality ?? 'hd')
    if (!file) throw new Error(`Pexels result ${result.source_id} has no downloadable files`)

    const tempPath = `${destPath}.tmp-${Date.now()}`
    await fs.mkdir(path.dirname(destPath), { recursive: true })

    const res = await fetch(file.url, { signal: opts.signal })
    if (!res.ok) {
      throw new Error(`Pexels download failed: ${res.status} ${res.statusText} for ${file.url}`)
    }
    if (!res.body) throw new Error('Pexels download returned no body')
    // Node 18+ exposes web Streams ReadableStream on res.body. Convert
    // to Node Readable so `pipeline` can compose it with the writable
    // file stream.
    const nodeReadable = Readable.fromWeb(res.body as any)
    try {
      await pipeline(nodeReadable, createWriteStream(tempPath))
      await fs.rename(tempPath, destPath)
    } catch (e) {
      // Clean up the temp file on any failure so we don't leave debris.
      await fs.unlink(tempPath).catch(() => {})
      throw e
    }
  }
}

function pexelsToFetchResult(v: PexelsVideo): FetchResult {
  // Sort files best-first by width (ignoring streaming-only entries).
  // Filter HLS / non-mp4 entries — those are for adaptive players, not
  // local files we want to download.
  const mp4Files = v.video_files
    .filter(f => f.file_type === 'video/mp4' && typeof f.link === 'string')
    .sort((a, b) => b.width - a.width)

  const files: FetchFile[] = mp4Files.map(f => ({
    quality: classifyQuality(f),
    url: f.link,
    width: f.width,
    height: f.height,
  }))

  return {
    provider: 'pexels',
    source_id: String(v.id),
    source_url: v.url,
    thumbnail_url: v.image,
    duration: v.duration,
    width: v.width,
    height: v.height,
    author: v.user?.name || '',
    author_url: v.user?.url,
    license: PEXELS_LICENSE,
    license_url: PEXELS_LICENSE_URL,
    files,
  }
}

/** Best-effort body extraction for error messages. Bails on parse error
 *  rather than masking the original HTTP failure. */
async function safeBody(res: Response): Promise<string> {
  try {
    const t = await res.text()
    return t.slice(0, 200)
  } catch {
    return ''
  }
}

export const pexels: FetchAdapter = new PexelsAdapter()
