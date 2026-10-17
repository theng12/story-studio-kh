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
        <legend>Repeat check by meaning</legend>
        <label>Mode
          <select v-model="form.semantic_dedupe" class="input">
            <option value="off">Off</option>
            <option value="shadow">Watch only — log what it would reject, reject nothing</option>
            <option value="on">On — reject new ideas that repeat an earlier one by meaning</option>
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
        <p class="hint">The model you choose must be able to tell this channel’s ideas apart — including in the language you write them in. Watch-only mode rejects nothing, so it only reports scores. When the meaning check cannot be used, the run log says so and the improved word check is used instead.</p>
        <label>Counts as a repeat at similarity <input v-model.number="form.semantic_threshold" class="input input-sm" type="number" min="0.5" max="0.999" step="0.01" /></label>
      </fieldset>

      <fieldset :disabled="saving">
        <legend>More variety per batch</legend>
        <label class="check"><input v-model="form.variety_seeds" type="checkbox" /> Give every idea its own starting point (era, region, theme, kind of story) and, on Topic Pack channels, take subjects from every pack in turn instead of one pack at a time</label>
        <p class="hint">Best left off for prayer, music and lullaby channels, where eras and regions do not fit.</p>
      </fieldset>

      <fieldset :disabled="saving">
        <legend>Self-growing Topic Packs</legend>
        <label class="check"><input v-model="form.grow_packs" type="checkbox" :disabled="!form.helper_model" /> When fewer than {{ form.low_unused_subjects }} Topic Pack subjects are unused, add up to 40 new ones (once a day at most) with the idea helper model</label>
        <p class="hint">New subjects go into this channel’s own “Grown subjects” pack; your Topic Packs are never changed. Review or remove them on the Ideas page. Only for channels that use Topic Packs.</p>
      </fieldset>

      <fieldset :disabled="saving">
        <legend>Real sources (Wikipedia)</legend>
        <label class="check"><input v-model="form.real_sources" type="checkbox" /> Take new subjects from real Wikipedia articles in these categories (free, read-only)</label>
        <label class="stack">Wikipedia categories, one per line
          <textarea v-model="categoriesText" class="input" rows="5" placeholder="Category:Spices" />
        </label>
        <div class="row">
          <button class="btn btn-secondary btn-sm" :disabled="suggesting || !savedHelper" @click="suggest">{{ suggesting ? 'Asking…' : 'Suggest Categories' }}</button>
          <button class="btn btn-sm" :disabled="refreshing || !savedCategories" @click="refreshPool">{{ refreshing ? 'Fetching…' : 'Fetch Articles Now' }}</button>
        </div>
        <p v-if="referenceResult" class="hint" role="status">{{ referenceResult }}</p>
        <p class="hint">Nothing is fetched until the list is saved. Topic Pack channels use the articles when growing subjects; other channels show a few unused ones to the idea model in each batch.</p>
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
  helper_model: string; covered_map: boolean; semantic_dedupe: 'off' | 'shadow' | 'on'; embedding_model: string
  semantic_threshold: number; supply_alerts: boolean; low_unused_subjects: number; low_days_of_ideas: number
  variety_seeds: boolean; grow_packs: boolean; real_sources: boolean; reference_categories: string[]
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
const categoriesText = ref('')
const savedCategories = ref(0)
const suggesting = ref(false)
const refreshing = ref(false)
const referenceResult = ref('')

function useSettings(settings: Upgrades) {
  form.value = { ...settings }
  savedHelper.value = settings.helper_model
  categoriesText.value = settings.reference_categories.join('\n')
  savedCategories.value = settings.reference_categories.length
}

function message(error: any, fallback: string): string {
  return error?.data?.detail || error?.message || fallback
}

async function load() {
  loadError.value = ''
  try {
    const data = await get<{ settings: Upgrades }>(`/projects/${props.slug}/ideas/upgrades`)
    useSettings(data.settings)
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
    const reference_categories = categoriesText.value.split('\n').map(line => line.trim()).filter(Boolean)
    const data = await put<{ settings: Upgrades; backup_dir: string | null }>(`/projects/${props.slug}/ideas/upgrades`, { ...form.value, reference_categories })
    useSettings(data.settings)
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

async function suggest() {
  suggesting.value = true
  referenceResult.value = ''
  try {
    const data = await post<{ categories: string[] }>(`/projects/${props.slug}/ideas/reference-categories/suggest`, {})
    const have = categoriesText.value.split('\n').map(line => line.trim()).filter(Boolean)
    categoriesText.value = [...new Set([...have, ...data.categories])].join('\n')
    referenceResult.value = `Added ${data.categories.length} suggestions to the list. Check them, then Save Idea Settings.`
  } catch (error) {
    referenceResult.value = message(error, 'Could not suggest categories.')
  } finally {
    suggesting.value = false
  }
}

async function refreshPool() {
  refreshing.value = true
  referenceResult.value = ''
  try {
    const data = await post<{ note: string }>(`/projects/${props.slug}/ideas/reference-pool/refresh`, {})
    referenceResult.value = data.note
  } catch (error) {
    referenceResult.value = message(error, 'Could not fetch the articles.')
  } finally {
    refreshing.value = false
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
.stack { flex-direction: column; align-items: stretch; }
textarea.input { width: 100%; max-width: 520px; font-family: inherit; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.hint { color: var(--text-secondary); font-size: var(--font-sm); margin: 0; overflow-wrap: anywhere; }
.idea-quality-error { color: var(--error, #ff9696); }
.settings-card-head h3 { margin: 0 0 6px; }
.settings-card-head p { margin: 0 0 12px; color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.5; }
select.input { max-width: 100%; }
</style>
