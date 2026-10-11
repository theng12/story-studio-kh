<template>
  <div class="anim-picker">
    <div class="ap-header">
      <div class="ap-tabs">
        <button
          v-for="cat in categories"
          :key="cat.id"
          :class="['ap-tab', { active: activeCat === cat.id }]"
          @click="activeCat = cat.id"
        >
          {{ cat.label }} <span class="ap-count">{{ grouped[cat.id]?.length || 0 }}</span>
        </button>
      </div>
      <div class="ap-meta">
        <span class="ap-meta-text">{{ selectionSummary }}</span>
        <button v-if="pool.length" class="btn btn-sm btn-secondary" @click="$emit('update:pool', [])">Clear Pool</button>
        <button v-if="activeCatItems.length" class="btn btn-sm btn-secondary" @click="selectAllInCat">Select All in Tab</button>
      </div>
    </div>

    <div class="ap-grid">
      <!-- 1.4.282 — one card per family; each strength is still its own motion id. -->
      <div
        v-for="f in activeFamilies" :key="f.key"
        :class="['ap-card', { primary: f.ids.includes(primaryId), inPool: f.ids.some(id => pool.includes(id)) }]"
        :title="f.description"
        @click="$emit('update:primaryId', shownId(f))"
      >
        <div class="ap-preview">
          <video
            v-if="previewsLoaded.has(f.key)"
            :key="shownId(f)"
            :src="previewUrl(shownId(f))"
            autoplay muted loop playsinline
            class="ap-preview-video"
            @error="previewsErrored.add(f.key)"
          />
          <div v-else class="ap-preview-placeholder">{{ previewsErrored.has(f.key) ? '⚠' : '▶' }}</div>
        </div>
        <div class="ap-label-row">
          <span class="ap-label">{{ f.name }}</span>
          <span v-if="f.ids.includes(primaryId)" class="ap-primary-tag">active</span>
        </div>
        <div class="ap-strengths" @click.stop>
          <span v-for="m in f.members" :key="m.id" :class="['ap-strength', { on: primaryId === m.id }]">
            <input
              type="checkbox"
              :checked="pool.includes(m.id)"
              :aria-label="`Add ${f.name} (${m.strength}) to randomize pool`"
              @change="togglePool(m.id)"
            />
            <button type="button" @click="$emit('update:primaryId', m.id)">{{ m.strength }}</button>
          </span>
        </div>
      </div>
      <div
        v-for="a in activeSingles" :key="a.id"
        :class="['ap-card', {
          primary: primaryId === a.id,
          inPool: pool.includes(a.id),
        }]"
        :title="a.hint || a.label"
        @click="$emit('update:primaryId', a.id)"
      >
        <div class="ap-preview">
          <video
            v-if="previewsLoaded.has(a.id)"
            :src="previewUrl(a.id)"
            autoplay muted loop playsinline
            class="ap-preview-video"
            @error="previewsErrored.add(a.id)"
          />
          <div v-else class="ap-preview-placeholder">{{ previewsErrored.has(a.id) ? '⚠' : '▶' }}</div>
        </div>
        <div class="ap-label-row">
          <label class="ap-pool-toggle" @click.stop>
            <input
              type="checkbox"
              :checked="pool.includes(a.id)"
              @change="togglePool(a.id)"
              :aria-label="`Add ${a.label} to randomize pool`"
            />
          </label>
          <span class="ap-label">{{ a.label }}</span>
          <span v-if="primaryId === a.id" class="ap-primary-tag">active</span>
        </div>
      </div>
    </div>

    <div class="ap-footer">
      <label>Randomize</label>
      <div class="ap-random-btns">
        <button
          v-for="mode in randomizeModes" :key="mode.id"
          :class="['btn btn-sm', randomizeMode === mode.id ? 'btn-primary' : 'btn-secondary']"
          @click="$emit('update:randomizeMode', mode.id)"
          :title="mode.hint"
        >{{ mode.label }}</button>
      </div>
    </div>
    <p class="ap-note">
      Tick strengths to add them to the random pool. A family counts as one pick, then one of its ticked strengths is used.
    </p>
    <p v-if="randomizeMode !== 'off' && pool.length === 0" class="ap-warn">
      Randomize is on but no animations are selected as a pool.
    </p>
  </div>
