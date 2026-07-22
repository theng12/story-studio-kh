<template>
  <div class="catalog-settings">
    <header>
      <span class="eyebrow">Live inventory</span>
      <h3>GenStudio catalogs</h3>
      <p>Models and voices are loaded live. Story Studio does not save provider rates or substitute a legacy provider.</p>
      <button class="btn btn-secondary btn-sm" :disabled="loading" @click="refresh">{{ loading ? 'Refreshing…' : 'Refresh catalogs' }}</button>
    </header>
    <WorkspaceNotice v-if="error" tone="warning" title="Catalog unavailable">{{ error }}</WorkspaceNotice>
    <div class="catalog-grid">
      <article v-for="entry in summaries" :key="entry.label">
        <span>{{ entry.label }}</span>
        <strong>{{ entry.available }}/{{ entry.total }}</strong>
        <small>available</small>
      </article>
    </div>
    <p class="billing-note">GenStudio returns quotes/reservations and settled or returned credits with its jobs. Those values appear in Jobs and Credits; no rate is editable here.</p>
  </div>
</template>

<script setup lang="ts">
const { get } = useApi()
const { models: imageModels, refresh: refreshImages } = useGenStudioImageModels()
const { voiceModels, videoModels, refresh: refreshMedia } = useGenStudioMediaModels()
const chatModels = ref<Array<{ available: boolean }>>([])
const transcriptionModels = ref<Array<{ available: boolean }>>([])
const voices = ref<Array<{ generation_enabled?: boolean }>>([])
const loading = ref(false)
const error = ref('')

const summaries = computed(() => [
  { label: 'LLM', total: chatModels.value.length, available: chatModels.value.filter(model => model.available).length },
  { label: 'Images', total: imageModels.value.length, available: imageModels.value.filter(model => model.available).length },
  { label: 'TTS models', total: voiceModels.value.length, available: voiceModels.value.filter(model => model.available).length },
  { label: 'Voices', total: voices.value.length, available: voices.value.filter(voice => voice.generation_enabled !== false).length },
  { label: 'Transcription', total: transcriptionModels.value.length, available: transcriptionModels.value.filter(model => model.available).length },
  { label: 'Video', total: videoModels.value.length, available: videoModels.value.filter(model => model.available).length },
])

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [chat, transcription, voiceResult] = await Promise.all([
      get<{ models: Array<{ available: boolean }> }>('/app-settings/genstudio/chat-models', { cache: 'no-store' }),
      get<{ models: Array<{ available: boolean }> }>('/app-settings/genstudio/transcription-models', { cache: 'no-store' }),
      get<{ voices: Array<{ generation_enabled?: boolean }> }>('/app-settings/genstudio/voices', { cache: 'no-store' }),
      refreshImages(true),
      refreshMedia(true),
    ])
    chatModels.value = chat.models || []
    transcriptionModels.value = transcription.models || []
    voices.value = voiceResult.voices || []
  } catch (cause: any) {
    error.value = cause?.data?.detail || cause?.message || 'GenStudio catalogs unavailable.'
  } finally { loading.value = false }
}

onMounted(() => { void refresh() })
</script>

<style scoped>
.catalog-settings header { display: grid; grid-template-columns: 1fr auto; gap: 4px 16px; align-items: start; }.catalog-settings h3 { margin: 2px 0; }.catalog-settings header p { margin: 0; color: var(--text-muted); font-size: 12px; }.eyebrow { grid-column: 1; color: var(--accent); font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }.catalog-settings header button { grid-column: 2; grid-row: 1 / 4; }
.catalog-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 16px; }.catalog-grid article { padding: 13px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-primary); }.catalog-grid span, .catalog-grid small { display: block; color: var(--text-muted); font-size: 11px; }.catalog-grid strong { display: block; margin: 3px 0; font-size: 20px; }.billing-note { margin: 14px 0 0; color: var(--text-muted); font-size: 11px; line-height: 1.5; }
</style>
