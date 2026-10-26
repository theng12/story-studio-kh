<!--
  Generate Songs (music format phase 1, mockup 03). The writing model is picked HERE, every time
  (the last pick is only pre-filled). Code decides what each song is; the model writes the words;
  Stable Audio (or whichever song model is picked) makes the audio on the fleet.
-->
<template>
  <Modal :visible="visible" size="xxl" dialog-class="mp-gen modal-flush" labelledby="mp-gen-title" @close="emit('close')">
    <div class="mp-gen-head">
      <span class="workspace-eyebrow">Song Pool · {{ formulaName || 'Music channel' }}</span>
      <h2 id="mp-gen-title">{{ mode === 'fill-gaps' ? 'Fill Gaps' : 'Generate Songs' }}</h2>
      <p class="mp-hint">
        Writes varied song briefs from your formula, then makes each song on your fleet.
        {{ creditsFree ? 'Nothing here costs credits.' : 'The song model you pick decides the cost, shown below.' }}
      </p>
      <p v-if="sung" class="mp-hint">
        <span class="ds-chip" data-tone="info">songs with lyrics</span>
        The writing model also writes original lyrics and a style line for each song; the song model sings them, at most a
        couple at a time on the 16 GB Macs; the listen-back model checks the words were sung. A take under
        {{ Math.round((songFormula?.lyrics?.min_match ?? 0) * 100) }}% goes to Trash and is sung again (up to {{ songFormula?.lyrics?.max_takes }} takes).
      </p>
    </div>

    <div class="mp-gen-body">
      <p v-if="formulaError" class="error-box">{{ formulaError }}
        <NuxtLink :to="`/projects/${slug}/music-formula`" class="btn btn-sm btn-secondary">Open Music Formula</NuxtLink>
      </p>

      <div class="mp-gen-grid">
        <div>
          <label class="mp-lbl" for="mp-count">How many songs</label>
          <div class="mp-row">
            <input id="mp-count" v-model.number="count" type="number" min="1" max="2000" class="mp-inp" style="width: 110px" @change="cancelPendingSongPoolSubmission">
            <button type="button" class="mp-chip" :class="{ on: count === 50 }" @click="cancelPendingSongPoolSubmission(); count = 50">50</button>
            <button v-if="missing" type="button" class="mp-chip" :class="{ on: count === missing }" @click="cancelPendingSongPoolSubmission(); count = missing">{{ missing }} · to reach {{ needed }}</button>
            <button type="button" class="mp-chip" :class="{ on: count === 500 }" @click="cancelPendingSongPoolSubmission(); count = 500">500</button>
          </div>
          <p class="mp-hint">Briefs are written {{ perCall }} at a time — {{ calls }} call{{ calls === 1 ? '' : 's' }} to the writing model for {{ count || 0 }} songs.</p>
        </div>
        <div>
          <span class="mp-lbl">Song length</span>
          <div class="mp-row">
            <input v-model="minText" class="mp-inp narrow" aria-label="Shortest song (m:ss)" @change="cancelPendingSongPoolSubmission">
            <span>to</span>
            <input v-model="maxText" class="mp-inp narrow" aria-label="Longest song (m:ss)" @change="cancelPendingSongPoolSubmission">
          </div>
          <p class="mp-hint">From the formula. Random within the range<span v-if="musicModel?.max_duration_seconds">; up to {{ clock(musicModel.max_duration_seconds) }} is possible with {{ musicModel.display_name }}</span>.</p>
          <p v-if="lengthError" class="mp-hint mp-warn">{{ lengthError }}</p>
        </div>

        <div>
          <ModelSelector v-model="writerModel" :project-slug="slug" label="Writing model" writing-step @update:model-value="cancelPendingSongPoolSubmission" />
          <p class="mp-hint">
            <span class="ds-chip" data-tone="info">you choose</span>
            Story Studio doesn't pick one for you. This model only writes titles, one descriptive line and a scene idea
            per song{{ sung ? ', plus its lyrics and style line' : '' }} — it does not make the audio.
          </p>
        </div>
        <div>
          <label class="mp-lbl" for="mp-song-model">Song model</label>
          <select id="mp-song-model" v-model="musicModelId" class="mp-inp" style="width: 100%" @change="cancelPendingSongPoolSubmission">
            <option value="" disabled>Pick the model that makes the audio…</option>
            <option v-for="m in songModels" :key="m.id" :value="m.id">{{ m.display_name }} — {{ describeMusicUnitCost(m).text }}</option>
          </select>
          <p class="mp-hint">One song per Mac at a time; free Macs take the next song. Saved as AAC (m4a), about {{ mbPerSong }} MB a song.</p>
          <template v-if="sung">
            <label class="mp-lbl" for="mp-check-model" style="margin-top: 10px">Listen-back model</label>
            <select id="mp-check-model" v-model="checkModelId" class="mp-inp" style="width: 100%" @change="cancelPendingSongPoolSubmission">
              <option value="" disabled>Pick the model that listens back…</option>
              <option v-for="m in checkModels" :key="m.id" :value="m.id">{{ m.display_name }}</option>
            </select>
            <p class="mp-hint">Transcribes each finished song and compares the words with its lyrics. Only free fleet models are listed.</p>
          </template>
          <label class="mp-lbl" for="mp-inflight" style="margin-top: 10px">Songs on the fleet at once</label>
          <input id="mp-inflight" v-model.number="inFlight" type="number" min="1" :max="maxInFlight" class="mp-inp narrow" @change="cancelPendingSongPoolSubmission">
          <p class="mp-hint">Sent to the Gateway together; any it can't start yet waits in its queue for the next free Mac (queue limit {{ maxInFlight }}).</p>

          <span class="mp-lbl" style="margin-top: 10px">Formula</span>
          <div class="mp-row">
            <span class="mp-inp" style="flex: 1">{{ formulaSummary }}</span>
            <NuxtLink :to="`/projects/${slug}/music-formula`" class="btn btn-sm btn-secondary">Edit</NuxtLink>
          </div>
        </div>
      </div>

      <h3 class="mp-gen-h3">What the {{ count || 0 }} songs will cover</h3>
      <p class="mp-hint">Chosen by code before anything is written: every combination is new to the pool, and the thinnest areas come first.</p>
      <table v-if="plan" class="mp-tbl" style="margin-top: 8px">
        <thead><tr><th>#</th><th>Ensemble</th><th>Mood</th><th class="mp-num">Tempo</th><th>Key</th><th>Structure</th><th>Texture</th></tr></thead>
        <tbody>
          <tr v-for="(c, i) in plan.first" :key="c.combo_key">
            <td>{{ i + 1 }}</td><td>{{ c.ensemble }}</td><td>{{ c.mood }}</td><td class="mp-num">{{ c.tempo_bpm }}</td>
            <td>{{ c.key }}</td><td>{{ c.structure }}</td><td>{{ c.texture }}</td>
          </tr>
          <tr v-if="plan.count > plan.first.length">
            <td colspan="7" class="mp-muted">… {{ plan.count - plan.first.length }} more · {{ planTops }} · {{ plan.new_combinations === plan.count ? 'no combination repeats one already in the pool' : `${plan.count - plan.new_combinations} repeat — every combination is already in the pool` }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="planError" class="mp-hint mp-warn">{{ planError }}</p>

      <div v-if="previews.length || previewDropped.length" class="mp-gen-previews">
        <h3 class="mp-gen-h3">5 preview briefs (no audio made)</h3>
        <div v-for="b in previews" :key="b.combo_key" class="mp-gen-preview">
          <b>{{ b.title }}</b> <span class="mp-muted">— {{ b.ensemble }}, {{ b.mood }}, {{ b.tempo_bpm }} BPM, {{ b.key }}</span>
          <div>{{ b.line }}</div>
          <div class="mp-muted">Scene: {{ b.scene_idea }}</div>
          <div v-if="b.style" class="mp-muted">Style: {{ b.style }}</div>
          <div v-if="b.lyrics" class="mp-muted" style="white-space: pre-wrap; margin-top: 4px">{{ b.lyrics }}</div>
        </div>
        <p v-for="d in previewDropped" :key="d.combo_key" class="mp-hint mp-warn">Dropped: {{ d.reason }}</p>
      </div>

      <div class="mp-kpis k4" style="margin-top: 16px">
        <div class="mp-kpi"><span>Time on the fleet</span><b>{{ timeText }}</b></div>
        <div class="mp-kpi"><span>Disk</span><b>{{ diskText }}</b></div>
        <div class="mp-kpi"><span>Writing calls</span><b>{{ calls }}</b></div>
        <div class="mp-kpi" :data-tone="creditsFree ? 'success' : 'warning'"><span>Credits</span><b>{{ creditsFree ? 'Free' : (musicModel ? describeMusicUnitCost(musicModel).text : '—') }}</b></div>
      </div>
      <p class="mp-hint">{{ timeHint }}</p>
      <p v-if="startError" class="error-box">{{ startError }}</p>
    </div>

    <div class="mp-gen-foot">
      <button type="button" class="btn btn-secondary" @click="emit('close')">Cancel</button>
      <div class="mp-row" style="align-items: flex-start">
        <div class="mp-btnhint">
          <button type="button" class="btn btn-secondary" :disabled="!writerModel || previewing || !!formulaError" @click="previewBriefs">{{ previewing ? 'Writing…' : 'Preview 5 Briefs' }}</button>
          <span class="mp-hint">Writes 5 briefs only — no audio — so you can check the formula.</span>
        </div>
        <div class="mp-btnhint">
          <button type="button" class="btn btn-primary" :disabled="!!disabledReason || starting" @click="start">{{ starting ? 'Starting…' : 'Start Generation' }}</button>
          <span class="mp-hint">{{ disabledReason || 'Runs in the background. Songs appear in the pool as they finish.' }}</span>
        </div>
      </div>
    </div>
  </Modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { describeMusicUnitCost, type PricedMusicModel } from '../../utils/genstudio-credit-cost.js'
import { UNCONFIRMED_SUBMISSION } from '../../composables/useFreshGenerationAction'
import { normalizeDefaultModels } from '../../utils/live-genstudio-model-selection.js'

interface SongModel extends PricedMusicModel { id: string; display_name: string; max_duration_seconds?: number; supports_vocals?: boolean | null }
interface PlanCell { combo_key: string; ensemble: string; mood: string; tempo_bpm: number; key: string; structure: string; texture: string; tempo_band: string }

const props = defineProps<{
  visible: boolean
  slug: string
  mode: 'new' | 'fill-gaps'
  initialCount?: number
  formulaName?: string
  formulaError?: string
  songFormula?: any
  missing?: number | null
  needed?: number | null
  averageSongS?: number
  averageGenerationS?: number | null
}>()
const emit = defineEmits<{ close: []; started: [job: any] }>()
const { get, post } = useApi()
const fresh = useFreshGenerationAction()
const { showAction } = useToast()

interface PendingSongPoolSubmission {
  projectSlug: string
  body: Record<string, unknown>
  operationId: string
  attempted: boolean
}

const storeKey = (what: string) => `story-studio:song-pool:${what}:${props.slug}`
const recall = (what: string) => { try { return localStorage.getItem(storeKey(what)) || '' } catch { return '' } }
const remember = (what: string, v: string) => { try { localStorage.setItem(storeKey(what), v) } catch { /* private window */ } }

const count = ref(50)
const minText = ref('3:00')
const maxText = ref('4:30')
const writerModel = ref('')
const musicModelId = ref('')
const checkModelId = ref('')
const checkModels = ref<Array<{ id: string; display_name: string }>>([])
const inFlight = ref(16)
const maxInFlight = ref(256)
const songModels = ref<SongModel[]>([])
const plan = ref<{ first: PlanCell[]; count: number; new_combinations: number; by_mood: Record<string, number>; by_tempo_band: Record<string, number> } | null>(null)
const planError = ref('')
const previews = ref<any[]>([])
const previewDropped = ref<any[]>([])
const previewing = ref(false)
const starting = ref(false)
const startError = ref('')
const pendingSongPoolSubmission = ref<PendingSongPoolSubmission | null>(null)
let postingOperationId = ''

const missing = computed(() => Math.max(0, props.missing || 0))
const needed = computed(() => props.needed || 0)
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
const parseClock = (t: string) => { const m = /^\s*(\d+):(\d{1,2})\s*$/.exec(t); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN }
const minS = computed(() => parseClock(minText.value))
const maxS = computed(() => parseClock(maxText.value))
const lengthError = computed(() => !(minS.value > 0 && maxS.value > 0) ? 'Write lengths as m:ss, for example 3:00.'
  : minS.value > maxS.value ? 'The shortest song must not be longer than the longest.'
  : props.songFormula && musicModel.value?.max_duration_seconds && maxS.value > musicModel.value.max_duration_seconds ? `${musicModel.value.display_name} makes songs up to ${clock(musicModel.value.max_duration_seconds)}.` : '')
// Songs with lyrics: the channel's switch (Music Formula). Sung answers are long, so 4 per call (song-brief.ts).
const sung = computed(() => props.songFormula?.lyrics?.enabled === true)
const perCall = computed(() => sung.value ? 4 : 20)
const calls = computed(() => Math.ceil(Math.max(0, count.value || 0) / perCall.value))
const musicModel = computed(() => songModels.value.find(m => m.id === musicModelId.value) || null)
const creditsFree = computed(() => musicModel.value?.price_source === 'local')
const avgLen = computed(() => (minS.value + maxS.value) / 2 || props.averageSongS || 0)
const mbPerSong = computed(() => avgLen.value ? Math.round((avgLen.value * 256) / 8 / 1024) : '≈7')
const diskText = computed(() => {
  const gb = ((count.value || 0) * avgLen.value * 256) / 8 / 1024 / 1024
  return gb >= 1 ? `≈ ${gb.toFixed(1)} GB` : `≈ ${Math.round(gb * 1024)} MB`
})
const timeText = computed(() => {
  if (!props.averageGenerationS) return 'Not known yet'
  const waves = Math.ceil((count.value || 0) / Math.max(1, inFlight.value || 1))
  const min = Math.round((waves * props.averageGenerationS) / 60)
  return min >= 90 ? `≈ ${(min / 60).toFixed(1)} h` : `≈ ${min} min`
})
const timeHint = computed(() => props.averageGenerationS
  ? `From this pool's recent songs (about ${props.averageGenerationS} s each from submit to saved), ${inFlight.value} at once — slower if fewer Macs are free.`
  : 'The time is shown once this pool has finished a few songs; Story Studio does not guess it.')
const formulaSummary = computed(() => {
  const f = props.songFormula
  if (!f) return props.formulaError ? 'No song formula saved yet' : '…'
  const live = (xs: any[]) => xs.filter((x: any) => x.weight > 0).length
  return `${props.formulaName || 'This channel'} — ${live(f.ensembles)} ensembles · ${live(f.moods)} moods · ${live(f.tempo_bands)} tempos · ${f.keys.length || 24} keys · ${live(f.structures)} structures`
})
const planTops = computed(() => {
  if (!plan.value) return ''
  const top = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1])[0]
  const mood = top(plan.value.by_mood)
  const band = top(plan.value.by_tempo_band)
  const bandLabel = props.songFormula?.tempo_bands?.find((b: any) => b.id === band?.[0])?.label || band?.[0]
  return [mood && `${mood[0]} ${mood[1]}`, band && `${bandLabel} tempo ${band[1]}`].filter(Boolean).join(' · ')
})
const disabledReason = computed(() => props.formulaError ? 'Save the Music Formula first.'
  : !writerModel.value ? 'Pick the writing model first.'
  : !musicModelId.value ? 'Pick the song model first.'
  : sung.value && !checkModelId.value ? 'Pick the listen-back model first.'
  : !(count.value >= 1 && count.value <= 2000) ? 'Choose between 1 and 2,000 songs.'
  : lengthError.value ? lengthError.value
  : !(inFlight.value >= 1 && inFlight.value <= maxInFlight.value) ? `Send between 1 and ${maxInFlight.value} songs at once.` : '')

