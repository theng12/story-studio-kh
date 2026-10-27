/**
 * Video Assembly follows what is switched on (owner decision 2026-10-07).
 *
 * A feature switched OFF is no problem. A feature switched ON whose input is
 * missing used to be a log line ("— title step skipped", "— logo skipped") and
 * the job still finished done, so the owner found out from the finished video.
 * This lists every such gap BEFORE the expensive encode, with what to press.
 */

import type { GenerateVideoRequest } from '../models/types.js'
import { checkAssetAvailability } from './sync-safe.js'

export interface MissingVideoInput {
  feature: string
  fix: string
}

function present(p: string | undefined | null): boolean {
  return !!p?.trim() && checkAssetAvailability(p).status === 'available'
}

export function missingEnabledVideoInputs(
  req: GenerateVideoRequest,
  opts: { canDrawtext: boolean; episodeCode: string; availableThumbnailPaths?: string[] },
): MissingVideoInput[] {
  const missing: MissingVideoInput[] = []
  const add = (feature: string, fix: string) => missing.push({ feature, fix })
  const off = (what: string) => `or switch ${what} off in Video Assembly`

  if (req.subtitles?.enabled && !present(req.subtitles.srt_path)) {
    add('Captions', `${opts.episodeCode} has no subtitle file. Open Subtitles and press Transcribe, then Stitch — ${off('captions')}.`)
  }
  const textTitle = !!(req.title_card?.enabled && req.title_card.text?.trim())
  if (textTitle && !opts.canDrawtext) {
    add('Text title card', `This FFmpeg has no drawtext filter, so the card cannot be drawn. Install a full FFmpeg build, ${off('the text title card')}.`)
  }
  if (req.title_image?.enabled && !textTitle && !present(req.title_image.image_path)) {
    const hasThumbnailFallback = Array.isArray(opts.availableThumbnailPaths) && opts.availableThumbnailPaths.some(p => present(p))
    if (!hasThumbnailFallback) {
      add('Title image / cover frame', `${req.title_image.image_path ? `The file is missing (${req.title_image.image_path}).` : 'No image is chosen and no thumbnail is available.'} Pick the title image again (or generate episode thumbnails), ${off('the title image')}.`)
    }
  }
  if (req.intro?.enabled && !present(req.intro.video_path)) {
    add('Intro video', `${req.intro.video_path ? `The file is missing (${req.intro.video_path}).` : 'No video is chosen.'} Pick the intro again, ${off('the intro')}.`)
  }
  if (req.outro?.enabled && !present(req.outro.video_path)) {
    add('Outro video', `${req.outro.video_path ? `The file is missing (${req.outro.video_path}).` : 'No video is chosen.'} Pick the outro again, ${off('the outro')}.`)
  }
  if (req.outro_card?.enabled && req.outro_card.text?.trim() && !opts.canDrawtext) {
    add('Text outro card', `This FFmpeg has no drawtext filter, so the card cannot be drawn. Install a full FFmpeg build, ${off('the text outro card')}.`)
  }
  ;(req.timeline_clips || []).forEach((clip, index) => {
    if (!clip.enabled) return
    const name = `Timeline clip ${index + 1} (${clip.anchor})`
    const source = clip.kind === 'static' ? clip.image_path : clip.video_path
    if (!present(source)) {
      add(name, `${source ? `The file is missing (${source}).` : 'No file is chosen.'} Pick it again, ${off('that clip')}.`)
    } else if (clip.kind === 'static' && !(Number.isFinite(clip.duration_sec) && clip.duration_sec > 0)) {
      add(name, `Its duration (${clip.duration_sec}) is not a positive number of seconds. Set a duration, ${off('that clip')}.`)
    }
  })
  if (req.logo?.enabled && !present(req.logo.image_path)) {
    add('Logo', `${req.logo.image_path ? `The file is missing (${req.logo.image_path}).` : 'No image is chosen.'} Pick the logo again, ${off('the logo')}.`)
  }
  if (req.overlays?.enabled && Array.isArray(req.overlays.layers)) {
    for (const layer of req.overlays.layers) {
      if (layer.enabled && !present(layer.source_path)) {
        add(`Overlay "${layer.id}"`, `${layer.source_path ? `The file is missing (${layer.source_path}).` : 'No file is chosen.'} Pick it again, ${off('that overlay')}.`)
      }
    }
  } else if (req.chroma_key?.enabled && !present(req.chroma_key.source_path)) {
    add('Chroma-key overlay', `${req.chroma_key.source_path ? `The file is missing (${req.chroma_key.source_path}).` : 'No file is chosen.'} Pick it again, ${off('the overlay')}.`)
  }
  if (req.video_layout === 'compilation' && Array.isArray(req.chapter_durations)
    && req.scenes.length !== req.chapter_durations.length) {
    add('Compilation foregrounds', `There are ${req.scenes.length} scene image(s) for ${req.chapter_durations.length} chapter(s); every chapter needs exactly one. Add or remove scene images so they match.`)
  }
  return missing
}

