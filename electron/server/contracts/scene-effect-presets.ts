/**
 * The built-in effect library: twenty-four scene motions, seven B-Roll
 * motions, thirteen overlays across the seven starter kinds.
 *
 * DATA, in one module. Not branches in the compiler — an entry is a document
 * and nothing more, which is the same thing a downloadable content pack will
 * be. If a look cannot be expressed here, the engine is missing a FIELD; the
 * answer is to add the field, never to special-case the name.
 *
 * The thirty-one motions reproduce v1.1.0's hardcoded FFmpeg output BYTE FOR BYTE.
 * `__tests__/scene-effect-registry.test.ts` asserts that against 1,163 filter
 * strings captured from the v1.1.0 tree before any of this existed, so a drift
 * of one decimal place fails the build.
 *
 * `approximation` is filled in wherever FFmpeg cannot do the thing the name
 * promises, and is shown in the UI. An effect that quietly renders something
 * other than its name is worse than one that says what it actually does.
 */

import {
  SCENE_EFFECT_SCHEMA_VERSION,
  defaultSceneMotion,
  defaultSceneOverlay,
  mergeSceneMotion,
  mergeSceneOverlay,
  normalizeSceneOverlay,
  type LegacyMotionBinding,
  type OverlayKind,
  type SceneEffectDescriptor,
  type SceneMotionDocument,
  type SceneMotionPatch,
  type SceneOverlayDocument,
} from './scene-effects.js'

/** A built-in motion, plus the legacy-parameter binding it honours. */
export interface BuiltInMotion extends SceneEffectDescriptor<SceneMotionDocument> {
  legacy_binding: LegacyMotionBinding
}

export type BuiltInOverlay = SceneEffectDescriptor<SceneOverlayDocument>

// ── Motion helpers ──────────────────────────────────────────────────────────

/**
 * Supersample stills 2x before `zoompan`.
 *
 * v1.0.515 settled on 2x after 4x upscaled every source to 33 megapixels for no
 * visible gain: `zoompan` is single-threaded and its per-frame cost scales with
 * canvas area. Sources are typically 1-2 MP, so there is no extra detail to
 * sample past ~2x, and 2x is the standard anti-jitter level.
 */
const SUPERSAMPLE_PCT = 200

/** The magnification pans hold so there is picture outside the frame to move into. */
const PAN_ZOOM_PCT = 108

/**
 * Diagonal pans travel at `speed / sqrt(2)` per axis, so the diagonal distance
 * matches the single-axis rate. Without it, diagonals visibly outrun `pan-left`.
 */
const DIAGONAL_AXIAL_SPEED = 1.5 / Math.SQRT2

function motion(
  id: string,
  name: string,
  category: string,
  description: string,
  patch: SceneMotionPatch,
  extra?: { legacy_binding?: LegacyMotionBinding; approximation?: string },
): BuiltInMotion {
  return {
    id,
    name,
    category,
    description,
    ...(extra?.approximation ? { approximation: extra.approximation } : {}),
    legacy_binding: extra?.legacy_binding || 'none',
    document: mergeSceneMotion(defaultSceneMotion(), patch),
  }
}

/** A still-image camera move: supersample, then drive `zoompan`. */
function stillCamera(patch: SceneMotionPatch): SceneMotionPatch {
  return { ...patch, source: 'still', framing: { source_scale_pct: SUPERSAMPLE_PCT, ...(patch.framing || {}) } }
}

function stillZoomRamp(from: number, to: number): SceneMotionPatch {
  return stillCamera({ zoom: { mode: 'ramp', from_pct: from, to_pct: to } })
}

function stillPan(x: number, y: number): SceneMotionPatch {
  return stillCamera({
    zoom: { mode: 'fixed', fixed_pct: PAN_ZOOM_PCT },
    pan: { mode: 'rate', x, y, rate_unit: 'output-px-per-second' },
  })
}

// ── Scene motions (still images) ────────────────────────────────────────────

