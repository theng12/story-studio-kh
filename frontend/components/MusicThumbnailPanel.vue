<template>
  <section v-if="state?.music" class="card workspace-section music-thumb" aria-labelledby="music-thumb-title">
    <div class="music-thumb-head">
      <div>
        <span class="settings-section-kicker">Music episode</span>
        <h3 id="music-thumb-title">Thumbnail from a scene</h3>
      </div>
      <span class="text-muted text-xs">{{ ready.length }} of {{ state.scenes.length }} scene pictures ready</span>
    </div>
    <p class="text-muted text-sm">
      Two ways: use one of the episode's scene pictures as it is (scene pictures carry no text), or let the image model
      below draw a thumbnail from a scene and the episode theme — it draws the headline “{{ state.headline }}” itself.
    </p>

    <div v-if="state.scenes.length" class="music-thumb-grid">
      <div
        v-for="scene in state.scenes"
        :key="scene.id"
        class="music-thumb-cell"
        :class="{ picked: picked === scene.id }"
      >
        <button type="button" class="music-thumb-pick" :disabled="!scene.has_image" :aria-pressed="picked === scene.id" @click="picked = scene.id">
          <img v-if="scene.has_image" :src="imageUrl(scene.id)" :alt="`Scene ${scene.scene_index}`" loading="lazy">
          <span v-else class="music-thumb-empty">No picture yet</span>
          <span class="music-thumb-label">Scene {{ scene.scene_index }}</span>
        </button>
      </div>
    </div>
    <p v-else class="text-muted text-sm">
      This episode has no scenes yet. <NuxtLink :to="`/projects/${projectSlug}/episode-builder?episode_id=${encodeURIComponent(episodeId)}`">Open Episode Builder →</NuxtLink>
    </p>

    <div class="music-thumb-actions">
      <div class="music-thumb-action">
        <button type="button" class="btn btn-primary btn-sm" :disabled="!pickedReady || busy" @click="useScene">Use Scene as Thumbnail</button>
        <span class="text-muted text-xs">Copies the picked scene picture (1280x720) into this episode's thumbnails and pins it for upload. No credits.</span>
      </div>
      <div class="music-thumb-action">
        <button type="button" class="btn btn-secondary btn-sm" :disabled="!picked || busy" @click="writePrompts">
          {{ state.prompts_ready ? 'Rewrite Thumbnail Prompt From Scene' : 'Write Thumbnail Prompt From Scene' }}
        </button>
        <span class="text-muted text-xs">
          Writes a prompt from the picked scene's idea, the episode theme and the channel's style, with the headline for the model to draw.
          Then pick the image model below (e.g. Z-Image) and press Generate Thumbnail Images.
          <template v-if="state.prompts_ready"> A prompt is already written; this replaces it.</template>
        </span>
      </div>
    </div>
    <p class="text-muted text-xs">Thumbnail template text settings only shape the gallery preview; the drawn headline comes from the image model.</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{ projectSlug: string; episodeId: string }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

interface State {
  music: boolean
  headline: string
  prompts_ready: boolean
  scenes: Array<{ id: string; scene_index: number; has_image: boolean }>
}

const { get, post } = useApi()
const { success, error: showError } = useToast()
const state = ref<State | null>(null)
const picked = ref('')
const busy = ref(false)
let sequence = 0

const ready = computed(() => (state.value?.scenes || []).filter(scene => scene.has_image))
const pickedReady = computed(() => ready.value.some(scene => scene.id === picked.value))

function imageUrl(sceneId: string): string {
  return `/api/projects/${encodeURIComponent(props.projectSlug)}/scene-review/${encodeURIComponent(props.episodeId)}/image/${encodeURIComponent(sceneId)}`
}

async function load() {
  const request = ++sequence
  // An episode change replaces everything: this episode's scenes, never the last one's.
  state.value = null
  picked.value = ''
  if (!props.projectSlug || !props.episodeId) return
  try {
    const next = await get<State>(`/projects/${props.projectSlug}/music-episodes/${encodeURIComponent(props.episodeId)}/thumbnail`)
    if (request !== sequence) return
    state.value = next
    picked.value = next.scenes.find(scene => scene.has_image)?.id || next.scenes[0]?.id || ''
  } catch {
    if (request === sequence) state.value = null
  }
}

async function useScene() {
  busy.value = true
  try {
    const res = await post<{ filename: string }>(`/projects/${props.projectSlug}/music-episodes/${encodeURIComponent(props.episodeId)}/thumbnail/use-scene`, { scene_id: picked.value })
    success(`${res.filename} is now this episode's YouTube thumbnail.`)
    emit('changed')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Could not use that scene')
  } finally {
    busy.value = false
  }
}

async function writePrompts() {
  busy.value = true
  try {
    await post(`/projects/${props.projectSlug}/music-episodes/${encodeURIComponent(props.episodeId)}/thumbnail/prompts`, { scene_ids: [picked.value], overwrite: true })
    success('Thumbnail prompt written. Press Generate Thumbnail Images to draw it with your image model.')
    await load()
    emit('changed')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Could not write the thumbnail prompt')
  } finally {
    busy.value = false
  }
}

watch(() => [props.projectSlug, props.episodeId], load, { immediate: true })
</script>

<style scoped>
.music-thumb { display: flex; flex-direction: column; gap: 10px; }
.music-thumb-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
.music-thumb-head h3 { margin: 2px 0 0; }
.music-thumb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.music-thumb-pick {
  position: relative; display: block; width: 100%; aspect-ratio: 16 / 9; padding: 0; overflow: hidden; cursor: pointer;
  border: 2px solid var(--border); border-radius: var(--radius-sm, 6px); background: var(--bg-tertiary);
}
.music-thumb-pick:disabled { cursor: not-allowed; opacity: 0.6; }
.music-thumb-cell.picked .music-thumb-pick { border-color: var(--accent); }
.music-thumb-pick img { width: 100%; height: 100%; object-fit: cover; display: block; }
.music-thumb-empty { display: flex; height: 100%; align-items: center; justify-content: center; color: var(--text-secondary); font-size: var(--font-xs); }
.music-thumb-label {
  position: absolute; left: 4px; bottom: 4px; padding: 1px 6px; border-radius: 999px; font-size: var(--font-xs);
  background: color-mix(in srgb, var(--bg-primary) 80%, transparent); color: var(--text-primary);
}
.music-thumb-actions { display: flex; flex-wrap: wrap; gap: 12px 24px; }
.music-thumb-action { display: flex; flex-direction: column; gap: 4px; flex: 1 1 280px; max-width: 520px; }
.music-thumb-action .btn { align-self: flex-start; }
</style>
