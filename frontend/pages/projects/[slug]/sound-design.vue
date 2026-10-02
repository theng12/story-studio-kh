<template>
  <div class="workspace-page sound-design-workspace">
    <WorkspaceHero eyebrow="Assembly · Optional" title="Sound Design" description="Place reviewed ambient beds and spot effects against the finished narration. Video Assembly uses only the cues you approve here.">
      <template #aside>
        <div class="workspace-metrics">
          <span class="workspace-metric"><strong>{{ approvedCount }}</strong> approved</span>
          <span class="workspace-metric" :data-tone="unresolvedCount ? 'warning' : 'success'"><strong>{{ unresolvedCount }}</strong> to review</span>
        </div>
      </template>
    </WorkspaceHero>

    <div class="workspace-command-surface">
      <TopActionBar
        :project-slug="slug"
        v-model:episode-id="episodeId"
        filter-field="scene_plan"
        :presets="presets"
        generate-label="Add spot effect"
        :generate-disabled="!config.enabled || !episodeId"
        :generate-status="actionStatus"
        @generate="addSpot"
      />
    </div>

    <section class="card sound-command">
      <div>
        <span class="section-kicker">Project setting</span>
        <h2>Use Sound Design</h2>
        <p>Off by default. When enabled, Final Video requires every Sound Design cue to be approved or excluded.</p>
      </div>
      <label class="sound-switch"><input v-model="config.enabled" type="checkbox" :disabled="savingConfig" @change="saveConfig" /><span>{{ config.enabled ? 'Enabled' : 'Disabled' }}</span></label>
    </section>

    <section class="card sound-settings">
      <div>
        <span class="section-kicker">Saved setup</span>
        <h2>Set safe pacing and mix defaults</h2>
        <p>Save these as a preset to reuse them on other episodes. Sounds come from your own sound-effect folders (SFX pools in the B-Roll Library).</p>
      </div>
      <div class="sound-settings-controls">
        <label class="sound-setting-field" title="Controls how frequently Sound Design suggests ambience and one-off effects. Minimal is safest for narration-first videos; Rich creates a busier soundscape.">
          <span class="setting-label-row"><span>Sound density</span><span class="setting-purpose">Frequency</span></span>
          <select v-model="settings.density" class="select" aria-describedby="sound-density-help"><option value="minimal">Minimal — sparse and documentary-safe</option><option value="balanced">Balanced — selective emphasis</option><option value="rich">Rich — use with care</option></select>
          <small id="sound-density-help" class="setting-help">How often ambience and effects appear. Use Minimal for voice-led videos; Rich adds more sonic activity.</small>
        </label>
        <label class="sound-setting-field" title="Sets a hard pacing limit for short one-off effects. Lower values leave more room for narration. A range of 2–4 per minute is a safe starting point.">
          <span class="setting-label-row"><span>Maximum spots per minute</span><span class="setting-purpose">Pacing cap</span></span>
          <input v-model.number="settings.max_spots_per_minute" class="input" type="number" min="1" max="12" aria-describedby="sound-spots-help" />
          <small id="sound-spots-help" class="setting-help">Limits brief effects such as clicks, impacts, or doors. Start at 2–4 to avoid distracting from speech.</small>
        </label>
        <label class="sound-setting-field" title="Sets the default loudness of continuous background ambience. Decibels are negative here: a more-negative number is quieter. Start near -20 dB.">
          <span class="setting-label-row"><span>Ambient bed level</span><span class="setting-purpose">Continuous mix · dB</span></span>
          <input v-model.number="settings.default_bed_gain_db" class="input" type="number" min="-45" max="-6" step="1" aria-describedby="sound-bed-level-help" />
          <small id="sound-bed-level-help" class="setting-help">Loudness of continuous backgrounds. More negative is quieter; −20 dB is a narration-safe starting point.</small>
        </label>
        <label class="sound-setting-field" title="Sets the default loudness of brief spot effects. Decibels are negative here: a more-negative number is quieter. Start near -12 dB.">
          <span class="setting-label-row"><span>Spot effect level</span><span class="setting-purpose">Momentary mix · dB</span></span>
          <input v-model.number="settings.default_spot_gain_db" class="input" type="number" min="-35" max="-3" step="1" aria-describedby="sound-spot-level-help" />
          <small id="sound-spot-level-help" class="setting-help">Loudness of brief effects. More negative is quieter; −12 dB is noticeable without overpowering speech.</small>
        </label>
        <label class="sound-setting-field" title="Controls how strongly continuous ambience lowers while narration is present. Gentle keeps the atmosphere audible; Strong gives speech the most space.">
          <span class="setting-label-row"><span>Bed ducking</span><span class="setting-purpose">Voice protection</span></span>
          <select v-model="settings.ducking_profile" class="select" aria-describedby="sound-ducking-help"><option value="gentle">Gentle — light narration protection</option><option value="standard">Standard — clearer narration</option><option value="strong">Strong — narration first</option></select>
          <small id="sound-ducking-help" class="setting-help">How much ambience lowers under speech. Gentle preserves atmosphere; Strong prioritizes voice clarity.</small>
        </label>
        <div class="provider-note"><strong>Making new sounds</strong><span>Not available yet. For now, add sound files you already have to an SFX pool in the <NuxtLink to="/broll-library">B-Roll Library</NuxtLink>.</span></div>
      </div>
    </section>

    <WorkspaceNotice v-if="!config.enabled" tone="info" title="Sound Design is off">Save a preset now if you like. Enable the project setting only when approved sound cues should become part of Final Video.</WorkspaceNotice>
    <template v-else>
      <WorkspaceNotice v-if="loadError" tone="warning" title="Sound Design can't open this episode">{{ loadError }}</WorkspaceNotice>
      <WorkspaceNotice v-else-if="loadingTimeline" tone="info" title="Loading this episode's sound cues…" />
      <WorkspaceNotice v-else-if="validation.length" tone="warning" :title="`Fix ${validation.length} thing${validation.length === 1 ? '' : 's'} before Final Video`">
        <span v-for="(issue, i) in validation" :key="i" class="sound-issue">• {{ issue.cue_id ? `${cueName(issue.cue_id)}: ` : '' }}{{ issue.detail }}</span>
      </WorkspaceNotice>
      <WorkspaceNotice v-else-if="timeline" tone="success" title="Sound Design ready">{{ approvedCount }} approved cue{{ approvedCount === 1 ? '' : 's' }} will be mixed into Final Video. Excluded cues will not be used.</WorkspaceNotice>

      <section v-if="timeline" class="card sound-timeline">
        <div class="timeline-heading"><div><span class="section-kicker">Reviewed timeline</span><h2>{{ timeline.cues.length }} cue{{ timeline.cues.length === 1 ? '' : 's' }}</h2></div><div class="timeline-actions"><button class="btn btn-secondary btn-sm" @click="addBed">+ Ambient bed</button><button class="btn btn-secondary btn-sm" @click="addSpot">+ Spot effect</button><button class="btn btn-primary btn-sm" :disabled="saving || !dirty" @click="saveTimeline()">{{ saving ? 'Saving…' : 'Save Sound Design' }}</button></div></div>
        <p v-if="!timeline.cues.length" class="text-muted">No sound cues yet. Silence is valid; add only the moments that improve the episode.</p>
        <p v-if="!candidates.length" class="text-muted text-sm">No sound files found. Add a folder of sound effects as an SFX pool in the <NuxtLink to="/broll-library">B-Roll Library</NuxtLink>, then reload this page.</p>
        <article v-for="cue in timeline.cues" :key="cue.id" class="sound-cue" :class="`is-${cue.status}`">
          <div class="cue-time">{{ time(cue.start_sec) }}<template v-if="cue.kind === 'bed'">–{{ time(cue.end_sec || cue.start_sec) }}</template></div>
          <div class="cue-icon">{{ cue.kind === 'bed' ? '〰️' : '🔔' }}</div>
          <div class="cue-fields">
            <select v-model="cue.kind" class="select select-sm" @change="onKindChange(cue)"><option value="bed">Ambient bed</option><option value="spot">Spot effect</option></select>
            <input v-model="cue.label" class="input" maxlength="120" placeholder="e.g. quiet city traffic, page turn, distant train" @input="markSoundDirty()" />
            <label>Start <input v-model.number="cue.start_sec" class="input input-time" type="number" min="0" :max="duration" step="0.1" @input="markSoundDirty()" /></label>
            <label v-if="cue.kind === 'bed'">End <input v-model.number="cue.end_sec" class="input input-time" type="number" min="0" :max="duration" step="0.1" @input="markSoundDirty()" /></label>
            <label>Gain <input v-model.number="cue.gain_db" class="input input-gain" type="number" min="-45" max="-3" step="1" @input="markSoundDirty()" /> dB</label>
            <select :value="cueKey(cue)" class="select clip-picker" @change="onClipChange(cue, $event)"><option value="">— choose a sound —</option><option v-for="candidate in candidates" :key="candidate.pool_id + '/' + candidate.filename" :value="candidate.pool_id + '/' + candidate.filename">{{ candidate.filename }}<template v-if="candidate.tags.length"> · {{ candidate.tags.join(', ') }}</template></option></select>
          </div>
          <div class="cue-actions"><span class="cue-status">{{ statusLabel(cue) }}</span><button class="btn btn-sm" :class="cue.status === 'approved' ? 'btn-primary' : 'btn-secondary'" :disabled="!cue.clip" @click="setStatus(cue, 'approved')">Approve</button><button class="btn btn-sm btn-secondary" @click="setStatus(cue, 'excluded')">Exclude</button><button class="btn btn-sm btn-danger" @click="removeCue(cue.id)">Remove</button></div>
          <p v-for="(issue, i) in cueIssues(cue.id)" :key="i" class="cue-issue" role="alert">{{ issue }}</p>
        </article>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useApi } from '../../../composables/useApi.js'
