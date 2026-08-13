/**
 * Thumbnail-template loader (v1.0.105+).
 *
 * First-class library of thumbnail layouts, decoupled from niches.
 * Niches declare a `defaultThumbnailTemplateId` to pair with one by
 * default; projects can override that pairing via project.config
 * `thumbnail_template_id`. Templates are pure layout — the compose
 * endpoint takes (source image, template, optional text + logo) and
 * renders a fresh thumbnail.
 *
 * Layout (mirrors niche-loader exactly):
 *   - Built-in templates: ${BUILTIN_DIR}/{id}.json — shipped with the
 *     app (electron-builder copies → resourcesPath/thumbnail-templates).
 *   - User-custom: ${PROJECTS_ROOT}/.thumbnail-templates/{id}.json —
 *     exportable as single JSON, shareable across machines.
 *
 * Lookup:
 *   loadTemplate('portrait-block-right')         → built-in
 *   loadTemplate('my-custom-style')              → user library
 *   getEffectiveTemplateFor(project, niche)      → project override →
 *                                                  niche default → null
 *
 * Caching mirrors niche-loader: built-ins forever, user-custom by mtime.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import * as pm from './project-manager.js'
import type { ThumbnailTemplate, ProjectMeta, Niche } from '../models/types.js'
import {
  isQualifiedContentPackId,
  listCatalogEntries,
  resolveCatalogItem,
  type CatalogEntry,
  type ContentPackRegistryOptions,
} from '../content-packs/registry.js'
import { contentPackDocumentToThumbnailTemplate } from '../content-packs/legacy-adapters.js'
import type { ContentPackDocument } from '../content-packs/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// ── Built-in directory resolution ──────────────────────────────────────────

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

function findRepoTemplatesDir(start: string, maxDepth = 8): string | null {
  let cur = start
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(cur, 'electron', 'server', 'thumbnail-templates')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

function resolveBuiltinDir(): string {
  if (isPackagedApp() && process.resourcesPath) {
    return path.join(process.resourcesPath, 'thumbnail-templates')
  }
  const found = findRepoTemplatesDir(__dirname)
  if (found) return found
  const ROOT = path.resolve(__dirname, '..', '..', '..')
  return path.join(ROOT, 'electron', 'server', 'thumbnail-templates')
}

export const BUILTIN_TEMPLATES_DIR = resolveBuiltinDir()

function userTemplatesDir(): string {
  return path.join(pm.projectsRoot(), '.thumbnail-templates')
}

// ── Cache ──────────────────────────────────────────────────────────────────

const builtinCache = new Map<string, ThumbnailTemplate>()
const userCache = new Map<string, { mtimeMs: number; template: ThumbnailTemplate }>()

async function loadFile(filePath: string): Promise<ThumbnailTemplate> {
  const raw = await fs.readFile(filePath, 'utf-8')
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch (e: any) {
    throw new Error(`ThumbnailTemplate JSON parse failed at ${filePath}: ${e.message}`)
  }
  validateShape(parsed, filePath)
  return parsed as ThumbnailTemplate
}

function validateShape(t: any, filePath: string): void {
  const missing: string[] = []
  if (typeof t?.id !== 'string' || !t.id) missing.push('id')
  if (typeof t?.name !== 'string' || !t.name) missing.push('name')
  if (typeof t?.description !== 'string') missing.push('description')
  if (t?.schemaVersion !== 1) missing.push('schemaVersion (must be 1)')
  if (missing.length) {
    throw new Error(`ThumbnailTemplate at ${filePath} is missing required fields: ${missing.join(', ')}`)
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Load a template by id. User-custom first, then built-in. Returns
 * null when not found.
 */
function signedTemplate(entry: CatalogEntry<ContentPackDocument>): ThumbnailTemplate | null {
  if (entry.value.kind !== 'thumbnail-recipe' || !entry.pack) return null
  const previews = entry.value.preview_assets.flatMap(assetPath => {
    const asset = entry.assets?.[assetPath]
    return asset
      ? [`/api/content-packs/${encodeURIComponent(entry.pack!.pack_id)}/${encodeURIComponent(entry.pack!.version)}/assets/${encodeURIComponent(asset.asset_id)}`]
      : []
  })
  return contentPackDocumentToThumbnailTemplate(entry.value, previews)
}

