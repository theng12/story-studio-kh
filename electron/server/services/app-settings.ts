/**
 * App-level settings store — single JSON file alongside the projects/ directory.
 *
 * Scope today: `ffmpeg_path` / `ffprobe_path`. Keep additions to genuinely
 * app-level knobs (per-install, not per-project). Per-project config lives
 * in `{PROJECTS_ROOT}/{slug}/config.json`. Provider API keys live at app
 * level (see `app-secrets-store.ts`); per-project `secrets.json` files
 * still hold YouTube OAuth tokens but no API keys.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { writeJsonAtomic, readJsonOr, withLock } from '../lib/atomic-store.js'

// `ffmpeg_path` lives in this file and is fed to `spawn()` by ffmpeg-manager.
// Any process running as the user that can write this file gets
// arbitrary-binary exec on next video render. Lock to owner-only.
const APP_SETTINGS_MODE = 0o600

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..', '..')

function resolveAppSettingsPath(): string {
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return path.join(process.env.STORY_STUDIO_DATA_DIR, 'app-settings.json')
  }
  const isPackaged = __dirname.includes('.asar') ||
    (!!process.resourcesPath && !process.env.ELECTRON_RUN_AS_NODE)
  if (isPackaged) {
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
    return path.join(userData, 'app-settings.json')
  }
  return path.join(ROOT, 'app-settings.json')
}

const APP_SETTINGS_PATH = resolveAppSettingsPath()

type AppSettings = Record<string, any>

// Legacy installs wrote this file with default 0644. On the first read after
// upgrade, tighten perms to 0600 so the ffmpeg_path value isn't world-
// readable. Best-effort: no-op on Windows, ignored on failure — the next
// atomic write will still land a 0600 replacement either way.
let modeTightened = false
async function tightenModeOnce(): Promise<void> {
  if (modeTightened) return
  modeTightened = true
  if (process.platform === 'win32') return
  if (!existsSync(APP_SETTINGS_PATH)) return
  await fs.chmod(APP_SETTINGS_PATH, APP_SETTINGS_MODE).catch(() => {})
}

async function readSettings(): Promise<AppSettings> {
  await tightenModeOnce()
  return readJsonOr<AppSettings>(APP_SETTINGS_PATH, {})
}

async function writeSettings(settings: AppSettings): Promise<void> {
  await writeJsonAtomic(APP_SETTINGS_PATH, settings, { mode: APP_SETTINGS_MODE })
}

export async function getAppSetting(key: string): Promise<any> {
  const settings = await readSettings()
  return settings[key]
}

export async function setAppSetting(key: string, value: any): Promise<void> {
  await withLock(APP_SETTINGS_PATH, async () => {
    const settings = await readSettings()
    settings[key] = value
    await writeSettings(settings)
  })
}

// ── Voice presets + favourites (global, not per-project) ──────────────────
//
// Voices the user curates (named presets, ★ favourites) are personal-taste
// signals — they don't change between channels. Storing them per-project
// duplicates work (re-favourite the same voice in 5 projects). The
// ElevenLabs voice CATALOG was already per-machine via voices-cache; this
// lifts the user's CURATION to the same scope.
//
// Schema:
//   app-settings.json
//     "voice_presets":    [{ "name": "Vincent", "voice_id": "..." }, ...]
//     "voice_favourites": ["voice_id_1", "voice_id_2", ...]
//
// Migration: boot/migrations.ts merges each project's legacy
// `voice_presets`/`voice_favourites` into these keys on first run after
// upgrade. Per-project fields stay readable for older app builds.

export const VOICE_PRESETS_KEY = 'voice_presets'
export const VOICE_FAVOURITES_KEY = 'voice_favourites'

export interface GlobalVoicePreset {
  name: string
  voice_id: string
}

export async function getVoicePresetsGlobal(): Promise<GlobalVoicePreset[]> {
  const v = await getAppSetting(VOICE_PRESETS_KEY)
  if (!Array.isArray(v)) return []
  return v.filter(
    (e): e is GlobalVoicePreset =>
      e && typeof e === 'object' &&
      typeof e.name === 'string' && typeof e.voice_id === 'string',
  )
}

export async function setVoicePresetsGlobal(value: GlobalVoicePreset[]): Promise<void> {
  await setAppSetting(VOICE_PRESETS_KEY, value)
}

export async function getVoiceFavouritesGlobal(): Promise<string[]> {
  const v = await getAppSetting(VOICE_FAVOURITES_KEY)
  if (!Array.isArray(v)) return []
  return v.filter((e): e is string => typeof e === 'string' && e.length > 0)
}

export async function setVoiceFavouritesGlobal(value: string[]): Promise<void> {
  await setAppSetting(VOICE_FAVOURITES_KEY, value)
}

/**
 * Returns true when neither key exists yet — the boot migration uses
 * this to decide whether to run the per-project merge. We require BOTH
 * to be unset so a partial migration (e.g. presets set, favourites not)
 * doesn't trigger a re-merge that would reintroduce already-removed
 * entries.
 */
