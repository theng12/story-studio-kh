<template>
  <div class="login-shell">
    <div class="login-card">
      <div class="login-logo">
        <span class="logo-mark">🌙</span>
        <h1>Story Studio KH</h1>
      </div>

      <p v-if="serverHost" class="login-host">
        Connecting to <strong>{{ serverHost }}</strong>
      </p>

      <form @submit.prevent="onSubmit" class="login-form">
        <label>
          <span class="label-text">Username</span>
          <input
            v-model="username"
            type="text"
            class="input"
            autocomplete="username"
            autofocus
            :disabled="submitting"
            required
          >
        </label>
        <label>
          <span class="label-text">Password</span>
          <input
            v-model="password"
            type="password"
            class="input"
            autocomplete="current-password"
            :disabled="submitting"
            required
          >
        </label>

        <div v-if="error" class="login-error" role="alert">
          {{ error }}
        </div>

        <button
          type="submit"
          class="btn btn-primary login-submit"
          :disabled="submitting || !username || !password"
        >
          {{ submitting ? 'Signing in…' : 'Sign In' }}
        </button>
      </form>

      <p class="login-footnote">
        Forgot your password? Sit at the Mac mini and reconfigure under Settings → Server Mode.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { markAuthenticated, isServerMode } from '~/composables/useServerMode'

definePageMeta({
  // Plain layout — no sidebar, no project context.
  layout: 'default',
})

const username = ref('')
const password = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)

const serverHost = computed(() => {
  if (typeof window === 'undefined') return ''
  return window.location.host
})

async function onSubmit() {
  if (submitting.value) return
  error.value = null
  submitting.value = true
  try {
    const r = await $fetch<{ username: string }>('/api/auth/login', {
      method: 'POST',
      body: { username: username.value.trim(), password: password.value },
    })
    markAuthenticated(r.username)
    // Full reload to '/' so every cached useFetch / pinia store / composable
    // re-runs with the cookie set. Cleaner than trying to invalidate piecemeal.
    window.location.assign('/')
  } catch (e: any) {
    // $fetch throws an FetchError with `data: { detail }` on non-2xx.
    error.value = e?.data?.detail || e?.message || 'Sign-in failed'
    submitting.value = false
  }
}

// If a user lands on /login while in default (Electron) mode, just shove them
// back to the dashboard — there's no auth state to manage.
onMounted(() => {
  if (!isServerMode()) {
    window.location.assign('/')
  }
})
</script>

<style scoped>
.login-shell {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: calc(100vh - 38px); /* minus titlebar */
  padding: 32px;
  background: var(--bg-primary);
}
.login-card {
  width: 100%;
  max-width: 380px;
  padding: 32px 28px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
}
.login-logo {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
.logo-mark {
  font-size: 28px;
}
.login-logo h1 {
  margin: 0;
  font-size: 18px;
  color: var(--text-primary);
}
.login-host {
  margin: 0 0 24px;
  color: var(--text-secondary);
  font-size: 13px;
}
.login-host strong {
  color: var(--text-primary);
  font-weight: 600;
}
.login-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.login-form label {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.label-text {
  font-size: 13px;
  color: var(--text-secondary);
}
.login-error {
  padding: 10px 12px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: 6px;
  color: #f87171;
  font-size: 13px;
}
.login-submit {
  margin-top: 4px;
  height: 40px;
  font-weight: 600;
}
.login-footnote {
  margin: 24px 0 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
}
</style>
