<template>
  <div class="bpp">
    <div class="bpp-stage">
      <video ref="vid" class="bpp-video" muted playsinline preload="auto" />
      <div v-if="!activeClip" class="bpp-empty">No clip for this moment</div>
      <div class="bpp-caption">{{ activeBeat?.line || '' }}</div>
    </div>

    <!-- narration is the master clock; muted video + SFX follow it -->
    <audio ref="narr" preload="auto" @timeupdate="onTime" @loadedmetadata="onMeta" @ended="onEnded" />

    <div class="bpp-controls">
      <button class="btn btn-sm btn-primary" @click="toggle">{{ playing ? '⏸' : '▶' }}</button>
      <span class="bpp-clock">{{ fmt(currentTime) }} / {{ fmt(duration) }}</span>
      <input class="bpp-seek" type="range" min="0" :max="duration || 0" step="0.05" :value="currentTime" @input="seek(($event.target as HTMLInputElement).valueAsNumber)" />
      <label class="bpp-sfxtoggle" title="Also preview the SFX sound layer (beds + spot effects)">
        <input type="checkbox" v-model="withSfx" /> SFX
      </label>
    </div>

    <!-- beat strip -->
    <div class="bpp-strip">
      <div
        v-for="(b, i) in liveBeats"
        :key="i"
        class="bpp-seg"
        :class="{ active: b === activeBeat }"
        :style="{ flexGrow: Math.max(0.2, b.end_sec - b.start_sec) }"
        :title="`${b.start_sec.toFixed(1)}–${b.end_sec.toFixed(1)}s · ${b.line}`"
        @click="seek(b.start_sec + 0.01)"
      >{{ i + 1 }}</div>
    </div>
    <p class="text-muted text-xs bpp-note">Approximate cut — exact trims/transitions are applied at render. Clip audio is muted; SFX is layered for preview only.</p>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useBrollPlan, type BrollPlan, type BrollBeat } from '../composables/useBrollPlan.js'
import { useSfxPlan, type SfxPlan } from '../composables/useSfxPlan.js'

const props = defineProps<{ slug: string; episodeCode: string; plan: BrollPlan }>()
const api = useBrollPlan()
const sfxApi = useSfxPlan()

const narr = ref<HTMLAudioElement | null>(null)
const vid = ref<HTMLVideoElement | null>(null)
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const withSfx = ref(true)

const sfx = reactive<SfxPlan>({ schema_version: 1, enabled: false, beds: [], spots: [] })

const liveBeats = computed(() =>
  props.plan.beats
    .filter(b => b.clip && b.pool_id && (b.status === 'matched' || b.status === 'user-swapped'))
    .slice()
    .sort((a, b) => a.start_sec - b.start_sec),
)
const activeBeat = computed<BrollBeat | null>(() => {
  const t = currentTime.value
  return liveBeats.value.find(b => t >= b.start_sec && t < b.end_sec) || null
})
const activeClip = computed(() => (activeBeat.value ? `${activeBeat.value.pool_id}/${activeBeat.value.clip}` : ''))

function fmt(s: number): string {
  if (!Number.isFinite(s)) return '0:00'
  const m = Math.floor(s / 60), sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}
function dbToVol(db: number): number { return Math.max(0, Math.min(1, Math.pow(10, db / 20))) }

// ── SFX preview elements ─────────────────────────────────────────────────────
const bedEls: HTMLAudioElement[] = []
let firedSpots = new Set<number>()

function teardownSfx() {
  for (const el of bedEls) { try { el.pause() } catch {} }
  bedEls.length = 0
}
function buildBeds() {
  teardownSfx()
  for (const b of sfx.beds) {
    if (!b.clip || !b.pool_id || b.status === 'muted' || b.status === 'empty') continue
    const el = new Audio(`/api/broll-pools/${encodeURIComponent(b.pool_id)}/clips/${encodeURIComponent(b.clip)}/audio`)
    el.loop = true
    el.volume = dbToVol(b.gain_db)
    ;(el as any)._range = [b.start_sec, b.end_sec]
    bedEls.push(el)
  }
}

function syncSfx(t: number, prevT: number) {
  if (!withSfx.value) { for (const el of bedEls) { try { el.pause() } catch {} } return }
  // beds
  for (const el of bedEls) {
    const [s, e] = (el as any)._range as [number, number]
    const inSpan = t >= s && t < e
    if (inSpan && playing.value) { if (el.paused) { el.play().catch(() => {}) } }
    else if (!el.paused) el.pause()
  }
  // spots — fire when the clock crosses at_sec going forward
  if (t >= prevT) {
    sfx.spots.forEach((sp, i) => {
      if (!sp.clip || !sp.pool_id || sp.status === 'muted' || sp.status === 'empty') return
      if (sp.at_sec > prevT && sp.at_sec <= t && !firedSpots.has(i)) {
        firedSpots.add(i)
        const a = new Audio(`/api/broll-pools/${sp.pool_id}/clips/${sp.clip}/audio`)
        a.volume = dbToVol(sp.gain_db)
        a.play().catch(() => {})
      }
    })
  }
}

