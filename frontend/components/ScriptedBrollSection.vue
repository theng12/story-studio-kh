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
      <button class="btn btn-primary" :disabled="!model || busy || !episodeCode" @click="generate">
        {{ busy === 'gen' ? 'Directing…' : '🎬 Generate shot plan' }}
      </button>
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
          <span class="sbr-time">{{ b.start_sec.toFixed(1) }}–{{ b.end_sec.toFixed(1) }}s</span>
          <div class="sbr-beat-main">
            <div class="sbr-line">{{ b.line || '—' }}</div>
            <div class="sbr-queries">
              <span v-for="(q, qi) in b.queries" :key="qi" class="sbr-query">{{ q }}</span>
              <span v-if="!b.queries.length" class="text-muted">no queries</span>
            </div>
            <div v-if="b.clip" class="sbr-clip">🎞 {{ b.clip }}</div>
          </div>
          <span :class="['sbr-status', 'st-' + b.status]">{{ b.status === 'matched' || b.status === 'user-swapped' ? '✓ clip' : (b.status === 'empty' ? 'none' : 'pending') }}</span>
        </div>
      </div>

      <div class="sbr-actions">
        <button class="btn btn-sm" :disabled="busy" @click="resolve">{{ busy === 'res' ? 'Downloading…' : '⬇ Download / re-match clips' }}</button>
        <span class="sbr-spacer" />
        <button class="btn btn-sm btn-icon danger" title="Delete the shot plan" @click="clearPlan">🗑</button>
        <button class="btn btn-sm btn-primary" :disabled="busy || !matchedCount" @click="assemble">{{ busy === 'asm' ? 'Queuing…' : '🎬 Assemble video' }}</button>
      </div>
    </template>

    <div v-else-if="!loading" class="text-muted text-sm sbr-empty">
      No shot plan yet — generate one from the narration above.
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'
import { useBrollPlan, type BrollPlan, type GenerateResult } from '../composables/useBrollPlan.js'

const props = defineProps<{ slug: string; episodeCode: string }>()
const api = useBrollPlan()

const plan = reactive<BrollPlan>({ schema_version: 1, enabled: false, broll_style: '', beats: [] })
const model = ref('')
const beatSec = ref(5)
const styleHint = ref('')
const resolveNow = ref(true)
const loading = ref(false)
const busy = ref<'' | 'gen' | 'res' | 'asm'>('')
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
}
function resolveNote(r: GenerateResult): string {
  if (r.resolve_skipped_reason) return ` (download skipped: ${r.resolve_skipped_reason})`
  if (typeof r.matched === 'number') return ` Downloaded ${r.downloaded ?? 0}, ${r.matched} beat(s) now have a clip.`
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
    const r = await api.resolve(props.slug, props.episodeCode, { ...plan } as BrollPlan)
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

async function clearPlan() {
  try {
    await api.deletePlan(props.slug, props.episodeCode)
    applyPlan({ schema_version: 1, enabled: false, broll_style: '', beats: [] })
    setMsg('Shot plan cleared.', 'ok')
  } catch (e) { setMsg(errOf(e), 'err') }
}

watch(() => props.episodeCode, load, { immediate: true })
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
