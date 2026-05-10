<template>
  <div class="ssm-panel">
    <header class="ssm-panel-head">
      <h3>
        Server Mode
        <span v-if="state?.is_currently_active" class="state-pill state-set">running</span>
        <span v-else-if="state?.enabled" class="state-pill state-warn">enabled (next launch)</span>
        <span v-else class="state-pill state-empty">disabled</span>
      </h3>
      <p class="ssm-help">
        Run Story Studio KH on a headless Mac mini and access it from another machine's browser at
        <code>http://this-mac:{{ state?.port || 8765 }}/</code>. Auth via username + password.
        Tailscale handles transport security; don't expose the port to the public internet.
      </p>
      <p v-if="lockedOut" class="ssm-locked">
        You're connected via the web UI right now. Networking changes (enable, port, bind) are
        editable — disabling server mode here will end this session and you'll need to sit at
        the Mac mini directly to re-enable. <strong>Credentials are locked from the web</strong>
        (a typo would lock you out completely); change them by sitting at the mini.
      </p>

      <!-- One-click "switch back to desktop" — most prominent action when active. -->
      <div v-if="state?.is_currently_active" class="ssm-quick-actions">
        <button
          class="btn btn-secondary"
          :disabled="!!saving"
          @click="onDisableAndRestart"
          title="Persist enabled=false and restart the app. After restart the app runs as a normal desktop Electron app and is no longer reachable remotely."
        >
          {{ saving === 'disable' ? 'Disabling…' : 'Disable Server Mode &amp; Switch to Desktop' }}
        </button>
        <span class="ssm-quick-hint">
          You'll lose remote access on restart — that's the point. Walk to the mini (or SSH in)
          to re-enable.
        </span>
      </div>
    </header>

    <div v-if="loading" class="ssm-loading">Loading…</div>
    <div v-else-if="state" class="ssm-fields">
      <!-- Networking — editable from anywhere. Disabling here is a deliberate action. -->
      <fieldset :disabled="!!saving" class="ssm-fieldset">
        <legend>Networking</legend>
        <label class="ssm-field">
          <span class="ssm-field-label">
            <input
              type="checkbox"
              :checked="state.enabled"
              @change="onToggleEnabled(($event.target as HTMLInputElement).checked)"
            >
            Enable on next launch
          </span>
          <span class="ssm-field-hint">
            When enabled, the next launch binds <code>{{ state.bind }}:{{ state.port }}</code> instead
            of localhost. Restart the app to apply.
          </span>
        </label>
        <label class="ssm-field">
          <span class="ssm-field-label">Port</span>
          <input
            v-model.number="form.port"
            type="number"
            min="1"
            max="65535"
            class="input ssm-input ssm-input-narrow"
            @blur="saveNetworkingDebounced"
          >
        </label>
        <label class="ssm-field">
          <span class="ssm-field-label">Bind interface</span>
          <input
            v-model="form.bind"
            class="input ssm-input ssm-input-narrow"
            placeholder="0.0.0.0"
            @blur="saveNetworkingDebounced"
          >
          <span class="ssm-field-hint">
            <code>0.0.0.0</code> = all interfaces. Use <code>127.0.0.1</code> to restrict to local
            (effectively disables remote access while leaving the toggle on).
          </span>
        </label>
      </fieldset>

      <!-- Credentials — locked from the web to prevent typo-lockout. -->
      <fieldset :disabled="lockedOut || saving" class="ssm-fieldset">
        <legend>
          Credentials
          <span v-if="state.has_credentials" class="state-pill state-set">configured</span>
          <span v-else class="state-pill state-empty">not set</span>
        </legend>
        <label class="ssm-field">
          <span class="ssm-field-label">Username</span>
          <input
            v-model="credForm.username"
            class="input ssm-input"
            :placeholder="state.username || 'admin'"
            autocomplete="username"
          >
        </label>
        <label class="ssm-field">
          <span class="ssm-field-label">{{ state.has_credentials ? 'New password' : 'Password' }}</span>
          <input
            v-model="credForm.password"
            type="password"
            class="input ssm-input"
            placeholder="At least 8 characters"
            autocomplete="new-password"
          >
        </label>
        <div class="ssm-buttons">
          <button
            class="btn btn-primary btn-sm"
            :disabled="!canSaveCredentials"
            @click="onSaveCredentials"
          >
            {{ saving === 'credentials' ? 'Saving…' : (state.has_credentials ? 'Change Password' : 'Set Password') }}
          </button>
          <button
            v-if="state.has_credentials"
            class="btn btn-secondary btn-sm"
            :disabled="!!saving"
            title="Invalidate every existing browser session — every signed-in machine will be forced to log in again"
            @click="onRotateSessions"
          >
            {{ saving === 'rotate' ? 'Rotating…' : 'Sign Out Everywhere' }}
          </button>
        </div>
      </fieldset>

      <div v-if="message" :class="['ssm-message', message.kind]">{{ message.text }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { isServerMode } from '~/composables/useServerMode'

interface ServerModeView {
  enabled: boolean
  is_currently_active: boolean
  port: number
  bind: string
  has_credentials: boolean
  username: string | null
  session_ttl_hours: number
}

const { get, put, post } = useApi()

const state = ref<ServerModeView | null>(null)
const loading = ref(false)
const saving = ref<'' | 'networking' | 'credentials' | 'rotate' | 'disable'>('')
const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)

