<template>
  <div class="vlb">
    <div class="vlb-head">
      <strong class="vlb-provider">{{ library.label }} library</strong>
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

    <div class="vlb-list">
      <div v-if="error" class="vlb-warning">{{ error }}</div>
      <div v-else-if="loading && !rows.length" class="vlb-empty">Loading {{ activeLibraryLabel }} voices…</div>
      <div v-else-if="!rows.length" class="vlb-empty">
        {{ search.trim() ? 'No voices matched this search.' : `${activeLibraryLabel} returned no voices right now.` }}
      </div>

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
    </div>

    <button
      v-if="hasMore"
      type="button"
      class="btn btn-sm btn-secondary vlb-more"
      :disabled="loading"
      @click="load(page + 1, true)"
    >{{ loading ? 'Loading…' : 'Load more voices' }}</button>
  </div>
</template>

<script setup lang="ts">
/**
 * Browse the one provider library linked to the selected model. The link is
 * published by Story's GenStudio boundary as a provider id; this component
 * neither guesses from the model name nor offers unrelated provider tabs.
 */
import type { GenStudioLibraryVoice, GenStudioVoiceLibrary } from '~/composables/useGenStudioVoices'

const props = defineProps<{ library: GenStudioVoiceLibrary }>()

const emit = defineEmits<{ added: [voiceId: string] }>()

const { browseLibrary, addLibraryVoice, libraryPreviewUrl } = useGenStudioVoices()
const { success, error: showError } = useToast()

const search = ref('')
const page = ref(0)
const hasMore = ref(false)
const rows = ref<GenStudioLibraryVoice[]>([])
const loading = ref(false)
const error = ref('')
const adding = ref('')
const previewing = ref('')
let audio: HTMLAudioElement | null = null

const activeLibraryLabel = computed(() => props.library.label)

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

async function load(nextPage = 0, append = false) {
  loading.value = true
  error.value = ''
  try {
    const result = await browseLibrary(props.library.id, { search: search.value, page: nextPage })
    rows.value = append ? [...rows.value, ...result.voices] : result.voices
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
  void load(0)
}

async function preview(voice: GenStudioLibraryVoice) {
  previewing.value = voice.public_voice_id
  try {
    audio?.pause()
    const url = voice.preview_url || await libraryPreviewUrl(props.library.id, voice.public_voice_id)
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
    const result = await addLibraryVoice(props.library.id, voice.public_voice_id)
    success(result.created
      ? `Added “${voice.name}” to your GenStudio library.`
      : `“${voice.name}” was already in your GenStudio library.`)
    emit('added', result.voice_id)
    void load(0)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Could not add this voice')
  } finally {
    adding.value = ''
  }
}

onMounted(() => { void load(0) })
onBeforeUnmount(() => { audio?.pause(); audio = null })
</script>

<style scoped>
.vlb { display: flex; flex: 1; flex-direction: column; gap: 8px; min-height: 0; }
/* The rows are the only part that scrolls: search, provider label and Load more
   stay reachable no matter how long the library is. `contain` stops the scroll
   chaining out to the page behind the picker once the list hits its end. */
.vlb-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.vlb-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.vlb-provider { color: var(--accent); font-size: var(--font-xs); letter-spacing: .05em; text-transform: uppercase; }
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
.vlb-more { align-self: center; }
</style>
