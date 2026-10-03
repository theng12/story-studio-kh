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
      <span class="vp-chev ds-chevron" data-dir="down" aria-hidden="true" />
    </button>

    <PickerDialog
      :visible="expanded"
      :title="scopeTitle"
      :description="scopeDescription"
      tone="accent"
      :count="voiceCountLabel"
      close-label="Close voice picker"
      size="xl"
      @close="close"
    >
      <template v-if="compatibleLibrary" #actions>
        <button
          type="button"
          class="btn btn-sm btn-secondary"
          @click="libraryOpen = !libraryOpen"
        >{{ libraryOpen ? 'Close library' : `Browse ${compatibleLibrary.label} library` }}</button>
      </template>

      <div v-if="libraryOpen && compatibleLibrary" class="vp-add-panel">
        <VoiceLibraryBrowser :key="compatibleLibrary.id" :library="compatibleLibrary" @added="onLibraryVoiceAdded" />
      </div>

      <template v-else>
        <p v-if="cloneHint" class="vp-clone-hint">{{ cloneHint }}</p>

        <div class="vp-toolbar">
        <input ref="searchEl" v-model="search" type="search" class="input input-sm vp-search" :placeholder="searchPlaceholder" :aria-label="searchPlaceholder" @keydown="onListKeydown" />
        <div class="vp-filter" role="group" aria-label="Filter voices">
          <button
            v-for="option in VOICE_FILTERS"
            :key="option.id"
            type="button"
            class="vp-filter-btn"
            :class="{ active: voiceFilter === option.id }"
            :aria-pressed="voiceFilter === option.id"
            :title="option.hint"
            @click="voiceFilter = option.id"
          >{{ option.label }}</button>
        </div>
        <button
          type="button"
          class="btn btn-sm btn-secondary"
          :disabled="voicesLoading"
          @click="loadGenStudioVoices"
        >{{ voicesLoading ? 'Loading…' : 'Refresh' }}</button>
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

          <div v-if="scopeToModel && !ttsModelId" class="vp-empty">
            <strong>Choose a voice model first.</strong>
            <span>Voices are listed for the model that serves them.</span>
          </div>
          <div v-else-if="voicesError" class="vp-warning">
            {{ voicesError }}
            <a href="#" @click.prevent="goToGenStudioSettings">Check Gateway settings</a>
          </div>
          <div v-else-if="voicesLoading && !visibleVoices.length" class="vp-empty">Loading voices from the Gateway…</div>

          <section v-if="savedVoiceRows.length" class="vp-section">
            <h4>Saved in your Gateway account</h4>
            <VoicePickerRow
              v-for="voice in savedVoiceRows"
              :key="`saved-${voice.id}`"
              v-bind="rowProps(voice)"
              @select="select(voice.id)"
              @favourite="toggleSaved(voice)"
              @preview="$emit('preview', voice.id)"
            />
          </section>

          <section v-if="voiceFilter !== 'saved' && otherVoiceRows.length" class="vp-section">
            <h4>{{ otherVoicesHeading }}</h4>
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
            <strong>{{ emptyStateTitle }}</strong>
            <span>{{ emptyStateHint }}</span>
          </div>
        </div>
      </template>
    </PickerDialog>
  </div>
</template>

<script setup lang="ts">
/**
 * Voice picker.
 *
 * For GenStudio the flow is model-first: the caller passes the selected TTS
 * model, and this list shows the voices GenStudio says that model serves. Every
 * attribute rendered — language, provider/engine name, description, preview
 * availability and its notice, saved state — is published by GenStudio.
 * Nothing is inferred from an id and nothing is cached past a model change.
 * Provider identity is DISPLAY only; this component never sends one.
 *
 * Saved state belongs to GenStudio (`is_saved` + the save endpoints). There is
 * deliberately no local favourites list for GenStudio voices — a second copy
 * would drift from the account it claims to describe.
 */
import type { GenStudioVoice } from '~/composables/useGenStudioVoices'
import { voiceIsGenerable } from '~/composables/useGenStudioVoices'
import { unverifiedSelectionLabel } from '~/utils/picker-trigger-label'

