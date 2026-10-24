/**
 * Episode Builder — files on disk.
 *
 * - `<episode>/music_episode.json`  the episode: settings, songs in order, locks,
 *   manual scene breaks, edited scene prompts, the last stitch.
 * - `<project>/music-episodes.json` this channel's drafted episodes, so the no-repeat
 *   window also covers episodes built but not rendered yet.
 * - `scene_plan.json`               derived on every save so Video Assembly, the
 *   scene-image renderer and Scene Review see an ordinary Scene Plan episode.
 *
 * The presence of `music_episode.json` is what marks an episode as a music
 * episode (no narration, so no subtitle timeline is required).
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { createHash } from 'node:crypto'
import * as pm from './project-manager.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from './utils.js'
import { resolveSceneImagesDir } from '../generators/scene-image.js'
import { getEffectiveNiche } from './niche-loader.js'
import {
  MUSIC_EPISODE_FILENAME,
  STARTING_EPISODE_SETTINGS,
  assignSceneSettings,
  buildScenePrompt,
  buildTimeline,
  groupScenes,
  scenePieceIdFor,
  songPieces,
  normalizeEpisodeSettings,
  sceneIdFor,
  settingsFromEpisodeDefaults,
  smoothFlowBreaks,
  songKey,
  windowEpisodeCodes,
  type BuilderSong,
  type ChannelUse,
  type EpisodeSettings,
  type EpisodeSong,
} from './music-episode.js'
import { channelUses, listSongPools, readPoolsForEpisode, recordEpisodeUse, type PoolSummary, type ResolvedPoolSong } from './music-pool-source.js'
import type { ScenePlan, ScenePlanEntry } from '../models/types.js'

export { MUSIC_EPISODE_FILENAME }

const CHANNEL_HISTORY_FILENAME = 'music-episodes.json'

/**
 * Per-run exact record for `music_scene_polish`. Lives beside the episode,
 * never in `job.params` (which `safeJob` rewrites through `redactSecrets`,
 * turning "Key lighting" into "Key [REDACTED]"). One file per logical run,
 * named by a validated 32-hex run id; nothing is ever pruned or removed.
 */
export interface MusicScenePolishRunArtifact {
  version: 2
  run_id: string
  project_slug: string
  episode_code: string
  owner_job_id: string
  predecessor_job_id?: string
  scene_ids: string[]
  request: {
    model: string
    system: string
    user_message: string
    temperature: number
    output_budget: string
    output_contract: unknown
    request_identity: string
  }
  input_fingerprint: string
  baseline_prompts: Record<string, string>
  prepared_key?: string
  accepted_key?: string
  accepted_job_id?: string
  request_preview?: unknown
  outputs?: Record<string, string>
  missing?: string[]
  outputs_recorded_at?: string
}

export const MUSIC_SCENE_POLISH_RUN_ID_PATTERN = /^[0-9a-f]{32}$/

export function musicScenePolishRunDir(episodeDir: string): string {
  return path.join(episodeDir, 'runs', 'music_scene_polish')
}

export function musicScenePolishRunPath(episodeDir: string, runId: string): string {
  return path.join(musicScenePolishRunDir(episodeDir), `${runId}.json`)
}

export async function readMusicScenePolishRun(
  slug: string,
  code: string,
  runId: string,
): Promise<MusicScenePolishRunArtifact | null> {
  if (!MUSIC_SCENE_POLISH_RUN_ID_PATTERN.test(runId)) return null
  const episodeDir = await episodeDirFor(slug, code.toUpperCase())
  const file = musicScenePolishRunPath(episodeDir, runId)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    if ((raw as any).version !== 2) return null
    if (typeof (raw as any).run_id !== 'string' || (raw as any).run_id !== runId) return null
    if (typeof (raw as any).project_slug !== 'string' || (raw as any).project_slug !== slug) return null
    if (typeof (raw as any).episode_code !== 'string'
      || (raw as any).episode_code.toUpperCase() !== code.toUpperCase()) return null
    return raw as MusicScenePolishRunArtifact
  } catch {
    return null
  }
}

export async function writeMusicScenePolishRun(
  slug: string,
  code: string,
  artifact: MusicScenePolishRunArtifact,
): Promise<void> {
  if (!MUSIC_SCENE_POLISH_RUN_ID_PATTERN.test(artifact.run_id)) {
    throw new Error('music_scene_polish run id must be a 32-hex string.')
  }
  if (artifact.project_slug !== slug) {
    throw new Error('music_scene_polish artifact project does not match the write target.')
  }
  if (artifact.episode_code.toUpperCase() !== code.toUpperCase()) {
    throw new Error('music_scene_polish artifact episode does not match the write target.')
  }
  const episodeDir = await episodeDirFor(slug, code.toUpperCase())
  const dir = musicScenePolishRunDir(episodeDir)
  await fs.mkdir(dir, { recursive: true })
  const file = musicScenePolishRunPath(episodeDir, artifact.run_id)
  await withLock(file, async () => {
    await writeJsonAtomic(file, artifact)
  })
}

