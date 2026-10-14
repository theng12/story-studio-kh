import { readonly, ref } from 'vue'
import { useApi } from './useApi.js'

export function useManualGenerationRedoPreference() {
  const enabled = ref(false)
  let scope: string | null = null
  let revision = 0

  async function load(scopeKey: string): Promise<boolean> {
    scope = scopeKey
    enabled.value = false
    const requestRevision = ++revision
    try {
      const response = await useApi().get<{ enabled?: unknown }>('/app-settings/manual-generation-redo')
      if (requestRevision !== revision || scope !== scopeKey) return false
      enabled.value = response?.enabled === true
      return enabled.value
    } catch {
      if (requestRevision === revision && scope === scopeKey) enabled.value = false
      return false
    }
  }

  function reset(): void {
    revision++
    scope = null
    enabled.value = false
  }

  return { enabled: readonly(enabled), load, reset }
}
