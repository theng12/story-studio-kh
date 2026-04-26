/**
 * Pattern loader — reads built-in + user-custom Pattern profiles.
 *
 * Pattern is the EPISODE-shape primitive (see plans/format-and-character-system.md
 * Phase 4b). Layout mirrors format-loader.ts:
 *   - Built-in: ${BUILTIN_PATTERNS_DIR}/{id}.json (extraResources entry copies
 *     electron/server/patterns → resourcesPath/patterns in packaged app).
 *   - User-custom: ${PROJECTS_ROOT}/.patterns/{id}.json — exportable as
 *     single JSON files.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import * as pm from './project-manager.js'
import type { Pattern } from '../models/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

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
 * Walk up from `start` until a directory contains `electron/server/patterns`.
 * See format-loader.ts findRepoFormatsDir for the full rationale — same fix.
 */
function findRepoPatternsDir(start: string, maxDepth = 8): string | null {
  let cur = start
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(cur, 'electron', 'server', 'patterns')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

function resolveBuiltinPatternsDir(): string {
  if (isPackagedApp() && process.resourcesPath) {
    return path.join(process.resourcesPath, 'patterns')
  }
  const found = findRepoPatternsDir(__dirname)
  if (found) return found
  const ROOT = path.resolve(__dirname, '..', '..', '..')
  return path.join(ROOT, 'electron', 'server', 'patterns')
}

export const BUILTIN_PATTERNS_DIR = resolveBuiltinPatternsDir()

function userPatternsDir(): string {
  return path.join(pm.PROJECTS_ROOT, '.patterns')
}

const builtinCache = new Map<string, Pattern>()
const userCache = new Map<string, { mtimeMs: number; pattern: Pattern }>()

/**
 * Validate a Pattern object for shape correctness. Throws with a list
 * of missing/invalid fields. Used both at load time (catches malformed
 * built-ins or hand-edited user files) AND at save time (catches bad
 * input from the editor modal or LLM extraction).
 *
 * Exported separately from `validatePatternShape` (which throws) so
 * callers that want a soft check (the route layer building a 400) can
 * use this without a try/catch.
 */
export function checkPatternShape(p: any): { ok: true } | { ok: false; missing: string[] } {
  const missing: string[] = []
  if (typeof p?.id !== 'string' || !p.id.trim()) missing.push('id')
  else if (!/^[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]$|^[A-Za-z0-9]$/.test(p.id)) {
    // Allow uppercase letters because built-in pattern ids use the
    // convention `fall-asleep-to-X` / `day-in-the-life-X` where the
    // uppercase X mirrors the {X} placeholder in the title template.
    // Strict lowercase kebab-case would reject every shipped built-in.
    missing.push('id (must be a slug — letters, digits, hyphens; no leading/trailing hyphen)')
  }
  if (typeof p?.name !== 'string' || !p.name.trim()) missing.push('name')
  if (p?.schemaVersion !== 1) missing.push('schemaVersion (must be 1)')
  if (typeof p?.titleTemplate !== 'string' || !p.titleTemplate.includes('{X}')) {
    missing.push("titleTemplate (must include '{X}' placeholder)")
  }
  if (typeof p?.subjectLabel !== 'string') missing.push('subjectLabel')
  if (!['first', 'second', 'third', 'mixed'].includes(p?.pov)) missing.push("pov ('first'|'second'|'third'|'mixed')")
  if (typeof p?.openingDevice !== 'string') missing.push('openingDevice')
  if (typeof p?.closingDevice !== 'string') missing.push('closingDevice')
  // Optional fields that, when present, must be the right shape.
  if (p?.bodyStructure !== undefined) {
    if (!Array.isArray(p.bodyStructure) || !p.bodyStructure.every((x: any) => typeof x === 'string')) {
      missing.push('bodyStructure (when present, must be an array of strings)')
    }
  }
  if (p?.preferredFormats !== undefined) {
    if (!Array.isArray(p.preferredFormats) || !p.preferredFormats.every((x: any) => typeof x === 'string')) {
      missing.push('preferredFormats (when present, must be an array of format-id strings)')
    }
  }
  if (p?.suggestedLengthMinutes !== undefined) {
    const v = p.suggestedLengthMinutes
    if (!Array.isArray(v) || v.length !== 2 || !v.every((x: any) => typeof x === 'number' && x > 0)) {
      missing.push('suggestedLengthMinutes (when present, must be [minNumber, maxNumber])')
    }
  }
  if (p?.metadataKeywordAdditions !== undefined) {
    if (!Array.isArray(p.metadataKeywordAdditions) || !p.metadataKeywordAdditions.every((x: any) => typeof x === 'string')) {
      missing.push('metadataKeywordAdditions (when present, must be an array of strings)')
    }
  }
  return missing.length ? { ok: false, missing } : { ok: true }
}

function validatePatternShape(p: any, filePath: string): void {
  const r = checkPatternShape(p)
  if (!r.ok) {
    throw new Error(`Pattern at ${filePath} is missing required fields: ${r.missing.join(', ')}`)
  }
}

async function loadPatternFile(filePath: string): Promise<Pattern> {
  const raw = await fs.readFile(filePath, 'utf-8')
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch (e: any) {
    throw new Error(`Pattern JSON parse failed at ${filePath}: ${e.message}`)
  }
  validatePatternShape(parsed, filePath)
  return parsed as Pattern
}

export async function loadPattern(id: string): Promise<Pattern | null> {
  const userPath = path.join(userPatternsDir(), `${id}.json`)
  if (existsSync(userPath)) {
    const st = await fs.stat(userPath)
    const cached = userCache.get(userPath)
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.pattern
    const p = await loadPatternFile(userPath)
    userCache.set(userPath, { mtimeMs: st.mtimeMs, pattern: p })
    return p
  }

  if (builtinCache.has(id)) return builtinCache.get(id)!
  const builtinPath = path.join(BUILTIN_PATTERNS_DIR, `${id}.json`)
  if (!existsSync(builtinPath)) return null
  const p = await loadPatternFile(builtinPath)
  builtinCache.set(id, p)
  return p
}

export async function listPatterns(): Promise<Pattern[]> {
  const seen = new Map<string, Pattern>()

  const userDir = userPatternsDir()
  if (existsSync(userDir)) {
    let entries: string[] = []
    try { entries = await fs.readdir(userDir) } catch { /* ignore */ }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      try {
        const p = await loadPatternFile(path.join(userDir, name))
        seen.set(p.id, p)
      } catch (e: any) {
        console.warn(`[pattern-loader] skipping malformed user pattern ${name}: ${e.message}`)
      }
    }
  }

  if (existsSync(BUILTIN_PATTERNS_DIR)) {
    let entries: string[] = []
    try { entries = await fs.readdir(BUILTIN_PATTERNS_DIR) } catch { /* ignore */ }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      try {
        const p = await loadPatternFile(path.join(BUILTIN_PATTERNS_DIR, name))
        if (!seen.has(p.id)) seen.set(p.id, p)
      } catch (e: any) {
        console.warn(`[pattern-loader] skipping malformed built-in pattern ${name}: ${e.message}`)
      }
    }
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Substitute the user-provided `{X}` subject (and chapter-number placeholders)
 * inside a pattern's title + body shape. Returns the strings the prompt
 * assembler should inject into the script prompt.
 */
export function applyPatternSubject(
  pattern: Pattern,
  subject: string,
  chapterCount: number,
): {
  resolvedTitle: string
  resolvedOpeningDevice: string
  resolvedBodyStructure: string[] | null
  resolvedClosingDevice: string
} {
  const safe = subject.trim() || pattern.subjectLabel
  const sub = (s: string) => s
    .replace(/\{X\}/g, safe)
    .replace(/\{lastButOne\}/g, String(chapterCount - 1))
    .replace(/\{last\}/g, String(chapterCount))

  return {
    resolvedTitle: sub(pattern.titleTemplate),
    resolvedOpeningDevice: sub(pattern.openingDevice),
    resolvedBodyStructure: pattern.bodyStructure ? pattern.bodyStructure.map(sub) : null,
    resolvedClosingDevice: sub(pattern.closingDevice),
  }
}

export function _clearPatternCaches(): void {
  builtinCache.clear()
  userCache.clear()
}

// ── User-custom pattern CRUD ───────────────────────────────────────────────
//
// Built-in patterns ship in the bundle and are immutable. User customs
// live at ${PROJECTS_ROOT}/.patterns/{id}.json — same directory layout
// formats use. saveUserPattern + deleteUserPattern operate ONLY on user
// customs; built-in IDs are reserved (a custom CAN shadow a built-in
// since loadPattern() prefers the user dir, but you have to opt in via
// `allowShadowBuiltin: true` so it's not accidental).

export interface SavePatternOptions {
  /** When false (default), refuses to overwrite an existing user-custom file with the same id. */
  overwrite?: boolean
  /** When true, allows the custom pattern's id to match a built-in (shadowing the built-in on read). */
  allowShadowBuiltin?: boolean
}

/**
 * Persist a user-custom pattern to disk. Validates shape, normalises a
 * couple of fields, and writes atomically. The cache is invalidated so
 * the next listPatterns() / loadPattern() call sees the new file.
 *
 * Returns the pattern as written (with `builtin: false` and
 * `schemaVersion: 1` enforced).
 */
export async function saveUserPattern(input: any, opts: SavePatternOptions = {}): Promise<Pattern> {
  // Force the two invariants the loader expects, then validate the
  // result. Saves the user from forgetting to set them in the editor
  // (and protects against an LLM-extracted pattern that omitted them).
  const candidate: any = {
    ...input,
    builtin: false,
    schemaVersion: 1,
  }

  const check = checkPatternShape(candidate)
  if (!check.ok) {
    throw new Error(`Cannot save pattern: ${check.missing.join(', ')}`)
  }

  // Built-in collision check. We allow shadowing only when the caller
  // explicitly opts in — most UI flows pass `allowShadowBuiltin: false`.
  if (!opts.allowShadowBuiltin) {
    const builtinPath = path.join(BUILTIN_PATTERNS_DIR, `${candidate.id}.json`)
    if (existsSync(builtinPath)) {
      throw new Error(`Pattern id "${candidate.id}" matches a built-in; pick a different id or opt in via allowShadowBuiltin.`)
    }
  }

  const userDir = userPatternsDir()
  const filePath = path.join(userDir, `${candidate.id}.json`)

  if (existsSync(filePath) && !opts.overwrite) {
    throw new Error(`Pattern "${candidate.id}" already exists. Pass overwrite:true to replace.`)
  }

  await fs.mkdir(userDir, { recursive: true })
  // Atomic write: tmp file then rename. Avoids a half-written JSON file
  // on a crash between open() and close().
  const tmpPath = `${filePath}.tmp`
  await fs.writeFile(tmpPath, JSON.stringify(candidate, null, 2) + '\n')
  await fs.rename(tmpPath, filePath)

  _clearPatternCaches()
  return candidate as Pattern
}

/**
 * Delete a user-custom pattern. Refuses to act on built-ins (the file
 * isn't in the user dir, so deletion would silently fail anyway — we
 * surface this as a clear error so the route can return 400). Returns
 * the deleted file path on success, throws on missing/built-in.
 */
export async function deleteUserPattern(id: string): Promise<{ deletedPath: string }> {
  const userPath = path.join(userPatternsDir(), `${id}.json`)
  if (!existsSync(userPath)) {
    // Distinguish "doesn't exist anywhere" from "is a built-in" so the
    // route can return the right HTTP status.
    const builtinPath = path.join(BUILTIN_PATTERNS_DIR, `${id}.json`)
    if (existsSync(builtinPath)) {
      throw new Error(`Pattern "${id}" is built-in and cannot be deleted.`)
    }
    throw new Error(`Pattern "${id}" not found.`)
  }
  await fs.rm(userPath, { force: true })
  _clearPatternCaches()
  return { deletedPath: userPath }
}

/**
 * True when the supplied id refers to a built-in. Used by the editor
 * UI to disable the Edit/Delete actions on built-ins (the user can
 * still copy-as-new to make their own variant).
 */
export function isBuiltinPatternId(id: string): boolean {
  return existsSync(path.join(BUILTIN_PATTERNS_DIR, `${id}.json`))
}
