/**
 * Shared utilities — episode paths, credit checks, API key testing.
 */

import path from 'path'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
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
  /** v1.0.469 — per-scene image-to-video clips ("11 Video Assets"). Heavy
   *  media: lives under mediaBase when media_root is set, else episode_dir. */
  video_assets_dir: string
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

  // Level B (opt-in): when `media_root` is set, HEAVY subfolders live under a
  // separate root (typically an external SSD, off iCloud) mirroring the same
  // episodeRel; light subfolders stay under output_root. `mediaBase` falls back
  // to `episodeDir` when media_root is absent or unresolvable here, so the
  // default path is byte-for-byte unchanged. See services/media-root.ts.
  const { resolveMediaBase } = await import('./media-root.js')
  const mediaBase = resolveMediaBase(meta.media_root, episodeRel, outputRoot) ?? episodeDir

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
  const videoAssetsName = (subfolder.video_assets || d.video_assets).replace('{code}', code)

  // Light artifacts (always under output_root / iCloud).
  const scriptDir = path.join(episodeDir, scriptName)
  const scenePromptsDir = path.join(episodeDir, scenePromptsName)
  const thumbPromptsDir = path.join(episodeDir, thumbPromptsName)
  const metadataDir = path.join(episodeDir, metadataName)
  const subtitlesDir = path.join(episodeDir, subtitlesName)
  // Heavy media (under mediaBase when media_root is set; == episodeDir otherwise).
  const bgDir = path.join(mediaBase, imagesName)
  const thumbDir = path.join(mediaBase, thumbsName)
  const audioDir = path.join(mediaBase, audioName)
  const mergedAudioDir = path.join(mediaBase, mergedAudioName)
  const videoDir = path.join(mediaBase, videoName)
  const videoAssetsDir = path.join(mediaBase, videoAssetsName)

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
    video_assets_dir: videoAssetsDir,
    // v1.0.228 — artifacts are now Markdown (.md). The `*_docx` KEY names are
    // kept (referenced widely) but the values point at .md. Readers of these
    // constants must go through resolveReadPath()/readArtifactRawText() in
    // lib/episode-artifacts.ts so legacy `.docx`-only episodes still resolve.
    narration_docx: path.join(scriptDir, `${code}_Script_Narration.md`),
    scene_prompts_docx: path.join(scenePromptsDir, `${code}_Scene_Prompts.md`),
    thumb_prompts_docx: path.join(thumbPromptsDir, `${code}_Thumbnail_Prompts.md`),
    metadata_txt: path.join(metadataDir, `${code}_Metadata.txt`),
    metadata_json: path.join(metadataDir, `${code}_Metadata.json`),
  }
}

/**
 * Resolve an episode's paths from the CODE alone, looking up the canonical
 * title from the idea store.
 *
 * v1.0.188 bug fix: the folder template is `{code} - {title}`, so a caller
 * that only knows the code MUST pass the episode's real title or it resolves
 * to a phantom `{code} - ` folder and silently misses every sidecar
 * (research.json, scene_plan.json, audio_chapters.json, the stitched SRT…).
 * Several routes + jobs in the research / scene-plan / scene-review pipeline
 * were passing '' (or, for research, the topic), so saved files landed in the
 * real folder while reads looked in the empty one — research "saved" but never
 * surfaced. This helper does the idea lookup once, the same way the episode
 * folder was created (episode.ts resolves with idea.title), so reads + writes
 * always agree. Falls back to '' (legacy behaviour) if the idea isn't found —
 * never throws, since it's a path resolver.
 *
 * Uses a dynamic import of idea-manager to avoid a static import cycle
 * (idea-manager imports this module), matching resolveEpisodePaths's own
 * dynamic-import style.
 */
export async function resolveEpisodePathsByCode(slug: string, code: string): Promise<EpisodePaths> {
  let title = ''
  try {
    const im = await import('./idea-manager.js')
    const ideas = await im.getIdeas(slug)
    title = ideas.find(i => i.episode_code === code)?.title || ''
  } catch { /* fall back to '' — better than throwing from a path resolver */ }
  return resolveEpisodePaths(slug, code, title)
}

