<template>
  <!-- A stopped Gateway outranks every other fact: nothing can run while it is down. -->
  <button
    v-if="gatewayDown"
    type="button"
    class="genstudio-standing-strip gateway-down"
    :class="`standing-strip-${variant}`"
    aria-label="Gateway not reachable — open connection settings"
    @click="appSettingsModal.open('connections')"
  >
    <span class="gateway-dot" aria-hidden="true" />
    <strong>{{ variant === 'inline' ? 'Gateway unavailable' : 'Gateway not reachable' }}</strong>
    <small>{{ variant === 'inline' ? 'Open the Gateway app' : connection.hint }}</small>
  </button>
  <NuxtLink
    v-else-if="genstudioConfigured"
    to="/usage"
    class="genstudio-standing-strip"
    :class="`standing-strip-${variant}`"
    aria-label="Gateway account standing"
    :title="usageError || 'Open GenStudio usage'"
  >
    <span>Gateway</span>
    <small v-if="standingSummary">{{ standingSummary }}</small>
  </NuxtLink>
  <button
    v-else
    type="button"
    class="genstudio-standing-strip"
    :class="`standing-strip-${variant}`"
    aria-label="Connect Your Gateway"
    @click="appSettingsModal.open('connections')"
  >
    <!-- No key yet: this is the Gateway connection, not the paid GenStudio cloud service. -->
    <span>Gateway</span>
    <strong>{{ connectionSummary }}</strong>
    <small v-if="standingSummary">{{ standingSummary }}</small>
  </button>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { gatewayJobsLine } from '../utils/genstudio-freshness.js'

/**
 * `stacked` is the sidebar/band shape: the tier and lane line wraps onto its
 * own row. `inline` is the 38px application top bar, where a second row would
 * overflow the header — the same facts stay on one line and the strip shrinks
 * with an ellipsis instead of wrapping. A variant rather than a parent
 * override, because scoped-style specificity between a parent class and this
 * component's own is a tie decided by bundle order (AGENTS.md, "CSS that
 * silently does nothing").
 */
const { variant = 'stacked' } = defineProps<{ variant?: 'stacked' | 'inline' }>()

const {
  genstudioTier,
  genstudioActiveLanes,
  genstudioLaneLimit,
  genstudioConfigured,
  usageError,
  startPolling,
} = useCredits()
const appSettingsModal = useAppSettingsModal()
const { connection, gatewayDown } = useConnectionStatus()

/** The only wording the no-key state needs; money never appears in this strip. */
const connectionSummary = computed(() => {
  if (!genstudioConfigured.value) return 'Connect'
  return ''
})

const standingSummary = computed(() => {
  const facts: string[] = []
  if (genstudioTier.value) facts.push(genstudioTier.value.current.display_name)
  const jobs = gatewayJobsLine(genstudioActiveLanes.value, genstudioLaneLimit.value)
  if (jobs) facts.push(jobs)
  return facts.join(' · ')
})

let releasePolling: (() => void) | null = null
onMounted(() => { releasePolling = startPolling() })
onUnmounted(() => { releasePolling?.() })
</script>

<style scoped>
.genstudio-standing-strip {
  display: flex;
  min-width: 0;
  min-height: 32px;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 8px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.genstudio-standing-strip[type="button"] { width: 100%; background: transparent; cursor: pointer; font: inherit; text-align: left; }
.genstudio-standing-strip:hover { background: var(--bg-hover); color: var(--text-primary); }
.genstudio-standing-strip strong { color: var(--text-primary); font-weight: 650; }
.genstudio-standing-strip small { width: 100%; color: var(--text-muted); line-height: 1.35; }

.gateway-down { border-color: color-mix(in srgb, var(--error) 55%, var(--border)); color: var(--text-primary); }
.gateway-down strong { color: var(--error); }
.gateway-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: var(--error); }

/* Top-bar shape: one line inside a 38px header, shrinking rather than wrapping. */
.standing-strip-inline { min-height: 26px; flex-wrap: nowrap; justify-content: flex-start; gap: 7px; padding: 3px 9px; white-space: nowrap; }
.standing-strip-inline > * { overflow: hidden; text-overflow: ellipsis; }
.standing-strip-inline small { width: auto; min-width: 0; }
.gateway-down.standing-strip-inline small { display: none; }
</style>
