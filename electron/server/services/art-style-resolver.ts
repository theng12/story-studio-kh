/**
 * Art-style resolver — the single source of truth for a project's active
 * visual style (v1.0.518).
 *
 * Before this, image style leaked in from several scattered places:
 *   - project `style_presets` (a picker that was never applied to real
 *     generation — only preview renders),
 *   - format `defaultStyleTag` + niche `visualStyleSheet` (merged tag).
 *
 * v1.4.64 removed the niche half of that fallback entirely. A channel type no
 * longer dictates a look; it suggests one, and only a selection reaches a
 * prompt. The remaining fallback is the format's own neutral style tag.
 *
 * The consolidation: a project now carries ONE persisted art style
 * (`config.active_style_preset_id`, pointing at a `style_presets` entry).
 * When set it is authoritative — it replaces the format+niche style tag in
 * generated prompts, and its preview image is fed into img2img generation
 * as a style reference.
 *
 * Precedence (highest first):
 *   1. Active `style_presets` entry (`active_style_preset_id`).
 *   2. null → callers fall back to the format+niche merged tag.
 *
 * This resolver deliberately does NOT know about per-run overrides (a
 * free-text `style_tag` typed into the Image Prompts page). Callers apply
 * that override first and only consult the resolver when no override is
 * present — see generators/image-prompts.ts.
 */

import path from 'path'
import { existsSync } from 'fs'
import * as pm from './project-manager.js'
import type { StylePreset } from '../models/types.js'
import { resolveProjectContentPinsForKinds } from '../content-packs/project-pins.js'
import { loadVisualStyle } from './visual-style-loader.js'
import type { ContentPackRegistryOptions } from '../content-packs/registry.js'

export interface ResolvedArtStyle {
  /** Where the style came from — for logging / UI hints. */
  source: 'preset'
  /** Id of the active preset. */
  presetId?: string
  /** Human-facing name, when available. */
  name?: string
  /** The style description folded into every image prompt as the style tag. */
  description: string
  /** Negative-prompt phrases appended as "Avoid in all images". */
  negatives: string[]
  /**
   * Absolute paths to the style's reference image(s), resolved from the
   * project's `style-previews/` dir. Fed into img2img generation. Only files
   * that exist on disk are included.
   */
  referenceImagePaths: string[]
}

/** Absolute path to the project's style-previews directory. */
function stylePreviewsDir(slug: string): string {
  const projDir = pm.getProjectDir(slug) || path.join(pm.projectsRoot(), slug)
  return path.join(projDir, 'style-previews')
}

/**
 * Resolve the single reference image for an active preset. Prefers the
 * primary `preview_filename`, else the first entry of `preview_files`. We
 * intentionally send only ONE style reference (not the whole preview
 * gallery) so it reinforces rather than confuses the generator, and so we
 * stay within provider reference-image caps.
 */
function resolvePresetReferenceImages(slug: string, preset: StylePreset): string[] {
  const dir = stylePreviewsDir(slug)
  const primary = preset.preview_filename
    || (Array.isArray(preset.preview_files) ? preset.preview_files[0] : undefined)
  if (!primary) return []
  const abs = path.join(dir, primary)
  return existsSync(abs) ? [abs] : []
}

/**
 * Resolve the effective art style for a project. Returns null when the
 * project has no active preset; the caller then keeps the format+niche tag.
 */
export async function resolveProjectArtStyle(
  slug: string,
  registryOptions: ContentPackRegistryOptions = {},
): Promise<ResolvedArtStyle | null> {
  const config = await pm.getConfig(slug)
  if (!config) return null

  // 1. Active preset wins.
  const activeId = (config.active_style_preset_id || '').trim()
  if (activeId) {
    const project = await pm.getProject(slug)
    if (project) {
      const pins = await resolveProjectContentPinsForKinds(project, ['visual-style'], registryOptions)
      const signed = await loadVisualStyle(activeId, { ...registryOptions, pins })
      if (signed) {
        return {
          source: 'preset',
          presetId: signed.id,
          name: signed.name,
          description: signed.data.style_bible.trim(),
          negatives: signed.data.negative_prompt
            ? signed.data.negative_prompt.split(',').map(value => value.trim()).filter(Boolean)
            : [],
          referenceImagePaths: [],
        }
      }
    }
  }
  if (activeId && Array.isArray(config.style_presets)) {
    const preset = config.style_presets.find(p => p && p.id === activeId)
    if (preset && (preset.description || '').trim()) {
      return {
        source: 'preset',
        presetId: preset.id,
        name: preset.name,
        description: preset.description.trim(),
        // Presets carry no negatives today; kept as a slot for a future field.
        negatives: [],
        referenceImagePaths: resolvePresetReferenceImages(slug, preset),
      }
    }
  }

  // A saved id that resolves to nothing used to disappear in silence: the
  // caller fell back to the format tag and the customer's chosen style was
  // simply absent from every prompt, with nothing anywhere saying so. Saving
  // one is refused at the route now (project-pins.ts), but a project can still
  // arrive here carrying an id written by an older build or by an uninstalled
  // pack — so say it out loud. Settings shows the same condition as a warning.
  if (activeId) {
    console.warn(
      `[art-style-resolver] project '${slug}' has active_style_preset_id '${activeId}' ` +
      'but it matches no installed style and no saved preset. Generation falls back to ' +
      'the format style tag until a style is selected.',
    )
  }
  // No project art style → caller uses the format tag.
  return null
}
