/**
 * Crash-safe file writes, and a plain "is this asset really here?" check.
 *
 * ── What changed in v1.4.3 ──
 *
 * This module used to be about cloud-synced folders. iCloud Drive, Google Drive
 * and OneDrive replace a file on disk with a zero-byte placeholder when they
 * decide it can be evicted, so `existsSync` returned true for files that could
 * not be read; half of this file existed to detect that.
 *
 * iCloud support is withdrawn — *"we now no longer offer icloud sync or
 * anything of that kind. it is so unreliable."* — so the placeholder detection
 * is gone and `checkAssetAvailability` gives a two-state answer: the file is
 * usable, or it is not.
 *
 * `writeAtomic` STAYS, and cloud sync was never really its reason. Writing to a
 * sibling temp file and renaming is what stops a config or a manifest being
 * left half-written when the app is killed or the machine loses power — a
 * rename is atomic per POSIX, so a reader sees the old file or the new one and
 * never a torn one. Deleting it because iCloud left would have been a
 * regression dressed up as a simplification.
 */

import { promises as fs, statSync } from 'fs'
import path from 'path'

/**
 * Write `data` to `dest` via a sibling .tmp file and atomic rename.
 * Creates parent directories as needed. Use for any file that a cloud
 * sync daemon might mirror — the rename is the only operation the
 * watcher observes, so it never sees partial content.
 *
 * Accepts Buffer so callers can write JSON, text, or binary blobs.
 */
export async function writeAtomic(dest: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(dest)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`
  try {
    await fs.writeFile(tmp, data)
    // Flush tmp bytes to disk before the rename — otherwise a power-loss between
    // writeFile resolving and the kernel flushing can reorder the rename ahead
    // of the data write, leaving the target empty after reboot.
    const tmpFd = await fs.open(tmp, 'r+')
    try {
      await tmpFd.sync()
    } finally {
      await tmpFd.close()
    }
    await fs.rename(tmp, dest)
  } catch (error) {
    // Never strand a half-written temp file (a full disk is how this fails).
    await fs.unlink(tmp).catch(() => {})
    throw error
  }
  // POSIX: fsync the parent dir so the rename entry itself is durable.
  if (process.platform !== 'win32') {
    try {
      const dirFd = await fs.open(dir, 'r')
      try {
        await dirFd.sync()
      } finally {
        await dirFd.close()
      }
    } catch {
      // Best-effort: some filesystems refuse dir opens for read.
    }
  }
}

/**
 * Is this asset actually usable?
 *
 * Two states, not three. The middle one used to be "an iCloud placeholder is
 * sitting where your file should be, go and download it", which cannot happen
 * now that the app does not expect to live in a synced folder.
 *
 * A zero-byte file still counts as missing: a half-written file and an absent
 * one are the same problem for anything that has to read it, and reporting
 * "available" for something ffmpeg will choke on helps nobody.
 *
 * The `message` is user-facing — generators push it straight into job output.
 */
export interface AssetAvailability {
  status: 'available' | 'missing'
  message?: string
}

export function checkAssetAvailability(p: string, label = 'asset'): AssetAvailability {
  try {
    const st = statSync(p)
    if (st.isFile() && st.size > 0) return { status: 'available' }
  } catch { /* fall through to missing */ }
  return {
    status: 'missing',
    message: `⚠ ${label} not found on disk: ${p}`,
  }
}
