/**
 * The free scene-image quality check's dated policy (owner 2026-10-26),
 * shared by the server and the page that shows the switch.
 *
 * Zero-dependency: also imported by the frontend runtime, so both sides agree
 * on WHEN the auto-remake switch unlocks without either keeping its own copy.
 */
export const SCENE_IMAGE_CHECK_SHADOW_START = '2026-10-27T00:00:00.000Z'
export const SCENE_IMAGE_CHECK_SHADOW_DAYS = 14

/** True once the 2-week shadow phase is over, so the auto-remake switch may be turned on. */
export function sceneImageCheckShadowOver(startedAt: string, now = Date.now()): boolean {
  const started = Date.parse(startedAt)
  return Number.isFinite(started)
    && now >= started + SCENE_IMAGE_CHECK_SHADOW_DAYS * 24 * 60 * 60 * 1000
}
