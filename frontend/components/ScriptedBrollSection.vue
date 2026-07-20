<template>
  <div class="settings-section sbr-section mt-2">
    <div class="flex gap-2 items-center justify-between flex-wrap">
      <h4 class="m-0">Scripted B-Roll <span class="sbr-badge">beta</span></h4>
    </div>
    <p class="text-muted text-sm hint-line">
      Instead of random pool clips, an LLM turns this episode's <strong>narration</strong> into timed beats and writes a
      filmable search query for each, then pulls a matching stock clip (Pexels / Pixabay) into your
      <NuxtLink to="/broll-library" class="ffmpeg-inline-link">B-Roll pool</NuxtLink> and lines them up to the narration.
      Needs the episode's stitched subtitles + a Pexels/Pixabay key + a video pool.
    </p>

    <div class="sbr-gen-row">
      <div class="sbr-model">
        <label class="sbr-lbl">Shot director model</label>
        <ModelSelector v-model="model" :project-slug="slug" />
      </div>
      <div class="sbr-field">
        <label class="sbr-lbl">Beat length</label>
        <span class="sbr-inline"><input type="number" v-model.number="beatSec" class="input sbr-num" min="2" max="15" step="1" />s</span>
      </div>
      <div class="sbr-field sbr-style">
        <label class="sbr-lbl">Style hint (optional)</label>
        <input v-model="styleHint" class="input" placeholder="e.g. corporate, 1950s period" />
      </div>
    </div>

    <div class="sbr-actions-top">
      <label class="sbr-check" title="After writing queries, immediately search + download a clip for each beat.">
        <input type="checkbox" v-model="resolveNow" /> <span>Download clips now</span>
      </label>
      <button class="btn btn-primary" :disabled="!model || !!busy || !episodeCode" @click="generate">
        {{ busy === 'gen' ? 'Directing…' : '🎬 Generate shot plan' }}
      </button>
    </div>

    <div class="sbr-aigen">
      <label class="sbr-check" title="For beats with no stock match, generate a channel-styled clip with your image model (costs image credits).">
        <input type="checkbox" v-model="aiFallback" /> <span>AI-generate clips for beats with no stock match</span>
      </label>
      <div v-if="aiFallback" class="sbr-aigen-fields">
        <div class="sbr-aigen-field">
          <label class="sbr-lbl">Channel style for AI clips</label>
          <input v-model="plan.broll_style" class="input" placeholder="e.g. flat editorial illustration, muted 2D vector" @input="dirty = true" />
        </div>
        <div class="sbr-aigen-field">
          <label class="sbr-lbl">Image model</label>
          <ImageModelPicker v-model="imageModel" :project-slug="slug" />
        </div>
        <template v-if="selectedGenStudioModel">
          <div class="sbr-aigen-field sbr-compact-field">
            <label class="sbr-lbl">Ratio</label>
            <select v-model="imageAspectRatio" class="select">
              <option v-for="ratio in selectedGenStudioModel.aspect_ratios" :key="ratio" :value="ratio">{{ ratio }}</option>
            </select>
          </div>
          <div class="sbr-aigen-field sbr-compact-field">
            <label class="sbr-lbl">Quality</label>
            <select v-model="imageQuality" class="select" @change="applyImageQuality">
              <option value="draft">Draft</option>
              <option value="balanced">Balanced</option>
              <option value="detailed">Detailed</option>
              <option value="maximum">Maximum</option>
              <option value="custom">Custom steps</option>
            </select>
          </div>
          <div class="sbr-aigen-field sbr-compact-field">
            <label class="sbr-lbl">Steps</label>
            <input v-model.number="imageSteps" class="input" type="number" :min="selectedGenStudioModel.min_steps" :max="selectedGenStudioModel.max_steps" @input="imageQuality = 'custom'" />
          </div>
          <div class="sbr-aigen-field sbr-seed-field">
            <label class="sbr-lbl">Seed (optional)</label>
            <input v-model.number="imageSeed" class="input" type="number" min="0" max="2147483647" placeholder="Random" />
          </div>
        </template>
      </div>
    </div>

    <p v-if="message" :class="['sbr-msg', messageKind]">{{ message }}</p>

    <div v-if="loading" class="text-muted text-sm">Loading shot plan…</div>

    <template v-else-if="plan.beats.length">
      <div class="sbr-summary text-sm text-muted">
        {{ plan.beats.length }} beat(s) · <strong :class="matchedCount ? 'sbr-live' : ''">{{ matchedCount }} with a clip</strong>,
        {{ emptyCount }} unmatched
      </div>

      <div class="sbr-beats">
        <div v-for="(b, i) in plan.beats" :key="i" class="sbr-beat">
          <span class="sbr-time">
            <input type="number" v-model.number="b.start_sec" class="input sbr-tnum" min="0" step="0.1" @input="dirty = true" />–
            <input type="number" v-model.number="b.end_sec" class="input sbr-tnum" min="0" step="0.1" @input="dirty = true" />s
          </span>
          <div class="sbr-beat-main">
            <div class="sbr-line">{{ b.line || '—' }}</div>
            <input
              class="input sbr-qedit"
              :value="b.queries.join(', ')"
              placeholder="comma-separated search queries"
              @input="onQueryEdit(b, ($event.target as HTMLInputElement).value)"
            />
            <div v-if="b.clip" class="sbr-clip">🎞 {{ b.clip }}</div>
            <div class="sbr-beat-actions">
              <button class="sbr-mini" :disabled="!!busyBeat || !model" title="Ask the LLM for fresh queries" @click="requery(i)">{{ busyBeat === 'rq' + i ? '…' : '↻ re-query' }}</button>
              <button class="sbr-mini" :disabled="!!busyBeat || !b.queries.length" title="Search alternatives + pick a clip" @click="openSwap(i)">{{ busyBeat === 'sw' + i ? '…' : '⇄ swap clip' }}</button>
              <span :class="['sbr-status', 'st-' + b.status]">{{ b.status === 'matched' || b.status === 'user-swapped' ? '✓ clip' : (b.status === 'empty' ? 'none' : 'pending') }}</span>
            </div>

            <!-- Swap candidate picker -->
            <div v-if="swapOpen === i" class="sbr-swap">
              <div v-if="swapLoading" class="text-muted text-xs">Searching…</div>
              <div v-else-if="!swapCandidates.length" class="text-muted text-xs">No results for these queries.</div>
              <div v-else class="sbr-swap-grid">
                <button v-for="c in swapCandidates" :key="c.provider + c.source_id" class="sbr-cand" :title="`${c.provider} · ${c.duration?.toFixed?.(0) || '?'}s`" @click="doSwap(i, c)">
                  <img :src="c.thumbnail_url" alt="" loading="lazy" />
                  <span class="sbr-cand-prov">{{ c.provider }}</span>
                </button>
              </div>
              <button class="sbr-mini" @click="swapOpen = -1">close</button>
            </div>
          </div>
        </div>
      </div>

      <div class="sbr-actions">
        <button class="btn btn-sm btn-primary" :disabled="!!busy || !dirty" @click="saveEdits">{{ dirty ? 'Save edits' : 'Saved' }}</button>
        <button class="btn btn-sm" :disabled="!!busy" @click="resolve">{{ busy === 'res' ? 'Downloading…' : '⬇ Download / re-match clips' }}</button>
        <button class="btn btn-sm" :disabled="!matchedCount" :title="matchedCount ? 'Scrub the cut in your browser (no render)' : 'Resolve clips first'" @click="previewOpen = !previewOpen">{{ previewOpen ? '▲ Hide preview' : '▶ Preview cut' }}</button>
        <span class="sbr-spacer" />
        <button class="btn btn-sm btn-icon danger" title="Delete the shot plan" @click="clearPlan">🗑</button>
        <button class="btn btn-sm btn-primary" :disabled="!!busy || !matchedCount" @click="assemble">{{ busy === 'asm' ? 'Queuing…' : '🎬 Assemble video' }}</button>
      </div>

      <BrollPreviewPlayer v-if="previewOpen && matchedCount" :slug="slug" :episode-code="episodeCode" :plan="plan" />
    </template>

    <div v-else-if="!loading" class="text-muted text-sm sbr-empty">
      No shot plan yet — generate one from the narration above.
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useBrollPlan, type BrollPlan, type BrollBeat, type BrollCandidate, type GenerateResult } from '../composables/useBrollPlan.js'

