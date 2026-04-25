/**
 * Last-session restore — remembers the page the operator was on so a relaunch
 * (clean or after a crash) lands them back where they left off instead of on
 * the project list.
 *
 * Two pieces of state live here:
 *   - `projectSlug` + `route` + `ts` — written by the renderer on every
 *     successful navigation to a project route (throttled).
 *   - `unclean_shutdown` + `unclean_shutdown_dismissed` — written by the main
 *     process on boot when a previous run's `running.flag` was still on disk.
 *     Dismissal is persisted so a reload doesn't re-fire the banner.
 *
 * Lives in its own JSON next to `app-settings.json` so per-second renderer
 * writes never contend with the locked, secret-bearing settings file.
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { writeJsonAtomic, readJsonOr, withLock } from '../lib/atomic-store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..', '..')

function resolveDataDir(): string {
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return process.env.STORY_STUDIO_DATA_DIR
  }
  const isPackaged = __dirname.includes('.asar') ||
    (!!process.resourcesPath && !process.env.ELECTRON_RUN_AS_NODE)
  if (isPackaged) {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const productName = 'Story Studio KH'
    if (process.platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', productName)
    }
    if (process.platform === 'win32') {
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), productName)
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), productName)
  }
  return ROOT
}

const DATA_DIR = resolveDataDir()
const LAST_SESSION_PATH = path.join(DATA_DIR, 'last-session.json')
const RUNNING_FLAG_PATH = path.join(DATA_DIR, 'running.flag')

// Only routes whose page-mount is safe to re-trigger automatically. OAuth
// callback handlers, one-shot wizard steps, or any flow that "consumes" a URL
// param on mount must NOT appear here — replaying them on cold launch would
// re-fire the side effect with stale state. Listed explicitly (not
// pattern-excluded) so adding a new page is an opt-in decision.
export const RESTORABLE_ROUTES = [
  'index', 'ideas', 'pipeline', 'scripts', 'metadata',
  'image-prompts', 'images', 'video', 'audio', 'audio-merge',
  'video-assembly', 'upload', 'tiktok-upload', 'facebook-upload',
  'presets', 'assets', 'jobs', 'settings',
] as const

export type LastSession = {
  projectSlug?: string
  route?: string
  ts?: number
  unclean_shutdown?: boolean
  unclean_shutdown_dismissed?: boolean
}

export function getLastSessionPath(): string {
  return LAST_SESSION_PATH
}

export function getRunningFlagPath(): string {
  return RUNNING_FLAG_PATH
}

export async function readLastSession(): Promise<LastSession> {
  return readJsonOr<LastSession>(LAST_SESSION_PATH, {})
}

export async function patchLastSession(patch: Partial<LastSession>): Promise<LastSession> {
  return withLock(LAST_SESSION_PATH, async () => {
    const current = await readJsonOr<LastSession>(LAST_SESSION_PATH, {})
    const next = { ...current, ...patch }
    await writeJsonAtomic(LAST_SESSION_PATH, next)
    return next
  })
}

export async function clearRouteState(): Promise<LastSession> {
  // Used when the user intentionally returns to the project list — wipe the
  // routing fields, but leave any unread unclean_shutdown signal alone so the
  // next page mount can still surface its banner.
  return withLock(LAST_SESSION_PATH, async () => {
    const current = await readJsonOr<LastSession>(LAST_SESSION_PATH, {})
    const next: LastSession = {
      unclean_shutdown: current.unclean_shutdown,
      unclean_shutdown_dismissed: current.unclean_shutdown_dismissed,
    }
    await writeJsonAtomic(LAST_SESSION_PATH, next)
    return next
  })
}

export function isRestorableRoute(route: string): boolean {
  const m = /^\/projects\/([^/]+)(?:\/([^/?#]+))?\/?$/.exec(route)
  if (!m) return false
  const sub = m[2] ?? 'index'
  return (RESTORABLE_ROUTES as readonly string[]).includes(sub)
}
