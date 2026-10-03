/**
 * Episode Builder — the pure decisions (SPEC §4–5, owner decisions 2026-10-03).
 *
 * Nothing here reads disk, calls a provider or spends anything. Building an episode
 * never makes songs: a short pool is reported with the exact number missing and the
 * owner decides whether to generate more (SPEC §1 "Rule kept from today").
 *
 * Every number below is a STARTING value the owner can change per channel (the
 * formula's `musicFormat.episodeDefaults`) and per episode. None is a fixed rule.
 */

import { createHash } from 'crypto'
import { formatTimestamp, seededOrder } from './music-mix.js'

/** Presence of this file in an episode folder marks a music (Episode Builder) episode. */
export const MUSIC_EPISODE_FILENAME = 'music_episode.json'

// ── Settings ────────────────────────────────────────────────────────────────

export type JoinStyle = 'crossfade' | 'butt' | 'silence'
export type SceneMode = 'per-song' | 'count' | 'every-minutes' | 'manual'
export type OrderMode = 'random' | 'smooth' | 'manual'
export type EpisodeResolution = '720p' | '1080p'
/** Light sharpening of each 720p scene still while it is upscaled for a 1080p render. */
export type UpscaleSharpen = 'off' | 'light'
export const UPSCALE_SHARPEN_OPTIONS: readonly UpscaleSharpen[] = ['off', 'light']

export interface EpisodeSettings {
  /** Pool ids songs are drawn from. Empty = this channel's own pool. */
  pools: string[]
  target_length_s: number
  /** No-repeat window, counted in this channel's episodes. */
  no_repeat_episodes: number
  order: OrderMode
  scenes: { mode: SceneMode; count: number; minutes: number }
  /** One theme for this episode; free text or a register/world name. */
  theme: string
  join: { style: JoinStyle; seconds: number }
  /** Picture change at a scene boundary — any Video Assembly transition. */
  scene_change: { transition: string; seconds: number }
  frame_rate: number
  /** 720p = the fleet's native still size; 1080p = upscale at render. */
  resolution: EpisodeResolution
  /** 1080p only: sharpen each still lightly while upscaling it (SPEC §5 "lanczos plus light sharpening"). */
  upscale_sharpen: UpscaleSharpen
  /** No-repeat window for Image Pool stills used as scenes, in this channel's episodes. 0 = off. */
  still_no_repeat_episodes: number
  loudness_lufs: number
  true_peak_db: number
}

/** Owner decisions 2026-10-03 + SPEC starting values. Shown as editable values, never hidden. */
export const STARTING_EPISODE_SETTINGS: EpisodeSettings = {
  pools: [],
  target_length_s: 65 * 60,
  no_repeat_episodes: 30,
  order: 'smooth',
  scenes: { mode: 'per-song', count: 12, minutes: 5 },
  theme: '',
  join: { style: 'crossfade', seconds: 3 },
  scene_change: { transition: 'crossfade', seconds: 4 },
  frame_rate: 24,
  resolution: '720p',
  upscale_sharpen: 'light',
  still_no_repeat_episodes: 0,
  loudness_lufs: -14,
  true_peak_db: -1,
}

export const FRAME_RATES = [24, 25, 30, 60] as const

const num = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}
const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? value as T : fallback
const text = (value: unknown, max: number, fallback: string): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : fallback

/**
 * Validate anything that arrives from a request or a stored file against `base`.
 * Unknown or out-of-range values fall back to `base`, field by field, so one bad
 * value never resets the owner's other choices.
 */
