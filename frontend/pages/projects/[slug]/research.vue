<!--
  v1.0.142+ — Research page real content. First production step of the
  timestamp-driven pipeline. Source adapters (user picks per-episode):
    - Perplexity (direct)            requires perplexity API key
    - LLM-only with disclaimers      uses any text-provider key

  Output is two sidecars in the episode dir:
    - research.json  (machine-readable, claims/citations/structure)
    - research.md    (human-readable, view in Finder)

  v1.0.143's Script Generator will pick up research.json and inject
  verified claims into its prompt context. Today the user generates
  research here, reviews claims (verify / ignore / unreviewed), and
  saves — the script gen wiring lands next release.
-->
<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Research</h1>
    </div>

    <TopActionBar
      :project-slug="slug"
      v-model:episode-id="episodeId"
      filter-field="research"
      generate-label="Run research"
      loading-label="Researching…"
      :generate-loading="researching || researchJobActive"
      :generate-disabled="!canRun"
      :generate-status="(researching || researchJobActive) ? `Researching for ${episodeId}…` : (canRun ? '' : runDisabledReason)"
      @generate="runResearch"
    />

    <p class="text-muted mt-1 mb-2">
      Research + fact-checking phase. Produces a <code>research.json</code>
      sidecar the Script Generator will consume (v1.0.143+) so factual
      claims trace back to real sources. Pick a source, set the topic,
      run. Review the returned claims and mark <strong>verified</strong> /
      <strong>ignored</strong> before saving.
    </p>

    <PresetPicker
      label="Research preset"
      hint="Saves the source, model, source limit, and reusable questions for one-click Pipeline runs. The episode title becomes each run's topic."
      :presets="researchPresets.presets.value"
      :active-id="researchPresets.activeId.value"
      @update:active-id="researchPresets.setActive"
      @apply="researchPresets.applyActive(); success('Research preset applied')"
      @overwrite="researchPresets.overwrite(); success('Research preset saved')"
      @save-as="(n: string) => researchPresets.saveAs(n).then(() => success(`Saved: ${n}`))"
      @rename="(n: string) => researchPresets.rename(n)"
      @delete="researchPresets.remove()"
    />

    <!-- Source picker -->
    <section class="card mt-3">
      <h3>1. Source</h3>
      <p class="text-muted text-sm mt-1">
        Each source has tradeoffs — pick per episode based on what the
        topic needs.
      </p>
      <div v-if="sourcesLoading" class="text-muted text-sm mt-2">Loading sources…</div>
      <div v-else class="research-source-grid mt-2">
        <button
          v-for="src in sources"
          :key="src.id"
          type="button"
          :class="['research-source-card', { active: form.source_provider === src.id, unconfigured: !src.configured }]"
          @click="form.source_provider = src.id"
          :title="src.configured ? '' : 'API key not configured — see App Settings → API Keys'"
        >
          <div class="research-source-card-head">
            <strong>{{ src.display_name }}</strong>
            <span v-if="!src.configured" class="research-source-badge">no key</span>
            <span v-else-if="form.source_provider === src.id" class="research-source-badge active">picked</span>
          </div>
          <p class="text-muted text-xs research-source-helper">{{ src.helper_text }}</p>
        </button>
      </div>

      <!-- v1.0.175 — model picker for the LLM-only source. The web-search
           source (Perplexity) is bound to its own search-capable models,
           so the picker only appears for LLM-only — there you can use any
           configured provider (kie.ai, OpenAI, DeepSeek, Anthropic…).
           Replaces the old hardcoded Anthropic default; your choice is
           remembered per project. -->
      <div v-if="form.source_provider === 'llm-only'" class="research-model-row mt-3">
        <ModelSelector v-model="form.source_model" :project-slug="slug" />
        <p class="text-muted text-xs mt-1">
          Pick any text model from a provider you've configured. Leave on a
          provider you actually pay for — there's no forced default.
        </p>
      </div>
    </section>

    <!-- Form -->
    <section class="card mt-3">
      <h3>2. Topic + questions</h3>
      <div class="form-group mt-2">
        <label>Episode topic <span class="req">*</span></label>
        <input
          v-model="form.topic"
          class="input"
          placeholder="e.g. Why the Tacoma Narrows Bridge collapsed in 1940"
        />
        <span class="text-muted text-xs">
          Specific is better than broad. "World War II" → too wide.
          "Why the German invasion of Norway in 1940 succeeded" → right-sized.
        </span>
      </div>
      <div class="form-group mt-2">
        <label>Specifically answer these (optional)</label>
        <textarea
          v-model="form.specific_questions"
          class="textarea"
          rows="3"
          placeholder="Anything you want addressed in the research, one per line. e.g.&#10;What was the actual cause of the collapse?&#10;Why is 'resonance' the wrong answer?"
        />
      </div>
      <div class="form-group mt-2">
        <label>Max sources to consult</label>
        <input
          v-model.number="form.max_sources"
          class="input input-sm input-inline"
          type="number"
          min="3"
          max="20"
        />
        <span class="text-muted text-xs ml-1">
          Adapters round / interpret this — Perplexity tends to honor
          it; LLM-only treats it as a hint.
        </span>
      </div>
    </section>

    <!-- Results -->
    <section
      v-if="result || researching"
      class="card mt-3"
    >
      <div class="flex justify-between items-center">
        <h3>3. Results</h3>
        <div v-if="result" class="flex gap-2 items-center">
          <span class="text-muted text-xs">
            {{ result.claims.length }} claim{{ result.claims.length === 1 ? '' : 's' }}
            · {{ result.citations.length }} source{{ result.citations.length === 1 ? '' : 's' }}
            · {{ acceptedCount }} verified, {{ ignoredCount }} ignored, {{ unreviewedCount }} pending
          </span>
          <button class="btn btn-sm btn-primary" :disabled="saving || !dirty" @click="saveResearch">
            {{ saving ? 'Saving…' : (dirty ? 'Save' : 'Saved') }}
          </button>
          <button
            class="btn btn-sm btn-danger"
            :disabled="deleting"
            @click="deleteResearch"
            title="Remove the research.json sidecar so the next run starts clean."
          >
            {{ deleting ? 'Deleting…' : '✕ Delete' }}
          </button>
        </div>
      </div>

      <div v-if="researching" class="text-muted mt-2">
        <LoadingSpinner size="sm" /> Adapter is running. Web-search
        adapters typically take 10-30s; LLM-only is faster but lower
        quality.
      </div>

      <template v-else-if="result">
        <p v-if="result.summary" class="text-sm mt-2 research-summary">
          {{ result.summary }}
        </p>

        <h4 class="mt-3">Claims</h4>
        <p class="text-muted text-xs">
          Mark each claim — only <strong>verified</strong> claims flow
          into the Script Generator (v1.0.143+).
        </p>
        <div v-if="result.claims.length" class="research-claims-bulk">
          <span class="text-muted text-xs">Bulk:</span>
          <button type="button" class="btn btn-xs btn-primary" @click="bulkClaims('verified')" title="Mark every claim verified">✓ Verify all</button>
          <button type="button" class="btn btn-xs btn-secondary" @click="bulkClaims('unreviewed')" title="Reset every claim to unreviewed (pending)">↺ Reset all</button>
          <button type="button" class="btn btn-xs btn-secondary" @click="bulkClaims('ignored')" title="Ignore every claim">⊘ Ignore all</button>
        </div>
        <ul class="research-claims-list">
          <li
            v-for="(claim, i) in result.claims"
            :key="claim.id"
            :class="['research-claim', `is-${claim.status}`]"
          >
            <div class="research-claim-text">
              <strong>{{ i + 1 }}.</strong>
              {{ claim.text }}
              <span v-if="claim.confidence" :class="['research-conf', `conf-${claim.confidence}`]">
                {{ claim.confidence }}
              </span>
            </div>
            <div v-if="claim.note" class="text-muted text-xs research-claim-note">
              {{ claim.note }}
            </div>
            <div
              v-if="claim.citation_indices?.length"
              class="text-muted text-xs research-claim-refs"
            >
              <a
                v-for="idx in claim.citation_indices"
                :key="idx"
                class="research-cite-link"
                :href="result.citations[idx]?.url || '#'"
                target="_blank"
                rel="noopener noreferrer"
                :title="result.citations[idx]?.snippet || result.citations[idx]?.title"
              >
                [{{ idx + 1 }}]
              </a>
            </div>
            <div class="research-claim-actions">
              <button
                type="button"
                :class="['btn btn-sm', claim.status === 'verified' ? 'btn-primary' : 'btn-secondary']"
                @click="setClaimStatus(claim, claim.status === 'verified' ? 'unreviewed' : 'verified')"
              >
                ✓ Verified
              </button>
              <button
                type="button"
                :class="['btn btn-sm', claim.status === 'ignored' ? 'btn-danger' : 'btn-secondary']"
                @click="setClaimStatus(claim, claim.status === 'ignored' ? 'unreviewed' : 'ignored')"
              >
                ✕ Ignored
              </button>
            </div>
          </li>
        </ul>

        <h4 class="mt-3" v-if="result.structure?.length">Recommended structure</h4>
        <ul class="research-structure" v-if="result.structure?.length">
          <li v-for="(s, i) in result.structure" :key="i">
            <strong>{{ s.heading }}</strong>
            <span class="text-muted"> — {{ s.brief }}</span>
          </li>
        </ul>

        <div v-if="result.citations?.length" class="research-sources-head mt-3">
          <h4>Sources</h4>
          <div class="research-sources-bulk">
            <span class="text-muted text-xs">In video description ({{ includedSourceCount }}):</span>
            <button type="button" class="btn btn-xs btn-secondary" @click="bulkSources('all')">All</button>
            <button type="button" class="btn btn-xs btn-secondary" @click="bulkSources('verified')" title="Only sources cited by a verified claim">Verified-backing</button>
            <button type="button" class="btn btn-xs btn-ghost" @click="bulkSources('none')">None</button>
          </div>
        </div>
        <p v-if="result.citations?.length" class="text-muted text-xs research-sources-note">
          Ticked sources are appended (title + link) to the YouTube description when you generate Metadata. Tick per source or use the bulk buttons, then <strong>Save</strong>.
        </p>
        <ol class="research-sources" v-if="result.citations?.length">
          <li v-for="(c, i) in result.citations" :key="i" :class="{ 'src-excluded': c.url && !isSourceIncluded(c) }">
            <input
              v-if="c.url"
              type="checkbox"
              class="research-source-check"
              :checked="isSourceIncluded(c)"
              :title="isSourceIncluded(c) ? 'Included in the description' : 'Excluded from the description'"
              @change="setSourceIncluded(c, ($event.target as HTMLInputElement).checked)"
            />
            <a v-if="c.url" :href="c.url" target="_blank" rel="noopener noreferrer">{{ c.title }}</a>
            <span v-else>{{ c.title }}</span>
            <span v-if="c.url && verifiedBackingIdx.has(i)" class="research-source-vbadge" title="Cited by a verified claim">verified-backing</span>
            <div v-if="c.snippet" class="text-muted text-xs research-source-snippet">{{ c.snippet }}</div>
          </li>
        </ol>
      </template>
    </section>

    <section v-else class="card mt-3">
      <p class="text-muted text-sm">
        No research yet for this episode. Pick a source above, set the
        topic, and click <strong>Run research</strong>.
      </p>
    </section>
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

