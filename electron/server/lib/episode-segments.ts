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
 * Not because a second one is nearly free — it is not, see below — but
 * because naming the class removed a real hardcode. The audio merge used to
 * decide what plays first by testing whether a filename contained the letters
 * "intro"; it now asks this module for the position of whatever segment a
 * filename belongs to. That is the whole of what this generality buys.
 *
 * WHAT A SECOND SEGMENT ACTUALLY COSTS — measured 2026-08-27.
 *
 * An earlier version of this comment said the shape was built "so those can be
 * added later without reshaping anything". That was not true, and an untrue
 * comment is worse than no comment: it invites somebody to promise a
 * sponsorship read in an afternoon. Registering a second kind in
 * `SEGMENT_KINDS` gets it a position and a filename. Everything below is
 * still outstanding, per item, for each new segment:
 *
 *   1. A page of its own under `frontend/pages/projects/[slug]/`, with its own
 *      recipe form. The Introduction page is ~600 lines and is not generic.
 *   2. A sidebar stage entry, and the visibility rules that go with it.
 *   3. A `BatchStep` id, plus its tile, chain position and gating in
 *      `pipeline.vue` and `routes/pipeline.ts` (both `NO_PRESET_STEPS` and the
 *      per-format CHAIN_* arrays).
 *   4. A job type and an executor branch in the job runner.
 *   5. A prompt builder. `generateIntroductionOnly()` in `generators/episode.ts`
 *      is named for the Introduction and is written around it.
 *   6. An asset-status marker and its filename matcher, alongside
 *      `isIntroductionMarker()` in `services/asset-status.ts`, plus the
 *      episode-status field the Production Board reads.
 *   7. An auto-add rule, so the step follows the channel setting rather than a
 *      tick-box — `syncDerivedSteps()` in `pipeline.vue`.
 *   8. A branch in `hasEverProducedSegment()` in
 *      `services/channel-segments.ts`, which today returns `false` for
 *      anything that is not the Introduction, so a second segment could never
 *      infer its own setting from existing episodes.
 *   9. Beats for it in `BEAT_LIBRARY`, and a default set per Formula in
 *      `electron/server/niches/*.json` — 22 files.
 *
 * None of that is hard. It is simply not free, and nobody has asked for it.
 * Add nothing here until somebody does.
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
  /**
   * The language model that writes this segment.
   *
   * BLANK IS A REAL VALUE and it is the default: it means "whatever the Script
   * Generator is set to", which is what every existing channel already gets.
   * So a channel that has never opened the picker keeps the behaviour it has
   * today, and nothing here can quietly switch a channel onto a product its
   * owner never chose.
   *
   * v1.4.73 shipped with no picker at all, reasoning that one language-model
   * choice was easier to trust than two that could disagree. The owner's
   * answer to that was: "what is the model picker not added. i don't care if
   * it's the same model or a different model writing it." The choice is his,
   * so the choice exists; the shared default is what keeps it from becoming a
   * second setting nobody set.
   */
  model: string
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

/**
 * The floor was 100 until v1.4.74, which quietly refused a shape the app
 * already documented: `introDefaults` has said "listicle ~50" since v1.0.71,
 * and `clampWordTarget` silently doubled it. A greeting-and-go opening on a
 * short explainer is a real want, not a mistake to be corrected, so the floor
 * now admits it. 50 words is about twenty seconds read aloud.
 */
export const WORD_TARGET_MIN = 50
export const WORD_TARGET_MAX = 600
export const WORD_TARGET_DEFAULT = 350

/**
 * What every known beat actually produces, in words.
 *
 * The page used to draw seven labels and explain none of them. "Community
 * question" is not self-explanatory to somebody who has never run a channel,
 * and a control nobody understands is a control nobody uses — the same failure
 * as hiding it, arrived at differently.
 *
 * The explanation lives HERE rather than in the page, for three reasons. It is
 * one copy, so the page and any future segment page cannot drift apart. It is
 * not written into every channel's saved settings, so improving a sentence
 * improves it everywhere instead of only for channels created afterwards. And
 * it survives a beat being removed and added back: the page restores the beat
 * BY ID from this catalogue, so its explanation comes back with it.
 *
 * `example` is what the per-beat wording box offers as a placeholder — a
 * concrete illustration of the kind of thing to type there.
 *
 * `defaultFor` is the note attached to a beat that is not general-purpose.
 * It is deliberately descriptive rather than enforcing: nothing here decides
 * what a channel may use. See the Introduction redo proposal for where
 * format-supplied beat sets belong.
 */
