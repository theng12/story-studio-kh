<template>
  <!-- EXPLICIT selection only. Nothing here reads, remembers or saves a
       channel intro on its own: with no pick the host sends no
       `channel_intro` at all, which is the release/1.4.383 behavior byte for
       byte. Browse returns the RAW path the dialog picked (FilePicker gets no
       episodes-root here, so it performs no adopt round-trip); the host's
       Apply adopts through the existing `/system/resolve-asset-path`
       mode=adopt endpoint. No filesystem write happens in this component —
       never for adoption, never to make a preview work. -->
  <div class="channel-intro-audio-picker">
    <div class="form-group">
      <label>Channel intro music</label>
      <div class="flex gap-2">
        <FilePicker
          v-model="file"
          class="flex-1"
          placeholder="No channel intro chosen"
          choose-label="Choose Intro Audio"
          :filters="AUDIO_FILTERS"
          clearable
        />
        <button
          v-if="file && slug"
          type="button"
          :class="['btn btn-sm', playing ? 'btn-primary' : 'btn-secondary']"
          @click="togglePreview"
        >{{ playing ? 'Stop' : 'Preview' }}</button>
      </div>
      <p v-if="playError" class="text-muted text-sm mt-1">{{ playError }}</p>
      <p v-else-if="file && adopted" class="text-muted text-sm mt-1">
        Uses this channel's own adopted copy — moving the channel folder moves it.
      </p>
      <p v-else-if="file" class="text-muted text-sm mt-1">
        Not in this channel yet — Apply saves the picked file into the channel first.
      </p>
    </div>

    <div v-if="file" class="grid-2 mt-2">
      <div class="form-group">
        <label>Volume ({{ volumePct }}%)</label>
        <SliderWithNumber v-model="volumePct" :min="0" :max="100" :step="1" suffix="%" />
      </div>
      <div class="form-group">
        <label>Gap after intro ({{ gapAfter }}s)</label>
        <SliderWithNumber v-model="gapAfter" :min="0" :max="10" :step="0.5" :decimals="1" suffix="s" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'

/** What the host puts on the request as `channel_intro`. `volume` is LINEAR gain (0–1) — converted once, here. */
interface ChannelIntroAudioSelection {
  file: string
  volume: number
  gap_after: number
}

const props = defineProps<{
  /** Nothing selected by default. A null/absent value must stay unselected — output changes only after an explicit pick. */
  modelValue?: ChannelIntroAudioSelection | null
  /** Kept for callers that already pass it. The picker no longer hands it to FilePicker — Browse must return the raw picked path, and adoption is the host's Apply call to the existing endpoint. */
  episodesRoot: string
  /** Enables Preview. Omitted when the host has no episode in scope. */
  slug?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: ChannelIntroAudioSelection | null] }>()

const AUDIO_FILTERS = [
  { name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] },
  { name: 'All Files', extensions: ['*'] },
]

// Internal UI state mirrors the selection; the parent is only told about
// user-driven changes (the watchers below are not immediate), so mounting
// with no selection emits nothing.
const file = ref(String(props.modelValue?.file || ''))
// Portable channel tokens are what the host's Apply stores after adoption;
// anything else is still the raw picked path.
const adopted = computed(() =>
  file.value.startsWith('${CHANNEL}/') || file.value.startsWith('${PROJECT}/'))
const volumePct = ref(Math.round((props.modelValue?.volume ?? 1) * 100))
// A NEW channel's selection starts with NO gap (0). Only a value the host
// actually sent is honoured; the legacy episode intro keeps its own default 2
// on the request side, untouched here.
const gapAfter = ref(props.modelValue?.gap_after ?? 0)

watch(() => props.modelValue, (v) => {
  const nextFile = String(v?.file || '')
  if (nextFile !== file.value) file.value = nextFile
  const nextPct = Math.round((v?.volume ?? 1) * 100)
  if (nextFile && nextPct !== volumePct.value) volumePct.value = nextPct
  const nextGap = v?.gap_after ?? 0
  if (nextFile && nextGap !== gapAfter.value) gapAfter.value = nextGap
}, { deep: true })

watch([file, volumePct, gapAfter], () => {
  emit('update:modelValue', file.value
    ? { file: file.value, volume: volumePct.value / 100, gap_after: gapAfter.value }
    : null)
})

const playing = ref(false)
const playError = ref('')
let audio: HTMLAudioElement | null = null
// Every preview run owns a token: stopPreview() bumps it, so a late onended /
// play() rejection from an old run can never flip `playing` or write an error
// over the selection the user has moved on to.
let playToken = 0

/** Stop playback and invalidate any in-flight play callbacks (close, unmount, file or scope change). */
function stopPreview() {
  playToken++
  if (audio) {
    audio.onended = null
    audio.pause()
    audio = null
  }
  playing.value = false
}

async function togglePreview() {
  if (playing.value) {
    stopPreview()
    return
  }
  const token = ++playToken
  playError.value = ''
  const name = file.value.split('/').pop() || file.value
  const url = `/api/projects/${props.slug}/audio-editor/preview-audio?path=${encodeURIComponent(file.value)}`
  // The preview route enforces containment, so a raw picked path (not yet
  // adopted by the host's Apply) answers 403. Probe first and say so — an
  // honest "unavailable" beats a silent play() failure, and nothing is
  // written anywhere just to make a preview work.
  try {
    const res = await fetch(url, { method: 'HEAD' })
    if (token !== playToken) return
    if (!res.ok) {
      const detail = await res.json().then(r => (r as { detail?: string })?.detail).catch(() => '')
      playError.value = String(detail || `Preview unavailable for ${name} — Story plays files inside this project or your media folders. Apply the pick to adopt it into the channel first.`)
      return
    }
  } catch {
    if (token !== playToken) return
    playError.value = `Couldn't reach the preview for ${name}.`
    return
  }
  if (token !== playToken) return
  audio = new Audio(url)
  audio.onended = () => {
    if (token !== playToken) return
    playing.value = false
    audio = null
  }
  void audio.play().catch(() => {
    // Not-checked is not played: say so instead of clicking into silence.
    if (token !== playToken) return
    playError.value = `Couldn't play ${name} — file may be missing or in an unsupported format.`
    playing.value = false
    audio = null
  })
  playing.value = true
}

watch(file, stopPreview)
watch(() => props.slug, stopPreview)
onUnmounted(stopPreview)
</script>
