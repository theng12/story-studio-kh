/**
 * Reveal effects — the entrance engine for scene stills.
 *
 * A **reveal** is how a still picture arrives on screen. Today a scene clip
 * either hard-cuts in or cross-dissolves; the only motion available is a camera
 * move applied to the whole clip (`SceneMotionDocument`). A reveal adds the
 * missing half: the picture arrives *in pieces* — a geometric wipe, a stack of
 * palette layers, a drawn-on line — and then **holds** while it drifts, which
 * is what lets one image carry 10–15 s instead of 5 and so cuts the number of
 * images the fleet has to generate.
 *
 * Three families, one engine (`lib/reveal-compiler.ts`):
 *
 * | Family | Input | What it needs |
 * | --- | --- | --- |
 * | `geometric` (default) | any image | nothing |
 * | `palette` | any image; real colour reads best | nothing |
 * | `draw-on` | line art — Story already has that art style | a trace; see the note on the preset |
 *
 * **Everything here renders through FFmpeg's `xfade`**, the same primitive the
 * scene-to-scene transitions already use (`models/transitions.ts`), plus the
 * still-image `zoompan` chain the camera moves already compile
 * (`lib/scene-effect-compiler.ts`). No new binary, no native dependency, and
 * nothing to install: `xfade` is in the FFmpeg Story already bundles.
 *
 * **What is deliberately NOT a field here.** The design lists easing and mask
 * feather. `xfade` transitions are linear and hard-edged by construction, so a
 * document that carried `easing` or `feather_pct` would be offering a control
 * that changes nothing — the same defect as a picked option the renderer
 * discards. A soft-edged mask needs a different primitive (a generated ramp mask
 * plus `maskedmerge`); when that lands it adds the fields, and until then the
 * presets that would want feathering say so in `approximation`.
 */

export const SCENE_REVEAL_SCHEMA_VERSION = 1

/** The three families. One engine, three flavours. */
export const REVEAL_FAMILIES = ['geometric', 'palette', 'draw-on'] as const
export type RevealFamily = (typeof REVEAL_FAMILIES)[number]

/** What the picture comes out of — the state on screen before the reveal. */
export const REVEAL_FIELD_MODES = ['colour', 'image'] as const
export type RevealFieldMode = (typeof REVEAL_FIELD_MODES)[number]

/**
 * What the field does to the source when `mode` is `image`.
 *
 * - `none` — the untouched frame (a "reveal from the same picture" — reads as a
 *   reshape rather than an entrance).
 * - `blur` — a defocused copy, the closest thing to a dissolve that still reads
 *   as an entrance.
 * - `duotone` — the picture flattened onto two colours; the field for the
 *   palette family, where the wipe then *adds* the real colour back.
 * - `darken` — the picture pushed down; the classic "lights come up" entrance.
 */
export const REVEAL_FIELD_TREATMENTS = ['none', 'blur', 'duotone', 'darken'] as const
export type RevealFieldTreatment = (typeof REVEAL_FIELD_TREATMENTS)[number]

/** Where a scene's effect comes from, and how much variety it is allowed. */
export const REVEAL_COHERENCE_MODES = ['scene', 'act', 'episode'] as const
export type RevealCoherence = (typeof REVEAL_COHERENCE_MODES)[number]

export interface SceneRevealField {
  mode: RevealFieldMode
  /** `#rrggbb`. Used when `mode` is `colour`, and as the duotone's dark end. */
  colour: string
  treatment: RevealFieldTreatment
  /** 0–100. Strength of `treatment`; ignored when the treatment is `none`. */
  amount_pct: number
}

/** One palette layer swept away before the picture arrives. */
export interface SceneRevealLayer {
  /** `#rrggbb` — the layer's own colour. */
  colour: string
  /** Registry transition id or supported xfade keyword; the layer's own geometry. */
  transition: string
  /** Share of the reveal window this layer takes, 1–100. Shares are normalised. */
  share_pct: number
}

/**
 * How long the reveal takes.
 *
 * `fit-narration` is the interesting one and the reason the field is a policy
 * rather than a number: the picture should land with the line, not before it.
 * The pacer (`lib/reveal-pacing.ts`) resolves it against the scene's narration
 * window and clamps to `min_seconds`/`max_seconds` — so the *duration* is never
 * randomised (rule 4 of the design), only measured against the script.
 */
export interface SceneRevealTiming {
  mode: 'fixed' | 'fit-narration'
  seconds: number
  min_seconds: number
  max_seconds: number
}

/**
 * The hold: what the picture does after it has arrived.
 *
 * Drift is what separates a hold from a freeze — a frozen frame reads as a
 * slideshow, and 3–8% of continuous movement is the difference. `micro_events`
 * stages extra beats during the hold (a veil of colour sweeping off at a
 * narration line or a music beat), because one wipe plus 8 s of nothing fades
 * from memory after about four.
 */
