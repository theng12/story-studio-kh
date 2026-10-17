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

/** One vector, made safe to compare and to cache. */
function unitVector(values: unknown[], expected: number | null): number[] {
  const vector: number[] = []
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('Gateway returned an embedding with a missing or non-finite value')
    }
    vector.push(value)
  }
  if (expected !== null && vector.length !== expected) {
    throw new Error(`Gateway returned a ${vector.length}-dimension embedding where ${expected} were expected`)
  }
  // Math.hypot scales by the largest component, so it is far safer than sqrt(Σx²)
  // for very small vectors — but components that are each finite can still have a
  // combined length past Number.MAX_VALUE, which comes back as Infinity. Dividing
  // by that would turn every component into 0, i.e. the all-zero vector this
  // function exists to refuse, so finiteness is checked before the length is used.
  const norm = Math.hypot(...vector)
  if (!Number.isFinite(norm)) {
    throw new Error('Gateway returned an embedding whose values are too large to compare')
  }
  // An all-zero vector has no direction: every comparison against it is 0, which
  // reads downstream as "nothing is similar" rather than "this answer is useless".
  if (!(norm > 0)) throw new Error('Gateway returned an embedding with no direction (all zeros)')
  // Every caller compares against thresholds calibrated as cosine on UNIT vectors,
  // so the promise in this module's header is made true here rather than assumed.
  // For a model that already answers in unit vectors this is a no-op to ~1e-10.
  return vector.map(value => value / norm)
}

/**
 * One response's rows, in input order and safe to cache.
 *
 * Each row may name the input it answers. When EVERY row names one, the names
 * decide the order and a repeated or out-of-range index is refused — a vector
 * filed under the wrong text would be cached under it for the rest of the run.
 * When NO row names one, array order decides, which is what this route has always
 * relied on. A batch where only some rows name one is refused: it cannot be
 * aligned honestly.
 *
 * Throws on anything else, before the caller caches a single vector. Pure, so the
 * trust boundary is testable without a network.
 */
export function readEmbeddingVectors(data: unknown, inputLength: number, dimensions: number | null): number[][] {
  const rows = Array.isArray(data) ? data : []
  if (rows.length !== inputLength) throw new Error(`Gateway returned ${rows.length} vectors for ${inputLength} texts`)
  const indices = rows.map(row => (row as any)?.index)
  // Only an ABSENT index is unnamed. A row carrying `index: null` is a row that
  // tried to name its input and failed, so it takes the named path and is refused
  // below, rather than quietly falling back to array order.
  const named = indices.filter(index => index !== undefined).length
  if (named !== 0 && named !== rows.length) {
    throw new Error('Gateway returned a batch where only some embeddings name their input')
  }
  const ordered: number[][] = new Array(inputLength)
  const seen = new Set<number>()
  let width = dimensions
  for (let row = 0; row < rows.length; row++) {
    const raw = indices[row]
    // The Gateway's contract is an integer index. A number is taken as-is; a plain
    // digit string is accepted as the deliberate legacy of the `a.index - b.index`
    // sort this replaces; anything else is refused rather than coerced. Number(null)
    // and Number('') are both 0, so coercing either would file that vector at
    // position 0 — cached under the wrong text for the rest of the run, which is
    // exactly what this boundary exists to prevent. When NO row named an index at
    // all, array order is used instead (the behavior this route has always had).
    const at = !named ? row
      : typeof raw === 'number' ? raw
        : typeof raw === 'string' && /^[0-9]+$/.test(raw) ? Number(raw)
          : NaN
    if (!Number.isInteger(at) || at < 0 || at >= inputLength || seen.has(at)) {
      throw new Error(`Gateway returned a malformed embedding index: ${String(raw)}`)
    }
    const embedding = (rows[row] as any)?.embedding
    if (!Array.isArray(embedding)) throw new Error('Gateway returned a malformed embedding')
    const vector = unitVector(embedding, width)
    if (width === null) width = vector.length
    ordered[at] = vector
    seen.add(at)
  }
  return ordered
}

/** One unit vector per text, in order. Throws on any failure — callers fall back to word overlap. */
export async function embedTexts(model: string, texts: string[]): Promise<number[][]> {
  const vectors: number[][] = []
  let dimensions: number | null = null
  for (let start = 0; start < texts.length; start += MAX_INPUTS_PER_REQUEST) {
    const input = texts.slice(start, start + MAX_INPUTS_PER_REQUEST).map(text => text.trim() || '-')
    const payload = await gateway('/v1/embeddings', { model, input })
    const batch = readEmbeddingVectors(payload?.data, input.length, dimensions)
    dimensions = batch[0]?.length ?? dimensions
    vectors.push(...batch)
  }
  return vectors
}
