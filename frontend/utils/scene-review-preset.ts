/**
 * The Scene Review preset's exact body (AGENTS.md §5).
 *
 * The preset is REUSABLE RENDER SETTINGS ONLY: which model, which aspect
 * ratio, which seed, whether generated images are auto-approved. The
 * "Reference to Image" character selection is episode state — it names specific
 * characters of one episode — so it is never captured and never applied. These
 * two functions are the whole boundary, which is why they live here instead of
 * inside the page: a test can drive the real composable through them.
 */

export interface SceneReviewPresetForm {
  model: string
  aspect_ratio: string
  seed: string | number
}

export interface SceneReviewPresetData extends SceneReviewPresetForm {
  auto_approve_generated: boolean
}

/** Exactly the fields a Scene Review preset may carry. Nothing else, ever. */
export const SCENE_REVIEW_PRESET_KEYS = ['model', 'aspect_ratio', 'seed', 'auto_approve_generated'] as const

export function sceneReviewPresetSnapshot(
  state: SceneReviewPresetForm & { auto_approve_generated: boolean },
): SceneReviewPresetData {
  return {
    model: state.model,
    aspect_ratio: state.aspect_ratio,
    seed: state.seed,
    auto_approve_generated: state.auto_approve_generated,
  }
}

/**
 * Apply a stored preset — possibly one hand-edited to carry an episode field —
 * to the live form. Only the four reusable keys are read; anything else in the
 * body is ignored, so a preset can never move the reference selection or any
 * other episode-owned state.
 */
export function sceneReviewPresetApply(
  current: SceneReviewPresetForm,
  data: Record<string, unknown> | null | undefined,
): SceneReviewPresetForm & { auto_approve_generated: boolean } {
  return {
    model: typeof data?.model === 'string' ? data.model : current.model,
    aspect_ratio: typeof data?.aspect_ratio === 'string' ? data.aspect_ratio : current.aspect_ratio,
    seed: typeof data?.seed === 'string' || typeof data?.seed === 'number' ? data.seed : current.seed,
    // Absent means "not saved", which keeps the owner's default-on (2026-10-25)
    // rather than silently flipping it off.
    auto_approve_generated: data?.auto_approve_generated !== false,
  }
}
