#!/usr/bin/env node
/**
 * cleanup-nested-episodes-dirs.mjs
 *
 * One-shot scanner + cleaner for the doubly-nested `episodes/episodes/` and
 * duplicate `Season NNN/EP*` directories created by the pre-v1.0.326
 * "episodes alias" mkdir bug (see CHANGELOG v1.0.326).
 *
 * What it does
 * ────────────
 * 1.  Reads the Story Studio app settings to find every registered project's
 *     project directory (linked external folders included). For each project
 *     dir whose basename is `episodes`, looks at `episodes/episodes/` and
 *     flags it if it's empty (only `.DS_Store` / `._*` macOS junk).
 *
 * 2.  Walks each registered project for a "duplicated season tree" — the
 *     MineePod-shape problem where the same `Season NNN/EP*` content lives
 *     both at the OUTER project root and inside an INNER `episodes/`
 *     subdirectory. For each duplicated episode, compares the directory
 *     trees (file count + total bytes) so you can see which side has the
 *     real / fuller version before deciding what to delete.
 *
 * 3.  Prints a plan. With `--apply`, deletes the EMPTY `episodes/episodes/`
 *     directories (zero data loss). The duplicate-season cleanup is
 *     **never** applied automatically — you eyeball the report and run a
 *     plain `rm -rf` on the side you decide to drop.
 *
 * Safety
 * ──────
 * • Default mode is dry-run. Nothing on disk changes without `--apply`.
 * • Even with `--apply` we only delete directories we've verified are empty
 *   (ignoring `.DS_Store` / `._*`). We never touch a directory with real
 *   content, and we never delete based on the duplicate-season comparison
 *   — that report is informational only.
 * • Reads `.story-studio-project.json` to confirm a directory is actually
 *   a Story Studio project before touching it.
 *
 * Usage
 * ─────
 *   node tools/cleanup-nested-episodes-dirs.mjs            # dry-run
 *   node tools/cleanup-nested-episodes-dirs.mjs --apply    # actually delete empty vestiges
 *
 * Exit codes
 * ──────────
 *   0  no bogus dirs found, or dry-run completed with findings
 *   1  invalid arguments / cannot read app settings
 */

import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { existsSync } from 'fs'

const APPLY = process.argv.includes('--apply')

/** v1.0.326 — `--trash <dir>` makes the script MOVE candidates into that dir
 *  instead of deleting. Preserves relative paths so you can see where each
 *  piece came from. With --trash set, Pass 2's suggested-to-drop season dirs
 *  ALSO get moved (otherwise Pass 2 stays informational). Without --trash,
 *  --apply only deletes the empty Pass 1 bogus dirs (the old behaviour). */
function readArgValue(name) {
  const idx = process.argv.indexOf(name)
  if (idx === -1) return null
  const v = process.argv[idx + 1]
  return (typeof v === 'string' && v.trim() && !v.startsWith('-')) ? v.trim() : null
}
const TRASH_DIR = readArgValue('--trash')

/** Story Studio's per-user app settings directory on macOS. */
const APP_SUPPORT = path.join(os.homedir(), 'Library/Application Support/Story Studio KH')
const DEFAULT_PROJECTS_ROOT = path.join(APP_SUPPORT, 'projects')
const APP_SETTINGS_PATH = path.join(APP_SUPPORT, 'app-settings.json')

/** Resolve the user's actual PROJECTS_ROOT. Honors `projects_root_override` in
 *  app-settings.json (used by users who want projects on Downloads / external
 *  drives instead of the per-user app-support default). */
function resolveProjectsRoot(settings) {
  const override = settings?.projects_root_override
  if (typeof override === 'string' && override.trim() && existsSync(override.trim())) {
    return override.trim()
  }
  return DEFAULT_PROJECTS_ROOT
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** macOS junk we can safely ignore when deciding if a directory is "empty". */
function isJunk(name) {
  return name === '.DS_Store' || name.startsWith('._') || name === '.localized'
}

/** Read a directory; return [] on error so the scanner stays robust. */
async function safeReaddir(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }) }
  catch { return [] }
}

