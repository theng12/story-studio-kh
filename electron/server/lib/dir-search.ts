import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'

/**
 * Level-order directory search: every directory at depth N is read before any
 * at depth N+1.
 *
 * The episode finders used to recurse depth-first. The episode folder sits
 * directly under its season folder, but a depth-first walk descended into EVERY
 * episode of Season 001 (and each episode's ~11 asset subfolders) before it ever
 * opened Season 002 — so finding EP0150 cost ~1,800 `readdir` calls instead of
 * ~9, and a project-wide audit that asks once per episode, per stage, was
 * quadratic (measured: 160 episodes → 20 s, ~2.6 M readdirs).
 *
 * `pick` sees one directory's entries at a time and returns the match, if any.
 * `rethrow` decides which read errors abort the search; the default skips an
 * unreadable directory, as the depth-first finders did.
 */
export async function findDirLevelOrder(
  root: string,
  maxDepth: number,
  pick: (entries: Dirent[], dir: string) => string | null,
  rethrow?: (error: unknown) => boolean,
  /** Checked after each level: stop descending once it says so (used to collect a whole level of hits). */
  done?: () => boolean,
): Promise<string | null> {
  let level = [root]
  for (let depth = 0; depth <= maxDepth && level.length > 0 && !done?.(); depth++) {
    const next: string[] = []
    for (const dir of level) {
      let entries: Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (rethrow?.(error)) throw error
        continue
      }
      const hit = pick(entries, dir)
      if (hit) return hit
      for (const entry of entries) if (entry.isDirectory()) next.push(path.join(dir, entry.name))
    }
    level = next
  }
  return null
}

/**
 * Every directory whose NAME matches, at the shallowest level that has any —
 * so two folders left over from a rename (`EP0001 - Old`, `EP0001 - New`) are
 * both returned, while nothing below a match is ever read.
 */
export async function findDirsLevelOrder(
  root: string,
  maxDepth: number,
  matches: (name: string) => boolean,
  rethrow?: (error: unknown) => boolean,
): Promise<string[]> {
  const hits: string[] = []
  await findDirLevelOrder(root, maxDepth, (entries, dir) => {
    for (const entry of entries) if (entry.isDirectory() && matches(entry.name)) hits.push(path.join(dir, entry.name))
    return null
  }, rethrow, () => hits.length > 0)
  return hits
}
