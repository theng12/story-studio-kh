<template>
  <p v-if="message || showLink" class="credit-settlement-hint" :class="{ compact, inline }">
    <span v-if="message">{{ message }}</span>
    <NuxtLink v-if="showLink" to="/usage">Credits &amp; settlement</NuxtLink>
  </p>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { jobStateBucket } from '../utils/job-presentation'
import { summariseSettlement } from '../composables/useJobEta'

type RemoteJob = {
  state?: string
  queue_state?: string
  /** Published by GenStudio only. */
  reserved_credits?: number
  settled_credits?: number
  released_credits?: number
  failure_code?: string | null
  /** The Gateway holds a failed item as an unknown outcome. */
  recovery_required?: boolean | null
  recovery_state?: string | null
}

const props = withDefaults(defineProps<{
  remoteJobs: readonly RemoteJob[]
  compact?: boolean
  /** The card's own credit line already carries the link; the hint need not repeat it. */
  link?: boolean
  /** Inside another line rather than in a box of its own. */
  inline?: boolean
}>(), {
  link: true,
  inline: false,
})

function numeric(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

/**
 * The state of a request, in the ONE vocabulary the Gateway item list uses
 * too (`jobStateBucket` in utils/job-presentation.ts). Two copies of this
 * rule had drifted: the item list knew about a request the Gateway still
 * holds as an unknown outcome, and this copy did not, so one card described
 * the same request two ways.
 */
function stateBucket(remote: RemoteJob) {
  return jobStateBucket(remote)
}

/**
 * Only an unfinished job can be holding credits, and only when GenStudio has
 * actually published a reservation. Treating `credit_cost` as a hold made every
 * settled batch keep claiming credits were on hold long after they were
 * released — the reservation is unknown, not held.
 *
 * A request the Gateway still holds as an unknown outcome counts too: its
 * reservation is published and not final, which is exactly what the card's
 * own "N credits on hold" figure says (the same rule, from
 * `summariseSettlement`). Before this, the figure said "on hold" and the
 * sentence beside it said "checking for the final outcome" — one card, two
 * vocabularies for one fact.
 */
const heldCount = computed(() => props.remoteJobs.filter(remote => {
  const bucket = stateBucket(remote)
  return (bucket === 'active' || bucket === 'queued' || bucket === 'held')
    && numeric(remote.reserved_credits) > 0
}).length)

/**
 * Whether the Gateway has published a settlement that adds up.
 *
 * The same derivation the card's credit figures come from (`summariseSettlement`),
 * so the sentence below and the numbers beside it can never disagree.
 */
const confirmed = computed(() => summariseSettlement(props.remoteJobs).confirmed)

/**
 * THE credit explanation — one sentence, said once.
 *
 * It used to be two: the money row said what was charged, a separate hint box
 * said the Gateway had published a provisional reservation, and an exception
 * line said the credit outcome was pending. Three sentences about one fact, and
 * the pending one wore the warning styling of a failure.
 *
 * Now there is one, and it says what is actually true: either the Gateway has
 * published a provisional reservation it has not finalised, or it has published
 * no settlement yet and Story Studio is still checking.
 */
const message = computed(() => {
  if (heldCount.value) return 'The Gateway has published a provisional reservation while this work settles.'
  if (!confirmed.value) return 'Story Studio is checking the Gateway for the final credit outcome.'
  return ''
})

/** The link to the settlement record — only while there is something unsettled. */
const showLink = computed(() => props.link && !confirmed.value)
</script>

<style scoped>
.credit-settlement-hint {
  display: flex;
  align-items: baseline;
  gap: 6px 10px;
  flex-wrap: wrap;
  margin: 8px 0 0;
  padding: 7px 8px;
  border: 1px solid rgba(224, 179, 75, .28);
  border-radius: var(--radius-sm);
  background: rgba(224, 179, 75, .07);
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: 1.45;
}
.credit-settlement-hint.compact { margin-top: 6px; }
.credit-settlement-hint.inline {
  display: inline;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
}
.credit-settlement-hint a { color: var(--accent); font-weight: 600; text-decoration: none; white-space: nowrap; }
.credit-settlement-hint a:hover { text-decoration: underline; }
</style>
