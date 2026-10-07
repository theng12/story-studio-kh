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

import { existsSync, statSync } from 'fs'
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
  /**
   * v1.0.107+ — per-IP login attempt cap inside a rolling 60-second window.
   * Bumped from the legacy hardcoded 5 (which made auto-fill / typo loops
   * lock the user out of their own server) to a configurable knob with a
   * personal-use default of 30. Restricting to single-digit attempts only
   * makes sense for public-internet exposure; this app runs over Tailscale.
   */
  login_max_attempts_per_minute: number  // default 30
}

/**
 * An automation key (`ssk_…`) lets an agent on another Mac call the API
 * without the owner's password. Only the SHA-256 of the key is stored; the
 * key itself is shown once at creation. Lives in `server_mode.automation_keys`,
 * outside `auth`, so rotating the session secret or changing the password does
 * not revoke keys — removing the entry does.
 */
export interface AutomationKeyRecord {
  id: string
  label: string
  hash: string                // sha256 hex of the full key
  last4: string
  created_at: string
  last_used_at: string | null
}

export interface ServerModeConfig {
  enabled: boolean
  port: number                // default 8765
  bind: string                // default '0.0.0.0'
  auth?: ServerModeAuth       // absent until credentials are first set
  automation_keys: AutomationKeyRecord[]
}

/** Well-formed key records from a raw settings value; anything else is dropped. */
export function normalizeAutomationKeys(value: unknown): AutomationKeyRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((k): k is AutomationKeyRecord =>
    !!k && typeof k === 'object'
    && typeof k.id === 'string' && !!k.id
    && typeof k.hash === 'string' && /^[0-9a-f]{64}$/.test(k.hash))
    .map((k) => ({
      id: k.id,
      label: typeof k.label === 'string' ? k.label : '',
      hash: k.hash,
      last4: typeof k.last4 === 'string' ? k.last4 : '',
      created_at: typeof k.created_at === 'string' ? k.created_at : '',
      last_used_at: typeof k.last_used_at === 'string' ? k.last_used_at : null,
    }))
}

const DEFAULT_PORT = 8765
const DEFAULT_BIND = '0.0.0.0'
const DEFAULT_SESSION_TTL_HOURS = 168
const DEFAULT_LOGIN_MAX_ATTEMPTS_PER_MINUTE = 30

/**
 * Resolve the app-settings.json path WITHOUT importing app-settings.ts.
 *
 * app-settings.ts uses async fs/promises and we can't await here. The path
 * resolution logic is identical (mirrored from app-settings.ts +
 * project-manager.ts) so the same file is read either way.
 *
 * Exported since v1.0.780 so the Nuxt dev proxy (lib/dev-backend.ts, imported
 * by frontend/nuxt.config.ts) can name the file it failed to read WITHOUT
 * growing a fourth copy of this resolution. Nothing outside diagnostics should
 * read the file directly — go through the accessors below.
 */