/**
 * Compute a stable run id from the project, episode and the first job that
 * started this logical run. Hex-only so it survives `safeJob` and is safe
 * as a filename component. Binds slug/code/firstJob so two episodes cannot
 * collide on the same job id.
 */
export function musicScenePolishRunId(slug: string, code: string, firstJobId: string): string {
  return createHash('sha256').update(`music_scene_polish|${slug}|${code.toUpperCase()}|${firstJobId}`).digest('hex').slice(0, 32)
}

/**
 * Locked read-modify-write over the episode document. Reads the freshest
 * document inside the same lock every writer of `saveEpisodeDoc` now shares,
 * applies the mutation, then writes through the unlocked inner helper so no
 * nested acquisition of the same key can deadlock. The plan + history writes
 * still happen after the document write, under their own existing locks.
 */
export async function updateEpisodeDoc<T>(
  slug: string,
  code: string,
  mutate: (doc: MusicEpisodeDoc) => Promise<{ doc: MusicEpisodeDoc; result: T }> | { doc: MusicEpisodeDoc; result: T },
): Promise<T> {
  const upper = code.toUpperCase()
  const episodeDir = await episodeDirFor(slug, upper)
  const docPath = path.join(episodeDir, MUSIC_EPISODE_FILENAME)
  return withLock(docPath, async () => {
    const current = await readEpisodeDoc(slug, upper)
    if (!current) throw new Error(`${upper}'s Episode Builder plan disappeared mid-update.`)
    const applied = await mutate(current)
    const ctx = await loadEpisodeContext(slug, upper, applied.doc.settings)
    await saveEpisodeDocUnlocked(slug, applied.doc, ctx.byKey)
    return applied.result
  })
}

export interface MusicEpisodeBuild {
  at: string
  merged_audio: string
  tracklist_path: string
  total_sec: number
  starts: number[]
  song_keys: string[]
  join_seconds: number
  lufs?: number
  true_peak_db?: number
}

export interface MusicEpisodeDoc {
  schema_version: 1
  episode_code: string
  settings: EpisodeSettings
  songs: EpisodeSong[]
  /** Bumped by every Re-draw, so a re-draw is a new draw and a rebuild is not. */
  draw_round: number
  /** Manual scene mode: song keys that start a new scene. */
  scene_breaks: string[]
  /** Scene id → the owner's own prompt. */
  prompt_overrides: Record<string, string>
  /** Scene id → the Image Pool still it uses (`pool_id/filename`), for the stills no-repeat window. */
  scene_stills?: Record<string, string>
  built?: MusicEpisodeBuild
  updated_at: string
}

/** True when this episode folder belongs to the Episode Builder. */
export function isMusicEpisodeDir(episodeDir: string): boolean {
  return existsSync(path.join(episodeDir, MUSIC_EPISODE_FILENAME))
}

export async function episodeDirFor(slug: string, code: string): Promise<string> {
  return (await resolveEpisodePathsByCode(slug, code.toUpperCase())).episode_dir
}

/** The channel's starting values: code starting values ← formula `musicFormat.episodeDefaults`. */
export async function channelStartingSettings(slug: string): Promise<{ settings: EpisodeSettings; music_channel: boolean; themes: string[]; scene_settings: string[] }> {
  const niche = await getEffectiveNiche(slug).catch(() => null) as {
    musicFormat?: { episodeDefaults?: { scene_themes?: unknown }; registers?: Record<string, { label?: string }>; sceneSettings?: unknown }
  } | null
  const format = niche?.musicFormat
  // Theme suggestions: the formula's scene themes, then its registers (SPEC §5).
  const themes = [
    ...(Array.isArray(format?.episodeDefaults?.scene_themes) ? format!.episodeDefaults!.scene_themes as unknown[] : []),
    ...Object.values(format?.registers || {}).map(register => register?.label),
  ].filter((t): t is string => typeof t === 'string' && !!t.trim())
  return {
    settings: format?.episodeDefaults ? settingsFromEpisodeDefaults(format.episodeDefaults) : { ...STARTING_EPISODE_SETTINGS },
    music_channel: !!format,
    themes: [...new Set(themes)],
    scene_settings: Array.isArray(format?.sceneSettings)
      ? format!.sceneSettings.filter((s): s is string => typeof s === 'string' && !!s.trim())
      : [],
  }
}

