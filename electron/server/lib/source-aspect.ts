/**
 * "Your pictures are not the shape of the video you asked for" (v1.4.15).
 *
 * The assembler fits every scene image inside the canvas and pads the rest with
 * black. That is the right behaviour when the shapes match or nearly match, and
 * it is what has always happened. It is the WRONG thing to do silently once
 * portrait renders exist: a set of 16:9 scene images rendered at 9:16 produces
 * a Short that is two-thirds black bar, and the render only tells you that
 * after the encode, by looking wrong.
 *
 * So the shapes are compared before any encode starts, and the answer is said
 * out loud — in the render's log, and in the preflight panel next to the three
 * frames, which is where a person is already looking to judge the render.
 *
 * It WARNS and continues rather than refusing. Letterboxing is sometimes
 * exactly what is wanted (a 21:9 still deliberately matted into 16:9), and a
 * render that refuses over a matter of taste is worse than one that says what
 * it is about to do.
 */

import { getMediaInfo } from './ffmpeg-validation.js'
import { ASPECT_MISMATCH_THRESHOLD, aspectDivergence, describeAspectRatio } from './render-canvas.js'

export interface SourceAspectReport {
  /** Number of sources probed. Zero when nothing could be measured. */
  checked: number
  /** How many of those are a different shape from the canvas. */
  mismatched: number
  /** `'16:9'` — the shape most of the mismatched sources actually are. */
  source_aspect: string
  /** `'9:16'` — the shape the render will be. */
  canvas_aspect: string
  /** Ready to show. Empty when there is nothing worth saying. */
  message: string
}

/** How many sources to probe. Enough to be representative, cheap enough to be free. */
const SAMPLE_LIMIT = 6

/**
 * Probe a sample of the scene images and report whether they fit the canvas.
 *
 * Never throws: an unreadable source is a problem the rest of the pipeline
 * already reports properly, and this check must not be the thing that fails a
 * render. Unprobeable files are simply not counted.
 */
export async function inspectSourceAspect(
  imagePaths: string[],
  canvasW: number,
  canvasH: number,
): Promise<SourceAspectReport> {
  const canvasAspect = describeAspectRatio(canvasW, canvasH)
  const empty: SourceAspectReport = {
    checked: 0, mismatched: 0, source_aspect: '', canvas_aspect: canvasAspect, message: '',
  }
  if (!(canvasW > 0) || !(canvasH > 0)) return empty

  // Spread the sample across the episode rather than taking the first six —
  // a title still at the front is the least representative frame there is.
  const usable = (imagePaths || []).filter(p => typeof p === 'string' && p)
  if (!usable.length) return empty
  const step = Math.max(1, Math.floor(usable.length / SAMPLE_LIMIT))
  const sample: string[] = []
  for (let i = 0; i < usable.length && sample.length < SAMPLE_LIMIT; i += step) sample.push(usable[i]!)

  const canvasRatio = canvasW / canvasH
  let checked = 0
  const mismatched: { w: number; h: number; ratio: number }[] = []
  for (const p of sample) {
    let info
    try {
      info = await getMediaInfo(p)
    } catch {
      continue
    }
    const sw = Number(info.width) || 0
    const sh = Number(info.height) || 0
    if (!(sw > 0) || !(sh > 0)) continue
    checked++
    const ratio = sw / sh
    if (aspectDivergence(ratio, canvasRatio) > ASPECT_MISMATCH_THRESHOLD) mismatched.push({ w: sw, h: sh, ratio })
  }
  if (!checked || !mismatched.length) {
    return { ...empty, checked, canvas_aspect: canvasAspect }
  }

  // Describe the sources by their MEDIAN member — its real pixel dimensions,
  // not an average of ratios. A mixed set has no single shape, and reducing the
  // actual dimensions of one real image is the honest one-line summary; a mean
  // of floats would report a ratio no image in the set actually has.
  const sorted = [...mismatched].sort((a, b) => a.ratio - b.ratio)
  const median = sorted[Math.floor(sorted.length / 2)]!
  const sourceAspect = describeAspectRatio(median.w, median.h)

  const everyOne = mismatched.length === checked
  const orientationFlip = (median.ratio >= 1) !== (canvasRatio >= 1)
  return {
    checked,
    mismatched: mismatched.length,
    source_aspect: sourceAspect,
    canvas_aspect: canvasAspect,
    message:
      `${everyOne ? 'Every' : `${mismatched.length} of ${checked}`} scene image sampled is `
      + `${sourceAspect} (${median.w}×${median.h}), and this render is ${canvasAspect} (${canvasW}×${canvasH}). `
      + (orientationFlip
        ? 'They will be fitted inside the frame with large black bars — a portrait video made from '
          + 'landscape pictures, or the reverse. Regenerate the scene images at the render\'s shape, '
          + 'or change the render\'s shape to match them.'
        : 'They will be fitted inside the frame with black bars along the shorter sides.'),
  }
}
