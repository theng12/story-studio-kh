<template>
  <section class="gs-batch" :aria-label="`GenStudio batch with ${remoteJobs.length} items`">
    <div class="gs-batch-head">
      <span class="meta-label">GenStudio batch:</span>
      <strong>{{ remoteJobs.length.toLocaleString() }} items</strong>
      <span class="gs-batch-credit">{{ settledLabel }}</span>
      <span v-if="reservedCredits > 0" class="gs-batch-credit muted">{{ reservedCredits.toLocaleString() }} reserved</span>
      <span v-if="returnedCredits > 0" class="gs-batch-credit returned">{{ returnedCredits.toLocaleString() }} returned</span>
    </div>

    <div class="gs-batch-progress" aria-label="Remote item status distribution">
      <span v-if="settledCount" class="settled" :style="segmentStyle(settledCount)" :title="`${settledCount} settled`" />
      <span v-if="activeCount" class="active" :style="segmentStyle(activeCount)" :title="`${activeCount} active`" />
      <span v-if="queuedCount" class="queued" :style="segmentStyle(queuedCount)" :title="`${queuedCount} queued`" />
      <span v-if="failedCount" class="failed" :style="segmentStyle(failedCount)" :title="`${failedCount} failed`" />
    </div>
    <div class="gs-batch-statuses">
      <span v-if="settledCount" class="settled">{{ settledCount.toLocaleString() }} settled</span>
      <span v-if="activeCount" class="active">{{ activeCount.toLocaleString() }} active</span>
      <span v-if="queuedCount" class="queued">{{ queuedCount.toLocaleString() }} queued</span>
      <span v-if="failedCount" class="failed">{{ failedCount.toLocaleString() }} failed</span>
    </div>

    <div class="gs-batch-actions">
      <button v-if="exceptionJobs.length" type="button" class="link-btn" @click="toggleExceptions">
        {{ showingExceptions ? 'Show all ledger' : `Inspect ${exceptionJobs.length.toLocaleString()} active or failed` }}
      </button>
      <button type="button" class="link-btn" @click="toggleLedger">
        {{ ledgerOpen ? 'Hide item ledger' : `Show item ledger (${remoteJobs.length.toLocaleString()})` }}
      </button>
    </div>

    <div v-if="ledgerOpen" class="gs-batch-ledger">
      <div class="gs-batch-ledger-head">
        <span>{{ showingExceptions ? 'Active or failed items' : 'All remote items' }}</span>
        <span>{{ visibleJobs.length.toLocaleString() }} item{{ visibleJobs.length === 1 ? '' : 's' }}</span>
      </div>
      <ul class="gs-batch-items">
        <li v-for="remote in pageItems" :key="remote.id">
          <span>{{ remote.operation }}</span>
          <strong :class="stateClass(remote.state)">{{ displayState(remote.state) }}</strong>
          <span v-if="settledFor(remote) !== null">{{ settledFor(remote)!.toLocaleString() }} credits</span>
          <span v-else-if="numeric(remote.reserved_credits) > 0">{{ numeric(remote.reserved_credits).toLocaleString() }} reserved</span>
          <span v-else>—</span>
        </li>
      </ul>
      <div v-if="pageCount > 1" class="gs-batch-pagination">
        <button type="button" class="btn btn-xs btn-secondary" :disabled="page === 1" @click="page -= 1">Previous</button>
        <span>Page {{ page }} / {{ pageCount }}</span>
        <button type="button" class="btn btn-xs btn-secondary" :disabled="page === pageCount" @click="page += 1">Next</button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

type RemoteJob = {
  id: string
  operation: string
  state: string
  credit_cost?: number
  reserved_credits?: number
  settled_credits?: number
  returned_credits?: number
  failure_code?: string | null
}

const props = defineProps<{ remoteJobs: readonly RemoteJob[] }>()

const PAGE_SIZE = 25
const ledgerOpen = ref(false)
const showingExceptions = ref(false)
const page = ref(1)

