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
  const { get, post, del } = useApi() as any

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
   * Hard-delete: rm -rf the folder + clear the tombstone. Frontend
   * MUST confirm with the user before calling this — it's irreversible.
   */
  async function hardDelete(slug: string): Promise<boolean> {
    try {
      if (typeof del === 'function') {
        await del(`/soft-deleted-projects/${slug}`)
      } else {
        const res = await fetch(`/api/soft-deleted-projects/${slug}`, { method: 'DELETE' })
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
