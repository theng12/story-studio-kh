<!--
  v1.0.142+ — Research page real content. First production step of the
  timestamp-driven pipeline. Research runs exclusively through the published
  GenStudio catalog.

  Output is two sidecars in the episode dir:
    - research.json  (machine-readable, claims/citations/structure)
    - research.md    (human-readable, view in Finder)

  The Script Generator picks up research.json and injects the claims the
  user KEPT (status 'verified') into its prompt context.

  v1.0.761 — there is exactly ONE decision on this page: the per-claim
  Verified / Ignore triage. The research-level state is derived from it
  (every claim decided = reviewed; at least one kept = usable), so the
  separate "Verify research" attestation banner is gone. Do not bring it back.

  ── TWO MODES, TWO DIFFERENT PROMISES ────────────────────────────────────
  "Model knowledge only" answers from what the model already knows: reliable
  on well-established facts, unable to cite live sources. "Search the web"
  runs a qualified GenStudio model that searches and records what it read;
  those sources back the RUN, never an individual claim (claim-to-citation
  mapping does not exist yet). Never let either mode borrow the other's
  wording, and never render a per-claim source link in web mode.
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
      />
      <div class="research-flow-rail" aria-label="Research workflow">
        <span class="research-flow-step" :class="{ active: !result }"><b>1</b> Brief</span>
        <span class="research-flow-line" aria-hidden="true"></span>
        <span class="research-flow-step" :class="{ active: researching || researchJobActive, complete: !!result }"><b>2</b> Gather</span>
        <span class="research-flow-line" aria-hidden="true"></span>
        <span class="research-flow-step" :class="{ active: !!result && !reviewComplete, complete: reviewComplete }"><b>3</b> Review</span>
        <p class="workspace-command-copy">
          <template v-if="researchRequired">
            This project requires research: generating it is not enough — an episode counts as complete once every
            claim has a <b>Verified</b> or <b>Ignore</b> decision and at least one is kept. Pipeline runs decide the
            leftovers automatically and record that a machine did it.
          </template>
          <template v-else>
            Research is optional for this project. When used, only claims you verify are passed to Script Generator.
          </template>
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

        <!-- Research mode. Two genuinely different promises, so they are a
             visible choice rather than a hidden setting. Web mode is offered
             only when GenStudio publishes a model that qualifies for it; when
             none does, the option stays visible and explains itself instead of
             disappearing without a word. -->
        <fieldset class="research-mode-field">
          <legend>Research mode</legend>
          <div class="research-mode-options">
            <label class="research-mode-option" :class="{ selected: form.research_mode === 'model-knowledge' }">
              <input
                v-model="form.research_mode"
                type="radio"
                name="research-mode"
                value="model-knowledge"
              />
              <span class="research-mode-copy">
                <strong>Model knowledge only</strong>
                <small>{{ MODEL_KNOWLEDGE_NOTICE }}</small>
              </span>
            </label>
            <label
              class="research-mode-option"
              :class="{ selected: form.research_mode === 'web-search', disabled: !webModeAvailable }"
            >
              <input
                v-model="form.research_mode"
                type="radio"
                name="research-mode"
                value="web-search"
                :disabled="!webModeAvailable"
              />
              <span class="research-mode-copy">
                <strong>Search the web</strong>
                <small v-if="webModeLoading">Checking which models can search the web…</small>
                <small v-else-if="!webModeAvailable">{{ webModeReason }}</small>
                <small v-else>{{ WEB_SEARCH_MODE_BLURB }}</small>
              </span>
            </label>
          </div>
        </fieldset>

        <div class="research-run-controls">
          <div class="research-model-field">
            <label>Research model</label>
            <!-- Web mode may only offer models GenStudio has qualified, so it
                 keeps its own list — but it is the SAME centred dialog every
                 other picker uses. It was the last native <select> left, and
                 it was the one mode actually in daily use. -->
            <ModelMenu
              v-if="webMode"
              v-model="form.web_model"
              :options="webModelMenuOptions"
              :loading="webModeLoading"
              media-type="llm"
              title="Choose a web-research model"
              placeholder="Pick a web-research model…"
              search-placeholder="Search web-research models…"
              aria-label="Web-research model options"
            />
            <ModelSelector v-else v-model="form.source_model" :project-slug="slug" />
            <span class="research-field-note">
              <template v-if="webMode">Only models qualified to search the web and return structured citations appear here.</template>
              <template v-else>Only published GenStudio LLM models appear here. Your last choice remains selected for this project.</template>
            </span>
          </div>
          <!-- Depth control. Hidden unless the SELECTED web model publishes an
               enforceable search cap (`max_web_searches`). A null cap means
               GenStudio cannot enforce a provider-side search count for that
               model, and in model-knowledge mode the number was only ever a
               prompt hint — offering a control that changes nothing would be a
               lie. Read per selection, so the control appears and disappears
               with the model rather than with a release. -->
          <div v-if="depthCapLimit" class="research-depth-field">
            <label for="research-max-sources">Search depth</label>
            <div class="research-depth-control">
              <input
                id="research-max-sources"
                v-model.number="form.max_sources"
                class="input input-sm"
                type="number"
                min="1"
                :max="depthCapLimit"
              />
              <span>searches</span>
            </div>
            <span class="research-field-note">This model caps a run at {{ depthCapLimit }} searches.</span>
          </div>
        </div>

        <!-- Domain filters: only when the SELECTED model advertises them. A
             filter the provider ignores is worse than none — the user would
             believe their sources were constrained when they were not. -->
        <div v-if="webMode && selectedWebModel?.supports_domain_filters" class="research-domain-controls">
          <div class="research-domain-field">
            <label for="research-allowed-domains">Only search these sites <span class="research-optional-label">optional</span></label>
            <input
              id="research-allowed-domains"
              v-model="form.allowed_domains"
              class="input input-sm"
              placeholder="nature.com, nasa.gov"
            />
          </div>
          <div class="research-domain-field">
            <label for="research-blocked-domains">Never search these sites <span class="research-optional-label">optional</span></label>
            <input
              id="research-blocked-domains"
              v-model="form.blocked_domains"
              class="input input-sm"
              placeholder="example-content-farm.com"
            />
          </div>
          <span class="research-field-note">Comma-separated domains. Saved with your research presets.</span>
        </div>

        <!-- Cost, stated as a RATE. There is no depth control and the provider
             decides how many searches to make, so there is no honest total to
             show before the run. The ACTUAL charge is reported afterwards. -->
        <p v-if="webMode && webCostNote" class="research-cost-note">{{ webCostNote }}</p>
      </div>
    </WorkspaceSection>

    <!-- Results -->
    <WorkspaceSection
      v-if="result || researching"
      eyebrow="Evidence review"
      :title="researching ? 'Gathering evidence' : 'Decide claim by claim'"
      :description="researching ? 'The selected source is building a reviewable evidence set.' : 'Only verified claims are passed into Script Generator. Ignored claims remain recorded but are not used.'"
      class="workspace-section research-review-section"
    >
      <template #actions>
        <div v-if="result" class="research-result-actions">
          <button
            class="btn btn-sm btn-primary"
            :disabled="saving || !dirty"
            title="Save your Verified / Ignore decisions. That is what makes this research count as reviewed."
            @click="saveResearch"
          >
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
        <!-- v1.0.761 — review state, DERIVED from the per-claim decisions
             below. There is no separate attest button: deciding each claim
             is the whole job. This banner only reports where that stands and
             what it means for the episode. -->
        <div class="research-review-banner" :data-state="reviewState">
          <div class="research-review-copy">
            <strong v-if="reviewState === 'empty'">No claims to review</strong>
            <strong v-else-if="reviewState === 'pending'">{{ unreviewedCount }} of {{ claimCount }} claims still need a decision</strong>
            <strong v-else-if="reviewState === 'none-usable'">Reviewed — every claim ignored</strong>
            <strong v-else-if="reviewState === 'auto'">Accepted automatically by a Pipeline run</strong>
            <strong v-else>Review complete</strong>

            <p v-if="reviewState === 'empty'">
              This run returned no claims, so there is nothing to review and nothing for the Script Generator to
              use. Re-run research for this episode.
            </p>
            <p v-else-if="reviewState === 'pending'">
              Mark each claim <b>Verified</b> to keep it or <b>Ignore</b> to drop it, then <b>Save review</b>.
              <template v-if="researchRequired">
                <b>{{ episodeId }}</b> counts as complete once no claim is left pending and at least one is kept.
              </template>
              <template v-else>
                This project treats research as optional, so nothing is blocked either way.
              </template>
            </p>
            <p v-else-if="reviewState === 'none-usable'">
              You read every claim and kept none, so this research hands the Script Generator nothing.
              Keep at least one claim, or re-run research for better ones.
              <template v-if="researchRequired">
                <b>{{ episodeId }}</b> stays incomplete until something is kept.
              </template>
            </p>
            <p v-else-if="reviewState === 'auto'">
              An unattended one-click Pipeline run accepted the remaining claims so the batch could finish.
              <b>No human read them.</b> Your own Verified / Ignore decisions replace that the moment you save.
              <span v-if="reviewedAtLabel"> Completed automatically {{ reviewedAtLabel }}.</span>
            </p>
            <p v-else>
              Every claim has a decision: {{ acceptedCount }} kept, {{ ignoredCount }} ignored. Only the kept
              claims go to the Script Generator.
              <span v-if="reviewedAtLabel">Reviewed {{ reviewedAtLabel }}.</span>
              Re-running research resets all of this.
            </p>
          </div>
        </div>

        <!-- Provenance for the mode this run ACTUALLY used (read from the
             sidecar, not from the form — the form may have been changed since).
             The two modes never share wording: model-knowledge output cites
             nothing, and web output cites the RUN, not each claim. -->
        <p class="research-provenance-note">
          {{ resultProvenanceNotice }}
          <span v-if="resultRanOnLabel"> Research ran on {{ resultRanOnLabel }}.</span>
          <span v-if="resultMode === 'web-search'"> {{ webRunReportLabel }}</span>
        </p>

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
              <!-- An absent citation is a fact the reviewer needs, but only
                   where absence actually means something. In model-knowledge
                   mode it always does. In web mode it means something only
                   once this run has linked at least one claim to a source:
                   until then the sources are run-level and marking every
                   claim "no source cited" would misreport a run that did
                   cite sources. -->
              <div v-else-if="resultMode !== 'web-search'" class="research-claim-nocite">
                {{ MODEL_KNOWLEDGE_CLAIM_NOTE }}
              </div>
              <div v-else-if="attributedClaimCount > 0" class="research-claim-nocite">
                {{ WEB_SEARCH_CLAIM_UNCITED_NOTE }}
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

        <!-- A web run that cited nothing is surfaced, not hidden. Without this
             the page would promise "cited its sources" over an empty space. -->
        <p v-if="resultMode === 'web-search' && !result.citations?.length && !resultHasSourceUrls" class="research-nosources-note">
          {{ WEB_SEARCH_NO_SOURCES_NOTICE }}
        </p>

        <div v-if="resultMode === 'web-search' && resultHasSourceUrls" class="research-sources-panel research-retrieved-pages">
          <div class="research-sources-head">
            <div>
              <span class="research-panel-kicker">Run-level evidence</span>
              <h3>Pages GenStudio reported retrieving</h3>
              <p>These are pages the provider reported opening. They are not citations and do not back individual claims.</p>
            </div>
          </div>
          <ul>
            <li v-for="url in resultSourceUrls" :key="url">
              <a :href="url" target="_blank" rel="noopener noreferrer">{{ url }}</a>
            </li>
          </ul>
        </div>

        <div v-if="result.citations?.length" class="research-sources-panel">
          <div class="research-sources-head">
            <div>
              <span class="research-panel-kicker">Source handoff</span>
              <h3>Sources in the video description</h3>
              <p>
                {{ includedSourceCount }} of {{ result.citations.length }} selected. Metadata will append their titles and links.
                <template v-if="resultMode === 'web-search' && attributedClaimCount === 0">
                  These sources back the whole run — they are not linked to individual claims.
                </template>
                <template v-else-if="resultMode === 'web-search'">
                  {{ attributedClaimCount }} of {{ result.claims?.length || 0 }} claims link to the specific
                  sources that back them.
                </template>
              </p>
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
                <!-- publisher / published_at are shown only when the provider
                     actually supplied them; neither is reliable today. -->
                <span v-if="sourceAttribution(c)" class="research-source-meta">{{ sourceAttribution(c) }}</span>
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
          <p v-if="episodeId && researchRequired">
            This project requires research. Confirm the topic and GenStudio model above, run research, then decide
            each claim — {{ episodeId }} will not count as complete until every claim is decided and at least one
            is kept.
          </p>
          <p v-else-if="episodeId">
            Confirm the topic and GenStudio model above, then run research when this story benefits from a
            reviewed evidence set.
          </p>
          <p v-else>
            Pick an episode to see whether it needs research and how far its claim review has got.
          </p>
        </div>
      </div>
    </WorkspaceSection>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import {
  MODEL_KNOWLEDGE_CLAIM_NOTE,
  MODEL_KNOWLEDGE_NOTICE,
  researchRanAt,
  WEB_SEARCH_CLAIM_UNCITED_NOTE,
  WEB_SEARCH_MODE_BLURB,
  WEB_SEARCH_NO_SOURCES_NOTICE,
  webResearchNotice,
} from '../../../../electron/server/services/research/provenance'

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
const { episodes, revalidateAfterMutation: refreshEpisodes } = useEpisodes(slug)
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

