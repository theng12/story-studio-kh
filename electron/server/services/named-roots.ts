/**
 * Named roots — per-machine label → absolute path map.
 *
 * Used by the path resolver to expand `${NAME}/rel/...` references in
 * presets into absolute paths for the current machine. The map lives
 * in userData (never synced) so each computer defines its own mapping.
 *
 *   Example: on machine A the user maps
 *     CHANNEL_ASSETS → /Users/alice/iCloud/.../Channel Video Assets
 *   On machine B the same name maps to
 *     CHANNEL_ASSETS → /Users/bob/iCloud/.../Channel Video Assets
 *   Presets stored in the synced project folder can reference
 *     ${CHANNEL_ASSETS}/00 Channel Logo.png
 *   and resolve correctly on both machines.
 *
 * Reserved names:
 *   ${PROJECT} — the output_root of the current project. Resolved
 *                per-call by the path resolver, not stored here.
 */

import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { writeAtomic } from '../lib/sync-safe.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'

function resolveNamedRootsPath(): string {
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return path.join(process.env.STORY_STUDIO_DATA_DIR, 'named-roots.json')
  }
  try {
    const { app } = require('electron')
    if (app?.getPath) return path.join(app.getPath('userData'), 'named-roots.json')
  } catch { /* not in Electron (tests) */ }
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Story Studio KH', 'named-roots.json')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Story Studio KH', 'named-roots.json')
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Story Studio KH', 'named-roots.json')
}

/**
 * The store path, resolved on EVERY access.
 *
 * Deliberately not captured in a module-scope `const`. `STORY_STUDIO_DATA_DIR`
 * is what redirects this store to an isolated directory, and it is set by the
 * caller — the Electron main process at boot, `useTempDataDir()` in tests. A
 * module-load-time capture froze the path to whatever it happened to be when
 * the FIRST importer anywhere in the graph pulled this module in, which is
 * before a test's `before()` hook can claim its temp dir. Measured on the full
 * backend suite, 18 test files bound the developer's real
 * `<userData>/named-roots.json` this way and one of them read it. Resolving per
 * call costs two string joins and removes the entire class of import-order bug.
 * Same shape as `services/app-settings.ts` and `services/app-secrets-store.ts`.
 */
export function namedRootsPath(): string {
  return resolveNamedRootsPath()
}

const RESERVED = new Set(['PROJECT'])
const NAME_RE = /^[A-Z][A-Z0-9_]*$/

/** Validate name: uppercase letter first, then uppercase/digit/underscore. */
export function isValidRootName(name: string): boolean {
  if (!NAME_RE.test(name)) return false
  if (RESERVED.has(name)) return false
  return true
}

function read(): Record<string, string> {
  const target = namedRootsPath()
  if (!existsSync(target)) return {}
  try {
    const raw = readFileSync(target, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && isValidRootName(k)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

async function write(map: Record<string, string>): Promise<void> {
  const target = namedRootsPath()
  // Under the node test runner, writing outside the claimed data dir is a hard
  // error rather than a silent write to the developer's real named-roots.json.
  assertWriteIsolatedInTests(target, 'named-roots')
  await writeAtomic(target, JSON.stringify(map, null, 2))
}

export function listNamedRoots(): Record<string, string> {
  return read()
}

export async function setNamedRoot(name: string, absPath: string): Promise<void> {
  if (!isValidRootName(name)) {
    throw new Error(`Invalid root name "${name}". Use UPPERCASE letters, digits, and underscores; must start with a letter; "PROJECT" is reserved.`)
  }
  if (!path.isAbsolute(absPath)) {
    throw new Error(`Root path must be absolute: ${absPath}`)
  }
  const map = read()
  map[name] = absPath
  await write(map)
}

export async function removeNamedRoot(name: string): Promise<void> {
  const map = read()
  if (!(name in map)) return
  delete map[name]
  await write(map)
}

export function getNamedRoot(name: string): string | undefined {
  return read()[name]
}
