/** Pure Motion Review decisions, separated so behaviour is tested without mounting the page. */

export interface MotionBatchScene {
  approved: boolean
  image_filename: string | null
  motion_prompt?: string
  clip_exists?: boolean
  clip_stale?: boolean
  motion_choice?: 'pending' | 'clip' | 'still'
  start_sec: number
  end_sec: number
}

export interface MotionBatchContext {
  isSketchDraw: boolean
  scoped: boolean
  animateMinSeconds: number
  imagePool: boolean
}

/** The same rule the route and generator apply before a batch can include a scene. */
export function motionBatchEligible(scene: MotionBatchScene, context: MotionBatchContext): boolean {
  return !context.imagePool
    && context.scoped
    && scene.approved
    && !!scene.image_filename
    && (context.isSketchDraw || !!scene.motion_prompt?.trim())
    && (context.isSketchDraw ? (!scene.clip_exists || !!scene.clip_stale) : !scene.clip_exists)
    && scene.motion_choice !== 'still'
    && scene.end_sec - scene.start_sec >= context.animateMinSeconds
}

/** Sketch Draw needs a saved pen, and a logo pen only when the channel actually has one. */
export function sketchSelectionReady(input: {
  loaded: boolean
  saving: boolean
  pen: 'none' | 'plain' | 'name' | 'logo'
  hasLogo: boolean
}): boolean {
  return input.loaded && !input.saving && (input.pen !== 'logo' || input.hasLogo)
}
