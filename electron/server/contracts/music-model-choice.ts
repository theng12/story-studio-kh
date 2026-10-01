/**
 * Which music model a request names when it names none.
 *
 * The Music page sends no model id, so the backend and the page both fall back to "the first
 * published row" — and the page prints that row's price beside its name. The gateway's Hub rows
 * come in catalogue order, and the first of them is YuE2, which *sings*: its lane states
 * `lyrics` required and "no instrumental switch", and the Hub refuses a request without lyrics.
 * Story's top-up sends `instrumental: true` and no lyrics, so taking `models[0]` blindly made
 * every default top-up a certain refusal at the Hub (found tracing the seam, 2026-10-01).
 *
 * The fields read here (`requires_lyrics`, `supports_instrumental`) are the ones the gateway
 * publishes from the lane's own contract; an absent field means "not stated" and never rules a
 * model out. This is the one function the page and the generator both call, so the model priced
 * on screen is the model that is charged.
 */
export interface MusicModelCapability {
  requires_lyrics?: boolean | null
  supports_instrumental?: boolean | null
  supports_vocals?: boolean | null
  min_duration_seconds?: number
  max_duration_seconds?: number
  default_duration_seconds?: number
}

export interface MusicRequestNeeds {
  /** The request asks for an instrumental track. */
  instrumental: boolean
  /** The request carries a lyric sheet. */
  hasLyrics: boolean
}

export function musicModelCanServe(model: MusicModelCapability, needs: MusicRequestNeeds): boolean {
  if (model.requires_lyrics === true && !needs.hasLyrics) return false
  if (needs.instrumental && !needs.hasLyrics && model.supports_instrumental === false) return false
  return true
}

/**
 * The first published model that can serve the request, or `undefined` when none can.
 *
 * A request for vocals prefers a model that sings (it states vocals or requires lyrics); the
 * caller supplies the lyrics, so `hasLyrics` is true on that path.
 */
export function pickDefaultMusicModel<T extends { id?: string } & MusicModelCapability>(
  models: readonly T[], needs: MusicRequestNeeds,
): T | undefined {
  const servable = models.filter(model => musicModelCanServe(model, needs))
  if (!needs.instrumental) {
    const singer = servable.find(model => model.supports_vocals === true || model.requires_lyrics === true)
    if (singer) return singer
  }
  return servable[0]
}

/** Track length Story asks an instrumental model for unless the owner says otherwise. */
export const DEFAULT_INSTRUMENTAL_TRACK_SECONDS = 240

/**
 * Seconds of song YuE2 needs per lyric section.
 *
 * YuE's own convention is one ~30 s segment per section. Measured on this fleet's qualification
 * runs (`qualification/yue2-music-results-20260927`): the 4-line, 2-section sheet filled its
 * 600-token (24.0 s) budget exactly and the 20-line, 5-section sheet was still singing when its
 * 3000-token (120.0 s) budget ran out (`truncated.semantic: true`) — so five sections need more
 * than 120 s, i.e. at least ~24 s each, and 30 s each is the stated convention.
 */
export const YUE2_SECONDS_PER_SECTION = 30

/** Sections in a lyric sheet: its `[Verse]`-style markers, or a four-line stanza each when it has none. */
export function lyricSectionCount(lyrics: string): number {
  const markers = lyrics.split('\n').filter(line => /^\s*\[[^\]\n]+\]\s*$/.test(line)).length
  if (markers > 0) return markers
  const lines = lyrics.split('\n').filter(line => line.trim().length > 0).length
  return Math.max(1, Math.ceil(lines / 4))
}

export interface MusicDurationPlan {
  seconds: number
  /** Why the length is what it is, when that is not the obvious request. Shown in the job log. */
  note?: string
}

/**
 * How long a track to ask for.
 *
 * A model that sings (`requires_lyrics`) renders what its lyrics need: the Hub converts seconds to
 * a token budget (25 tokens per second) and the song comes back no shorter than half of it and no
 * longer than all of it, so the length follows the sheet — `lyricSectionCount × 30 s`. An
 * instrumental model takes the length asked for (default four minutes). Either way the figure is
 * clamped to the bounds the model publishes, and the log says so when that changed it. The length
 * actually delivered is measured from the saved file, never assumed.
 */
export function musicDurationPlan(
  model: MusicModelCapability & { display_name?: string },
  input: { lyrics?: string; requestedSeconds?: number },
): MusicDurationPlan {
  const name = model.display_name || 'This model'
  const sings = model.requires_lyrics === true
  let seconds: number
  let note: string | undefined
  if (sings) {
    const sections = lyricSectionCount(input.lyrics || '')
    seconds = sections * YUE2_SECONDS_PER_SECTION
    note = `${name} sings its lyrics, so the length follows them: ${sections} section${sections === 1 ? '' : 's'} × ${YUE2_SECONDS_PER_SECTION} s = ${seconds} s requested (it returns between half and all of that).`
  } else {
    seconds = Math.round(input.requestedSeconds && input.requestedSeconds > 0 ? input.requestedSeconds : DEFAULT_INSTRUMENTAL_TRACK_SECONDS)
  }
  const wanted = seconds
  const min = model.min_duration_seconds
  const max = model.max_duration_seconds
  if (typeof max === 'number' && seconds > max) seconds = max
  if (typeof min === 'number' && seconds < min) seconds = min
  if (seconds !== wanted) {
    note = `${name} makes tracks of ${min ?? '?'}–${max ?? '?'} s, so ${wanted} s was set to ${seconds} s.`
  }
  return { seconds, ...(note ? { note } : {}) }
}
