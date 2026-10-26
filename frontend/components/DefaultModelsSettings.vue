<template>
  <section class="panel default-models" data-setting="default-models">
    <div class="default-models-copy">
      <span class="eyebrow">This Mac</span>
      <h4>Default models</h4>
      <p>
        The model a page uses when its own preset and its last-used choice name none. Pick one per
        kind of work; leave any unset and the page asks you to choose, as it does today.
      </p>
      <p class="default-models-rule">
        A page's own preset and its remembered last choice always win. These are only the fallback,
        and changing one here never rewrites a preset or a channel.
      </p>
    </div>

    <div v-for="family in FAMILIES" :key="family.id" class="default-model-row">
      <label :for="`default-model-${family.id}`">{{ family.label }}</label>
      <ModelMenu
        :model-value="value(family.id)"
        :options="optionsFor(family.id)"
        :media-type="family.mediaType"
        :title="`Choose a default ${family.label.toLowerCase()} model`"
        :placeholder="`No default ${family.label.toLowerCase()} model`"
        :search-placeholder="`Search ${family.label.toLowerCase()} models…`"
        :aria-label="`Default ${family.label.toLowerCase()} model options`"
        :loading="loadingFor(family.id)"
        :catalog-notice="catalogError(family.id)"
        @update:model-value="choose(family.id, $event)"
      />
      <p v-if="goneNotice(family.id)" class="default-model-gone" role="status">{{ goneNotice(family.id) }}</p>
    </div>

    <p v-if="saveError" class="result err">{{ saveError }}</p>
    <p v-else-if="saved" class="result ok">Default models saved.</p>
    <p v-if="loadError" class="result err">{{ loadError }}</p>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { DEFAULT_MODEL_FAMILIES, goneDefaultMessage, type DefaultModelFamily } from '../utils/live-genstudio-model-selection.js'
import { invalidateDefaultModels } from '../composables/useDefaultModels.js'
import { useGenStudioChatModels } from '../composables/useGenStudioChatModels.js'
import { useGenStudioImageModels } from '../composables/useGenStudioImageModels.js'
import { useGenStudioMediaModels } from '../composables/useGenStudioMediaModels.js'
import { useGenStudioTranscriptionModels } from '../composables/useGenStudioTranscription.js'

/**
 * One picker per generation family, fed by the SAME live catalogues the
 * generator pages use — so a model that is not in the catalogue cannot be
 * chosen here, and a default that leaves the catalogue says so rather than
 * sitting in the field as though it still worked.
 *
 * This is an app-level setting (AGENTS §5): it is not a preset field and never
 * becomes one.
 */
interface FamilyDef {
  id: DefaultModelFamily
  label: string
  mediaType: 'llm' | 'image' | 'tts' | 'video' | 'transcription'
}

const FAMILIES: FamilyDef[] = [
  { id: 'writing', label: 'Writing', mediaType: 'llm' },
  { id: 'image', label: 'Images', mediaType: 'image' },
  { id: 'video', label: 'Video', mediaType: 'video' },
  { id: 'audio', label: 'Voice (narration)', mediaType: 'tts' },
  { id: 'transcription', label: 'Subtitles & transcription', mediaType: 'transcription' },
  // Music has no ModelMenu media type of its own; the TTS menu's shape is the
  // closest published one (a flat list of priced rows, no tier tabs).
  { id: 'music', label: 'Music', mediaType: 'tts' },
]

const { get, put } = useApi()
const chat = useGenStudioChatModels()
const images = useGenStudioImageModels()
const media = useGenStudioMediaModels()
const transcription = useGenStudioTranscriptionModels()

const values = ref<Record<DefaultModelFamily, string>>(
  Object.fromEntries(DEFAULT_MODEL_FAMILIES.map(f => [f, ''])) as Record<DefaultModelFamily, string>,
)
const saved = ref(false)
const saveError = ref('')
const loadError = ref('')

/**
 * One row shape for every family. The catalogues publish `display_name`; this component only needs
 * the id, a name to show, and the three published flags that decide whether it can be used.
 */
type Row = { id: string; label: string; available?: boolean; generation_enabled?: boolean; coming_soon?: boolean; locked?: boolean }

