<template>
  <p class="updated-ago" role="status">
    <span>{{ label }}</span>
    <span aria-hidden="true">·</span>
    <button type="button" class="updated-ago-refresh" :disabled="busy" :title="title" @click="$emit('refresh', $event)">
      {{ busy ? 'Refreshing…' : 'Refresh' }}
    </button>
  </p>
</template>

<script setup lang="ts">
/**
 * "Updated 4 min ago · Refresh" — the one freshness caption Board, Jobs and
 * Pipeline share, so the owner can tell a stale list from a quiet one.
 * `at` is when the list was last loaded (ms, Date or ISO); null shows "Not loaded yet".
 */
import { updatedAgoLabel } from '~/utils/updated-ago'

const props = defineProps<{ at: number | string | Date | null | undefined; busy?: boolean; title?: string }>()
defineEmits<{ (e: 'refresh', event: MouseEvent): void }>()

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 15_000) })
onUnmounted(() => { if (timer) clearInterval(timer) })

const label = computed(() => updatedAgoLabel(props.at, now.value))
</script>

<style scoped>
.updated-ago { display: inline-flex; align-items: center; gap: 6px; margin: 0; color: var(--text-muted); font-size: var(--font-xs); }
.updated-ago-refresh {
  padding: 0; border: 0; background: none; color: var(--text-secondary); font: inherit;
  text-decoration: underline; text-underline-offset: 3px; cursor: pointer;
}
.updated-ago-refresh:hover:not(:disabled) { color: var(--text-primary); }
.updated-ago-refresh:disabled { cursor: default; opacity: .7; text-decoration: none; }
</style>
