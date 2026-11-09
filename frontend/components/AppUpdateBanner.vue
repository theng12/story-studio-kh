<template>
  <span v-if="text" class="app-update">
    <!--
      The updater's status and its actions, reachable from the TOP of every
      window (the old fixed bottom pill is gone). Opening this reveals the
      existing explicit action path only: nothing here installs by itself,
      and the install buttons keep their confirm-and-post flow from
      utils/app-update.ts unchanged.
    -->
    <button
      type="button"
      class="app-update-trigger"
      data-testid="app-update-trigger"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :title="text"
      :aria-label="`Update: ${text}`"
      @click="open = !open"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 3v11" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        <path d="m7.5 9.5 4.5 4.5 4.5-4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M5 17.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
      <span class="app-update-trigger-text">{{ text }}</span>
      <span
        v-if="status?.phase === 'downloading' || status?.phase === 'draining'"
        class="app-update-pulse"
        aria-hidden="true"
      />
    </button>

    <div v-if="open" role="dialog" :aria-label="`Update — ${text}`" class="app-update-popover">
      <p class="app-update-line" role="status">{{ text }}</p>
      <p v-if="error" class="app-update-error" role="alert">{{ error }}</p>
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
  settings?: { auto_install: boolean }
  jobs_left?: number
  /** Final checks still measuring a finished video; they hold an install until they finish. */
  final_checks_running?: number
  queue_paused?: boolean
  /** The one non-queue storage operation holding this Mac, if any; the queue runs on through it. */
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
const { ask } = useConfirm()

/** "Update ready — installs as soon as it's ready / Install Now", and what the install still waits for. */
const text = computed(() => {
  const s = status.value
  const v = s?.release?.version
  if (!s || !v) return ''
  if (s.phase === 'ready') {
    if (s.held || !s.settings?.auto_install) return `Story Studio ${v} is ready.`
    return readyText(v, !!s.queue_paused, s.maintenance_running)
  }
  if (s.phase === 'downloading') return `Downloading Story Studio ${v}...`
  if (s.phase === 'draining') return waitingText(v, s.waiting_for)
  if (s.phase === 'installing') return `Installing Story Studio ${v}. It restarts in a moment.`
  if (s.phase === 'failed') return `The update to ${v} did not complete.`
  if (s.phase === 'rolled_back') return `${v} did not start, so the previous version was put back.`
  return ''
})

async function load() {
  try {
    status.value = await get<UpdateBannerStatus>('/app-update/status', { cache: 'no-store' })
    error.value = ''
  } catch {
    // Engine restarting — keep the last honest state; when there is none, the
    // control stays hidden rather than claiming a state it does not have.
    if (status.value) error.value = 'Could not refresh the update status.'
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

const poll = createVisibleInterval(() => { void load() }, 60_000)
onMounted(() => { void load(); poll.start() })
onUnmounted(() => poll.stop())
</script>

<style scoped>
.app-update { position: relative; display: inline-flex; -webkit-app-region: no-drag; }
.app-update-trigger {
  display: inline-flex;
  max-width: 340px;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-secondary);
  font-size: var(--font-xs);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.app-update-trigger:hover { border-color: var(--accent); background: rgba(255, 255, 255, 0.08); color: var(--text-primary); }
.app-update-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.app-update-trigger-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.app-update-pulse {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: var(--accent);
  animation: app-update-pulse 1.4s ease-in-out infinite;
}
@keyframes app-update-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
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

/* Narrow windows: the bar wraps, and the pill must not squeeze the nav —
   one readable line that still carries the whole honest status in its title. */
@media (max-width: 1330px) {
  .app-update-trigger { max-width: 240px; }
}
@media (max-width: 720px) {
  .app-update { order: 1; }
  .app-update-trigger { max-width: 100%; }
}
</style>