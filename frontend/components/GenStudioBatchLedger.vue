<template>
  <section class="gs-batch" :aria-label="`GenStudio batch with ${remoteJobs.length} items`">
    <div class="gs-batch-head">
      <span class="meta-label">GenStudio batch:</span>
      <!-- v1.4.7 — every credit figure says "credits".
           These sit immediately after an ITEM count, and read without a unit:
           "50 items · 450 on hold" looks like 450 items on hold. They are
           credits, and one of them (`on hold`) already carried the unit on the
           jobs page while the other two did not — one fact, three spellings. -->
      <strong>{{ remoteJobs.length.toLocaleString() }} items</strong>
      <span v-if="chargedCredits > 0" class="gs-batch-credit">{{ chargedCredits.toLocaleString() }} credits charged</span>
      <span v-if="heldCredits > 0" class="gs-batch-credit held">{{ heldCredits.toLocaleString() }} credits on hold</span>
      <span v-if="returnedCredits > 0" class="gs-batch-credit returned">{{ returnedCredits.toLocaleString() }} credits returned</span>
      <span v-if="chargedCredits === 0 && heldCredits === 0 && returnedCredits === 0 && unresolvedCount > 0" class="gs-batch-credit muted">Awaiting settlement</span>
    </div>

    <div class="gs-batch-progress" aria-label="Remote item status distribution">
      <span v-if="settledCount" class="settled" :style="segmentStyle(settledCount)" :title="`${settledCount} settled`" />
      <span v-if="activeCount" class="active" :style="segmentStyle(activeCount)" :title="`${activeCount} active`" />
      <span v-if="queuedCount" class="queued" :style="segmentStyle(queuedCount)" :title="`${queuedCount} queued`" />
      <span v-if="notCreatedCount" class="not-created" :style="segmentStyle(notCreatedCount)" :title="`${notCreatedCount} not created`" />
      <span v-if="cancelledCount" class="cancelled" :style="segmentStyle(cancelledCount)" :title="`${cancelledCount} cancelled`" />
      <span v-if="failedCount" class="failed" :style="segmentStyle(failedCount)" :title="`${failedCount} failed`" />
    </div>
    <div class="gs-batch-statuses">
      <span v-if="settledCount" class="settled">{{ settledCount.toLocaleString() }} settled</span>
      <span v-if="activeCount" class="active">{{ activeCount.toLocaleString() }} active</span>
      <span v-if="queuedCount" class="queued">{{ queuedCount.toLocaleString() }} queued</span>
      <span v-if="notCreatedCount" class="not-created">{{ notCreatedCount.toLocaleString() }} not created</span>
      <span v-if="cancelledCount" class="cancelled">{{ cancelledCount.toLocaleString() }} cancelled</span>
      <span v-if="failedCount" class="failed">{{ failedCount.toLocaleString() }} failed</span>
    </div>

    <div class="gs-batch-actions">
      <!-- v1.4.82 — this counted every in-flight item as an exception too, so
           a batch where nothing whatsoever had gone wrong still offered to
           inspect forty of them. An item the provider is working on is not an
           exception; the affordance now appears only when there is a real one
           to inspect. -->
      <button v-if="exceptionJobs.length" type="button" class="link-btn" @click="toggleExceptions">
        {{ showingExceptions ? 'Show all ledger' : `Inspect ${exceptionJobs.length.toLocaleString()} failed` }}
      </button>
      <button type="button" class="link-btn" @click="toggleLedger">
        {{ ledgerOpen ? 'Hide item ledger' : `Show item ledger (${remoteJobs.length.toLocaleString()})` }}
      </button>
    </div>

    <p v-if="contentRefusedCount" class="gs-batch-guidance">
      GenStudio marked {{ contentRefusedCount.toLocaleString() }} image{{ contentRefusedCount === 1 ? '' : 's' }} as a content refusal. Review the prompt, then use Reword to try a different angle; nothing is rewritten automatically.
    </p>
    <p v-if="notCreatedCount" class="gs-batch-guidance">
      GenStudio has no record of {{ notCreatedCount.toLocaleString() }} request{{ notCreatedCount === 1 ? '' : 's' }}.
      <template v-if="unchargedNotCreatedCount === notCreatedCount">
        {{ notCreatedCount === 1 ? 'It was' : 'They were' }} not created or charged; Retry resubmits only the missing work.
      </template>
      <template v-else>
        Some entries retain credit settlement details; review the ledger before retrying them.
      </template>
    </p>

    <GenStudioCreditSettlementHint :remote-jobs="remoteJobs" />

    <div v-if="ledgerOpen" class="gs-batch-ledger">
      <div class="gs-batch-ledger-head">
        <span>{{ showingExceptions ? 'Failed items' : 'All remote items' }}</span>
        <span>{{ visibleJobs.length.toLocaleString() }} item{{ visibleJobs.length === 1 ? '' : 's' }}</span>
      </div>
      <ul class="gs-batch-items">
        <li v-for="remote in pageItems" :key="remote.id">
          <span>{{ remote.operation }}</span>
          <strong :class="stateClass(remote)">
            {{ displayState(remote) }}
            <small v-if="remote.failure_code" class="gs-batch-diagnostic">{{ remote.failure_code }}</small>
          </strong>
          <span v-if="chargedFor(remote) > 0">{{ chargedFor(remote).toLocaleString() }} credits charged</span>
          <span v-else-if="returnedFor(remote) > 0">{{ returnedFor(remote).toLocaleString() }} credits returned</span>
          <span v-else-if="heldFor(remote) > 0">{{ heldFor(remote).toLocaleString() }} credits on hold</span>
          <span v-else>—</span>
          <!-- When this item last moved. `updated_at` is rewritten on every
               record write including the terminal one, so for a settled item
               it IS the settlement time — the per-item clock the job contract
               otherwise does not carry. -->
          <small v-if="settledAtLabel(remote)" class="gs-batch-when" :title="remote.updated_at">{{ settledAtLabel(remote) }}</small>
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
import { effectiveGenStudioTaskState } from '@shared/provider-task-state'