/** Recursive file count + total bytes for a directory. Skips macOS junk. */
async function dirStats(dir) {
  let files = 0
  let bytes = 0
  async function walk(d) {
    const entries = await safeReaddir(d)
    for (const e of entries) {
      if (isJunk(e.name)) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        await walk(p)
      } else if (e.isFile()) {
        files++
        try { const st = await fs.stat(p); bytes += st.size } catch { /* unreadable */ }
      }
    }
  }
  await walk(dir)
  return { files, bytes }
}

/** Is this directory truly empty (after filtering macOS junk)? */
async function isEffectivelyEmpty(dir) {
  const entries = await safeReaddir(dir)
  return entries.every(e => isJunk(e.name))
}

/** Collect every project directory the app knows about: PROJECTS_ROOT children
 *  plus linked external dirs from app-settings.json. */
async function collectProjectDirs() {
  const dirs = new Map()  // slug → projectDir
  // Read app-settings.json once so PROJECTS_ROOT override + linked paths are
  // both resolved from the same source of truth.
  let settings = {}
  if (existsSync(APP_SETTINGS_PATH)) {
    try { settings = JSON.parse(await fs.readFile(APP_SETTINGS_PATH, 'utf-8')) }
    catch { /* tolerate corrupt app-settings.json */ }
  }
  const projectsRoot = resolveProjectsRoot(settings)
  console.log(`projects_root: ${projectsRoot}`)

  // 1) Local project dirs in PROJECTS_ROOT (or the override).
  if (existsSync(projectsRoot)) {
    for (const e of await safeReaddir(projectsRoot)) {
      if (!e.isDirectory()) continue
      const dir = path.join(projectsRoot, e.name)
      // Confirm it's a project (sentinel file present). Use case-insensitive
      // match for the slug key so 'MineePod' on disk maps to 'mineepod' the
      // app uses (macOS HFS+/APFS is case-insensitive by default).
      if (existsSync(path.join(dir, '.story-studio-project.json'))) {
        dirs.set(e.name.toLowerCase(), dir)
      }
    }
  }
  // 2) Linked external project dirs — `linked_project_paths` is an ARRAY of
  //    absolute paths (see services/linked-projects.ts).
  const linkedPaths = settings?.linked_project_paths
  if (Array.isArray(linkedPaths)) {
    for (const p of linkedPaths) {
      if (typeof p !== 'string' || !existsSync(p)) continue
      if (existsSync(path.join(p, '.story-studio-project.json'))) {
        dirs.set(path.basename(p).toLowerCase(), p)
      }
    }
  }
  return dirs
}

// ── Pass 1: bogus `<projectDir>/episodes/` when projectDir is named `episodes` ──

async function scanBogusEpisodesDirs(projectDirs) {
  const findings = []
  for (const [slug, dir] of projectDirs) {
    // CASE A — projectDir is named 'episodes' AND has an `episodes` subdir.
    // This is the shape the v1.0.326 guard prevents going forward.
    if (path.basename(dir).toLowerCase() === 'episodes') {
      const bogus = path.join(dir, 'episodes')
      if (existsSync(bogus)) {
        const empty = await isEffectivelyEmpty(bogus)
        findings.push({ slug, projectDir: dir, bogusDir: bogus, empty, shape: 'A: projectDir-basename-is-episodes' })
      }
    }
    // CASE B — projectDir/episodes/episodes/ exists empty (the historical
    // MineePod shape: standard `<project>/episodes/` was created normally,
    // then a later linked-project path of `<project>/episodes/` re-triggered
    // the alias mkdir, producing the third level). The fix's guard prevents
    // this from happening AGAIN; this case catches existing vestiges.
    const stdEpisodes = path.join(dir, 'episodes')
    if (existsSync(stdEpisodes)) {
      const nested = path.join(stdEpisodes, 'episodes')
      if (existsSync(nested)) {
        const empty = await isEffectivelyEmpty(nested)
        findings.push({ slug, projectDir: dir, bogusDir: nested, empty, shape: 'B: <project>/episodes/episodes/' })
      }
    }
  }
  return findings
}

// ── Pass 2: duplicate Season trees (outer wrapper + inner `episodes/`) ──

