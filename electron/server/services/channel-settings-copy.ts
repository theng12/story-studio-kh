/**
 * Which settings a new channel takes from the channel it was started from
 * (owner, 2026-10-30): after a first episode settles the look — *"i also want
 * it to be saved as like a template … then in the future i can just 1 click the
 * pipeline."*
 *
 * An ALLOW list, never a deny list (AGENTS.md §4): every key that crosses is
 * named here, so a key added later that happens to describe one episode — a
 * file, a sheet, an anchor, an idea — stays behind by default instead of
 * leaking into every channel copied afterwards.
 *
 * What crosses is reusable look and configuration. What stays is everything
 * else, and in particular the channel's scene rhythm: an episode's pacing is a
 * deliberate per-episode choice (AGENTS.md §5) and is never inherited.
 *
 * Retired channel-kit packs are not resurrected here either: nothing in this
 * module installs, re-registers or re-pins a pack — it only reads what the
 * source channel already has on disk.
 */
import type { CreateProjectRequest, ProjectMeta } from '../models/types.js'
import { isPresetConfigKey } from './project-manager.js'

/**
 * project.json keys that cross — the Series Formula, its Topic Packs, and the
 * art style's own pointer. Only what `CreateProjectSchema` accepts is named
 * here; the art style is written by the config step below, which mirrors it
 * into project.json through the ordinary signed-selection path.
 */
export const COPYABLE_CREATE_KEYS = ['niche_id', 'formula_choice', 'topic_pack_ids'] as const

/** config.json keys that cross IN ADDITION to every preset family. */
const EXTRA_COPYABLE_CONFIG_KEYS = new Set([
  // Art style: the pointer (the entries themselves ride in on `style_presets`).
  'active_style_preset_id',
  // Idea upgrades — the channel's own idea-quality switches.
  'idea_upgrades',
])

/**
 * Named explicitly even where the allow list would already drop them, because
 * a future widening of that list must not start carrying them either:
 *
 * - `default_scene_pacing` — the starting scene rhythm episodes read until
 *   they save their own (AGENTS.md §5). It belongs to the episodes that
 *   settled it, never to a channel started from them.
 * - `voice_presets` / `voice_favourites` — app-wide voice curation, not this
 *   channel's. `updateConfig` writes these to app settings for the whole Mac,
 *   so carrying them here would silently replace every other channel's list.
 *   A channel's narration voice rides in on `audio_generator_presets` with the
 *   rest of its Audio presets.
 * - `channel_default_name` — this channel's marker as a saved starting point
 *   for a new channel (owner, 2026-10-31). A channel STARTED FROM a default
 *   is not itself a default: if the marker crossed, every copy would silently
 *   join the list of starting points and the list would grow without anyone
 *   choosing to. Named here even though the allow list below would already
 *   drop it, so a future widening of that list cannot start carrying it.
 */
const NEVER_COPIED_CONFIG_KEYS = new Set([
  'default_scene_pacing',
  'voice_presets',
  'voice_favourites',
  'channel_default_name',
])

/**
 * The config patch that carries a channel's reusable settings over: every
 * preset family and last-preset pointer (`*_presets`, `*_last_preset*` — the
 * Script, Scene Plan, Thumbnail, Audio/voice, Video Assembly and transition
 * pools alike), plus the two keys named above. Keys the source does not have
 * are simply not present, so a channel that never set one does not blank it on
 * the copy.
 */
export function copyableConfigSettings(source: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || NEVER_COPIED_CONFIG_KEYS.has(key)) continue
    if (!isPresetConfigKey(key) && !EXTRA_COPYABLE_CONFIG_KEYS.has(key)) continue
    patch[key] = value
  }
  return patch
}

/** The `POST /projects` body a copy sends: a name plus the Formula it inherits. */
export function copyableCreateRequest(name: string, source: ProjectMeta): CreateProjectRequest {
  const request: CreateProjectRequest = { name }
  for (const key of COPYABLE_CREATE_KEYS) {
    const value = (source as unknown as Record<string, unknown>)[key]
    if (value !== undefined) (request as unknown as Record<string, unknown>)[key] = value
  }
  return request
}
