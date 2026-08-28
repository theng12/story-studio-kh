/**
 * Shared, deduplicated episode-list cache for one project slug.
 *
 * Why:
 *   `/projects/:slug/episodes` was being fetched independently from
 *   pipeline.vue, ideas.vue, EpisodeSelector.vue, scripts.vue, and
 *   useEpisodeStatus — every navigation re-walked the whole list, even
 *   though nothing had changed. With the backend cache landed, repeats
 *   are cheap (~7 ms), but a frontend cache makes them effectively free
 *   AND covers the case where two pages mount the same data simultaneously.
 *
 * Behaviour (stale-while-revalidate):
 *   - First mount for a slug → fetch; isLoading=true until it resolves.
 *   - Subsequent mounts where the cached entry is fresh (< TTL) → serve
 *     cached IMMEDIATELY (isLoading=false), then fire a background
 *     revalidate (isRevalidating=true → false on resolve).
 *   - Concurrent calls for the same slug share one in-flight promise.
 *   - TTL backstop (5 min): cache is treated as cold past that and the
 *     next mount fetches fresh, not just revalidates.
 *   - `invalidate(slug)` drops the entry; next mount refetches.
 *   - `load()` is the cached read path: serves the cached list, revalidates
 *     in the background when it is older than REVALIDATE_MIN_MS, and only
 *     blocks when the slot is cold or past TTL. It NEVER sends `?refresh=1`,
 *     so it is what passive UI events (a select gaining focus) must call.
 *   - `refresh()` forces a fresh fetch with `?refresh=1` (clears the
 *     backend cache for the project too). Reserved for the explicit
 *     refresh button — on a 300-episode project it recomputes every row.
 *
 * Module-level state intentionally — Vue composables are called per
 * instance, but the underlying Map lives once per page load. All mounters
 * of the same slug see the same reactive ref via Vue's reactivity over
 * the shared object.
 */

import { ref, computed, onMounted, watch, type Ref } from 'vue'
import { useApi } from './useApi.js'
import { useJobs } from './useJobs.js'

export interface EpisodeRow {
  episode_code: string
  title: string
  logline?: string
  suggested_chapters?: number
  suggested_length?: string
  mood?: string
  themes?: string[]
  series_formula_id?: string
  topic_pack_ids?: string[]
  idea_dimensions?: Record<string, string>
  episode_profile?: string
  scene_images: { total: number; present: number; complete: boolean }
  // Provenance + per-episode override surface (added in mark-done overhaul).
  // batch_id === 'imported' identifies YouTube imports (Situation A); the UI
  // uses it for the Source filter + bulk-by-source action. marked_done lets
  // the pipeline render a "✓ Done (manual)" pill and dim asset icons.
  // status_overrides surfaces which fields are user-pinned (annotated as
  // "(manual)") vs file-detected.
  batch_id?: string
  marked_done?: boolean
  marked_done_at?: string | null
  status_overrides?: Partial<EpisodeRow['status']> | null
  // v1.0.338 — research / scene_plan / scene_review were already sent by the
  // backend (surfaced v1.0.246 / v1.0.279) but missing here; optional since
  // they only apply to transcript-timed formats. The Record intersection
  // lets generic per-step code (EpisodeSelector's chips, filterField
  // lookups) index by string without a cast.
  status: {
    /** Research evidence exists. Claim triage remains separately visible. */
    research?: boolean
    /** Raw facts behind `research`, so the UI can distinguish "not run yet"
     *  from "run, claims still to decide" from "reviewed but nothing kept". */
    research_generated?: boolean
    research_reviewed?: boolean
    research_has_usable_claims?: boolean
    // NOTE: `research_reviewed_by` ('human' | 'pipeline-auto' | 'auto-approval') is on the
    // wire but is deliberately NOT declared here — this object is intersected
    // with Record<string, boolean | undefined> for generic per-step indexing,
    // which would collapse a string-valued member to `never`. Read it with a
    // cast at the one place that renders it.
    scene_plan?: boolean
    scene_review?: boolean
    motion_review?: boolean
    character_sheet?: boolean
    broll_picked?: boolean
    script: boolean
    introduction: boolean
    prompts: boolean
    scene_prompts: boolean
    thumb_prompts: boolean
    images: boolean
    thumbnails: boolean
    audio: boolean
    merged_audio: boolean
    subtitles?: boolean
    video: boolean
    video_assembly: boolean
    video_ready: boolean
    publishable: boolean
    metadata: boolean
    all_done: boolean
  } & Record<string, boolean | undefined>
}