function rebaseEpisodePaths(paths: EpisodePaths, episodeDir: string): EpisodePaths {
  const from = path.resolve(paths.episode_dir)
  const to = path.resolve(episodeDir)
  const rebase = (p: string) => {
    const rel = path.relative(from, path.resolve(p))
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
      ? path.join(to, rel)
      : p
  }

  return {
    ...paths,
    episode_dir: to,
    script_dir: rebase(paths.script_dir),
    scene_prompts_dir: rebase(paths.scene_prompts_dir),
    thumb_prompts_dir: rebase(paths.thumb_prompts_dir),
    metadata_dir: rebase(paths.metadata_dir),
    bg_dir: rebase(paths.bg_dir),
    thumb_dir: rebase(paths.thumb_dir),
    audio_dir: rebase(paths.audio_dir),
    merged_audio_dir: rebase(paths.merged_audio_dir),
    subtitles_dir: rebase(paths.subtitles_dir),
    video_dir: rebase(paths.video_dir),
    video_assets_dir: rebase(paths.video_assets_dir),
    narration_docx: rebase(paths.narration_docx),
    scene_prompts_docx: rebase(paths.scene_prompts_docx),
    thumb_prompts_docx: rebase(paths.thumb_prompts_docx),
    metadata_txt: rebase(paths.metadata_txt),
    metadata_json: rebase(paths.metadata_json),
  }
}

/**
 * Resolve by episode code, but when the caller is trying to read or update an
 * existing sidecar, prefer the sibling episode-code folder that actually has
 * that file. This protects Scene Plan / Scene Review from duplicate or renamed
 * episode folders such as:
 *
 *   EP0011 - Old Title/
 *   EP0011 - Current Title/scene_plan.json
 *
 * The normal resolver still owns new writes. This helper only intervenes when
 * the canonical path is missing the sidecar and a same-code sibling has it.
 */
export async function resolveEpisodePathsByCodeWithSidecar(
  slug: string,
  code: string,
  sidecarFilename: string,
): Promise<EpisodePaths> {
  const paths = await resolveEpisodePathsByCode(slug, code)

  // v1.0.467 — scene_plan.json moved INTO the "03 Scene Prompts" subfolder.
  // The sidecar may sit at the episode root (legacy episodes) OR inside that
  // subfolder (post-migration / fresh). Check both when deciding which
  // same-code sibling folder actually owns the episode's data. Checking the
  // scene_prompts subfolder for any sidecar is harmless — only scene_plan.json
  // is ever passed here, and other sidecars simply won't be found there.
  const names = await resolveSubfolderNames(slug, code)
  const { findSubfolder } = await import('../lib/folder-resolver.js')
  const hasSidecar = async (dir: string): Promise<boolean> => {
    if (existsSync(path.join(dir, sidecarFilename))) return true
    const sp = await findSubfolder(dir, names.scene_prompts)
    return !!sp && existsSync(path.join(sp, sidecarFilename))
  }

  if (await hasSidecar(paths.episode_dir)) return paths

  const seasonDir = path.dirname(path.resolve(paths.episode_dir))
  let entries: import('fs').Dirent[]
  try {
    const fs = await import('fs/promises')
    entries = await fs.readdir(seasonDir, { withFileTypes: true })
  } catch {
    return paths
  }

  const wanted = code.toLowerCase()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const name = entry.name.toLowerCase()
    if (name !== wanted && !name.startsWith(`${wanted} - `)) continue
    const candidateDir = path.join(seasonDir, entry.name)
    if (path.resolve(candidateDir) === path.resolve(paths.episode_dir)) continue
    if (await hasSidecar(candidateDir)) {
      return rebaseEpisodePaths(paths, candidateDir)
    }
  }

  return paths
}

