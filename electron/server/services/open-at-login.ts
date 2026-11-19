/** Open at Login and restart after a crash; independent of app updates. */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { trashDir } from '../lib/app-paths.js'
import { APP_TRASH, libraryTrashDir, moveToTrashSync } from '../lib/trash-move.js'

export const AGENT_LABEL = 'local.storystudio.kh'

/**
 * Move something aside, never delete it: Story's one Trash (`<Library>/_trash/_story-studio/<bucket>`);
 * the app's own `_trash` only when the Library is on another drive (a rename never crosses drives).
 * Both record the move for Restore and never replace what is already there.
 */
async function toTrash(target: string, bucket: string): Promise<void> {
  if (!fs.existsSync(target)) return
  const { projectsRoot } = await import('./project-manager.js')
  try {
    moveToTrashSync(target, path.join(libraryTrashDir(projectsRoot()), APP_TRASH, bucket, path.basename(target)), bucket)
    return
  } catch (error: any) { if (error?.code !== 'EXDEV') throw error }
  moveToTrashSync(target, path.join(trashDir(), bucket, path.basename(target)), bucket)
}

// ── Open at Login (and come back after a crash) ────────────────────────────
//
// One per-user launchd agent does both, as Studio Hub's does: `RunAtLoad` starts Story Studio at
// login, and `KeepAlive { Crashed: true }` relaunches it only after a crash signal (SIGSEGV,
// SIGABRT, SIGTRAP — a V8 heap abort is one). A deliberate Quit exits 0 and a Force Quit or a
// macOS memory kill is SIGKILL; neither is a crash, so neither brings it back. Electron's
// `setLoginItemSettings` was the first idea, but a login item does nothing after a crash, which is
// why the Hub moved off `SMAppService` to this agent.
//
// A Mac that SERVES (server mode) gets `KeepAlive <true/>` instead: there, a clean exit is exactly
// the case that must not be fatal. angkor 2026-11-19: macOS restored the app at login while the
// agent started a second copy; the agent's copy lost the single-instance lock and exited 0, and
// `KeepAlive { Crashed }` never restarted it — the Mac served nothing for over an hour. A desktop
// keeps `Crashed` so a deliberate Quit sticks; stopping a server-role app on purpose is
// `launchctl bootout gui/$UID/local.storystudio.kh`.

export interface AgentOptions {
  /** Server role: come back from any exit, clean ones included. */
  keepAliveAlways?: boolean
}

export function agentPlistPath(home = os.homedir()): string {
  return path.join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`)
}

export function agentPlist(executable: string, options: AgentOptions = {}): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const keepAlive = options.keepAliveAlways ? '<true/>' : '<dict><key>Crashed</key><true/></dict>'
  // shortcut: if a second starter keeps winning the lock, launchd retries the exit-0 copy every
  // 30 s instead of every 10 s. A standby process would be the fix if that ever shows in a log.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(executable)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>${keepAlive}
  <key>ThrottleInterval</key><integer>30</integer>
  <key>AbandonProcessGroup</key><true/>
  <key>EnvironmentVariables</key><dict><key>STORY_STUDIO_LAUNCH_AGENT</key><string>1</string></dict>
</dict>
</plist>
`
}

export function openAtLogin(home = os.homedir()): boolean {
  return fs.existsSync(agentPlistPath(home))
}

/**
 * Turn it on: write the agent (never load it now — `RunAtLoad` would start a second copy; the next
 * login loads it). Turn it off: move the file to `_trash`.
 */
export async function setOpenAtLogin(enabled: boolean, executable: string, home = os.homedir(), options: AgentOptions = {}): Promise<void> {
  const plist = agentPlistPath(home)
  if (enabled) {
    if (!/\.app\/Contents\/MacOS\/[^/]+$/.test(executable)) {
      throw new Error('Open at Login needs the installed app (this looks like a development run).')
    }
    await fsp.mkdir(path.dirname(plist), { recursive: true })
    await fsp.writeFile(plist, agentPlist(executable, options), { mode: 0o644 })
    return
  }
  // Not booted out: if this very process runs under the agent, bootout would stop it. The loaded
  // job lapses at logout; without the file nothing starts Story Studio at the next login.
  await toTrash(plist, 'launch-agent')
}

/**
 * Keep an existing agent's role current without touching a Mac where Open at Login is off.
 * Called at boot so an installed agent heals to the deployment it now runs in (a Mac switched to
 * server mode stops being allowed to exit cleanly; one switched back may Quit and stay quit).
 */
export async function syncAgentPlist(executable: string, keepAliveAlways: boolean, home = os.homedir()): Promise<'absent' | 'unchanged' | 'rewritten'> {
  const plist = agentPlistPath(home)
  if (!fs.existsSync(plist)) return 'absent'
  const wanted = agentPlist(executable, { keepAliveAlways })
  if (fs.readFileSync(plist, 'utf8') === wanted) return 'unchanged'
  await fsp.writeFile(plist, wanted, { mode: 0o644 })
  return 'rewritten'
}
