/**
 * The built-in reveal library — the pool a randomised episode draws from, and
 * the presets the picker offers.
 *
 * DATA, in one module, exactly like `scene-effect-presets.ts`: an entry is a
 * document and nothing more, which is the same shape a downloaded Content Pack
 * will carry (`kind: 'reveal'`). If a look cannot be expressed here, the engine
 * is missing a FIELD — the answer is to add the field, never to special-case a
 * name in the compiler.
 *
 * `approximation` is filled in wherever FFmpeg cannot do the thing the name
 * promises, and the UI shows it. This repo's rule: an effect that quietly
 * renders something other than its name is worse than one that says what it
 * actually does.
 */

import {
  defaultSceneReveal,
  mergeSceneReveal,
  type SceneRevealDocument,
  type SceneRevealPatch,
} from './scene-reveal.js'

export interface BuiltInReveal {
  id: string
  name: string
  /** The family this preset belongs to; the picker groups by it. */
  family: SceneRevealDocument['family']
  description: string
  /** Filled in only where the render differs from what the name implies. */
  approximation?: string
  document: SceneRevealDocument
}

function reveal(
  id: string,
  name: string,
  description: string,
  patch: SceneRevealPatch,
  extra?: { approximation?: string },
): BuiltInReveal {
  const document = mergeSceneReveal(defaultSceneReveal(), patch)
  return {
    id,
    name,
    family: document.family,
    description,
    ...(extra?.approximation ? { approximation: extra.approximation } : {}),
    document,
  }
}

/** A geometric wipe out of a flat colour — the default family's shape. */
function wipe(
  id: string,
  name: string,
  transition: string,
  description: string,
  extra?: { colour?: string; treatment?: 'blur' | 'darken'; approximation?: string; drift?: number },
): BuiltInReveal {
  return reveal(id, name, description, {
    family: 'geometric',
    transition,
    field: {
      mode: extra?.treatment ? 'image' : 'colour',
      colour: extra?.colour ?? '#0b0d10',
      treatment: extra?.treatment ?? 'none',
      amount_pct: extra?.treatment === 'blur' ? 45 : 60,
    },
    hold: { drift_pct: extra?.drift ?? 4, drift_direction: 'in', micro_events: 1 },
  }, extra?.approximation ? { approximation: extra.approximation } : undefined)
}

// ── Geometric wipes — the default pool ──────────────────────────────────────

