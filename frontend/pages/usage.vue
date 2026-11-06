<template>
  <div class="usage-page page-frame">
    <!-- Its own row, top-left, above everything: it used to share a line with the eyebrow ("← BackGENSTUDIO"). -->
    <PlainBackLink />
    <PageTitle
      eyebrow="Gateway"
      title="Usage"
      description="Credits and recent work, exactly as your Gateway reports them. Story Studio does not calculate rates or balances."
    >
      <template #actions>
        <a
          v-if="snapshot?.overview.app_links?.billing"
          class="btn btn-secondary btn-sm"
          :href="snapshot.overview.app_links.billing"
          target="_blank"
          rel="noopener noreferrer"
        >Buy Credits</a>
        <button class="btn btn-secondary btn-sm" :disabled="loading" @click="load">{{ loading ? 'Refreshing…' : 'Refresh' }}</button>
      </template>
    </PageTitle>
    <ApiDataStatus path="/app-settings/genstudio/usage" @retry="load" />

    <p v-if="loading && !snapshot && !error" class="empty" role="status">Loading usage from your Gateway…</p>

    <WorkspaceNotice v-if="error" tone="warning" title="Usage unavailable">
      {{ gatewayDown ? connection.hint : error }}
      <template #actions>
        <button type="button" class="btn btn-sm btn-secondary" :disabled="loading" @click="load">Try Again</button>
        <button type="button" class="btn btn-sm btn-secondary" @click="appSettingsModal.open('connections')">
          {{ usageErrorCode === 'GENSTUDIO_USAGE_SCOPE_UNAVAILABLE' ? 'Review the Gateway Connection' : error === 'Add a Gateway API Key first.' ? 'Connect Your Gateway' : 'Open Connection Settings' }}
        </button>
      </template>
    </WorkspaceNotice>

    <template v-if="snapshot">
      <div class="totals">
        <article><span>Available</span><strong>{{ count(snapshot.overview.credit_balance) }}</strong><small>credits</small></article>
        <article><span>Used · 30 days</span><strong>{{ count(snapshot.overview.credits_used_30d) }}</strong><small>credits</small></article>
        <article>
          <span>Running now</span><strong>{{ count(snapshot.overview.paid_active_jobs) }}</strong>
          <small>of {{ count(snapshot.overview.paid_concurrency_limit) }} at once (free and paid)</small>
        </article>
        <article><span>Waiting</span><strong>{{ count(snapshot.overview.paid_queued_jobs) }}</strong><small>jobs in the Gateway queue</small></article>
      </div>

      <section v-if="snapshot.overview.service_tier" class="card plan-card">
        <div>
          <span class="eyebrow">Tier standing</span>
          <h2>{{ tierHeading(snapshot.overview.service_tier.current) }}</h2>
          <p v-if="snapshot.overview.service_tier.overridden">
            This account's tier is set by hand. Lifetime-spend progress does not decide today's capacity.
          </p>
          <p v-else-if="snapshot.overview.service_tier.next_tier && snapshot.overview.service_tier.cents_to_next_tier !== null">
            {{ formatMoney(snapshot.overview.service_tier.lifetime_paid_cents) }} lifetime spend ·
            {{ formatMoney(snapshot.overview.service_tier.cents_to_next_tier) }} more reaches
            {{ tierHeading(snapshot.overview.service_tier.next_tier) }} with
            {{ snapshot.overview.service_tier.next_tier.paid_concurrency_limit }} paid jobs at once.
          </p>
        </div>
      </section>

      <section class="card">
        <h2>Recent Gateway jobs</h2>
        <p v-if="snapshot.history_error" class="empty">Recent jobs could not be read just now — the figures above are unaffected. Refresh to try again.</p>
        <p v-else-if="!snapshot.jobs.items.length" class="empty">No Gateway jobs reported.</p>
        <template v-else>
          <p v-if="!showCreditColumns" class="empty">No credits were held or charged for these jobs.</p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Model</th><th>Work</th><th>State</th>
                  <template v-if="showCreditColumns"><th class="num">Held credits</th><th class="num">Charged credits</th><th class="num">Refunded credits</th></template>
                </tr>
              </thead>
              <tbody>
                <tr v-for="job in snapshot.jobs.items" :key="job.id">
                  <td><strong>{{ usageModelDisplay(job) }}</strong></td>
                  <td>{{ workLabel(job.operation) }}</td>
                  <td>{{ plainReason(job.state) }}</td>
                  <template v-if="showCreditColumns">
                    <td class="num">{{ count(job.reserved_credits) }}</td>
                    <td class="num">{{ count(job.settled_credits) }}</td>
                    <td class="num">{{ count(job.released_credits) }}</td>
                  </template>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </section>

      <section v-if="!snapshot.history_error && snapshot.credit_activity.items.length" class="card">
        <h2>Credit activity</h2>
        <ul class="activity">
          <li v-for="entry in snapshot.credit_activity.items" :key="entry.id">
            <span :class="['activity-kind', entry.kind]">{{ entry.kind }}</span>
            <span><strong>{{ usageActivityDescription(entry.description) }}</strong><small>{{ formatDate(entry.created_at) }} · {{ plainReason(entry.reason_code) }}</small></span>
            <b>{{ count(entry.credits) }} credits</b>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { customerSafeJobText } from '~/utils/job-presentation'

