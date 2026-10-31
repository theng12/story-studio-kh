<template>
  <section class="weekly panel" aria-labelledby="weekly-heading">
    <div class="weekly-header">
      <div>
        <h3 id="weekly-heading">Weekly results</h3>
        <p class="hint">Saved YouTube results for each week.</p>
      </div>
      <label v-if="enabled !== null" class="setting">
        <input type="checkbox" :checked="enabled" :disabled="saving" @change="changeSetting">
        Collect weekly results for all channels
      </label>
    </div>
    <p v-if="settingsError" class="error" role="alert">{{ settingsError }}</p>
    <p v-if="loading" class="hint">Loading weekly results…</p>
    <p v-else-if="error" class="error" role="alert">{{ error }}</p>
    <p v-else-if="!results.length" class="hint">No data</p>
    <template v-else>
      <label class="week-label">
        Week
        <select v-model="selectedWeek" class="input">
          <option v-for="item in results" :key="item.week" :value="item.week">{{ item.week }} to {{ item.end_date }}{{ item.complete ? '' : ' · Partial' }}</option>
        </select>
      </label>
      <template v-if="report">
        <p v-if="!report.complete" class="partial" role="status">Partial week<template v-if="report.reason"> — {{ report.reason }}</template></p>
        <p v-for="warning in report.warnings" :key="warning" class="hint">{{ warning }}</p>
        <p v-if="!report.top_videos.length" class="hint">No data</p>
        <ul v-else class="videos">
          <li v-for="video in report.top_videos" :key="video.video_id">
            <h4>{{ video.title || `Video ${video.video_id}` }}</h4>
            <dl>
              <div v-for="column in columns" :key="column.key">
                <dt>{{ column.label }}</dt>
                <dd :title="video.metrics[column.key]?.reason">{{ metricText(video.metrics[column.key], column.key === 'click_through_rate') }}</dd>
              </div>
            </dl>
          </li>
        </ul>
      </template>
    </template>
  </section>
</template>

<script setup lang="ts">
interface Metric { state: string, value: number | null, reason: string }
interface WeeklyResult {
  week: string
  end_date: string
  complete: boolean
  reason: string | null
  warnings: string[]
  top_videos: Array<{ video_id: string, title: string | null, metrics: Record<string, Metric> }>
}
const props = defineProps<{ slug: string }>()
const { get, put } = useApi()
const results = ref<WeeklyResult[]>([])
const selectedWeek = ref('')
const enabled = ref<boolean | null>(null)
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const settingsError = ref('')
const report = computed(() => results.value.find(item => item.week === selectedWeek.value))
const columns = [
  { key: 'views', label: 'Views' },
  { key: 'watch_minutes', label: 'Watch time (minutes)' },
  { key: 'click_through_rate', label: 'Click-through rate' },
  { key: 'impressions', label: 'Impressions' },
]
function metricText(metric: Metric | undefined, percent: boolean): string {
  if (metric?.state === 'measured' && typeof metric.value === 'number' && Number.isFinite(metric.value)) {
    return `${metric.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${percent ? '%' : ''}`
  }
  if (metric?.state === 'no_data') return 'No data'
  if (metric?.state === 'not_fetched') return 'Not fetched'
  if (metric?.state === 'reconnect_required') return 'Reconnect YouTube'
  return 'Not available'
}
async function changeSetting(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  saving.value = true
  settingsError.value = ''
  try {
    enabled.value = (await put<{ enabled: boolean }>('/youtube/weekly-results/settings', { enabled: input.checked })).enabled
  } catch (e: any) {
    input.checked = enabled.value === true
    settingsError.value = e?.data?.detail || e?.message || 'Could not save the weekly results setting.'
  } finally { saving.value = false }
}
async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  results.value = []
  selectedWeek.value = ''
  try {
    const response = await get<{ results: WeeklyResult[] }>(`/projects/${encodeURIComponent(props.slug)}/youtube/weekly-results`)
    results.value = response.results
    selectedWeek.value = response.results[0]?.week || ''
  } catch (e: any) {
    error.value = e?.data?.detail || e?.message || 'Could not load weekly results.'
  } finally { loading.value = false }
}
onMounted(() => {
  void load()
  void get<{ enabled: boolean }>('/youtube/weekly-results/settings').then(value => { enabled.value = value.enabled }).catch((e: any) => {
    settingsError.value = e?.data?.detail || e?.message || 'Could not load the weekly results setting.'
  })
})
watch(() => props.slug, load)
</script>

<style scoped>
.panel { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: var(--surface); min-width: 0; }
.weekly { display: grid; gap: 12px; }
.weekly-header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: start; gap: 10px; }
h3, h4, p, dl, dd { margin: 0; }
.hint, .week-label, dt { color: var(--text-muted); font-size: var(--font-xs); }
.error { color: var(--danger, #b00020); font-size: var(--font-sm); }
.partial { color: var(--warn, #b8860b); font-size: var(--font-sm); }
.setting { display: flex; align-items: center; gap: 6px; font-size: var(--font-sm); }
.week-label { display: grid; gap: 3px; justify-items: start; min-width: 0; }
.week-label select { max-width: 100%; font-size: var(--font-sm); }
.videos { list-style: none; margin: 0; padding: 0; }
.videos li { padding: 10px 0; border-top: 1px solid var(--border); }
h4 { font-size: var(--font-sm); overflow-wrap: anywhere; }
dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(125px, 1fr)); gap: 8px 12px; margin-top: 8px; }
dd { font-size: var(--font-sm); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
</style>
