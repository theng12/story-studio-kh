/**
 * Niche loader — reads built-in + user-custom Niche profiles and resolves
 * the "effective niche" for a given project (base + per-project overrides
 * deep-merged).
 *
 * Layout:
 *   - Built-in niches: ${BUILTIN_NICHES_DIR}/{id}.json — shipped with the
 *     app (electron-builder copies electron/server/niches → resourcesPath/niches).
 *   - User-custom niches: ${PROJECTS_ROOT}/.niches/{id}.json — exportable as
 *     single JSON files, shareable across machines / users.
 *   - Per-project overrides: stored inside project.json as `niche_overrides`
 *     (DeepPartial<Niche>), applied with a deep merge on top of the base.
 *
 * Lookup:
 *   loadNiche('plants')      → built-in
 *   loadNiche('my-custom')   → user library
 *   getEffectiveNicheFor(p)  → null if p.niche_id unset or niche missing,
 *                              else base + project.niche_overrides
 *
 * Caching:
 *   Built-in niches are cached forever (immutable in the bundle).
 *   User-custom niches are cached + invalidated on mtime change so editing
 *   the JSON directly takes effect on the next read.
 *
 * Pattern is intentionally identical to format-loader.ts so the codebase
 * has one shape to maintain for "JSON profile + built-in + user-custom +
 * per-project overrides" loaders. If you're adding the next axis primitive
 * (themes, tone packs, season templates), copy this file again.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import * as pm from './project-manager.js'
import type { Niche, DeepPartial, ProjectMeta } from '../models/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// ── Built-in directory resolution ──────────────────────────────────────────
// Mirrors format-loader's logic so packaged Electron, dev (tsx), and the
// compiled-from-watcher path all resolve correctly.

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

function findRepoNichesDir(start: string, maxDepth = 8): string | null {
  let cur = start
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(cur, 'electron', 'server', 'niches')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

function resolveBuiltinNichesDir(): string {
  if (isPackagedApp() && process.resourcesPath) {
    return path.join(process.resourcesPath, 'niches')
  }
  const found = findRepoNichesDir(__dirname)
  if (found) return found
  const ROOT = path.resolve(__dirname, '..', '..', '..')
  return path.join(ROOT, 'electron', 'server', 'niches')
}

export const BUILTIN_NICHES_DIR = resolveBuiltinNichesDir()

function userNichesDir(): string {
  return path.join(pm.PROJECTS_ROOT, '.niches')
}

// ── Cache ──────────────────────────────────────────────────────────────────

const builtinCache = new Map<string, Niche>()
const userCache = new Map<string, { mtimeMs: number; niche: Niche }>()

async function loadNicheFile(filePath: string): Promise<Niche> {
  const raw = await fs.readFile(filePath, 'utf-8')
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch (e: any) {
    throw new Error(`Niche JSON parse failed at ${filePath}: ${e.message}`)
  }
  validateNicheShape(parsed, filePath)
  return parsed as Niche
}

function validateNicheShape(n: any, filePath: string): void {
  const missing: string[] = []
  if (typeof n?.id !== 'string' || !n.id) missing.push('id')
  if (typeof n?.name !== 'string' || !n.name) missing.push('name')
  if (typeof n?.description !== 'string') missing.push('description')
  if (n?.schemaVersion !== 1) missing.push('schemaVersion (must be 1)')
  if (!Array.isArray(n?.exampleTopics)) missing.push('exampleTopics (array)')
  if (missing.length) {
    throw new Error(`Niche at ${filePath} is missing required fields: ${missing.join(', ')}`)
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Load a niche by id. User-custom first (shadows built-ins by id), then
 * built-in library. Returns null if not found.
 */
export async function loadNiche(id: string): Promise<Niche | null> {
  if (!id) return null
  const userPath = path.join(userNichesDir(), `${id}.json`)
  if (existsSync(userPath)) {
    const st = await fs.stat(userPath)
    const cached = userCache.get(userPath)
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.niche
    const n = await loadNicheFile(userPath)
    userCache.set(userPath, { mtimeMs: st.mtimeMs, niche: n })
    return n
  }
  if (builtinCache.has(id)) return builtinCache.get(id)!
  const builtinPath = path.join(BUILTIN_NICHES_DIR, `${id}.json`)
  if (!existsSync(builtinPath)) return null
  const n = await loadNicheFile(builtinPath)
  builtinCache.set(id, n)
  return n
}