export function normalizeEpisodeSettings(raw: unknown, base: EpisodeSettings = STARTING_EPISODE_SETTINGS): EpisodeSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const join = (r.join && typeof r.join === 'object' ? r.join : {}) as Record<string, unknown>
  const scenes = (r.scenes && typeof r.scenes === 'object' ? r.scenes : {}) as Record<string, unknown>
  const change = (r.scene_change && typeof r.scene_change === 'object' ? r.scene_change : {}) as Record<string, unknown>
  const style = oneOf(join.style, ['crossfade', 'butt', 'silence'] as const, base.join.style)
  const fps = Number(r.frame_rate)
  return {
    pools: Array.isArray(r.pools)
      ? [...new Set(r.pools.filter((p: unknown): p is string => typeof p === 'string' && !!p.trim()).map((p: string) => p.trim()))].slice(0, 20)
      : base.pools,
    target_length_s: Math.round(num(r.target_length_s, 60, 6 * 3600, base.target_length_s)),
    no_repeat_episodes: Math.round(num(r.no_repeat_episodes, 0, 1000, base.no_repeat_episodes)),
    order: oneOf(r.order, ['random', 'smooth', 'manual'] as const, base.order),
    scenes: {
      mode: oneOf(scenes.mode, ['per-song', 'count', 'every-minutes', 'manual'] as const, base.scenes.mode),
      count: Math.round(num(scenes.count, 1, 500, base.scenes.count)),
      minutes: num(scenes.minutes, 0.5, 120, base.scenes.minutes),
    },
    theme: text(r.theme, 120, base.theme),
    join: {
      style,
      seconds: num(join.seconds, style === 'silence' ? 0.1 : 0.5, style === 'silence' ? 30 : 15, base.join.seconds),
    },
    scene_change: {
      transition: text(change.transition, 40, base.scene_change.transition) || base.scene_change.transition,
      seconds: num(change.seconds, 0, 10, base.scene_change.seconds),
    },
    frame_rate: (FRAME_RATES as readonly number[]).includes(fps) ? fps : base.frame_rate,
    // model-drift-allow: the local FFmpeg render size (owner decision: 720p native stills or upscale to 1080p), not a model option
    resolution: oneOf(r.resolution, ['720p', '1080p'] as const, base.resolution),
    upscale_sharpen: oneOf(r.upscale_sharpen, UPSCALE_SHARPEN_OPTIONS, base.upscale_sharpen),
    still_no_repeat_episodes: Math.round(num(r.still_no_repeat_episodes, 0, 1000, base.still_no_repeat_episodes)),
    loudness_lufs: num(r.loudness_lufs, -40, -5, base.loudness_lufs),
    true_peak_db: num(r.true_peak_db, -9, 0, base.true_peak_db),
  }
}

/**
 * The channel's starting values from the formula's `musicFormat.episodeDefaults`
 * (INTERFACES.md, feat/music-pool shape). Missing fields keep the code starting values.
 */
export function settingsFromEpisodeDefaults(defaults: unknown): EpisodeSettings {
  const d = (defaults && typeof defaults === 'object' ? defaults : {}) as Record<string, any>
  const scenes = d.scenes && typeof d.scenes === 'object' ? d.scenes : {}
  return normalizeEpisodeSettings({
    pools: d.pools,
    target_length_s: d.target_length_s,
    no_repeat_episodes: d.no_repeat_episodes,
    scenes: { mode: scenes.mode, count: scenes.count, minutes: scenes.minutes },
    theme: Array.isArray(d.scene_themes) ? d.scene_themes.find((t: unknown) => typeof t === 'string' && t.trim()) : undefined,
    join: d.join && typeof d.join === 'object' ? { style: d.join.style, seconds: d.join.seconds } : undefined,
    scene_change: d.scene_change,
    frame_rate: d.frame_rate,
    resolution: d.resolution,
    upscale_sharpen: d.upscale_sharpen,
    still_no_repeat_episodes: d.still_no_repeat_episodes,
    loudness_lufs: d.loudness_lufs,
    true_peak_db: d.true_peak_db,
  })
}

// ── Songs ───────────────────────────────────────────────────────────────────

/** What the builder needs from a pool song (see music-pool-source.ts). */
export interface BuilderSong {
  pool_id: string
  id: string
  title: string
  duration_s: number
  drawable: boolean
  rating?: number | null
  mood?: string
  energy?: number
  tempo_bpm?: number
  key?: string
  ensemble?: string
  scene_idea?: string
  theme?: string
  tags?: string[]
  /** Plays across every channel = rendered episodes this song is in. */
  plays: number
}

export interface SongRef { pool_id: string; song_id: string }
export interface EpisodeSong extends SongRef { locked?: boolean }

export const songKey = (ref: { pool_id: string; song_id?: string; id?: string }): string =>
  `${ref.pool_id}/${ref.song_id ?? ref.id}`

// ── The no-repeat window ────────────────────────────────────────────────────

export interface ChannelUse { code: string; at: string }

