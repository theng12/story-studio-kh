/**
 * Transitions registry — single source of truth for every scene-to-scene
 * transition the video assembly step can produce. Keep this aligned with
 * FFmpeg's xfade filter: https://ffmpeg.org/ffmpeg-filters.html#xfade
 *
 * The frontend pulls this list via GET /video-editor/transitions/catalog
 * and the renderer pulls it via imports, so both ends stay in sync.
 */

export type TransitionCategory = 'fade' | 'wipe' | 'slide' | 'shape' | 'effect'

export interface TransitionDef {
  /** Stable id used in presets and request payloads. */
  id: string
  /** Human label shown in the picker. */
  label: string
  /** The exact xfade transition keyword passed to FFmpeg. */
  xfade: string
  /** Category — drives the tab layout in the picker. */
  category: TransitionCategory
  /** Optional short blurb, surfaced as a tooltip. */
  hint?: string
  /**
   * E1 (1.4.287) — how a boundary is drawn when it is more than one xfade keyword. Absent = plain
   * `xfade`. `xfade` stays the keyword every path falls back to (a preview builder that does not
   * know the engine, or a chunk whose engine graph fails).
   *   - `clip-ramp`: the two clips are shaped at the boundary (a blur toward the midpoint, or a dip
   *     to black with a held black) and then crossfaded.
   *   - `matte`: the new scene spreads over the old through a baked grey matte (`bleed`).
   */
  engine?: 'clip-ramp' | 'matte'
  ramp?: 'blur' | 'dip'
  bleed?: 'ink' | 'watercolour'
}