/**
 * v1.0.467 — canonical location of an episode's `scene_plan.json`.
 *
 * The scene plan carries every scene's `visual_prompt`, so it now lives inside
 * the "03 Scene Prompts" folder alongside the human-readable prompts doc — the
 * whole prompt pipeline in one place. Episodes created before this change keep
 * the file at the episode root; this resolver returns whichever location
 * actually holds it, falling back to the new location for fresh writes. The
 * boot migration (scene-plan-migration.ts) moves legacy files forward, after
 * which only the new location is ever used.
 *
 * Resolution order (same path for reads AND writes, so in-place edits like
 * approve / regenerate-prompt never split state across the two locations):
 *   1. <scene_prompts_dir>/scene_plan.json exists → use it (new, preferred)
 *   2. <episode_dir>/scene_plan.json     exists → use it (legacy, in place)
 *   3. neither (fresh plan)                       → new location
 *
 * Mirrors resolveSceneImagesDir's "✅ "-prefix-tolerant findSubfolder lookup.
 * Callers that WRITE must `mkdir(path.dirname(result))` first (the folder may
 * not exist yet when Scene Plan runs before Image Prompts).
 */
export const SCENE_PLAN_SIDECAR = 'scene_plan.json'

export async function resolveScenePlanPath(slug: string, code: string, episodeDir: string): Promise<string> {
  const names = await resolveSubfolderNames(slug, code)
  const { findSubfolder } = await import('../lib/folder-resolver.js')
  const scenePromptsDir =
    (await findSubfolder(episodeDir, names.scene_prompts)) || path.join(episodeDir, names.scene_prompts)
  const newPath = path.join(scenePromptsDir, SCENE_PLAN_SIDECAR)
  if (existsSync(newPath)) return newPath
  const legacyPath = path.join(episodeDir, SCENE_PLAN_SIDECAR)
  if (existsSync(legacyPath)) return legacyPath
  return newPath
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
  video_assets: string
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
    video_assets:  (subfolder.video_assets || d.video_assets).replace('{code}', code),
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

// v1.0.84+: bumped from 5_000ms to 30_000ms. The frontend polls
// `/projects/:slug/health` every 5s (useCredits.ts default), and the
// previous 5s TTL was the worst possible value — the cache expired
// just before every poll, so every poll missed cache and re-fetched
// all 4 external balance APIs (Kie / fal / ElevenLabs / GenAIPro)
// in parallel. Each provider has a 5s timeout, so a single slow
// provider could blow the budget on every poll. Server logs from
// 2026-05-12 showed `/projects/:slug/health` consistently taking
// 2-5s and the request queue piling up behind it, which made the
// FilePicker Browse button feel laggy (the browser was holding
// connections open to in-flight health polls).
//
// 30s is comfortably longer than the 5s poll interval so the cache
// hits ~83% of the time. The trade-off is that the credit indicator
// can be 30s stale — fine for a "do I still have money to generate"
// indicator. Job completion calls `invalidateCreditCache(provider)`
// explicitly, so the user sees fresh numbers right after generation.
const CREDIT_CACHE_TTL_MS = 30_000

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

/**
 * Fish Audio remaining API credit. Fish bills in "credit bytes" (≈1 byte per
 * English character), so this is a raw count, not dollars. `self` resolves to
 * the key's owner. Cached like the other balances to survive the 5s sidebar poll.
 */
export async function getFishCredit(apiKey: string): Promise<number | null> {
  if (!apiKey) return null
  const cacheKey = hashKey('fishaudio', apiKey)
  const cached = getCached(cacheKey)
  if (cached !== undefined) return cached
  try {
    const resp = await fetch('https://api.fish.audio/wallet/self/api-credit', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    })
    if (resp.status !== 200) { setCache(cacheKey, null); return null }
    const data = await resp.json() as any
    const credit = Number(data?.credit)
    const val = Number.isFinite(credit) ? credit : null
    setCache(cacheKey, val)
    return val
  } catch {
    return getCached(cacheKey) ?? null
  }
}

export interface DeepseekBalance { currency: string; total_balance: number }

