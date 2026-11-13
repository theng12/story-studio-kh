/**
 * The built-in effect library: twenty-four scene motions, seven B-Roll
 * motions, thirteen overlays across the seven starter kinds, plus (v1.5) sixteen
 * atmosphere, weather and light effects and six starting effect stacks.
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

import { isContentPackItemId } from './content-origin.js'
import type { MotionCategory, OverlayCategory } from './scene-effects.js'
import {
  SCENE_EFFECT_SCHEMA_VERSION,
  defaultAtmosphereLoop,
  defaultSceneMotion,
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

const DEPTH_APPROXIMATION = 'Each pixel shifts by its depth from one picture, so the gaps a real camera would see behind '
  + 'near things are stretched from their surroundings rather than drawn; kept to at most 1.5% of the width so that '
  + 'never shows. Needs a transition between scenes; cut episodes render the plain zoom.'
const RACK_APPROXIMATION = 'The picture blends between sharp and one blurred copy by depth, so the out-of-focus parts '
  + 'are a single blur strength softened by distance, not a lens\'s true bokeh.'

function motion(
  id: string,
  name: string,
  category: MotionCategory,
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
  // 1.4.282 — grouped as Fades: they change the picture's brightness, not the camera.
  motion('fade-in', 'Fade In', 'fade', 'Scene fades up from black.',
    { fade: { in: true } }),
  motion('fade-out', 'Fade Out', 'fade', 'Scene fades down to black at the end.',
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

  // ── E1 (1.4.287): handheld float ─────────────────────────────────────────
  // A held camera's tiny sideways and up-and-down drift, never a turn. 103% keeps the frame
  // covered while it drifts (at most 0.8% either way inside 1.5% of slack); a 0.3% breath on top.
  motion('float-gentle', 'Handheld Float (gentle)', 'ambient',
    'A barely-there drift, as if the camera were held by a very still hand.',
    stillCamera({ zoom: { mode: 'sine', base_pct: 103, amplitude_pct: 0.3 }, float: { amplitude_pct: 0.4, period_sec: 9, seed: 0 } })),
  motion('float', 'Handheld Float', 'ambient',
    'A slow, organic sideways and up-and-down drift. Never rotates.',
    stillCamera({ zoom: { mode: 'sine', base_pct: 103, amplitude_pct: 0.3 }, float: { amplitude_pct: 0.8, period_sec: 9, seed: 0 } })),

  // ── E2–E4 (1.4.288): moves that understand the picture ───────────────────
  // Each needs the scene's analysis (Effects Library → Scene analysis, per channel). Without it the
  // scene renders the move's plain camera — the Zoom in it is built on, or Blur → Focus for a rack.
  motion('depth-gentle', '3D Photo (gentle)', 'zoom',
    'A slow push in where near things grow a little faster than far ones, like a real camera moving in.',
    { ...stillZoomRamp(100, 106), depth: { parallax_pct: 0.6, direction: 'in' } }, { approximation: DEPTH_APPROXIMATION }),
  motion('depth', '3D Photo', 'zoom',
    'A push in with real depth: near and far layers move at different rates. Needs the scene\'s depth map.',
    { ...stillZoomRamp(100, 108), depth: { parallax_pct: 1, direction: 'in' } }, { approximation: DEPTH_APPROXIMATION }),
  motion('depth-strong', '3D Photo (strong)', 'zoom',
    'A stronger push in with real depth.',
    { ...stillZoomRamp(100, 112), depth: { parallax_pct: 1.5, direction: 'in' } }, { approximation: DEPTH_APPROXIMATION }),
  motion('depth-left', '3D Photo, slide left', 'pan',
    'The near layer slides left past the far one while the camera pushes in gently.',
    { ...stillZoomRamp(100, 108), depth: { parallax_pct: 1, direction: 'left' } }, { approximation: DEPTH_APPROXIMATION }),
  motion('depth-right', '3D Photo, slide right', 'pan',
    'The near layer slides right past the far one while the camera pushes in gently.',
    { ...stillZoomRamp(100, 108), depth: { parallax_pct: 1, direction: 'right' } }, { approximation: DEPTH_APPROXIMATION }),
  motion('rack-focus-gentle', 'Rack Focus (gentle)', 'effect',
    'The focus slides from the background onto the subject, lightly.',
    { ...stillZoomRamp(100, 102), rack: { to: 'subject', max_sigma_px: 4 } }, { approximation: RACK_APPROXIMATION }),
  motion('rack-focus', 'Rack Focus', 'effect',
    'The focus slides from the background onto the subject while the camera pushes in a touch.',
    { ...stillZoomRamp(100, 102), rack: { to: 'subject', max_sigma_px: 6 } }, { approximation: RACK_APPROXIMATION }),
  motion('rack-focus-strong', 'Rack Focus (strong)', 'effect',
    'A deeper focus pull from the background onto the subject.',
    { ...stillZoomRamp(100, 102), rack: { to: 'subject', max_sigma_px: 8 } }, { approximation: RACK_APPROXIMATION }),
  motion('rack-focus-background', 'Rack Focus to Background', 'effect',
    'The focus slides from the subject to the far background.',
    { ...stillZoomRamp(100, 102), rack: { to: 'far', max_sigma_px: 6 } }, { approximation: RACK_APPROXIMATION }),
  motion('subject-gentle', 'Zoom to Subject (gentle)', 'zoom',
    'A gentle push that ends on the picture\'s main subject instead of the middle.',
    { ...stillZoomRamp(100, 106), aim: { mode: 'subject' } }),
  motion('subject', 'Zoom to Subject', 'zoom',
    'Ken Burns aimed at the main subject the scene analysis found (else the nearest thing, else the middle).',
    { ...stillZoomRamp(100, 108), aim: { mode: 'subject' } }),
  motion('subject-strong', 'Zoom to Subject (strong)', 'zoom',
    'A closer push onto the main subject. The subject always keeps a margin round it.',
    { ...stillZoomRamp(100, 112), aim: { mode: 'subject' } }),
  motion('subject-pull', 'Pull Back from Subject', 'zoom',
    'Starts close on the main subject and slowly pulls back to the whole picture.',
    { ...stillZoomRamp(108, 100), aim: { mode: 'subject' } }),
  motion('tour', 'Guided Tour', 'pan',
    'One slow move through two or three interesting places in the picture, starting from the left.',
    stillCamera({ zoom: { mode: 'fixed', fixed_pct: 115 }, aim: { mode: 'tour' } }), {
      approximation: 'Drawn by the native renderer; a scene rendered by FFmpeg zooms to the subject instead.',
    }),
  motion('tour-slow', 'Guided Tour (slow)', 'pan',
    'The guided tour with a wider view, so it travels less.',
    stillCamera({ zoom: { mode: 'fixed', fixed_pct: 110 }, aim: { mode: 'tour' } }), {
      approximation: 'Drawn by the native renderer; a scene rendered by FFmpeg zooms to the subject instead.',
    }),
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

/**
 * A camera move that turns the picture (owner, 2026-10-11: "we don't want no rotation at all").
 * `rotate-cw`/`rotate-ccw` stay in the registry only so old saved presets still parse; nothing
 * offers or renders them (1.4.280). An unknown id is judged by its name.
 * ponytail: a pack spin motion is caught by its document only where the library is at hand.
 */
