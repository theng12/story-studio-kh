<template>
  <section class="compression" :aria-labelledby="headingId">
    <h3 :id="headingId">Smaller files</h3>
    <p v-if="!slug">
      Ask the Gateway to hand back music, narration and images already compressed, so they move and store faster.
      Each change applies to the next thing you generate; files you already have are not touched. A computer that
      cannot compress simply sends the normal file. Projects can override these.
    </p>
    <p v-else>
      Choose per type for this project, or leave it on the app default. Each change applies to the next thing you generate.
    </p>
    <p v-if="loadError" class="compression-error" role="alert">{{ loadError }}</p>
    <ul v-else class="compression-list">
      <li v-for="row in rows" :key="row.kind" class="compression-row">
        <template v-if="!slug">
          <label class="compression-toggle">
            <input
              type="checkbox"
              :name="`compress-${row.kind}`"
              :checked="effective[row.kind]"
              :disabled="!loaded || saving === row.kind"
              @change="onToggle(row.kind, $event.target as HTMLInputElement)"
            />
            <span>{{ row.label }}</span>
          </label>
        </template>
        <template v-else>
          <label class="compression-choice">
            <span>{{ row.short }}</span>
            <select
              :name="`compress-${row.kind}`"
              :value="choice(row.kind)"
              :disabled="!loaded || saving === row.kind"
              @change="onChoice(row.kind, $event.target as HTMLSelectElement)"
            >
              <option value="inherit">Use app default ({{ globalSettings[row.kind] ? 'On' : 'Off' }})</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </label>
        </template>
        <small>{{ row.hint }}</small>
      </li>
    </ul>
    <p v-if="result" :class="['compression-result', result.kind]" aria-live="polite">{{ result.message }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useApi } from '~/composables/useApi'

type Kind = 'music' | 'narration' | 'scene_images' | 'image_pool' | 'thumbnails'
type Toggles = Record<Kind, boolean>
const props = defineProps<{ slug?: string }>()
const { get, put } = useApi()

const rows: Array<{ kind: Kind; label: string; short: string; hint: string }> = [
  { kind: 'music', label: 'Compress music (smaller files, AAC)', short: 'Music', hint: 'About 5 times smaller. Same sound as before: Story Studio already stored music as AAC.' },
  { kind: 'narration', label: 'Compress narration in transit (smaller transfer, AAC)', short: 'Narration', hint: 'Only the download is smaller. Chapter files are still saved as MP3, exactly as today.' },
  { kind: 'scene_images', label: 'Compress scene images (smaller files, JPEG)', short: 'Scene images', hint: 'About 6 times smaller. Saved as JPEG data under the usual file names.' },
  { kind: 'image_pool', label: 'Compress image pool images (smaller files, JPEG)', short: 'Image pool images', hint: 'Same as scene images, for stills generated into an image pool.' },
  { kind: 'thumbnails', label: 'Compress thumbnails (smaller files, JPEG)', short: 'Thumbnails', hint: 'Off keeps full-quality PNG thumbnails (YouTube accepts them up to 2 MB). Turn on only if you want smaller files.' },
]

const headingId = computed(() => props.slug ? 'project-compression-heading' : 'app-compression-heading')
const globalSettings = ref<Toggles>({ music: true, narration: true, scene_images: true, image_pool: true, thumbnails: false })
const override = ref<Partial<Toggles>>({})
const loaded = ref(false)
const loadError = ref('')
const saving = ref<Kind | ''>('')
const result = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let generation = 0

const effective = computed<Toggles>(() => ({ ...globalSettings.value, ...override.value }))
function choice(kind: Kind): 'inherit' | 'on' | 'off' {
  const own = override.value[kind]
  return own === undefined ? 'inherit' : own ? 'on' : 'off'
}

interface AppPayload { settings: Toggles }
interface ProjectPayload { global: Toggles; override: Partial<Toggles> }
const message = (e: unknown) => (e as any)?.data?.detail || (e as any)?.message || 'Could not save the setting.'

async function load() {
  const version = ++generation
  loaded.value = false
  loadError.value = ''
  result.value = null
  try {
    if (props.slug) {
      const data = await get<ProjectPayload>(`/projects/${props.slug}/settings/generation-compression`)
      if (version !== generation) return
      globalSettings.value = data.global
      override.value = data.override || {}
    } else {
      const data = await get<AppPayload>('/app-settings/generation-compression')
      if (version !== generation) return
      globalSettings.value = data.settings
    }
    loaded.value = true
  } catch (e) {
    if (version === generation) loadError.value = 'Could not load the smaller-files settings. They stay unavailable until their saved state is confirmed.'
  }
}

/** False when the save did not land; the control is then put back by the caller. */
async function save(kind: Kind, value: boolean | null): Promise<boolean> {
  const version = generation
  saving.value = kind
  result.value = null
  try {
    if (props.slug) {
      const data = await put<ProjectPayload>(`/projects/${props.slug}/settings/generation-compression`, { [kind]: value })
      if (version !== generation) return
      globalSettings.value = data.global
      override.value = data.override || {}
    } else {
      const data = await put<AppPayload>('/app-settings/generation-compression', { [kind]: value })
      if (version !== generation) return
      globalSettings.value = data.settings
    }
    result.value = { kind: 'ok', message: 'Saved. Applies to the next thing you generate.' }
    return true
  } catch (e) {
    if (version === generation) result.value = { kind: 'err', message: message(e) }
    return false
  } finally {
    // Cleared even when the project changed mid-save, or that row stayed disabled for good.
    if (saving.value === kind) saving.value = ''
  }
}

// A failed save leaves the bound value unchanged, so Vue would not re-render the control and it
// would keep showing a choice that was never saved. Put it back by hand.
async function onToggle(kind: Kind, box: HTMLInputElement) {
  if (!await save(kind, box.checked)) box.checked = effective.value[kind]
}
async function onChoice(kind: Kind, select: HTMLSelectElement) {
  const value = select.value
  if (!await save(kind, value === 'inherit' ? null : value === 'on')) select.value = choice(kind)
}

watch(() => props.slug, () => { void load() })
onMounted(() => { void load() })
</script>

<style scoped>
.compression { padding: 20px 0; }
.compression h3 { margin: 0 0 8px; }
p { color: var(--text-secondary); line-height: 1.5; margin: 8px 0 12px; max-width: 72ch; }
.compression-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }
.compression-row { display: grid; gap: 4px; }
.compression-row small { color: var(--text-secondary); line-height: 1.4; margin-left: 30px; max-width: 72ch; }
.compression-toggle { display: flex; gap: 12px; align-items: center; cursor: pointer; }
.compression-choice { display: grid; gap: 4px; max-width: 360px; }
.compression-choice > span { font-size: 13px; color: var(--text-secondary); }
.compression-choice + small { margin-left: 0; }
input[type=checkbox] { width: 18px; height: 18px; flex-shrink: 0; accent-color: var(--accent); }
.compression-error { color: var(--error, #ff9696); }
.compression-result.err { color: var(--error, #ff9696); }
:where(button, input, select):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
</style>
