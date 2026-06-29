/**
 * Freesound adapter — sound-effects search/download for `audio` (SFX) pools.
 *
 * API docs: https://freesound.org/docs/api/resources_apiv2.html#text-search
 *
 * Auth: token in the `Authorization` header as `Token <key>` (NOT OAuth2).
 * The token-only credential is enough for text search AND for downloading the
 * pre-rendered **previews** (the `previews.preview-hq-mp3` URL — 128 kbps MP3).
 * Only the original-quality download endpoint needs OAuth2; we deliberately
 * fetch the HQ preview instead so a plain token works end-to-end. Previews are
 * public CDN URLs, so the download itself carries no auth header.
 *
 * License: each result carries its own Creative-Commons license URL (CC0,
 * CC-BY, CC-BY-NC, etc.) — varies per clip, unlike Pexels' single house
 * license. We capture the exact `license` URL per result in the provenance
 * sidecar so attribution requirements are recoverable later.
 *
 * Tags: Freesound returns a `tags` array per result. We pass it through on
 * `FetchResult.tags`; the fetch executor applies them to the indexed clip so
 * fetched SFX land pre-tagged (no vision auto-tag pass for audio).
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
  FetchResult,
  SearchOptions,
} from './types.js'
import { pickFile } from './types.js'

const FREESOUND_API_BASE = 'https://freesound.org/apiv2'
// Fields we ask the API to return — keep it tight so the JSON stays small.
const FREESOUND_FIELDS = 'id,name,tags,license,previews,duration,username,url'

interface FreesoundPreviews {
  'preview-hq-mp3'?: string
  'preview-lq-mp3'?: string
  'preview-hq-ogg'?: string
  'preview-lq-ogg'?: string
}

interface FreesoundResult {
  id: number
  name: string
  tags?: string[]
  /** Per-clip Creative-Commons license URL. */
  license: string
  previews?: FreesoundPreviews
  duration: number
  username: string
  /** Page URL on freesound.org for this sound. */
  url: string
}

interface FreesoundSearchResponse {
  count: number
  next: string | null
  previous: string | null
  results: FreesoundResult[]
}

class FreesoundAdapter implements FetchAdapter {
  readonly provider = 'freesound' as const

  async isConfigured(): Promise<boolean> {
    const key = await getApiKey('freesound')
    return !!(key && key.trim())
  }

  async search(query: string, opts: SearchOptions = {}): Promise<FetchResult[]> {
    const key = await getApiKey('freesound')
    if (!key) throw new Error('Freesound API key not configured. Add it under App Settings → API Keys.')
    const q = query.trim()
    if (!q) return []
    const pageSize = Math.min(Math.max(opts.perPage ?? 20, 1), 150)
    const page = Math.max(opts.page ?? 1, 1)

    const url = new URL(`${FREESOUND_API_BASE}/search/text/`)
    url.searchParams.set('query', q)
    url.searchParams.set('fields', FREESOUND_FIELDS)
    url.searchParams.set('page_size', String(pageSize))
    url.searchParams.set('page', String(page))

    const res = await fetch(url, {
      headers: {
        Authorization: `Token ${key}`,
        Accept: 'application/json',
      },
    })
    if (!res.ok) {
      const detail = await safeBody(res)
      throw new Error(`Freesound search failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`)
    }
    const data = await res.json() as FreesoundSearchResponse

    // Drop results with no HQ-mp3 preview — without it there's nothing we can
    // download with a token-only credential.
    return (data.results || [])
      .map(r => freesoundToFetchResult(r))
      .filter((r): r is FetchResult => r !== null)
  }

  async download(result: FetchResult, destPath: string, opts: DownloadOptions = {}): Promise<void> {
    if (result.provider !== 'freesound') {
      throw new Error(`FreesoundAdapter.download called with non-Freesound result (${result.provider})`)
    }
    // Audio results expose a single 'sd' file (the HQ-mp3 preview); pickFile
    // falls back to it regardless of the requested quality.
    const file = pickFile(result, opts.quality ?? 'sd')
    if (!file) throw new Error(`Freesound result ${result.source_id} has no downloadable preview`)

    const tempPath = `${destPath}.tmp-${Date.now()}`
    await fs.mkdir(path.dirname(destPath), { recursive: true })

    // Preview URLs are public CDN links — no Authorization header needed.
    const res = await fetch(file.url, { signal: opts.signal })
    if (!res.ok) {
      throw new Error(`Freesound download failed: ${res.status} ${res.statusText} for ${file.url}`)
    }
    if (!res.body) throw new Error('Freesound download returned no body')
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

function freesoundToFetchResult(r: FreesoundResult): FetchResult | null {
  const previewUrl = r.previews?.['preview-hq-mp3']
  if (!previewUrl) return null

  // Audio has no dimensions — width/height land as 0, mirroring how the
  // indexer records audio clips. Single file at our canonical 'sd' tier.
  const files: FetchFile[] = [{ quality: 'sd', url: previewUrl, width: 0, height: 0 }]

  return {
    provider: 'freesound',
    source_id: String(r.id),
    source_url: r.url,
    thumbnail_url: '',  // audio has no still — UI renders an inline player instead
    duration: typeof r.duration === 'number' ? r.duration : 0,
    width: 0,
    height: 0,
    author: r.username || '',
    license: r.license || 'Freesound (CC)',
    license_url: r.license || 'https://freesound.org/help/faq/#licenses',
    files,
    tags: Array.isArray(r.tags) ? r.tags : [],
  }
}

/** Best-effort body extraction for error messages. */
async function safeBody(res: Response): Promise<string> {
  try {
    const t = await res.text()
    return t.slice(0, 200)
  } catch {
    return ''
  }
}

export const freesound: FetchAdapter = new FreesoundAdapter()