export async function readEpisodeDoc(slug: string, code: string): Promise<MusicEpisodeDoc | null> {
  const file = path.join(await episodeDirFor(slug, code), MUSIC_EPISODE_FILENAME)
  if (!existsSync(file)) return null
  const raw = JSON.parse(await fs.readFile(file, 'utf8'))
  const base = (await channelStartingSettings(slug)).settings
  return {
    schema_version: 1,
    episode_code: code.toUpperCase(),
    settings: normalizeEpisodeSettings(raw?.settings, base),
    songs: Array.isArray(raw?.songs) ? raw.songs.filter(isSongRef).map(cleanRef) : [],
    draw_round: Number.isInteger(raw?.draw_round) ? raw.draw_round : 0,
    scene_breaks: Array.isArray(raw?.scene_breaks) ? raw.scene_breaks.filter((k: unknown) => typeof k === 'string') : [],
    prompt_overrides: raw?.prompt_overrides && typeof raw.prompt_overrides === 'object' ? raw.prompt_overrides : {},
    ...(raw?.scene_stills && typeof raw.scene_stills === 'object'
      ? { scene_stills: Object.fromEntries(Object.entries(raw.scene_stills).filter(([, v]) => typeof v === 'string')) as Record<string, string> }
      : {}),
    ...(raw?.built ? { built: raw.built } : {}),
    updated_at: typeof raw?.updated_at === 'string' ? raw.updated_at : new Date(0).toISOString(),
  }
}

/** A new, empty episode with the channel's starting settings (nothing saved yet). */
export async function newEpisodeDoc(slug: string, code: string): Promise<MusicEpisodeDoc> {
  return {
    schema_version: 1,
    episode_code: code.toUpperCase(),
    settings: (await channelStartingSettings(slug)).settings,
    songs: [],
    draw_round: 0,
    scene_breaks: [],
    prompt_overrides: {},
    updated_at: new Date().toISOString(),
  }
}

function isSongRef(value: any): value is EpisodeSong {
  return !!value && typeof value.pool_id === 'string' && typeof value.song_id === 'string'
}
const cleanRef = (ref: EpisodeSong): EpisodeSong => ({ pool_id: ref.pool_id, song_id: ref.song_id, ...(ref.locked ? { locked: true } : {}) })

function historyPath(slug: string): string {
  const dir = pm.getProjectDir(slug)
  if (!dir) throw new Error(`Project ${slug} not found.`)
  return path.join(dir, CHANNEL_HISTORY_FILENAME)
}

interface ChannelHistory { episodes: Record<string, { songs: string[]; at: string; stills?: string[] }> }

async function readHistory(slug: string): Promise<ChannelHistory> {
  const file = historyPath(slug)
  if (!existsSync(file)) return { episodes: {} }
  const raw = JSON.parse(await fs.readFile(file, 'utf8'))
  return { episodes: raw?.episodes && typeof raw.episodes === 'object' ? raw.episodes : {} }
}

/** Other drafted episodes of this channel as window entries (song key → codes). */
function draftUses(history: ChannelHistory): { uses: ChannelUse[]; byCode: Map<string, string[]> } {
  const byCode = new Map<string, string[]>()
  const uses: ChannelUse[] = []
  for (const [code, entry] of Object.entries(history.episodes)) {
    if (!Array.isArray(entry?.songs)) continue
    byCode.set(code.toUpperCase(), entry.songs)
    uses.push({ code, at: String(entry.at || '') })
  }
  return { uses, byCode }
}

// ── View ────────────────────────────────────────────────────────────────────

export interface EpisodeSceneView {
  id: string
  scene_index: number
  start_sec: number
  end_sec: number
  song_keys: string[]
  /** This picture may carry its song's title: a one-song scene, or a song's first picture in 'duration' mode. */
  title_on_scene: boolean
  prompt: string
  prompt_is_custom: boolean
  image: 'ready' | 'stale' | 'missing'
  /** Changes whenever the picture is replaced (cache key for the preview). */
  image_version: string | null
  approved: boolean
}

export interface EpisodeView {
  episode_code: string
  music_channel: boolean
  doc: MusicEpisodeDoc | null
  channel_settings: EpisodeSettings
  themes: string[]
  pools: PoolSummary[]
  missing_pools: string[]
  /** `key` is the song's musical key; `song_key` (`pool_id/song_id`) identifies it. */
  songs: Array<ResolvedPoolSong & { locked: boolean; start_sec: number; song_key: string; blocked_by?: string; scene_id: string }>
  unresolved_songs: string[]
  scenes: EpisodeSceneView[]
  total_sec: number
  target_sec: number
  /** Seconds still missing to reach the target, and about how many songs that is. */
  shortfall_sec: number
  songs_missing: number
  free_songs: number
  window_codes: string[]
  smooth_breaks: { tempo: number; keyAndEnsemble: number }
  visual_style: string
}

export interface EpisodeContext {
  pools: PoolSummary[]
  missing_pools: string[]
  songs: ResolvedPoolSong[]
  byKey: Map<string, ResolvedPoolSong>
  blocked: Map<string, string>
  window_codes: string[]
}

