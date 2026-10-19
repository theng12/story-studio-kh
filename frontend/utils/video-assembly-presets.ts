export interface TitleImageState {
  enabled: boolean
  image_path: string
  duration: number
  transition_type: string
  transition_duration: number
}

export type TitleImagePresetData = Omit<TitleImageState, 'image_path'>

/**
 * The closing music tail's controls — what the background bed does AFTER the
 * narration ends. They live beside `post_audio.behavior` / `tail_seconds`,
 * which own the tail's LENGTH; these own its sound. Reusable look, so they ride
 * in the Video Assembly timeline preset (AGENTS.md §5).
 */
export interface ClosingMusicState {
  /**
   * Percent of the bed's normal post-narration level (the level Audio Assembly
   * already gives the music once the voice stops). 100 = exactly that level.
   */
  volume: number
  /** Seconds the bed takes to rise back out of the duck once the speech stops. */
  duck_release_sec: number
  /** Seconds of fade-out over the end of the tail. */
  fade_out_sec: number
}

/**
 * What the closing tail sounds like with nothing touched.
 *
 * 100% is deliberately NOT full scale: it is the level Audio Assembly already
 * set for the music after the narration, so a channel that never opens this
 * panel closes with the very bed it already approved. The rise is long enough to
 * hear as a rise rather than a jump, and the fade is long enough that the music
 * never stops with a cut.
 */
export const CLOSING_MUSIC_DEFAULTS: ClosingMusicState = {
  volume: 100,
  duck_release_sec: 1.5,
  fade_out_sec: 5,
}

/** Ranges the page's sliders and the backend both honour. */
export const CLOSING_MUSIC_LIMITS = {
  volume: { min: 0, max: 200 },
  duck_release_sec: { min: 0, max: 10 },
  fade_out_sec: { min: 0, max: 20 },
} as const

function clampSetting(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

/**
 * One complete closing-music state. Anything missing, of the wrong type, or
 * outside its range becomes its default — a preset saved before these controls
 * existed therefore restores the tuned defaults rather than an undefined that
 * would reach the mix.
 */
export function normalizeClosingMusic(
  raw: Partial<ClosingMusicState> | null | undefined,
): ClosingMusicState {
  return {
    volume: clampSetting(raw?.volume, CLOSING_MUSIC_LIMITS.volume.min, CLOSING_MUSIC_LIMITS.volume.max, CLOSING_MUSIC_DEFAULTS.volume),
    duck_release_sec: clampSetting(raw?.duck_release_sec, CLOSING_MUSIC_LIMITS.duck_release_sec.min, CLOSING_MUSIC_LIMITS.duck_release_sec.max, CLOSING_MUSIC_DEFAULTS.duck_release_sec),
    fade_out_sec: clampSetting(raw?.fade_out_sec, CLOSING_MUSIC_LIMITS.fade_out_sec.min, CLOSING_MUSIC_LIMITS.fade_out_sec.max, CLOSING_MUSIC_DEFAULTS.fade_out_sec),
  }
}

/** What a preset stores. Nothing here names an episode, so nothing is dropped. */
export function snapshotClosingMusic(source: Partial<ClosingMusicState> | null | undefined): ClosingMusicState {
  return normalizeClosingMusic(source)
}

/** Apply a saved preset's closing music onto the live state, replacing it whole. */
export function applyClosingMusicPreset(
  target: ClosingMusicState,
  data: Partial<ClosingMusicState> | null | undefined,
): void {
  Object.assign(target, normalizeClosingMusic(data))
}

/** Title-image timing is reusable; the selected image belongs to one episode. */
export function snapshotTitleImagePreset(source: TitleImageState): TitleImagePresetData {
  return {
    enabled: source.enabled,
    duration: source.duration,
    transition_type: source.transition_type,
    transition_duration: source.transition_duration,
  }
}

/** Apply reusable settings without ever restoring a legacy episode image path. */
export function applyTitleImagePreset(
  target: TitleImageState,
  data: Partial<TitleImageState> | null | undefined,
): void {
  if (!data) return
  if (typeof data.enabled === 'boolean') target.enabled = data.enabled
  if (typeof data.duration === 'number') target.duration = data.duration
  if (typeof data.transition_type === 'string') target.transition_type = data.transition_type
  if (typeof data.transition_duration === 'number') target.transition_duration = data.transition_duration
}
