<template>
  <div class="vlb">
    <div class="vlb-head">
      <nav class="vlb-tabs" aria-label="Voice library providers">
        <button
          v-for="library in libraries"
          :key="library.id"
          type="button"
          class="vlb-tab"
          :class="{ active: activeLibrary === library.id }"
          :aria-current="activeLibrary === library.id ? 'page' : undefined"
          @click="selectLibrary(library.id)"
        >{{ library.label }}</button>
      </nav>
      <input
        v-model="search"
        type="search"
        class="input input-sm vlb-search"
        placeholder="Search this library…"
        @keydown.enter.prevent="reload"
      />
      <button type="button" class="btn btn-sm btn-secondary" :disabled="loading" @click="reload">
        {{ loading ? 'Loading…' : 'Search' }}
      </button>
    </div>

    <p class="vlb-note">
      Voices published by <strong>{{ activeLibraryLabel }}</strong> in your GenStudio KH account. Adding one brings it
      into your own library so it appears with the voices for a compatible model.
    </p>

    <div v-if="error" class="vlb-warning">{{ error }}</div>
    <div v-else-if="loading && !rows.length" class="vlb-empty">Loading {{ activeLibraryLabel }} voices…</div>
    <div v-else-if="!rows.length" class="vlb-empty">No voices matched this search.</div>

    <div v-for="voice in rows" :key="voice.public_voice_id" class="vlb-row">
      <div class="vlb-row-main">
        <strong>{{ voice.name }}</strong>
        <span class="vlb-meta">
          <template v-for="(part, index) in metaParts(voice)" :key="part">
            <span v-if="index" aria-hidden="true"> · </span>{{ part }}
          </template>
        </span>
        <span v-if="voice.description" class="vlb-description">{{ voice.description }}</span>
        <span v-if="voice.notice_period_days !== null && voice.notice_period_days !== undefined" class="vlb-notice">
          {{ activeLibraryLabel }} publishes a {{ voice.notice_period_days }}-day notice period for this voice.
        </span>
      </div>
      <button
        type="button"
        class="btn btn-sm btn-ghost"
        :disabled="!voice.preview_available || previewing === voice.public_voice_id"
        :title="voice.preview_available ? 'Play the published sample' : 'No sample is published for this voice'"
        @click="preview(voice)"
      >{{ previewing === voice.public_voice_id ? '…' : '▶' }}</button>
      <button
        type="button"
        class="btn btn-sm btn-primary"
        :disabled="adding === voice.public_voice_id || voice.is_saved === true"
        @click="add(voice)"
      >
        {{ voice.is_saved === true ? 'In library' : adding === voice.public_voice_id ? 'Adding…' : 'Add' }}
      </button>
    </div>

    <div v-if="rows.length" class="vlb-pager">
      <button type="button" class="btn btn-sm btn-secondary" :disabled="page <= 0 || loading" @click="goTo(page - 1)">
        ← Previous
      </button>
      <span class="vlb-page">Page {{ page + 1 }}</span>
      <button type="button" class="btn btn-sm btn-secondary" :disabled="!hasMore || loading" @click="goTo(page + 1)">
        Next →
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Browse the provider voice libraries GenStudio publishes, BY PROVIDER and
 * named as such (AGENTS.md → Provider Transparency). The provider list comes
 * from GenStudio via `/app-settings/genstudio/voice-libraries`; this component
 * hardcodes none of it.
 */
import type { GenStudioLibraryVoice } from '~/composables/useGenStudioVoices'

const emit = defineEmits<{ added: [voiceId: string] }>()

const { libraries, loadLibraries, browseLibrary, addLibraryVoice, libraryPreviewUrl } = useGenStudioVoices()
const { success, error: showError } = useToast()

const activeLibrary = ref('')
const search = ref('')
const page = ref(0)
const hasMore = ref(false)
const rows = ref<GenStudioLibraryVoice[]>([])
const loading = ref(false)
const error = ref('')
const adding = ref('')
const previewing = ref('')
let audio: HTMLAudioElement | null = null

