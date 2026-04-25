/**
 * Boot-time folder migration: rename "02 Description" → "02 Metadata" and
 * wrap legacy `_YouTube_Description.txt` files into the new dual-format
 * (`_Metadata.txt` + `_Metadata.json`) used by the Metadata Generator.
 *
 * Crash-consistency design (audit-reports/08-persistence.md #6 / H4):
 *
 *   The invariant we preserve across any process termination is
 *     "project.json always matches the intended post-migration layout."
 *
 *   To uphold it we do the writes in this order, per project:
 *     1. Atomically update project.json (writeJsonAtomic + withLock) so
 *        subfolder_names.description → subfolder_names.metadata FIRST.
 *     2. Then rename each episode's "02 Description" folder on disk.
 *
 *   If step 1 throws we skip the renames for that project entirely — the
 *   user can retry after clearing whatever blocked the write. If we crash
 *   mid-step-2, the next boot reads project.json (already in post-migration
 *   shape) and the remaining "02 Description" dirs are simply renamed
 *   forward. The path-resolver never observes a disk layout that disagrees
 *   with project.json.
 *
 *   A persistent marker `description_to_metadata_v1_done` in migrations.json
 *   (see ./migration.ts) is set only after a clean full pass. Subsequent
 *   boots short-circuit immediately — no filesystem scan.
 *
 * Per-episode idempotency: each rename tolerates every interleaving —
 *   "new exists, legacy gone"  → nothing to do
 *   "legacy exists, new gone"  → rename forward
 *   "both exist"               → skip (ambiguous; leave for user to inspect)
 *   "neither exists"           → nothing to do
 *
 * This is separate from `migration.ts` (which handles output_root relocation
 * out of userData). This module only restructures *inside* an existing
 * project's episode folders.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { PROJECTS_ROOT } from './project-manager.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import { isDescriptionToMetadataDone, markDescriptionToMetadataDone } from './migration.js'

interface ProjectMetaShape {
  slug: string
  output_root?: string
  subfolder_names?: Record<string, string>
}

export async function migrateDescriptionToMetadata(): Promise<void> {
  // Persistent marker short-circuit — skip the scan entirely after a clean pass.
  if (await isDescriptionToMetadataDone()) return

  let projects: string[] = []
  try {
    projects = await fs.readdir(PROJECTS_ROOT)
  } catch {
    return
  }

  let anyFailed = false

  for (const slug of projects) {
    const projectDir = path.join(PROJECTS_ROOT, slug)
    const metaPath = path.join(projectDir, 'project.json')
    if (!existsSync(metaPath)) continue

    // ── Step 1: update project.json FIRST, atomically, under the same lock
    //          that project-manager uses for this path. If this fails we
    //          bail on the project entirely rather than leave the on-disk
    //          layout inconsistent with the metadata.
    let episodesRoot: string | null = null
    try {
      episodesRoot = await withLock(metaPath, async () => {
        const meta: ProjectMetaShape = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
        const outRoot = meta.output_root || './episodes'
        const epRoot = path.isAbsolute(outRoot) ? outRoot : path.join(projectDir, outRoot)

        if (
          meta.subfolder_names &&
          typeof meta.subfolder_names === 'object' &&
          'description' in meta.subfolder_names
        ) {
          const sub = { ...meta.subfolder_names }
          const old = sub.description
          delete sub.description
          sub.metadata = old?.replace(/02 Description$/, '02 Metadata') || '{code} - 02 Metadata'
          const updated = { ...meta, subfolder_names: sub }
          await writeJsonAtomic(metaPath, updated)
          console.log(`[migration] ${slug}: project.json subfolder_names.description → metadata`)
        }
        return epRoot
      })
    } catch (e) {
      anyFailed = true
      console.error(`[migration] ${slug}: project.json update failed — skipping folder renames:`, e)
      continue
    }

    if (!episodesRoot || !existsSync(episodesRoot)) continue

    // ── Step 2: rename each episode's "02 Description" folder forward. A
    //          failure on one episode is logged but does not poison the
    //          rest of the batch; we just refrain from marking the global
    //          migration complete so the next boot retries.
    let seasons: string[] = []
    try { seasons = await fs.readdir(episodesRoot) } catch { continue }

    let projectRenamesOk = true
    for (const season of seasons) {
      const seasonDir = path.join(episodesRoot, season)
      const seasonStat = await fs.stat(seasonDir).catch(() => null)
      if (!seasonStat?.isDirectory()) continue

      let episodes: string[] = []
      try { episodes = await fs.readdir(seasonDir) } catch { continue }

      for (const ep of episodes) {
        const epDir = path.join(seasonDir, ep)
        const epStat = await fs.stat(epDir).catch(() => null)
        if (!epStat?.isDirectory()) continue
        try {
          await migrateEpisode(slug, epDir)
        } catch (e) {
          projectRenamesOk = false
          console.error(`[migration] ${slug}: episode rename failed for ${ep}:`, e)
        }
      }
    }
    if (!projectRenamesOk) anyFailed = true
  }

  // Mark completion ONLY when every project finished cleanly. A partial run
  // leaves the marker unset so the next boot retries; since step 1 is atomic
  // and step 2 is idempotent, retries converge without double-updates.
  if (!anyFailed) {
    try {
      await markDescriptionToMetadataDone()
    } catch (e) {
      console.error('[migration] failed to set description_to_metadata_v1 marker:', e)
    }
  }
}

async function migrateEpisode(slug: string, epDir: string): Promise<void> {
  let subs: string[] = []
  try { subs = await fs.readdir(epDir) } catch { return }

  const legacy = subs.find(s => /^.+? - 02 Description$/.test(s))
  // Tolerate the reverse: a prior run already renamed this episode forward
  // but crashed before finishing the batch. No legacy folder means nothing
  // to do for this episode — the "already migrated" state is fine.
  if (!legacy) return

  const legacyPath = path.join(epDir, legacy)
  const newName = legacy.replace(/02 Description$/, '02 Metadata')
  const newPath = path.join(epDir, newName)

  // Both forms present → ambiguous state (user may have restored the legacy
  // folder, or a partial migration merged disks). Don't clobber — leave
  // both for the user to reconcile.
  if (existsSync(newPath)) {
    console.log(`[migration] ${slug}: both "${legacy}" and "${newName}" present — leaving untouched`)
    return
  }

  console.log(`[migration] ${slug}: renaming "${legacy}" -> "${newName}"`)
  await fs.rename(legacyPath, newPath)

  // Wrap any legacy _YouTube_Description.txt into the new metadata format
  let files: string[] = []
  try { files = await fs.readdir(newPath) } catch { return }

  for (const f of files) {
    const m = f.match(/^(.+)_YouTube_Description\.txt$/)
    if (!m) continue
    const code = m[1]
    if (!code) continue

    const oldFile = path.join(newPath, f)
    const description = await fs.readFile(oldFile, 'utf-8').catch(() => '')

    const metadataObj = {
      title: '',
      description: description.trim(),
      tags: [] as string[],
      savedAt: new Date().toISOString(),
      version: 1,
      migrated_from: f,
    }

    const txt = formatMetadataTxt(metadataObj)
    const txtPath = path.join(newPath, `${code}_Metadata.txt`)
    const jsonPath = path.join(newPath, `${code}_Metadata.json`)
    const backupPath = path.join(newPath, `${f}.bak`)

    if (!existsSync(txtPath)) await fs.writeFile(txtPath, txt)
    if (!existsSync(jsonPath)) await fs.writeFile(jsonPath, JSON.stringify(metadataObj, null, 2) + '\n')
    if (!existsSync(backupPath)) await fs.rename(oldFile, backupPath)

    console.log(`[migration] ${slug}: wrapped ${f} -> ${code}_Metadata.{txt,json}`)
  }
}

export function formatMetadataTxt(meta: { title: string; description: string; tags: string[] }): string {
  const tags = (meta.tags || []).join(', ')
  return [
    '=== TITLE ===',
    meta.title || '',
    '',
    '=== DESCRIPTION ===',
    meta.description || '',
    '',
    '=== TAGS ===',
    tags,
    '',
  ].join('\n')
}

export function parseMetadataTxt(text: string): { title: string; description: string; tags: string[] } {
  const sections: Record<string, string> = {}
  let current = ''
  let buf: string[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^=== (TITLE|DESCRIPTION|TAGS) ===$/)
    if (m && m[1]) {
      if (current) sections[current] = buf.join('\n').trim()
      current = m[1].toLowerCase()
      buf = []
    } else {
      buf.push(line)
    }
  }
  if (current) sections[current] = buf.join('\n').trim()
  return {
    title: sections.title || '',
    description: sections.description || '',
    tags: sections.tags ? sections.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
  }
}