interface SharedSlot {
  data: Ref<EpisodeRow[]>
  isLoading: Ref<boolean>
  isRevalidating: Ref<boolean>
  error: Ref<unknown>
  fetchedAt: Ref<number>
  /** In-flight fetch promise (shared by concurrent callers). */
  inflight: Promise<EpisodeRow[]> | null
  /** Monotonic request id so an older response cannot overwrite a mutation refresh. */
  requestSeq: number
}

const TTL_MS = 5 * 60 * 1000  // 5 minutes — past this, treat as cold
const REVALIDATE_MIN_MS = 15 * 1000
const slots = new Map<string, SharedSlot>()

function getOrCreateSlot(slug: string): SharedSlot {
  let slot = slots.get(slug)
  if (!slot) {
    slot = {
      data: ref<EpisodeRow[]>([]),
      isLoading: ref(false),
      isRevalidating: ref(false),
      error: ref<unknown>(null),
      fetchedAt: ref(0),
      inflight: null,
      requestSeq: 0,
    }
    slots.set(slug, slot)
  }
  return slot
}

/** Drop the cached entry for a slug. Next mount refetches from scratch. */
export function invalidateEpisodes(slug: string): void {
  const slot = slots.get(slug)
  if (!slot) return
  slot.fetchedAt.value = 0
  slot.error.value = null
  // Don't blank slot.data — let consumers keep showing the previous list
  // until the next refetch lands. Clearing here would cause an empty-state
  // flash on every invalidation.
}

interface UseEpisodesOptions {
  /**
   * Job types whose `done` transitions should invalidate this slug's
   * cache. e.g. ['script-only', 'image_prompts'] — completing a script
   * for an episode flips its status, so the next read should refresh.
   * Defaults to ALL job types (broad but safe — backend cache shoulders
   * the cost of an unnecessary revalidate).
   */
  invalidateOnJobTypes?: string[] | true
}

