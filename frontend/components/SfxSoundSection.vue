<template>
  <div class="settings-section sfx-section mt-2">
    <div class="flex gap-2 items-center justify-between flex-wrap">
      <h4 class="m-0">
        Sound / SFX <span class="sfx-badge">optional</span>
        <button type="button" class="sfx-toggle" @click="expanded = !expanded">
          {{ expanded ? '▾ hide' : '▸ set up' }}
        </button>
      </h4>
      <label class="sfx-enable" title="Master switch. Off = the render is exactly as it is today.">
        <input type="checkbox" v-model="enabled" @change="onEnableToggle" />
        <span>Apply SFX to this video</span>
      </label>
    </div>

    <!-- v1.0.510 — collapsed by default. Video generation NEVER uses the sound
         director LLM; this whole section is opt-in. Collapsing it keeps the
         slow "Generate from narration" button (which cold-loads a local LLM)
         out of the render flow for the common case of not wanting SFX. -->
    <p v-if="!expanded" class="text-muted text-sm hint-line">
      Optional layer — leave it closed to render with your original audio (no AI, nothing to load).
      Open it only if you want ambient beds + spot effects mixed under the narration.
    </p>

    <template v-if="expanded">
    <p class="text-muted text-sm hint-line">
      An LLM sound director reads this episode's <strong>subtitle timing</strong> and proposes ambient beds + spot
      effects, drawn from your <NuxtLink to="/broll-library" class="ffmpeg-inline-link">SFX pools</NuxtLink>.
      Mixed under the narration at render time — nothing here changes the video until you enable it and a cue resolves to a clip.
    </p>

    <!-- Generate controls -->
    <div class="sfx-gen-row">
      <div class="sfx-gen-model">
        <label class="sfx-lbl">Director model</label>
        <ModelSelector v-model="model" :project-slug="slug" />
      </div>
      <div class="sfx-gen-intensity">
        <label class="sfx-lbl">Density</label>
        <select v-model="intensity" class="select">
          <option value="minimal">Minimal — barely any</option>
          <option value="moderate">Moderate — sparse (default)</option>
          <option value="rich">Rich — a little more</option>
        </select>
      </div>
      <button class="btn btn-primary sfx-gen-btn" :disabled="!model || generating || !episodeCode" @click="generate">
        {{ generating ? 'Directing…' : '🎬 Generate from narration' }}
      </button>
    </div>

    <!-- v1.0.510 — set the expectation for the local-model cold-load, which is
         what "the AI model is taking forever" actually is: Chat Studio loading
         the weights into memory on first use. Cloud/free models skip this. -->
    <p v-if="generating && directorIsLocal" class="text-muted text-sm sfx-loadnote">
      ⏳ Loading the local model into memory (Chat Studio). The <strong>first</strong> run can take 30–60s;
      later runs are fast. Tip: for this light task a free cloud model directs almost instantly.
    </p>

    <label class="sfx-autofetch" title="For cues your pools don't cover, download a matching effect from Freesound into your SFX pool — so the pool grows with every video. First videos are slower; later ones mostly reuse what's already there.">
      <input type="checkbox" v-model="autoFetch" />
      <span>Auto-fetch missing effects from Freesound (seeds your SFX pool)</span>
    </label>

    <p v-if="message" :class="['sfx-msg', messageKind]">{{ message }}</p>

    <div v-if="loading" class="text-muted text-sm">Loading sound plan…</div>

    <template v-else>
      <!-- Summary -->
      <div class="sfx-summary text-sm text-muted" v-if="plan.beds.length || plan.spots.length">
        {{ plan.beds.length }} bed(s), {{ plan.spots.length }} spot(s) ·
        <strong :class="liveCount ? 'sfx-live' : ''">{{ liveCount }} live</strong>,
        {{ emptyCount }} unmatched
        <span v-if="emptyCount" class="sfx-hint"> — add matching clips to your SFX pools, then “Re-match”.</span>
      </div>

      <!-- Beds -->
      <div class="sfx-group" v-if="plan.beds.length">
        <div class="sfx-group-head">Ambient beds</div>
        <div v-for="(b, i) in plan.beds" :key="'b' + i" class="sfx-row">
          <input v-model="b.label" class="input sfx-label" placeholder="ambience label" @input="markDirty" />
          <span class="sfx-time">
            <input type="number" v-model.number="b.start_sec" class="input sfx-num" min="0" step="0.1" @input="markDirty" />–
            <input type="number" v-model.number="b.end_sec" class="input sfx-num" min="0" step="0.1" @input="markDirty" />s
          </span>
          <select :value="cueKey(b)" class="select sfx-clip" @change="onSwap(b, $event)">
            <option value="">— no clip —</option>
            <option v-for="c in candidates" :key="c.pool_id + '/' + c.filename" :value="c.pool_id + '/' + c.filename">
              {{ c.filename }}
            </option>
          </select>
          <span class="sfx-gain">
            <input type="number" v-model.number="b.gain_db" class="input sfx-num" step="1" @input="markDirty" />dB
          </span>
          <span :class="['sfx-status', 'st-' + b.status]">{{ statusLabel(b) }}</span>
          <button class="btn-icon" :title="b.status === 'muted' ? 'Unmute' : 'Mute'" @click="toggleMute(b)">{{ b.status === 'muted' ? '🔇' : '🔊' }}</button>
          <button class="btn-icon danger" title="Remove" @click="plan.beds.splice(i, 1); markDirty()">✕</button>
        </div>
      </div>

      <!-- Spots -->
      <div class="sfx-group" v-if="plan.spots.length">
        <div class="sfx-group-head">Spot effects</div>
        <div v-for="(s, i) in plan.spots" :key="'s' + i" class="sfx-row">
          <input v-model="s.label" class="input sfx-label" placeholder="effect label" @input="markDirty" />
          <span class="sfx-time">@
            <input type="number" v-model.number="s.at_sec" class="input sfx-num" min="0" step="0.1" @input="markDirty" />s
          </span>
          <select :value="cueKey(s)" class="select sfx-clip" @change="onSwap(s, $event)">
            <option value="">— no clip —</option>
            <option v-for="c in candidates" :key="c.pool_id + '/' + c.filename" :value="c.pool_id + '/' + c.filename">
              {{ c.filename }}
            </option>
          </select>
          <span class="sfx-gain">
            <input type="number" v-model.number="s.gain_db" class="input sfx-num" step="1" @input="markDirty" />dB
          </span>
          <span :class="['sfx-status', 'st-' + s.status]">{{ statusLabel(s) }}</span>
          <button class="btn-icon" :title="s.status === 'muted' ? 'Unmute' : 'Mute'" @click="toggleMute(s)">{{ s.status === 'muted' ? '🔇' : '🔊' }}</button>
          <button class="btn-icon danger" title="Remove" @click="plan.spots.splice(i, 1); markDirty()">✕</button>
        </div>
      </div>

      <div v-if="!plan.beds.length && !plan.spots.length" class="text-muted text-sm sfx-empty">
        No sound plan yet. Generate one from the narration above, or add cues manually.
      </div>

      <!-- Actions -->
      <div class="sfx-actions">
        <button class="btn btn-sm btn-secondary" @click="addBed">+ Bed</button>
        <button class="btn btn-sm btn-secondary" @click="addSpot">+ Spot</button>
        <span class="sfx-spacer" />
        <button class="btn btn-sm" :disabled="generating || (!candidates.length && !autoFetch)" title="Re-match unresolved cues against your SFX pools (and auto-fetch missing ones if enabled)" @click="rematch">↻ Re-match{{ autoFetch ? ' + fetch' : '' }}</button>
        <button class="btn btn-sm btn-primary" :disabled="!dirty || saving" @click="save">{{ saving ? 'Saving…' : (dirty ? 'Save plan' : 'Saved') }}</button>
        <button class="btn btn-sm btn-icon danger" title="Delete the plan (reverts to no SFX)" @click="clearPlan">🗑</button>
      </div>
    </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'