export function resolveAppSettingsPath(): string {
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
 * The port server mode will bind, from a raw settings value.
 *
 * Shared by `getServerModeConfig()` (which binds it) and
 * `probeServerModePort()` (which tells the dev proxy where to send `/api`), so
 * the two can never disagree about where the backend is. Anything that is not
 * a usable TCP port — absent, non-numeric, fractional, out of range — becomes
 * the default rather than being handed to `listen()` to crash on.
 */
function normalizeServerModePort(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536
    ? value
    : DEFAULT_PORT
}

/**
 * Read the raw `server_mode` block, distinguishing "legitimately absent" from
 * "the file is there but we could not read it".
 *
 * `readServerModeBlock()` below collapses both into null — which is the right
 * call for the boot path (an unreadable settings file must never stop the app
 * from starting as a plain desktop app). Callers that want to *report* the
 * difference use this instead: the dev proxy has to say out loud when it fell
 * back to a default because the settings were unreadable, since a silent wrong
 * default is what made the port mismatch invisible in the first place.
 */
interface ServerModeBlockRead {
  /** The block, or null when absent / unusable / unreadable. */
  block: Partial<ServerModeConfig> | null
  /** The file we looked at, whether or not it existed. */
  path: string
  /** Non-null only when the file was there but could not be read or parsed. */
  error: string | null
}

/**
 * S14: every request read and parsed the whole app-settings.json synchronously, up to four times
 * (auth + automation keys + mode checks). The parsed block is kept per file identity (inode, size,
 * mtime). Keyed on the file, not on `onAppSettingWritten`: the server-mode writers (credentials,
 * session-secret rotation, networking, automation keys) save through `writeSettings` without
 * announcing, and a listener-only cache would keep a rotated session secret valid.
 */
let blockMemo: { signature: string; result: ServerModeBlockRead } | null = null

function readServerModeBlockResult(): ServerModeBlockRead {
  const settingsPath = resolveAppSettingsPath()
  let signature: string | null = null
  try {
    const info = statSync(settingsPath)
    signature = `${settingsPath}\u0000${info.ino}\u0000${info.size}\u0000${info.mtimeMs}`
  } catch (error: any) {
    // No settings file at all is the fresh-checkout case, not a failure.
    if (error?.code === 'ENOENT') return { block: null, path: settingsPath, error: null }
  }
  if (signature && blockMemo?.signature === signature) return blockMemo.result
  const result = parseServerModeBlock(settingsPath)
  blockMemo = signature && !result.error ? { signature, result } : null
  return result
}

function parseServerModeBlock(settingsPath: string): ServerModeBlockRead {
  try {
    const raw = readFileSync(settingsPath, 'utf-8')
    const data = JSON.parse(raw)
    const sm = data?.server_mode
    // Absent / non-object (including an array or null) `server_mode` is a
    // well-formed file that simply does not configure server mode.
    if (!sm || typeof sm !== 'object' || Array.isArray(sm)) {
      return { block: null, path: settingsPath, error: null }
    }
    return { block: sm as Partial<ServerModeConfig>, path: settingsPath, error: null }
  } catch (e) {
    return { block: null, path: settingsPath, error: (e as Error)?.message || String(e) }
  }
}

/**
 * Read the raw `server_mode` block from app-settings.json.
 * Returns null on any error; the toggle reader composes that with the env var.
 */
function readServerModeBlock(): Partial<ServerModeConfig> | null {
  return readServerModeBlockResult().block
}

/**
 * Where server mode says the backend will be listening, for callers that need
 * to *reach* it rather than run it — today, the Nuxt dev proxy.
 *
 * Deliberately reports `unreadable` separately from `disabled`: both fall back
 * to the dev default, but only one of them deserves a warning.
 */
export type ServerModePortProbe =
  | { status: 'enabled'; port: number; path: string }
  | { status: 'disabled'; path: string }
  | { status: 'unreadable'; error: string; path: string }

export function probeServerModePort(): ServerModePortProbe {
  const read = readServerModeBlockResult()
  if (read.error) return { status: 'unreadable', error: read.error, path: read.path }
  const block = read.block
  // Same precedence as isServerMode(): an explicit `enabled: false` beats the
  // env var, which beats `enabled: true`.
  const enabled = block?.enabled === false
    ? false
    : process.env.STORY_STUDIO_SERVER_MODE === '1' || block?.enabled === true
  if (!enabled) return { status: 'disabled', path: read.path }
  return { status: 'enabled', port: normalizeServerModePort(block?.port), path: read.path }
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
    port: normalizeServerModePort(block.port),
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
        login_max_attempts_per_minute:
          typeof (block.auth as any).login_max_attempts_per_minute === 'number'
            && (block.auth as any).login_max_attempts_per_minute > 0
            ? (block.auth as any).login_max_attempts_per_minute
            : DEFAULT_LOGIN_MAX_ATTEMPTS_PER_MINUTE,
      }
      : undefined,
    automation_keys: normalizeAutomationKeys(block.automation_keys),
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
    login_max_attempts_per_minute: DEFAULT_LOGIN_MAX_ATTEMPTS_PER_MINUTE,
  }
}