async function scanDuplicateSeasons(projectDirs) {
  const findings = []
  for (const [slug, projectDir] of projectDirs) {
    // The outer wrapper case: projectDir has BOTH a `Season NNN/` AND a
    // `episodes/Season NNN/` whose names overlap. That's the MineePod shape.
    const outerEntries = await safeReaddir(projectDir)
    const outerSeasons = outerEntries.filter(e => e.isDirectory() && /^Season\s+\d+$/i.test(e.name)).map(e => e.name)
    if (!outerSeasons.length) continue
    const innerEpisodesDir = path.join(projectDir, 'episodes')
    if (!existsSync(innerEpisodesDir)) continue
    const innerEntries = await safeReaddir(innerEpisodesDir)
    const innerSeasons = innerEntries.filter(e => e.isDirectory() && /^Season\s+\d+$/i.test(e.name)).map(e => e.name)
    const dupeSeasons = outerSeasons.filter(s => innerSeasons.includes(s))
    if (!dupeSeasons.length) continue

    // For each duplicated season, list the overlapping EP directories and
    // compare sizes so the user can pick which side to drop.
    const seasonDetails = []
    for (const season of dupeSeasons) {
      const outerSeasonDir = path.join(projectDir, season)
      const innerSeasonDir = path.join(innerEpisodesDir, season)
      const outerEps = (await safeReaddir(outerSeasonDir)).filter(e => e.isDirectory()).map(e => e.name)
      const innerEps = (await safeReaddir(innerSeasonDir)).filter(e => e.isDirectory()).map(e => e.name)
      const overlap = outerEps.filter(n => innerEps.includes(n))
      const episodeComparisons = []
      for (const epName of overlap) {
        const outerEpDir = path.join(outerSeasonDir, epName)
        const innerEpDir = path.join(innerSeasonDir, epName)
        const [a, b] = await Promise.all([dirStats(outerEpDir), dirStats(innerEpDir)])
        episodeComparisons.push({
          name: epName,
          outer: { files: a.files, bytes: a.bytes },
          inner: { files: b.files, bytes: b.bytes },
          identical: a.files === b.files && a.bytes === b.bytes,
        })
      }
      seasonDetails.push({
        season,
        outerSeasonDir,
        innerSeasonDir,
        outerOnly: outerEps.filter(n => !innerEps.includes(n)),
        innerOnly: innerEps.filter(n => !outerEps.includes(n)),
        episodes: episodeComparisons,
      })
    }
    findings.push({ slug, projectDir, seasons: seasonDetails })
  }
  return findings
}

// ── Reporting + delete ──

function reportBogus(findings) {
  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(' Pass 1 — bogus <project>/episodes/ empty directories')
  console.log('══════════════════════════════════════════════════════════════')
  if (!findings.length) {
    console.log('  ✓ none found.')
    return
  }
  for (const f of findings) {
    const safety = f.empty ? '✓ empty (safe to delete)' : '✗ NOT empty — leaving alone'
    console.log(`  [${f.slug}]`)
    console.log(`    shape:   ${f.shape}`)
    console.log(`    project: ${f.projectDir}`)
    console.log(`    bogus:   ${f.bogusDir}`)
    console.log(`             ${safety}`)
  }
}

async function applyBogusCleanup(findings) {
  if (TRASH_DIR) {
    // Move every bogus dir we found (even non-empty — user picked safe trash).
    if (!findings.length) { console.log('\n  (nothing to trash — no bogus dirs found)'); return }
    console.log(`\n  Moving ${findings.length} bogus director${findings.length === 1 ? 'y' : 'ies'} to trash…`)
    for (const f of findings) {
      await moveToTrash(f.bogusDir, f.projectDir)
    }
    return
  }
  const target = findings.filter(f => f.empty)
  if (!target.length) { console.log('\n  (nothing to delete — no empty bogus dirs; use --trash to move non-empty ones safely)'); return }
  console.log(`\n  Deleting ${target.length} empty bogus director${target.length === 1 ? 'y' : 'ies'}…`)
  for (const f of target) {
    try {
      await fs.rmdir(f.bogusDir)  // rmdir refuses if non-empty — extra safety
      console.log(`    ✓ removed ${f.bogusDir}`)
    } catch (e) {
      console.log(`    ✗ failed ${f.bogusDir}: ${e?.message || e}`)
    }
  }
}

