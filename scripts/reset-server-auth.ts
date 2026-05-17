#!/usr/bin/env tsx
/**
 * reset-server-auth — wipe Server Mode credentials from app-settings.json.
 *
 * Usage:
 *
 *   npm run reset-server-auth          # disables server mode + clears auth
 *   npm run reset-server-auth -- --keep-enabled   # clears auth, leaves enabled toggle on
 *
 * Why this exists: Server Mode credentials are stored as a one-way scrypt
 * hash (electron/server/lib/auth-session.ts:hashPassword). If you forget
 * the password, there's no way to derive it back — the only recovery is
 * to delete the `auth` block so the Server Mode panel shows "not set"
 * again, then re-set a fresh password from the desktop Electron app.
 *
 * Default behaviour is the SAFEST recovery: also set `enabled: false` so
 * that on next launch the app boots in DESKTOP mode (not server mode
 * with broken auth), letting you walk through the credential setup in
 * the normal UI. Pass `--keep-enabled` if you specifically want server
 * mode to stay on (e.g. you'll re-set credentials immediately and don't
 * want a desktop-mode launch in between).
 *
 * This script doesn't talk to the running app. It edits the JSON file
 * directly. So you should QUIT the app first — otherwise the running
 * process may overwrite your changes on its next save.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import os from 'os'

function resolveAppSettingsPath(): string {
  // Same precedence as electron/server/lib/server-mode.ts → resolveAppSettingsPath
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return path.join(process.env.STORY_STUDIO_DATA_DIR, 'app-settings.json')
  }
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir()
  const productName = 'Story Studio KH'
  let userData: string
  if (process.platform === 'darwin') {
    userData = path.join(home, 'Library', 'Application Support', productName)
  } else if (process.platform === 'win32') {
    userData = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), productName)
  } else {
    userData = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), productName)
  }
  // Fallback to repo-root if userData doesn't exist (dev-from-source).
  const ROOT = path.resolve(__dirname, '..')
  if (!existsSync(userData) && existsSync(path.join(ROOT, 'app-settings.json'))) {
    return path.join(ROOT, 'app-settings.json')
  }
  return path.join(userData, 'app-settings.json')
}

function readJson(file: string): any {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch (e: any) {
    console.error(`✗ ${file} is malformed JSON: ${e.message}`)
    console.error(`  Fix it by hand or restore from a backup before re-running this script.`)
    process.exit(2)
  }
}

function backup(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bak = `${file}.bak-${stamp}`
  writeFileSync(bak, readFileSync(file))
  return bak
}

function main() {
  const keepEnabled = process.argv.includes('--keep-enabled')
  const file = resolveAppSettingsPath()

  console.log(`Story Studio KH — reset Server Mode auth\n`)
  console.log(`Settings file: ${file}`)

  if (!existsSync(file)) {
    console.log(`\n✓ No app-settings.json found at that path.`)
    console.log(`  Server Mode credentials aren't stored anywhere yet.`)
    console.log(`  Launch the desktop app to create a fresh config.`)
    return
  }

  const data = readJson(file)
  const sm = data.server_mode

  if (!sm || typeof sm !== 'object') {
    console.log(`\n✓ No server_mode block in app-settings.json.`)
    console.log(`  Nothing to reset.`)
    return
  }

  const hadAuth = !!sm.auth
  const wasEnabled = sm.enabled === true

  if (!hadAuth && !wasEnabled) {
    console.log(`\n✓ Server mode is already disabled with no credentials.`)
    console.log(`  Nothing to reset.`)
    return
  }

  // Back up before we touch anything.
  const bak = backup(file)
  console.log(`\nBacked up current settings → ${path.basename(bak)}`)

  // Clear auth, optionally disable.
  if (sm.auth) delete sm.auth
  if (!keepEnabled) sm.enabled = false

  writeFileSync(file, JSON.stringify(data, null, 2) + '\n')

  console.log(`\n✓ Reset complete.`)
  if (hadAuth) console.log(`  • Cleared the auth block (username + password hash + session secret).`)
  if (!keepEnabled && wasEnabled) {
    console.log(`  • Set server_mode.enabled = false. Next launch boots in desktop mode.`)
  } else if (keepEnabled && wasEnabled) {
    console.log(`  • Left server_mode.enabled = true (--keep-enabled). Next launch boots headless`)
    console.log(`    but logins will 503 until you set fresh credentials.`)
  }
  console.log(`\nNext steps:`)
  console.log(`  1. Quit the app if it's still running.`)
  console.log(`  2. Launch the desktop Electron app on the host Mac.`)
  console.log(`  3. App Settings → Server Mode → Credentials → set new password.`)
  console.log(`  4. (Optional) Re-enable "Enable on next launch" + restart.`)
  console.log(`\nThe backup (${path.basename(bak)}) is safe to delete once you've confirmed`)
  console.log(`the new credentials work.`)
}

main()
