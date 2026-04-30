/**
 * Boot-time migrations — idempotent, safe to run on every startup.
 *
 * Intentionally fire-and-forget: migrations that depend on disk I/O should
 * not block the server from accepting traffic. Any failure is logged but
 * doesn't prevent boot — a migration that can't run today can run tomorrow.
 */

import { migrateDescriptionToMetadata } from '../services/folder-migration.js'
import { migrateAppSecrets } from './migrate-app-secrets.js'
import { cleanOrphanWorkTempDirs, cleanLegacyInProjectTempDirs } from '../lib/work-tempdir.js'
import * as pm from '../services/project-manager.js'
import { proactiveRecoverySweep } from '../services/boot-recovery.js'
import { readLastSession } from '../services/last-session.js'

export function runBootMigrations(): void {
  migrateDescriptionToMetadata().catch(e => console.error('[migration] failed:', e))
  migrateAppSecrets().then((summary) => {
    if (summary.scanned > 0 || summary.liftedProviders.length > 0) {
      console.log(
        `[migration] app-secrets v3: scanned ${summary.scanned} project(s), ` +
        `lifted ${summary.liftedProviders.length} provider(s) [${summary.liftedProviders.join(', ')}], ` +
        `rewrote ${summary.rewrittenFiles}, removed ${summary.removedFiles}, skipped ${summary.skipped}`,
      )
    }
  }).catch(e => console.error('[migration] app-secrets failed:', e))
  // Sweep orphan video/audio scratch dirs left by force-quits or
  // crashes mid-encode. 24 h cutoff is comfortably past the longest
  // plausible run; same-session orphans are removed by the generator's
  // own try/finally on success or failure.
  cleanOrphanWorkTempDirs().then((s) => {
    if (s.removed > 0) console.log(`[migration] work-tempdir: removed ${s.removed} orphan(s) (scanned ${s.scanned})`)
  }).catch(e => console.error('[migration] work-tempdir cleanup failed:', e))
  // Sweep legacy .tmp_<ts>/ dirs left INSIDE project trees by pre-v1.0.24
  // builds (which wrote intermediates to the iCloud-synced project tree
  // instead of os.tmpdir()). Each can be 5–10 GB. Idempotent — once
  // every project has been swept the post-v1.0.24 generator never
  // creates new in-project tmp dirs, so this is a no-op on subsequent
  // boots.
  ;(async () => {
    const projects = await pm.listProjects()
    const roots: string[] = []
    for (const p of projects) {
      const r = await pm.getProjectOutputRoot(p.slug).catch(() => null)
      if (r) roots.push(r)
    }
    if (roots.length === 0) return
    const s = await cleanLegacyInProjectTempDirs(roots)
    if (s.removed > 0) {
      const gb = (s.bytesFreed / (1024 ** 3)).toFixed(2)
      console.log(
        `[migration] legacy in-project tmp: removed ${s.removed} orphan(s) ` +
        `(scanned ${s.scanned}, freed ${gb} GB)`,
      )
    }
  })().catch(e => console.error('[migration] legacy in-project tmp cleanup failed:', e?.message || e))

  // Proactive recovery sweep — only fires on unclean shutdown so a clean
  // boot has zero overhead. Walks every project's accepted episodes,
  // finds manifest entries whose local file is missing, and pulls down
  // any provider-completed results for free (single-shot, no polling).
  // Pending tasks get picked up later via the auto-recovery path inside
  // generators on the next user click. Bounded by maxItems=50 to keep
  // first-run after a big interruption tractable; the user can use
  // Repair & Retry per-episode for anything beyond the cap.
  ;(async () => {
    const last = await readLastSession().catch(() => null)
    if (!last?.unclean_shutdown) return
    const summary = await proactiveRecoverySweep({ maxItems: 50 })
    if (summary.recovered > 0 || summary.pending > 0) {
      const mb = (summary.bytesFreed / 1024 / 1024).toFixed(1)
      console.log(
        `[boot-recovery] recovered ${summary.recovered} asset(s) (${mb} MB) for free; ` +
        `${summary.pending} still pending, ${summary.expired + summary.failed} unrecoverable; ` +
        `scanned ${summary.scannedEntries} entries across ${summary.scannedManifests} manifest(s)` +
        (summary.budgetExhausted ? ' (budget cap hit — use Repair & Retry per episode for more)' : ''),
      )
    }
  })().catch(e => console.error('[boot-recovery] failed:', e?.message || e))
}
