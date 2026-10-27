/**
 * The free scene-image quality check's dated policy (owner 2026-10-26, updated),
 * shared by the server and the page that shows the switch.
 *
 * Zero-dependency: also imported by the frontend runtime, so both sides agree
 * on WHEN the auto-remake switch unlocks without either keeping its own copy.
 */
export const SCENE_IMAGE_CHECK_SHADOW_UNTIL = '2026-11-30T23:59:59.999Z'

/** True once the shadow phase is over (past shadow_until), so the auto-remake switch may be turned on. */
export function sceneImageCheckShadowOver(shadowUntil: string, now = Date.now()): boolean {
  const until = Date.parse(shadowUntil || SCENE_IMAGE_CHECK_SHADOW_UNTIL)
  return Number.isFinite(until) && now > until
}