export const BUILT_IN_SCENE_REVEALS: BuiltInReveal[] = [
  wipe('reveal-rows', 'Rows', 'hlslice',
    'Horizontal bands sweep across and the picture assembles behind them.'),
  wipe('reveal-columns', 'Columns', 'vdslice',
    'Vertical bands sweep down the frame — the calmest of the set.'),
  wipe('reveal-diagonal', 'Diagonal', 'diagtl',
    'A corner-to-corner sweep. Reads as decisive; good on a first scene.'),
  wipe('reveal-centre', 'Centre Out', 'circleopen',
    'Opens from the middle of the frame outward, so the subject arrives first.'),
  wipe('reveal-curtain', 'Curtain', 'vertopen',
    'Parts from a vertical line at the centre, like a curtain.'),
  wipe('reveal-radial', 'Radial', 'radial',
    'A rotating radial sweep — the most stylised of the default pool.'),

  // Lights-up: the picture is already there, dark, and comes up. Slower and
  // more formal than a wipe, and the one to use when the image is the subject.
  wipe('reveal-lights-up', 'Lights Up', 'fadeblack',
    'The frame is the same picture, dark, and the light comes up on it. Formal and quiet.',
    { treatment: 'darken', colour: '#000000', drift: 5 }),

  // ── Available, outside the default pool ───────────────────────────────────
  wipe('reveal-sweep', 'Soft Sweep', 'smoothleft', 'A soft-edged horizontal sweep.'),
  wipe('reveal-slices', 'Fine Slices', 'hrslice', 'Thin horizontal slices, right to left.'),
  wipe('reveal-hinge', 'Hinge', 'horzopen', 'Opens from a horizontal line at the centre.'),
  wipe('reveal-crop', 'Crop Open', 'rectcrop', 'A rectangle grows from the centre.'),
  wipe('reveal-mosaic', 'Mosaic', 'pixelize', 'A pixel mosaic resolves into the picture.'),
  wipe('reveal-blur-in', 'Blur In', 'hblur',
    'A horizontal blur resolves. The softest entrance here.',
    { treatment: 'blur', approximation: 'This is a blur resolve, not a focus pull: '
      + 'FFmpeg\'s xfade blurs uniformly along one axis, so it cannot imitate a lens '
      + 'bringing one plane into focus.' }),
  wipe('reveal-dissolve', 'Dissolve', 'dissolve',
    'A grainy dissolve out of the field colour.'),
  wipe('reveal-white', 'White Flash', 'fadewhite',
    'Fades up through white — strong, and best used once an episode.'),

  // ── Palette layers ────────────────────────────────────────────────────────
  reveal('reveal-palette-dawn', 'Palette — Dawn',
    'Two colour layers sweep off the flattened frame before the real colour arrives.',
    {
      family: 'palette',
      transition: 'wipe-left',
      field: { mode: 'image', colour: '#1b2a4a', treatment: 'duotone', amount_pct: 80 },
      layers: [
        { colour: '#e8a13a', transition: 'wipe-up', share_pct: 55 },
        { colour: '#f6e7c8', transition: 'diagtr', share_pct: 45 },
      ],
      hold: { drift_pct: 5, drift_direction: 'in', micro_events: 1 },
    }),
  reveal('reveal-palette-ink', 'Palette — Ink',
    'Ink and cream sweep away to reveal the picture underneath.',
    {
      family: 'palette',
      transition: 'wipe-right',
      field: { mode: 'image', colour: '#0a0a0a', treatment: 'duotone', amount_pct: 90 },
      layers: [
        { colour: '#111418', transition: 'vdslice', share_pct: 50 },
        { colour: '#efe7d8', transition: 'smoothright', share_pct: 50 },
      ],
      hold: { drift_pct: 4, drift_direction: 'out', micro_events: 1 },
    }),
  reveal('reveal-palette-ember', 'Palette — Ember',
    'A single warm layer burns off the frame, then the picture.',
    {
      family: 'palette',
      transition: 'radial',
      field: { mode: 'image', colour: '#2a0f08', treatment: 'darken', amount_pct: 70 },
      layers: [{ colour: '#c8501e', transition: 'circleopen', share_pct: 100 }],
      hold: { drift_pct: 6, drift_direction: 'in', micro_events: 2 },
    }),

  // ── Draw-on ───────────────────────────────────────────────────────────────
  reveal('reveal-draw-on', 'Draw-On',
    'A directional ink pass over line art: the drawing appears as the stroke crosses it.',
    {
      family: 'draw-on',
      transition: 'diagtl',
      field: { mode: 'colour', colour: '#f7f3ea', treatment: 'none', amount_pct: 100 },
      hold: { drift_pct: 3, drift_direction: 'in', micro_events: 0 },
    },
    {
      approximation: 'This is a directional wipe across the line art, not a stroke-ordered '
        + 'draw: reproducing the order a hand would draw the lines needs a vector trace of the '
        + 'image first (potrace-style), which this version does not do. It reads correctly on '
        + 'line art and says so here rather than pretending.',
    }),
]

const REVEALS_BY_ID = new Map(BUILT_IN_SCENE_REVEALS.map(entry => [entry.id, entry] as const))

export function builtInReveal(id: string): BuiltInReveal | undefined {
  return REVEALS_BY_ID.get(id)
}

/**
 * The default pool: the six geometric wipes the design names as reading well on
 * photoreal frames. Order is the falling-back order too — `reveal-rows` is what
 * a scene gets when the pool is empty or every pick is capped out.
 */
export const DEFAULT_REVEAL_POOL: string[] = [
  'reveal-rows',
  'reveal-columns',
  'reveal-diagonal',
  'reveal-centre',
  'reveal-curtain',
  'reveal-radial',
]

export const DEFAULT_REVEAL_ID = 'reveal-rows'