/**
 * DeepSeek account balance (the official `/user/balance` endpoint). Returns the
 * primary balance bucket's currency + total. total_balance comes back as a
 * STRING from DeepSeek, so we coerce. Cached like the others.
 */
export async function getDeepseekBalance(apiKey: string): Promise<DeepseekBalance | null> {
  if (!apiKey) return null
  const cacheKey = hashKey('deepseek', apiKey)
  const cached = getCached(cacheKey)
  if (cached !== undefined) return cached
  try {
    const resp = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (resp.status !== 200) { setCache(cacheKey, null); return null }
    const data = await resp.json() as any
    const info = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : null
    const total = info ? Number(info.total_balance) : NaN
    const val: DeepseekBalance | null = info && Number.isFinite(total)
      ? { currency: String(info.currency || 'USD'), total_balance: total } : null
    setCache(cacheKey, val)
    return val
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

type Probe =
  | { kind: 'http'; status: number; body: any; headers: Record<string, string> }
  | { kind: 'network'; error: string }

async function probeJson(url: string, headers: Record<string, string>): Promise<Probe> {
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
    let body: any = null
    try { body = await resp.json() } catch { /* non-JSON is fine */ }
    // Lowercase header names — Pexels exposes rate-limit info as
    // `X-Ratelimit-Remaining`, the WHATWG fetch normalizes to lowercase,
    // and callers do exact-key lookups so an explicit lowercase map is
    // the least-surprising contract.
    const headersOut: Record<string, string> = {}
    resp.headers.forEach((v, k) => { headersOut[k.toLowerCase()] = v })
    return { kind: 'http', status: resp.status, body, headers: headersOut }
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
  if (provider === 'deepseek') {
    // Official DeepSeek API — OpenAI-compatible models list, Bearer auth.
    const r = await probeJson('https://api.deepseek.com/models', { Authorization: `Bearer ${apiKey}` })
    if (r.kind === 'network') return { valid: false, reachable: false, message: r.error }
    return { valid: r.status === 200, reachable: true, message: r.status === 200 ? 'OK' : `HTTP ${r.status}` }
  }
  if (provider === 'openrouter') {
    // OpenRouter exposes /auth/key which echoes the key's limits — a clean
    // 200 means the key is valid; 401 means it isn't.
    const r = await probeJson('https://openrouter.ai/api/v1/auth/key', { Authorization: `Bearer ${apiKey}` })
    if (r.kind === 'network') return { valid: false, reachable: false, message: r.error }
    if (r.status === 401) return { valid: false, reachable: true, message: 'Invalid key (401)' }
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
    const r = await probeJson('https://genaipro.io/api/v1/labs/credits', { Authorization: `Bearer ${apiKey}` })
    if (r.kind === 'network') return { valid: false, reachable: false, message: r.error }
    if (r.status !== 200) return { valid: false, reachable: true, message: `HTTP ${r.status}` }
    const credits = Array.isArray(r.body) ? r.body.reduce((s: number, c: any) => s + (c.amount || 0), 0) : null
    return credits !== null
      ? { valid: true, reachable: true, message: `Credits: ${credits.toLocaleString()}` }
      : { valid: false, reachable: true, message: 'Unexpected response shape' }
  }
  // v1.0.379+ — Fish Audio probe. The wallet credit endpoint validates the key
  // (Bearer) AND returns the remaining balance; `self` resolves to the key's
  // owner so we don't need the user id. Fish bills in "credit bytes" (≈1 byte
  // per English character), so we label the number neutrally — not as dollars.
  if (provider === 'fishaudio') {
    const r = await probeJson('https://api.fish.audio/wallet/self/api-credit', { Authorization: `Bearer ${apiKey}` })
    if (r.kind === 'network') return { valid: false, reachable: false, message: r.error }
    if (r.status === 401 || r.status === 403) return { valid: false, reachable: true, message: 'Invalid key (401)' }
    if (r.status !== 200) return { valid: false, reachable: true, message: `HTTP ${r.status}` }
    const credit = (r.body as any)?.credit
    const creditNum = credit !== undefined && credit !== null ? Number(credit) : NaN
    return {
      valid: true,
      reachable: true,
      message: Number.isFinite(creditNum)
        ? `Key works — ${creditNum.toLocaleString()} credit remaining`
        : 'Key works',
    }
  }
  // v1.0.123+ — Pexels probe. The `popular` endpoint returns one video
  // with a per_page=1 request — cheapest possible auth check. Pexels
  // takes the raw key as the Authorization header (NO `Bearer ` prefix —
  // a common foot-gun). Quota: 1 request consumed of the 200/hr budget.
  if (provider === 'pexels') {
    const r = await probeJson('https://api.pexels.com/videos/popular?per_page=1', { Authorization: apiKey })
    if (r.kind === 'network') return { valid: false, reachable: false, message: r.error }
    if (r.status === 401) return { valid: false, reachable: true, message: 'Invalid key (401)' }
    if (r.status !== 200) return { valid: false, reachable: true, message: `HTTP ${r.status}` }
    // Pexels exposes rate-limit headers — surface remaining/hour so the
    // user sees how much budget they have before doing real searches.
    const remaining = r.headers?.['x-ratelimit-remaining']
    const limit = r.headers?.['x-ratelimit-limit']
    const tail = (remaining && limit) ? ` · ${remaining}/${limit} req remaining this hour` : ''
    return { valid: true, reachable: true, message: `Key works${tail}` }
  }
  // v1.0.142+ — Perplexity probe. There's no documented free probe
  // endpoint, so do the cheapest possible chat completion: 1 token of
  // output on the smallest model. Costs roughly $0.000003 per test —
  // negligible. Auth failures return 401; bad model id returns 400;
  // missing credit returns 402.
  if (provider === 'perplexity') {
    try {
      const resp = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'sonar',
          messages: [{ role: 'user', content: 'ok' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(8000),
      })
      if (resp.status === 401) return { valid: false, reachable: true, message: 'Invalid key (401)' }
      if (resp.status === 402) return { valid: false, reachable: true, message: 'No credit on Perplexity account' }
      if (resp.status === 429) return { valid: true, reachable: true, message: 'Key works (rate-limited right now)' }
      if (!resp.ok) {
        const t = await resp.text().catch(() => '')
        return { valid: false, reachable: true, message: `HTTP ${resp.status}${t ? ` — ${t.slice(0, 80)}` : ''}` }
      }
      return { valid: true, reachable: true, message: 'Key works' }
    } catch (e: any) {
      return { valid: false, reachable: false, message: e?.message || 'Network error' }
    }
  }
  // v1.0.123+ — Pixabay probe. Pixabay's videos endpoint min `per_page`
  // is 3 — passing 1 returns HTTP 400 "Parameter 'per_page' is out of
  // valid range." Quota: ~100/min, plenty for a one-off probe. Key is
  // a query parameter, not a header (Pixabay convention).
  if (provider === 'pixabay') {
    const r = await probeJson(`https://pixabay.com/api/videos/?key=${encodeURIComponent(apiKey)}&per_page=3`, {})
    if (r.kind === 'network') return { valid: false, reachable: false, message: r.error }
    // Pixabay returns 400 with a body containing "Invalid API key" when
    // the key is bad — they don't use 401 / 403. Disambiguate.
    if (r.status === 400) {
      const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '')
      if (/invalid api key/i.test(text)) return { valid: false, reachable: true, message: 'Invalid key' }
      return { valid: false, reachable: true, message: `HTTP 400 — ${text.slice(0, 80)}` }
    }
    if (r.status !== 200) return { valid: false, reachable: true, message: `HTTP ${r.status}` }
    const total = r.body?.totalHits ?? r.body?.total ?? null
    return { valid: true, reachable: true, message: total !== null ? `Key works (${total.toLocaleString()} hits available)` : 'Key works' }
  }
  return { valid: false, reachable: false, message: `Unknown provider: ${provider}` }
}
