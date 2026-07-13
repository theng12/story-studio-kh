/**
 * Boot-time migrations — idempotent, safe to run on every startup.
 *
 * Intentionally fire-and-forget: migrations that depend on disk I/O should
 * not block the server from accepting traffic. Any failure is logged but
 * doesn't prevent boot — a migration that can't run today can run tomorrow.
 */

import { migrateDescriptionToMetadata } from '../services/folder-migration.js'
import { migrateScenePlanIntoPrompts } from '../services/scene-plan-migration.js'
import { migrateAppSecrets } from './migrate-app-secrets.js'
import { cleanOrphanWorkTempDirs, cleanLegacyInProjectTempDirs } from '../lib/work-tempdir.js'
import * as pm from '../services/project-manager.js'
import { cleanupStaleUndoSidecars } from '../services/upload-renumber-undo.js'
import { cleanupStaleReseasonUndoSidecars } from '../services/upload-reseason.js'
import { migrateScheduleMapsToSidecars } from '../services/upload-schedule-migration.js'
import { proactiveRecoverySweep } from '../services/boot-recovery.js'
import { readLastSession } from '../services/last-session.js'
import {
  voiceCurationGlobalIsUnset,
  setVoicePresetsGlobal, setVoiceFavouritesGlobal,
} from '../services/app-settings.js'
import { normalizeVoicePresets } from '../services/voice-presets.js'

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
  // v1.0.311 — prime the in-memory disabled-endpoint registry from app-settings
  // so any Mac the user switched OFF in Settings is filtered out from the very
  // first dispatch/probe, not just after they next toggle it.
  tasks.push(((async () => {
    const { getAllDisabledEndpoints } = await import('../services/app-settings.js')
    const { setDisabledEndpoints } = await import('../lib/endpoint-pool.js')
    const all = await getAllDisabledEndpoints()
    for (const [providerId, urls] of Object.entries(all)) setDisabledEndpoints(providerId, urls)
  })()).catch(e => console.error('[migration] disabled-endpoints load failed:', e?.message || e)))
  tasks.push(migrateDescriptionToMetadata().catch(e => console.error('[migration] failed:', e)))
  // v1.0.467 — move legacy episode-root scene_plan.json into the "03 Scene
  // Prompts" folder. Idempotent + marker-gated; no-op after one clean pass.
  tasks.push(migrateScenePlanIntoPrompts().catch(e => console.error('[migration] scene-plan relocation failed:', e)))
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
  // (per-machine). This
  // migration runs ONCE per machine: walks every project, merges their
  // legacy lists (deduped), writes to global. Per-project fields stay
  // readable so older app builds keep working. Idempotent — gated on
  // both global keys being unset so a re-add post-migration never gets
  // reverted.
  tasks.push(((async () => {
    if (!await voiceCurationGlobalIsUnset()) return
    const projects = await pm.listProjects().catch(() => [])
    const presetInputs: unknown[] = []
    const favouriteIds = new Set<string>()
    let scannedProjects = 0
    for (const p of projects) {
      const cfg = await pm.getConfig(p.slug).catch(() => null) as any
      if (!cfg) continue
      scannedProjects++
      const presets = Array.isArray(cfg.voice_presets) ? cfg.voice_presets : []
      presetInputs.push(...presets)
      const favs = Array.isArray(cfg.voice_favourites) ? cfg.voice_favourites : []
      for (const id of favs) if (typeof id === 'string' && id.length > 0) favouriteIds.add(id)
    }
    // First display name wins while provider labels from duplicate IDs merge.
    const presets = normalizeVoicePresets(presetInputs)
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

  // v1.0.75 fix (gated by marker in v1.0.76+): the z-image image model was
  // registered with an `api_model` of `tongyi/z-image-text-to-image`, which
  // kie.ai's job API rejects. Correct identifier per kie.ai docs is the
  // literal string `z-image`. The default catalog only seeds NEW projects,
  // so existing projects have the bad value baked into their saved
  // `image_models.z-image.api_model`. This walk-and-fix migrates them.
  //
  // Marker key: `z_image_api_model_v1` in <userData>/migrations.json. Without
  // the marker, the walk re-ran on every boot — bounded by project count
  // but still N x getConfig() reads from iCloud, ~5–10 s on big projects.
  // Now: one boot, one fix, then zero overhead forever.
  tasks.push(((async () => {
    const fs = await import('fs/promises')
    const pathMod = await import('path')
    const MIGRATION_KEY = 'z_image_api_model_v1'
    const migrationsPath = pathMod.join(pm.getUserDataDir(), 'migrations.json')

    // Read marker file. If migration already ran, short-circuit immediately.
    let alreadyDone = false
    try {
      const raw = await fs.readFile(migrationsPath, 'utf-8')
      const data = JSON.parse(raw)
      if (data?.[MIGRATION_KEY]) alreadyDone = true
    } catch { /* file missing or unparsable — treat as not done */ }
    if (alreadyDone) return

    const BAD = 'tongyi/z-image-text-to-image'
    const GOOD = 'z-image'
    const projects = await pm.listProjects().catch(() => [])
    let fixed = 0
    for (const p of projects) {
      const cfg = await pm.getConfig(p.slug).catch(() => null) as any
      if (!cfg) continue
      const im = cfg.image_models
      const entry = im && typeof im === 'object' ? im['z-image'] : null
      if (!entry || entry.api_model !== BAD) continue
      const next = { ...im, 'z-image': { ...entry, api_model: GOOD } }
      await pm.updateConfig(p.slug, { image_models: next } as any).catch(() => {})
      fixed++
    }
    if (fixed > 0) {
      console.log(`[migration] z-image api_model: rewrote ${fixed} project config(s) from "${BAD}" to "${GOOD}"`)
    }

    // Mark done so subsequent boots skip the walk entirely. Best-effort —
    // a write failure here just means the migration runs again next boot
    // (still idempotent and safe).
    try {
      await fs.mkdir(pathMod.dirname(migrationsPath), { recursive: true })
      let prev: Record<string, unknown> = {}
      try {
        const raw = await fs.readFile(migrationsPath, 'utf-8')
        prev = JSON.parse(raw) || {}
      } catch { /* ignore */ }
      prev[MIGRATION_KEY] = { ranAt: new Date().toISOString(), fixed }
      await fs.writeFile(migrationsPath, JSON.stringify(prev, null, 2))
    } catch { /* marker write failure is non-fatal */ }
  })()).catch(e => console.error('[migration] z-image api_model fix failed:', e?.message || e)))

  // Item I-eager: promote per-item schedule entries from
  // `config.upload_item_schedule` into each episode's YouTube sidecar
  // so there's exactly one source of truth per episode. Per-project
  // marker (`upload_item_schedule_migrated_v1`) makes subsequent
  // boots skip the walk; orphaned entries (no matching idea) are
  // dropped, `import:*` keys are preserved in the legacy map (they
  // have no sidecar to migrate into).
  tasks.push(migrateScheduleMapsToSidecars().then((s) => {
    if (s.migratedProjects > 0 || s.totalOrphans > 0 || s.errors.length > 0) {
      console.log(
        `[migration] upload-item-schedule → sidecar: ` +
        `scanned ${s.scanned} project(s), ` +
        `${s.alreadyMigrated} already migrated, ` +
        `${s.migratedProjects} migrated this run ` +
        `(${s.totalEntriesMigrated} entries, ${s.totalOrphans} orphan(s) dropped)` +
        (s.errors.length ? ` · ${s.errors.length} error(s): ${s.errors.map(e => `${e.slug}=${e.error}`).join(', ')}` : ''),
      )
    }
  }).catch(e => console.error('[migration] upload-item-schedule failed:', e?.message || e)))

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

  // v1.0.45: same 30-day TTL for the reseason-undo sidecars. Single
  // boot-time pass keeps stale safety nets from cluttering project
  // dirs forever after the user's confidence in the change settles.
  tasks.push(cleanupStaleReseasonUndoSidecars().then((cleaned) => {
    if (cleaned.length > 0) {
      console.log(`[migration] reseason-undo: auto-cleaned ${cleaned.length} stale sidecar(s) [${cleaned.join(', ')}]`)
    }
  }).catch(e => console.error('[migration] reseason-undo cleanup failed:', e?.message || e)))

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
    void Promise.allSettled(tasks).then(() => { clearTimeout(timer); resolve() })
  })
  void settle.then(() => { _bootComplete = true })
}
