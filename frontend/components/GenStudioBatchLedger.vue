<template>
  <section class="gs-batch" aria-label="Gateway requests for this job">
    <div class="gs-batch-head">
      <!-- Two units live in this panel and they are not the same thing: the
           JOB's items (a chapter, a scene) and the Gateway REQUESTS sent for
           them (a retried item is sent twice). The head says which one it is
           counting; the list below is always the requests. -->
      <span class="meta-label">{{ items ? 'Job items:' : 'Gateway requests:' }}</span>
      <!-- v1.4.7 — every credit figure says "credits".
           These sit immediately after an ITEM count, and read without a unit:
           "50 items · 450 on hold" looks like 450 items on hold. They are
           credits, and one of them (`on hold`) already carried the unit on the
           jobs page while the other two did not — one fact, three spellings. -->
      <!-- The status row under the head counts the JOB's items, from the same
           derivation as the job card (useJobEta.summariseJobItems), so the two
           can never disagree. The list further down is the REQUESTS, and each
           request's own request-preview sits in that request's row — so there
           is one list of the requests and not two. -->
      <strong v-if="items">{{ items.total.toLocaleString() }}</strong>
      <strong v-else>{{ remoteJobs.length.toLocaleString() }}</strong>
      <template v-if="!free">
      <span v-if="chargedCredits > 0" class="gs-batch-credit">{{ chargedCredits.toLocaleString() }} credits charged</span>
      <span v-if="heldCredits > 0" class="gs-batch-credit held">{{ heldCredits.toLocaleString() }} credits on hold</span>
      <span v-if="returnedCredits > 0" class="gs-batch-credit returned">{{ returnedCredits.toLocaleString() }} credits returned</span>
      </template>
    </div>

    <div v-if="items" class="gs-batch-statuses" aria-label="Item status">
      <span v-if="items.finished" class="settled">{{ items.finished.toLocaleString() }} done</span>
      <span v-if="items.inFlight" class="active">{{ items.inFlight.toLocaleString() }} generating</span>
      <span v-if="items.waiting" class="queued">{{ items.waiting.toLocaleString() }} {{ items.waitingForMac ? 'waiting for a free Mac' : 'waiting to try again' }}</span>
      <span v-if="items.queued" class="queued">{{ items.queued.toLocaleString() }} not sent yet</span>
      <span v-if="items.failed" class="failed">{{ items.failed.toLocaleString() }} failed</span>
    </div>
    <template v-else>

    <div class="gs-batch-progress" aria-label="Request status distribution">
      <span v-if="settledCount" class="settled" :style="segmentStyle(settledCount)" :title="`${settledCount} settled`" />
      <span v-if="activeCount" class="active" :style="segmentStyle(activeCount)" :title="`${activeCount} active`" />
      <span v-if="queuedCount" class="queued" :style="segmentStyle(queuedCount)" :title="`${queuedCount} queued`" />
      <span v-if="notCreatedCount" class="not-created" :style="segmentStyle(notCreatedCount)" :title="`${notCreatedCount} not created`" />
      <span v-if="cancelledCount" class="cancelled" :style="segmentStyle(cancelledCount)" :title="`${cancelledCount} cancelled`" />
      <span v-if="heldCount" class="held" :style="segmentStyle(heldCount)" :title="`${heldCount} held`" />
      <span v-if="failedCount" class="failed" :style="segmentStyle(failedCount)" :title="`${failedCount} failed`" />
    </div>
    <div class="gs-batch-statuses">
      <span v-if="settledCount" class="settled">{{ settledCount.toLocaleString() }} settled</span>
      <span v-if="activeCount" class="active">{{ activeCount.toLocaleString() }} active</span>
      <span v-if="queuedCount" class="queued">{{ queuedCount.toLocaleString() }} queued</span>
      <span v-if="notCreatedCount" class="not-created">{{ notCreatedCount.toLocaleString() }} not created</span>
      <span v-if="cancelledCount" class="cancelled">{{ cancelledCount.toLocaleString() }} cancelled</span>
      <span v-if="heldCount" class="held">{{ heldCount.toLocaleString() }} held — outcome unknown</span>
      <span v-if="failedCount" class="failed">{{ failedCount.toLocaleString() }} failed</span>
    </div>
    </template>

    <div class="gs-batch-actions">
      <!-- v1.4.82 — this counted every in-flight item as an exception too, so
           a batch where nothing whatsoever had gone wrong still offered to
           inspect forty of them. An item the provider is working on is not an
           exception; the affordance now appears only when there is a real one
           to inspect. -->
      <!-- A failed Gateway request whose item is being tried again is not a failed item. -->
      <button v-if="exceptionJobs.length && (!items || items.failed)" type="button" class="link-btn" @click="toggleExceptions">
        {{ showingExceptions ? 'Show All Items' : `Inspect ${exceptionJobs.length.toLocaleString()} Failed` }}
      </button>
    </div>

    <p v-if="contentRefusedCount" class="gs-batch-guidance">
      The Gateway marked {{ contentRefusedCount.toLocaleString() }} image{{ contentRefusedCount === 1 ? '' : 's' }} as a content refusal. Review the prompt, then use Reword to try a different angle; nothing is rewritten automatically.
    </p>
    <p v-if="notCreatedCount" class="gs-batch-guidance">
      The Gateway has no record of {{ notCreatedCount.toLocaleString() }} request{{ notCreatedCount === 1 ? '' : 's' }}.
      <template v-if="unchargedNotCreatedCount === notCreatedCount">
        {{ notCreatedCount === 1 ? 'It was' : 'They were' }} not created or charged; Retry resubmits only the missing work.
      </template>
      <template v-else>
        Some entries retain credit settlement details; review the ledger before retrying them.
      </template>
    </p>

    <!-- No settlement sentence here. The card's ONE credit line explains the
         money, and it reads from the same evidence this ledger does — a second
         copy of the same sentence, a few lines below, says nothing new. -->

    <!-- ONE list of the items: what each one was asked for, where it got to,
         what it cost and when it last moved. The item list used to sit behind
         its own expander, and the request preview behind another one inside
         it — three levels of nesting to answer one question. -->
    <div class="gs-batch-ledger">
      <div class="gs-batch-ledger-head">
        <span>{{ showingExceptions ? 'Failed requests' : 'All requests' }}</span>
        <span>{{ visibleJobs.length.toLocaleString() }} request{{ visibleJobs.length === 1 ? '' : 's' }}</span>
      </div>
      <ul class="gs-batch-items">
        <li v-for="remote in pageItems" :key="remote.id" class="gs-batch-item">
          <div class="gs-batch-item-head">
            <span class="gs-batch-op">{{ jobOperationLabel(remote.operation) || remote.operation }}</span>
            <strong :class="stateClass(remote)">
              {{ displayState(remote) }}
              <small v-if="remote.failure_code" class="gs-batch-diagnostic">{{ remote.failure_code }}</small>
            </strong>
            <span class="gs-batch-credits">
              <template v-if="chargedFor(remote) > 0">{{ chargedFor(remote).toLocaleString() }} credits charged</template>
              <template v-else-if="returnedFor(remote) > 0">{{ returnedFor(remote).toLocaleString() }} credits returned</template>
              <template v-else-if="heldFor(remote) > 0">{{ heldFor(remote).toLocaleString() }} credits on hold</template>
              <template v-else-if="!describeJobCostUsd(remote)">—</template>
              <!-- The provider's own stated charge. Absent means "not stated" and prints nothing, never $0. -->
              <small v-if="describeJobCostUsd(remote)" class="gs-batch-diagnostic">{{ describeJobCostUsd(remote) }}</small>
            </span>
            <!-- When this item last moved. `updated_at` is rewritten on every
                 record write including the terminal one, so for a settled item
                 it IS the settlement time — the per-item clock the job contract
                 otherwise does not carry. -->
            <small v-if="settledAtLabel(remote)" class="gs-batch-when" :title="remote.updated_at">{{ settledAtLabel(remote) }}</small>
          </div>
          <!-- What was actually sent for THIS item: the product, the token
               limits and the fields that went on the wire, with the raw
               payload behind one expander. -->
          <GenStudioRequestPreview :entry="remote" />
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
import { describeJobCostUsd } from '../utils/genstudio-price-usd.js'
import { jobOperationLabel, jobStateBucket, type JobStateBucket } from '../utils/job-presentation.js'
import type { JobItemCounts } from '../composables/useJobEta'

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
  cost_usd?: number
  cost_source?: string
  cancelled?: boolean | null
  /** Rewritten on every record write, terminal write included. */
  updated_at?: string
  /** The Gateway holds a failed item as an unknown outcome (a song it may yet adopt). */
  recovery_required?: boolean | null
  recovery_state?: string | null
}