/** Pools + the no-repeat window for one episode. */
export async function loadEpisodeContext(slug: string, code: string, settings: EpisodeSettings): Promise<EpisodeContext> {
  const upper = code.toUpperCase()
  const { pools, songs, missing_pools } = await readPoolsForEpisode(slug, settings.pools)
  const drafts = draftUses(await readHistory(slug))
  const rendered = channelUses(songs, slug)
  const window = windowEpisodeCodes([...rendered, ...drafts.uses], upper, settings.no_repeat_episodes)
  const inWindow = new Set(window)
  const blocked = new Map<string, string>()
  for (const song of songs) {
    const use = [...song.episodes]
      .filter(e => e.project_slug === slug && inWindow.has(e.code.toUpperCase()))
      .sort((a, b) => b.used_at.localeCompare(a.used_at))[0]
    if (use) blocked.set(songKey(song), use.code.toUpperCase())
  }
  for (const windowCode of window) {
    for (const key of drafts.byCode.get(windowCode) || []) if (!blocked.has(key)) blocked.set(key, windowCode)
  }
  // A plan may still name a duplicate entry that was folded into its song (1.4.270): resolve it too.
  const byKey = new Map(songs.flatMap(s => [s, ...(s.merged_ids || []).map(id => ({ ...s, id }))].map(row => [songKey(row), s] as const)))
  return { pools, missing_pools, songs, byKey, blocked, window_codes: window }
}

/** Timeline + scenes for a list of songs (stored lengths, or the measured stitch when it still matches). */
export function planEpisode(doc: MusicEpisodeDoc, byKey: ReadonlyMap<string, BuilderSong>, sceneSettings: readonly string[] = []) {
  const rows = doc.songs.map(ref => byKey.get(songKey(ref)))
  const keys = doc.songs.map(songKey)
  const built = doc.built && doc.built.song_keys.join('\n') === keys.join('\n') ? doc.built : null
  const timeline = built
    ? { starts: built.starts, total: built.total_sec, join_seconds: built.join_seconds }
    : buildTimeline(rows.map(song => song?.duration_s || 0), doc.settings.join)
  // Every mode but 'duration' groups whole songs; 'duration' cuts each song into pictures of its own.
  type Slot = { id: string; songs: number[]; start: number; end: number; titled: boolean }
  let slots: Slot[]
  const { scenes: sceneMode } = doc.settings
  if (sceneMode.mode === 'duration') {
    slots = doc.songs.flatMap((ref, i) => songPieces(keys[i]!, timeline.starts[i] ?? 0, timeline.starts[i + 1] ?? timeline.total,
      sceneMode.min_seconds, sceneMode.max_seconds).map((piece, k) => ({
      id: scenePieceIdFor(ref, k), songs: [i], start: piece.start, end: piece.end, titled: k === 0,
    })))
  } else {
    const breaks = new Set(doc.scene_breaks.map(key => keys.indexOf(key)).filter(i => i > 0))
    const groups = groupScenes(timeline.starts, timeline.total, sceneMode, breaks)
    slots = groups.map((group, index) => ({
      id: sceneIdFor(doc.songs[group[0]!]!), songs: group, start: timeline.starts[group[0]!] ?? 0,
      end: index + 1 < groups.length ? timeline.starts[groups[index + 1]![0]!]! : timeline.total,
      // A picture shared by several songs would name only the first one, so it stays text-free.
      titled: group.length === 1,
    }))
  }
  const settingOf = assignSceneSettings(slots.map(slot => slot.id), sceneSettings)
  const scenes = slots.map((slot, index) => {
    const group = slot.songs
    const first = doc.songs[group[0]!]!
    const id = slot.id
    const firstSong = rows[group[0]!]
    const custom = doc.prompt_overrides[id]?.trim()
    return {
      id,
      scene_index: index + 1,
      start_sec: slot.start,
      end_sec: slot.end,
      song_keys: group.map(i => keys[i]!),
      titles: group.map(i => rows[i]?.title || doc.songs[i]!.song_id),
      title_on_scene: slot.titled,
      prompt: custom || buildScenePrompt({
        sceneIdea: firstSong?.scene_idea,
        title: firstSong?.title || first.song_id,
        theme: doc.settings.theme,
        setting: settingOf[index],
        mood: firstSong?.mood,
        titleOnScene: doc.settings.scenes.title_on_scene && slot.titled && !!firstSong?.title,
      }),
      prompt_is_custom: !!custom,
      // Drives "every '<theme>' scene" effects (feat/music-effects): the episode theme, else the song's.
      theme: doc.settings.theme.trim() || firstSong?.theme?.trim() || '',
    }
  })
  return { timeline, scenes, measured: !!built }
}

/**
 * Each scene's picture prompt without its song title: setting, mood and theme only. Owner and Polish
 * rewrites are left out too, since they carry the title in their own words. Music thumbnails start here
 * (CJ0027: the thumbnail kept scene 1's title instruction and printed that song's title twice).
 */
export async function untitledScenePrompts(slug: string, code: string, doc: MusicEpisodeDoc): Promise<Map<string, string>> {
  const channel = await channelStartingSettings(slug)
  const ctx = await loadEpisodeContext(slug, code, doc.settings)
  const bare = { ...doc, prompt_overrides: {}, settings: { ...doc.settings, scenes: { ...doc.settings.scenes, title_on_scene: false } } }
  return new Map(planEpisode(bare, ctx.byKey, channel.scene_settings).scenes.map(scene => [scene.id, scene.prompt]))
}

