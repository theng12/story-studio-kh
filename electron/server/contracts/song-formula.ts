/**
 * The song formula and episode starting values of a music channel (music format, phase 1).
 *
 * Lives in a Series Formula as `musicFormat.songFormula` / `musicFormat.episodeDefaults`; the
 * shape is the shared contract in `_orchestra/audit-20261001/music-format/INTERFACES.md`, so the
 * Episode Builder and effects branches read the same thing. Every list is the owner's to edit;
 * the STARTING_* values are the SPEC's Cello example and are only shown as a starting point when
 * a formula has none yet — never applied behind his back.
 */
import { z } from 'zod'

export const ALL_KEYS: readonly string[] = (() => {
  const roots = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
  return [...roots.map(r => `${r} major`), ...roots.map(r => `${r} minor`)]
})()

const weighted = z.object({ value: z.string().trim().min(1).max(80), weight: z.number().min(0).max(1000) })
const tempoBand = z.object({
  id: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(60),
  min_bpm: z.number().int().min(20).max(300),
  max_bpm: z.number().int().min(20).max(300),
  weight: z.number().min(0).max(1000),
}).refine(b => b.min_bpm <= b.max_bpm, { message: 'A tempo band must not start above where it ends' })

/**
 * Songs with lyrics (owner 2026-10-12): a channel switch, absent or `enabled: false` = instrumental, as
 * before. On, the writing model also writes each song's lyrics and a style line, a model that sings
 * (YuE2) makes it, and a transcription model listens back: under `min_match` of the lyric words heard
 * in order, the take goes to the pool's _trash and the song is sung again, up to `max_takes`.
 */
/**
 * The channel's singer(s) (owner 2026-10-12, approved after the same-singer test): a fixed voice phrase
 * and a fixed seed that every song of this channel uses — the writing model writes only the genre and
 * instrument part. With 2–3 singers each song gets one of them (a male/female pair, say). Empty = off:
 * the writer describes a voice per song, as before.
 */
export const SingerSchema = z.object({
  name: z.string().trim().min(1).max(40),
  voice: z.string().trim().min(3).max(200),
  seed: z.number().int().min(0).max(2_147_483_647),
}).strict()
export type Singer = z.infer<typeof SingerSchema>

export const LyricsSettingsSchema = z.object({
  enabled: z.boolean(),
  language: z.string().trim().min(2).max(40),
  min_match: z.number().min(0).max(1),
  max_takes: z.number().int().min(1).max(5),
  in_description: z.boolean(),
  singers: z.array(SingerSchema).max(3).optional(),
}).strict()
export type LyricsSettings = z.infer<typeof LyricsSettingsSchema>
export const STARTING_LYRICS: LyricsSettings = { enabled: false, language: 'English', min_match: 0.7, max_takes: 3, in_description: false }

export const SongFormulaSchema = z.object({
  ensembles: z.array(weighted).min(1).max(40),
  moods: z.array(weighted).min(1).max(60),
  tempo_bands: z.array(tempoBand).min(1).max(12),
  keys: z.array(z.string().refine(k => ALL_KEYS.includes(k), { message: 'Unknown key' })).max(24),
  textures: z.array(weighted).min(1).max(40),
  structures: z.array(weighted).min(1).max(40),
  length_s: z.object({ min: z.number().int().min(1).max(3600), max: z.number().int().min(1).max(3600) })
    .refine(l => l.min <= l.max, { message: 'The shortest song must not be longer than the longest' }),
  never: z.array(z.string().trim().min(1).max(60)).max(100),
  variety: z.object({
    unique_combos: z.boolean(),
    spread_least_filled: z.boolean(),
    max_title_word_share: z.number().min(0.001).max(1),
    max_similarity: z.number().min(0.05).max(1),
    trim_silence: z.boolean(),
    flag_gap_s: z.number().min(0.5).max(120),
  }),
  lyrics: LyricsSettingsSchema.optional(),
}).strict()
export type SongFormula = z.infer<typeof SongFormulaSchema>
export type Weighted = z.infer<typeof weighted>
export type TempoBand = z.infer<typeof tempoBand>

export const EpisodeDefaultsSchema = z.object({
  target_length_s: z.number().int().min(60).max(86400),
  no_repeat_episodes: z.number().int().min(0).max(10000),
  loudness_lufs: z.number().min(-40).max(-5),
  true_peak_db: z.number().min(-12).max(0),
  join: z.object({ style: z.enum(['crossfade', 'butt', 'silence']), seconds: z.number().min(0).max(30) }),
  scenes: z.object({
    mode: z.enum(['per-song', 'count', 'every-minutes', 'manual']),
    count: z.number().int().min(1).max(500).optional(),
    minutes: z.number().min(0.5).max(600).optional(),
    /** Draw each song's title as lettering in its own picture (one-per-song scenes). */
    title_on_scene: z.boolean().optional(),
  }),
  scene_themes: z.array(z.string().trim().min(1).max(120)).max(50),
  scene_change: z.object({ transition: z.string().trim().min(1).max(60), seconds: z.number().min(0).max(30) }),
  effects_look: z.array(z.string().trim().min(1).max(120)).max(50),
  frame_rate: z.number().int().min(1).max(120),
  // model-drift-allow: the episode's own output size (owner 2026-10-03: 720p, or Story's local 1080p upscale), not a model option
  resolution: z.enum(['720p', '1080p']),
  /** 1080p: sharpen each 720p still lightly while upscaling it (feat/music-finish, optional). */
  upscale_sharpen: z.enum(['off', 'light']).optional(),
  /** No-repeat window for Image Pool stills used as scenes, in episodes; 0 = off (feat/music-finish, optional). */
  still_no_repeat_episodes: z.number().int().min(0).max(10000).optional(),
  pools: z.array(z.string().trim().min(1).max(80)).max(50),
}).strict()
export type EpisodeDefaults = z.infer<typeof EpisodeDefaultsSchema>

