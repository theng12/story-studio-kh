/**
 * Global generating state — tracks which generators are active.
 *
 * Job-based generators (script, images, audio) are auto-synced with the job queue:
 *   - Pages set the state to `true` on submit (immediate sidebar pulse)
 *   - This composable watches the job list and auto-resets to `false` when no
 *     matching active jobs remain (prevents stale sidebar indicators)
 *
 * Direct-API generators (prompts, descriptions) manage their own state manually
 * via try/finally — no job queue involvement.
 */
export function useGenerating() {
  // Job-based generating states
  const scriptGenerating = useState('scriptGenerating', () => false)
  const imageGenerating = useState('imageGenerating', () => false)
  const thumbImageGenerating = useState('thumbImageGenerating', () => false)
  const audioGenerating = useState('audioGenerating', () => false)

  const audioMergeGenerating = useState('audioMergeGenerating', () => false)
  const videoGenerating = useState('videoGenerating', () => false)
  // v1.0.391 — Video Assembly (FFmpeg stitch, job type `video_assembly`) is a
  // DISTINCT generator from the AI Video Generator (job type `video`). It used
  // to share `videoGenerating`, which lit the wrong "Video Generator" nav pulse
  // while an assembly was running. Its own flag drives the Video Assembly pulse.
  const videoAssemblyGenerating = useState('videoAssemblyGenerating', () => false)

  // Direct-API generating states (managed manually by pages)
  const promptGenerating = useState('promptGenerating', () => false)
  const thumbPromptGenerating = useState('thumbPromptGenerating', () => false)
  const metaGenerating = useState('metaGenerating', () => false)

  // Auto-sync job-based states with the actual job queue.
  //
  // v1.0.72: was `watch(jobs, ..., { deep: true })`, which fired on every
  // output_lines push from a running job — hundreds of fires per second
  // during chunked listicle expansion. This composable is mounted on
  // every page (the sidebar reads scriptGenerating et al for the nav
  // pulse indicators), so its lag was the dominant cause of "I clicked
  // Expand all and now can't navigate." Switched to a signal-based
  // watcher that only fires on real status transitions, like the other
  // jobs watchers in the app.
  if (import.meta.client) {
    const { jobs } = useJobs()

    // The signal: a sorted, joined string of `${type}:${status}` for
    // every job whose type is one of the kinds we track. Active jobs
    // (queued/running) flip to done/error/cancelled cause the signal
    // to mutate; output_lines pushes don't.
    const TRACKED = new Set([
      'introduction-only', 'chapter-only', 'outline_only', 'expand_chapters',
      'images', 'scene_images', 'thumb_images', 'images_repair',
      'audio', 'audio_merge',
      'video', 'video_assembly',
    ])
    const activeSignal = computed(() =>
      jobs.value
        .filter(j => TRACKED.has(j.type))
        .map(j => `${j.type}:${j.status}`)
        .sort()
        .join('|'),
    )
    watch(activeSignal, () => {
      const hasActive = (...types: string[]) =>
        jobs.value.some(j => types.includes(j.type) && (j.status === 'running' || j.status === 'queued'))

      // Turn OFF when no active jobs of that type remain
      // (Pages turn ON on submit — we only auto-reset here)
      if (scriptGenerating.value && !hasActive('script', 'outline_only', 'expand_chapters', 'chapter-only')) {
        scriptGenerating.value = false
      }
      if (imageGenerating.value && !hasActive('images', 'scene_images')) {
        imageGenerating.value = false
      }
      if (thumbImageGenerating.value && !hasActive('images', 'thumb_images')) {
        thumbImageGenerating.value = false
      }
      if (audioGenerating.value && !hasActive('audio')) {
        audioGenerating.value = false
      }
      if (audioMergeGenerating.value && !hasActive('audio_merge')) {
        audioMergeGenerating.value = false
      }
      if (videoGenerating.value && !hasActive('video')) {
        videoGenerating.value = false
      }
      if (videoAssemblyGenerating.value && !hasActive('video_assembly')) {
        videoAssemblyGenerating.value = false
      }
    })
  }

  return {
    scriptGenerating,
    promptGenerating,
    thumbPromptGenerating,
    imageGenerating,
    thumbImageGenerating,
    audioGenerating,
    audioMergeGenerating,
    metaGenerating,
    videoGenerating,
    videoAssemblyGenerating,
  }
}