export function isRotationMotion(motion: string | BuiltInMotion | null | undefined): boolean {
  const entry = typeof motion === 'string' ? (findSceneMotion(motion) ?? findFootageMotion(motion)) : motion
  if (entry) return entry.category === 'rotate' || entry.document.spin.rate_rad_per_sec !== 0
  return typeof motion === 'string' && /rotat/i.test(motion)
}

// ── Motion families (1.4.282, owner-approved) ────────────────────────────────
//
// The menu shows one card per family with a strength choice; underneath, every
// strength is still its own motion with its own id, so a saved preset, pool,
// episode file or render that names an id gets exactly that motion.

export type MotionStrength = 'gentle' | 'normal' | 'strong'
export interface MotionFamily {
  key: string
  name: string
  description: string
  members: ReadonlyArray<{ id: string; strength: MotionStrength }>
}

export const MOTION_FAMILIES: readonly MotionFamily[] = [
  { key: 'zoom-in', name: 'Zoom in', description: 'A slow push toward the subject.', members: [
    { id: 'slow-push', strength: 'gentle' }, { id: 'ken-burns', strength: 'normal' }, { id: 'zoom-in', strength: 'strong' },
  ] },
  { key: 'zoom-out', name: 'Zoom out', description: 'A slow pull back that reveals the wider frame.', members: [
    { id: 'slow-pull', strength: 'gentle' }, { id: 'ken-burns-reverse', strength: 'normal' }, { id: 'zoom-out', strength: 'strong' },
  ] },
  { key: 'breathe', name: 'Breathe', description: 'A gentle in-and-out pulse.', members: [
    { id: 'breathe', strength: 'gentle' }, { id: 'pulse', strength: 'strong' },
  ] },
  { key: 'float', name: 'Handheld float', description: 'A tiny organic sideways and up-and-down drift. Never rotates.', members: [
    { id: 'float-gentle', strength: 'gentle' }, { id: 'float', strength: 'normal' },
  ] },
  // E2–E4 (1.4.288) — need scene analysis.
  { key: 'depth', name: '3D photo', description: 'A push in with real depth: near and far layers move at different rates.', members: [
    { id: 'depth-gentle', strength: 'gentle' }, { id: 'depth', strength: 'normal' }, { id: 'depth-strong', strength: 'strong' },
  ] },
  { key: 'rack-focus', name: 'Rack focus', description: 'The focus slides from the background onto the subject.', members: [
    { id: 'rack-focus-gentle', strength: 'gentle' }, { id: 'rack-focus', strength: 'normal' }, { id: 'rack-focus-strong', strength: 'strong' },
  ] },
  { key: 'subject', name: 'Zoom to subject', description: 'Ken Burns aimed at the picture\'s main subject.', members: [
    { id: 'subject-gentle', strength: 'gentle' }, { id: 'subject', strength: 'normal' }, { id: 'subject-strong', strength: 'strong' },
  ] },
  { key: 'tour', name: 'Guided tour', description: 'One slow move through two or three interesting places.', members: [
    { id: 'tour-slow', strength: 'gentle' }, { id: 'tour', strength: 'normal' },
  ] },
]

