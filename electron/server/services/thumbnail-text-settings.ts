/**
 * Thumbnail text layer — per-episode language override.
 *
 * The thumbnail headline language follows the channel's own setting
 * (`project.content_language`, read through `lib/content-language.ts`) unless the owner picks a
 * different one for one episode's thumbnail text. That choice is EPISODE state, so it lives in the
 * episode's own folder — beside `sketch_pen.json` and `scene_effects.json`, not in `config.json`
 * (channel-wide, which made one episode's choice leak onto every other — AGENTS §4) and never in a
 * thumbnail-text preset (reusable look only — AGENTS §5).
 *
 *   <episode>/thumbnail_text.json   { "schema": 1, "language": "en" | "km" | null }
 *
 * `language: null` means "follow the channel language" and is WRITTEN rather than deleting the file,
 * the same shape `episode-sketch-pen.ts` uses — so "following" is a choice the owner made, not an
 * absent file everyone has to guess at.
 *
 * It stores the SELECTION only; the channel's language is read live from the project every time, so
 * switching the channel's language moves every episode that still follows it (AGENTS §1).
 */

import fs from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { normalizeContentLanguage, type ContentLanguage } from '../lib/content-language.js'
import { resolveEpisodePathsByCodeWithSidecar } from './utils.js'
import { EpisodeSettingFileUnreadable } from './episode-sketch-pen.js'

export const THUMBNAIL_TEXT_SETTINGS_FILENAME = 'thumbnail_text.json'
export const THUMBNAIL_TEXT_SETTINGS_SCHEMA = 1

/** True when a value is a language the layer can be written in (the app's own two). */
export function isThumbnailTextLanguage(value: unknown): value is ContentLanguage {
  return normalizeContentLanguage(value) !== null
}

/** The episode's own folder. Resolved so a renamed folder that already carries the setting is found. */
async function episodeDir(slug: string, episodeId: string): Promise<string> {
  return (await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, THUMBNAIL_TEXT_SETTINGS_FILENAME)).episode_dir
}

/**
 * This episode's chosen thumbnail-text language.
 *
 * `null` means "follow the channel language" — an absent file AND an explicit `null` both answer
 * that way (unlike a malformed file, which is an unreadable setting rather than a silent follow).
 */
export async function readThumbnailTextLanguage(slug: string, episodeId: string): Promise<ContentLanguage | null> {
  const file = path.join(await episodeDir(slug, episodeId), THUMBNAIL_TEXT_SETTINGS_FILENAME)
  let raw: string
  try { raw = await fs.readFile(file, 'utf8') }
  catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  let value: unknown
  try { value = JSON.parse(raw) }
  catch {
    throw new EpisodeSettingFileUnreadable(
      `This episode's thumbnail text language file (${THUMBNAIL_TEXT_SETTINGS_FILENAME} for ${episodeId}) is malformed and cannot be read. Choose the language again in the thumbnail text editor to rewrite it.`,
    )
  }
  const language = (value as { language?: unknown } | null)?.language
  if (language === null || language === undefined) return null
  if (!isThumbnailTextLanguage(language)) {
    throw new EpisodeSettingFileUnreadable(
      `This episode's thumbnail text language file (${THUMBNAIL_TEXT_SETTINGS_FILENAME} for ${episodeId}) names a language the app does not support. Choose the language again in the thumbnail text editor to rewrite it.`,
    )
  }
  return language
}

/**
 * Set this episode's thumbnail-text language, or pass null to follow the channel language again.
 *
 * Refuses when the episode has no folder yet rather than creating one — a settings write must never
 * make a stray `EP9999 - /` that nothing else in the app knows about.
 */
export async function writeThumbnailTextLanguage(
  slug: string,
  episodeId: string,
  language: ContentLanguage | null,
): Promise<void> {
  if (language !== null && !isThumbnailTextLanguage(language)) {
    throw new Error('Choose a language the app supports.')
  }
  const dir = await episodeDir(slug, episodeId)
  if (!existsSync(dir)) {
    throw new Error(`Story Studio could not find ${episodeId}'s folder, so nothing was saved.`)
  }
  const file = path.join(dir, THUMBNAIL_TEXT_SETTINGS_FILENAME)
  await withLock(file, async () => {
    await writeJsonAtomic(file, { schema: THUMBNAIL_TEXT_SETTINGS_SCHEMA, language })
  })
}

/**
 * The language the thumbnail text is actually written in, and its source.
 *
 * `override` wins when the episode states one; otherwise the channel's own language; otherwise
 * nothing (the suggestions fall back to script/title detection, exactly as before).
 */
export function effectiveThumbnailTextLanguage(
  override: ContentLanguage | null,
  channelLanguage: ContentLanguage | null,
): { language: ContentLanguage | null; source: 'override' | 'channel' | null } {
  if (override) return { language: override, source: 'override' }
  if (channelLanguage) return { language: channelLanguage, source: 'channel' }
  return { language: null, source: null }
}
