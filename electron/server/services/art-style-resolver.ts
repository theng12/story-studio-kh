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
 * Step 1 has one extra rung since 2026-10-25: when the active id is one of the
 * owner's hand-written presets and `style-aliases.ts` maps it to a Store style,
 * that Store style's bible and negative prompt are used instead of the preset's
 * stored prose — provided the style is installed. Nothing on disk is rewritten.
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
import { aliasedVisualStyleId } from '../content-packs/style-aliases.js'
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

export type ArtStyleFallbackReason =
  /** The saved preset is one the Store now owns, and that Content Pack is not installed. */
  | 'store_style_not_installed'
  /** The saved id is a Store style id, and that Content Pack is not installed. */
  | 'store_style_missing'
  /** The saved id matches no installed style and no saved preset at all. */
  | 'style_not_found'

/**
 * The look the channel names, and the look the image prompts will actually use.
 *
 * It exists because both directions of this divergence were silent: a channel
 * naming a Store style whose pack was uninstalled rendered with the format's
 * default tag, and a channel naming one of the owner's presets that the Store
 * now owns rendered with the preset's old prose — with nothing on any screen
 * or in any job log saying the named style was not used. The render still
 * happens (refusing would strand every channel on a Mac without Store styles,
 * which is the documented behaviour of the alias table), but it is never
 * quiet about it.
 */
export interface ArtStyleFallback {
  reason: ArtStyleFallbackReason
  /** The id the channel names — exactly what is stored, never rewritten. */
  requestedId: string
  /** A human-facing name for that id: the saved preset's name, or the id humanised. */
  requestedName: string
  /** The Store visual style that would have provided the look, when one names it. */
  storeStyleId: string | null
  /** What the image prompts use instead. */
  used: 'saved_preset' | 'format_default'
  /** The name of what was used instead, when it has one. */
  usedName: string | null
  /** One plain sentence, for a job log line or a Settings hint. */
  message: string
}

export interface ArtStyleResolution {
  /** The style to render with, or null when the caller keeps the format tag. */
  style: ResolvedArtStyle | null
  /** Set when the channel names a style that could not be used. */
  fallback: ArtStyleFallback | null
}

/** `com.storystudio.style.carved-woodcut-print` → `carved woodcut print`. */
export function humanizeVisualStyleId(id: string): string {
  const bare = id.replace(/^com\.storystudio\.style\./, '')
  return bare.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim() || id
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
 * Resolve the effective art style for a project.
 *
 * `style` is null when the project has no active preset; the caller then keeps
 * the format tag. `fallback` is set when the project DOES name a style that
 * could not be used — the caller must announce it (job log, Settings), never
 * drop it.
 */
export async function resolveProjectArtStyle(
  slug: string,
  registryOptions: ContentPackRegistryOptions = {},
): Promise<ArtStyleResolution> {
  const config = await pm.getConfig(slug)
  if (!config) return { style: null, fallback: null }

  // 1. Active preset wins.
  const activeId = (config.active_style_preset_id || '').trim()
  let fallback: ArtStyleFallback | null = null
  if (activeId) {
    const project = await pm.getProject(slug)
    if (project) {
      const pins = await resolveProjectContentPinsForKinds(project, ['visual-style'], registryOptions)
      const signed = await loadVisualStyle(activeId, { ...registryOptions, pins })
      if (signed) {
        return {
          style: {
            source: 'preset',
            presetId: signed.id,
            name: signed.name,
            description: signed.data.style_bible.trim(),
            negatives: signed.data.negative_prompt
              ? signed.data.negative_prompt.split(',').map(value => value.trim()).filter(Boolean)
              : [],
            referenceImagePaths: [],
          },
          fallback: null,
        }
      }
      // 2. The owner's own hand-written presets, resolved to the Store style that
      // now owns that look. Read-time only: the preset in the project config is
      // never rewritten, and when the Store style is not installed this falls
      // through to the preset's own stored prose below, exactly as before —
      // but it now says so, because that prose is not the style it names.
      const aliasedId = aliasedVisualStyleId(activeId)
      if (aliasedId) {
        const adopted = await loadVisualStyle(aliasedId, { ...registryOptions, pins })
        if (adopted) {
          return {
            style: {
              source: 'preset',
              // The customer's selection did not change — only where its text comes from.
              presetId: activeId,
              name: adopted.name,
              description: adopted.data.style_bible.trim(),
              negatives: adopted.data.negative_prompt
                ? adopted.data.negative_prompt.split(',').map(value => value.trim()).filter(Boolean)
                : [],
              referenceImagePaths: [],
            },
            fallback: null,
          }
        }
        fallback = {
          reason: 'store_style_not_installed',
          requestedId: activeId,
          requestedName: savedPresetName(config, activeId) ?? humanizeVisualStyleId(activeId),
          storeStyleId: aliasedId,
          used: 'saved_preset',
          usedName: savedPresetName(config, activeId) ?? null,
          message: `The Studio Library style “${humanizeVisualStyleId(aliasedId)}” (${aliasedId}) ` +
            'is not installed on this Mac, so images do not use it.',
        }
      }
    }
  }
  if (activeId && Array.isArray(config.style_presets)) {
    const preset = config.style_presets.find(p => p && p.id === activeId)
    if (preset && (preset.description || '').trim()) {
      if (fallback) {
        fallback.used = 'saved_preset'
        fallback.usedName = preset.name || preset.id
        fallback.message = `The Studio Library style “${humanizeVisualStyleId(fallback.storeStyleId!)}” ` +
          `(${fallback.storeStyleId}) is not installed on this Mac, so this channel’s own saved style ` +
          `“${fallback.usedName}” is used instead.`
      }
      return {
        style: {
          source: 'preset',
          presetId: preset.id,
          name: preset.name,
          description: preset.description.trim(),
          // Presets carry no negatives today; kept as a slot for a future field.
          negatives: [],
          referenceImagePaths: resolvePresetReferenceImages(slug, preset),
        },
        fallback,
      }
    }
  }

  // A saved id that resolves to nothing used to disappear in silence: the
  // caller fell back to the format tag and the customer's chosen style was
  // simply absent from every prompt, with nothing anywhere saying so. Saving
  // one is refused at the route now (project-pins.ts), but a project can still
  // arrive here carrying an id written by an older build or by an uninstalled
  // pack — so say it out loud, here and in every job log that renders images.
  if (activeId) {
    const requestedName = savedPresetName(config, activeId) ?? humanizeVisualStyleId(activeId)
    const storeStyleId = aliasedVisualStyleId(activeId)
    console.warn(
      `[art-style-resolver] project '${slug}' has active_style_preset_id '${activeId}' ` +
      'but it matches no installed style and no saved preset. Generation falls back to ' +
      'the format style tag until a style is selected.',
    )
    return {
      style: null,
      fallback: {
        reason: storeStyleId ? 'store_style_not_installed' : 'style_not_found',
        requestedId: activeId,
        requestedName,
        storeStyleId,
        used: 'format_default',
        usedName: null,
        message: `The art style “${requestedName}” (${activeId}) is not available on this Mac, ` +
          'so images use the channel’s format default style instead.',
      },
    }
  }
  // No project art style → caller uses the format tag.
  return { style: null, fallback: null }
}

function savedPresetName(
  config: { style_presets?: Array<{ id: string; name?: string }> } | null,
  id: string,
): string | null {
  const preset = Array.isArray(config?.style_presets) ? config!.style_presets.find(candidate => candidate?.id === id) : undefined
  const name = (preset?.name || '').trim()
  return name || null
}
