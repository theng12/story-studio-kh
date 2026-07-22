#!/usr/bin/env node
/**
 * check-changelog.mjs — release guard for every version surface used by
 * packaging and the in-app What's New experience.
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
import { compareVersions, parseChangelog } from './release/release-utils.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

if (process.env.STORY_STUDIO_SKIP_CHANGELOG_CHECK === '1') {
  console.warn('[check-changelog] STORY_STUDIO_SKIP_CHANGELOG_CHECK=1 — skipping guard.')
  process.exit(0)
}

const pkgPath = resolve(ROOT, 'package.json')
const lockPath = resolve(ROOT, 'package-lock.json')
const changelogPath = resolve(ROOT, 'CHANGELOG.md')

let pkg
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
} catch (e) {
  console.error(`[check-changelog] could not read ${pkgPath}: ${e.message}`)
  process.exit(2)
}

const version = String(pkg.version || '').trim()
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`[check-changelog] package.json has an invalid release version: ${version || '(missing)'}`)
  process.exit(2)
}

let lock
try {
  lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
} catch (e) {
  console.error(`[check-changelog] could not read ${lockPath}: ${e.message}`)
  process.exit(2)
}

const lockVersions = [String(lock.version || ''), String(lock.packages?.['']?.version || '')]
if (lockVersions.some((candidate) => candidate !== version)) {
  console.error('[check-changelog] package version surfaces disagree:')
  console.error(`  package.json:              ${version}`)
  console.error(`  package-lock.json:         ${lockVersions[0] || '(missing)'}`)
  console.error(`  package-lock packages[""]: ${lockVersions[1] || '(missing)'}`)
  process.exit(1)
}

let raw
try {
  raw = readFileSync(changelogPath, 'utf-8')
} catch (e) {
  console.error(`[check-changelog] could not read ${changelogPath}: ${e.message}`)
  process.exit(2)
}

const entries = parseChangelog(raw)
const found = entries.map((entry) => entry.version)
if (!found.includes(version)) {
  console.error('')
  console.error(`  ✖ CHANGELOG.md has no entry for v${version}.`)
  console.error('')
  console.error(`    package.json: "version": "${version}"`)
  console.error(`    CHANGELOG.md: latest entries → ${found.slice(0, 5).join(', ') || '(none)'}`)
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

if (entries[0]?.version !== version) {
  console.error(`[check-changelog] newest CHANGELOG entry is v${entries[0]?.version || '(none)'}, expected v${version}.`)
  process.exit(1)
}

if (!entries[0].body.trim()) {
  console.error(`[check-changelog] v${version} has no What's New details.`)
  process.exit(1)
}

const duplicates = found.filter((candidate, index) => found.indexOf(candidate) !== index)
if (duplicates.length) {
  console.error(`[check-changelog] duplicate version headers: ${[...new Set(duplicates)].join(', ')}`)
  process.exit(1)
}

for (let index = 1; index < entries.length; index += 1) {
  if (compareVersions(entries[index - 1].version, entries[index].version) < 0) {
    console.error(
      `[check-changelog] entries are not newest-first: v${entries[index - 1].version} precedes v${entries[index].version}.`,
    )
    process.exit(1)
  }
}

console.log(`[check-changelog] ok — package, lockfile, and newest What's New entry agree on v${version}.`)
