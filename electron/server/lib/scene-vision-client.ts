/**
 * Gateway scene analysis (Gateway 0.2.167+, Studio Hub 0.6.166 `vision-mlx`):
 * `POST /v1/vision/analyze`, `GET /v1/vision/models`. Contract: `_orchestra/audit-20261009/effects-plan/PLAN.md`
 * "Vision engine (shipped)".
 *
 * Same single endpoint and key as every other Gateway call; free fleet models only (the route can
 * never spend). Only the scene analysis runner calls this — never a render.
 */
import { getGenStudioUrl } from '../services/app-settings.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { readCatalogRows } from './genstudio-client.js'

/** A whole picture with all four tasks is 0.6–8 s on a fleet Mac; three Macs may be tried. */
const ANALYZE_TIMEOUT_MS = 90_000
const LIST_TIMEOUT_MS = 10_000

export type VisionTask = 'depth' | 'subject' | 'points' | 'segments'

export interface VisionModelRow { id: string; display_name: string; available: boolean; tasks: VisionTask[]; default: boolean }

export interface VisionAnalyzeRequest {
  tasks: VisionTask[]
  image: { b64: string; mime: 'image/jpeg' }
  model?: string[]
  text?: string
  regions?: string[]
  source_job_id?: string
  priority?: 'background'
}

/** The answer, as the Gateway sends it (only the fields Story reads). */
export interface VisionAnalyzeAnswer {
  models?: Record<string, string>
  revisions?: Record<string, string>
  depth?: { png_b64: string; w: number; h: number; near?: string; range?: number } | null
  subject?: { box: [number, number, number, number]; label?: string; score?: number; source?: string } | null
  points?: Array<{ box: [number, number, number, number]; label?: string }>
  caption?: string
  segments?: Record<string, { png_b64: string; w: number; h: number; coverage: number; score?: number } | null>
  served_by?: { location_id?: string; machine?: string; why?: string }
  network?: { request_bytes?: number; response_bytes?: number }
}

export class VisionGatewayError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly retryAfterSec: number | null) { super(message) }
}

/** Test seam: replaces `fetch`. */
let fetchImpl: typeof fetch = (...args) => fetch(...args)
export function _setVisionFetchForTesting(impl: typeof fetch | null): void { fetchImpl = impl ?? ((...args) => fetch(...args)) }

async function gateway(pathname: string, body: unknown, timeoutMs: number): Promise<{ payload: any; bytes: number }> {
  const apiKey = (await getApiKey('genstudio').catch(() => '')).trim()
  if (!apiKey) throw new VisionGatewayError('No Gateway API Key configured.', 0, 'NO_KEY', null)
  const base = (await getGenStudioUrl()).replace(/\/+$/, '')
  const response = await fetchImpl(`${base}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let payload: any = {}
  try { payload = JSON.parse(text) } catch { /* not JSON */ }
  if (!response.ok) {
    const code = typeof payload?.code === 'string' ? payload.code : `HTTP ${response.status}`
    const retry = Number(response.headers.get('retry-after'))
    throw new VisionGatewayError(`${code}: ${typeof payload?.detail === 'string' ? payload.detail : typeof payload?.message === 'string' ? payload.message : 'scene analysis request failed'}`,
      response.status, code, Number.isFinite(retry) && retry > 0 ? retry : null)
  }
  return { payload, bytes: Buffer.byteLength(text) }
}

export async function listVisionModels(): Promise<VisionModelRow[]> {
  const rows = readCatalogRows((await gateway('/v1/vision/models', undefined, LIST_TIMEOUT_MS)).payload) || []
  return rows.flatMap((row: any) => typeof row?.id === 'string'
    ? [{
        id: row.id,
        display_name: String(row.display_name || row.id),
        available: row.available !== false,
        tasks: Array.isArray(row.tasks) ? row.tasks.filter((t: unknown) => typeof t === 'string') : [],
        default: row.default === true,
      }]
    : [])
}

/** One picture, every asked task in one request (one upload). Throws {@link VisionGatewayError}. */
export async function analyzeImage(body: VisionAnalyzeRequest): Promise<{ answer: VisionAnalyzeAnswer; requestBytes: number; responseBytes: number }> {
  const requestBytes = Buffer.byteLength(JSON.stringify(body))
  const { payload, bytes } = await gateway('/v1/vision/analyze', body, ANALYZE_TIMEOUT_MS)
  return { answer: payload as VisionAnalyzeAnswer, requestBytes, responseBytes: bytes }
}
