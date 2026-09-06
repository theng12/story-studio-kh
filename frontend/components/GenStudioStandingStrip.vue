<template>
  <NuxtLink
    v-if="genstudioConfigured"
    to="/usage"
    class="genstudio-standing-strip"
    :class="`standing-strip-${variant}`"
    aria-label="GenStudio account standing"
    :title="usageError || 'Open GenStudio usage'"
  >
    <span>GenStudio</span>
    <strong>{{ creditSummary }}</strong>
    <em v-if="stalenessNote" class="freshness-badge">{{ stalenessNote }}</em>
    <small v-if="standingSummary">{{ standingSummary }}</small>
  </NuxtLink>
  <button
    v-else
    type="button"
    class="genstudio-standing-strip"
    :class="`standing-strip-${variant}`"
    aria-label="Set up GenStudio"
    :title="usageError || 'Set up GenStudio'"
    @click="appSettingsModal.open('connections')"
  >
    <span>GenStudio</span>
    <strong>{{ creditSummary }}</strong>
    <em v-if="stalenessNote" class="freshness-badge">{{ stalenessNote }}</em>
    <small v-if="standingSummary">{{ standingSummary }}</small>
  </button>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { genstudioStaleNote } from '../utils/genstudio-freshness.js'

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
  genstudioCredits,
  genstudioCreditsLoadedAt,
  genstudioCreditsStale,
  genstudioTier,
  genstudioActiveLanes,
  genstudioLaneLimit,
  genstudioConfigured,
  usageError,
  startPolling,
} = useCredits()
const appSettingsModal = useAppSettingsModal()

/**
 * Three states, not two. A balance we hold is shown whether or not the last
 * refresh landed; `Unavailable` is reserved for having no balance at all, after
 * the server's own retries and its stale fallback have both been exhausted.
 * Announcing an outage on one slow response, next to a job generating happily,
 * is how this strip used to mislead.
 */
const creditSummary = computed(() => {
  if (!genstudioConfigured.value) return 'Set up'
  if (genstudioCredits.value === null) return 'Unavailable'
  return `${genstudioCredits.value.toLocaleString()} credits`
})

/** Empty on the happy path, so nothing is rendered when the balance is current. */
const stalenessNote = computed(() => (
  genstudioConfigured.value && genstudioCredits.value !== null
    ? genstudioStaleNote(genstudioCreditsStale.value, genstudioCreditsLoadedAt.value)
    : ''
))

const standingSummary = computed(() => {
  const facts: string[] = []
  if (genstudioTier.value) facts.push(genstudioTier.value.current.display_name)
  if (genstudioActiveLanes.value !== null && genstudioLaneLimit.value !== null) {
    facts.push(`${genstudioActiveLanes.value}/${genstudioLaneLimit.value} lanes`)
  }
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
/* Unobtrusive by design: a muted aside, never a banner. */
.genstudio-standing-strip .freshness-badge { color: var(--text-muted); font-style: normal; font-size: var(--font-xs); }

/* Top-bar shape: one line inside a 38px header, shrinking rather than wrapping. */
.standing-strip-inline { min-height: 26px; flex-wrap: nowrap; justify-content: flex-start; gap: 7px; padding: 3px 9px; white-space: nowrap; }
.standing-strip-inline > * { overflow: hidden; text-overflow: ellipsis; }
.standing-strip-inline small { width: auto; min-width: 0; }
</style>