const props = defineProps<{ slug: string; episodeCode: string }>()
const api = useBrollPlan()

const plan = reactive<BrollPlan>({ schema_version: 1, enabled: false, broll_style: '', beats: [] })
const model = ref('')
const beatSec = ref(5)
const styleHint = ref('')
const resolveNow = ref(true)
const aiFallback = ref(false)
const imageModel = ref('')
const imageAspectRatio = ref('16:9')
const imageQuality = ref<'draft' | 'balanced' | 'detailed' | 'maximum' | 'custom'>('balanced')
const imageSteps = ref(4)
const imageSeed = ref<number | ''>('')
const { models: genStudioModels, refresh: refreshGenStudioModels } = useGenStudioImageModels()
const selectedGenStudioModel = computed(() => genStudioModels.value.find(item => item.id === imageModel.value))
const qualitySteps = computed(() => {
  const item = selectedGenStudioModel.value
  return item ? {
    draft: item.min_steps,
    balanced: item.default_steps,
    detailed: Math.min(item.max_steps, item.default_steps + 2),
    maximum: item.max_steps,
  } : { draft: 2, balanced: 4, detailed: 6, maximum: 8 }
})
function applyImageQuality() {
  if (imageQuality.value !== 'custom') imageSteps.value = qualitySteps.value[imageQuality.value]
}
function aiImageControls() {
  if (!aiFallback.value) return { ai_fallback: false }
  return {
    ai_fallback: true,
    image_model: imageModel.value,
    image_aspect_ratio: selectedGenStudioModel.value ? imageAspectRatio.value : undefined,
    image_steps: selectedGenStudioModel.value ? imageSteps.value : undefined,
    image_seed: selectedGenStudioModel.value && typeof imageSeed.value === 'number' ? imageSeed.value : undefined,
  }
}
const loading = ref(false)
const busy = ref<'' | 'gen' | 'res' | 'asm'>('')
const busyBeat = ref('')
const dirty = ref(false)
const swapOpen = ref(-1)
const swapLoading = ref(false)
const swapCandidates = ref<BrollCandidate[]>([])
const previewOpen = ref(false)
const message = ref('')
const messageKind = ref<'ok' | 'err'>('ok')

