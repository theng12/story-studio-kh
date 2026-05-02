<template>
  <div class="usage-page">
    <header class="usage-header">
      <NuxtLink to="/" class="btn btn-secondary btn-sm">← Back to projects</NuxtLink>
      <div>
        <h1>Cost Dashboard</h1>
        <p class="text-muted">
          Tracks text-model API costs (Anthropic, OpenAI, Google) across all projects on this machine.
          Persists to disk so it survives Electron restarts.
        </p>
      </div>
      <div class="header-actions">
        <input v-model="since" type="date" class="input input-sm" />
        <span class="text-muted" style="font-size: 12px">to</span>
        <input v-model="until" type="date" class="input input-sm" />
        <button class="btn btn-sm btn-secondary" :disabled="loading" @click="load">
          {{ loading ? 'Loading…' : 'Apply' }}
        </button>
      </div>
    </header>

    <div v-if="error" class="error-card">
      <strong>Couldn't load usage rollup.</strong>
      <p>{{ error }}</p>
    </div>

    <div v-else-if="rollup" class="rollup">
      <!-- Top-line totals -->
      <div class="totals-strip">
        <div class="totals-card">
          <div class="totals-label">Total spend</div>
          <div class="totals-value">${{ rollup.total_cost.toFixed(2) }}</div>
        </div>
        <div class="totals-card">
          <div class="totals-label">API calls</div>
          <div class="totals-value">{{ rollup.entries.toLocaleString() }}</div>
        </div>
        <div class="totals-card">
          <div class="totals-label">Models used</div>
          <div class="totals-value">{{ Object.keys(rollup.by_model).length }}</div>
        </div>
        <div class="totals-card">
          <div class="totals-label">Active days</div>
          <div class="totals-value">{{ Object.keys(rollup.by_day).length }}</div>
        </div>
      </div>

      <p v-if="rollup.entries === 0" class="empty-state mt-2">
        No usage tracked in this range yet. Generate a script, metadata, or comments draft to populate the dashboard.
      </p>

      <!-- Per-provider -->
      <section v-if="providerRows.length" class="card mt-3">
        <h2>By provider</h2>
        <table class="usage-table">
          <thead>
            <tr><th>Provider</th><th class="num">Calls</th><th class="num">Cost</th><th class="num">Share</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in providerRows" :key="row.provider">
              <td>{{ row.provider }}</td>
              <td class="num">{{ row.calls.toLocaleString() }}</td>
              <td class="num">${{ row.cost.toFixed(4) }}</td>
              <td class="num">
                <div class="bar-container">
                  <div class="bar" :style="{ width: row.share + '%' }"></div>
                  <span>{{ row.share.toFixed(0) }}%</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Per-model -->
      <section v-if="modelRows.length" class="card mt-3">
        <h2>By model</h2>
        <table class="usage-table">
          <thead>
            <tr>
              <th>Model</th>
              <th class="num">Calls</th>
              <th class="num">Input tokens</th>
              <th class="num">Output tokens</th>
              <th class="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in modelRows" :key="row.model">
              <td>{{ row.model }}</td>
              <td class="num">{{ row.calls.toLocaleString() }}</td>
              <td class="num">{{ formatTokens(row.input_tokens) }}</td>
              <td class="num">{{ formatTokens(row.output_tokens) }}</td>
              <td class="num">${{ row.cost.toFixed(4) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Per-day bar chart -->
      <section v-if="dayRows.length > 1" class="card mt-3">
        <h2>By day</h2>
        <div class="day-chart">
          <div v-for="d in dayRows" :key="d.day" class="day-bar-wrap" :title="`${d.day} — $${d.cost.toFixed(4)} · ${d.calls} call(s)`">
            <div class="day-bar" :style="{ height: (d.cost / maxDayCost * 100) + '%' }"></div>
            <span class="day-label">{{ d.day.slice(5) }}</span>
          </div>
        </div>
      </section>

      <p class="text-muted mt-3" style="font-size: 12px">
        <strong>Not yet tracked here:</strong> ElevenLabs character usage, image generation (Fal / KIE / GenAIPro), video generation.
        Check those providers' own dashboards for those costs.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
useAppTitle('Cost Dashboard')

interface RollupShape {
  total_cost: number
  entries: number
  by_model: Record<string, { calls: number; cost: number; input_tokens: number; output_tokens: number }>
  by_provider: Record<string, { calls: number; cost: number }>
  by_day: Record<string, { calls: number; cost: number }>
  since: string
  until: string
}

function isoNDaysAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

const since = ref<string>(isoNDaysAgo(30))
const until = ref<string>(isoNDaysAgo(0))
const loading = ref(false)
const error = ref<string | null>(null)
const rollup = ref<RollupShape | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    const { get } = useApi()
    const r = await get<RollupShape>(`/usage/rollup?since=${since.value}&until=${until.value}`)
    rollup.value = r
  } catch (e: any) {
    error.value = e?.data?.detail || e?.message || 'Failed to load rollup'
  } finally {
    loading.value = false
  }
}