export const TRANSITIONS: TransitionDef[] = [
  // ── Fade family ───────────────────────────────────────────────────────────
  { id: 'crossfade',   label: 'Crossfade',      xfade: 'fade',        category: 'fade',   hint: 'Classic A→B crossfade' },
  { id: 'fade-fast',   label: 'Crossfade (fast)', xfade: 'fadefast',  category: 'fade',   hint: 'Faster-curve crossfade — snappier cut feel' },
  { id: 'fade-slow',   label: 'Crossfade (slow)', xfade: 'fadeslow',  category: 'fade',   hint: 'Slower-curve crossfade — more deliberate drift' },
  { id: 'fade-black',  label: 'Fade to Black',  xfade: 'fadeblack',   category: 'fade',   hint: 'Fades out to black, then in to next scene' },
  { id: 'fade-white',  label: 'Fade to White',  xfade: 'fadewhite',   category: 'fade',   hint: 'Fades out to white, then in to next scene' },
  { id: 'fade-grays',  label: 'Fade through Gray', xfade: 'fadegrays', category: 'fade',  hint: 'Desaturates during the transition, then re-colors' },
  { id: 'distance',    label: 'Distance',       xfade: 'distance',    category: 'fade',   hint: 'Color-distance morph' },
  { id: 'dissolve',    label: 'Dissolve',       xfade: 'dissolve',    category: 'fade',   hint: 'Grainy dissolve between frames' },
  { id: 'pixelize',    label: 'Pixelize',       xfade: 'pixelize',    category: 'fade',   hint: 'Pixel mosaic grows, then shrinks on the next scene' },
  { id: 'hblur',       label: 'Blur',           xfade: 'hblur',       category: 'fade',   hint: 'Horizontal blur morph' },
  // E1 (1.4.287)
  { id: 'blur-dissolve', label: 'Soft Blur Dissolve', xfade: 'fade', category: 'fade', engine: 'clip-ramp', ramp: 'blur',
    hint: 'Both scenes go soft toward the middle of the crossfade, then the new one sharpens' },
  { id: 'dip-black', label: 'Dip to Black', xfade: 'fadeblack', category: 'fade', engine: 'clip-ramp', ramp: 'dip',
    hint: 'Fades to black, holds black for 0.3 s, then fades up on the next scene' },
  { id: 'ink-bleed', label: 'Ink Bleed', xfade: 'fade', category: 'effect', engine: 'matte', bleed: 'ink',
    hint: 'The next scene spreads over the last like ink in water — sharp, branching edges' },
  { id: 'watercolour-bleed', label: 'Watercolour Bleed', xfade: 'fade', category: 'effect', engine: 'matte', bleed: 'watercolour',
    hint: 'The next scene blooms over the last like wet watercolour — soft edges' },

  // ── Wipe family ───────────────────────────────────────────────────────────
  { id: 'wipe-left',   label: 'Wipe Left',      xfade: 'wipeleft',    category: 'wipe' },
  { id: 'wipe-right',  label: 'Wipe Right',     xfade: 'wiperight',   category: 'wipe' },
  { id: 'wipe-up',     label: 'Wipe Up',        xfade: 'wipeup',      category: 'wipe' },
  { id: 'wipe-down',   label: 'Wipe Down',      xfade: 'wipedown',    category: 'wipe' },
  { id: 'wipe-tl',     label: 'Wipe Top-Left',  xfade: 'wipetl',      category: 'wipe' },
  { id: 'wipe-tr',     label: 'Wipe Top-Right', xfade: 'wipetr',      category: 'wipe' },
  { id: 'wipe-bl',     label: 'Wipe Btm-Left',  xfade: 'wipebl',      category: 'wipe' },
  { id: 'wipe-br',     label: 'Wipe Btm-Right', xfade: 'wipebr',      category: 'wipe' },
  { id: 'diag-tl',     label: 'Diagonal TL',    xfade: 'diagtl',      category: 'wipe' },
  { id: 'diag-tr',     label: 'Diagonal TR',    xfade: 'diagtr',      category: 'wipe' },
  { id: 'diag-bl',     label: 'Diagonal BL',    xfade: 'diagbl',      category: 'wipe' },
  { id: 'diag-br',     label: 'Diagonal BR',    xfade: 'diagbr',      category: 'wipe' },
  { id: 'smooth-left', label: 'Smooth Left',    xfade: 'smoothleft',  category: 'wipe',   hint: 'Softer-edged wipe' },
  { id: 'smooth-right',label: 'Smooth Right',   xfade: 'smoothright', category: 'wipe' },
  { id: 'smooth-up',   label: 'Smooth Up',      xfade: 'smoothup',    category: 'wipe' },
  { id: 'smooth-down', label: 'Smooth Down',    xfade: 'smoothdown',  category: 'wipe' },
  { id: 'hlslice',     label: 'Horizontal Slice L→R', xfade: 'hlslice', category: 'wipe' },
  { id: 'hrslice',     label: 'Horizontal Slice R→L', xfade: 'hrslice', category: 'wipe' },
  { id: 'vuslice',     label: 'Vertical Slice B→T',   xfade: 'vuslice', category: 'wipe' },
  { id: 'vdslice',     label: 'Vertical Slice T→B',   xfade: 'vdslice', category: 'wipe' },

  // ── Slide family ──────────────────────────────────────────────────────────
  { id: 'slide-left',  label: 'Slide Left',     xfade: 'slideleft',   category: 'slide' },
  { id: 'slide-right', label: 'Slide Right',    xfade: 'slideright',  category: 'slide' },
  { id: 'slide-up',    label: 'Slide Up',       xfade: 'slideup',     category: 'slide' },
  { id: 'slide-down',  label: 'Slide Down',     xfade: 'slidedown',   category: 'slide' },
  { id: 'squeeze-h',   label: 'Squeeze Horizontal', xfade: 'squeezeh', category: 'slide' },
  { id: 'squeeze-v',   label: 'Squeeze Vertical',   xfade: 'squeezev', category: 'slide' },
  // Cover: next scene slides in ON TOP of the previous (previous stays put)
  { id: 'cover-left',  label: 'Cover Left',     xfade: 'coverleft',   category: 'slide',  hint: 'Next scene slides in from the right, covering the prior' },
  { id: 'cover-right', label: 'Cover Right',    xfade: 'coverright',  category: 'slide' },
  { id: 'cover-up',    label: 'Cover Up',       xfade: 'coverup',     category: 'slide' },
  { id: 'cover-down',  label: 'Cover Down',     xfade: 'coverdown',   category: 'slide' },
  // Reveal: previous scene slides OFF to expose the next (next stays put)
  { id: 'reveal-left', label: 'Reveal Left',    xfade: 'revealleft',  category: 'slide',  hint: 'Prior scene slides off to the left, revealing the next' },
  { id: 'reveal-right',label: 'Reveal Right',   xfade: 'revealright', category: 'slide' },
  { id: 'reveal-up',   label: 'Reveal Up',      xfade: 'revealup',    category: 'slide' },
  { id: 'reveal-down', label: 'Reveal Down',    xfade: 'revealdown',  category: 'slide' },

  // ── Shape family ──────────────────────────────────────────────────────────
  { id: 'circle-open', label: 'Circle Open',    xfade: 'circleopen',  category: 'shape' },
  { id: 'circle-close',label: 'Circle Close',   xfade: 'circleclose', category: 'shape' },
  { id: 'circle-crop', label: 'Circle Crop',    xfade: 'circlecrop',  category: 'shape' },
  { id: 'rect-crop',   label: 'Rectangle Crop', xfade: 'rectcrop',    category: 'shape' },
  { id: 'radial',      label: 'Radial',         xfade: 'radial',      category: 'shape' },
  { id: 'vert-open',   label: 'Vertical Open',  xfade: 'vertopen',    category: 'shape',  hint: 'Scene opens from a vertical line at center' },
  { id: 'vert-close',  label: 'Vertical Close', xfade: 'vertclose',   category: 'shape',  hint: 'Scene closes to a vertical line at center' },
  { id: 'horz-open',   label: 'Horizontal Open', xfade: 'horzopen',   category: 'shape',  hint: 'Scene opens from a horizontal line at center' },
  { id: 'horz-close',  label: 'Horizontal Close', xfade: 'horzclose', category: 'shape',  hint: 'Scene closes to a horizontal line at center' },

  // ── Effect family ─────────────────────────────────────────────────────────
  { id: 'zoom-in',     label: 'Zoom In',        xfade: 'zoomin',      category: 'effect', hint: 'Next scene zooms in over the previous one' },
  { id: 'wind-left',   label: 'Wind Left',      xfade: 'hlwind',      category: 'effect', hint: 'Windblown left-to-right streak' },
  { id: 'wind-right',  label: 'Wind Right',     xfade: 'hrwind',      category: 'effect', hint: 'Windblown right-to-left streak' },
  { id: 'wind-up',     label: 'Wind Up',        xfade: 'vuwind',      category: 'effect', hint: 'Windblown bottom-to-top streak' },
  { id: 'wind-down',   label: 'Wind Down',      xfade: 'vdwind',      category: 'effect', hint: 'Windblown top-to-bottom streak' },
]

