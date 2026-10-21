/**
 * The finished half of a Jobs list, read from the server.
 *
 * The live streams carry queued/running/paused rows only — a page that opened
 * them to find out what was running was paying for a channel's (or a fleet's)
 * entire past. The finished rows come from here instead: `?all=1` returns every
 * matching row in the row view, which drops the per-row log (`output_lines`,
 * the single biggest field on the wire, which no closed card renders) and
 * carries the three small fields a card does read. The endpoint pages, searches
 * and counts server-side too (`cursor`, `q`, `total`, `ids`), which is what the
 * next step — rendering one page at a time — will use.
 */
import { ref } from 'vue'
import { useApi } from './useApi.js'
import type { Job } from './useJobs.js'
import type { JobHistoryResponse } from '@shared/contracts'

/** Filters the server understands, named as the endpoint names them. */
export interface JobHistoryQuery {
  project?: string
  status?: string
  type?: string
  batch?: string
  q?: string
}

export function useJobHistory() {
  const rows = ref<Job[]>([])
  const total = ref(0)
  const loading = ref(false)
  const error = ref('')
  // Every load carries an epoch so a slow answer for an abandoned scope cannot
  // replace a newer one — the same rule the transports use for their snapshots.
  let epoch = 0

  async function load(path: string, query: JobHistoryQuery = {}): Promise<void> {
    const mine = ++epoch
    loading.value = true
    error.value = ''
    const params = new URLSearchParams({ all: '1' })
    for (const [key, value] of Object.entries(query)) if (value) params.set(key, value)
    try {
      const body = await useApi().get<JobHistoryResponse>(`${path}?${params.toString()}`)
      if (mine !== epoch) return
      rows.value = (body.jobs || []) as Job[]
      total.value = body.total || 0
    } catch (cause: any) {
      if (mine !== epoch) return
      // The history is not the live queue: a failed read must not look like an
      // empty one, or the page would claim a channel has no finished work.
      error.value = cause?.data?.detail || cause?.message || 'Could not load job history.'
      rows.value = []
      total.value = 0
    } finally {
      if (mine === epoch) loading.value = false
    }
  }

  /**
   * A delete is about to run. An answer to a load begun before it may still
   * carry the row being removed, so it must not land after the deletion.
   */
  function invalidate(): void {
    epoch++
    loading.value = false
  }

  /**
   * Drop rows the server confirmed gone. The epoch bump also discards a
   * pre-clear load still in flight; the caller reloads the authoritative list.
   */
  function removeIds(ids: Iterable<string>): void {
    const drop = new Set(ids)
    if (!drop.size) return
    invalidate()
    const kept = rows.value.filter(row => !drop.has(row.job_id))
    if (kept.length !== rows.value.length) {
      total.value = Math.max(0, total.value - (rows.value.length - kept.length))
      rows.value = kept
    }
  }

  function reset(): void {
    epoch++
    rows.value = []
    total.value = 0
    loading.value = false
    error.value = ''
  }

  return { rows, total, loading, error, load, invalidate, removeIds, reset }
}