export interface BeatDefinition {
  id: string
  label: string
  /** What this beat writes, said plainly. Rendered under the label. */
  description: string
  /** Placeholder for this beat's own wording box. */
  example: string
  /** Present when the beat suits one kind of channel rather than all of them. */
  suitsNote?: string
}

export const BEAT_LIBRARY: Record<string, BeatDefinition> = {
  welcome: {
    id: 'welcome',
    label: 'Welcome & host intro',
    description: 'The host says hello and gives their name, so a listener knows who is talking '
      + 'before the story starts. Leave the host name blank above and this becomes a greeting '
      + 'with no name in it.',
    example: 'greet the audience warmly and introduce yourself by name',
  },
  story_teaser: {
    id: 'story_teaser',
    label: 'Story teaser',
    description: 'A sentence or two about where this episode goes, without giving away how it '
      + 'ends. It is written from this episode\u2019s own chapters, so it is different every time.',
    example: 'hint at tonight\u2019s setting without spoiling the ending',
  },
  community_question: {
    id: 'community_question',
    label: 'Community question',
    description: 'A question put to the audience to answer in the comments. Its job is to get '
      + 'comments \u2014 that is the signal YouTube reads as an engaged audience.',
    example: 'ask listeners to share their favourite winter comfort food',
  },
  patreon: {
    id: 'patreon',
    label: 'Patreon / membership mention',
    description: 'A short mention of a paid membership and what somebody gets for joining. '
      + 'Off unless this channel actually has one \u2014 an opening that offers a membership '
      + 'that does not exist reads as a mistake.',
    example: 'mention what the membership tier includes',
  },
  subscribe_cta: {
    id: 'subscribe_cta',
    label: 'Subscribe CTA',
    description: 'The ask to subscribe. One line in the host\u2019s own voice rather than a '
      + 'read-out advert, so it does not break the tone of what follows.',
    example: 'invite viewers to subscribe if they want more of these',
  },
  relaxation: {
    id: 'relaxation',
    label: 'Relaxation / breathing exercise',
    description: 'The host leads a few slow breaths before the story begins, to settle a '
      + 'listener who is going to sleep to it.',
    suitsNote: 'Suits sleep and calm channels. On an explainer, history or business channel '
      + 'it will sound out of place \u2014 switch it off.',
    example: 'lead three slow breaths before the story starts',
  },
  transition: {
    id: 'transition',
    label: 'Transition into story',
    description: 'The handover line that ends the opening and hands over to chapter one, so '
      + 'the two do not collide mid-sentence.',
    example: 'invite them to close their eyes as the story begins',
  },

  // ── Beats added in v1.4.74, when openings stopped being sleep-shaped ─────
  //
  // The seven above were authored for one kind of channel and then handed to
  // every kind. These are the beats the other twenty-one Formulas actually
  // open with. They are in the same catalogue rather than in the Formulas
  // because a beat's explanation must not be written twice: a channel is free
  // to switch any of them on, whatever Formula it runs.
  hook: {
    id: 'hook',
    label: 'Cold-open hook',
    description: 'One arresting line before anything else \u2014 the question this episode '
      + 'answers, or the single fact that makes it worth staying for. It runs before any '
      + 'greeting, because a greeting is not a reason to keep watching.',
    suitsNote: 'Suits explainer, documentary and essay channels. On a sleep, prayer or '
      + 'meditation channel it works against the calm \u2014 switch it off.',
    example: 'open on the strangest single fact in this episode',
  },
  what_youll_learn: {
    id: 'what_youll_learn',
    label: 'What this episode answers',
    description: 'Names the question the episode settles, so a listener knows in the first '
      + 'half-minute whether this one is for them. It is a promise, not a summary \u2014 it '
      + 'says what they will know by the end, not what happens in between.',
    example: 'say plainly what question this episode answers',
  },
  why_it_matters: {
    id: 'why_it_matters',
    label: 'Why it matters',
    description: 'A line on why the subject is worth the time \u2014 the stakes, the '
      + 'consequence, or what changes once the listener understands it.',
    example: 'say what changes once you understand this',
  },
  episode_roadmap: {
    id: 'episode_roadmap',
    label: 'How the episode runs',
    description: 'The shape the listener is settling into \u2014 a countdown of ten, three '
      + 'parts, a journey from one place to another. Told once, up front, so nobody spends '
      + 'the episode wondering how long the current bit lasts.',
    example: 'we are counting down ten, from the least to the most unsettling',
  },
  evidence_note: {
    id: 'evidence_note',
    label: 'Where the evidence comes from',
    description: 'A short, honest word on how we know \u2014 what is documented, what is '
      + 'inferred, and where the record runs thin. It buys the trust the rest of the episode '
      + 'spends.',
    suitsNote: 'Suits history, science and documentary channels, where being believed is '
      + 'the whole product.',
    example: 'name the kind of evidence this rests on, and where it is thin',
  },
  scripture_reading: {
    id: 'scripture_reading',
    label: 'Read the passage',
    description: 'The passage is spoken aloud before anything is said about it, so the '
      + 'listener hears the text itself before they hear anyone\u2019s reading of it.',
    suitsNote: 'Suits devotional and expository preaching channels.',
    example: 'read the passage slowly, then leave a beat of silence',
  },
  invitation_to_pray: {
    id: 'invitation_to_pray',
    label: 'Invitation to pray',
    description: 'Invites the listener to stop what they are doing and pray along, rather '
      + 'than sit and listen to somebody else praying.',
    suitsNote: 'Suits prayer and devotional channels.',
    example: 'invite them to stop, wherever they are, and pray along',
  },
  settle_in: {
    id: 'settle_in',
    label: 'Settle in',
    description: 'Asks the listener to get comfortable and give the next while their '
      + 'attention. A softer thing than a breathing exercise \u2014 it suits a channel that '
      + 'is calm without being a sleep aid.',
    example: 'invite them to get comfortable and let the next hour be slow',
  },
  practice_frame: {
    id: 'practice_frame',
    label: 'What this practice is',
    description: 'Names the practice and how long it takes, so the listener knows what they '
      + 'have agreed to before it starts.',
    suitsNote: 'Suits guided-meditation and mindfulness channels.',
    example: 'this is a five-minute body scan, sitting or lying down',
  },
  not_advice_note: {
    id: 'not_advice_note',
    label: 'This is not professional advice',
    description: 'One unfussy sentence saying this is an explanation rather than medical, '
      + 'legal or financial advice. Said once, early, and never laboured.',
    suitsNote: 'Suits psychology, money and business channels.',
    example: 'note that this explains how it works and is not financial advice',
  },
  personal_check_in: {
    id: 'personal_check_in',
    label: 'Where the host is right now',
    description: 'The host says, briefly and honestly, what prompted this episode \u2014 the '
      + 'thing that happened this week, the question somebody asked. It is what makes a '
      + 'first-person channel feel like a person rather than a script.',
    suitsNote: 'Suits first-person, motivation and POV channels.',
    example: 'say what happened this week that made you want to talk about this',
  },
  premise_setup: {
    id: 'premise_setup',
    label: 'Set the premise',
    description: 'Puts the listener inside the episode\u2019s premise \u2014 who they are '
      + 'about to be, where they are standing, or which creature is about to have a very bad '
      + 'time. It names the subject and the frame in one move.',
    suitsNote: 'Suits second-person, POV and single-subject profile channels.',
    example: 'tell them who they are about to be, and when',
  },
  listening_note: {
    id: 'listening_note',
    label: 'How to listen',
    description: 'A practical note on how this is best listened to \u2014 headphones, in the '
      + 'background, over several hours, or that this is the last talking there will be.',
    example: 'say this is the last you will hear a voice, and the rest is music',
  },
  question_to_sit_with: {
    id: 'question_to_sit_with',
    label: 'The question to sit with',
    description: 'Poses the question the episode circles and deliberately does not answer '
      + 'it. The listener carries it through everything that follows.',
    suitsNote: 'Suits philosophy and essay channels.',
    example: 'pose the question the episode circles, and leave it open',
  },
}

