<template>
  <div v-if="showBanner" class="ssm-session">
    <span class="ssm-session-text" :title="sessionLine">
      <strong>{{ host }}</strong>
      <span v-if="state.username"> — {{ state.username }}</span>
    </span>
    <button
      v-if="state.isAuthenticated"
      class="ssm-signout"
      :disabled="signingOut"
      @click="onSignOut"
      title="Sign out and close this session"
    >
      {{ signingOut ? 'Signing Out…' : 'Sign Out' }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useServerMode, markSignedOut, isServerMode } from '~/composables/useServerMode'

const state = useServerMode()
const signingOut = ref(false)

const showBanner = computed(() => {
  if (!isServerMode()) return false
  if (!state.authChecked) return false
  if (!state.isAuthenticated) return false
  // Hide on the login page itself (no point showing the session line there).
  // v1.0.112 — normalize trailing slash so `/login/` (from express.static's
  // directory-redirect, until disabled in v1.0.112) also matches.
  if (typeof window !== 'undefined') {
    const p = window.location.pathname.replace(/\/+$/, '') || '/'
    if (p === '/login') return false
  }
  return true
})

const host = computed(() => {
  if (typeof window === 'undefined') return ''
  return window.location.host
})

const sessionLine = computed(() => (
  `${host.value}${state.username ? ` — ${state.username}` : ''}`
))

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
/* Lives in the sidebar footer, in normal flow. That footer's connection row
   already carries the status truth, so this is only the host and signed-in user. */
.ssm-session {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr);
  gap: 2px;
  padding: 0 8px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.ssm-session-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.35;
}
.ssm-session-text strong { color: var(--text-primary); font-weight: 600; }
.ssm-signout {
  justify-self: start;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.ssm-signout:hover:not(:disabled) { color: var(--text-primary); }
.ssm-signout:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
.ssm-signout:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
