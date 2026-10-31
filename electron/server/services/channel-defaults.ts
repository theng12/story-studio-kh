/**
 * Channel starting points — the owner's saved templates for a NEW channel
 * (owner, 2026-10-31): *"yes setting up the new channel… as we can have
 * several defaults to choose from."*
 *
 * A channel marked as a starting point carries a NAME in its own config
 * (`channel_default_name`). Empty or missing means it is not one. The name is
 * the only thing stored: WHICH channel it is comes from the channel itself,
 * so a marked channel that is deleted simply stops being offered — there is
 * no separate registry that could outlive it and offer a card whose source
 * is gone.
 *
 * The marker is deliberately NOT on the copy allow list
 * (`services/channel-settings-copy.ts`): a channel STARTED FROM a default is
 * not itself a default. If the marker crossed, every copy would silently
 * become another entry in this list, and the list would grow without anyone
 * choosing to.
 *
 * Everything the list shows is read LIVE from the channels on disk. Nothing
 * is cached: a marked channel's Formula, art style and preview are whatever
 * that channel says today, because a saved starting point is a POINTER to a
 * channel, not a frozen copy of one.
 */

import fs from 'fs/promises'
import path from 'path'

import * as pm from './project-manager.js'
import { withFormulaLabels } from './niche-loader.js'
import { resolveProjectArtStyle } from './art-style-resolver.js'
import { aliasedVisualStyleId } from '../content-packs/style-aliases.js'
import { sharedStylePreviewSlots } from './user-style-previews.js'
import { channelStyleSourceHash } from './channel-style-previews.js'
import type { ContentPackRegistryOptions } from '../content-packs/registry.js'
import type { ChannelDefaultSummary } from '../contracts/index.js'
import type { ProjectSummary, StylePreset } from '../models/types.js'

/**
 * The config key that marks a channel as a starting point. Its value is the
 * name the customer gave the starting point ("Warm History"), shown on the
 * card they pick it from.
 */
export const CHANNEL_DEFAULT_NAME_KEY = 'channel_default_name'

/** How long a starting point's name may be. Long enough to be a title, short
 * enough to fit on a card. */
export const CHANNEL_DEFAULT_NAME_MAX = 80

/**
 * The name a config carries as a starting point, or '' when it is not one.
 *
 * A blank string and a missing key mean the same thing — "not a starting
 * point" — and both read as '' here, so no caller has to tell them apart.
 */
export function readChannelDefaultName(config: unknown): string {
  if (!config || typeof config !== 'object') return ''
  const value = (config as Record<string, unknown>)[CHANNEL_DEFAULT_NAME_KEY]
  if (typeof value !== 'string') return ''
  return value.trim()
}

/** Whether this config makes its channel a starting point. */
export function isChannelDefault(config: unknown): boolean {
  return readChannelDefaultName(config).length > 0
}

/**
 * The starting-point name stored in one channel's own config.json, or ''.
 *
 * Read RAW, straight off disk, rather than through `pm.getConfig` — that
 * reader merges the whole image and voice catalogues into the answer, and the
 * list needs one string per channel. The raw file is where the key lives and
 * the only thing that reads it is this module and the marker route.
 */
export async function readChannelDefaultNameOnDisk(slug: string): Promise<string> {
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) return ''
  try {
    const raw = await fs.readFile(path.join(projectDir, 'config.json'), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    return readChannelDefaultName(parsed)
  } catch {
    // A missing or unreadable config.json is not a starting point. It is not
    // an error the customer has to hear about on a listing screen either.
    return ''
  }
}

/**
 * Normalise a requested starting-point name.
 *
 * An empty name is how the customer says "this is not a starting point
 * any more" — that is a legitimate request, not a missing value, so it is
 * returned as '' rather than refused. A name that is only whitespace is the
 * same request. Anything else is trimmed and length-checked.
 *
 * Returns `{ ok: true, name }` or `{ ok: false, detail }` with a plain
 * sentence the customer can read.
 */
export function normaliseChannelDefaultName(raw: unknown): { ok: true; name: string } | { ok: false; detail: string } {
  if (raw === undefined || raw === null) return { ok: true, name: '' }
  if (typeof raw !== 'string') {
    return { ok: false, detail: 'Give the starting point a name, or clear it to stop offering this channel.' }
  }
  const name = raw.trim()
  if (!name) return { ok: true, name: '' }
  if (name.length > CHANNEL_DEFAULT_NAME_MAX) {
    return { ok: false, detail: `A starting point's name can be up to ${CHANNEL_DEFAULT_NAME_MAX} characters.` }
  }
  return { ok: true, name }
}

