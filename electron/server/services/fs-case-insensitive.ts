/**
 * Case-insensitive single-basename lookup.
 *
 * Reconcilers build expected filenames from the uppercased episode code
 * (e.g. `TN0001_Scene01_v1.png`) and then ask the disk "does this file
 * exist?". That works on macOS because APFS is case-insensitive by
 * default — the query hits the on-disk file regardless of its actual
 * casing. It breaks the moment the project lands on a case-sensitive
 * backing store (case-sensitive APFS, Linux, SMB mount to a case-
 * sensitive server), or when legacy episodes produced mixed-case files
 * from an older naming convention (e.g. pre-uppercase `ep001_*.png`).
 *
 * The visible symptom is nasty: the "Repair" action silently reports "no
 * assets found for this episode" even on a project the user knows has
 * assets. No error, no log line — they panic and regenerate at cost.
 *
 * This helper fixes the READ path only. Writers still emit the
 * uppercase-prefixed convention; we merely tolerate legacy/foreign
 * casings on lookup.
 */

import { existsSync } from 'fs'
import { readdir } from 'fs/promises'
import path from 'path'

/**
 * Find a file in `dir` whose basename equals `expectedName` case-
 * insensitively. Returns the actual on-disk path (preserving the
 * entry's original casing) or null when no match exists.
 *
 * Tries an exact-case `existsSync` first so the common path pays only
 * one syscall; falls back to a directory scan only on miss. Errors
 * reading the directory (missing, permission) are treated as "not
 * found" since every caller already handles that as the miss branch.
 */
export async function findFileCaseInsensitive(
  dir: string,
  expectedName: string,
): Promise<string | null> {
  const exact = path.join(dir, expectedName)
  if (existsSync(exact)) return exact
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  const target = expectedName.toLowerCase()
  for (const name of entries) {
    if (name.toLowerCase() === target) return path.join(dir, name)
  }
  return null
}
