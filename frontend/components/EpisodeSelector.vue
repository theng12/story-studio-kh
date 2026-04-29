<template>
  <div class="form-group">
    <label>Episode</label>
    <div class="toggle-row">
      <button :class="['toggle-btn', { active: !showAll }]" @click="showAll = false">Pending only</button>
      <button :class="['toggle-btn', { active: showAll }]" @click="showAll = true">Show all</button>
      <button
        class="toggle-btn refresh-btn"
        :disabled="loading"
        @click="onRefreshClick"
        title="Refresh (shift-click to rescan from disk — slower, use after iCloud sync)"
      >
        {{ loading ? '…' : '↻' }}
      </button>
    </div>
    <select
      :value="modelValue"
      @change="onSelect(($event.target as HTMLSelectElement).value)"
      @focus="loadEpisodes"
      class="select"
    >
      <option value="" disabled>Select an episode...</option>
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

const filteredEpisodes = computed(() => {
  let list = episodes.value
  if (!showAll.value && props.filterField) {
    const field = props.filterField
    list = list.filter(ep => !ep.status[field])
  }
  return [...list].sort((a, b) => a.episode_code.localeCompare(b.episode_code))
})

// Per-context suffix so the user can tell at a glance what each episode is ready for.
// For video assembly specifically: ✓ rendered, ● ready to assemble, ○ missing inputs.
function statusSuffix(ep: any): string {
  const s = ep.status || {}
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
  if (props.filterField === 'video') return '✓ rendered · ● ready · ○ missing inputs'
  return ''
})

function onSelect(code: string) {
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
</style>
