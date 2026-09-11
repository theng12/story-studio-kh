<template>
  <fieldset
    class="episode-visual-source"
    :disabled="disabled || saving || !currentSource"
    @click.stop
  >
    <legend>Visual source</legend>
    <p v-if="sourceError" class="episode-visual-source-error" role="alert">{{ sourceError }}</p>
    <div v-else class="episode-visual-source-options">
      <label>
        <input
          :checked="currentSource === 'scene_plan'"
          type="radio"
          :name="`visual-source-${episodeId}`"
          value="scene_plan"
          @change="save('scene_plan')"
        />
        <span><strong>Scene Plan</strong><small>Planned stills and timing.</small></span>
      </label>
      <label>
        <input
          :checked="currentSource === 'image_pool'"
          type="radio"
          :name="`visual-source-${episodeId}`"
          value="image_pool"
          @change="save('image_pool')"
        />
        <span><strong>Image Pool</strong><small>Saved picks at their saved timing.</small></span>
      </label>
    </div>
    <p v-if="currentSource === 'scene_plan'" class="episode-visual-source-help">
      Set timing and motion in <NuxtLink :to="scenePlanLink">Scene Plan</NuxtLink>.
    </p>
    <p v-else-if="currentSource === 'image_pool'" class="episode-visual-source-help">
      Pick images in <NuxtLink :to="videoAssemblyLink">Video Assembly</NuxtLink>. You can choose Image Pool before picks exist.
    </p>
    <p v-if="saving" class="episode-visual-source-help">Saving source…</p>
  </fieldset>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { EpisodeVisualSource as VisualSource } from '~/composables/useProjectFlow'

const props = withDefaults(defineProps<{
  slug: string
  episodeId: string
  source: VisualSource | null | undefined
  disabled?: boolean
}>(), {
  disabled: false,
})

const emit = defineEmits<{ changed: [source: VisualSource] }>()
const { put } = useApi()
const { error: showError } = useToast()
const currentSource = ref<VisualSource | null>(null)
const sourceError = ref('')
const saving = ref(false)
let requestSequence = 0

const scenePlanLink = computed(() => ({
  path: `/projects/${props.slug}/scene-plan`,
  query: { episode_id: props.episodeId },
  hash: '#visual-timing',
}))
const videoAssemblyLink = computed(() => ({
  path: `/projects/${props.slug}/video-assembly`,
  query: { episode_id: props.episodeId },
}))

function isVisualSource(value: unknown): value is VisualSource {
  return value === 'scene_plan' || value === 'image_pool'
}

function identity(): string {
  return `${props.slug}:${props.episodeId}`
}

watch(
  [() => props.slug, () => props.episodeId, () => props.source],
  ([, , source]) => {
    requestSequence++
    saving.value = false
    if (isVisualSource(source)) {
      currentSource.value = source
      sourceError.value = ''
      return
    }
    currentSource.value = null
    sourceError.value = 'This episode’s saved visual source is unavailable. Refresh the episode list before changing it.'
  },
  { immediate: true },
)

async function save(source: VisualSource): Promise<void> {
  if (saving.value || !currentSource.value) return
  const scope = identity()
  const request = ++requestSequence
  saving.value = true
  sourceError.value = ''
  try {
    const result = await put<{ source?: unknown }>(
      `/projects/${props.slug}/video-editor/visual-source/${encodeURIComponent(props.episodeId)}`,
      { source },
    )
    if (request !== requestSequence || scope !== identity()) return
    if (!isVisualSource(result?.source)) {
      currentSource.value = null
      sourceError.value = 'The saved visual source could not be confirmed. Refresh the episode list before trying again.'
      return
    }
    currentSource.value = result.source
    emit('changed', result.source)
  } catch (error: any) {
    if (request !== requestSequence || scope !== identity()) return
    sourceError.value = error?.data?.detail || error?.message || 'Could not save visual source'
    showError(sourceError.value)
  } finally {
    if (request === requestSequence && scope === identity()) saving.value = false
  }
}
</script>

<style scoped>
.episode-visual-source {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--bg-primary) 60%, transparent);
}
.episode-visual-source legend { padding: 0 4px; color: var(--text-muted); font-size: var(--font-xs); }
.episode-visual-source-options { display: flex; flex-wrap: wrap; gap: 6px; }
.episode-visual-source-options label { display: flex; align-items: flex-start; gap: 5px; cursor: pointer; }
.episode-visual-source-options span { display: grid; gap: 1px; }
.episode-visual-source-options small,
.episode-visual-source-help { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.35; }
.episode-visual-source-help { margin: 0; }
.episode-visual-source-error { margin: 0; color: var(--danger, #dc2626); font-size: var(--font-xs); }
@media (max-width: 560px) { .episode-visual-source-options { display: grid; } }
</style>