export async function buildEpisodeView(slug: string, code: string): Promise<EpisodeView> {
  const upper = code.toUpperCase()
  const channel = await channelStartingSettings(slug)
  const doc = await readEpisodeDoc(slug, upper)
  const settings = doc?.settings ?? channel.settings
  const ctx = await loadEpisodeContext(slug, upper, settings)
  const style = await visualStyleFor(slug, upper)
  const view: EpisodeView = {
    episode_code: upper,
    music_channel: channel.music_channel,
    doc,
    channel_settings: channel.settings,
    themes: channel.themes,
    pools: ctx.pools,
    missing_pools: ctx.missing_pools,
    songs: [],
    unresolved_songs: [],
    scenes: [],
    total_sec: 0,
    target_sec: settings.target_length_s,
    shortfall_sec: 0,
    songs_missing: 0,
    free_songs: ctx.songs.filter(s => s.drawable && s.duration_s > 0 && !ctx.blocked.has(songKey(s))).length,
    window_codes: ctx.window_codes,
    smooth_breaks: { tempo: 0, keyAndEnsemble: 0 },
    visual_style: style,
  }
  if (!doc) return view
  const { timeline, scenes } = planEpisode(doc, ctx.byKey, channel.scene_settings)
  // A song cut into several pictures points at its first one.
  const sceneOfKey = new Map(scenes.flatMap(scene => scene.song_keys.map(key => [key, scene.id] as const)).reverse())
  doc.songs.forEach((ref, i) => {
    const song = ctx.byKey.get(songKey(ref))
    if (!song) { view.unresolved_songs.push(songKey(ref)); return }
    view.songs.push({
      ...song,
      song_key: songKey(ref),
      locked: !!ref.locked,
      start_sec: timeline.starts[i] ?? 0,
      scene_id: sceneOfKey.get(songKey(ref)) || '',
      ...(ctx.blocked.has(songKey(ref)) ? { blocked_by: ctx.blocked.get(songKey(ref)) } : {}),
    })
  })
  view.total_sec = Math.round(timeline.total)
  view.shortfall_sec = Math.max(0, view.target_sec - view.total_sec)
  const usable = ctx.songs.filter(s => s.drawable && s.duration_s > 0)
  const average = usable.length ? usable.reduce((sum, s) => sum + s.duration_s, 0) / usable.length : 225
  view.songs_missing = view.shortfall_sec ? Math.ceil(view.shortfall_sec / average) : 0
  view.smooth_breaks = smoothFlowBreaks(doc.songs.map(ref => ctx.byKey.get(songKey(ref))).filter((s): s is ResolvedPoolSong => !!s))
  const plan = await readScenePlan(slug, upper)
  const imagesDir = await resolveSceneImagesDir(slug, upper, await episodeDirFor(slug, upper))
  view.scenes = scenes.map(scene => {
    const entry = plan?.scenes.find(s => s.id === scene.id)
    const hasFile = existsSync(path.join(imagesDir, `${scene.id}.png`)) || (!!entry?.image_path && existsSync(entry.image_path))
    const stale = hasFile && entry?.rendered_prompt !== undefined && entry.rendered_prompt !== scene.prompt
    return {
      id: scene.id,
      scene_index: scene.scene_index,
      start_sec: scene.start_sec,
      end_sec: scene.end_sec,
      song_keys: scene.song_keys,
      title_on_scene: scene.title_on_scene,
      prompt: scene.prompt,
      prompt_is_custom: scene.prompt_is_custom,
      image: !hasFile ? 'missing' : stale ? 'stale' : 'ready',
      image_version: entry?.image_version || null,
      approved: !!entry?.approved,
    }
  })
  return view
}

async function visualStyleFor(slug: string, code: string): Promise<string> {
  try {
    const { resolveStyleBible } = await import('../lib/style-bible.js')
    return (await resolveStyleBible({ slug, episodeDir: await episodeDirFor(slug, code) })).text || ''
  } catch {
    return ''
  }
}

async function readScenePlan(slug: string, code: string): Promise<ScenePlan | null> {
  const planPath = await resolveScenePlanPath(slug, code, await episodeDirFor(slug, code))
  if (!existsSync(planPath)) return null
  return JSON.parse(await fs.readFile(planPath, 'utf8')) as ScenePlan
}

// ── Save ────────────────────────────────────────────────────────────────────

/**
 * Unlocked inner writer. Callers that need mutual exclusion with other
 * document writers (including `updateEpisodeDoc`) MUST use `saveEpisodeDoc`,
 * which wraps this in the shared document lock. Direct calls are only safe
 * from inside a lock the caller already holds on the same key.
 */
