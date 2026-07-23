<!--
  Upload Center → Analytics tab. Extracted verbatim from upload.vue
  (v1.0.341 god-page split) — read-only per-episode YouTube Analytics with a
  date range + sortable table. Self-loads on mount (the tab only mounts when
  it's the active tab, so mounting === the old lazy-load on tab-open). Emits
  `reauth` so the parent can switch to the Accounts tab when the connected
  account predates the analytics scope.
-->
<template>
  <div class="card mt-2">
    <div class="card-header">
      <h3>Analytics</h3>
      <div class="flex gap-2 items-center">
        <label class="text-muted" style="font-size: 12px">From</label>
        <input v-model="analyticsStart" type="date" class="input input-sm" />
        <label class="text-muted" style="font-size: 12px">to</label>
        <input v-model="analyticsEnd" type="date" class="input input-sm" />
        <button class="btn btn-sm btn-secondary" :disabled="analyticsLoading" @click="loadAnalytics(false)">
          {{ analyticsLoading ? 'Loading…' : 'Apply' }}
        </button>
        <button class="btn btn-sm btn-secondary" :disabled="analyticsLoading" title="Skip the 6h cache and pull fresh numbers from YouTube." @click="loadAnalytics(true)">
          ↻ Refresh
        </button>
      </div>
    </div>
    <p class="text-muted mt-1" style="font-size: 12px">
      Per-episode performance pulled from YouTube Analytics. Cached for 6h — Refresh forces a new pull.
      Top performers (by views) feed the "what worked" panel on the Ideas + Metadata pages.
    </p>

    <!-- Re-auth banner for accounts connected before the analytics scope shipped -->
    <div v-if="analyticsReauthRequired" class="reauth-banner mt-2" role="status">
      <span class="reauth-icon" aria-hidden="true">⚠</span>
      <span>
        <strong>Analytics access not granted.</strong>
        This YouTube account was connected before we requested the analytics permission.
        Re-connect to grant it.
      </span>
      <button class="btn btn-sm btn-primary" @click="emit('reauth')">Reconnect on Accounts tab</button>
    </div>

    <div v-if="analyticsError && !analyticsReauthRequired" class="error-card mt-2">
      <strong>Couldn't load analytics.</strong>
      <p>{{ analyticsError }}</p>
      <button class="btn btn-sm btn-secondary" @click="loadAnalytics(true)">Retry</button>
    </div>

    <div v-if="analyticsResult?.totals" class="totals-strip mt-2">
      <div class="totals-card">
        <div class="totals-label">Views</div>
        <div class="totals-value">{{ formatNumber(analyticsResult.totals.views) }}</div>
      </div>
      <div class="totals-card">
        <div class="totals-label">Watch time</div>
        <div class="totals-value">{{ formatMinutes(analyticsResult.totals.watch_minutes) }}</div>
      </div>
      <div class="totals-card">
        <div class="totals-label">Avg retention</div>
        <div class="totals-value">{{ analyticsResult.totals.avg_view_percentage.toFixed(1) }}%</div>
      </div>
      <div class="totals-card">
        <div class="totals-label">Episodes</div>
        <div class="totals-value">{{ analyticsResult.rows.length }}</div>
      </div>
    </div>

    <table v-if="analyticsResult?.rows?.length" class="analytics-table mt-2">
      <thead>
        <tr>
          <th @click="setAnalyticsSort('title')" :class="{ sortable: true, sorted: analyticsSort === 'title' }">Episode</th>
          <th @click="setAnalyticsSort('views')" :class="{ sortable: true, sorted: analyticsSort === 'views' }" class="num">Views</th>
          <th @click="setAnalyticsSort('watch_minutes')" :class="{ sortable: true, sorted: analyticsSort === 'watch_minutes' }" class="num">Watch (min)</th>
          <th @click="setAnalyticsSort('avg_view_percentage')" :class="{ sortable: true, sorted: analyticsSort === 'avg_view_percentage' }" class="num" title="Average percentage of the video watched">Retention</th>
          <th @click="setAnalyticsSort('avg_view_seconds')" :class="{ sortable: true, sorted: analyticsSort === 'avg_view_seconds' }" class="num">Avg view</th>
          <th @click="setAnalyticsSort('ctr_percentage')" :class="{ sortable: true, sorted: analyticsSort === 'ctr_percentage' }" class="num" title="Card click rate (closest YouTube Analytics proxy for thumbnail performance)">CTR</th>
          <th @click="setAnalyticsSort('likes')" :class="{ sortable: true, sorted: analyticsSort === 'likes' }" class="num">Likes</th>
          <th @click="setAnalyticsSort('published_at')" :class="{ sortable: true, sorted: analyticsSort === 'published_at' }">Published</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in sortedAnalyticsRows" :key="row.video_id">
          <td>
            <a :href="`https://youtube.com/watch?v=${row.video_id}`" target="_blank" rel="noopener">
              {{ row.title || row.video_id }}
            </a>
          </td>
          <td class="num">{{ formatNumber(row.views) }}</td>
          <td class="num">{{ formatNumber(Math.round(row.watch_minutes)) }}</td>
          <td class="num">{{ row.avg_view_percentage.toFixed(1) }}%</td>
          <td class="num">{{ formatTimecode(row.avg_view_seconds) }}</td>
          <td class="num">{{ row.ctr_percentage != null ? row.ctr_percentage.toFixed(2) + '%' : '—' }}</td>
          <td class="num">{{ formatNumber(row.likes) }}</td>
          <td>{{ row.published_at ? row.published_at.slice(0, 10) : '—' }}</td>
        </tr>
      </tbody>
    </table>

    <div v-else-if="!analyticsLoading && !analyticsError && !analyticsReauthRequired" class="empty-state mt-2">
      <p>No analytics data yet. Click Apply to fetch.</p>
    </div>

    <p v-if="analyticsResult?.fetched_at" class="text-muted mt-2" style="font-size: var(--font-xs)">
      Fetched {{ formatRelativeTime(analyticsResult.fetched_at) }}.
      Date range: {{ analyticsResult.start_date }} to {{ analyticsResult.end_date }}.
    </p>
  </div>
</template>

<script setup lang="ts">
import { formatNumber, formatMinutes, formatTimecode, formatRelativeTime } from '~/utils/upload-format'

const props = defineProps<{ slug: string }>()
const emit = defineEmits<{ (e: 'reauth'): void }>()

interface AnalyticsRow {
  video_id: string
  title: string
  published_at: string
  views: number
  watch_minutes: number
  avg_view_seconds: number
  avg_view_percentage: number
  ctr_percentage?: number
  impressions?: number
  likes: number
  comments: number
  shares: number
}
interface AnalyticsResultShape {
  fetched_at: string
  start_date: string
  end_date: string
  rows: AnalyticsRow[]
  totals?: { views: number; watch_minutes: number; avg_view_percentage: number }
}

function isoNDaysAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}
const analyticsStart = ref<string>(isoNDaysAgo(90))
const analyticsEnd = ref<string>(isoNDaysAgo(0))
const analyticsLoading = ref(false)
const analyticsError = ref<string | null>(null)
const analyticsReauthRequired = ref(false)
const analyticsResult = ref<AnalyticsResultShape | null>(null)
type AnalyticsSortKey = 'title' | 'views' | 'watch_minutes' | 'avg_view_percentage' | 'avg_view_seconds' | 'ctr_percentage' | 'likes' | 'published_at'
const analyticsSort = ref<AnalyticsSortKey>('views')
const analyticsSortDir = ref<'asc' | 'desc'>('desc')

