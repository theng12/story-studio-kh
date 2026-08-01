<template>
  <div class="voice-picker" @click.stop>
    <button
      type="button"
      class="vp-trigger"
      :class="{ open: expanded }"
      aria-haspopup="dialog"
      :aria-expanded="expanded"
      @click="toggle"
    >
      <span class="vp-current">{{ currentVoiceName || defaultLabel }}</span>
      <span v-if="currentVoiceProviderLabel" class="vp-provider-badge">{{ currentVoiceProviderLabel }}</span>
      <span v-if="currentVoiceSaved" class="vp-star-badge" aria-label="Saved voice">★</span>
      <span class="vp-chev" aria-hidden="true">▾</span>
    </button>

    <PickerDialog
      :visible="expanded"
      :title="scopeTitle"
      :description="scopeDescription"
      :tone="scopeFamily === 'cloud' ? 'accent' : 'success'"
      :count="voiceCountLabel"
      close-label="Close voice picker"
      size="xl"
      @close="close"
    >
      <template v-if="isGenStudioScope" #actions>
        <button
          type="button"
          class="btn btn-sm btn-secondary"
          @click="libraryOpen = !libraryOpen"
        >{{ libraryOpen ? 'Close libraries' : 'Browse libraries' }}</button>
      </template>

      <div v-if="isGenStudioScope && libraryOpen" class="vp-add-panel">
        <VoiceLibraryBrowser @added="onLibraryVoiceAdded" />
      </div>

      <div class="vp-toolbar">
        <input ref="searchEl" v-model="search" type="search" class="input input-sm vp-search" :placeholder="searchPlaceholder" :aria-label="searchPlaceholder" @keydown="onListKeydown" />
        <label v-if="isGenStudioScope" class="vp-saved-toggle" title="Show only the voices saved in your GenStudio account">
          <input type="checkbox" v-model="savedOnly" />
          <span>Saved only</span>
        </label>
        <button
          type="button"
          class="btn btn-sm btn-secondary"
          :disabled="voiceListLoading"
          @click="refreshVoices"
        >{{ voiceListLoading ? 'Loading…' : 'Refresh' }}</button>
      </div>

      <!-- Stated here as well as in a toast: the dialog sits above the toast
           stack, so a save failure has to be readable without closing it. -->
      <div v-if="saveError" class="vp-warning" role="alert">{{ saveError }}</div>

      <div ref="listEl" class="vp-list" @keydown="onListKeydown">
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

        <template v-if="isGenStudioScope">
          <div v-if="scopeToModel && !ttsModelId" class="vp-empty">
            <strong>Choose a voice model first.</strong>
            <span>Voices are listed for the model that serves them.</span>
          </div>
          <div v-else-if="voicesError" class="vp-warning">
            {{ voicesError }}
            <a href="#" @click.prevent="goToGenStudioSettings">Check GenStudio settings</a>
          </div>
          <div v-else-if="voicesLoading && !visibleVoices.length" class="vp-empty">Loading voices from GenStudio KH…</div>

          <section v-if="savedVoiceRows.length" class="vp-section">
            <h4>Saved in your GenStudio account</h4>
            <VoicePickerRow
              v-for="voice in savedVoiceRows"
              :key="`saved-${voice.id}`"
              v-bind="rowProps(voice)"
              @select="select(voice.id)"
              @favourite="toggleSaved(voice)"
              @preview="$emit('preview', voice.id)"
            />
          </section>

          <section v-if="!savedOnly && otherVoiceRows.length" class="vp-section">
            <h4>{{ scopeToModel ? `${ttsModelName || 'Model'} voices` : 'All voices on your account' }}</h4>
            <VoicePickerRow
              v-for="voice in otherVoiceRows"
              :key="voice.id"
              v-bind="rowProps(voice)"
              @select="select(voice.id)"
              @favourite="toggleSaved(voice)"
              @preview="$emit('preview', voice.id)"
            />
          </section>

          <div v-if="voicesReady && !voicesLoading && !voicesError && !visibleVoices.length" class="vp-empty">
            <strong>{{ savedOnly ? 'No saved voices for this model.' : 'GenStudio KH returned no voices for this model.' }}</strong>
            <span>{{ savedOnly ? 'Clear “Saved only”, or save a voice with the ★ control.' : 'Browse the provider libraries to add one, or refresh the catalog.' }}</span>
          </div>
        </template>

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
      </div>
    </PickerDialog>
  </div>
</template>