export async function loadTemplate(id: string, registryOptions: ContentPackRegistryOptions = {}): Promise<ThumbnailTemplate | null> {
  if (!id) return null
  if (isQualifiedContentPackId(id)) {
    const signed = await resolveCatalogItem(id, undefined, registryOptions)
    if (signed) {
      const mapped = signedTemplate(signed)
      if (mapped) return mapped
    }
  }
  const userPath = path.join(userTemplatesDir(), `${id}.json`)
  if (existsSync(userPath)) {
    const st = await fs.stat(userPath)
    const cached = userCache.get(userPath)
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.template
    const t = await loadFile(userPath)
    userCache.set(userPath, { mtimeMs: st.mtimeMs, template: t })
    return t
  }
  if (builtinCache.has(id)) return builtinCache.get(id)!
  const builtinPath = path.join(BUILTIN_TEMPLATES_DIR, `${id}.json`)
  if (!existsSync(builtinPath)) return null
  const t = await loadFile(builtinPath)
  builtinCache.set(id, t)
  return t
}

/**
 * List every available template (built-in + user-custom), sorted by
 * name. Malformed JSONs are skipped with a console warning rather than
 * failing the list — one bad file shouldn't hide the whole library.
 */
export async function listTemplates(registryOptions: ContentPackRegistryOptions = {}): Promise<ThumbnailTemplate[]> {
  const seen = new Map<string, ThumbnailTemplate>()
  for (const entry of await listCatalogEntries('thumbnail-recipe', registryOptions)) {
    const mapped = signedTemplate(entry)
    if (mapped) seen.set(mapped.id, mapped)
  }

  const userDir = userTemplatesDir()
  if (existsSync(userDir)) {
    let entries: string[] = []
    try { entries = await fs.readdir(userDir) } catch { /* ignore */ }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      try {
        const t = await loadFile(path.join(userDir, name))
        if (!seen.has(t.id)) seen.set(t.id, t)
      } catch (e: any) {
        console.warn(`[thumbnail-template-loader] skipping malformed user template ${name}: ${e.message}`)
      }
    }
  }

  if (existsSync(BUILTIN_TEMPLATES_DIR)) {
    let entries: string[] = []
    try { entries = await fs.readdir(BUILTIN_TEMPLATES_DIR) } catch { /* ignore */ }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      try {
        const t = await loadFile(path.join(BUILTIN_TEMPLATES_DIR, name))
        if (!seen.has(t.id)) seen.set(t.id, t)
      } catch (e: any) {
        console.warn(`[thumbnail-template-loader] skipping malformed built-in template ${name}: ${e.message}`)
      }
    }
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Resolve the effective template for a project, given its already-
 * resolved niche. Resolution chain:
 *
 *   project.config.thumbnail_template_id   (explicit override)
 *     → niche.defaultThumbnailTemplateId    (niche's recommended default)
 *     → null
 *
 * Callers can pass `niche = null` (project has no niche set) — the
 * project override still wins if one is configured, otherwise null.
 */
export async function getEffectiveTemplateFor(
  project: ProjectMeta,
  niche: Niche | null,
  projectConfig?: Record<string, any> | null,
): Promise<ThumbnailTemplate | null> {
  // 1. Project-level override wins everywhere
  const cfg = projectConfig || (await pm.getConfig(project.slug)) || {}
  const overrideId = typeof cfg.thumbnail_template_id === 'string' ? cfg.thumbnail_template_id : ''
  if (overrideId) {
    const t = await loadTemplate(overrideId)
    if (t) return t
    console.warn(`[thumbnail-template-loader] project '${project.slug}' references template '${overrideId}' but no file found; falling back to niche default`)
  }

  // 2. Niche's declared default (the modern path)
  if (niche?.defaultThumbnailTemplateId) {
    const t = await loadTemplate(niche.defaultThumbnailTemplateId)
    if (t) return t
    console.warn(`[thumbnail-template-loader] niche '${niche.id}' references default template '${niche.defaultThumbnailTemplateId}' but no file was found`)
  }

  return null
}

// ── Mutation helpers (used by /thumbnail-templates routes) ─────────────────

export function templateFilePath(id: string): string {
  return path.join(userTemplatesDir(), `${id}.json`)
}

export async function ensureTemplatesDir(): Promise<void> {
  // ensureProjectsRoot() so the test-isolation guard fires before a recursive
  // mkdir can create `.thumbnail-templates` in the real projects folder.
  await fs.mkdir(path.join(pm.ensureProjectsRoot(), '.thumbnail-templates'), { recursive: true })
}

export function invalidateTemplateCache(id: string): void {
  userCache.delete(templateFilePath(id))
  builtinCache.delete(id)
}

/** Test-only — wipe caches so freshly-written files take effect. */
export function _clearTemplateCaches(): void {
  builtinCache.clear()
  userCache.clear()
}

export { userTemplatesDir as _userTemplatesDir }