export interface SceneRevealHold {
  /** 3–8% is the useful band; 0 is a freeze and the contract refuses it. */
  drift_pct: number
  drift_direction: 'in' | 'out'
  /** 0–3 staged events during the hold. */
  micro_events: number
}

export interface SceneRevealSeedPolicy {
  coherence: RevealCoherence
  /** Rule 3: the same effect twice in a row reads as a mistake, not a choice. */
  no_immediate_repeat: boolean
  /** Rule 3: how many times one effect may appear in an episode. 0 = no cap. */
  cap_per_effect: number
}

export interface SceneRevealDocument {
  schema_version: typeof SCENE_REVEAL_SCHEMA_VERSION
  family: RevealFamily
  /** Transition id from `models/transitions.ts`, or a published xfade keyword
   *  (e.g. `diag-tl` or `diagtl`). The compiler resolves either form; validation
   *  happens at compile time, not here — normalisation trims but does not reject
   *  so stored documents survive registry changes. */
  transition: string
  field: SceneRevealField
  /** Palette layers, swept in order. Empty for the other two families. */
  layers: SceneRevealLayer[]
  timing: SceneRevealTiming
  hold: SceneRevealHold
  seed_policy: SceneRevealSeedPolicy
}

export type SceneRevealPatch = {
  [K in keyof Omit<SceneRevealDocument, 'schema_version'>]?: Partial<SceneRevealDocument[K]>
} & { schema_version?: number }

/** A reveal with nothing chosen: a plain crossfade out of black, then a drift. */
export function defaultSceneReveal(): SceneRevealDocument {
  return {
    schema_version: SCENE_REVEAL_SCHEMA_VERSION,
    family: 'geometric',
    transition: 'fade-black',
    field: { mode: 'colour', colour: '#000000', treatment: 'none', amount_pct: 100 },
    layers: [],
    timing: { mode: 'fit-narration', seconds: 1.2, min_seconds: 0.5, max_seconds: 2.5 },
    hold: { drift_pct: 4, drift_direction: 'in', micro_events: 1 },
    seed_policy: { coherence: 'scene', no_immediate_repeat: true, cap_per_effect: 0 },
  }
}

// ── Normalisation — lenient, for data already on disk ───────────────────────

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function hex(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : fallback
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : fallback
}

function normalizeTiming(input: unknown): SceneRevealTiming {
  const base = defaultSceneReveal().timing
  const raw = (input ?? {}) as Partial<SceneRevealTiming>
  const min = clamp(raw.min_seconds, 0.2, 10, base.min_seconds)
  const max = Math.max(min, clamp(raw.max_seconds, min, 20, Math.max(min, base.max_seconds)))
  return {
    mode: oneOf(raw.mode, ['fixed', 'fit-narration'] as const, base.mode),
    seconds: clamp(raw.seconds, 0.2, 10, base.seconds),
    min_seconds: min,
    max_seconds: max,
  }
}

function normalizeHold(input: unknown): SceneRevealHold {
  const base = defaultSceneReveal().hold
  const raw = (input ?? {}) as Partial<SceneRevealHold>
  /** The drift band comes from the contract, not the caller: below 3% a hold
   *  reads as a freeze, and past 8% the picture is moving like a camera move
   *  rather than holding still. Clamped rather than refused so a hand-edited
   *  project file still renders. */
  return {
    drift_pct: clamp(raw.drift_pct, 3, 8, base.drift_pct),
    drift_direction: oneOf(raw.drift_direction, ['in', 'out'] as const, base.drift_direction),
    micro_events: Math.round(clamp(raw.micro_events, 0, 3, base.micro_events)),
  }
}

function normalizeField(input: unknown): SceneRevealField {
  const base = defaultSceneReveal().field
  const raw = (input ?? {}) as Partial<SceneRevealField>
  return {
    mode: oneOf(raw.mode, REVEAL_FIELD_MODES, base.mode),
    colour: hex(raw.colour, base.colour),
    treatment: oneOf(raw.treatment, REVEAL_FIELD_TREATMENTS, base.treatment),
    amount_pct: clamp(raw.amount_pct, 0, 100, base.amount_pct),
  }
}

function normalizeLayers(input: unknown): SceneRevealLayer[] {
  if (!Array.isArray(input)) return []
  return input.slice(0, 4).map((raw, index) => {
    const entry = (raw ?? {}) as Partial<SceneRevealLayer>
    return {
      colour: hex(entry.colour, index === 0 ? '#101418' : '#f2ede4'),
      transition: typeof entry.transition === 'string' && entry.transition.trim()
        ? entry.transition.trim()
        : 'wipe-left',
      share_pct: clamp(entry.share_pct, 1, 100, 50),
    }
  })
}