/**
 * The last `n` episodes of this channel, other than the one being built.
 *
 * "Counts episodes in order, not days" (SPEC §4.1): rendered uses (pool records,
 * ordered by when they were rendered) and this channel's other DRAFTED episodes
 * (built but not rendered yet) are one ordered list, newest last. Drafts count so
 * that building five episodes in a row before rendering any cannot reuse songs.
 */
export function windowEpisodeCodes(uses: readonly ChannelUse[], currentCode: string, n: number): string[] {
  if (n <= 0) return []
  const latest = new Map<string, string>()
  for (const use of uses) {
    const code = use.code.toUpperCase()
    if (!code || code === currentCode.toUpperCase()) continue
    const prev = latest.get(code)
    if (!prev || use.at > prev) latest.set(code, use.at)
  }
  return [...latest.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0], undefined, { numeric: true }))
    .slice(-n)
    .map(([code]) => code)
}

// ── Draw ────────────────────────────────────────────────────────────────────

export interface DrawInput {
  songs: readonly BuilderSong[]
  /** The current episode list; locked rows keep their place. */
  current: readonly EpisodeSong[]
  targetSec: number
  seed: string
  theme: string
  /** songKey → the episode code inside the window that used it. */
  blocked: ReadonlyMap<string, string>
  order: OrderMode
  /** Join style, so a crossfade's overlap is counted against the target. */
  join?: EpisodeSettings['join']
}

export interface DrawResult {
  songs: EpisodeSong[]
  total_sec: number
  shortfall_sec: number
  /** Drawable songs outside the window and not already locked in. */
  free_count: number
  notes: string[]
}

function seededUnit(seed: string, key: string): number {
  return createHash('sha256').update(`${seed}\n${key}`).digest().readUInt32BE(0) / 2 ** 32
}

const sameText = (a?: string, b?: string): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

function themeMatch(song: BuilderSong, theme: string): boolean {
  if (!theme.trim()) return false
  return sameText(song.theme, theme) || sameText(song.mood, theme) || (song.tags || []).some(tag => sameText(tag, theme))
}

/**
 * Draw weight, lower first: least played first, then rating and the episode
 * theme pull a song forward; a seeded jitter breaks ties so successive episodes
 * do not open with the same song.
 */
function drawScore(song: BuilderSong, theme: string, seed: string): number {
  const rating = typeof song.rating === 'number' ? song.rating : 3
  return song.plays
    - (rating - 3) * 0.3
    - (themeMatch(song, theme) ? 0.5 : 0)
    + seededUnit(seed, songKey(song)) * 0.9
}

export const isUsable = (song: BuilderSong): boolean => song.drawable && song.duration_s > 0

/** Seconds each junction adds (silence) or removes (crossfade overlap). */
function joinStep(join?: EpisodeSettings['join']): number {
  if (!join || join.style === 'butt') return 0
  return join.style === 'silence' ? join.seconds : -join.seconds
}

/**
 * Re-draw every unlocked song. Locked songs keep their place; the rest is filled
 * from free songs to the target, finishing the last song rather than cutting it.
 */
export function drawEpisode(input: DrawInput): DrawResult {
  const byKey = new Map(input.songs.map(song => [songKey(song), song]))
  const notes: string[] = []
  const locked = input.current
    .map((ref, index) => ({ ref, index, song: byKey.get(songKey(ref)) }))
    .filter(row => row.ref.locked)
  const missingLocked = locked.filter(row => !row.song || !isUsable(row.song))
  if (missingLocked.length) {
    notes.push(`${missingLocked.length} locked song(s) are no longer in a selected pool or can no longer be drawn; they were dropped.`)
  }
  const keptLocked = locked.filter(row => row.song && isUsable(row.song))
  const lockedKeys = new Set(keptLocked.map(row => songKey(row.ref)))
  const free = input.songs.filter(song => isUsable(song) && !lockedKeys.has(songKey(song)) && !input.blocked.has(songKey(song)))
  const unusable = input.songs.filter(song => !song.drawable || !(song.duration_s > 0)).length
  if (unusable) notes.push(`${unusable} song(s) skipped: rejected, switched off, or without a measured length.`)

  const step = joinStep(input.join)
  const runtime = (count: number, sum: number) => (count ? sum + step * (count - 1) : 0)
  let sum = keptLocked.reduce((acc, row) => acc + row.song!.duration_s, 0)
  let count = keptLocked.length
  const picked: BuilderSong[] = []
  for (const song of [...free].sort((a, b) => drawScore(a, input.theme, input.seed) - drawScore(b, input.theme, input.seed))) {
    if (runtime(count, sum) >= input.targetSec) break
    picked.push(song)
    sum += song.duration_s
    count++
  }
  const total = runtime(count, sum)
  const shortfall = Math.max(0, Math.round(input.targetSec - total))

  const ordered = placeAroundLocks(
    keptLocked.map(row => ({ index: row.index, song: row.song! })),
    picked,
    input.order,
    input.seed,
  )
  return {
    songs: ordered.map(song => ({ pool_id: song.pool_id, song_id: song.id, ...(lockedKeys.has(songKey(song)) ? { locked: true } : {}) })),
    total_sec: Math.round(total),
    shortfall_sec: shortfall,
    free_count: free.length,
    notes,
  }
}

