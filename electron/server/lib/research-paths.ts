/**
 * Research sidecar location (v1.0.220+).
 *
 * Research used to write `research.json` + `research.md` loose at the episode
 * root — the only pipeline step without its own numbered folder. They now live
 * in `{code} - 11 Research/`, consistent with every other stage.
 *
 * This is a localized helper (folder name + migration) rather than a new entry
 * in the formal SubfolderNames schema on purpose: `SUBFOLDER_LINKAGE` has no
 * consumers, `resolveSubfolderNames` doesn't return every key anyway, and
 * research status is tracked separately from the asset audit — so adding it to
 * the core schema would risk spurious "missing research" audit rows + TS
 * construction errors for zero functional gain.
 *
 * `resolveResearchPaths` is the single source of truth: every reader/writer
 * goes through it, and it AUTO-MIGRATES any legacy loose sidecars into the
 * folder on first access (rename within the same episode dir — fast + safe,
 * including for iCloud-synced projects).
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'

export const RESEARCH_JSON_FILENAME = 'research.json'
export const RESEARCH_MD_FILENAME = 'research.md'

/** "{code} - 11 Research" — sits after Video Assembly Output (10) in the
 *  numbered scheme (per the operator's choice). */
export function researchFolderName(code: string): string {
  return `${code.toUpperCase()} - 11 Research`
}

export interface ResearchPaths {
  dir: string
  jsonPath: string
  mdPath: string
}

/**
 * Resolve the research folder + sidecar paths for an episode, migrating any
 * legacy loose `research.json` / `research.md` at the episode root into the
 * folder. Idempotent and best-effort: a failed migration just leaves the file
 * where it was and the caller handles "not found" as it always has.
 */
export async function resolveResearchPaths(episodeDir: string, code: string): Promise<ResearchPaths> {
  const dir = path.join(episodeDir, researchFolderName(code))
  const jsonPath = path.join(dir, RESEARCH_JSON_FILENAME)
  const mdPath = path.join(dir, RESEARCH_MD_FILENAME)

  await migrateLegacy(dir, path.join(episodeDir, RESEARCH_JSON_FILENAME), jsonPath)
  await migrateLegacy(dir, path.join(episodeDir, RESEARCH_MD_FILENAME), mdPath)

  return { dir, jsonPath, mdPath }
}

async function migrateLegacy(dir: string, legacy: string, target: string): Promise<void> {
  try {
    if (existsSync(legacy) && !existsSync(target)) {
      await fs.mkdir(dir, { recursive: true })
      await fs.rename(legacy, target)
    }
  } catch {
    /* best-effort — readers fall back to their existing not-found handling */
  }
}
