<template>
  <section class="job-details" aria-label="Job details">
    <!-- What the provider itself said, and what the Gateway was doing when it
         said it. This is the provider's own wording, so it belongs in the
         diagnostics rather than on the card's face — the card carries one
         summary line derived from OUR evidence, and the provider's prose used
         to sit beside it and repeat the same state in three more words. -->
    <div v-if="providerStatus || providerQueue" class="job-detail-block">
      <h4 class="job-detail-heading">What the provider reported</h4>
      <p v-if="providerStatus" class="job-detail-line">{{ providerStatus }}</p>
      <p v-if="providerQueue" class="job-detail-line">{{ providerQueue }}</p>
    </div>

    <p v-if="summaryLine" class="technical-summary">{{ summaryLine }}</p>

    <EpisodeRecoveryStatus :job="job" diagnostics-only />

    <!-- ONE list of the Gateway items: what each was asked for, where it got
         to, what it cost and when it last moved. -->
    <GenStudioBatchLedger v-if="remoteJobs.length" :remote-jobs="remoteJobs" :items="counts" :free="free" />

    <!--
      What the job is actually working on, item by item. A percentage
      says how far; a long-running step that reports nothing else is
      indistinguishable from a hang, and that ambiguity has already
      produced a wrong diagnosis. `waiting_retry` in particular is a
      job doing exactly what it should and must not read as stuck.

      The counts are stated ONCE. The Gateway item list above already states
      them, from the same derivation — saying them here as well put two
      copies of the same numbers a few lines apart, and the two copies were
      not even the same numbers: the raw per-field values and the derivation
      disagree about a held item (the Gateway still holds it, so it is
      settling, not failed). When there is no Gateway item list — a local
      job — this line is the only place the counts can be.
    -->
    <div v-if="job.item_progress" class="job-items">
      <template v-if="!hasItemList">
        <span class="job-items-count">
          {{ counts?.finished.toLocaleString() ?? '0' }} of {{ counts?.total.toLocaleString() ?? '0' }} done
        </span>
        <span v-if="counts?.waiting" class="job-items-note">
          · {{ counts.waiting.toLocaleString() }} {{ counts.waitingForMac ? 'waiting for a free Mac' : 'waiting to try again' }}
        </span>
        <span v-if="counts?.failed" class="job-items-failed">
          · {{ counts.failed.toLocaleString() }} failed
        </span>
        <span v-if="counts?.queued" class="job-items-note">
          · {{ counts.queued.toLocaleString() }} not submitted
        </span>
      </template>
      <!-- The two counts the item list does not carry. -->
      <span v-if="counts?.settling" class="job-items-note">
        · {{ counts.settling.toLocaleString() }} settling
      </span>
      <span v-if="counts?.cancelled" class="job-items-note">
        · {{ counts.cancelled.toLocaleString() }} cancelled by customer
      </span>
      <span
        v-if="job.item_progress.concurrency === 1 && job.item_progress.total > 1"
        class="job-items-note"
        title="Sent to the provider one request at a time, on purpose — a whole batch at once gets most of it refused."
      >· one at a time</span>
      <span
        v-for="item in job.item_progress.active"
        :key="item.key || item.label"
        class="job-items-active"
        :class="{ waiting: item.state === 'waiting_retry' }"
      >· {{ itemAttemptText(item) }}</span>
    </div>

    <div v-if="job.output_lines?.length" class="job-output">
      <code v-for="(line, i) in outputLines" :key="i">{{ customerText(line) }}</code>
    </div>
    <div class="job-technical-ids">
      <span v-if="outputDir" class="meta-tag"><span class="meta-label">Output folder:</span> {{ outputDir }}</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, type DeepReadonly } from 'vue'
import { FREE_MAC_WAIT_REASON, isFreeFleetWork } from '@shared/provider-task-state'
import { WAITING_FALLBACK_REASON, type JobItemCounts } from '../composables/useJobEta'
import type { Job } from '~/composables/useJobs'
import { customerSafeJobText, jobRequestIds, visibleJobOutputLines } from '../utils/job-presentation'
import { deriveOutputDir, rowOutputLineCount } from '../utils/jobs-list'

/**
 * The shared body of a job card's "Technical details" drawer.
 *
 * It exists because the Active card and the History card used to carry two
 * copies of the same blocks, and the copies drifted: the History card lost the
 * per-item concurrency note, the request preview and the ledger were two lists
 * of the same items, and the raw payload sat behind an expander inside an
 * expander inside the drawer.
 *
 * This component is display-only. It reads what the server published and
 * renders it; it never reconstructs a request, a provider detail, or a charge.
 */