// ── Video follow ─────────────────────────────────────────────────────────────
let activeKey = ''
function syncVideo(t: number) {
  const el = vid.value
  if (!el) return
  const beat = activeBeat.value
  if (!beat) { if (activeKey) { activeKey = ''; el.removeAttribute('src'); el.load() } return }
  const key = `${beat.pool_id}/${beat.clip}`
  if (key !== activeKey) {
    activeKey = key
    el.src = api.videoUrl(beat.pool_id!, beat.clip)
    const seekTo = (beat.in_point_sec || 0) + Math.max(0, t - beat.start_sec)
    el.onloadeddata = () => { try { el.currentTime = seekTo; if (playing.value) el.play().catch(() => {}) } catch {} }
    el.load()
    return
  }
  // same clip — keep loosely in sync (correct drift > 0.4s)
  const expected = (beat.in_point_sec || 0) + (t - beat.start_sec)
  if (Math.abs(el.currentTime - expected) > 0.4) { try { el.currentTime = expected } catch {} }
  if (playing.value && el.paused) el.play().catch(() => {})
}

// ── Transport ────────────────────────────────────────────────────────────────
function onMeta() { duration.value = narr.value?.duration || 0 }
let prevT = 0
function onTime() {
  const t = narr.value?.currentTime || 0
  currentTime.value = t
  syncVideo(t)
  syncSfx(t, prevT)
  prevT = t
}
function onEnded() { playing.value = false; for (const el of bedEls) el.pause(); if (vid.value) vid.value.pause() }

async function toggle() {
  const a = narr.value
  if (!a) return
  if (playing.value) {
    a.pause(); playing.value = false
    vid.value?.pause(); for (const el of bedEls) el.pause()
  } else {
    playing.value = true
    await a.play().catch(() => {})
    syncVideo(a.currentTime); syncSfx(a.currentTime, a.currentTime)
    if (vid.value && activeBeat.value) vid.value.play().catch(() => {})
  }
}
function seek(t: number) {
  const a = narr.value
  if (!a) return
  a.currentTime = t
  prevT = t
  firedSpots = new Set() // allow spots after the new position to fire again
  currentTime.value = t
  activeKey = '' // force video re-sync to the right clip
  syncVideo(t)
}

async function init() {
  if (narr.value) narr.value.src = api.narrationUrl(props.slug, props.episodeCode)
  try {
    const p = await sfxApi.getPlan(props.slug, props.episodeCode)
    sfx.enabled = p.enabled; sfx.beds = p.beds || []; sfx.spots = p.spots || []
    buildBeds()
  } catch { /* SFX preview is optional */ }
}

watch(withSfx, () => { if (!withSfx.value) for (const el of bedEls) el.pause() })
onMounted(init)
onBeforeUnmount(() => { teardownSfx(); try { narr.value?.pause() } catch {} })
</script>

<style scoped>
.bpp { border: 1px solid var(--border, #333); border-radius: 8px; padding: 10px; margin-top: 8px; }
.bpp-stage { position: relative; background: #000; border-radius: 6px; overflow: hidden; aspect-ratio: 16/9; display: flex; align-items: center; justify-content: center; }
.bpp-video { width: 100%; height: 100%; object-fit: contain; background: #000; }
.bpp-empty { position: absolute; color: #888; font-size: 13px; }
.bpp-caption { position: absolute; bottom: 8px; left: 0; right: 0; text-align: center; color: #fff; font-size: 14px; text-shadow: 0 1px 3px rgba(0,0,0,0.9); padding: 0 12px; }
.bpp-controls { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.bpp-clock { font-size: 12px; color: var(--text-muted, #888); white-space: nowrap; font-variant-numeric: tabular-nums; }
.bpp-seek { flex: 1; }
.bpp-sfxtoggle { font-size: 12px; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.bpp-strip { display: flex; gap: 2px; margin-top: 8px; height: 22px; }
.bpp-seg { background: var(--surface-2, #1e1e1e); border: 1px solid var(--border, #333); border-radius: 3px; font-size: var(--font-xs); color: var(--text-muted, #888); display: flex; align-items: center; justify-content: center; cursor: pointer; min-width: 16px; }
.bpp-seg.active { background: var(--accent, #6ab0f3); color: #fff; border-color: var(--accent, #6ab0f3); }
.bpp-note { margin-top: 6px; }
</style>
