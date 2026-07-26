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
        <p>These settings belong to a Sound Design preset. Phase 1 uses your local sound library only; compatible GenStudio sound capabilities will appear here when they are published.</p>
      </div>
      <div class="sound-settings-controls">
        <label>Sound density<select v-model="settings.density" class="select"><option value="minimal">Minimal — sparse and documentary-safe</option><option value="balanced">Balanced — selective emphasis</option><option value="rich">Rich — use with care</option></select></label>
        <label>Maximum spots per minute<input v-model.number="settings.max_spots_per_minute" class="input" type="number" min="1" max="12" /></label>
        <label>Ambient bed level<input v-model.number="settings.default_bed_gain_db" class="input" type="number" min="-45" max="-6" step="1" /></label>
        <label>Spot effect level<input v-model.number="settings.default_spot_gain_db" class="input" type="number" min="-35" max="-3" step="1" /></label>
        <label>Bed ducking<select v-model="settings.ducking_profile" class="select"><option value="gentle">Gentle — light narration protection</option><option value="standard">Standard — clearer narration</option><option value="strong">Strong — narration first</option></select></label>
        <div class="provider-note"><strong>GenStudio sound generation</strong><span>Not available yet. This workflow will use a qualified live GenStudio capability when one is published; Story Studio will not connect to providers directly.</span></div>
      </div>
    </section>

    <WorkspaceNotice v-if="!config.enabled" tone="info" title="Sound Design is off">Save a preset now if you like. Enable the project setting only when approved sound cues should become part of Final Video.</WorkspaceNotice>
    <template v-else>
      <WorkspaceNotice v-if="loadError" tone="warning" title="Sound Design needs a Scene Plan">{{ loadError }}</WorkspaceNotice>
      <WorkspaceNotice v-else-if="validation.length" tone="warning" title="Resolve Sound Design before Final Video">{{ validation[0]?.detail }}</WorkspaceNotice>
      <WorkspaceNotice v-else-if="timeline" tone="success" title="Sound Design ready">{{ approvedCount }} approved cue{{ approvedCount === 1 ? '' : 's' }} will be mixed into Final Video. Excluded cues will not be used.</WorkspaceNotice>

      <section v-if="timeline" class="card sound-timeline">
        <div class="timeline-heading"><div><span class="section-kicker">Reviewed timeline</span><h2>{{ timeline.cues.length }} cue{{ timeline.cues.length === 1 ? '' : 's' }}</h2></div><div class="timeline-actions"><button class="btn btn-secondary btn-sm" @click="addBed">+ Ambient bed</button><button class="btn btn-secondary btn-sm" @click="addSpot">+ Spot effect</button><button class="btn btn-primary btn-sm" :disabled="saving || !dirty" @click="saveTimeline">{{ saving ? 'Saving…' : 'Save Sound Design' }}</button></div></div>
        <p v-if="!timeline.cues.length" class="text-muted">No sound cues yet. Silence is valid; add only the moments that improve the episode.</p>
        <article v-for="cue in timeline.cues" :key="cue.id" class="sound-cue" :class="`is-${cue.status}`">
          <div class="cue-time">{{ time(cue.start_sec) }}<template v-if="cue.kind === 'bed'">–{{ time(cue.end_sec || cue.start_sec) }}</template></div>
          <div class="cue-icon">{{ cue.kind === 'bed' ? '〰️' : '🔔' }}</div>
          <div class="cue-fields">
            <select v-model="cue.kind" class="select select-sm" @change="onKindChange(cue)"><option value="bed">Ambient bed</option><option value="spot">Spot effect</option></select>
            <input v-model="cue.label" class="input" maxlength="120" placeholder="e.g. quiet city traffic, page turn, distant train" @input="dirty = true" />
            <label>Start <input v-model.number="cue.start_sec" class="input input-time" type="number" min="0" :max="duration" step="0.1" @input="dirty = true" /></label>
            <label v-if="cue.kind === 'bed'">End <input v-model.number="cue.end_sec" class="input input-time" type="number" min="0" :max="duration" step="0.1" @input="dirty = true" /></label>
            <label>Gain <input v-model.number="cue.gain_db" class="input input-gain" type="number" min="-45" max="-3" step="1" @input="dirty = true" /> dB</label>
            <select :value="cueKey(cue)" class="select clip-picker" @change="onClipChange(cue, $event)"><option value="">— choose a local sound asset —</option><option v-for="candidate in candidates" :key="candidate.pool_id + '/' + candidate.filename" :value="candidate.pool_id + '/' + candidate.filename">{{ candidate.filename }}<template v-if="candidate.tags.length"> · {{ candidate.tags.join(', ') }}</template></option></select>
          </div>
          <div class="cue-actions"><span class="cue-status">{{ statusLabel(cue) }}</span><button class="btn btn-sm" :class="cue.status === 'approved' ? 'btn-primary' : 'btn-secondary'" :disabled="!cue.clip" @click="setStatus(cue, 'approved')">Approve</button><button class="btn btn-sm btn-secondary" @click="setStatus(cue, 'excluded')">Exclude</button><button class="btn btn-sm btn-danger" @click="removeCue(cue.id)">Remove</button></div>
        </article>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useApi } from '../../../composables/useApi.js'