<script setup lang="ts">
/**
 * Voice picker.
 *
 * For GenStudio the flow is model-first: the caller passes the selected TTS
 * model, and this list shows the voices GenStudio says that model serves. Every
 * attribute rendered — language, provider/engine name, description, the voice's
 * own rate, preview availability and its notice, saved state — is published by
 * GenStudio. Nothing is inferred from an id and nothing is cached past a model
 * change. Provider identity is DISPLAY only; this component never sends one.
 *
 * Saved state belongs to GenStudio (`is_saved` + the save endpoints). There is
 * deliberately no local favourites list for GenStudio voices — a second copy
 * would drift from the account it claims to describe.
 */
import type { GenStudioVoice } from '~/composables/useGenStudioVoices'
import { voiceIsGenerable } from '~/composables/useGenStudioVoices'
import { formatCredits } from '~/utils/genstudio-credit-cost'

interface VoiceStudioVoice {
  id: string
  name: string
  language?: string
  gender?: string
  duration_seconds?: number
  available_on?: string[]
  available_everywhere?: boolean
  endpoint_count?: number
  voice_kind?: 'voicestudio-pooled' | 'studiohub-shared'
}

const props = withDefaults(defineProps<{
  modelValue: string | null
  projectSlug: string
  defaultLabel?: string
  /** '' or 'genstudio' for the GenStudio catalogue; a local engine id otherwise. */
  audioModelProvider?: string
  /** Local (Voice Studio / macOS) engine id. Not used for GenStudio. */
  audioModelId?: string
  /** The selected GenStudio TTS model. Voices are listed for this model only. */
  ttsModelId?: string
  ttsModelName?: string
  /**
   * Restrict the list to the voices the selected model serves. False lists
   * every voice on the account with the model that serves it named on each
   * row — for choosing a voice that is not being generated with right now.
   */
  scopeToModel?: boolean
  /** The model's own published rate, so a voice only shows its own when it differs. */
  modelCreditsPer1000Characters?: number | null
  requireSelection?: boolean
}>(), {
  defaultLabel: 'Default (let model pick)',
  audioModelProvider: '',
  audioModelId: '',
  ttsModelId: '',
  ttsModelName: '',
  scopeToModel: true,
  modelCreditsPer1000Characters: null,
  requireSelection: false,
})

const emit = defineEmits<{
  'update:modelValue': [voiceId: string | null]
  preview: [voiceId: string]
  'catalog-updated': [voices: GenStudioVoice[]]
}>()

const { get } = useApi()
const { error: showError, info } = useToast()
const router = useRouter()
const {
  voices,
  voicesLoading,
  voicesError,
  loadVoices,
  clearVoices,
  setSaved,
} = useGenStudioVoices()

type Scope = 'genstudio' | 'voicestudio-voicepack' | 'voicestudio-cloning' | 'macos-builtin'

const VOICEPACK_MODEL_IDS = new Set(['voicestudio-kokoro', 'voicestudio-qwen3-tts', 'voicestudio-bark'])

const scope = computed<Scope>(() => {
  if (props.audioModelProvider === 'voicestudio') {
    return VOICEPACK_MODEL_IDS.has(props.audioModelId) ? 'voicestudio-voicepack' : 'voicestudio-cloning'
  }
  if (props.audioModelProvider === 'macos') return 'macos-builtin'
  return 'genstudio'
})
const scopeFamily = computed<'cloud' | 'local'>(() => scope.value === 'genstudio' ? 'cloud' : 'local')
const isGenStudioScope = computed(() => scope.value === 'genstudio')
const isMacosScope = computed(() => scope.value === 'macos-builtin')

const expanded = ref(false)
const searchEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const search = ref('')
const savedOnly = ref(false)
const libraryOpen = ref(false)
const savingVoiceId = ref('')
const saveError = ref('')
const localVoices = ref<VoiceStudioVoice[]>([])
const localLoading = ref(false)
const localError = ref('')
const voiceStudioBaseUrl = ref('')
const voicesAttempted = ref(false)
/** No `model_id` filter: every voice on the account, each naming its model. */
const ALL_VOICES = ''
const voicesReady = computed(() => !props.scopeToModel || !!props.ttsModelId)
const voiceListLoading = computed(() => localLoading.value || voicesLoading.value)
const searchPlaceholder = computed(() => isGenStudioScope.value ? 'Search voices…' : 'Search local voices…')