type RemoteJob = {
  id: string
  operation: string
  state: string
  queue_state?: string
  /**
   * Settlement values arrive ONLY when GenStudio publishes them. Image and chat
   * jobs may omit them; the authoritative triad lives on the
   * account-jobs snapshot, which the Jobs page merges in when it is available.
   */
  reserved_credits?: number
  settled_credits?: number
  released_credits?: number
  failure_code?: string | null
  cancelled?: boolean | null
  /** Rewritten on every record write, terminal write included. */
  updated_at?: string
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

function effectiveState(remote: RemoteJob): string {
  return effectiveGenStudioTaskState(remote)
}

function stateBucket(remote: RemoteJob): 'settled' | 'active' | 'queued' | 'not_created' | 'cancelled' | 'failed' {
  const state = effectiveState(remote)
  if (state === 'not_created') return 'not_created'
  if (remote.cancelled === true || state === 'cancelled' || /_CANCELLED_BY_CUSTOMER$/.test(remote.failure_code || '')) return 'cancelled'
  if (state === 'failed') return 'failed'
  if (/success|succeed|complete|done|settled/.test(state)) return 'settled'
  if (/queue|pending|wait|accept/.test(state)) return 'queued'
  return 'active'
}

function isImageContentRefused(remote: RemoteJob): boolean {
  return stateBucket(remote) === 'failed'
    && remote.operation === 'image.generation'
    && remote.failure_code === 'IMAGE_CONTENT_REFUSED'
}

function chargedFor(remote: RemoteJob): number {
  return numeric(remote.settled_credits)
}

function returnedFor(remote: RemoteJob): number {
  return numeric(remote.released_credits)
}

/**
 * Credits actually on hold — only ever the reservation GenStudio published.
 *
 * Falling back to `credit_cost` used to invent a hold for every job, so a batch
 * whose reservations had already been released still read "13 credits on hold"
 * days later. An unpublished reservation is unknown, not held.
 */
function heldFor(remote: RemoteJob): number {
  if (chargedFor(remote) > 0 || returnedFor(remote) > 0) return 0
  return numeric(remote.reserved_credits)
}

const settledCount = computed(() => props.remoteJobs.filter(remote => stateBucket(remote) === 'settled').length)
const activeCount = computed(() => props.remoteJobs.filter(remote => stateBucket(remote) === 'active').length)
const queuedCount = computed(() => props.remoteJobs.filter(remote => stateBucket(remote) === 'queued').length)
const notCreatedCount = computed(() => props.remoteJobs.filter(remote => stateBucket(remote) === 'not_created').length)
const unchargedNotCreatedCount = computed(() => props.remoteJobs.filter(remote => (
  stateBucket(remote) === 'not_created'
  && chargedFor(remote) === 0
  && heldFor(remote) === 0
  && returnedFor(remote) === 0
)).length)
const cancelledCount = computed(() => props.remoteJobs.filter(remote => stateBucket(remote) === 'cancelled').length)
const failedCount = computed(() => props.remoteJobs.filter(remote => stateBucket(remote) === 'failed').length)
const unresolvedCount = computed(() => activeCount.value + queuedCount.value)
const chargedCredits = computed(() => props.remoteJobs.reduce((sum, remote) => sum + chargedFor(remote), 0))
const heldCredits = computed(() => props.remoteJobs.reduce((sum, remote) => sum + heldFor(remote), 0))
const returnedCredits = computed(() => props.remoteJobs.reduce((sum, remote) => sum + returnedFor(remote), 0))
const contentRefusedCount = computed(() => props.remoteJobs.filter(isImageContentRefused).length)
/** Only genuine exceptions. Work in progress is not one. */
const exceptionJobs = computed(() => props.remoteJobs.filter(remote => stateBucket(remote) === 'failed'))
const visibleJobs = computed(() => showingExceptions.value ? exceptionJobs.value : props.remoteJobs)
const pageCount = computed(() => Math.max(1, Math.ceil(visibleJobs.value.length / PAGE_SIZE)))
const pageItems = computed(() => visibleJobs.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))

