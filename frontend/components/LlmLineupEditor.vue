<template>
  <section class="card llm-lineup-editor" aria-labelledby="llm-lineup-title">
    <div class="llm-lineup-heading">
      <div>
        <span class="section-kicker">Shared writing setup</span>
        <h2 id="llm-lineup-title">LLM lineup</h2>
        <p>
          Use one ordered set of live GenStudio language models for new writing jobs across the Pipeline.
          Per-stage policies below take precedence when enabled.
        </p>
      </div>
      <span class="llm-lineup-state" :data-state="loading ? 'loading' : loadError ? 'error' : isDirty ? 'draft' : 'saved'" role="status">
        {{ loading ? 'Loading project lineup…' : loadError ? 'Lineup unavailable' : isDirty ? 'Draft changes' : 'Saved project lineup' }}
      </span>
    </div>

    <label class="llm-lineup-toggle">
      <input v-model="draft.enabled" type="checkbox" :disabled="loading || saving" />
      <span>
        <strong>Use this lineup for new writing jobs</strong>
        <small>Applies to eligible Pipeline stages and queued writing pages after you save it.</small>
      </span>
    </label>

    <details class="llm-lineup-details" :open="draft.enabled || isDirty">
      <summary>Configure model order and reusable lineups</summary>
      <PresetPicker
        label="Reusable lineup"
        hint="Presets save only this lineup's enabled state, model order, and savings preference. They do not save stage settings or content."
        :presets="presets.presets.value"
        :active-id="presets.activeId.value"
        :active-preset-is-built-in="presets.activePresetIsBuiltIn.value"
        @update:active-id="presets.setActive"
        @apply="applyPreset"
        @overwrite="savePreset('overwrite')"
        @save-as="(name) => savePreset('save-as', name)"
        @rename="(name) => presets.rename(name).then(() => notify('Lineup renamed'))"
        @delete="presets.remove().then(() => notify('Lineup deleted'))"
      />

      <div class="llm-lineup-controls">
        <div class="llm-lineup-list-heading">
          <div>
            <h3>Model order</h3>
            <p class="text-muted text-sm">Models are read from the live LLM catalogue. Add up to {{ MAX_LLM_LINEUP_MODELS }} ordered choices; this is a selection limit, not a spending cap.</p>
          </div>
          <button type="button" class="btn btn-sm btn-secondary" :disabled="loading || saving || draft.models.length >= MAX_LLM_LINEUP_MODELS" :title="draft.models.length >= MAX_LLM_LINEUP_MODELS ? `The project lineup supports up to ${MAX_LLM_LINEUP_MODELS} selections.` : ''" @click="addModel">Add model</button>
        </div>

        <div v-if="draft.models.length" class="llm-lineup-list">
          <div v-for="(model, index) in draft.models" :key="`llm-lineup-${index}`" class="llm-lineup-row">
            <span class="llm-lineup-number" aria-hidden="true">{{ index + 1 }}</span>
            <ModelSelector
              :model-value="model"
              :project-slug="projectSlug"
              :label="`Lineup model ${index + 1}`"
              @update:model-value="setModel(index, $event)"
              @model-meta="setModelMeta(index, $event)"
            />
            <div class="llm-lineup-row-actions">
              <button type="button" class="btn btn-xs btn-ghost" :disabled="index === 0 || saving" @click="moveModel(index, -1)">Move up</button>
              <button type="button" class="btn btn-xs btn-ghost" :disabled="index === draft.models.length - 1 || saving" @click="moveModel(index, 1)">Move down</button>
              <button type="button" class="btn btn-xs btn-ghost" :disabled="saving" @click="removeModel(index)">Remove</button>
            </div>
          </div>
        </div>
      <p v-else class="llm-lineup-empty">No models selected. Add a model to enable the shared lineup.</p>

      <label class="llm-lineup-savings">
        <input v-model="draft.prefer_savings" type="checkbox" :disabled="loading || saving" />
        <span>
          <strong>Prefer free and discounted choices first</strong>
          <small>GenStudio still chooses availability and validates each request at queue time. Paid choices remain allowed.</small>
        </span>
      </label>

      <p v-if="lineupError" class="llm-lineup-error" role="alert">{{ lineupError }}</p>
      <p v-if="loadError" class="llm-lineup-error" role="alert">{{ loadError }}</p>
      <div class="llm-lineup-actions">
        <button type="button" class="btn btn-primary" :disabled="loading || saving || !!lineupError || !isDirty" @click="applyToProject">
          {{ saving ? 'Saving…' : 'Apply lineup to project' }}
        </button>
        <button v-if="isDirty" type="button" class="btn btn-secondary" :disabled="loading || saving" @click="discardDraft">Discard draft</button>
        <span class="text-muted text-xs">{{ loading ? 'Loading saved lineup…' : isDirty ? 'Not saved to this project yet.' : 'Changes are saved to this project.' }}</span>
      </div>
      </div>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useApi } from '../composables/useApi.js'
