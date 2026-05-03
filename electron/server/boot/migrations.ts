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
import { cleanupStaleUndoSidecars } from '../services/upload-renumber-undo.js'
import { proactiveRecoverySweep } from '../services/boot-recovery.js'
import { readLastSession } from '../services/last-session.js'
import {
  voiceCurationGlobalIsUnset,
  setVoicePresetsGlobal, setVoiceFavouritesGlobal,
  type GlobalVoicePreset,
} from '../services/app-settings.js'

// Module-level flag that flips true once every async migration has either
// resolved or rejected. Exposed via /api/health so the frontend can wait
// for boot to settle before firing the parallel page-load fan-out — the
// "Project not found" / "COULDN'T VERIFY" flashes some users hit on the
// very first navigation came from API requests landing while
// migrateAppSecrets / migrateDescriptionToMetadata were still mid-rewrite.
let _bootComplete = false
/** Read-only accessor for the boot-complete flag. Set by runBootMigrations
 *  after all background tasks finish (or a safety-net timeout fires).
 *  Defaults to false so anything that imports + queries before runBoot
 *  is called sees the conservative answer. */
export function isBootComplete(): boolean { return _bootComplete }

export function runBootMigrations(): void {
  // Collect every migration's promise so we can settle the boot-complete
  // flag once they're all done. We still let each migration FAIL without
  // blocking the others (and without blocking startup) — boot_complete
  // means "no longer migrating", not "everything succeeded".
  const tasks: Promise<unknown>[] = []
  tasks.push(migrateDescriptionToMetadata().catch(e => console.error('[migration] failed:', e)))
  tasks.push(migrateAppSecrets().then((summary) => {
    if (summary.scanned > 0 || summary.liftedProviders.length > 0) {
      console.log(
        `[migration] app-secrets v3: scanned ${summary.scanned} project(s), ` +
        `lifted ${summary.liftedProviders.length} provider(s) [${summary.liftedProviders.join(', ')}], ` +
        `rewrote ${summary.rewrittenFiles}, removed ${summary.removedFiles}, skipped ${summary.skipped}`,
      )
    }
  }).catch(e => console.error('[migration] app-secrets failed:', e)))
  // Sweep orphan video/audio scratch dirs left by force-quits or
  // crashes mid-encode. 24 h cutoff is comfortably past the longest
  // plausible run; same-session orphans are removed by the generator's
  // own try/finally on success or failure.
  tasks.push(cleanOrphanWorkTempDirs().then((s) => {
    if (s.removed > 0) console.log(`[migration] work-tempdir: removed ${s.removed} orphan(s) (scanned ${s.scanned})`)
  }).catch(e => console.error('[migration] work-tempdir cleanup failed:', e)))
  // Sweep legacy .tmp_<ts>/ dirs left INSIDE project trees by pre-v1.0.24
  // builds (which wrote intermediates to the iCloud-synced project tree
  // instead of os.tmpdir()). Each can be 5–10 GB. Idempotent — once
  // every project has been swept the post-v1.0.24 generator never
  // creates new in-project tmp dirs, so this is a no-op on subsequent
  // boots.
  tasks.push(((async () => {
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
  })()).catch(e => console.error('[migration] legacy in-project tmp cleanup failed:', e?.message || e)))

  // Voice-curation lift: voice_presets and voice_favourites used to live
  // per-project (config.json). They're personal-taste data that doesn't
  // change between channels, so they were lifted to app-settings.json
  // (per-machine, like the elevenlabs-voices catalog cache). This
  // migration runs ONCE per machine: walks every project, merges their
  // legacy lists (deduped), writes to global. Per-project fields stay
  // readable so older app builds keep working. Idempotent — gated on
  // both global keys being unset so a re-add post-migration never gets
  // reverted.
  tasks.push(((async () => {
    if (!await voiceCurationGlobalIsUnset()) return
    const projects = await pm.listProjects().catch(() => [])
    const presetsByVoiceId = new Map<string, GlobalVoicePreset>()
    const favouriteIds = new Set<string>()
    let scannedProjects = 0
    for (const p of projects) {
      const cfg = await pm.getConfig(p.slug).catch(() => null) as any
      if (!cfg) continue
      scannedProjects++
      const presets = Array.isArray(cfg.voice_presets) ? cfg.voice_presets : []
      for (const vp of presets) {
        if (vp && typeof vp.name === 'string' && typeof vp.voice_id === 'string') {
          // First write wins on duplicate voice_id — preserves the
          // earliest project's chosen display name.
          if (!presetsByVoiceId.has(vp.voice_id)) {
            presetsByVoiceId.set(vp.voice_id, { name: vp.name, voice_id: vp.voice_id })
          }
        }
      }
      const favs = Array.isArray(cfg.voice_favourites) ? cfg.voice_favourites : []
      for (const id of favs) if (typeof id === 'string' && id.length > 0) favouriteIds.add(id)
    }
    const presets = [...presetsByVoiceId.values()]
    const favourites = [...favouriteIds]
    await setVoicePresetsGlobal(presets)
    await setVoiceFavouritesGlobal(favourites)
    if (presets.length > 0 || favourites.length > 0) {
      console.log(
        `[migration] voice-curation lifted to global: ${presets.length} preset(s), ` +
        `${favourites.length} favourite(s) merged from ${scannedProjects} project(s)`,
      )
    }
  })()).catch(e => console.error('[migration] voice-curation lift failed:', e?.message || e)))

  // Item L: auto-clean stale renumber-undo sidecars (>30 days old).
  // Cheap walk — bounded by project count (typically <10 for personal
  // use) and most projects never carry an undo sidecar at all. Logs a
  // one-line summary if any were swept so the user can scan boot
  // output for "did my safety net just expire?".
  tasks.push(cleanupStaleUndoSidecars().then((cleaned) => {
    if (cleaned.length > 0) {
      console.log(`[migration] renumber-undo: auto-cleaned ${cleaned.length} stale sidecar(s) [${cleaned.join(', ')}]`)
    }
  }).catch(e => console.error('[migration] renumber-undo cleanup failed:', e?.message || e)))

  // Proactive recovery sweep — only fires on unclean shutdown so a clean
  // boot has zero overhead. Walks every project's accepted episodes,
  // finds manifest entries whose local file is missing, and pulls down
  // any provider-completed results for free (single-shot, no polling).
  // Pending tasks get picked up later via the auto-recovery path inside
  // generators on the next user click. Bounded by maxItems=50 to keep
  // first-run after a big interruption tractable; the user can use
  // Repair & Retry per-episode for anything beyond the cap.
  tasks.push(((async () => {
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
  })()).catch(e => console.error('[boot-recovery] failed:', e?.message || e)))

  // Settle the boot-complete flag once every migration task has finished
  // (resolved or rejected — we already swallow rejections above). Bound
  // the wait at 20 s so a single hung migration can't block the frontend
  // forever; if the cap fires, anything still in flight keeps running in
  // the background. 20 s is generous for the legacy-tmp sweep on big
  // iCloud projects (the slowest task) without making first-launch UX
  // feel stuck.
  const BOOT_TIMEOUT_MS = 20_000
  const settle = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[migration] boot-ready timeout after ${BOOT_TIMEOUT_MS}ms — flipping boot_complete with tasks still in flight`)
      resolve()
    }, BOOT_TIMEOUT_MS)
    timer.unref?.()
    Promise.allSettled(tasks).then(() => { clearTimeout(timer); resolve() })
  })
  settle.then(() => { _bootComplete = true })
}