const rowsFor = (family: DefaultModelFamily): Row[] => {
  switch (family) {
    case 'writing': return chat.models.value.map(row => ({ ...row, label: row.display_name }))
    case 'image': return images.models.value.map(row => ({ ...row, label: row.display_name }))
    case 'video': return media.videoModels.value.map(row => ({ ...row, label: row.display_name }))
    case 'audio': return media.voiceModels.value.map(row => ({ ...row, label: row.display_name }))
    case 'transcription': return transcription.models.value.map(row => ({ ...row, label: row.display_name }))
    // Music is loaded here rather than by a composable: no generator page shares
    // a music catalogue cache, and one extra read on a settings page is cheaper
    // than a second cache to keep fresh.
    case 'music': return musicRows.value
  }
}

const musicRows = ref<Row[]>([])

function usable(row: Row): boolean {
  return row.available !== false
    && row.generation_enabled !== false
    && row.coming_soon !== true
    && row.locked !== true
}

/** Every published row, with the unusable ones visibly disabled — never filtered away. */
function optionsFor(family: DefaultModelFamily) {
  return rowsFor(family).map(row => ({
    id: row.id,
    label: row.label,
    disabled: !usable(row),
    disabledReason: usable(row) ? '' : 'This model cannot be used right now.',
  }))
}

function loadingFor(family: DefaultModelFamily): boolean {
  switch (family) {
    case 'writing': return chat.loading.value
    case 'image': return images.loading.value
    case 'video':
    case 'audio': return media.loading.value
    case 'transcription': return transcription.loading.value
    case 'music': return musicLoading.value
  }
}

function catalogError(family: DefaultModelFamily): string {
  switch (family) {
    case 'writing': return chat.error.value || ''
    case 'image': return images.error.value || ''
    case 'video':
    case 'audio': return media.error.value || ''
    case 'transcription': return transcription.error.value || ''
    case 'music': return ''
  }
}

function value(family: DefaultModelFamily): string {
  return values.value[family] || ''
}

/** The saved default is gone from the catalogue — said plainly, and the field stays empty. */
function goneNotice(family: DefaultModelFamily): string {
  const chosen = value(family)
  if (!chosen) return ''
  const rows = rowsFor(family)
  // Nothing loaded yet says nothing about the model (AGENTS §6).
  if (!rows.length) return ''
  const row = rows.find(entry => entry.id === chosen)
  if (row && usable(row)) return ''
  return goneDefaultMessage(family, chosen)
}

function choose(family: DefaultModelFamily, modelId: string): void {
  values.value[family] = modelId
  saved.value = false
  saveError.value = ''
  void save()
}

const musicLoading = ref(false)

async function load(): Promise<void> {
  loadError.value = ''
  try {
    const response = await get<Partial<Record<DefaultModelFamily, string | null>>>('/app-settings/default-models', { cache: 'no-store' })
    for (const family of DEFAULT_MODEL_FAMILIES) {
      const entry = response?.[family]
      values.value[family] = typeof entry === 'string' ? entry : ''
    }
  } catch (error: any) {
    loadError.value = error?.data?.detail || error?.message || 'Could not load the default models.'
  }
}

async function loadMusic(): Promise<void> {
  musicLoading.value = true
  try {
    const response = await get<{ models: Row[] }>('/app-settings/genstudio/music-models', { cache: 'no-store' })
    musicRows.value = Array.isArray(response?.models) ? response.models : []
  } catch {
    // An unreadable music catalogue leaves the row empty; it never invents one.
    musicRows.value = []
  } finally {
    musicLoading.value = false
  }
}

async function save(): Promise<void> {
  saveError.value = ''
  try {
    const body = Object.fromEntries(
      DEFAULT_MODEL_FAMILIES.map(family => [family, values.value[family] || null]),
    )
    await put('/app-settings/default-models', body)
    saved.value = true
    // Every page holding the old default must see the new one on its next read.
    invalidateDefaultModels()
  } catch (error: any) {
    saveError.value = error?.data?.detail || error?.message || 'Could not save the default models.'
  }
}

onMounted(() => {
  void load()
  void chat.refresh()
  void images.refresh()
  void media.refresh()
  void transcription.load()
  void loadMusic()
})
</script>

<style scoped>
.default-models { display: grid; gap: var(--space-3, 12px); }
.default-models-copy p { margin: 4px 0 0; color: var(--text-secondary); }
.default-models-rule { font-size: var(--font-xs); }
.default-model-row { display: grid; gap: 4px; }
.default-model-row label { font-weight: 600; }
.default-model-gone { margin: 0; color: var(--warning, #d97706); font-size: var(--font-xs); line-height: 1.45; }
</style>
