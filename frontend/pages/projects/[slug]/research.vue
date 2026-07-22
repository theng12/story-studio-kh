<!--
  v1.0.142+ — Research page real content. First production step of the
  timestamp-driven pipeline. Research generation is routed exclusively
  through the published GenStudio LLM catalog.

  Output is two sidecars in the episode dir:
    - research.json  (machine-readable, claims/citations/structure)
    - research.md    (human-readable, view in Finder)

  v1.0.143's Script Generator will pick up research.json and inject
  verified claims into its prompt context. Today the user generates
  research here, reviews claims (verify / ignore / unreviewed), and
  saves — the script gen wiring lands next release.
-->
<template>
  <div class="workspace-page creation-workspace research-workspace">
    <WorkspaceHero
      eyebrow="Create · Evidence"
      title="Research"
      description="Collect source-backed context, review claims, and pass only approved evidence into the Script Generator."
    >
      <template #aside>
        <div class="workspace-metrics" aria-label="Research workspace context">
          <span class="workspace-metric" :data-tone="episodeId ? 'success' : 'warning'"><strong>{{ episodeId || 'No episode' }}</strong> target</span>
          <span class="workspace-metric"><strong>{{ result?.claims.length || 0 }}</strong> claims</span>
          <span class="workspace-metric" :data-tone="researchReadinessTone"><strong>{{ researchReadinessLabel }}</strong> status</span>
        </div>
      </template>
    </WorkspaceHero>

    <div class="workspace-command-surface creation-command-surface">
      <TopActionBar
        :project-slug="slug"
        v-model:episode-id="episodeId"
        filter-field="research"
        :presets="researchPresets"
        generate-label="Run research"
        loading-label="Researching…"
        :generate-loading="researching || researchJobActive"
        :generate-disabled="!canRun"
        :generate-status="(researching || researchJobActive) ? `Researching for ${episodeId}…` : (canRun ? '' : runDisabledReason)"
        @generate="runResearch"
        @preset-applied="success('Research preset applied')"
        @preset-saved="success('Research preset saved')"
        @preset-renamed="success('Research preset renamed')"
        @preset-deleted="success('Research preset deleted')"
      />
      <div class="research-flow-rail" aria-label="Research workflow">
        <span class="research-flow-step" :class="{ active: !result }"><b>1</b> Brief</span>
        <span class="research-flow-line" aria-hidden="true"></span>
        <span class="research-flow-step" :class="{ active: researching || researchJobActive, complete: !!result }"><b>2</b> Gather</span>
        <span class="research-flow-line" aria-hidden="true"></span>
        <span class="research-flow-step" :class="{ active: !!result, complete: !!result && unreviewedCount === 0 }"><b>3</b> Verify</span>
        <p class="workspace-command-copy">
          Research is optional. When used, only claims you verify are passed to Script Generator.
        </p>
      </div>
    </div>

    <WorkspaceSection
      eyebrow="Research brief"
      title="Define what needs evidence"
      description="The episode title is filled automatically. Refine it only when the research question needs a narrower boundary."
      class="workspace-section research-brief-section"
    >
      <template #actions>
        <span class="research-selection-pill" :data-ready="genStudioSource?.configured ? 'true' : 'false'">
          GenStudio LLM
        </span>
      </template>

      <div class="research-brief-grid">
        <div class="research-brief-copy">
          <div class="form-group">
            <label>Research topic <span class="req">*</span></label>
            <input
              v-model="form.topic"
              class="input research-topic-input"
              placeholder="What specifically should this episode establish?"
            />
            <span class="research-field-note">Specific questions produce stronger, easier-to-review evidence.</span>
          </div>

          <div class="form-group research-questions-field">
            <label>Questions to answer <span class="research-optional-label">optional</span></label>
            <textarea
              v-model="form.specific_questions"
              class="textarea"
              rows="3"
              placeholder="One question per line, such as: What caused it? What common explanation is wrong?"
            />
          </div>
        </div>

        <aside class="research-source-panel">
          <div class="research-panel-heading">
            <span>Generation route</span>
            <small>Managed centrally</small>
          </div>
          <div v-if="sourcesLoading" class="research-source-loading">
            <LoadingSpinner size="sm" /> Checking GenStudio…
          </div>
          <div v-else class="research-source-summary">
            <span class="research-source-mark" aria-hidden="true">G</span>
            <span class="research-source-copy">
              <strong>GenStudio LLM</strong>
              <small>Uses the model selected below through your single GenStudio API connection.</small>
            </span>
            <span class="research-source-badge" :class="{ active: genStudioSource?.configured }">
              {{ genStudioSource?.configured ? 'Ready' : 'Not connected' }}
            </span>
          </div>
          <NuxtLink
            v-if="genStudioSource && !genStudioSource.configured"
            :to="`/projects/${slug}/settings#app`"
            class="research-settings-link"
          >
            Connect GenStudio in Settings
          </NuxtLink>
        </aside>
      </div>

      <div class="research-setup-surface">
        <div class="research-setup-heading">
          <div>
            <span class="research-panel-kicker">Run controls</span>
            <h3>Tune the evidence run</h3>
          </div>
          <p>Save, apply, or rename reusable research presets in the command bar above. Episode topics remain episode-specific.</p>
        </div>
        <div class="research-run-controls">
          <div class="research-model-field">
            <label>Research model</label>
            <ModelSelector v-model="form.source_model" :project-slug="slug" />
            <span class="research-field-note">Only published GenStudio LLM models appear here. Your last choice remains selected for this project.</span>
          </div>
          <div class="research-depth-field">
            <label for="research-max-sources">Source depth</label>
            <div class="research-depth-control">
              <input
                id="research-max-sources"
                v-model.number="form.max_sources"
                class="input input-sm"
                type="number"
                min="3"
                max="20"
              />
              <span>sources</span>
            </div>
            <span class="research-field-note">Guides the number of claims and references requested from the selected model.</span>
          </div>
        </div>
      </div>
    </WorkspaceSection>

    <!-- Results -->
    <WorkspaceSection
      v-if="result || researching"
      eyebrow="Evidence review"
      :title="researching ? 'Gathering evidence' : 'Verify before use'"
      :description="researching ? 'The selected source is building a reviewable evidence set.' : 'Only verified claims are passed into Script Generator. Ignored claims remain recorded but are not used.'"
      class="workspace-section research-review-section"
    >
      <template #actions>
        <div v-if="result" class="research-result-actions">
          <button class="btn btn-sm btn-primary" :disabled="saving || !dirty" @click="saveResearch">
            {{ saving ? 'Saving…' : (dirty ? 'Save review' : 'Saved') }}
          </button>
          <button
            class="btn btn-sm btn-danger"
            :disabled="deleting"
            @click="deleteResearch"
            title="Remove the research files so the next run starts clean."
          >
            {{ deleting ? 'Deleting…' : 'Delete' }}
          </button>
        </div>
      </template>

      <div v-if="researching" class="research-running-state">
        <LoadingSpinner size="sm" />
        <div>
          <strong>Research is running for {{ episodeId }}</strong>
          <span>Results will appear here automatically. You can continue elsewhere while this job runs.</span>
        </div>
      </div>

      <template v-else-if="result">
        <div class="research-review-dashboard">
          <div class="research-review-score" :data-ready="unreviewedCount === 0 ? 'true' : 'false'">
            <strong>{{ reviewProgress }}%</strong>
            <span>reviewed</span>
          </div>
          <div class="research-review-counts">
            <span data-tone="success"><b>{{ acceptedCount }}</b> verified</span>
            <span data-tone="warning"><b>{{ unreviewedCount }}</b> pending</span>
            <span><b>{{ ignoredCount }}</b> ignored</span>
            <span><b>{{ result.citations.length }}</b> sources</span>
          </div>
          <div v-if="result.claims.length" class="research-claims-bulk">
            <button type="button" class="btn btn-xs btn-primary" @click="bulkClaims('verified')" title="Mark every claim verified">Verify all</button>
            <button type="button" class="btn btn-xs btn-secondary" @click="bulkClaims('unreviewed')" title="Reset every claim to pending">Reset</button>
            <button type="button" class="btn btn-xs btn-secondary" @click="bulkClaims('ignored')" title="Ignore every claim">Ignore all</button>
          </div>
        </div>

        <p v-if="result.summary" class="research-summary">{{ result.summary }}</p>

        <ul class="research-claims-list">
          <li
            v-for="(claim, i) in result.claims"
            :key="claim.id"
            :class="['research-claim', `is-${claim.status}`]"
          >
            <div class="research-claim-index">{{ String(i + 1).padStart(2, '0') }}</div>
            <div class="research-claim-body">
              <div class="research-claim-text">
                {{ claim.text }}
                <span v-if="claim.confidence" :class="['research-conf', `conf-${claim.confidence}`]">
                  {{ claim.confidence }} confidence
                </span>
              </div>
              <div v-if="claim.note" class="research-claim-note">{{ claim.note }}</div>
              <div v-if="claim.citation_indices?.length" class="research-claim-refs">
                <span>Evidence</span>
                <a
                  v-for="idx in claim.citation_indices"
                  :key="idx"
                  class="research-cite-link"
                  :href="result.citations[idx]?.url || '#'"
                  target="_blank"
                  rel="noopener noreferrer"
                  :title="result.citations[idx]?.snippet || result.citations[idx]?.title"
                >
                  Source {{ idx + 1 }}
                </a>
              </div>
            </div>
            <div class="research-claim-actions">
              <button
                type="button"
                :class="['btn btn-sm', claim.status === 'verified' ? 'btn-primary' : 'btn-secondary']"
                @click="setClaimStatus(claim, claim.status === 'verified' ? 'unreviewed' : 'verified')"
              >
                {{ claim.status === 'verified' ? 'Verified' : 'Verify' }}
              </button>
              <button
                type="button"
                :class="['btn btn-sm', claim.status === 'ignored' ? 'btn-danger' : 'btn-secondary']"
                @click="setClaimStatus(claim, claim.status === 'ignored' ? 'unreviewed' : 'ignored')"
              >
                {{ claim.status === 'ignored' ? 'Ignored' : 'Ignore' }}
              </button>
            </div>
          </li>
        </ul>

        <AdvancedDisclosure
          v-if="result.structure?.length"
          label="Recommended episode structure"
          :badge="`${result.structure.length} sections`"
        >
          <ol class="research-structure">
            <li v-for="(s, i) in result.structure" :key="i">
              <span>{{ String(i + 1).padStart(2, '0') }}</span>
              <div><strong>{{ s.heading }}</strong><p>{{ s.brief }}</p></div>
            </li>
          </ol>
        </AdvancedDisclosure>

        <div v-if="result.citations?.length" class="research-sources-panel">
          <div class="research-sources-head">
            <div>
              <span class="research-panel-kicker">Source handoff</span>
              <h3>Sources in the video description</h3>
              <p>{{ includedSourceCount }} of {{ result.citations.length }} selected. Metadata will append their titles and links.</p>
            </div>
            <div class="research-sources-bulk">
              <button type="button" class="btn btn-xs btn-secondary" @click="bulkSources('all')">All</button>
              <button type="button" class="btn btn-xs btn-secondary" @click="bulkSources('verified')" title="Only sources cited by a verified claim">Verified only</button>
              <button type="button" class="btn btn-xs btn-secondary" @click="bulkSources('none')">None</button>
            </div>
          </div>
          <ol class="research-sources">
            <li v-for="(c, i) in result.citations" :key="i" :class="{ 'src-excluded': c.url && !isSourceIncluded(c) }">
              <label class="research-source-toggle">
                <input
                  v-if="c.url"
                  type="checkbox"
                  :checked="isSourceIncluded(c)"
                  :title="isSourceIncluded(c) ? 'Included in the description' : 'Excluded from the description'"
                  @change="setSourceIncluded(c, ($event.target as HTMLInputElement).checked)"
                />
                <span>{{ i + 1 }}</span>
              </label>
              <div class="research-source-content">
                <a v-if="c.url" :href="c.url" target="_blank" rel="noopener noreferrer">{{ c.title }}</a>
                <strong v-else>{{ c.title }}</strong>
                <p v-if="c.snippet">{{ c.snippet }}</p>
              </div>
              <span v-if="c.url && verifiedBackingIdx.has(i)" class="research-source-vbadge" title="Cited by a verified claim">Verified evidence</span>
            </li>
          </ol>
        </div>
      </template>
    </WorkspaceSection>

    <WorkspaceSection v-else class="workspace-section research-empty-section">
      <div class="research-empty-state">
        <span class="research-empty-mark">R</span>
        <div>
          <strong>{{ episodeId ? 'This episode has no research yet' : 'Choose an episode to begin' }}</strong>
          <p>{{ episodeId ? 'Confirm the topic and GenStudio model above, then run research when this story benefits from fact-checking.' : 'Research stays optional and never blocks the production pipeline.' }}</p>
        </div>
      </div>
    </WorkspaceSection>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Research')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put, del } = useApi()
