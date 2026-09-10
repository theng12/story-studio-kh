<template>
  <section class="chapter-audio-preview" aria-label="Chapter audio preview">
    <div class="preview-heading">
      <strong>{{ section.replaceAll('_', ' ') }} · source audio</strong>
      <button type="button" class="btn btn-xs btn-secondary" @click="$emit('close')">Close player</button>
    </div>
    <p v-if="loading" role="status">Loading chapter audio…</p>
    <div v-else-if="error" role="alert" class="preview-error">
      <p>{{ error }}</p>
      <button type="button" class="btn btn-sm btn-secondary" @click="loadAudio">Retry playback</button>
    </div>
    <template v-else-if="parts.length">
      <label v-if="parts.length > 1" class="part-picker">
        Audio part
        <select :value="partIndex" @change="selectPart">
          <option v-for="(part, index) in parts" :key="part.part" :value="index">Part {{ index + 1 }} of {{ parts.length }}</option>
        </select>
      </label>
      <audio :key="audioSrc" ref="player" :src="audioSrc" controls preload="metadata"
        :aria-label="`${section.replaceAll('_', ' ')} audio, part ${partIndex + 1}`"
        @loadedmetadata="startPlayback" @ended="playNextPart" @error="playbackFailed" />
      <p class="text-muted text-sm" role="status">{{ playbackNote }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{ projectSlug: string; episodeId: string; section: string; startSeconds?: number }>()
defineEmits<{ close: [] }>()
const { get } = useApi()
const parts = ref<Array<{ part: number; filename: string }>>([])
const player = ref<HTMLAudioElement | null>(null)
const partIndex = ref(0)
const loading = ref(false)
const error = ref('')
const playbackNote = ref('Use the player to listen and seek. Playback does not use credits.')
let request = 0
let remainingSeek = 0
const sourceRevision = ref(0)
const endpoint = computed(() => `/api/projects/${encodeURIComponent(props.projectSlug)}/episodes/${encodeURIComponent(props.episodeId)}/audio-file?section=${encodeURIComponent(props.section)}`)
const audioSrc = computed(() => `${endpoint.value}&part=${parts.value[partIndex.value]?.part ?? 0}&preview=${sourceRevision.value}`)
function stopPlayback() { player.value?.pause() }
async function loadAudio() {
  const currentRequest = ++request
  stopPlayback()
  parts.value = []
  partIndex.value = 0
  error.value = ''
  loading.value = true
  remainingSeek = Number.isFinite(props.startSeconds) ? Math.max(0, props.startSeconds || 0) : 0
  sourceRevision.value = Date.now()
  playbackNote.value = 'Use the player to listen and seek. Playback does not use credits.'
  try {
    const result = await get<{ parts: Array<{ part: number; filename: string }> }>(`${endpoint.value.slice(4)}&info=1`)
    if (currentRequest !== request) return
    if (!result.parts?.length) throw new Error('No source audio is available for this chapter.')
    parts.value = result.parts
  } catch {
    if (currentRequest === request) error.value = 'Could not load this chapter’s audio. Retry playback or open Audio Generator to check its files.'
  } finally {
    if (currentRequest === request) loading.value = false
  }
}
function selectPart(event: Event) {
  stopPlayback()
  remainingSeek = 0
  partIndex.value = Number((event.target as HTMLSelectElement).value)
}
function startPlayback(event: Event) {
  const el = event.target as HTMLAudioElement
  if (el !== player.value) return
  // Gap offsets are chapter-local. Walk active parts until that offset lands
  // within a file; never apply a chapter offset directly to an arbitrary chunk.
  if (Number.isFinite(el.duration) && el.duration > 0) {
    if (remainingSeek >= el.duration && partIndex.value + 1 < parts.value.length) {
      remainingSeek -= el.duration
      partIndex.value++
      return
    }
    el.currentTime = Math.min(remainingSeek, Math.max(0, el.duration - 0.1))
  }
  remainingSeek = 0
  void el.play().catch(() => {
    if (el === player.value) playbackNote.value = 'Press Play in the player to listen. Playback does not use credits.'
  })
}
function playNextPart(event: Event) {
  if (event.target !== player.value || partIndex.value + 1 >= parts.value.length) return
  remainingSeek = 0
  partIndex.value++
}
function playbackFailed(event: Event) {
  if (event.target !== player.value) return
  stopPlayback()
  error.value = 'This audio file could not be played. Retry playback or open Audio Generator to regenerate the chapter.'
}
watch(() => [props.projectSlug, props.episodeId, props.section, props.startSeconds], loadAudio, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { request++; stopPlayback() })
</script>

<style scoped>
.chapter-audio-preview { margin-block: 12px; padding: 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary); }
.preview-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.preview-heading strong { overflow-wrap: anywhere; }
audio { display: block; width: 100%; margin-block: 10px; }
.part-picker { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.preview-error { color: var(--text-primary); }
.preview-error p { margin-bottom: 8px; }
</style>
