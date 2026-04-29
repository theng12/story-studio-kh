/**
 * Shared utilities — episode paths, credit checks, API key testing.
 */

import path from 'path'
import { createHash } from 'crypto'
import { PROJECTS_ROOT, getProjectDir } from './project-manager.js'

/**
 * Resolve a project's directory regardless of whether it lives in the
 * default PROJECTS_ROOT or in a linked location (registered via
 * "Add existing project folder…"). Falls back to the default-location
 * path when the registry doesn't know the slug yet — that branch only
 * matters during fresh project creation, when the directory is about
 * to be created on disk.
 */
function projectDirFor(slug: string): string {
  return getProjectDir(slug) || path.join(PROJECTS_ROOT, slug)
}

// ── Episode path resolver ───────────────────────────────────────────────────

export function episodeNumber(code: string, prefix: string = 'EP'): number {
  const pattern = new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)`, 'i')
  const match = code.match(pattern)
  if (!match) throw new Error(`Invalid episode code: ${code} (expected prefix: ${prefix})`)
  return parseInt(match[1], 10)
}

export function formatEpisodeCode(num: number, prefix: string = 'EP', digits: number = 4): string {
  return `${prefix}${num.toString().padStart(digits, '0')}`
}

export interface EpisodePaths {
  output_root: string
  episode_dir: string
  script_dir: string
  scene_prompts_dir: string
  thumb_prompts_dir: string
  metadata_dir: string
  bg_dir: string
  thumb_dir: string
  audio_dir: string
  merged_audio_dir: string
  // New in the 07→08→09→10 contract; callers that predate it should
  // ignore this field rather than rely on it.
  subtitles_dir: string
  video_dir: string
  narration_docx: string
  scene_prompts_docx: string
  thumb_prompts_docx: string
  metadata_txt: string
  metadata_json: string
}

export async function resolveEpisodePaths(slug: string, code: string, title: string): Promise<EpisodePaths> {
  const { readFile } = await import('fs/promises')

  const projectDir = projectDirFor(slug)
  const metaRaw = await readFile(path.join(projectDir, 'project.json'), 'utf-8')
  const meta = JSON.parse(metaRaw)

  const prefix = meta.episode_prefix || 'EP'
  const seasonSize = meta.season_size || 20
  const seasonPrefix = meta.season_prefix || 'Season'
  const folderTemplate = meta.folder_template || '{season_prefix} {season_num}/{code} - {title}/'
  const subfolder = meta.subfolder_names || {}

  const epNum = episodeNumber(code, prefix)
  const seasonNum = Math.floor((epNum - 1) / seasonSize) + 1

  let outputRoot = meta.output_root || './episodes'
  if (!path.isAbsolute(outputRoot)) {
    // Relative output_root resolves against the project's actual
    // directory (linked or default) — not unconditionally against
    // PROJECTS_ROOT — so iCloud-synced projects with output_root:
    // './episodes' look in the right place.
    outputRoot = path.join(projectDir, outputRoot)
  }

  const episodeRel = folderTemplate
    .replace('{season_prefix}', seasonPrefix)
    .replace('{season_num}', seasonNum.toString().padStart(3, '0'))
    .replace('{code}', code)
    .replace('{title}', title)

  const episodeDir = path.join(outputRoot, episodeRel)

  const { DEFAULT_SUBFOLDER_NAMES } = await import('../models/types.js')
  const d = DEFAULT_SUBFOLDER_NAMES
  const scriptName = (subfolder.script || d.script).replace('{code}', code)
  const scenePromptsName = (subfolder.scene_prompts || d.scene_prompts).replace('{code}', code)
  const thumbPromptsName = (subfolder.thumb_prompts || d.thumb_prompts).replace('{code}', code)
  const metadataName = (subfolder.metadata || d.metadata).replace('{code}', code)
  const imagesName = (subfolder.images || d.images).replace('{code}', code)
  const thumbsName = (subfolder.thumbnails || d.thumbnails).replace('{code}', code)
  const audioName = (subfolder.audio || d.audio).replace('{code}', code)
  const mergedAudioName = (subfolder.merged_audio || d.merged_audio).replace('{code}', code)
  const subtitlesName = (subfolder.subtitles || d.subtitles).replace('{code}', code)
  const videoName = (subfolder.video || d.video).replace('{code}', code)

  const scriptDir = path.join(episodeDir, scriptName)
  const scenePromptsDir = path.join(episodeDir, scenePromptsName)
  const thumbPromptsDir = path.join(episodeDir, thumbPromptsName)
  const metadataDir = path.join(episodeDir, metadataName)
  const bgDir = path.join(episodeDir, imagesName)
  const thumbDir = path.join(episodeDir, thumbsName)
  const audioDir = path.join(episodeDir, audioName)
  const mergedAudioDir = path.join(episodeDir, mergedAudioName)
  const subtitlesDir = path.join(episodeDir, subtitlesName)
  const videoDir = path.join(episodeDir, videoName)

  return {
    output_root: outputRoot,
    episode_dir: episodeDir,
    script_dir: scriptDir,
    scene_prompts_dir: scenePromptsDir,
    thumb_prompts_dir: thumbPromptsDir,
    metadata_dir: metadataDir,
    bg_dir: bgDir,
    thumb_dir: thumbDir,
    audio_dir: audioDir,
    merged_audio_dir: mergedAudioDir,
    subtitles_dir: subtitlesDir,
    video_dir: videoDir,
    narration_docx: path.join(scriptDir, `${code}_Script_Narration.docx`),
    scene_prompts_docx: path.join(scenePromptsDir, `${code}_Scene_Prompts.docx`),
    thumb_prompts_docx: path.join(thumbPromptsDir, `${code}_Thumbnail_Prompts.docx`),
    metadata_txt: path.join(metadataDir, `${code}_Metadata.txt`),
    metadata_json: path.join(metadataDir, `${code}_Metadata.json`),
  }
}

// ── Resolve subfolder names from project config ────────────────────────────

export interface ResolvedSubfolderNames {
  script: string
  metadata: string
  scene_prompts: string
  thumb_prompts: string
  images: string
  thumbnails: string
  audio: string
  merged_audio: string
  subtitles: string
  video: string
}

/**
 * Resolve the actual subfolder names for a given project + episode code.
 * Reads from project config; falls back to defaults.
 * Returns names with {code} already replaced.
 */
export async function resolveSubfolderNames(slug: string, code: string): Promise<ResolvedSubfolderNames> {
  const { readFile } = await import('fs/promises')
  const { DEFAULT_SUBFOLDER_NAMES } = await import('../models/types.js')

  let subfolder: Record<string, string> = {}
  try {
    const metaRaw = await readFile(path.join(projectDirFor(slug), 'project.json'), 'utf-8')
    const meta = JSON.parse(metaRaw)
    subfolder = meta.subfolder_names || {}
  } catch { /* use defaults */ }

  const d = DEFAULT_SUBFOLDER_NAMES
  return {
    script:        (subfolder.script || d.script).replace('{code}', code),
    metadata:      (subfolder.metadata || d.metadata).replace('{code}', code),
    scene_prompts: (subfolder.scene_prompts || d.scene_prompts).replace('{code}', code),
    thumb_prompts: (subfolder.thumb_prompts || d.thumb_prompts).replace('{code}', code),
    images:        (subfolder.images || d.images).replace('{code}', code),
    thumbnails:    (subfolder.thumbnails || d.thumbnails).replace('{code}', code),
    audio:         (subfolder.audio || d.audio).replace('{code}', code),
    merged_audio:  (subfolder.merged_audio || d.merged_audio).replace('{code}', code),
    subtitles:     (subfolder.subtitles || d.subtitles).replace('{code}', code),
    video:         (subfolder.video || d.video).replace('{code}', code),
  }
}

// ── Credit/balance checks ───────────────────────────────────────────────────
//
// Balance reads are cached per API key so a dashboard polling the health
// endpoint doesn't hammer the provider. Three important invariants:
//
//   1. **Cache key is a SHA-256 digest of the full key**, not an 8-char prefix.
//      Two keys sharing a prefix would otherwise collide and one project
//      could see another's balance.
//   2. **TTL is short (5 s)** so fresh numbers land quickly; the old 30 s
//      window made the UI show stale balances for half a minute after a
//      job completed.
//   3. **Exported `invalidateCreditCache()`** — the job queue calls this
//      whenever a job reaches a terminal state (done/error/cancelled), so
//      the next poll after a generation run hits the provider live.

const CREDIT_CACHE_TTL_MS = 5_000

const creditCache = new Map<string, { value: any; ts: number }>()

function hashKey(provider: string, apiKey: string): string {
  // First 16 hex chars is 2^64 collision space — more than enough and
  // keeps cache keys readable in debug dumps without exposing the full key.
  const digest = createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
  return `${provider}:${digest}`
}

function getCached(key: string, ttl = CREDIT_CACHE_TTL_MS): any {
  const entry = creditCache.get(key)
  if (entry && Date.now() - entry.ts < ttl) return entry.value
  return undefined
}

function setCache(key: string, value: any) {
  creditCache.set(key, { value, ts: Date.now() })
}

/**
 * Drop every cached balance. Called by the job queue after a terminal state
 * transition so the UI stops showing the pre-job balance for up to TTL ms.
 */
export function invalidateCreditCache(): void {
  creditCache.clear()
}

/**
 * Credit preflight — fail fast if the provider's balance is *definitely*
 * empty. Uncertainty (network error, admin-only keys, non-numeric returns)
 * is treated as "maybe fine, let the provider decide" so we never block a
 * legitimate run on a flaky balance endpoint.
 *
 * Catches the "I queued 40 audio chunks and the 3rd one failed with
 * 'insufficient balance'" pattern where the user would otherwise only learn
 * of the empty balance after waiting minutes for the first chunks to finish.
 */
export async function assertBalanceAvailable(
  provider: 'kie' | 'fal' | 'elevenlabs',
  apiKey: string,
): Promise<void> {
  if (!apiKey) return // key absence is handled by the caller with a better message
  if (provider === 'kie') {
    const credits = await getKieCredits(apiKey)
    if (typeof credits === 'number' && credits <= 0) {
      throw new Error('kie.ai credit balance is 0 — top up before running this job.')
    }
    return
  }
  if (provider === 'fal') {
    const balance = await getFalBalance(apiKey)
    // Fal returns a string ('admin key needed') for non-admin keys — that's
    // an uncertainty case, not an empty balance. Only block on definite 0.
    if (typeof balance === 'number' && balance <= 0) {
      throw new Error('fal.ai balance is empty — top up before running this job.')
    }
    return
  }
  if (provider === 'elevenlabs') {
    const bal = await getElevenLabsBalance(apiKey)
    if (bal && bal.remaining <= 0) {
      throw new Error(
        `ElevenLabs character quota exhausted (${bal.character_count.toLocaleString()}/${bal.character_limit.toLocaleString()}) — wait for reset or upgrade tier.`,
      )
    }
  }
}

export async function getKieCredits(apiKey: string): Promise<number | null> {
  if (!apiKey) return null
  const cacheKey = hashKey('kie', apiKey)
  const cached = getCached(cacheKey)
  if (cached !== undefined) return cached
  try {
    const resp = await fetch('https://api.kie.ai/api/v1/chat/credit', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    })
    const data = await resp.json() as any
    const credits = data.data ?? data.credits ?? null
    setCache(cacheKey, credits)
    return credits
  } catch {
    return getCached(cacheKey) ?? null
  }
}

export async function getFalBalance(apiKey: string): Promise<number | string | null> {
  if (!apiKey) return null
  const cacheKey = hashKey('fal', apiKey)
  const cached = getCached(cacheKey)
  if (cached !== undefined) return cached
  try {
    const resp = await fetch('https://api.fal.ai/v1/account/billing?expand=credits', {
      headers: { Authorization: `Key ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    })
    const data = await resp.json() as any
    if (resp.status === 403) {
      setCache(cacheKey, 'admin key needed')
      return 'admin key needed'
    }
    const balance = data.credits?.current_balance ?? data.credits?.balance ?? null
    setCache(cacheKey, balance)
    return balance
  } catch {
    return getCached(cacheKey) ?? null
  }
}

