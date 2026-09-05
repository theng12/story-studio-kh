<template>
  <div v-if="message || states.length" class="episode-recovery" role="status">
    <p v-if="message">{{ message }}</p>
    <p v-if="expected">{{ expected - missing.length }}/{{ expected }} sections ready</p>
    <p v-for="state in states" :key="state.section">{{ state.section }}: {{ state.message }}</p>
    <form v-if="canBuy && !sent" class="subtitle-purchase" @submit.prevent="buy">
      <label>Additional subtitle credit ceiling
        <input v-model="ceiling" type="number" min="1" step="1" required :disabled="busy" />
      </label>
      <button class="btn btn-xs btn-primary" type="submit" :disabled="busy">{{ busy ? 'Queueing recovery…' : 'Buy missing subtitles now' }}</button>
    </form>
    <div v-if="rerunSections.length && rerunHref" class="subtitle-rerun">
      <p>Recovery cannot finish the saved result. A fresh GenStudio request is limited to the chapter you choose; GenStudio confirms the current quote before submission and the new request may be charged.</p>
      <a class="btn btn-xs btn-secondary" :href="rerunHref">Open missing chapter controls</a>
    </div>
    <p v-if="sent">Recovery queued. Existing task identities and completed sections are preserved.</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{ job: {
  job_id: string; project_slug: string; episode_id?: string; type: string; status: string
  params?: Record<string, any>; result?: Record<string, any>
} }>()
const { post } = useApi()
const ceiling = ref('')
const busy = ref(false)
const sent = ref(false)
const error = ref('')
const missing = computed<string[]>(() => Array.isArray(props.job.result?.missing_sections) ? props.job.result.missing_sections : [])
const expected = computed(() => Number.isSafeInteger(props.job.result?.expected_sections) ? props.job.result!.expected_sections as number : 0)
const states = computed(() => Object.entries(props.job.params?.subtitle_recovery?.sections || {}).map(([section, state]) => ({ section, ...(state as { message?: string; manual_action?: string }) })))
const message = computed(() => props.job.params?.episode_recovery?.message || '')
const canBuy = computed(() => props.job.type === 'subtitles_transcribe' && props.job.status === 'error'
  && !props.job.params?.episode_recovery?.deferred && missing.value.length > 0
  && states.value.some(state => missing.value.includes(state.section) && state.manual_action === 'buy_missing_subtitles'))
const rerunSections = computed(() => states.value.filter(state => missing.value.includes(state.section)
  && state.manual_action === 'rerun_subtitle_section').map(state => state.section))
const rerunHref = computed(() => props.job.episode_id
  ? `/projects/${encodeURIComponent(props.job.project_slug)}/subtitles?episode_id=${encodeURIComponent(props.job.episode_id)}`
  : '')
async function buy() {
  if (busy.value || sent.value || !canBuy.value) return
  const value = Number(ceiling.value)
  if (!Number.isSafeInteger(value) || value < 1) { error.value = 'Enter a positive whole-number credit ceiling.'; return }
  busy.value = true
  error.value = ''
  try {
    await post(`/projects/${encodeURIComponent(props.job.project_slug)}/video-editor/subtitles/buy-missing/${encodeURIComponent(props.job.job_id)}`, { additional_credit_ceiling: value })
    sent.value = true
  } catch (cause: any) { error.value = cause?.data?.detail || cause?.message || 'Subtitle recovery could not be queued.' }
  finally { busy.value = false }
}
</script>

<style scoped>
.episode-recovery { min-width: 0; overflow-wrap: anywhere; font-size: .85rem; }
.episode-recovery p { margin: .35rem 0; }
.subtitle-purchase { display: flex; flex-wrap: wrap; align-items: end; gap: .6rem; margin: .5rem 0; }
.subtitle-purchase label { display: flex; flex-direction: column; gap: .25rem; max-width: 100%; }
.subtitle-purchase input { width: 10rem; max-width: 100%; min-height: 2rem; }
.subtitle-rerun { margin: .5rem 0; }
</style>