export const BUILT_IN_SCENE_MOTIONS: BuiltInMotion[] = [
  // ── Zoom ──────────────────────────────────────────────────────────────────
  motion('ken-burns', 'Ken Burns', 'zoom',
    'Classic documentary slow zoom.',
    stillZoomRamp(100, 108), { legacy_binding: 'zoom' }),

  motion('ken-burns-reverse', 'Ken Burns Reverse', 'zoom',
    'Starts zoomed in, slowly pulls back — reveals the wider frame.',
    stillZoomRamp(108, 100), { legacy_binding: 'zoom-reversed' }),

  motion('zoom-in', 'Zoom In', 'zoom',
    'Straight zoom from 100% to 112%.',
    stillZoomRamp(100, 112)),

  motion('zoom-out', 'Zoom Out', 'zoom',
    'Pull back from 112% to 100%.',
    stillZoomRamp(112, 100)),

  motion('slow-push', 'Slow Push', 'zoom',
    'Gentler zoom-in (100% → 106%) — subtle drift toward subject.',
    stillZoomRamp(100, 106)),

  motion('slow-pull', 'Slow Pull', 'zoom',
    'Gentler zoom-out (106% → 100%) — subtle drift away.',
    stillZoomRamp(106, 100)),

  motion('dolly-in', 'Dolly In', 'zoom',
    'Slow zoom with a gentle downward tilt.',
    stillCamera({
      zoom: { mode: 'ramp', from_pct: 100, to_pct: 108 },
      // Authored as a per-FRAME rate in v1.0, so the tilt speed follows the
      // frame rate rather than the clock. Preserved; see MOTION_RATE_UNITS.
      pan: { mode: 'rate', x: 0, y: 0.6, rate_unit: 'source-px-per-frame' },
    }), {
      approximation: 'A real dolly changes perspective as the camera moves. A still image '
        + 'has one perspective, so this is a zoom plus a downward drift — the parallax '
        + 'between near and far objects that a physical dolly produces is not there.',
    }),

  // ── Pan ───────────────────────────────────────────────────────────────────
  motion('parallax-drift', 'Parallax Drift', 'pan',
    'Slow directional pan (configurable direction).',
    stillPan(2, 0), {
      legacy_binding: 'parallax',
      approximation: 'Not true parallax. A single flat image has no depth layers to move at '
        + 'different rates, so the whole frame drifts together.',
    }),

  motion('pan-left', 'Pan Left', 'pan', 'Camera drifts left across the frame.', stillPan(-2, 0)),
  motion('pan-right', 'Pan Right', 'pan', 'Camera drifts right across the frame.', stillPan(2, 0)),
  motion('pan-up', 'Pan Up', 'pan', 'Camera drifts upward.', stillPan(0, -2)),
  motion('pan-down', 'Pan Down', 'pan', 'Camera drifts downward.', stillPan(0, 2)),

  motion('pan-diag-tl', 'Pan Diagonal TL', 'pan', 'Slow pan up and to the left.',
    stillPan(-DIAGONAL_AXIAL_SPEED, -DIAGONAL_AXIAL_SPEED)),
  motion('pan-diag-tr', 'Pan Diagonal TR', 'pan', 'Slow pan up and to the right.',
    stillPan(DIAGONAL_AXIAL_SPEED, -DIAGONAL_AXIAL_SPEED)),
  motion('pan-diag-bl', 'Pan Diagonal BL', 'pan', 'Slow pan down and to the left.',
    stillPan(-DIAGONAL_AXIAL_SPEED, DIAGONAL_AXIAL_SPEED)),
  motion('pan-diag-br', 'Pan Diagonal BR', 'pan', 'Slow pan down and to the right.',
    stillPan(DIAGONAL_AXIAL_SPEED, DIAGONAL_AXIAL_SPEED)),

  // ── Ambient ───────────────────────────────────────────────────────────────
  motion('breathe', 'Breathe', 'ambient', 'Gentle sine-wave pulse zoom.',
    stillCamera({ zoom: { mode: 'sine', base_pct: 103, amplitude_pct: 2 } }),
    { legacy_binding: 'breathe' }),

  motion('pulse', 'Pulse', 'ambient', 'More pronounced breathing rhythm.',
    stillCamera({ zoom: { mode: 'sine', base_pct: 105, amplitude_pct: 4 } }),
    { legacy_binding: 'breathe' }),

  // ── Rotate ────────────────────────────────────────────────────────────────
  motion('rotate-cw', 'Rotate CW', 'rotate', 'Subtle clockwise drift.',
    { framing: { source_scale_pct: 110 }, spin: { rate_rad_per_sec: 0.02 } }),
  motion('rotate-ccw', 'Rotate CCW', 'rotate', 'Subtle counter-clockwise drift.',
    { framing: { source_scale_pct: 110 }, spin: { rate_rad_per_sec: -0.02 } }),

  // ── Effect ────────────────────────────────────────────────────────────────
  motion('fade-in', 'Fade In', 'effect', 'Scene fades up from black.',
    { fade: { in: true } }),
  motion('fade-out', 'Fade Out', 'effect', 'Scene fades down to black at the end.',
    { fade: { out: true } }),

  motion('blur-focus', 'Blur → Focus', 'effect', 'Starts blurred, comes into focus.',
    { focus: { stages: [
      { sigma: 8, until_share: 0.3 },
      { sigma: 4, until_share: 0.6 },
      { sigma: 1.5, until_share: 0.85 },
    ] } }, {
      approximation: 'FFmpeg cannot animate a blur radius, so the ramp is three time-gated '
        + 'passes at decreasing strength rather than a continuous rack focus. The steps '
        + 'between them are visible on a slow look.',
    }),

  // ── Static ────────────────────────────────────────────────────────────────
  motion('none', 'None (static)', 'static', 'No motion — fastest render.', {}),
]