const FAMILY_BY_MOTION = new Map(MOTION_FAMILIES.flatMap(f => f.members.map(m => [m.id, f] as const)))

export function motionFamilyOf(id: string): MotionFamily | undefined {
  return FAMILY_BY_MOTION.get(id)
}

/**
 * Motions kept only so old saved choices still render, never offered.
 * `parallax-drift` draws exactly what Pan Right draws (unless an old preset set
 * its direction, which it still honours).
 */
export function isHiddenMotion(motion: string | { id: string } | null | undefined): boolean {
  const id = typeof motion === 'string' ? motion : motion?.id
  return id === 'parallax-drift' || isRotationMotion(motion as any)
}

/**
 * A random pool as the picks it draws from: each family present is ONE slot
 * (holding the strengths ticked), every other motion its own slot, in pool
 * order. A pool with no two strengths of one family gives the same slots, in
 * the same order, as the plain list did.
 */
export function motionPoolSlots(pool: readonly string[]): string[][] {
  const slots: string[][] = []
  const byFamily = new Map<string, string[]>()
  for (const id of pool) {
    const family = FAMILY_BY_MOTION.get(id)
    if (!family) { slots.push([id]); continue }
    const slot = byFamily.get(family.key)
    if (slot) { if (!slot.includes(id)) slot.push(id); continue }
    const fresh = [id]
    byFamily.set(family.key, fresh)
    slots.push(fresh)
  }
  return slots
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
  category: OverlayCategory,
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
    'Black bars top and bottom at 2.35:1. The whole picture shrinks to fit between them, so nothing is hidden.',
    'letterbox', { ratio: '2.35:1' }),

  overlay('letterbox-185', 'Widescreen Bars', 'framing',
    'Shallower 1.85:1 bars. A cinema hint rather than a statement. The whole picture stays visible.',
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

// ── v1.5 effects library: atmosphere, weather and light ─────────────────────
//
// Appended, never interleaved: the thirteen entries above keep their order so
// every picker and every pinned list is unchanged. Each of these is a STARTING
// point — every field is a slider in the Effects Library.

function loop(
  id: string, name: string, category: OverlayCategory, description: string,
  variant: Parameters<typeof defaultAtmosphereLoop>[0], patch: Record<string, unknown> = {},
  extra?: { approximation?: string },
): BuiltInOverlay {
  return overlay(id, name, category, description, 'atmosphere-loop', { ...defaultAtmosphereLoop(variant), ...patch }, extra)
}

BUILT_IN_OVERLAYS.push(
  loop('rain', 'Rain', 'weather',
    'Falling rain in one to three depth layers, slanted by the wind. Darkens the picture a little, like a wet night.',
    'rain'),
  loop('snow', 'Snow', 'weather',
    'Soft flakes that sway as they fall, near flakes larger and faster than far ones.',
    'snow'),
  overlay('lightning-flash', 'Lightning Flash', 'weather',
    'Rare, seeded flashes of the whole picture with a weaker second strike. Picture only — no thunder.',
    'lightning', {}),
  overlay('shimmer-ripple', 'Heat Shimmer / Ripple', 'weather',
    'The picture wavers inside a band — heat over a road, light on water.',
    'heat-shimmer', {}, {
      approximation: 'A displacement of the flat picture. It wobbles what is there; it cannot bend light '
        + 'the way real glass or water refracts it.',
    }),
  loop('ground-mist', 'Fog / Mist', 'atmosphere',
    'Drifting mist, heaviest near the ground. Height, density and drift are all adjustable.',
    'fog', {}, {
      approximation: 'A soft noise layer drawn over the picture. It does not hide distant objects more than '
        + 'near ones — a still has no depth to read.',
    }),
  loop('cloud-shadows', 'Cloud Shadows', 'atmosphere',
    'Slow shadows of passing clouds darkening parts of the scene.',
    'cloud-shadows'),
  loop('dust-motes', 'Dust Motes / Pollen', 'atmosphere',
    'Specks drifting in a beam of light.',
    'dust'),
  loop('petals', 'Petals / Leaves', 'atmosphere',
    'Tumbling petals or leaves. Simple soft shapes, so use them lightly.',
    'petals', {}, {
      approximation: 'Drawn as soft ellipses, not real petal or leaf shapes — they read as petals at a '
        + 'distance and as shapes up close.',
    }),
  loop('fireflies', 'Fireflies', 'light',
    'Small lights that wander and blink, kept to the lower part of the frame by default.',
    'fireflies'),
  loop('bokeh-orbs', 'Bokeh Orbs', 'light',
    'Large out-of-focus lights drifting slowly, in one or two tints.',
    'bokeh', { secondary_color_hex: '#8AB8FF' }),
  loop('embers', 'Embers / Sparks', 'light',
    'Sparks rising and flickering, brightest near the fire.',
    'embers'),
  // 1.4.282 (owner: "i don't see much twinkle") — fewer, larger stars that
  // pulse from full to a tenth of their brightness every 6-12 s. Only these
  // defaults changed; the drawing maths did not, so a saved value renders as
  // before. Amount is a share of 3,000 stars: the old 30 drew 900 tiny specks.
  loop('twinkling-stars', 'Twinkling Stars', 'light',
    'A few bright stars in the sky band that slowly pulse brighter and dimmer. Amount is a share of 3,000 stars, so keep it low.',
    'stars', { amount: 3, size: 2.4, twinkle: 1, speed: 0.75 }),
  loop('light-rays', 'Light Rays / Sun Wash', 'light',
    'Soft beams falling from the top of the frame, gently swaying.',
    'light-rays', {}, {
      approximation: 'A soft wash of beams laid over the picture, not volumetric light: the beams do not '
        + 'wrap around objects in the scene.',
    }),
  overlay('bloom-glow', 'Bloom / Glow', 'light',
    'Bright areas bleed a soft glow, like a lens catching lamplight.',
    'bloom', {}),
  overlay('candle-flicker', 'Candle / Fire Flicker', 'light',
    'The whole picture wavers in brightness like firelight.',
    'flicker', {}),
  overlay('colour-grade-look', 'Colour Grade', 'grade',
    'One of the colour-grade presets plus brightness, contrast, saturation, warmth and tint — per scene or per episode.',
    'color-grade', {}),
  // 1.4.284 — one scene only, and only with an outline of that scene's picture.
  overlay('living-region', 'Living Picture', 'atmosphere',
    'One outlined part of this scene moves — a flame flickers, steam rises, water ripples, the sky drifts, '
      + 'a moon or lamp pulses — while everything outside the outline stays perfectly still. Upload the outline for the scene first.',
    'living-region', {}, {
      approximation: 'The outlined pixels are displaced and brightened in a gentle loop; nothing new is drawn. '
        + 'A flame wobbles and flickers, it does not grow new tongues of fire. On the whole episode or in Video '
        + 'Assembly it moves every scene that has an outline of its name (Outline name, else the motion\'s name).',
    }),
)

// ── E1 (1.4.287): sky, water, glass, paper, film and lens ───────────────────
// Band versions — no scene analysis needed. Appended so every earlier list keeps its order.
BUILT_IN_OVERLAYS.push(
  overlay('shooting-star', 'Shooting Star', 'light',
    'Now and then a star streaks across the sky band — about one every three minutes, at seeded moments and places, never on a fixed loop.',
    'shooting-star', {}),
  loop('aurora', 'Aurora', 'light',
    'Wavy green and violet curtains of light hanging in the top of the frame, slowly swaying.',
    'aurora', { secondary_color_hex: '#B06CFF' }, {
      approximation: 'Drawn in a band across the top of the frame, not cut to the sky: it can pass over a mountain top '
        + 'that reaches into the band.',
    }),
  loop('moon-glow', 'Moonlight Glow', 'light',
    'A large soft cool glow around the moon (or any light high in the frame) that breathes slowly. Move it with Across and Height.',
    'moon-glow'),
  loop('sky-clouds', 'Clouds in the Sky', 'atmosphere',
    'Soft clouds drifting sideways across the top of the frame.',
    'sky-clouds', {}, {
      approximation: 'A band across the top of the frame, not the sky itself: tall things reaching into it are drifted over.',
    }),
  loop('caustics', 'Underwater Caustics', 'light',
    'Rippling bright lines of light, as on a sea floor or a pool wall.',
    'caustics', {}, {
      approximation: 'Laid over the band you choose, not only on water: set the band to where the water is.',
    }),
  loop('window-drops', 'Raindrops on Glass', 'weather',
    'Still beads on a window pane with a few drops sliding down and leaving a trail. Darkens the picture a little.',
    'window-drops', {}, {
      approximation: 'Light beads and trails drawn over the picture; the drops do not bend the picture behind them '
        + 'the way real water on glass does.',
    }),
  loop('paper-texture', 'Parchment / Paper', 'texture',
    'A faint parchment texture of fibres and mottling over the whole picture, for old maps and letters.',
    'paper'),
  loop('film-dust', 'Old Film Dust & Scratches', 'texture',
    'Faint specks that change every frame and a hairline scratch drifting slowly — the marks only, without Aged Archive Film’s grade or weave.',
    'film-dust', { secondary_color_hex: '#F0E8D8' }),
  overlay('halation', 'Halation', 'light',
    'A red-orange glow bleeding from the brightest highlights, like light scattering in film.',
    'bloom', { threshold: 0.75, strength: 0.25, radius_px: 6, color_hex: '#FF6A3D' }),
  overlay('bloom-gentle', 'Gentle Bloom', 'light',
    'A softer version of Bloom / Glow: only the very brightest parts glow, and lightly.',
    'bloom', { threshold: 0.8, strength: 0.15, radius_px: 24 }),
  overlay('water-shimmer', 'Surface Shimmer', 'weather',
    'A gentle shimmer on water in the lower part of the frame.',
    'heat-shimmer', { strength_px: 2, scale: 1.5, region_top: 0.6, region_bottom: 1 }, {
      approximation: 'The whole band shimmers, not only the water in it: set the band to where the water is.',
    }),
  overlay('bedtime-dimming', 'Bedtime Dimming', 'grade',
    'Over a sleep episode the picture slowly gets darker, warmer and a little less colourful — 25% darker by 85% of the episode. '
      + 'Captions and the logo are not dimmed. The preview squeezes the whole dim into 6 seconds.',
    'bedtime-dimming', {}),
)

// ── E4 (1.4.288): effects that follow the picture ───────────────────────────
// The same effects, kept to a part of each picture that scene analysis found (or a hand outline
// of that name). A scene where nothing was found keeps the effect's own band; a Living Picture
// is skipped there. Appended so every earlier list keeps its order.
const FOLLOWS = 'Needs scene analysis (subject and outlines) switched on for the channel. A hand outline of the same name wins.'
BUILT_IN_OVERLAYS.push(
  loop('sky-clouds-real', 'Clouds in the Real Sky', 'atmosphere',
    `Soft clouds drifting across the sky only — never over a mountain, a roof or a person. ${FOLLOWS}`,
    'sky-clouds', { follow: 'sky' }),
  loop('twinkling-stars-sky', 'Twinkling Stars in the Sky', 'light',
    `Twinkling Stars kept to the real sky. ${FOLLOWS}`,
    'stars', { amount: 3, size: 2.4, twinkle: 1, speed: 0.75, follow: 'sky' }),
  overlay('shooting-star-sky', 'Shooting Star in the Sky', 'light',
    `A rare shooting star crossing the real sky. ${FOLLOWS}`,
    'shooting-star', { follow: 'sky' }),
  loop('aurora-sky', 'Aurora in the Sky', 'light',
    `Aurora curtains cut to the real sky. ${FOLLOWS}`,
    'aurora', { secondary_color_hex: '#B06CFF', follow: 'sky' }),
  loop('moon-glow-sky', 'Moonlight Glow in the Sky', 'light',
    `The moonlight glow kept to the sky, so it never washes over the land. ${FOLLOWS}`,
    'moon-glow', { follow: 'sky' }),
  loop('caustics-water', 'Caustics on the Water', 'light',
    `Rippling lines of light on the water only. ${FOLLOWS}`,
    'caustics', { follow: 'water' }),
  overlay('water-shimmer-real', 'Shimmer on the Water', 'weather',
    `A gentle shimmer on the water only — the boat and the reeds stay still. ${FOLLOWS}`,
    'heat-shimmer', { strength_px: 2, scale: 1.5, region_top: 0.6, region_bottom: 1, follow: 'water' }),
  overlay('water-ripples', 'Water Ripples', 'weather',
    `A Living Picture on the water the scene analysis found: it ripples, nothing else moves. ${FOLLOWS}`,
    'living-region', { motion: 'water', follow: 'water' }),
  loop('ground-mist-real', 'Mist along the Ground', 'atmosphere',
    `Drifting mist hugging the line where the sky meets the land. ${FOLLOWS}`,
    'fog', { follow: 'horizon' }),
  loop('fireflies-plants', 'Fireflies among the Plants', 'light',
    `Fireflies kept to the trees and grass. Scenes with no plants found keep the usual fireflies. ${FOLLOWS}`,
    'fireflies', { follow: 'plants' }),
  overlay('flame-found', 'Flicker on Found Flames', 'light',
    `A Living Picture on every flame the scene analysis found: candles and fires flicker, nothing else moves. ${FOLLOWS}`,
    'living-region', { motion: 'flame', follow: 'fire' }),
  overlay('fire-glow-found', 'Firelight round Found Flames', 'light',
    `The glow a found candle or fire throws on the room flickers with it. ${FOLLOWS}`,
    'living-region', { motion: 'fire-glow', follow: 'glow' }),
)

const OVERLAYS_BY_ID = new Map(BUILT_IN_OVERLAYS.map(o => [o.id, o] as const))

// ═══════════════════════════════════════════════════════════════════════════
// Effect stacks — starting presets
// ═══════════════════════════════════════════════════════════════════════════

/** One effect inside a stack preset: a library id plus the fields it changes. */
export interface EffectStackItem {
  id: string
  params?: Record<string, unknown>
}

/**
 * A named stack of effects. Applying one ADDS its effects to the chosen scene
 * or to the whole episode; it never replaces what is there and never decides
 * anything else. Reusable look only — no scene, no episode, no time window.
 */
export interface EffectStackPreset {
  id: string
  name: string
  description: string
  effects: EffectStackItem[]
  builtin?: boolean
}

export const BUILT_IN_EFFECT_STACKS: EffectStackPreset[] = [
  {
    id: 'stack-rainy-night', name: 'Rainy Night', builtin: true,
    description: 'Cool moonlight grade, far fog, two layers of rain, a rare lightning flash, soft vignette and fine grain.',
    effects: [
      { id: 'colour-grade-look', params: { preset: 'cool-moonlight' } },
      { id: 'ground-mist', params: { region_top: 0.1, amount: 35, opacity: 0.35 } },
      { id: 'rain' },
      { id: 'lightning-flash' },
      { id: 'vignette-soft' },
      { id: 'film-grain-fine' },
    ],
  },
  {
    id: 'stack-snowy-cabin', name: 'Snowy Cabin', builtin: true,
    description: 'Warm night grade, gentle snow, candle flicker and a soft vignette.',
    effects: [
      { id: 'colour-grade-look', params: { preset: 'warm-night' } },
      { id: 'snow' },
      { id: 'candle-flicker', params: { amount: 0.03 } },
      { id: 'vignette-soft' },
    ],
  },
  {
    id: 'stack-summer-meadow', name: 'Summer Meadow', builtin: true,
    description: 'Golden-hour grade, light rays, drifting pollen and a little bloom.',
    effects: [
      { id: 'colour-grade-look', params: { preset: 'golden-hour' } },
      { id: 'light-rays' },
      { id: 'dust-motes', params: { beam: 0.2 } },
      { id: 'bloom-glow', params: { strength: 0.25 } },
    ],
  },
  {
    id: 'stack-firelight', name: 'Firelight', builtin: true,
    description: 'Firelight grade, rising embers, flicker and a heavy vignette.',
    effects: [
      { id: 'colour-grade-look', params: { preset: 'firelight' } },
      { id: 'embers' },
      { id: 'candle-flicker' },
      { id: 'vignette-heavy' },
    ],
  },
  {
    id: 'stack-starry-night', name: 'Starry Night', builtin: true,
    description: 'Starlit grade, twinkling stars, fireflies low in the frame and fine grain.',
    effects: [
      { id: 'colour-grade-look', params: { preset: 'starlit-night' } },
      { id: 'twinkling-stars' },
      { id: 'fireflies' },
      { id: 'film-grain-fine' },
    ],
  },
  {
    id: 'stack-misty-morning', name: 'Misty Morning', builtin: true,
    description: 'Misty-morning grade, ground mist, cloud shadows and bloom.',
    effects: [
      { id: 'colour-grade-look', params: { preset: 'misty-morning' } },
      { id: 'cloud-shadows', params: { opacity: 0.25 } },
      { id: 'ground-mist' },
      { id: 'bloom-glow', params: { strength: 0.2 } },
    ],
  },
  {
    id: 'stack-old-film', name: 'Old Film & Grain', builtin: true,
    description: 'Atmospheric old-film patina: fine grain, film dust and scratches, and a soft vignette.',
    effects: [
      { id: 'film-dust' },
      { id: 'film-grain-fine' },
      { id: 'vignette-soft', params: { intensity: 0.6 } },
    ],
  },
]

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
    motion_families: MOTION_FAMILIES,
    footage_motions: BUILT_IN_FOOTAGE_MOTIONS,
    overlays: BUILT_IN_OVERLAYS,
    grouped_overlays: groupedOverlays(),
    effect_stacks: BUILT_IN_EFFECT_STACKS,
  }
}

