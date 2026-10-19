<template>
  <div v-if="text" class="app-update-banner" role="status">
    <span>{{ text }}</span>
    <button v-if="status?.phase === 'ready'" class="btn btn-primary btn-sm" :disabled="busy" title="Pause new work, let jobs that cannot resume finish (up to 30 minutes), install, restart and resume" @click="installNow()">
      {{ busy ? 'Starting…' : 'Install Now' }}
    </button>
    <button v-if="canInstallImmediately(status?.phase)" class="btn btn-secondary btn-sm" :disabled="busy" title="Stop running jobs now, install and restart; they pick up again after the restart" @click="installNow(true)">
      {{ INSTALL_IMMEDIATELY_LABEL }}
    </button>
  </div>
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
  waiting_for?: { submits: number; jobs: string[]; finalChecks?: number; maintenance?: { kind: string; status: string } | null } | null
}

const { get, post } = useApi()
const status = ref<UpdateBannerStatus | null>(null)
const busy = ref(false)
const { ask } = useConfirm()

/** "Update ready — installs as soon as it's ready / Install Now", and what the install still waits for. */
const text = computed(() => {
  const s = status.value
  const v = s?.release?.version
  if (!s || !v) return ''
  if (s.phase === 'ready') {
    if (s.held || !s.settings?.auto_install) return `Story Studio ${v} is ready.`
    return readyText(v, !!s.queue_paused)
  }
  if (s.phase === 'downloading') return `Downloading Story Studio ${v}…`
  if (s.phase === 'draining') return waitingText(v, s.waiting_for)
  if (s.phase === 'installing') return `Installing Story Studio ${v}. It restarts in a moment.`
  return ''
})

async function load() {
  try { status.value = await get<UpdateBannerStatus>('/app-update/status', { cache: 'no-store' }) } catch { /* engine restarting */ }
}

async function installNow(immediately = false) {
  const version = status.value?.release?.version || ''
  const question = immediately ? installImmediatelyQuestion(version) : installNowQuestion(version, status.value?.jobs_left ?? 0)
  if (question && !await ask({ ...question, confirmLabel: immediately ? INSTALL_IMMEDIATELY_LABEL : 'Install Now', danger: false })) return
  busy.value = true
  try { status.value = await post<UpdateBannerStatus>('/app-update/install-now', immediately ? { immediately: true } : {}) } finally { busy.value = false }
}

const poll = createVisibleInterval(() => { void load() }, 60_000)
onMounted(() => { void load(); poll.start() })
onUnmounted(() => poll.stop())
</script>

<style scoped>
.app-update-banner {
  position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 900;
  display: flex; gap: 12px; align-items: center; padding: 10px 16px; border-radius: 10px;
  background: var(--surface-raised); border: 1px solid var(--border);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35); max-width: calc(100vw - 32px);
}
</style>