import { usePresets } from '../../../composables/usePresets.js'
import { useRememberedForm } from '../../../composables/useRememberedForm.js'
import { useToast } from '../../../composables/useToast.js'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Sound Design')

type Status = 'proposed' | 'matched' | 'approved' | 'excluded'
type Cue = { id: string; kind: 'bed' | 'spot'; label: string; start_sec: number; end_sec?: number; pool_id?: string; clip: string; gain_db: number; status: Status; created_at: string; updated_at: string }
type Settings = { density: 'minimal' | 'balanced' | 'rich'; max_spots_per_minute: number; default_bed_gain_db: number; default_spot_gain_db: number; ducking_profile: 'gentle' | 'standard' | 'strong' }
type Timeline = { schema_version: 1; generated_at: string; source_scene_plan_generated_at: string; settings: Settings; cues: Cue[] }
type Config = { enabled: boolean }
type Candidate = { pool_id: string; filename: string; tags: string[] }

const route = useRoute(); const slug = computed(() => String(route.params.slug)); const { get, put } = useApi(); const { success, error } = useToast()
const episodeId = ref(''); const config = ref<Config>({ enabled: false }); const timeline = ref<Timeline | null>(null); const timelineProjectSlug = ref(''); const timelineEpisodeId = ref(''); const candidates = ref<Candidate[]>([]); const validation = ref<Array<{ cue_id?: string; detail: string }>>([]); const duration = ref(0); const loadError = ref(''); const saving = ref(false); const savingConfig = ref(false); const dirty = ref(false); useUnsavedGuard(dirty, 'Sound Design cues'); const loadingTimeline = ref(false)
let soundScopeEpoch = 0; let soundProjectEpoch = 0; let soundLoadSequence = 0; let soundEditSeq = 0
const settings = ref<Settings>({ density: 'minimal', max_spots_per_minute: 3, default_bed_gain_db: -20, default_spot_gain_db: -12, ducking_profile: 'gentle' })
useRememberedForm('sound-design', slug, settings, { include: ['density', 'max_spots_per_minute', 'default_bed_gain_db', 'default_spot_gain_db', 'ducking_profile'], version: 1 })
const presets = usePresets<Settings>({ slug: slug.value, configKey: 'sound_design', presetType: 'sound-design', snapshot: () => ({ ...settings.value }), apply: data => { settings.value = { ...settings.value, ...data } } })
const approvedCount = computed(() => timeline.value?.cues.filter(cue => cue.status === 'approved').length || 0)
const unresolvedCount = computed(() => timeline.value?.cues.filter(cue => cue.status === 'proposed' || cue.status === 'matched').length || 0)
const actionStatus = computed(() => !config.value.enabled ? 'Enable Sound Design for this project first.' : !episodeId.value ? 'Choose an episode first.' : 'Add a sparse, reviewable cue to this episode.')