import { useSfxPlan, type SfxPlan, type SfxBed, type SfxSpot, type SfxCandidate } from '../composables/useSfxPlan.js'

const props = defineProps<{ slug: string; episodeCode: string }>()

const api = useSfxPlan()

const plan = reactive<SfxPlan>({ schema_version: 1, enabled: false, beds: [], spots: [] })
const candidates = ref<SfxCandidate[]>([])
const model = ref('')
const intensity = ref('moderate')
const autoFetch = ref(true)
const loading = ref(false)
const generating = ref(false)
const saving = ref(false)
const dirty = ref(false)
const message = ref('')
const messageKind = ref<'ok' | 'err'>('ok')
// v1.0.510 — collapsed by default; auto-opens only when this episode already
// has SFX enabled or a saved plan (see load()). Keeps the slow, opt-in
// director button out of the render flow for the common no-SFX case.
const expanded = ref(false)
// Local LLMs (chatstudio:*) cold-load into memory on first use — that's the
// "model taking forever" the user sees. Cloud/free models don't. Drives the
// loading-expectation note.
const directorIsLocal = computed(() => model.value.startsWith('chatstudio:'))

// enabled proxied so toggling marks dirty + writes back into the reactive plan
const enabled = computed({
  get: () => plan.enabled,
  set: (v: boolean) => { plan.enabled = v },
})