const props = withDefaults(defineProps<{
  modelValue: string | null
  projectSlug: string
  defaultLabel?: string
  /** The selected GenStudio TTS model. Voices are listed for this model only. */
  ttsModelId?: string
  ttsModelName?: string
  ttsModelProviderId?: string
  ttsModelDescription?: string
  ttsModelSupportsVoiceCloning?: boolean
  /**
   * Restrict the list to the voices the selected model serves. False lists
   * every voice on the account with the model that serves it named on each
   * row — for choosing a voice that is not being generated with right now.
   */
  scopeToModel?: boolean
  requireSelection?: boolean
}>(), {
  defaultLabel: 'Default (let model pick)',
  ttsModelId: '',
  ttsModelName: '',
  ttsModelProviderId: '',
  ttsModelDescription: '',
  ttsModelSupportsVoiceCloning: false,
  scopeToModel: true,
  requireSelection: false,
})

const emit = defineEmits<{
  'update:modelValue': [voiceId: string | null]
  preview: [voiceId: string]
  'catalog-updated': [voices: GenStudioVoice[]]
}>()

const { error: showError, info } = useToast()
const router = useRouter()
const {
  voices,
  voicesLoading,
  voicesError,
  loadVoices,
  clearVoices,
  setSaved,
  libraries,
  loadLibraries,
} = useGenStudioVoices()

const expanded = ref(false)
const searchEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const search = ref('')
/**
 * Two different mechanisms, deliberately:
 *
 * `saved` filters on `is_saved`, a field GenStudio publishes per voice — the
 * rows already in hand carry the answer, so no refetch is needed.
 *
 * `cloned` is one of GenStudio's own collections (`all` | `explore` | `my` |
 * `cloned`) and is re-requested from the server, because which voices are
 * clones is GenStudio's to decide. Story Studio must not work it out from
 * `custom_voice_id` or a name — the same rule that governs every other
 * published fact.
 *
 * `explore` and `my` are deliberately NOT surfaced: GenStudio has not told us
 * what they mean, and inventing a label for someone else's vocabulary is how
 * you end up with a control that lies. They can be added the moment their
 * semantics are published.
 */
const VOICE_FILTERS = [
  { id: 'all' as const, label: 'All', hint: 'Every voice Gateway serves for this model' },
  { id: 'saved' as const, label: 'Saved', hint: 'Voices you saved to your Gateway account with ★' },
  { id: 'cloned' as const, label: 'Cloned', hint: 'Voices you cloned in the Gateway' },
]
type VoiceFilter = (typeof VOICE_FILTERS)[number]['id']
const voiceFilter = ref<VoiceFilter>('all')
const libraryOpen = ref(false)
const savingVoiceId = ref('')
const saveError = ref('')
const voicesAttempted = ref(false)
/**
 * Voice names this browser has seen, persisted across launches. Hydrated with no
 * network call so the first paint after a cold start already has a name for the
 * saved voice, and topped up from every successful catalogue read below.
 */
const rememberedVoiceNames = useRememberedVoiceNames()
rememberedVoiceNames.hydrate()
/** No `model_id` filter: every voice on the account, each naming its model. */
const ALL_VOICES = ''
const voicesReady = computed(() => !props.scopeToModel || !!props.ttsModelId)
const searchPlaceholder = 'Search voices…'
const compatibleLibrary = computed(() => libraries.value.find(
  library => library.provider_id === props.ttsModelProviderId,
) || null)
const cloneHint = computed(() => {
  if (!props.ttsModelSupportsVoiceCloning || !props.ttsModelName) return ''
  return `Clone a voice in the Gateway; once its compatible copy is ready, it appears here for ${props.ttsModelName}.`
})

const matchingVoices = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return voices.value
  return voices.value.filter(voice => [
    voice.display_name, voice.language, voice.description, voice.engine_name, voice.provider,
  ].filter(Boolean).join(' ').toLowerCase().includes(q))
})
// `cloned` needs no local filter — the server already returned only clones.
const visibleVoices = computed(() => voiceFilter.value === 'saved'
  ? matchingVoices.value.filter(voice => voice.is_saved === true)
  : matchingVoices.value)