const { success, error: showError } = useToast()
const { ask } = useConfirm()

const episodeId = ref('')

// v1.0.148+ — episode list (shared SWR cache via useEpisodes) so we can
// look up the picked episode's title for the topic default. Same shape
// the EpisodeSelector already uses internally — no duplicate fetch
// because useEpisodes singletons by slug.
const { episodes } = useEpisodes(slug)
const selectedEpisode = computed(() =>
  episodes.value.find(e => e.episode_code === episodeId.value) || null,
)

// `/research/sources` remains as a compatibility health endpoint, but it now
// returns one fixed GenStudio route. There is intentionally no provider picker.
interface SourceInfo {
  id: 'llm-only'
  display_name: string
  helper_text: string
  configured: boolean
}
const genStudioSource = ref<SourceInfo>({
  id: 'llm-only',
  display_name: 'GenStudio LLM',
  helper_text: 'Uses the published GenStudio language-model catalog.',
  configured: false,
})
const sourcesLoading = ref(false)

async function loadSources(): Promise<void> {
  sourcesLoading.value = true
  try {
    const r = await get<{ sources: SourceInfo[] }>('/research/sources')
    genStudioSource.value = r.sources.find(source => source.id === 'llm-only') || genStudioSource.value
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to load research sources')
  } finally {
    sourcesLoading.value = false
  }
}