const liveCount = computed(() =>
  [...plan.beds, ...plan.spots].filter(c => c.clip && c.source && c.status !== 'muted' && c.status !== 'empty').length,
)
const emptyCount = computed(() =>
  [...plan.beds, ...plan.spots].filter(c => !c.clip || c.status === 'empty').length,
)

function markDirty() { dirty.value = true }
// Turning SFX on from the collapsed header expands the setup so the controls
// are visible; turning it off leaves whatever the user had open.
function onEnableToggle() {
  markDirty()
  if (plan.enabled) expanded.value = true
}
function setMsg(text: string, kind: 'ok' | 'err' = 'ok') { message.value = text; messageKind.value = kind }
function errOf(e: any): string { return e?.data?.detail || e?.message || String(e) }

function applyPlan(p: SfxPlan) {
  plan.schema_version = 1
  plan.enabled = !!p.enabled
  plan.beds = p.beds || []
  plan.spots = p.spots || []
}

async function load() {
  if (!props.episodeCode) return
  loading.value = true
  message.value = ''
  try {
    const [p, c] = await Promise.all([
      api.getPlan(props.slug, props.episodeCode),
      api.candidates(props.slug, props.episodeCode).catch(() => ({ candidates: [] })),
    ])
    applyPlan(p)
    candidates.value = c.candidates || []
    dirty.value = false
    // Open the section only if this episode is actually using SFX.
    expanded.value = plan.enabled || plan.beds.length > 0 || plan.spots.length > 0
  } catch (e) {
    setMsg(`Couldn't load the sound plan: ${errOf(e)}`, 'err')
  } finally {
    loading.value = false
  }
}

function fetchNote(res: { fetched?: string[]; fetch_skipped_reason?: string }): string {
  if (res.fetch_skipped_reason) return ` (auto-fetch skipped: ${res.fetch_skipped_reason})`
  if (res.fetched && res.fetched.length) return ` Fetched ${res.fetched.length} new sound(s) from Freesound into your pool.`
  return ''
}

async function generate() {
  generating.value = true
  message.value = ''
  try {
    const res = await api.generate(props.slug, props.episodeCode, { model: model.value, intensity: intensity.value, auto_fetch: autoFetch.value })
    applyPlan(res.plan)
    if (res.fetched?.length) await reloadCandidates()
    dirty.value = false
    setMsg(`Directed ${plan.beds.length} bed(s) + ${plan.spots.length} spot(s); ${liveCount.value} matched.${fetchNote(res)}`, 'ok')
  } catch (e) {
    setMsg(errOf(e), 'err')
  } finally {
    generating.value = false
  }
}

async function rematch() {
  generating.value = true
  message.value = ''
  try {
    const res = await api.resolvePlan(props.slug, props.episodeCode, { ...plan } as SfxPlan, { auto_fetch: autoFetch.value })
    applyPlan(res.plan)
    if (res.fetched?.length) await reloadCandidates()
    dirty.value = false
    setMsg(`Re-matched against ${res.candidate_count} pool clip(s); ${liveCount.value} live.${fetchNote(res)}`, 'ok')
  } catch (e) {
    setMsg(errOf(e), 'err')
  } finally {
    generating.value = false
  }
}

async function reloadCandidates() {
  try {
    const c = await api.candidates(props.slug, props.episodeCode)
    candidates.value = c.candidates || []
  } catch { /* keep existing */ }
}

async function save() {
  saving.value = true
  try {
    await api.savePlan(props.slug, props.episodeCode, { ...plan } as SfxPlan)
    dirty.value = false
    setMsg('Sound plan saved.', 'ok')
  } catch (e) {
    setMsg(errOf(e), 'err')
  } finally {
    saving.value = false
  }
}

async function clearPlan() {
  try {
    await api.deletePlan(props.slug, props.episodeCode)
    applyPlan({ schema_version: 1, enabled: false, beds: [], spots: [] })
    dirty.value = false
    setMsg('Sound plan cleared — this video renders with the original audio.', 'ok')
  } catch (e) {
    setMsg(errOf(e), 'err')
  }
}

