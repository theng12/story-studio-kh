/**
 * Gateway embeddings (Gateway 0.2.166+): `POST /v1/embeddings`, `GET /v1/embeddings/models`.
 *
 * Same single endpoint and key as every other Gateway call. Free fleet models only — the Gateway
 * refuses anything chargeable on this route. Only the Authorization header is sent (no caller
 * name), so nothing personal leaves this Mac with the texts.
 */
import { getGenStudioUrl } from '../services/app-settings.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { readCatalogRows } from './genstudio-client.js'

const TIMEOUT_MS = 10_000
/** Published per-request ceiling at the time of writing; the Gateway answers 422 above it. */
const MAX_INPUTS_PER_REQUEST = 2048

async function gateway(pathname: string, body?: unknown): Promise<any> {
  const apiKey = (await getApiKey('genstudio').catch(() => '')).trim()
  if (!apiKey) throw new Error('No Gateway API Key configured.')
  const base = (await getGenStudioUrl()).replace(/\/+$/, '')
  const response = await fetch(`${base}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const code = typeof payload?.code === 'string' ? payload.code : `HTTP ${response.status}`
    throw new Error(`${code}: ${typeof payload?.detail === 'string' ? payload.detail : 'embeddings request failed'}`)
  }
  return payload
}

export interface EmbeddingModelRow { id: string; display_name: string; available: boolean; dimensions?: number }

export async function listEmbeddingModels(): Promise<EmbeddingModelRow[]> {
  const rows = readCatalogRows(await gateway('/v1/embeddings/models')) || []
  return rows.flatMap((row: any) => typeof row?.id === 'string'
    ? [{ id: row.id, display_name: String(row.display_name || row.id), available: row.available !== false, dimensions: row.dimensions }]
    : [])
}

/** One unit vector per text, in order. Throws on any failure — callers fall back to word overlap. */
export async function embedTexts(model: string, texts: string[]): Promise<number[][]> {
  const vectors: number[][] = []
  for (let start = 0; start < texts.length; start += MAX_INPUTS_PER_REQUEST) {
    const input = texts.slice(start, start + MAX_INPUTS_PER_REQUEST).map(text => text.trim() || '-')
    const payload = await gateway('/v1/embeddings', { model, input })
    const data = Array.isArray(payload?.data) ? payload.data : []
    if (data.length !== input.length) throw new Error(`Gateway returned ${data.length} vectors for ${input.length} texts`)
    for (const row of [...data].sort((a: any, b: any) => a.index - b.index)) {
      if (!Array.isArray(row?.embedding)) throw new Error('Gateway returned a malformed embedding')
      vectors.push(row.embedding)
    }
  }
  return vectors
}