const providerRows = computed(() => {
  if (!rollup.value) return []
  const total = rollup.value.total_cost || 0.000001
  return Object.entries(rollup.value.by_provider)
    .map(([provider, v]) => ({ provider, ...v, share: (v.cost / total) * 100 }))
    .sort((a, b) => b.cost - a.cost)
})

const modelRows = computed(() => {
  if (!rollup.value) return []
  return Object.entries(rollup.value.by_model)
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.cost - a.cost)
})

const dayRows = computed(() => {
  if (!rollup.value) return []
  return Object.entries(rollup.value.by_day)
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => a.day.localeCompare(b.day))
})

const maxDayCost = computed(() => {
  return Math.max(0.000001, ...dayRows.value.map(d => d.cost))
})

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K'
  return n.toLocaleString()
}

await load()
</script>

<style scoped>
.usage-page {
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px;
  color: var(--text-primary);
}
.usage-header {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 16px;
  align-items: start;
  margin-bottom: 24px;
}
.usage-header h1 { margin: 0; color: var(--accent); }
.usage-header p { margin: 4px 0 0; color: var(--text-secondary); }
.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.input-sm {
  padding: 4px 8px;
  font-size: 12px;
  height: 28px;
}

.totals-strip {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.totals-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
}
.totals-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}
.totals-value {
  font-size: 22px;
  font-weight: 600;
  color: var(--text-primary);
  margin-top: 4px;
  font-variant-numeric: tabular-nums;
}

.card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 18px 20px;
}
.card h2 { margin: 0 0 12px; font-size: 16px; color: var(--text-primary); }

.usage-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.usage-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
  padding: 6px 8px;
}
.usage-table td {
  padding: 8px;
  border-bottom: 1px solid var(--border);
  color: var(--text-primary);
}
.usage-table th.num,
.usage-table td.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.bar-container {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  justify-content: flex-end;
}
.bar-container .bar {
  height: 8px;
  background: var(--accent);
  border-radius: 2px;
  min-width: 2px;
}
.bar-container span {
  font-size: 11px;
  color: var(--text-muted);
  min-width: 30px;
  text-align: right;
}

.day-chart {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 140px;
}
.day-bar-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  height: 100%;
  justify-content: flex-end;
}
.day-bar {
  width: 100%;
  background: var(--accent);
  border-radius: 2px 2px 0 0;
  min-height: 2px;
  opacity: 0.85;
}
.day-bar:hover { opacity: 1; }
.day-label {
  font-size: 10px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.error-card {
  background: var(--bg-secondary);
  border: 1px solid #d97757;
  padding: 16px;
  border-radius: 8px;
  color: var(--text-primary);
}
.empty-state {
  text-align: center;
  padding: 36px 16px;
  color: var(--text-secondary);
}
</style>
