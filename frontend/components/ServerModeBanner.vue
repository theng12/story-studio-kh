<template>
  <div v-if="showBanner" class="ssm-banner" role="status">
    <div class="ssm-banner-inner">
      <span class="ssm-dot" :class="latencyClass" :title="latencyTitle"></span>
      <span class="ssm-text">
        Connected to <strong>{{ host }}</strong>
        <span v-if="state.username" class="ssm-user">— {{ state.username }}</span>
      </span>
      <button
        v-if="state.isAuthenticated"
        class="ssm-signout"
        :disabled="signingOut"
        @click="onSignOut"
        title="Sign out and close this session"
      >
        {{ signingOut ? 'Signing out…' : 'Sign Out' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useServerMode, markSignedOut, isServerMode } from '~/composables/useServerMode'

const state = useServerMode()
const signingOut = ref(false)
const latencyMs = ref<number | null>(null)
let latencyTimer: ReturnType<typeof setInterval> | null = null

const showBanner = computed(() =>
  isServerMode()
  && state.authChecked
  && state.isAuthenticated
  // Hide on the login page itself (no point showing "Connected to mac-mini" there)
  && (typeof window === 'undefined' || window.location.pathname !== '/login')
)

const host = computed(() => {
  if (typeof window === 'undefined') return ''
  return window.location.host
})

const latencyClass = computed(() => {
  if (latencyMs.value === null) return 'idle'
  if (latencyMs.value < 50) return 'green'
  if (latencyMs.value < 200) return 'amber'
  return 'red'
})

const latencyTitle = computed(() => {
  if (latencyMs.value === null) return 'Measuring round-trip…'
  return `Round-trip ${Math.round(latencyMs.value)}ms`
})

async function pingLatency() {
  if (typeof window === 'undefined') return
  const t0 = performance.now()
  try {
    await $fetch('/api/health')
    latencyMs.value = performance.now() - t0
  } catch {
    latencyMs.value = null
  }
}

onMounted(() => {
  if (!isServerMode()) return
  pingLatency()
  latencyTimer = setInterval(pingLatency, 30_000)
})

onUnmounted(() => {
  if (latencyTimer) clearInterval(latencyTimer)
})

async function onSignOut() {
  if (signingOut.value) return
  signingOut.value = true
  try {
    await $fetch('/api/auth/logout', { method: 'POST' })
  } catch { /* logout is best-effort; cookie is local anyway */ }
  markSignedOut()
  // Full reload to clear every cached fetch / store state, lands on /login.
  window.location.assign('/login')
}
</script>

<style scoped>
.ssm-banner {
  position: fixed;
  bottom: 12px;
  right: 12px;
  z-index: 900;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 999px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  font-size: 12px;
}
.ssm-banner-inner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px 6px 10px;
}
.ssm-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.ssm-dot.idle  { background: var(--text-muted); }
.ssm-dot.green { background: #22c55e; }
.ssm-dot.amber { background: #f59e0b; }
.ssm-dot.red   { background: #ef4444; }
.ssm-text {
  color: var(--text-secondary);
  white-space: nowrap;
}
.ssm-text strong {
  color: var(--text-primary);
  font-weight: 600;
}
.ssm-user {
  color: var(--text-muted);
  margin-left: 2px;
}
.ssm-signout {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-secondary);
  padding: 3px 9px;
  border-radius: 999px;
  cursor: pointer;
  font-size: 11px;
}
.ssm-signout:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.ssm-signout:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
