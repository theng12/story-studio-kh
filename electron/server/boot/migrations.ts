/**
 * Boot-time maintenance for current Story Studio state.
 *
 * This intentionally contains no historical project migrations. Current
 * installs only prime live registries, clean temporary files, and reconnect
 * durable GenStudio work.
 */

import { cleanOrphanWorkTempDirs } from '../lib/work-tempdir.js'
import { cleanupStaleUndoSidecars } from '../services/upload-renumber-undo.js'
import { cleanupStaleReseasonUndoSidecars } from '../services/upload-reseason.js'
import { proactiveRecoverySweep } from '../services/boot-recovery.js'
import { readLastSession } from '../services/last-session.js'

let bootComplete = false

export function isBootComplete(): boolean { return bootComplete }

export function runBootMigrations(): void {
  const tasks: Promise<unknown>[] = []

  tasks.push((async () => {
    const { getAllDisabledEndpoints } = await import('../services/app-settings.js')
    const { setDisabledEndpoints } = await import('../lib/endpoint-pool.js')
    const all = await getAllDisabledEndpoints()
    for (const [providerId, urls] of Object.entries(all)) setDisabledEndpoints(providerId, urls)
  })().catch(error => console.error('[boot] disabled-endpoints load failed:', error?.message || error)))

  tasks.push(cleanOrphanWorkTempDirs().then(summary => {
    if (summary.removed > 0) console.log(`[boot] work-tempdir: removed ${summary.removed} orphan(s) (scanned ${summary.scanned})`)
  }).catch(error => console.error('[boot] work-tempdir cleanup failed:', error)))

  tasks.push(cleanupStaleUndoSidecars().then(cleaned => {
    if (cleaned.length > 0) console.log(`[boot] renumber-undo: removed ${cleaned.length} stale sidecar(s)`)
  }).catch(error => console.error('[boot] renumber-undo cleanup failed:', error?.message || error)))

  tasks.push(cleanupStaleReseasonUndoSidecars().then(cleaned => {
    if (cleaned.length > 0) console.log(`[boot] reseason-undo: removed ${cleaned.length} stale sidecar(s)`)
  }).catch(error => console.error('[boot] reseason-undo cleanup failed:', error?.message || error)))

  tasks.push((async () => {
    const last = await readLastSession().catch(() => null)
    if (!last?.unclean_shutdown) return
    const summary = await proactiveRecoverySweep({ maxItems: 50 })
    if (summary.recovered > 0 || summary.pending > 0) {
      console.log(
        `[boot-recovery] recovered ${summary.recovered} asset(s); ` +
        `${summary.pending} still pending, ${summary.expired + summary.failed} unrecoverable`,
      )
    }
  })().catch(error => console.error('[boot-recovery] failed:', error?.message || error)))

  const timeoutMs = 20_000
  const settle = new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      console.warn(`[boot] ready timeout after ${timeoutMs}ms — continuing with maintenance in flight`)
      resolve()
    }, timeoutMs)
    timer.unref?.()
    void Promise.allSettled(tasks).then(() => { clearTimeout(timer); resolve() })
  })
  void settle.then(() => { bootComplete = true })
}