// Form state contains no provider selector. The backend always dispatches to
// GenStudio; only the published GenStudio model remains user-selectable.
interface ResearchForm {
  topic: string
  specific_questions: string
  max_sources: number
  // Empty means the GenStudio Research adapter's compatibility default.
  source_model: string
}
// Per-project memory of the last GenStudio model picked.
const RESEARCH_MODEL_KEY = `research_llm_model_${slug.value}`
const form = ref<ResearchForm>({
  topic: '',
  specific_questions: '',
  max_sources: 8,
  source_model: (typeof localStorage !== 'undefined' && localStorage.getItem(RESEARCH_MODEL_KEY)) || '',
})
// Remember breadth only. Historical `source_provider` values in saved form
// state are deliberately ignored; all runs now use GenStudio.
useRememberedForm('research', slug, form, { include: ['max_sources'] })
const researchPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'research',
  presetType: 'research',
  snapshot: () => ({
    form: {
      source_model: form.value.source_model,
      specific_questions: form.value.specific_questions,
      max_sources: form.value.max_sources,
    },
  }),
  apply: (data) => {
    if (!data?.form) return
    if (typeof data.form.source_model === 'string') form.value.source_model = data.form.source_model
    if (typeof data.form.specific_questions === 'string') form.value.specific_questions = data.form.specific_questions
    if (typeof data.form.max_sources === 'number') form.value.max_sources = data.form.max_sources
  },
})
// Persist the model choice whenever it changes.
watch(() => form.value.source_model, (m) => {
  if (typeof localStorage !== 'undefined') {
    if (m) localStorage.setItem(RESEARCH_MODEL_KEY, m)
    else localStorage.removeItem(RESEARCH_MODEL_KEY)
  }
})