/**
 * Move a directory into TRASH_DIR while preserving the relative path under the
 * project. So /<root>/MineePod/Season 001 becomes /<trash>/MineePod/Season 001
 * — the user can see at a glance what came from where. If a collision exists
 * (e.g. the user re-runs after a previous move), suffix with a timestamp.
 */
async function moveToTrash(src, projectDir) {
  const projectsRoot = path.dirname(projectDir)
  // Relative path from PROJECTS_ROOT (so the trash mirrors the layout).
  const rel = path.relative(projectsRoot, src)
  let dest = path.join(TRASH_DIR, rel)
  // Collision suffix — never overwrite anything already in trash.
  if (existsSync(dest)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    dest = `${dest}.${ts}`
  }
  await fs.mkdir(path.dirname(dest), { recursive: true })
  try {
    await fs.rename(src, dest)  // atomic if same FS
    console.log(`    ✓ moved  ${src}\n            → ${dest}`)
  } catch (e) {
    // Cross-filesystem rename fails with EXDEV — fall back to cp -R + rm.
    if (e?.code === 'EXDEV') {
      try {
        await fs.cp(src, dest, { recursive: true, force: false, errorOnExist: true })
        await fs.rm(src, { recursive: true })
        console.log(`    ✓ copied+removed ${src}\n            → ${dest}`)
      } catch (e2) {
        console.log(`    ✗ failed (cross-fs) ${src}: ${e2?.message || e2}`)
      }
    } else {
      console.log(`    ✗ failed ${src}: ${e?.message || e}`)
    }
  }
}

function reportDupes(findings) {
  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(' Pass 2 — duplicate Season trees (outer wrapper + inner `episodes/`)')
  console.log('══════════════════════════════════════════════════════════════')
  if (!findings.length) {
    console.log('  ✓ none found.')
    return
  }
  console.log('  (informational only — never auto-deleted; you decide which side to drop)\n')
  for (const f of findings) {
    console.log(`  [${f.slug}] ${f.projectDir}`)
    for (const s of f.seasons) {
      console.log(`    ${s.season}:`)
      console.log(`      OUTER: ${s.outerSeasonDir}`)
      console.log(`      INNER: ${s.innerSeasonDir}`)
      if (s.outerOnly.length) console.log(`      only-in-outer (${s.outerOnly.length}): ${s.outerOnly.slice(0, 8).join(', ')}${s.outerOnly.length > 8 ? '…' : ''}`)
      if (s.innerOnly.length) console.log(`      only-in-inner (${s.innerOnly.length}): ${s.innerOnly.slice(0, 8).join(', ')}${s.innerOnly.length > 8 ? '…' : ''}`)
      if (s.episodes.length) {
        console.log(`      overlap (${s.episodes.length}):`)
        // Wide enough to fit `EP0001 - <40 char title>…`
        const pad = (str, n) => (str + ' '.repeat(n)).slice(0, n)
        console.log(`        ${pad('episode', 50)} ${pad('outer', 18)} ${pad('inner', 18)} match?`)
        for (const ep of s.episodes) {
          const o = `${ep.outer.files}f ${fmtBytes(ep.outer.bytes)}`
          const i = `${ep.inner.files}f ${fmtBytes(ep.inner.bytes)}`
          const mark = ep.identical ? 'identical' : '⚠ DIFFERENT'
          console.log(`        ${pad(ep.name, 50)} ${pad(o, 18)} ${pad(i, 18)} ${mark}`)
        }
      }
    }
  }
  // Compute a recommendation per season based on file/byte counts: whichever
  // side has more "stuff" is presumably the real one. Print the EXACT commands.
  console.log('\n  Suggested cleanup (review before running — these delete real data):')
  for (const f of findings) {
    for (const s of f.seasons) {
      let outerSum = 0, innerSum = 0
      for (const ep of s.episodes) { outerSum += ep.outer.bytes; innerSum += ep.inner.bytes }
      // Pick the bigger side as "keep" — if outer-only or inner-only episodes
      // exist, those break the tie regardless of overlap sizes.
      const keepInner = innerSum > outerSum || s.innerOnly.length > 0
      const dropSide = keepInner ? 'OUTER' : 'INNER'
      const dropDir = keepInner ? s.outerSeasonDir : s.innerSeasonDir
      const keepDir = keepInner ? s.innerSeasonDir : s.outerSeasonDir
      const keepBytes = keepInner ? innerSum : outerSum
      const dropBytes = keepInner ? outerSum : innerSum
      console.log(`    [${f.slug}/${s.season}]  drop ${dropSide} (${fmtBytes(dropBytes)}), keep the other (${fmtBytes(keepBytes)}):`)
      console.log(`        rm -rf "${dropDir}"`)
      console.log(`        # keeps: ${keepDir}`)
    }
  }
  console.log('\n  ⚠ Episodes marked DIFFERENT in the table above have a real content gap')
  console.log('    between the two sides. If any of those have unique work on the SMALLER side,')
  console.log('    move that work into the KEEP side first (cp / mv), then delete/trash.')
}

