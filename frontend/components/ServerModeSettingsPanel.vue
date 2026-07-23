<template>
  <div class="ssm-panel">
    <header class="ssm-panel-head">
      <span class="ssm-kicker">Remote access</span>
      <h3>
        Server Mode
        <span v-if="state?.is_currently_active" class="state-pill state-set">running</span>
        <span v-else-if="state?.enabled" class="state-pill state-warn">enabled (next launch)</span>
        <span v-else class="state-pill state-empty">disabled</span>
      </h3>
      <p class="ssm-help">
        Open Story Studio from another machine at <code>http://this-mac:{{ state?.port || 8765 }}/</code>.
        Use Tailscale for transport security and never expose this port directly to the public internet.
      </p>
      <!-- v1.0.109 — replaced the "credentials are locked from the web" wall
           with an informational banner. The previous lockout was over-defensive
           (and twice now caused users to be unable to set initial credentials
           at all because its DOM-heuristic bypass misfired). Typo-lockout is
           now handled by the "Confirm new password" field instead. -->
      <p v-if="state?.is_currently_active" class="ssm-locked">
        You are connected through Server Mode. <strong>Changing the password signs this browser
        out.</strong> Log back in with the new password. If needed, run
        <code>npm run reset-server-auth</code> on the Mac mini to reset access.
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
      <div class="ssm-config-grid">
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
        <div class="ssm-inline-fields">
          <label class="ssm-field">
            <span class="ssm-field-label">Port</span>
            <input
              v-model.number="form.port"
              type="number"
              min="1"
              max="65535"
              class="input ssm-input"
              @blur="saveNetworkingDebounced"
            >
          </label>
          <label class="ssm-field">
            <span class="ssm-field-label">Bind interface</span>
            <input
              v-model="form.bind"
              class="input ssm-input"
              placeholder="0.0.0.0"
              @blur="saveNetworkingDebounced"
            >
          </label>
        </div>
        <span class="ssm-field-hint ssm-network-hint">
          <code>0.0.0.0</code> allows your private network; <code>127.0.0.1</code> keeps access local.
        </span>
      </fieldset>

      <!-- v1.0.109 — credentials are editable from anywhere. Typo-lockout is
           handled by the Confirm field below + the rate limiter + the reset
           script. The old origin-based lockout caused more pain than it
           prevented (see history note above the banner). -->
      <fieldset :disabled="!!saving" class="ssm-fieldset">
        <legend>
          Credentials
          <span v-if="state.has_credentials" class="state-pill state-set">configured</span>
          <span v-else class="state-pill state-empty">not set</span>
        </legend>
        <div class="ssm-credential-grid">
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
            <span
              v-if="credForm.password && credForm.password.length > 0 && credForm.password.length < 8"
              class="ssm-field-hint ssm-field-hint-warn"
            >
              {{ 8 - credForm.password.length }} more character{{ 8 - credForm.password.length === 1 ? '' : 's' }} to go.
            </span>
          </label>
        <!-- v1.0.109 — Confirm new password. Industry-standard typo guard;
             replaces the old origin-based credential lockout. Save is gated
             on this matching the password field above. -->
          <label class="ssm-field">
            <span class="ssm-field-label">Confirm password</span>
            <input
              v-model="credForm.passwordConfirm"
              type="password"
              class="input ssm-input"
              placeholder="Re-enter password"
              autocomplete="new-password"
            >
            <span
              v-if="credForm.passwordConfirm && credForm.password !== credForm.passwordConfirm"
              class="ssm-field-hint ssm-field-hint-warn"
            >
              Doesn't match the password above.
            </span>
          </label>
        </div>
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

        <!-- v1.0.107+ — login rate-limit knob. Standalone field so the -->
        <!-- user can bump it after running into a 429 without re-entering -->
        <!-- credentials (saves to /server-mode/rate-limit, NOT through    -->
        <!-- the credentials PUT). Only meaningful when credentials are    -->
        <!-- already configured. -->
        <label v-if="state.has_credentials" class="ssm-field ssm-field-rate-limit">
          <span class="ssm-field-label">Login attempts per minute (per IP)</span>
          <input
            v-model.number="rateLimitInput"
            type="number"
            min="1"
            max="1000"
            class="input ssm-input ssm-input-narrow"
            @blur="saveRateLimit"
            @keydown.enter="saveRateLimit"
          >
          <span class="ssm-field-hint">
            Default <strong>30</strong>. Hit the limit? Wait 60 s, then bump this number
            (and consider whether something is auto-filling stale credentials).
            Hard upper bound: 1000.
          </span>
        </label>
      </fieldset>

      <!-- v1.0.99+ Server Status diagnostic.
           Surfaces operational data from /api/server-info — bind, port,
           uptime, credentials state, session TTL, Node/platform versions.
           Renders only when server mode is currently active (the diagnostic
           field is null when in desktop mode). Useful for confirming
           "yes the mini is actually running" + "yes credentials are set"
           from the laptop without SSHing in. -->
      <fieldset v-if="diag" class="ssm-fieldset">
        <legend>
          Server Status
          <span class="state-pill state-set" title="Server is running and answering API requests">live</span>
        </legend>
        <div class="ssm-diag-grid">
          <div class="ssm-diag-row">
            <span class="ssm-diag-label">Listening on</span>
            <code class="ssm-diag-value">{{ diag.bind }}:{{ diag.port }}</code>
          </div>
          <div class="ssm-diag-row">
            <span class="ssm-diag-label">Uptime</span>
            <span class="ssm-diag-value">{{ formatUptime(diag.uptime_seconds) }}</span>
          </div>
          <div class="ssm-diag-row">
            <span class="ssm-diag-label">Credentials</span>
            <span class="ssm-diag-value">
              <span v-if="diag.has_credentials" class="state-pill state-set">configured</span>
              <span v-else class="state-pill state-empty">not set</span>
            </span>
          </div>
          <div class="ssm-diag-row" v-if="diag.session_ttl_hours">
            <span class="ssm-diag-label">Session TTL</span>
            <span class="ssm-diag-value">{{ diag.session_ttl_hours }} h ({{ Math.round(diag.session_ttl_hours / 24) }} days)</span>
          </div>
          <div class="ssm-diag-row">
            <span class="ssm-diag-label">Platform</span>
            <code class="ssm-diag-value">{{ diag.platform }} · node {{ diag.node_version }}</code>
          </div>
        </div>
        <div class="ssm-diag-refresh">
          <button class="btn btn-ghost btn-sm" :disabled="diagLoading" @click="loadDiag">
            {{ diagLoading ? 'Refreshing…' : '↻ Refresh' }}
          </button>
          <span class="ssm-field-hint">
            Polls <code>/api/server-info</code>. Updates uptime; reflects credential changes
            immediately. No auth required (it only returns boolean for credentials, never the hash).
          </span>
        </div>
      </fieldset>
      </div>

      <div v-if="message" :class="['ssm-message', message.kind]">{{ message.text }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'

interface ServerModeView {
  enabled: boolean
  is_currently_active: boolean
  port: number
  bind: string
  has_credentials: boolean
  username: string | null
  session_ttl_hours: number
  login_max_attempts_per_minute: number
}

const { get, put, post } = useApi()
const { ask } = useConfirm()

const state = ref<ServerModeView | null>(null)
const loading = ref(false)
const saving = ref<'' | 'networking' | 'credentials' | 'rotate' | 'disable' | 'rate-limit'>('')
const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)

