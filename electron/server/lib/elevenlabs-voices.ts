/**
 * ElevenLabs voice catalog client — fetches and normalises voice metadata
 * from the two relevant endpoints:
 *
 *   GET /v1/voices           — the user's own premade + cloned voices
 *                              (always returns ~20–50 items).
 *   GET /v1/shared-voices    — the community "Voice Library" with
 *                              popularity, language filters, etc.
 *                              Paginated; we fetch the top-100 English
 *                              voices by user count.
 *
 * Returns a merged, deduped, normalised array of `VoiceMeta` that the
 * frontend picker renders directly. Failures in one endpoint don't nuke
 * the other — e.g. if /shared-voices 403s on a restricted account, the
 * user's own voices still populate.
 */

export interface VoiceMeta {
  voice_id: string
  name: string
  /** 'premade' (stock), 'cloned' (user-cloned), 'generated' (user-generated), 'library' (community shared). */
  category: 'premade' | 'cloned' | 'generated' | 'library' | 'professional' | 'unknown'
  gender: 'male' | 'female' | 'neutral' | 'unknown'
  language: string          // ISO-639-1 code, lowercase — e.g. 'en'
  accent?: string           // Free-form — 'American', 'British', 'Australian', etc.
  age?: string              // 'young', 'middle_aged', 'old', or custom.
  use_case?: string         // 'narration', 'conversational', 'characters', …
  description?: string
  preview_url: string | null
  /** Relative popularity (higher = more used). Only populated from /shared-voices. */
  popularity?: number
}

const BASE = 'https://api.elevenlabs.io/v1'
const TIMEOUT_MS = 15_000

async function fetchJson<T>(path: string, apiKey: string): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'xi-api-key': apiKey, 'accept': 'application/json' },
      signal: ctrl.signal as any,
    })
    if (!res.ok) {
      throw new Error(`ElevenLabs ${path} → ${res.status} ${res.statusText}`)
    }
    return await res.json() as T
  } finally {
    clearTimeout(t)
  }
}

/** Normalise a raw `/v1/voices` item into our shape. */
function normaliseUserVoice(raw: any): VoiceMeta | null {
  if (!raw?.voice_id || !raw?.name) return null
  const labels = raw.labels || {}
  return {
    voice_id: raw.voice_id,
    name: raw.name,
    category: (raw.category as any) || 'unknown',
    gender: (labels.gender as any) || 'unknown',
    language: (labels.language || 'en').toLowerCase(),
    accent: labels.accent,
    age: labels.age,
    use_case: labels.use_case || labels.useCase,
    description: raw.description,
    preview_url: raw.preview_url || null,
  }
}

/** Normalise a raw `/v1/shared-voices` item into our shape. */
function normaliseSharedVoice(raw: any): VoiceMeta | null {
  const id = raw?.voice_id || raw?.voiceId || raw?.public_owner_id
  if (!id || !raw?.name) return null
  return {
    voice_id: id,
    name: raw.name,
    category: 'library',
    gender: (raw.gender as any) || 'unknown',
    language: (raw.language || 'en').toLowerCase(),
    accent: raw.accent,
    age: raw.age,
    use_case: raw.use_case,
    description: raw.description,
    preview_url: raw.preview_url || null,
    popularity: typeof raw.cloned_by_count === 'number'
      ? raw.cloned_by_count
      : (typeof raw.usage_character_count_1y === 'number' ? raw.usage_character_count_1y : undefined),
  }
}

/**
 * Fetch the user's own voices (premade + cloned + generated). Always
 * attempted — free-tier and above works.
 */
export async function fetchUserVoices(apiKey: string): Promise<VoiceMeta[]> {
  try {
    const data = await fetchJson<{ voices: any[] }>('/voices', apiKey)
    return (data.voices || [])
      .map(normaliseUserVoice)
      .filter((v): v is VoiceMeta => v !== null)
  } catch (e: any) {
    console.warn('[elevenlabs-voices] fetchUserVoices failed:', e?.message || e)
    return []
  }
}

/**
 * Fetch the top community-shared voices from the Voice Library. Defaults
 * to English, sorted by popularity, 100 per page.
 *
 * Some accounts may 403 on shared-voices depending on tier; we swallow
 * the error and return [] so the user's own voices still populate.
 */
export async function fetchSharedVoices(
  apiKey: string,
  opts: { language?: string; pageSize?: number } = {},
): Promise<VoiceMeta[]> {
  const language = opts.language || 'en'
  const pageSize = Math.min(Math.max(opts.pageSize || 100, 1), 100)
  const path = `/shared-voices?page_size=${pageSize}&sort=most_users&language=${encodeURIComponent(language)}`
  try {
    const data = await fetchJson<{ voices: any[] }>(path, apiKey)
    return (data.voices || [])
      .map(normaliseSharedVoice)
      .filter((v): v is VoiceMeta => v !== null)
  } catch (e: any) {
    console.warn('[elevenlabs-voices] fetchSharedVoices failed:', e?.message || e)
    return []
  }
}

/**
 * Merge user + shared, dedupe by voice_id (user's own voice wins over
 * a matching shared-voice entry so `category: "cloned"` isn't overwritten
 * by `category: "library"`).
 *
 * Returns a single sorted list — user voices first (by name), then shared
 * voices sorted by popularity descending.
 */
export async function fetchCombinedVoices(
  apiKey: string,
  opts: { language?: string; shared?: boolean } = {},
): Promise<VoiceMeta[]> {
  const [user, shared] = await Promise.all([
    fetchUserVoices(apiKey),
    opts.shared === false ? Promise.resolve([]) : fetchSharedVoices(apiKey, { language: opts.language }),
  ])
  const byId = new Map<string, VoiceMeta>()
  // User voices first so their category/name wins on collision.
  for (const v of user) byId.set(v.voice_id, v)
  for (const v of shared) if (!byId.has(v.voice_id)) byId.set(v.voice_id, v)

  const userList = user.sort((a, b) => a.name.localeCompare(b.name))
  const userIds = new Set(userList.map(v => v.voice_id))
  const sharedList = Array.from(byId.values())
    .filter(v => !userIds.has(v.voice_id))
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))

  return [...userList, ...sharedList]
}
