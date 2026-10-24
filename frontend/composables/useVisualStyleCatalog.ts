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
  /** Every preview, hero first (at least three per signed style); `[]` for a user style with none rendered. */
  preview_images: string[]
  /** True only for a style from the owner's own user style pack — the "Your style" card. */
  user_style?: boolean
  /** Its saved previews were made from style text that has since been edited. */
  preview_stale?: boolean
}

/**
 * The two shapes a preview URL may take: a signed pack's verified asset by
 * content hash, and this Mac's own saved preview for a user style, also by
 * content hash. Both are strict — anything else (a filesystem path, a data URL,
 * a host this app never served) drops the image and, for `preview_image`,
 * the whole style, which is what keeps pack disk paths out of the renderer.
 */
const PREVIEW_URL = /^(?:\/api\/content-packs\/[a-z0-9.%_-]+\/[0-9.]+\/assets\/[a-f0-9]{64}|\/api\/user-style-previews\/assets\/[a-f0-9]{64})$/

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
    // A user style pack style (v1.4.277) with nothing rendered yet: an empty string.
    && (style.preview_image === '' || PREVIEW_URL.test(style.preview_image))
    // Stated flags only. A main process that publishes neither leaves them absent.
    && (style.user_style === undefined || typeof style.user_style === 'boolean')
    && (style.preview_stale === undefined || typeof style.preview_stale === 'boolean')
}

/**
 * `preview_images` is normalised rather than required: a style from an older main process carries
 * only `preview_image`, and a missing gallery must never drop the style from the library (a
 * filtered-out style is a silently empty picker). Unusable entries are dropped; the hero leads.
 */
function withPreviewImages(style: VisualStyleCatalogItem): VisualStyleCatalogItem {
  const listed = Array.isArray((style as Partial<VisualStyleCatalogItem>).preview_images)
    ? style.preview_images.filter(url => typeof url === 'string' && PREVIEW_URL.test(url))
    : []
  const images = style.preview_image && !listed.includes(style.preview_image) ? [style.preview_image, ...listed] : listed
  return { ...style, preview_images: images }
}

/** Reactive catalog of locally installed signed Content Pack styles and user style pack styles. */
export function useVisualStyleCatalog() {
  const { get } = useApi()
  const refresh = (): Promise<void> => {
    if (refreshPromise) return refreshPromise
    catalogLoading.value = true
    refreshPromise = (async () => {
      try {
        const response = await get<{ visual_styles?: unknown[] }>('/visual-styles', { cache: 'no-store' })
        catalogStyles.value = (response.visual_styles ?? []).filter(isVisualStyleCatalogItem).map(withPreviewImages)
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
