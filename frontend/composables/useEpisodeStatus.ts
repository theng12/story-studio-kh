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
 *   const { selectedEpisode, scriptReady, statusKnown, refetch } = useEpisodeStatus(
 *     toRef(form, 'episode_id'),
 *     slug,
 *     { refetchOnJobTypes: ['script-only', 'introduction-only'] },
 *   )
 *
 *   <button :disabled="!scriptReady"
 *           :title="!statusKnown ? 'Checking script status…'
 *                   : !scriptReady ? 'Generate the script first to unlock this generator.' : ''" />
 *
 * IMPORTANT — `scriptReady` is false in TWO different situations the UI must
 * NOT conflate: (a) status is loaded and the script is genuinely missing, and
 * (b) status hasn't loaded yet (mount, episode just changed, or a transient
 * `/episodes` error). Showing the definitive "Generate the script first"
 * message during (b) is the v1.0.296-fixed bug: a heavy /episodes response on
 * a large project (150+ episodes) left the gate flashing the alarming copy for
 * seconds even though the script was on disk. Gate the COPY on `statusKnown`:
 * only assert "no script" once `statusKnown` is true. Keep gating the button
 * disabled on `!scriptReady` (we can't generate without a confirmed script),
 * but say "Checking…" until we actually know.
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
  let activeScope: { projectSlug: string; episodeCode: string } | null = null
  let requestSequence = 0

  // `statusKnown` = "we have a confirmed status for the CURRENTLY-selected
  // episode id". It starts false, flips true once a refetch successfully
  // resolves the selected episode, and resets to false the instant the id
  // changes (so the gate shows "Checking…" for the new episode rather than
  // briefly asserting the previous episode's answer). It also stays false
  // after a transient fetch error that we couldn't recover from — better to
  // say "checking" than to falsely claim "no script". See the header note.
  const statusKnown = ref(false)

  // Convenience: the most-asked-about flag is "does the script exist?",
  // because that's the universal upstream dependency. Other consumers
  // can read selectedEpisode.value?.status?.<field> directly. A row from the
  // previous scope must never count while the current scope is still unknown.
  const scriptReady = computed(() => statusKnown.value && !!selectedEpisode.value?.status?.script)

  /**
   * `quiet` skips the toast — use it for the auto-refresh path that fires
   * every time a watched job finishes. Toasting on every background poll
   * would be noise fatigue. The user-initiated paths (mount, episode
   * change) toast on failure because the operator was waiting for that
   * gating flag and silence would let them act on stale data.
   *
   * The `?invalidate=CODE` parameter drops just THIS episode's cache entry
   * server-side before recomputing — surgically forces a re-stat of the
   * selected episode's watched folders. Without this, an externally-written
   * script docx whose folder mtime didn't bump would leave status.script
   * stale at false until the user manually shift-clicked the global ↻
   * button (full project rescan, expensive). Per-episode invalidate is
   * cheap (one extra getConfig + a few fs.stat calls) and catches the
   * externally-written-file case automatically.
   */
  async function refetch(quiet = false) {
    const projectSlug = slugRef.value
    const code = episodeIdRef.value
    const request = ++requestSequence
    const previousScope = activeScope
    activeScope = projectSlug && code ? { projectSlug, episodeCode: code } : null
    const isCurrentRequest = () =>
      request === requestSequence
      && slugRef.value === projectSlug
      && episodeIdRef.value === code

    if (!projectSlug || !code) {
      selectedEpisode.value = null
      statusKnown.value = false
      return
    }
    // A change of episode means the previous episode's status no longer
    // describes what's selected — clear it so both the data and the gate show
    // "unknown" rather than briefly exposing the old episode's answer.
    if ((previousScope !== null
      && (previousScope.projectSlug !== projectSlug || previousScope.episodeCode !== code))
        || selectedEpisode.value?.episode_code !== code) {
      selectedEpisode.value = null
      statusKnown.value = false
    }

    // Bounded retry: an occasional blip (filesystem stat churn, a busy event loop)
    // shouldn't strand the gate in a state the user reads as "no script". Two
    // quick retries with backoff, then give up and surface the error
    // (non-quiet path only).
    //
    // v1.0.299 — hit the SINGLE-episode status endpoint, NOT the whole
    // /episodes list. The list recomputes status for every accepted idea
    // (~230s on a 384-episode project), which left this gate stuck on
    // "Checking…" forever. The per-episode endpoint is ~600ms cold.
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!isCurrentRequest()) return
      try {
        const data = await get<any>(
          `/projects/${projectSlug}/episodes/${encodeURIComponent(code)}/status?invalidate=1`,
          { cache: 'no-store' },
        )
        // Race guard: if the user switched episodes while this request was in
        // flight, discard the stale result — applying it would show episode
        // A's status under episode B's selection.
        if (!isCurrentRequest()) return
        if (data && data.episode_code) {
          selectedEpisode.value = data
          statusKnown.value = true   // confirmed: we now know this episode's status
        } else {
          // Shouldn't happen (endpoint always echoes the code), but guard:
          // leave statusKnown false so the gate stays "Checking…" rather than
          // flipping to the alarming definitive "no script" message.
          statusKnown.value = false
        }
        return
      } catch (e: any) {
        if (!isCurrentRequest()) return  // superseded; stop retrying
        if (attempt < maxAttempts) {
          await new Promise(r => setTimeout(r, attempt * 400))
          if (!isCurrentRequest()) return
          continue
        }
        // Exhausted retries. Keep a previously confirmed status for this same
        // scope, but leave unknown scopes blank and visibly unconfirmed.
        if (!isCurrentRequest()) return
        if (!quiet) {
          const raw = e?.data?.detail || e?.message || 'Failed to load episode status'
          showError(`Couldn't refresh episode "${code}": ${humanizeError(raw)}`)
        }
      }
    }
  }

  // Hydrate on mount + every time the id changes (covers deep-links,
  // preset-apply that flips episode_id, batch resumption, etc.).
  watch([slugRef, episodeIdRef], () => { void refetch() }, { immediate: true, flush: 'sync' })

  // Auto-refresh when relevant jobs complete. Tracking seenDoneJobs
  // prevents re-triggering on every render of the jobs list.
  //
  // v1.0.72: switched from `watch(jobs, ..., { deep: true })` to a status
  // signal — same UI-thread starvation fix as useEpisodes. The deep watch
  // fired on every output_lines push from running jobs, blocking sidebar
  // navigation during chunked expansion.
  if (opts.refetchOnJobTypes && opts.refetchOnJobTypes.length) {
    const watchTypes = new Set(opts.refetchOnJobTypes)
    const seenDoneJobs = new Set<string>()
    const statusSignal = computed(() =>
      jobs.value
        .filter(j => watchTypes.has(j.type) && j.episode_id === episodeIdRef.value)
        .map(j => `${j.job_id}:${j.status}`)
        .sort()
        .join('|'),
    )
    watch(statusSignal, () => {
      for (const job of jobs.value) {
        if (job.status !== 'done' || seenDoneJobs.has(job.job_id)) continue
        if (!watchTypes.has(job.type)) continue
        if (job.episode_id !== episodeIdRef.value) continue
        seenDoneJobs.add(job.job_id)
        void refetch(true)
        return
      }
    })
  }

  return { selectedEpisode, scriptReady, statusKnown, refetch }
}
