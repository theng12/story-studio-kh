<template>
  <div class="transition-picker">
    <div class="tp-header">
      <div class="tp-tabs">
        <button
          v-for="cat in categories"
          :key="cat.id"
          :class="['tp-tab', { active: activeCat === cat.id }]"
          @click="activeCat = cat.id"
        >
          {{ cat.label }} <span class="tp-count">{{ grouped[cat.id]?.length || 0 }}</span>
        </button>
      </div>
      <div class="tp-selection-meta">
        <span class="tp-meta-text">{{ selectionSummary }}</span>
        <button v-if="pool.length" class="btn btn-sm btn-secondary" @click="$emit('update:pool', [])" title="Clear selected pool">Clear Pool</button>
        <button v-if="activeCatItems.length" class="btn btn-sm btn-secondary" @click="selectAllInCat">Select All in Tab</button>
      </div>
    </div>

    <div class="tp-grid">
      <div
        v-for="t in activeCatItems"
        :key="t.id"
        :class="['tp-card', {
          primary: primaryId === t.id,
          inPool: pool.includes(t.id),
        }]"
        :title="t.hint || t.label"
        @click="setPrimary(t.id)"
      >
        <div class="tp-preview">
          <video
            v-if="previewsLoaded.has(t.id)"
            :src="previewUrl(t.id)"
            autoplay muted loop playsinline
            class="tp-preview-video"
            @error="previewsErrored.add(t.id)"
          />
          <div v-else class="tp-preview-placeholder">
            <span>{{ previewsErrored.has(t.id) ? '⚠' : '▶' }}</span>
          </div>
        </div>
        <div class="tp-label-row">
          <label class="tp-pool-toggle" @click.stop>
            <input
              type="checkbox"
              :checked="pool.includes(t.id)"
              @change="togglePool(t.id)"
              :aria-label="`Add ${t.label} to randomize pool`"
            />
          </label>
          <span class="tp-label">{{ t.label }}</span>
          <span v-if="primaryId === t.id" class="tp-primary-tag">active</span>
        </div>
      </div>
    </div>

    <div class="tp-footer">
      <div class="tp-footer-left">
        <label>Duration ({{ duration.toFixed(1) }}s)</label>
        <input type="range" min="0.3" max="3" step="0.1" :value="duration"
          @input="$emit('update:duration', parseFloat(($event.target as HTMLInputElement).value))"
          class="slider" />
      </div>

      <div class="tp-footer-right">
        <label>Randomize</label>
        <div class="tp-randomize-buttons">
          <button
            v-for="mode in randomizeModes" :key="mode.id"
            :class="['btn btn-sm', randomizeMode === mode.id ? 'btn-primary' : 'btn-secondary']"
            @click="$emit('update:randomizeMode', mode.id)"
            :title="mode.hint"
          >{{ mode.label }}</button>
        </div>
      </div>
    </div>
    <p v-if="randomizeMode !== 'off' && pool.length === 0" class="tp-warn">
      Randomize is on but no transitions are selected as a pool. Tick the checkboxes on the cards you want to include.
    </p>
  </div>
</template>

<script setup lang="ts">
interface TransitionDef {
  id: string
  label: string
  xfade: string
  category: string
  hint?: string
}

const props = defineProps<{
  slug: string
  episodeId?: string
  /** The render's shape, so the preview is drawn in the frame the transition
   *  will actually land in (v1.4.15). Omitted = 16:9, as it always was. */
  aspectRatio?: string
  transitions: TransitionDef[]
  primaryId: string
  pool: string[]
  duration: number
  randomizeMode: 'off' | 'single' | 'per-scene'
}>()

const emit = defineEmits<{
  'update:primaryId': [id: string]
  'update:pool': [pool: string[]]
  'update:duration': [d: number]
  'update:randomizeMode': [mode: 'off' | 'single' | 'per-scene']
}>()

const categories = [
  { id: 'fade',   label: 'Fade' },
  { id: 'wipe',   label: 'Wipe' },
  { id: 'slide',  label: 'Slide' },
  { id: 'shape',  label: 'Shape' },
  { id: 'effect', label: 'Effect' },
]

const randomizeModes = [
  { id: 'off' as const,       label: 'Off',        hint: 'Use the primary transition for every scene boundary' },
  { id: 'single' as const,    label: 'Single Pick', hint: 'Randomly pick ONE transition from the pool and apply to the whole video' },
  { id: 'per-scene' as const, label: 'Per Scene',  hint: 'Randomly pick a different transition from the pool for each scene boundary' },
]