/**
 * Contextual Cues / Sound Design at render time. Switched on and never made,
 * or proposals still waiting: stop. Every cue turned down in review: render
 * without them, and say so in the job result (it is the reviewer's decision).
 */
export function switchedOnCueGate(
  feature: 'Contextual Cues' | 'Sound Design',
  episodeId: string,
  input: { enabled: boolean; timeline: { cues: Array<{ status: string }> } | null; approved: number },
): { stop?: string; note?: string } {
  if (!input.enabled || input.approved > 0) return {}
  const page = feature === 'Contextual Cues' ? 'Contextual Cues' : 'Sound Design'
  const waiting = input.timeline?.cues.filter(cue => cue.status === 'proposed').length || 0
  if (!input.timeline) {
    return {
      stop: `Video Assembly stopped before encoding ${episodeId}: ${feature} ${feature === 'Sound Design' ? 'is' : 'are'} switched on but nothing was ever `
        + `${feature === 'Sound Design' ? 'added' : 'proposed'} for this episode. Open ${page} and press `
        + `${feature === 'Sound Design' ? 'Add cues' : 'Propose cues'}, or switch ${feature} off in the project settings. Nothing was rendered.`,
    }
  }
  if (waiting) {
    return {
      stop: `Video Assembly stopped before encoding ${episodeId}: ${feature} ${feature === 'Sound Design' ? 'is' : 'are'} switched on but none is approved `
        + `and ${waiting} still await review. Open ${page} and approve or switch off each one, or switch ${feature} off in the project settings. Nothing was rendered.`,
    }
  }
  return { note: `${feature}: every cue on this episode was turned down in review — rendering without them.` }
}

export function missingInputsMessage(missing: MissingVideoInput[], episodeCode: string): string {
  return `Video Assembly stopped before encoding ${episodeCode}: ${missing.length} switched-on feature(s) have nothing to show. `
    + missing.map(item => `${item.feature}: ${item.fix}`).join(' ')
    + ' Nothing was rendered.'
}

/**
 * The finished file's length against the plan. The tolerance covers frame
 * rounding and encoder padding; a truncated outro or a short concat is far
 * outside it.
 */
export function finalDurationIssue(actualSec: number | null | undefined, plannedSec: number): string | null {
  if (!(plannedSec > 0)) return null
  if (!(Number(actualSec) > 0)) return 'its length could not be measured'
  const tolerance = Math.max(2, plannedSec * 0.005)
  const delta = Number(actualSec) - plannedSec
  return Math.abs(delta) <= tolerance
    ? null
    : `it is ${Number(actualSec).toFixed(1)}s long but the narration, opening, outro and tail add up to ${plannedSec.toFixed(1)}s (${delta > 0 ? '+' : ''}${delta.toFixed(1)}s)`
}
