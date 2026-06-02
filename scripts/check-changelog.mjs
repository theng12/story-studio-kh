#!/usr/bin/env node
/**
 * check-changelog.mjs — release guard. Fails fast when package.json's
 * version has no matching `## vX.Y.Z` header in CHANGELOG.md.
 *
 * Why this exists:
 *   The "What's New" modal compares the runtime `appVersion` (baked from
 *   package.json at build time) against `last_seen_version` persisted in
 *   app-settings. When they differ, the modal pops on launch and renders
 *   the changelog as the body. But if the version was bumped without a
 *   matching CHANGELOG entry, the modal still pops, still shows the SAME
 *   stale top entry, and the user reads it as "What's New is broken."
 *
 *   See: v1.0.115 + v1.0.116 shipped without entries; the modal looked
 *   identical to v1.0.114 to the user.
 *
 * Wired into:
 *   - `npm run build` (frontend + electron build)
 *   - `npm run dist`  (electron-builder packaging)
 *
 * Bypass for true emergencies: set STORY_STUDIO_SKIP_CHANGELOG_CHECK=1.
 * Don't make that a habit — the whole point is to keep the modal honest.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

if (process.env.STORY_STUDIO_SKIP_CHANGELOG_CHECK === '1') {
  console.warn('[check-changelog] STORY_STUDIO_SKIP_CHANGELOG_CHECK=1 — skipping guard.')
  process.exit(0)
}

const pkgPath = resolve(ROOT, 'package.json')
const changelogPath = resolve(ROOT, 'CHANGELOG.md')

let pkg
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
} catch (e) {
  console.error(`[check-changelog] could not read ${pkgPath}: ${e.message}`)
  process.exit(2)
}

const version = String(pkg.version || '').trim()
if (!version) {
  console.error('[check-changelog] package.json has no "version" field.')
  process.exit(2)
}

let raw
try {
  raw = readFileSync(changelogPath, 'utf-8')
} catch (e) {
  console.error(`[check-changelog] could not read ${changelogPath}: ${e.message}`)
  process.exit(2)
}

// Match the same header shape that routes/changelog.ts parses.
// Accept `## v1.0.116 — 2026-05-21`, `## v1.0.116`, `## 1.0.116`, etc.
const headerRe = /^##\s+v?(\d+\.\d+(?:\.\d+)?)\b/gm
const found = new Set()
for (const m of raw.matchAll(headerRe)) found.add(m[1])

if (!found.has(version)) {
  console.error('')
  console.error(`  ✖ CHANGELOG.md has no entry for v${version}.`)
  console.error('')
  console.error(`    package.json: "version": "${version}"`)
  console.error(`    CHANGELOG.md: latest entries → ${[...found].slice(0, 5).join(', ') || '(none)'}`)
  console.error('')
  console.error('  Add a `## v' + version + ' — YYYY-MM-DD` section at the top of CHANGELOG.md')
  console.error('  before building. The "What\'s New" modal renders these on upgrade — shipping')
  console.error('  without one shows users a stale top entry that doesn\'t match their version.')
  console.error('')
  console.error('  Emergency bypass (not for normal use):')
  console.error('    STORY_STUDIO_SKIP_CHANGELOG_CHECK=1 npm run build')
  console.error('')
  process.exit(1)
}

console.log(`[check-changelog] ok — v${version} has a CHANGELOG entry.`)