export async function voiceCurationGlobalIsUnset(): Promise<boolean> {
  const settings = await readSettings()
  return settings[VOICE_PRESETS_KEY] === undefined
    && settings[VOICE_FAVOURITES_KEY] === undefined
}

// ── Server mode (headless web UI) ──────────────────────────────────────────
//
// Schema:
//   server_mode: {
//     enabled: boolean
//     port: number
//     bind: string
//     auth?: {
//       username: string
//       password_hash: string       // scrypt salt:hash hex
//       session_secret: string      // 32-byte hex; used to sign session cookies
//       session_ttl_hours: number
//     }
//   }
//
// Reads return a "safe" view (password_hash redacted, surfaced as
// has_credentials: boolean). Setters use withLock to avoid lost updates
// when two settings panels are saved nearly simultaneously.

import crypto from 'crypto'
import { hashPassword } from '../lib/auth-session.js'
import { isServerMode } from '../lib/server-mode.js'

export const SERVER_MODE_KEY = 'server_mode'

export interface ServerModeSafeView {
  /** Persisted JSON value — what the user toggled, controls next launch. */
  enabled: boolean
  /**
   * Resolved state — what `isServerMode()` returns RIGHT NOW. May differ
   * from `enabled` when launchd is forcing it via env var (resolved=true
   * even though JSON enabled=false would mean false). Use this for the
   * "currently in server mode" badge in the UI.
   */
  is_currently_active: boolean
  port: number
  bind: string
  has_credentials: boolean
  username: string | null
  session_ttl_hours: number
  /** v1.0.107+ — per-IP login rate-limit cap. Default 30/min. */
  login_max_attempts_per_minute: number
}

export interface ServerModeNetworkingPatch {
  enabled?: boolean
  port?: number
  bind?: string
}

const SERVER_MODE_DEFAULTS = {
  enabled: false,
  port: 8765,
  bind: '0.0.0.0',
  session_ttl_hours: 168,
  login_max_attempts_per_minute: 30,
}

/**
 * Read the server-mode settings as a safe view (no password hash).
 * Defaults are filled in for every field so the Settings UI never has to
 * deal with `undefined`. `has_credentials` lets the UI know whether the
 * "Set password" button or the "Change password" button should be shown.
 */
export async function getServerModeSettingsSafe(): Promise<ServerModeSafeView> {
  const settings = await readSettings()
  const sm = (settings[SERVER_MODE_KEY] || {}) as Record<string, any>
  const auth = (sm.auth || {}) as Record<string, any>
  return {
    enabled: sm.enabled === true,
    is_currently_active: isServerMode(),
    port: typeof sm.port === 'number' && sm.port > 0 ? sm.port : SERVER_MODE_DEFAULTS.port,
    bind: typeof sm.bind === 'string' && sm.bind ? sm.bind : SERVER_MODE_DEFAULTS.bind,
    has_credentials: !!auth.password_hash && !!auth.session_secret,
    username: typeof auth.username === 'string' && auth.username ? auth.username : null,
    session_ttl_hours: typeof auth.session_ttl_hours === 'number' && auth.session_ttl_hours > 0
      ? auth.session_ttl_hours
      : SERVER_MODE_DEFAULTS.session_ttl_hours,
    login_max_attempts_per_minute:
      typeof auth.login_max_attempts_per_minute === 'number' && auth.login_max_attempts_per_minute > 0
        ? auth.login_max_attempts_per_minute
        : SERVER_MODE_DEFAULTS.login_max_attempts_per_minute,
  }
}

/**
 * Patch the networking part of server-mode settings (enabled / port / bind).
 * Doesn't touch the auth block — credentials are managed separately so a
 * mistyped port can't accidentally clobber the password.
 */
