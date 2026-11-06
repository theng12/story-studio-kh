<template>
  <!--
    Per-block freshness line. The smallest adoption is one line next to the
    block's title, naming the path that block reads:

      <ApiDataStatus path="/projects" />

    That alone gives three honest states:

      · updating — "Shown from 2 min ago · updating"
      · failed   — "Couldn't refresh: <why> · Retry"
      · fresh    — nothing rendered (a silent line would be noise)

    A page that reads outside the shared cache (its own store, say) passes
    the three values instead of `path`. Wrapping mode also dims the stale
    block with a soft shimmer, so a caller that wants both the line and the
    treatment writes:

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
      Couldn't refresh: {{ errorText }}
      <button type="button" class="api-data-status__retry" @click="onRetry">Retry</button>
    </span>

    <span v-else-if="showAge" class="api-data-status__line" role="status">
      <span v-if="isRefreshing" class="api-data-status__pulse" aria-hidden="true" />
      Shown from {{ ageText }}<template v-if="isRefreshing"> · updating</template>
    </span>
  </component>
</template>

<script setup lang="ts">
import { computed, useSlots } from 'vue'
import { swrReactive, swrForceRefresh } from '~/utils/swrCache'
import { useApi } from '~/composables/useApi'

const props = withDefaults(defineProps<{
  /**
   * API path this block reads (e.g. `/projects`), when the page wants the
   * line to follow the shared cache entry for that read. Given, the page
   * needs no script at all: age, refreshing and error all come from the
   * entry, and Retry re-reads it.
   *
   * Fixed for the life of the component (a page's data source does not
   * change while it is mounted).
   */
  path?: string
  /** Unix ms of the last successful fetch, or null when there is none. */
  updatedAt?: number | null
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
  path: '',
  showAge: false,
  ageAfterMs: 30_000,
})

const emit = defineEmits<{ retry: [] }>()

const slots = useSlots()
const hasSlot = computed(() => !!slots.default)

// Cache view for `path`. `swrReactive` hands back the live refs for the
// entry, so the line follows a background refresh without the page wiring
// anything up. No path → the page's own props below.
const view = props.path ? swrReactive<unknown>(`GET:${props.path}`) : null

/**
 * A timestamp is either a real one or there is none — a NaN from a value
 * that is not a date must never render as "NaN s ago" (AGENTS.md §6: a
 * value that cannot be worked out is not a measurement).
 */
const ageFrom = computed(() => {
  const raw = view ? view.updatedAt.value : props.updatedAt
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null
})
const refreshing = computed(() => (view ? view.refreshing.value : props.refreshing === undefined ? false : props.refreshing))
const errorText = computed(() => (view ? view.error.value : props.error ?? null) || null)
const hasError = computed(() => !!errorText.value)
const isRefreshing = computed(() => refreshing.value)
const isFresh = computed(() => !refreshing.value && !errorText.value)

/** Plain-word age: "just now", "40 s ago", "2 min ago", "3 h ago". */
const ageText = computed(() => {
  const at = ageFrom.value
  if (!at) return 'an earlier load'
  const elapsed = Date.now() - at
  if (elapsed < 10_000) return 'just now'
  const s = Math.floor(elapsed / 1000)
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
})

/**
 * The line only appears when it says something the user needs: either a
 * failure, or an age past the threshold, or a refresh running against a
 * value that is already on screen. A cold load has no shown value to date,
 * so it stays silent — the page's own loading state speaks for it.
 */
const showAgeLine = computed(() => {
  const at = ageFrom.value
  if (!at) return false
  if (Date.now() - at < props.ageAfterMs) return false
  return true
})

// `showAge` prop opts into the age line unconditionally (for pages that
// always want to say where the data came from); otherwise it follows the
// threshold above.
const showAge = computed(() => props.showAge || showAgeLine.value || (isRefreshing.value && !!ageFrom.value))

/**
 * Retry: drop the stored answer so the next read must go to the network,
 * tell the page (so a page that keeps its own copy reloads it), and re-read
 * the path when this component owns it. A page that binds @retry does the
 * same read — the two join one request rather than doubling it.
 */
async function onRetry(): Promise<void> {
  if (props.path) swrForceRefresh(`GET:${props.path}`)
  emit('retry')
  if (props.path) {
    const { get } = useApi()
    await get(props.path).catch(() => { /* the line keeps the failure visible */ })
  }
}
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
  cursor: pointer;
}

.api-data-status__retry:hover {
  background: rgba(255, 255, 255, 0.2);
}
</style>