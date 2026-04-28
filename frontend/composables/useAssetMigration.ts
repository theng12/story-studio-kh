/**
 * Detects when a project's `output_root` (where its assets — scripts,
 * images, audio, video — physically live) is set to an absolute path
 * OUTSIDE the project's metadata folder, and exposes the data the UI
 * needs to render the recovery banner + the Project-tab move button.
 *
 * The half-migrated state we're catching:
 *   - User moved the project's metadata to iCloud via Settings →
 *     Storage → "Move projects to…" (or did so before this app's
 *     v1.0.13 augmentation that co-locates assets during the move).
 *   - The metadata is now at <iCloud>/projects/<slug>/, but the
 *     project.json's `output_root` still points at the original
 *     `~/Downloads/Story Studio/...` path.
 *   - When iCloud syncs to a second Mac, only the metadata follows.
 *     Renders fail because the absolute path doesn't exist there.
 *
 * `needs_migration` flips true when current_kind === 'absolute_external'
 * AND the asset folder is on a non-iCloud volume (heuristic: different
 * filesystem root than PROJECTS_ROOT, OR not under iCloud's mobile-
 * documents prefix). The dashboard banner uses that flag; the Project
 * tab button uses `needed` regardless of the path heuristic so users
 * can normalise output_root even when both locations are local.
 */

import { ref, watch } from 'vue'
import { useApi } from './useApi.js'
import { useProject } from './useProject.js'

export type AssetLocationKind =
  | 'relative'
  | 'absolute_inside_project_dir'
  | 'absolute_external'
  | 'unknown'

export interface AssetMigrationStatus {
  needed: boolean
  current_output_root: string
  current_kind: AssetLocationKind
  projected_target: string
  estimated_bytes?: number
  estimated_files?: number
  warnings: string[]
  blockers: string[]
}

export function useAssetMigration() {
  const { get, post } = useApi()
  const { slug } = useProject()

  const status = ref<AssetMigrationStatus | null>(null)
  const loading = ref(false)
  const migrating = ref(false)
  const lastError = ref<string>('')

  async function checkNow(): Promise<void> {
    const s = slug.value
    if (!s) return
    loading.value = true
    try {
      const r = await get<AssetMigrationStatus>(`/projects/${s}/asset-migration-status`)
      status.value = r
      lastError.value = ''
    } catch (e: any) {
      // Backend offline / project vanished — leave status null so the
      // banner stays hidden. The dashboard's other "could not fetch"
      // surfaces will pick up the outage.
      status.value = null
      lastError.value = e?.data?.detail || e?.message || 'Failed to inspect asset location'
    } finally {
      loading.value = false
    }
  }

  /**
   * Heuristic: is the current asset path on a different volume / not
   * iCloud-synced? Returns true for the "metadata in iCloud, assets on
   * local Downloads" case the recovery banner cares about.
   */
  function isProbablyUnsynced(): boolean {
    const s = status.value
    if (!s || s.current_kind !== 'absolute_external') return false
    const root = s.current_output_root
    // iCloud Drive on macOS lives under ~/Library/Mobile Documents/.
    // If the asset path is NOT under that prefix AND the projects root
    // (deduced from projected_target) IS, the assets won't sync.
    const ICLOUD_PREFIX = '/Library/Mobile Documents/'
    const projectsRootIsICloud = s.projected_target.includes(ICLOUD_PREFIX)
    const assetsAreICloud = root.includes(ICLOUD_PREFIX)
    if (projectsRootIsICloud && !assetsAreICloud) return true
    return false
  }

  async function migrate(opts: { delete_source?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
    const s = slug.value
    if (!s) return { ok: false, error: 'no project selected' }
    migrating.value = true
    lastError.value = ''
    try {
      await post(`/projects/${s}/migrate-assets`, { delete_source: !!opts.delete_source })
      // Re-check status so the UI flips back to "no migration needed".
      await checkNow()
      return { ok: true }
    } catch (e: any) {
      const msg = e?.data?.detail || e?.message || 'Migration failed'
      lastError.value = msg
      return { ok: false, error: msg }
    } finally {
      migrating.value = false
    }
  }

  // Auto-poll on slug change. Same shape as useSecretsProvenance — small
  // ref, single call, no watchers further down the tree.
  watch(() => slug.value, () => {
    status.value = null
    lastError.value = ''
    void checkNow()
  }, { immediate: true })

  return {
    status,
    loading,
    migrating,
    lastError,
    checkNow,
    migrate,
    isProbablyUnsynced,
  }
}
