/**
 * Art-style resolver — the single source of truth for a project's active
 * visual style (v1.0.518).
 *
 * Before this, image style leaked in from four scattered places:
 *   - project `style_presets` (a picker that was never applied to real
 *     generation — only preview renders),
 *   - `brand.imagePrompts` (auto-applied but not a picker),
 *   - format `defaultStyleTag` + niche `visualStyleSheet` (merged tag).
 *
 * The consolidation: a project now carries ONE persisted art style
 * (`config.active_style_preset_id`, pointing at a `style_presets` entry).
 * When set it is authoritative — it replaces the format+niche style tag in
 * generated prompts, and its preview image is fed into img2img generation
 * as a style reference. `brand.imagePrompts` is folded in as the fallback
 * when no preset is active, so existing brand projects keep their look with
 * zero migration.
 *
 * Precedence (highest first):
 *   1. Active `style_presets` entry (`active_style_preset_id`).
 *   2. Brand `imagePrompts` (via `project.brand_id`).
 *   3. null → callers fall back to the legacy format+niche merged tag.
 *
 * This resolver deliberately does NOT know about per-run overrides (a
 * free-text `style_tag` typed into the Image Prompts page). Callers apply
 * that override first and only consult the resolver when no override is
 * present — see generators/image-prompts.ts.
 */

import path from 'path'
import { existsSync } from 'fs'
import * as pm from './project-manager.js'
import { getEffectiveBrand } from './brand-loader.js'
import type { StylePreset } from '../models/types.js'

export interface ResolvedArtStyle {
  /** Where the style came from — for logging / UI hints. */
  source: 'preset' | 'brand'
  /** Id of the active preset (absent for the brand fallback). */
  presetId?: string
  /** Human-facing name, when available. */
  name?: string
  /** The style description folded into every image prompt as the style tag. */
  description: string
  /** Negative-prompt phrases appended as "Avoid in all images". */
  negatives: string[]
  /**
   * Absolute paths to the style's reference image(s), resolved from the
   * project's `style-previews/` dir. Fed into img2img generation. Empty for
   * the brand fallback (brands have no rendered preview). Only files that
   * exist on disk are included.
   */
  referenceImagePaths: string[]
}

/** Absolute path to the project's style-previews directory. */
function stylePreviewsDir(slug: string): string {
  const projDir = pm.getProjectDir(slug) || path.join(pm.PROJECTS_ROOT, slug)
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

/** Fold a brand's imagePrompts block into a single style description. */
function brandDescription(styleSheet?: string, keywords?: string[]): string {
  const pieces: string[] = []
  const sheet = (styleSheet || '').trim()
  if (sheet) pieces.push(sheet)
  if (keywords?.length) pieces.push(keywords.join(', '))
  return pieces.join('\n\n').trim()
}

/**
 * Resolve the effective art style for a project. Returns null when the
 * project has neither an active preset nor a brand imagePrompts block — the
 * caller then keeps the legacy format+niche merged tag.
 */
export async function resolveProjectArtStyle(slug: string): Promise<ResolvedArtStyle | null> {
  const config = await pm.getConfig(slug)
  if (!config) return null

  // 1. Active preset wins.
  const activeId = (config.active_style_preset_id || '').trim()
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

  // 2. Brand imagePrompts fallback (folded into the one art-style concept).
  try {
    const brand = await getEffectiveBrand(slug)
    const ip = brand?.imagePrompts
    if (ip) {
      const description = brandDescription(ip.style_sheet, ip.style_keywords)
      const negatives = Array.isArray(ip.negative_prompts) ? ip.negative_prompts.filter(Boolean) : []
      if (description || negatives.length) {
        return {
          source: 'brand',
          name: brand?.name,
          description,
          negatives,
          referenceImagePaths: [],
        }
      }
    }
  } catch {
    // Brand resolution must never break generation — fall through to null.
  }

  // 3. No project art style → caller uses the legacy format+niche tag.
  return null
}
