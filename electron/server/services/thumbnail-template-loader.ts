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
import { existsSync, constants as fsConstants } from 'fs'
import { createHash } from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import * as pm from './project-manager.js'
import type { ThumbnailTemplate, ProjectMeta, Niche } from '../models/types.js'
import {
  isQualifiedContentPackId,
  listCatalogEntries,
  listUserForkCatalogEntries,
  resolveCatalogItem,
  resolveUserForkCatalogItem,
  type CatalogEntry,
  type ContentPackRegistryOptions,
} from '../content-packs/registry.js'
import { readContentPackState } from '../content-packs/state.js'
import { readUserFork, isUserForkId } from '../content-packs/user-forks.js'
import { contentPackDocumentToThumbnailTemplate } from '../content-packs/legacy-adapters.js'
import type { ContentPackDocument } from '../content-packs/types.js'
import { compareVersionStrings } from '../content-packs/version-order.js'
import { registryOptionsForCurrentJob, resolveProjectContentPinsForKinds } from '../content-packs/project-pins.js'
import { getContentPackRuntimePaths, resolveVerifiedPackFile } from '../content-packs/runtime-paths.js'

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
  const mapped = contentPackDocumentToThumbnailTemplate(entry.value, previews)
  // `builtin: true` — system content, never the customer's own copy. The library
  // badges a card "Your copy" exactly when this is false.
  return Object.assign(mapped, { signedPackVersion: entry.pack.version })
}

/**
 * One library card per recipe identity (2026-10-24).
 *
 * Before this, the library listed the same recipe two or three times:
 *
 *   1. A signed pack recipe and its legacy bundled twin are the SAME recipe
 *      under two ids — `com.storystudio.thumbnail.documentary-label-tableau`
 *      and `documentary-label-tableau`. Keying the list by raw id showed both.
 *   2. A pack that ships `1.0.0` and `1.0.1` with the same recipe id, or a
 *      project pin older than the active version, emitted the recipe once per
 *      version.
 *
 * The identity is the recipe id's last dot-segment, which the signed id keeps
 * from the legacy id it replaces. Resolution is read-time only: no pack, no
 * project pin and no preset is rewritten (§5).
 */
type RankedRecipe = ThumbnailTemplate & { signedPackVersion?: string }

function recipeFamilyKey(recipe: ThumbnailTemplate): string {
  const id = recipe.id.toLowerCase()
  // The name too: two different recipes that happen to share an id tail must never merge.
  return `${id.slice(id.lastIndexOf('.') + 1)}|${recipe.name.trim().toLowerCase()}`
}

function preferRecipe(seen: Map<string, RankedRecipe>, recipe: RankedRecipe): void {
  const key = recipeFamilyKey(recipe)
  const current = seen.get(key)
  // A signed pack version always outranks a bundled legacy twin; between two
  // signed copies the newest version wins. The customer's own copies never
  // reach here — they resolve before this list is consulted.
  if (current?.signedPackVersion && recipe.signedPackVersion
    && compareVersionStrings(recipe.signedPackVersion, current.signedPackVersion) <= 0) return
  if (current?.signedPackVersion && !recipe.signedPackVersion) return
  seen.set(key, recipe)
}

export async function loadTemplate(id: string, registryOptions: ContentPackRegistryOptions = {}): Promise<ThumbnailTemplate | null> {
  if (!id) return null
  const userFork = await resolveUserForkCatalogItem(id, 'thumbnail-recipe', registryOptions)
  if (userFork) return userFork.value as ThumbnailTemplate
  if (isQualifiedContentPackId(id)) {
    const effectiveOptions = await registryOptionsForCurrentJob(['thumbnail-recipe'], registryOptions)
    const signed = await resolveCatalogItem(id, undefined, effectiveOptions)
    if (signed) {
      const mapped = signedTemplate(signed)
      if (mapped) return mapped
    }
  }
  return loadLegacyThumbnailTemplate(id).then(result => result?.document ?? null)
}