/**
 * One saved starting point, as the create screen shows it.
 *
 * The wire shape lives in `contracts/index.ts` so the page that renders the
 * card and the route that serves it cannot drift apart. Every field is read
 * LIVE from the source channel as it is NOW — the card describes the channel
 * it points at, not a snapshot taken when it was marked.
 */
export type ChannelDefaultRow = ChannelDefaultSummary

/**
 * The source channel's art style picture.
 *
 * Resolved the same way the channel itself resolves its style
 * (`services/art-style-resolver.ts`), so the card names the look the channel
 * really uses — not the look its saved id would have used before the Studio
 * Library took it over.
 *
 * The picture is the style's own first preview: a Studio Library style's
 * verified hero, or a channel style's saved picture. Never a file path —
 * only a URL the app already serves.
 */
async function readArtStylePreview(
  slug: string,
  options: ContentPackRegistryOptions,
): Promise<{ name: string; preview: string }> {
  const resolution = await resolveProjectArtStyle(slug, options).catch(() => null)
  const config = (await pm.getConfig(slug).catch(() => null)) as {
    active_style_preset_id?: string
    style_presets?: StylePreset[]
  } | null
  const activeId = (config?.active_style_preset_id || '').trim()
  if (!activeId) return { name: '', preview: '' }

  const appliedName = resolution?.style?.name || resolution?.fallback?.requestedName || ''

  // A Studio Library style: its hero is a verified pack asset, served by the
  // content-pack asset route. Read it from the same catalogue the Style
  // Library reads, so the card and the library show the same picture.
  const { loadVisualStyle } = await import('./visual-style-loader.js')
  const signed = await loadVisualStyle(activeId, options).catch(() => null)
  if (signed) return { name: signed.name || appliedName, preview: signed.preview_image || '' }

  // The channel names a look the Studio Library now owns under another id.
  const aliasId = aliasedVisualStyleId(activeId)
  if (aliasId) {
    const adopted = await loadVisualStyle(aliasId, options).catch(() => null)
    if (adopted) return { name: adopted.name || appliedName, preview: adopted.preview_image || '' }
  }

  // A channel's OWN style: its previews live in the shared store under the
  // hash of the style text, or beside the channel in `style-previews/`.
  const presets = Array.isArray(config?.style_presets) ? config.style_presets : []
  const preset = presets.find(entry => entry && entry.id === activeId)
  if (!preset) return { name: appliedName, preview: '' }

  const slots = await sharedStylePreviewSlots(channelStyleSourceHash(preset)).catch(() => [])
  if (slots.length) return { name: preset.name || appliedName, preview: slots[0]!.url }

  // The older project-local picture. Served by the style-preset preview route.
  const stored = preset.preview_filename
    || (Array.isArray(preset.preview_files) ? preset.preview_files[0] : undefined)
  if (stored) {
    return {
      name: preset.name || appliedName,
      preview: `/api/projects/${encodeURIComponent(slug)}/style-presets/${encodeURIComponent(preset.id)}/preview?file=${encodeURIComponent(stored)}`,
    }
  }

  return { name: preset.name || appliedName, preview: '' }
}

/**
 * Every saved starting point on this Mac, live.
 *
 * A channel that has since been DELETED, hidden or lost its project folder is
 * simply not here: the list is built by reading the channels that exist, so
 * there is nothing to clean up and no stale entry to hide. (The same rule the
 * copy path uses — the source must exist — so a card never offers a start
 * that cannot happen.)
 */
export async function listChannelDefaults(
  options: ContentPackRegistryOptions = {},
): Promise<ChannelDefaultSummary[]> {
  const projects = await pm.listProjects()
  const marked: Array<{ slug: string; name: string; meta: ProjectSummary }> = []
  for (const project of projects) {
    const name = await readChannelDefaultNameOnDisk(project.slug)
    if (!name) continue
    marked.push({ slug: project.slug, name, meta: project })
  }
  if (!marked.length) return []

  // The Formula names come from ONE catalogue read for the whole list, the
  // same way the channel list resolves them.
  const labelled = await withFormulaLabels(marked.map(row => ({
    niche_id: row.meta?.niche_id,
    formula_choice: row.meta?.formula_choice,
  })), options)
  const formulaNames = new Map(labelled.map((row, index) => [marked[index]!.slug, row.formula_name ?? '']))

  return Promise.all(marked.map(async row => {
    const art = await readArtStylePreview(row.slug, options).catch(() => ({ name: '', preview: '' }))
    return {
      name: row.name,
      source_slug: row.slug,
      source_name: row.meta?.name ?? row.slug,
      formula_name: formulaNames.get(row.slug) ?? '',
      art_style_name: art.name,
      art_style_preview: art.preview,
    }
  }))
}
