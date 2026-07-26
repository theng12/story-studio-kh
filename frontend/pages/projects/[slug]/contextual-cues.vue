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

    <section v-if="config.enabled" class="card cues-command cue-settings">
      <div>
        <span class="section-kicker">Pacing</span>
        <h2>Keep the labels intentional</h2>
        <p>One subtle documentary label at a time. Top corners are protected from the subtitle area.</p>
      </div>
      <label>Density
        <select v-model="config.density" class="select" :disabled="savingConfig" @change="saveConfig">
          <option value="restrained">Restrained — only key orientation</option>
          <option value="standard">Standard — useful context</option>
          <option value="editorial">Editorial — more frequent labels</option>
        </select>
      </label>
      <label>Default corner
        <select v-model="config.placement" class="select" :disabled="savingConfig" @change="saveConfig">
          <option value="top-right">Top right</option>
          <option value="top-left">Top left</option>
        </select>
      </label>
    </section>

    <WorkspaceNotice v-if="!config.enabled" tone="info" title="Contextual Cues are off">
      This episode will assemble normally without an annotation review gate. Enable the project setting when a documentary-style context layer adds value.
    </WorkspaceNotice>

    <template v-else>
      <section class="card cues-toolbar">
        <div>
          <span class="section-kicker">Episode</span>
          <EpisodeSelector v-model="episodeId" :project-slug="slug" filter-field="scene_plan" />
        </div>
        <div class="cues-toolbar-actions">
          <NuxtLink :to="`/projects/${slug}/scene-plan`" class="btn btn-secondary">Open Scene Plan</NuxtLink>
          <button class="btn btn-primary" :disabled="!episodeId || proposing || cueJobActive" @click="propose">
            <LoadingSpinner v-if="proposing || cueJobActive" size="sm" />
            {{ timeline?.cues?.length ? 'Refresh proposals' : 'Propose cues' }}
          </button>
        </div>
      </section>

      <WorkspaceNotice v-if="loadError" tone="warning" title="Contextual Cues need a Scene Plan">
        {{ loadError }}
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
          <div class="cue-time">{{ time(cue.start_sec) }}–{{ time(cue.end_sec) }}</div>
          <div class="cue-fields">
            <input v-model="cue.title" class="input" maxlength="80" placeholder="Main label" @input="dirty = true" />
            <input v-model="cue.subtitle" class="input" maxlength="100" placeholder="Optional second line" @input="dirty = true" />
            <div class="cue-meta">
              <select v-model="cue.kind" class="select select-sm" @change="dirty = true"><option value="location_date">Location / date</option><option value="historical_context">Historical context</option><option value="person">Person</option><option value="chapter">Chapter</option></select>
              <select v-model="cue.placement" class="select select-sm" @change="dirty = true"><option value="top-right">Top right</option><option value="top-left">Top left</option></select>
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
  template: 'documentary-label'; entrance: 'fade' | 'slide' | 'dissolve'; exit: 'fade' | 'slide' | 'dissolve'; status: 'proposed' | 'approved' | 'disabled'; created_at: string; updated_at: string
}
type CueConfig = { enabled: boolean; density: 'restrained' | 'standard' | 'editorial'; placement: 'top-left' | 'top-right'; template: 'documentary-label' }
type Timeline = { schema_version: 1; generated_at: string; source_scene_plan_generated_at: string; cues: Cue[] }

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put } = useApi()
const { success, error: showError } = useToast()
const { isJobActiveFor } = useJobs()
const episodeId = ref('')
const config = ref<CueConfig>({ enabled: false, density: 'restrained', placement: 'top-right', template: 'documentary-label' })
const timeline = ref<Timeline | null>(null)
const validation = ref<Array<{ cue_id?: string; detail: string }>>([])
const loadError = ref('')
const proposing = ref(false)
const saving = ref(false)
const savingConfig = ref(false)
const dirty = ref(false)
const cueJobActive = computed(() => isJobActiveFor(episodeId.value, ['contextual_cues']))
const proposedCount = computed(() => timeline.value?.cues.filter(cue => cue.status === 'proposed').length || 0)
const approvedCount = computed(() => timeline.value?.cues.filter(cue => cue.status === 'approved').length || 0)

