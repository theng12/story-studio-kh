/**
 * Hydrate the currently-selected episode's row from
 * `/projects/:slug/episodes` so pages can read `episode.status.*` as the
 * single source of truth for "is X generated?" gating.
 *
 * Why this exists: every dependent generator (image-prompts, audio,
 * metadata, video) needs to disable its Generate button when the script
 * isn't on disk yet. The architecture rule is "use episode.status.* as
 * source of truth, never local refs or preview signals" — but the
 * EpisodeSelector only emits `episode-selected` when the user picks
 * from the dropdown. Deep-links / preset-applies / programmatic id
 * changes need a separate hydration path.
 *
 * This composable wraps that pattern in one line so each page doesn't
 * copy the watcher + refetch boilerplate from scripts.vue. It also
 * re-fetches automatically when a relevant job finishes, so a Generate
 * button enables itself the moment the upstream artefact lands without
 * the user having to re-pick the episode.
 *
 * Usage:
 *   const { selectedEpisode, scriptReady, refetch } = useEpisodeStatus(
 *     toRef(form, 'episode_id'),
 *     slug,
 *     { refetchOnJobTypes: ['script-only', 'introduction-only'] },
 *   )
 *
 *   <button :disabled="!scriptReady" :title="!scriptReady ? 'Generate the script first to unlock this generator.' : ''" />
 */

import { ref, computed, watch, type Ref } from 'vue'
import { useApi } from './useApi.js'
import { useJobs } from './useJobs.js'
import { useToast } from './useToast.js'

interface UseEpisodeStatusOptions {
  /**
   * Job types whose `done` transitions should trigger a status refetch
   * for the active episode. e.g. `['script-only']` so an image-prompts
   * page re-enables its Generate button as soon as the user finishes
   * generating the script in another tab.
   */
  refetchOnJobTypes?: string[]
}

export function useEpisodeStatus(
  episodeIdRef: Ref<string>,
  slugRef: Ref<string>,
  opts: UseEpisodeStatusOptions = {},
) {
  const { get } = useApi()
  const { jobs } = useJobs()
  const { error: showError, humanizeError } = useToast()
  const selectedEpisode = ref<any>(null)

  // Convenience: the most-asked-about flag is "does the script exist?",
  // because that's the universal upstream dependency. Other consumers
  // can read selectedEpisode.value?.status?.<field> directly.
  const scriptReady = computed(() => !!selectedEpisode.value?.status?.script)

  /**
   * `quiet` skips the toast — use it for the auto-refresh path that fires
   * every time a watched job finishes. Toasting on every background poll
   * would be noise fatigue. The user-initiated paths (mount, episode
   * change) toast on failure because the operator was waiting for that
   * gating flag and silence would let them act on stale data.
   */
  async function refetch(quiet = false) {
    if (!episodeIdRef.value) {
      selectedEpisode.value = null
      return
    }
    try {
      const list = await get<any[]>(`/projects/${slugRef.value}/episodes`)
      const fresh = (list || []).find(e => e.episode_code === episodeIdRef.value)
      // Keep the previous episode rather than blanking on transient errors —
      // the user shouldn't see the gating flash open mid-edit.
      if (fresh) selectedEpisode.value = fresh
    } catch (e: any) {
      if (!quiet) {
        const raw = e?.data?.detail || e?.message || 'Failed to load episode status'
        showError(`Couldn't refresh episode "${episodeIdRef.value}": ${humanizeError(raw)}`)
      }
    }
  }

  // Hydrate on mount + every time the id changes (covers deep-links,
  // preset-apply that flips episode_id, batch resumption, etc.).
  watch(episodeIdRef, () => { void refetch() }, { immediate: true })

  // Auto-refresh when relevant jobs complete. Tracking seenDoneJobs
  // prevents re-triggering on every render of the jobs list.
  if (opts.refetchOnJobTypes && opts.refetchOnJobTypes.length) {
    const watchTypes = new Set(opts.refetchOnJobTypes)
    const seenDoneJobs = new Set<string>()
    watch(jobs, (list: readonly any[]) => {
      for (const job of list) {
        if (job.status !== 'done' || seenDoneJobs.has(job.job_id)) continue
        if (!watchTypes.has(job.type)) continue
        seenDoneJobs.add(job.job_id)
        if (job.episode_id === episodeIdRef.value) {
          void refetch(true)
        }
      }
    }, { deep: true })
  }

  return { selectedEpisode, scriptReady, refetch }
}