// ── B-Roll motions (footage) ────────────────────────────────────────────────

/**
 * The magnification a footage move works within. Deliberately gentler than the
 * still moves: real footage already carries its own motion, and stacking a
 * large camera move on top of it reads as a wobble.
 */
const FOOTAGE_TRAVEL_PCT = 110

function footage(
  id: string, name: string, description: string, patch: SceneMotionPatch,
): BuiltInMotion {
  return motion(id, name, 'footage', description, { ...patch, source: 'footage' })
}

export const BUILT_IN_FOOTAGE_MOTIONS: BuiltInMotion[] = [
  footage('static', 'Static',
    'No camera move. Cleanest cuts; lets the footage carry the rhythm.', {}),

  footage('zoom-in', 'Slow Zoom In',
    'Subtle push toward the subject over the clip. Adds intimacy.',
    { zoom: { mode: 'ramp', from_pct: 100, to_pct: FOOTAGE_TRAVEL_PCT } }),

  footage('zoom-out', 'Slow Zoom Out',
    'Subtle pull-back. Reveals more of the scene over time.',
    { zoom: { mode: 'ramp', from_pct: FOOTAGE_TRAVEL_PCT, to_pct: 100 } }),

  footage('pan-left', 'Pan Left', 'Camera drifts left across the frame.', {
    framing: { source_scale_pct: FOOTAGE_TRAVEL_PCT },
    pan: { mode: 'traverse', x: -1, y: 0 },
  }),
  footage('pan-right', 'Pan Right', 'Camera drifts right across the frame.', {
    framing: { source_scale_pct: FOOTAGE_TRAVEL_PCT },
    pan: { mode: 'traverse', x: 1, y: 0 },
  }),
  footage('pan-up', 'Pan Up', 'Camera drifts upward.', {
    framing: { source_scale_pct: FOOTAGE_TRAVEL_PCT },
    pan: { mode: 'traverse', x: 0, y: -1 },
  }),
  footage('pan-down', 'Pan Down', 'Camera drifts downward.', {
    framing: { source_scale_pct: FOOTAGE_TRAVEL_PCT },
    pan: { mode: 'traverse', x: 0, y: 1 },
  }),
]

const SCENE_MOTIONS_BY_ID = new Map(BUILT_IN_SCENE_MOTIONS.map(m => [m.id, m] as const))
const FOOTAGE_MOTIONS_BY_ID = new Map(BUILT_IN_FOOTAGE_MOTIONS.map(m => [m.id, m] as const))

export function findSceneMotion(id: string | null | undefined): BuiltInMotion | undefined {
  return id ? SCENE_MOTIONS_BY_ID.get(id) : undefined
}

