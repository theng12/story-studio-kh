/**
 * One-shot migration: walk every accepted episode in a project and
 * materialise per-chapter source files from the legacy unified narration
 * (and the legacy separate `_Introduction.docx` if present).
 *
 * Idempotent — episodes that already have per-chapter files are skipped.
 *
 * Usage:
 *   npx tsx scripts/migrate-narration.ts <project-slug>
 *
 * Run from the `electron/` directory so the relative imports resolve.
 */

import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'

import * as pm from '../server/services/project-manager.js'
import * as im from '../server/services/idea-manager.js'
import { ensureChapterFilesMigrated } from '../server/lib/narration-assembly.js'

const slug = process.argv[2]
if (!slug) {
  console.error('Usage: tsx scripts/migrate-narration.ts <project-slug>')
  process.exit(1)
}

async function findEpisodeScriptDir(outputRoot: string, code: string): Promise<string | null> {
  // Mirrors routes/ideas.ts findDir: episode folders are named "{code} - {title}".
  // We just need the script subfolder inside.
  async function recurseEpisode(dir: string, depth = 0): Promise<string | null> {
    if (depth > 4) return null
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) }
    catch { return null }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name.startsWith(`${code} - `) || e.name.toUpperCase().startsWith(code.toUpperCase())) {
        // Found episode dir — now find the script subfolder
        const epDir = path.join(dir, e.name)
        const subs = await fs.readdir(epDir, { withFileTypes: true }).catch(() => [])
        for (const sub of subs) {
          if (!sub.isDirectory()) continue
          const lower = sub.name.toLowerCase()
          if ((lower.endsWith('script') || lower.includes('01 script'))
              && !lower.includes('prompt') && !lower.includes('description')) {
            return path.join(epDir, sub.name)
          }
        }
      }
    }
    // Recurse into subdirectories (Season folders, etc.)
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const found = await recurseEpisode(path.join(dir, e.name), depth + 1)
      if (found) return found
    }
    return null
  }
  return recurseEpisode(outputRoot)
}

async function main() {
  const project = await pm.getProject(slug)
  if (!project) {
    console.error(`Project not found: ${slug}`)
    process.exit(1)
  }
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot || !existsSync(outputRoot)) {
    console.error(`Project output root missing: ${outputRoot}`)
    process.exit(1)
  }

  const ideas = await im.getIdeas(slug, 'accepted')
  console.log(`\nMigrating ${ideas.length} episode(s) in project "${slug}"`)
  console.log(`Output root: ${outputRoot}\n`)

  let migrated = 0
  let skipped = 0
  let missing = 0

  for (const idea of ideas) {
    if (!idea.episode_code) continue
    const code = idea.episode_code
    const title = idea.title || ''
    const scriptDir = await findEpisodeScriptDir(outputRoot, code)
    if (!scriptDir) {
      console.log(`  ${code}  — no script folder on disk, skipping`)
      missing++
      continue
    }
    try {
      const ran = await ensureChapterFilesMigrated(scriptDir, code, title)
      if (ran) {
        // Confirm result by listing what we just wrote
        const entries = await fs.readdir(scriptDir)
        const chapterCount = entries.filter(n => new RegExp(`^${code}_Chapter_\\d+\\.docx$`).test(n)).length
        const hasIntro = entries.includes(`${code}_Introduction.docx`)
        console.log(`  ${code}  → migrated: ${chapterCount} chapter file(s)${hasIntro ? ' + intro' : ''}`)
        migrated++
      } else {
        console.log(`  ${code}  — already has chapter files (or no source), skipping`)
        skipped++
      }
    } catch (e: any) {
      console.error(`  ${code}  ERROR: ${e?.message || e}`)
    }
  }

  console.log(`\nDone. migrated=${migrated}  skipped=${skipped}  missing=${missing}`)
}

main().catch(e => {
  console.error('Migration failed:', e)
  process.exit(1)
})
