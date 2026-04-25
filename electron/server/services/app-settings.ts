/**
 * App-level settings store — single JSON file alongside the projects/ directory.
 *
 * Scope today: `ffmpeg_path` / `ffprobe_path`. Keep additions to genuinely
 * app-level knobs (per-install, not per-project). Per-project config lives in
 * `{PROJECTS_ROOT}/{slug}/config.json`; per-project secrets live in
 * `secrets.json` (see `secrets-store.ts`).
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
