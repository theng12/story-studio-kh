/**
 * Filesystem helpers that survive the quirks of cloud-synced folders
 * (iCloud Drive, Google Drive Desktop, OneDrive).
 *
 *   writeAtomic(path, data)    → write to sibling tmp then rename, so a
 *                                 mid-write sync can't pick up a half-file.
 *   isFileMaterialized(path)   → check the file is actually on disk, not an
 *                                 iCloud "optimize storage" placeholder.
 *
 * Kept deliberately small and dependency-free; the named-roots + path
 * resolver code lean on these for every manifest / config write.
 */

import { promises as fs, statSync, existsSync } from 'fs'
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
 * True when the file at `p` is actually downloaded to the local disk
 * (vs. an iCloud placeholder where existsSync returns true but reads
 * fail with ENOENT-style errors until the sync daemon fetches it).
 *
 * Heuristic — no one API reports this reliably across providers:
 *   1. must exist
 *   2. must report a non-zero size
 *   3. on macOS, reject files whose name starts with `.` and ends with
 *      `.icloud` (iCloud's placeholder-file naming convention)
 *
 * Returns false for symlinks that dangle and for directories.
 */
export function isFileMaterialized(p: string): boolean {
  if (!existsSync(p)) return false
  try {
    const st = statSync(p)
    if (!st.isFile()) return false
    if (st.size === 0) return false
  } catch {
    return false
  }
  const base = path.basename(p)
  if (base.startsWith('.') && base.endsWith('.icloud')) return false
  return true
}

/**
 * Given an asset path the user referenced, return the actual path to read
 * — if iCloud replaced `foo.png` with `.foo.png.icloud`, point at the
 * placeholder so callers can surface "trigger iCloud download" messaging.
 * Returns the original path unchanged when the asset is fully available.
 */
export function findICloudPlaceholder(p: string): string | null {
  const dir = path.dirname(p)
  const base = path.basename(p)
  const placeholder = path.join(dir, `.${base}.icloud`)
  return existsSync(placeholder) ? placeholder : null
}

/**
 * Availability check for asset paths at generator boundaries. Replaces a
 * plain `existsSync(path)` with a tri-state result so callers can show a
 * targeted error for each failure mode:
 *
 *   - `available`   → file is on disk and readable (bytes present).
 *   - `placeholder` → file is currently an iCloud "optimize storage"
 *                     placeholder. The user needs to trigger a download
 *                     (double-click in Finder) before retrying.
 *   - `missing`     → neither the file nor a placeholder exists.
 *
 * The `message` field is a user-facing string generators can push into the
 * job output lines — opinionated but safe to tweak per caller.
 */
export interface AssetAvailability {
  status: 'available' | 'placeholder' | 'missing'
  message?: string
}

export function checkAssetAvailability(p: string, label = 'asset'): AssetAvailability {
  if (isFileMaterialized(p)) return { status: 'available' }
  const placeholder = findICloudPlaceholder(p)
  if (placeholder) {
    return {
      status: 'placeholder',
      message: `⚠ ${label} not downloaded yet: ${p} — open Finder and double-click the file to trigger an iCloud download, then re-run.`,
    }
  }
  return {
    status: 'missing',
    message: `⚠ ${label} not found on disk: ${p}`,
  }
}
