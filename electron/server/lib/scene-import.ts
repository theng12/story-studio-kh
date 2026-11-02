/**
 * Scene import utilities for external clips and images from any outside tool.
 *
 * Owner (2026-11-02): "let me refer back to my import flow of clips and images
 * instead. I use Google Flow to generate the scene and import. that's better
 * and doesn't cost me anything. a watermark is expected."
 *
 * Owner (2026-11-02): scene import is for ANY outside video or image tool,
 * not just Google Flow: "I just copy the prompt and then generate and import back".
 *
 * This module provides:
 * - Preset-owned allowed clip lengths (Flow=8s, extended=longer, or Custom)
 * - Matching imported files to scenes by name, scene ID, scene number, or order
 * - Hand-off data showing which scenes need clips/images with prompts
 *
 * The actual import (conversion, trash, checkpoint) reuses the existing
 * single-file upload endpoints in scene-review.ts. Watermarks from any outside
 * tool are accepted without rejection or flagging.
 */

import path from 'path'
import type { ScenePlanEntry } from '../models/types.js'

/**
 * Preset-owned allowed clip lengths for outside video tools.
 * Flow makes 8s clips by default; extended clips are longer; Custom allows owner-defined lengths.
 */
export const EXTERNAL_CLIP_PRESETS = {
  flow: { label: 'Google Flow', allowed_lengths: [8], default: 8 },
  flow_extended: { label: 'Google Flow Extended', allowed_lengths: [8, 16, 24], default: 8 },
  veo: { label: 'Veo', allowed_lengths: [8], default: 8 },
  custom: { label: 'Custom', allowed_lengths: [], default: 8 },
} as const

export type ClipPresetKey = keyof typeof EXTERNAL_CLIP_PRESETS

/**
 * Validate and parse custom clip lengths entered by the owner.
 * Allowed input: positive whole seconds (integers > 0), at least one length.
 * Accepts strings like "5, 10", "5, 10s", or number arrays [5, 10].
 * Returns sorted unique lengths, or an error description.
 */
export function parseCustomClipLengths(
  input: unknown,
): { ok: true; lengths: number[] } | { ok: false; error: string } {
  if (input === null || input === undefined) {
    return { ok: false, error: 'At least one clip length is required.' }
  }
  let rawItems: unknown[]
  if (Array.isArray(input)) {
    rawItems = input
  } else if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) {
      return { ok: false, error: 'At least one clip length is required.' }
    }
    rawItems = trimmed
      .split(/[,\s]+/)
      .map(s => s.replace(/(?:seconds?|secs?|s)$/i, '').trim())
      .filter(Boolean)
  } else if (typeof input === 'number') {
    rawItems = [input]
  } else {
    return { ok: false, error: 'Clip lengths must be positive whole seconds.' }
  }

  if (rawItems.length === 0) {
    return { ok: false, error: 'At least one clip length is required.' }
  }

  const numbers: number[] = []
  for (const item of rawItems) {
    const num = typeof item === 'number' ? item : Number(String(item).trim())
    if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
      return { ok: false, error: 'Clip lengths must be positive whole seconds (e.g. 5, 10).' }
    }
    numbers.push(num)
  }

  const unique = Array.from(new Set(numbers)).sort((a, b) => a - b)
  if (unique.length === 0) {
    return { ok: false, error: 'At least one clip length is required.' }
  }

  return { ok: true, lengths: unique }
}

/**
 * Pick the shortest allowed clip length that covers the scene duration.
 * Can take a preset key ('flow', 'veo', 'custom'), an array of allowed lengths directly,
 * or both a preset key and custom lengths.
 * Returns the length and whether the scene exceeds the longest allowed clip.
 */