const otherVoicesHeading = computed(() => {
  if (voiceFilter.value === 'cloned') return 'Your cloned voices'
  if (props.scopeToModel) return `${props.ttsModelName || 'Model'} voices`
  return 'All voices on your account'
})

const emptyStateTitle = computed(() => {
  if (voiceFilter.value === 'saved') return 'No saved voices for this model.'
  if (voiceFilter.value === 'cloned') return 'No cloned voices for this model.'
  return 'The Gateway returned no voices for this model.'
})

const emptyStateHint = computed(() => {
  if (voiceFilter.value === 'saved') return 'Switch to All, or save a voice with the ★ control.'
  // An empty clone list is the normal answer for someone who has not cloned
  // anything — say where cloning happens rather than letting it read as a
  // failure to load. Story Studio deliberately does not clone voices.
  if (voiceFilter.value === 'cloned') return 'Voices are cloned in the Gateway; once its compatible copy is ready, it appears here for the selected model.'
  if (compatibleLibrary.value) return `Browse the ${compatibleLibrary.value.label} library to add one, or refresh the catalog.`
  return cloneHint.value || 'Refresh the catalog after Gateway makes compatible voices available.'
})
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

function unavailableReason(voice: GenStudioVoice): string {
  if (voice.generation_enabled === false) return 'The Gateway has generation turned off for this voice.'
  if (voice.catalog_status === 'qualification') return 'The Gateway lists this voice as qualification-only.'
  if (voice.catalog_status === 'retired') return 'The Gateway has retired this voice.'
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
    modelName: props.scopeToModel ? '' : (voice.tts_model_name || ''),
    previewAvailable: voice.preview_available === true,
    previewNotice: voice.preview_notice || null,
    disabled: !generable,
    disabledReason: unavailableReason(voice),
    saving: savingVoiceId.value === voice.id,
  }
}

const currentGenStudioVoice = computed(() => voices.value.find(voice => voice.id === props.modelValue) || null)
/**
 * The name on the closed trigger.
 *
 * The last term used to be `props.modelValue`, which is a raw GenStudio voice id
 * (or a `vsname:` transport prefix left by a retired local voice). Whenever the voice
 * catalogue failed to load — GenStudio unreachable,
 * an expired key — the picker fell straight through to it and showed the
 * customer an internal handle in the place where the name of their voice goes.
 * Unlike the model picker, this one had no fallback machinery at all.
 *
 * It has the same one now: names this browser has seen are remembered across
 * launches, and where the app cannot confirm the voice is still served it says
 * so in the label rather than pretending, or worse, showing the id. Nothing here
 * touches what may be SUBMITTED — an unconfirmed voice is still checked by the
 * server at generation time exactly as before.
 */
const currentVoiceName = computed(() => {
  const live = currentGenStudioVoice.value?.display_name
  if (live) return live
  // `reconcileSelection` already clears a selection the loaded list does not
  // serve, so a value still sitting here against a non-empty list is the
  // picker's own business, not a failure.
  return unverifiedSelectionLabel({
    savedId: props.modelValue || '',
    catalogueSize: voices.value.length,
    loading: voicesLoading.value,
    rememberedName: rememberedVoiceNames.knownName(props.modelValue),
    unknownNoun: 'Saved voice',
  })
})
const currentVoiceProviderLabel = computed(() =>
  currentGenStudioVoice.value ? voiceProviderText(currentGenStudioVoice.value) : '')
const currentVoiceSaved = computed(() => currentGenStudioVoice.value?.is_saved === true)
const scopeTitle = computed(() => props.ttsModelName ? `${props.ttsModelName} voices` : 'Gateway voices')
const scopeDescription = computed(() =>
  props.ttsModelDescription || 'Read live from your Gateway account for the selected voice model.')
const voiceCountLabel = computed(() => {
  const count = visibleVoices.value.length
  return count === 1 ? '1 voice' : `${count} voices`
})

