<template>
  <section class="card settings-panel app-update-panel" data-setting="app-update">
    <header class="settings-card-head">
      <h3>Updates</h3>
      <p>Story Studio checks the Gateway for a new version every 30 minutes (and at startup), installs it when the queue is drained, and restarts itself.</p>
    </header>

    <div v-if="!status" class="text-muted">Loading…</div>
    <template v-else>
      <p class="settings-hint" role="status">
        <strong>{{ headline }}</strong>
        <template v-if="status.last_check_at"> · checked {{ ago(status.last_check_at) }}</template>
      </p>
      <p v-if="status.error && ['failed', 'rolled_back'].includes(status.phase)" class="error-box">{{ status.error }}</p>
      <p v-else-if="status.last_check_error" class="text-muted">{{ status.last_check_error }}</p>

      <div class="flex gap-2 app-update-actions">
        <button class="btn btn-secondary btn-sm" :disabled="!!busy" @click="act('check')">{{ busy === 'check' ? 'Checking…' : 'Check Now' }}</button>
        <button
          v-if="canInstall"
          class="btn btn-primary btn-sm"
          :disabled="!!busy"
          title="Pause the queue, let running jobs finish (up to 30 minutes), install, restart and resume"
          @click="act('install')"
        >{{ busy === 'install' ? 'Starting…' : 'Install Now' }}</button>
      </div>

      <label class="app-update-field">
        <input type="checkbox" :checked="status.settings.auto_install" :disabled="!!busy" @change="save({ auto_install: ($event.target as HTMLInputElement).checked })">
        Install updates automatically
      </label>
      <label class="app-update-field">
        When to install
        <select class="input" :value="status.settings.install_window" :disabled="!!busy" @change="save({ install_window: ($event.target as HTMLSelectElement).value })">
          <option value="drain">Anytime: pause the queue and wait for running jobs</option>
          <option value="idle">Only when no jobs are running</option>
        </select>
      </label>
      <label class="app-update-field">
        <input type="checkbox" :checked="status.open_at_login" :disabled="!!busy" @change="setLogin(($event.target as HTMLInputElement).checked)">
        Open at Login, and restart after a crash
      </label>
      <p class="settings-hint">
        A Quit, a Force Quit or a macOS low-memory stop never restarts it. Server Mode stays as you set it, so an update or a restart comes back as a server.
      </p>
      <p v-if="status.trusted_fingerprint" class="settings-hint">
        App Update Key <code>{{ status.trusted_fingerprint.slice(0, 16) }}…</code> (this Mac: {{ status.machine }})
        <span class="app-update-key-hint">should match the fingerprint in Gateway → Settings → App Update Key</span>
        <button class="btn btn-ghost btn-sm" :disabled="!!busy" @click="act('trust')">Trust the New App Update Key</button>
      </p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

interface UpdateStatus {
  enabled: boolean
  current_version: string | null
  machine: string
  phase: string
  release?: { version: string } | null
  error?: string | null
  held?: boolean
  last_check_at?: number | null
  last_check_error?: string | null
  settings: { auto_install: boolean; install_window: 'drain' | 'idle' }
  trusted_fingerprint: string | null
  open_at_login: boolean
}

const { get, put, post } = useApi()
const { success, error: showError } = useToast()
const status = ref<UpdateStatus | null>(null)
const busy = ref('')

const version = computed(() => status.value?.release?.version || '')
const canInstall = computed(() => ['ready', 'failed', 'rolled_back'].includes(status.value?.phase || '') && !!version.value)
const headline = computed(() => {
  const s = status.value
  if (!s) return ''
  if (!s.enabled) return 'Updates are checked only in the installed app.'
  switch (s.phase) {
    case 'downloading': return `Downloading ${version.value}…`
    case 'ready': return s.held ? `${version.value} is ready; it waits for Install Now because you resumed the queue.` : `${version.value} is ready.`
    case 'draining': return `Installing ${version.value} once running jobs stop. The queue is paused for the update.`
    case 'installing': return `Installing ${version.value}; Story Studio restarts.`
    case 'installed': return `Up to date: ${s.current_version} was installed remotely.`
    case 'rolled_back': return `${version.value} did not start, so ${s.current_version} was put back.`
    case 'failed': return `The update to ${version.value} did not complete.`
    default: return `Up to date: ${s.current_version}.`
  }
})

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  return s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`
}

async function load() {
  status.value = await get<UpdateStatus>('/app-update/status', { cache: 'no-store' })
}

async function act(kind: 'check' | 'install' | 'trust') {
  busy.value = kind
  try {
    const path = kind === 'check' ? '/app-update/check' : kind === 'install' ? '/app-update/install-now' : '/app-update/trust-new-key'
    status.value = await post<UpdateStatus>(path, {})
    if (kind === 'install') success('Installing once running jobs stop')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'The update action failed')
  } finally {
    busy.value = ''
  }
}

async function save(patch: Record<string, unknown>) {
  busy.value = 'save'
  try { status.value = await put<UpdateStatus>('/app-update/settings', patch) } catch (e: any) {
    showError(e?.data?.detail || 'Could not save')
  } finally { busy.value = '' }
}

async function setLogin(enabled: boolean) {
  busy.value = 'login'
  try { status.value = await put<UpdateStatus>('/app-update/open-at-login', { enabled }) } catch (e: any) {
    showError(e?.data?.detail || 'Could not change Open at Login')
    await load()
  } finally { busy.value = '' }
}

onMounted(() => { void load().catch(() => {}) })
</script>

<style scoped>
.app-update-key-hint { display: block; margin-block: var(--space-2); }
.app-update-actions { margin: var(--space-2, 8px) 0; }
.app-update-field { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.app-update-field select { max-width: 360px; }
</style>