const canRun = computed(() => {
  if (!episodeId.value) return false
  if (!form.value.topic.trim()) return false
  if (!genStudioSource.value?.configured) return false
  return true
})
const runDisabledReason = computed(() => {
  if (!episodeId.value) return 'Pick an episode first'
  if (!form.value.topic.trim()) return 'Enter a topic'
  if (!genStudioSource.value?.configured) return 'GenStudio API not configured — App Settings → API Keys'
  return ''
})

// ── Result state ────────────────────────────────────────────────────
// `result` is the live, possibly-edited research output. `serverResult`
// is the last-saved server snapshot — used to compute the `dirty` flag
// so the Save button enables / disables correctly.
interface ResearchClaim {
  id: string
  text: string
  status: 'unreviewed' | 'verified' | 'ignored'
  citation_indices: number[]
  confidence?: 'high' | 'medium' | 'low' | 'unknown'
  note?: string
}
interface ResearchCitation { title: string; url: string; snippet?: string; include_in_description?: boolean }
interface ResearchStructureSection { heading: string; brief: string; claim_ids: string[] }
interface ResearchOutput {
  schema_version: 1
  source_provider: string
  source_model?: string
  generated_at: string
  topic: string
  specific_questions?: string
  claims: ResearchClaim[]
  citations: ResearchCitation[]
  structure?: ResearchStructureSection[]
  summary?: string
}

const result = ref<ResearchOutput | null>(null)
const serverResult = ref<string>('')  // JSON snapshot of last save for diff
// v1.0.268 — track WHICH episode is researching, not just a global boolean.
// A research run holds its flag through pollUntilLoaded (up to 90s); a plain
// page-level boolean would keep the Run button disabled (generateLoading) for a
// DIFFERENT episode the user switches to mid-job. Keying it to the episode makes
// `researching` true only when the in-flight episode is the one on screen.
// (See auto-memory: per-episode-inflight-gating.md — recurring pattern.)
const researchingEpisode = ref<string | null>(null)
const researching = computed(() => researchingEpisode.value === episodeId.value)
// v1.0.307 — also reflect a research_run already queued/running for this
// episode. `researching` only covers the brief enqueue window (it resets when
// the POST returns), so without this the button re-enabled while the job ran.
// See useJobs.isJobActiveFor — survives reloads too.
const { isJobActiveFor } = useJobs()
const researchJobActive = computed(() => isJobActiveFor(episodeId.value, ['research_run']))
const saving = ref(false)
const deleting = ref(false)

