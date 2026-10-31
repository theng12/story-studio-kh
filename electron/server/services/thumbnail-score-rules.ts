/**
 * Stage 1 of thumbnail scoring: the LOCAL rules.
 *
 * These are the checks that can be made on the pixels alone, with no model and
 * no network. They exist to throw out the clear failures before a paid (or
 * even free) model call is spent on them.
 *
 * WHAT A LOCAL RULE MAY CLAIM (the owner's line, 2026-11-01):
 *
 *   - the wrong size or ratio,
 *   - a near-blank picture,
 *   - muddy contrast,
 *   - unreadable at phone size IF THAT IS MEASURABLE.
 *
 * WHAT A LOCAL RULE MUST NEVER CLAIM: that a word is misspelled, or that a
 * letter is wrong. Only a model can see that. A rule that guesses at spelling
 * would be inventing a defect — the exact shape AGENTS §6 forbids.
 *
 * So the rules here measure: dimensions, the aspect ratio, the per-channel
 * spread of the pixels, and — for "unreadable at phone size" — how much
 * detail survives a downscale to the size a phone shows a thumbnail at.
 */
import sharp from 'sharp'
import type { Stats, Metadata } from 'sharp'

import {
  THUMBNAIL_RULE_LIMITS,
  THUMBNAIL_RULE_REJECTION_TEXT,
  type ThumbnailRuleRejection,
} from '../contracts/thumbnail-scores.js'

/** What the phone-size readability check measures at. */
const PHONE_SIZE = { width: 320, height: 180 }

/** One candidate's local verdict. */
export interface ThumbnailRuleResult {
  /** `null` when the picture passes every rule. */
  rejected: ThumbnailRuleRejection | null
  /** The plain reason, when rejected. */
  reason?: string
  /** The measurements, kept for the record. Never a score. */
  measurements: {
    width: number
    height: number
    /** The mean per-channel standard deviation — "how much is in this picture". */
    stdev: number
    /** The mean per-channel mean — "how bright is this picture". */
    mean: number
  }
}

/**
 * The rules, in order. The FIRST one that fires is the reason.
 *
 * Order matters for the message a person reads: a file that is not an image
 * at all is told that, not "too flat to read".
 */
export async function applyThumbnailRules(imagePath: string): Promise<ThumbnailRuleResult> {
  let metadata: Metadata
  try {
    metadata = await sharp(imagePath).metadata()
  } catch {
    return {
      rejected: 'unreadable',
      reason: THUMBNAIL_RULE_REJECTION_TEXT.unreadable,
      measurements: { width: 0, height: 0, stdev: 0, mean: 0 },
    }
  }

  const width = metadata.width || 0
  const height = metadata.height || 0
  if (!width || !height) {
    return {
      rejected: 'unreadable',
      reason: THUMBNAIL_RULE_REJECTION_TEXT.unreadable,
      measurements: { width, height, stdev: 0, mean: 0 },
    }
  }

  // 1. Size and ratio.
  if (width < THUMBNAIL_RULE_LIMITS.min_width || height < THUMBNAIL_RULE_LIMITS.min_height) {
    return {
      rejected: 'aspect',
      reason: `the picture is only ${width}×${height}, too small for a thumbnail`,
      measurements: { width, height, stdev: 0, mean: 0 },
    }
  }
  const ratio = width / height
  if (Math.abs(ratio - 16 / 9) > THUMBNAIL_RULE_LIMITS.aspect_tolerance) {
    return {
      rejected: 'aspect',
      reason: `the picture is ${width}×${height}, not a wide 16:9 thumbnail`,
      measurements: { width, height, stdev: 0, mean: 0 },
    }
  }

  // 2. Contrast and blankness, from the pixel spread.
  let stats: Stats
  try {
    stats = await sharp(imagePath).stats()
  } catch {
    return {
      rejected: 'unreadable',
      reason: THUMBNAIL_RULE_REJECTION_TEXT.unreadable,
      measurements: { width, height, stdev: 0, mean: 0 },
    }
  }
  const channels = stats.channels || []
  const stdev = channels.length
    ? channels.reduce((sum: number, channel) => sum + (channel.stdev || 0), 0) / channels.length
    : 0
  const mean = channels.length
    ? channels.reduce((sum: number, channel) => sum + (channel.mean || 0), 0) / channels.length
    : 0

  if (stdev < THUMBNAIL_RULE_LIMITS.blank_stdev) {
    return {
      rejected: 'blank',
      reason: THUMBNAIL_RULE_REJECTION_TEXT.blank,
      measurements: { width, height, stdev, mean },
    }
  }
  if (stdev < THUMBNAIL_RULE_LIMITS.min_stdev) {
    return {
      rejected: 'contrast',
      reason: THUMBNAIL_RULE_REJECTION_TEXT.contrast,
      measurements: { width, height, stdev, mean },
    }
  }

  // 3. Readable at phone size — MEASURED, not guessed. A picture whose detail
  //    all but vanishes when it is shrunk to the size a phone shows a
  //    thumbnail at cannot be read there, and that is a fact about the pixels.
  const shrunk = await sharp(imagePath)
    .resize(PHONE_SIZE.width, PHONE_SIZE.height, { fit: 'inside' })
    .greyscale()
    .raw()
    .toBuffer()
  let phoneStdev = 0
  if (shrunk.length > 1) {
    let sum = 0
    let squares = 0
    for (const byte of shrunk) { sum += byte; squares += byte * byte }
    const avg = sum / shrunk.length
    phoneStdev = Math.sqrt(Math.max(0, squares / shrunk.length - avg * avg))
  }
  if (phoneStdev < 2) {
    return {
      rejected: 'contrast',
      reason: 'the picture turns into a flat smear at phone size',
      measurements: { width, height, stdev, mean },
    }
  }

  return { rejected: null, measurements: { width, height, stdev, mean } }
}