const form = reactive({ port: 8765, bind: '0.0.0.0' })
const credForm = reactive({ username: '', password: '' })

// `lockedOut` now applies ONLY to credentials — networking changes (enable
// off, port, bind) are deliberate actions even from the web. Disabling server
// mode loses remote access, but that's the user's intent. Credentials remain
// locked because a mistyped password while logged in via web = total lockout.
const lockedOut = computed(() => isServerMode())

const canSaveCredentials = computed(() => {
  if (lockedOut.value || saving.value) return false
  if (!credForm.password || credForm.password.length < 8) return false
  if (!credForm.username && !state.value?.username) return false
  return true
})

async function load() {
  loading.value = true
  try {
    const r = await get<ServerModeView>('/app-settings/server-mode')
    state.value = r
    form.port = r.port
    form.bind = r.bind
    if (!credForm.username) credForm.username = r.username || ''
  } catch (e: any) {
    message.value = { kind: 'err', text: e?.data?.detail || 'Failed to load server-mode settings' }
  } finally {
    loading.value = false
  }
}

let networkSaveTimer: ReturnType<typeof setTimeout> | null = null
function saveNetworkingDebounced() {
  if (networkSaveTimer) clearTimeout(networkSaveTimer)
  networkSaveTimer = setTimeout(saveNetworking, 400)
}

async function saveNetworking() {
  if (lockedOut.value) return
  if (!state.value) return
  if (form.port === state.value.port && form.bind === state.value.bind) return
  saving.value = 'networking'
  message.value = null
  try {
    state.value = await put<ServerModeView>('/app-settings/server-mode', {
      port: Math.floor(form.port),
      bind: form.bind.trim(),
    })
    message.value = { kind: 'ok', text: 'Networking saved. Restart the app to apply.' }
  } catch (e: any) {
    message.value = { kind: 'err', text: e?.data?.detail || 'Save failed' }
  } finally {
    saving.value = ''
  }
}

async function onToggleEnabled(checked: boolean) {
  saving.value = 'networking'
  message.value = null
  try {
    state.value = await put<ServerModeView>('/app-settings/server-mode', { enabled: checked })
    message.value = checked
      ? { kind: 'ok', text: 'Server mode will start on next launch. Set credentials below if you haven\'t already.' }
      : { kind: 'ok', text: 'Server mode disabled. Restart the app to apply — you\'ll lose remote access.' }
  } catch (e: any) {
    message.value = { kind: 'err', text: e?.data?.detail || 'Save failed' }
  } finally {
    saving.value = ''
  }
}

/**
 * One-click "switch back to desktop": persist enabled=false, then trigger
 * /system/restart-app. After restart the app boots in desktop mode (per the
 * "JSON enabled=false wins over env var" precedence in lib/server-mode.ts),
 * binding loopback only — this browser session ends and the app is no longer
 * reachable remotely. To re-enable, sit at the mini.
 */