async function saveEpisodeDocUnlocked(slug: string, doc: MusicEpisodeDoc, byKey: ReadonlyMap<string, BuilderSong>): Promise<void> {
  const code = doc.episode_code.toUpperCase()
  const episodeDir = await episodeDirFor(slug, code)
  await fs.mkdir(episodeDir, { recursive: true })
  const keys = new Set(doc.songs.map(songKey))
  const next: MusicEpisodeDoc = {
    ...doc,
    episode_code: code,
    scene_breaks: doc.scene_breaks.filter(key => keys.has(key)),
    updated_at: new Date().toISOString(),
  }
  await writeJsonAtomic(path.join(episodeDir, MUSIC_EPISODE_FILENAME), next)

  const history = historyPath(slug)
  const plan = await writeDerivedScenePlan(slug, code, next, byKey)
  // Stills still in use: their scene is still in the plan.
  const sceneIds = new Set(plan.scenes.map(scene => scene.id))
  const stills = [...new Set(Object.entries(next.scene_stills || {}).filter(([id]) => sceneIds.has(id)).map(([, still]) => still))]
  await withLock(history, async () => {
    const current = await readHistory(slug)
    current.episodes[code] = {
      songs: [...keys],
      at: current.episodes[code]?.at || next.updated_at,
      ...(stills.length ? { stills } : {}),
    }
    await writeJsonAtomic(history, current)
  })
}

/**
 * Write the episode, this channel's draft history and the derived scene plan.
 * Image fields already in the plan are kept for every scene id that survives,
 * so a picture follows its song through reorders and re-draws.
 *
 * This is the SHARED LOCKED entry point: every writer of `music_episode.json`
 * goes through here so `updateEpisodeDoc`'s read-modify-write cannot race
 * against a direct save. The lock key is the document path itself.
 */
export async function saveEpisodeDoc(slug: string, doc: MusicEpisodeDoc, byKey: ReadonlyMap<string, BuilderSong>): Promise<void> {
  const code = doc.episode_code.toUpperCase()
  const episodeDir = await episodeDirFor(slug, code)
  const docPath = path.join(episodeDir, MUSIC_EPISODE_FILENAME)
  await withLock(docPath, () => saveEpisodeDocUnlocked(slug, doc, byKey))
}

/**
 * The stills no-repeat window (owner ask, optional per channel): Image Pool stills used as scenes in
 * this channel's last `n` episodes (drafted or rendered, in order — the same order the song window
 * uses). Returns still key (`pool_id/filename`) → the episode code that used it. `n` = 0 → empty.
 */
export async function stillWindow(slug: string, code: string, n: number): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (n <= 0) return out
  const history = await readHistory(slug)
  const window = windowEpisodeCodes(draftUses(history).uses, code.toUpperCase(), n)
  for (const windowCode of [...window].reverse()) {
    const entry = Object.entries(history.episodes).find(([c]) => c.toUpperCase() === windowCode)?.[1]
    for (const still of entry?.stills || []) if (!out.has(still)) out.set(still, windowCode)
  }
  return out
}

export const stillKey = (poolId: string, filename: string): string => `${poolId}/${filename}`

export async function writeDerivedScenePlan(
  slug: string,
  code: string,
  doc: MusicEpisodeDoc,
  byKey: ReadonlyMap<string, BuilderSong>,
): Promise<ScenePlan> {
  const episodeDir = await episodeDirFor(slug, code)
  const planPath = await resolveScenePlanPath(slug, code, episodeDir)
  const { timeline, scenes } = planEpisode(doc, byKey, (await channelStartingSettings(slug)).scene_settings)
  await fs.mkdir(path.dirname(planPath), { recursive: true })
  return withLock(planPath, async () => {
    const previous = existsSync(planPath)
      ? JSON.parse(await fs.readFile(planPath, 'utf8')) as ScenePlan
      : null
    const byId = new Map((previous?.scenes || []).map(scene => [scene.id, scene]))
    const now = new Date().toISOString()
    const plan: Omit<ScenePlan, 'scenes'> & { scenes: Array<ScenePlanEntry & { theme?: string }>; music_episode: { scene_song_keys: string[][] } } = {
      ...(previous || {}),
      schema_version: 1,
      generated_at: now,
      timeline_built_at: now,
      total_duration_sec: Math.round(timeline.total * 1000) / 1000,
      research_used: false,
      planning_stage: 'visual',
      opening_mode: 'from-start',
      opening_reserved_sec: 0,
      music_episode: { scene_song_keys: scenes.map(scene => scene.song_keys) },
      scenes: scenes.map((scene): ScenePlanEntry & { theme?: string } => {
        const prev = byId.get(scene.id)
        const keep = prev ? {
          ...(prev.image_path ? { image_path: prev.image_path } : {}),
          ...(prev.rendered_prompt !== undefined ? { rendered_prompt: prev.rendered_prompt } : {}),
          ...(prev.image_version ? { image_version: prev.image_version } : {}),
          ...(prev.image_sha256 ? { image_sha256: prev.image_sha256 } : {}),
          ...(prev.motion_choice ? { motion_choice: prev.motion_choice } : {}),
          ...(prev.clip_path ? { clip_path: prev.clip_path } : {}),
          ...(prev.rendered_motion_prompt !== undefined ? { rendered_motion_prompt: prev.rendered_motion_prompt } : {}),
          ...(prev.clip_source_image_version ? { clip_source_image_version: prev.clip_source_image_version } : {}),
          ...(prev.clip_renderer ? { clip_renderer: prev.clip_renderer } : {}),
          ...(prev.clip_source_image_sha256 ? { clip_source_image_sha256: prev.clip_source_image_sha256 } : {}),
          ...(prev.clip_scene_window_seconds !== undefined ? { clip_scene_window_seconds: prev.clip_scene_window_seconds } : {}),
          ...(prev.clip_sketch ? { clip_sketch: prev.clip_sketch } : {}),
          approved: !!prev.approved,
        } : { approved: false }
        return {
          id: scene.id,
          scene_index: scene.scene_index,
          start_sec: Math.round(scene.start_sec * 1000) / 1000,
          end_sec: Math.round(scene.end_sec * 1000) / 1000,
          transcript_segment: `Music: ${scene.titles.join(' · ')}`,
          visual_prompt: scene.prompt,
          scene_type: 'environment',
          ...(scene.theme ? { theme: scene.theme } : {}),
          ...keep,
        }
      }),
    }
    await writeJsonAtomic(planPath, plan)
    return plan as ScenePlan
  })
}