export async function setServerModeNetworking(patch: ServerModeNetworkingPatch): Promise<ServerModeSafeView> {
  await withLock(APP_SETTINGS_PATH, async () => {
    const settings = await readSettings()
    const cur = (settings[SERVER_MODE_KEY] || {}) as Record<string, any>
    if (patch.enabled !== undefined) cur.enabled = !!patch.enabled
    if (patch.port !== undefined) {
      if (typeof patch.port !== 'number' || patch.port < 1 || patch.port > 65535) {
        throw new Error('port must be an integer between 1 and 65535')
      }
      cur.port = Math.floor(patch.port)
    }
    if (patch.bind !== undefined) {
      if (typeof patch.bind !== 'string' || !patch.bind.trim()) {
        throw new Error('bind must be a non-empty string')
      }
      cur.bind = patch.bind.trim()
    }
    settings[SERVER_MODE_KEY] = cur
    await writeSettings(settings)
  })
  return getServerModeSettingsSafe()
}

/**
 * Set or replace the server-mode credentials. Always generates a fresh
 * session_secret on every credential change — implicit "rotate sessions
 * on password change" so a stolen cookie can't outlive the password it
 * was minted under.
 */
export async function setServerModeCredentials(opts: {
  username: string
  password: string
  session_ttl_hours?: number
  login_max_attempts_per_minute?: number
}): Promise<ServerModeSafeView> {
  if (!opts.username || typeof opts.username !== 'string' || !opts.username.trim()) {
    throw new Error('username is required')
  }
  if (!opts.password || typeof opts.password !== 'string' || opts.password.length < 8) {
    throw new Error('password must be at least 8 characters')
  }
  const ttl = typeof opts.session_ttl_hours === 'number' && opts.session_ttl_hours > 0
    ? Math.floor(opts.session_ttl_hours)
    : SERVER_MODE_DEFAULTS.session_ttl_hours
  // Preserve the existing rate-limit knob when the caller doesn't pass
  // one — the credentials form doesn't surface it on every change, so
  // a "Change Password" save shouldn't reset the cap back to the default.
  await withLock(APP_SETTINGS_PATH, async () => {
    const settings = await readSettings()
    const cur = (settings[SERVER_MODE_KEY] || {}) as Record<string, any>
    const prevAuth = (cur.auth || {}) as Record<string, any>
    const maxAttempts = typeof opts.login_max_attempts_per_minute === 'number'
      && opts.login_max_attempts_per_minute > 0
      ? Math.floor(opts.login_max_attempts_per_minute)
      : (typeof prevAuth.login_max_attempts_per_minute === 'number'
        && prevAuth.login_max_attempts_per_minute > 0
        ? prevAuth.login_max_attempts_per_minute
        : SERVER_MODE_DEFAULTS.login_max_attempts_per_minute)
    const password_hash = hashPassword(opts.password)
    const session_secret = crypto.randomBytes(32).toString('hex')
    cur.auth = {
      username: opts.username.trim(),
      password_hash,
      session_secret,
      session_ttl_hours: ttl,
      login_max_attempts_per_minute: maxAttempts,
    }
    settings[SERVER_MODE_KEY] = cur
    await writeSettings(settings)
  })
  return getServerModeSettingsSafe()
}

/**
 * v1.0.107+ — update the rate-limit cap without touching the password.
 * Surfaced as a standalone field in the Server Mode panel so the user
 * can bump it after running into a 429 without re-entering credentials.
 */
export async function setServerModeRateLimit(maxAttemptsPerMinute: number): Promise<ServerModeSafeView> {
  if (typeof maxAttemptsPerMinute !== 'number' || maxAttemptsPerMinute < 1 || maxAttemptsPerMinute > 1000) {
    throw new Error('login_max_attempts_per_minute must be between 1 and 1000')
  }
  await withLock(APP_SETTINGS_PATH, async () => {
    const settings = await readSettings()
    const cur = (settings[SERVER_MODE_KEY] || {}) as Record<string, any>
    if (!cur.auth || !cur.auth.password_hash) {
      throw new Error('Credentials must be set before adjusting the rate-limit cap')
    }
    cur.auth.login_max_attempts_per_minute = Math.floor(maxAttemptsPerMinute)
    settings[SERVER_MODE_KEY] = cur
    await writeSettings(settings)
  })
  return getServerModeSettingsSafe()
}

/**
 * Rotate the session_secret without changing the password. Invalidates
 * every existing signed cookie immediately. Used by the "Sign out
 * everywhere" button in the Settings UI.
 */
