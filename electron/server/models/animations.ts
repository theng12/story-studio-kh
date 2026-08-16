/**
 * Scene animation registry — every motion the video assembler can apply to an
 * individual scene image while it's on screen. Mirrors transitions.ts in shape
 * so the frontend's AnimationPicker can use the same pattern.
 *
 * v1.2.0: this is now a PROJECTION of the declarative registry in
 * `contracts/scene-effect-presets.ts`, not a second list beside it. Adding an
 * animation means adding a document there; the catalogue, the picker and the
 * filter builder all follow. `approximation` is carried through so the UI can
 * say plainly where FFmpeg cannot do what a name promises.
 */

import { BUILT_IN_SCENE_MOTIONS } from '../contracts/scene-effect-presets.js'

export type AnimationCategory = 'zoom' | 'pan' | 'ambient' | 'rotate' | 'effect' | 'static'

export interface AnimationDef {
  id: string
  label: string
  category: AnimationCategory
  hint?: string
  /** Honest note about what FFmpeg cannot render exactly. Shown in the UI. */
  approximation?: string
}

export const ANIMATIONS: AnimationDef[] = BUILT_IN_SCENE_MOTIONS.map(m => ({
  id: m.id,
  label: m.name,
  category: m.category as AnimationCategory,
  hint: m.description,
  ...(m.approximation ? { approximation: m.approximation } : {}),
}))

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
