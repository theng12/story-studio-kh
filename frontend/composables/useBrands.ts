/**
 * Brand resource client. Wraps /api/brands + the per-project brand setter.
 *
 * Brands live above projects in the resolution chain. One brand per channel
 * carries channel name, narrator persona, default voice, logo, brand-style
 * keywords for visual prompts. Future hooks (pronunciation lexicon, analytics
 * persona, comment-reply tone) hang off this object.
 *
 * Mirrors the shape of usePresets — loading/error refs + actions.
 */

import type { Brand } from '@shared/contracts'

export interface BrandWithStats extends Brand {
  /** How many projects currently reference this brand. */
  project_count: number
}

export function useBrands() {
  const api = useApi()
  const brands = ref<BrandWithStats[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await api.get<{ brands: BrandWithStats[] }>('/brands')
      brands.value = res.brands || []
    } catch (e: any) {
      error.value = e?.data?.detail || e?.message || 'Failed to load brands'
      brands.value = []
    } finally {
      loading.value = false
    }
  }

  async function loadOne(id: string): Promise<Brand | null> {
    try {
      return await api.get<Brand>(`/brands/${encodeURIComponent(id)}`)
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.status === 404) return null
      throw e
    }
  }

  async function create(brand: Brand): Promise<Brand> {
    return await api.post<Brand>('/brands', brand)
  }

  async function update(brand: Brand): Promise<Brand> {
    return await api.put<Brand>(`/brands/${encodeURIComponent(brand.id)}`, brand)
  }

  async function remove(id: string): Promise<{ ok: true; id: string } | { conflict: true; referencing_projects: string[] }> {
    try {
      return await api.del<{ ok: true; id: string }>(`/brands/${encodeURIComponent(id)}`)
    } catch (e: any) {
      if (e?.statusCode === 409 && Array.isArray(e?.data?.referencing_projects)) {
        return { conflict: true, referencing_projects: e.data.referencing_projects }
      }
      throw e
    }
  }

  async function setProjectBrand(slug: string, brandId: string | null): Promise<void> {
    await api.put(`/projects/${encodeURIComponent(slug)}/brand`, { brand_id: brandId })
  }

  function blank(id: string = ''): Brand {
    return {
      id,
      name: '',
      schemaVersion: 1,
      channel: {},
      visual: {},
      narration: {},
      imagePrompts: { style_keywords: [] },
      metadata: { banned_words: [] },
    }
  }

  return {
    brands,
    loading,
    error,
    loadAll,
    loadOne,
    create,
    update,
    remove,
    setProjectBrand,
    blank,
  }
}