export type ElevenLabsBalance = {
  tier: string
  character_count: number
  character_limit: number
  remaining: number
}

export async function getGenaiproBalance(apiKey: string): Promise<number | null> {
  if (!apiKey) return null
  const cacheKey = hashKey('genaipro', apiKey)
  const cached = getCached(cacheKey)
  if (cached !== undefined) return cached
  try {
    // Dynamic import matches how other provider clients are loaded in this
    // file — keeps the import graph shallow and avoids pulling the TTS
    // client into the startup path when balance polling hasn't fired yet.
    const { getCredits } = await import('../lib/genaipro-client.js')
    const credits = await getCredits(apiKey)
    setCache(cacheKey, credits)
    return credits
  } catch {
    return getCached(cacheKey) ?? null
  }
}

export async function getElevenLabsBalance(apiKey: string): Promise<ElevenLabsBalance | null> {
  if (!apiKey) return null
  const cacheKey = hashKey('eleven', apiKey)
  const cached = getCached(cacheKey)
  if (cached !== undefined) return cached
  try {
    const { getElevenLabsSubscription } = await import('../lib/elevenlabs-client.js')
    const sub = await getElevenLabsSubscription(apiKey)
    if (!sub) {
      setCache(cacheKey, null)
      return null
    }
    const balance: ElevenLabsBalance = {
      tier: sub.tier,
      character_count: sub.character_count,
      character_limit: sub.character_limit,
      remaining: Math.max(0, sub.character_limit - sub.character_count),
    }
    setCache(cacheKey, balance)
    return balance
  } catch {
    return getCached(cacheKey) ?? null
  }
}

