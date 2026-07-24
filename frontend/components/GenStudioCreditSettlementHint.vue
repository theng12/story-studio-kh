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
  credit_cost?: number
  reserved_credits?: number
  settled_credits?: number
  returned_credits?: number
  failure_code?: string | null
}

const props = defineProps<{ remoteJobs: readonly RemoteJob[]; compact?: boolean }>()

function numeric(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function stateBucket(remote: RemoteJob): 'settled' | 'active' | 'queued' | 'failed' {
  const state = String(remote.queue_state || remote.state || '').toLowerCase()
  if (remote.failure_code || /fail|error|cancel|reject/.test(state)) return 'failed'
  if (/success|succeed|complete|done|settled/.test(state)) return 'settled'
  if (/queue|pending|wait|accept/.test(state)) return 'queued'
  return 'active'
}

const heldOrFailedCount = computed(() => props.remoteJobs.filter(remote => {
  const bucket = stateBucket(remote)
  return (bucket === 'active' || bucket === 'queued' || bucket === 'failed')
    && (numeric(remote.reserved_credits) > 0 || numeric(remote.credit_cost) > 0)
}).length)
const failedCount = computed(() => props.remoteJobs.filter(remote => stateBucket(remote) === 'failed').length)

const message = computed(() => {
  if (!heldOrFailedCount.value) return ''
  if (failedCount.value) {
    return 'Failed items are not charged a second time. Any amount on hold stays provisional while GenStudio settles the result and returns unused credits.'
  }
  return 'Amounts on hold are provisional while GenStudio completes this work. It settles the final charge and returns unused credits automatically.'
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
