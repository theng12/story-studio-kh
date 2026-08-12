<template>
  <p v-if="message" class="credit-settlement-hint" :class="{ compact }">
    <span>{{ message }}</span>
    <NuxtLink to="/usage">Credits &amp; settlement</NuxtLink>
  </p>
</template>

<script setup lang="ts">
import { computed } from 'vue'

type RemoteJob = {
  state?: string
  queue_state?: string
  /** Published by GenStudio only. */
  reserved_credits?: number
  settled_credits?: number
  released_credits?: number
  failure_code?: string | null
}

const props = defineProps<{ remoteJobs: readonly RemoteJob[]; compact?: boolean }>()

function numeric(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function stateBucket(remote: RemoteJob): 'settled' | 'active' | 'queued' | 'failed' {
  const state = String(remote.queue_state || remote.state || '').toLowerCase()
  if (state === 'failed' || state === 'cancelled') return 'failed'
  if (/success|succeed|complete|done|settled/.test(state)) return 'settled'
  if (/queue|pending|wait|accept/.test(state)) return 'queued'
  return 'active'
}

/**
 * Only an unfinished job can be holding credits, and only when GenStudio has
 * actually published a reservation. Treating `credit_cost` as a hold made every
 * settled batch keep claiming credits were on hold long after they were
 * released — the reservation is unknown, not held.
 */
const heldCount = computed(() => props.remoteJobs.filter(remote => {
  const bucket = stateBucket(remote)
  return (bucket === 'active' || bucket === 'queued') && numeric(remote.reserved_credits) > 0
}).length)
const message = computed(() => {
  if (!heldCount.value) return ''
  return 'GenStudio has published a provisional reservation while this work settles.'
})
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
.credit-settlement-hint a { color: var(--accent); font-weight: 600; text-decoration: none; white-space: nowrap; }
.credit-settlement-hint a:hover { text-decoration: underline; }
</style>
