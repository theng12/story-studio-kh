/**
 * Changelog endpoint — reads CHANGELOG.md and returns it parsed into
 * per-version entries the SPA's "What's New" modal can render.
 *
 * The file lives at the repo root in dev (./CHANGELOG.md) and ships with
 * the packaged app under `process.resourcesPath/CHANGELOG.md` (wired into
 * electron-builder.json's extraResources).
 *
 * Format expected — markdown sections of the form:
 *
 *   ## v1.0.77 — 2026-05-09
 *
 *   - Bullet describing change
 *   - Another bullet
 *
 *   ## v1.0.76 — 2026-05-09
 *
 *   - …
 *
 * Entries are returned in document order (newest first by convention).
 * The endpoint is read-only and has no side effects.
 */

import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()
export const MAX_WHATS_NEW_ENTRIES = 20
export const MAX_WHATS_NEW_REQUEST_LIMIT = 500
export const MAX_WHATS_NEW_REQUEST_OFFSET = 50_000

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Resolve the CHANGELOG.md path. Try (in order):
 *   1. process.resourcesPath/CHANGELOG.md  — packaged Electron app
 *   2. <repo-root>/CHANGELOG.md            — dev (tsx) + npm run dev
 *
 * Returns null if neither exists; the route then returns an empty list.
 */
async function resolveChangelogPath(): Promise<string | null> {
  const candidates: string[] = []
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'CHANGELOG.md'))
  }
  // From electron/server/routes/changelog.ts → up 4 levels to repo root
  candidates.push(path.resolve(__dirname, '..', '..', '..', '..', 'CHANGELOG.md'))
  // Fallback: 3 levels up (compiled location may differ).
  candidates.push(path.resolve(__dirname, '..', '..', '..', 'CHANGELOG.md'))
  for (const p of candidates) {
    try {
      const stat = await fs.stat(p)
      if (stat.isFile()) return p
    } catch { /* try next */ }
  }
  return null
}

interface ChangelogEntry {
  version: string
  date: string | null
  body_markdown: string
}

export function parseChangelog(
  raw: string,
  limit = MAX_WHATS_NEW_ENTRIES,
): ChangelogEntry[] {
  const boundedLimit = Math.max(0, Math.floor(limit))
  if (boundedLimit === 0) return []

  // Split on `## ` lines that look like version headers. Match v1.0.77,
  // 1.0.77, etc. Date is the trailing token after a `—` or `-`.
  const lines = raw.split(/\r?\n/)
  const entries: ChangelogEntry[] = []
  let current: ChangelogEntry | null = null
  const headerRe = /^##\s+v?(\d+\.\d+(?:\.\d+)?)\b\s*(?:[—\-:]\s*([\d-]+))?\s*$/
  for (const line of lines) {
    const m = line.match(headerRe)
    if (m) {
      if (current) {
        current.body_markdown = current.body_markdown.trimEnd()
        entries.push(current)
        if (entries.length >= boundedLimit) break
      }
      current = { version: m[1], date: m[2] || null, body_markdown: '' }
      continue
    }
    if (current) {
      // Trim leading blank line so each body starts cleanly.
      if (current.body_markdown === '' && line.trim() === '') continue
      current.body_markdown += line + '\n'
    }
  }
  if (current && entries.length < boundedLimit) {
    current.body_markdown = current.body_markdown.trimEnd()
    entries.push(current)
  }
  return entries
}

router.get('/changelog', async (req, res) => {
  try {
    const p = await resolveChangelogPath()
    if (!p) {
      return res.json({ entries: [], has_more: false, source: null, hint: 'CHANGELOG.md not found.' })
    }
    const raw = await fs.readFile(p, 'utf-8')
    const requested = Number.parseInt(String(req.query.limit || ''), 10)
    const limit = Number.isFinite(requested)
      ? Math.max(1, Math.min(MAX_WHATS_NEW_REQUEST_LIMIT, requested))
      : MAX_WHATS_NEW_ENTRIES
    const requestedOffset = Number.parseInt(String(req.query.offset || ''), 10)
    const offset = Number.isFinite(requestedOffset)
      ? Math.max(0, Math.min(MAX_WHATS_NEW_REQUEST_OFFSET, requestedOffset))
      : 0
    // Read one extra entry so the client can offer another explicit page.
    // This avoids silently truncating the changelog as it grows over time.
    const allEntries = parseChangelog(raw, offset + limit + 1)
    const entries = allEntries.slice(offset, offset + limit)
    res.json({
      entries,
      has_more: allEntries.length > offset + entries.length,
      next_offset: offset + entries.length,
      source: p,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read changelog'))
  }
})
