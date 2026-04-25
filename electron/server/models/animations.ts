/**
 * Scene animation registry — every motion the video assembler can apply
 * to an individual scene image while it's on screen. Mirrors transitions.ts
 * in shape so the frontend's AnimationPicker can use the same pattern.
 *
 * The filter strings themselves live in lib/animation-filters.ts — this file
 * is only the user-facing catalog.
 */

export type AnimationCategory = 'zoom' | 'pan' | 'ambient' | 'rotate' | 'effect' | 'static'

export interface AnimationDef {
  id: string
  label: string
  category: AnimationCategory
  hint?: string
}

export const ANIMATIONS: AnimationDef[] = [
  // ── Zoom ────────────────────────────────────────────────────────────────
  { id: 'ken-burns',         label: 'Ken Burns',         category: 'zoom',   hint: 'Classic documentary slow zoom' },
  { id: 'ken-burns-reverse', label: 'Ken Burns Reverse', category: 'zoom',   hint: 'Starts zoomed in, slowly pulls back — reveals the wider frame' },
  { id: 'zoom-in',           label: 'Zoom In',           category: 'zoom',   hint: 'Straight zoom from 100% to 112%' },
  { id: 'zoom-out',          label: 'Zoom Out',          category: 'zoom',   hint: 'Pull back from 112% to 100%' },
  { id: 'slow-push',         label: 'Slow Push',         category: 'zoom',   hint: 'Gentler zoom-in (100% → 106%) — subtle drift toward subject' },
  { id: 'slow-pull',         label: 'Slow Pull',         category: 'zoom',   hint: 'Gentler zoom-out (106% → 100%) — subtle drift away' },
  { id: 'dolly-in',          label: 'Dolly In',          category: 'zoom',   hint: 'Slow zoom with a gentle downward tilt' },

  // ── Pan ─────────────────────────────────────────────────────────────────
  { id: 'parallax-drift',label: 'Parallax Drift', category: 'pan',    hint: 'Slow directional pan (configurable direction)' },
  { id: 'pan-left',      label: 'Pan Left',       category: 'pan' },
  { id: 'pan-right',     label: 'Pan Right',      category: 'pan' },
  { id: 'pan-up',        label: 'Pan Up',         category: 'pan' },
  { id: 'pan-down',      label: 'Pan Down',       category: 'pan' },
  { id: 'pan-diag-tl',   label: 'Pan Diagonal TL', category: 'pan',  hint: 'Slow pan up and to the left' },
  { id: 'pan-diag-tr',   label: 'Pan Diagonal TR', category: 'pan',  hint: 'Slow pan up and to the right' },
  { id: 'pan-diag-bl',   label: 'Pan Diagonal BL', category: 'pan',  hint: 'Slow pan down and to the left' },
  { id: 'pan-diag-br',   label: 'Pan Diagonal BR', category: 'pan',  hint: 'Slow pan down and to the right' },

  // ── Ambient ─────────────────────────────────────────────────────────────
  { id: 'breathe',       label: 'Breathe',        category: 'ambient', hint: 'Gentle sine-wave pulse zoom' },
  { id: 'pulse',         label: 'Pulse',          category: 'ambient', hint: 'More pronounced breathing rhythm' },

  // ── Rotate ──────────────────────────────────────────────────────────────
  { id: 'rotate-cw',     label: 'Rotate CW',      category: 'rotate',  hint: 'Subtle clockwise drift' },
  { id: 'rotate-ccw',    label: 'Rotate CCW',     category: 'rotate',  hint: 'Subtle counter-clockwise drift' },

  // ── Effect ──────────────────────────────────────────────────────────────
  { id: 'fade-in',       label: 'Fade In',        category: 'effect',  hint: 'Scene fades up from black' },
  { id: 'fade-out',      label: 'Fade Out',       category: 'effect',  hint: 'Scene fades down to black at the end' },
  { id: 'blur-focus',    label: 'Blur → Focus',   category: 'effect',  hint: 'Starts blurred, comes into focus' },

  // ── Static ──────────────────────────────────────────────────────────────
  { id: 'none',          label: 'None (static)',  category: 'static',  hint: 'No motion — fastest render' },
]

const BY_ID = new Map<string, AnimationDef>(ANIMATIONS.map(a => [a.id, a] as const))

export function getAnimation(id: string | undefined | null): AnimationDef | null {
  if (!id) return null
  return BY_ID.get(id) || null
}

export function groupedAnimations(): Record<AnimationCategory, AnimationDef[]> {
  const out: Record<AnimationCategory, AnimationDef[]> = {
    zoom: [], pan: [], ambient: [], rotate: [], effect: [], static: [],
  }
  for (const a of ANIMATIONS) out[a.category].push(a)
  return out
}
