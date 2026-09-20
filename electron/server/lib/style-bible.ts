/**
 * The single answer to "what does this channel look like?"
 *
 * A scene's art direction has exactly one home: the Style Bible. It is written
 * on the Character Sheet page into `<episode_dir>/continuity.json`
 * (`style_bible`), and it is applied TWICE on purpose — once at plan time, where
 * it steers the LLM writing each scene's `visual_prompt`
 * (`resolveEffectiveStyle` in generators/scene-plan.ts), and once at render
 * time, where it is appended to every rendered prompt (`composePrompt` in
 * generators/continuity-render.ts). Both readings must agree, or the plan and
 * the render describe different pictures.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * `continuity.json` is PER EPISODE. A channel whose look never changes had to
 * re-apply that look to every new episode, and when that step was skipped the
 * Style Bible resolved to nothing at all — no art direction reached the prompt
 * writer, and the writer defaulted to describing a photograph. That is not a
 * cosmetic default: asked for a photograph, an image model RETRIEVES
 * photographic references, and photographic references of a historical place
 * are modern photographs of it — a present-day alley with wheelie bins standing
 * in for a 6th-century street, a tourist replica standing in for a period ship.
 * Asked for a painting, the model COMPOSES instead, and the anachronism has
 * nowhere to enter from. Giving a channel a durable default look therefore
 * removes a failure mode; it is not only a matter of taste.
 *
 * So a project may now set a default Style Bible once (config.json
 * `default_style_bible`) and have every future episode inherit it. This is a
 * FALLBACK TIER on the existing field, deliberately not a second style field:
 *
 *   1. an explicit per-run `style_prompt`     (one run, highest precedence)
 *   2. the episode's continuity.json          (this episode looks different)
 *   3. the project's `default_style_bible`    (the channel's standing look)
 *   4. nothing                                (unchanged legacy behaviour)
 *
 * Tier 2 still wins over tier 3, so an episode that deliberately breaks format
 * keeps doing so; tier 3 only fills the silence that used to mean "no art
 * direction at all". A project that has never set `default_style_bible` reads
 * `''` here and behaves byte-identically to before this existed — nothing
 * changes for an existing project just because this shipped.
 *
 * Note this is NOT the `style_presets` / `active_style_preset_id` system in
 * services/art-style-resolver.ts. That one resolves the THUMBNAIL art style and
 * img2img reference images, and never reaches a scene's visual_prompt. The two
 * were already separate; this keeps them separate rather than overloading
 * either.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import * as pm from '../services/project-manager.js'

/**
 * The per-EPISODE Style Bible cap, mirroring the write cap in
 * routes/continuity.ts. Kept as a read-side guard because `continuity.json` can
 * be edited by hand: an episode bible the app itself wrote is already ≤ this.
 *
 * The PROJECT default no longer shares this number. Its bound is what the
 * SELECTED image model publishes (`max_prompt_characters`), enforced and
 * displayed in the Scene Plan UI where that model is known — see
 * `readProjectStyleBible` below.
 */
export const STYLE_BIBLE_MAX_CHARS = 2000

/** Where a resolved Style Bible came from. Used for operator-facing job log lines. */
export type StyleBibleSource = 'episode' | 'project' | 'none'

export interface ResolvedStyleBible {
  /** Trimmed, capped text. Empty string when nothing is set anywhere. */
  text: string
  source: StyleBibleSource
}

/**
 * The project's standing look (config.json `default_style_bible`), or `''`.
 * Never throws: a project with no config, an unreadable config, or a non-string
 * value all mean "this project has no default", which is the pre-existing
 * behaviour for every project.
 *
 * v1.4.207 — NO fixed truncation here any more. This used to slice the stored
 * text to STYLE_BIBLE_MAX_CHARS (2,000), matching the per-episode field. The
 * owner ruled on 2026-09-20 that the channel default's ceiling must be what the
 * SELECTED image model publishes for a prompt, not a Story Studio constant, and
 * that ceiling is enforced and shown in the Scene Plan UI where the model is
 * known (owner decision #2). Slicing here would silently cut a value the UI had
 * just told the customer it accepted — the exact §1 defect the ruling exists to
 * remove. config.json is still a passthrough document, but an over-long string
 * is now refused LOUDLY at render time by the image provider
 * (`providers/image/genstudio.ts` names the model's published limit), which is
 * the honest failure; a silent trim is not.
 */
export async function readProjectStyleBible(slug: string): Promise<string> {
  try {
    const config = await pm.getConfig(slug)
    const raw = (config as any)?.default_style_bible
    if (typeof raw !== 'string') return ''
    return raw.trim()
  } catch {
    return ''
  }
}

/** The episode's own Style Bible (continuity.json `style_bible`), or `''`. */
export async function readEpisodeStyleBible(episodeDir: string): Promise<string> {
  try {
    const continuityPath = path.join(episodeDir, 'continuity.json')
    if (!existsSync(continuityPath)) return ''
    const raw = JSON.parse(await fs.readFile(continuityPath, 'utf-8'))
    if (typeof raw?.style_bible !== 'string') return ''
    return raw.style_bible.trim().slice(0, STYLE_BIBLE_MAX_CHARS)
  } catch {
    return ''
  }
}

/**
 * Resolve the look that applies to this episode: its own Style Bible if it has
 * one, else the project's standing default, else nothing.
 *
 * Every consumer — plan time and render time — goes through this, so the two
 * can never disagree about which of the two tiers is in force.
 */
export async function resolveStyleBible(input: {
  slug: string
  episodeDir: string
}): Promise<ResolvedStyleBible> {
  const episode = await readEpisodeStyleBible(input.episodeDir)
  if (episode) return { text: episode, source: 'episode' }
  const project = await readProjectStyleBible(input.slug)
  if (project) return { text: project, source: 'project' }
  return { text: '', source: 'none' }
}