const dirty = computed(() => {
  if (!result.value) return false
  return JSON.stringify(result.value) !== serverResult.value
})
const acceptedCount = computed(() => result.value?.claims.filter(c => c.status === 'verified').length ?? 0)
const ignoredCount = computed(() => result.value?.claims.filter(c => c.status === 'ignored').length ?? 0)
const unreviewedCount = computed(() => result.value?.claims.filter(c => c.status === 'unreviewed').length ?? 0)
const reviewProgress = computed(() => {
  const total = result.value?.claims.length || 0
  if (!total) return 0
  return Math.round(((total - unreviewedCount.value) / total) * 100)
})
const researchReadinessLabel = computed(() => {
  if (researching.value || researchJobActive.value) return 'Running'
  if (!result.value) return 'Optional'
  if (unreviewedCount.value) return `${unreviewedCount.value} to review`
  if (dirty.value) return 'Unsaved'
  return 'Ready'
})
const researchReadinessTone = computed(() => {
  if (researching.value || researchJobActive.value) return 'info'
  if (!result.value) return 'info'
  if (unreviewedCount.value || dirty.value) return 'warning'
  return 'success'
})
// v1.0.197 — which sources flow into the YouTube description. Absent flag =
// included (default-on). The Metadata generator appends the kept ones.
function isSourceIncluded(c: ResearchCitation): boolean { return c.include_in_description !== false }
function setSourceIncluded(c: ResearchCitation, val: boolean): void { c.include_in_description = val }
const includedSourceCount = computed(() =>
  (result.value?.citations || []).filter(c => c.url && isSourceIncluded(c)).length,
)
// A citation index is "verified-backing" when at least one VERIFIED claim cites it.
const verifiedBackingIdx = computed(() => {
  const set = new Set<number>()
  for (const claim of result.value?.claims || []) {
    if (claim.status === 'verified') for (const idx of claim.citation_indices || []) set.add(idx)
  }
  return set
})
function bulkSources(mode: 'all' | 'verified' | 'none'): void {
  const cites = result.value?.citations || []
  cites.forEach((c, i) => {
    c.include_in_description = mode === 'all' ? true : mode === 'none' ? false : verifiedBackingIdx.value.has(i)
  })
}

async function loadExisting(): Promise<void> {
  if (!episodeId.value) {
    result.value = null
    serverResult.value = ''
    return
  }
  try {
    const r = await get<{ exists: boolean; research?: ResearchOutput }>(
      `/projects/${slug.value}/research/${episodeId.value}`,
    )
    if (r.exists && r.research) {
      result.value = r.research
      serverResult.value = JSON.stringify(r.research)
      // Hydrate the form from the loaded research so re-running shows
      // the same topic / questions / model the user used last time. Historical
      // source_provider values remain audit evidence and never restore a route.
      form.value.topic = r.research.topic
      form.value.specific_questions = r.research.specific_questions || ''
      if (r.research.source_model) {
        form.value.source_model = r.research.source_model
      }
    } else {
      result.value = null
      serverResult.value = ''
      // v1.0.148+ — no saved research yet → reset the form to the
      // newly-picked episode's defaults so we don't carry the prior
      // episode's topic/questions across. (Switching from EP0001
      // to EP0002 would otherwise leave EP0001's title in the topic
      // field, since we seeded it last load.)
      //
      // Seed `topic` from the episode title so the user doesn't have
      // to retype what they already picked in the episode selector —
      // the Ideas Generator titles (e.g. "From Lava to Loam: How
      // Volcanic Eruptions Fertilize Deserts") are already well-
      // bounded research subjects, exactly matching the "specific is
      // better than broad" hint we surface under the input.
      //
      // If `useEpisodes` hasn't resolved yet, leave topic blank —
      // the `selectedEpisode` watcher below backfills the moment
      // the title arrives.
      form.value.topic = selectedEpisode.value?.title || ''
      form.value.specific_questions = ''
    }
  } catch (e: any) {
    if (e?.__slugRace) return
    // Non-fatal — the empty-state card renders.
  }
}

async function runResearch(): Promise<void> {
  if (!canRun.value) return
  const ep = episodeId.value          // pin the episode this run belongs to
  researchingEpisode.value = ep
  try {
    await post<{ job_id: string }>(`/projects/${slug.value}/research/${ep}/run`, {
      topic: form.value.topic.trim(),
      specific_questions: form.value.specific_questions.trim() || undefined,
      max_sources: form.value.max_sources,
      model: form.value.source_model || undefined,
      title: form.value.topic.trim(),  // best-effort title hint for path resolution
    })
    success('Research job queued — watch the Jobs panel for progress')
    // The job runs async; poll for completion by re-loading every 3s
    // until research.json shows up + matches the topic we just sent.
    await pollUntilLoaded(form.value.topic.trim(), ep)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to start research')
  } finally {
    // Only clear if a LATER run for another episode hasn't taken over.
    if (researchingEpisode.value === ep) researchingEpisode.value = null
  }
}