const matchingVoices = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return voices.value
  return voices.value.filter(voice => [
    voice.display_name, voice.language, voice.description, voice.engine_name, voice.provider,
  ].filter(Boolean).join(' ').toLowerCase().includes(q))
})
const visibleVoices = computed(() => savedOnly.value
  ? matchingVoices.value.filter(voice => voice.is_saved === true)
  : matchingVoices.value)
const savedVoiceRows = computed(() => visibleVoices.value.filter(voice => voice.is_saved === true))
const otherVoiceRows = computed(() => visibleVoices.value.filter(voice => voice.is_saved !== true))

/**
 * Provider identity exactly as GenStudio published it. `engine_name` is the
 * more specific fact when both are present; neither is ever reconstructed.
 */
function voiceProviderText(voice: GenStudioVoice): string {
  const parts = [voice.provider, voice.engine_name].filter(Boolean) as string[]
  const unique = [...new Set(parts)]
  return unique.join(' · ')
}

/** Only worth showing when the voice is priced differently from its model. */
function voiceRateText(voice: GenStudioVoice): string {
  const rate = voice.credits_per_1000_characters
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return ''
  if (props.modelCreditsPer1000Characters === rate) return ''
  return `${formatCredits(rate)} / 1,000 characters`
}

function unavailableReason(voice: GenStudioVoice): string {
  if (voice.generation_enabled === false) return 'GenStudio has generation turned off for this voice.'
  if (voice.catalog_status === 'qualification') return 'GenStudio lists this voice as qualification-only.'
  if (voice.catalog_status === 'retired') return 'GenStudio has retired this voice.'
  return ''
}

function rowProps(voice: GenStudioVoice) {
  const generable = voiceIsGenerable(voice)
  return {
    name: voice.display_name,
    selected: props.modelValue === voice.id,
    favourite: voice.is_saved === true,
    providerLabel: voiceProviderText(voice),
    language: voice.language || '',
    description: voice.description || '',
    rateText: voiceRateText(voice),
    modelName: props.scopeToModel ? '' : (voice.tts_model_name || ''),
    previewAvailable: voice.preview_available === true,
    previewNotice: voice.preview_notice || null,
    disabled: !generable,
    disabledReason: unavailableReason(voice),
    saving: savingVoiceId.value === voice.id,
  }
}

const currentGenStudioVoice = computed(() => voices.value.find(voice => voice.id === props.modelValue) || null)
const currentLocalVoice = computed(() => {
  if (!props.modelValue) return null
  if (props.modelValue.startsWith('hubvoice:')) {
    const id = props.modelValue.slice('hubvoice:'.length)
    return localVoices.value.find(voice => voice.id === id && voice.voice_kind === 'studiohub-shared') || null
  }
  if (props.modelValue.startsWith('vsname:')) {
    const name = props.modelValue.slice('vsname:'.length)
    return localVoices.value.find(voice => voice.name === name) || null
  }
  return localVoices.value.find(voice => voice.id === props.modelValue) || null
})
const currentVoiceName = computed(() =>
  currentGenStudioVoice.value?.display_name || currentLocalVoice.value?.name || (props.modelValue || ''))
const currentVoiceProviderLabel = computed(() =>
  currentGenStudioVoice.value ? voiceProviderText(currentGenStudioVoice.value) : '')
const currentVoiceSaved = computed(() => currentGenStudioVoice.value?.is_saved === true)
const scopeTitle = computed(() => isGenStudioScope.value
  ? props.ttsModelName ? `${props.ttsModelName} voices` : 'GenStudio KH voices'
  : localSectionTitle.value)