</template>

<script setup lang="ts">
interface AnimationDef {
  id: string
  label: string
  category: string
  hint?: string
}

interface MotionFamily {
  key: string
  name: string
  description: string
  members: Array<{ id: string; strength: string }>
}

const props = defineProps<{
  slug: string
  episodeId?: string
  /** The render's shape, so the preview is drawn in the frame the effect will
   *  actually land in (v1.4.15). Omitted = 16:9, as it always was. */
  aspectRatio?: string
  animations: AnimationDef[]
  /** 1.4.282 — strengths shown on one card. Absent = every motion its own card, as before. */
  families?: MotionFamily[]
  primaryId: string
  pool: string[]
  randomizeMode: 'off' | 'single' | 'per-scene'
}>()

const emit = defineEmits<{
  'update:primaryId': [id: string]
  'update:pool': [pool: string[]]
  'update:randomizeMode': [mode: 'off' | 'single' | 'per-scene']
}>()

const categories = [
  { id: 'zoom',    label: 'Zoom' },
  { id: 'pan',     label: 'Pan' },
  { id: 'ambient', label: 'Ambient' },
  { id: 'effect',  label: 'Effect' },
  { id: 'fade',    label: 'Fades' },
  { id: 'static',  label: 'Static' },
]

const randomizeModes = [
  { id: 'off' as const,       label: 'Off',        hint: 'Use the primary animation for every scene' },
  { id: 'single' as const,    label: 'Single Pick', hint: 'Randomly pick ONE animation from the pool for the whole video' },
  { id: 'per-scene' as const, label: 'Per Scene',  hint: 'Randomly pick a different animation per scene' },
]

const activeCat = ref('zoom')
const previewsLoaded = reactive(new Set<string>())
const previewsErrored = reactive(new Set<string>())

const grouped = computed<Record<string, AnimationDef[]>>(() => {
  const out: Record<string, AnimationDef[]> = { zoom: [], pan: [], ambient: [], rotate: [], effect: [], fade: [], static: [] }
  for (const a of props.animations) {
    if (!out[a.category]) out[a.category] = []
    out[a.category].push(a)
  }
  return out
})

const activeCatItems = computed(() => grouped.value[activeCat.value] || [])

/** Families whose strengths are in this tab, with only the strengths the catalogue offers. */
const activeFamilies = computed(() => {
  const here = new Set(activeCatItems.value.map(a => a.id))
  return (props.families || [])
    .map(f => ({ ...f, members: f.members.filter(m => here.has(m.id)) }))
    .filter(f => f.members.length)
    .map(f => ({ ...f, ids: f.members.map(m => m.id) }))
})
const activeSingles = computed(() => {
  const inFamily = new Set(activeFamilies.value.flatMap(f => f.ids))
  return activeCatItems.value.filter(a => !inFamily.has(a.id))
})
/** The strength a family card shows: the active one, else the first in the pool, else the middle one. */
function shownId(f: { ids: string[] }): string {
  return f.ids.find(id => id === props.primaryId)
    ?? f.ids.find(id => props.pool.includes(id))
    ?? f.ids[Math.floor((f.ids.length - 1) / 2)]!
}

const selectionSummary = computed(() => {
  const n = props.pool.length
  if (n === 0) return 'No pool · randomize disabled'
  return `${n} in pool${props.randomizeMode !== 'off' ? ` · ${props.randomizeMode}` : ''}`
})

function previewUrl(id: string) {
  const ep = props.episodeId ? `&episode=${encodeURIComponent(props.episodeId)}` : ''
  const ar = props.aspectRatio ? `&aspect_ratio=${encodeURIComponent(props.aspectRatio)}` : ''
  return `/api/projects/${props.slug}/video-editor/preview-animation?type=${encodeURIComponent(id)}${ep}${ar}`
}

function togglePool(id: string) {
  const cur = props.pool || []
  const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]
  emit('update:pool', next)
}

