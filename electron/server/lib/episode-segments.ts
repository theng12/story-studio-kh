/**
 * Episode segments — generated narration that attaches to an episode at a
 * POSITION, rather than being "the Introduction" specifically.
 *
 * v1.4.73. Until now an opening existed only if a checkbox on the Script
 * page's Outline tab happened to be ticked during that session. Nothing
 * anywhere recorded "this channel opens with a host", so the answer was
 * re-invented on every page load, and a watcher forced it back off whenever
 * the page reloaded its context. Intent now lives in exactly one place: the
 * channel's own settings, read by every path that produces an episode.
 *
 * WHY A SEGMENT AND NOT AN "INTRODUCTION":
 * An opening is one instance of a general class — a generated piece of
 * narration with a recipe of its own that sits at a known place relative to
 * the chapter body. A sponsorship read and a sign-off are the same shape at
 * different positions. The shape is built here so those can be added later
 * without reshaping anything; only the Introduction is implemented, and
 * nothing else should be added until it is actually wanted.
 *
 * That generality is not speculative decoration — it removes a real
 * hardcode. The audio merge used to decide what plays first by testing
 * whether a filename contained the letters "intro"; it now asks this module
 * for the position of whatever segment a filename belongs to.
 */

/** Registered kinds of segment. Only the Introduction exists today. */
export interface SegmentKind {
  id: string
  /** What a person calls it. */
  label: string
  /**
   * Sort key against the chapter body, which occupies 1…n. Negative sorts
   * before chapter one, a value above the chapter count sorts after the last
   * chapter. This is structural rather than a preference — an opening opens —
   * so it lives here rather than in the channel's saved settings.
   */
  position: number
  /** The `{code}_{stem}` filename this segment's artifacts carry. */
  filenameStem: string
  /**
   * Other spellings the same segment's files have been written under. The
   * merge used to accept any filename containing the letters "intro", so a
   * short form has to keep working or a real episode's running order changes
   * the day this ships.
   */
  filenameAliases?: string[]
  /** Sentence shown on the segment's page when the channel has said nothing. */
  description: string
}

export const SEGMENT_KINDS: Record<string, SegmentKind> = {
  introduction: {
    id: 'introduction',
    label: 'Introduction',
    position: -1,
    filenameStem: 'Introduction',
    filenameAliases: ['Intro'],
    description: 'A spoken opening before the story begins — a greeting, what tonight holds, '
      + 'and whatever else this channel says every time.',
  },
}

export const INTRODUCTION_SEGMENT_ID = 'introduction'

/** One beat of a segment: an ordered thing the opening has to cover. */
export interface SegmentBeat {
  id: string
  label: string
  enabled: boolean
  /** Extra wording for this beat. Blank = write from the label alone. */
  custom_text?: string
}

/** Everything about HOW a segment is written. All of it is the owner's. */
export interface SegmentRecipe {
  /** Blank = the model omits a host name, which is the older behaviour. */
  host_name: string
  word_target: number
  custom_opening_line: string
  beats: SegmentBeat[]
}

/** What a channel has decided about one segment. */
export interface ChannelSegment {
  enabled: boolean
  recipe: SegmentRecipe
  /**
   * Set when `enabled` was inferred from existing episodes at upgrade time
   * rather than chosen. Never gates generation — intent is intent — but the
   * page says so, and asks, until it is confirmed.
   */
  inferred_at?: string
}

export type ChannelSegments = Record<string, ChannelSegment>

export const WORD_TARGET_MIN = 100
export const WORD_TARGET_MAX = 600
export const WORD_TARGET_DEFAULT = 350

/**
 * The beats an opening covers when the channel has not said otherwise.
 *
 * This is the list the Script page has shown since v1.0.71, kept identical so
 * an existing channel's opening does not change shape the day it gains a page.
 * The backend's own fallback had drifted to a six-item list missing the
 * membership beat; both now read from here, so they cannot disagree again.
 */
export const DEFAULT_INTRODUCTION_BEATS: ReadonlyArray<SegmentBeat> = Object.freeze([
  { id: 'welcome', label: 'Welcome & host intro', enabled: true },
  { id: 'story_teaser', label: 'Story teaser', enabled: true },
  { id: 'community_question', label: 'Community question', enabled: true },
  { id: 'patreon', label: 'Patreon / membership mention', enabled: false },
  { id: 'subscribe_cta', label: 'Subscribe CTA', enabled: true },
  { id: 'relaxation', label: 'Relaxation / breathing exercise', enabled: true },
  { id: 'transition', label: 'Transition into story', enabled: true },
])

/** Defaults a format ships for its openings, if it ships any. */
export interface FormatIntroDefaults {
  wordTarget?: number
  beats?: string[]
}

function cloneDefaultBeats(): SegmentBeat[] {
  return DEFAULT_INTRODUCTION_BEATS.map(beat => ({ ...beat }))
}

function clampWordTarget(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(WORD_TARGET_MAX, Math.max(WORD_TARGET_MIN, Math.round(n)))
}