const scopeDescription = computed(() => isGenStudioScope.value
  ? 'Read live from your GenStudio KH account for the selected voice model.'
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
const voiceCountLabel = computed(() => {
  const count = isGenStudioScope.value ? visibleVoices.value.length : filteredLocalVoices.value.length
  return count === 1 ? '1 voice' : `${count} voices`
})

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

/** Re-read the whole voice list whenever the model selection changes. */
async function loadGenStudioVoices() {
  if (!isGenStudioScope.value || (props.scopeToModel && !props.ttsModelId)) {
    voicesAttempted.value = false
    clearVoices()
    emit('catalog-updated', [])
    return
  }
  voicesAttempted.value = true
  await loadVoices(props.scopeToModel ? props.ttsModelId : ALL_VOICES)
  emit('catalog-updated', voices.value)
  reconcileSelection()
}

function refreshVoices() {
  if (scopeFamily.value === 'local') void loadLocalVoices()
  else void loadGenStudioVoices()
}

async function toggleSaved(voice: GenStudioVoice) {
  if (savingVoiceId.value) return
  savingVoiceId.value = voice.id
  saveError.value = ''
  try {
    await setSaved(voice.id, voice.is_saved !== true)
    emit('catalog-updated', voices.value)
  } catch (error: any) {
    const detail = error?.data?.detail || error?.message || 'GenStudio could not update the saved state of this voice'
    saveError.value = detail
    showError(detail)
  } finally {
    savingVoiceId.value = ''
  }
}

async function onLibraryVoiceAdded(voiceId: string) {
  await loadGenStudioVoices()
  if (voices.value.some(voice => voice.id === voiceId)) select(voiceId)
}

function encodedLocalVoice(voice: VoiceStudioVoice) {
  if (voice.voice_kind === 'studiohub-shared') return `hubvoice:${voice.id}`
  return voice.voice_kind === 'voicestudio-pooled' ? `vsname:${voice.name}` : voice.id
}
function isSelectedLocal(voice: VoiceStudioVoice) {
  return props.modelValue === encodedLocalVoice(voice)
}
function select(voiceId: string | null) {
  emit('update:modelValue', voiceId)
  close()
}
function selectLocal(voice: VoiceStudioVoice) {
  select(encodedLocalVoice(voice))
}

/**
 * A voice that the newly selected model does not serve cannot be submitted, so
 * it is cleared rather than left as a selection that would fail at generation.
 */
function reconcileSelection() {
  if (!props.modelValue) return
  if (isGenStudioScope.value) {
    if (!voicesReady.value || !voicesAttempted.value || voicesLoading.value || voicesError.value) return
    if (voices.value.some(voice => voice.id === props.modelValue)) return
    emit('update:modelValue', null)
    info(props.scopeToModel
      ? 'Voice cleared: the selected voice model does not serve it.'
      : 'Voice cleared: it is no longer in your GenStudio catalogue.')
    return
  }
  if (localLoading.value || localError.value || !localVoices.value.length) return
  if (!currentLocalVoice.value) {
    emit('update:modelValue', null)
    info('Voice cleared because it is not available for the selected local model.')
  }
}

async function toggle() {
  if (expanded.value) {
    close()
    return
  }
  saveError.value = ''
  expanded.value = true
  if (scopeFamily.value === 'local' && !localVoices.value.length) void loadLocalVoices()
  if (isGenStudioScope.value) void loadGenStudioVoices()
  // Two ticks: the shared focus trap claims the dialog's first control on the
  // first tick, so the search field takes focus on the one after.
  await nextTick()
  await nextTick()
  searchEl.value?.focus({ preventScroll: true })
  listEl.value?.querySelector('.vp-row.selected, .vp-default-row.selected')?.scrollIntoView({ block: 'center' })
}
/** Modal restores focus to the trigger, so closing never strands the keyboard. */
function close() {
  expanded.value = false
}

/**
 * Arrow keys walk the selectable rows and Enter picks one — Enter needs no
 * handler because each row's name is a real <button>. Arrow Up off the top
 * hands the keyboard back to the search field.
 */
function selectableButtons(): HTMLButtonElement[] {
  const nodes = listEl.value?.querySelectorAll<HTMLButtonElement>(
    '.vp-default-row, .vp-select:not(:disabled)')
  return nodes ? Array.from(nodes) : []
}
function moveActive(delta: number) {
  const buttons = selectableButtons()
  if (!buttons.length) return
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if (current < 0) {
    buttons[delta > 0 ? 0 : buttons.length - 1]?.focus()
    return
  }
  const next = current + delta
  if (next < 0) {
    searchEl.value?.focus({ preventScroll: true })
    return
  }
  buttons[Math.min(next, buttons.length - 1)]?.focus()
}
function onListKeydown(event: KeyboardEvent) {
  // Home/End belong to the caret while the user is typing a query.
  const typing = event.target === searchEl.value
  if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1) }
  else if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1) }
  else if (event.key === 'Home' && !typing) { event.preventDefault(); selectableButtons()[0]?.focus() }
  else if (event.key === 'End' && !typing) { event.preventDefault(); selectableButtons().at(-1)?.focus() }
}
function openVoiceStudioWeb() {
  if (!voiceStudioBaseUrl.value) {
    showError('Voice Studio URL is not set. Check Settings → This Mac → Local Models.')
    return
  }
  window.open(voiceStudioBaseUrl.value, '_blank', 'noopener,noreferrer')
}
function goToLocalModelsSettings() {
  close()
  void router.push(`/projects/${props.projectSlug}/settings#local-tts`)
}
function goToGenStudioSettings() {
  close()
  void router.push(`/projects/${props.projectSlug}/settings#genstudio-settings`)
}