type JobItemAttempt = {
  label: string
  key?: string
  state: 'running' | 'waiting_retry'
  attempt: number
  max_attempts: number
  retry_at?: string
  reason?: string
}

const props = defineProps<{
  /** The job, exactly as the page holds it. Display-only: reads what the server published. */
  job: DeepReadonly<Job>
  /** The Gateway evidence for this job, already merged with the account settlement. */
  remoteJobs: readonly any[]
  /** The job's item counts (useJobEta.summariseJobItems). */
  counts: JobItemCounts | null
  /** The provider's own wording about the newest request, if it published any. */
  providerStatus?: string
  /** What the Gateway was doing with the newest request, if it said. */
  providerQueue?: string
  /** The wall clock, for the retry countdown. */
  nowMs: number
}>()

/**
 * Free fleet work: no credit figures at all.
 *
 * The shared predicate, not a rule of its own — the page's own "Credits:"
 * line uses the same one, so the two can never disagree about whether this
 * job cost anything.
 */
const free = computed(() => isFreeFleetWork(props.remoteJobs as ReadonlyArray<{ model_id?: unknown }>))

/**
 * Is the Gateway item list on screen?
 *
 * It states the item counts itself, from the same derivation this component
 * is given — so the counts are printed once, in one place, whichever of the
 * two is showing.
 */
const hasItemList = computed(() => props.remoteJobs.length > 0)

/** How much is folded away behind this drawer. */
const summaryLine = computed(() => {
  const parts: string[] = []
  const lines = rowOutputLineCount(props.job as any)
  if (lines) parts.push(`${lines} log line${lines === 1 ? '' : 's'}`)
  // Every remote row is one Gateway request. Counting only the ones that
  // happen to have a stored preview would understate the work the job did —
  // and the preview count is not what this line is about.
  const requests = (props.remoteJobs || []).length
  if (requests) parts.push(`${requests} request${requests === 1 ? '' : 's'}`)
  return parts.join(' + ')
})

/**
 * One line for one in-flight item. A backoff shows the seconds left so the
 * pause visibly ticks down instead of looking frozen.
 */
function itemAttemptText(item: JobItemAttempt): string {
  if (item.state !== 'waiting_retry') return `${item.label} — running`
  const remaining = item.retry_at
    ? Math.max(0, Math.round((new Date(item.retry_at).getTime() - props.nowMs) / 1000))
    : 0
  // A wait for a free Mac is not a numbered attempt; it ends when a Mac frees up.
  if (item.reason === FREE_MAC_WAIT_REASON) return `${item.label}: waiting for a free Mac; next try ${remaining ? `in ${remaining}s` : 'now'}`
  return `${item.label}: ${item.reason || WAITING_FALLBACK_REASON};`
    + ` retrying${remaining ? ` in ${remaining}s` : ' now'}`
    + ` (attempt ${item.attempt + 1} of ${item.max_attempts})`
}

/** The log, without the request identities the customer never sees. */
const outputLines = computed(() => visibleJobOutputLines(props.job.output_lines))
function customerText(value: unknown): string {
  return customerSafeJobText(value, jobRequestIds(props.job))
}
const outputDir = computed(() => deriveOutputDir(props.job as any))
</script>

<style scoped>
.job-details { display: block; min-width: 0; }
.job-detail-block { margin-bottom: 8px; }
.job-detail-heading {
  margin: 0 0 4px;
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .04em;
}
.job-detail-line { margin: 0 0 3px; color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.45; }
.technical-summary { margin: 0 0 8px; color: var(--text-muted); font-size: var(--font-xs); }
.job-items {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 4px 0 6px;
  font-size: var(--font-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.job-items-count { color: var(--text-primary); font-weight: 500; }
.job-items-failed { color: rgb(202, 138, 4); }
.job-items-note { border-bottom: 1px dotted var(--border); cursor: help; }
.job-items-active.waiting { color: rgb(202, 138, 4); }
.job-technical-ids { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 8px; overflow-wrap: anywhere; }
/* Customer-safe job output. */
.job-output {
  margin-top: 6px; background: var(--bg-primary); border-radius: var(--radius-sm);
  padding: 10px; font-size: var(--font-xs); max-height: 250px; overflow-y: auto;
}
.job-output code {
  display: block; color: var(--text-secondary);
  font-family: 'SF Mono', Monaco, monospace; line-height: 1.6;
}
</style>