export function pickClipLength(
  sceneDurationSeconds: number,
  presetOrLengths: ClipPresetKey | string | readonly number[] | number[] = 'flow',
  customLengths?: readonly number[] | number[],
): { clip_seconds: number; exceeds_max: boolean } {
  let lengths: readonly number[] = []

  if (Array.isArray(presetOrLengths)) {
    lengths = presetOrLengths
  } else if (presetOrLengths === 'custom') {
    lengths = customLengths && customLengths.length > 0 ? customLengths : [8]
  } else if (typeof presetOrLengths === 'string' && presetOrLengths in EXTERNAL_CLIP_PRESETS) {
    lengths = EXTERNAL_CLIP_PRESETS[presetOrLengths as ClipPresetKey].allowed_lengths
  }

  // Fallback to flow default if no valid lengths provided
  if (!lengths || lengths.length === 0) {
    lengths = EXTERNAL_CLIP_PRESETS.flow.allowed_lengths
  }

  const sorted = [...lengths]
    .filter(n => typeof n === 'number' && Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)

  if (sorted.length === 0) {
    sorted.push(EXTERNAL_CLIP_PRESETS.flow.default)
  }

  const max = sorted[sorted.length - 1]!

  // Find the shortest length that covers the scene
  for (const length of sorted) {
    if (length >= sceneDurationSeconds) {
      return { clip_seconds: length, exceeds_max: false }
    }
  }

  // Scene exceeds the longest allowed clip
  return { clip_seconds: max, exceeds_max: true }
}

/**
 * The motion prompt an external tool receives: the scene's own prompt, with the
 * clip length stated first so the tool makes the right one. A scene longer than
 * the longest allowed clip says so — the app trims or holds it to fit, and the
 * owner needs to know before they make the file.
 */
export function clipPrompt(
  exceeds_max: boolean,
  clip_seconds: number,
  scene_seconds: number,
  prompt: string,
): string {
  const isOver = exceeds_max || (scene_seconds > clip_seconds && clip_seconds > 0)
  const length = `${clip_seconds}s clip`
  const over = isOver
    ? ` (scene runs ${scene_seconds}s — longer than any allowed clip; trim or hold to fit)`
    : ''
  return `${length}${over}: ${prompt}`
}

/**
 * Match imported files to scenes by filename or order.
 *
 * Matching priority:
 * 1. Explicit scene ID from file metadata
 * 2. Exact scene ID match (e.g. "scene-a.mp4" → scene with id "scene-a")
 * 3. Embedded scene ID token (e.g. "Untitled_scene-b_v2.mp4" → scene with id "scene-b")
 * 4. Scene index patterns (e.g. "01.mp4", "scene_01.mov", "my-clip (1).mp4" → scene_index 1)
 * 5. Unmatched (order-based matching requires explicit confirmation from UI)
 */
export function matchFilesToScenes(
  files: Array<{ name: string; scene_id?: string }>,
  scenes: ScenePlanEntry[],
): {
  matched: Array<{ file: typeof files[0]; scene: ScenePlanEntry }>
  unmatched: typeof files
  ambiguous: Array<{ file: typeof files[0]; candidates: ScenePlanEntry[] }>
} {
  const matched: Array<{ file: typeof files[0]; scene: ScenePlanEntry }> = []
  const unmatched: typeof files = []
  const ambiguous: Array<{ file: typeof files[0]; candidates: ScenePlanEntry[] }> = []

  const scenesById = new Map(scenes.map(s => [s.id, s]))
  const scenesByIndex = new Map(scenes.map(s => [s.scene_index, s]))
  const usedVideos = new Set<string>()
  const usedImages = new Set<string>()

  for (const file of files) {
    const isVideo = /\.(mp4|mov|webm|mkv|avi)$/i.test(file.name)
    const usedScenes = isVideo ? usedVideos : usedImages

    // Explicit scene_id from file metadata
    if (file.scene_id && scenesById.has(file.scene_id) && !usedScenes.has(file.scene_id)) {
      const scene = scenesById.get(file.scene_id)!
      matched.push({ file, scene })
      usedScenes.add(scene.id)
      continue
    }

    // Match by filename patterns
    const basename = path.basename(file.name, path.extname(file.name))

    // Priority 1: Exact ID match (e.g. suggested filenames like "scene-a.mp4" / "scene-d.png")
    if (scenesById.has(basename) && !usedScenes.has(basename)) {
      const scene = scenesById.get(basename)!
      matched.push({ file, scene })
      usedScenes.add(scene.id)
      continue
    }

    // Priority 1b: Embedded scene ID in outside-tool filenames (e.g. "Untitled_scene-b_v2.mp4", "Flow_scene-a.mp4")
    const idCandidates: ScenePlanEntry[] = []
    for (const [id, scene] of scenesById.entries()) {
      if (usedScenes.has(id)) continue
      const escaped = id.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
      const idPattern = new RegExp(`(^|[_\\s.()\\[\\]-])${escaped}(?:$|[_\\s.()\\[\\]-])`, 'i')
      if (idPattern.test(basename)) {
        idCandidates.push(scene)
      }
    }
    if (idCandidates.length === 1) {
      const scene = idCandidates[0]!
      matched.push({ file, scene })
      usedScenes.add(scene.id)
      continue
    } else if (idCandidates.length > 1) {
      ambiguous.push({ file, candidates: idCandidates })
      continue
    }

    // Priority 2: Scene index patterns: "01", "scene_01", "Scene01", "scene-01", "clip_02", "my-clip (1)", "clip (1)"
    const candidates: ScenePlanEntry[] = []
    const indexMatch =
      basename.match(/^(?:(?:scene|clip)[_\s-]*)?\(?(\d+)\)?$/i) ||
      basename.match(/(?:scene|clip)[_\s-]*\(?(\d+)\)?/i) ||
      basename.match(/\((\d+)\)$/)
    if (indexMatch) {
      const index = parseInt(indexMatch[1]!, 10)
      const scene = scenesByIndex.get(index)
      if (scene && !usedScenes.has(scene.id)) {
        candidates.push(scene)
      }
    }

    // Deduplicate candidates
    const unique = candidates.filter((s, i, arr) => arr.findIndex(x => x.id === s.id) === i)

    if (unique.length === 1) {
      matched.push({ file, scene: unique[0]! })
      usedScenes.add(unique[0]!.id)
    } else if (unique.length > 1) {
      ambiguous.push({ file, candidates: unique })
    } else {
      unmatched.push(file)
    }
  }

  return { matched, unmatched, ambiguous }
}

