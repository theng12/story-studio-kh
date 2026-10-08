<template>
  <div v-if="text" class="app-update-banner" role="status">
    <span>{{ text }}</span>
    <button v-if="status?.phase === 'ready'" class="btn btn-primary btn-sm" :disabled="busy" title="Pause the queue, let running jobs finish (up to 30 minutes), install, restart and resume" @click="installNow">
      {{ busy ? 'Starting…' : 'Install Now' }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { createVisibleInterval } from '~/composables/useVisibleInterval'
import { useConfirm } from '~/composables/useConfirm'
import { installNowQuestion, waitingForQueueText } from '~/utils/app-update'

interface UpdateBannerStatus {
  phase: string
  held?: boolean
  release?: { version: string } | null
  settings?: { auto_install: boolean }
  jobs_left?: number
  queue_paused?: boolean
}

const { get, post } = useApi()
const status = ref<UpdateBannerStatus | null>(null)
const busy = ref(false)
const { ask } = useConfirm()

/** "Update ready — installs when the queue is empty / Install Now", and the drain while it runs. */
const text = computed(() => {
  const s = status.value
  const v = s?.release?.version
  if (!s || !v) return ''
  if (s.phase === 'ready') {
    if (s.held || !s.settings?.auto_install) return `Story Studio ${v} is ready.`
    return waitingForQueueText(v, s.jobs_left ?? 0, !!s.queue_paused)
  }
  if (s.phase === 'draining') return `Installing Story Studio ${v} once running jobs stop. The queue is paused for the update and resumes after it.`
  if (s.phase === 'installing') return `Installing Story Studio ${v}. It restarts in a moment.`
  return ''
})

async function load() {
  try { status.value = await get<UpdateBannerStatus>('/app-update/status', { cache: 'no-store' }) } catch { /* engine restarting */ }
}

async function installNow() {
  const question = installNowQuestion(status.value?.release?.version || '', status.value?.jobs_left ?? 0)
  if (question && !await ask({ ...question, confirmLabel: 'Install Now', danger: false })) return
  busy.value = true
  try { status.value = await post<UpdateBannerStatus>('/app-update/install-now', {}) } finally { busy.value = false }
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
