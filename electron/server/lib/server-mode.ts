/**
 * Server-mode toggle + config reader.
 *
 * Server mode flips the app from "personal desktop Electron app" to "headless
 * web service" — bind on a network-accessible interface, gate every request
 * with session auth, and serve the same Nuxt SPA + Express API to a remote
 * browser. Architecturally the only thing that changes is *who can reach the
 * server and how they authenticate*; the generators, providers, and project
 * model are unchanged.
 *
 * Why synchronous: this is read at boot from `electron/main.ts:startServer()`
 * and from middleware mounted in `electron/server/app.ts`. Both paths run
 * before any await, so an async reader would force a top-level await chain
 * through the whole boot. Mirrors `readProjectsRootOverrideSync` in
 * `services/project-manager.ts`.
 *
 * Two ways to enable:
 *   1. `STORY_STUDIO_SERVER_MODE=1` env var — for launchd / wrapper scripts.
 *   2. `app-settings.json → server_mode.enabled === true` — set via the
 *      Settings UI on the local Electron app, then quit and re-launch under
 *      launchd. Persistent across reboots without env vars.
 *
 * Either signal flips the bit. The settings file always provides the
 * port / bind / credential values regardless of which signal turned the mode
 * on, because the env var is a boolean and can't carry credentials.
 */

import { existsSync } from 'fs'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..', '..')

export interface ServerModeAuth {
  username: string
  password_hash: string       // scrypt: `salt:hash` hex
  session_secret: string      // 32-byte hex, generated on first credential set
  session_ttl_hours: number   // default 168 (1 week)
}

export interface ServerModeConfig {
  enabled: boolean
  port: number                // default 8765
  bind: string                // default '0.0.0.0'
  auth?: ServerModeAuth       // absent until credentials are first set
}

const DEFAULT_PORT = 8765
const DEFAULT_BIND = '0.0.0.0'
const DEFAULT_SESSION_TTL_HOURS = 168

/**
 * Resolve the app-settings.json path WITHOUT importing app-settings.ts.
 *
 * app-settings.ts uses async fs/promises and we can't await here. The path
 * resolution logic is identical (mirrored from app-settings.ts +
 * project-manager.ts) so the same file is read either way.
 */
function resolveAppSettingsPath(): string {
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return path.join(process.env.STORY_STUDIO_DATA_DIR, 'app-settings.json')
  }
  // Try Electron's app.getPath('userData') first.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron')
    if (app?.getPath) return path.join(app.getPath('userData'), 'app-settings.json')
  } catch { /* not in Electron — tests / standalone tsx */ }
  // Fallback to platform-default user data dir.
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const productName = 'Story Studio KH'
  let userData: string
  if (process.platform === 'darwin') {
    userData = path.join(home, 'Library', 'Application Support', productName)
  } else if (process.platform === 'win32') {
    userData = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), productName)
  } else {
    userData = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), productName)
  }
  // If userData doesn't exist yet (first launch from source), fall through
  // to the repo root so dev runs find their settings.json there.
  if (!existsSync(userData) && existsSync(path.join(ROOT, 'app-settings.json'))) {
    return path.join(ROOT, 'app-settings.json')
  }
  return path.join(userData, 'app-settings.json')
}

/**
 * Read the raw `server_mode` block from app-settings.json.
 * Returns null on any error; the toggle reader composes that with the env var.
 */
function readServerModeBlock(): Partial<ServerModeConfig> | null {
  const settingsPath = resolveAppSettingsPath()
  if (!existsSync(settingsPath)) return null
  try {
    const raw = readFileSync(settingsPath, 'utf-8')
    const data = JSON.parse(raw)
    const sm = data?.server_mode
    if (!sm || typeof sm !== 'object') return null
    return sm as Partial<ServerModeConfig>
  } catch {
    return null
  }
}

/**
 * Whether the process should run in server mode.
 *
 * Precedence (most-specific wins):
 *   1. JSON `enabled: false`        → desktop mode, ALWAYS (even if env says ON).
 *      This is what lets the user disable server mode from the web UI without
 *      first having to SSH in and unload launchd. The launchd-respawned
 *      process sees JSON disabled and runs as desktop on the next cycle.
 *   2. `STORY_STUDIO_SERVER_MODE=1` → server mode (the launchd path).
 *   3. JSON `enabled: true`         → server mode (the GUI-toggle path).
 *   4. Otherwise                    → desktop mode.
 */
export function isServerMode(): boolean {
  const block = readServerModeBlock()
  if (block?.enabled === false) return false        // explicit disable wins
  if (process.env.STORY_STUDIO_SERVER_MODE === '1') return true
  return block?.enabled === true
}

/**
 * Fully-resolved server-mode config — port + bind defaults filled in,
 * auth block returned as-is (caller checks for presence before relying on it).
 *
 * Returns null when not in server mode. Callers that need defaults regardless
 * of mode (e.g. the Settings UI showing what the port WOULD be) can call
 * `getServerModeDefaults()` instead.
 */
export function getServerModeConfig(): ServerModeConfig | null {
  if (!isServerMode()) return null
  const block = readServerModeBlock() || {}
  return {
    enabled: true,
    port: typeof block.port === 'number' && block.port > 0 ? block.port : DEFAULT_PORT,
    bind: typeof block.bind === 'string' && block.bind ? block.bind : DEFAULT_BIND,
    auth: block.auth && typeof block.auth === 'object'
      ? {
        username: String(block.auth.username || ''),
        password_hash: String(block.auth.password_hash || ''),
        session_secret: String(block.auth.session_secret || ''),
        session_ttl_hours: typeof block.auth.session_ttl_hours === 'number'
          && block.auth.session_ttl_hours > 0
          ? block.auth.session_ttl_hours
          : DEFAULT_SESSION_TTL_HOURS,
      }
      : undefined,
  }
}

/**
 * Defaults for the Settings UI to seed empty fields with.
 * Always returns the same shape regardless of current mode.
 */
export function getServerModeDefaults() {
  return {
    port: DEFAULT_PORT,
    bind: DEFAULT_BIND,
    session_ttl_hours: DEFAULT_SESSION_TTL_HOURS,
  }
}