function blankTimeline(): Timeline { return { schema_version: 1, generated_at: new Date().toISOString(), source_scene_plan_generated_at: '', settings: { ...settings.value }, cues: [] } }
function markSoundDirty(): void { dirty.value = true; soundEditSeq++ }
function id(): string { return `sound-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
function time(value: number): string { const whole = Math.max(0, Math.floor(value || 0)); return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}` }
function cueKey(cue: Cue): string { return cue.pool_id && cue.clip ? `${cue.pool_id}/${cue.clip}` : '' }
function statusLabel(cue: Cue): string { if (cue.status === 'approved') return 'approved'; if (cue.status === 'excluded') return 'excluded'; return cue.clip ? 'ready to review' : 'choose a sound first' }
function cueIssues(cueId: string): string[] { return validation.value.filter(issue => issue.cue_id === cueId).map(issue => issue.detail) }
function cueName(cueId: string): string { const index = timeline.value?.cues.findIndex(cue => cue.id === cueId) ?? -1; const cue = index >= 0 ? timeline.value!.cues[index]! : null; return cue ? `Cue ${index + 1}${cue.label ? ` (${cue.label})` : ''}` : 'A cue' }
function ensureTimeline(): Timeline { if (!timeline.value) { timeline.value = blankTimeline(); timelineProjectSlug.value = slug.value; timelineEpisodeId.value = episodeId.value }; return timeline.value }
function addSpot(): void { const target = ensureTimeline(); target.cues.push({ id: id(), kind: 'spot', label: '', start_sec: 0, clip: '', gain_db: settings.value.default_spot_gain_db, status: 'proposed', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }); markSoundDirty() }
function addBed(): void { const target = ensureTimeline(); target.cues.push({ id: id(), kind: 'bed', label: '', start_sec: 0, end_sec: Math.min(20, duration.value || 20), clip: '', gain_db: settings.value.default_bed_gain_db, status: 'proposed', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }); markSoundDirty() }
function onKindChange(cue: Cue): void { if (cue.kind === 'bed' && !cue.end_sec) cue.end_sec = Math.min((cue.start_sec || 0) + 20, duration.value || (cue.start_sec || 0) + 20); if (cue.kind === 'spot') delete cue.end_sec; cue.status = cue.clip ? 'matched' : 'proposed'; markSoundDirty() }
function onClipChange(cue: Cue, event: Event): void { const key = (event.target as HTMLSelectElement).value; if (!key) { cue.pool_id = undefined; cue.clip = ''; cue.status = 'proposed' } else { const divider = key.indexOf('/'); cue.pool_id = key.slice(0, divider); cue.clip = key.slice(divider + 1); cue.status = 'matched' }; markSoundDirty() }
function setStatus(cue: Cue, status: Status): void { if (status === 'approved' && !cue.clip) return; cue.status = status; markSoundDirty() }
function removeCue(cueId: string): void { if (!timeline.value) return; timeline.value.cues = timeline.value.cues.filter(cue => cue.id !== cueId); markSoundDirty() }
function isCurrentSoundScope(projectSlug: string, episode: string, scopeEpoch: number): boolean { return soundScopeEpoch === scopeEpoch && slug.value === projectSlug && episodeId.value === episode }
async function loadConfig(): Promise<void> {
  const projectSlug = slug.value
  const projectEpoch = soundProjectEpoch
  try {
    const data = await get<Config>(`/projects/${projectSlug}/sound-design/config`)
    if (soundProjectEpoch !== projectEpoch || slug.value !== projectSlug) return
    config.value = data
  } catch (cause: any) {
    if (soundProjectEpoch === projectEpoch && slug.value === projectSlug) error(cause?.data?.detail || 'Could not load Sound Design setting')
  }
}
async function saveConfig(): Promise<void> {
  const projectSlug = slug.value
  const projectEpoch = soundProjectEpoch
  const payload = { ...config.value }
  savingConfig.value = true
  try {
    const data = await put<Config>(`/projects/${projectSlug}/sound-design/config`, payload)
    if (soundProjectEpoch !== projectEpoch || slug.value !== projectSlug) return
    config.value = data
    success(data.enabled ? 'Sound Design enabled' : 'Sound Design disabled — Final Video will use original audio.')
  } catch (cause: any) {
    if (soundProjectEpoch === projectEpoch && slug.value === projectSlug) error(cause?.data?.detail || 'Could not save Sound Design setting')
  } finally { savingConfig.value = false }
}
async function loadEpisode(): Promise<void> {
  const projectSlug = slug.value
  const episode = episodeId.value
  const scopeEpoch = soundScopeEpoch
  const request = ++soundLoadSequence
  await saveTimeline(false)
  if (!isCurrentSoundScope(projectSlug, episode, scopeEpoch)) return
  if (dirty.value) {
    loadingTimeline.value = false
    loadError.value = `Changes to ${timelineProjectSlug.value}/${timelineEpisodeId.value} are still on this page. Save them before loading ${projectSlug}/${episode}.`
    return
  }
  timeline.value = null
  timelineProjectSlug.value = ''
  timelineEpisodeId.value = ''
  validation.value = []
  candidates.value = []
  duration.value = 0
  loadError.value = ''
  loadingTimeline.value = false
  if (!episode) return
  loadingTimeline.value = true
  try {
    const [data, assets] = await Promise.all([
      get<any>(`/projects/${projectSlug}/sound-design/${episode}`),
      get<{ candidates: Candidate[] }>(`/projects/${projectSlug}/sound-design/${episode}/candidates`),
    ])
    if (request !== soundLoadSequence || !isCurrentSoundScope(projectSlug, episode, scopeEpoch)) return
    timeline.value = data.timeline || blankTimeline()
    timelineProjectSlug.value = projectSlug
    timelineEpisodeId.value = episode
    validation.value = data.validation || []
    duration.value = data.duration_sec || 0
    candidates.value = assets.candidates || []
    if (data.timeline?.settings) settings.value = { ...settings.value, ...data.timeline.settings }
  } catch (cause: any) {
    if (request === soundLoadSequence && isCurrentSoundScope(projectSlug, episode, scopeEpoch)) loadError.value = cause?.data?.detail || 'Could not load Sound Design timeline.'
  } finally {
    if (request === soundLoadSequence && isCurrentSoundScope(projectSlug, episode, scopeEpoch)) loadingTimeline.value = false
  }
}
let soundSaveTail: Promise<void> = Promise.resolve()
function saveTimeline(announce = true): Promise<void> {
  const run = soundSaveTail.then(() => writeTimeline(announce), () => writeTimeline(announce))
  soundSaveTail = run.then(() => undefined, () => undefined)
  return run
}
async function writeTimeline(announce: boolean): Promise<void> {
  if (!timeline.value || !timelineProjectSlug.value || !timelineEpisodeId.value || !dirty.value) return
  const projectSlug = timelineProjectSlug.value
  const episode = timelineEpisodeId.value
  const scopeEpoch = soundScopeEpoch
  const sentAt = soundEditSeq
  const cues = JSON.parse(JSON.stringify(timeline.value.cues))
  const timelineSettings = { ...settings.value }
  saving.value = true
  try {
    const data = await put<any>(`/projects/${projectSlug}/sound-design/${episode}`, { cues, settings: timelineSettings })
    const stillOwnsTimeline = timelineProjectSlug.value === projectSlug && timelineEpisodeId.value === episode
    if (!stillOwnsTimeline || soundEditSeq !== sentAt) return
    dirty.value = false
    if (!isCurrentSoundScope(projectSlug, episode, scopeEpoch)) {
      if (announce) void loadEpisode()
      return
    }
    timeline.value = data.timeline
    validation.value = data.validation || []
    if (announce) success('Sound Design timeline saved')
  } catch (cause: any) {
    if (timelineProjectSlug.value === projectSlug && timelineEpisodeId.value === episode && announce) {
      const issues = Array.isArray(cause?.data?.issues) ? cause.data.issues : []
      if (issues.length) validation.value = issues
      error(issues.length ? `Not saved — fix the ${issues.length} problem${issues.length === 1 ? '' : 's'} shown on this page.` : cause?.data?.detail || 'Could not save Sound Design timeline')
    }
  } finally { saving.value = false }
}
watch(settings, () => { if (timeline.value && !loadingTimeline.value) markSoundDirty() }, { deep: true, flush: 'sync' })
watch(slug, () => { soundProjectEpoch++; void loadConfig() }, { flush: 'sync' })
watch([slug, episodeId], () => { soundScopeEpoch++; void loadEpisode() }, { flush: 'sync' })
onBeforeUnmount(() => { void saveTimeline(false) })
onMounted(async () => { await Promise.all([loadConfig(), presets.load()]) })
</script>

