/**
 * Boot-time orphan reaper.
 *
 * After a force-quit / SIGKILL of the Electron parent, FFmpeg children that
 * were tracked via job-queue.trackChild() get reparented to launchd (PPID 1)
 * and continue writing to the project's output directory. Meanwhile the next
 * launch loads jobs.json, sees `running` jobs, and rewrites them to
 * `error: Interrupted by app restart` — but the orphan FFmpeg is still
 * actively writing the file the user now sees as failed.
 *
 * On boot, before the window opens, scan for any ffmpeg process whose parent
 * is launchd AND whose argv references a path under PROJECTS_ROOT. Kill them.
 * SIGTERM, then SIGKILL after killAfterMs.
 *
 * macOS-only — `ps -eo` is portable across BSD `ps`, but Windows has no
 * equivalent without spawning tasklist (different output format). Per
 * audit-reports/04-threat-model-personal.md §1 the personal-use model is
 * macOS-primary, so we log-and-skip on Windows for now.
 */

import { spawn } from 'child_process'

export interface OrphanInfo {
  pid: number
  command: string
}

/**
 * Parse `ps -eo pid,ppid,command` output and return rows that look like a
 * leaked ffmpeg child writing under projectsRoot. Pure function — fed real
 * `ps` output in production and a fixture string in tests.
 *
 * Match rules (all must hold):
 *   - PPID === 1 (reparented to launchd)
 *   - command contains 'ffmpeg' (case-insensitive substring)
 *   - command contains an absolute path under projectsRoot
 *
 * The third rule is what scopes us to *our* leaks. ffmpeg launched by the
 * user from /Applications/Whatever doesn't reference a project directory and
 * is left alone.
 */
export function parsePsOutput(psOutput: string, projectsRoot: string | string[]): OrphanInfo[] {
  // v1.0.515 — accept multiple roots. Preview-cache renders (userData) and
  // scene-prep chunks (os.tmpdir()/story-studio-kh) are ffmpeg children whose
  // argv never references PROJECTS_ROOT, so a crash used to leave them running
  // as true zombies (five preview ffmpegs survived 30+ min on 2026-07-05).
  const roots = Array.isArray(projectsRoot) ? projectsRoot.filter(Boolean) : [projectsRoot]
  const lines = psOutput.split('\n')
  const orphans: OrphanInfo[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    // Header line begins with "PID" — skip.
    if (/^PID\b/i.test(line)) continue
    // ps -eo pid,ppid,command → "  1234     1 /path/to/ffmpeg -i ..."
    const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) continue
    const pid = Number(match[1])
    const ppid = match[2]
    const command = match[3]
    if (ppid !== '1') continue
    if (!/ffmpeg/i.test(command)) continue
    if (!roots.some(r => command.includes(r))) continue
    orphans.push({ pid, command })
  }
  return orphans
}

function runPs(): Promise<string> {
  return new Promise((resolve, reject) => {
    // shell-free argv-array — no injection surface from PROJECTS_ROOT.
    const proc = spawn('ps', ['-eo', 'pid,ppid,command'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    proc.once('error', reject)
    proc.once('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`ps exited ${code}: ${stderr.trim()}`))
    })
  })
}

export interface ReapResult {
  scanned: boolean
  reaped: OrphanInfo[]
  reason?: string
}

/**
 * Scan for and kill ffmpeg orphans under projectsRoot. SIGTERM, escalate to
 * SIGKILL after killAfterMs for any survivor. No-ops (returns scanned:false)
 * on non-darwin platforms — see module header.
 */
export async function reapFfmpegOrphans(
  projectsRoot: string | string[],
  options: { killAfterMs?: number; platform?: NodeJS.Platform } = {},
): Promise<ReapResult> {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') {
    return { scanned: false, reaped: [], reason: `orphan reap skipped on ${platform}` }
  }
  const killAfterMs = options.killAfterMs ?? 2_000
  let psOutput: string
  try {
    psOutput = await runPs()
  } catch (e: any) {
    return { scanned: false, reaped: [], reason: `ps failed: ${e?.message || e}` }
  }
  const orphans = parsePsOutput(psOutput, projectsRoot)
  for (const o of orphans) {
    try { process.kill(o.pid, 'SIGTERM') } catch { /* already dead or not ours */ }
  }
  if (orphans.length > 0) {
    setTimeout(() => {
      for (const o of orphans) {
        try { process.kill(o.pid, 'SIGKILL') } catch { /* already dead */ }
      }
    }, killAfterMs).unref()
  }
  return { scanned: true, reaped: orphans }
}
