/**
 * Per-run scratch directory for heavy generators (video assembly, audio
 * merge). Lives under the OS tempdir so iCloud / Google Drive / OneDrive
 * never index or upload the multi-GB intermediate files ffmpeg produces.
 *
 * Why this exists
 * ---------------
 * Video assembly (and to a lesser extent audio merge) produces hundreds
 * of MB to several GB of working files: per-scene clips, concat lists,
 * premixed audio, intermediate video. Pre-fix, these landed inside the
 * project's `XX 10 Video Assembly Output/.tmp_<ts>/` subfolder, which
 * sits inside the iCloud-synced project tree. iCloud's daemon would
 * pick up every byte change and start uploading the temp directory
 * mid-encode, saturating the user's network for ~30–60 minutes — only
 * for the entire pile to be deleted on completion.
 *
 * macOS `os.tmpdir()` returns `/var/folders/...`, which is on the boot
 * volume but never inside any cloud-sync provider's watched path. That
 * solves the upload churn at zero cost (kernel-level rename to the
 * final destination on a same-volume APFS move; existing EXDEV
 * fallback in video.ts handles cross-volume moves to external HDDs).
 *
 * Naming
 * ------
 * `<os.tmpdir()>/story-studio-kh/<slug>/<episode_code>/.tmp_<ts>/`
 *
 * Per-slug and per-episode subdirs let boot expire unowned runs while a
 * validated nonterminal Video Assembly checkpoint protects its exact path.
 */

import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const ROOT_NAME = 'story-studio-kh'

export function getWorkTempRoot(): string {
  return path.join(os.tmpdir(), ROOT_NAME)
}

/**
 * Create + return a fresh scratch directory for one generator run.
 * The caller owns cleanup — wrap usage in try/finally and `fs.rm(dir,
 * { recursive: true, force: true })` on exit.
 */
export async function getWorkTempDir(slug: string, episodeCode: string): Promise<string> {
  const dir = path.join(
    getWorkTempRoot(),
    sanitizeWorkTempSegment(slug),
    sanitizeWorkTempSegment(episodeCode),
    `.tmp_${Date.now()}`,
  )
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/**
 * Idempotent boot-time sweeper: wipe orphan tempdirs older than the
 * given age. Default 24 h is a comfortable margin past the longest
 * realistic encode (~hour) and shorter than any plausible "I left a
 * job running overnight" scenario.
 *
 * Best-effort. Permission errors, missing dir, race conditions all get
 * swallowed — this never blocks boot.
 * `protectedDirs` must already have passed durable job ownership validation.
 */
export async function cleanOrphanWorkTempDirs(
  maxAgeMs = 24 * 60 * 60 * 1000,
  protectedDirs: ReadonlySet<string> = new Set(),
  root = getWorkTempRoot(),
): Promise<{ scanned: number; removed: number }> {
  const summary = { scanned: 0, removed: 0 }
  let slugDirs: string[]
  try {
    slugDirs = await fs.readdir(root)
  } catch {
    return summary
  }
  const cutoff = Date.now() - maxAgeMs
  for (const slug of slugDirs) {
    const slugPath = path.join(root, slug)
    let codeDirs: string[]
    try {
      codeDirs = await fs.readdir(slugPath)
    } catch { continue }
    for (const code of codeDirs) {
      const codePath = path.join(slugPath, code)
      let runDirs: string[]
      try {
        runDirs = await fs.readdir(codePath)
      } catch { continue }
      for (const run of runDirs) {
        if (!run.startsWith('.tmp_')) continue
        summary.scanned++
        const runPath = path.join(codePath, run)
        if (protectedDirs.has(runPath)) continue
        try {
          const st = await fs.stat(runPath)
          if (st.mtimeMs < cutoff) {
            await fs.rm(runPath, { recursive: true, force: true })
            summary.removed++
          }
        } catch { /* race / permission — skip */ }
      }
      // Best-effort prune of now-empty per-episode + per-slug dirs.
      try { await fs.rmdir(codePath) } catch { /* not empty / not present */ }
    }
    try { await fs.rmdir(slugPath) } catch { /* not empty */ }
  }
  return summary
}

export function sanitizeWorkTempSegment(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  return !sanitized || sanitized === '.' || sanitized === '..' ? 'unknown' : sanitized
}