import { usePresets } from '../../../composables/usePresets.js'
import { useRememberedForm } from '../../../composables/useRememberedForm.js'
import { useToast } from '../../../composables/useToast.js'

type Status = 'proposed' | 'matched' | 'approved' | 'excluded'
type Cue = { id: string; kind: 'bed' | 'spot'; label: string; start_sec: number; end_sec?: number; pool_id?: string; clip: string; gain_db: number; status: Status; created_at: string; updated_at: string }
type Settings = { density: 'minimal' | 'balanced' | 'rich'; max_spots_per_minute: number; default_bed_gain_db: number; default_spot_gain_db: number; ducking_profile: 'gentle' | 'standard' | 'strong' }
type Timeline = { schema_version: 1; generated_at: string; source_scene_plan_generated_at: string; settings: Settings; cues: Cue[] }
type Config = { enabled: boolean }
type Candidate = { pool_id: string; filename: string; tags: string[] }

const route = useRoute(); const slug = computed(() => String(route.params.slug)); const { get, put } = useApi(); const { success, error } = useToast()
const episodeId = ref(''); const config = ref<Config>({ enabled: false }); const timeline = ref<Timeline | null>(null); const candidates = ref<Candidate[]>([]); const validation = ref<Array<{ cue_id?: string; detail: string }>>([]); const duration = ref(0); const loadError = ref(''); const saving = ref(false); const savingConfig = ref(false); const dirty = ref(false); const loadingTimeline = ref(false)
const settings = ref<Settings>({ density: 'minimal', max_spots_per_minute: 3, default_bed_gain_db: -20, default_spot_gain_db: -12, ducking_profile: 'gentle' })
useRememberedForm('sound-design', slug, settings, { include: ['density', 'max_spots_per_minute', 'default_bed_gain_db', 'default_spot_gain_db', 'ducking_profile'], version: 1 })
const presets = usePresets<Settings>({ slug: slug.value, configKey: 'sound_design', presetType: 'sound-design', snapshot: () => ({ ...settings.value }), apply: data => { settings.value = { ...settings.value, ...data } } })
const approvedCount = computed(() => timeline.value?.cues.filter(cue => cue.status === 'approved').length || 0)
const unresolvedCount = computed(() => timeline.value?.cues.filter(cue => cue.status === 'proposed' || cue.status === 'matched').length || 0)
const actionStatus = computed(() => !config.value.enabled ? 'Enable Sound Design for this project first.' : !episodeId.value ? 'Choose an episode first.' : 'Add a sparse, reviewable cue to this episode.')