/**
 * Generate hand-off data for an episode: which scenes need clips/images,
 * with prompts ready to copy and filenames to save as.
 */
export function generateHandoffData(
  scenes: ScenePlanEntry[],
  presetOrLengths: ClipPresetKey | string | readonly number[] | number[] = 'flow',
  customLengths?: readonly number[] | number[],
): {
  scenes_needing_clips: Array<{
    scene_id: string
    scene_index: number
    duration_seconds: number
    clip_seconds: number
    exceeds_max: boolean
    motion_prompt: string
    suggested_filename: string
  }>
  scenes_needing_images: Array<{
    scene_id: string
    scene_index: number
    visual_prompt: string
    suggested_filename: string
  }>
} {
  const scenes_needing_clips: Array<{
    scene_id: string
    scene_index: number
    duration_seconds: number
    clip_seconds: number
    exceeds_max: boolean
    motion_prompt: string
    suggested_filename: string
  }> = []

  const scenes_needing_images: Array<{
    scene_id: string
    scene_index: number
    visual_prompt: string
    suggested_filename: string
  }> = []

  for (const scene of scenes) {
    // Scenes needing clips: have motion_prompt but no clip_path or motion_choice !== 'clip'
    if (scene.motion_prompt && (!scene.clip_path || scene.motion_choice !== 'clip')) {
      const duration = scene.end_sec - scene.start_sec
      const { clip_seconds, exceeds_max } = pickClipLength(duration, presetOrLengths, customLengths)
      scenes_needing_clips.push({
        scene_id: scene.id,
        scene_index: scene.scene_index,
        duration_seconds: duration,
        clip_seconds,
        exceeds_max,
        // v1.4.375 — the copied prompt states the clip length, so the external tool
        // makes the right one (Flow's default is 8s; a longer scene needs a longer
        // pick). A scene past the longest allowed length is said here too, not only
        // in the UI badge, because this is the text that leaves the app.
        motion_prompt: clipPrompt(exceeds_max, clip_seconds, duration, scene.rendered_motion_prompt || scene.motion_prompt),
        suggested_filename: `${scene.id}.mp4`,
      })
    }

    // Scenes needing images: have visual_prompt but no image_path or approved === false
    if (scene.visual_prompt && (!scene.image_path || !scene.approved)) {
      scenes_needing_images.push({
        scene_id: scene.id,
        scene_index: scene.scene_index,
        visual_prompt: scene.rendered_prompt || scene.visual_prompt,
        suggested_filename: `${scene.id}.png`,
      })
    }
  }

  return { scenes_needing_clips, scenes_needing_images }
}