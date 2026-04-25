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

function resolveBuiltinPatternsDir(): string {
  if (isPackagedApp() && process.resourcesPath) {
    return path.join(process.resourcesPath, 'patterns')
  }
  const ROOT = path.resolve(__dirname, '..', '..', '..')
  return path.join(ROOT, 'electron', 'server', 'patterns')
}

export const BUILTIN_PATTERNS_DIR = resolveBuiltinPatternsDir()

function userPatternsDir(): string {
  return path.join(pm.PROJECTS_ROOT, '.patterns')
}

const builtinCache = new Map<string, Pattern>()
const userCache = new Map<string, { mtimeMs: number; pattern: Pattern }>()

function validatePatternShape(p: any, filePath: string): void {
  const missing: string[] = []
  if (typeof p?.id !== 'string') missing.push('id')
  if (typeof p?.name !== 'string') missing.push('name')
  if (p?.schemaVersion !== 1) missing.push('schemaVersion (must be 1)')
  if (typeof p?.titleTemplate !== 'string' || !p.titleTemplate.includes('{X}')) {
    missing.push("titleTemplate (must include '{X}' placeholder)")
  }
  if (typeof p?.subjectLabel !== 'string') missing.push('subjectLabel')
  if (!['first', 'second', 'third', 'mixed'].includes(p?.pov)) missing.push("pov ('first'|'second'|'third'|'mixed')")
  if (typeof p?.openingDevice !== 'string') missing.push('openingDevice')
  if (typeof p?.closingDevice !== 'string') missing.push('closingDevice')
  if (missing.length) {
    throw new Error(`Pattern at ${filePath} is missing required fields: ${missing.join(', ')}`)
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