import { usePresets } from '../composables/usePresets.js'
import { cloneLlmLineup, DEFAULT_LLM_LINEUP, MAX_LLM_LINEUP_MODELS, normalizeLlmLineup, normalizeLlmModelId, sameLlmModelId, type LlmLineup } from '../utils/llm-lineup.js'
import { useProject } from '../composables/useProject.js'

const props = defineProps<{ projectSlug: string }>()
const emit = defineEmits<{ loaded: [lineup: LlmLineup]; saved: [lineup: LlmLineup] }>()
const { get, put } = useApi()
const { refreshConfig } = useProject()
const { success: notify } = useToast()
const loading = ref(true)
const saving = ref(false)
const loadError = ref('')
const saved = ref<LlmLineup>(cloneLlmLineup(DEFAULT_LLM_LINEUP))
const draft = reactive<LlmLineup>(cloneLlmLineup(DEFAULT_LLM_LINEUP))
const modelMeta = reactive<Array<{ id: string } | null>>([])
let requestRevision = 0
onBeforeUnmount(() => { requestRevision++ })
function setDraft(value: unknown): void {
  const next = normalizeLlmLineup(value)
  const knownMeta = new Map(draft.models.map((model, index) => [normalizeLlmModelId(model), modelMeta[index] || null]))
  draft.enabled = next.enabled
  draft.models = [...next.models]
  draft.prefer_savings = next.prefer_savings
  modelMeta.splice(0, modelMeta.length, ...draft.models.map(model => knownMeta.get(normalizeLlmModelId(model)) || null))
}
function snapshot(): LlmLineup {
  const next = cloneLlmLineup(draft)
  // Keep draft values in the picker-native format for the live selector. The
  // project contract stores the same chat products without its optional
  // gateway prefix, so only snapshots cross that boundary.
  next.models = next.models.map(normalizeLlmModelId)
  return next
}
const isDirty = computed(() => JSON.stringify(snapshot()) !== JSON.stringify(saved.value))
const lineupError = computed(() => {
  if (draft.models.some(model => !model.trim())) return 'Choose a live GenStudio model for every slot.'
  const savedModelIds = new Set(saved.value.models.map(normalizeLlmModelId))
  if (draft.enabled && draft.models.some((model, index) => {
    // A saved product may be temporarily depleted or retired. Keep that
    // unchanged preference editable so the operator can replace another slot;
    // only newly introduced choices require live catalogue metadata.
    return !sameLlmModelId(modelMeta[index]?.id, model) && !savedModelIds.has(normalizeLlmModelId(model))
  })) return 'Wait for each selected model’s live catalogue details before saving.'
  if (new Set(draft.models.map(normalizeLlmModelId)).size !== draft.models.length) return 'Choose each model once so order remains meaningful.'
  if (draft.enabled && !draft.models.length) return 'Add at least one model before enabling the shared lineup.'
  return ''
})

function setModel(index: number, value: string): void {
  draft.models[index] = value.trim()
  modelMeta[index] = null
}
function setModelMeta(index: number, value: { id: string } | null): void { modelMeta[index] = value }
function addModel(): void {
  if (draft.models.length >= MAX_LLM_LINEUP_MODELS) return
  draft.models.push('')
  modelMeta.push(null)
}
function removeModel(index: number): void {
  draft.models.splice(index, 1)
  modelMeta.splice(index, 1)
}
function moveModel(index: number, direction: -1 | 1): void {
  const target = index + direction
  if (target < 0 || target >= draft.models.length) return
  const [model] = draft.models.splice(index, 1)
  draft.models.splice(target, 0, model)
  const [meta] = modelMeta.splice(index, 1)
  modelMeta.splice(target, 0, meta || null)
}

const presets = usePresets<LlmLineup>({
  slug: props.projectSlug,
  configKey: 'llm_lineup',
  presetType: 'llm-lineup',
  autoApplyOnLoad: false,
  snapshot,
  apply: setDraft,
})