type ResearchMode = 'model-knowledge' | 'web-search'

// Form state contains no provider selector. The backend always dispatches to
// GenStudio; the user picks the MODE and the published GenStudio model.
interface ResearchForm {
  topic: string
  specific_questions: string
  max_sources: number
  // Empty means the GenStudio Research adapter's compatibility default.
  source_model: string
  /** Which route to run. Default = the unchanged model-knowledge path. */
  research_mode: ResearchMode
  /** Web-mode model, kept separate from `source_model` so switching modes
   *  never silently submits a model the other mode cannot use. */
  web_model: string
  /** Comma-separated domain filters. Only sent in web mode, and only when the
   *  selected model advertises domain filters. */
  allowed_domains: string
  blocked_domains: string
}
// Per-project memory of the last GenStudio model picked.
const RESEARCH_MODEL_KEY = `research_llm_model_${slug.value}`
const form = ref<ResearchForm>({
  topic: '',
  specific_questions: '',
  max_sources: 8,
  source_model: (typeof localStorage !== 'undefined' && localStorage.getItem(RESEARCH_MODEL_KEY)) || '',
  research_mode: 'model-knowledge',
  web_model: '',
  allowed_domains: '',
  blocked_domains: '',
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
      research_mode: form.value.research_mode,
      web_model: form.value.web_model,
      allowed_domains: form.value.allowed_domains,
      blocked_domains: form.value.blocked_domains,
    },
  }),
  apply: (data) => {
    if (!data?.form) return
    if (typeof data.form.source_model === 'string') form.value.source_model = data.form.source_model
    if (typeof data.form.specific_questions === 'string') form.value.specific_questions = data.form.specific_questions
    if (typeof data.form.max_sources === 'number') form.value.max_sources = data.form.max_sources
    // A preset saved before web search existed has no mode; it can only have
    // meant model knowledge. Anything unrecognised resolves the same way —
    // never optimistically upgrade a preset into a mode that spends credits.
    form.value.research_mode = data.form.research_mode === 'web-search' ? 'web-search' : 'model-knowledge'
    if (typeof data.form.web_model === 'string') form.value.web_model = data.form.web_model
    if (typeof data.form.allowed_domains === 'string') form.value.allowed_domains = data.form.allowed_domains
    if (typeof data.form.blocked_domains === 'string') form.value.blocked_domains = data.form.blocked_domains
  },
})
// Persist the model choice whenever it changes.
watch(() => form.value.source_model, (m) => {
  if (typeof localStorage !== 'undefined') {
    if (m) localStorage.setItem(RESEARCH_MODEL_KEY, m)
    else localStorage.removeItem(RESEARCH_MODEL_KEY)
  }
})

