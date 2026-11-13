<template>
  <div class="app-version-info">
    <button class="version-badge" type="button" title="What's New" @click="whatsNew.open()">
      Story Studio KH {{ version || '—' }}
    </button>
    <p v-if="!compact">Updates are installed by Studio Launcher KH.</p>
    <p v-if="error" class="version-error" role="status">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useWhatsNewModal } from '~/composables/useWhatsNewModal'

/** `compact` keeps the pill alone in the 38px top bar and the sidebar footer; Settings and Welcome carry the sentence. */
const { compact = false } = defineProps<{ compact?: boolean }>()

const { get } = useApi()
const whatsNew = useWhatsNewModal()
const version = ref('')
const error = ref('')
onMounted(async () => {
  try {
    const info = await get<{ version: string }>('/server-info', { cache: 'no-store' })
    if (!info.version) throw new Error('Version unavailable')
    version.value = info.version
  } catch {
    error.value = 'The installed version could not be read.'
  }
})
</script>

<style scoped>
.app-version-info { display: grid; justify-items: start; gap: 4px; max-width: 260px; }
.version-badge {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-xs);
  cursor: pointer;
}
.version-badge:hover { background: var(--bg-hover); border-color: var(--accent); }
.version-badge:active { background: var(--accent-dim); }
.version-badge:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
p { margin: 0; color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.4; }
.version-error { color: var(--danger); }
</style>