const matchedCount = computed(() => plan.beats.filter(b => b.clip && (b.status === 'matched' || b.status === 'user-swapped')).length)
const emptyCount = computed(() => plan.beats.filter(b => !b.clip).length)

function setMsg(t: string, k: 'ok' | 'err' = 'ok') { message.value = t; messageKind.value = k }
function errOf(e: any): string { return e?.data?.detail || e?.message || String(e) }
function applyPlan(p: BrollPlan) {
  plan.enabled = !!p.enabled
  plan.broll_style = p.broll_style || ''
  plan.beats = p.beats || []
  dirty.value = false // every applyPlan reflects the persisted server state
}
function resolveNote(r: GenerateResult): string {
  if (r.resolve_skipped_reason) return ` (download skipped: ${r.resolve_skipped_reason})`
  if (typeof r.matched === 'number') {
    const ai = r.aigen ? ` (${r.aigen} AI-generated)` : ''
    return ` Downloaded ${r.downloaded ?? 0}, ${r.matched} beat(s) now have a clip${ai}.`
  }
  return ''
}

async function load() {
  if (!props.episodeCode) return
  loading.value = true
  message.value = ''
  try { applyPlan(await api.getPlan(props.slug, props.episodeCode)) }
  catch (e) { setMsg(`Couldn't load the shot plan: ${errOf(e)}`, 'err') }
  finally { loading.value = false }
}

async function generate() {
  busy.value = 'gen'
  message.value = ''
  try {
    const r = await api.generate(props.slug, props.episodeCode, {
      model: model.value, style_hint: styleHint.value || undefined, target_beat_sec: beatSec.value, resolve: resolveNow.value,
      broll_style: plan.broll_style || undefined,
      ...aiImageControls(),
    })
    applyPlan(r.plan)
    setMsg(`Directed ${r.beat_count} beat(s).${resolveNote(r)}`, 'ok')
  } catch (e) { setMsg(errOf(e), 'err') }
  finally { busy.value = '' }
}