/**
 * The recipe a channel starts from.
 *
 * A format may ship its own opening shape (a listicle channel wants fifty
 * words and no breathing exercise); otherwise the long-form default above
 * applies. A niche's `openingProfile` is deliberately NOT consulted here: it
 * carries only a label and a description, never a recipe, and it used to act
 * as a permission slip that hid this whole feature from twenty of the
 * twenty-one niches. It is now used for wording on the page and nothing else.
 */
export function defaultSegmentRecipe(
  segmentId: string,
  formatIntroDefaults?: FormatIntroDefaults | null,
): SegmentRecipe {
  const beats = (segmentId === INTRODUCTION_SEGMENT_ID && formatIntroDefaults?.beats?.length)
    ? formatIntroDefaults.beats.map((label, i) => ({ id: `fmt-${i}`, label: String(label), enabled: true }))
    : cloneDefaultBeats()
  return {
    host_name: '',
    word_target: clampWordTarget(formatIntroDefaults?.wordTarget, WORD_TARGET_DEFAULT),
    custom_opening_line: '',
    beats,
  }
}

function normalizeBeats(raw: unknown, fallback: SegmentBeat[]): SegmentBeat[] {
  if (!Array.isArray(raw)) return fallback
  const beats = raw
    .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
    .map((b, i) => ({
      id: typeof b.id === 'string' && b.id.trim() ? b.id.trim() : `beat-${i}`,
      label: typeof b.label === 'string' ? b.label : '',
      enabled: b.enabled !== false,
      ...(typeof b.custom_text === 'string' && b.custom_text.trim()
        ? { custom_text: b.custom_text }
        : {}),
    }))
    .filter(b => b.label.trim().length > 0)
  return beats.length ? beats : fallback
}

/**
 * Read a channel's saved segments back into a shape the app can rely on.
 *
 * Everything is optional on disk and everything has an answer here, so a
 * config written by an older build, a hand-edited file, or a channel that has
 * never opened the page all produce the same well-formed result. A channel
 * that has said nothing gets `enabled: false` — silence is not consent to
 * spend, and the migration that infers otherwise does so from evidence.
 */
export function normalizeChannelSegments(
  raw: unknown,
  formatIntroDefaults?: FormatIntroDefaults | null,
): ChannelSegments {
  const source = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? raw as Record<string, unknown>
    : {}
  const out: ChannelSegments = {}
  for (const kind of Object.values(SEGMENT_KINDS)) {
    const stored = (source[kind.id] && typeof source[kind.id] === 'object')
      ? source[kind.id] as Record<string, unknown>
      : {}
    const defaults = defaultSegmentRecipe(kind.id, formatIntroDefaults)
    const recipe = (stored.recipe && typeof stored.recipe === 'object')
      ? stored.recipe as Record<string, unknown>
      : {}
    out[kind.id] = {
      enabled: stored.enabled === true,
      recipe: {
        host_name: typeof recipe.host_name === 'string' ? recipe.host_name : defaults.host_name,
        word_target: clampWordTarget(recipe.word_target, defaults.word_target),
        custom_opening_line: typeof recipe.custom_opening_line === 'string'
          ? recipe.custom_opening_line
          : defaults.custom_opening_line,
        beats: normalizeBeats(recipe.beats, defaults.beats),
      },
      ...(typeof stored.inferred_at === 'string' && stored.inferred_at
        ? { inferred_at: stored.inferred_at }
        : {}),
    }
  }
  return out
}

/** Does this channel want an opening on every episode it produces? */
export function channelWantsSegment(segments: ChannelSegments, segmentId: string): boolean {
  return segments[segmentId]?.enabled === true
}

/**
 * The beat lines handed to the language model.
 *
 * A beat with extra wording becomes "Label — specifically cover: …", which is
 * the phrasing the prompt loop has always received. Flattening happens HERE,
 * once, so an opening written from the Introduction page, from an unattended
 * batch, or from a direct API call is written from identical instructions.
 */
export function beatLinesForPrompt(recipe: SegmentRecipe): string[] {
  return recipe.beats
    .filter(beat => beat.enabled)
    .map(beat => {
      const extra = (beat.custom_text || '').trim()
      return extra ? `${beat.label} — specifically cover: ${extra}` : beat.label
    })
}

/**
 * Where a narration or audio file sits in an episode's running order.
 *
 * Replaces the old rule "a filename containing the letters `intro` plays
 * first", which was the only notion of placement the merge had. Chapters
 * occupy 1…n by their own number; a registered segment gets its kind's
 * position; anything unrecognised sorts after the chapters rather than
 * silently jumping to the front.
 */
export function segmentPositionForFilename(filename: string): number | null {
  for (const kind of Object.values(SEGMENT_KINDS)) {
    for (const spelling of [kind.filenameStem, ...(kind.filenameAliases || [])]) {
      const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(?:^|[_\\s-])${escaped}`, 'i').test(filename)) return kind.position
    }
  }
  return null
}
