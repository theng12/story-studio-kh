/**
 * Boot-time migration (v1.0.467): move each episode's `scene_plan.json` from the
 * episode root INTO its "03 Scene Prompts" folder.
 *
 * The scene plan carries every scene's `visual_prompt`, so it belongs next to
 * the human-readable Scene Prompts doc — the whole prompt pipeline in one place.
 * New writes already land in the subfolder (see resolveScenePlanPath in
 * services/utils.ts, which also falls back to the legacy root location on read).
 * This migration moves the historical files forward so there's a single
 * canonical location going forward.
 *
 * Idempotency — each episode tolerates every interleaving:
 *   "subfolder has it, root gone"  → nothing to do
 *   "root has it, subfolder gone"  → move forward (mkdir subfolder if needed)
 *   "both have it"                 → leave untouched (ambiguous; resolver already
 *                                    prefers the subfolder, so reads are correct)
 *   "neither"                      → nothing to do
 *
 * A persistent marker `scene_plan_into_prompts_v1_done` (migration.ts) short-
 * circuits the scan after one clean full pass. A failure on one episode is
 * logged but doesn't poison the batch; the marker simply stays unset so the
 * next boot retries (the move is idempotent, so retries converge).
 *
 * This only restructures *inside* existing episode folders — it never touches
 * project.json or the folder template, so there's no crash-consistency coupling
 * with the path resolver (unlike folder-migration.ts).
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { PROJECTS_ROOT } from './project-manager.js'
import { resolveSubfolderNames, SCENE_PLAN_SIDECAR } from './utils.js'
import { findSubfolder } from '../lib/folder-resolver.js'
import { isScenePlanIntoPromptsDone, markScenePlanIntoPromptsDone } from './migration.js'

interface ProjectMetaShape {
  output_root?: string
}

export async function migrateScenePlanIntoPrompts(): Promise<void> {
  if (await isScenePlanIntoPromptsDone()) return

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

    let episodesRoot: string
    try {
      const meta: ProjectMetaShape = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
      const outRoot = meta.output_root || './episodes'
      episodesRoot = path.isAbsolute(outRoot) ? outRoot : path.join(projectDir, outRoot)
    } catch (e) {
      anyFailed = true
      console.error(`[migration] ${slug}: scene-plan relocation — couldn't read project.json:`, e)
      continue
    }
    if (!existsSync(episodesRoot)) continue

    let seasons: string[] = []
    try { seasons = await fs.readdir(episodesRoot) } catch { continue }

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
          anyFailed = true
          console.error(`[migration] ${slug}: scene-plan relocation failed for ${ep}:`, e)
        }
      }
    }
  }

  // Mark complete only after a fully clean pass — a partial run leaves the
  // marker unset so the next boot retries (the move is idempotent).
  if (!anyFailed) {
    try {
      await markScenePlanIntoPromptsDone()
    } catch (e) {
      console.error('[migration] failed to set scene_plan_into_prompts_v1 marker:', e)
    }
  }
}

async function migrateEpisode(slug: string, epDir: string): Promise<void> {
  const legacyPath = path.join(epDir, SCENE_PLAN_SIDECAR)
  if (!existsSync(legacyPath)) return  // nothing at the root → already migrated or never planned

  // Episode folder is named "{code} - {title}" (optionally "✅ "-prefixed). The
  // scene_prompts subfolder name is "{code} - 03 Scene Prompts" by default, but
  // honour any custom subfolder_names template via resolveSubfolderNames.
  const folderName = path.basename(epDir).replace(/^✅\s*/, '')
  const code = folderName.split(' - ')[0]?.trim() || folderName
  const names = await resolveSubfolderNames(slug, code)

  const scenePromptsDir =
    (await findSubfolder(epDir, names.scene_prompts)) || path.join(epDir, names.scene_prompts)
  const newPath = path.join(scenePromptsDir, SCENE_PLAN_SIDECAR)

  // Both present → ambiguous (partial prior run, or a manual copy). Leave both;
  // resolveScenePlanPath already prefers the subfolder, so reads are correct.
  if (existsSync(newPath)) {
    console.log(`[migration] ${slug}: ${code} — scene_plan.json present at both root and 03 folder; leaving untouched`)
    return
  }

  await fs.mkdir(scenePromptsDir, { recursive: true })
  await fs.rename(legacyPath, newPath)
  console.log(`[migration] ${slug}: ${code} — moved scene_plan.json into "${path.basename(scenePromptsDir)}"`)
}
