/**
 * useBrollPools — composable for the app-level B-Roll Library page.
 *
 * Thin wrapper around /api/broll-pools so the page stays focused on UI
 * state. No caching — pools change rarely and each Library mount does
 * one list call; on-disk operations (scan, normalize) are user-initiated
 * and report progress through the job queue.
 */
import { ref, computed } from 'vue'
import { useApi } from './useApi.js'

export interface BrollPool {
  id: string
  name: string
  folder_path: string
  auto_normalize: boolean
  fps_target: 24 | 30
  resolution_target: '1920x1080'
  created_at: string
  /** Server derives this from `existsSync(folder_path)` on every list call. */
  online: boolean
}

export interface BrollClip {
  filename: string
  duration: number
  width: number
  height: number
  fps: number
  size_bytes: number
  sha256: string
  normalized: boolean
  tags: string[]
  indexed_at: string
  missing?: boolean
}

export interface ScanResult {
  added: string[]
  updated: string[]
  unchanged: string[]
  missing: string[]
  errors: Array<{ filename: string; error: string }>
}

export function useBrollPools() {
  const { get, post, put, del } = useApi()

  const pools = ref<BrollPool[]>([])
  const loading = ref(false)

  async function loadPools(): Promise<void> {
    loading.value = true
    try {
      pools.value = await get<BrollPool[]>(`/broll-pools`)
    } finally {
      loading.value = false
    }
  }

  async function createPool(input: {
    name: string
    folder_path: string
    auto_normalize?: boolean
    fps_target?: 24 | 30
  }): Promise<BrollPool> {
    const created = await post<BrollPool>(`/broll-pools`, input)
    // POST returns the raw pool entity without the `online` boolean (that
    // field is derived on the list endpoint via existsSync). Reloading
    // pulls the enriched version so the Re-scan button doesn't sit
    // "offline" with a freshly-registered pool that's actually online.
    await loadPools()
    return pools.value.find(p => p.id === created.id) || created
  }

  async function updatePool(id: string, patch: Partial<Pick<BrollPool, 'name' | 'auto_normalize' | 'fps_target'>>): Promise<BrollPool> {
    const updated = await put<BrollPool>(`/broll-pools/${encodeURIComponent(id)}`, patch)
    pools.value = pools.value.map(p => p.id === id ? { ...p, ...updated } : p)
    return updated
  }

  async function deletePool(id: string): Promise<void> {
    await del(`/broll-pools/${encodeURIComponent(id)}`)
    pools.value = pools.value.filter(p => p.id !== id)
  }

  async function scanPool(id: string): Promise<ScanResult> {
    return await post<ScanResult>(`/broll-pools/${encodeURIComponent(id)}/scan`, {})
  }

  async function listClips(id: string): Promise<{ clips: BrollClip[]; online: boolean }> {
    return await get<{ clips: BrollClip[]; online: boolean }>(`/broll-pools/${encodeURIComponent(id)}/clips`)
  }

  async function setClipTags(id: string, filename: string, tags: string[]): Promise<BrollClip> {
    return await put<BrollClip>(
      `/broll-pools/${encodeURIComponent(id)}/clips/${encodeURIComponent(filename)}/tags`,
      { tags },
    )
  }

  async function normalizeClip(id: string, filename: string): Promise<{ job_id: string }> {
    return await post<{ job_id: string }>(
      `/broll-pools/${encodeURIComponent(id)}/clips/${encodeURIComponent(filename)}/normalize`,
      {},
    )
  }

  async function normalizeAll(id: string): Promise<{ queued: number; remaining: number }> {
    return await post<{ queued: number; remaining: number }>(
      `/broll-pools/${encodeURIComponent(id)}/normalize-all`,
      {},
    )
  }

  async function autotagClip(id: string, filename: string, opts?: { replace_tags?: boolean }): Promise<{ job_id: string }> {
    return await post<{ job_id: string }>(
      `/broll-pools/${encodeURIComponent(id)}/clips/${encodeURIComponent(filename)}/autotag`,
      { replace_tags: !!opts?.replace_tags },
    )
  }

  async function autotagUntagged(id: string, opts?: { force?: boolean }): Promise<{ queued: number; total_targets: number }> {
    return await post<{ queued: number; total_targets: number }>(
      `/broll-pools/${encodeURIComponent(id)}/autotag-untagged`,
      { force: !!opts?.force },
    )
  }

  function thumbnailUrl(poolId: string, filename: string): string {
    return `/api/broll-pools/${encodeURIComponent(poolId)}/clips/${encodeURIComponent(filename)}/thumbnail`
  }

  return {
    pools: computed(() => pools.value),
    loading: computed(() => loading.value),
    loadPools,
    createPool,
    updatePool,
    deletePool,
    scanPool,
    listClips,
    setClipTags,
    normalizeClip,
    normalizeAll,
    autotagClip,
    autotagUntagged,
    thumbnailUrl,
  }
}