function addBed() {
  plan.beds.push({ label: '', start_sec: 0, end_sec: 10, source: '', clip: '', gain_db: -20, status: 'proposed' } as SfxBed)
  markDirty()
}
function addSpot() {
  plan.spots.push({ label: '', at_sec: 0, source: '', clip: '', gain_db: -12, status: 'proposed' } as SfxSpot)
  markDirty()
}

function cueKey(c: SfxBed | SfxSpot): string {
  return c.clip && c.pool_id ? `${c.pool_id}/${c.clip}` : ''
}
function onSwap(c: SfxBed | SfxSpot, ev: Event) {
  const key = (ev.target as HTMLSelectElement).value
  if (!key) {
    c.source = ''; c.pool_id = undefined; c.clip = ''; c.status = 'empty'
  } else {
    const slash = key.indexOf('/')
    c.pool_id = key.slice(0, slash)
    c.clip = key.slice(slash + 1)
    c.source = 'pool'
    c.status = 'user-swapped'
  }
  markDirty()
}
function toggleMute(c: SfxBed | SfxSpot) {
  c.status = c.status === 'muted' ? (c.clip ? 'matched' : 'proposed') : 'muted'
  markDirty()
}
function statusLabel(c: SfxBed | SfxSpot): string {
  if (c.status === 'muted') return 'muted'
  if (!c.clip) return 'no clip'
  if (c.status === 'user-swapped') return 'pinned'
  return 'matched'
}

watch(() => props.episodeCode, load, { immediate: true })
</script>

<style scoped>
.sfx-section { border-top: 1px solid var(--border, #2a2a2a); padding-top: 12px; }
.sfx-badge { font-size: 11px; font-weight: 400; color: var(--text-muted, #888); border: 1px solid var(--border, #333); border-radius: 4px; padding: 1px 5px; margin-left: 6px; vertical-align: middle; }
.sfx-toggle { background: none; border: none; color: var(--accent, #6ab0f3); cursor: pointer; font-size: 12px; margin-left: 8px; padding: 0; vertical-align: middle; }
.sfx-toggle:hover { text-decoration: underline; }
.sfx-loadnote { margin-top: 6px; padding: 6px 10px; border-left: 2px solid var(--accent, #6ab0f3); background: rgba(106, 176, 243, 0.06); border-radius: 0 4px 4px 0; }
.sfx-enable { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
.sfx-gen-row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; margin-top: 8px; }
.sfx-gen-model { min-width: 220px; flex: 1; }
.sfx-lbl { display: block; font-size: 12px; color: var(--text-muted, #888); margin-bottom: 3px; }
.sfx-gen-btn { white-space: nowrap; }
.sfx-msg { font-size: 13px; margin-top: 8px; }
.sfx-msg.ok { color: var(--accent, #6ab0f3); }
.sfx-msg.err { color: var(--danger, #e06c75); }
.sfx-summary { margin: 10px 0 4px; }
.sfx-live { color: var(--accent, #6ab0f3); }
.sfx-hint { color: var(--text-muted, #888); }
.sfx-group { margin-top: 10px; }
.sfx-group-head { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted, #888); margin-bottom: 4px; }
.sfx-row { display: flex; gap: 6px; align-items: center; margin-bottom: 5px; flex-wrap: wrap; }
.sfx-label { flex: 1; min-width: 130px; }
.sfx-time { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; color: var(--text-muted, #888); }
.sfx-num { width: 62px; }
.sfx-clip { max-width: 200px; }
.sfx-gain { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; color: var(--text-muted, #888); }
.sfx-status { font-size: 11px; border-radius: 4px; padding: 1px 6px; border: 1px solid var(--border, #333); }
.sfx-status.st-matched { color: #98c379; }
.sfx-status.st-user-swapped { color: #6ab0f3; }
.sfx-status.st-empty { color: #e06c75; }
.sfx-status.st-proposed { color: var(--text-muted, #888); }
.sfx-status.st-muted { color: var(--text-muted, #888); opacity: 0.7; }
.sfx-empty { margin: 8px 0; }
.sfx-actions { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
.sfx-spacer { flex: 1; }
.btn-icon { background: none; border: 1px solid var(--border, #333); border-radius: 4px; cursor: pointer; padding: 2px 7px; }
.btn-icon.danger:hover { border-color: var(--danger, #e06c75); }
</style>
