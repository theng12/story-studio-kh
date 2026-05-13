<template>
  <div class="form-group">
    <label>
      Episode
      <!-- v1.0.48: episode-count badge — confirms scope ("X loaded") so
           large projects (TerraNash has 380+) make slow loads feel
           legitimate instead of like the app is hung. -->
      <span v-if="!loading && episodes.length" class="ep-count">· {{ episodes.length }} loaded</span>
      <span v-else-if="loading" class="ep-loading-inline">
        <span class="ep-spinner" aria-hidden="true" />
        Loading episodes… {{ elapsedLabel }}
      </span>
    </label>
    <div class="toggle-row">
      <button :class="['toggle-btn', { active: !showAll }]" @click="showAll = false">Pending only</button>
      <button :class="['toggle-btn', { active: showAll }]" @click="showAll = true">Show all</button>
      <button
        class="toggle-btn refresh-btn"
        :disabled="loading"
        @click="onRefreshClick"
        :title="loading ? 'Loading…' : 'Refresh (shift-click to rescan from disk — slower, use after iCloud sync)'"
      >
        {{ loading || isRevalidating ? '…' : '↻' }}
      </button>
    </div>
    <select
      :value="modelValue"
      :disabled="loading && episodes.length === 0"
      @change="onSelect(($event.target as HTMLSelectElement).value)"
      @focus="loadEpisodes"
      class="select"
    >
      <!-- v1.0.48: placeholder reflects load state. Cold-load: "Loading…
           N episodes". Loaded: standard "Select an episode…". -->
      <option value="" disabled>
        <template v-if="loading && episodes.length === 0">Loading episodes… please wait</template>
        <template v-else>Select an episode...</template>
      </option>
      <option v-for="ep in filteredEpisodes" :key="ep.episode_code" :value="ep.episode_code">
        {{ ep.episode_code }} — {{ ep.title }}{{ statusSuffix(ep) }}
      </option>
    </select>
    <div v-if="legend" class="status-legend">{{ legend }}</div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  modelValue: string
  projectSlug: string
  filterField?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'episode-selected': [episode: any]
}>()

// Use the shared SWR cache for episode lists so EpisodeSelector instances
// across all 9 generator pages share one in-memory copy and dedupe
// concurrent fetches. Manual refresh + job-completion auto-refresh both
// flow through the composable.
const slugRef = computed(() => props.projectSlug)
const { episodes, isLoading: loading, isRevalidating, refresh, rescan } = useEpisodes(slugRef)
const showAll = ref(false)

// v1.0.48 Layer 3 — cross-reference active jobs so episodes that are
// CURRENTLY generating a script / audio / video render get a 🔄 badge
// in the dropdown. The disk-derived status (script: bool, audio: bool,
// etc.) only flips after the job lands; without this overlay there's
// no UI signal that a render is in flight for a specific episode.
const { jobs } = useJobs()
const activeJobsByEpisode = computed(() => {
  // Build Map<episode_code, jobType[]> of jobs that are queued or
  // running. Multiple job types per episode (e.g. audio + image-prompts
  // running in parallel) collapse into the array so the suffix can
  // describe whichever is most useful.
  const out = new Map<string, string[]>()
  for (const job of jobs.value || []) {
    if (job.status !== 'queued' && job.status !== 'running') continue
    const code = job.episode_id
    if (!code) continue
    const list = out.get(code) || []
    list.push(job.type)
    out.set(code, list)
  }
  return out
})

const filteredEpisodes = computed(() => {
  let list = episodes.value
  if (!showAll.value && props.filterField) {
    const field = props.filterField
    list = list.filter(ep => !ep.status[field])
  }
  return [...list].sort((a, b) => a.episode_code.localeCompare(b.episode_code))
})

