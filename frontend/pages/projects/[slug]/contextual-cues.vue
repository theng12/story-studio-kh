<template>
  <div class="workspace-page contextual-cues-workspace">
    <WorkspaceHero
      eyebrow="Editorial · Optional"
      title="Contextual Cues"
      description="Add restrained location, date, and context labels to a reviewed timeline. Video Assembly renders approved cues exactly as shown here."
    >
      <template #aside>
        <div class="workspace-metrics">
          <span class="workspace-metric"><strong>{{ approvedCount }}</strong> approved</span>
          <span class="workspace-metric" :data-tone="proposedCount ? 'warning' : 'success'"><strong>{{ proposedCount }}</strong> to review</span>
        </div>
      </template>
    </WorkspaceHero>

    <div class="workspace-command-surface">
      <TopActionBar
        :project-slug="slug"
        v-model:episode-id="episodeId"
        filter-field="scene_plan"
        :presets="cuePresets"
        generate-label="Propose cues"
        generate-loading-label="Proposing cues…"
        :generate-loading="proposing || cueJobActive"
        :generate-disabled="!config.enabled || !episodeId || !form.model"
        :generate-status="proposalStatus"
        @generate="propose"
      />
    </div>

    <section class="card cues-command">
      <div class="cue-toggle-copy">
        <span class="section-kicker">Project setting</span>
        <h2>Use contextual cues</h2>
        <p>Optional by default. When enabled, every proposed cue must be approved or excluded before Video Assembly can render this episode.</p>
      </div>
      <label class="cue-switch">
        <input v-model="config.enabled" type="checkbox" :disabled="savingConfig" @change="saveConfig" />
        <span>{{ config.enabled ? 'Enabled' : 'Disabled' }}</span>
      </label>
    </section>

    <section class="card cues-command cues-auto-command">
      <div class="cue-toggle-copy">
        <span class="section-kicker">Project setting</span>
        <h2>Approve cues automatically</h2>
        <p>
          Every cue still has to pass the exact same structural checks as manual review — inside its scene,
          2.25–4.5 seconds readable, no crowding within 0.5s of another approved cue, valid treatment and
          placement. This never skips those checks; it only skips waiting for you once a preset has earned
          your trust. Run proposals manually a few times first — anything that fails a check is held back
          here with the reason, never silently dropped, so you can approve or exclude it yourself.
        </p>
      </div>
      <label class="cue-switch">
        <input v-model="config.auto_approve_cues" type="checkbox" :disabled="savingConfig || !config.enabled" @change="setAutoApproveCues(config.auto_approve_cues)" />
        <span>{{ config.auto_approve_cues ? 'Automatic' : 'Manual review' }}</span>
      </label>
    </section>

    <section class="card cue-settings">
      <div>
        <span class="section-kicker">Cue proposal setup</span>
        <h2>Choose the editorial model and pacing</h2>
        <p>These settings are saved in presets. The model is used only to propose labels; it never changes your Scene Plan or final approved timing.</p>
      </div>
      <div class="cue-settings-controls">
        <ModelSelector v-model="form.model" :project-slug="slug" label="Cue proposal model" />
        <label>Density
          <select v-model="form.density" class="select">
            <option value="restrained">Restrained — only key orientation</option>
            <option value="standard">Standard — useful context</option>
            <option value="editorial">Editorial — more frequent labels</option>
          </select>
        </label>
        <label>Default corner
          <select v-model="form.placement" class="select">
            <option value="top-right">Top right</option>
            <option value="top-left">Top left</option>
          </select>
        </label>
        <label class="cue-auto-approve">
          <input v-model="form.auto_approve" type="checkbox" />
          <span><strong>Auto-approve safe proposals</strong><small>Off by default. Use only after you trust this preset; Pipeline can then continue automatically.</small></span>
        </label>
      </div>
    </section>

    <WorkspaceNotice v-if="!config.enabled" tone="info" title="Contextual Cues are off">
      Pick an episode and save a cue preset whenever you like. Enable this project setting only when you are ready to propose, review, and require contextual cues for Video Assembly.
    </WorkspaceNotice>

    <template v-else>
      <WorkspaceNotice v-if="loadError" tone="warning" title="Contextual Cues need a Scene Plan">
        {{ loadError }}
      </WorkspaceNotice>
      <WorkspaceNotice v-else-if="proposalProgress" tone="info" title="Saved partial proposal">
        {{ proposalProgress.completed_batches.length }} of {{ proposalProgress.total_batches }} batches are safely checkpointed.
        {{ proposalProgress.total_scenes - completedProposalScenes }} scenes remain. Retry resumes only the missing batches; Video Assembly still treats this timeline as incomplete.
      </WorkspaceNotice>
      <WorkspaceNotice v-else-if="timeline?.auto_approval_holds?.length" tone="warning" title="Held back from auto-approval">
        {{ timeline.auto_approval_holds.length }} cue{{ timeline.auto_approval_holds.length === 1 ? '' : 's' }} failed a structural check
        during the last automatic pass and stayed in review instead of being approved — see the reason marked on
        each cue below. This episode will render without them until you approve or exclude them yourself.
      </WorkspaceNotice>
      <WorkspaceNotice v-else-if="validation.length" tone="warning" title="Resolve these cues before Video Assembly">
        {{ validation[0]?.detail }}
      </WorkspaceNotice>
      <WorkspaceNotice v-else-if="timeline && !proposedCount" tone="success" title="Cue timeline ready">
        Every cue is resolved. Approved cues will render exactly as reviewed; disabled cues will not render.
      </WorkspaceNotice>

      <section v-if="timeline" class="card cue-list">
        <div class="cue-list-heading">
          <div><span class="section-kicker">Reviewed timeline</span><h2>{{ timeline.cues.length }} cue{{ timeline.cues.length === 1 ? '' : 's' }}</h2></div>
          <button class="btn btn-secondary btn-sm" :disabled="saving || !dirty" @click="saveTimeline">Save changes</button>
        </div>
        <p v-if="!timeline.cues.length" class="text-muted">No cues were proposed. That is valid—this episode will continue without contextual labels.</p>
        <article v-for="cue in timeline.cues" :key="cue.id" class="cue-row" :class="`is-${cue.status}`">
          <p v-if="holdReasons.get(cue.id)?.length" class="cue-hold-reason">
            Held back from auto-approval: {{ holdReasons.get(cue.id)!.join('; ') }}
          </p>
          <div class="cue-time">{{ time(cue.start_sec) }}–{{ time(cue.end_sec) }}</div>
          <div class="cue-preview" :class="`preview-${cue.template}`" aria-label="Cue treatment preview">
            <span v-if="cue.template === 'map-pin'" class="cue-preview-pin">●</span>
            <span v-else-if="cue.template === 'archival-caption'" class="cue-preview-kicker">ARCHIVE</span>
            <span v-else-if="cue.template === 'chapter-plate'" class="cue-preview-kicker">CHAPTER</span>
            <span v-else class="cue-preview-kicker">CONTEXT</span>
            <strong>{{ cue.title || 'Cue title' }}</strong>
            <small v-if="cue.subtitle">{{ cue.subtitle }}</small>
          </div>
          <div class="cue-fields">
            <input v-model="cue.title" class="input" maxlength="80" placeholder="Main label" @input="dirty = true" />
            <input v-model="cue.subtitle" class="input" maxlength="100" placeholder="Optional second line" @input="dirty = true" />
            <div class="cue-meta">
              <select v-model="cue.kind" class="select select-sm" @change="dirty = true"><option value="location_date">Location / date</option><option value="historical_context">Historical context</option><option value="person">Person</option><option value="chapter">Chapter</option></select>
              <select v-model="cue.template" class="select select-sm" @change="dirty = true"><option value="documentary-label">Documentary label</option><option value="map-pin">Location pin</option><option value="archival-caption">Archival caption</option><option value="chapter-plate">Chapter plate</option></select>
              <select v-model="cue.placement" class="select select-sm" @change="dirty = true"><option value="top-right">Top right</option><option value="top-left">Top left</option></select>
              <select class="select select-sm" :value="cue.entrance" @change="setTransition(cue, ($event.target as HTMLSelectElement).value)"><option value="fade">Fade</option><option value="dissolve">Dissolve</option><option value="slide">Slide</option></select>
              <label>Start <input v-model.number="cue.start_sec" class="input input-time" type="number" step="0.1" @input="dirty = true" /></label>
              <label>End <input v-model.number="cue.end_sec" class="input input-time" type="number" step="0.1" @input="dirty = true" /></label>
            </div>
          </div>
          <div class="cue-actions">
            <button class="btn btn-sm" :class="cue.status === 'approved' ? 'btn-primary' : 'btn-secondary'" @click="setStatus(cue, 'approved')">Approve</button>
            <button class="btn btn-sm btn-secondary" :class="{ 'is-active': cue.status === 'disabled' }" @click="setStatus(cue, 'disabled')">Exclude</button>
          </div>
        </article>
      </section>
      <section v-else-if="proposalProgress?.provisional_cues?.length" class="card cue-list" aria-label="Saved partial contextual cue preview">
        <div class="cue-list-heading">
          <div><span class="section-kicker">Saved partial proposal</span><h2>{{ proposalProgress.provisional_cues.length }} recoverable cue preview{{ proposalProgress.provisional_cues.length === 1 ? '' : 's' }}</h2></div>
        </div>
        <p class="text-muted">These completed batches are read-only until every batch finishes. They will not render in Video Assembly yet.</p>
        <article v-for="cue in proposalProgress.provisional_cues" :key="cue.id" class="cue-row is-proposed">
          <div class="cue-time">{{ time(cue.start_sec) }}–{{ time(cue.end_sec) }}</div>
          <div class="cue-preview" :class="`preview-${cue.template}`"><strong>{{ cue.title }}</strong><small v-if="cue.subtitle">{{ cue.subtitle }}</small></div>
        </article>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Contextual Cues')