function blankTimeline(): Timeline { return { schema_version: 1, generated_at: new Date().toISOString(), source_scene_plan_generated_at: '', settings: { ...settings.value }, cues: [] } }
function id(): string { return `sound-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
function time(value: number): string { const whole = Math.max(0, Math.floor(value || 0)); return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}` }
function cueKey(cue: Cue): string { return cue.pool_id && cue.clip ? `${cue.pool_id}/${cue.clip}` : '' }
function statusLabel(cue: Cue): string { if (cue.status === 'approved') return 'approved'; if (cue.status === 'excluded') return 'excluded'; return cue.clip ? 'ready to review' : 'needs asset' }
function ensureTimeline(): Timeline { if (!timeline.value) timeline.value = blankTimeline(); return timeline.value }
function addSpot(): void { const target = ensureTimeline(); target.cues.push({ id: id(), kind: 'spot', label: '', start_sec: 0, clip: '', gain_db: settings.value.default_spot_gain_db, status: 'proposed', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }); dirty.value = true }
function addBed(): void { const target = ensureTimeline(); target.cues.push({ id: id(), kind: 'bed', label: '', start_sec: 0, end_sec: Math.min(20, duration.value || 20), clip: '', gain_db: settings.value.default_bed_gain_db, status: 'proposed', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }); dirty.value = true }
function onKindChange(cue: Cue): void { if (cue.kind === 'bed' && !cue.end_sec) cue.end_sec = Math.min((cue.start_sec || 0) + 20, duration.value || (cue.start_sec || 0) + 20); if (cue.kind === 'spot') delete cue.end_sec; cue.status = cue.clip ? 'matched' : 'proposed'; dirty.value = true }
function onClipChange(cue: Cue, event: Event): void { const key = (event.target as HTMLSelectElement).value; if (!key) { cue.pool_id = undefined; cue.clip = ''; cue.status = 'proposed' } else { const divider = key.indexOf('/'); cue.pool_id = key.slice(0, divider); cue.clip = key.slice(divider + 1); cue.status = 'matched' }; dirty.value = true }
function setStatus(cue: Cue, status: Status): void { if (status === 'approved' && !cue.clip) return; cue.status = status; dirty.value = true }
function removeCue(cueId: string): void { if (!timeline.value) return; timeline.value.cues = timeline.value.cues.filter(cue => cue.id !== cueId); dirty.value = true }
async function loadConfig(): Promise<void> { try { config.value = await get<Config>(`/projects/${slug.value}/sound-design/config`) } catch (cause: any) { error(cause?.data?.detail || 'Could not load Sound Design setting') } }
async function saveConfig(): Promise<void> { savingConfig.value = true; try { config.value = await put<Config>(`/projects/${slug.value}/sound-design/config`, config.value); success(config.value.enabled ? 'Sound Design enabled' : 'Sound Design disabled — Final Video will use original audio.') } catch (cause: any) { error(cause?.data?.detail || 'Could not save Sound Design setting') } finally { savingConfig.value = false } }
async function loadEpisode(): Promise<void> { timeline.value = null; validation.value = []; loadError.value = ''; dirty.value = false; if (!episodeId.value) return; loadingTimeline.value = true; try { const [data, assets] = await Promise.all([get<any>(`/projects/${slug.value}/sound-design/${episodeId.value}`), get<{ candidates: Candidate[] }>(`/projects/${slug.value}/sound-design/${episodeId.value}/candidates`)]); timeline.value = data.timeline; validation.value = data.validation || []; duration.value = data.duration_sec || 0; candidates.value = assets.candidates || []; if (data.timeline?.settings) settings.value = { ...settings.value, ...data.timeline.settings } } catch (cause: any) { loadError.value = cause?.data?.detail || 'Could not load Sound Design timeline.' } finally { loadingTimeline.value = false } }
async function saveTimeline(): Promise<void> { if (!timeline.value) return; saving.value = true; try { const data = await put<any>(`/projects/${slug.value}/sound-design/${episodeId.value}`, { cues: timeline.value.cues, settings: settings.value }); timeline.value = data.timeline; validation.value = data.validation || []; dirty.value = false; success('Sound Design timeline saved') } catch (cause: any) { const issue = cause?.data?.issues?.[0]?.detail; error(issue || cause?.data?.detail || 'Could not save Sound Design timeline') } finally { saving.value = false } }
watch(settings, () => { if (timeline.value && !loadingTimeline.value) dirty.value = true }, { deep: true, flush: 'sync' })
watch(episodeId, loadEpisode); onMounted(async () => { await Promise.all([loadConfig(), presets.load()]) })
</script>