// v1.0.48 Layer 1 — elapsed-time counter for the "Loading…" hint above.
// Starts when `loading` flips true, stops/resets when it goes false.
// Updates every second, so 380-episode cold-loads feel honest ("12s
// elapsed") instead of stalled. Reset when not loading so the next
// load starts at 0s.
const elapsedSec = ref(0)
let elapsedTimer: ReturnType<typeof setInterval> | null = null
const elapsedLabel = computed(() => elapsedSec.value > 0 ? `(${elapsedSec.value}s elapsed)` : '')
watch(loading, (isLoading) => {
  if (isLoading) {
    elapsedSec.value = 0
    if (elapsedTimer) clearInterval(elapsedTimer)
    elapsedTimer = setInterval(() => { elapsedSec.value++ }, 1000)
  } else {
    if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
    elapsedSec.value = 0
  }
}, { immediate: true })
onBeforeUnmount(() => { if (elapsedTimer) clearInterval(elapsedTimer) })

// v1.0.48 Layer 3 — pretty-print job types for the dropdown suffix.
// Maps the internal job-type strings to short user-facing verbs.
const JOB_TYPE_LABELS: Record<string, string> = {
  'script-only':         'script',
  'introduction-only':   'intro',
  'outline_only':        'outline',
  'expand_chapters':     'chapter expansion',
  'chapter-only':        'chapter regeneration',
  'metadata':            'metadata',
  'scene_prompts':       'scene prompts',
  'thumb_prompts':       'thumb prompts',
  'images':              'images',
  'scene_images':        'scene images',
  'thumb_images':        'thumbnail images',
  'images_repair':       'image repair',
  'audio':               'audio',
  'audio_merge':         'audio merge',
  'subtitles_transcribe':'subtitles',
  'video':               'video clips',
  'video_repair':        'video repair',
  'video_assembly':      'video assembly',
  'youtube_upload':      'YouTube upload',
  'tiktok_upload':       'TikTok upload',
  'facebook_upload':     'Facebook upload',
}

// Per-context suffix so the user can tell at a glance what each episode is ready for.
// For video assembly specifically: ✓ rendered, ● ready to assemble, ○ missing inputs.
function statusSuffix(ep: any): string {
  // v1.0.48 Layer 3 — in-progress badge wins over disk-derived status.
  // If a render is running RIGHT NOW for this episode, that's the most
  // important signal; what's currently on disk is stale either way.
  const activeTypes = activeJobsByEpisode.value.get(ep.episode_code)
  if (activeTypes && activeTypes.length > 0) {
    // Pick the first job type alphabetically for stable display when
    // multiple are running (rare). Map to a friendly label.
    const primary = activeTypes.slice().sort()[0]
    const label = JOB_TYPE_LABELS[primary] || primary
    return ` 🔄 generating ${label}…`
  }
  const s = ep.status || {}
  // 'video_assembly' is the OUTPUT (final assembled file present anywhere
  // — project tree, external root, or YouTube-uploaded). 'video' is the
  // INPUT (per-scene AI clips done). The video-assembly page filters
  // by the former; per-scene-clip pages still filter by the latter.
  if (props.filterField === 'video_assembly') {
    if (s.video_assembly) return ' ✓ rendered'
    if (s.video_ready) return ' ● ready to assemble'
    if (!s.images) return ' ○ missing scenes'
    if (!s.merged_audio) return ' ○ missing merged audio'
    return ' ○ not ready'
  }
  if (props.filterField === 'video') {
    if (s.video) return ' ✓ rendered'
    if (s.video_ready) return ' ● ready'
    if (!s.images) return ' ○ missing scenes'
    if (!s.merged_audio) return ' ○ missing merged audio'
    return ' ○ not ready'
  }
  if (props.filterField === 'merged_audio') {
    if (s.merged_audio) return ' ✓'
    if (!s.audio) return ' ○ no narration'
    return ''
  }
  return s.all_done ? ' ✓' : ''
}

const legend = computed(() => {
  if (props.filterField === 'video' || props.filterField === 'video_assembly') {
    return '✓ rendered · ● ready · ○ missing inputs'
  }
  return ''
})

