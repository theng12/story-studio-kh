/**
 * Manifest-sync watcher for multi-machine projects.
 *
 * On pages scoped to a specific project, this composable polls the backend
 * to see if another computer has synced in a newer `.story-studio-project.json`
 * manifest since this machine's cache was refreshed. When out-of-sync, it
 * surfaces a persistent toast with a "Reload from cloud" action; clicking it
 * calls `POST /projects/:slug/sync-from-manifest` (which overwrites project.json
 * + config.json from the manifest, preserving secrets/jobs), then refreshes
 * the in-memory project state so preset pickers etc. pick up the new values.
 *
 * Polling strategy: on mount, on window focus, and every 60s while mounted.
 * We avoid re-showing the toast while one for the same project is already
 * visible (tracked by toast id). The toast is dismissed automatically if
 * the user clicks Reload OR if a subsequent poll reports `in_sync: true`
 * (which happens once they sync manually or the external file goes stale).
 *
 * Only active when the project is multi-machine (portable=true). Local-only
 * projects skip the polling entirely — there's no manifest to reconcile.
 */

import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useApi } from './useApi.js'
import { useToast } from './useToast.js'
import { useProject } from './useProject.js'
import { FEATURE_FLAGS } from './useFeatureFlags.js'

interface ManifestStatus {
  in_sync: boolean
  external_exists: boolean
  external_mtime: number | null
  cache_mtime: number | null
  last_edited?: { machine_label: string; at: string }
}

const POLL_INTERVAL_MS = 60_000

export function useManifestSync() {
  const { get, post } = useApi()
  const { showAction, dismiss, success, error: showError } = useToast()
  const { project, slug, loadProject } = useProject()

  const inSync = ref(true)
  const remoteMachine = ref<string | undefined>()
  const remoteAt = ref<string | undefined>()
  let activeToastId: number | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null

  function fmtRemote(): string {
    const who = remoteMachine.value || 'another device'
    const when = remoteAt.value ? new Date(remoteAt.value).toLocaleString() : ''
    return when ? `${who} · ${when}` : who
  }

  async function pullAndReload() {
    const s = slug.value
    if (!s) return
    try {
      await post(`/projects/${s}/sync-from-manifest`)
      await loadProject(s)
      inSync.value = true
      success('Project reloaded from the synced manifest.')
    } catch (e: any) {
      showError(e?.data?.detail || 'Could not sync from manifest')
    }
  }

  function showOutOfSyncToast() {
    // Already showing — don't stack duplicates.
    if (activeToastId !== null) return
    activeToastId = showAction(
      `Project updated on ${fmtRemote()}.`,
      'Reload from cloud',
      async () => {
        activeToastId = null
        await pullAndReload()
      },
      'info',
    )
  }

  function clearToast() {
    if (activeToastId !== null) {
      dismiss(activeToastId)
      activeToastId = null
    }
  }

  async function checkNow() {
    const s = slug.value
    if (!s) return
    // Feature-flagged off: cloud sync is paused project-wide while the
    // subsystem is hardened. Skip the poll so existing portable projects
    // don't hit the backend either.
    if (!FEATURE_FLAGS.CLOUD_SYNC_ENABLED) return
    // Only portable projects carry a reconcilable manifest. Local-only
    // projects always report `in_sync: true` anyway, but we skip the poll
    // so we don't hit the backend unnecessarily.
    if ((project.value as any)?.portable !== true) return
    try {
      const status = await get<ManifestStatus>(`/projects/${s}/manifest-status`)
      inSync.value = status.in_sync
      remoteMachine.value = status.last_edited?.machine_label
      remoteAt.value = status.last_edited?.at
      if (status.in_sync) {
        clearToast()
      } else {
        showOutOfSyncToast()
      }
    } catch {
      // Backend offline / project vanished — stay quiet. The rest of the
      // app will surface the outage more prominently elsewhere.
    }
  }

  function onFocus() { checkNow() }

  onMounted(() => {
    // First check once the project slug is known. If the project loads
    // after mount, the watch below fires the first check; if it's already
    // loaded, the watch still runs with `immediate`.
    if (import.meta.client) {
      window.addEventListener('focus', onFocus)
    }
    pollTimer = setInterval(checkNow, POLL_INTERVAL_MS)
  })

  watch(() => slug.value, () => {
    clearToast()
    inSync.value = true
    checkNow()
  }, { immediate: true })

  onBeforeUnmount(() => {
    if (import.meta.client) {
      window.removeEventListener('focus', onFocus)
    }
    if (pollTimer) clearInterval(pollTimer)
    clearToast()
  })

  return { inSync, checkNow, pullAndReload }
}
