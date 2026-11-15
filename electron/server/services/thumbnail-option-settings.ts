/**
 * Thumbnail option settings — the per-episode sidecar beside the authoritative
 * numbered `*_Thumbnail_Prompts.md`.
 *
 *   <episode>/thumbnail_options.json
 *     { "schema": 1, "auto_approve": false,   // optional: absent = channel default
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
import { getConfig } from './project-manager.js'
import { getThumbnailStyleTextLimit } from './app-settings.js'
import {
  THUMBNAIL_OPTIONS_SCHEMA,
  ThumbnailOptionSettingsSchema,
  type ThumbnailOptionSettings,
  type ThumbnailOptionStored,
} from '../contracts/thumbnail-options.js'

export const THUMBNAIL_OPTIONS_FILENAME = 'thumbnail_options.json'

/** An episode that has never saved option metadata. Read-only default: no
 *  per-episode choice, so the channel's reusable setting applies. */
export function emptyThumbnailOptionSettings(): ThumbnailOptionSettings {
  return { schema: THUMBNAIL_OPTIONS_SCHEMA, options: {} }
}

/**
 * The channel's reusable "Auto-approve thumbnail prompts" switch, read from
 * `config.auto_approve_thumbnail_prompts` (owner-approved 2026-11-08). ON
 * unless explicitly false. A config that cannot be read also reads ON: this is
 * the existing permissive workflow, and a read failure must not start refusing
 * renders nobody switched off.
 */
export async function thumbnailPromptsAutoApproveDefault(slug: string): Promise<boolean> {
  const config = await getConfig(slug).catch(() => null)
  return (config as any)?.auto_approve_thumbnail_prompts !== false
}

/**
 * What this episode will actually do. An explicit per-episode choice wins;
 * otherwise the channel's saved default is inherited. `inherited` lets the UI
 * say so honestly rather than presenting the default as an episode choice.
 */
export async function effectiveThumbnailAutoApprove(
  slug: string,
  settings: ThumbnailOptionSettings,
): Promise<{ auto_approve: boolean; inherited: boolean }> {
  if (typeof settings.auto_approve === 'boolean') {
    return { auto_approve: settings.auto_approve, inherited: false }
  }
  return { auto_approve: await thumbnailPromptsAutoApproveDefault(slug), inherited: true }
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
    const current = await readThumbnailOptionSettings(slug, episodeId)
    const settings = update(current)
    await assertStyleTextWithinLimit(current, settings)
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

/**
 * A NEW or CHANGED lettering/headline description must fit the owner's current ceiling
 * (Settings → Performance & recovery, 1,000 by default). Unchanged stored values are never
 * re-judged, so lowering the ceiling can never make an episode's own saved choices unreadable or
 * unwritable — it only refuses new prose past it.
 *
 * This is the one place every write passes through: the generator's initialization, the Image
 * Prompts page's option editor and option duplication all end at `updateThumbnailOptionSettings`.
 */
async function assertStyleTextWithinLimit(
  previous: ThumbnailOptionSettings,
  next: ThumbnailOptionSettings,
): Promise<void> {
  const limit = await getThumbnailStyleTextLimit()
  for (const [key, option] of Object.entries(next.options ?? {})) {
    const before = previous.options?.[key]
    for (const field of ['thumb_font_style', 'thumb_text_style'] as const) {
      const value = option?.[field]
      if (typeof value !== 'string' || value === before?.[field]) continue
      if (value.length <= limit) continue
      const which = field === 'thumb_font_style' ? 'font' : 'text'
      throw Object.assign(
        new Error(
          `Thumbnail ${key}'s ${which} description is ${value.length.toLocaleString('en-US')} characters, over the ${limit.toLocaleString('en-US')}-character limit. Shorten it, or raise the limit in Settings → Performance & recovery.`,
        ),
        { statusCode: 400, expose: true },
      )
    }
  }
}

export async function initializeThumbnailOptions(
  slug: string,
  episodeId: string,
  numbers: number[],
  defaults: Omit<ThumbnailOptionStored, 'approved_prompt_sha256'> = {},
): Promise<void> {
  await updateThumbnailOptionSettings(slug, episodeId, settings => {
    for (const number of numbers) {
      if (!settings.options[String(number)]) settings = mergeThumbnailOption(settings, number, defaults)
    }
    return settings
  })
}

/** Legacy episodes without metadata inherit the channel default like any other. */
export async function assertThumbnailOptionsApproved(
  slug: string,
  episodeId: string,
  prompts: Array<{ number: number; prompt: string }>,
): Promise<void> {
  const settings = await readThumbnailOptionSettings(slug, episodeId)
  const { auto_approve } = await effectiveThumbnailAutoApprove(slug, settings)
  if (auto_approve) return
  const pending = prompts.filter(item => !thumbnailOptionApproved(settings, item.number, thumbnailPromptSha256(item.prompt.trim())))
  if (pending.length) throw new Error(`Approve thumbnail prompt(s) ${pending.map(item => item.number).join(', ')} in Thumbnail Prompts before rendering, or deliberately turn on automatic prompt approval for this episode. No image request was submitted.`)
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