// ── Web-search availability ─────────────────────────────────────────────
// The backend filters the published catalog by CAPABILITY ONLY (six
// conditions — see services/research/web-capability.ts). This page never
// decides eligibility itself and never matches on a model name.
//
// Web search is live on GenStudio and qualified models are published, so
// `available` is normally true. It was false at launch, when nothing was
// research-qualified, and this page turned itself on with no code change here.
// Both answers stay first-class: the option is visible and self-explaining
// either way, and neither is assumed before the read.
interface WebResearchModel {
  id: string
  display_name: string
  credits_per_search: number | null
  /** Flat per-request web-research rate, charged on top of the per-search
   *  figure. Published alongside it; both are RATES, neither is a total. */
  credits_per_request: number | null
  max_web_searches: number | null
  supports_domain_filters: boolean
  /** Published `returns_citations`. Optional so an older backend response
   *  still types; absent means unpublished, which states nothing. */
  returns_citations?: boolean
}
const webModels = ref<WebResearchModel[]>([])
const webModeAvailable = ref(false)
const webModeReason = ref('')
const webModeLoading = ref(false)

async function loadWebModels(): Promise<void> {
  webModeLoading.value = true
  try {
    const r = await get<{ available: boolean; reason: string; models: WebResearchModel[] }>(
      '/research/web-models',
    )
    webModels.value = Array.isArray(r.models) ? r.models : []
    webModeAvailable.value = r.available === true && webModels.value.length > 0
    webModeReason.value = r.reason || ''
    if (!webModels.value.some(m => m.id === form.value.web_model)) {
      form.value.web_model = webModels.value[0]?.id || ''
    }
  } catch {
    // Never claim "nothing qualifies" from a failed request — that would be a
    // guess about GenStudio's inventory drawn from a local network problem.
    webModels.value = []
    webModeAvailable.value = false
    webModeReason.value = 'Could not check which models can search the web. Model-knowledge research still works.'
  } finally {
    webModeLoading.value = false
  }
}

