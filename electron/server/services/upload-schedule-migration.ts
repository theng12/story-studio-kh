/**
 * Item I-eager: boot-time migration that promotes per-item schedule
 * entries from `config.upload_item_schedule` into each episode's
 * YouTube sidecar.
 *
 * Lifecycle (per project):
 *   1. Read the legacy map. If empty → no-op (idempotent fast path).
 *   2. For each `episode_code` key, look up the matching accepted idea
 *      and call `setScheduledFor` on its sidecar. Imports (`import:*`
 *      keys) and any other non-episode key shapes stay in the legacy
 *      map untouched — they have no sidecar to migrate into.
 *   3. After all episode keys land, rewrite the legacy map with only
 *      the leftover non-episode entries.
 *   4. Mark the project's config with `upload_item_schedule_migrated_v1`
 *      so a re-boot doesn't redo the walk for projects that have
 *      already been swept (skip even when the legacy map is empty —
 *      the marker is what tells us "this project has been through
 *      the migration", versus "nothing to migrate").
 *
 * The marker is per-project rather than global so a future install
 * importing an older project (via the linked-paths registry) still
 * gets that project migrated even if the host machine already booted
 * past v1.0.X.
 *
 * Idempotent: re-running on a migrated project is cheap (single
 * config read + the marker check) and produces no writes.
 */

import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { setScheduledFor } from './upload-sidecar.js'
import { LEGACY_SCHEDULE_FIELD } from './upload-plans.js'

export const MIGRATION_MARKER = 'upload_item_schedule_migrated_v1'

export interface ProjectMigrationResult {
  slug: string
  /** Episode-coded entries actually written to sidecars. */
  migrated: number
  /** Non-episode keys (today: `import:*`) preserved in the legacy map. */
  preserved: number
  /** Episode-coded entries with no matching accepted idea (skipped). */
  orphaned: number
  /** True when the project was already migrated before this run. */
  skipped: boolean
}

export interface MigrationSummary {
  scanned: number
  alreadyMigrated: number
  migratedProjects: number
  totalEntriesMigrated: number
  totalOrphans: number
  errors: Array<{ slug: string; error: string }>
}

async function migrateOneProject(slug: string): Promise<ProjectMigrationResult> {
  const result: ProjectMigrationResult = {
    slug, migrated: 0, preserved: 0, orphaned: 0, skipped: false,
  }

  const config = (await pm.getConfig(slug)) as any
  if (config?.[MIGRATION_MARKER]) {
    result.skipped = true
    return result
  }

  const legacyRaw = config?.[LEGACY_SCHEDULE_FIELD]
  const legacy: Record<string, string> = (legacyRaw && typeof legacyRaw === 'object')
    ? legacyRaw
    : {}

  // Even when the legacy map is empty we still write the marker, so
  // subsequent boots short-circuit on the marker check above instead
  // of always re-reading + checking the empty map.
  if (Object.keys(legacy).length === 0) {
    await pm.updateConfig(slug, { [MIGRATION_MARKER]: true } as any)
    return result
  }

  // Walk episode keys → sidecar; preserve everything else (today only
  // import:*) unchanged. We need accepted ideas to look up the title,
  // which sidecar paths are computed from when the folder template
  // includes {title}.
  const ideas = await im.getIdeas(slug, 'accepted').catch(() => [])
  const ideaByCode = new Map<string, { title: string }>()
  for (const i of ideas) {
    if (i.episode_code) ideaByCode.set(i.episode_code, { title: i.title || '' })
  }

  const remaining: Record<string, string> = {}
  for (const [k, v] of Object.entries(legacy)) {
    if (!v) continue
    const idea = ideaByCode.get(k)
    if (!idea) {
      // Either an `import:*` key (preserve) or an orphan reference to
      // a deleted idea (drop — we can't migrate to a sidecar that has
      // nowhere to live). The two cases are distinguishable by prefix.
      if (k.startsWith('import:')) {
        remaining[k] = v
        result.preserved++
      } else {
        result.orphaned++
      }
      continue
    }
    try {
      await setScheduledFor(slug, k, idea.title, 'youtube', v)
      result.migrated++
    } catch (e: any) {
      // A single sidecar-write failure shouldn't poison the rest of
      // the project. Keep the entry in the legacy map so the user
      // can re-attempt next boot, and log so the failure is visible.
      console.warn(`[migration:upload-item-schedule] ${slug}/${k}: sidecar write failed:`, e?.message || e)
      remaining[k] = v
    }
  }

  // Rewrite the legacy field + plant the marker in a single config
  // write so the migration's "second run is cheap" property doesn't
  // depend on two writes landing atomically.
  await pm.updateConfig(slug, {
    [LEGACY_SCHEDULE_FIELD]: remaining,
    [MIGRATION_MARKER]: true,
  } as any)

  return result
}

/**
 * Run the eager sweep across every project. Each project's failure is
 * isolated — a parse error on one config doesn't block the rest. The
 * caller (boot/migrations.ts) logs the summary; this function returns
 * a structured result rather than printing directly so it stays easy
 * to test.
 */
export async function migrateScheduleMapsToSidecars(): Promise<MigrationSummary> {
  const summary: MigrationSummary = {
    scanned: 0,
    alreadyMigrated: 0,
    migratedProjects: 0,
    totalEntriesMigrated: 0,
    totalOrphans: 0,
    errors: [],
  }
  let projects: Array<{ slug: string }> = []
  try {
    projects = (await pm.listProjects()) as any
  } catch (e: any) {
    summary.errors.push({ slug: '*', error: e?.message || 'listProjects failed' })
    return summary
  }
  for (const p of projects) {
    summary.scanned++
    try {
      const r = await migrateOneProject(p.slug)
      if (r.skipped) summary.alreadyMigrated++
      else if (r.migrated > 0) {
        summary.migratedProjects++
        summary.totalEntriesMigrated += r.migrated
      }
      summary.totalOrphans += r.orphaned
    } catch (e: any) {
      summary.errors.push({ slug: p.slug, error: e?.message || 'migration failed' })
    }
  }
  return summary
}
