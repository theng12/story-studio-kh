/**
 * Migration flag-file helpers.
 *
 * The userData → visible-folder migration this file once owned has been
 * removed in v1.0.14 — fully superseded by the v1.0.13 Storage tab
 * "Move projects to…" + per-project Move asset location flow + dashboard
 * recovery banner. Reasoning: the old flow misclassified iCloud paths
 * as "hidden system folder" and would re-fire the migration dialog
 * after the user had successfully co-located assets, with the side
 * effect of REVERSING the migration (rewriting output_root to absolute
 * and copying bytes out of iCloud — which broke cross-Mac sync).
 *
 * What's still here: the boot-time markers used by `folder-migration.ts`
 * to short-circuit the one-time "rename 02 Description → 02 Metadata"
 * pass after the first successful run. That flow is unrelated to
 * project storage location and remains active.
 *
 * Flag file shape: { description_to_metadata_v1_done?: boolean }
 *
 * The old `v1_output_root_migrated` array stays readable on disk so
 * existing flag files don't error on parse, but no code reads or
 * writes it anymore.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'

const require = createRequire(import.meta.url)

// ── Flag-file location ─────────────────────────────────────────────────────

function resolveFlagPath(): string {
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return path.join(process.env.STORY_STUDIO_DATA_DIR, 'migrations.json')
  }
  try {
    const { app } = require('electron')
    if (app?.getPath) return path.join(app.getPath('userData'), 'migrations.json')
  } catch {}
  return path.join(process.cwd(), 'migrations.json')
}

interface MigrationFlags {
  /**
   * Set once `migrateDescriptionToMetadata` has completed a full pass with no
   * failures. When true, the boot-time folder migration short-circuits and
   * skips the scan across every project. See `folder-migration.ts`.
   */
  description_to_metadata_v1_done?: boolean
  /**
   * v1.0.467 — set once `migrateScenePlanIntoPrompts` has moved every legacy
   * episode-root scene_plan.json into its "03 Scene Prompts" folder. When true,
   * the boot-time scan short-circuits across every project.
   */
  scene_plan_into_prompts_v1_done?: boolean
  /**
   * Legacy field from the removed userData → visible-folder migration.
   * Kept in the type so existing on-disk flag files parse without error,
   * but the new code neither reads nor writes it.
   */
  v1_output_root_migrated?: string[]
}

async function readFlags(): Promise<MigrationFlags> {
  const p = resolveFlagPath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(await fs.readFile(p, 'utf-8'))
  } catch {
    return {}
  }
}

// ── Boot-migration markers (used by folder-migration.ts) ───────────────────

/**
 * True if the "rename 02 Description → 02 Metadata" migration has already
 * completed cleanly. Checked on every boot so we don't re-scan every project
 * after the first successful pass.
 */
export async function isDescriptionToMetadataDone(): Promise<boolean> {
  const flags = await readFlags()
  return !!flags.description_to_metadata_v1_done
}

/**
 * Record that the "02 Description → 02 Metadata" migration finished a clean
 * full pass (every project's project.json updated AND every legacy folder
 * renamed). Only call this after verifying no per-project failures.
 */
export async function markDescriptionToMetadataDone(): Promise<void> {
  const flagPath = resolveFlagPath()
  await withLock(flagPath, async () => {
    const flags = await readFlags()
    flags.description_to_metadata_v1_done = true
    await writeJsonAtomic(flagPath, flags)
  })
}

/**
 * v1.0.467 — True if the "move scene_plan.json into the 03 Scene Prompts folder"
 * migration has completed cleanly. Checked on every boot so we don't re-scan
 * every project after the first successful pass.
 */
export async function isScenePlanIntoPromptsDone(): Promise<boolean> {
  const flags = await readFlags()
  return !!flags.scene_plan_into_prompts_v1_done
}

/**
 * Record that the scene_plan-relocation migration finished a clean full pass
 * (every legacy episode-root scene_plan.json moved into its "03 Scene Prompts"
 * folder). Only call this after verifying no per-episode failures.
 */
export async function markScenePlanIntoPromptsDone(): Promise<void> {
  const flagPath = resolveFlagPath()
  await withLock(flagPath, async () => {
    const flags = await readFlags()
    flags.scene_plan_into_prompts_v1_done = true
    await writeJsonAtomic(flagPath, flags)
  })
}
