/**
 * Boot-time migrations — idempotent, safe to run on every startup.
 *
 * Intentionally fire-and-forget: migrations that depend on disk I/O should
 * not block the server from accepting traffic. Any failure is logged but
 * doesn't prevent boot — a migration that can't run today can run tomorrow.
 */

import { migrateDescriptionToMetadata } from '../services/folder-migration.js'
import { migrateAppSecrets } from './migrate-app-secrets.js'
import { cleanOrphanWorkTempDirs } from '../lib/work-tempdir.js'

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
}