// Web mode can never be the ACTIVE mode while it is unavailable, no matter
// what a preset or remembered form restored.
const webMode = computed(() => form.value.research_mode === 'web-search' && webModeAvailable.value)
watch(webModeAvailable, (available) => {
  if (!available && form.value.research_mode === 'web-search') form.value.research_mode = 'model-knowledge'
})

const selectedWebModel = computed<WebResearchModel | null>(() =>
  webModels.value.find(m => m.id === form.value.web_model) || webModels.value[0] || null,
)

/**
 * The web-research rows for the shared model dialog.
 *
 * Every line is a PUBLISHED research fact and nothing else. No provider is
 * shown: `ChatModelResponse` publishes none, and one is never reconstructed
 * from an id or a name. A fact GenStudio has not published is simply absent
 * from the row — an unpublished cap or rate is never filled in with a
 * plausible number, and never rendered as free or as unlimited.
 */
const webModelMenuOptions = computed(() => webModels.value.map((model) => {
  const facts: string[] = []
  if (typeof model.credits_per_request === 'number') {
    facts.push(`${model.credits_per_request} credit${model.credits_per_request === 1 ? '' : 's'} per request`)
  }
  if (typeof model.credits_per_search === 'number') {
    facts.push(`${model.credits_per_search} credit${model.credits_per_search === 1 ? '' : 's'} per search`)
  }
  if (typeof model.max_web_searches === 'number' && model.max_web_searches > 0) {
    facts.push(`up to ${model.max_web_searches} searches per run`)
  }
  return {
    id: model.id,
    label: model.display_name,
    group: 'GenStudio KH',
    meta: facts.join(' · '),
    badges: [
      ...(model.returns_citations ? [{ label: 'Cites sources', tone: 'info' as const }] : []),
      ...(model.supports_domain_filters ? [{ label: 'Domain filters', tone: 'neutral' as const }] : []),
    ],
  }
}))
/** The depth control exists ONLY when the selected web model publishes an
 *  enforceable cap. A null cap hides it: GenStudio cannot enforce a
 *  provider-side search count for that model, and in model-knowledge mode the
 *  number was only ever a prompt hint. Re-derived on every selection change. */
const depthCapLimit = computed<number | null>(() => {
  if (!webMode.value) return null
  const cap = selectedWebModel.value?.max_web_searches
  return typeof cap === 'number' && cap > 0 ? cap : null
})
/** Cost stated as RATES only. GenStudio publishes two: a flat per-REQUEST
 *  web-research charge and a per-SEARCH charge, and a run pays both. With no
 *  depth control and the provider deciding how many searches to run, there is
 *  still no honest total to quote up front — so this page discloses each
 *  published rate and multiplies nothing into a customer charge. */