export interface MusicStitchState {
  /** The episode belongs to the Episode Builder (music_episode.json is present). */
  music: boolean
  /** The last stitch matches today's song list and its mix + tracklist are on disk. */
  current: boolean
  songs: number
  tracklist_path: string | null
  total_sec: number | null
  /** Plain reason when not current; empty when current. */
  reason: string
}

/**
 * Is this music episode's stitched mix the one its song list describes? The Finalizer's chapters,
 * the Production Board and Pipeline all ask this one question, so they cannot disagree.
 */
export async function inspectMusicStitch(slug: string, code: string): Promise<MusicStitchState> {
  const upper = code.toUpperCase()
  const empty = { songs: 0, tracklist_path: null, total_sec: null }
  if (!isMusicEpisodeDir(await episodeDirFor(slug, upper))) return { music: false, current: false, ...empty, reason: '' }
  const doc = await readEpisodeDoc(slug, upper).catch(() => null)
  if (!doc?.songs.length) return { music: true, current: false, ...empty, reason: `${upper} has no songs yet. Draw songs in Episode Builder.` }
  const keys = doc.songs.map(songKey).join('\n')
  const built = doc.built
  const base = { music: true, songs: doc.songs.length, tracklist_path: built?.tracklist_path || null, total_sec: built?.total_sec ?? null }
  if (!built) return { ...base, current: false, reason: `${upper} is not stitched yet. Press "Send to Video Assembly" in Episode Builder.` }
  if (built.song_keys.join('\n') !== keys) {
    return { ...base, current: false, reason: `${upper}'s songs changed after the last stitch. Send it to Video Assembly again in Episode Builder.` }
  }
  if (!existsSync(built.merged_audio) || !existsSync(built.tracklist_path)) {
    return { ...base, current: false, reason: `${upper}'s stitched mix or tracklist is missing on disk. Send it to Video Assembly again in Episode Builder.` }
  }
  return { ...base, current: true, reason: '' }
}

/** Songs with lyrics: this episode's sung songs, in episode order, as `{ title, lyrics }`. */
export async function episodeLyrics(slug: string, code: string): Promise<Array<{ title: string; lyrics: string }>> {
  const doc = await readEpisodeDoc(slug, code.toUpperCase()).catch(() => null)
  if (!doc?.songs.length) return []
  const { songs } = await readPoolsForEpisode(slug, doc.settings.pools)
  return doc.songs.flatMap(ref => {
    const song = songs.find(s => s.pool_id === ref.pool_id && s.id === ref.song_id)
    return song?.lyrics ? [{ title: song.title, lyrics: song.lyrics }] : []
  })
}

/**
 * What the writing model reads to write a music episode's title, description and tags (SPEC phase 4):
 * the channel's formula (ensembles, moods, textures, structures), the episode theme and its tracklist.
 * Facts only; the model the owner picked writes the words.
 */