async function resolve() {
  busy.value = 'res'
  message.value = ''
  try {
    const r = await api.resolve(props.slug, props.episodeCode, { ...plan } as BrollPlan, {
      ...aiImageControls(),
    })
    applyPlan(r.plan)
    setMsg(`${r.matched} beat(s) have a clip.${resolveNote(r)}`, 'ok')
  } catch (e) { setMsg(errOf(e), 'err') }
  finally { busy.value = '' }
}

async function assemble() {
  busy.value = 'asm'
  message.value = ''
  try {
    const r = await api.assemble(props.slug, props.episodeCode)
    setMsg(`Queued assembly of ${r.beats} beat(s) — watch the Jobs page.`, 'ok')
  } catch (e) { setMsg(errOf(e), 'err') }
  finally { busy.value = '' }
}

function onQueryEdit(b: BrollBeat, val: string) {
  b.queries = val.split(',').map(s => s.trim()).filter(Boolean)
  dirty.value = true
}

async function saveEdits() {
  busy.value = 'gen'
  try {
    const r = await api.savePlan(props.slug, props.episodeCode, { ...plan } as BrollPlan)
    applyPlan(r.plan)
    dirty.value = false
    setMsg('Shot plan saved.', 'ok')
  } catch (e) { setMsg(errOf(e), 'err') }
  finally { busy.value = '' }
}

async function requery(i: number) {
  if (!model.value) { setMsg('Pick a director model first.', 'err'); return }
  busyBeat.value = 'rq' + i
  try {
    const r = await api.requeryBeat(props.slug, props.episodeCode, { beat_index: i, model: model.value, style_hint: styleHint.value || undefined })
    applyPlan(r.plan)
    setMsg(`Beat ${i + 1}: ${r.queries.length} fresh quer${r.queries.length === 1 ? 'y' : 'ies'}.`, 'ok')
  } catch (e) { setMsg(errOf(e), 'err') }
  finally { busyBeat.value = '' }
}

async function openSwap(i: number) {
  if (swapOpen.value === i) { swapOpen.value = -1; return }
  swapOpen.value = i
  swapCandidates.value = []
  swapLoading.value = true
  busyBeat.value = 'sw' + i
  try {
    const r = await api.search(props.slug, props.episodeCode, plan.beats[i]!.queries)
    swapCandidates.value = r.candidates || []
  } catch (e) { setMsg(errOf(e), 'err'); swapOpen.value = -1 }
  finally { swapLoading.value = false; busyBeat.value = '' }
}

async function doSwap(i: number, c: BrollCandidate) {
  busyBeat.value = 'sw' + i
  try {
    const r = await api.swapBeat(props.slug, props.episodeCode, { beat_index: i, provider: c.provider, result: c.result })
    applyPlan(r.plan)
    swapOpen.value = -1
    setMsg(`Beat ${i + 1}: swapped to ${r.filename}.`, 'ok')
  } catch (e) { setMsg(errOf(e), 'err') }
  finally { busyBeat.value = '' }
}

async function clearPlan() {
  try {
    await api.deletePlan(props.slug, props.episodeCode)
    applyPlan({ schema_version: 1, enabled: false, broll_style: '', beats: [] })
    setMsg('Shot plan cleared.', 'ok')
  } catch (e) { setMsg(errOf(e), 'err') }
}

watch(() => props.episodeCode, load, { immediate: true })
watch([imageModel, () => genStudioModels.value.length], () => {
  const item = selectedGenStudioModel.value
  if (!item) return
  if (!item.aspect_ratios.includes(imageAspectRatio.value)) imageAspectRatio.value = item.default_aspect_ratio
  imageSteps.value = Math.max(item.min_steps, Math.min(item.max_steps, Number(imageSteps.value) || item.default_steps))
  if (imageQuality.value !== 'custom') applyImageQuality()
})
onMounted(() => { void refreshGenStudioModels() })
</script>

