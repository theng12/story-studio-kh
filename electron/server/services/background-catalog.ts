/**
 * Built-in Backgrounds catalog.
 *
 * Twelve owner-review exports ship with the app as bytes; the manifest marks
 * each `approved` or `pending`, and the catalog **enforces that boundary**:
 *
 *   listBackgrounds()             → APPROVED entries only — `{ id, name, reference }`
 *   resolveBackground(id)         → absolute path, integrity-checked, sync;
 *                                   a pending id is rejected even though its
 *                                   bytes are bundled
 *   backgroundReferenceForPath(p) → '${BACKGROUND}/<id>' for an approved
 *                                   bundled file, else null
 *
 * The catalog is **catalog-only**: it offers choices, never an app-wide active
 * default and never an inheritance — selection stays where it already was, per
 * episode, with "None" meaning the empty string at the UI, never a fake asset.
 * A saved absolute or `${CHANNEL}/...` background path resolves exactly as it
 * always did. Flipping an entry to `approved` in the manifest is the whole
 * switch when the owner says yes; there is no runtime toggle.
 *
 * `reference` is the portable `${BACKGROUND}/<id>` form; `resolveAssetPath`
 * in path-resolver expands it, and `toPortablePath` collapses an approved
 * bundled file back to it, so picking one never duplicates the bytes into the
 * channel folder.
 *
 * Integrity: the file on disk must be the manifest's exact byte length and
 * sha256 before it reaches a render. A missing or tampered asset fails loudly
 * with the id named — a half-rendered video is worse than a stopped one
 * (AGENTS §8).
 */

import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/** Allowlist only: what an id may contain, and nothing else. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export type BackgroundReference = string // `${BACKGROUND}/<id>`

export interface BackgroundEntry {
  id: string
  name: string
  reference: BackgroundReference
}

/** Test seam — the installed directory changes only here. */
let dirOverride: string | null = null
/** Test seam — carry a manifest without writing into the app directory. */
let manifestOverride: ManifestDoc | null = null

function isPackagedApp(): boolean {
  if (__dirname.includes('.asar')) return true
  if (process.resourcesPath && !process.env.ELECTRON_RUN_AS_NODE) {
    try {
      const { app } = require('electron')
      return app?.isPackaged === true
    } catch {
      return false
    }
  }
  return false
}

/**
 * Packaged: `resources/backgrounds` (electron-builder extraResources).
 * Dev: `electron/server/backgrounds` found by walking up, same shape as
 * thumbnail-template-loader's built-in lookup.
 */
function findRepoBackgroundsDir(start: string, maxDepth = 8): string | null {
  let cur = start
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(cur, 'electron', 'server', 'backgrounds')
    if (existsSync(path.join(candidate, 'manifest.json'))) return candidate
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

function defaultDir(): string {
  if (isPackagedApp() && process.resourcesPath) {
    return path.join(process.resourcesPath, 'backgrounds')
  }
  const found = findRepoBackgroundsDir(__dirname)
  if (found) return found
  return path.resolve(__dirname, '..', 'backgrounds')
}

/** Absolute directory the catalog reads. */
export function backgroundsDir(): string {
  return dirOverride ?? defaultDir()
}

/** @internal test seam — pass null to restore the normal lookup. */
export function _setBackgroundsDirForTesting(dir: string | null): void {
  dirOverride = dir
}

/** @internal test seam — pass null to read manifest.json from disk again. */
export function _setBackgroundManifestForTesting(manifest: ManifestDoc | null): void {
  manifestOverride = manifest
}

/** Drop the cached manifest so a changed one takes effect. */
export function _clearBackgroundCatalogCache(): void {
  manifestCache = null
}

interface ManifestAsset {
  id: string
  name: string
  file: string
  sha256: string
  bytes: number
  approval: 'approved' | 'pending'
}
interface ManifestDoc {
  schemaVersion: number
  assets: ManifestAsset[]
}

let manifestCache: ManifestDoc | null = null

function loud(context: string, detail: string): never {
  // Not a warning and not a fallback: the id and the file are named so the
  // operator can see what is wrong before a render starts.
  throw new Error(`[background-catalog] ${context}: ${detail}`)
}

function loadManifest(): ManifestDoc {
  if (manifestOverride) {
    validateManifest(manifestOverride, 'override')
    return manifestOverride
  }
  if (manifestCache) return manifestCache
  const file = path.join(backgroundsDir(), 'manifest.json')
  if (!existsSync(file)) {
    loud('manifest missing', `expected ${file} — the built-in Backgrounds catalog did not ship.`)
  }
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e: any) {
    loud('manifest unreadable', `${file}: ${e.message}`)
  }
  let doc: any
  try {
    doc = JSON.parse(raw)
  } catch (e: any) {
    loud('manifest malformed', `${file}: ${e.message}`)
  }
  validateManifest(doc, file)
  manifestCache = doc as ManifestDoc
  return manifestCache
}

