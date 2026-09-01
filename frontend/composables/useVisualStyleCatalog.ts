import { readonly, ref, shallowReadonly, shallowRef } from 'vue'
import { useApi } from './useApi'

export interface VisualStyleCatalogItem {
  id: string
  name: string
  builtin: true
  blurb: string
  category: string
  tags: string[]
  data: {
    style_bible: string
    negative_prompt: string
  }
  preview_image: string
}

const catalogStyles = shallowRef<VisualStyleCatalogItem[]>([])
const catalogLoading = ref(false)
const catalogError = ref<string | null>(null)
let refreshPromise: Promise<void> | null = null

function isVisualStyleCatalogItem(value: unknown): value is VisualStyleCatalogItem {
  if (!value || typeof value !== 'object') return false
  const style = value as Partial<VisualStyleCatalogItem>
  const data = style.data as Partial<VisualStyleCatalogItem['data']> | undefined
  return typeof style.id === 'string' && !!style.id
    && typeof style.name === 'string' && !!style.name
    && style.builtin === true
    && typeof style.blurb === 'string'
    && typeof style.category === 'string' && !!style.category.trim()
    && Array.isArray(style.tags) && style.tags.every(tag => typeof tag === 'string')
    && typeof data?.style_bible === 'string'
    && typeof data?.negative_prompt === 'string'
    && typeof style.preview_image === 'string'
    && /^\/api\/content-packs\/[a-z0-9.%_-]+\/[0-9.]+\/assets\/[a-f0-9]{64}$/.test(style.preview_image)
}

/** Reactive catalog of locally installed, signed Content Pack styles. */
export function useVisualStyleCatalog() {
  const { get } = useApi()
  const refresh = (): Promise<void> => {
    if (refreshPromise) return refreshPromise
    catalogLoading.value = true
    refreshPromise = (async () => {
      try {
        const response = await get<{ visual_styles?: unknown[] }>('/visual-styles', { cache: 'no-store' })
        catalogStyles.value = (response.visual_styles ?? []).filter(isVisualStyleCatalogItem)
        catalogError.value = null
      } catch (error: unknown) {
        catalogStyles.value = []
        catalogError.value = error instanceof Error ? error.message : 'Visual style catalog is unavailable.'
      } finally {
        catalogLoading.value = false
        refreshPromise = null
      }
    })()
    return refreshPromise
  }
  return {
    styles: shallowReadonly(catalogStyles),
    loading: readonly(catalogLoading),
    error: readonly(catalogError),
    refresh,
  }
}

export function _resetVisualStyleCatalogForTests(): void {
  catalogStyles.value = []
  catalogLoading.value = false
  catalogError.value = null
  refreshPromise = null
}