function setAnalyticsSort(key: AnalyticsSortKey) {
  if (analyticsSort.value === key) {
    analyticsSortDir.value = analyticsSortDir.value === 'desc' ? 'asc' : 'desc'
  } else {
    analyticsSort.value = key
    // Numeric columns default to desc (biggest first); text/date default asc.
    analyticsSortDir.value = (key === 'title' || key === 'published_at') ? 'asc' : 'desc'
  }
}

const sortedAnalyticsRows = computed<AnalyticsRow[]>(() => {
  const rows = analyticsResult.value?.rows ? [...analyticsResult.value.rows] : []
  const key = analyticsSort.value
  const dir = analyticsSortDir.value === 'asc' ? 1 : -1
  rows.sort((a, b) => {
    const va = (a as any)[key]
    const vb = (b as any)[key]
    // Undefined sorts to the bottom regardless of direction.
    if (va == null && vb == null) return 0
    if (va == null) return 1
    if (vb == null) return -1
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
    return String(va).localeCompare(String(vb)) * dir
  })
  return rows
})

async function loadAnalytics(force: boolean) {
  analyticsLoading.value = true
  analyticsError.value = null
  analyticsReauthRequired.value = false
  try {
    const params = new URLSearchParams({
      start_date: analyticsStart.value,
      end_date: analyticsEnd.value,
      max_results: '200',
    })
    if (force) params.set('force', '1')
    const { get: apiGet } = useApi()
    const r = await apiGet<AnalyticsResultShape>(`/projects/${props.slug}/upload/analytics?${params}`)
    analyticsResult.value = r
  } catch (e: any) {
    // Nuxt's $fetch surfaces server errors with `statusCode` on the
    // FetchError, and the parsed body on `e.data`. The 403 reauth case
    // bubbles `reauth_required: true` so the banner can fire instead of
    // a generic error card.
    const code = e?.statusCode || e?.response?.status || e?.status
    const data = e?.data || e?.response?._data
    if (code === 403 && data?.reauth_required) {
      analyticsReauthRequired.value = true
      analyticsError.value = data.detail || 'Reauthorize to grant analytics access.'
    } else {
      analyticsError.value = data?.detail || e?.message || 'Failed to load analytics'
    }
  } finally {
    analyticsLoading.value = false
  }
}

// Auto-load the first time the tab mounts (the tab is v-else-if-gated in the
// parent, so mount === the user opening the tab). Subsequent visits remount
// and hit the 6h server cache, so this stays cheap.
onMounted(() => {
  if (!analyticsResult.value && !analyticsLoading.value) loadAnalytics(false)
})
</script>

<style scoped>
.totals-strip {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.totals-card {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px 14px;
}
.totals-label {
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}
.totals-value {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  margin-top: 2px;
}
.analytics-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.analytics-table th {
  text-align: left;
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.analytics-table th.num { text-align: right; }
.analytics-table th.sortable { cursor: pointer; user-select: none; }
.analytics-table th.sortable:hover { color: var(--text-primary); }
.analytics-table th.sorted { color: var(--accent); }
.analytics-table td {
  padding: 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.analytics-table td.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.analytics-table td a {
  color: var(--text-primary);
  text-decoration: none;
}
.analytics-table td a:hover { color: var(--accent); text-decoration: underline; }
.input-sm {
  padding: 4px 8px;
  font-size: 12px;
  height: 28px;
}
.reauth-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: var(--accent-dim);
  border: 1px solid var(--accent);
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-primary);
}
.reauth-icon { font-size: 18px; }
</style>
