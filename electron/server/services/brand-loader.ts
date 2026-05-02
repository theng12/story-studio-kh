/**
 * Brand loader — reads user-defined Brand profiles and resolves the
 * "effective brand" for a given project.
 *
 * Layout:
 *   - User-defined brands: ${PROJECTS_ROOT}/.brands/{id}.json — exportable
 *     as single JSON files, shareable across machines / users.
 *   - Per-project association: stored inside project.json as `brand_id`.
 *
 * Lookup:
 *   loadBrand('demo')        → reads ${PROJECTS_ROOT}/.brands/demo.json
 *   listBrands()             → directory scan, skip-malformed-with-warn
 *   getEffectiveBrandFor(p)  → null if p.brand_id unset or brand missing
 *
 * Caching:
 *   Keyed by (path, mtimeMs) so editing the JSON directly takes effect on
 *   the next read. Mirrors format-loader's user-cache strategy.
 *
 * Compared to formats: no built-in directory. Brands are inherently
 * per-channel — there's no useful "default brand" to ship.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import * as pm from './project-manager.js'
import type { Brand, ProjectMeta } from '../models/types.js'

/** Where user-defined brands live. */
function brandsDir(): string {
  return path.join(pm.PROJECTS_ROOT, '.brands')
}

// ── Cache ──────────────────────────────────────────────────────────────────

const userCache = new Map<string, { mtimeMs: number; brand: Brand }>()

/**
 * Read + validate one brand JSON file. Throws on parse error or missing
 * required fields so callers can decide whether to log + fall back.
 */
async function loadBrandFile(filePath: string): Promise<Brand> {
  const raw = await fs.readFile(filePath, 'utf-8')
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch (e: any) {
    throw new Error(`Brand JSON parse failed at ${filePath}: ${e.message}`)
  }
  validateBrandShape(parsed, filePath)
  return parsed as Brand
}

function validateBrandShape(b: any, filePath: string): void {
  // Lightweight structural check — schema-side fields are validated at
  // the HTTP boundary by BrandSchema. Loader only enforces the
  // invariants downstream code depends on.
  const missing: string[] = []
  if (typeof b?.id !== 'string' || !b.id) missing.push('id')
  if (typeof b?.name !== 'string' || !b.name) missing.push('name')
  if (b?.schemaVersion !== 1) missing.push('schemaVersion (must be 1)')
  if (missing.length) {
    throw new Error(`Brand at ${filePath} is missing required fields: ${missing.join(', ')}`)
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Load a brand by id. Returns null if the file doesn't exist; throws on
 * parse / validation errors so the caller can surface the message.
 */
export async function loadBrand(id: string): Promise<Brand | null> {
  if (!id) return null
  const filePath = path.join(brandsDir(), `${id}.json`)
  if (!existsSync(filePath)) return null
  const st = await fs.stat(filePath)
  const cached = userCache.get(filePath)
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.brand
  const brand = await loadBrandFile(filePath)
  userCache.set(filePath, { mtimeMs: st.mtimeMs, brand })
  return brand
}

/**
 * List every brand on disk, sorted by name. Malformed JSON files are
 * skipped with a console warning rather than failing the whole list —
 * the user can fix the bad file without losing access to their others.
 */
export async function listBrands(): Promise<Brand[]> {
  const dir = brandsDir()
  if (!existsSync(dir)) return []
  let entries: string[] = []
  try { entries = await fs.readdir(dir) } catch { return [] }
  const out: Brand[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    try {
      const filePath = path.join(dir, name)
      const st = await fs.stat(filePath)
      const cached = userCache.get(filePath)
      if (cached && cached.mtimeMs === st.mtimeMs) {
        out.push(cached.brand)
        continue
      }
      const brand = await loadBrandFile(filePath)
      userCache.set(filePath, { mtimeMs: st.mtimeMs, brand })
      out.push(brand)
    } catch (e: any) {
      console.warn(`[brand-loader] skipping malformed brand ${name}: ${e.message}`)
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Resolve the effective brand for a project. Returns null when:
 *   - project has no brand_id, or
 *   - the referenced brand file is missing (we log + fall back rather
 *     than throwing — generators must keep working with their literal
 *     defaults if a brand file gets renamed mid-flight).
 */
export async function getEffectiveBrandFor(project: ProjectMeta): Promise<Brand | null> {
  if (!project.brand_id) return null
  try {
    const brand = await loadBrand(project.brand_id)
    if (!brand) {
      console.warn(`[brand-loader] project '${project.slug}' references brand '${project.brand_id}' but no file found`)
      return null
    }
    return brand
  } catch (e: any) {
    console.warn(`[brand-loader] failed loading brand '${project.brand_id}' for project '${project.slug}': ${e.message}`)
    return null
  }
}

/**
 * Same as getEffectiveBrandFor() but takes a slug. Convenience for callers
 * that already have the slug but not the project.
 */
export async function getEffectiveBrand(slug: string): Promise<Brand | null> {
  const project = await pm.getProject(slug)
  if (!project) return null
  return getEffectiveBrandFor(project)
}

// ── Mutation helpers (used by the /brands routes) ──────────────────────────

/** Path on disk where a brand by this id would live (whether or not it exists). */
export function brandFilePath(id: string): string {
  return path.join(brandsDir(), `${id}.json`)
}

/** Ensure the brands directory exists. Idempotent. */
export async function ensureBrandsDir(): Promise<void> {
  await fs.mkdir(brandsDir(), { recursive: true })
}

/** Drop a single cached brand entry (e.g. after delete). */
export function invalidateBrandCache(id: string): void {
  userCache.delete(brandFilePath(id))
}

/** Test-only — wipe caches so freshly-written brand files take effect. */
export function _clearBrandCaches(): void {
  userCache.clear()
}

/** Exposed for the routes layer + tests. */
export { brandsDir as _brandsDir }