const props = defineProps<{
  remoteJobs: readonly RemoteJob[]
  /** The job's item counts (useJobEta.summariseJobItems), when it works through a list. */
  items?: Pick<JobItemCounts, 'total' | 'finished' | 'inFlight' | 'waiting' | 'waitingForMac' | 'queued' | 'failed'> | null
  /** Free fleet work: no credit figures at all. */
  free?: boolean
}>()

const PAGE_SIZE = 25
const showingExceptions = ref(false)
const page = ref(1)

function numeric(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function effectiveState(remote: RemoteJob): string {
  return effectiveGenStudioTaskState(remote)
}

/**
 * The state of a request, in the ONE vocabulary every surface uses
 * (`jobStateBucket` in utils/job-presentation.ts). The item list and the
 * settlement sentence read the same rule, so they cannot describe the same
 * request two different ways.
 */
function stateBucket(remote: RemoteJob): JobStateBucket {
  return jobStateBucket(remote)
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
/** Items the Gateway holds as an unknown outcome. */
const heldCount = computed(() => props.remoteJobs.filter(remote => stateBucket(remote) === 'held').length)
const failedCount = computed(() => props.remoteJobs.filter(remote => stateBucket(remote) === 'failed').length)
const chargedCredits = computed(() => props.remoteJobs.reduce((sum, remote) => sum + chargedFor(remote), 0))
const heldCredits = computed(() => props.remoteJobs.reduce((sum, remote) => sum + heldFor(remote), 0))
const returnedCredits = computed(() => props.remoteJobs.reduce((sum, remote) => sum + returnedFor(remote), 0))
const contentRefusedCount = computed(() => props.remoteJobs.filter(isImageContentRefused).length)
/** Only genuine exceptions. Work in progress is not one. */
const exceptionJobs = computed(() => props.remoteJobs.filter(remote => stateBucket(remote) === 'failed'))

/**
 * Newest first.
 *
 * The request previews are kept only for the newest items (the server bounds
 * them), and the newest items are the ones a user inspects after a failure —
 * so the list starts where the evidence is. Items with no timestamp keep
 * their own order behind the ones that have one.
 */
const orderedJobs = computed(() => {
  const time = (remote: RemoteJob): number => {
    const parsed = remote.updated_at ? Date.parse(remote.updated_at) : NaN
    return Number.isFinite(parsed) ? parsed : -Infinity
  }
  return props.remoteJobs
    .map((remote, index) => ({ remote, index }))
    .sort((a, b) => (time(b.remote) - time(a.remote)) || (a.index - b.index))
    .map(entry => entry.remote)
})
const visibleJobs = computed(() => showingExceptions.value ? exceptionJobs.value : orderedJobs.value)
const pageCount = computed(() => Math.max(1, Math.ceil(visibleJobs.value.length / PAGE_SIZE)))
const pageItems = computed(() => visibleJobs.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))

function segmentStyle(count: number) {
  return { width: `${(count / Math.max(1, props.remoteJobs.length)) * 100}%` }
}

const QUEUE_LABELS: Record<string, string> = {
  waiting_local: 'Waiting locally',
  submitting: 'Submitting to the Gateway',
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
  const bucket = stateBucket(remote)
  if (bucket === 'cancelled') return 'Cancelled'
  if (bucket === 'held') return 'Held — outcome unknown'
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

function toggleExceptions() {
  showingExceptions.value = !showingExceptions.value
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
.gs-batch-progress span { min-width: 2px; }.gs-batch-progress .settled { background: var(--success, #3fb950); }.gs-batch-progress .active { background: var(--accent); }.gs-batch-progress .queued { background: #64748b; }.gs-batch-progress .not-created, .gs-batch-progress .cancelled { background: var(--text-muted); }.gs-batch-progress .held { background: #e0b34b; }.gs-batch-progress .failed { background: var(--danger, #f85149); }
.gs-batch-statuses { margin-top: 6px; font-size: var(--font-xs); }.gs-batch-statuses .settled { color: var(--success, #3fb950); }.gs-batch-statuses .active { color: var(--accent); }.gs-batch-statuses .queued, .gs-batch-statuses .not-created, .gs-batch-statuses .cancelled { color: var(--text-muted); }.gs-batch-statuses .held { color: #e0b34b; }.gs-batch-statuses .failed { color: var(--danger, #f85149); }
.gs-batch-actions { margin-top: 7px; }.link-btn { border: 0; padding: 0; color: var(--accent); background: transparent; font: inherit; cursor: pointer; }.link-btn:hover { text-decoration: underline; }
.gs-batch-guidance { margin: 8px 0 0; color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.45; }
.gs-batch-ledger { margin-top: 8px; padding: 8px; border-radius: var(--radius-sm); background: var(--bg-primary); }.gs-batch-ledger-head { justify-content: space-between; color: var(--text-muted); font-size: var(--font-xs); }
.gs-batch-items { max-height: 420px; margin: 7px 0 0; padding: 0; overflow: auto; list-style: none; }
.gs-batch-item { padding: 6px 0; border-top: 1px solid var(--border); color: var(--text-secondary); font-size: var(--font-xs); }
.gs-batch-item-head { display: grid; grid-template-columns: minmax(80px, auto) minmax(120px, 1fr) minmax(90px, auto) minmax(70px, auto); gap: 10px; align-items: baseline; }
.gs-batch-op { color: var(--text-primary); font-weight: 600; }
.gs-batch-credits { font-variant-numeric: tabular-nums; }
.gs-batch-when { color: var(--text-muted); font-size: inherit; font-variant-numeric: tabular-nums; white-space: nowrap; }
.gs-batch-items strong { font-weight: 600; text-transform: capitalize; }.gs-batch-diagnostic { display: block; margin-top: 2px; color: var(--text-muted); font-size: inherit; font-weight: 400; text-transform: none; }.state-settled { color: var(--success, #3fb950); }.state-active { color: var(--accent); }.state-queued, .state-not_created, .state-cancelled { color: var(--text-muted); }.state-held { color: #e0b34b; }.state-failed { color: var(--danger, #f85149); }
.gs-batch-pagination { justify-content: flex-end; margin-top: 8px; color: var(--text-muted); font-size: var(--font-xs); }
@media (max-width: 620px) { .gs-batch-item-head { grid-template-columns: 1fr auto; } }
</style>
