/**
 * Reactive bridge to the soft-delete registry. Powers:
 *
 *   - All Projects page → "🗑️ Hidden projects (N)" chip + expandable
 *     panel with [Restore] [Open in Finder] [Delete from disk] per row.
 *
 * Soft-deleted projects are slugs the user removed via Settings →
 * Danger Zone → Hide project. The folder stays on disk until the user
 * explicitly clicks "Delete from disk." Restoring the slug re-shows it
 * in the live project list.
 */

import { ref } from 'vue'
import { useApi } from './useApi.js'

export interface SoftDeletedProjectInfo {
  slug: string
  name: string
  path: string
  exists: boolean
  is_default_location: boolean
  estimated_bytes: number
  deleted_at?: string
}

export function useSoftDeletedProjects() {
  const { get, post, del } = useApi()

  const items = ref<SoftDeletedProjectInfo[]>([])
  const loading = ref(false)
  const lastError = ref<string>('')

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const r = await get<{ projects: SoftDeletedProjectInfo[] }>('/soft-deleted-projects')
      items.value = Array.isArray(r?.projects) ? r.projects : []
      lastError.value = ''
    } catch (e: any) {
      lastError.value = e?.data?.detail || e?.message || 'Failed to load hidden projects'
    } finally {
      loading.value = false
    }
  }

  /**
   * Restore a hidden slug → it re-appears in the live project list and
   * the chip count drops by one.
   */
  async function restore(slug: string): Promise<boolean> {
    try {
      await post(`/soft-deleted-projects/${slug}/restore`, {})
      await refresh()
      return true
    } catch (e: any) {
      lastError.value = e?.data?.detail || e?.message || 'Failed to restore project'
      return false
    }
  }

  /**
   * Hard-delete: rm -rf the folder + clear the tombstone. Irreversible, so the size the person
   * confirmed travels with the request and the server compares it against what it measures now —
   * a confirmation the server never sees is not a guard (row `20261120-161`).
   */
  async function hardDelete(item: Pick<SoftDeletedProjectInfo, 'slug' | 'estimated_bytes'>): Promise<boolean> {
    const confirmedBytes = Number(item?.estimated_bytes)
    if (!Number.isSafeInteger(confirmedBytes) || confirmedBytes < 0) {
      lastError.value = 'The size of that channel could not be measured, so nothing was deleted.'
      return false
    }
    try {
      const body = { confirm: true, expected_bytes: confirmedBytes }
      if (typeof del === 'function') {
        await del(`/soft-deleted-projects/${item.slug}`, { body })
      } else {
        const res = await fetch(`/api/soft-deleted-projects/${item.slug}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      }
      await refresh()
      return true
    } catch (e: any) {
      lastError.value = e?.data?.detail || e?.message || 'Failed to permanently delete'
      return false
    }
  }

  async function revealInFinder(absPath: string): Promise<boolean> {
    try {
      await post('/system/reveal-folder', { path: absPath })
      return true
    } catch (e: any) {
      lastError.value = e?.data?.detail || e?.message || 'Could not open Finder'
      return false
    }
  }

  return {
    items,
    loading,
    lastError,
    refresh,
    restore,
    hardDelete,
    revealInFinder,
  }
}
