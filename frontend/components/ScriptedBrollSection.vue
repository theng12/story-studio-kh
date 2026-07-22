<template>
  <div class="settings-section sbr-section mt-2">
    <div class="flex gap-2 items-center justify-between flex-wrap">
      <h4 class="m-0">Scripted B-Roll <span class="sbr-badge">beta</span></h4>
    </div>
    <p class="text-muted text-sm hint-line">
      Automatic shot direction and stock-provider search are paused until GenStudio KH publishes a qualified typed B-Roll route.
      Existing resolved plans still use your <NuxtLink to="/broll-library" class="ffmpeg-inline-link">local B-Roll pools</NuxtLink>
      and can be reviewed, edited, previewed, and assembled safely.
    </p>

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
              <span :class="['sbr-status', 'st-' + b.status]">{{ b.status === 'matched' || b.status === 'user-swapped' ? '✓ clip' : (b.status === 'empty' ? 'none' : 'pending') }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="sbr-actions">
        <button class="btn btn-sm btn-primary" :disabled="!!busy || !dirty" @click="saveEdits">{{ dirty ? 'Save edits' : 'Saved' }}</button>
        <button class="btn btn-sm" :disabled="!matchedCount" :title="matchedCount ? 'Scrub the cut in your browser (no render)' : 'Resolve clips first'" @click="previewOpen = !previewOpen">{{ previewOpen ? '▲ Hide preview' : '▶ Preview cut' }}</button>
        <span class="sbr-spacer" />
        <button class="btn btn-sm btn-icon danger" title="Delete the shot plan" @click="clearPlan">🗑</button>
        <button class="btn btn-sm btn-primary" :disabled="!!busy || !matchedCount" @click="assemble">{{ busy === 'asm' ? 'Queuing…' : '🎬 Assemble video' }}</button>
      </div>

      <BrollPreviewPlayer v-if="previewOpen && matchedCount" :slug="slug" :episode-code="episodeCode" :plan="plan" />
    </template>

    <div v-else-if="!loading" class="text-muted text-sm sbr-empty">
      No shot plan yet. Automatic planning will return after GenStudio KH exposes the typed B-Roll workflow.
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'
import { useBrollPlan, type BrollPlan, type BrollBeat } from '../composables/useBrollPlan.js'

const props = defineProps<{ slug: string; episodeCode: string }>()
const api = useBrollPlan()

const plan = reactive<BrollPlan>({ schema_version: 1, enabled: false, broll_style: '', beats: [] })
const loading = ref(false)
const busy = ref<'' | 'save' | 'asm'>('')
const dirty = ref(false)
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

async function load() {
  if (!props.episodeCode) return
  loading.value = true
  message.value = ''
  try { applyPlan(await api.getPlan(props.slug, props.episodeCode)) }
  catch (e) { setMsg(`Couldn't load the shot plan: ${errOf(e)}`, 'err') }
  finally { loading.value = false }
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
  busy.value = 'save'
  try {
    const r = await api.savePlan(props.slug, props.episodeCode, { ...plan } as BrollPlan)
    applyPlan(r.plan)
    dirty.value = false
    setMsg('Shot plan saved.', 'ok')
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