/**
 * List every available niche (built-in + user-custom), sorted by name.
 * Malformed JSONs are skipped with a console warning rather than failing
 * the list — the user can fix the bad file without losing the others.
 */
export async function listNiches(): Promise<Niche[]> {
  const seen = new Map<string, Niche>()

  const userDir = userNichesDir()
  if (existsSync(userDir)) {
    let entries: string[] = []
    try { entries = await fs.readdir(userDir) } catch { /* ignore */ }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      try {
        const n = await loadNicheFile(path.join(userDir, name))
        seen.set(n.id, n)
      } catch (e: any) {
        console.warn(`[niche-loader] skipping malformed user niche ${name}: ${e.message}`)
      }
    }
  }

  if (existsSync(BUILTIN_NICHES_DIR)) {
    let entries: string[] = []
    try { entries = await fs.readdir(BUILTIN_NICHES_DIR) } catch { /* ignore */ }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      try {
        const n = await loadNicheFile(path.join(BUILTIN_NICHES_DIR, name))
        if (!seen.has(n.id)) seen.set(n.id, n)
      } catch (e: any) {
        console.warn(`[niche-loader] skipping malformed built-in niche ${name}: ${e.message}`)
      }
    }
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Deep-merge `overrides` onto `base`. Arrays in overrides REPLACE the base
 * array — matches format-loader's merge semantics so the user mental model
 * stays consistent ("override = swap out the whole list").
 */
export function mergeNicheOverrides(base: Niche, overrides?: DeepPartial<Niche>): Niche {
  if (!overrides) return base
  return deepMerge(base, overrides) as Niche
}

function deepMerge(target: any, source: any): any {
  if (source === null || source === undefined) return target
  if (Array.isArray(source)) return source.slice()
  if (typeof source !== 'object') return source
  const out: any = Array.isArray(target) ? target.slice() : { ...(target || {}) }
  for (const key of Object.keys(source)) {
    const sv = source[key]
    if (sv === undefined) continue
    if (sv !== null && typeof sv === 'object' && !Array.isArray(sv) && target?.[key] && typeof target[key] === 'object') {
      out[key] = deepMerge(target[key], sv)
    } else {
      out[key] = Array.isArray(sv) ? sv.slice() : sv
    }
  }
  return out
}

/**
 * Resolve the effective niche for a project. Returns null when:
 *   - the project has no niche_id, or
 *   - the referenced niche file is missing (we log + fall back to null
 *     rather than throwing — generators must keep working with their
 *     format-only behavior if a niche file gets renamed mid-flight).
 */
export async function getEffectiveNicheFor(project: ProjectMeta): Promise<Niche | null> {
  if (!project.niche_id) return null
  let base: Niche | null = null
  try {
    base = await loadNiche(project.niche_id)
  } catch (e: any) {
    console.warn(`[niche-loader] failed loading niche '${project.niche_id}' for project '${project.slug}': ${e.message}`)
    return null
  }
  if (!base) {
    console.warn(`[niche-loader] project '${project.slug}' references niche '${project.niche_id}' but no file found`)
    return null
  }
  return mergeNicheOverrides(base, project.niche_overrides)
}

/** Same as getEffectiveNicheFor() but takes a slug. */
export async function getEffectiveNiche(slug: string): Promise<Niche | null> {
  const project = await pm.getProject(slug)
  if (!project) return null
  return getEffectiveNicheFor(project)
}

// ── Mutation helpers (used by the /niches routes) ──────────────────────────

export function nicheFilePath(id: string): string {
  return path.join(userNichesDir(), `${id}.json`)
}

export async function ensureNichesDir(): Promise<void> {
  await fs.mkdir(userNichesDir(), { recursive: true })
}

export function invalidateNicheCache(id: string): void {
  userCache.delete(nicheFilePath(id))
  builtinCache.delete(id)
}

/** Test-only — wipe caches so freshly-written niche files take effect. */
export function _clearNicheCaches(): void {
  builtinCache.clear()
  userCache.clear()
}

export { userNichesDir as _userNichesDir }