const webCostNote = computed(() => {
  const perSearch = selectedWebModel.value?.credits_per_search
  const perRequest = selectedWebModel.value?.credits_per_request
  const rates: string[] = []
  if (typeof perRequest === 'number') {
    rates.push(`Web research costs ${perRequest} credit${perRequest === 1 ? '' : 's'} per request`)
  }
  if (typeof perSearch === 'number') {
    rates.push(`${rates.length ? 'plus' : 'Each web search costs'} ${perSearch} credit${perSearch === 1 ? '' : 's'}`
      + `${rates.length ? ' per search' : ''}`)
  }
  if (!rates.length) return ''
  return `${rates.join(', ')}. `
    + 'The model decides how many searches to make, so the total varies per run — the actual charge is shown '
    + 'here once the run finishes.'
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
interface ResearchCitation {
  /** GenStudio's id for this source within the run. Per-claim links are
   *  resolved from it server-side; the page reads the resulting indices. */
  source_id?: string
  title: string
  url: string
  snippet?: string
  include_in_description?: boolean
  /** Neither is reliable yet — shown only when the provider supplied it. */
  publisher?: string
  published_at?: string
  /** Stored only. In a JSON answer these arrive as 0..0 and anchor nowhere,
   *  which is why per-claim links come from grounded claim attribution. */
  start_index?: number
  end_index?: number
}
interface ResearchStructureSection { heading: string; brief: string; claim_ids: string[] }
/** v1.0.761 — WHO finished the per-claim triage. Provenance only: whether the
 *  research counts as reviewed is derived from the claim statuses. */
interface ResearchReviewRecord {
  completed_by: 'human' | 'pipeline-auto'
  completed_at?: string
  note?: string
}
/** GenStudio's CONFIRMED envelope field names (cloud-api chat/schemas.py).
 *  The two `@deprecated` names are what v1.0.764 guessed; sidecars written by
 *  that release still carry them, so they are still read and never written. */
interface ResearchWebRunReport {
  source_urls?: string[]
  research_evidence_level?: 'attributed_claim_citations' | 'claim_citations' | 'source_urls_only'
  web_searches_executed?: number
  /** The web-search ADD-ON cost, not the run's total charge. */
  web_search_credit_cost?: number
  /** GenStudio's own record of when the run finished. Beats generated_at. */
  research_ran_at?: string
  /** In the contract, unpopulated by every provider today. Parsed, not shown:
   *  citations still back the RUN, never an individual claim. */
  citation_claims?: Array<{ claim_id: string; citation_ids: string[] }>
  credits_per_search?: number
  /** Flat per-request web-research rate published at run time. */
  credits_per_request?: number
  allowed_domains?: string[]
  blocked_domains?: string[]
  /** @deprecated read-only back-compat */
  searches_performed?: number
  /** @deprecated read-only back-compat */
  credits_charged?: number
}
interface ResearchOutput {
  schema_version: 1
  source_provider: string
  source_model?: string
  /** ABSENT = model-knowledge. Every sidecar written before web search existed
   *  came from the no-web-access route, so that is its only honest reading. */
  research_mode?: ResearchMode
  /** What a web run actually did / cost, when GenStudio reported it. */
  web_run?: ResearchWebRunReport
  generated_at: string
  topic: string
  specific_questions?: string
  claims: ResearchClaim[]
  citations: ResearchCitation[]
  structure?: ResearchStructureSection[]
  summary?: string
  /** v1.0.761 — review provenance. Absent = nobody has finished the triage. */
  review?: ResearchReviewRecord
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
// ── v1.0.761 — the per-claim triage IS the research-level state ─────────
// Counts ignore blank placeholder claims, matching the backend's
// readResearchTriage() so this page and the Production Board never disagree
// about whether the review is finished.
const reviewableClaims = computed(() => (result.value?.claims || []).filter(c => c.text?.trim()))
const claimCount = computed(() => reviewableClaims.value.length)
const acceptedCount = computed(() => reviewableClaims.value.filter(c => c.status === 'verified').length)
const ignoredCount = computed(() => reviewableClaims.value.filter(c => c.status === 'ignored').length)
const unreviewedCount = computed(() => reviewableClaims.value.filter(c => c.status !== 'verified' && c.status !== 'ignored').length)
const reviewProgress = computed(() => {
  const total = claimCount.value
  if (!total) return 0
  return Math.round(((total - unreviewedCount.value) / total) * 100)
})
// Reviewed = nothing left pending (and there IS something). Complete also
// needs a kept claim: "I ignored all of them" is a real editorial outcome, but
// it leaves the script with no evidence, which is what the gate exists to stop.
const reviewed = computed(() => claimCount.value > 0 && unreviewedCount.value === 0)
const reviewComplete = computed(() => reviewed.value && acceptedCount.value > 0)
const reviewRecord = computed<ResearchReviewRecord | null>(() => result.value?.review || null)
const completedByPipeline = computed(() => reviewRecord.value?.completed_by === 'pipeline-auto')
/** Which story the banner tells. Derived — never a stored flag. */
const reviewState = computed<'empty' | 'pending' | 'none-usable' | 'auto' | 'reviewed'>(() => {
  if (!claimCount.value) return 'empty'
  if (!reviewed.value) return 'pending'
  if (!acceptedCount.value) return 'none-usable'
  return completedByPipeline.value ? 'auto' : 'reviewed'
})
// Echoed by the backend on every episode status row — the SAME resolution the
// completion rule used, so this page and the Production Board never disagree.
const researchRequired = computed(() => (selectedEpisode.value?.status as any)?.research_required === true)
const reviewedAtLabel = computed(() => {
  const at = reviewRecord.value?.completed_at
  if (!at) return ''
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString()
})

const researchReadinessLabel = computed(() => {
  if (researching.value || researchJobActive.value) return 'Running'
  if (!result.value) return researchRequired.value ? 'Required' : 'Optional'
  if (dirty.value) return 'Unsaved'
  if (!claimCount.value) return 'No claims'
  if (unreviewedCount.value) return `${unreviewedCount.value} to review`
  if (!acceptedCount.value) return 'All ignored'
  return completedByPipeline.value ? 'Auto-accepted' : 'Reviewed'
})
const researchReadinessTone = computed(() => {
  if (researching.value || researchJobActive.value) return 'info'
  if (!result.value) return researchRequired.value ? 'warning' : 'info'
  if (dirty.value || !reviewComplete.value) return 'warning'
  if (completedByPipeline.value) return 'warning'
  return 'success'
})
// ── Provenance of the LOADED result ─────────────────────────────────────
// Read from the sidecar, never from the form: the form may have been changed
// since the run, and the page must describe what actually happened.
//
// A sidecar with no `research_mode` predates web search, so it can only be
// model-knowledge. Never treat an unknown value as web-search.
const resultMode = computed<ResearchMode>(() => {
  const raw = result.value?.research_mode
  if (raw === 'web-search') return 'web-search'
  if (raw === 'model-knowledge') return 'model-knowledge'
  return result.value?.source_provider === 'genstudio-web' ? 'web-search' : 'model-knowledge'
})
/** Claims GenStudio actually linked to a source it verified was retrieved.
 *  Zero means this run has run-level sources only — either the model sourced
 *  nothing, or GenStudio could not ground what it named. Both keep the
 *  weaker, run-level wording rather than borrowing the stronger one. */
const attributedClaimCount = computed(
  () => (result.value?.claims || []).filter(c => c.citation_indices?.length).length,
)
const resultSourceUrls = computed(() => {
  const urls: string[] = []
  const seen = new Set<string>()
  for (const raw of result.value?.web_run?.source_urls || []) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    try {
      const url = new URL(raw.trim())
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      const canonical = url.toString()
      if (!seen.has(canonical)) {
        seen.add(canonical)
        urls.push(canonical)
      }
    } catch { /* edited legacy sidecars may contain malformed URLs */ }
  }
  return urls
})
const resultWebRun = computed(() => ({
  ...result.value?.web_run,
  source_urls: resultSourceUrls.value,
}))
const resultHasSourceUrls = computed(() => resultSourceUrls.value.length > 0)
const resultProvenanceNotice = computed(() => {
  if (resultMode.value !== 'web-search') return MODEL_KNOWLEDGE_NOTICE
  return webResearchNotice(
    result.value?.citations?.length || 0,
    attributedClaimCount.value,
    result.value?.claims?.length || 0,
    resultWebRun.value,
  )
})
/** Run-level recency. There is no per-source retrieval timestamp on purpose —
 *  GenStudio does not fetch the pages, so one would be falsely precise.
 *  GenStudio's `research_ran_at` is preferred when the envelope supplied it;
 *  `generated_at` (when this app wrote the sidecar) is the fallback. */
const resultRanOnLabel = computed(() => {
  const at = researchRanAt(result.value?.web_run, result.value?.generated_at)
  if (!at) return ''
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString()
})
/** What the run actually did and what the SEARCHES cost, exactly as GenStudio
 *  reported them under its confirmed field names. Nothing is computed locally,
 *  and an unreported value says so.
 *
 *  "Web search cost" — not "charged": the envelope field is
 *  `web_search_credit_cost`, the search ADD-ON only, so labelling it as the
 *  total bill would misreport what the user paid. */
const webRunReportLabel = computed(() => {
  const run = result.value?.web_run
  const searches = run?.web_searches_executed ?? run?.searches_performed
  const searchCost = run?.web_search_credit_cost ?? run?.credits_charged
  if (searches === undefined && searchCost === undefined) {
    return 'GenStudio did not report how many searches this run made or what the search cost.'
  }
  const parts: string[] = []
  parts.push(searches === undefined ? 'Searches executed: not reported.' : `Searches executed: ${searches}.`)
  parts.push(searchCost === undefined
    ? 'Web search cost: not reported.'
    : `Web search cost: ${searchCost} credits.`)
  return parts.join(' ')
})
/** Publisher / date, only when the provider actually supplied them. */
function sourceAttribution(c: ResearchCitation): string {
  return [c.publisher, c.published_at].filter(Boolean).join(' · ')
}

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
      // Re-running should repeat what this episode last did — but only if that
      // mode is still on offer. A previously-web episode falls back to model
      // knowledge rather than presenting a mode that cannot run.
      const loadedMode = resultMode.value
      if (loadedMode === 'web-search' && webModeAvailable.value) {
        form.value.research_mode = 'web-search'
        if (r.research.source_model && webModels.value.some(m => m.id === r.research!.source_model)) {
          form.value.web_model = r.research.source_model
        }
      } else {
        form.value.research_mode = 'model-knowledge'
        if (r.research.source_model && loadedMode !== 'web-search') {
          form.value.source_model = r.research.source_model
        }
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
    // Domain filters are sent only in web mode; the backend drops them again
    // unless the SELECTED model advertises domain filters, so a filter the
    // provider would ignore never looks like it was applied.
    await post<{ job_id: string }>(`/projects/${slug.value}/research/${ep}/run`, {
      topic: form.value.topic.trim(),
      specific_questions: form.value.specific_questions.trim() || undefined,
      max_sources: form.value.max_sources,
      research_mode: webMode.value ? 'web-search' : 'model-knowledge',
      model: (webMode.value ? form.value.web_model : form.value.source_model) || undefined,
      ...(webMode.value
        ? {
            allowed_domains: form.value.allowed_domains,
            blocked_domains: form.value.blocked_domains,
          }
        : {}),
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
    // The backend derives the review record from what this save changed, so
    // adopt what it wrote back rather than guessing locally.
    const r = await put<{ review: ResearchReviewRecord | null }>(
      `/projects/${slug.value}/research/${episodeId.value}`,
      result.value,
    )
    if (result.value) {
      if (r?.review) result.value.review = r.review
      else delete result.value.review
    }
    serverResult.value = JSON.stringify(result.value)
    // Completion may have just flipped — refresh the rows the selector, the
    // pending filter and the Production Board read.
    await refreshEpisodes()
    success(reviewComplete.value
      ? 'Review saved — every claim decided'
      : 'Research saved')
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

// Hydrate both live source state and reusable setup. Research previously
// omitted the shared preset load entirely, so saves reached config.json but
// disappeared from the page after navigation.
onMounted(async () => {
  await Promise.all([
    loadSources(),
    loadWebModels(),
    researchPresets.load(),
  ])
})
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

/* v1.0.761 — review-state banner. Derived from the per-claim triage; it
   reports, it never asks for a second decision. */
.research-review-banner {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 14px 16px;
  margin-bottom: 10px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  background: color-mix(in srgb, var(--surface-2, var(--surface)) 80%, transparent);
}
.research-review-banner[data-state='pending'] {
  border-color: color-mix(in srgb, var(--research-warning) 60%, var(--border));
  background: color-mix(in srgb, var(--research-warning) 12%, transparent);
}
.research-review-banner[data-state='auto'] {
  border-color: color-mix(in srgb, var(--research-warning) 42%, var(--border));
}
.research-review-banner[data-state='empty'],
.research-review-banner[data-state='none-usable'] {
  border-color: color-mix(in srgb, var(--research-danger) 55%, var(--border));
  background: color-mix(in srgb, var(--research-danger) 10%, transparent);
}
.research-review-banner[data-state='reviewed'] {
  border-color: color-mix(in srgb, var(--research-success) 50%, var(--border));
  background: color-mix(in srgb, var(--research-success) 10%, transparent);
}
.research-review-copy {
  flex: 1 1 320px;
  min-width: 0;
}
.research-review-copy strong {
  display: block;
  font-size: 14px;
  margin-bottom: 4px;
}
.research-review-copy p {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-muted, inherit);
}
/* Provenance disclosure — llm-only research is not fact-checking. */
.research-provenance-note {
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted, inherit);
}
.research-claim-nocite {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.4;
  color: color-mix(in srgb, var(--research-warning) 70%, var(--text-muted, currentColor));
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.research-field-note {
  display: block;
  margin-top: 5px;
  color: var(--text-muted);
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.research-panel-heading small { color: var(--text-muted); font-size: var(--font-xs); font-weight: 600; }
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
.research-source-copy small { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.35; }
.research-source-badge {
  padding: 2px 7px;
  border-radius: 999px;
  color: var(--research-warning);
  background: color-mix(in srgb, var(--research-warning) 12%, transparent);
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.research-source-badge.active { color: var(--research-success); background: color-mix(in srgb, var(--research-success) 12%, transparent); }
.research-settings-link { display: inline-flex; margin-top: 8px; color: var(--accent); font-size: var(--font-xs); text-decoration: none; }
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
  font-size: var(--font-xs);
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

/* Research mode. Both options stay visible even when web search is
   unavailable — the disabled option explains itself instead of vanishing. */
.research-mode-field {
  grid-column: 1 / -1;
  margin: 0;
  padding: 0;
  border: 0;
}
.research-mode-field legend {
  margin-bottom: 6px;
  padding: 0;
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 700;
}
.research-mode-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 9px;
}
.research-mode-option {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 9px;
  align-items: start;
  padding: 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 7px);
  background: var(--bg-secondary);
  cursor: pointer;
}
.research-mode-option.selected {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  background: var(--accent-dim);
}
.research-mode-option.disabled { opacity: 0.62; cursor: not-allowed; }
.research-mode-option input { margin-top: 2px; }
.research-mode-copy { display: grid; min-width: 0; gap: 3px; }
.research-mode-copy strong { font-size: 12px; }
.research-mode-copy small {
  color: var(--text-muted);
  font-size: var(--font-xs);
  line-height: 1.45;
}

.research-domain-controls {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 10px;
  grid-column: 1 / -1;
  margin-top: 11px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 7px);
  background: var(--bg-secondary);
}
.research-domain-field { min-width: 0; }
.research-domain-controls .research-field-note { grid-column: 1 / -1; margin-top: 0; }

/* Cost is quoted as a RATE. Never a computed total — the provider decides how
   many searches to run, so no honest total exists before the run. */
.research-cost-note {
  grid-column: 1 / -1;
  margin: 10px 0 0;
  color: var(--text-muted);
  font-size: var(--font-xs);
  line-height: 1.5;
}
/* A web run that cited nothing is stated plainly rather than left blank. */
.research-nosources-note {
  margin: 12px 0 0;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--research-warning) 45%, var(--border));
  border-radius: var(--radius-sm, 7px);
  background: color-mix(in srgb, var(--research-warning) 9%, transparent);
  font-size: 12px;
  line-height: 1.5;
}
.research-source-meta {
  display: block;
  margin-top: 2px;
  color: var(--text-muted);
  font-size: var(--font-xs);
}
.research-depth-control { display: flex; align-items: center; gap: 8px; }
.research-depth-control .input { width: 80px; }
.research-depth-control span { color: var(--text-muted); font-size: var(--font-xs); }
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
.research-running-state span { color: var(--text-muted); font-size: var(--font-xs); }

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
.research-review-score span { margin-top: -5px; font-size: var(--font-xs); font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
.research-review-counts { display: flex; flex-wrap: wrap; gap: 7px; }
.research-review-counts span { padding: 5px 8px; border: 1px solid var(--border); border-radius: 999px; color: var(--text-muted); font-size: var(--font-xs); }
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
.research-claim-index { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 6px; color: var(--text-muted); background: var(--bg-primary); font-size: var(--font-xs); font-weight: 800; }
.research-claim-body { min-width: 0; }
.research-claim-text { color: var(--text-primary); font-size: 12px; line-height: 1.5; }
.research-claim-note { margin-top: 4px; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.45; }
.research-claim-refs { display: flex; align-items: center; gap: 6px; margin-top: 6px; color: var(--text-muted); font-size: var(--font-xs); }
.research-cite-link { color: var(--accent); text-decoration: none; }
.research-cite-link:hover { text-decoration: underline; }
.research-claim-actions { display: flex; align-items: center; gap: 6px; }
.research-conf { display: inline-flex; margin-left: 6px; padding: 2px 6px; border-radius: 999px; font-size: var(--font-xs); font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap; }
.conf-high { color: var(--research-success); background: color-mix(in srgb, var(--research-success) 13%, transparent); }
.conf-medium { color: var(--research-warning); background: color-mix(in srgb, var(--research-warning) 13%, transparent); }
.conf-low, .conf-unknown { color: var(--research-danger); background: color-mix(in srgb, var(--research-danger) 13%, transparent); }

.research-review-section :deep(.adv-disclosure) { margin-top: 12px; }
.research-structure { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.research-structure li { display: grid; grid-template-columns: 26px 1fr; gap: 9px; padding: 8px 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-secondary); }
.research-structure li > span { color: var(--accent); font-size: var(--font-xs); font-weight: 800; }
.research-structure strong { font-size: var(--font-xs); }
.research-structure p { margin: 2px 0 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.4; }

.research-sources-panel { margin-top: 12px; padding: 13px; border: 1px solid var(--border); border-radius: var(--radius-md, 10px); background: var(--bg-secondary); }
.research-sources-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 14px; margin-bottom: 9px; }
.research-panel-kicker { color: var(--accent); font-size: var(--font-xs); font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; }
.research-sources-head h3 { margin: 2px 0; font-size: 13px; }
.research-sources-head p { margin: 0; color: var(--text-muted); font-size: var(--font-xs); }
.research-sources-bulk { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.research-sources { display: grid; gap: 5px; margin: 0; padding: 0; list-style: none; }
.research-sources li { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-primary); }
.research-sources li.src-excluded { opacity: 0.46; }
.research-retrieved-pages ul { display: grid; gap: 5px; margin: 0; padding: 0; list-style: none; }
.research-retrieved-pages li { padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-primary); overflow-wrap: anywhere; }
.research-source-toggle { display: grid; place-items: center; position: relative; width: 30px; height: 30px; border-radius: 6px; color: var(--text-muted); background: var(--bg-secondary); font-size: var(--font-xs); font-weight: 800; cursor: pointer; }
.research-source-toggle input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.research-source-toggle:has(input:checked) { color: var(--accent); outline: 1px solid var(--accent); }
.research-source-content { min-width: 0; }
.research-source-content a,
.research-source-content strong { color: var(--text-primary); font-size: var(--font-xs); font-weight: 700; text-decoration: none; }
.research-source-content a:hover { color: var(--accent); }
.research-source-content p { overflow: hidden; margin: 2px 0 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.research-source-vbadge { padding: 2px 7px; border-radius: 999px; color: var(--research-success); background: color-mix(in srgb, var(--research-success) 12%, transparent); font-size: var(--font-xs); font-weight: 800; white-space: nowrap; }

.research-empty-state { display: flex; align-items: center; gap: 13px; min-height: 74px; }
.research-empty-mark { display: grid; place-items: center; width: 44px; height: 44px; flex: 0 0 auto; border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--border)); border-radius: 12px; color: var(--accent); background: var(--accent-dim); font-family: Georgia, serif; font-size: 19px; font-weight: 700; }
.research-empty-state div { display: grid; gap: 3px; }
.research-empty-state strong { font-size: 13px; }
.research-empty-state p { margin: 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.5; }

.req { color: var(--research-danger); font-weight: 800; }

@media (max-width: 1080px) {
  .research-brief-grid { grid-template-columns: 1fr; }
  .research-flow-rail .workspace-command-copy { display: none; }
  .research-setup-surface { grid-template-columns: 1fr; }
  .research-setup-heading { grid-column: 1; }
}

@media (max-width: 760px) {
  .research-flow-line { width: 12px; }
  .research-flow-step { font-size: var(--font-xs); }
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