<style scoped>
.sound-design-workspace :deep(.workspace-command-surface .top-action-bar) { margin:0; border:0; background:transparent; box-shadow:none; }
.sound-command,.sound-settings { display:grid; grid-template-columns:minmax(20rem,1fr) auto; align-items:center; gap:2rem; margin:1rem 0; padding:1.25rem 1.5rem; }.sound-command h2,.sound-settings h2,.sound-timeline h2 { margin:.25rem 0; font-size:1.1rem; }.sound-command p,.sound-settings p { margin:0; color:var(--text-muted); max-width:48rem; }.section-kicker { color:var(--accent-gold); text-transform:uppercase; letter-spacing:.09em; font-size:.72rem; font-weight:700; }.sound-switch { display:flex; gap:.55rem; align-items:center; font-weight:700; white-space:nowrap; }.sound-switch input { width:1.2rem; height:1.2rem; accent-color:var(--accent-gold); }
.sound-settings { align-items:end; grid-template-columns:minmax(18rem,.8fr) minmax(36rem,1.7fr); }.sound-settings-controls { display:grid; grid-template-columns:repeat(2,minmax(12rem,1fr)); gap:.8rem; }.sound-settings-controls label { display:grid; gap:.35rem; font-size:.82rem; color:var(--text-muted); }.provider-note { grid-column:1/-1; display:grid; gap:.18rem; padding:.65rem .8rem; border:1px solid var(--border-color); border-radius:.45rem; color:var(--text-muted); font-size:.8rem; }.provider-note strong { color:var(--text-primary); }
.sound-timeline { padding:1.25rem; }.timeline-heading { display:flex; justify-content:space-between; align-items:center; gap:1rem; margin-bottom:1rem; }.timeline-actions,.cue-actions { display:flex; gap:.45rem; flex-wrap:wrap; align-items:center; }.sound-cue { display:grid; grid-template-columns:6.5rem 2.2rem minmax(30rem,1fr) auto; gap:.8rem; align-items:start; padding:1rem 0; border-top:1px solid var(--border-color); }.sound-cue.is-approved { border-left:3px solid var(--success); padding-left:.7rem; }.sound-cue.is-excluded { opacity:.55; }.cue-time { padding-top:.55rem; color:var(--accent-gold); font-variant-numeric:tabular-nums; font-weight:700; }.cue-icon { font-size:1.1rem; padding-top:.45rem; }.cue-fields { display:grid; grid-template-columns:9rem minmax(15rem,1fr) 7rem 7rem 8rem minmax(15rem,1.2fr); gap:.5rem; align-items:center; }.cue-fields label { display:flex; align-items:center; gap:.25rem; color:var(--text-muted); font-size:.75rem; }.input-time { width:4.7rem; }.input-gain { width:3.6rem; }.clip-picker { min-width:0; }.cue-status { font-size:.75rem; color:var(--text-muted); white-space:nowrap; }
@media (max-width:1100px) { .sound-settings,.sound-command,.sound-cue { grid-template-columns:1fr; }.sound-settings-controls,.cue-fields { grid-template-columns:1fr 1fr; }.cue-actions { justify-content:flex-start; } }
</style>
