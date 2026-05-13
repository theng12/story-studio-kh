/**
 * Format loader — reads built-in + user-custom Format profiles and resolves
 * the "effective format" for a given project (base + per-project overrides
 * deep-merged).
 *
 * Layout:
 *   - Built-in formats: ${BUILTIN_FORMATS_DIR}/{id}.json — shipped with the
 *     app (electron-builder copies electron/server/formats → resourcesPath/formats).
 *   - User-custom formats: ${PROJECTS_ROOT}/.formats/{id}.json — exportable as
 *     single JSON files, shareable across machines / users.
 *   - Per-project overrides: stored inside project.json as `format_overrides`
 *     (DeepPartial<Format>), applied with a deep merge on top of the base.
 *
 * Lookup:
 *   loadFormat('sleep-story') → built-in
 *   loadFormat('my-custom')   → user library
 *   getEffectiveFormat(slug)  → reads project.format_id, loads base, applies
 *                                project.format_overrides, returns merged result
 *
 * Caching:
 *   Built-in formats are cached forever (immutable in the bundle).
 *   User-custom formats are cached + invalidated on mtime change so editing
 *   the JSON directly takes effect on the next read.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import * as pm from './project-manager.js'
import type { Format, DeepPartial, ProjectMeta } from '../models/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/** Default base format used when a project has no `format_id` set yet. */
export const DEFAULT_FORMAT_ID = 'sleep-story'

// ── Built-in directory resolution ──────────────────────────────────────────
//
// Mirrors resolveTemplatesRoot() in project-manager.ts: in packaged Electron
// the formats live under process.resourcesPath; in dev (tsx or compiled JS
// from the watcher) they live in the source tree at electron/server/formats.

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
 * Walk up from `start` until a directory contains `electron/server/formats`.
 * Robust to both source layout (electron/server/services running via tsx)
 * AND compiled layout (electron/dist/server/services running via Electron),
 * which differ in depth. Returns null if no match within `maxDepth` levels.
 */