useAppTitle('Usage')

interface Snapshot {
  overview: {
    app_links?: { billing: string | null }
    credit_balance: number
    credits_used_30d: number
    paid_concurrency_limit: number
    paid_active_jobs: number
    paid_queued_jobs: number
    service_tier?: ServiceTierStanding
  }
  jobs: { items: Array<{ id: string; operation: string; state: string; model_id: string; reserved_credits: number; settled_credits: number; released_credits: number }> }
  credit_activity: { items: Array<{ id: string; kind: 'credit' | 'charge' | 'return'; description: string; credits: number; reason_code: string; created_at: string }> }
  /** Set when the two history reads failed; the balance above still stands. */
  history_error?: string
}

interface ServiceTier {
  code: string
  display_name: string
  threshold_cents: number
  paid_concurrency_limit: number
  max_queued_jobs: number
  generation_submissions_per_minute: number
  max_api_keys: number
}
interface ServiceTierStanding {
  current: ServiceTier
  ladder: ServiceTier
  floor?: ServiceTier | null
  overridden: boolean
  lifetime_paid_cents: number
  next_tier: ServiceTier | null
  cents_to_next_tier: number | null
}

const snapshot = ref<Snapshot | null>(null)
const loading = ref(false)
const error = ref('')
const usageErrorCode = ref('')
const { get } = useApi()
const appSettingsModal = useAppSettingsModal()
const genStudioModels = useGenStudioModelDisplay()
const { connection, gatewayDown } = useConnectionStatus()

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  usageErrorCode.value = ''
  try {
    // Read through the shared cache like every other page: the last answer is
    // on screen at once and revalidated behind it, so Gateway figures are never
    // a blank wait and never a silent stale number either.
    snapshot.value = await get<Snapshot>('/app-settings/genstudio/usage')
  } catch (cause: any) {
    snapshot.value = null
    usageErrorCode.value = cause?.data?.code || ''
    error.value = cause?.data?.detail || cause?.message || 'GenStudio usage is unavailable.'
  } finally { loading.value = false }
}

/**
 * A figure the Gateway may not publish. The page went blank on the mini (1.4.257) because the
 * Gateway's overview has no `active_jobs` / `completed_jobs` and `undefined.toLocaleString()`
 * threw inside render — the back link "showed for a second", then the whole page vanished.
 * Unpublished shows "—", never a made-up 0.
 */
function count(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—'
}

