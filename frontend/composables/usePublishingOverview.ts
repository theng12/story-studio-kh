/**
 * The global Publishing Overview's data.
 *
 * One GET builds the whole page (`/publishing/overview`) — it reads local
 * stores only and never touches YouTube, so rendering costs no quota. The one
 * provider call is `refresh()`, which the owner presses deliberately: it reuses
 * the existing read-only per-channel sync (`POST /projects/:slug/youtube/sync`)
 * and never writes to YouTube.
 *
 * Module-scoped so the page and any future header count share one load, and a
 * re-render can never fire a fetch on its own.
 */

import { ref } from 'vue'
import { useApi } from './useApi.js'
import { swrForceRefresh } from '../utils/swrCache'
import { loadPublishingTimelineStages } from '../utils/loadPublishingTimelineStages'
import type { PublishingOverviewResponse } from '@shared/publishing-overview'

const overview = ref<PublishingOverviewResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const refreshing = ref(false)
let inFlight: Promise<PublishingOverviewResponse | null> | null = null

export function usePublishingOverview() {
  const { get, post } = useApi()

  /** Read the overview, once. Concurrent callers share one request. */
  async function load(force = false): Promise<PublishingOverviewResponse | null> {
    if (overview.value && !force) return overview.value
    if (inFlight && !force) return inFlight
    loading.value = true
    error.value = null
    inFlight = (async () => {
      try {
        // "Check YouTube now" must go to the network AND leave the freshness
        // line able to say the truth about what it then shows — so the stored
        // answer is dropped from the shared cache rather than the read stepping
        // around the cache and leaving it a version behind the page.
        if (force) swrForceRefresh('GET:/publishing/overview')
        overview.value = await get<PublishingOverviewResponse>('/publishing/overview')
        return overview.value
      } catch (e: any) {
        // Never strand the page: an unreadable overview is a message, not a
        // blank screen.
        error.value = e?.data?.detail || e?.message || 'Could not load the publishing overview.'
        return null
      } finally {
        loading.value = false
        inFlight = null
      }
    })()
    return inFlight
  }

  /**
   * Ask YouTube about every assigned channel's uploads, then re-read.
   *
   * Deliberate and read-only: it reuses the existing per-channel sync, which
   * only READS publication state. Channels without an assigned YouTube account
   * are skipped — there is nothing to ask. Never called on render.
   */
  async function refresh(): Promise<PublishingOverviewResponse | null> {
    refreshing.value = true
    try {
      const current = overview.value ?? await load()
      const assigned = (current?.channels ?? []).filter(channel => channel.channel)
      for (const channel of assigned) {
        try {
          await post(`/projects/${encodeURIComponent(channel.slug)}/youtube/schedule-refresh`, {})
        } catch { /* one channel failing must not stop the others; its row shows the failed read */ }
        try {
          await post(`/projects/${encodeURIComponent(channel.slug)}/youtube/sync`, {})
        } catch { /* one channel failing must not stop the others; its freshness shows stale/unknown */ }
      }
      return await load(true)
    } finally {
      refreshing.value = false
    }
  }

  async function loadTimelineStages(isVisible: () => boolean): Promise<void> {
    const current = overview.value
    if (!current) return
    await loadPublishingTimelineStages(current.channels, path => get(path), () => overview.value === current && isVisible())
  }

  return { overview, loading, error, refreshing, load, refresh, loadTimelineStages }
}
