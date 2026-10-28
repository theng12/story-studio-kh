/**
 * External media root (Level B, opt-in split storage).
 *
 * A project MAY set `media_root` in project.json to route its HEAVY media
 * subfolders (scene images, thumbnails, audio, merged audio, final video) to a
 * separate root — typically an external SSD — while the LIGHT artifacts
 * (script, metadata, prompts, subtitles, episode-root sidecars, project.json)
 * stay in the project folder.
 *
 * Fully opt-in: when `media_root` is absent (the default) every helper here is
 * a no-op and callers fall back to the episode dir — behavior is byte-for-byte
 * unchanged. See docs/external-media-root-spec.md.
 *
 * v1.4.249: retired for projects that do not use it. `PUT /projects/:slug`
 * refuses to set one on a project without it; a project that has one keeps
 * working and may change or clear it (Settings → Project files & behavior →
 * Advanced). Nothing here moves data.
 *
 * `media_root` is an absolute path or a `${NAME}` token (e.g. `${ASSET}/Media`).
 */

import { existsSync } from 'fs'
import path from 'path'
import { resolveAssetPath } from './path-resolver.js'
import type { ProjectFactsCache } from './utils.js'

/**
 * Episode subfolder KEYS (matching SubfolderNames keys) whose contents are
 * large media — eligible to live under an external media_root. Everything not
 * listed here always stays in the project folder.
 */
export const HEAVY_SUBFOLDERS: ReadonlySet<string> = new Set([
  'images', 'thumbnails', 'audio', 'merged_audio', 'video', 'video_assets',
])

export function isHeavySubfolder(key: string): boolean {
  return HEAVY_SUBFOLDERS.has(key)
}

/**
 * Resolve the external media base dir for one episode, or null when the
 * project hasn't opted in OR the media root can't be resolved on this machine.
 *
 *   mediaRootRaw — the project's `media_root` (a `${NAME}` token or an absolute
 *                  path). Falsy/blank ⇒ null (opt-out, the default).
 *   episodeRel   — the same relative episode path used under the episodes
 *                  folder, so the SSD layout mirrors the project folder exactly.
 *   outputRoot   — the project's ABSOLUTE episodes folder (only used to expand
 *                  a `${PROJECT}` token, which would be unusual for a media
 *                  root).
 *
 * Returns null rather than throwing when the token is undefined on this machine
 * (an unknown `${NAME}`). That keeps
 * LIGHT-only operations working everywhere; media operations gate on a separate
 * preflight (added in a later phase) that fails loud with a clear message.
 * Returns a path even when the SSD is merely unplugged — the later fs op then
 * fails loud naturally with ENOENT on a concrete path.
 */
