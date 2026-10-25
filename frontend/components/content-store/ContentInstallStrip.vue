<template>
  <div v-if="visible" class="content-install-strip" role="status" aria-live="polite">
    <span class="strip-text">
      <template v-if="queue.running.value">
        Installing Content Packs — {{ queue.batchDone.value }} of {{ queue.batchTotal.value }} done<template v-if="queue.batchFailed.value">, {{ queue.batchFailed.value }} failed</template><template v-if="queue.activeTitle.value"> · now: {{ queue.activeTitle.value }}</template><template v-if="progressLine"> · {{ progressLine }}</template>
      </template>
      <template v-else>
        Content Pack installs finished — {{ queue.batchInstalled.value }} installed<template v-if="queue.haltReason.value"> — stopped early. {{ queue.haltReason.value }}</template><template v-else-if="queue.batchFailed.value">, {{ queue.batchFailed.value }} failed. Open the pack and try again.</template>
      </template>
    </span>
    <span class="strip-actions">
      <NuxtLink v-if="!onStore" to="/library" class="strip-link">Open Studio Library</NuxtLink>
      <button v-if="!queue.running.value" type="button" class="strip-link" @click="queue.clearFinished()">Dismiss</button>
    </span>
  </div>
</template>

<script setup lang="ts">
/**
 * Where the install queue stands, on every page. Installs keep running after
 * the Studio Library is left; without this the only evidence was a job that
 * finished somewhere else. Rendered from the shared queue, so it is the same
 * count the Library's own cards show.
 */
import { computed } from 'vue'
import { useContentInstallQueue } from '~/composables/useContentInstallQueue'

const queue = useContentInstallQueue()
const route = useRoute()
const onStore = computed(() => route.path.startsWith('/library'))
const visible = computed(() => queue.running.value || queue.finished.value)
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1)
  return `${(bytes / (1024 ** (unit + 1))).toFixed(unit > 0 ? 1 : 0)} ${units[unit]}`
}
const progressLine = computed(() => {
  const progress = queue.activeProgress.value
  if (!progress) return ''
  if (progress.phase === 'downloading') {
    if (progress.downloadedBytes !== null && progress.totalBytes !== null) return `Downloading ${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)}`
    return 'Downloading'
  }
  if (progress.phase === 'verifying') return 'Verifying signed pack'
  if (progress.phase === 'installing') return 'Installing verified pack'
  if (progress.phase === 'queued') return 'Queued'
  return ''
})
</script>

<style scoped>
.content-install-strip { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 14px; padding: 8px 14px; border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border)); border-radius: var(--radius-md); background: var(--accent-dim); color: var(--text-primary); font-size: var(--font-sm); }
.strip-text { min-width: 0; overflow-wrap: anywhere; }
.strip-actions { display: inline-flex; gap: 12px; }
.strip-link { border: 0; padding: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; font-weight: 650; text-decoration: underline; }
.strip-link:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
</style>