const activeLibraryLabel = computed(() =>
  libraries.value.find(library => library.id === activeLibrary.value)?.label || 'this library')

function metaParts(voice: GenStudioLibraryVoice): string[] {
  return [
    voice.language,
    voice.accent || '',
    voice.gender || '',
    voice.age || '',
    voice.category || '',
    voice.use_case || '',
  ].filter(Boolean) as string[]
}

async function load() {
  if (!activeLibrary.value) return
  loading.value = true
  error.value = ''
  try {
    const result = await browseLibrary(activeLibrary.value, { search: search.value, page: page.value })
    rows.value = result.voices
    hasMore.value = result.has_more
    page.value = result.page
  } catch (e: any) {
    rows.value = []
    hasMore.value = false
    error.value = e?.data?.detail || e?.message || 'This voice library is unavailable right now.'
  } finally {
    loading.value = false
  }
}

function reload() {
  page.value = 0
  void load()
}

function goTo(next: number) {
  page.value = Math.max(0, next)
  void load()
}

function selectLibrary(id: string) {
  if (activeLibrary.value === id) return
  activeLibrary.value = id
  search.value = ''
  reload()
}

async function preview(voice: GenStudioLibraryVoice) {
  previewing.value = voice.public_voice_id
  try {
    audio?.pause()
    const url = voice.preview_url || await libraryPreviewUrl(activeLibrary.value, voice.public_voice_id)
    if (!url) throw new Error('No sample was returned for this voice.')
    audio = new Audio(url)
    await audio.play()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Could not play this sample')
  } finally {
    previewing.value = ''
  }
}

async function add(voice: GenStudioLibraryVoice) {
  adding.value = voice.public_voice_id
  try {
    const result = await addLibraryVoice(activeLibrary.value, voice.public_voice_id)
    success(result.created
      ? `Added “${voice.name}” to your GenStudio library.`
      : `“${voice.name}” was already in your GenStudio library.`)
    emit('added', result.voice_id)
    void load()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Could not add this voice')
  } finally {
    adding.value = ''
  }
}

onMounted(async () => {
  await loadLibraries()
  if (!activeLibrary.value && libraries.value.length) {
    activeLibrary.value = libraries.value[0]!.id
    await load()
  }
})
onBeforeUnmount(() => { audio?.pause(); audio = null })
</script>

<style scoped>
.vlb { display: flex; flex-direction: column; gap: 8px; }
.vlb-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.vlb-tabs { display: flex; gap: 4px; }
.vlb-tab { padding: 5px 10px; border: 1px solid var(--border); border-radius: 999px; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 12px; }
.vlb-tab.active { border-color: var(--accent); background: var(--accent-dim); color: var(--accent); }
.vlb-search { flex: 1; min-width: 140px; }
.vlb-note { margin: 0; color: var(--text-muted); font-size: var(--font-xs); }
.vlb-warning { padding: 8px; border: 1px solid rgba(245,158,11,.4); border-radius: var(--radius-sm); color: rgb(245,158,11); font-size: var(--font-xs); }
.vlb-empty { padding: 20px 12px; color: var(--text-muted); font-size: 12px; text-align: center; }
.vlb-row { display: flex; align-items: center; gap: 6px; padding: 6px; border: 1px solid transparent; border-radius: var(--radius-sm); }
.vlb-row:hover { background: var(--bg-tertiary); border-color: var(--border); }
.vlb-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.vlb-row-main strong { font-size: 13px; }
.vlb-meta, .vlb-description, .vlb-notice { color: var(--text-muted); font-size: var(--font-xs); }
.vlb-description { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.vlb-notice { color: rgb(245,158,11); }
.vlb-pager { display: flex; align-items: center; justify-content: center; gap: 10px; padding-top: 4px; }
.vlb-page { color: var(--text-muted); font-size: var(--font-xs); }
</style>
