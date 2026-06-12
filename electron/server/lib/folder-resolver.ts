/**
 * Folder resolver — THE canonical episode-folder + subfolder lookups.
 * Use this everywhere instead of hardcoding folder paths.
 *
 * v1.0.338 — consolidation. Before this, four independent copies of the
 * same logic lived in generators/video.ts (findEpisodeDir + a private
 * resolveSubfolder), routes/video.ts (findEpisodeDirForRoute),
 * generators/audio.ts (resolveAudioDir's inner matching loop), and
 * routes/ideas.ts (buildEpisodeDirIndex) — each with its own quirks.
 * Quirks that mattered:
 *   - "✅ " prefix tolerance: users can mark a step done by prefixing the
 *     subfolder name ("✅ EP0019 - 07 Audio Assets"). Only the video/audio
 *     copies handled it — this lib's resolveSubfolder did NOT, so writers
 *     (image prompts, metadata) could create a DUPLICATE unprefixed folder
 *     next to the marked one. Fixed: every matcher strips the prefix.
 *   - Title-hint disambiguation (video.ts): when two folders share a code
 *     prefix (rename leftovers), an exact "{code} - {title}" match wins.
 *   - Case-insensitive code prefix (routes/video.ts uppercased the code,
 *     generators/video.ts didn't): unified to uppercase both sides.
 */

import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'

/** Strip the user-applied "✅ " done-marker prefix from a folder name. */
function cleanName(name: string): string {
  return name.replace(/^✅\s*/, '')
}

/**
 * Find a subfolder inside parentDir that matches baseName.
 * Returns the actual path on disk, or creates it if missing.
 * Matches the exact name OR a "✅ "-prefixed variant (user marked done) —
 * never creates a duplicate next to a marked folder.
 */
export async function resolveSubfolder(parentDir: string, baseName: string, createIfMissing = true): Promise<string> {
  parentDir = parentDir.replace(/\/+$/, '')
  if (!existsSync(parentDir)) {
    if (createIfMissing) await fs.mkdir(parentDir, { recursive: true })
    const p = path.join(parentDir, baseName)
    if (createIfMissing) await fs.mkdir(p, { recursive: true })
    return p
  }

  try {
    const entries = await fs.readdir(parentDir)
    for (const entry of entries) {
      if (cleanName(entry) === baseName) {
        return path.join(parentDir, entry)
      }
    }
  } catch {}

  // Not found — create it
  const p = path.join(parentDir, baseName)
  if (createIfMissing) await fs.mkdir(p, { recursive: true })
  return p
}

/**
 * Non-creating subfolder lookup (the generators/video.ts semantics):
 * match exact or "✅ "-prefixed; if neither is listed but the exact path
 * exists (race / odd fs), return it; else null. Use when "missing" is a
 * meaningful state the caller handles (e.g. asset scans).
 */
export async function findSubfolder(parentDir: string, baseName: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(parentDir)
    for (const entry of entries) {
      if (cleanName(entry) === baseName) return path.join(parentDir, entry)
    }
  } catch { /* fall through */ }
  const exactPath = path.join(parentDir, baseName)
  if (existsSync(exactPath)) return exactPath
  return null
}

/**
 * Resolve the episode directory by matching the episode code prefix
 * within ONE directory level (typically the season dir). For a search
 * from the project root across season folders, use findEpisodeDir.
 */
export async function resolveEpisodeDir(parentDir: string, code: string): Promise<string | null> {
  if (!existsSync(parentDir)) return null

  try {
    const entries = await fs.readdir(parentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (cleanName(entry.name).startsWith(`${code} - `)) {
        return path.join(parentDir, entry.name)
      }
    }
  } catch {}

  return null
}

/**
 * Recursive episode-dir search from a project/output root (handles both
 * the Season-nested and episodes/-nested layouts, plus custom folder
 * templates up to `maxDepth` levels).
 *
 * Match order per directory level:
 *   1. exact "{code} - {titleHint}" (when a hint is given) — disambiguates
 *      multiple folders sharing the code prefix (rename leftovers)
 *   2. case-insensitive code prefix
 *   3. recurse into child dirs
 */
export async function findEpisodeDir(
  rootDir: string,
  code: string,
  opts: { titleHint?: string; maxDepth?: number } = {},
): Promise<string | null> {
  const maxDepth = opts.maxDepth ?? 4
  const exactName = opts.titleHint ? `${code} - ${opts.titleHint}` : null
  const codeUpper = code.toUpperCase()

  async function searchRecursive(dir: string, depth: number): Promise<string | null> {
    if (depth > maxDepth) return null
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      if (exactName) {
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          if (cleanName(entry.name) === exactName) return path.join(dir, entry.name)
        }
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (cleanName(entry.name).toUpperCase().startsWith(codeUpper)) {
          return path.join(dir, entry.name)
        }
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const found = await searchRecursive(path.join(dir, entry.name), depth + 1)
        if (found) return found
      }
    } catch { /* skip unreadable dirs */ }
    return null
  }
  return searchRecursive(rootDir, 0)
}

/**
 * v1.0.337/338 — bulk code→dir index in ONE tree walk (used by the
 * /episodes list route). Visits each directory at most once and stops
 * descending at any matched episode dir — an episode dir's subfolders
 * are "{code} - NN …" and can never be another episode. Dramatically
 * cheaper than calling findEpisodeDir per code on big projects.
 *
 * Matching is "{prefix} - {rest}" with prefix ∈ codes — exact (not
 * case-folded) because the codes come from the same ideas store that
 * named the folders.
 */
export async function buildEpisodeDirIndex(rootDir: string, codes: Set<string>): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  if (codes.size === 0) return found

  async function walk(dir: string): Promise<void> {
    if (found.size >= codes.size) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch { return }
    const descend: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const clean = cleanName(entry.name)
      const sep = clean.indexOf(' - ')
      const prefix = sep > 0 ? clean.slice(0, sep) : ''
      if (prefix && codes.has(prefix)) {
        if (!found.has(prefix)) found.set(prefix, path.join(dir, entry.name))
        continue
      }
      descend.push(path.join(dir, entry.name))
    }
    for (const sub of descend) {
      if (found.size >= codes.size) return
      await walk(sub)
    }
  }
  await walk(rootDir)
  return found
}