/**
 * Re-order the unlocked songs of an existing list by `order`, locked songs staying put.
 * Manual keeps the list exactly as it is.
 */
export function orderEpisode(
  current: readonly EpisodeSong[],
  songs: readonly BuilderSong[],
  order: OrderMode,
  seed: string,
): EpisodeSong[] {
  if (order === 'manual') return current.map(ref => ({ ...ref }))
  const byKey = new Map(songs.map(song => [songKey(song), song]))
  const rows = current.map((ref, index) => ({ ref, index, song: byKey.get(songKey(ref)) }))
  // A row whose song cannot be resolved stays where it is, like a lock.
  const fixed = rows.filter(row => row.ref.locked || !row.song)
  const loose = rows.filter(row => !row.ref.locked && row.song).map(row => row.song!)
  const fixedSongs = fixed.map(row => ({ index: row.index, song: row.song ?? placeholder(row.ref) }))
  const placed = placeAroundLocks(fixedSongs, loose, order, seed)
  const lockedKeys = new Set(current.filter(ref => ref.locked).map(songKey))
  return placed.map(song => ({ pool_id: song.pool_id, song_id: song.id, ...(lockedKeys.has(songKey(song)) ? { locked: true } : {}) }))
}

function placeholder(ref: SongRef): BuilderSong {
  return { pool_id: ref.pool_id, id: ref.song_id, title: '', duration_s: 0, drawable: false, plays: 0 }
}

function placeAroundLocks(
  fixed: Array<{ index: number; song: BuilderSong }>,
  loose: BuilderSong[],
  order: OrderMode,
  seed: string,
): BuilderSong[] {
  const length = fixed.length + loose.length
  const slots: Array<BuilderSong | null> = Array.from({ length }, () => null)
  for (const row of [...fixed].sort((a, b) => a.index - b.index)) {
    let at = Math.min(row.index, length - 1)
    while (slots[at]) at = (at + 1) % length
    slots[at] = row.song
  }
  if (order === 'smooth') return smoothFill(slots, loose, seed)
  const queue = order === 'random' ? seededOrder(loose, `${seed}:order`) : [...loose]
  return slots.map(slot => slot ?? queue.shift()!)
}

/** SPEC §4.2 smooth flow: the most a tempo should move between neighbours. */
export const SMOOTH_MAX_BPM_STEP = 12

/** Energy arc: start mid, settle low (5 = most energy). */
function targetEnergy(position: number, length: number): number {
  return length <= 1 ? 3 : 3 - 1.5 * (position / (length - 1))
}

function flowPenalty(prev: BuilderSong | undefined, next: BuilderSong, position: number, length: number): number {
  let penalty = 0
  if (prev?.tempo_bpm && next.tempo_bpm) {
    const step = Math.abs(prev.tempo_bpm - next.tempo_bpm)
    penalty += step > SMOOTH_MAX_BPM_STEP ? 10 + step / SMOOTH_MAX_BPM_STEP : step / (2 * SMOOTH_MAX_BPM_STEP)
  }
  if (prev && sameText(prev.key, next.key) && sameText(prev.ensemble, next.ensemble)) penalty += 10
  if (typeof next.energy === 'number') penalty += Math.abs(next.energy - targetEnergy(position, length))
  return penalty
}