/**
 * The beats an opening covers when the channel has not said otherwise.
 *
 * This is the list the Script page has shown since v1.0.71, kept identical so
 * an existing channel's opening does not change shape the day it gains a page.
 * The backend's own fallback had drifted to a six-item list missing the
 * membership beat; both now read from here, so they cannot disagree again.
 *
 * Built from `BEAT_LIBRARY` so a label can never be spelt two ways.
 *
 * RESOLVED in v1.4.74. This list used to be what EVERY channel got, and it is
 * sleep-shaped — `relaxation` in front of a business explainer. The mechanism
 * meant to fix that was unreachable: `canonicalFormatId()` folds every channel
 * onto one format, and that format ships no `introDefaults`, so the branch
 * that would have overridden this never ran. The fix did not go through the
 * format at all. Every built-in Formula now ships its own opening in
 * `electron/server/niches/*.json`, and `applyNicheToFormat()` carries it onto
 * `format.script.introDefaults` — the same bridge that has always carried the
 * Formula's script role, closing hint and chapter counts.
 *
 * So this list is now a genuine last resort: it applies to a channel with no
 * Formula at all, and to nothing else. It is still kept identical to what the
 * Script page has shown since v1.0.71, because a channel that lands here is
 * one nothing else has an opinion about, and changing its opening under it
 * would be a change nobody asked for.
 */
