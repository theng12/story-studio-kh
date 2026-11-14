/**
 * The Gateway's footage catalogue and store, read-only (v1.4.402).
 *
 * The Gateway owns the catalogue, the licence gate and the stored bytes; Story
 * owns where the downloaded copy lives on this Mac (see
 * `services/footage-library.ts`). These are the same free, read-only calls the
 * sound library makes: one paired Gateway, the scoped API key, no generation.
 *
 * Every row is relayed exactly as the Gateway sends it — no field is filled in,
 * renamed or guessed. A clip the Gateway has not published a licence for stays
 * unlicensed here rather than being offered with an invented one.
 */
import { getGenStudioUrl } from '../services/app-settings.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { STORY_CALLER } from './machine-name.js'

/** One catalogue row: a library clip, or an upstream search hit not yet kept. */
export interface FootageCatalogueRow {
  /** Present on library rows. An upstream search hit has no identity until it is kept. */
  sha256?: string | null
  source?: string | null
  source_id?: string | null
  title?: string | null
  description?: string | null
  tags?: string[] | null
  licence?: string | null
  licence_note?: string | null
  provenance?: string | null
  source_url?: string | null
  author?: string | null
  attribution?: string | null
  /** Upstream search hits publish a container; library rows are served by media type. */
  filetype?: string | null
  mime?: string | null
  filesize?: number | null
  filesize_bytes?: number | null
  duration_seconds?: number | null
  width?: number | null
  height?: number | null
  resolution?: string | null
  fps?: number | null
  codec?: string | null
  ai_generated?: boolean | null
  added_at?: number | null
  not_recorded?: string[]
  [field: string]: unknown
}

export interface FootageSearchAnswer {
  /** Upstream connector hits (no sha256 yet). */
  results: FootageCatalogueRow[]
  /** The Gateway's own library, resolvable by sha256. */
  library: FootageCatalogueRow[]
  /** One report per stock source that was tried. */
  sources: Array<{ id?: string; ok?: boolean; error?: string; [field: string]: unknown }>
  /** Say instead of "nothing matched" when a source could not be reached. */
  note?: string
}

export interface FootageQuota {
  files: number
  bytes: number
  root: string
  free_bytes: number
}

export interface FootageSourceRow {
  id: string
  label?: string
  free?: boolean
  needs_key?: boolean
  configured?: boolean
  enabled?: boolean
  cost?: string
  [field: string]: unknown
}

/** A control call; a JSON answer should be quick even when the library is large. */
const REQUEST_TIMEOUT_MS = 20_000
/** A clip is a download, not a query. */
const FILE_TIMEOUT_MS = 120_000

async function gatewayRequest<T>(pathname: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const [baseUrl, apiKey] = await Promise.all([getGenStudioUrl(), getApiKey('genstudio')])
  if (!apiKey.trim()) throw new Error('No Gateway API Key configured. Open Settings → This Mac → Gateway API Key.')
  const url = `${baseUrl.trim().replace(/\/+$/, '')}${pathname}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'X-Caller': STORY_CALLER,
        ...(init.headers as Record<string, string> | undefined),
      },
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      const detail = (body as any)?.detail || (body as any)?.message
      throw Object.assign(
        new Error(typeof detail === 'string' && detail ? detail : `The Gateway answered ${response.status}.`),
        { statusCode: response.status },
      )
    }
    return body as T
  } finally {
    clearTimeout(timer)
  }
}

function catalogueRows(value: unknown): FootageCatalogueRow[] {
  return Array.isArray(value)
    ? value.filter((row): row is FootageCatalogueRow => !!row && typeof row === 'object' && !Array.isArray(row))
    : []
}

/**
 * Search the enabled stock connectors and the Gateway's own library.
 *
 * The two lists stay separate: only the library list carries a sha256, so only
 * those rows can be resolved locally without keeping the clip first.
 */
export async function searchFootage(query: string, tag?: string): Promise<FootageSearchAnswer> {
  const params = new URLSearchParams({ q: query || '' })
  if (tag && tag.trim()) params.set('tag', tag.trim())
  const body = await gatewayRequest<Record<string, unknown>>(`/v1/footage/search?${params.toString()}`)
  const sources = Array.isArray(body?.sources)
    ? body.sources.filter((row): row is FootageSearchAnswer['sources'][number] => !!row && typeof row === 'object')
    : []
  return {
    results: catalogueRows(body?.results),
    library: catalogueRows(body?.library),
    sources,
    ...(typeof body?.note === 'string' && body.note.trim() ? { note: body.note } : {}),
  }
}

/** Every clip in the Gateway's own library, newest first. */
export async function listFootageLibrary(): Promise<FootageCatalogueRow[]> {
  const body = await gatewayRequest<{ clips?: unknown }>('/v1/footage/library')
  return catalogueRows(body?.clips)
}

/** The library's measured footprint (files, bytes, root, free disk). */
export async function getFootageQuota(): Promise<FootageQuota> {
  return gatewayRequest<FootageQuota>('/v1/footage/quota')
}

/** Every stock source, its licence/cost line, and whether it is switched on. */
export async function getFootageSources(): Promise<FootageSourceRow[]> {
  const body = await gatewayRequest<{ sources?: unknown }>('/v1/footage/sources')
  return Array.isArray(body?.sources)
    ? body.sources.filter((row): row is FootageSourceRow => !!row && typeof row === 'object' && !Array.isArray(row) && typeof (row as any).id === 'string')
    : []
}

/** One library clip's bytes, exactly as stored and served by the Gateway. */
export async function downloadFootageFile(sha256: string): Promise<{ bytes: Buffer; contentType: string }> {
  const [baseUrl, apiKey] = await Promise.all([getGenStudioUrl(), getApiKey('genstudio')])
  if (!apiKey.trim()) throw new Error('No Gateway API Key configured. Open Settings → This Mac → Gateway API Key.')
  const url = `${baseUrl.trim().replace(/\/+$/, '')}/v1/footage/library/${encodeURIComponent(sha256)}/file`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FILE_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey.trim()}`, 'X-Caller': STORY_CALLER },
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as any
      const detail = body?.detail || body?.message
      throw Object.assign(
        new Error(typeof detail === 'string' && detail ? detail : `The Gateway answered ${response.status}.`),
        { statusCode: response.status },
      )
    }
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: String(response.headers.get('content-type') || ''),
    }
  } finally {
    clearTimeout(timer)
  }
}
