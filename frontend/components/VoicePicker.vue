<template>
  <div ref="rootEl" class="voice-picker" @click.stop>
    <button type="button" class="vp-trigger" :class="{ open: expanded }" @click="toggle">
      <span class="vp-current">{{ currentVoiceName || defaultLabel }}</span>
      <span v-if="currentVoiceProviderLabel" class="vp-provider-badge">{{ currentVoiceProviderLabel }}</span>
      <span v-if="modelValue && isFavourite(modelValue)" class="vp-star-badge" aria-label="Favourite">★</span>
      <span class="vp-chev" aria-hidden="true">▾</span>
    </button>

    <div v-if="expanded" class="vp-panel">
      <div class="vp-scope" :class="scopeFamily">
        <div>
          <strong>{{ scopeTitle }}</strong>
          <span>{{ scopeDescription }}</span>
        </div>
        <button
          v-if="scopeFamily === 'cloud'"
          type="button"
          class="btn btn-sm btn-secondary"
          @click="addOpen = !addOpen"
        >+ Add voice</button>
      </div>

      <div v-if="scopeFamily === 'cloud' && addOpen" class="vp-add-panel">
        <p>
          Add a voice or clone ID for <strong>{{ activeProviderLabel }}</strong>.
          You can add more provider labels later in Settings → Voices.
        </p>
        <div class="vp-add-row">
          <input v-model.trim="addName" class="input input-sm" maxlength="80" placeholder="Voice name" @keydown.enter.prevent="saveNewVoice" />
          <input v-model.trim="addVoiceId" class="input input-sm vp-add-id" placeholder="Voice or reference ID" spellcheck="false" @keydown.enter.prevent="saveNewVoice" />
          <button type="button" class="btn btn-sm btn-primary" :disabled="addSaving || !addName || !addVoiceId" @click="saveNewVoice">
            {{ addSaving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>

      <div class="vp-toolbar">
        <input v-model="search" type="search" class="input input-sm vp-search" placeholder="Search saved voices…" autofocus />
        <button
          v-if="scopeFamily === 'local'"
          type="button"
          class="btn btn-sm btn-secondary"
          :disabled="localLoading"
          @click="loadLocalVoices"
        >{{ localLoading ? 'Loading…' : 'Refresh' }}</button>
      </div>

      <div class="vp-list">
        <button
          v-if="!requireSelection"
          type="button"
          class="vp-default-row"
          :class="{ selected: modelValue === null }"
          @click="select(null)"
        >
          <strong>{{ defaultLabel }}</strong>
          <span>Use the model's default voice</span>
        </button>

        <section v-if="favouriteCloudVoices.length" class="vp-section">
          <h4>Favourites</h4>
          <VoicePickerRow
            v-for="voice in favouriteCloudVoices"
            :key="`favourite-${voice.voice_id}`"
            :name="voice.name"
            :selected="modelValue === voice.voice_id"
            :favourite="true"
            :provider-label="activeProviderLabel"
            @select="select(voice.voice_id)"
            @favourite="toggleFavourite(voice.voice_id)"
            @preview="$emit('preview', voice.voice_id)"
          />
        </section>

        <section v-if="scopeFamily === 'cloud' && regularCloudVoices.length" class="vp-section">
          <h4>{{ activeProviderLabel }} voices</h4>
          <VoicePickerRow
            v-for="voice in regularCloudVoices"
            :key="voice.voice_id"
            :name="voice.name"
            :selected="modelValue === voice.voice_id"
            :favourite="false"
            :provider-label="activeProviderLabel"
            @select="select(voice.voice_id)"
            @favourite="toggleFavourite(voice.voice_id)"
            @preview="$emit('preview', voice.voice_id)"
          />
        </section>

        <section v-if="scopeFamily === 'local'" class="vp-section vp-section-local">
          <div class="vp-section-heading">
            <h4>{{ localSectionTitle }}</h4>
            <a v-if="!isMacosScope" href="#" @click.prevent="openVoiceStudioWeb">Open Voice Studio ↗</a>
          </div>
          <div v-if="localError" class="vp-warning">
            {{ localError }}
            <a href="#" @click.prevent="goToLocalModelsSettings">Check local model settings</a>
          </div>
          <div v-else-if="localLoading" class="vp-empty">Loading voices…</div>
          <div v-else-if="!filteredLocalVoices.length" class="vp-empty">No compatible local voices were reported.</div>
          <div
            v-for="voice in filteredLocalVoices"
            :key="voice.id"
            class="vp-row"
            :class="{ selected: isSelectedLocal(voice) }"
          >
            <button type="button" class="vp-star" :class="{ favourite: isFavourite(encodedLocalVoice(voice)) }" @click="toggleFavourite(encodedLocalVoice(voice))">
              {{ isFavourite(encodedLocalVoice(voice)) ? '★' : '☆' }}
            </button>
            <button type="button" class="vp-select" @click="selectLocal(voice)">
              <strong>{{ voice.name }}</strong>
              <span>
                {{ isMacosScope ? 'macOS' : scope === 'voicestudio-voicepack' ? 'built-in' : 'local clone' }}
                <template v-if="voice.endpoint_count"> · {{ voice.available_everywhere ? `all ${voice.endpoint_count} machines` : `${voice.available_on?.length || 0}/${voice.endpoint_count} machines` }}</template>
              </span>
            </button>
            <button type="button" class="vp-preview" title="Preview voice" @click="$emit('preview', encodedLocalVoice(voice))">▶</button>
          </div>
        </section>

        <div v-if="showCloudEmpty" class="vp-empty">
          <strong>No voices labelled for {{ activeProviderLabel }}.</strong>
          <span>Add one here or update provider labels in Settings → Voices.</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  normalizeSavedVoices,
  voiceProviderLabel,
  voiceSupportsProvider,
  type SavedVoice,
  type VoiceProviderId,
} from '~/utils/voice-providers'

interface VoiceStudioVoice {
  id: string
  name: string
  language?: string
  gender?: string
  duration_seconds?: number
  available_on?: string[]
  available_everywhere?: boolean
  endpoint_count?: number
  voice_kind?: 'voicestudio-pooled'
}

const props = withDefaults(defineProps<{
  modelValue: string | null
  projectSlug: string
  customVoices?: unknown[]
  customVoicesLoaded?: boolean
  defaultLabel?: string
  audioModelProvider?: string
  audioModelId?: string
  requireSelection?: boolean
}>(), {
  customVoices: () => [],
  customVoicesLoaded: false,
  defaultLabel: 'Default (let model pick)',
  audioModelProvider: '',
  audioModelId: '',
  requireSelection: false,
})

const emit = defineEmits<{
  'update:modelValue': [voiceId: string | null]
  preview: [voiceId: string]
  'voice-saved': [voice: SavedVoice]
}>()

const { get, put } = useApi()
const { success, error: showError, info } = useToast()
const router = useRouter()

const CLOUD_PROVIDERS = new Set(['elevenlabs', 'fal', 'genaipro', 'kie', 'fishaudio'])
const VOICEPACK_MODEL_IDS = new Set(['voicestudio-kokoro', 'voicestudio-qwen3-tts', 'voicestudio-bark'])
type Scope = 'cloud' | 'voicestudio-voicepack' | 'voicestudio-cloning' | 'macos-builtin' | 'all'

const scope = computed<Scope>(() => {
  if (CLOUD_PROVIDERS.has(props.audioModelProvider)) return 'cloud'
  if (props.audioModelProvider === 'voicestudio') {
    return VOICEPACK_MODEL_IDS.has(props.audioModelId) ? 'voicestudio-voicepack' : 'voicestudio-cloning'
  }
  if (props.audioModelProvider === 'macos') return 'macos-builtin'
  return 'all'
})
const scopeFamily = computed<'cloud' | 'local'>(() => scope.value === 'cloud' || scope.value === 'all' ? 'cloud' : 'local')
const isMacosScope = computed(() => scope.value === 'macos-builtin')
const activeProvider = computed<VoiceProviderId | null>(() =>
  CLOUD_PROVIDERS.has(props.audioModelProvider) ? props.audioModelProvider as VoiceProviderId : null)
const activeProviderLabel = computed(() => activeProvider.value ? voiceProviderLabel(activeProvider.value) : 'saved cloud')
const savedVoices = computed(() => normalizeSavedVoices(props.customVoices))
const compatibleCloudVoices = computed(() => {
  const voices = activeProvider.value
    ? savedVoices.value.filter(voice => voiceSupportsProvider(voice, activeProvider.value!))
    : savedVoices.value
  const q = search.value.trim().toLowerCase()
  return q ? voices.filter(voice => `${voice.name} ${voice.voice_id}`.toLowerCase().includes(q)) : voices
})
const favouriteCloudVoices = computed(() => compatibleCloudVoices.value.filter(voice => favouriteIds.value.includes(voice.voice_id)))
const regularCloudVoices = computed(() => compatibleCloudVoices.value.filter(voice => !favouriteIds.value.includes(voice.voice_id)))

const expanded = ref(false)
const rootEl = ref<HTMLElement | null>(null)
const search = ref('')
const favouriteIds = ref<string[]>([])
const addOpen = ref(false)
const addName = ref('')
const addVoiceId = ref('')
const addSaving = ref(false)
const localVoices = ref<VoiceStudioVoice[]>([])
const localLoading = ref(false)
const localError = ref('')
const voiceStudioBaseUrl = ref('')

const currentSavedVoice = computed(() => savedVoices.value.find(voice => voice.voice_id === props.modelValue) || null)
const currentLocalVoice = computed(() => {
  if (!props.modelValue) return null
  if (props.modelValue.startsWith('vsname:')) {
    const name = props.modelValue.slice('vsname:'.length)
    return localVoices.value.find(voice => voice.name === name) || null
  }
  return localVoices.value.find(voice => voice.id === props.modelValue) || null
})
const currentVoiceName = computed(() => currentSavedVoice.value?.name || currentLocalVoice.value?.name || (props.modelValue ? props.modelValue : ''))
const currentVoiceProviderLabel = computed(() => currentSavedVoice.value && activeProvider.value ? activeProviderLabel.value : '')
const scopeTitle = computed(() => scopeFamily.value === 'cloud' ? `${activeProviderLabel.value} voice library` : localSectionTitle.value)
const scopeDescription = computed(() => scopeFamily.value === 'cloud'
  ? 'Only voices labelled as compatible with this provider are shown.'
  : 'This list comes from the selected local voice engine.')
const localSectionTitle = computed(() => {
  if (isMacosScope.value) return 'macOS built-in voices'
  if (scope.value === 'voicestudio-voicepack') return 'Built-in model voices'
  return 'Voice Studio cloned voices'
})
const filteredLocalVoices = computed(() => {
  const q = search.value.trim().toLowerCase()
  return q ? localVoices.value.filter(voice => `${voice.name} ${voice.language || ''}`.toLowerCase().includes(q)) : localVoices.value
})
const showCloudEmpty = computed(() => scopeFamily.value === 'cloud' && !compatibleCloudVoices.value.length)

function hasValidSlug() {
  return !!props.projectSlug && props.projectSlug !== 'undefined'
}

async function loadFavourites() {
  if (!hasValidSlug()) return
  try {
    const data = await get<{ voice_ids: string[] }>(`/projects/${props.projectSlug}/voices/favourites`)
    favouriteIds.value = Array.isArray(data.voice_ids) ? data.voice_ids : []
  } catch { /* Favourites are optional; the voice list still works. */ }
}

async function toggleFavourite(voiceId: string) {
  const next = favouriteIds.value.filter(id => id !== voiceId)
  if (next.length === favouriteIds.value.length) next.unshift(voiceId)
  favouriteIds.value = next
  try {
    await put(`/projects/${props.projectSlug}/voices/favourites`, { voice_ids: next })
  } catch (error: any) {
    showError(error?.data?.detail || 'Could not save voice favourites')
  }
}

async function loadLocalVoices() {
  if (scopeFamily.value !== 'local') {
    localVoices.value = []
    localError.value = ''
    return
  }
  localLoading.value = true
  localError.value = ''
  try {
    if (isMacosScope.value) {
      const data = await get<{ voices: VoiceStudioVoice[]; available?: boolean }>('/macos/voices')
      localVoices.value = Array.isArray(data.voices) ? data.voices : []
      if (data.available === false) localError.value = 'macOS voices are not available on this machine.'
    } else {
      const query = props.audioModelId ? `?model=${encodeURIComponent(props.audioModelId)}` : ''
      const data = await get<{ voices: VoiceStudioVoice[]; baseUrl?: string }>(`/voicestudio/voices${query}`)
      localVoices.value = Array.isArray(data.voices) ? data.voices : []
      voiceStudioBaseUrl.value = data.baseUrl || ''
    }
  } catch (error: any) {
    localVoices.value = []
    localError.value = error?.data?.detail || error?.message || 'The local voice service is unavailable.'
  } finally {
    localLoading.value = false
    reconcileSelection()
  }
}

async function saveNewVoice() {
  if (!activeProvider.value || addSaving.value) return
  const name = addName.value.trim()
  const voiceId = addVoiceId.value.trim()
  if (!name || !voiceId) return
  const existing = savedVoices.value.find(voice => voice.voice_id === voiceId)
  const next = savedVoices.value.map(voice => ({ ...voice, providers: [...voice.providers] }))
  if (existing) {
    const target = next.find(voice => voice.voice_id === voiceId)!
    if (target.providers.includes(activeProvider.value)) {
      showError('That voice is already saved for this provider.')
      return
    }
    target.providers.push(activeProvider.value)
  } else {
    next.push({ name, voice_id: voiceId, providers: [activeProvider.value] })
  }
  addSaving.value = true
  try {
    await put(`/projects/${props.projectSlug}/settings/config`, { voice_presets: next })
    const saved = { name: existing?.name || name, voice_id: voiceId, providers: existing ? [...existing.providers, activeProvider.value] : [activeProvider.value] } as SavedVoice
    emit('voice-saved', saved)
    emit('update:modelValue', voiceId)
    addName.value = ''
    addVoiceId.value = ''
    addOpen.value = false
    expanded.value = false
    success(`Saved “${saved.name}” for ${activeProviderLabel.value}.`)
  } catch (error: any) {
    showError(error?.data?.detail || error?.message || 'Could not save the voice')
  } finally {
    addSaving.value = false
  }
}

function encodedLocalVoice(voice: VoiceStudioVoice) {
  return voice.voice_kind === 'voicestudio-pooled' ? `vsname:${voice.name}` : voice.id
}
function isSelectedLocal(voice: VoiceStudioVoice) {
  return props.modelValue === encodedLocalVoice(voice)
}
function select(voiceId: string | null) {
  emit('update:modelValue', voiceId)
  expanded.value = false
}
function selectLocal(voice: VoiceStudioVoice) {
  select(encodedLocalVoice(voice))
}
function isFavourite(voiceId: string) {
  return favouriteIds.value.includes(voiceId)
}

function reconcileSelection() {
  if (!props.modelValue) return
  if (scopeFamily.value === 'cloud') {
    if (!props.customVoicesLoaded || !activeProvider.value) return
    const compatible = savedVoices.value.some(voice =>
      voice.voice_id === props.modelValue && voiceSupportsProvider(voice, activeProvider.value!))
    if (!compatible) {
      emit('update:modelValue', null)
      info(`Voice cleared because it is not labelled for ${activeProviderLabel.value}.`)
    }
    return
  }
  if (localLoading.value || localError.value || !localVoices.value.length) return
  if (!currentLocalVoice.value) {
    emit('update:modelValue', null)
    info('Voice cleared because it is not available for the selected local model.')
  }
}

function toggle() {
  expanded.value = !expanded.value
  if (!expanded.value) return
  void loadFavourites()
  if (scopeFamily.value === 'local' && !localVoices.value.length) void loadLocalVoices()
}
function openVoiceStudioWeb() {
  if (!voiceStudioBaseUrl.value) {
    showError('Voice Studio URL is not set. Check Settings → This Mac → Local Models.')
    return
  }
  window.open(voiceStudioBaseUrl.value, '_blank', 'noopener,noreferrer')
}
function goToLocalModelsSettings() {
  expanded.value = false
  void router.push(`/projects/${props.projectSlug}/settings#local-tts`)
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') expanded.value = false
}
function onClickOutside(event: MouseEvent) {
  if (expanded.value && !rootEl.value?.contains(event.target as Node)) expanded.value = false
}

onMounted(() => {
  void loadFavourites()
  void loadLocalVoices()
  window.addEventListener('keydown', onKey)
  document.addEventListener('click', onClickOutside)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('click', onClickOutside)
})
watch(() => [props.audioModelId, props.audioModelProvider], () => {
  addOpen.value = false
  search.value = ''
  void loadLocalVoices()
  reconcileSelection()
})
watch(() => [props.customVoices, props.customVoicesLoaded], reconcileSelection, { deep: true })
</script>

<style scoped>
.voice-picker { position: relative; width: 100%; }
.vp-trigger { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-sm); color: inherit; cursor: pointer; text-align: left; font: inherit; }
.vp-trigger:hover, .vp-trigger.open { border-color: var(--accent); }
.vp-current { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vp-provider-badge { padding: 2px 7px; border-radius: 999px; background: var(--accent-dim); color: var(--accent); font-size: 10px; }
.vp-star-badge { color: var(--accent); }
.vp-chev { color: var(--text-muted); transition: transform .15s; }
.vp-trigger.open .vp-chev { transform: rotate(180deg); }
.vp-panel { position: relative; z-index: 20; margin-top: 6px; max-height: 500px; display: flex; flex-direction: column; overflow: hidden; background: var(--bg-primary); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: 0 16px 45px rgba(0,0,0,.28); }
.vp-scope { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.vp-scope div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.vp-scope strong { font-size: 12px; }
.vp-scope span { font-size: 11px; color: var(--text-muted); }
.vp-scope.cloud { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.vp-scope.local { border-color: color-mix(in srgb, var(--success) 45%, var(--border)); }
.vp-add-panel { margin: 0 10px 8px; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.vp-add-panel p { margin: 0 0 8px; color: var(--text-muted); font-size: 11px; }
.vp-add-row { display: grid; grid-template-columns: minmax(120px,.7fr) minmax(180px,1.3fr) auto; gap: 6px; }
.vp-add-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.vp-toolbar { display: flex; gap: 8px; padding: 0 10px 8px; }
.vp-search { flex: 1; }
.vp-list { flex: 1; overflow-y: auto; padding: 0 8px 10px; }
.vp-section { margin-top: 8px; }
.vp-section h4 { margin: 0; padding: 5px 7px; color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
.vp-section-heading { display: flex; align-items: center; justify-content: space-between; }
.vp-section-heading a { color: var(--accent); font-size: 10px; }
.vp-default-row { width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 8px; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: inherit; cursor: pointer; text-align: left; }
.vp-default-row span { color: var(--text-muted); font-size: 11px; }
.vp-default-row:hover, .vp-default-row.selected { border-color: var(--accent); background: var(--accent-dim); }
.vp-row { display: flex; align-items: center; gap: 5px; padding: 5px; border: 1px solid transparent; border-radius: var(--radius-sm); }
.vp-row:hover, .vp-row.selected { background: var(--bg-tertiary); border-color: var(--border); }
.vp-row.selected { border-color: var(--accent); background: var(--accent-dim); }
.vp-star { border: 0; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 15px; }
.vp-star.favourite, .vp-star:hover { color: var(--accent); }
.vp-select { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; border: 0; background: transparent; color: inherit; cursor: pointer; text-align: left; }
.vp-select strong { font-size: 13px; }
.vp-select span { color: var(--text-muted); font-size: 10px; }
.vp-preview { padding: 3px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; color: var(--accent); cursor: pointer; }
.vp-warning { margin: 4px 6px 8px; padding: 8px; border: 1px solid rgba(245,158,11,.4); border-radius: var(--radius-sm); color: rgb(245,158,11); font-size: 11px; }
.vp-warning a { color: inherit; text-decoration: underline; }
.vp-empty { display: flex; flex-direction: column; gap: 4px; padding: 24px 12px; color: var(--text-muted); font-size: 12px; text-align: center; }
@media (max-width: 720px) { .vp-add-row { grid-template-columns: 1fr; } .vp-provider-badge { display: none; } }
</style>
