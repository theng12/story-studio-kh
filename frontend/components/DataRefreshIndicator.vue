<template>
  <!--
    Shared data-refresh sign. Two instances of this component live in
    AppHeader, so every page gets both without importing anything:

      variant="pill"    — a small "Updating…" chip in the header's reserved
                          slot at the END of the top bar. The slot is always
                          there (fixed width), so the nav never moves when
                          the chip appears, and the chip is in normal flow,
                          so it can never sit on top of a link.
      variant="banner"  — the failure strip directly under the bar, in flow:
                          a loud, plain sentence with a Retry. It pushes the
                          page down while it shows rather than covering it.

    Three states between them, all small and calm:

     1. Refreshing (debounced 300 ms): "Updating…" with a small pulse.
     2. Shown-old data: the per-page ApiDataStatus line owns
        "Shown from 2 min ago · updating".
     3. Failed refresh: "Couldn't refresh: <why> · Retry", in the banner.
  -->
  <Transition :name="variant === 'pill' ? 'refresh-fade' : 'refresh-banner'">
    <div
      v-if="variant === 'pill' ? debouncedRefreshing : firstError"
      class="data-refresh-indicator"
      :class="`data-refresh-indicator--${variant}`"
      :role="variant === 'pill' ? 'status' : 'alert'"
      :aria-live="variant === 'pill' ? 'polite' : 'assertive'"
      :title="variant === 'pill' ? 'Refreshing data in the background' : undefined"
    >
      <div v-if="variant === 'pill'" class="refreshing-row">
        <span class="refresh-pulse" aria-hidden="true" />
        <span class="refresh-label">Updating…</span>
      </div>
      <div v-else class="error-row">
        <span class="error-dot" aria-hidden="true" />
        <span class="error-text">Couldn't refresh: {{ firstError }}</span>
        <button type="button" class="retry-btn" @click="retryNow">Retry</button>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import { swrAnyRefreshing, swrErrors, swrForceRefresh } from '~/utils/swrCache'

withDefaults(defineProps<{ variant?: 'pill' | 'banner' }>(), { variant: 'pill' })

const SHOW_DELAY_MS = 300
const anyRefreshing = swrAnyRefreshing()
const errors = swrErrors()

/**
 * Debounced visibility: only show the chip once a refresh has been running
 * for at least SHOW_DELAY_MS. Quick refreshes (<300 ms) stay invisible so
 * the UI never flashes for a sub-second update.
 */
const debouncedRefreshing = ref(false)
let showTimer: ReturnType<typeof setTimeout> | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null

watch(anyRefreshing, (now) => {
  if (now) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    if (debouncedRefreshing.value) return // already showing
    if (showTimer) return // already scheduled
    showTimer = setTimeout(() => {
      debouncedRefreshing.value = true
      showTimer = null
    }, SHOW_DELAY_MS)
  } else {
    if (showTimer) { clearTimeout(showTimer); showTimer = null }
    // Hide a touch faster so the chip doesn't linger.
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      debouncedRefreshing.value = false
      hideTimer = null
    }, 80)
  }
})

onUnmounted(() => {
  if (showTimer) clearTimeout(showTimer)
  if (hideTimer) clearTimeout(hideTimer)
})

const firstError = computed(() => errors.value[0]?.error || null)
const firstErrorKey = computed(() => errors.value[0]?.key || null)

/**
 * Retry button: mark the errored entry invalid so the next read on the page
 * that owns it fetches fresh, and clear the error so the amber banner goes
 * away. Every page using useApiData re-reads on its next watch tick.
 */
function retryNow(): void {
  if (firstErrorKey.value) swrForceRefresh(firstErrorKey.value)
}
</script>

<style scoped>
/* The pill is sized by the reserved slot in the header (100px) — never by
   its own text — so its content can only ever fill that space. */
.data-refresh-indicator--pill {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  max-width: 100%;
  pointer-events: auto;
}

.refreshing-row,
.error-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  border-radius: 999px;
  font-size: var(--font-xs);
  line-height: 1.3;
  white-space: nowrap;
}

.refreshing-row {
  padding: 5px 10px;
  background: rgba(30, 32, 40, 0.78);
  color: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(6px);
}

.refresh-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The failure strip runs the full width of the header, under the bar. */
.data-refresh-indicator--banner {
  width: 100%;
}

.error-row {
  width: 100%;
  padding: 6px 16px;
  border-top: 1px solid rgba(255, 210, 122, 0.35);
  background: rgba(120, 70, 0, 0.94);
  color: #fff;
}

.refresh-pulse {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.85;
  animation: refresh-pulse 1.1s ease-in-out infinite;
}

@keyframes refresh-pulse {
  0%, 100% { opacity: 0.3; transform: scale(0.9); }
  50% { opacity: 1; transform: scale(1.1); }
}

.error-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: #ffd27a;
}

.error-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.retry-btn {
  flex: none;
  background: rgba(255, 255, 255, 0.15);
  color: inherit;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 4px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.retry-btn:hover {
  background: rgba(255, 255, 255, 0.25);
}

/* Fade in/out so quick refreshes don't flash. */
.refresh-fade-enter-active,
.refresh-fade-leave-active,
.refresh-banner-enter-active,
.refresh-banner-leave-active {
  transition: opacity 160ms ease;
}
.refresh-fade-enter-from,
.refresh-fade-leave-to,
.refresh-banner-enter-from,
.refresh-banner-leave-to {
  opacity: 0;
}
</style>
