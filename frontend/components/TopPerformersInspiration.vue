<template>
  <div v-if="state === 'data'" class="inspiration-card">
    <div class="inspiration-header">
      <span class="inspiration-icon" aria-hidden="true">📈</span>
      <strong>Inspired by your top performers</strong>
      <NuxtLink :to="`/projects/${slug}/upload/analytics`" class="inspiration-link">View Analytics →</NuxtLink>
    </div>
    <ul class="inspiration-list">
      <li v-for="performer in performers" :key="performer.episode_code">
        <span class="inspiration-title">{{ performer.episode_code }}</span>
        <span class="inspiration-meta">{{ formatViews(performer.views) }}</span>
      </li>
    </ul>
    <p v-if="partialCopy" class="inspiration-hint text-muted">{{ partialCopy }}</p>
    <p v-else class="inspiration-hint text-muted">Refresh on the Analytics page to update this evidence.</p>
  </div>
  <div v-else-if="state === 'reauth'" class="inspiration-cta">
    <span aria-hidden="true">💡</span>
    <span><strong>Connect YouTube Analytics</strong> to use this channel’s measured performance here.</span>
    <NuxtLink :to="`/projects/${slug}/settings#youtube`" class="inspiration-link">Reconnect in Settings →</NuxtLink>
  </div>
  <div v-else-if="state === 'unavailable'" class="inspiration-cta" role="status">
    <span aria-hidden="true">⚠</span>
    <span><strong>Analytics are unavailable.</strong> {{ unavailableCopy }}</span>
    <NuxtLink :to="`/projects/${slug}/upload/analytics`" class="inspiration-link">Open Analytics →</NuxtLink>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ slug: string; limit?: number }>()
type Metric = { state: string; value?: number }
type Analytics = {
  episodes: Array<{ episode_code: string; metrics: Record<string, Metric> }>
  partial: boolean
  partial_reason?: string | null
  empty_reason: 'no_channel_assigned' | 'nothing_published_yet' | null
}
type Performer = { episode_code: string; views: number }
type State = 'idle' | 'data' | 'reauth' | 'unavailable' | 'hidden'
const state = ref<State>('idle')
const performers = ref<Performer[]>([])
const partialCopy = ref('')
const unavailableCopy = ref('Open Analytics for the current status.')
const UNAVAILABLE: Record<string, string> = {
  quota_exhausted: 'Today’s analytics allowance is used up.',
  provider_error: 'YouTube did not finish the last analytics read.',
  report_truncated: 'The last analytics report did not cover every episode.',
  not_connected: 'This channel needs to be reconnected.',
  not_all_measured: 'Some published episodes have not been measured yet.',
}
async function load() {
  if (!props.slug) { state.value = 'hidden'; return }
  performers.value = []
  partialCopy.value = ''
  try {
    const { get } = useApi()
    const analytics = await get<Analytics>(`/projects/${props.slug}/youtube/analytics`)
    const rows = analytics.episodes
      .flatMap((episode): Performer[] => {
        const views = episode.metrics?.views
        return views?.state === 'value' && typeof views.value === 'number'
          ? [{ episode_code: episode.episode_code, views: views.value }]
          : []
      })
      .sort((left, right) => right.views - left.views)
      .slice(0, Math.max(props.limit ?? 5, 1))
    if (rows.length) {
      performers.value = rows
      partialCopy.value = analytics.partial
        ? UNAVAILABLE[analytics.partial_reason || ''] || 'Some analytics could not be read.'
        : ''
      state.value = 'data'
    } else if (analytics.partial_reason === 'scope_missing') {
      state.value = 'reauth'
    } else if (analytics.empty_reason) {
      state.value = 'hidden'
    } else {
      unavailableCopy.value = UNAVAILABLE[analytics.partial_reason || ''] || 'No measured analytics are available yet.'
      state.value = 'unavailable'
    }
  } catch {
    unavailableCopy.value = 'Story Studio could not read the saved analytics right now.'
    state.value = 'unavailable'
  }
}
function formatViews(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M views`
  if (value >= 10_000) return `${(value / 1000).toFixed(0)}K views`
  return `${value.toLocaleString()} views`
}
onMounted(load)
watch(() => props.slug, load)
</script>

<style scoped>
.inspiration-card { background: var(--bg-secondary); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 6px; padding: 12px 16px; margin-bottom: 12px; }
.inspiration-header { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-primary); }
.inspiration-icon { font-size: 14px; }
.inspiration-link { margin-left: auto; font-size: 12px; color: var(--accent); text-decoration: none; white-space: nowrap; }
.inspiration-link:hover { color: var(--accent-hover); text-decoration: underline; }
.inspiration-list { list-style: none; padding: 0; margin: 8px 0 0; }
.inspiration-list li { padding: 4px 0; font-size: 13px; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.inspiration-title { color: var(--text-primary); }
.inspiration-meta { color: var(--text-muted); font-size: var(--font-xs); font-variant-numeric: tabular-nums; white-space: nowrap; }
.inspiration-hint { margin: 8px 0 0; font-size: var(--font-xs); }
.inspiration-cta { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg-tertiary); border: 1px dashed var(--border); border-radius: 6px; margin-bottom: 12px; font-size: 12px; color: var(--text-secondary); }
.inspiration-cta strong { color: var(--text-primary); }
.inspiration-cta .inspiration-link { margin-left: auto; }
</style>