export function useEpisodes(slug: string | Ref<string>, opts: UseEpisodesOptions = {}) {
  const slugRef = typeof slug === 'string' ? ref(slug) : slug
  const { get } = useApi()
  // useJobs is module-scoped: if no one has called startPolling(slug),
  // jobs.value stays []. So mounting in a unit-test context is safe — the
  // watcher just never fires.
  const { jobs } = useJobs()

  function currentSlot(): SharedSlot {
    return getOrCreateSlot(slugRef.value)
  }

  async function fetchOnce(force: boolean | 'rescan' | 'mutation'): Promise<EpisodeRow[]> {
    const slot = currentSlot()
    if (slot.inflight && !force) return slot.inflight

    const path = force === 'rescan'
      ? `/projects/${slugRef.value}/episodes?rescan=1`
      : force === 'mutation'
        ? `/projects/${slugRef.value}/episodes?mutation=${Date.now()}`
      : force
        ? `/projects/${slugRef.value}/episodes?refresh=1`
        : `/projects/${slugRef.value}/episodes`
    const requestId = ++slot.requestSeq

    const promise = (async () => {
      try {
        const list = await get<EpisodeRow[]>(path)
        // A mutation refresh deliberately bypasses an older in-flight read.
        // Only the newest request may publish data, otherwise the older response
        // can make a successfully toggled step look pending again.
        if (requestId === slot.requestSeq) {
          slot.data.value = list || []
          slot.fetchedAt.value = Date.now()
          slot.error.value = null
        }
        return list || []
      } catch (e) {
        if (requestId === slot.requestSeq) slot.error.value = e
        // Don't blank existing data on transient failures — caller can read
        // .error to surface it without losing the previously-loaded list.
        throw e
      } finally {
        if (slot.inflight === promise) slot.inflight = null
        if (requestId === slot.requestSeq) {
          slot.isLoading.value = false
          slot.isRevalidating.value = false
        }
      }
    })()
    slot.inflight = promise
    return promise
  }

  async function load() {
    const slot = currentSlot()
    const age = slot.fetchedAt.value > 0 ? Date.now() - slot.fetchedAt.value : Infinity
    const fresh = age < TTL_MS
    if (slot.data.value.length > 0 && fresh) {
      // Show cached immediately. Avoid another project-wide status request
      // when several controls mount within the same navigation burst.
      if (age < REVALIDATE_MIN_MS) return
      slot.isRevalidating.value = true
      fetchOnce(false).catch(() => { /* error already stored on slot */ })
      return
    }
    // Cold or expired — block on the fetch. Show loading state.
    slot.isLoading.value = true
    try { await fetchOnce(false) } catch { /* error stored */ }
  }

  /** User-initiated explicit refresh — bypasses cache, forces backend recompute. */
  async function refresh() {
    const slot = currentSlot()
    slot.isRevalidating.value = true
    try { await fetchOnce(true) } catch { /* error stored */ }
  }

  /**
   * v1.0.338 — light refetch (NO ?refresh=1). The backend serves its
   * mtime-cached status for unchanged episodes and recomputes only entries
   * something surgically invalidated (e.g. the status-overrides PATCH or an
   * asset import). Use after single-episode mutations: refresh() would
   * force a full recompute of every episode — a 300-episode disk sweep —
   * to pick up a one-row change.
   */
  async function revalidate() {
    const slot = currentSlot()
    slot.isRevalidating.value = true
    try { await fetchOnce(false) } catch { /* error stored */ }
  }

  /**
   * Re-read after a successful single-episode mutation. This must not join an
   * older in-flight request that started before the mutation was saved.
   */
  async function revalidateAfterMutation(): Promise<EpisodeRow[]> {
    const slot = currentSlot()
    slot.isRevalidating.value = true
    return await fetchOnce('mutation')
  }

  /** Publish a confirmed mutation immediately to every mounted selector/board. */
  function updateEpisode(
    episodeCode: string,
    updater: (episode: EpisodeRow) => EpisodeRow,
  ): EpisodeRow | null {
    const slot = currentSlot()
    const index = slot.data.value.findIndex(ep => ep.episode_code === episodeCode)
    if (index < 0) return null
    const updated = updater(slot.data.value[index])
    const next = slot.data.value.slice()
    next[index] = updated
    slot.data.value = next
    return updated
  }

  /**
   * Heavier "Rescan from disk" — wipes the backend's on-disk cache file
   * for this project too, so the next pass is guaranteed to readdir
   * every episode folder fresh. Use when files changed on disk but the
   * UI hasn't caught up.
   */
  async function rescan() {
    const slot = currentSlot()
    slot.isRevalidating.value = true
    try { await fetchOnce('rescan') } catch { /* error stored */ }
  }

  /** Drop the cache for the current slug. Next access refetches. */
  function invalidate() {
    invalidateEpisodes(slugRef.value)
  }

  // The slot persists across unmounts, so a remount immediately sees the
  // cached list; mounting only has to kick the (cached) read.
  onMounted(() => {
    void load()
  })

  // If the slug ref changes (rare for episode-list pages, but cheap), refetch.
  watch(slugRef, () => {
    void load()
  })

  // Auto-invalidate on relevant job completions. Tracking seen job IDs
  // prevents re-firing on every render when the jobs list mutates.
  //
  // v1.0.72: switched from `watch(jobs, ..., { deep: true })` to a derived
  // status-signal computed. The deep watch fired on every output_lines
  // push from a running job — for chunked listicle expansion that's
  // hundreds of fires per second, which (combined with similar deep
  // watches in other composables and panels) starved the UI thread of
  // navigation events. The signal only changes on real status transitions,
  // so this watcher fires once per terminal completion, not per progress
  // update.
  const seenDoneJobs = new Set<string>()
  const watchAll = opts.invalidateOnJobTypes === true || opts.invalidateOnJobTypes === undefined
  const allowedTypes = watchAll ? null : new Set(opts.invalidateOnJobTypes as string[])
  const jobsSignal = computed(() =>
    jobs.value
      .filter(j =>
        j.project_slug === slugRef.value &&
        (allowedTypes === null || allowedTypes.has(j.type)),
      )
      .map(j => `${j.job_id}:${j.status}`)
      .sort()
      .join('|'),
  )
  watch(jobsSignal, () => {
    for (const job of jobs.value) {
      if (job.status !== 'done' || seenDoneJobs.has(job.job_id)) continue
      if (allowedTypes !== null && !allowedTypes.has(job.type)) continue
      if (job.project_slug !== slugRef.value) continue
      seenDoneJobs.add(job.job_id)
      invalidate()
      void load()
      return  // one invalidation per signal tick is enough
    }
  })

  const slot = currentSlot()
  return {
    episodes: slot.data,
    isLoading: slot.isLoading,
    isRevalidating: slot.isRevalidating,
    error: slot.error,
    isStale: computed(() => {
      const t = slot.fetchedAt.value
      return t === 0 || (Date.now() - t) > TTL_MS
    }),
    load,
    refresh,
    revalidate,
    revalidateAfterMutation,
    rescan,
    invalidate,
    updateEpisode,
  }
}