export function findFootageMotion(id: string | null | undefined): BuiltInMotion | undefined {
  return id ? FOOTAGE_MOTIONS_BY_ID.get(id) : undefined
}

/** The id a missing or unrecognised selection falls back to. */
export const DEFAULT_SCENE_MOTION_ID = 'none'
export const DEFAULT_FOOTAGE_MOTION_ID = 'static'

// ═══════════════════════════════════════════════════════════════════════════
// Overlays — the free starter library
// ═══════════════════════════════════════════════════════════════════════════

function overlay(
  id: string,
  name: string,
  category: string,
  description: string,
  kind: OverlayKind,
  patch: Record<string, unknown>,
  extra?: { approximation?: string },
): BuiltInOverlay {
  return {
    id,
    name,
    category,
    description,
    ...(extra?.approximation ? { approximation: extra.approximation } : {}),
    document: mergeSceneOverlay(kind, patch),
  }
}

export const BUILT_IN_OVERLAYS: BuiltInOverlay[] = [
  overlay('vignette-soft', 'Soft Vignette', 'light',
    'Gentle corner darkening that pulls the eye to the middle of the frame.',
    'vignette', { intensity: 0.45 }),

  overlay('vignette-heavy', 'Heavy Vignette', 'light',
    'Strong corner falloff. Reads as an old lens or a spotlit stage.',
    'vignette', { intensity: 0.85 }),

  overlay('film-grain-fine', 'Fine Film Grain', 'texture',
    'A light, constantly moving grain. Takes the digital flatness off an AI still.',
    'film-grain', { amount: 12 }),

  overlay('film-grain-heavy', 'Heavy Film Grain', 'texture',
    'Coarse, obvious grain for a 16mm or archival feel.',
    'film-grain', { amount: 34 }),

  overlay('light-leak-warm', 'Warm Light Leak', 'light',
    'An amber glow that drifts down the right of the frame, screen-blended.',
    'light-leak', {
      color_hex: '#FF9A3C', intensity: 0.35, softness: 0.6,
      from_anchor: 'top-right', to_anchor: 'center-right',
    }, {
      approximation: 'A real light leak is film stock fogging at the edge of the gate. '
        + 'FFmpeg has no such filter, so this is a soft coloured blob screen-blended over '
        + 'the picture: it drifts and glows, but it does not wash across the frame edge or '
        + 'bloom into the highlights the way exposed film does.',
    }),

  overlay('light-leak-cool', 'Cool Light Leak', 'light',
    'A cold blue flare crossing the top of the frame. Good for night and dream scenes.',
    'light-leak', {
      color_hex: '#5FC8FF', intensity: 0.28, softness: 0.72,
      from_anchor: 'top-left', to_anchor: 'top-right',
    }, {
      approximation: 'Same approximation as the warm leak: a screen-blended soft blob, not '
        + 'true film fogging.',
    }),

  overlay('letterbox-235', 'Cinemascope Bars', 'framing',
    'Black bars top and bottom at 2.35:1. Drawn over the picture — nothing is cropped.',
    'letterbox', { ratio: '2.35:1' }),

  overlay('letterbox-185', 'Widescreen Bars', 'framing',
    'Shallower 1.85:1 bars. A cinema hint rather than a statement.',
    'letterbox', { ratio: '1.85:1' }),

  overlay('lower-third-clean', 'Clean Lower Third', 'title',
    'A dark bar with a name and a role, bottom-left. Fades in and out.',
    'lower-third', {
      title: 'Name', subtitle: 'Role or place',
      bar: true, bar_color_hex: '#101014', bar_opacity: 0.72,
    }),

  overlay('lower-third-bare', 'Bare Lower Third', 'title',
    'Text only, no bar. Relies on a stroke to stay legible over busy footage.',
    'lower-third', {
      title: 'Name', subtitle: '', bar: false,
      title_size_px: 48, anchor: 'bottom-left',
    }),

  // Deliberately NOT `corner-logo`: an entry id that is identical to its kind
  // reads as the kind everywhere it appears, and the two are different things
  // — one is a specific shipped effect, the other is a category the engine
  // knows how to render.
  overlay('channel-mark', 'Corner Logo', 'brand',
    'A channel mark held in one corner at a fixed size and opacity.',
    'corner-logo', {}),

  overlay('scrim-bottom', 'Bottom Scrim', 'framing',
    'A dark wash rising from the bottom edge so captions stay legible over bright scenes.',
    'gradient-scrim', { edge: 'bottom', opacity: 0.75, coverage: 0.34 }, {
      approximation: 'FFmpeg’s drawbox cannot draw a gradient. The ramp is a stack of '
        + 'flat bands at stepped opacity — smooth at the default 24 steps, visibly banded '
        + 'below about 8.',
    }),

  overlay('scrim-top', 'Top Scrim', 'framing',
    'The same wash from the top edge, for titles and channel marks.',
    'gradient-scrim', { edge: 'top', opacity: 0.7, coverage: 0.28 }, {
      approximation: 'Stepped bands rather than a true gradient — see Bottom Scrim.',
    }),
]