type Cue = {
  id: string; scene_id: string; start_sec: number; end_sec: number; title: string; subtitle?: string
  kind: 'location_date' | 'historical_context' | 'person' | 'chapter'; placement: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  template: 'documentary-label' | 'map-pin' | 'archival-caption' | 'chapter-plate'; entrance: 'fade' | 'slide' | 'dissolve'; exit: 'fade' | 'slide' | 'dissolve'; status: 'proposed' | 'approved' | 'disabled'; created_at: string; updated_at: string
}
type CueConfig = { enabled: boolean; auto_approve_cues: boolean }
type CueProposalForm = { model: string; density: 'restrained' | 'standard' | 'editorial'; placement: 'top-left' | 'top-right'; auto_approve: boolean }
type AutoApprovalHold = { cue_id: string; reasons: string[] }
type Timeline = { schema_version: 1; generated_at: string; source_scene_plan_generated_at: string; cues: Cue[]; auto_approval_holds?: AutoApprovalHold[] }
type ProposalProgress = { total_scenes: number; total_batches: number; completed_batches: Array<{ scene_ids: string[] }>; provisional_cues?: Cue[] }

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put } = useApi()
const { success, error: showError } = useToast()
const { isJobActiveFor } = useJobs()
const episodeId = ref('')
const config = ref<CueConfig>({ enabled: false, auto_approve_cues: false })
const form = ref<CueProposalForm>({ model: '', density: 'restrained', placement: 'top-right', auto_approve: false })
useRememberedForm('contextual-cues', slug, form, { include: ['model', 'density', 'placement', 'auto_approve'], version: 1 })
const timeline = ref<Timeline | null>(null)
const proposalProgress = ref<ProposalProgress | null>(null)
const validation = ref<Array<{ cue_id?: string; detail: string }>>([])
const loadError = ref('')
const proposing = ref(false)
const saving = ref(false)
const savingConfig = ref(false)
const dirty = ref(false)
const cueJobActive = computed(() => isJobActiveFor(episodeId.value, ['contextual_cues']))
const proposedCount = computed(() => timeline.value?.cues.filter(cue => cue.status === 'proposed').length || 0)
const approvedCount = computed(() => timeline.value?.cues.filter(cue => cue.status === 'approved').length || 0)
const completedProposalScenes = computed(() => proposalProgress.value?.completed_batches.reduce((total, batch) => total + batch.scene_ids.length, 0) || 0)
// v1.0.796 — "Approve cues automatically" (config.auto_approve_cues). A cue
// the automatic pass declined stays 'proposed' with its reason recorded
// here by id, so review can show exactly why next to that cue instead of
// leaving it unexplained among ordinary unreviewed proposals.
const holdReasons = computed(() => {
  const map = new Map<string, string[]>()
  for (const hold of timeline.value?.auto_approval_holds || []) map.set(hold.cue_id, hold.reasons)
  return map
})
const proposalStatus = computed(() => {
  if (!config.value.enabled) return 'Enable Contextual Cues for this project first.'
  if (!episodeId.value) return 'Choose an episode with a Scene Plan.'
  if (!form.value.model) return 'Choose a live GenStudio model.'
  return timeline.value?.cues?.length ? 'Refreshes unresolved proposals; approved and excluded cues stay intact.' : 'Creates a reviewed cue proposal from this episode’s Scene Plan.'
})