// v1.0.48 Layer 4 — confirm-before-swap when the CURRENT episode has
// an active job. Switching away mid-generation hides the progress
// panel from the page and the user can lose track that a render is
// running. The job itself keeps going (it's queued / running on the
// backend), but the UX-level concern is real: a dropdown click that
// silently abandons the page's progress view is a class of "did I
// just lose my work?" panic moment we can prevent with one prompt.
//
// Strategy: read the previously-selected modelValue, look up its
// active jobs, and if any are running, ask. If user cancels, revert
// the <select> visually by re-emitting the OLD modelValue (Vue's
// :value binding handles the rollback). If they confirm, proceed.
const { ask } = useConfirm()

async function onSelect(code: string) {
  // No-op when the user picked the same episode they were on (clicking
  // the dropdown without changing).
  if (code === props.modelValue) return

  // Confirm guard — only when the OLD selection has running jobs.
  const oldCode = props.modelValue
  const oldActive = oldCode ? activeJobsByEpisode.value.get(oldCode) : null
  if (oldCode && oldActive && oldActive.length > 0) {
    const labels = oldActive.map(t => JOB_TYPE_LABELS[t] || t).join(', ')
    const proceed = await ask({
      title: `Switch away from ${oldCode}?`,
      message:
        `${oldCode} has a generation in progress: ${labels}. ` +
        `The job keeps running on the backend, but switching episodes hides this page's progress panel — ` +
        `come back to ${oldCode} to see when it finishes. ` +
        `(The Jobs tab also lists every running job across episodes.)`,
      confirmLabel: 'Switch episode',
    })
    if (!proceed) {
      // Force a re-render by re-emitting the old value. Without this
      // the <select> stays visually on the new code even though
      // modelValue prop didn't change — Vue's :value binding only
      // updates when the prop changes, which it didn't.
      emit('update:modelValue', oldCode)
      return
    }
  }

  emit('update:modelValue', code)
  const ep = episodes.value.find(e => e.episode_code === code)
  if (ep) emit('episode-selected', ep)
}

// Refresh + invalidation are handled inside useEpisodes:
//  - Auto-revalidate on `done` job transitions (any type, current slug)
//  - Manual ↻ button calls refresh() which forces ?refresh=1
//  - Shift+↻ calls rescan() which also wipes the on-disk cache (use
//    after iCloud delivers files but the UI hasn't caught up).
async function loadEpisodes() {
  await refresh()
}

async function onRefreshClick(e: MouseEvent) {
  if (e.shiftKey) await rescan()
  else await refresh()
}

defineExpose({ refresh, rescan })
</script>

<style scoped>
.toggle-row {
  display: flex;
  gap: 2px;
  margin-bottom: 6px;
}

.toggle-btn {
  flex: 1;
  padding: 5px 10px;
  font-size: 12px;
  font-family: inherit;
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;
}

.toggle-btn:first-child {
  border-radius: 6px 0 0 6px;
}

.toggle-btn:last-child {
  border-radius: 0 6px 6px 0;
}

.toggle-btn.active {
  background: var(--accent);
  color: #0f1117;
  border-color: var(--accent);
  font-weight: 500;
}

.toggle-btn:not(.active):hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.refresh-btn {
  flex: 0 0 auto;
  padding: 5px 10px;
  border-radius: 0 6px 6px 0 !important;
  border-left: none;
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.toggle-btn:not(:first-child):not(:last-child) {
  border-radius: 0;
  border-left: none;
  border-right: none;
}

.status-legend {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}

/* v1.0.48 — episode-count + loading-state hints next to the label. */
.ep-count {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: normal;
  margin-left: 6px;
}
.ep-loading-inline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: normal;
  color: var(--text-muted);
  margin-left: 6px;
}
.ep-spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--text-muted);
  border-top-color: transparent;
  border-radius: 50%;
  animation: ep-spin 0.7s linear infinite;
}
@keyframes ep-spin {
  to { transform: rotate(360deg); }
}
</style>