/** Held / charged / refunded columns only earn their space when some job actually moved credits. */
const showCreditColumns = computed(() => (snapshot.value?.jobs.items || [])
  .some(job => [job.reserved_credits, job.settled_credits, job.released_credits].some(n => typeof n === 'number' && n !== 0)))

function workLabel(operation: string): string {
  return ({ tts: 'Narration', chat: 'Writing' } as Record<string, string>)[operation] || plainReason(operation)
}

/** `JOB_SETTLED` → "Job settled": the code is still there to quote, without reading as an error code. */
function plainReason(code: string): string {
  const words = String(code || '').replace(/[_.-]+/g, ' ').trim().toLowerCase()
  return words ? words[0]!.toUpperCase() + words.slice(1) : ''
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString()
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100)
}

function tierHeading(tier: ServiceTier): string {
  return `${tier.display_name} · ${formatMoney(tier.threshold_cents)} tier`
}

function usageModelDisplay(job: Snapshot['jobs']['items'][number]): string {
  return genStudioModels.displayName(job.model_id)
}

function usageActivityDescription(description: string): string {
  return customerSafeJobText(description, snapshot.value?.jobs.items.map(job => job.id) || [])
}

// Not awaited: with the Gateway stopped or slow, awaiting here held the click on the credits strip
// for the whole retry budget before the page appeared at all. The page shows its loading line instead.
void load()
void genStudioModels.refresh()
</script>

<style scoped>
/* Width, margin and padding belong to .page-frame (was: pinned at 1120px). */
.usage-page { color: var(--text-primary); }
.usage-header { display: flex; margin-top: 4px; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 20px; }
.usage-header h1 { margin: 2px 0; color: var(--accent); }.usage-header p { margin: 0; color: var(--text-muted); }
.usage-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; flex: 0 0 auto; }
.eyebrow { color: var(--accent); font-size: var(--font-xs); font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.totals { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 18px 0; }
.totals article, .card { border: 1px solid var(--border); border-radius: 10px; background: var(--bg-secondary); padding: 16px; }
.totals span, .totals small { display: block; color: var(--text-muted); font-size: var(--font-xs); }.totals strong { display: block; margin: 4px 0; font-size: 24px; }
.card { margin-top: 14px; }.card h2 { margin: 0 0 12px; font-size: 16px; }.empty { color: var(--text-muted); }
.plan-card { display: flex; align-items: center; justify-content: space-between; gap: 20px; border-color: color-mix(in srgb, var(--accent) 28%, var(--border)); }.plan-card h2 { margin: 4px 0 6px; }.plan-card p { max-width: 760px; margin: 4px 0 0; color: var(--text-secondary); line-height: 1.5; }.billing-action { display: grid; max-width: 260px; gap: 4px; color: var(--text-primary); }.billing-action small { color: var(--text-muted); line-height: 1.4; }
.table-wrap { overflow-x: auto; } table { width: 100%; border-collapse: collapse; font-size: 12px; } th, td { padding: 9px; border-bottom: 1px solid var(--border); text-align: left; } th { color: var(--text-muted); font-size: var(--font-xs); text-transform: uppercase; } td small { display: block; color: var(--text-muted); }.num { text-align: right; font-variant-numeric: tabular-nums; }
.activity { list-style: none; margin: 0; padding: 0; }.activity li { display: grid; grid-template-columns: 70px 1fr auto; gap: 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }.activity small { display: block; color: var(--text-muted); }.activity-kind { text-transform: uppercase; font-size: var(--font-xs); font-weight: 700; }.activity-kind.credit, .activity-kind.return { color: var(--success); }.activity-kind.charge { color: var(--warning, #d97706); }
@media (max-width: 760px) { .usage-header { flex-direction: column; }.usage-actions { width: 100%; justify-content: flex-start; }.totals { grid-template-columns: repeat(2, 1fr); }.plan-card { align-items: stretch; flex-direction: column; }.plan-card button { width: 100%; } }
</style>