const form = reactive({ port: 8765, bind: '0.0.0.0' })
// v1.0.107+ — pulled into a separate ref so an in-flight edit doesn't
// reset on every `load()` until the user commits via blur/Enter.
const rateLimitInput = ref(30)
// v1.0.109 — passwordConfirm added so the user can self-check for typos.
// Replaces the prior origin-based lockout that prevented web-side password
// changes entirely.
const credForm = reactive({ username: '', password: '', passwordConfirm: '' })

// v1.0.99+ — live diagnostic from /api/server-info. Populated when the
// server is in server mode (the endpoint returns null otherwise). Polled
// on mount + manual ↻ Refresh. Lightweight (single HTTP call returning
// ~150 bytes of JSON) so we don't bother with an auto-refresh timer.
interface ServerDiagnostic {
  bind: string
  port: number
  has_credentials: boolean
  session_ttl_hours: number | null
  uptime_seconds: number
  node_version: string
  platform: string
}
const diag = ref<ServerDiagnostic | null>(null)
const diagLoading = ref(false)

async function loadDiag(): Promise<void> {
  diagLoading.value = true
  try {
    const r = await get<{ diagnostic: ServerDiagnostic | null }>('/server-info')
    diag.value = r?.diagnostic || null
  } catch {
    diag.value = null
  } finally {
    diagLoading.value = false
  }
}