// v1.0.142+ — Source list comes from /research/sources so the
// configured-or-not state stays in sync with the live key store.
interface SourceInfo {
  id: 'perplexity' | 'llm-only'
  display_name: string
  helper_text: string
  configured: boolean
}
const sources = ref<SourceInfo[]>([])
const sourcesLoading = ref(false)

async function loadSources(): Promise<void> {
  sourcesLoading.value = true
  try {
    const r = await get<{ sources: SourceInfo[] }>('/research/sources')
    sources.value = r.sources
    // Default the picker to the first CONFIGURED source so the user
    // can run immediately without poking the picker. Only override
    // if form.source_provider isn't already set to a configured one.
    const current = sources.value.find(s => s.id === form.value.source_provider)
    if (!current || !current.configured) {
      const firstReady = sources.value.find(s => s.configured)
      if (firstReady) form.value.source_provider = firstReady.id
    }
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to load research sources')
  } finally {
    sourcesLoading.value = false
  }
}

// Form state — defaults to the llm-only adapter since it works with any
// configured text-provider key (Anthropic / OpenAI / kie.ai); the page
// still auto-selects the first CONFIGURED source on load.
interface ResearchForm {
  source_provider: 'perplexity' | 'llm-only'
  topic: string
  specific_questions: string
  max_sources: number
  // v1.0.175 — model for the LLM-only source. Empty = adapter default.
  // Ignored by the web-search sources (they're bound to search models).
  source_model: string
}
// Per-project memory of the last LLM-only model picked, so the page stops
// silently defaulting to Anthropic for users who don't use it.
const RESEARCH_MODEL_KEY = `research_llm_model_${slug.value}`
const form = ref<ResearchForm>({
  source_provider: 'llm-only',
  topic: '',
  specific_questions: '',
  max_sources: 8,
  source_model: (typeof localStorage !== 'undefined' && localStorage.getItem(RESEARCH_MODEL_KEY)) || '',
})
// v1.0.259 — remember the source + breadth across reloads (NOT topic /
// specific_questions — those are episode content). source_model already has
// its own per-project key (above), so it's left out of the allowlist.
useRememberedForm('research', slug, form, { include: ['source_provider', 'max_sources'] })
const researchPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'research',
  presetType: 'research',
  snapshot: () => ({
    form: {
      source_provider: form.value.source_provider,
      source_model: form.value.source_model,
      specific_questions: form.value.specific_questions,
      max_sources: form.value.max_sources,
    },
  }),
  apply: (data) => { if (data?.form) Object.assign(form.value, data.form) },
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
  const src = sources.value.find(s => s.id === form.value.source_provider)
  if (!src?.configured) return false
  return true
})
const runDisabledReason = computed(() => {
  if (!episodeId.value) return 'Pick an episode first'
  if (!form.value.topic.trim()) return 'Enter a topic'
  const src = sources.value.find(s => s.id === form.value.source_provider)
  if (!src?.configured) return `${src?.display_name ?? 'Source'} not configured — App Settings → API Keys`
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
      // the same topic / questions / source the user used last time.
      form.value.source_provider = r.research.source_provider as ResearchForm['source_provider']
      form.value.topic = r.research.topic
      form.value.specific_questions = r.research.specific_questions || ''
      // v1.0.175 — restore the LLM-only model used last time (if it was an
      // llm-only run); keep the persisted choice otherwise.
      if (r.research.source_provider === 'llm-only' && r.research.source_model) {
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
      source_provider: form.value.source_provider,
      topic: form.value.topic.trim(),
      specific_questions: form.value.specific_questions.trim() || undefined,
      max_sources: form.value.max_sources,
      // Only meaningful for llm-only; backend ignores it for web sources.
      model: form.value.source_provider === 'llm-only' && form.value.source_model
        ? form.value.source_model
        : undefined,
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
.research-source-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}
.research-source-card {
  text-align: left;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.research-source-card:hover { border-color: var(--accent); }
/* v1.0.147+ — was `rgba(108, 143, 255, 0.08)` (a hardcoded blue tint
   that fought the app's amber accent palette). Now uses the same
   accent-dim variable the rest of the app uses for "this is the
   selected thing" backgrounds, so the source picker matches the
   active-tab + active-nav-item visual register everywhere else. */
.research-source-card.active { border-color: var(--accent); background: var(--accent-dim); }
/* v1.0.147+ — `:not(.active)` so picking an unconfigured source
   doesn't dim the card the user just clicked (the dim-to-60%
   "you can't pick this" cue should drop the moment they DO pick
   it — the "no key" badge alone carries the warning from there). */
.research-source-card.unconfigured:not(.active) { opacity: 0.6; }
.research-source-card-head { display: flex; align-items: center; gap: 6px; }
.research-source-helper { margin: 4px 0 0; line-height: 1.45; }
.research-source-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(201, 122, 74, 0.16);
  color: #c97a4a;
}
.research-source-badge.active {
  background: var(--accent);
  color: var(--accent-on);
}

.research-summary {
  background: var(--bg-secondary);
  border-left: 3px solid var(--accent);
  padding: 8px 10px;
  border-radius: 4px;
}
.research-claims-bulk { display: flex; align-items: center; gap: 6px; margin: 6px 0 4px; flex-wrap: wrap; }
.research-claims-list { list-style: none; padding: 0; margin: 6px 0 0; display: flex; flex-direction: column; gap: 6px; }
.research-claim {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-secondary);
}
.research-claim.is-verified { border-left: 3px solid #5bb37c; }
.research-claim.is-ignored { border-left: 3px solid #c97a4a; opacity: 0.6; }
.research-claim-text { font-size: 13px; line-height: 1.5; }
.research-claim-note { margin-top: 4px; line-height: 1.5; }
.research-claim-refs { margin-top: 4px; }
.research-cite-link {
  margin-right: 4px;
  color: var(--accent);
  text-decoration: none;
}
.research-cite-link:hover { text-decoration: underline; }
.research-claim-actions { display: flex; gap: 6px; margin-top: 6px; }
.research-conf {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  margin-left: 6px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.conf-high { background: rgba(91, 179, 124, 0.16); color: #5bb37c; }
.conf-medium { background: rgba(212, 160, 23, 0.16); color: #d4a017; }
.conf-low, .conf-unknown { background: rgba(201, 122, 74, 0.16); color: #c97a4a; }

.research-structure { margin: 6px 0 0; padding-left: 22px; }
.research-structure li { margin: 4px 0; line-height: 1.5; }
.research-sources { margin: 6px 0 0; padding-left: 4px; font-size: 12px; list-style: none; }
.research-sources li { margin: 6px 0; line-height: 1.5; }
.research-source-snippet { margin-top: 2px; font-style: italic; }

/* v1.0.197 — sources-in-description controls. */
.research-sources-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.research-sources-head h4 { margin: 0; }
.research-sources-bulk { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.research-sources-note { margin: 4px 0 0; line-height: 1.5; }
.research-source-check { margin-right: 6px; vertical-align: middle; }
.research-sources li.src-excluded { opacity: 0.5; }
.research-source-vbadge {
  font-size: 10px;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(91, 179, 124, 0.16);
  color: #5bb37c;
}

.req { color: var(--error, #e25c5c); font-weight: bold; }
.input-inline { width: 80px; }
.ml-1 { margin-left: 4px; }
</style>
