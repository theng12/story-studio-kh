<template>
  <div class="scene-analysis-settings">
    <header class="settings-card-head">
      <h3>Scene analysis models</h3>
      <p>
        Used by every channel that switches scene analysis on (Effects Library). Each scene picture is analysed once on your
        own Macs through the Gateway, as a small 640 px copy, and the result is saved with the episode. Free: these models run
        only on your fleet. Changing a model re-analyses recent episodes in the background; the saved results are used until then.
      </p>
    </header>
    <p v-if="note" class="hint" role="status">{{ note }}</p>
    <fieldset :disabled="saving">
      <label>Depth model (3D photo, rack focus)
        <select v-model="form.depth" class="input">
          <option value="">None — depth moves use their plain version</option>
          <option v-for="model in depthModels" :key="model.id" :value="model.id" :disabled="!model.available">{{ model.display_name }}{{ model.available ? '' : ' (not available now)' }}</option>
          <option v-if="form.depth && !depthModels.some(model => model.id === form.depth)" :value="form.depth">{{ form.depth }} (not offered right now)</option>
        </select>
      </label>
      <label>Vision model (main subject, places of interest, outlines of sky, water, flames)
        <select v-model="form.vision" class="input">
          <option value="">None — zoom to subject uses depth only; nothing follows the picture</option>
          <option v-for="model in visionModels" :key="model.id" :value="model.id" :disabled="!model.available">{{ model.display_name }}{{ model.available ? '' : ' (not available now)' }}</option>
          <option v-if="form.vision && !visionModels.some(model => model.id === form.vision)" :value="form.vision">{{ form.vision }} (not offered right now)</option>
        </select>
      </label>
    </fieldset>
    <div class="row">
      <button class="btn btn-primary btn-sm" :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save Scene Analysis Models' }}</button>
      <span v-if="saveResult" class="hint" role="status">{{ saveResult }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useApi } from '~/composables/useApi'

interface VisionModel { id: string; display_name: string; available: boolean; tasks: string[]; default: boolean }
const { get, put } = useApi()
const form = reactive({ depth: '', vision: '' })
const depthModels = ref<VisionModel[]>([])
const visionModels = ref<VisionModel[]>([])
const note = ref('')
const saving = ref(false)
const saveResult = ref('')

async function load() {
  try {
    const data = await get<{ picked: { depth: string; vision: string }; depth: VisionModel[]; vision: VisionModel[]; detail?: string }>('/scene-analysis/models')
    Object.assign(form, data.picked)
    depthModels.value = data.depth || []
    visionModels.value = data.vision || []
    note.value = data.detail || (!depthModels.value.length && !visionModels.value.length ? 'The Gateway offers no scene-analysis model right now.' : '')
  } catch (error: any) {
    note.value = error?.data?.detail || 'Could not load the scene-analysis models.'
  }
}

async function save() {
  saving.value = true
  saveResult.value = ''
  try {
    const data = await put<{ picked: { depth: string; vision: string }; requeued: number }>('/scene-analysis/models', { ...form })
    Object.assign(form, data.picked)
    saveResult.value = data.requeued ? `Saved. ${data.requeued} recent episode(s) will be re-analysed in the background.` : 'Saved.'
  } catch (error: any) {
    saveResult.value = error?.data?.detail || 'Could not save.'
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.scene-analysis-settings { display: flex; flex-direction: column; gap: 10px; }
fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
</style>