/** Human-friendly uptime: '3h 14m', '5d 2h', '47s'. */
function formatUptime(s: number): string {
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  if (s < 86400) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return `${h}h ${m}m`
  }
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  return `${d}d ${h}h`
}

// v1.0.109 — `lockedOut` and the origin-based DOM heuristic that gated it
// have been removed entirely. Credentials are editable from anywhere; typo
// protection lives in the Confirm Password field below, in the per-IP rate
// limiter on /api/auth/login, and in the `npm run reset-server-auth` escape
// hatch for the truly-stuck case. See the banner copy above for the
// "you'll be signed out after save" warning when changing remotely.
const canSaveCredentials = computed(() => {
  if (saving.value) return false
  if (!credForm.password || credForm.password.length < 8) return false
  if (credForm.password !== credForm.passwordConfirm) return false
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
    rateLimitInput.value = r.login_max_attempts_per_minute || 30
    if (!credForm.username) credForm.username = r.username || ''
  } catch (e: any) {
    message.value = { kind: 'err', text: e?.data?.detail || 'Failed to load server-mode settings' }
  } finally {
    loading.value = false
  }
}

async function saveRateLimit() {
  const n = Number(rateLimitInput.value)
  if (!Number.isFinite(n) || n < 1 || n > 1000) {
    message.value = { kind: 'err', text: 'Rate limit must be between 1 and 1000.' }
    if (state.value?.login_max_attempts_per_minute) {
      rateLimitInput.value = state.value.login_max_attempts_per_minute
    }
    return
  }
  if (state.value && n === state.value.login_max_attempts_per_minute) return // no-op
  saving.value = 'rate-limit'
  try {
    const r = await put<ServerModeView>('/app-settings/server-mode/rate-limit', {
      login_max_attempts_per_minute: n,
    })
    state.value = r
    rateLimitInput.value = r.login_max_attempts_per_minute
    message.value = { kind: 'ok', text: `Rate limit set to ${r.login_max_attempts_per_minute}/min.` }
  } catch (e: any) {
    message.value = { kind: 'err', text: e?.data?.detail || 'Failed to save rate limit' }
  } finally {
    saving.value = ''
  }
}

let networkSaveTimer: ReturnType<typeof setTimeout> | null = null
function saveNetworkingDebounced() {
  if (networkSaveTimer) clearTimeout(networkSaveTimer)
  networkSaveTimer = setTimeout(saveNetworking, 400)
}

async function saveNetworking() {
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
  if (!await ask({
    title: 'Disable server mode?',
    message: 'The app will restart as a desktop-only window and will no longer be reachable from this browser. Re-enabling requires access to the Mac mini.',
    confirmLabel: 'Disable and restart',
    danger: true,
  })) return

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
    credForm.passwordConfirm = ''
    // v1.0.109 — clearer next-step copy. The user is almost always still
    // missing one of: (a) toggle Enable on next launch, or (b) restart the
    // app to flip into server mode. The original message ("Existing sessions
    // are invalidated") was technically accurate but left them stranded.
    message.value = {
      kind: 'ok',
      text: state.value?.is_currently_active
        ? 'Credentials saved. Your current session was invalidated — log back in with the new password.'
        : (state.value?.enabled
          ? 'Credentials saved. Restart the app to enter server mode and start logging in remotely.'
          : 'Credentials saved. Toggle "Enable on next launch" above, then restart the app to start logging in remotely.'),
    }
  } catch (e: any) {
    message.value = { kind: 'err', text: e?.data?.detail || 'Save failed' }
  } finally {
    saving.value = ''
  }
}