/**
 * The places this channel's scene pictures are set in (e.g. 30 different cosy cafés), one per
 * picture, spread across the list. Separate from the song themes, which stay as they are.
 * Duplicates (ignoring case) are dropped; null on save = no list (pictures follow each song's
 * scene idea, as before).
 */
export const SceneSettingsSchema = z.array(z.string().trim().min(2, 'A scene setting needs at least 2 characters').max(160, 'A scene setting is at most 160 characters'))
  .transform(list => list.filter((w, i) => list.findIndex(x => x.toLowerCase() === w.toLowerCase()) === i))
  .pipe(z.array(z.string()).min(1, 'Give at least one scene setting').max(200, 'At most 200 scene settings'))

export const MusicFormatPatchSchema = z.object({
  songFormula: SongFormulaSchema.optional(),
  episodeDefaults: EpisodeDefaultsSchema.optional(),
  sceneSettings: SceneSettingsSchema.nullable().optional(),
}).strict().refine(p => p.songFormula || p.episodeDefaults || p.sceneSettings !== undefined, { message: 'Nothing to save' })


const w = (value: string, weight = 1): Weighted => ({ value, weight })

/** SPEC §2.1 Cello example. A starting point the owner edits, not a default. */
export const STARTING_SONG_FORMULA: SongFormula = {
  ensembles: [w('Solo cello', 50), w('Cello + piano', 30), w('Cello quartet', 20)],
  moods: ['Tender', 'Melancholic', 'Hopeful', 'Nocturnal', 'Pastoral', 'Adventurous', 'Cosy'].map(m => w(m)),
  tempo_bands: [
    { id: 'slow', label: 'Slow', min_bpm: 50, max_bpm: 64, weight: 50 },
    { id: 'gentle', label: 'Gentle', min_bpm: 65, max_bpm: 80, weight: 30 },
    { id: 'flowing', label: 'Flowing', min_bpm: 81, max_bpm: 96, weight: 20 },
  ],
  keys: [],
  textures: ['Close-mic intimate', 'Warm room', 'Distant hall', 'Soft tape warmth', 'Rain-on-window bed'].map(t => w(t)),
  structures: ['ABA', 'Slow build', 'Theme & variations', 'Through-composed', 'Loop-friendly ambient'].map(s => w(s)),
  length_s: { min: 180, max: 270 },
  never: ['vocals', 'drums'],
  variety: {
    unique_combos: true,
    spread_least_filled: true,
    max_title_word_share: 0.03,
    max_similarity: 0.5,
    trim_silence: true,
    flag_gap_s: 5,
  },
}

/** Owner decisions 2026-10-03: crossfade joins, 720p, 24 fps, −14 LUFS / −1 dBTP — all adjustable. */
export const STARTING_EPISODE_DEFAULTS: EpisodeDefaults = {
  target_length_s: 3900,
  no_repeat_episodes: 30,
  loudness_lufs: -14,
  true_peak_db: -1,
  join: { style: 'crossfade', seconds: 3 },
  scenes: { mode: 'per-song' },
  scene_themes: [],
  scene_change: { transition: 'crossfade', seconds: 4 },
  effects_look: [],
  frame_rate: 24,
  resolution: '720p',
  upscale_sharpen: 'light',
  still_no_repeat_episodes: 0,
  pools: [],
}

/** The keys a formula draws from: its own subset, or all 24 when it names none. */
export function formulaKeys(f: SongFormula): string[] {
  return f.keys.length ? [...f.keys] : [...ALL_KEYS]
}

export function comboKey(c: { ensemble: string; mood: string; tempo_band: string; key: string; structure: string }): string {
  return [c.ensemble, c.mood, c.tempo_band, c.key, c.structure].map(s => s.trim().toLowerCase()).join('|')
}

/** How many distinct combinations the formula allows (values with weight 0 are never drawn). */
export function comboCount(f: SongFormula): number {
  const live = (xs: Array<{ weight?: number }>) => xs.filter(x => (x.weight ?? 0) > 0).length
  return live(f.ensembles) * live(f.moods) * live(f.tempo_bands) * formulaKeys(f).length * live(f.structures)
}

/** Songs per episode and songs needed for a window — the "What this pool needs" card. */
export function poolNeeds(targetLengthS: number, windowEpisodes: number, averageSongS: number) {
  const perEpisode = averageSongS > 0 ? targetLengthS / averageSongS : 0
  // SPEC §3 table: 18 songs × 30 episodes = 540.
  return { per_episode: perEpisode, needed: Math.ceil(perEpisode * windowEpisodes) }
}