// Escape, backdrop dismissal and focus restoration all come from Modal via
// PickerDialog, so this component owns no global key or click listeners.
onMounted(() => {
  void loadLocalVoices()
  void loadGenStudioVoices()
})
// The first rule: a model change invalidates the voice list, so re-read it.
watch(() => [props.audioModelId, props.audioModelProvider, props.ttsModelId], () => {
  libraryOpen.value = false
  search.value = ''
  void loadLocalVoices()
  void loadGenStudioVoices()
})
</script>

<style scoped>
.voice-picker { position: relative; width: 100%; }
.vp-trigger { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px; padding: 7px 10px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-sm); color: inherit; cursor: pointer; text-align: left; font: inherit; }
.vp-trigger:hover, .vp-trigger.open { border-color: var(--accent); }
.vp-current { display: -webkit-box; flex: 1; min-width: 0; overflow: hidden; line-height: 1.25; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.vp-provider-badge { padding: 2px 7px; border-radius: 999px; background: var(--accent-dim); color: var(--accent); font-size: var(--font-xs); }
.vp-star-badge { color: var(--accent); }
.vp-chev { color: var(--text-muted); transition: transform .15s; }
.vp-trigger.open .vp-chev { transform: rotate(180deg); }
/* min-height:0 so this flex child can shrink inside the dialog's fixed
   max-height; without it the library browser overflows behind the dialog's
   overflow:hidden and the tail of the list becomes unreachable. */
.vp-add-panel { margin: 10px 12px 8px; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); display: flex; flex-direction: column; min-height: 0; }
.vp-add-panel p { margin: 0 0 8px; color: var(--text-muted); font-size: var(--font-xs); }
.vp-add-row { display: grid; grid-template-columns: minmax(120px,.7fr) minmax(180px,1.3fr) auto; gap: 6px; }
.vp-add-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.vp-toolbar { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; padding: 12px 12px 9px; }
.vp-saved-toggle { display: flex; align-items: center; gap: 5px; color: var(--text-muted); font-size: 12px; white-space: nowrap; }
.vp-search { flex: 1; }
/* The only scroller in the dialog — the header and toolbar stay put while a
   long voice catalogue moves under them. min-height:0 lets it shrink inside
   the flex column instead of pushing the dialog past its max-height. */
.vp-list { min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 0 10px 12px; scrollbar-width: thin; }
.vp-section { margin-top: 8px; }
.vp-section h4 { margin: 0; padding: 5px 7px; color: var(--text-muted); font-size: var(--font-xs); text-transform: uppercase; letter-spacing: .05em; }
.vp-section-heading { display: flex; align-items: center; justify-content: space-between; }
.vp-section-heading a { color: var(--accent); font-size: var(--font-xs); }
.vp-default-row { width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 8px; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: inherit; cursor: pointer; text-align: left; }
.vp-default-row span { color: var(--text-muted); font-size: var(--font-xs); }
.vp-default-row:hover, .vp-default-row.selected { border-color: var(--accent); background: var(--accent-dim); }
.vp-default-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.vp-row { display: flex; align-items: center; gap: 5px; padding: 5px; border: 1px solid transparent; border-radius: var(--radius-sm); }
.vp-row:hover, .vp-row.selected { background: var(--bg-tertiary); border-color: var(--border); }
.vp-row.selected { border-color: var(--accent); background: var(--accent-dim); }
.vp-star { border: 0; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 15px; }
.vp-star.favourite, .vp-star:hover { color: var(--accent); }
.vp-select { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; border: 0; background: transparent; color: inherit; cursor: pointer; text-align: left; }
.vp-select strong { font-size: 13px; }
.vp-select span { color: var(--text-muted); font-size: var(--font-xs); }
.vp-preview { padding: 3px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; color: var(--accent); cursor: pointer; }
.vp-warning { flex: 0 0 auto; margin: 0 12px 8px; padding: 8px; border: 1px solid rgba(245,158,11,.4); border-radius: var(--radius-sm); color: rgb(245,158,11); font-size: var(--font-xs); }
.vp-warning a { color: inherit; text-decoration: underline; }
.vp-empty { display: flex; flex-direction: column; gap: 4px; padding: 24px 12px; color: var(--text-muted); font-size: 12px; text-align: center; }
@media (max-width: 720px) { .vp-add-row { grid-template-columns: 1fr; } .vp-provider-badge { display: none; } }
</style>