const OVERLAYS_BY_ID = new Map(BUILT_IN_OVERLAYS.map(o => [o.id, o] as const))

export function findBuiltInOverlay(id: string | null | undefined): BuiltInOverlay | undefined {
  return id ? OVERLAYS_BY_ID.get(id) : undefined
}

/** Group the overlay library for the picker, preserving declaration order. */
export function groupedOverlays(): Array<{ category: string; overlays: BuiltInOverlay[] }> {
  const out: Array<{ category: string; overlays: BuiltInOverlay[] }> = []
  for (const item of BUILT_IN_OVERLAYS) {
    let bucket = out.find(b => b.category === item.category)
    if (!bucket) { bucket = { category: item.category, overlays: [] }; out.push(bucket) }
    bucket.overlays.push(item)
  }
  return out
}

/** Everything the pickers need, in one payload. */
export function sceneEffectCatalog() {
  return {
    schema_version: SCENE_EFFECT_SCHEMA_VERSION,
    scene_motions: BUILT_IN_SCENE_MOTIONS,
    footage_motions: BUILT_IN_FOOTAGE_MOTIONS,
    overlays: BUILT_IN_OVERLAYS,
    grouped_overlays: groupedOverlays(),
  }
}

/** Defaults for one overlay kind, for a UI that is building a custom instance. */
export function overlayKindDefaults(kind: OverlayKind): SceneOverlayDocument {
  return defaultSceneOverlay(kind)
}

/** One selected overlay, resolved against the library and ready to compile. */
export interface ResolvedOverlay {
  id: string
  name: string
  approximation?: string
  document: SceneOverlayDocument
}

/**
 * Resolve a render's overlay selection into finished documents.
 *
 * Only the SELECTION is persisted — an id plus the fields the customer changed.
 * The document is rebuilt from the current built-in every time, so improving a
 * built-in reaches every project that chose it instead of leaving copies of the
 * old one frozen inside saved configs. Same rule the first line of AGENTS.md
 * sets for catalogue values: persist the choice, resolve the detail.
 *
 * An id this build does not have is SKIPPED and REPORTED, never fatal — a
 * project authored against a pack that is not installed must still render, and
 * the customer must be told which effect did not appear.
 */
export function resolveAppliedOverlays(
  config: {
    enabled?: boolean
    overlays?: Array<{ id: string; enabled?: boolean; params?: Record<string, unknown> }>
  } | null | undefined,
): { resolved: ResolvedOverlay[]; unknownIds: string[] } {
  const resolved: ResolvedOverlay[] = []
  const unknownIds: string[] = []
  if (!config || config.enabled === false || !Array.isArray(config.overlays)) return { resolved, unknownIds }
  for (const applied of config.overlays) {
    if (!applied || applied.enabled === false) continue
    const entry = findBuiltInOverlay(applied.id)
    if (!entry) { unknownIds.push(String(applied?.id ?? '(unnamed)')); continue }
    resolved.push({
      id: entry.id,
      name: entry.name,
      ...(entry.approximation ? { approximation: entry.approximation } : {}),
      document: applied.params
        ? normalizeSceneOverlay({ ...entry.document, ...applied.params, kind: entry.document.kind })
        : entry.document,
    })
  }
  return { resolved, unknownIds }
}
