<template>
  <div class="usage-page">
    <header class="usage-header">
      <div>
        <span class="eyebrow">GenStudio</span>
        <h1>Credits &amp; settlement</h1>
        <p>Every value on this page comes from GenStudio. Story Studio does not calculate rates or balances.</p>
      </div>
      <button class="btn btn-secondary btn-sm" :disabled="loading" @click="load">{{ loading ? 'Refreshing…' : 'Refresh' }}</button>
    </header>

    <WorkspaceNotice v-if="error" tone="warning" title="Authoritative credit data unavailable">
      {{ error }}
    </WorkspaceNotice>

    <template v-if="snapshot">
      <div class="totals">
        <article><span>Available</span><strong>{{ snapshot.overview.credit_balance.toLocaleString() }}</strong><small>credits</small></article>
        <article><span>Used · 30 days</span><strong>{{ snapshot.overview.credits_used_30d.toLocaleString() }}</strong><small>credits</small></article>
        <article><span>Active jobs</span><strong>{{ snapshot.overview.active_jobs.toLocaleString() }}</strong><small>GenStudio jobs</small></article>
        <article><span>Completed</span><strong>{{ snapshot.overview.completed_jobs.toLocaleString() }}</strong><small>GenStudio jobs</small></article>
      </div>

      <section class="card">
        <h2>Recent jobs</h2>
        <p v-if="!snapshot.jobs.items.length" class="empty">No GenStudio jobs reported.</p>
        <div v-else class="table-wrap">
          <table>
            <thead><tr><th>Job</th><th>Operation</th><th>State</th><th class="num">Reserved</th><th class="num">Settled</th><th class="num">Returned</th></tr></thead>
            <tbody>
              <tr v-for="job in snapshot.jobs.items" :key="job.id">
                <td><code>{{ job.id }}</code><small>{{ job.model_id }}</small></td>
                <td>{{ job.operation }}</td>
                <td>{{ job.state }}</td>
                <td class="num">{{ job.reserved_credits }}</td>
                <td class="num">{{ job.settled_credits }}</td>
                <td class="num">{{ job.released_credits }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="card">
        <h2>Credit activity</h2>
        <p v-if="!snapshot.credit_activity.items.length" class="empty">No credit activity reported.</p>
        <ul v-else class="activity">
          <li v-for="entry in snapshot.credit_activity.items" :key="entry.id">
            <span :class="['activity-kind', entry.kind]">{{ entry.kind }}</span>
            <span><strong>{{ entry.description }}</strong><small>{{ formatDate(entry.created_at) }} · {{ entry.reason_code }}</small></span>
            <b>{{ entry.credits.toLocaleString() }} credits</b>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
useAppTitle('GenStudio Credits')

interface Snapshot {
  overview: {
    credit_balance: number
    credits_used_30d: number
    active_jobs: number
    completed_jobs: number
  }
  jobs: { items: Array<{ id: string; operation: string; state: string; model_id: string; reserved_credits: number; settled_credits: number; released_credits: number }> }
  credit_activity: { items: Array<{ id: string; kind: 'credit' | 'charge' | 'return'; description: string; credits: number; reason_code: string; created_at: string }> }
}

const snapshot = ref<Snapshot | null>(null)
const loading = ref(false)
const error = ref('')
const { get } = useApi()

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    snapshot.value = await get<Snapshot>('/app-settings/genstudio/usage', { cache: 'no-store' })
  } catch (cause: any) {
    snapshot.value = null
    error.value = cause?.data?.detail || cause?.message || 'GenStudio usage is unavailable.'
  } finally { loading.value = false }
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString()
}

await load()
</script>

<style scoped>
.usage-page { max-width: 1120px; margin: 0 auto; padding: 24px; color: var(--text-primary); }
.usage-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 20px; }
.usage-header h1 { margin: 2px 0; color: var(--accent); }.usage-header p { margin: 0; color: var(--text-muted); }
.eyebrow { color: var(--accent); font-size: var(--font-xs); font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.totals { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 18px 0; }
.totals article, .card { border: 1px solid var(--border); border-radius: 10px; background: var(--bg-secondary); padding: 16px; }
.totals span, .totals small { display: block; color: var(--text-muted); font-size: var(--font-xs); }.totals strong { display: block; margin: 4px 0; font-size: 24px; }
.card { margin-top: 14px; }.card h2 { margin: 0 0 12px; font-size: 16px; }.empty { color: var(--text-muted); }
.table-wrap { overflow-x: auto; } table { width: 100%; border-collapse: collapse; font-size: 12px; } th, td { padding: 9px; border-bottom: 1px solid var(--border); text-align: left; } th { color: var(--text-muted); font-size: var(--font-xs); text-transform: uppercase; } td small { display: block; color: var(--text-muted); }.num { text-align: right; font-variant-numeric: tabular-nums; }
.activity { list-style: none; margin: 0; padding: 0; }.activity li { display: grid; grid-template-columns: 70px 1fr auto; gap: 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }.activity small { display: block; color: var(--text-muted); }.activity-kind { text-transform: uppercase; font-size: var(--font-xs); font-weight: 700; }.activity-kind.credit, .activity-kind.return { color: var(--success); }.activity-kind.charge { color: var(--warning, #d97706); }
@media (max-width: 760px) { .totals { grid-template-columns: repeat(2, 1fr); } }
</style>
