<template>
 <!--
   Shared data-refresh indicator. Lives in app.vue so every page gets it
   without importing anything. Three states, all small and calm:

     1. Refreshing (debounced 300 ms): "Updating…" with a small pulse.
     2. Shown-old data: nothing here — the per-block styling in useApiData
        consumers handles "Shown from 2 min ago · updating" inline.
     3. Failed refresh: amber "Couldn't refresh: <why> · Retry" banner.

   Layout: a fixed strip just under the app header. Fades in after the
   debounce so quick refreshes never flash. Never shifts content — the
   strip is overlay with pointer-events-none when idle.
 -->
 <Transition name="refresh-fade">
   <div
     v-if="visible"
     class="data-refresh-indicator"
     role="status"
     aria-live="polite"
   >
     <div v-if="anyRefreshing && !firstError" class="refreshing-row">
       <span class="refresh-pulse" aria-hidden="true" />
       <span>Updating…</span>
     </div>
     <div v-if="firstError" class="error-row">
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

const SHOW_DELAY_MS = 300
const anyRefreshing = swrAnyRefreshing()
const errors = swrErrors()

/**
 * Debounced visibility: only show the strip once a refresh has been running
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
    // Hide a touch faster so the strip doesn't linger.
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

const visible = computed(() => debouncedRefreshing.value || !!firstError.value)

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
.data-refresh-indicator {
 position: fixed;
 top: 0;
 left: 0;
 right: 0;
 z-index: 950; /* under dialogs (1000+), over normal content */
 display: flex;
 justify-content: center;
 pointer-events: none;
}

.refreshing-row,
.error-row {
 display: inline-flex;
 align-items: center;
 gap: 8px;
 margin-top: 8px;
 padding: 6px 14px;
 border-radius: 999px;
 font-size: 12px;
 line-height: 1.3;
 pointer-events: auto;
 backdrop-filter: blur(6px);
}

.refreshing-row {
 background: rgba(30, 32, 40, 0.75);
 color: rgba(255, 255, 255, 0.85);
}

.error-row {
 background: rgba(120, 70, 0, 0.92);
 color: #fff;
}

.refresh-pulse {
 width: 8px;
 height: 8px;
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
 border-radius: 50%;
 background: #ffd27a;
}

.error-text {
 max-width: 60ch;
 overflow: hidden;
 text-overflow: ellipsis;
 white-space: nowrap;
}

.retry-btn {
 background: rgba(255, 255, 255, 0.15);
 color: inherit;
 border: 1px solid rgba(255, 255, 255, 0.25);
 border-radius: 4px;
 padding: 2px 10px;
 font-size: 12px;
 cursor: pointer;
}

.retry-btn:hover {
 background: rgba(255, 255, 255, 0.25);
}

/* Fade in/out so quick refreshes don't flash. */
.refresh-fade-enter-active,
.refresh-fade-leave-active {
 transition: opacity 160ms ease;
}
.refresh-fade-enter-from,
.refresh-fade-leave-to {
 opacity: 0;
}
</style>