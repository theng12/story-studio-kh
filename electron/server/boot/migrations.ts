/**
 * Boot-time maintenance for current Story Studio state.
 *
 * This intentionally contains no historical project migrations. Current
 * installs only prime live registries, clean temporary files, and reconnect
 * durable GenStudio work.
 */

import { cleanOrphanWorkTempDirs } from '../lib/work-tempdir.js'
import { collectProtectedVideoAssemblyWorkDirs } from '../lib/video-assembly-checkpoint.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { cleanupStaleUndoSidecars } from '../services/upload-renumber-undo.js'
import { cleanupStaleReseasonUndoSidecars } from '../services/upload-reseason.js'
import { proactiveRecoverySweep } from '../services/boot-recovery.js'
import { readLastSession } from '../services/last-session.js'
import { registerDeferredBootWork } from './deferred-boot.js'

let bootComplete = false

export function isBootComplete(): boolean { return bootComplete }

async function protectedVideoAssemblyWorkDirsAtBoot(): Promise<Set<string>> {
  const { listProjects, getProjectDir } = await import('../services/project-manager.js')
  const projects = await listProjects() as Array<{ slug?: string }>
  const jobs: unknown[] = []
  for (const project of projects) {
    if (!project.slug) continue
    const projectDir = getProjectDir(project.slug)
    if (!projectDir) continue
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(projectDir, 'jobs.json'), 'utf8'))
      if (Array.isArray(parsed?.jobs)) jobs.push(...parsed.jobs)
    } catch { /* no readable durable job history for this project */ }
  }
  return collectProtectedVideoAssemblyWorkDirs(jobs)
}

export function runBootMigrations(): void {
  const tasks: Promise<unknown>[] = []

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
    const { getImageEpisodeConcurrency, getThumbnailEpisodeConcurrency, getAudioEpisodeConcurrency: getAudioSetting } = await import('../services/app-settings.js')
    const { setImageEpisodeConcurrency, setThumbnailEpisodeConcurrency, setAudioEpisodeConcurrency } = await import('../services/job-queue.js')
    const n = await getImageEpisodeConcurrency()
    setImageEpisodeConcurrency(n)
    // Thumbnails have their own lane: they usually buy from a cloud API while
    // Scene Review buys from the local fleet, so one must not block the other.
    const thumbs = await getThumbnailEpisodeConcurrency()
    setThumbnailEpisodeConcurrency(thumbs)
    // Narration: its own number, seeded from the image one on first read.
    const audio = await getAudioSetting()
    setAudioEpisodeConcurrency(audio)
    console.log(`[boot] episodes generating images at once: ${n} (thumbnails: ${thumbs}, narration: ${audio})`)
  })().catch(error => console.error('[boot] image concurrency load failed:', error?.message || error)))

  // v1.4.41 — the owner's images-per-episode override. 'auto' follows the
  // account's published ceiling, which is the default and the honest answer.
  tasks.push((async () => {
    const { getImageFanout } = await import('../services/app-settings.js')
    const { setImageFanoutOverride } = await import('../services/job-queue.js')
    const setting = await getImageFanout()
    setImageFanoutOverride(setting === 'auto' ? 0 : setting)
    console.log(`[boot] images per episode at once: ${setting === 'auto' ? 'auto (follows the Gateway)' : setting}`)
  })().catch(error => console.error('[boot] image fanout load failed:', error?.message || error)))

  tasks.push((async () => {
    // `app.ts` starts this migration before registering executors. Resolve and
    // validate every durable Video Assembly owner before the first directory is
    // inspected, so recovery and the 24-hour sweep cannot race over one path.
    const protectedDirs = await protectedVideoAssemblyWorkDirsAtBoot()
    const summary = await cleanOrphanWorkTempDirs(24 * 60 * 60 * 1000, protectedDirs)
    if (summary.removed > 0) console.log(`[boot] work-tempdir: removed ${summary.removed} orphan(s) (scanned ${summary.scanned})`)
  })().catch(error => console.error('[boot] work-tempdir cleanup failed:', error)))

  // 1.4.289 — one Story-wide Trash: move every old per-channel `_trash` (and the app's own) into
  // `<Library>/_trash/<channel>/legacy`. Renames only, nothing deleted; a second run finds nothing.
  tasks.push((async () => {
    const { migrateLegacyTrash } = await import('../services/trash.js')
    const report = await migrateLegacyTrash()
    if (report.moved.length || report.left.length) console.log(`[boot] trash: moved ${report.moved.length} old trash folder(s), left ${report.left.length}`)
  })().catch(error => console.error('[boot] trash migration failed:', error?.message || error)))

  tasks.push(cleanupStaleUndoSidecars().then(cleaned => {
    if (cleaned.length > 0) console.log(`[boot] renumber-undo: removed ${cleaned.length} stale sidecar(s)`)
  }).catch(error => console.error('[boot] renumber-undo cleanup failed:', error?.message || error)))

  tasks.push(cleanupStaleReseasonUndoSidecars().then(cleaned => {
    if (cleaned.length > 0) console.log(`[boot] reseason-undo: removed ${cleaned.length} stale sidecar(s)`)
  }).catch(error => console.error('[boot] reseason-undo cleanup failed:', error?.message || error)))

  // 1.4.402 — the unclean-shutdown recovery sweep starts after the window's
  // first paint, not before it (owner-approved startup deferral). Nothing is
  // skipped: it still runs on every unclean shutdown, and one logged line now
  // says when it actually starts. Not part of `tasks`, so `boot_complete` no
  // longer waits on it — it repairs background evidence, nothing a route
  // needs synchronously.
  registerDeferredBootWork({
    name: 'proactive-recovery-sweep',
    run: async () => {
      try {
        const last = await readLastSession().catch(() => null)
        if (!last?.unclean_shutdown) return
        const summary = await proactiveRecoverySweep({ maxItems: 50 })
        if (summary.recovered > 0 || summary.pending > 0) {
          console.log(
            `[boot-recovery] recovered ${summary.recovered} asset(s); ` +
            `${summary.pending} still pending, ${summary.expired + summary.failed} unrecoverable`,
          )
        }
      } catch (error) {
        console.error('[boot-recovery] failed:', (error as Error)?.message || error)
      }
    },
  })

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

  // 1.4.343 — freeze every plan-less final's expectation onto the file, ONCE, while the channel's
  // Video Assembly settings can still be shown to be the ones that produced it.
  //
  // The owner's decision (2026-10-20) keeps every already-made Sprout final on its long silent still
  // tail and its branded intro while FUTURE episodes drop that 6000 s `after_scenes` clip. A final
  // from before the 1.4.327 plan sidecar records no plan of its own, so once that preset changes,
  // nothing on disk says what the file was made to be — and a re-check would measure its 9354 s
  // against a ~15 s tail and STOP a file the owner said to keep. Freezing it now, beside the file,
  // is what makes the answer survive the change. Idempotent: a final already frozen for its own
  // bytes is left exactly as it is.
  tasks.push((async () => {
    const { freezeExistingPlanlessFinals } = await import('../services/final-check-expectation.js')
    const summary = await freezeExistingPlanlessFinals()
    if (summary.unknown > 0) {
      console.warn(`[boot] ${summary.unknown} plan-less final(s) have no frozen expectation and their settings moved since they were rendered — they will be reported as unknown, not measured against today's settings.`)
    }
  })().catch(error => console.error('[boot] final-check expectation freeze failed:', error?.message || error)))

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
