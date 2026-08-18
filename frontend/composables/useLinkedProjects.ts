/**
 * Reactive bridge to the backend's linked-projects registry. Powers:
 *
 *   - Project tab → "Move this project to…" dialog
 *   - Project tab → "Unlink from this Mac"
 *
 * The registry is per-Mac (stored in app-settings.json on the backend).
 * That means different Macs can each link a different subset of project
 * folders — Mac A can link only one channel from iCloud while Mac B
 * links several. This composable just shows what the current Mac knows
 * about.
 *
 * ── `add()` has no caller, and is kept deliberately (v1.4.2) ──
 *
 * It POSTs `/linked-projects`, which was the "Add existing project folder…"
 * picker on the All Projects page. That button was removed on 2026-08-08 and
 * `frontend/__tests__/channelCreationFlow.test.ts` asserts it stays removed, so
 * `add()` currently has zero callers.
 *
 * It is KEPT rather than deleted because the backend route is the only way to
 * register a project folder that lives OUTSIDE the projects root, and the
 * filesystem scan that replaced the picker cannot do that — it only reads the
 * projects root. Deleting this would remove the mechanism as well as the
 * button, and `moveProject` still creates linked projects that this registry
 * has to describe. Cross-Mac discovery is now "put the folder in your projects
 * folder"; this remains the escape hatch for a folder that cannot move.
 *
 * If a future release restores an out-of-tree picker, this is what it calls.
 * Do not describe it in UI text meanwhile — there is no button to press.
 */

import { ref } from 'vue'
import { useApi } from './useApi.js'

export interface LinkedProjectInfo {
  path: string
  exists: boolean
  slug?: string
  name?: string
  reason?: string
  /**
   * Populated when the user picked a *parent* folder by mistake — names
   * each Story Studio project found one level deep so the UI can offer
   * "did you mean…?" chips.
   */
  suggestions?: Array<{ path: string; slug: string; name: string }>
}

export interface ProjectMoveStatus {
  current_path: string
  is_default_location: boolean
  is_linked: boolean
  estimated_bytes: number
  estimated_files: number
  icloud_blockers: string[]
}

export interface ProjectMoveResult {
  slug: string
  new_path: string
  old_path: string
  source_disposition: 'deleted' | 'renamed' | 'kept_at_linked'
  renamed_source_path?: string
  copied_files: number
  copied_bytes: number
  warnings: string[]
}

export function useLinkedProjects() {
  const { get, post, del } = useApi()

  const linked = ref<LinkedProjectInfo[]>([])
  const loading = ref(false)
  const lastError = ref<string>('')

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const r = await get<{ projects: LinkedProjectInfo[] }>('/linked-projects')
      linked.value = Array.isArray(r?.projects) ? r.projects : []
      lastError.value = ''
    } catch (e: any) {
      // Backend offline — keep stale list, surface error so UI can warn.
      lastError.value = e?.data?.detail || e?.message || 'Failed to load linked projects'
    } finally {
      loading.value = false
    }
  }

  /**
   * Pre-flight check on a candidate folder. Returns the same shape as
   * a successful add (slug, name, etc.) — or { reason } on rejection.
   * Used by the picker dialog to show "is this a Story Studio project?"
   * before committing.
   */
  async function inspect(absPath: string): Promise<LinkedProjectInfo> {
    return await post<LinkedProjectInfo>('/linked-projects/inspect', { path: absPath })
  }

  async function add(absPath: string): Promise<LinkedProjectInfo> {
    const info = await post<LinkedProjectInfo>('/linked-projects', { path: absPath })
    await refresh()
    return info
  }

  /**
   * Remove a path from the registry. Doesn't touch the folder on disk.
   * Most useApi instances expose `del`; if not, we fall back to fetch.
   */
  async function remove(absPath: string): Promise<boolean> {
    try {
      if (typeof del === 'function') {
        await del('/linked-projects', { body: { path: absPath } })
      } else {
        const res = await fetch('/api/linked-projects', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: absPath }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      }
      await refresh()
      return true
    } catch (e: any) {
      lastError.value = e?.data?.detail || e?.message || 'Failed to unlink project'
      return false
    }
  }

  // Per-project move
  async function getMoveStatus(slug: string): Promise<ProjectMoveStatus> {
    return await get<ProjectMoveStatus>(`/projects/${slug}/move-status`)
  }

  async function moveProject(
    slug: string,
    destination: string,
    opts: { delete_source?: boolean } = {},
  ): Promise<ProjectMoveResult> {
    const r = await post<ProjectMoveResult>(`/projects/${slug}/move-to-folder`, {
      destination,
      delete_source: !!opts.delete_source,
    })
    await refresh()
    return r
  }

  return {
    linked,
    loading,
    lastError,
    refresh,
    inspect,
    add,
    remove,
    getMoveStatus,
    moveProject,
  }
}