function segmentStyle(count: number) {
  return { width: `${(count / Math.max(1, props.remoteJobs.length)) * 100}%` }
}

const QUEUE_LABELS: Record<string, string> = {
  waiting_local: 'Waiting locally',
  submitting: 'Submitting to GenStudio',
  accepted: 'Accepted',
  waiting_account_capacity: 'Waiting for account capacity',
  reserved: 'Reserved',
  dispatched: 'Dispatched',
  validating: 'Validating',
  reconciling: 'Reconciling',
  running: 'Running',
  completing: 'Completing',
  succeeded: 'Succeeded',
  failed: 'Failed',
  not_created: 'Not created',
  waiting_credits: 'Waiting for credits',
  cancelled: 'Cancelled',
}

function displayState(remote: RemoteJob) {
  if (stateBucket(remote) === 'cancelled') return 'Cancelled'
  const state = effectiveState(remote) || 'unknown'
  return QUEUE_LABELS[state] || state.replace(/_/g, ' ')
}

function stateClass(remote: RemoteJob) {
  return `state-${stateBucket(remote)}`
}

/**
 * The clock time this item last moved — a wall-clock reading rather than a
 * relative age, because the drawer is opened on demand and a "4 min ago" that
 * silently stops ticking is worse than a time that is simply true.
 */
function settledAtLabel(remote: RemoteJob): string {
  const at = remote.updated_at ? Date.parse(remote.updated_at) : NaN
  if (!Number.isFinite(at)) return ''
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
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
.gs-batch-credit.muted { color: var(--text-muted); }.gs-batch-credit.held { color: var(--accent); }.gs-batch-credit.returned { color: var(--success, #3fb950); }
.gs-batch-progress { display: flex; height: 6px; overflow: hidden; margin-top: 8px; border-radius: 999px; background: var(--bg-primary); }
.gs-batch-progress span { min-width: 2px; }.gs-batch-progress .settled { background: var(--success, #3fb950); }.gs-batch-progress .active { background: var(--accent); }.gs-batch-progress .queued { background: #64748b; }.gs-batch-progress .not-created, .gs-batch-progress .cancelled { background: var(--text-muted); }.gs-batch-progress .failed { background: var(--danger, #f85149); }
.gs-batch-statuses { margin-top: 6px; font-size: var(--font-xs); }.gs-batch-statuses .settled { color: var(--success, #3fb950); }.gs-batch-statuses .active { color: var(--accent); }.gs-batch-statuses .queued, .gs-batch-statuses .not-created, .gs-batch-statuses .cancelled { color: var(--text-muted); }.gs-batch-statuses .failed { color: var(--danger, #f85149); }
.gs-batch-actions { margin-top: 7px; }.link-btn { border: 0; padding: 0; color: var(--accent); background: transparent; font: inherit; cursor: pointer; }.link-btn:hover { text-decoration: underline; }
.gs-batch-guidance { margin: 8px 0 0; color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.45; }
.gs-batch-ledger { margin-top: 8px; padding: 8px; border-radius: var(--radius-sm); background: var(--bg-primary); }.gs-batch-ledger-head { justify-content: space-between; color: var(--text-muted); font-size: var(--font-xs); }
.gs-batch-items { max-height: 270px; margin: 7px 0 0; padding: 0; overflow: auto; list-style: none; }.gs-batch-items li { display: grid; grid-template-columns: minmax(120px, 1fr) minmax(90px, auto) minmax(90px, auto) minmax(70px, auto); gap: 10px; padding: 5px 0; border-top: 1px solid var(--border); color: var(--text-secondary); font-size: var(--font-xs); }.gs-batch-when { color: var(--text-muted); font-size: inherit; font-variant-numeric: tabular-nums; white-space: nowrap; }.gs-batch-items strong { font-weight: 600; text-transform: capitalize; }.gs-batch-diagnostic { display: block; margin-top: 2px; color: var(--text-muted); font-size: inherit; font-weight: 400; text-transform: none; }.state-settled { color: var(--success, #3fb950); }.state-active { color: var(--accent); }.state-queued, .state-not_created, .state-cancelled { color: var(--text-muted); }.state-failed { color: var(--danger, #f85149); }
.gs-batch-pagination { justify-content: flex-end; margin-top: 8px; color: var(--text-muted); font-size: var(--font-xs); }
@media (max-width: 620px) { .gs-batch-items li { grid-template-columns: 1fr auto; }.gs-batch-items li > :last-child { grid-column: 1 / -1; } }
</style>
