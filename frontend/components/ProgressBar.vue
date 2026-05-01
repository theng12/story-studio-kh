<template>
  <div
    class="progress-bar"
    role="progressbar"
    :aria-valuemin="0"
    :aria-valuemax="100"
    :aria-valuenow="indeterminate ? undefined : (progress ?? 0)"
    :aria-label="ariaLabelText"
  >
    <div v-if="label" class="pb-label" :title="labelTitle">{{ label }}</div>
    <div class="pb-track" :class="{ indeterminate }">
      <div
        v-if="!indeterminate"
        class="pb-fill"
        :style="{ width: clampedProgress + '%' }"
      />
      <div v-else class="pb-indet-bar" />
    </div>
    <div class="pb-meta">
      <span
        v-if="!indeterminate"
        class="pb-pct"
        title="Percentage complete"
      >{{ clampedProgress }}%</span>
      <span
        v-if="bytesDone != null"
        class="pb-bytes"
        :title="bytesTotal != null ? 'Bytes transferred / total file size' : 'Bytes transferred so far'"
      >
        {{ formatBytes(bytesDone) }}<template v-if="bytesTotal != null"> / {{ formatBytes(bytesTotal) }}</template>
      </span>
      <span
        v-if="speedBps != null && speedBps > 0"
        class="pb-speed"
        title="Current transfer speed (rolling 5-second average)"
      >{{ formatSpeed(speedBps) }}</span>
      <span
        v-if="etaSeconds != null && etaSeconds > 0 && !indeterminate"
        class="pb-eta"
        title="Estimated time remaining at current speed"
      >ETA {{ formatDuration(etaSeconds) }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatBytes, formatSpeed, formatDuration } from '~/composables/useFormat'

const props = withDefaults(defineProps<{
  /** 0–100. Ignored when `indeterminate` is true. */
  progress?: number
  bytesDone?: number
  bytesTotal?: number
  speedBps?: number
  etaSeconds?: number
  /** When true, renders an animated stripe instead of a fill — used when
   *  total bytes are unknown (CDN didn't send Content-Length). */
  indeterminate?: boolean
  /** Optional caption shown above the bar. Hover-explainable. */
  label?: string
  /** Tooltip for the label — context for what this transfer represents. */
  labelTitle?: string
}>(), {
  indeterminate: false,
})

const clampedProgress = computed(() => {
  const p = props.progress
  if (p == null || !Number.isFinite(p)) return 0
  return Math.max(0, Math.min(100, Math.round(p)))
})

const ariaLabelText = computed(() => {
  if (props.label) return props.label
  return props.indeterminate ? 'In-progress transfer' : 'Transfer progress'
})
</script>

<style scoped>
.progress-bar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  font-size: 11px;
  color: var(--text-secondary, #94a3b8);
}
.pb-label {
  font-weight: 500;
  color: var(--text-primary, #e2e8f0);
}
.pb-track {
  position: relative;
  width: 100%;
  height: 6px;
  background: var(--bg-secondary, rgba(148, 163, 184, 0.16));
  border-radius: 999px;
  overflow: hidden;
}
.pb-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent, #60a5fa), var(--info, #60a5fa));
  border-radius: 999px;
  transition: width 0.25s ease-out;
}
.pb-track.indeterminate .pb-indet-bar {
  position: absolute;
  inset: 0;
  width: 35%;
  background: linear-gradient(90deg, transparent, var(--accent, #60a5fa), transparent);
  animation: pb-slide 1.4s ease-in-out infinite;
}
@keyframes pb-slide {
  0%   { left: -35%; }
  100% { left: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .pb-fill { transition: none; }
  .pb-track.indeterminate .pb-indet-bar { animation: none; opacity: 0.6; left: 35%; }
}
.pb-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-variant-numeric: tabular-nums;
}
.pb-pct {
  font-weight: 600;
  color: var(--text-primary, #e2e8f0);
}
</style>