/** One selected overlay, resolved against the library and ready to compile. */
export interface ResolvedOverlay {
  id: string
  name: string
  approximation?: string
  document: SceneOverlayDocument
}

/**
 * A selected overlay the library could not produce.
 *
 * `from_content_pack` is the difference that matters. A bare unknown id is a
 * hand-edited or ancient config and has always been survivable; a QUALIFIED id
 * can only be there because a content pack put it there, which means the pack
 * has since been uninstalled, disabled or recalled. Rendering the episode
 * without it would publish a video missing a look the customer chose, so the
 * two cases are reported separately and treated differently — see
 * `assertNoUnavailablePackOverlays`.
 */
export interface UnavailableOverlay {
  id: string
  from_content_pack: boolean
}

/**
 * Thrown when a render would otherwise silently drop a content-pack effect.
 *
 * One class for both engines: a camera move and an overlay fail for the same
 * reason and are repaired the same way, and two error types would mean two
 * places for a caller to forget one.
 */
export class MissingPackEffectError extends Error {
  readonly effectIds: string[]
  constructor(message: string, effectIds: string[]) {
    super(message)
    this.name = 'MissingPackEffectError'
    this.effectIds = effectIds
  }
}

/**
 * Refuse to render when a content-pack effect the episode uses is gone.
 *
 * AGENTS.md' Verified Completion Contract: a required item that is missing
 * fails the whole job loudly, names what is missing, and says how to repair it.
 * The alternative — carrying on and noting it in the log — hands the customer a
 * finished video that quietly lacks something they configured, which is exactly
 * the "silent fallback" the pack design forbids.
 *
 * The owning pack id is deliberately NOT guessed. An item id names its
 * publisher, not its pack, so the publisher is all the message can honestly
 * offer, and it is enough to find the pack in the Studio Library.
 */