function time(value: number): string { const minutes = Math.floor(value / 60); const seconds = Math.floor(value % 60); return `${minutes}:${String(seconds).padStart(2, '0')}` }
function setStatus(cue: Cue, status: Cue['status']): void { cue.status = status; dirty.value = true }
function setTransition(cue: Cue, value: string): void {
  const transition = value === 'slide' || value === 'dissolve' ? value : 'fade'
  cue.entrance = transition
  cue.exit = transition
  dirty.value = true
}
async function loadConfig(): Promise<void> { try { config.value = await get<CueConfig>(`/projects/${slug.value}/contextual-cues/config`) } catch (e: any) { showError(e?.data?.detail || 'Could not load contextual cue settings') } }
async function saveConfig(): Promise<void> { savingConfig.value = true; try { config.value = await put<CueConfig>(`/projects/${slug.value}/contextual-cues/config`, config.value); success(config.value.enabled ? 'Contextual Cues enabled' : 'Contextual Cues disabled — Video Assembly is no longer gated.') } catch (e: any) { showError(e?.data?.detail || 'Could not save contextual cue settings') } finally { savingConfig.value = false } }
// v1.0.796 — "Approve cues automatically", persisted per project beside
// `enabled` above. Optimistic like saveConfig, but with its own revert and
// toast so flipping this doesn't misreport as an enabled/disabled change.
async function setAutoApproveCues(v: boolean): Promise<void> {
  const previous = config.value.auto_approve_cues
  config.value.auto_approve_cues = v
  savingConfig.value = true
  try {
    config.value = await put<CueConfig>(`/projects/${slug.value}/contextual-cues/config`, config.value)
    success(v
      ? 'Cues will be approved automatically once they clear every structural check. Anything that fails stays here for review.'
      : 'Manual review is back on — every proposed cue needs your approval again.')
  } catch (e: any) {
    config.value.auto_approve_cues = previous
    showError(e?.data?.detail || 'Could not save the setting')
  } finally {
    savingConfig.value = false
  }
}
async function loadTimeline(): Promise<void> {
  timeline.value = null; proposalProgress.value = null; validation.value = []; loadError.value = ''; dirty.value = false
  if (!episodeId.value || !config.value.enabled) return
  try { const data = await get<any>(`/projects/${slug.value}/contextual-cues/${episodeId.value}`); timeline.value = data.timeline; proposalProgress.value = data.proposal_progress || null; validation.value = data.validation || [] } catch (e: any) { loadError.value = e?.data?.detail || 'Could not load the episode cue timeline.' }
}
async function propose(): Promise<void> {
  if (!episodeId.value || !config.value.enabled || !form.value.model) return
  proposing.value = true
  try {
    await post(`/projects/${slug.value}/contextual-cues/${episodeId.value}/propose`, form.value)
    success('Contextual cue proposal queued. Review the timeline when the job completes.')
    setTimeout(() => { void loadTimeline() }, 1200)
  } catch (e: any) { showError(e?.data?.detail || 'Could not propose contextual cues') } finally { proposing.value = false }
}
async function saveTimeline(): Promise<void> { if (!timeline.value) return; saving.value = true; try { const data = await put<any>(`/projects/${slug.value}/contextual-cues/${episodeId.value}`, { cues: timeline.value.cues }); timeline.value = data.timeline; validation.value = data.validation || []; dirty.value = false; success('Contextual cue timeline saved') } catch (e: any) { showError(e?.data?.detail || 'Could not save the cue timeline') } finally { saving.value = false } }
watch(episodeId, () => { void loadTimeline() })
watch(() => config.value.enabled, () => { void loadTimeline() })
watch(() => config.value.auto_approve_cues, () => { void loadTimeline() })
watch(cueJobActive, (active, wasActive) => {
  if (wasActive && !active) void loadTimeline()
})
const cuePresets = usePresets<CueProposalForm>({
  slug: slug.value,
  configKey: 'contextual_cues',
  presetType: 'contextual-cues',
  snapshot: () => ({ ...form.value }),
  apply: (data) => {
    if (typeof data?.model === 'string') form.value.model = data.model
    if (data?.density === 'restrained' || data?.density === 'standard' || data?.density === 'editorial') form.value.density = data.density
    if (data?.placement === 'top-left' || data?.placement === 'top-right') form.value.placement = data.placement
    form.value.auto_approve = data?.auto_approve === true
  },
})
onMounted(async () => { await loadConfig(); await cuePresets.load() })
</script>

