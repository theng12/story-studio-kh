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

  // v1.4.3 — fold the four retired location settings into the Library. Reports
  // anything still living outside it rather than moving a single file; see
  // services/library-migration.ts for why that asymmetry is deliberate.
  tasks.push((async () => {
    const { migrateLegacyLocationSettings } = await import('../services/library-migration.js')
    const notices = await migrateLegacyLocationSettings()
    if (notices.length) {
      console.log(`[boot] library migration: ${notices.length} notice(s) recorded for the customer`)
    }
  })().catch(error => console.error('[boot] library migration failed:', error?.message || error)))

  // v1.4.23 — apply the owner's episode-transcription concurrency.
  //
  // `job-queue.setSubtitleTranscribeConcurrency` has existed since the group
  // was written and nothing outside a test has ever called it, so the limit
  // sat at its hardcoded 50. Thirty episodes fired at once became ~350
  // simultaneous requests and a third of them were refused for want of a free
  // machine. Reading the setting here is what makes the number the owner's
  // rather than the code's.
  tasks.push((async () => {
    const { getSubtitleEpisodeConcurrency } = await import('../services/app-settings.js')
    const { setSubtitleTranscribeConcurrency } = await import('../services/job-queue.js')
    const n = await getSubtitleEpisodeConcurrency()
    setSubtitleTranscribeConcurrency(n)
    console.log(`[boot] subtitle episodes running at once: ${n}`)
  })().catch(error => console.error('[boot] subtitle concurrency load failed:', error?.message || error)))

  // v1.4.27 — the same story as the subtitle lane. `setLlmConcurrency` has
  // existed since the group was written and nothing outside a test ever called
  // it, so the writing lane sat at 50 and a burst of 21+ chat jobs waited a
  // median of 15.6 minutes. Reading the owner's setting here is what makes the
  // number his.
  tasks.push((async () => {
    const { getLlmConcurrency } = await import('../services/app-settings.js')
    const { setLlmConcurrency } = await import('../services/job-queue.js')
    const n = await getLlmConcurrency()
    setLlmConcurrency(n)
    console.log(`[boot] writing jobs running at once: ${n}`)
  })().catch(error => console.error('[boot] llm concurrency load failed:', error?.message || error)))

  // v1.4.39 — the third lane with the same story, found by measurement rather
  // than by report. The owner queued 50 Scene Review jobs and asked whether his
  // machines were all working; 51 of 74 online fleet workers were idle, and a
  // location connected that morning had one busy worker out of twenty. Neither
  // the fleet nor GenStudio was the limit — his account bursts to 128 and 25
  // were running. Image episodes ran ONE AT A TIME because every lane outside
  // the LLM and subtitle groups gets a single boolean slot.
  tasks.push((async () => {
    const { getImageEpisodeConcurrency } = await import('../services/app-settings.js')
    const { setImageEpisodeConcurrency } = await import('../services/job-queue.js')
    const n = await getImageEpisodeConcurrency()
    setImageEpisodeConcurrency(n)
    console.log(`[boot] episodes generating images at once: ${n}`)
  })().catch(error => console.error('[boot] image concurrency load failed:', error?.message || error)))

  // v1.4.41 — the owner's images-per-episode override. 'auto' follows the
  // account's published ceiling, which is the default and the honest answer.
  tasks.push((async () => {
    const { getImageFanout } = await import('../services/app-settings.js')
    const { setImageFanoutOverride } = await import('../services/job-queue.js')
    const setting = await getImageFanout()
    setImageFanoutOverride(setting === 'auto' ? 0 : setting)
    console.log(`[boot] images per episode at once: ${setting === 'auto' ? 'auto (follows GenStudio)' : setting}`)
  })().catch(error => console.error('[boot] image fanout load failed:', error?.message || error)))

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

  tasks.push((async () => {
    const { verifyContentPackRuntimeAtBoot } = await import('../content-packs/recovery.js')
    const summary = await verifyContentPackRuntimeAtBoot()
    if (summary.recovery_verified || summary.installed_verified || summary.rolled_back.length || summary.quarantined) {
      console.log(
        `[content-packs] recovery ${summary.recovery_verified}, installed ${summary.installed_verified}, ` +
        `rolled back ${summary.rolled_back.length}, invalid ${summary.quarantined}`,
      )
    }
  })().catch(error => console.error('[content-packs] boot verification failed:', error?.message || error)))

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