/**
 * Greedy smooth flow: each free slot takes the remaining song that moves least
 * from its neighbour — tempo within 12 BPM, never the same key AND ensemble,
 * energy following a gentle arc. Key is requested, not guaranteed (SPEC §2.2),
 * so this is a preference, never a refusal.
 */
function smoothFill(slots: Array<BuilderSong | null>, loose: BuilderSong[], seed: string): BuilderSong[] {
  const remaining = seededOrder(loose, `${seed}:smooth`)
  const out: BuilderSong[] = []
  for (let i = 0; i < slots.length; i++) {
    const fixed = slots[i]
    if (fixed) { out.push(fixed); continue }
    let best = 0
    let bestPenalty = Infinity
    for (let c = 0; c < remaining.length; c++) {
      const penalty = flowPenalty(out[i - 1], remaining[c]!, i, slots.length)
        + (slots[i + 1] ? flowPenalty(remaining[c], slots[i + 1]!, i + 1, slots.length) : 0)
      if (penalty < bestPenalty) { bestPenalty = penalty; best = c }
    }
    out.push(remaining.splice(best, 1)[0]!)
  }
  return out
}

/** Neighbours that break the smooth-flow preferences, for an honest hint. */
export function smoothFlowBreaks(list: readonly BuilderSong[]): { tempo: number; keyAndEnsemble: number } {
  let tempo = 0
  let keyAndEnsemble = 0
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1]!
    const b = list[i]!
    if (a.tempo_bpm && b.tempo_bpm && Math.abs(a.tempo_bpm - b.tempo_bpm) > SMOOTH_MAX_BPM_STEP) tempo++
    if (sameText(a.key, b.key) && sameText(a.ensemble, b.ensemble)) keyAndEnsemble++
  }
  return { tempo, keyAndEnsemble }
}

/** SPEC §4.3: the five free songs closest by length and mood. */
export function swapCandidates(
  target: BuilderSong,
  songs: readonly BuilderSong[],
  inEpisode: ReadonlySet<string>,
  blocked: ReadonlyMap<string, string>,
  limit = 5,
): BuilderSong[] {
  const distance = (song: BuilderSong) => Math.abs(song.duration_s - target.duration_s) / 30
    + (sameText(song.mood, target.mood) ? 0 : 1)
    + (sameText(song.ensemble, target.ensemble) ? 0 : 0.5)
  return songs
    .filter(song => isUsable(song) && !inEpisode.has(songKey(song)) && !blocked.has(songKey(song)))
    .sort((a, b) => distance(a) - distance(b) || a.title.localeCompare(b.title))
    .slice(0, limit)
}

// ── Timeline ────────────────────────────────────────────────────────────────

export interface Timeline {
  /** Where each song starts in the stitched audio (crossfade: where its fade-in begins). */
  starts: number[]
  total: number
  /** Crossfade actually used (shortened when a song is too short for it). */
  join_seconds: number
}

/** Song start times for a join style. Measured durations in, chapter times out. */
export function buildTimeline(durations: readonly number[], join: EpisodeSettings['join']): Timeline {
  const n = durations.length
  const sum = durations.reduce((a, b) => a + b, 0)
  if (!n) return { starts: [], total: 0, join_seconds: 0 }
  let step = 0
  if (join.style === 'silence') step = join.seconds
  if (join.style === 'crossfade' && n > 1) {
    // acrossfade cannot overlap more than the shorter neighbour; half of the
    // shortest song keeps every song audible on its own for a moment.
    step = -Math.min(join.seconds, Math.min(...durations) / 2)
  }
  const starts: number[] = []
  let at = 0
  for (const duration of durations) {
    starts.push(Math.max(0, at))
    at += duration + step
  }
  return { starts, total: Math.max(0, sum + step * (n - 1)), join_seconds: Math.abs(step) }
}

/** The tracklist that becomes YouTube chapters: `0:00 Title`, one line per song. */
export function renderEpisodeTracklist(titles: readonly string[], starts: readonly number[]): string {
  return titles.map((title, i) => `${formatTimestamp(starts[i] ?? 0)} ${title}`).join('\n')
}

// ── Scenes ──────────────────────────────────────────────────────────────────