export async function musicMetadataContext(slug: string, code: string): Promise<string> {
  const upper = code.toUpperCase()
  const niche = await getEffectiveNiche(slug).catch(() => null) as {
    musicFormat?: { songFormula?: Record<string, unknown> }
  } | null
  const project = await pm.getProject(slug).catch(() => null) as { name?: string } | null
  const formula = niche?.musicFormat?.songFormula || {}
  const values = (key: string): string => (Array.isArray(formula[key]) ? formula[key] as unknown[] : [])
    .map(v => (v && typeof v === 'object' ? v as { value?: unknown; weight?: unknown } : { value: v, weight: 1 }))
    .filter(v => typeof v.value === 'string' && v.value.trim() && Number(v.weight ?? 1) > 0)
    .map(v => String(v.value).trim())
    .join(', ')
  const doc = await readEpisodeDoc(slug, upper).catch(() => null)
  const stitch = await inspectMusicStitch(slug, upper)
  const tracklist = stitch.current && stitch.tracklist_path
    ? (await fs.readFile(stitch.tracklist_path, 'utf8').catch(() => '')).trim()
    : ''
  const minutes = stitch.total_sec ? Math.round(stitch.total_sec / 60) : null
  const never = Array.isArray(formula.never) ? (formula.never as unknown[]).filter(v => typeof v === 'string').join(', ') : ''
  const sung = (await episodeLyrics(slug, upper)).length
  return [
    sung
      ? `This is a music episode of original songs, ${sung} of them sung with original lyrics written for this channel (no narration), on the channel "${project?.name || slug}".`
      : `This is an instrumental music episode (original songs, no narration, no vocals) on the channel "${project?.name || slug}".`,
    values('ensembles') ? `Instruments / ensembles: ${values('ensembles')}.` : '',
    values('moods') ? `Moods: ${values('moods')}.` : '',
    values('textures') ? `Sound: ${values('textures')}.` : '',
    values('structures') ? `Song forms: ${values('structures')}.` : '',
    never ? `Never mention: ${never}.` : '',
    doc?.settings.theme ? `Episode theme: ${doc.settings.theme}.` : '',
    `${stitch.songs || doc?.songs.length || 0} songs${minutes ? `, about ${minutes} minutes` : ''}.`,
    tracklist ? `Tracklist (chapters are added to the description automatically — do not write timestamps):\n${tracklist}` : '',
  ].filter(Boolean).join('\n')
}

/** "Keep This Picture": accept the scene's current picture for its current prompt. */
export async function keepScenePicture(slug: string, code: string, sceneId: string): Promise<void> {
  const episodeDir = await episodeDirFor(slug, code)
  const planPath = await resolveScenePlanPath(slug, code, episodeDir)
  const imagesDir = await resolveSceneImagesDir(slug, code.toUpperCase(), episodeDir)
  await withLock(planPath, async () => {
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as ScenePlan
    const scene = plan.scenes.find(s => s.id === sceneId)
    if (!scene) throw new Error(`Scene ${sceneId} is not in this episode any more. Reload the page.`)
    const named = path.join(imagesDir, `${sceneId}.png`)
    if (!existsSync(named) && !(scene.image_path && existsSync(scene.image_path))) {
      throw new Error('This scene has no picture yet. Make one first.')
    }
    if (existsSync(named)) scene.image_path = named
    scene.rendered_prompt = scene.visual_prompt
    scene.approved = true
    await writeJsonAtomic(planPath, plan)
  })
}

/** Mark this channel's episode as rendered (history only; plays live in the pools). */
export async function markEpisodeRendered(slug: string, code: string, at: string): Promise<void> {
  const history = historyPath(slug)
  await withLock(history, async () => {
    const current = await readHistory(slug)
    const entry = current.episodes[code.toUpperCase()]
    if (!entry) return
    current.episodes[code.toUpperCase()] = { ...entry, at }
    await writeJsonAtomic(history, current)
  })
}

/**
 * After Video Assembly renders a music episode: record one play per song in its
 * pool (SPEC §3 — plays mean heard). Bookkeeping only; a failure is reported in
 * the render log and never fails a finished render.
 */
export async function recordRenderedMusicEpisode(slug: string, code: string, log: (line: string) => void): Promise<void> {
  const upper = code.toUpperCase()
  if (!isMusicEpisodeDir(await episodeDirFor(slug, upper))) return
  const doc = await readEpisodeDoc(slug, upper)
  if (!doc?.songs.length) return
  const at = new Date().toISOString()
  const byPool = new Map<string, string[]>()
  for (const ref of doc.songs) byPool.set(ref.pool_id, [...(byPool.get(ref.pool_id) || []), ref.song_id])
  const pools = await listSongPools()
  let recorded = 0
  const problems: string[] = []
  for (const [poolId, ids] of byPool) {
    const pool = pools.find(p => p.pool_id === poolId)
    if (!pool) { problems.push(`pool ${poolId} not found`); continue }
    try {
      await recordEpisodeUse(pool.project_slug, ids, { code: upper, project_slug: slug, used_at: at })
      recorded += ids.length
    } catch (e: any) {
      problems.push(`${pool.name}: ${e?.message || e}`)
    }
  }
  await markEpisodeRendered(slug, upper, at)
  log(`Song plays recorded for ${recorded} of ${doc.songs.length} song(s) in ${byPool.size} pool(s).`
    + (problems.length ? ` Not recorded: ${problems.join('; ')}.` : ''))
}
