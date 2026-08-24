<template>
  <div class="swatch-picker">
    <div class="swatch-head">
      <span class="swatch-caption">{{ caption }}</span>
      <button
        v-if="missingCount" type="button" class="btn btn-secondary btn-sm"
        :disabled="busy || !model"
        :title="model ? '' : 'Choose an image model first'"
        @click="generateMissing"
      >{{ busy ? `Rendering ${done}/${total}…` : `Show me ${missingCount}` }}</button>
    </div>

    <div class="swatch-grid" role="radiogroup" :aria-label="caption">
      <button
        v-for="style in styles" :key="style.id" type="button" role="radio"
        :aria-checked="modelValue === style.id"
        :class="['swatch', { selected: modelValue === style.id }]"
        @click="$emit('update:modelValue', style.id)"
      >
        <span class="swatch-image">
          <img v-if="style.preview" :src="style.preview.url" :alt="`The word ${word} in the ${style.id} style`" loading="lazy" decoding="async" />
          <!-- No swatch yet says so plainly. A blank tile reads as a broken
               image; "not rendered yet" reads as a thing you can fix. -->
          <span v-else class="swatch-pending">not rendered yet</span>
        </span>
        <span class="swatch-name">{{ style.id.replace(/-/g, ' ') }}</span>
      </button>
    </div>

    <p v-if="error" class="swatch-error" role="status">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

interface SwatchStyle { kind: string; id: string; phrase: string; preview: { hash: string; url: string } | null }

const props = defineProps<{ kind: 'font' | 'text'; modelValue: string; model: string; aspectRatio: string; caption: string }>()
defineEmits<{ 'update:modelValue': [value: string] }>()

const { get, post } = useApi()
const styles = ref<SwatchStyle[]>([])
const word = ref('STORY')
const busy = ref(false)
const error = ref('')
const done = ref(0)
const total = ref(0)
const missingCount = computed(() => styles.value.filter(style => !style.preview).length)

async function load(): Promise<void> {
  try {
    const query = props.model ? `?model=${encodeURIComponent(props.model)}&aspect_ratio=${encodeURIComponent(props.aspectRatio || '16:9')}` : ''
    const result = await get<{ word: string; styles: SwatchStyle[] }>(`/lettering-styles${query}`)
    word.value = result.word || 'STORY'
    styles.value = (result.styles || []).filter(style => style.kind === props.kind)
  } catch (caught: any) {
    error.value = caught?.message || 'Could not load the style list.'
  }
}

/**
 * One request per missing swatch, in sequence. Each is a separate paid image,
 * so a failure stops rather than continuing to spend — and everything already
 * rendered stays rendered, because each swatch is cached the moment it lands.
 */
async function generateMissing(): Promise<void> {
  if (busy.value || !props.model) return
  const pending = styles.value.filter(style => !style.preview)
  busy.value = true; error.value = ''; done.value = 0; total.value = pending.length
  try {
    for (const style of pending) {
      const result = await post<{ url: string; hash: string }>('/lettering-styles/preview', {
        kind: props.kind, style_id: style.id, model: props.model, aspect_ratio: props.aspectRatio || '16:9',
      })
      const row = styles.value.find(item => item.id === style.id)
      if (row) row.preview = { hash: result.hash, url: result.url }
      done.value += 1
    }
  } catch (caught: any) {
    error.value = `${caught?.message || 'Rendering failed'} — ${done.value} of ${total.value} were rendered and kept.`
  } finally {
    busy.value = false
  }
}

watch(() => [props.model, props.aspectRatio], () => { void load() }, { immediate: true })
</script>

<style scoped>
.swatch-picker { display: grid; gap: 9px; }
.swatch-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.swatch-caption { color: var(--text-muted); font-size: var(--font-xs); }
.swatch-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 132px), 1fr)); gap: 9px; max-height: 340px; overflow-y: auto; padding: 2px; }
.swatch { display: grid; gap: 5px; padding: 5px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-primary); cursor: pointer; text-align: left; }
.swatch:hover { border-color: var(--border-light); }
.swatch.selected { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.swatch:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.swatch-image { display: grid; aspect-ratio: 16/9; overflow: hidden; place-items: center; border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.swatch-image > img { width: 100%; height: 100%; display: block; object-fit: cover; }
.swatch-pending { color: var(--text-muted); font-size: var(--font-xs); text-align: center; }
.swatch-name { color: var(--text-secondary); font-size: var(--font-xs); text-transform: capitalize; overflow-wrap: anywhere; }
.swatch.selected .swatch-name { color: var(--accent); font-weight: 700; }
.swatch-error { color: var(--warning); font-size: var(--font-sm); }
@media (max-width: 560px) { .swatch-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