function numeric(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function stateBucket(remote: RemoteJob): 'settled' | 'active' | 'queued' | 'failed' {
  const state = String(remote.state || '').toLowerCase()
  if (remote.failure_code || /fail|error|cancel|reject/.test(state)) return 'failed'
  if (/success|succeed|complete|done|settled/.test(state)) return 'settled'
  if (/queue|pending|wait|accept/.test(state)) return 'queued'
  return 'active'
}

function settledFor(remote: RemoteJob): number | null {
  const settled = numeric(remote.settled_credits)
  if (settled > 0) return settled
  const reported = numeric(remote.credit_cost)
  return reported > 0 ? reported : null
}

const settledCount = computed(() => props.remoteJobs.filter(remote => stateBucket(remote) === 'settled').length)
const activeCount = computed(() => props.remoteJobs.filter(remote => stateBucket(remote) === 'active').length)
const queuedCount = computed(() => props.remoteJobs.filter(remote => stateBucket(remote) === 'queued').length)
const failedCount = computed(() => props.remoteJobs.filter(remote => stateBucket(remote) === 'failed').length)
const settledCredits = computed(() => props.remoteJobs.reduce((sum, remote) => sum + (settledFor(remote) || 0), 0))
const reservedCredits = computed(() => props.remoteJobs.reduce((sum, remote) => sum + numeric(remote.reserved_credits), 0))
const returnedCredits = computed(() => props.remoteJobs.reduce((sum, remote) => sum + numeric(remote.returned_credits), 0))
const settledLabel = computed(() => settledCredits.value > 0
  ? `${settledCredits.value.toLocaleString()} charged`
  : 'Awaiting settlement')
const exceptionJobs = computed(() => props.remoteJobs.filter(remote => {
  const bucket = stateBucket(remote)
  return bucket === 'active' || bucket === 'failed'
}))
const visibleJobs = computed(() => showingExceptions.value ? exceptionJobs.value : props.remoteJobs)
const pageCount = computed(() => Math.max(1, Math.ceil(visibleJobs.value.length / PAGE_SIZE)))
const pageItems = computed(() => visibleJobs.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))

function segmentStyle(count: number) {
  return { width: `${(count / Math.max(1, props.remoteJobs.length)) * 100}%` }
}

function displayState(state: string) {
  return String(state || 'unknown').replace(/_/g, ' ')
}

function stateClass(state: string) {
  return `state-${stateBucket({ id: '', operation: '', state })}`
}

function toggleLedger() {
  ledgerOpen.value = !ledgerOpen.value
  page.value = 1
}

function toggleExceptions() {
  showingExceptions.value = !showingExceptions.value
  ledgerOpen.value = true
  page.value = 1
}

watch([visibleJobs, pageCount], () => {
  if (page.value > pageCount.value) page.value = pageCount.value
})
</script>

<style scoped>
.gs-batch { margin-top: 7px; padding: 8px 10px; border: 1px solid rgba(63, 185, 80, .28); border-radius: var(--radius-sm); background: rgba(46, 160, 67, .06); }
.gs-batch-head, .gs-batch-statuses, .gs-batch-actions, .gs-batch-ledger-head, .gs-batch-pagination { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.gs-batch-head { font-size: var(--font-xs); color: var(--text-secondary); }
.gs-batch-credit { color: var(--success, #3fb950); font-variant-numeric: tabular-nums; }
.gs-batch-credit.muted { color: var(--text-muted); }.gs-batch-credit.returned { color: var(--success, #3fb950); }
.gs-batch-progress { display: flex; height: 6px; overflow: hidden; margin-top: 8px; border-radius: 999px; background: var(--bg-primary); }
.gs-batch-progress span { min-width: 2px; }.gs-batch-progress .settled { background: var(--success, #3fb950); }.gs-batch-progress .active { background: var(--accent); }.gs-batch-progress .queued { background: #64748b; }.gs-batch-progress .failed { background: var(--danger, #f85149); }
.gs-batch-statuses { margin-top: 6px; font-size: var(--font-xs); }.gs-batch-statuses .settled { color: var(--success, #3fb950); }.gs-batch-statuses .active { color: var(--accent); }.gs-batch-statuses .queued { color: var(--text-muted); }.gs-batch-statuses .failed { color: var(--danger, #f85149); }
.gs-batch-actions { margin-top: 7px; }.link-btn { border: 0; padding: 0; color: var(--accent); background: transparent; font: inherit; cursor: pointer; }.link-btn:hover { text-decoration: underline; }
.gs-batch-ledger { margin-top: 8px; padding: 8px; border-radius: var(--radius-sm); background: var(--bg-primary); }.gs-batch-ledger-head { justify-content: space-between; color: var(--text-muted); font-size: var(--font-xs); }
.gs-batch-items { max-height: 270px; margin: 7px 0 0; padding: 0; overflow: auto; list-style: none; }.gs-batch-items li { display: grid; grid-template-columns: minmax(120px, 1fr) minmax(90px, auto) minmax(90px, auto); gap: 10px; padding: 5px 0; border-top: 1px solid var(--border); color: var(--text-secondary); font-size: var(--font-xs); }.gs-batch-items strong { font-weight: 600; text-transform: capitalize; }.state-settled { color: var(--success, #3fb950); }.state-active { color: var(--accent); }.state-queued { color: var(--text-muted); }.state-failed { color: var(--danger, #f85149); }
.gs-batch-pagination { justify-content: flex-end; margin-top: 8px; color: var(--text-muted); font-size: var(--font-xs); }
@media (max-width: 620px) { .gs-batch-items li { grid-template-columns: 1fr auto; }.gs-batch-items li > :last-child { grid-column: 1 / -1; } }
</style>