const activeCat = ref('fade')
const previewsLoaded = reactive(new Set<string>())
const previewsErrored = reactive(new Set<string>())

const grouped = computed<Record<string, TransitionDef[]>>(() => {
  const out: Record<string, TransitionDef[]> = { fade: [], wipe: [], slide: [], shape: [], effect: [] }
  for (const t of props.transitions) {
    if (!out[t.category]) out[t.category] = []
    out[t.category].push(t)
  }
  return out
})

const activeCatItems = computed(() => grouped.value[activeCat.value] || [])

const selectionSummary = computed(() => {
  const n = props.pool.length
  if (n === 0) return 'No pool · randomize disabled'
  return `${n} in pool${props.randomizeMode !== 'off' ? ` · ${props.randomizeMode}` : ''}`
})

function previewUrl(id: string): string {
  const ep = props.episodeId ? `&episode=${encodeURIComponent(props.episodeId)}` : ''
  return `/api/projects/${props.slug}/video-editor/preview-transition?type=${encodeURIComponent(id)}&duration=${props.duration.toFixed(2)}${ep}${props.aspectRatio ? `&aspect_ratio=${encodeURIComponent(props.aspectRatio)}` : ''}`
}

function setPrimary(id: string) {
  emit('update:primaryId', id)
}

function togglePool(id: string) {
  const cur = props.pool || []
  const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]
  emit('update:pool', next)
}

function selectAllInCat() {
  const ids = activeCatItems.value.map(t => t.id)
  const merged = Array.from(new Set([...(props.pool || []), ...ids]))
  emit('update:pool', merged)
}

// Lazy-load previews a few at a time so 40 cards don't fire 40 FFmpeg renders simultaneously.
let loadQueue: string[] = []
let loadInFlight = 0
const LOAD_CONCURRENCY = 3

function enqueueLoad(ids: string[]) {
  for (const id of ids) {
    if (!previewsLoaded.has(id) && !loadQueue.includes(id)) loadQueue.push(id)
  }
  pumpQueue()
}

function pumpQueue() {
  while (loadInFlight < LOAD_CONCURRENCY && loadQueue.length > 0) {
    const id = loadQueue.shift()!
    loadInFlight++
    // Kick off by marking as loaded — the <video> tag takes it from there.
    previewsLoaded.add(id)
    // We don't actually need to wait on the fetch; treat each as one slot
    // and release shortly after (roughly the time one preview renders).
    setTimeout(() => { loadInFlight--; pumpQueue() }, 400)
  }
}

watch(activeCat, (cat) => {
  enqueueLoad((grouped.value[cat] || []).map(t => t.id))
}, { immediate: true })
</script>

<style scoped>
.transition-picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tp-header {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: space-between;
  align-items: center;
}

.tp-tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.tp-tab {
  padding: 6px 12px;
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
  color: var(--text-muted);
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
}

.tp-tab.active {
  background: var(--accent);
  color: #0f1117;
  border-color: var(--accent);
  font-weight: 600;
}

.tp-count {
  font-size: var(--font-xs);
  opacity: 0.7;
  margin-left: 4px;
}

.tp-selection-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-xs);
  color: var(--text-muted);
}

.tp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}

.tp-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.15s;
  display: flex;
  flex-direction: column;
}

.tp-card:hover {
  border-color: var(--text-muted);
  transform: translateY(-1px);
}

.tp-card.primary {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.tp-card.inPool {
  border-style: dashed;
}

.tp-card.primary.inPool {
  border-style: solid;
}

.tp-preview {
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
  position: relative;
  overflow: hidden;
}

.tp-preview-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.tp-preview-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--text-muted);
  font-size: 20px;
}

.tp-label-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  font-size: 12px;
  background: var(--bg-secondary);
}

.tp-pool-toggle {
  display: flex;
  align-items: center;
  cursor: pointer;
}

.tp-label {
  flex: 1;
  color: var(--text-primary);
  font-weight: 500;
}

.tp-primary-tag {
  font-size: var(--font-xs);
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.tp-footer {
  display: flex;
  gap: 16px;
  padding: 10px;
  border-top: 1px solid var(--border);
  align-items: center;
  flex-wrap: wrap;
}

.tp-footer-left,
.tp-footer-right {
  flex: 1;
  min-width: 200px;
}

.tp-randomize-buttons {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}

.tp-warn {
  padding: 6px 10px;
  background: rgba(255, 180, 0, 0.1);
  border: 1px solid rgba(255, 180, 0, 0.3);
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 12px;
  margin: 0;
}

.tp-meta-text {
  font-style: italic;
}
</style>