function normalizeSeedPolicy(input: unknown): SceneRevealSeedPolicy {
  const base = defaultSceneReveal().seed_policy
  const raw = (input ?? {}) as Partial<SceneRevealSeedPolicy>
  return {
    coherence: oneOf(raw.coherence, REVEAL_COHERENCE_MODES, base.coherence),
    no_immediate_repeat: raw.no_immediate_repeat !== false,
    cap_per_effect: Math.round(clamp(raw.cap_per_effect, 0, 99, base.cap_per_effect)),
  }
}

/**
 * Normalise a stored or pack-supplied reveal. Lenient on purpose — this runs
 * against project files and Content Packs the customer already has, so a bad
 * field falls back rather than throwing, and every clamp names its band above.
 */
export function normalizeSceneReveal(input: unknown): SceneRevealDocument {
  const raw = (input ?? {}) as Partial<SceneRevealDocument>
  const family = oneOf(raw.family, REVEAL_FAMILIES, 'geometric')
  return {
    schema_version: SCENE_REVEAL_SCHEMA_VERSION,
    family,
    transition: typeof raw.transition === 'string' && raw.transition.trim()
      ? raw.transition.trim()
      : 'fade-black',
    field: normalizeField(raw.field),
    // Layers only mean something to the palette family; keeping them elsewhere
    // would make the picker's description disagree with the render.
    layers: family === 'palette' ? normalizeLayers(raw.layers) : [],
    timing: normalizeTiming(raw.timing),
    hold: normalizeHold(raw.hold),
    seed_policy: normalizeSeedPolicy(raw.seed_policy),
  }
}

/** Merge a patch over a base document — how a preset is authored and applied. */
export function mergeSceneReveal(
  base: SceneRevealDocument,
  patch: SceneRevealPatch | null | undefined,
): SceneRevealDocument {
  if (!patch) return normalizeSceneReveal(base)
  return normalizeSceneReveal({
    ...base,
    ...patch,
    field: { ...base.field, ...(patch.field ?? {}) },
    timing: { ...base.timing, ...(patch.timing ?? {}) },
    hold: { ...base.hold, ...(patch.hold ?? {}) },
    seed_policy: { ...base.seed_policy, ...(patch.seed_policy ?? {}) },
    layers: patch.layers ?? base.layers,
  })
}

/**
 * The reveal's own durations, resolved against a scene.
 *
 * `reveal_seconds + hold_seconds` is the clip's length. Both are returned
 * rather than recomputed by callers, because the clip length and the timeline
 * must agree to the frame or the assembly drifts.
 */
export interface ResolvedRevealTiming {
  reveal_seconds: number
  hold_seconds: number
  total_seconds: number
  /** Where each staged micro-event begins, in clip seconds. */
  micro_event_offsets: number[]
  /** Whose measurement chose the reveal length — the script's, or the preset's. */
  source: 'preset' | 'narration'
}

/**
 * Resolve a reveal against a scene window.
 *
 * `narration_seconds` is the length of the narration the scene carries; when
 * the timing mode is `fit-narration` the reveal grows into it (clamped), which
 * is what makes the picture land with the line. The hold then takes the rest of
 * the window — the picture has already arrived, so every remaining second is
 * hold, which is exactly the image-count saving the design is built around.
 */
export function resolveRevealTiming(
  doc: SceneRevealDocument,
  scene: { window_seconds: number; narration_seconds?: number },
): ResolvedRevealTiming {
  const timing = doc.timing
  const window = Math.max(0.5, scene.window_seconds)
  let reveal = timing.mode === 'fixed' ? timing.seconds : timing.seconds
  let source: ResolvedRevealTiming['source'] = 'preset'

  if (timing.mode === 'fit-narration') {
    const narration = scene.narration_seconds
    if (typeof narration === 'number' && Number.isFinite(narration) && narration > 0) {
      // The narration **shortens** an arrival, it does not lengthen one: the
      // picture must be up well before the line ends, so a short line gets a
      // shorter reveal — while a long line keeps the length the pace chose
      // rather than stretching the entrance to fill it. (It also means the four
      // paces actually differ: with the narration as the target, a 6 s line
      // made Fast, Standard, Slow and Documentary all render a 2.4 s arrival.)
      const share = narration * 0.4
      if (share < reveal) {
        reveal = share
        source = 'narration'
      }
    }
  }
  reveal = Math.max(timing.min_seconds, Math.min(timing.max_seconds, reveal))
  // A reveal can never be the whole window: a scene that is all entrance and no
  // hold is the thing this engine exists to avoid.
  reveal = Math.min(reveal, Math.max(0.2, window * 0.5))
  const hold = Math.max(0.2, window - reveal)

  const micro: number[] = []
  const events = doc.hold.micro_events
  for (let i = 1; i <= events; i++) {
    micro.push(Number((reveal + (hold * i) / (events + 1)).toFixed(3)))
  }
  return {
    reveal_seconds: Number(reveal.toFixed(3)),
    hold_seconds: Number(hold.toFixed(3)),
    total_seconds: Number((reveal + hold).toFixed(3)),
    micro_event_offsets: micro,
    source,
  }
}