/** Explicit compatibility resolver used by non-destructive fork-on-edit. */
export async function loadLegacyThumbnailTemplate(id: string): Promise<{ document: ThumbnailTemplate; source: 'legacy-builtin' | 'legacy-user-fork' } | null> {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)) return null
  const userPath = path.join(userTemplatesDir(), `${id}.json`)
  if (existsSync(userPath)) {
    const st = await fs.stat(userPath)
    const cached = userCache.get(userPath)
    if (cached && cached.mtimeMs === st.mtimeMs) return { document: cached.template, source: 'legacy-user-fork' }
    const t = await loadFile(userPath)
    userCache.set(userPath, { mtimeMs: st.mtimeMs, template: t })
    return { document: t, source: 'legacy-user-fork' }
  }
  if (builtinCache.has(id)) return { document: builtinCache.get(id)!, source: 'legacy-builtin' }
  const builtinPath = path.join(BUILTIN_TEMPLATES_DIR, `${id}.json`)
  if (!existsSync(builtinPath)) return null
  const t = await loadFile(builtinPath)
  builtinCache.set(id, t)
  return { document: t, source: 'legacy-builtin' }
}

/**
 * List every available template (built-in + user-custom), sorted by
 * name. Malformed JSONs are skipped with a console warning rather than
 * failing the list — one bad file shouldn't hide the whole library.
 */
export async function listTemplates(registryOptions: ContentPackRegistryOptions = {}): Promise<ThumbnailTemplate[]> {
  const seen = new Map<string, RankedRecipe>()
  for (const entry of await listCatalogEntries('thumbnail-recipe', registryOptions)) {
    const mapped = signedTemplate(entry)
    if (mapped) preferRecipe(seen, mapped)
  }

  for (const entry of await listUserForkCatalogEntries('thumbnail-recipe', registryOptions)) {
    const template = entry.value as ThumbnailTemplate
    // The customer's own copy keeps its own identity: same name, own card. A
    // fork's id is its own `user:<uuid>`, so it never collides with the signed
    // recipe it was forked from — even when the legacy source id does.
    if (!seen.has(`copy:${template.id}`)) seen.set(`copy:${template.id}`, { ...template, builtin: false })
  }

  const userDir = userTemplatesDir()
  if (existsSync(userDir)) {
    let entries: string[] = []
    try { entries = await fs.readdir(userDir) } catch { /* ignore */ }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      try {
        const t = await loadFile(path.join(userDir, name))
        seen.set(`copy:${t.id}`, { ...t, builtin: false })
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
        preferRecipe(seen, t)
      } catch (e: any) {
        console.warn(`[thumbnail-template-loader] skipping malformed built-in template ${name}: ${e.message}`)
      }
    }
  }

  return [...seen.values()]
    .map(({ signedPackVersion: _signedPackVersion, ...template }) => template)
    .sort((a, b) => a.name.localeCompare(b.name))
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
  registryOptions: ContentPackRegistryOptions = {},
): Promise<ThumbnailTemplate | null> {
  const pins = await resolveProjectContentPinsForKinds(project, ['thumbnail-recipe'], registryOptions)
  const pinnedOptions = { ...registryOptions, pins }
  // 1. Project-level override wins everywhere
  const cfg = projectConfig || (await pm.getConfig(project.slug)) || {}
  const overrideId = typeof cfg.thumbnail_template_id === 'string' ? cfg.thumbnail_template_id : ''
  if (overrideId) {
    const t = await loadTemplate(overrideId, pinnedOptions)
    if (t) return t
    console.warn(`[thumbnail-template-loader] project '${project.slug}' references template '${overrideId}' but no file found; falling back to niche default`)
  }

  // 2. Niche's declared default (the modern path)
  if (niche?.defaultThumbnailTemplateId) {
    const t = await loadTemplate(niche.defaultThumbnailTemplateId, pinnedOptions)
    if (t) return t
    console.warn(`[thumbnail-template-loader] niche '${niche.id}' references default template '${niche.defaultThumbnailTemplateId}' but no file was found`)
  }

  return null
}

// ── Mutation helpers (used by /thumbnail-templates routes) ─────────────────

export function templateFilePath(id: string): string {
  return path.join(userTemplatesDir(), `${id}.json`)
}

