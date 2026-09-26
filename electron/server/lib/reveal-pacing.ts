/**
 * Reveal pacing — the part that pays for itself.
 *
 * A reveal plus a **hold** lets one image carry 10–15 s instead of 5. Image
 * generation is the expensive fleet step, so fewer images is the largest saving
 * available to an episode, and it arrives free with pacing.
 *
 * Three decisions are encoded here, and they are craft rather than measurement:
 *
 * 1. **Drift never stops.** A frozen frame reads as a slideshow; 3–8% of
 *    continuous movement is what makes a hold a shot rather than a stall.
 * 2. **Events are staged.** One wipe followed by eight seconds of nothing has
 *    faded from memory after four, so two or three micro-events are spread
 *    across the hold — each one a small colour settle, at a narration line or a
 *    music beat where the script already has one.
 * 3. **Pace is per episode, never a global default.** Overdone, slow pacing
 *    reads as padding — which is exactly what the full-episode check at Slow is
 *    for.
 */

import { normalizeSceneReveal, resolveRevealTiming, type SceneRevealDocument } from '../contracts/scene-reveal.js'
import { builtInReveal } from '../contracts/scene-reveal-presets.js'

export const REVEAL_PACES = ['fast', 'standard', 'slow', 'documentary'] as const
export type RevealPace = (typeof REVEAL_PACES)[number]

export interface RevealPaceSettings {
  id: RevealPace
  name: string
  description: string
  /** Reveal length these presets land on when the script does not decide it. */
  reveal_seconds: number
  /** The band a scene's total length is allowed to land in. */
  min_total_seconds: number
  max_total_seconds: number
  /** How long a hold has to be before a micro-event is worth staging in it. */
  min_hold_for_event_seconds: number
  micro_events: number
  drift_pct: number
}

/**
 * The four paces. These are the design's bundles: reveal length, hold length,
 * drift and micro-event count, in one place so the picker and the renderer
 * cannot disagree about what "Slow" means.
 */
export const REVEAL_PACE_SETTINGS: Record<RevealPace, RevealPaceSettings> = {
  fast: {
    id: 'fast',
    name: 'Fast',
    description: 'Short scenes, quick arrivals. For a listicle or a news-style cut.',
    reveal_seconds: 0.8,
    min_total_seconds: 3,
    max_total_seconds: 6,
    min_hold_for_event_seconds: 3,
    micro_events: 1,
    drift_pct: 6,
  },
  standard: {
    id: 'standard',
    name: 'Standard',
    description: 'The default: a clear arrival and a few seconds of hold.',
    reveal_seconds: 1.2,
    min_total_seconds: 5,
    max_total_seconds: 9,
    min_hold_for_event_seconds: 3.5,
    micro_events: 1,
    drift_pct: 4,
  },
  slow: {
    id: 'slow',
    name: 'Slow',
    description: 'One image carries a whole narration line. The image-count saving lives here.',
    reveal_seconds: 1.6,
    min_total_seconds: 9,
    max_total_seconds: 16,
    min_hold_for_event_seconds: 4,
    micro_events: 2,
    drift_pct: 4,
  },
  documentary: {
    id: 'documentary',
    name: 'Documentary',
    description: 'Long holds, the calmest arrivals. For archive and interview material.',
    reveal_seconds: 1.8,
    min_total_seconds: 12,
    max_total_seconds: 20,
    min_hold_for_event_seconds: 5,
    micro_events: 3,
    drift_pct: 3,
  },
}

export function isRevealPace(value: unknown): value is RevealPace {
  return typeof value === 'string' && (REVEAL_PACES as readonly string[]).includes(value)
}

export function paceSettings(pace: RevealPace | undefined): RevealPaceSettings {
  return REVEAL_PACE_SETTINGS[isRevealPace(pace) ? pace : 'standard']
}

export interface RevealHoldPlan {
  pace: RevealPace
  reveal_seconds: number
  hold_seconds: number
  total_seconds: number
  /** Clip seconds where each staged micro-event begins. */
  micro_event_offsets: number[]
  /** What decided the total: the scene's own window, or something it snapped to. */
  snapped_to: 'window' | 'narration-line' | 'beat'
}

/** Candidates a hold may be snapped onto: narration line ends, then beats. */
export interface RevealSnapCandidates {
  narration_line_ends?: number[]
  beat_seconds?: number[]
}

/**
 * A tolerance, not a magnet.
 *
 * Snapping should choose between candidates that are already nearly the same
 * length — a line end 0.2 s away is the line's own rhythm, while one 1.5 s away
 * would stretch or crush the scene to hit it, which is the "padding" failure
 * the pace setting exists to avoid.
 */
const SNAP_TOLERANCE_SECONDS = 0.35

function nearest(candidates: number[], target: number, floor: number, ceiling: number): number | null {
  let best: number | null = null
  let bestDistance = Infinity
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate)) continue
    if (candidate < floor || candidate > ceiling) continue
    const distance = Math.abs(candidate - target)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return best !== null && bestDistance <= SNAP_TOLERANCE_SECONDS ? best : null
}