<style scoped>
.contextual-cues-workspace :deep(.workspace-command-surface .top-action-bar) { margin: 0; border: 0; background: transparent; box-shadow: none; }
.cues-command { display:flex; align-items:center; justify-content:space-between; gap:2rem; margin:1rem 0; padding:1.25rem 1.5rem; }
.cue-toggle-copy h2,.cue-settings h2,.cue-list h2 { margin:.25rem 0; font-size:1.1rem; }.cue-toggle-copy p,.cue-settings p { margin:0; color:var(--text-muted); max-width:46rem; }
.section-kicker { display:block; color:var(--accent-gold); text-transform:uppercase; letter-spacing:.09em; font-weight:700; font-size:.72rem; }.cue-switch { display:flex; gap:.55rem; align-items:center; font-weight:700; white-space:nowrap; }.cue-switch input { width:1.2rem; height:1.2rem; accent-color:var(--accent-gold); }
.cues-auto-command { margin-top:-.3rem; border-left:3px solid var(--accent-gold); }.cues-auto-command .cue-toggle-copy p { max-width:52rem; }
.cue-hold-reason { grid-column:1/-1; margin:.85rem 0 -.35rem; padding:.5rem .7rem; color:var(--text-primary); background:color-mix(in srgb, var(--warning) 9%, var(--bg-secondary)); border:1px solid color-mix(in srgb, var(--warning) 42%, var(--border)); border-radius:.35rem; font-size:.8rem; line-height:1.4; }
.cue-settings { display:grid; grid-template-columns:minmax(16rem, .85fr) minmax(30rem, 1.6fr); align-items:end; gap:1.5rem; margin-bottom:1rem; padding:1.25rem 1.5rem; }.cue-settings-controls { display:grid; grid-template-columns:minmax(16rem, 1.6fr) minmax(11rem, 1fr) minmax(9rem, .8fr); gap:1rem; align-items:end; }.cue-settings-controls > label { display:grid; gap:.4rem; color:var(--text-muted); font-size:.82rem; }.cue-auto-approve { grid-column:1/-1; display:flex !important; align-items:flex-start; gap:.55rem; padding:.55rem .65rem; background:var(--bg-secondary); border:1px solid var(--border-color); border-radius:.4rem; }.cue-auto-approve input { margin-top:.14rem; accent-color:var(--accent-gold); }.cue-auto-approve strong,.cue-auto-approve small { display:block; }.cue-auto-approve small { margin-top:.15rem; color:var(--text-muted); line-height:1.35; }
.cue-list { padding:1.25rem; }.cue-list-heading { display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; }.cue-row { display:grid; grid-template-columns:7.5rem 11rem minmax(20rem,1fr) auto; gap:1rem; padding:1rem 0; border-top:1px solid var(--border-color); }.cue-row.is-approved { border-left:3px solid var(--success); padding-left:.75rem; }.cue-row.is-disabled { opacity:.55; }.cue-time { color:var(--accent-gold); font-variant-numeric:tabular-nums; font-weight:700; padding-top:.55rem; }.cue-preview { min-height:4.8rem; display:flex; flex-direction:column; justify-content:center; gap:.13rem; padding:.65rem .8rem; color:#fff; background:#111827; border:1px solid #364152; border-radius:.45rem; overflow:hidden; }.cue-preview strong { font-size:.78rem; line-height:1.15; }.cue-preview small,.cue-preview-kicker { color:#b6c0d1; font-size:.6rem; letter-spacing:.08em; text-transform:uppercase; }.cue-preview-pin { color:#f4c75d; font-size:1rem; line-height:.7; }.preview-map-pin { border-left:3px solid #f4c75d; }.preview-archival-caption { color:#f4ead1; background:#2c211b; border-color:#66513f; font-family:Georgia,serif; }.preview-chapter-plate { text-align:center; background:linear-gradient(135deg,#111827,#2b3445); }.cue-fields { display:grid; grid-template-columns:1fr 1fr; gap:.5rem; }.cue-meta { grid-column:1/-1; display:flex; gap:.55rem; align-items:center; flex-wrap:wrap; }.cue-meta label { display:flex; gap:.3rem; align-items:center; color:var(--text-muted); font-size:.78rem; }.input-time { width:5.5rem; }.cue-actions { display:flex; gap:.4rem; align-items:start; }.is-active { outline:1px solid var(--accent-gold); }
@media (max-width:980px) { .cue-settings,.cue-settings-controls { grid-template-columns:1fr; } }
@media (max-width:1000px) { .cue-row { grid-template-columns:7.5rem 1fr auto; }.cue-preview { grid-column:2; } }
@media (max-width:800px) { .cues-command { align-items:stretch; flex-direction:column; }.cue-row { grid-template-columns:1fr; }.cue-preview { grid-column:auto; }.cue-fields { grid-template-columns:1fr; }.cue-actions { justify-content:flex-start; } }
</style>