/**
 * Resolve a template's reusable Shell image to a validated local file.
 * A declared-but-unavailable reference (unsafe path, missing, unreadable,
 * tampered sha256) THROWS: returning null would silently drop a declared Shell
 * into text-only. Text-only Shells carry no reference, which returns null.
 */
export async function resolveTemplateShellImage(
  template: ThumbnailTemplate,
  registryOptions: ContentPackRegistryOptions = {},
): Promise<string | null> {
  const reference = typeof template.shellImage === 'string' ? template.shellImage.trim() : ''
  if (!reference) return null
  if (!isSafeShellRelativeAsset(reference)) {
    throw new Error(`Shell image reference "${reference}" is not a managed relative asset (shell/ or assets/)`)
  }

  if (reference.startsWith('assets/')) {
    // Signed-origin reference (pack item, or a user fork of one): locate the
    // exact installed pack/version through the catalogue, never from the id.
    const sourceId = isQualifiedContentPackId(template.id)
      ? template.id
      : (await readUserFork(template.id, { paths: registryOptions.paths }))?.source.legacy_id
    if (!sourceId || !isQualifiedContentPackId(sourceId)) {
      throw new Error(`Shell image "${reference}" has no installed source pack`)
    }
    // Same effective options the loader itself uses (project pins included), and
    // the image must come from the exact pack version the template was mapped
    // from — otherwise note and image can land on different versions.
    const effectiveOptions = await registryOptionsForCurrentJob(['thumbnail-recipe'], registryOptions)
    // signedPackVersion rides on mapped signed templates but is not on the base type.
    const signedVersion = (template as ThumbnailTemplate & { signedPackVersion?: string }).signedPackVersion
    const matches = (await listCatalogEntries('thumbnail-recipe', effectiveOptions))
      .filter(item => item.value.id === sourceId && item.pack
        && (!signedVersion || item.pack!.version === signedVersion))
    const entry = matches[0]
    if (!entry?.pack) throw new Error(`Shell image "${reference}" belongs to an unknown content pack${signedVersion ? ` version ${signedVersion}` : ''}`)
    return resolveCatalogShellImage(entry, reference, effectiveOptions)
  }

  // `shell/...` references are basename-managed beside every user/fork template
  // in one global directory, so a Shell survives channel changes (AGENTS §5).
  await assertManagedShellDirIsReal()
  const candidate = managedShellImagePath(reference)
  if (!candidate || !(await readFileSafe(candidate))) {
    throw new Error(`Shell image "${reference}" is missing or unreadable on disk`)
  }
  return candidate
}

/** Verify the exact catalogue version without re-entering the coordination lock during a fork. */
export async function resolveCatalogShellImage(
  entry: CatalogEntry<ContentPackDocument>,
  reference: string,
  options: ContentPackRegistryOptions = {},
): Promise<string> {
  if (!entry.pack || !isSafeShellRelativeAsset(reference) || !reference.startsWith('assets/')) {
    throw new Error('Shell image must name a verified pack asset')
  }
  const paths = options.paths ?? getContentPackRuntimePaths()
  const installed = (await readContentPackState(paths)).packs[entry.pack.pack_id]?.versions[entry.pack.version]
  if (!installed) throw new Error(`Shell image "${reference}" needs content pack ${entry.pack.pack_id} ${entry.pack.version} installed`)
  const declared = installed.manifest.files.find(file => file.path === reference)
  if (!declared) throw new Error(`Shell image "${reference}" is not declared in the pack manifest`)
  const candidate = resolveVerifiedPackFile(installed.install_path, reference)
  const bytes = await readFileSafe(candidate)
  if (!bytes) throw new Error(`Shell image "${reference}" is missing or unreadable on disk`)
  if (createHash('sha256').update(bytes).digest('hex') !== declared.sha256) {
    throw new Error(`Shell image "${reference}" failed its integrity check`)
  }
  return candidate
}

/** Global managed Shell bytes directory — shared by every user template/fork. */
export function managedShellDir(): string {
  return path.join(userTemplatesDir(), 'shell-images')
}