/**
 * Plan one scene's reveal and hold.
 *
 * The pace decides the band; the scene's window (its narration, its place on
 * the timeline) decides where inside the band it lands; and the arrival itself
 * is never randomised — only chosen. Rule 4 of the design: wipe length jumping
 * scene to scene makes an episode feel unstable.
 */
export function planSceneHold(input: {
  pace: RevealPace
  window_seconds: number
  narration_seconds?: number
  doc?: SceneRevealDocument
  snap?: RevealSnapCandidates
}): RevealHoldPlan {
  const settings = paceSettings(input.pace)
  const window = Math.max(0.6, input.window_seconds)

  // The scene's length stays inside the pace's band. A narration line longer
  // than the band wins — the pace is a look, and the script is the script.
  const narration = typeof input.narration_seconds === 'number' && input.narration_seconds > 0
    ? input.narration_seconds
    : undefined
  let total = Math.min(Math.max(window, settings.min_total_seconds), settings.max_total_seconds)
  if (narration) total = Math.max(total, narration, settings.min_total_seconds)

  let snappedTo: RevealHoldPlan['snapped_to'] = 'window'
  const floor = settings.reveal_seconds + 0.4
  const ceiling = Math.max(floor, total + 2.5)
  const line = nearest(input.snap?.narration_line_ends ?? [], total, floor, ceiling)
  if (line !== null) {
    total = line
    snappedTo = 'narration-line'
  } else {
    const beat = nearest(input.snap?.beat_seconds ?? [], total, floor, ceiling)
    if (beat !== null) {
      total = beat
      snappedTo = 'beat'
    }
  }

  // **The pace sets the arrival length.** The preset says how it wants to
  // arrive (fit the narration, or a fixed length); the pace says how long an
  // arrival is in *this* episode. Applying the pace to the document is what
  // makes Fast 0.8 s and Documentary 1.8 s — before this, the narration alone
  // decided and every pace rendered the same 2.4 s arrival.
  const doc = paceDocument(settings.id, input.doc)
  const resolved = resolveRevealTiming(doc, {
    window_seconds: total,
    narration_seconds: narration,
  })

  // Micro-events are staged at the script's own moments when there are any,
  // and spread evenly when there are not. Either way they never land inside the
  // arrival, and never overlap each other.
  //
  // Who decides the count: the **pace** does, because how busy an episode feels
  // is a per-episode choice — but a preset may opt out entirely (0), which is
  // why `draw-on` stays quiet even at Documentary.
  const offsets: number[] = []
  const wanted = doc.hold.micro_events === 0 || resolved.hold_seconds < settings.min_hold_for_event_seconds
    ? 0
    : settings.micro_events
  const candidates = [
    ...(input.snap?.narration_line_ends ?? []),
    ...(input.snap?.beat_seconds ?? []),
  ].filter(at => at > resolved.reveal_seconds + 0.3 && at < resolved.total_seconds - 0.3)
  for (let i = 0; i < wanted; i++) {
    const even = resolved.reveal_seconds + (resolved.hold_seconds * (i + 1)) / (wanted + 1)
    const snapped = nearest(candidates, even, resolved.reveal_seconds + 0.2, resolved.total_seconds - 0.2)
    const at = snapped ?? even
    // Keep them ordered and apart; two settles inside a second read as a flicker.
    const previous = offsets[offsets.length - 1]
    if (previous !== undefined && at - previous < 0.8) continue
    offsets.push(Number(at.toFixed(3)))
  }

  return {
    pace: settings.id,
    reveal_seconds: resolved.reveal_seconds,
    hold_seconds: resolved.hold_seconds,
    total_seconds: resolved.total_seconds,
    micro_event_offsets: offsets,
    snapped_to: snappedTo,
  }
}

/** The document a pace implies, for a caller that has no preset yet. */
export function paceDocument(pace: RevealPace, base?: SceneRevealDocument): SceneRevealDocument {
  const settings = paceSettings(pace)
  const doc = normalizeSceneReveal(base ?? builtInReveal('reveal-rows')!.document)
  return normalizeSceneReveal({
    ...doc,
    timing: {
      ...doc.timing,
      mode: 'fit-narration',
      seconds: settings.reveal_seconds,
      min_seconds: Math.max(0.4, settings.reveal_seconds * 0.6),
      max_seconds: settings.reveal_seconds * 1.6,
    },
    hold: {
      ...doc.hold,
      drift_pct: settings.drift_pct,
      // A preset that asks for no micro-events keeps none, at every pace: some
      // looks are meant to be quiet (draw-on is a line arriving on paper), and a
      // pace setting must not busy them up. Otherwise the pace decides.
      micro_events: doc.hold.micro_events === 0 ? 0 : settings.micro_events,
    },
  })
}