function findRepoFormatsDir(start: string, maxDepth = 8): string | null {
  let cur = start
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(cur, 'electron', 'server', 'formats')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

function resolveBuiltinFormatsDir(): string {
  if (isPackagedApp() && process.resourcesPath) {
    return path.join(process.resourcesPath, 'formats')
  }
  // Dev / tests / Electron-running-dist: walk up to find the source dir.
  // From source (electron/server/services) it's 3 ups; from compiled
  // (electron/dist/server/services) it's 4 ups; the search handles both.
  const found = findRepoFormatsDir(__dirname)
  if (found) return found
  // Fallback to the 3-ups guess so the loader still has *some* path to
  // attempt (will produce a clearer "not found" error than throwing here).
  const ROOT = path.resolve(__dirname, '..', '..', '..')
  return path.join(ROOT, 'electron', 'server', 'formats')
}

export const BUILTIN_FORMATS_DIR = resolveBuiltinFormatsDir()

/** User-custom formats live next to projects so they travel with the user. */
function userFormatsDir(): string {
  return path.join(pm.PROJECTS_ROOT, '.formats')
}

// ── Cache ──────────────────────────────────────────────────────────────────
//
// Built-in: load-once-and-keep. They're shipped with the bundle; mtime never
// changes during a process lifetime.
// User-custom: keyed by (path, mtimeMs) so editing the JSON directly works
// without restart.

const builtinCache = new Map<string, Format>()
const userCache = new Map<string, { mtimeMs: number; format: Format }>()

/**
 * Read + validate one format JSON file. Throws on parse error or missing
 * required fields so callers can decide whether to log + fall back vs. fail.
 */
async function loadFormatFile(filePath: string): Promise<Format> {
  const raw = await fs.readFile(filePath, 'utf-8')
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch (e: any) {
    throw new Error(`Format JSON parse failed at ${filePath}: ${e.message}`)
  }
  validateFormatShape(parsed, filePath)
  return parsed as Format
}

function validateFormatShape(f: any, filePath: string): void {
  // Lightweight shape check — enough to avoid runtime explosions if the
  // user hand-edits a format. Per-field validation (e.g. narrator-style id
  // uniqueness) lives in the override editor; loader only enforces the
  // structural invariants the prompt assembly depends on.
  const missing: string[] = []
  if (typeof f?.id !== 'string') missing.push('id')
  if (typeof f?.name !== 'string') missing.push('name')
  if (f?.schemaVersion !== 1) missing.push('schemaVersion (must be 1)')
  if (!f?.idea?.systemPromptRole) missing.push('idea.systemPromptRole')
  if (!f?.script?.systemPromptRole) missing.push('script.systemPromptRole')
  if (!Array.isArray(f?.script?.narratorStyles) || !f.script.narratorStyles.length) {
    missing.push('script.narratorStyles (non-empty array)')
  }
  if (!f?.imagePrompts?.purposeNote) missing.push('imagePrompts.purposeNote')
  if (!f?.metadata?.purposeNote) missing.push('metadata.purposeNote')
  if (missing.length) {
    throw new Error(`Format at ${filePath} is missing required fields: ${missing.join(', ')}`)
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Load a format by id. Tries the user library first (so custom formats can
 * shadow built-ins by reusing an id), falls back to the built-in library.
 * Returns null if not found.
 */
export async function loadFormat(id: string): Promise<Format | null> {
  // User-custom first (shadows built-ins).
  const userPath = path.join(userFormatsDir(), `${id}.json`)
  if (existsSync(userPath)) {
    const st = await fs.stat(userPath)
    const cached = userCache.get(userPath)
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.format
    const fmt = await loadFormatFile(userPath)
    userCache.set(userPath, { mtimeMs: st.mtimeMs, format: fmt })
    return fmt
  }

  // Built-in (cached forever).
  if (builtinCache.has(id)) return builtinCache.get(id)!
  const builtinPath = path.join(BUILTIN_FORMATS_DIR, `${id}.json`)
  if (!existsSync(builtinPath)) return null
  const fmt = await loadFormatFile(builtinPath)
  builtinCache.set(id, fmt)
  return fmt
}

/**
 * List every available format (built-in + user-custom). Used by the format
 * picker and the GET /api/formats endpoint. Returns the full Format objects
 * sorted by name for stable display order.
 */
export async function listFormats(): Promise<Format[]> {
  const seen = new Map<string, Format>()

  // User-custom first so they shadow built-ins with the same id.
  const userDir = userFormatsDir()
  if (existsSync(userDir)) {
    let entries: string[] = []
    try { entries = await fs.readdir(userDir) } catch { /* ignore */ }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      try {
        const fmt = await loadFormatFile(path.join(userDir, name))
        seen.set(fmt.id, fmt)
      } catch (e: any) {
        console.warn(`[format-loader] skipping malformed user format ${name}: ${e.message}`)
      }
    }
  }

  // Built-ins fill in gaps.
  if (existsSync(BUILTIN_FORMATS_DIR)) {
    let entries: string[] = []
    try { entries = await fs.readdir(BUILTIN_FORMATS_DIR) } catch { /* ignore */ }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      try {
        const fmt = await loadFormatFile(path.join(BUILTIN_FORMATS_DIR, name))
        if (!seen.has(fmt.id)) seen.set(fmt.id, fmt)
      } catch (e: any) {
        console.warn(`[format-loader] skipping malformed built-in format ${name}: ${e.message}`)
      }
    }
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Deep-merge `overrides` onto `base`. Arrays in overrides REPLACE the base
 * array (not merged element-wise) — narrator-style lists, keyword pools, and
 * pacing arcs are atomic-meaning-units the user intends to swap out wholesale.
 */
export function mergeFormatOverrides(base: Format, overrides?: DeepPartial<Format>): Format {
  if (!overrides) return base
  return deepMerge(base, overrides) as Format
}

function deepMerge(target: any, source: any): any {
  if (source === null || source === undefined) return target
  if (Array.isArray(source)) return source.slice()  // arrays replace
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
 * Resolve the effective format for a project: load `project.format_id`
 * (defaulting to DEFAULT_FORMAT_ID), apply `project.format_overrides`,
 * return the merged result.
 *
 * Errors fall back to the default format with a warning rather than throwing —
 * the script generator must always return a usable format so the user's
 * generation flow never fails because of a missing format file.
 */
export async function getEffectiveFormat(slug: string): Promise<Format> {
  const project = await pm.getProject(slug)
  if (!project) {
    // No project → default format. Loader callers handle the missing-project
    // error themselves; this path supports tests / dry-runs.
    return ensureLoaded(DEFAULT_FORMAT_ID)
  }
  return getEffectiveFormatFor(project)
}

/** Same as getEffectiveFormat() but takes the ProjectMeta directly. */
export async function getEffectiveFormatFor(project: ProjectMeta): Promise<Format> {
  const id = project.format_id || DEFAULT_FORMAT_ID
  let base: Format | null = null
  try {
    base = await loadFormat(id)
  } catch (e: any) {
    console.warn(`[format-loader] failed loading format '${id}', falling back to default: ${e.message}`)
  }
  if (!base) {
    if (id !== DEFAULT_FORMAT_ID) {
      console.warn(`[format-loader] format '${id}' not found, falling back to '${DEFAULT_FORMAT_ID}'`)
    }
    base = await ensureLoaded(DEFAULT_FORMAT_ID)
  }
  // Apply the brand's format_overrides BEFORE the project's, so project
  // overrides win on conflict. The brand layer is where channel-wide
  // format tweaks live (narrator-style preference, broad keywords);
  // project-level overrides remain the per-project escape hatch.
  if (project.brand_id) {
    try {
      const brandLoader = await import('./brand-loader.js')
      const brand = await brandLoader.loadBrand(project.brand_id)
      if (brand?.format_overrides) {
        base = mergeFormatOverrides(base, brand.format_overrides)
      }
    } catch (e: any) {
      console.warn(`[format-loader] failed applying brand '${project.brand_id}' overrides: ${e.message}`)
    }
  }
  base = mergeFormatOverrides(base, project.format_overrides)
  // Niche layer (subject-domain context). Applied LAST so niche-merged
  // fields win over format defaults but lose to explicit project format_-
  // overrides. Niche layering only touches generator-relevant fields
  // (idea vocab, image-prompt style, metadata tags, script context) —
  // narrator pools, pacing arcs, and chapter counts stay format-owned.
  if (project.niche_id) {
    try {
      const nicheLoader = await import('./niche-loader.js')
      const niche = await nicheLoader.getEffectiveNicheFor(project)
      if (niche) {
        base = applyNicheToFormat(base, niche)
      }
    } catch (e: any) {
      console.warn(`[format-loader] failed applying niche '${project.niche_id}' for project '${project.slug}': ${e.message}`)
    }
  }
  return base
}

// ── Niche-onto-format layering ─────────────────────────────────────────────
//
// Mutates none of the input Format/Niche objects — returns a new Format with
// niche vocabulary, style sheet, and metadata hints merged in. Designed so
// every existing call site of getEffectiveFormat() automatically benefits
// from niche context without per-generator integration.

import type { Niche } from '../models/types.js'

function uniqueAppend(a: string[] | undefined, b: string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const arr of [a, b]) {
    if (!arr) continue
    for (const v of arr) {
      if (!v) continue
      const k = v.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      out.push(v)
    }
  }
  return out
}

export function applyNicheToFormat(format: Format, niche: Niche): Format {
  // Build new sub-objects rather than mutating the input — Format objects
  // can be cached by loadFormat() across requests; mutating would leak
  // niche state into later format-only consumers.
  const idea = {
    ...format.idea,
    moodVocabulary: uniqueAppend(format.idea.moodVocabulary, niche.vocabulary?.mood),
    themeVocabulary: uniqueAppend(format.idea.themeVocabulary, niche.vocabulary?.theme),
    genreVocabulary: uniqueAppend(format.idea.genreVocabulary, niche.vocabulary?.genre),
    keywordVocabulary: uniqueAppend(format.idea.keywordVocabulary, niche.vocabulary?.keyword),
    audienceDefault: niche.audienceHint
      ? `${format.idea.audienceDefault} — ${niche.audienceHint}`
      : format.idea.audienceDefault,
  }

  // Script layer — only the system-prompt-role gets niche-augmented. The
  // pacing arc, narrator styles, rules, and chapter counts stay format-
  // pure so niche doesn't accidentally change format-defining behaviors.
  const script = niche.scriptContext
    ? {
        ...format.script,
        systemPromptRole: `${format.script.systemPromptRole}\n\nSubject-domain context: ${niche.scriptContext}`,
      }
    : format.script

  // Image-prompt layer — append visualStyleSheet to defaultStyleTag (the
  // string the LLM sees baked into every prompt). visualStyleHint is the
  // human-facing one-liner shown in the UI; we leave it alone so the
  // picker preview stays readable.
  const stylePieces: string[] = []
  if (format.imagePrompts.defaultStyleTag) stylePieces.push(format.imagePrompts.defaultStyleTag)
  if (niche.visualStyleSheet) stylePieces.push(`Niche style: ${niche.visualStyleSheet}`)
  if (niche.defaultStyleKeywords?.length) {
    stylePieces.push(`Niche keywords: ${niche.defaultStyleKeywords.join(', ')}`)
  }
  const imagePrompts = {
    ...format.imagePrompts,
    defaultStyleTag: stylePieces.join('\n\n'),
  }

  // Metadata layer — niche tags merged into broadKeywords pool.
  const metadata = {
    ...format.metadata,
    broadKeywords: uniqueAppend(format.metadata.broadKeywords, niche.youtubeTagsHint),
  }

  return {
    ...format,
    idea,
    script,
    imagePrompts,
    metadata,
  }
}

/** Loads a format that MUST exist; throws clearly if not (used for the default). */
async function ensureLoaded(id: string): Promise<Format> {
  const fmt = await loadFormat(id)
  if (!fmt) {
    throw new Error(
      `Built-in format '${id}' could not be loaded from ${BUILTIN_FORMATS_DIR}. ` +
      `This indicates a bundling problem — the formats/ directory may not have ` +
      `shipped with the build.`,
    )
  }
  return fmt
}

/**
 * Substitute `{lastButOne}` and `{last}` placeholders in pacing-arc lines
 * with the actual chapter numbers. Used by the script prompt assembler.
 */
export function fillPacingArcPlaceholders(arc: string[], chapterCount: number): string[] {
  const last = chapterCount
  const lastButOne = chapterCount - 1
  return arc.map(line => line.replace(/\{lastButOne\}/g, String(lastButOne)).replace(/\{last\}/g, String(last)))
}

/** Test-only — wipe caches so freshly-written format files take effect. */
export function _clearFormatCaches(): void {
  builtinCache.clear()
  userCache.clear()
}