async function pollUntilLoaded(expectedTopic: string, ep: string): Promise<void> {
  const start = Date.now()
  const timeoutMs = 90_000
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 3000))
    // User switched episodes — stop polling; that episode's own loader owns its
    // state now, and this poll must not overwrite it via loadExisting().
    if (episodeId.value !== ep) return
    await loadExisting()
    if (result.value && result.value.topic === expectedTopic) return
  }
  if (episodeId.value === ep) showError('Research job is taking longer than 90s — check the Jobs panel for details.')
}

async function saveResearch(): Promise<void> {
  if (!result.value || !episodeId.value) return
  saving.value = true
  try {
    await put(`/projects/${slug.value}/research/${episodeId.value}`, result.value)
    serverResult.value = JSON.stringify(result.value)
    success('Research saved')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to save research')
  } finally {
    saving.value = false
  }
}

async function deleteResearch(): Promise<void> {
  if (!episodeId.value) return
  const ok = await ask({
    title: 'Delete research?',
    message: 'Removes research.json + research.md from the episode dir. The next Run starts fresh.',
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return
  deleting.value = true
  try {
    await del(`/projects/${slug.value}/research/${episodeId.value}`)
    result.value = null
    serverResult.value = ''
    success('Research deleted')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to delete research')
  } finally {
    deleting.value = false
  }
}

function setClaimStatus(claim: ResearchClaim, status: ResearchClaim['status']): void {
  claim.status = status
}

/**
 * Bulk-set every surfaced claim's review status in one click. `dirty` is a
 * deep-compare computed against the saved snapshot, so this flips Save on
 * automatically — the user still has to Save to persist.
 */
function bulkClaims(status: ResearchClaim['status']): void {
  if (!result.value) return
  for (const c of result.value.claims) c.status = status
}

// Hydrate on mount + episode change.
onMounted(loadSources)
watch(episodeId, () => { void loadExisting() }, { immediate: true })

// v1.0.148+ — race guard for the topic seed: useEpisodes may resolve
// AFTER loadExisting() already returned with no saved research. In
// that case loadExisting saw selectedEpisode === null and skipped
// the seed. Watch the title separately so the moment the episode list
// arrives we backfill the topic — but only when:
//   - no saved research is loaded (result is null), AND
//   - the user hasn't already started typing (topic is empty).
watch(
  () => selectedEpisode.value?.title,
  (title) => {
    if (!title) return
    if (result.value) return  // existing research wins
    if (form.value.topic.trim()) return  // user edits win
    form.value.topic = title
  },
)
</script>

<style scoped>
.research-workspace {
  --research-success: #55c786;
  --research-warning: #e0a548;
  --research-danger: #d66b63;
}

.research-flow-rail {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 4px 0;
  border-top: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
}
.research-flow-step {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
}
.research-flow-step b {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-secondary);
  font-size: 10px;
}
.research-flow-step.active { color: var(--accent); }
.research-flow-step.active b { border-color: var(--accent); background: var(--accent-dim); }
.research-flow-step.complete { color: var(--research-success); }
.research-flow-step.complete b { border-color: color-mix(in srgb, var(--research-success) 55%, transparent); }
.research-flow-line { width: 26px; height: 1px; background: var(--border); }
.research-flow-rail .workspace-command-copy { margin: 0 0 0 auto; }

.research-selection-pill {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 11px;
  border: 1px solid color-mix(in srgb, var(--research-warning) 45%, var(--border));
  border-radius: 999px;
  color: var(--research-warning);
  background: color-mix(in srgb, var(--research-warning) 9%, transparent);
  font-size: 11px;
  font-weight: 700;
}
.research-selection-pill[data-ready='true'] {
  border-color: color-mix(in srgb, var(--research-success) 45%, var(--border));
  color: var(--research-success);
  background: color-mix(in srgb, var(--research-success) 9%, transparent);
}

.research-brief-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(340px, 0.8fr);
  gap: 18px;
  align-items: stretch;
}
.research-brief-copy,
.research-source-panel {
  min-width: 0;
}
.research-brief-copy {
  display: flex;
  flex-direction: column;
  gap: 13px;
}
.research-brief-copy label,
.research-advanced-grid label {
  display: block;
  margin-bottom: 6px;
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 700;
}
.research-topic-input { font-size: 14px; font-weight: 600; }
.research-questions-field { margin: 0; }
.research-optional-label {
  margin-left: 5px;
  color: var(--text-muted);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.research-field-note {
  display: block;
  margin-top: 5px;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.45;
}

.research-source-panel {
  padding: 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 10px);
  background:
    linear-gradient(145deg, color-mix(in srgb, var(--accent) 5%, transparent), transparent 55%),
    var(--bg-secondary);
}
.research-panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.research-panel-heading small { color: var(--text-muted); font-size: 10px; font-weight: 600; }
.research-source-loading { display: flex; align-items: center; gap: 8px; min-height: 78px; color: var(--text-muted); font-size: 12px; }
.research-source-summary {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  gap: 9px;
  align-items: center;
  min-height: 58px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 7px);
  color: var(--text-primary);
  background: var(--accent-dim);
}
.research-source-mark {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  color: var(--bg-primary);
  background: var(--text-primary);
  font-weight: 800;
}
.research-source-copy { display: grid; min-width: 0; gap: 2px; }
.research-source-copy strong { font-size: 12px; }
.research-source-copy small { color: var(--text-muted); font-size: 10px; line-height: 1.35; }
.research-source-badge {
  padding: 2px 7px;
  border-radius: 999px;
  color: var(--research-warning);
  background: color-mix(in srgb, var(--research-warning) 12%, transparent);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.research-source-badge.active { color: var(--research-success); background: color-mix(in srgb, var(--research-success) 12%, transparent); }
.research-settings-link { display: inline-flex; margin-top: 8px; color: var(--accent); font-size: 10px; text-decoration: none; }
.research-settings-link:hover { text-decoration: underline; }

.research-setup-surface {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px 14px;
  margin-top: 16px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 10px);
  background: color-mix(in srgb, var(--bg-secondary) 88%, var(--accent) 12%);
}
.research-setup-heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 14px;
  grid-column: 1 / -1;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}