async function onDisableAndRestart() {
  if (saving.value) return
  if (!confirm(
    'Disable server mode and restart the app?\n\n'
    + 'After restart, the app runs as a normal desktop window on the Mac mini and is '
    + 'no longer reachable from this browser. To re-enable, sit at the mini directly.',
  )) return

  saving.value = 'disable'
  message.value = null
  try {
    state.value = await put<ServerModeView>('/app-settings/server-mode', { enabled: false })
    message.value = { kind: 'ok', text: 'Server mode disabled. Restarting the app…' }
    // Trigger restart. The current cookie becomes useless once the app rebinds
    // to localhost — the page will fail to reload, which is the correct
    // outcome (server mode is OFF; user goes to the mini).
    try {
      await post('/system/restart-app', {})
    } catch { /* restart endpoint may not respond cleanly while killing itself; that's fine */ }
    // Show a friendly fallback after a moment in case restart hasn't happened.
    setTimeout(() => {
      message.value = {
        kind: 'ok',
        text: 'If the app didn\'t restart automatically, quit it manually on the Mac mini.',
      }
    }, 3000)
  } catch (e: any) {
    message.value = { kind: 'err', text: e?.data?.detail || 'Failed to disable server mode' }
    saving.value = ''
  }
}

async function onSaveCredentials() {
  if (!canSaveCredentials.value) return
  const username = credForm.username.trim() || state.value?.username || ''
  if (!username) {
    message.value = { kind: 'err', text: 'Username is required' }
    return
  }
  saving.value = 'credentials'
  message.value = null
  try {
    state.value = await put<ServerModeView>('/app-settings/server-mode/credentials', {
      username,
      password: credForm.password,
    })
    credForm.password = ''
    message.value = { kind: 'ok', text: 'Credentials saved. Existing sessions are invalidated.' }
  } catch (e: any) {
    message.value = { kind: 'err', text: e?.data?.detail || 'Save failed' }
  } finally {
    saving.value = ''
  }
}

async function onRotateSessions() {
  if (saving.value) return
  if (!confirm('Invalidate every signed-in browser session? You\'ll need to log in again everywhere.')) return
  saving.value = 'rotate'
  message.value = null
  try {
    state.value = await post<ServerModeView>('/app-settings/server-mode/rotate-sessions', {})
    message.value = { kind: 'ok', text: 'Sessions rotated. All other browsers are now signed out.' }
  } catch (e: any) {
    message.value = { kind: 'err', text: e?.data?.detail || 'Rotation failed' }
  } finally {
    saving.value = ''
  }
}

onMounted(load)

defineExpose({ reload: load })
</script>

<style scoped>
.ssm-panel { padding-top: 4px; }
.ssm-panel-head h3 {
  margin: 0;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.ssm-help {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.55;
}
.ssm-locked {
  margin: 8px 0 0;
  padding: 8px 12px;
  background: var(--accent-dim);
  border-left: 3px solid var(--accent);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
  border-radius: 4px;
}
.ssm-loading { padding: 16px 0; color: var(--text-muted); font-size: 13px; }
.ssm-fieldset {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 14px 14px;
  margin: 12px 0 0;
}
.ssm-fieldset legend {
  padding: 0 8px;
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.ssm-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}
.ssm-field:first-of-type { margin-top: 4px; }
.ssm-field-label {
  font-size: 12px;
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ssm-field-hint {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
}
.ssm-input { font-size: 13px; }
.ssm-input-narrow { max-width: 180px; }
.ssm-buttons {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.ssm-message {
  margin-top: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
}
.ssm-message.ok { background: rgba(34, 197, 94, 0.12); color: #16a34a; }
.ssm-message.err { background: rgba(239, 68, 68, 0.12); color: #dc2626; }
.state-pill {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 500;
}
.state-set { background: rgba(34, 197, 94, 0.12); color: #16a34a; }
.state-warn { background: rgba(234, 179, 8, 0.12); color: #ca8a04; }
.state-empty { background: var(--bg-tertiary); color: var(--text-muted); }
.ssm-quick-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  padding: 10px 12px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 6px;
  flex-wrap: wrap;
}
.ssm-quick-hint {
  font-size: 11px;
  color: var(--text-muted);
  flex: 1;
  min-width: 200px;
  line-height: 1.4;
}
</style>