function time(value: number): string { const minutes = Math.floor(value / 60); const seconds = Math.floor(value % 60); return `${minutes}:${String(seconds).padStart(2, '0')}` }
function setStatus(cue: Cue, status: Cue['status']): void { cue.status = status; dirty.value = true }
async function loadConfig(): Promise<void> { try { config.value = await get<CueConfig>(`/projects/${slug.value}/contextual-cues/config`) } catch (e: any) { showError(e?.data?.detail || 'Could not load contextual cue settings') } }
async function saveConfig(): Promise<void> { savingConfig.value = true; try { config.value = await put<CueConfig>(`/projects/${slug.value}/contextual-cues/config`, config.value); success(config.value.enabled ? 'Contextual Cues enabled' : 'Contextual Cues disabled — Video Assembly is no longer gated.') } catch (e: any) { showError(e?.data?.detail || 'Could not save contextual cue settings') } finally { savingConfig.value = false } }
async function loadTimeline(): Promise<void> {
  timeline.value = null; validation.value = []; loadError.value = ''; dirty.value = false
  if (!episodeId.value || !config.value.enabled) return
  try { const data = await get<any>(`/projects/${slug.value}/contextual-cues/${episodeId.value}`); timeline.value = data.timeline; validation.value = data.validation || [] } catch (e: any) { loadError.value = e?.data?.detail || 'Could not load the episode cue timeline.' }
}
async function propose(): Promise<void> { if (!episodeId.value) return; proposing.value = true; try { await post(`/projects/${slug.value}/contextual-cues/${episodeId.value}/propose`, {}); success('Contextual cue proposal queued. Review the timeline when the job completes.'); setTimeout(() => { void loadTimeline() }, 1200) } catch (e: any) { showError(e?.data?.detail || 'Could not propose contextual cues') } finally { proposing.value = false } }
async function saveTimeline(): Promise<void> { if (!timeline.value) return; saving.value = true; try { const data = await put<any>(`/projects/${slug.value}/contextual-cues/${episodeId.value}`, { cues: timeline.value.cues }); timeline.value = data.timeline; validation.value = data.validation || []; dirty.value = false; success('Contextual cue timeline saved') } catch (e: any) { showError(e?.data?.detail || 'Could not save the cue timeline') } finally { saving.value = false } }
watch(episodeId, () => { void loadTimeline() })
watch(() => config.value.enabled, () => { void loadTimeline() })
watch(cueJobActive, (active, wasActive) => {
  if (wasActive && !active) void loadTimeline()
})
onMounted(async () => { await loadConfig() })
</script>

<style scoped>
.cues-command { display:flex; align-items:center; justify-content:space-between; gap:2rem; margin:1rem 0; padding:1.25rem 1.5rem; }
.cue-toggle-copy h2,.cue-settings h2,.cue-list h2 { margin:.25rem 0; font-size:1.1rem; }.cue-toggle-copy p,.cue-settings p { margin:0; color:var(--text-muted); max-width:46rem; }
.section-kicker { display:block; color:var(--accent-gold); text-transform:uppercase; letter-spacing:.09em; font-weight:700; font-size:.72rem; }.cue-switch { display:flex; gap:.55rem; align-items:center; font-weight:700; white-space:nowrap; }.cue-switch input { width:1.2rem; height:1.2rem; accent-color:var(--accent-gold); }
.cue-settings { display:grid; grid-template-columns:1fr 15rem 11rem; align-items:end; gap:1rem; }.cue-settings label { display:grid; gap:.4rem; color:var(--text-muted); font-size:.82rem; }.cues-toolbar { display:flex; justify-content:space-between; align-items:end; gap:1rem; margin:1rem 0; padding:1rem 1.25rem; }.cues-toolbar :deep(.episode-selector) { min-width:28rem; }.cues-toolbar-actions { display:flex; gap:.5rem; }
.cue-list { padding:1.25rem; }.cue-list-heading { display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; }.cue-row { display:grid; grid-template-columns:7.5rem 1fr auto; gap:1rem; padding:1rem 0; border-top:1px solid var(--border-color); }.cue-row.is-approved { border-left:3px solid var(--success); padding-left:.75rem; }.cue-row.is-disabled { opacity:.55; }.cue-time { color:var(--accent-gold); font-variant-numeric:tabular-nums; font-weight:700; padding-top:.55rem; }.cue-fields { display:grid; grid-template-columns:1fr 1fr; gap:.5rem; }.cue-meta { grid-column:1/-1; display:flex; gap:.55rem; align-items:center; }.cue-meta label { display:flex; gap:.3rem; align-items:center; color:var(--text-muted); font-size:.78rem; }.input-time { width:5.5rem; }.cue-actions { display:flex; gap:.4rem; align-items:start; }.is-active { outline:1px solid var(--accent-gold); }
@media (max-width:800px) { .cues-command,.cues-toolbar { align-items:stretch; flex-direction:column; }.cue-settings { grid-template-columns:1fr; }.cues-toolbar :deep(.episode-selector) { min-width:0; }.cue-row { grid-template-columns:1fr; }.cue-fields { grid-template-columns:1fr; }.cue-actions { justify-content:flex-start; } }
</style>