/** With --apply --trash, ALSO move the recommended drop side of each
 *  duplicated season into trash. Without --trash, this stays informational
 *  even on --apply — Pass 2 never deletes outright. */
async function applyDuplicateSeasonsCleanup(findings) {
  if (!TRASH_DIR) return  // no automatic deletion of season trees — too risky
  for (const f of findings) {
    for (const s of f.seasons) {
      let outerSum = 0, innerSum = 0
      for (const ep of s.episodes) { outerSum += ep.outer.bytes; innerSum += ep.inner.bytes }
      const keepInner = innerSum > outerSum || s.innerOnly.length > 0
      const dropDir = keepInner ? s.outerSeasonDir : s.innerSeasonDir
      console.log(`\n  Moving duplicate ${s.season} (${keepInner ? 'outer' : 'inner'} side) to trash…`)
      await moveToTrash(dropDir, f.projectDir)
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const trashLabel = TRASH_DIR ? `MOVE bogus + duplicate-season drops → ${TRASH_DIR}` : 'delete empty bogus dirs'
  console.log(`mode: ${APPLY ? `APPLY (${trashLabel})` : 'dry-run (no changes)'}`)
  console.log(`app: ${APP_SUPPORT}`)
  if (TRASH_DIR) {
    // Pre-create + sanity-check the trash dir so a typo doesn't litter the FS.
    if (!path.isAbsolute(TRASH_DIR)) {
      console.error(`✗ --trash must be an absolute path. Got: ${TRASH_DIR}`)
      process.exit(1)
    }
    await fs.mkdir(TRASH_DIR, { recursive: true })
  }
  const projectDirs = await collectProjectDirs()
  console.log(`found ${projectDirs.size} project director${projectDirs.size === 1 ? 'y' : 'ies'}`)

  const bogus = await scanBogusEpisodesDirs(projectDirs)
  const dupes = await scanDuplicateSeasons(projectDirs)
  reportBogus(bogus)
  if (APPLY) await applyBogusCleanup(bogus)
  reportDupes(dupes)
  if (APPLY) await applyDuplicateSeasonsCleanup(dupes)

  if (!APPLY && (bogus.length || dupes.length)) {
    console.log('\n──────────────────────────────────────────────────────────────')
    console.log(' Next step:')
    if (bogus.some(f => f.empty)) {
      console.log('   • Re-run with --apply to delete the empty bogus dirs (zero data loss).')
    }
    if (dupes.length) {
      console.log('   • Or re-run with --apply --trash <abs path> to MOVE bogus + the')
      console.log('     suggested-drop side of each duplicated season into trash (safer).')
      console.log('   • Or read Pass 2 and manually `rm -rf` one side of each duplicate.')
    }
    console.log('──────────────────────────────────────────────────────────────')
  }
}

main().catch(e => {
  console.error('cleanup failed:', e?.message || e)
  process.exit(1)
})
