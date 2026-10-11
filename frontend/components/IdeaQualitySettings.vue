<template>
  <div class="idea-quality">
    <header class="settings-card-head">
      <h3>Idea supply and repeat checks</h3>
      <p>Every switch here is off until you turn it on, for this channel only. Existing ideas are never changed. The supply count on the Ideas page is always shown.</p>
    </header>
    <p v-if="loadError" class="idea-quality-error" role="alert">{{ loadError }}</p>
    <template v-if="form">
      <fieldset :disabled="saving">
        <legend>Running-low warning</legend>
        <label class="check"><input v-model="form.supply_alerts" type="checkbox" /> Send an alert (Telegram / desktop, as set in Notifications) when this channel’s ideas run low</label>
        <label>Warn below this many unused Topic Pack subjects <input v-model.number="form.low_unused_subjects" class="input input-sm" type="number" min="0" /></label>
        <label>Warn when waiting ideas last fewer days than <input v-model.number="form.low_days_of_ideas" class="input input-sm" type="number" min="0" /></label>
      </fieldset>

      <fieldset :disabled="saving">
        <legend>Covered-topics map</legend>
        <ModelSelector v-model="form.helper_model" :project-slug="slug" label="Idea helper model (small paid calls; you choose it)" />
        <label class="check"><input v-model="form.covered_map" type="checkbox" :disabled="!form.helper_model" /> Keep a map of everything this channel has covered and show it to the idea model</label>
        <div class="row">
          <button class="btn btn-secondary btn-sm" :disabled="building || !savedHelper" @click="build(false)">{{ building ? 'Building…' : 'Build / Update Map Now' }}</button>
          <button class="btn btn-sm" :disabled="building || !savedHelper" @click="build(true)">Start Over (old map to _trash)</button>
        </div>
        <p v-if="buildResult" class="hint" role="status">{{ buildResult }}</p>
      </fieldset>

      <fieldset :disabled="saving">
        <legend>Repeat check by meaning (watch-only)</legend>
        <label>Mode
          <select v-model="form.semantic_dedupe" class="input">
            <option value="off">Off</option>
            <option value="shadow">Watch only — log what it would reject, reject nothing</option>
          </select>
        </label>
        <label>Embeddings model
          <select v-model="form.embedding_model" class="input">
            <option value="">None — use the improved word check</option>
            <option v-for="model in embeddingModels" :key="model.id" :value="model.id" :disabled="!model.available">{{ model.display_name }}{{ model.available ? '' : ' (not available now)' }}</option>
            <option v-if="form.embedding_model && !embeddingModels.some(model => model.id === form!.embedding_model)" :value="form.embedding_model">{{ form.embedding_model }} (not offered right now)</option>
          </select>
        </label>
        <p v-if="embeddingNote" class="hint">{{ embeddingNote }}</p>
        <label>Counts as a repeat at similarity <input v-model.number="form.semantic_threshold" class="input input-sm" type="number" min="0.5" max="0.999" step="0.01" /></label>
      </fieldset>

      <div class="row">
        <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save Idea Settings' }}</button>
        <span v-if="saveResult" class="hint" role="status">{{ saveResult }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useApi } from '~/composables/useApi'
import { useConfirm } from '~/composables/useConfirm'

interface Upgrades {
  helper_model: string; covered_map: boolean; semantic_dedupe: 'off' | 'shadow'; embedding_model: string
  semantic_threshold: number; supply_alerts: boolean; low_unused_subjects: number; low_days_of_ideas: number
}
const props = defineProps<{ slug: string }>()
const { get, put, post } = useApi()
const { ask } = useConfirm()
const form = ref<Upgrades | null>(null)
const savedHelper = ref('')
const embeddingModels = ref<{ id: string; display_name: string; available: boolean }[]>([])
const embeddingNote = ref('')
const loadError = ref('')
const saving = ref(false)
const saveResult = ref('')
const building = ref(false)
const buildResult = ref('')

function message(error: any, fallback: string): string {
  return error?.data?.detail || error?.message || fallback
}

async function load() {
  loadError.value = ''
  try {
    const data = await get<{ settings: Upgrades }>(`/projects/${props.slug}/ideas/upgrades`)
    form.value = { ...data.settings }
    savedHelper.value = data.settings.helper_model
  } catch (error) {
    loadError.value = message(error, 'Could not load the idea settings.')
  }
  const models = await get<{ models: typeof embeddingModels.value; detail?: string }>('/ideas/embedding-models').catch(() => null)
  embeddingModels.value = models?.models || []
  embeddingNote.value = models?.detail || (models && !models.models.length ? 'The Gateway offers no embeddings model right now; the improved word check is used.' : '')
}

async function save() {
  if (!form.value) return
  saving.value = true
  saveResult.value = ''
  try {
    const data = await put<{ settings: Upgrades; backup_dir: string | null }>(`/projects/${props.slug}/ideas/upgrades`, form.value)
    form.value = { ...data.settings }
    savedHelper.value = data.settings.helper_model
    saveResult.value = data.backup_dir ? `Saved. First switch on: ideas.json and config.json were backed up to ${data.backup_dir}.` : 'Saved.'
  } catch (error) {
    saveResult.value = message(error, 'Could not save.')
  } finally {
    saving.value = false
  }
}

async function build(fresh: boolean) {
  if (fresh && !await ask({ title: 'Start the covered-topics map over?', message: 'The current map moves to this channel’s _trash folder, and the whole history is sent to the helper model again (a small paid call).', confirmLabel: 'Start Over', danger: false })) return
  building.value = true
  buildResult.value = ''
  try {
    const data = await post<{ map: { entries: { subjects: unknown[] }; covered_idea_ids: string[] } | null; added: number; note: string | null }>(`/projects/${props.slug}/ideas/covered-topics/build`, { fresh })
    buildResult.value = data.note
      ? data.note
      : data.map ? `Map has ${data.map.entries.subjects.length} subjects from ${data.map.covered_idea_ids.length} ideas (${data.added} added now).` : 'No map yet.'
  } catch (error) {
    buildResult.value = message(error, 'Could not build the map.')
  } finally {
    building.value = false
  }
}

watch(() => props.slug, () => { void load() }, { immediate: true })
</script>

<style scoped>
fieldset { border: 0; border-top: 1px solid var(--border); padding: 12px 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
legend { font-weight: 600; padding: 0; margin-bottom: 4px; }
label { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.check input { width: 18px; height: 18px; accent-color: var(--accent); }
.input-sm { width: 110px; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.hint { color: var(--text-secondary); font-size: var(--font-sm); margin: 0; overflow-wrap: anywhere; }
.idea-quality-error { color: var(--error, #ff9696); }
.settings-card-head h3 { margin: 0 0 6px; }
.settings-card-head p { margin: 0 0 12px; color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.5; }
select.input { max-width: 100%; }
</style>