function selectAllInCat() {
  const ids = activeCatItems.value.map(a => a.id)
  const merged = Array.from(new Set([...(props.pool || []), ...ids]))
  emit('update:pool', merged)
}

// Lazy load previews
let loadQueue: string[] = []
let loadInFlight = 0
const LOAD_CONCURRENCY = 3

function enqueueLoad(ids: string[]) {
  for (const id of ids) if (!previewsLoaded.has(id) && !loadQueue.includes(id)) loadQueue.push(id)
  pumpQueue()
}

function pumpQueue() {
  while (loadInFlight < LOAD_CONCURRENCY && loadQueue.length > 0) {
    const id = loadQueue.shift()!
    loadInFlight++
    previewsLoaded.add(id)
    setTimeout(() => { loadInFlight--; pumpQueue() }, 500)
  }
}

watch([activeCat, () => props.families], () => {
  enqueueLoad([...activeFamilies.value.map(f => f.key), ...activeSingles.value.map(a => a.id)])
}, { immediate: true })
</script>

<style scoped>
.anim-picker { display: flex; flex-direction: column; gap: 10px; }
.ap-header { display: flex; flex-wrap: wrap; gap: 10px; justify-content: space-between; align-items: center; }
.ap-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.ap-tab { padding: 6px 12px; border: 1px solid var(--border); background: var(--bg-tertiary); color: var(--text-muted); border-radius: 6px; cursor: pointer; font-size: 12px; font-family: inherit; }
.ap-tab.active { background: var(--accent); color: #0f1117; border-color: var(--accent); font-weight: 600; }
.ap-count { font-size: var(--font-xs); opacity: 0.7; margin-left: 4px; }
.ap-meta { display: flex; align-items: center; gap: 8px; font-size: var(--font-xs); color: var(--text-muted); }
.ap-meta-text { font-style: italic; }
.ap-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.ap-card { border: 1px solid var(--border); border-radius: 8px; background: var(--bg-secondary); overflow: hidden; cursor: pointer; transition: border-color 0.15s, transform 0.15s; display: flex; flex-direction: column; }
.ap-card:hover { border-color: var(--text-muted); transform: translateY(-1px); }
.ap-card.primary { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.ap-card.inPool { border-style: dashed; }
.ap-card.primary.inPool { border-style: solid; }
.ap-preview { width: 100%; aspect-ratio: 16 / 9; background: #000; position: relative; overflow: hidden; }
.ap-preview-video { width: 100%; height: 100%; object-fit: cover; display: block; }
.ap-preview-placeholder { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; color: var(--text-muted); font-size: 20px; }
.ap-label-row { display: flex; align-items: center; gap: 6px; padding: 6px 8px; font-size: 12px; background: var(--bg-secondary); }
.ap-pool-toggle { display: flex; align-items: center; cursor: pointer; }
.ap-label { flex: 1; color: var(--text-primary); font-weight: 500; }
.ap-primary-tag { font-size: var(--font-xs); color: var(--accent); text-transform: uppercase; letter-spacing: 0.5px; }
.ap-footer { display: flex; gap: 12px; align-items: center; padding: 10px; border-top: 1px solid var(--border); }
.ap-random-btns { display: flex; gap: 4px; }
.ap-strengths { display: flex; gap: 4px; flex-wrap: wrap; padding: 0 8px 8px; }
.ap-strength { display: inline-flex; align-items: center; gap: 2px; border: 1px solid var(--border); border-radius: 999px; padding: 1px 6px 1px 4px; font-size: 12px; }
.ap-strength button { background: none; border: 0; color: var(--text-muted); cursor: pointer; font: inherit; text-transform: capitalize; padding: 0; }
.ap-strength.on { border-color: var(--accent); }
.ap-strength.on button { color: var(--accent); font-weight: 600; }
.ap-note { margin: 0; font-size: 12px; color: var(--text-muted); }
.ap-warn { padding: 6px 10px; background: rgba(255, 180, 0, 0.1); border: 1px solid rgba(255, 180, 0, 0.3); border-radius: 6px; color: var(--text-muted); font-size: 12px; margin: 0; }
</style>
