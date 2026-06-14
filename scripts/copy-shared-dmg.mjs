#!/usr/bin/env node
/**
 * Copy the freshly built macOS DMG into the user's iCloud-shared app folder.
 *
 * Default target:
 *   ~/Library/Mobile Documents/com~apple~CloudDocs/02 Business Ventures (Others)/Business - YouTube/Story Studio KH <version>-arm64.dmg
 *
 * Override target directory with:
 *   STORY_STUDIO_SHARED_DMG_DIR=/path/to/folder npm run dist
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST_DIR = path.join(ROOT, 'dist')
const PRODUCT_NAME = 'Story Studio KH'
function userDataPath(productName) {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', productName)
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), productName)
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), productName)
}

function expandHome(p) {
  if (!p.startsWith('~')) return p
  return path.join(os.homedir(), p.slice(1))
}

async function readPackageVersion() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf-8'))
  return String(pkg.version || '').trim()
}

async function resolveSharedDir() {
  const override = process.env.STORY_STUDIO_SHARED_DMG_DIR
  if (override && override.trim()) return path.resolve(expandHome(override.trim()))

  const defaultICloudDir = path.join(
    os.homedir(),
    'Library',
    'Mobile Documents',
    'com~apple~CloudDocs',
    '02 Business Ventures (Others)',
    'Business - YouTube',
  )
  if (existsSync(defaultICloudDir)) return defaultICloudDir

  const settingsPath = path.join(userDataPath(PRODUCT_NAME), 'app-settings.json')
  try {
    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'))
    const projectsRoot = typeof settings?.projects_root_override === 'string'
      ? settings.projects_root_override.trim()
      : ''
    if (projectsRoot) return path.join(expandHome(projectsRoot), '_app_')
  } catch {
    // Fall through to a warning below.
  }

  return ''
}

async function main() {
  const version = await readPackageVersion()
  if (!version) throw new Error('package.json has no version')

  const source = path.join(DIST_DIR, `${PRODUCT_NAME} ${version}-arm64.dmg`)
  if (!existsSync(source)) {
    throw new Error(`built DMG not found: ${source}`)
  }

  const sharedDir = await resolveSharedDir()
  if (!sharedDir) {
    console.warn('[copy-shared-dmg] no shared DMG directory configured; skipping.')
    console.warn('[copy-shared-dmg] set STORY_STUDIO_SHARED_DMG_DIR to enable this on another Mac.')
    return
  }

  await mkdir(sharedDir, { recursive: true })
  const target = path.join(sharedDir, path.basename(source))
  await copyFile(source, target)
  await writeFile(
    path.join(sharedDir, `${PRODUCT_NAME} ${version}-arm64.version.txt`),
    `version=${version}\nsource=${source}\ncopied_at=${new Date().toISOString()}\n`,
    'utf-8',
  )

  console.log(`[copy-shared-dmg] copied ${source}`)
  console.log(`[copy-shared-dmg] shared copy: ${target}`)
}

main().catch((err) => {
  console.error(`[copy-shared-dmg] ${err?.message || err}`)
  process.exit(1)
})