export const NONE_TRANSITION: TransitionDef = {
  id: 'none',
  label: 'Hard Cut',
  xfade: '',
  category: 'fade',
  hint: 'No blend — direct cut. Fastest render.',
}

const TRANSITION_BY_ID = new Map<string, TransitionDef>([
  ...TRANSITIONS.map(t => [t.id, t] as const),
  [NONE_TRANSITION.id, NONE_TRANSITION],
])

// Legacy id aliases from earlier releases; keep the old ids working.
const LEGACY_ALIASES: Record<string, string> = {
  wipeleft: 'wipe-left',
  wiperight: 'wipe-right',
}

/** Resolve a transition id (including legacy aliases) to its def, or null. */
export function getTransition(id: string | undefined | null): TransitionDef | null {
  if (!id) return null
  const direct = TRANSITION_BY_ID.get(id)
  if (direct) return direct
  const aliased = LEGACY_ALIASES[id]
  if (aliased) return TRANSITION_BY_ID.get(aliased) || null
  return null
}

/** All transitions grouped by category in deterministic order, for the UI catalog. */
export function groupedTransitions(): Record<TransitionCategory, TransitionDef[]> {
  const out: Record<TransitionCategory, TransitionDef[]> = {
    fade: [], wipe: [], slide: [], shape: [], effect: [],
  }
  for (const t of TRANSITIONS) out[t.category].push(t)
  return out
}
