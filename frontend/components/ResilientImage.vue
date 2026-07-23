<template>
  <div :class="['resilient-image', `is-${state}`, { 'is-compact': compact }]">
    <img
      v-if="src"
      :key="requestKey"
      :src="requestUrl"
      :alt="alt"
      :loading="loading"
      decoding="async"
      @load="onLoad"
      @error="onError"
    />

    <div v-if="showStatus && state === 'loading'" class="resilient-image-status" aria-live="polite">
      <LoadingSpinner size="sm" />
      <span v-if="!compact">Loading preview...</span>
    </div>

    <button
      v-if="showStatus && state === 'error' && manualRetry"
      type="button"
      class="resilient-image-retry"
      title="Try loading this preview again"
      @click.stop="retry"
    >
      <span aria-hidden="true">↻</span>
      <span>{{ compact ? 'Retry' : 'Preview unavailable - retry' }}</span>
    </button>
    <div
      v-else-if="showStatus && state === 'error'"
      class="resilient-image-retry is-static"
    >
      <span aria-hidden="true">!</span>
      <span>Preview unavailable</span>
    </div>
  </div>
</template>

<script setup lang="ts">
type PreviewState = 'loading' | 'loaded' | 'error'

const props = withDefaults(defineProps<{
  src: string
  alt?: string
  loading?: 'eager' | 'lazy'
  compact?: boolean
  showStatus?: boolean
  manualRetry?: boolean
  retryAfterMs?: number
  automaticRetries?: number
}>(), {
  alt: '',
  loading: 'eager',
  compact: false,
  showStatus: true,
  manualRetry: true,
  retryAfterMs: 8000,
  automaticRetries: 1,
})

const emit = defineEmits<{
  load: [event: Event]
  error: [event: Event]
}>()

const state = ref<PreviewState>('loading')
const attempt = ref(0)
let retryTimer: ReturnType<typeof setTimeout> | null = null

const requestKey = computed(() => `${props.src}:${attempt.value}`)
const requestUrl = computed(() => {
  if (!props.src || attempt.value === 0) return props.src
  const joiner = props.src.includes('?') ? '&' : '?'
  return `${props.src}${joiner}preview_retry=${attempt.value}`
})

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

function armStallRecovery() {
  clearRetryTimer()
  if (!props.src || props.retryAfterMs <= 0) return
  retryTimer = setTimeout(() => {
    if (state.value !== 'loading') return
    if (attempt.value < props.automaticRetries) {
      attempt.value++
      state.value = 'loading'
      armStallRecovery()
    } else {
      state.value = 'error'
    }
  }, props.retryAfterMs)
}

function reset() {
  attempt.value = 0
  state.value = props.src ? 'loading' : 'error'
  armStallRecovery()
}

function retry() {
  attempt.value++
  state.value = 'loading'
  armStallRecovery()
}

function onLoad(event: Event) {
  clearRetryTimer()
  state.value = 'loaded'
  emit('load', event)
}

function onError(event: Event) {
  clearRetryTimer()
  if (attempt.value < props.automaticRetries) {
    attempt.value++
    state.value = 'loading'
    armStallRecovery()
  } else {
    state.value = 'error'
    emit('error', event)
  }
}

watch(() => props.src, reset, { immediate: true })
onBeforeUnmount(clearRetryTimer)
</script>

<style scoped>
.resilient-image {
  position: relative;
  display: block;
  overflow: hidden;
  min-width: 0;
  min-height: 0;
  background: var(--bg-tertiary);
}

.resilient-image > img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: inherit;
}

.resilient-image-status,
.resilient-image-retry {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 8px;
  border: 0;
  background: color-mix(in srgb, var(--bg-tertiary) 92%, transparent);
  color: var(--text-muted);
  font: inherit;
  font-size: var(--font-xs);
  text-align: center;
}

.resilient-image-retry {
  cursor: pointer;
  color: var(--warning, #f0c674);
}

.resilient-image-retry:hover {
  background: color-mix(in srgb, var(--warning, #f0c674) 10%, var(--bg-tertiary));
  color: var(--text-primary);
}

.resilient-image-retry.is-static {
  cursor: default;
  color: var(--text-muted);
}

.resilient-image.is-compact .resilient-image-status,
.resilient-image.is-compact .resilient-image-retry {
  gap: 4px;
  padding: 4px;
  font-size: var(--font-xs);
}
</style>