export async function rotateServerModeSessionSecret(): Promise<ServerModeSafeView> {
  await withLock(APP_SETTINGS_PATH, async () => {
    const settings = await readSettings()
    const cur = (settings[SERVER_MODE_KEY] || {}) as Record<string, any>
    if (!cur.auth || !cur.auth.password_hash) {
      throw new Error('No credentials configured — nothing to rotate')
    }
    cur.auth.session_secret = crypto.randomBytes(32).toString('hex')
    settings[SERVER_MODE_KEY] = cur
    await writeSettings(settings)
  })
  return getServerModeSettingsSafe()
}

// ── YouTube upload defaults (app-level) ────────────────────────────────────
//
// Two app-level defaults that new uploads inherit when the per-project value
// is not explicitly set:
//   - default_mark_as_ai_generated: bool. Default true (Story Studio's primary
//     use is AI narration / images / video; YouTube requires the disclosure).
//   - default_yt_category_id: number. Default 24 (Entertainment) — best fit
//     for narrative AI / story content.
//
// Per-project values in `config.json` override these. The Settings UI exposes
// both and the backfill action under Settings → YouTube applies the resolved
// values to every previously uploaded video.

export const DEFAULT_MARK_AS_AI_GENERATED_KEY = 'default_mark_as_ai_generated'
export const DEFAULT_YT_CATEGORY_KEY = 'default_yt_category_id'

export interface YoutubeDefaultsView {
  default_mark_as_ai_generated: boolean
  default_yt_category_id: number
}

export async function getYoutubeDefaults(): Promise<YoutubeDefaultsView> {
  const settings = await readSettings()
  const ai = settings[DEFAULT_MARK_AS_AI_GENERATED_KEY]
  const cat = settings[DEFAULT_YT_CATEGORY_KEY]
  return {
    default_mark_as_ai_generated: typeof ai === 'boolean' ? ai : true,
    default_yt_category_id: typeof cat === 'number' && cat > 0 ? cat : 24,
  }
}

export async function setYoutubeDefaults(patch: Partial<YoutubeDefaultsView>): Promise<YoutubeDefaultsView> {
  await withLock(APP_SETTINGS_PATH, async () => {
    const settings = await readSettings()
    if (typeof patch.default_mark_as_ai_generated === 'boolean') {
      settings[DEFAULT_MARK_AS_AI_GENERATED_KEY] = patch.default_mark_as_ai_generated
    }
    if (typeof patch.default_yt_category_id === 'number'
      && Number.isFinite(patch.default_yt_category_id)
      && patch.default_yt_category_id > 0) {
      settings[DEFAULT_YT_CATEGORY_KEY] = Math.floor(patch.default_yt_category_id)
    }
    await writeSettings(settings)
  })
  return getYoutubeDefaults()
}

// ── "What's New" version tracking (per-machine) ────────────────────────────
//
// Stores the last app version the user dismissed the "What's New" modal for.
// Boot detection compares this to package.json's version; on mismatch, the
// modal pops automatically (showing the changelog since last_seen_version).
// Per-machine — different installs (iMac + Mac mini) each track their own
// dismiss state.

export const LAST_SEEN_VERSION_KEY = 'last_seen_version'

export async function getLastSeenVersion(): Promise<string | null> {
  const v = await getAppSetting(LAST_SEEN_VERSION_KEY)
  return typeof v === 'string' && v ? v : null
}

export async function setLastSeenVersion(version: string): Promise<void> {
  if (!version || typeof version !== 'string') return
  await setAppSetting(LAST_SEEN_VERSION_KEY, version)
}

/**
 * Bootstrap helper: if server mode is enabled but no credentials exist,
 * AND `STORY_STUDIO_INITIAL_USERNAME` + `STORY_STUDIO_INITIAL_PASSWORD`
 * env vars are present, persist them. Called once at app boot from
 * electron/main.ts so a fresh launchd-managed install can land
 * pre-configured. After the first successful boot, the env vars are
 * logged-and-ignored — they're a one-shot escape hatch, not a config
 * surface.
 */
export async function bootstrapServerModeFromEnv(): Promise<{ bootstrapped: boolean; reason?: string }> {
  const u = process.env.STORY_STUDIO_INITIAL_USERNAME
  const p = process.env.STORY_STUDIO_INITIAL_PASSWORD
  if (!u || !p) return { bootstrapped: false, reason: 'env vars not set' }
  const safe = await getServerModeSettingsSafe()
  if (safe.has_credentials) return { bootstrapped: false, reason: 'credentials already present' }
  try {
    await setServerModeCredentials({ username: u, password: p })
    return { bootstrapped: true }
  } catch (e: any) {
    return { bootstrapped: false, reason: e?.message || String(e) }
  }
}
