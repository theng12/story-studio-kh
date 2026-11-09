<template>
  <span ref="rootEl" class="app-update">
    <button
      ref="triggerEl"
      type="button"
      class="app-update-trigger"
      data-testid="app-update-trigger"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :title="state"
      :aria-label="`Update: ${state}`"
      @click="open = !open"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 3v11" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        <path d="m7.5 9.5 4.5 4.5 4.5-4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M5 17.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
      <span
        v-if="tone"
        class="app-update-dot"
        :class="[`is-${tone}`, { 'is-pulsing': tone === 'loading' || pulsing }]"
        aria-hidden="true"
      />
    </button>

    <div v-if="open" role="dialog" :aria-label="`Update — ${state}`" class="app-update-popover">
      <p class="app-update-line" role="status">{{ state }}</p>
      <p v-if="error" class="app-update-error" role="alert">{{ error }}</p>
      <p v-else-if="status?.last_check_error" class="app-update-error">{{ status.last_check_error }}</p>
      <div class="app-update-actions">
        <button v-if="status?.phase === 'ready'" class="btn btn-primary btn-sm" :disabled="busy" title="Pause new work, let jobs that cannot resume finish (up to 30 minutes), install, restart and resume" @click="installNow()">
          {{ busy ? 'Starting...' : 'Install Now' }}
        </button>
        <button v-if="canInstallImmediately(status?.phase)" class="btn btn-secondary btn-sm" :disabled="busy" title="Stop running jobs now, install and restart; they pick up again after the restart" @click="installNow(true)">
          {{ INSTALL_IMMEDIATELY_LABEL }}
        </button>
        <NuxtLink class="btn btn-ghost btn-sm" to="/settings#app-update" @click="open = false">
          Update settings
        </NuxtLink>
      </div>
    </div>
  </span>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { createVisibleInterval } from '~/composables/useVisibleInterval'
import { useConfirm } from '~/composables/useConfirm'
import { INSTALL_IMMEDIATELY_LABEL, canInstallImmediately, installImmediatelyQuestion, installNowQuestion, readyText, waitingText } from '~/utils/app-update'

interface UpdateBannerStatus {
  phase: string
  held?: boolean
  release?: { version: string } | null
  current_version?: string | null
  settings?: { auto_install: boolean }
  jobs_left?: number
  final_checks_running?: number
  queue_paused?: boolean
  maintenance_running?: { id: string; kind: string; status: string } | null
  waiting_for?: { submits: number; jobs: string[]; finalChecks?: number; maintenance?: { kind: string; status: string } | null } | null
  error?: string | null
  last_check_error?: string | null
}

const { get, post } = useApi()
const status = ref<UpdateBannerStatus | null>(null)
const open = ref(false)
const busy = ref(false)
const error = ref('')
const rootEl = ref<HTMLElement | null>(null)
const triggerEl = ref<HTMLElement | null>(null)
const { ask } = useConfirm()

/** The one honest sentence for every state: loading, current, waiting, failed, unavailable. Never a made-up version. */
const state = computed(() => {
  const s = status.value
  if (!s) return error.value ? 'Update status unavailable.' : 'Checking for updates…'
  const v = s.release?.version
  if (s.phase === 'failed') return v ? `The update to ${v} did not complete.` : s.error || 'The update did not complete.'
  if (s.phase === 'rolled_back') return v ? `${v} did not start, so the previous version was put back.` : s.error || 'The update did not start, so the previous version was put back.'
  if (!v) {
    if (s.phase === 'installed') return s.current_version ? `Up to date: ${s.current_version} was installed remotely.` : 'Up to date.'
    return s.current_version ? `Up to date: ${s.current_version}.` : 'No update is waiting.'
  }
  if (s.phase === 'ready') {
    if (s.held || !s.settings?.auto_install) return `Story Studio ${v} is ready.`
    return readyText(v, !!s.queue_paused, s.maintenance_running)
  }
  if (s.phase === 'downloading') return `Downloading Story Studio ${v}...`
  if (s.phase === 'draining') return waitingText(v, s.waiting_for)
  if (s.phase === 'installing') return `Installing Story Studio ${v}. It restarts in a moment.`
  return s.current_version ? `Up to date: ${s.current_version}.` : 'No update is waiting.'
})

/** Dot tone: loading / needs attention (accent) / broken (danger); empty = quietly current. */
const tone = computed(() => {
  const s = status.value
  if (!s) return error.value ? 'danger' : 'loading'
  if (error.value || s.phase === 'failed' || s.phase === 'rolled_back') return 'danger'
  if (['ready', 'downloading', 'draining', 'installing'].includes(s.phase)) return 'accent'
  return ''
})
const pulsing = computed(() => ['downloading', 'draining'].includes(status.value?.phase || ''))

async function load() {
  try {
    status.value = await get<UpdateBannerStatus>('/app-update/status', { cache: 'no-store' })
    error.value = ''
  } catch {
    error.value = 'Could not read the update status. Story Studio may still be starting up.'
  }
}

async function installNow(immediately = false) {
  const version = status.value?.release?.version || ''
  const question = immediately ? installImmediatelyQuestion(version) : installNowQuestion(version, status.value?.jobs_left ?? 0)
  if (question && !await ask({ ...question, confirmLabel: immediately ? INSTALL_IMMEDIATELY_LABEL : 'Install Now', danger: false })) return
  busy.value = true
  error.value = ''
  try {
    status.value = await post<UpdateBannerStatus>('/app-update/install-now', immediately ? { immediately: true } : {})
  } catch (e: any) {
    error.value = e?.data?.detail || e?.message || 'The update action failed'
  } finally { busy.value = false }
}

// Close on outside click + Escape (focus returns to the trigger), same as NotificationCenter.
function close() { open.value = false; triggerEl.value?.focus() }
function onDocMouseDown(e: MouseEvent) {
  if (open.value && rootEl.value && !rootEl.value.contains(e.target as Node)) open.value = false
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) close()
}

const poll = createVisibleInterval(() => { void load() }, 60_000)
onMounted(() => {
  void load()
  poll.start()
  document.addEventListener('mousedown', onDocMouseDown)
  document.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  poll.stop()
  document.removeEventListener('mousedown', onDocMouseDown)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
.app-update { position: relative; display: inline-flex; -webkit-app-region: no-drag; }
.app-update-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 8px);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.app-update-trigger:hover { border-color: var(--accent); background: rgba(255, 255, 255, 0.08); color: var(--text-primary); }
.app-update-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.app-update-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--text-muted); }
.app-update-dot.is-accent { background: var(--accent); }
.app-update-dot.is-danger { background: var(--danger); }
.app-update-dot.is-pulsing { animation: app-update-pulse 1.4s ease-in-out infinite; }
@keyframes app-update-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .app-update-dot.is-pulsing { animation: none; }
  .app-update-trigger { transition: none; }
}
.app-update-popover {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 210;
  width: max-content;
  max-width: min(420px, calc(100vw - 32px));
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 8px);
  background: var(--surface-raised);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  text-align: left;
}
.app-update-line { margin: 0; color: var(--text-primary); font-size: var(--font-sm); line-height: 1.45; }
.app-update-error { margin: 8px 0 0; color: var(--danger); font-size: var(--font-sm); }
.app-update-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
</style>