async function loadModels() {
  try {
    const r = await get<{ models: SongModel[] }>('/app-settings/genstudio/music-models')
    // Instrumental channels: a lyrics-only model cannot make their songs. Songs with lyrics: only models that sing.
    songModels.value = (r.models || []).filter(m => sung.value
      ? (m.requires_lyrics === true || m.supports_vocals === true)
      : (m.requires_lyrics !== true && m.supports_instrumental !== false))
  } catch { songModels.value = [] }
  if (sung.value) {
    try {
      const t = await get<{ models: Array<{ id: string; display_name: string; price_source?: string }> }>('/app-settings/genstudio/transcription-models')
      checkModels.value = (t.models || []).filter(m => m.price_source === 'local')
    } catch { checkModels.value = [] }
    const lastCheck = recall('check-model')
    checkModelId.value = checkModels.value.some(m => m.id === lastCheck) ? lastCheck : ''
  }
  const last = recall('music-model')
  // Order: the model this dialog last used → the app-wide default (Settings → Default models) →
  // the first free fleet model. The default is READ, never written back, so changing it later
  // still reaches this dialog.
  // Settings → Default models, read here rather than from a composable: this dialog already holds
  // the live song catalogue, so one settings read is cheaper than a second cache to keep fresh.
  const appDefault = normalizeDefaultModels(
    await get('/app-settings/default-models', { cache: 'no-store' }).catch(() => null),
  ).music
  const usable = (id: string | null | undefined): boolean => !!id && songModels.value.some(m => m.id === id)
  musicModelId.value = usable(last) ? last!
    : usable(appDefault) ? appDefault!
      : (songModels.value.find(m => m.price_source === 'local')?.id || '')
  try {
    const a = await get<any>('/app-settings/genstudio/admission')
    const cap = Number(a?.max_queued_jobs ?? a?.value?.max_queued_jobs)
    if (Number.isInteger(cap) && cap > 0) maxInFlight.value = cap
  } catch { /* the Gateway's own 256 stays the bound */ }
}

