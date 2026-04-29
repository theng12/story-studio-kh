/**
 * Boot-time migrations — idempotent, safe to run on every startup.
 *
 * Intentionally fire-and-forget: migrations that depend on disk I/O should
 * not block the server from accepting traffic. Any failure is logged but
 * doesn't prevent boot — a migration that can't run today can run tomorrow.
 */

import { migrateDescriptionToMetadata } from '../services/folder-migration.js'
import { migrateAppSecrets } from './migrate-app-secrets.js'

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
}