function validateManifest(doc: any, where: string): void {
  if (doc?.schemaVersion !== 1) loud('manifest malformed', `${where}: schemaVersion must be 1.`)
  if (!Array.isArray(doc?.assets)) loud('manifest malformed', `${where}: assets must be an array.`)
  const seen = new Set<string>()
  for (const asset of doc.assets) {
    if (!ID_RE.test(String(asset?.id ?? ''))) {
      loud('manifest malformed', `${where}: id "${asset?.id}" is not a plain lowercase id (a-z, 0-9, hyphen).`)
    }
    if (seen.has(asset.id)) loud('manifest malformed', `${where}: duplicate id "${asset.id}".`)
    seen.add(asset.id)
    if (typeof asset?.name !== 'string' || !asset.name.trim()) {
      loud('manifest malformed', `${where}: id "${asset.id}" has no name.`)
    }
    // The file name travels into path.join — an id or a name must never
    // reach it, and neither may anything carrying a separator or a dot.
    const file = String(asset?.file ?? '')
    if (!/^[a-z0-9][a-z0-9-]{0,63}\.webp$/.test(file)) {
      loud('manifest malformed', `${where}: id "${asset.id}" has an unsafe file name "${file}".`)
    }
    if (!/^[a-f0-9]{64}$/.test(String(asset?.sha256 ?? ''))) {
      loud('manifest malformed', `${where}: id "${asset.id}" has no sha256.`)
    }
    if (!Number.isInteger(asset?.bytes) || (asset?.bytes as number) <= 0) {
      loud('manifest malformed', `${where}: id "${asset.id}" has no byte length.`)
    }
    // The approval word is the whole gate — a typo must not silently promote
    // unreviewed artwork, so it is allowed to be exactly one of two values.
    if (asset?.approval !== 'approved' && asset?.approval !== 'pending') {
      loud('manifest malformed', `${where}: id "${asset.id}" approval must be "approved" or "pending", got ${JSON.stringify(asset?.approval)}.`)
    }
  }
}

/** Catalog entry by id regardless of approval (pending included). */
function manifestAsset(id: string): ManifestAsset {
  const doc = loadManifest()
  const asset = doc.assets.find(a => a.id === id)
  if (!asset) {
    const known = doc.assets.map(a => a.id).join(', ') || '(none)'
    loud('unknown background id', `"${id}" is not an app-owned background. Known ids: ${known}.`)
  }
  return asset
}

/** Approved entries only — what a picker may offer. */
function approvedAsset(id: string): ManifestAsset {
  const asset = manifestAsset(id)
  if (asset.approval !== 'approved') {
    loud('background not approved', `"${id}" is bundled but not approved for use yet. `
      + 'It becomes available when the owner approves it in the catalog manifest; there is no switch to flip here.')
  }
  return asset
}

function assertInside(dir: string, file: string): string {
  const abs = path.resolve(dir, file)
  const dirWithSep = dir.endsWith(path.sep) ? dir : dir + path.sep
  if (!abs.startsWith(dirWithSep)) {
    loud('path traversal refused', `file "${file}" escapes ${dir}.`)
  }
  return abs
}

/**
 * Hash the bytes as read — no cache. A hash remembered across a manifest
 * change is the one way an integrity check can go stale in the safe-looking
 * direction, and twelve small files are cheap to read.
 */
function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Every APPROVED background, in manifest order. Pending entries never appear. */
export function listBackgrounds(): BackgroundEntry[] {
  return loadManifest().assets
    .filter(a => a.approval === 'approved')
    .map(a => ({
      id: a.id,
      name: a.name,
      reference: `\${BACKGROUND}/${a.id}`,
    }))
}

/**
 * Absolute, integrity-checked path of a known APPROVED background id.
 * An unknown id, a pending id, a missing file and tampered bytes all throw
 * with the id named.
 */
export function resolveBackground(id: string): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    loud('unknown background id', `"${String(id)}" is not an app-owned background id. `
      + 'Allowed: lowercase a-z, 0-9 and hyphens, starting with a letter or digit.')
  }
  const asset = approvedAsset(id)
  const file = assertInside(backgroundsDir(), asset.file)
  let bytes: Buffer
  try {
    bytes = readFileSync(file)
  } catch {
    loud('missing asset', `${id} expects ${file} but the file is not there.`)
  }
  if (bytes.length !== asset.bytes) {
    loud('tampered asset', `${id} at ${file} is ${bytes.length} bytes, expected ${asset.bytes}. `
      + 'The bundled background was altered or truncated; reinstall the app to restore it.')
  }
  const actual = sha256Of(bytes)
  if (actual !== asset.sha256) {
    loud('tampered asset', `${id} at ${file} hashes to ${actual}, expected ${asset.sha256}. `
      + 'The bundled background was altered or truncated; reinstall the app to restore it.')
  }
  return file
}

/**
 * `${BACKGROUND}/<id>` when `abs` is an APPROVED bundled catalog file, else
 * null. Pending bytes collapse the way any other file does, so an unapproved
 * background can never travel as a catalog reference. Non-catalog paths
 * return null so callers keep collapsing them exactly as before; one
 * malformed path name reports rather than half-collapse.
 */
export function backgroundReferenceForPath(abs: string): string | null {
  if (typeof abs !== 'string' || !abs) return null
  if (!path.isAbsolute(abs)) return null
  let doc: ManifestDoc
  try {
    doc = loadManifest()
  } catch {
    // No readable catalog: leave the caller's ordinary collapse alone.
    return null
  }
  const target = path.normalize(abs)
  const dir = backgroundsDir()
  for (const asset of doc.assets) {
    if (asset.approval !== 'approved') continue
    if (path.normalize(path.resolve(dir, asset.file)) === target) return `\${BACKGROUND}/${asset.id}`
  }
  return null
}