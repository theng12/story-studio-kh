<template>
  <div class="swatch-picker">
    <!-- One line, whatever the catalogue grows to. The grid lives in a modal,
         the way the Recipe Library and the Style Library already work — a
         hundred swatches inline would push everything else off the page. -->
    <div class="chosen-row">
      <span class="chosen-thumb">
        <img v-if="chosen?.preview" :src="chosen.preview.url" :alt="`The word ${word} in the ${chosen.id} style`" loading="lazy" decoding="async" />
        <span v-else class="chosen-pending">{{ modelValue === 'auto' ? 'auto' : 'no swatch' }}</span>
      </span>
      <span class="chosen-copy">
        <strong>{{ modelValue === 'auto' ? 'Let the model decide' : (chosen ? styleLabel(chosen) : modelValue) }}</strong>
        <span>{{ modelValue === 'auto' ? caption : chosen?.phrase }}</span>
      </span>
      <button type="button" class="btn btn-secondary btn-sm" @click="open = true">Browse {{ styles.length }}</button>
    </div>

    <Modal :visible="open" size="xxl" :labelledby="`${kind}-swatch-heading`" @close="open = false">
      <header class="swatch-modal-head">
        <div><span class="swatch-eyebrow">Thumbnail lettering</span><h2 :id="`${kind}-swatch-heading`">{{ title }}</h2></div>
        <button type="button" class="modal-close" aria-label="Close" @click="open = false">×</button>
      </header>
      <div class="swatch-tools">
        <span class="swatch-caption">{{ caption }}</span>
        <button
          v-if="missingCount" type="button" class="btn btn-secondary btn-sm"
          :disabled="busy" @click="generateMissing"
        >{{ busy ? `Rendering ${done}/${total}…` : `Show me ${missingCount}` }}</button>
      </div>

      <div class="swatch-grid" role="radiogroup" :aria-label="title">
        <button
          type="button" role="radio" :aria-checked="modelValue === 'auto'"
          :class="['swatch', 'swatch-auto', { selected: modelValue === 'auto' }]"
          @click="choose('auto')"
        >
          <span class="swatch-image"><span class="swatch-pending">Let the model decide</span></span>
          <span class="swatch-name">Automatic</span>
        </button>
        <button
          v-for="style in styles" :key="style.id" type="button" role="radio"
          :aria-checked="modelValue === style.id"
          :class="['swatch', { selected: modelValue === style.id }]"
          @click="choose(style.id)"
        >
          <span class="swatch-image">
            <img v-if="style.preview" :src="style.preview.url" :alt="`The word ${word} in the ${style.id} style`" loading="lazy" decoding="async" />
            <span v-else class="swatch-pending">not rendered yet</span>
          </span>
          <span class="swatch-name">{{ styleLabel(style) }}</span>
        </button>
      </div>

      <p v-if="error" class="swatch-error" role="status">{{ error }}</p>
    </Modal>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

interface SwatchStyle {
  kind: string; id: string; phrase: string
  /** Present on pack styles; built-ins are named by their id. */
  name?: string
  description?: string
  source?: 'built-in' | 'pack'
  pack_id?: string | null
  preview: { hash: string; url: string } | null
}

const props = defineProps<{ kind: 'font' | 'text'; modelValue: string; model?: string; aspectRatio?: string; caption: string; title: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const open = ref(false)
/**
 * A pack style carries a real name; a built-in only has its id. Showing the id
 * for a pack style would print "com.storystudio.lettering.case file stamp",
 * which is precisely the unreadable label the swatches exist to replace.
 */
function styleLabel(style: { id: string, name?: string }) {
  return style.name?.trim() || style.id.replace(/-/g, ' ')
}

const chosen = computed(() => styles.value.find(style => style.id === props.modelValue) || null)
function choose(id: string): void { emit('update:modelValue', id); open.value = false }

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
    // No model in the query: the page's model field is the LANGUAGE model that
    // writes the prompts, and passing it here is what made every swatch 400.
    // The server resolves the cheapest published image model itself.
    const result = await get<{ word: string; styles: SwatchStyle[] }>(
      `/lettering-styles?aspect_ratio=${encodeURIComponent(props.aspectRatio || '16:9')}`)
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
  if (busy.value) return
  const pending = styles.value.filter(style => !style.preview)
  busy.value = true; error.value = ''; done.value = 0; total.value = pending.length
  try {
    for (const style of pending) {
      const result = await post<{ url: string; hash: string }>('/lettering-styles/preview', {
        kind: props.kind, style_id: style.id, aspect_ratio: props.aspectRatio || '16:9',
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

watch(() => props.aspectRatio, () => { void load() }, { immediate: true })
</script>

<style scoped>
.swatch-picker { display: grid; gap: 9px; }
.chosen-row { display: flex; align-items: center; gap: 11px; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-primary); }
.chosen-thumb { display: grid; flex: 0 0 auto; width: 96px; aspect-ratio: 16/9; overflow: hidden; place-items: center; border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.chosen-thumb > img { width: 100%; height: 100%; object-fit: cover; }
.chosen-pending { color: var(--text-muted); font-size: var(--font-xs); }
.chosen-copy { display: grid; min-width: 0; gap: 2px; }
.chosen-copy strong { font-size: var(--font-sm); text-transform: capitalize; }
.chosen-copy span { overflow: hidden; color: var(--text-muted); font-size: var(--font-xs); text-overflow: ellipsis; white-space: nowrap; }
.chosen-row .btn { margin-left: auto; flex: 0 0 auto; }
.swatch-tools { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.swatch-caption { color: var(--text-muted); font-size: var(--font-xs); }
.swatch-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 150px), 1fr)); gap: 10px; max-height: min(60vh, 560px); overflow-y: auto; padding: 2px; }
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
.swatch-modal-head { display: flex; align-items: start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.swatch-eyebrow { display: block; color: var(--accent); font-size: var(--font-xs); font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.swatch-modal-head h2 { margin-top: 3px; font-size: var(--font-2xl); letter-spacing: -.025em; }
.modal-close { width: 36px; height: 36px; border: 1px solid var(--border); border-radius: 50%; background: var(--bg-tertiary); color: var(--text-secondary); cursor: pointer; font-size: 22px; line-height: 1; }
.modal-close:hover { border-color: var(--accent); color: var(--text-primary); }
@media (max-width: 560px) { .swatch-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
