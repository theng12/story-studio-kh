/**
 * One picture-length rule for every stage that claims a finished final (owner-strict, never loosened
 * per stage): the independently probed VIDEO STREAM may be at most this much shorter than the length
 * that stage planned. The container/audio duration is a different measurement and never stands in
 * for it — a longer audio track can hide a picture that stopped early.
 */
export const PICTURE_SHORT_SLACK_SEC = 0.25

export type PictureLengthCheck =
  | { state: 'ok' }
  | { state: 'unmeasurable' }
  | { state: 'short'; shortBySec: number }

/**
 * `unmeasurable` is deliberately not `ok`: a missing picture measurement must be refused by the
 * caller, never read as complete (AGENTS §6 — a zero that means two things is a defect).
 */
export function checkPictureLength(
  pictureSec: number | null | undefined,
  plannedSec: number,
): PictureLengthCheck {
  if (!Number.isFinite(plannedSec) || plannedSec <= 0) return { state: 'unmeasurable' }
  if (pictureSec === null || pictureSec === undefined
    || !Number.isFinite(pictureSec) || pictureSec <= 0) return { state: 'unmeasurable' }
  const shortBySec = plannedSec - pictureSec
  return shortBySec > PICTURE_SHORT_SLACK_SEC ? { state: 'short', shortBySec } : { state: 'ok' }
}