let planTimer: ReturnType<typeof setTimeout> | null = null
function replan() {
  if (planTimer) clearTimeout(planTimer)
  planTimer = setTimeout(async () => {
    if (props.formulaError || !(count.value >= 1)) { plan.value = null; return }
    try {
      planError.value = ''
      plan.value = await post(`/projects/${props.slug}/song-pool/plan`, { count: count.value, length_min_s: minS.value || undefined, length_max_s: maxS.value || undefined })
    } catch (e: any) { plan.value = null; planError.value = e?.data?.detail || 'Could not plan the songs.' }
  }, 250)
}

async function previewBriefs() {
  previewing.value = true
  startError.value = ''
  try {
    const r = await post<{ briefs: any[]; dropped: any[] }>(`/projects/${props.slug}/song-pool/preview-briefs`, { writer_model: writerModel.value, length_min_s: minS.value, length_max_s: maxS.value })
    previews.value = r.briefs; previewDropped.value = r.dropped
  } catch (e: any) { startError.value = e?.data?.detail || 'Could not write the preview briefs.' }
  finally { previewing.value = false }
}

function cancelPendingSongPoolSubmission() {
  const pending = pendingSongPoolSubmission.value
  if (pending) fresh.complete(pending.operationId)
  pendingSongPoolSubmission.value = null
  if (pending && postingOperationId === pending.operationId) {
    postingOperationId = ''
    starting.value = false
  }
}

