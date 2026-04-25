/**
 * Boot-time migrations — idempotent, safe to run on every startup.
 *
 * Intentionally fire-and-forget: migrations that depend on disk I/O should
 * not block the server from accepting traffic. Any failure is logged but
 * doesn't prevent boot — a migration that can't run today can run tomorrow.
 */

import { migrateDescriptionToMetadata } from '../services/folder-migration.js'

export function runBootMigrations(): void {
  migrateDescriptionToMetadata().catch(e => console.error('[migration] failed:', e))
}
