<template>
  <!--
    Per-block freshness line. Pages drop this next to a block that reads
    through useApiData, or wrap the block in it, and get three honest
    states for free:

      · updating — "Shown from 2 min ago · updating"
      · failed   — "Couldn't refresh: <why> · Retry"
      · fresh    — nothing rendered (a silent line would be noise)

    Wrapping mode also dims the stale block with a soft shimmer, so a
    caller that wants both the line and the treatment writes:

      <ApiDataStatus :updated-at="updatedAt" :refreshing="refreshing"
                     :error="error" @retry="refresh">
        …the block…
      </ApiDataStatus>

    The line is rendered in normal flow (no absolute positioning) so it
    can never shift the layout of the block it sits above.
  -->
  <component
    :is="hasSlot ? 'div' : 'span'"
    class="api-data-status"
    :class="{ 'api-data-status--wrapped': hasSlot, 'api-data-status--stale': showAge && !isFresh }"
  >
    <span v-if="hasSlot" class="api-data-status__slot">
      <slot />
    </span>

    <span v-if="hasError" class="api-data-status__line api-data-status__line--error" role="status">
      <span class="api-data-status__dot" aria-hidden="true" />
      Couldn't refresh: {{ error }}
      <button type="button" class="api-data-status__retry" @click="$emit('retry')">Retry</button>
    </span>

    <span v-else-if="showAge" class="api-data-status__line" role="status">
      <span v-if="isRefreshing" class="api-data-status__pulse" aria-hidden="true" />
      Shown from {{ ageText }}<template v-if="isRefreshing"> · updating</template>
    </span>
  </component>
</template>

<script setup lang="ts">
import { computed, useSlots } from 'vue'

const props = withDefaults(defineProps<{
  /** Unix ms of the last successful fetch, or null when there is none. */
  updatedAt: number | null
  /** True while a background refresh is in flight. */
  refreshing?: boolean
  /** Last refresh error, or null when the last refresh succeeded. */
  error?: string | null
  /**
   * Say how old the shown value is. Off by default: the age of a value
   * that refreshed a moment ago is noise, so only a value older than
   * `ageAfterMs` is labelled.
   */
  showAge?: boolean
  /** Age threshold (ms) before the line is worth showing. Default 30 s. */
  ageAfterMs?: number
}>(), {
  refreshing: false,
  error: null,
  showAge: false,
  ageAfterMs: 30_000,
})

defineEmits<{ retry: [] }>()

const slots = useSlots()
const hasSlot = computed(() => !!slots.default)
const hasError = computed(() => !!props.error)
const isRefreshing = computed(() => props.refreshing)
const isFresh = computed(() => !props.refreshing && !props.error)

/** Plain-word age: "just now", "40 s ago", "2 min ago", "3 h ago". */
const ageText = computed(() => {
  if (!props.updatedAt) return 'an earlier load'
  const ms = Date.now() - props.updatedAt
  if (ms < 10_000) return 'just now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
})

/**
 * The line only appears when it says something the user needs: either a
 * failure, or an age past the threshold. A value fetched a second ago is
 * simply current.
 */
const showAgeLine = computed(() => {
  if (!props.updatedAt) return false
  if (Date.now() - props.updatedAt < props.ageAfterMs) return false
  return true
})

// `showAge` prop opts into the age line unconditionally (for pages that
// always want to say where the data came from); otherwise it follows the
// threshold above.
const showAge = computed(() => props.showAge || showAgeLine.value || props.refreshing)
</script>

<style scoped>
.api-data-status {
  display: contents;
}

.api-data-status--wrapped {
  display: block;
}

.api-data-status__slot {
  display: block;
  transition: opacity 160ms ease;
}

/* Soft dim while the block's data is being revalidated. Never changes
   geometry — opacity only — so nothing shifts. */
.api-data-status--stale .api-data-status__slot {
  opacity: 0.72;
}

.api-data-status__line {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 11.5px;
  line-height: 1.3;
  color: var(--text-muted, rgba(255, 255, 255, 0.55));
}

.api-data-status__line--error {
  color: #ffcf87;
}

.api-data-status__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}

.api-data-status__pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
  animation: api-pulse 1.1s ease-in-out infinite;
}

@keyframes api-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

.api-data-status__retry {
  background: rgba(255, 255, 255, 0.1);
  color: inherit;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 4px;
  padding: 1px 8px;
  font-size: 11px;
  cursor: pointer;
}

.api-data-status__retry:hover {
  background: rgba(255, 255, 255, 0.2);
}
</style>