async function onRotateSessions() {
  if (saving.value) return
  if (!await ask({ title: 'Sign out every browser?', message: 'Invalidate every signed-in browser session? You will need to log in again everywhere.', confirmLabel: 'Invalidate sessions', danger: true })) return
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
onMounted(loadDiag)

defineExpose({ reload: load })
</script>

<style scoped>
.ssm-panel { min-width: 0; }
.ssm-kicker {
  display: block;
  margin-bottom: 2px;
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.ssm-panel-head h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 15px;
}
.ssm-help { margin: 4px 0 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.45; }
.ssm-locked {
  margin: 9px 0 0;
  padding: 7px 10px;
  border-left: 3px solid var(--accent);
  border-radius: 4px;
  background: var(--accent-dim);
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: 1.45;
}
.ssm-loading { padding: 16px 0; color: var(--text-muted); font-size: 13px; }
.ssm-config-grid {
  display: grid;
  grid-template-columns: minmax(260px, 0.82fr) minmax(420px, 1.18fr);
  gap: 9px;
  margin-top: 12px;
}
.ssm-fieldset {
  min-width: 0;
  margin: 0;
  padding: 9px 11px 11px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-primary);
}
.ssm-fieldset:nth-child(3) { grid-column: 1 / -1; }
.ssm-fieldset legend {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 7px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  font-weight: 700;
}
.ssm-field { display: flex; flex-direction: column; gap: 4px; margin-top: 7px; }
.ssm-field:first-of-type { margin-top: 4px; }
.ssm-field-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.ssm-field-hint { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.35; }
.ssm-field-hint-warn { color: #ca8a04; }
.ssm-input { font-size: var(--font-xs); }
.ssm-input-narrow { max-width: 180px; }
.ssm-inline-fields,
.ssm-credential-grid { display: grid; gap: 7px; }
.ssm-inline-fields { grid-template-columns: minmax(90px, 0.7fr) minmax(130px, 1.3fr); }
.ssm-credential-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.ssm-inline-fields .ssm-field,
.ssm-credential-grid .ssm-field { min-width: 0; }
.ssm-inline-fields .ssm-input,
.ssm-credential-grid .ssm-input { width: 100%; min-width: 0; }
.ssm-network-hint { display: block; margin-top: 7px; }
.ssm-buttons { display: flex; gap: 7px; margin-top: 8px; }
.ssm-message { margin-top: 9px; padding: 7px 9px; border-radius: 6px; font-size: var(--font-xs); }
.ssm-message.ok { background: rgba(34, 197, 94, 0.12); color: #16a34a; }
.ssm-message.err { background: rgba(239, 68, 68, 0.12); color: #dc2626; }
.state-pill { padding: 2px 7px; border-radius: 999px; font-size: var(--font-xs); font-weight: 700; }
.state-set { background: rgba(34, 197, 94, 0.12); color: #16a34a; }
.state-warn { background: rgba(234, 179, 8, 0.12); color: #ca8a04; }
.state-empty { background: var(--bg-tertiary); color: var(--text-muted); }
.ssm-quick-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 9px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-primary);
  flex-wrap: wrap;
}
.ssm-quick-hint { flex: 1; min-width: 200px; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.35; }
.ssm-diag-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 7px;
  margin-top: 3px;
}
.ssm-diag-row {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
  padding: 7px 8px;
  border-radius: 6px;
  background: var(--bg-secondary);
}
.ssm-diag-label {
  color: var(--text-muted);
  font-size: var(--font-xs);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.ssm-diag-value {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: var(--font-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ssm-diag-value code { padding: 2px 5px; border-radius: 3px; background: var(--bg-tertiary); font-size: var(--font-xs); }
.ssm-diag-refresh { display: flex; align-items: baseline; gap: 9px; margin-top: 8px; flex-wrap: wrap; }

@media (max-width: 1000px) {
  .ssm-config-grid { grid-template-columns: 1fr; }
  .ssm-fieldset:nth-child(3) { grid-column: auto; }
  .ssm-diag-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

@media (max-width: 680px) {
  .ssm-credential-grid { grid-template-columns: 1fr; }
  .ssm-diag-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ssm-quick-actions { align-items: flex-start; flex-direction: column; }
}
</style>
