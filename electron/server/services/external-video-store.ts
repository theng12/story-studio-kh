/**
 * External final-video storage path resolver.
 *
 * Why this exists: sleep-story episodes produce 5-10 GB final videos.
 * When the project lives in a synced folder (iCloud Drive, Dropbox,
 * etc.), every assembled video drags multi-GB through the sync loop —
 * slow on big libraries, expensive on small devices. Letting the user
 * point ffmpeg at a separate local-only path keeps a working copy
 * outside the sync tree without touching the rest of the project.
 *
 * Design:
 *   - The path is an APP-LEVEL setting (`external_final_video_root`)
 *     stored in `app-settings.json`. Per-machine — never syncs. A
 *     fresh laptop just leaves it empty and falls back to the
 *     in-project location.
 *   - When set, finals land at `{root}/{slug}/Season NNN/{code} - {title}/`
 *     (mirrors the project tree's season segmentation so each project
 *     gets its own subtree under the external root).
 *   - Detection in asset-status reads from BOTH the project tree and
 *     this external location, so a final video at either place lights
 *     up `video_assembly: true`.
 *   - Per-scene Veo/fal clips stay in the project tree — they're inputs
 *     to the assembly pass and the user might or might not want to
 *     move them. Storage UI surfaces them but defaults to "final-only"
 *     for cleanup.
 */

import path from 'path'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import * as pm from './project-manager.js'
import { getAppSetting, setAppSetting } from './app-settings.js'

/** App-settings key. Keep stable — migration paths key off it. */
export const EXTERNAL_FINAL_VIDEO_ROOT_KEY = 'external_final_video_root'

/**
 * Read the configured external root, expanding `~` to the user's home
 * dir. Returns empty string when unset or invalid (non-string).
 */
export async function getExternalFinalVideoRoot(): Promise<string> {
  const raw = await getAppSetting(EXTERNAL_FINAL_VIDEO_ROOT_KEY)
  if (typeof raw !== 'string' || !raw.trim()) return ''
  let resolved = raw.trim()
  if (resolved.startsWith('~')) {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    if (home) resolved = path.join(home, resolved.slice(1))
  }
  return resolved
}

export async function setExternalFinalVideoRoot(value: string): Promise<void> {
  await setAppSetting(EXTERNAL_FINAL_VIDEO_ROOT_KEY, value || '')
}

/**
 * Compute the canonical external directory for one episode's final
 * video. Returns `null` when no external root is configured.
 *
 * Path shape:
 *   {externalRoot}/{slug}/Season NNN/{code} - {title}/
 *
 * The season segment uses the project's `season_size` + `season_prefix`,
 * matching the project tree's folder template. We replicate the same
 * math here rather than calling `resolveEpisodePaths` because the
 * external root has its own `output_root` (not the project's). Keeps
 * cross-machine semantics clean — different machines can point at
 * different roots without the project json changing.
 */
export async function resolveExternalFinalVideoDir(
  slug: string,
  code: string,
  title: string,
): Promise<string | null> {
  const root = await getExternalFinalVideoRoot()
  if (!root) return null

  const meta = await pm.getProject(slug)
  if (!meta) return null

  const seasonSize = (meta as any).season_size || 20
  const seasonPrefix = (meta as any).season_prefix || 'Season'
  const folderTemplate = (meta as any).folder_template
    || '{season_prefix} {season_num}/{code} - {title}/'

  // Pull the numeric portion of the code via the project's prefix so
  // arbitrary prefixes (TN/EP/etc.) all parse correctly.
  const epNum = parseInt(code.replace(meta.episode_prefix, ''), 10) || 1
  const seasonNum = Math.floor((epNum - 1) / seasonSize) + 1

  const episodeRel = folderTemplate
    .replace('{season_prefix}', seasonPrefix)
    .replace('{season_num}', seasonNum.toString().padStart(3, '0'))
    .replace('{code}', code)
    .replace('{title}', title || code)

  return path.join(root, slug, episodeRel)
}

/**
 * Ensure the external dir for an episode exists, creating parents if
 * needed. Used by the writer (video-assembly generator) before it asks
 * ffmpeg to dump a file there.
 */
export async function ensureExternalFinalVideoDir(
  slug: string,
  code: string,
  title: string,
): Promise<string | null> {
  const dir = await resolveExternalFinalVideoDir(slug, code, title)
  if (!dir) return null
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/**
 * Quick existence check used by the migration scanner. Avoids loading
 * the full sized stat — just returns whether the external root is set
 * AND that root's directory itself is reachable. Doesn't validate
 * write permission (the writer will surface that error directly when
 * it tries to mkdir or write).
 */
export async function externalRootIsReachable(): Promise<{ ok: boolean; root: string; reason?: string }> {
  const root = await getExternalFinalVideoRoot()
  if (!root) return { ok: false, root: '', reason: 'External final video root is not configured.' }
  if (!existsSync(root)) {
    return { ok: false, root, reason: `External root does not exist: ${root}` }
  }
  return { ok: true, root }
}