/** Re-read the whole voice list whenever the model selection changes. */
async function loadGenStudioVoices() {
  if (props.scopeToModel && !props.ttsModelId) {
    voicesAttempted.value = false
    clearVoices()
    emit('catalog-updated', [])
    return
  }
  voicesAttempted.value = true
  // Only `cloned` narrows the request; `all` and `saved` both work from the
  // full list, so switching between those two costs no round trip.
  await loadVoices(
    props.scopeToModel ? props.ttsModelId : ALL_VOICES,
    '',
    voiceFilter.value === 'cloned' ? 'cloned' : '',
  )
  // Every successful read is a chance to learn a name — including the selected
  // voice's, which is what this picker falls back on the next time the read
  // fails.
  rememberedVoiceNames.remember(voices.value.map(voice => ({ id: voice.id, name: voice.display_name })))
  emit('catalog-updated', voices.value)
  reconcileSelection()
}

/**
 * Crossing into or out of `cloned` changes what the server should return, so it
 * refetches. `all` <-> `saved` does not: both read the same rows. The selected
 * voice is left alone — reconcileSelection only clears a voice the model no
 * longer serves, and a filter is a view, not a change of what is available.
 */
watch(voiceFilter, (next, previous) => {
  if ((next === 'cloned') === (previous === 'cloned')) return
  void loadGenStudioVoices()
})

async function toggleSaved(voice: GenStudioVoice) {
  if (savingVoiceId.value) return
  savingVoiceId.value = voice.id
  saveError.value = ''
  try {
    await setSaved(voice.id, voice.is_saved !== true)
    emit('catalog-updated', voices.value)
  } catch (error: any) {
    const detail = error?.data?.detail || error?.message || 'The Gateway could not update the saved state of this voice'
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

function select(voiceId: string | null) {
  emit('update:modelValue', voiceId)
  close()
}

/**
 * A voice that the newly selected model does not serve cannot be submitted, so
 * it is cleared rather than left as a selection that would fail at generation.
 */
function reconcileSelection() {
  if (!props.modelValue) return
  if (!voicesReady.value || !voicesAttempted.value || voicesLoading.value || voicesError.value) return
  if (voices.value.some(voice => voice.id === props.modelValue)) return
  emit('update:modelValue', null)
  info(props.scopeToModel
    ? 'Voice cleared: the selected voice model does not serve it.'
    : 'Voice cleared: it is no longer in your Gateway catalogue.')
}

async function toggle() {
  if (expanded.value) {
    close()
    return
  }
  saveError.value = ''
  expanded.value = true
  void loadGenStudioVoices()
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
function goToGenStudioSettings() {
  close()
  void router.push(`/projects/${props.projectSlug}/settings#connections`)
}

// Escape, backdrop dismissal and focus restoration all come from Modal via
// PickerDialog, so this component owns no global key or click listeners.
onMounted(() => {
  void loadLibraries()
  void loadGenStudioVoices()
})
// The first rule: a model change invalidates the voice list, so re-read it.
watch(() => props.ttsModelId, () => {
  libraryOpen.value = false
  search.value = ''
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
.vp-add-panel { flex: 1; margin: 10px 12px 8px; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); display: flex; flex-direction: column; min-height: 0; }
.vp-add-panel p { margin: 0 0 8px; color: var(--text-muted); font-size: var(--font-xs); }
.vp-clone-hint { flex: 0 0 auto; margin: 8px 12px 0; padding: 8px 10px; border-left: 2px solid var(--accent); background: var(--accent-dim); color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.4; }
.vp-add-row { display: grid; grid-template-columns: minmax(120px,.7fr) minmax(180px,1.3fr) auto; gap: 6px; }
.vp-add-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.vp-toolbar { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; padding: 12px 12px 9px; }
.vp-filter { display: flex; gap: 4px; flex-shrink: 0; }
.vp-filter-btn { padding: 5px 10px; border: 1px solid var(--border); border-radius: 999px; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 12px; white-space: nowrap; }
.vp-filter-btn:hover { color: var(--text-primary); border-color: var(--accent); }
.vp-filter-btn.active { border-color: var(--accent); background: var(--accent-dim); color: var(--accent); }
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
