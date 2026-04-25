/**
 * Detects when a project's `secrets.json` was written on a different machine
 * (user copied the folder via rsync / drag-drop instead of the Import flow).
 *
 * The backend stamps every write with a hash derived from the current user
 * + userData path, and refuses to load a store whose stamp doesn't match.
 * This composable polls the provenance status and exposes a `foreign` flag
 * that the dashboard layout uses to show a warning banner with a one-click
 * Clear-and-reset action — the tokens inside belong to a different channel
 * context and must not be silently reactivated here.
 *
 * Polls on mount, on slug change, and after a successful reset. We don't
 * poll continuously — the state changes only on a foreign folder copy
 * (rare + user-initiated) or on reset, both of which we already hook.
 */

import { ref, watch } from 'vue'
import { useApi } from './useApi.js'
import { useProject } from './useProject.js'

interface ProvenanceStatus {
  present: boolean
  foreign: boolean
}

export function useSecretsProvenance() {
  const { get, post } = useApi()
  const { slug } = useProject()

  const foreign = ref(false)
  const resetting = ref(false)

  async function checkNow() {
    const s = slug.value
    if (!s) return
    try {
      const status = await get<ProvenanceStatus>(`/projects/${s}/secrets-status`)
      foreign.value = status.foreign === true
    } catch {
      // Backend offline / project vanished — stay silent; the rest of the
      // app will surface the outage more prominently elsewhere.
      foreign.value = false
    }
  }

  async function resetSecrets(): Promise<boolean> {
    const s = slug.value
    if (!s) return false
    resetting.value = true
    try {
      await post(`/projects/${s}/secrets-reset`)
      foreign.value = false
      return true
    } catch {
      return false
    } finally {
      resetting.value = false
    }
  }

  watch(() => slug.value, () => {
    foreign.value = false
    checkNow()
  }, { immediate: true })

  return { foreign, resetting, checkNow, resetSecrets }
}