/**
 * Three-state result. `reachable` tells the wizard whether we actually talked
 * to the provider: false means timeout/DNS/TCP failure (caller should show a
 * yellow "couldn't reach" state rather than a red "invalid key"). When
 * `valid` is true, `reachable` is always true.
 */
export type TestKeyResult = { valid: boolean; reachable: boolean; message: string }

type Probe = { kind: 'http'; status: number; body: any } | { kind: 'network'; error: string }

async function probeJson(url: string, headers: Record<string, string>): Promise<Probe> {
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
    let body: any = null
    try { body = await resp.json() } catch { /* non-JSON is fine */ }
    return { kind: 'http', status: resp.status, body }
  } catch (e: any) {
    return { kind: 'network', error: e?.message || 'Network error' }
  }
}

export async function testApiKey(provider: string, apiKey: string): Promise<TestKeyResult> {
  if (!apiKey) return { valid: false, reachable: false, message: 'No API key provided' }

  if (provider === 'openai') {
    const r = await probeJson('https://api.openai.com/v1/models', { Authorization: `Bearer ${apiKey}` })
    if (r.kind === 'network') return { valid: false, reachable: false, message: r.error }
    return { valid: r.status === 200, reachable: true, message: r.status === 200 ? 'OK' : `HTTP ${r.status}` }
  }
  if (provider === 'anthropic') {
    const r = await probeJson('https://api.anthropic.com/v1/models', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' })
    if (r.kind === 'network') return { valid: false, reachable: false, message: r.error }
    return { valid: r.status === 200, reachable: true, message: r.status === 200 ? 'OK' : `HTTP ${r.status}` }
  }
  if (provider === 'kie') {
    const r = await probeJson('https://api.kie.ai/api/v1/chat/credit', { Authorization: `Bearer ${apiKey}` })
    if (r.kind === 'network') return { valid: false, reachable: false, message: r.error }
    if (r.status !== 200) return { valid: false, reachable: true, message: `HTTP ${r.status}` }
    const credits = r.body?.data ?? r.body?.credits ?? null
    return credits !== null
      ? { valid: true, reachable: true, message: `Credits: ${credits}` }
      : { valid: false, reachable: true, message: 'Unexpected response shape' }
  }
  if (provider === 'fal') {
    const r = await probeJson('https://api.fal.ai/v1/account/billing?expand=credits', { Authorization: `Key ${apiKey}` })
    if (r.kind === 'network') return { valid: false, reachable: false, message: r.error }
    // fal returns 403 for non-admin keys — the key itself is valid, it just
    // can't read the billing endpoint. Treat as valid (matches prior behavior).
    if (r.status === 403) return { valid: true, reachable: true, message: 'Valid (admin key needed to read balance)' }
    if (r.status !== 200) return { valid: false, reachable: true, message: `HTTP ${r.status}` }
    const balance = r.body?.credits?.current_balance ?? r.body?.credits?.balance ?? null
    return balance !== null
      ? { valid: true, reachable: true, message: `Balance: ${balance}` }
      : { valid: false, reachable: true, message: 'Unexpected response shape' }
  }
  if (provider === 'elevenlabs') {
    const r = await probeJson('https://api.elevenlabs.io/v1/user/subscription', { 'xi-api-key': apiKey })
    if (r.kind === 'network') return { valid: false, reachable: false, message: r.error }
    if (r.status !== 200) return { valid: false, reachable: true, message: `HTTP ${r.status}` }
    const sub = r.body
    const pct = sub?.character_limit ? Math.round((sub.character_count / sub.character_limit) * 100) : 0
    return {
      valid: true,
      reachable: true,
      message: `Tier: ${sub.tier} — ${Number(sub.character_count).toLocaleString()} / ${Number(sub.character_limit).toLocaleString()} chars used (${pct}%)`,
    }
  }
  if (provider === 'genaipro') {
    const r = await probeJson('https://genaipro.vn/api/v1/labs/credits', { Authorization: `Bearer ${apiKey}` })
    if (r.kind === 'network') return { valid: false, reachable: false, message: r.error }
    if (r.status !== 200) return { valid: false, reachable: true, message: `HTTP ${r.status}` }
    const credits = Array.isArray(r.body) ? r.body.reduce((s: number, c: any) => s + (c.amount || 0), 0) : null
    return credits !== null
      ? { valid: true, reachable: true, message: `Credits: ${credits.toLocaleString()}` }
      : { valid: false, reachable: true, message: 'Unexpected response shape' }
  }
  return { valid: false, reachable: false, message: `Unknown provider: ${provider}` }
}