function currentStartBody() {
  return {
    mode: props.mode, count: count.value, writer_model: writerModel.value, music_model: musicModelId.value,
    length_min_s: minS.value, length_max_s: maxS.value, in_flight: inFlight.value,
    ...(sung.value ? { check_model: checkModelId.value } : {}),
  }
}

function submissionIsCurrent(submission: PendingSongPoolSubmission) {
  return pendingSongPoolSubmission.value?.operationId === submission.operationId
    && pendingSongPoolSubmission.value.projectSlug === submission.projectSlug
    && props.visible && props.slug === submission.projectSlug
    && props.mode === submission.body.mode
}

async function submitStart(submission: PendingSongPoolSubmission) {
  if (!submissionIsCurrent(submission)) return
  if (!submission.attempted && (submission.projectSlug !== props.slug
    || JSON.stringify(submission.body) !== JSON.stringify(currentStartBody()))) {
    cancelPendingSongPoolSubmission()
    startError.value = 'The project or generation choices changed. Review them and start again.'
    return
  }
  starting.value = true
  postingOperationId = submission.operationId
  startError.value = ''
  submission.attempted = true
  try {
    const job = await post(`/projects/${submission.projectSlug}/song-pool/generate`, { ...submission.body, operation_id: submission.operationId })
    if (submissionIsCurrent(submission)) {
      fresh.complete(submission.operationId)
      pendingSongPoolSubmission.value = null
      remember('writer-model', String(submission.body.writer_model || ''))
      remember('music-model', String(submission.body.music_model || ''))
      remember('in-flight', String(submission.body.in_flight || ''))
      if (submission.body.check_model) remember('check-model', String(submission.body.check_model))
      emit('started', job)
    }
  } catch (e: any) {
    if (!submissionIsCurrent(submission)) return
    const detail = e?.data?.detail || e?.response?._data?.detail
    if (detail) {
      fresh.complete(submission.operationId)
      pendingSongPoolSubmission.value = null
      startError.value = detail
    } else {
      startError.value = UNCONFIRMED_SUBMISSION
      showAction(UNCONFIRMED_SUBMISSION, 'Retry', () => submitStart(submission))
    }
  } finally {
    if (postingOperationId === submission.operationId) {
      postingOperationId = ''
      starting.value = false
    }
  }
}