export function resolveMediaBase(
  mediaRootRaw: string | undefined | null,
  episodeRel: string,
  outputRoot?: string,
): string | null {
  if (!mediaRootRaw || typeof mediaRootRaw !== 'string' || !mediaRootRaw.trim()) return null
  let base: string
  try {
    base = resolveAssetPath(mediaRootRaw.trim(), outputRoot)
  } catch {
    // Named root undefined on this machine — defer to a media-op preflight
    // rather than breaking the (light) path computation here.
    return null
  }
  // resolveAssetPath returns the input unchanged for non-portable strings; if
  // it still looks like an unexpanded token, treat as unresolved.
  if (!base || /^\$\{/.test(base)) return null
  return path.join(base, episodeRel)
}

/**
 * Media-aware drop-in for the call sites that resolved their OWN
 * episode dir and then did `resolveSubfolder(episodeDir, names[key])`.
 *
 *   - LIGHT subfolder, OR project has no media_root  → resolves the subfolder
 *     inside the caller's `episodeDir` exactly as before (so the
 *     drift/✅-tolerant episode dir the caller already found is preserved).
 *   - HEAVY subfolder + media_root set               → resolves the subfolder
 *     inside the mirrored media (SSD) episode dir.
 *
 * Determines the media episode dir from `resolveEpisodePathsByCode` (which is
 * itself media-aware): the parent of its heavy `bg_dir` is the media base when
 * a media_root is configured, or the episode dir when it isn't — so a
 * non-split project takes the unchanged path with zero behavioural difference.
 */
/**
 * The base episode dir to use for `key`: the media (SSD) episode dir for a
 * HEAVY subfolder when media_root is configured, else the caller's already-
 * resolved episode dir (preserving its drift/✅ tolerance). For a
 * non-split project this always returns `episodeDir` — zero behaviour
 * change on the default path.
 */
/**
 * The mirrored media (SSD) episode dir for `code`, or null when the project has
 * no media_root configured (or it can't be resolved on this machine). Lets call
 * sites with bespoke episode-dir logic re-route ONLY when media is active,
 * preserving their default-path behavior untouched.
 */
export async function mediaEpisodeBaseForCode(
  slug: string,
  code: string,
  cache?: ProjectFactsCache,
): Promise<string | null> {
  const { episodeNumber, storedEpisodeNumber, projectMetaOnce, resolveEpisodePathsByCode } = await import('./utils.js')
  // No `media_root` ⇒ every heavy subfolder sits under the episode dir, so the
  // caller's own episode dir is already correct. Answering that costs ONE cached
  // read of project.json; resolving the full path set instead also reads
  // ideas.json (to recover the episode title) and resolves ~15 subfolders, just
  // to compare two paths that are guaranteed equal. On the owner's 302-episode
  // project this ran once per episode — 2,360 `readFile` calls of project.json
  // and 1,340 of ideas.json for a comparison that always said "not split".
  const meta = await projectMetaOnce(slug, cache)
  if (!meta?.media_root || !String(meta.media_root).trim()) {
    // The fast path must not be quieter than the slow one. A WRITE reaches here
    // through `resolveEpisodeSubfolderDir`, which creates the folder it is
    // handed, so a code that names no episode must still be refused. Since
    // 2026-10-28 `resolveEpisodePaths` reads a STORED code's number whatever its
    // prefix (an episode accepted as AU0001 keeps that code after the channel's
    // prefix changes) and refuses only a code with no number at all — ask the
    // same question here rather than refusing the channel's own episode.
    if (storedEpisodeNumber(code) === null) episodeNumber(code, meta?.episode_prefix || 'EP')
    return null
  }

  const paths = await resolveEpisodePathsByCode(slug, code, cache)
  const mediaBase = path.dirname(paths.bg_dir)
  // media_root set but unresolvable on this machine ⇒ bg_dir sits under
  // episode_dir (see resolveEpisodePaths), so there is no split to route.
  return path.resolve(mediaBase) === path.resolve(paths.episode_dir) ? null : mediaBase
}

/**
 * Fail-loud preflight for media-WRITING operations. No-op for projects without
 * a `media_root` (the default). When media_root IS set, throws a clear,
 * actionable error if the root can't be resolved on this machine (`${NAME}`
 * undefined) or the resolved folder doesn't exist (drive unplugged) — so we
 * never silently write heavy media back into the project folder (split-brain).
 * Light operations don't call this, so they keep working without the drive.
 */
export async function assertMediaRootReady(slug: string): Promise<void> {
  const pm = await import('./project-manager.js')
  const meta = await pm.getProject(slug)
  const raw = (meta as any)?.media_root
  if (!raw || !String(raw).trim()) return // not a split project — nothing to check
  const outputRoot = (await pm.getProjectOutputRoot(slug)) || undefined
  let abs: string
  try {
    abs = resolveAssetPath(String(raw).trim(), outputRoot)
  } catch {
    throw new Error(`This project's heavy-media folder ${raw} can't be found on this Mac. Connect the drive, or change or clear the folder in Settings → Project files & behavior → Advanced, before generating or rendering media.`)
  }
  if (!abs || /^\$\{/.test(abs)) {
    throw new Error(`This project's heavy-media folder ${raw} can't be found on this Mac. Change or clear it in Settings → Project files & behavior → Advanced.`)
  }
  if (!existsSync(abs)) {
    throw new Error(`This project's heavy-media folder isn't available: ${abs}. Connect the drive (or change the folder in Settings → Project files & behavior → Advanced) before generating or rendering media.`)
  }
}

async function baseEpisodeDirForKey(
  slug: string, code: string, key: string, episodeDir: string, cache?: ProjectFactsCache,
): Promise<string> {
  if (!isHeavySubfolder(key)) return episodeDir
  return (await mediaEpisodeBaseForCode(slug, code, cache)) ?? episodeDir
}

/**
 * Media-aware drop-in for `resolveSubfolder(episodeDir, names[key])` — the
 * CREATING variant (writers). Light subfolders / non-split projects behave
 * identically to before.
 */
export async function resolveEpisodeSubfolderDir(
  slug: string, code: string, key: string,
  episodeDir: string, subfolderName: string, createIfMissing = true,
  cache?: ProjectFactsCache,
): Promise<string> {
  const base = await baseEpisodeDirForKey(slug, code, key, episodeDir, cache)
  const { resolveSubfolder } = await import('../lib/folder-resolver.js')
  return resolveSubfolder(base, subfolderName, createIfMissing)
}

/**
 * Media-aware drop-in for `findSubfolder(episodeDir, names[key])` — the
 * NON-creating variant (scans / status). Returns null when the subfolder
 * doesn't exist, mirroring `findSubfolder`.
 */
export async function findEpisodeSubfolderDir(
  slug: string, code: string, key: string,
  episodeDir: string, subfolderName: string,
  cache?: ProjectFactsCache,
): Promise<string | null> {
  const base = await baseEpisodeDirForKey(slug, code, key, episodeDir, cache)
  const { findSubfolder } = await import('../lib/folder-resolver.js')
  return findSubfolder(base, subfolderName)
}
