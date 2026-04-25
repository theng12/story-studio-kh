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

  // Direct-API generating states (managed manually by pages)
  const promptGenerating = useState('promptGenerating', () => false)
  const thumbPromptGenerating = useState('thumbPromptGenerating', () => false)
  const metaGenerating = useState('metaGenerating', () => false)

  // Auto-sync job-based states with the actual job queue
  if (import.meta.client) {
    const { jobs } = useJobs()

    watch(jobs, (jobList) => {
      const hasActive = (...types: string[]) =>
        jobList.some(j => types.includes(j.type) && (j.status === 'running' || j.status === 'queued'))

      // Turn OFF when no active jobs of that type remain
      // (Pages turn ON on submit — we only auto-reset here)
      if (scriptGenerating.value && !hasActive('script')) {
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
    }, { deep: true })
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
  }
}