function nearestSongStart(starts: readonly number[], at: number): number {
  let best = 1
  for (let i = 1; i < starts.length; i++) {
    if (Math.abs(starts[i]! - at) < Math.abs(starts[best]! - at)) best = i
  }
  return best
}

/**
 * Which songs share a scene. Every scene change lands on a song start (SPEC §5).
 * Returns song-index groups in order; the first group always starts at song 0.
 */
export function groupScenes(
  starts: readonly number[],
  total: number,
  scenes: EpisodeSettings['scenes'],
  manualBreaks: ReadonlySet<number> = new Set(),
): number[][] {
  const n = starts.length
  if (!n) return []
  const breaks = new Set<number>()
  if (scenes.mode === 'per-song') for (let i = 1; i < n; i++) breaks.add(i)
  if (scenes.mode === 'manual') for (const i of manualBreaks) if (i >= 1 && i < n) breaks.add(i)
  if (n > 1 && scenes.mode === 'count') {
    const count = Math.min(n, Math.max(1, scenes.count))
    for (let k = 1; k < count; k++) breaks.add(nearestSongStart(starts, (k * total) / count))
  }
  if (n > 1 && scenes.mode === 'every-minutes') {
    const every = scenes.minutes * 60
    for (let at = every; at < total - every / 2; at += every) breaks.add(nearestSongStart(starts, at))
  }
  const groups: number[][] = []
  for (let i = 0; i < n; i++) {
    if (i === 0 || breaks.has(i)) groups.push([])
    groups[groups.length - 1]!.push(i)
  }
  return groups
}

/** Stable scene id: a picture follows the first song of its scene through reorders. */
export function sceneIdFor(firstSong: SongRef): string {
  return `ms-${createHash('sha256').update(songKey(firstSong)).digest('hex').slice(0, 12)}`
}

/**
 * SPEC §5 scene prompt: the song's scene idea + the episode theme + the channel's
 * visual style + "no people, no text".
 */
export function buildScenePrompt(input: { sceneIdea?: string; title: string; theme?: string; style?: string }): string {
  const idea = input.sceneIdea?.trim().replace(/[.\s]+$/, '')
    || `A quiet, atmospheric scene that matches the music "${input.title.trim()}"`
  return [
    idea,
    input.theme?.trim() ? `${input.theme.trim()} mood` : '',
    input.style?.trim() || '',
    'no people, no text',
  ].filter(Boolean).join(', ')
}

// ── Render settings ─────────────────────────────────────────────────────────

/**
 * Video Assembly's "Music episode" settings, server-side (Pipeline): the same values Video
 * Assembly's "Use Music Episode Settings" button applies, on top of whatever the owner's Video
 * Assembly preset carries (logo, grade, effects stay). No intro/outro clips, title cards, chapter
 * titles or subtitles — a music episode has no narration to caption.
 */
const NARRATION_ONLY_RENDER_KEYS = ['intro', 'outro', 'timeline_clips', 'title_image', 'title_card', 'outro_card', 'chapter_titles', 'subtitles']

export function musicEpisodeRenderParams(params: Record<string, unknown>, settings: EpisodeSettings): Record<string, unknown> {
  const rest = { ...params }
  for (const key of NARRATION_ONLY_RENDER_KEYS) delete rest[key]
  const cut = !(settings.scene_change.seconds > 0) || settings.scene_change.transition === 'none'
  return {
    ...rest,
    transition: cut ? 'none' : settings.scene_change.transition,
    transition_duration: cut ? 0 : settings.scene_change.seconds,
    transition_pool: [],
    transition_randomize: 'off',
    scene_animation: { type: 'ken-burns', zoom_start: 100, zoom_end: 106, pool: [], randomize_mode: 'off' },
    animation_pool: [],
    animation_randomize: 'off',
    fps: settings.frame_rate,
    // model-drift-allow: the local FFmpeg render size from the episode's own settings, not a model option
    resolution: settings.resolution,
    upscale_sharpen: settings.resolution === '1080p' ? settings.upscale_sharpen : 'off',
    // Coordinator decision 2026-10-03: hardware encoding at ~5 Mbps (1080p) / 2.5 Mbps (720p).
    encoding_effort: 'hardware',
    video_bitrate_kbps: settings.resolution === '1080p' ? 5000 : 2500,
    post_audio: { behavior: 'hard-cut' },
  }
}