.research-setup-heading h3 { margin: 2px 0 0; font-size: 14px; }
.research-setup-heading p {
  max-width: 440px;
  margin: 0;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.45;
  text-align: right;
}
.research-run-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 210px;
  gap: 14px;
  padding: 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 7px);
  background: var(--bg-secondary);
}
.research-model-field,
.research-depth-field { min-width: 0; }
.research-depth-control { display: flex; align-items: center; gap: 8px; }
.research-depth-control .input { width: 80px; }
.research-depth-control span { color: var(--text-muted); font-size: 11px; }
.research-result-actions { display: flex; align-items: center; gap: 7px; }
.research-running-state {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 90px;
  padding: 18px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  border-radius: var(--radius-md, 10px);
  background: var(--accent-dim);
}
.research-running-state div { display: grid; gap: 4px; }
.research-running-state strong { font-size: 13px; }
.research-running-state span { color: var(--text-muted); font-size: 11px; }

.research-review-dashboard {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr) auto;
  gap: 14px;
  align-items: center;
  margin-bottom: 12px;
  padding: 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 10px);
  background: var(--bg-secondary);
}
.research-review-score {
  display: grid;
  place-items: center;
  min-height: 58px;
  border: 1px solid color-mix(in srgb, var(--research-warning) 45%, var(--border));
  border-radius: 8px;
  color: var(--research-warning);
  background: color-mix(in srgb, var(--research-warning) 8%, transparent);
}
.research-review-score[data-ready='true'] { border-color: color-mix(in srgb, var(--research-success) 45%, var(--border)); color: var(--research-success); background: color-mix(in srgb, var(--research-success) 8%, transparent); }
.research-review-score strong { font-size: 18px; line-height: 1; }
.research-review-score span { margin-top: -5px; font-size: 8px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
.research-review-counts { display: flex; flex-wrap: wrap; gap: 7px; }
.research-review-counts span { padding: 5px 8px; border: 1px solid var(--border); border-radius: 999px; color: var(--text-muted); font-size: 10px; }
.research-review-counts span[data-tone='success'] { color: var(--research-success); }
.research-review-counts span[data-tone='warning'] { color: var(--research-warning); }
.research-claims-bulk { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }

.research-summary {
  margin: 0 0 12px;
  padding: 11px 13px;
  border-left: 3px solid var(--accent);
  border-radius: 0 var(--radius-sm, 7px) var(--radius-sm, 7px) 0;
  color: var(--text-secondary, var(--text-primary));
  background: linear-gradient(90deg, var(--accent-dim), transparent);
  font-size: 12px;
  line-height: 1.55;
}
.research-claims-list { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; }
.research-claim {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto;
  gap: 11px;
  align-items: start;
  padding: 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 7px);
  background: var(--bg-secondary);
}
.research-claim.is-verified { border-color: color-mix(in srgb, var(--research-success) 42%, var(--border)); background: linear-gradient(90deg, color-mix(in srgb, var(--research-success) 6%, transparent), var(--bg-secondary) 35%); }
.research-claim.is-ignored { opacity: 0.58; }
.research-claim-index { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 6px; color: var(--text-muted); background: var(--bg-primary); font-size: 9px; font-weight: 800; }
.research-claim-body { min-width: 0; }
.research-claim-text { color: var(--text-primary); font-size: 12px; line-height: 1.5; }
.research-claim-note { margin-top: 4px; color: var(--text-muted); font-size: 10px; line-height: 1.45; }
.research-claim-refs { display: flex; align-items: center; gap: 6px; margin-top: 6px; color: var(--text-muted); font-size: 9px; }
.research-cite-link { color: var(--accent); text-decoration: none; }
.research-cite-link:hover { text-decoration: underline; }
.research-claim-actions { display: flex; align-items: center; gap: 6px; }
.research-conf { display: inline-flex; margin-left: 6px; padding: 2px 6px; border-radius: 999px; font-size: 8px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap; }
.conf-high { color: var(--research-success); background: color-mix(in srgb, var(--research-success) 13%, transparent); }
.conf-medium { color: var(--research-warning); background: color-mix(in srgb, var(--research-warning) 13%, transparent); }
.conf-low, .conf-unknown { color: var(--research-danger); background: color-mix(in srgb, var(--research-danger) 13%, transparent); }

