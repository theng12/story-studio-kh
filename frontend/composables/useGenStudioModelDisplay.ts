import { readonly, ref } from 'vue'
import { useApi } from './useApi.js'
import {
  buildGenStudioModelLabelEntries,
  genStudioTtsDisplayName,
  isGenStudioModelId,
  type GenStudioDisplayCatalogEntry,
} from '../utils/genstudio-model-display.js'

const STORAGE_KEY = 'genstudio_model_display_labels_v1'
const labels = ref<Record<string, string>>({})
const loaded = ref(false)
const loading = ref(false)

function readRememberedLabels(): Record<string, string> {
  if (!import.meta.client) return {}
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function rememberLabels(next: Record<string, string>): void {
  if (!import.meta.client) return
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* best effort */ }
}

/**
 * Resolves opaque GenStudio dispatch ids into the account catalog's published
 * model names. TTS is deliberately excluded from the catalog map because its
 * customer-facing boundary is Regular, Premium, or Clone.
 */
export function useGenStudioModelDisplay() {
  const { get } = useApi()

  async function refresh(force = false): Promise<void> {
    if (loading.value || (loaded.value && !force)) return
    loading.value = true
    const remembered = { ...readRememberedLabels(), ...labels.value }
    const endpoints = [
      ['chat', '/app-settings/genstudio/chat-models'],
      ['image', '/app-settings/genstudio/image-models'],
      ['video', '/app-settings/genstudio/video-models'],
      ['transcription', '/app-settings/genstudio/transcription-models'],
    ] as const
    const results = await Promise.allSettled(endpoints.map(async ([kind, endpoint]) => {
      const response = await get<{ models?: GenStudioDisplayCatalogEntry[] }>(endpoint)
      return [kind, Array.isArray(response.models) ? response.models : []] as const
    }))
    const catalogs: Record<string, GenStudioDisplayCatalogEntry[]> = {}
    for (const result of results) {
      if (result.status === 'fulfilled') catalogs[result.value[0]] = result.value[1]
    }
    const current = Object.fromEntries(buildGenStudioModelLabelEntries(catalogs))
    labels.value = { ...remembered, ...current }
    rememberLabels(labels.value)
    loaded.value = true
    loading.value = false
  }

  function displayName(
    modelId: unknown,
    options: { tts?: boolean; ttsTier?: unknown } = {},
  ): string {
    const id = typeof modelId === 'string' ? modelId.trim() : ''
    if (options.tts) return genStudioTtsDisplayName(id, options.ttsTier)
    if (!id) return ''
    return labels.value[id] || id
  }

  function hasReadableName(modelId: unknown): boolean {
    const id = typeof modelId === 'string' ? modelId.trim() : ''
    return !!id && (!isGenStudioModelId(id) || !!labels.value[id])
  }

  return {
    labels: readonly(labels),
    loaded: readonly(loaded),
    loading: readonly(loading),
    refresh,
    displayName,
    hasReadableName,
  }
}
