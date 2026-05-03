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

// ── External rename cascade (v1.0.43) ─────────────────────────────────────
//
// All in-project rename ops (Compact, single Renumber, orphan-renumber,
// and their reverts) walk the project tree to update folders + asset
// filenames when an episode_code changes. Until v1.0.43 they didn't
// touch the external root mirror — so any episode whose final video
// lived in `external_final_video_root/{slug}/Season NNN/{code} - {title}/`
// kept its OLD code in the path. The next upload of that episode
// then failed with "No final video file found" because the resolver
// looked at the new code's external path and got an empty dir.
//
// `renameExternalEpisodeDir` closes that gap. Each rename caller
// invokes it after the project-tree rename succeeds. Failures are
// non-fatal: external root might be unmounted, on a different
// filesystem (USB / NAS), or unset entirely on this machine — none
// of those should block the project-tree rename, which is the more
// load-bearing path. Callers should append any returned error
// message to their result's `errors` array so the user can see what
// didn't migrate.

export interface RenameExternalResult {
  /** True when the external root is configured AND the old dir existed. */
  attempted: boolean
  /** True when the actual rename + inner file walk succeeded. */
  renamed: boolean
  /** Resolved path the rename moved FROM (or null when not attempted). */
  from_dir: string | null
  /** Resolved path the rename moved TO. */
  to_dir: string | null
  /** Human-readable reason when something didn't go through. */
  detail?: string
}

/**
 * Rename the external mirror dir for one episode + its inner files.
 *
 * Three reasons this might no-op (all return `attempted: false`):
 *   1. No external root configured on this machine — fine, project
 *      data is still consistent and other machines that DO have the
 *      external root configured will see the renamed code via
 *      resolveExternalFinalVideoDir on next access.
 *   2. Old dir doesn't exist — the user hasn't rendered to external
 *      yet for this episode, or already manually moved it. Either
 *      way, nothing to do.
 *   3. Old + new dirs resolve to the same path (caller passed
 *      identical codes) — guard against silent destructive renames.
 *
 * EXDEV (cross-filesystem) is handled by recursive copy + rm —
 * matches the same fallback every other rename helper uses.
 */
export async function renameExternalEpisodeDir(
  slug: string,
  oldCode: string,
  newCode: string,
  title: string,
): Promise<RenameExternalResult> {
  if (oldCode === newCode) {
    return { attempted: false, renamed: false, from_dir: null, to_dir: null, detail: 'old_code === new_code' }
  }
  const oldDir = await resolveExternalFinalVideoDir(slug, oldCode, title)
  const newDir = await resolveExternalFinalVideoDir(slug, newCode, title)
  if (!oldDir || !newDir) {
    return { attempted: false, renamed: false, from_dir: oldDir, to_dir: newDir, detail: 'External final video root is not configured on this machine.' }
  }
  if (!existsSync(oldDir)) {
    return { attempted: false, renamed: false, from_dir: oldDir, to_dir: newDir, detail: 'No external dir for this episode — skipping.' }
  }

  try {
    await fs.mkdir(path.dirname(newDir), { recursive: true })
    try {
      await fs.rename(oldDir, newDir)
    } catch (e: any) {
      if (e?.code === 'EXDEV') {
        // Cross-filesystem fallback — same pattern as upload-orphans.ts.
        await copyDirRecursive(oldDir, newDir)
        await fs.rm(oldDir, { recursive: true, force: true })
      } else if (e?.code === 'ENOTEMPTY' || e?.code === 'EEXIST' || e?.code === 'EISDIR') {
        return {
          attempted: true, renamed: false, from_dir: oldDir, to_dir: newDir,
          detail: `Target external dir already exists at ${newDir}. Move or delete it manually, then re-run.`,
        }
      } else {
        throw e
      }
    }
    // Per-file rename inside the new dir — the external root only
    // holds the final video + its supporting files (transcript,
    // thumbnail copy if the user pinned one), so this is shallow.
    // Recurse one level for any subfolder the user happened to
    // create (e.g. side-by-side captions/) — same pattern the
    // project-tree helper uses.
    await renameCodeScopedFilesIn(newDir, oldCode, newCode)

    return { attempted: true, renamed: true, from_dir: oldDir, to_dir: newDir }
  } catch (e: any) {
    return {
      attempted: true, renamed: false, from_dir: oldDir, to_dir: newDir,
      detail: e?.message || 'External rename failed',
    }
  }
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const e of entries) {
    const s = path.join(src, e.name)
    const d = path.join(dest, e.name)
    if (e.isDirectory()) await copyDirRecursive(s, d)
    else if (e.isFile()) await fs.copyFile(s, d)
  }
}

async function renameCodeScopedFilesIn(dir: string, oldCode: string, newCode: string): Promise<void> {
  if (!existsSync(dir)) return
  const entries = await fs.readdir(dir, { withFileTypes: true })
  // Files at the top level: `{oldCode}_final.mp4`, `{oldCode}_Thumb01_v1.png`, etc.
  for (const e of entries) {
    if (!e.isFile()) continue
    if (!e.name.startsWith(oldCode)) continue
    const oldP = path.join(dir, e.name)
    const newName = e.name.replace(oldCode, newCode)
    const newP = path.join(dir, newName)
    try { await fs.rename(oldP, newP) } catch { /* non-fatal — the external dir is already at the new path */ }
  }
  // One level of subfolders (rare but possible: a `captions/` or
  // `proxy/` dir the user dropped). Subfolder NAMES with the code
  // get rewritten too, then their inner files get scanned.
  for (const e of entries) {
    if (!e.isDirectory()) continue
    let subDir = path.join(dir, e.name)
    if (e.name.includes(oldCode)) {
      const newSubName = e.name.replaceAll(oldCode, newCode)
      const newSub = path.join(dir, newSubName)
      try { await fs.rename(subDir, newSub); subDir = newSub } catch { /* leave as-is */ }
    }
    if (existsSync(subDir)) {
      const inner = await fs.readdir(subDir)
      for (const f of inner) {
        if (!f.startsWith(oldCode)) continue
        const oldP = path.join(subDir, f)
        const newName = f.replace(oldCode, newCode)
        const newP = path.join(subDir, newName)
        try { await fs.rename(oldP, newP) } catch { /* non-fatal */ }
      }
    }
  }
}