.research-review-section :deep(.adv-disclosure) { margin-top: 12px; }
.research-structure { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.research-structure li { display: grid; grid-template-columns: 26px 1fr; gap: 9px; padding: 8px 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-secondary); }
.research-structure li > span { color: var(--accent); font-size: 9px; font-weight: 800; }
.research-structure strong { font-size: 11px; }
.research-structure p { margin: 2px 0 0; color: var(--text-muted); font-size: 10px; line-height: 1.4; }

.research-sources-panel { margin-top: 12px; padding: 13px; border: 1px solid var(--border); border-radius: var(--radius-md, 10px); background: var(--bg-secondary); }
.research-sources-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 14px; margin-bottom: 9px; }
.research-panel-kicker { color: var(--accent); font-size: 8px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; }
.research-sources-head h3 { margin: 2px 0; font-size: 13px; }
.research-sources-head p { margin: 0; color: var(--text-muted); font-size: 10px; }
.research-sources-bulk { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.research-sources { display: grid; gap: 5px; margin: 0; padding: 0; list-style: none; }
.research-sources li { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-primary); }
.research-sources li.src-excluded { opacity: 0.46; }
.research-source-toggle { display: grid; place-items: center; position: relative; width: 30px; height: 30px; border-radius: 6px; color: var(--text-muted); background: var(--bg-secondary); font-size: 9px; font-weight: 800; cursor: pointer; }
.research-source-toggle input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.research-source-toggle:has(input:checked) { color: var(--accent); outline: 1px solid var(--accent); }
.research-source-content { min-width: 0; }
.research-source-content a,
.research-source-content strong { color: var(--text-primary); font-size: 11px; font-weight: 700; text-decoration: none; }
.research-source-content a:hover { color: var(--accent); }
.research-source-content p { overflow: hidden; margin: 2px 0 0; color: var(--text-muted); font-size: 9px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.research-source-vbadge { padding: 2px 7px; border-radius: 999px; color: var(--research-success); background: color-mix(in srgb, var(--research-success) 12%, transparent); font-size: 8px; font-weight: 800; white-space: nowrap; }

.research-empty-state { display: flex; align-items: center; gap: 13px; min-height: 74px; }
.research-empty-mark { display: grid; place-items: center; width: 44px; height: 44px; flex: 0 0 auto; border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--border)); border-radius: 12px; color: var(--accent); background: var(--accent-dim); font-family: Georgia, serif; font-size: 19px; font-weight: 700; }
.research-empty-state div { display: grid; gap: 3px; }
.research-empty-state strong { font-size: 13px; }
.research-empty-state p { margin: 0; color: var(--text-muted); font-size: 11px; line-height: 1.5; }

.req { color: var(--research-danger); font-weight: 800; }

@media (max-width: 1080px) {
  .research-brief-grid { grid-template-columns: 1fr; }
  .research-flow-rail .workspace-command-copy { display: none; }
  .research-setup-surface { grid-template-columns: 1fr; }
  .research-setup-heading { grid-column: 1; }
}

@media (max-width: 760px) {
  .research-flow-line { width: 12px; }
  .research-flow-step { font-size: 9px; }
  .research-run-controls { grid-template-columns: 1fr; }
  .research-setup-heading { align-items: flex-start; flex-direction: column; }
  .research-setup-heading p { text-align: left; }
  .research-review-dashboard { grid-template-columns: 74px 1fr; }
  .research-claims-bulk { grid-column: 1 / -1; justify-content: flex-start; }
  .research-claim { grid-template-columns: 26px minmax(0, 1fr); }
  .research-claim-actions { grid-column: 2; }
  .research-sources-head { align-items: flex-start; flex-direction: column; }
  .research-sources li { grid-template-columns: 34px minmax(0, 1fr); }
  .research-source-vbadge { grid-column: 2; justify-self: start; }
}
</style>
