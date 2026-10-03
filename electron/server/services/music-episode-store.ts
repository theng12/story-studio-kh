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
import * as pm from './project-manager.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from './utils.js'
import { resolveSceneImagesDir } from '../generators/scene-image.js'
import { getEffectiveNiche } from './niche-loader.js'
import {
  MUSIC_EPISODE_FILENAME,
  STARTING_EPISODE_SETTINGS,
  buildScenePrompt,
  buildTimeline,
  groupScenes,
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
export async function channelStartingSettings(slug: string): Promise<{ settings: EpisodeSettings; music_channel: boolean; themes: string[] }> {
  const niche = await getEffectiveNiche(slug).catch(() => null) as {
    musicFormat?: { episodeDefaults?: { scene_themes?: unknown }; registers?: Record<string, { label?: string }> }
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
    ...(raw?.built ? { built: raw.built } : {}),
    updated_at: typeof raw?.updated_at === 'string' ? raw.updated_at : new Date(0).toISOString(),
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

interface ChannelHistory { episodes: Record<string, { songs: string[]; at: string }> }

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
  return { pools, missing_pools, songs, byKey: new Map(songs.map(s => [songKey(s), s])), blocked, window_codes: window }
}

/** Timeline + scenes for a list of songs (stored lengths, or the measured stitch when it still matches). */
export function planEpisode(doc: MusicEpisodeDoc, byKey: ReadonlyMap<string, BuilderSong>) {
  const rows = doc.songs.map(ref => byKey.get(songKey(ref)))
  const keys = doc.songs.map(songKey)
  const built = doc.built && doc.built.song_keys.join('\n') === keys.join('\n') ? doc.built : null
  const timeline = built
    ? { starts: built.starts, total: built.total_sec, join_seconds: built.join_seconds }
    : buildTimeline(rows.map(song => song?.duration_s || 0), doc.settings.join)
  const breaks = new Set(doc.scene_breaks.map(key => keys.indexOf(key)).filter(i => i > 0))
  const groups = groupScenes(timeline.starts, timeline.total, doc.settings.scenes, breaks)
  const scenes = groups.map((group, index) => {
    const first = doc.songs[group[0]!]!
    const id = sceneIdFor(first)
    const firstSong = rows[group[0]!]
    const custom = doc.prompt_overrides[id]?.trim()
    return {
      id,
      scene_index: index + 1,
      start_sec: timeline.starts[group[0]!] ?? 0,
      end_sec: index + 1 < groups.length ? timeline.starts[groups[index + 1]![0]!]! : timeline.total,
      song_keys: group.map(i => keys[i]!),
      titles: group.map(i => rows[i]?.title || doc.songs[i]!.song_id),
      prompt: custom || buildScenePrompt({ sceneIdea: firstSong?.scene_idea, title: firstSong?.title || first.song_id, theme: doc.settings.theme }),
      prompt_is_custom: !!custom,
    }
  })
  return { timeline, scenes, measured: !!built }
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
  const { timeline, scenes } = planEpisode(doc, ctx.byKey)
  const sceneOfKey = new Map(scenes.flatMap(scene => scene.song_keys.map(key => [key, scene.id] as const)))
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
 * Write the episode, this channel's draft history and the derived scene plan.
 * Image fields already in the plan are kept for every scene id that survives,
 * so a picture follows its song through reorders and re-draws.
 */
export async function saveEpisodeDoc(slug: string, doc: MusicEpisodeDoc, byKey: ReadonlyMap<string, BuilderSong>): Promise<void> {
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
  await withLock(history, async () => {
    const current = await readHistory(slug)
    current.episodes[code] = { songs: [...keys], at: current.episodes[code]?.at || next.updated_at }
    await writeJsonAtomic(history, current)
  })

  await writeDerivedScenePlan(slug, code, next, byKey)
}

export async function writeDerivedScenePlan(
  slug: string,
  code: string,
  doc: MusicEpisodeDoc,
  byKey: ReadonlyMap<string, BuilderSong>,
): Promise<ScenePlan> {
  const episodeDir = await episodeDirFor(slug, code)
  const planPath = await resolveScenePlanPath(slug, code, episodeDir)
  const { timeline, scenes } = planEpisode(doc, byKey)
  await fs.mkdir(path.dirname(planPath), { recursive: true })
  return withLock(planPath, async () => {
    const previous = existsSync(planPath)
      ? JSON.parse(await fs.readFile(planPath, 'utf8')) as ScenePlan
      : null
    const byId = new Map((previous?.scenes || []).map(scene => [scene.id, scene]))
    const now = new Date().toISOString()
    const plan: ScenePlan & { music_episode: { scene_song_keys: string[][] } } = {
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
      scenes: scenes.map((scene): ScenePlanEntry => {
        const prev = byId.get(scene.id)
        const keep = prev ? {
          ...(prev.image_path ? { image_path: prev.image_path } : {}),
          ...(prev.rendered_prompt !== undefined ? { rendered_prompt: prev.rendered_prompt } : {}),
          ...(prev.image_version ? { image_version: prev.image_version } : {}),
          ...(prev.motion_choice ? { motion_choice: prev.motion_choice } : {}),
          ...(prev.clip_path ? { clip_path: prev.clip_path } : {}),
          ...(prev.rendered_motion_prompt !== undefined ? { rendered_motion_prompt: prev.rendered_motion_prompt } : {}),
          ...(prev.clip_source_image_version ? { clip_source_image_version: prev.clip_source_image_version } : {}),
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
          ...keep,
        }
      }),
    }
    await writeJsonAtomic(planPath, plan)
    return plan
  })
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
      recorded += await recordEpisodeUse(pool.project_slug, ids, { code: upper, project_slug: slug, used_at: at })
    } catch (e: any) {
      problems.push(`${pool.name}: ${e?.message || e}`)
    }
  }
  await markEpisodeRendered(slug, upper, at)
  log(`Song plays recorded: ${recorded} new for ${doc.songs.length} song(s) in ${byPool.size} pool(s).`
    + (problems.length ? ` Not recorded: ${problems.join('; ')}.` : ''))
}