const DEFAULT_BEAT_STATE: ReadonlyArray<readonly [string, boolean]> = Object.freeze([
  ['welcome', true],
  ['story_teaser', true],
  ['community_question', true],
  ['patreon', false],
  ['subscribe_cta', true],
  ['relaxation', true],
  ['transition', true],
])

export const DEFAULT_INTRODUCTION_BEATS: ReadonlyArray<SegmentBeat> = Object.freeze(
  DEFAULT_BEAT_STATE.map(([id, enabled]) => Object.freeze({
    id,
    label: BEAT_LIBRARY[id].label,
    enabled,
  })),
) as ReadonlyArray<SegmentBeat>

/**
 * One beat as a Formula declares it.
 *
 * A bare string is either a catalogue id (`'hook'`) or, for anything the
 * catalogue has no name for, the beat's own label. The object form is how a
 * Formula says a beat in its own voice: `custom_text` becomes the
 * "specifically cover: …" half of the prompt line, which is what stops
 * twenty-two channels opening with the same seven labels in a new order.
 */
export type FormatIntroBeat = string | { id: string; custom_text?: string }

/** Defaults a Formula ships for its openings, if it ships any. */
export interface FormatIntroDefaults {
  wordTarget?: number
  beats?: FormatIntroBeat[]
  /** Style anchor baked into the prompt. See `ScriptFormat.introDefaults`. */
  exampleText?: string
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
 * One declared beat, resolved into the beat the app actually uses.
 *
 * A catalogue id wins: the beat comes back with the catalogue's label AND its
 * explanation, so a Formula-supplied opening is as self-describing on the page
 * as a hand-built one. Anything the catalogue does not know keeps the older
 * behaviour — the string is the label — so a Formula or a format may
 * still write a beat nothing else has a name for.
 */
function resolveDeclaredBeat(declared: FormatIntroBeat, index: number): SegmentBeat {
  const id = typeof declared === 'string' ? declared : String(declared?.id ?? '')
  const custom = typeof declared === 'object' && declared
    ? (declared.custom_text || '').trim()
    : ''
  const known = BEAT_LIBRARY[id]
  return {
    id: known ? known.id : `fmt-${index}`,
    label: known ? known.label : id,
    enabled: true,
    ...(custom ? { custom_text: custom } : {}),
  }
}

/**
 * The recipe a channel starts from.
 *
 * A Formula ships its own opening shape — a listicle channel wants fifty
 * words and no breathing exercise, a prayer channel opens by inviting somebody
 * to pray — and it reaches here as `format.script.introDefaults`, which
 * `applyNicheToFormat()` copies off the Formula. The seven-beat default below
 * is what a channel gets when its Formula says nothing, which since v1.4.74 is
 * no built-in Formula at all.
 *
 * A niche's `openingProfile` is deliberately NOT consulted here: it carries a
 * label and a description, never a recipe, and it used to act as a permission
 * slip that hid this whole feature from twenty of the twenty-one Formulas. It
 * is used for wording on the page and nothing else.
 */
export function defaultSegmentRecipe(
  segmentId: string,
  formatIntroDefaults?: FormatIntroDefaults | null,
): SegmentRecipe {
  const beats = (segmentId === INTRODUCTION_SEGMENT_ID && formatIntroDefaults?.beats?.length)
    ? formatIntroDefaults.beats.map(resolveDeclaredBeat)
    : cloneDefaultBeats()
  return {
    host_name: '',
    word_target: clampWordTarget(formatIntroDefaults?.wordTarget, WORD_TARGET_DEFAULT),
    custom_opening_line: '',
    beats,
    // Blank on purpose: follow the Script Generator until somebody says otherwise.
    model: '',
  }
}

function normalizeBeats(raw: unknown, fallback: SegmentBeat[]): SegmentBeat[] {
  if (!Array.isArray(raw)) return fallback
  const beats = raw
    .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
    .map((b, i) => {
      const id = typeof b.id === 'string' && b.id.trim() ? b.id.trim() : `beat-${i}`
      // A beat from the catalogue is named by the catalogue, whatever spelling
      // an older config, a hand edit or a saved preset happens to carry. There
      // is one name for "Subscribe CTA" and this is where it comes from.
      const known = BEAT_LIBRARY[id]
      return {
        id,
        label: known ? known.label : (typeof b.label === 'string' ? b.label : ''),
        enabled: b.enabled !== false,
        ...(typeof b.custom_text === 'string' && b.custom_text.trim()
          ? { custom_text: b.custom_text }
          : {}),
      }
    })
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
        model: typeof recipe.model === 'string' ? recipe.model.trim() : defaults.model,
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
 * The comparable SHAPE of an opening: its length and its ordered beats.
 *
 * Deliberately excludes `host_name`, `custom_opening_line` and `model`. Those
 * are a channel's own particulars — a host has a name whatever Formula the
 * channel runs — and counting them would make "has this been edited?"
 * answer yes for somebody who only typed their name in.
 */
function openingShape(recipe: SegmentRecipe): string {
  return JSON.stringify([
    recipe.word_target,
    recipe.beats.map(b => [b.id, b.enabled !== false, (b.custom_text || '').trim()]),
  ])
}

/** Are these two openings the same shape? */
export function sameOpeningShape(a: SegmentRecipe, b: SegmentRecipe): boolean {
  return openingShape(a) === openingShape(b)
}

/**
 * Is this channel still following the opening its Formula ships, or has
 * somebody edited it?
 *
 * Derived by comparison rather than recorded in the channel's settings, and
 * that is the point: a stored "this is the default" flag goes stale the moment
 * the Formula's opening is improved, and then says the wrong thing forever.
 * Comparing cannot go stale.
 */
export function followsFormulaOpening(
  recipe: SegmentRecipe,
  formatIntroDefaults?: FormatIntroDefaults | null,
): boolean {
  return sameOpeningShape(recipe, defaultSegmentRecipe(INTRODUCTION_SEGMENT_ID, formatIntroDefaults))
}

/**
 * Is this the seven-beat opening every channel was given before v1.4.74?
 *
 * Every channel that predates Formula-supplied openings carries this exact
 * shape, whatever kind of channel it is, because it was the only shape there
 * was. A channel still carrying it has not chosen it — it was never asked
 * — so it is safe to re-seed from its Formula. A channel carrying anything
 * else has been edited, and is left alone.
 *
 * The one channel this reads wrongly is one whose owner deliberately built,
 * beat for beat, the same opening it already had. It is re-seeded, and the
 * page tells it so; the alternative is leaving every un-asked channel with a
 * breathing exercise in front of a business explainer.
 */
export function matchesLegacyDefaultOpening(recipe: SegmentRecipe): boolean {
  return sameOpeningShape(recipe, defaultSegmentRecipe(INTRODUCTION_SEGMENT_ID, null))
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
