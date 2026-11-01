/**
 * Scene import utilities for external clips and images (Google Flow workflow).
 *
 * Owner (2026-11-02): "let me refer back to my import flow of clips and images
 * instead. I use Google Flow to generate the scene and import. that's better
 * and doesn't cost me anything. a watermark is expected."
 *
 * This module provides:
 * - Preset-owned allowed clip lengths (Flow=8s, extended=longer)
 * - Matching imported files to scenes by name or order
 * - Hand-off data showing which scenes need clips/images with prompts
 *
 * The actual import (conversion, trash, checkpoint) reuses the existing
 * single-file upload endpoints in scene-review.ts.
 */

import path from 'path'
import type { ScenePlanEntry } from '../models/types.js'

/**
 * Preset-owned allowed clip lengths for external video tools.
 * Flow makes 8s clips by default; extended clips are longer.
 */
export const EXTERNAL_CLIP_PRESETS = {
  flow: { label: 'Google Flow', allowed_lengths: [8], default: 8 },
  flow_extended: { label: 'Google Flow Extended', allowed_lengths: [8, 16, 24], default: 8 },
  veo: { label: 'Veo', allowed_lengths: [8], default: 8 },
} as const

export type ClipPresetKey = keyof typeof EXTERNAL_CLIP_PRESETS

/**
 * Pick the shortest allowed clip length that covers the scene duration.
 * Returns the length and whether the scene exceeds the longest allowed clip.
 */
export function pickClipLength(
  sceneDurationSeconds: number,
  presetKey: ClipPresetKey = 'flow',
): { clip_seconds: number; exceeds_max: boolean } {
  const preset = EXTERNAL_CLIP_PRESETS[presetKey]
  const sorted = [...preset.allowed_lengths].sort((a, b) => a - b)
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
  const length = `${clip_seconds}s clip`
  const over = exceeds_max
    ? ` (scene runs ${scene_seconds}s — longer than any allowed clip; trim or hold to fit)`
    : ''
  return `${length}${over}: ${prompt}`
}

/**
 * Match imported files to scenes by filename or order.
 *
 * Matching priority:
 * 1. Exact scene ID match (e.g., "scene-a.mp4" → scene with id "scene-a")
 * 2. Scene index match (e.g., "01.mp4" or "scene_01.mov" → scene_index 1)
 * 3. Unmatched (order-based matching requires explicit confirmation from UI)
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
  const usedScenes = new Set<string>()

  for (const file of files) {
    // Explicit scene_id from file metadata
    if (file.scene_id && scenesById.has(file.scene_id) && !usedScenes.has(file.scene_id)) {
      const scene = scenesById.get(file.scene_id)!
      matched.push({ file, scene })
      usedScenes.add(scene.id)
      continue
    }

    // Match by filename patterns
    const basename = path.basename(file.name, path.extname(file.name))
    const candidates: ScenePlanEntry[] = []

    // Try exact ID match
    if (scenesById.has(basename) && !usedScenes.has(basename)) {
      candidates.push(scenesById.get(basename)!)
    }

    // Try scene_index patterns: "01", "scene_01", "Scene01", "scene-01"
    const indexMatch = basename.match(/(?:scene[_-]?)?(\d+)/i)
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
  presetKey: ClipPresetKey = 'flow',
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
      const { clip_seconds, exceeds_max } = pickClipLength(duration, presetKey)
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