/**
 * ElevenLabs voice catalog cache — per-machine, not per-project.
 *
 * Voices are user-account-wide in ElevenLabs (any project that uses the
 * same key gets the same voice list), so caching per-project would duplicate
 * data and fire redundant refreshes. We keep one cache file alongside
 * `app-settings.json` and every project reads from it.
 *
 * Lifecycle:
 *   - `loadCache()` reads the on-disk cache, if any. Silent [] on error.
 *   - `writeCache()` atomically rewrites the file. Non-fatal on error.
 *   - `isFresh()` applies the 24h TTL (user-configurable; fixed for now).
 *   - `fetchAndCache()` drives a live fetch + cache refresh. Callers that
 *      want a stale-OK read should hit `getCachedOrSnapshot` instead.
 */
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import { fetchCombinedVoices, type VoiceMeta } from '../lib/elevenlabs-voices.js'
import { VOICES_SNAPSHOT } from '../data/voices-snapshot.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..', '..')

const CACHE_TTL_MS = 24 * 60 * 60 * 1000   // 24h per user's chosen setting
const FILENAME = 'elevenlabs-voices.json'

function resolveCachePath(): string {
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return path.join(process.env.STORY_STUDIO_DATA_DIR, FILENAME)
  }
  const isPackaged = __dirname.includes('.asar') ||
    (!!process.resourcesPath && !process.env.ELECTRON_RUN_AS_NODE)
  if (isPackaged) {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const productName = 'Story Studio KH'
    let userData: string
    if (process.platform === 'darwin') {
      userData = path.join(home, 'Library', 'Application Support', productName)
    } else if (process.platform === 'win32') {
      userData = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), productName)
    } else {
      userData = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), productName)
    }
    return path.join(userData, FILENAME)
  }
  return path.join(ROOT, FILENAME)
}

const CACHE_PATH = resolveCachePath()

export interface VoicesCache {
  schema_version: 1
  fetched_at: string           // ISO timestamp
  voices: VoiceMeta[]
}

export interface CatalogResult {
  /** Where the voices came from — informs the UI "last refreshed" chip. */
  source: 'live' | 'cache' | 'snapshot'
  fetched_at: string | null
  voices: VoiceMeta[]
}

function readSnapshot(): VoiceMeta[] {
  // TS-imported module = no filesystem read, no path resolution drama,
  // and the snapshot ships inside the compiled asar on packaged builds.
  return [...VOICES_SNAPSHOT]
}

export async function loadCache(): Promise<VoicesCache | null> {
  try {
    if (!existsSync(CACHE_PATH)) return null
    const raw = await fs.readFile(CACHE_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed?.schema_version === 1 && Array.isArray(parsed.voices)) {
      return parsed as VoicesCache
    }
  } catch { /* corrupt — fall through */ }
  return null
}

async function writeCache(cache: VoicesCache): Promise<void> {
  try {
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true })
    await writeJsonAtomic(CACHE_PATH, cache)
  } catch (e: any) {
    console.warn('[voices-cache] write failed:', e?.message || e)
  }
}

export function isFresh(cache: VoicesCache | null, nowMs = Date.now()): boolean {
  if (!cache?.fetched_at) return false
  const age = nowMs - new Date(cache.fetched_at).getTime()
  return age >= 0 && age < CACHE_TTL_MS
}

/**
 * Read-only catalog accessor. Never makes network calls — the caller
 * chooses whether to kick off a background refresh. Priority order:
 *   1) Fresh cache (<24h old)
 *   2) Stale cache
 *   3) Bundled snapshot
 *   4) Empty list
 */
export async function getCachedOrSnapshot(): Promise<CatalogResult> {
  const cache = await loadCache()
  if (cache) {
    return {
      source: isFresh(cache) ? 'cache' : 'cache',  // both fresh + stale are 'cache'
      fetched_at: cache.fetched_at,
      voices: cache.voices,
    }
  }
  return { source: 'snapshot', fetched_at: null, voices: readSnapshot() }
}

/**
 * Live fetch + cache write. Throws on ElevenLabs error so the caller
 * can show a specific "refresh failed: <reason>" toast — callers that
 * want silent behaviour should wrap.
 */
export async function fetchAndCache(
  apiKey: string,
  opts: { language?: string; shared?: boolean } = {},
): Promise<VoicesCache> {
  if (!apiKey) throw new Error('ElevenLabs API key required to refresh the voice catalog.')
  const voices = await fetchCombinedVoices(apiKey, opts)
  const cache: VoicesCache = {
    schema_version: 1,
    fetched_at: new Date().toISOString(),
    voices,
  }
  await writeCache(cache)
  return cache
}

/**
 * Convenience for routes: if cache is fresh use it, otherwise try a
 * background live fetch. Never throws — degrades through the chain.
 */
export async function resolveCatalog(
  apiKey: string | undefined,
  opts: { forceRefresh?: boolean; language?: string } = {},
): Promise<CatalogResult> {
  const cache = await loadCache()
  if (!opts.forceRefresh && isFresh(cache)) {
    return { source: 'cache', fetched_at: cache!.fetched_at, voices: cache!.voices }
  }
  if (apiKey) {
    try {
      const fresh = await fetchAndCache(apiKey, { language: opts.language })
      return { source: 'live', fetched_at: fresh.fetched_at, voices: fresh.voices }
    } catch (e: any) {
      console.warn('[voices-cache] live fetch failed, falling back:', e?.message || e)
    }
  }
  if (cache) {
    return { source: 'cache', fetched_at: cache.fetched_at, voices: cache.voices }
  }
  return getCachedOrSnapshot()
}
