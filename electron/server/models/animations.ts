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

import { BUILT_IN_SCENE_MOTIONS, type BuiltInMotion } from '../contracts/scene-effect-presets.js'
import type { ContentOrigin } from '../contracts/content-origin.js'
import type { SceneMotionCategory } from '../contracts/scene-effects.js'

/**
 * v1.2.1 — the app-owned category list, sourced from the contract module rather
 * than restated here. A content pack picks one of these; it cannot invent a
 * seventh section of the picker, because a new section is engine behaviour.
 */
export type AnimationCategory = SceneMotionCategory

export interface AnimationDef {
  id: string
  label: string
  category: AnimationCategory
  hint?: string
  /** Honest note about what FFmpeg cannot render exactly. Shown in the UI. */
  approximation?: string
  /** v1.2.1 — absent for the app's own moves, set for a move from a pack. */
  origin?: ContentOrigin
}

/**
 * Project one registry entry into the picker's shape.
 *
 * Exported in v1.2.1 so the catalogue route can project the MERGED built-in +
 * installed-pack registry through this same function instead of growing a
 * second copy of the mapping beside it.
 */
export function toAnimationDef(motion: BuiltInMotion & { origin?: ContentOrigin }): AnimationDef {
  return {
    id: motion.id,
    label: motion.name,
    category: motion.category as AnimationCategory,
    hint: motion.description,
    ...(motion.approximation ? { approximation: motion.approximation } : {}),
    ...(motion.origin ? { origin: motion.origin } : {}),
  }
}

export const ANIMATIONS: AnimationDef[] = BUILT_IN_SCENE_MOTIONS.map(toAnimationDef)

const BY_ID = new Map<string, AnimationDef>(ANIMATIONS.map(a => [a.id, a] as const))

export function getAnimation(id: string | undefined | null): AnimationDef | null {
  if (!id) return null
  return BY_ID.get(id) || null
}

export function groupAnimationDefs(animations: readonly AnimationDef[]): Record<AnimationCategory, AnimationDef[]> {
  const out: Record<AnimationCategory, AnimationDef[]> = {
    zoom: [], pan: [], ambient: [], rotate: [], effect: [], static: [],
  }
  // A pack's category is validated against this same list at install time, so
  // an entry can only land in a bucket that exists — but a lookup that could
  // ever be `undefined` is worth one guard rather than a throw inside a route.
  for (const animation of animations) out[animation.category]?.push(animation)
  return out
}

export function groupedAnimations(): Record<AnimationCategory, AnimationDef[]> {
  return groupAnimationDefs(ANIMATIONS)
}
