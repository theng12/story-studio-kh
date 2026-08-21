/**
 * The size the subtitle "exact preview" is rendered at.
 *
 * It lives here, on its own, for one reason: the preview is only evidence if
 * it describes the same caption the burn does, and
 * `__tests__/subtitle-engine.test.ts` proves that by comparing the ASS
 * document at the preview size against the document at the burn size. If the
 * test hardcoded its own idea of the preview size, someone could change the
 * endpoint and leave the test proving a resolution nothing renders at — a
 * green gate over a claim that had quietly stopped being about the product.
 * One constant, imported by both.
 *
 * v1.3.2 raised this from 640x360. At 640 the modal had to upscale the clip
 * roughly 1.7x to fill a 1120px dialog, so the owner was judging typography —
 * weight, outline, word highlighting — from a blurred image. Measured on the
 * bundled ffmpeg (arm64, VP9 `-deadline realtime`), a 4-second clip costs a
 * median 0.63s at 640x360 and 1.18s at 1280x720: about half a second more,
 * once, behind the on-disk preview cache and a deliberate button press. 1080p
 * was also measured (2.21s) and rejected — it more than triples the wait to
 * exceed a dialog that can never be wider than 1120px.
 */

/**
 * v1.4.15 — the preview follows the render's ASPECT RATIO, so the SHORT edge is
 * the constant and the long edge comes from the chosen shape. `_W` / `_H` stay
 * as the 16:9 canvas they have always named: that is what the burn-vs-preview
 * agreement test compares against, and what a caller naming no ratio still gets.
 *
 * The ratio genuinely matters here rather than being tidiness. Line wrapping,
 * side margins and how many lines a caption occupies are exactly what this
 * preview exists to let a person judge, and all three are different on a
 * 1280-wide frame and a 720-wide one.
 */
export const SUBTITLE_PREVIEW_SHORT_EDGE = 720
export const SUBTITLE_PREVIEW_W = 1280
export const SUBTITLE_PREVIEW_H = 720
export const SUBTITLE_PREVIEW_FPS = 24
/** Long enough for a word-mode sweep to actually be visible. */
export const SUBTITLE_PREVIEW_DURATION = 4
export const SUBTITLE_PREVIEW_SAMPLE =
  'The forest whispered secrets older than memory, and the quiet river answered.'