<style scoped>
.sound-design-workspace :deep(.workspace-command-surface .top-action-bar) { margin:0; border:0; background:transparent; box-shadow:none; }
.sound-command,.sound-settings { display:grid; grid-template-columns:minmax(20rem,1fr) auto; align-items:center; gap:2rem; margin:1rem 0; padding:1.25rem 1.5rem; }.sound-command h2,.sound-settings h2,.sound-timeline h2 { margin:.25rem 0; font-size:1.1rem; }.sound-command p,.sound-settings p { margin:0; color:var(--text-muted); max-width:48rem; }.section-kicker { color:var(--accent-gold); text-transform:uppercase; letter-spacing:.09em; font-size:.72rem; font-weight:700; }.sound-switch { display:flex; gap:.55rem; align-items:center; font-weight:700; white-space:nowrap; }.sound-switch input { width:1.2rem; height:1.2rem; accent-color:var(--accent-gold); }
.sound-settings { align-items:end; grid-template-columns:minmax(18rem,.8fr) minmax(36rem,1.7fr); }.sound-settings-controls { display:grid; grid-template-columns:repeat(2,minmax(12rem,1fr)); gap:.8rem; }.sound-setting-field { display:grid; align-content:start; gap:.42rem; min-width:0; padding:.72rem; border:1px solid var(--border-color); border-radius:.55rem; background:color-mix(in srgb,var(--bg-input) 58%,transparent); color:var(--text-muted); }.setting-label-row { display:flex; justify-content:space-between; align-items:center; gap:.65rem; color:var(--text-primary); font-size:.82rem; font-weight:700; }.setting-purpose { flex:0 0 auto; color:var(--accent-gold); font-size:.65rem; font-weight:700; letter-spacing:.05em; text-transform:uppercase; }.setting-help { color:var(--text-muted); font-size:.74rem; line-height:1.4; }.provider-note { grid-column:1/-1; display:grid; gap:.18rem; padding:.65rem .8rem; border:1px solid var(--border-color); border-radius:.45rem; color:var(--text-muted); font-size:.8rem; }.provider-note strong { color:var(--text-primary); }
.sound-timeline { padding:1.25rem; }.timeline-heading { display:flex; justify-content:space-between; align-items:center; gap:1rem; margin-bottom:1rem; }.timeline-actions,.cue-actions { display:flex; gap:.45rem; flex-wrap:wrap; align-items:center; }.sound-cue { display:grid; grid-template-columns:6.5rem 2.2rem minmax(0,1fr) auto; gap:.8rem; align-items:start; padding:1rem 0; border-top:1px solid var(--border-color); }.sound-cue.is-approved { border-left:3px solid var(--success); padding-left:.7rem; }.sound-cue.is-excluded { opacity:.55; }.cue-time { padding-top:.55rem; color:var(--accent-gold); font-variant-numeric:tabular-nums; font-weight:700; }.cue-icon { font-size:1.1rem; padding-top:.45rem; }.cue-fields { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; min-width:0; }.cue-fields > select:first-child { flex:0 0 9rem; }.cue-fields > input { flex:1 1 14rem; min-width:10rem; }.cue-fields > label { flex:0 0 auto; }.cue-issue { grid-column:1 / -1; margin:0; color:var(--warning, #d97706); font-size:.78rem; }.sound-issue { display:block; }.cue-fields label { display:flex; align-items:center; gap:.25rem; color:var(--text-muted); font-size:.75rem; }.input-time { width:4.7rem; }.input-gain { width:4.6rem; }.clip-picker { flex:1 1 14rem; min-width:10rem; }.cue-status { font-size:.75rem; color:var(--text-muted); white-space:nowrap; }
@media (max-width:1100px) { .sound-settings,.sound-command,.sound-cue { grid-template-columns:1fr; }.sound-settings-controls { grid-template-columns:1fr 1fr; }.cue-actions { justify-content:flex-start; } }
</style>
