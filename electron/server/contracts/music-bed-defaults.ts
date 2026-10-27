/**
 * The background-music bed's starting level, and the owner's minimum for a channel's music
 * choices. ONE definition of each, shared across the boundary: the generator that mixes the bed,
 * the Audio Assembly form and the Music Pool panel all read the same constant, because a copy in
 * each of them is how they drift apart.
 *
 * Owner, 2026-10-26 (after DM0018's Khmer narration was buried and PR0039's bed was too loud at
 * the old 8%): 6% is the STARTING level — about 24 dB under the voice. It applies to a request
 * that states NO level and to nothing else. A page value, a saved preset, a remembered form and a
 * pool track's own override are the customer's own choice and pass through untouched (AGENTS.md
 * §5). A channel whose Series Formula names its own starting level (Quote Shorts: prominent music
 * at 55%) keeps it — that is a deliberate channel-type choice, not a stale default.
 */
export const DEFAULT_BACKGROUND_MUSIC_VOLUME_PERCENT = 6

/** The same level in the unit the generator speaks: LINEAR GAIN (`1` = unchanged). */
export const DEFAULT_BACKGROUND_MUSIC_VOLUME = DEFAULT_BACKGROUND_MUSIC_VOLUME_PERCENT / 100

/**
 * Owner, 2026-10-27: a regular narrated channel has background music under the narration, and at
 * least ten tracks to choose from. A STANDARD to show, never a gate — assembly is never refused
 * for falling short of it (AGENTS.md §8: only explicit configuration skips a step).
 */
export const MIN_CHANNEL_MUSIC_OPTIONS = 10

/**
 * How many background-music options a channel has. A typed measurement, never a bare number:
 * `{ measured: false }` means the count could not be worked out, and that must never be shown as
 * 0 (AGENTS.md §6 — "no tracks" and "the folder could not be read" are different answers).
 *
 * `usable` counts every file the channel may use: the Music Pool folder (`music/`) plus its own
 * Music Library songs not yet copied into the pool (the panel offers those in one click).
 * `enabled` is the subset of POOL tracks the cycler may draw automatically; a switched-off track
 * is still an option a person can choose by hand, which is why both are carried.
 */
export type MusicOptionsMeasurement =
  | { measured: true; usable: number; enabled: number; from_library: number }
  | { measured: false; reason: string }

export interface MusicOptionsNotice {
  /** `ok` = meets the standard, `warn` = below it, `unknown` = could not be measured. */
  level: 'ok' | 'warn' | 'unknown'
  text: string
}

/**
 * The one wording for the standard, so the page, a test and any future caller cannot say it three
 * different ways. Only the count is spoken here — the "assembly still works" reassurance belongs
 * beside the button this text sits over, not in a string a caller cannot reword.
 */
export function musicOptionsNotice(m: MusicOptionsMeasurement): MusicOptionsNotice {
  // `in` rather than `!m.measured`: the frontend's tsconfig does not narrow a
  // `false` discriminant, and this module is imported by the page too.
  if ('reason' in m) {
    return {
      level: 'unknown',
      text: `This channel's background music options could not be counted (${m.reason}).`,
    }
  }
  const { usable, enabled, from_library } = m
  const libraryNote = from_library ? ` (${from_library} of them from your Music Library, not yet in the pool)` : ''
  // Rotation is a second, different fact: how many the CYCLER may draw without
  // anyone choosing. Saying only "12 options" while the pool holds none would be
  // true and useless — a merge would simply get no music.
  const rotation = enabled >= usable || enabled >= MIN_CHANNEL_MUSIC_OPTIONS
    ? ''
    : enabled === 0
      ? ' None of them is in the Music Pool yet, so nothing is rotating automatically.'
      : ` Only ${enabled} of them ${enabled === 1 ? 'is' : 'are'} switched on for automatic rotation.`
  if (usable >= MIN_CHANNEL_MUSIC_OPTIONS) {
    return { level: 'ok', text: `${usable} background music options for this channel.${libraryNote}${rotation}` }
  }
  const options = `${usable} background music option${usable === 1 ? '' : 's'}`
  return {
    level: 'warn',
    text: `This channel has ${options}; the standard is at least ${MIN_CHANNEL_MUSIC_OPTIONS}.${libraryNote}${rotation}`,
  }
}
