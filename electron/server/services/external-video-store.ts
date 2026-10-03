/**
 * Where finished videos go: `<Library>/Exports` (v1.4.3).
 *
 * ── What changed, and why the names did not ──
 *
 * This used to resolve a free-floating `external_final_video_root` — a
 * per-machine app setting pointing anywhere on disk, which existed because
 * projects often sat in iCloud Drive and nobody wanted 5-10 GB finals dragged
 * through a sync loop. iCloud support is withdrawn (*"we now no longer offer
 * icloud sync or anything of that kind. it's so unreliable."*), and there is one
 * Library now, so exports live inside it like everything else.
 *
 * The EXPORTED NAMES are unchanged on purpose. Fourteen modules import from
 * here — `storage-audit.ts` statically, the rest through dynamic imports that
 * TypeScript cannot check — and renaming a symbol to match new vocabulary would
 * have meant touching every one of them for no behavioural gain, with the
 * dynamic importers failing at runtime rather than at build. What the functions
 * RESOLVE TO changed; what they are called did not.
 *
 * Design:
 *   - The root is always `<Library>/Exports`. There is no setting, so there is
 *     no unset state, no per-machine drift, and no "reachable?" question beyond
 *     whether the Library itself is there.
 *   - Finals land at `{Exports}/{slug}/Season NNN/{code} - {title}/`, unchanged,
 *     so an existing export tree keeps its shape.
 *   - Detection in asset-status still reads BOTH the project tree and here.
 *   - Per-scene Veo/fal clips stay in the project tree — they are inputs to the
 *     assembly pass, not deliverables.
 */

import path from 'path'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import * as pm from './project-manager.js'
import { projectMetaOnce, type ProjectFactsCache } from './utils.js'
import { getAppSetting, setAppSetting } from './app-settings.js'

/**
 * The old app-settings key. Retired in v1.4.3 and kept here only so the
 * upgrade notice can read what it used to say and tell the owner where his
 * existing exports still are. Nothing writes it any more.
 */
export const RETIRED_EXTERNAL_ROOT_KEY = 'external_final_video_root'

/**
 * Where finished videos go. Always `<Library>/Exports`.
 *
 * Returns '' only when no Library has been chosen yet, which callers already
 * treat as "use the project tree" — the same shape the unset setting had, so
 * every existing caller keeps working without a change.
 */
export async function getExternalFinalVideoRoot(): Promise<string> {
  const { exportsDir } = await import('./library.js')
  return exportsDir()
}

/**
 * What the retired setting used to point at, for the one-time upgrade notice.
 * Read-only: 1.4.3 deliberately does NOT move an existing export pile, because
 * on the owner's machine that is 220 GB and 191 finished videos, and moving a
 * fifth of a terabyte without being asked is not a decision this app makes.
 */
export async function getRetiredExternalRoot(): Promise<string> {
  const raw = await getAppSetting(RETIRED_EXTERNAL_ROOT_KEY)
  if (typeof raw !== 'string' || !raw.trim()) return ''
  let resolved = raw.trim()
  if (resolved.startsWith('~')) {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    if (home) resolved = path.join(home, resolved.slice(1))
  }
  return resolved
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
 * external root has its own base directory (not the project's). Keeps
 * cross-machine semantics clean — different machines can point at
 * different roots without the project json changing.
 */
export async function resolveExternalFinalVideoDir(
  slug: string,
  code: string,
  title: string,
  cache?: ProjectFactsCache,
  options: { forWrite?: boolean } = {},
): Promise<string | null> {
  const root = cache
    ? await (cache.externalFinalVideoRoot ??= getExternalFinalVideoRoot().catch((error: unknown) => {
        // A failed read must not become the answer for the rest of the request.
        cache.externalFinalVideoRoot = undefined
        throw error
      }))
    : await getExternalFinalVideoRoot()
  if (!root) return null

  // A sweeping caller (the Upload Center listing) hands in its request-scoped
  // facts so project.json is parsed once, not once per episode.
  const meta = cache
    ? await projectMetaOnce(slug, cache).catch(() => null)
    : await pm.getProject(slug)
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

  const current = path.join(root, slug, episodeRel)
  // v1.4.249 — the finished-videos folder can be changed. A video rendered
  // before the change is still where it was, so when this episode has nothing
  // in the current folder, look in the folders it replaced. Writers pass
  // `forWrite` and always get the current folder.
  if (options.forWrite || existsSync(current)) return current
  const previous = cache
    ? await (cache.previousExportRoots ??= previousExportRootsOrEmpty())
    : await previousExportRootsOrEmpty()
  for (const earlier of previous) {
    const candidate = path.join(earlier, slug, episodeRel)
    if (existsSync(candidate)) return candidate
  }
  return current
}

async function previousExportRootsOrEmpty(): Promise<string[]> {
  const { previousExportsDirs } = await import('./library.js')
  return previousExportsDirs().catch(() => [])
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
  const dir = await resolveExternalFinalVideoDir(slug, code, title, undefined, { forWrite: true })
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
