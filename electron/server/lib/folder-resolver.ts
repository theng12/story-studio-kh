/**
 * Folder resolver — finds subfolders by base name.
 * Use this everywhere instead of hardcoding folder paths.
 */

import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'

/**
 * Find a subfolder inside parentDir that matches baseName.
 * Returns the actual path on disk, or creates it if missing.
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
      if (entry === baseName) {
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
 * Resolve the episode directory by matching the episode code prefix.
 */
export async function resolveEpisodeDir(parentDir: string, code: string): Promise<string | null> {
  if (!existsSync(parentDir)) return null

  try {
    const entries = await fs.readdir(parentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith(`${code} - `)) {
        return path.join(parentDir, entry.name)
      }
    }
  } catch {}

  return null
}