<style scoped>
.sbr-section { border-top: 1px solid var(--border, #2a2a2a); padding-top: 12px; }
.sbr-badge { font-size: 11px; font-weight: 400; color: var(--text-muted, #888); border: 1px solid var(--border, #333); border-radius: 4px; padding: 1px 5px; margin-left: 6px; vertical-align: middle; }
.sbr-gen-row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; margin-top: 8px; }
.sbr-model { min-width: 220px; flex: 1; }
.sbr-style { flex: 2; min-width: 180px; }
.sbr-lbl { display: block; font-size: 12px; color: var(--text-muted, #888); margin-bottom: 3px; }
.sbr-inline { display: inline-flex; align-items: center; gap: 3px; }
.sbr-num { width: 60px; }
.sbr-actions-top { display: flex; gap: 12px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
.sbr-check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
.sbr-aigen { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--border, #2a2a2a); }
.sbr-aigen-fields { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
.sbr-aigen-field { flex: 1; min-width: 220px; }
.sbr-compact-field { flex: 0 1 150px; min-width: 130px; }
.sbr-seed-field { flex: 0 1 180px; min-width: 160px; }
.sbr-msg { font-size: 13px; margin-top: 8px; }
.sbr-msg.ok { color: var(--accent, #6ab0f3); }
.sbr-msg.err { color: var(--danger, #e06c75); }
.sbr-summary { margin: 10px 0 4px; }
.sbr-live { color: var(--accent, #6ab0f3); }
.sbr-beats { display: flex; flex-direction: column; gap: 4px; max-height: 320px; overflow-y: auto; padding-right: 4px; }
.sbr-beat { display: flex; gap: 10px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid var(--border, #222); }
.sbr-time { font-size: 11px; color: var(--text-muted, #888); white-space: nowrap; min-width: 78px; padding-top: 2px; }
.sbr-beat-main { flex: 1; min-width: 0; }
.sbr-line { font-size: 13px; }
.sbr-queries { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 3px; }
.sbr-query { font-size: 11px; background: var(--surface-2, #1e1e1e); border: 1px solid var(--border, #333); border-radius: 4px; padding: 1px 6px; }
.sbr-clip { font-size: 11px; color: var(--accent, #6ab0f3); margin-top: 3px; }
.sbr-tnum { width: 56px; }
.sbr-qedit { width: 100%; margin-top: 3px; font-size: 12px; }
.sbr-beat-actions { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
.sbr-mini { background: none; border: 1px solid var(--border, #333); border-radius: 4px; cursor: pointer; padding: 1px 7px; font-size: 11px; color: var(--text, inherit); }
.sbr-mini:hover:not(:disabled) { border-color: var(--accent, #6ab0f3); }
.sbr-mini:disabled { opacity: 0.5; cursor: default; }
.sbr-swap { margin-top: 6px; padding: 6px; border: 1px solid var(--border, #333); border-radius: 6px; }
.sbr-swap-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 6px; margin-bottom: 6px; }
.sbr-cand { position: relative; border: 1px solid var(--border, #333); border-radius: 4px; overflow: hidden; cursor: pointer; padding: 0; background: none; aspect-ratio: 16/9; }
.sbr-cand:hover { border-color: var(--accent, #6ab0f3); }
.sbr-cand img { width: 100%; height: 100%; object-fit: cover; display: block; }
.sbr-cand-prov { position: absolute; bottom: 0; left: 0; right: 0; font-size: 9px; background: rgba(0,0,0,0.6); color: #fff; padding: 1px 3px; }
.sbr-status { font-size: 11px; white-space: nowrap; }
.sbr-status.st-matched, .sbr-status.st-user-swapped { color: #98c379; }
.sbr-status.st-empty { color: #e06c75; }
.sbr-status.st-proposed { color: var(--text-muted, #888); }
.sbr-empty { margin: 8px 0; }
.sbr-actions { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
.sbr-spacer { flex: 1; }
.btn-icon { background: none; border: 1px solid var(--border, #333); border-radius: 4px; cursor: pointer; padding: 2px 7px; }
.btn-icon.danger:hover { border-color: var(--danger, #e06c75); }
</style>
