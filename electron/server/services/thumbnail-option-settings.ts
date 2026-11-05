/**
 * Thumbnail option settings — the per-episode sidecar beside the authoritative
 * numbered `*_Thumbnail_Prompts.md`.
 *
 *   <episode>/thumbnail_options.json
 *     { "schema": 1, "auto_approve": false,
 *       "options": { "1": { "thumbnail_template_id": "...", ...,
 *                           "approved_prompt_sha256": "<sha256 of the prompt text>" } } }
 *
 * The prompts Markdown stays the only source of WHAT a prompt says; this file
 * only carries each option's own selections and the approval hash. Approval is
 * a hash comparison, never a stored "yes": re-read the current prompt, hash it,
 * and a mismatch (the prompt was edited) reads as not approved. Nothing has to
 * touch the prompts file when a prompt changes.
 *
 * EPISODE state (AGENTS §4): the file lives in the episode's own folder via
 * `resolveEpisodePathsByCodeWithSidecar`, never in `config.json` and never in a
 * preset (AGENTS §5). A read NEVER creates the file — an episode with no
 * sidecar is a legacy episode that reads as empty defaults and stays on disk
 * exactly as it was (no backfill).
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { createHash } from 'crypto'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { resolveEpisodePathsByCodeWithSidecar } from './utils.js'
import { EpisodeSettingFileUnreadable } from './episode-sketch-pen.js'
import {
  THUMBNAIL_OPTIONS_SCHEMA,
  ThumbnailOptionSettingsSchema,
  type ThumbnailOptionSettings,
  type ThumbnailOptionStored,
} from '../contracts/thumbnail-options.js'

export const THUMBNAIL_OPTIONS_FILENAME = 'thumbnail_options.json'

/** An episode that has never saved option metadata. Read-only default. */
export function emptyThumbnailOptionSettings(): ThumbnailOptionSettings {
  return { schema: THUMBNAIL_OPTIONS_SCHEMA, auto_approve: false, options: {} }
}

/** The episode's own folder, resolved so a renamed folder carrying the sidecar is found. */
async function episodeDir(slug: string, episodeId: string): Promise<string> {
  return (await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, THUMBNAIL_OPTIONS_FILENAME)).episode_dir
}

/**
 * This episode's option metadata. Never writes: an absent file answers with the
 * empty defaults, a malformed file is an unreadable setting (loud, by name)
 * rather than a silent reset of the customer's choices.
 */
export async function readThumbnailOptionSettings(slug: string, episodeId: string): Promise<ThumbnailOptionSettings> {
  const file = path.join(await episodeDir(slug, episodeId), THUMBNAIL_OPTIONS_FILENAME)
  let raw: string
  try { raw = await fs.readFile(file, 'utf8') }
  catch (error: any) {
    if (error?.code === 'ENOENT') return emptyThumbnailOptionSettings()
    throw error
  }
  let value: unknown
  try { value = JSON.parse(raw) }
  catch {
    throw new EpisodeSettingFileUnreadable(
      `This episode's thumbnail option file (${THUMBNAIL_OPTIONS_FILENAME} for ${episodeId}) is malformed and cannot be read. Restore a valid copy before saving option settings.`,
    )
  }
  const parsed = ThumbnailOptionSettingsSchema.safeParse(value)
  if (!parsed.success) {
    throw new EpisodeSettingFileUnreadable(
      `This episode's thumbnail option file (${THUMBNAIL_OPTIONS_FILENAME} for ${episodeId}) is malformed and cannot be read. Restore a valid copy before saving option settings.`,
    )
  }
  return value as ThumbnailOptionSettings
}

/**
 * Persist the whole sidecar. Refuses when the episode has no folder yet rather
 * than creating one — a settings write must never make a stray folder nothing
 * else in the app knows about (same rule as `thumbnail_text.json`).
 */
export async function updateThumbnailOptionSettings(
  slug: string,
  episodeId: string,
  update: (settings: ThumbnailOptionSettings) => ThumbnailOptionSettings,
): Promise<ThumbnailOptionSettings> {
  const dir = await episodeDir(slug, episodeId)
  if (!existsSync(dir)) {
    throw new Error(`Story Studio could not find ${episodeId}'s folder, so nothing was saved.`)
  }
  const file = path.join(dir, THUMBNAIL_OPTIONS_FILENAME)
  return withLock(file, async () => {
    const settings = update(await readThumbnailOptionSettings(slug, episodeId))
    ThumbnailOptionSettingsSchema.parse(settings)
    await writeJsonAtomic(file, settings)
    return settings
  })
}

/** The hash an approval is pinned to: SHA-256 of the prompt text as read from the Markdown file. */
export function thumbnailPromptSha256(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex')
}

/**
 * Is this option approved against the prompt as it stands RIGHT NOW?
 *
 * `currentPromptSha` is the hash of the current prompt text, or null when no
 * prompt for that number could be read (no file) — no prompt means nothing to
 * approve. The episode's `auto_approve` switch skips the gate entirely; it is
 * off unless the customer turned it on.
 */
export function thumbnailOptionApproved(
  settings: ThumbnailOptionSettings,
  number: number,
  currentPromptSha: string | null,
): boolean {
  if (!currentPromptSha) return false
  if (settings.auto_approve === true) return true
  const stored = settings.options[String(number)]
  if (!stored?.approved_prompt_sha256 || !currentPromptSha) return false
  return stored.approved_prompt_sha256 === currentPromptSha
}

/** Merge ONE option into the stored settings, leaving every sibling option untouched. */
export function mergeThumbnailOption(
  settings: ThumbnailOptionSettings,
  number: number,
  patch: Omit<ThumbnailOptionStored, 'approved_prompt_sha256'> & {
    approved_prompt_sha256?: string | null
  },
): ThumbnailOptionSettings {
  const key = String(number)
  const existing = { ...(settings.options[key] ?? {}) }
  const next: ThumbnailOptionStored = { ...existing }
  for (const field of ['thumbnail_template_id', 'style_tag', 'thumb_font_style', 'thumb_text_style', 'thumb_text_position'] as const) {
    const value = patch[field]
    if (value !== undefined) next[field] = value
  }
  if (patch.approved_prompt_sha256 === null) delete next.approved_prompt_sha256
  else if (patch.approved_prompt_sha256 !== undefined) next.approved_prompt_sha256 = patch.approved_prompt_sha256
  return { ...settings, options: { ...settings.options, [key]: next } }
}