async function start() {
  const body = JSON.parse(JSON.stringify(currentStartBody())) as Record<string, unknown>
  const operationId = fresh.begin(body, 'song-pool-generation')
  const submission: PendingSongPoolSubmission = { projectSlug: props.slug, body, operationId, attempted: false }
  pendingSongPoolSubmission.value = submission
  await submitStart(submission)
}

watch(() => props.visible, (open) => {
  if (!open) { cancelPendingSongPoolSubmission(); return }
  const f = props.songFormula
  if (f?.length_s) { minText.value = clock(f.length_s.min); maxText.value = clock(f.length_s.max) }
  count.value = props.initialCount && props.initialCount > 0 ? props.initialCount : (props.mode === 'fill-gaps' && missing.value ? missing.value : 50)
  writerModel.value = recall('writer-model')
  inFlight.value = Number(recall('in-flight')) || 16
  previews.value = []; previewDropped.value = []; startError.value = ''
  void loadModels()
  replan()
}, { immediate: true })
watch(() => [props.slug, props.mode] as const, () => cancelPendingSongPoolSubmission())
watch([count, minText, maxText], replan)
</script>

<style>
.mp-gen { padding: 0; }
.mp-gen-head { padding: 22px 24px 12px; border-bottom: 1px solid var(--border); }
.mp-gen-head h2 { margin: 4px 0 2px; font-size: 22px; }
.mp-gen-body { padding: 16px 24px; max-height: 68vh; overflow-y: auto; }
.mp-gen-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px 28px; }
.mp-gen-h3 { font-size: 15px; margin: 18px 0 2px; }
.mp-gen-foot { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 14px 24px 18px; border-top: 1px solid var(--border); }
.mp-gen-preview { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; margin-top: 6px; font-size: 13px; }
</style>
<style src="~/assets/css/music-pool.css"></style>
