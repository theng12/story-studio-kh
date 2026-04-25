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

function resolveBuiltinFormatsDir(): string {
  if (isPackagedApp() && process.resourcesPath) {
    return path.join(process.resourcesPath, 'formats')
  }
  // Dev / tests: source-tree path. ROOT = repo root (3 up from services/).
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
  return mergeFormatOverrides(base, project.format_overrides)
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