async function load(): Promise<void> {
  const targetSlug = props.projectSlug
  const revision = ++requestRevision
  loading.value = true
  loadError.value = ''
  try {
    const config = await get<any>(`/projects/${targetSlug}/settings/config`)
    if (revision !== requestRevision || targetSlug !== props.projectSlug) return
    const next = normalizeLlmLineup(config?.llm_lineup)
    saved.value = cloneLlmLineup(next)
    setDraft(next)
    emit('loaded', cloneLlmLineup(next))
    await presets.load()
    if (revision !== requestRevision || targetSlug !== props.projectSlug) return
  } catch (error: any) {
    if (revision !== requestRevision || targetSlug !== props.projectSlug) return
    loadError.value = error?.data?.detail || error?.message || 'Could not load the project LLM lineup.'
  } finally {
    if (revision === requestRevision && targetSlug === props.projectSlug) loading.value = false
  }
}

function applyPreset(): void {
  if (presets.applyActive()) notify('Lineup loaded into draft')
}
async function savePreset(kind: 'overwrite' | 'save-as', name?: string): Promise<void> {
  try {
    if (kind === 'overwrite') await presets.overwrite()
    else if (name) await presets.saveAs(name)
    notify('Lineup preset saved')
  } catch (error: any) {
    loadError.value = error?.message || 'Could not save the lineup preset.'
  }
}
function discardDraft(): void { setDraft(saved.value) }
async function applyToProject(): Promise<void> {
  if (lineupError.value || !isDirty.value) return
  saving.value = true
  loadError.value = ''
  const next = snapshot()
  const targetSlug = props.projectSlug
  const revision = ++requestRevision
  try {
    await put(`/projects/${targetSlug}/settings/config`, { llm_lineup: next })
    await refreshConfig(targetSlug)
    if (revision !== requestRevision || targetSlug !== props.projectSlug) return
    const verified = normalizeLlmLineup((await get<any>(`/projects/${targetSlug}/settings/config`, { cache: 'no-store' }))?.llm_lineup)
    if (revision !== requestRevision || targetSlug !== props.projectSlug) return
    if (JSON.stringify(verified) !== JSON.stringify(next)) throw new Error('The saved lineup did not match the project settings. Try again.')
    saved.value = cloneLlmLineup(verified)
    setDraft(verified)
    emit('saved', cloneLlmLineup(verified))
    notify('LLM lineup applied to this project')
  } catch (error: any) {
    if (revision !== requestRevision || targetSlug !== props.projectSlug) return
    loadError.value = error?.data?.detail || error?.message || 'Could not save the project LLM lineup.'
  } finally {
    if (revision === requestRevision && targetSlug === props.projectSlug) saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.llm-lineup-editor { display: grid; gap: 16px; }
.llm-lineup-heading, .llm-lineup-list-heading, .llm-lineup-actions { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.llm-lineup-heading h2, .llm-lineup-list-heading h3 { margin: 2px 0 4px; }
.llm-lineup-heading p, .llm-lineup-list-heading p { margin: 0; max-width: 72ch; line-height: 1.5; }
.llm-lineup-state { padding: 4px 9px; border: 1px solid var(--border); border-radius: 999px; color: var(--text-secondary); font-size: var(--font-xs); white-space: nowrap; }
.llm-lineup-state[data-state='draft'] { border-color: var(--warning); color: var(--warning); }
.llm-lineup-state[data-state='error'] { border-color: var(--error); color: var(--error); }
.llm-lineup-toggle, .llm-lineup-savings { display: flex; align-items: flex-start; gap: 9px; color: var(--text-primary); }
.llm-lineup-toggle small, .llm-lineup-savings small { display: block; margin-top: 3px; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.4; }
.llm-lineup-controls { display: grid; gap: 12px; }
.llm-lineup-list { display: grid; gap: 10px; }
.llm-lineup-row { display: grid; grid-template-columns: 28px minmax(220px, 1fr) auto; align-items: start; gap: 9px; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-secondary); }
.llm-lineup-number { padding-top: 9px; color: var(--text-muted); font-size: var(--font-sm); text-align: center; }
.llm-lineup-row-actions { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.llm-lineup-empty { margin: 0; padding: 12px; border: 1px dashed var(--border); color: var(--text-muted); }
.llm-lineup-error { margin: 0; color: var(--error); line-height: 1.4; }
.llm-lineup-actions { align-items: center; justify-content: flex-start; }
@media (max-width: 720px) { .llm-lineup-row { grid-template-columns: 24px minmax(0, 1fr); } .llm-lineup-row-actions { grid-column: 2; justify-content: flex-start; } }
</style>