export function managedShellImagePath(reference: string): string | null {
  return isSafeShellRelativeAsset(reference) && reference.startsWith('shell/')
    ? path.join(managedShellDir(), path.basename(reference))
    : null
}

/**
 * Save-boundary validation for Shell fields. Text-only Shells (note, or nothing)
 * are legal; the one hard rule is an image always carries a non-empty layout
 * note (runtime can never invent it without a per-episode vision charge).
 * No raw paths/URLs. Throws a plain Error; callers surface it as a 400/409.
 */
export async function validateShellSaveFields(template: ThumbnailTemplate): Promise<void> {
  if (template.shellImage !== undefined && typeof template.shellImage !== 'string') {
    throw new Error('shellImage must be a string')
  }
  if (template.layoutNote !== undefined && typeof template.layoutNote !== 'string') {
    throw new Error('layoutNote must be a string')
  }
  // An empty string simply clears the field — a text-only Shell may carry no
  // note at all, and note-only authoring is legal.
  const note = (template.layoutNote ?? '').trim()
  if (note.length > 4000) throw new Error('layoutNote must be 4000 characters or fewer')
  const reference = (template.shellImage ?? '').trim()
  if (!reference) return
  if (!isSafeShellRelativeAsset(reference)) {
    throw new Error('shell image must be a managed relative asset reference (shell/ or assets/)')
  }
  if (reference.startsWith('shell/')) {
    await assertManagedShellDirIsReal()
    const managed = managedShellImagePath(reference)
    const stat = managed ? await fs.lstat(managed).catch(() => null) : null
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new Error('shell image reference does not name an existing managed image')
    }
  }
  if (!note) throw new Error('a shell image requires a non-empty layout note')
}

/**
 * The managed Shell directory itself must be a real directory beneath
 * userTemplatesDir(): a swapped-in symlink there would let leaf lstat checks
 * pass while writing/reading outside the managed location.
 */
export async function assertManagedShellDirIsReal(): Promise<void> {
  const root = path.join(userTemplatesDir(), 'shell-images')
  const parent = userTemplatesDir()
  try {
    const [realRoot, realParent] = await Promise.all([fs.realpath(root), fs.realpath(parent)])
    if (realRoot !== path.join(realParent, 'shell-images')) {
      throw new Error('managed Shell directory is not a real directory under the template library')
    }
  } catch (error: any) {
    if (error?.code === 'ENOENT') return // never created yet — nothing to escape
    throw error
  }
}

/** A template the customer may edit in place (their own copy), not an immutable source. */
export function isUserShellTemplate(template: ThumbnailTemplate): boolean {
  return !template.builtin && !isQualifiedContentPackId(template.id)
}

/** Save a user-owned Shell template (fork record or user-library JSON). */
export async function saveShellTemplateDocument(
  id: string,
  template: ThumbnailTemplate,
  registryOptions: ContentPackRegistryOptions = {},
): Promise<void> {
  await validateShellSaveFields(template)
  if (isUserForkId(id)) {
    const { saveUserForkDocument } = await import('../content-packs/user-forks.js')
    await saveUserForkDocument(id, template as Parameters<typeof saveUserForkDocument>[1], registryOptions)
    return
  }
  if (isQualifiedContentPackId(id)) throw new Error('Signed Shell templates are immutable; edit a copy')
  const normalized = { ...template, id, builtin: false, schemaVersion: 1 }
  await ensureTemplatesDir()
  await fs.writeFile(templateFilePath(id), JSON.stringify(normalized, null, 2) + '\n', 'utf8')
  invalidateTemplateCache(id)
}

async function readFileSafe(candidate: string): Promise<Buffer | null> {
  try {
    const stat = await fs.lstat(candidate)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    await fs.access(candidate, fsConstants.R_OK)
    return await fs.readFile(candidate)
  } catch {
    return null
  }
}

function isSafeShellRelativeAsset(reference: string): boolean {
  return /^(?:shell|assets)\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*\.(?:png|jpe?g|webp)$/i.test(reference)
    && !reference.includes('\0') && !reference.includes('\\') && !reference.includes('..')
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