export function assertNoUnavailablePackOverlays(unavailable: readonly UnavailableOverlay[]): void {
  const fromPacks = unavailable.filter(entry => entry.from_content_pack)
  if (!fromPacks.length) return
  const named = fromPacks.map(entry => {
    const publisher = entry.id.split('.').slice(0, 2).join('.')
    return `"${entry.id}" (published by ${publisher})`
  })
  throw new MissingPackEffectError(
    `This episode uses ${named.length === 1 ? 'an effect' : 'effects'} from a Content Pack that is not installed: `
    + `${named.join(', ')}. Rendering now would publish the video without ${named.length === 1 ? 'it' : 'them'}. `
    + 'Reinstall the pack from the Studio Library, or remove the effect from the Video Assembly effect stack, then run this job again — '
    + 'no completed work is repeated.',
    fromPacks.map(entry => entry.id),
  )
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
 * An id this build does not have is SKIPPED and REPORTED here rather than
 * throwing, because resolution has no way to tell a hand-edited config from an
 * uninstalled pack. The caller makes that call: `unavailable` marks which ids
 * are qualified pack ids, and `assertNoUnavailablePackOverlays` turns those
 * into a loud refusal. A bare unknown id stays survivable, as it has been since
 * v1.2.0.
 *
 * `library` defaults to the built-ins so every existing caller is unchanged with
 * zero packs installed. `services/style-effect-loader.ts` passes the merged
 * built-in + installed-pack library.
 */
export function resolveAppliedOverlays(
  config: {
    enabled?: boolean
    overlays?: Array<{ id: string; enabled?: boolean; params?: Record<string, unknown> }>
  } | null | undefined,
  library: readonly BuiltInOverlay[] = BUILT_IN_OVERLAYS,
): { resolved: ResolvedOverlay[]; unavailable: UnavailableOverlay[] } {
  const resolved: ResolvedOverlay[] = []
  const unavailable: UnavailableOverlay[] = []
  if (!config || config.enabled === false || !Array.isArray(config.overlays)) {
    return { resolved, unavailable }
  }
  for (const applied of config.overlays) {
    if (!applied || applied.enabled === false) continue
    const entry = library.find(candidate => candidate.id === applied.id)
    if (!entry) {
      const id = String(applied?.id ?? '(unnamed)')
      unavailable.push({ id, from_content_pack: isContentPackItemId(id) })
      continue
    }
    resolved.push({
      id: entry.id,
      name: entry.name,
      ...(entry.approximation ? { approximation: entry.approximation } : {}),
      document: applied.params
        ? normalizeSceneOverlay({ ...entry.document, ...applied.params, kind: entry.document.kind })
        : entry.document,
    })
  }
  return { resolved, unavailable }
}
