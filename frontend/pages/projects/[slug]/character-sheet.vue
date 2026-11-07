<!--
  v1.0.189 (CC2) — Character Sheet page (continuity-chain).

  The compact visual-setup step: select Channel Characters, optionally store
  one episode visual anchor, and choose the shared Style Library look.
  Scene Plan owns episode timing and motion.

  Only reachable for continuity-chain projects (sidebar gates on
  isContinuityChain).
-->
<template>
  <div class="workspace-page character-sheet-workspace">
    <WorkspaceHero
      eyebrow="Continuity · Recurring cast"
      title="Character Sheet"
      description="Choose the recurring cast, an optional episode visual anchor, and the channel look for this episode."
    />

    <TopActionBar
      :project-slug="slug"
      v-model:episode-id="episodeId"
      filter-field="character_sheet"
      :presets="pagePresets"
      generate-label="Save Visual Setup"
      :generate-loading="saving"
      :generate-disabled="!episodeId || !configLoaded || !storyLoaded"
      :generate-status="saveStatus"
      @generate="saveConfig"
    />

    <WorkspaceNotice v-if="configLoadError" class="mt-3" tone="warning" title="This episode’s saved setup could not be read">
      {{ configLoadError }} Saving is turned off so the saved setup is not overwritten.
      <button class="btn btn-ghost btn-sm" @click="loadConfig">Retry</button>
    </WorkspaceNotice>
    <WorkspaceNotice v-if="droppedAnchorNotice" class="mt-3" tone="info" title="Removed characters that are no longer in this project">
      {{ droppedAnchorNotice }} Save visual setup to keep the change.
    </WorkspaceNotice>
    <WorkspaceNotice v-if="compositionPromptNotice" class="mt-3" tone="info" title="Composition prompt cleared">
      {{ compositionPromptNotice }}
    </WorkspaceNotice>

    <!-- Channel roster: shared Channel Characters for this channel. Lives
         OUTSIDE the episode gate so it works with no episode selected, and
         feeds neither dropUnknownAnchors nor the continuity save below. -->
    <ChannelCharacterRoster :slug="slug" />

    <div v-if="!episodeId" class="card mt-3">
      <p class="text-muted text-sm">Pick an episode above to configure its visual anchors and channel look.</p>
    </div>

    <template v-else>
      <section class="card mt-3 cs-visual-setup">
        <header class="cs-section-head">
          <div>
            <span class="cs-kicker">Episode-specific</span>
            <h3>Visual anchors</h3>
            <p class="text-muted text-sm">Pick the recurring cast and, if useful, add one visual anchor for this episode.</p>
          </div>
          <!-- The roster lives on this page since 1.4.384 (was /character-library). -->
          <NuxtLink :to="{ path: `/projects/${slug}/character-sheet` }" class="btn btn-ghost btn-sm">Manage Channel Characters →</NuxtLink>
        </header>

        <div class="cs-anchor-layout">
          <div class="cs-anchor-characters">
            <div class="cs-field-head">
              <strong>Channel characters</strong>
              <span>{{ config.anchor_character_ids.length }} selected</span>
            </div>
            <div v-if="charsLoading" class="text-muted text-sm">Loading characters…</div>
            <div v-else-if="!characters.length" class="cs-empty-inline text-muted text-sm">
              No Channel Characters are assigned yet.
              <NuxtLink :to="{ path: `/projects/${slug}/character-sheet` }" class="cs-link">Create or assign one →</NuxtLink>
            </div>
            <div v-else class="cs-character-grid">
              <button
                v-for="character in characters"
                :key="character.id"
                type="button"
                :class="['cs-character-tile', { selected: config.anchor_character_ids.includes(character.id), missing: !firstImage(character) }]"
                :aria-pressed="config.anchor_character_ids.includes(character.id)"
                @click="toggleAnchor(character.id)"
              >
                <img v-if="firstImage(character)" :src="charImageUrl(character, firstImage(character)!)" :alt="character.name" />
                <span v-else class="cs-character-placeholder" aria-hidden="true">{{ character.name.slice(0, 1) }}</span>
                <span class="cs-character-name">{{ character.name }}</span>
                <span class="cs-character-state">{{ firstImage(character) ? (config.anchor_character_ids.includes(character.id) ? 'In this episode' : 'Select') : 'Needs image' }}</span>
              </button>
            </div>
            <p v-if="anchorsWithoutImages.length" class="cs-warn text-xs">
              {{ anchorsWithoutImages.join(', ') }} {{ anchorsWithoutImages.length === 1 ? 'needs' : 'need' }} a portrait before it can visually anchor a render.
            </p>
          </div>

          <div class="cs-episode-anchor">
            <div class="cs-field-head">
              <strong>Episode visual anchor</strong>
              <span v-if="masterExists" class="cs-saved-badge">Saved</span>
              <span v-else>Optional</span>
            </div>
            <p class="text-muted text-xs">One image reserved for this episode's reference-guided visual setup.</p>
            <div v-if="masterExists" class="cs-reference-card">
              <a :href="masterUrl" target="_blank" rel="noopener" class="cs-reference-preview" title="Open full-size episode visual anchor">
                <img :src="masterUrl" alt="Episode visual anchor" />
              </a>
              <div class="cs-reference-actions">
                <ReferenceDropzone class="cs-reference-dropzone" :busy="uploadingSheet" @files="onSheetFiles">
                  <template #title>Replace image</template>
                  <template #hint>Paste, drop, or browse</template>
                </ReferenceDropzone>
                <div class="cs-reference-action-row">
                  <label class="cs-checkbox">
                    <input v-model="episodeAnchorEnabled" type="checkbox" />
                    Use episode anchor
                  </label>
                  <a :href="masterUrl" target="_blank" rel="noopener" class="cs-link text-xs">View full size</a>
                  <button class="btn btn-ghost btn-sm" :disabled="uploadingSheet" @click="removeSheet">Remove</button>
                </div>
              </div>
            </div>
            <ReferenceDropzone v-else class="cs-reference-dropzone cs-reference-dropzone-empty" :busy="uploadingSheet" @files="onSheetFiles">
              <template #title>Drop an episode visual anchor</template>
              <template #hint>Paste, drop, or browse one image</template>
            </ReferenceDropzone>

            <!-- Composition template. Restored 2026-08-27 at the owner's
                 direction. The backend for this never went away — the route,
                 the generator, the job type and the config flag all stayed
                 live; only the control was missing, which made the whole
                 feature unreachable. -->
            <div class="cs-composition-block">
              <div class="cs-field-head">
                <strong>Composition template</strong>
                <span v-if="compositionExists" class="cs-saved-badge">Saved</span>
                <span v-else>Optional</span>
              </div>
              <p class="text-muted text-xs">The layout every scene is structured against. Drop one in, or describe it and have an image model draw it.</p>

              <div v-if="compositionExists" class="cs-reference-card">
                <a :href="compositionUrl" target="_blank" rel="noopener" class="cs-reference-preview" title="Open full-size composition template">
                  <img :src="compositionUrl" alt="Composition template" />
                </a>
                <div class="cs-reference-actions">
                  <ReferenceDropzone class="cs-reference-dropzone" :busy="uploadingComposition" @files="onCompositionFiles">
                    <template #title>Replace image</template>
                    <template #hint>Paste, drop, or browse</template>
                  </ReferenceDropzone>
                  <div class="cs-reference-action-row">
                    <label class="cs-checkbox">
                      <input v-model="config.references.composition" type="checkbox" />
                      Use composition template
                    </label>
                    <a :href="compositionUrl" target="_blank" rel="noopener" class="cs-link text-xs">View full size</a>
                    <button class="btn btn-ghost btn-sm" :disabled="uploadingComposition" @click="removeComposition">Remove</button>
                  </div>
                </div>
              </div>
              <ReferenceDropzone v-else class="cs-reference-dropzone cs-reference-dropzone-empty" :busy="uploadingComposition" @files="onCompositionFiles">
                <template #title>Drop a composition template</template>
                <template #hint>Paste, drop, or browse one image</template>
              </ReferenceDropzone>

              <details class="cs-composition-generate disclosure">
                <summary>Or describe the layout and generate it</summary>
                <textarea
                  v-model="compositionPrompt"
                  class="input mt-2"
                  rows="3"
                  placeholder="e.g. wide 16:9 frame, subject centred as the focal object, guide character standing at the right edge, plenty of clear space above for a caption"
                ></textarea>
                <ImageModelPicker v-model="compositionModel" :project-slug="slug" class="mt-2" />
                <button
                  class="btn btn-primary btn-sm mt-2"
                  :disabled="!compositionPrompt.trim() || !compositionModel || generatingComposition"
                  @click="generateComposition"
                >
                  {{ generatingComposition ? 'Starting…' : 'Generate Template' }}
                </button>
                <p class="text-muted text-xs mt-1">Runs in the background (see the Jobs page). It appears here when finished and is switched on — then Save visual setup.</p>
              </details>
            </div>
          </div>
        </div>
      </section>

      <!-- Story context: THIS episode's entity inventory (story-entities
           sidecar). Story facts only — the channel look stays in the section
           below and in continuity.json. -->
      <section class="card mt-3 cs-story-context">
        <header class="cs-section-head">
          <div>
            <span class="cs-kicker">Episode-specific</span>
            <h3>Story context</h3>
            <p class="text-muted text-sm">The cast, places, world facts and objects this episode's story actually uses — kept separate from the channel look.</p>
          </div>
          <div class="cs-story-head-actions">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="extractDisabled"
              :title="extractDisabledReason"
              @click="extractStoryEntities"
            >
              {{ extracting ? 'Reading the completed script…' : 'Extract from completed script' }}
            </button>
          </div>
        </header>

        <WorkspaceNotice v-if="storyLoadError" class="mt-3" tone="warning" title="This episode’s story context could not be read">
          {{ storyLoadError }} Saving is turned off so saved story context is not overwritten.
          <button class="btn btn-ghost btn-sm" @click="loadStory">Retry</button>
        </WorkspaceNotice>

        <WorkspaceNotice v-if="extractError" class="mt-3" tone="warning" title="Extraction did not finish">
          {{ extractError }} The inventory is unchanged.
        </WorkspaceNotice>

        <WorkspaceNotice v-if="scriptChangedSinceExtraction" class="mt-3" tone="info" title="The completed script changed since this inventory was extracted">
          This inventory was extracted from {{ extractionRecord?.chapters }} chapter{{ extractionRecord?.chapters === 1 ? '' : 's' }}
          on {{ extractionDate }}, and the script now has {{ storyChapters }}.
          Extract again to reconcile — nothing was changed automatically.
        </WorkspaceNotice>

        <p class="text-muted text-xs mt-2">
          {{ storyChapters === null
            ? 'Whole completed script: chapter folder not on disk — nothing measured against it yet'
            : `Whole completed script: ${storyChapters} chapter${storyChapters === 1 ? '' : 's'} on file` }}
        </p>
        <p v-if="extractionRecord && !scriptChangedSinceExtraction" class="text-muted text-xs">
          Last extracted {{ extractionDate }} with {{ extractionRecord.model }}. Review the list below; Keep/Drop is yours.
        </p>
        <p v-if="extracting" class="text-muted text-xs">
          Reading every completed chapter with the Scene Plan preset’s writing model. Nothing is added until you review it.
        </p>

        <div class="cs-story-list mt-3">
          <div
            v-for="(entity, index) in storyDoc.entities"
            :key="entity.id || `row-${index}`"
            :class="['cs-story-row', { 'is-dropped': entity.review === 'drop' }]"
          >
            <div class="cs-story-row-head">
              <select v-model="entity.kind" class="input cs-story-kind" :aria-label="`Type for ${entity.name || 'entity'}`">
                <option v-for="kind in STORY_ENTITY_KINDS" :key="kind" :value="kind">{{ STORY_ENTITY_KIND_LABELS[kind] }}</option>
              </select>
              <input v-model="entity.name" class="input cs-story-name" maxlength="200" placeholder="Name" aria-label="Entity name" />
              <label class="cs-checkbox" title="An important entity holds one canonical reference; more only when a scene needs them">
                <input v-model="entity.important" type="checkbox" />
                Needs reference
              </label>
              <button type="button" class="btn btn-ghost btn-sm" @click="toggleStoryReview(entity)">
                {{ entity.review === 'drop' ? 'Restore' : 'Drop' }}
              </button>
            </div>
            <div v-if="entity.kind === 'cast'" class="cs-story-row-cast">
              <select v-model="entity.character_id" class="input" :aria-label="`Channel character for ${entity.name || 'entity'}`">
                <option value="">No character link</option>
                <option v-for="character in characters" :key="character.id" :value="character.id">{{ character.name }}</option>
              </select>
              <span v-if="entity.character_id && !characterName(entity.character_id)" class="cs-warn text-xs">
                This character is no longer in this channel — clear the link or pick another.
              </span>
              <span v-else-if="entity.character_id && entity.important" class="text-muted text-xs">
                Canonical reference: {{ characterName(entity.character_id) }}’s portrait
              </span>
            </div>
            <textarea
              v-model="entity.description"
              class="input cs-story-description"
              rows="2"
              maxlength="4000"
              placeholder="Story facts: how it looks, its state, what changes in this episode"
              aria-label="Story facts"
            ></textarea>
            <span v-if="entity.review === 'drop'" class="text-muted text-xs">Dropped from the inventory — restore any time; nothing is deleted.</span>
          </div>
          <div v-if="!storyDoc.entities.length" class="cs-empty-inline text-muted text-sm">
            No story entities yet. Add the cast, places, world facts and objects this episode uses.
          </div>
        </div>

        <div class="cs-story-add-row mt-3">
          <select v-model="newEntityKind" class="input cs-story-kind" aria-label="New entity type">
            <option v-for="kind in STORY_ENTITY_KINDS" :key="kind" :value="kind">{{ STORY_ENTITY_KIND_LABELS[kind] }}</option>
          </select>
          <input
            v-model="newEntityName"
            class="input cs-story-name"
            maxlength="200"
            placeholder="Name of the new entity"
            aria-label="New entity name"
            @keyup.enter="addStoryEntity"
          />
          <button type="button" class="btn btn-ghost btn-sm" :disabled="!newEntityName.trim()" @click="addStoryEntity">Add</button>
        </div>

        <!-- Extraction is a REVIEW step: proposals are listed here and only
             the ones kept are added to the draft. Nothing is written until
             Save visual setup, and an existing entity keeps its stored
             Keep/Drop decision across every retry. -->
        <section v-if="proposals.length" class="cs-story-proposals mt-3" aria-label="Extracted story entities to review">
          <div class="cs-field-head">
            <strong>Review extracted entities</strong>
            <span>{{ proposalAddCount + proposalUpdateCount }} of {{ proposals.length }} selected</span>
          </div>
          <p class="text-muted text-xs">
            Nothing is added until you choose. Existing entities keep their current Keep/Drop decision.
          </p>
          <div class="cs-story-list mt-2">
            <div
              v-for="proposal in proposals"
              :key="proposal.id"
              :class="['cs-story-row', 'cs-proposal-row', { 'is-dropped': proposal.existing && proposal.review === 'drop' }]"
            >
              <div class="cs-story-row-head">
                <span class="cs-proposal-kind">{{ STORY_ENTITY_KIND_LABELS[proposal.kind] }}</span>
                <strong class="cs-proposal-name">{{ proposal.name }}</strong>
                <span v-if="proposal.existing" class="cs-proposal-badge">
                  In inventory · {{ proposal.review === 'drop' ? 'dropped' : 'kept' }}
                </span>
                <label v-if="!proposal.existing" class="cs-checkbox">
                  <input v-model="proposalKeep[proposal.id]" type="checkbox" />
                  Add
                </label>
                <label v-else-if="proposal.current_description" class="cs-checkbox">
                  <input v-model="proposalUpdateFacts[proposal.id]" type="checkbox" />
                  Update story facts
                </label>
                <span v-if="proposal.existing" class="text-muted text-xs">No change to its Keep/Drop choice.</span>
              </div>
              <p class="cs-proposal-description">{{ proposal.description || 'The script gave no story facts for this entity.' }}</p>
              <p v-if="proposal.existing && proposalUpdateFacts[proposal.id] && proposal.current_description" class="text-muted text-xs">
                Current facts: {{ proposal.current_description }}
              </p>
            </div>
          </div>
          <div class="cs-story-add-row mt-2">
            <button
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="!proposalAddCount && !proposalUpdateCount"
              @click="addKeptProposals"
            >
              Add selected to inventory
            </button>
            <button type="button" class="btn btn-ghost btn-sm" @click="discardProposals">Discard</button>
            <span class="text-muted text-xs">Saves with Save visual setup.</span>
          </div>
        </section>

        <!-- Channel-owned, stored OFF by default. It rides the existing
             per-channel settings route; no extraction runs by itself in this
             release, and the page says so rather than implying it does. -->
        <div class="cs-story-automation mt-3">
          <label class="cs-checkbox">
            <input
              v-model="channelAutomation"
              type="checkbox"
              :disabled="automationSaving"
              @change="saveChannelAutomation"
            />
            Keep this channel’s story context updated automatically
          </label>
          <span class="text-muted text-xs">
            Off by default. Saved for the automatic pass; automatic extraction is not wired in this release, so each episode extracts when you press the button above.
          </span>
        </div>
      </section>

      <section class="card mt-3 cs-look-card">
        <header class="cs-section-head">
          <div>
            <span class="cs-kicker">Channel look</span>
            <h3>Visual art style</h3>
            <p class="text-muted text-sm">Choose one reusable channel look. Its render guidance is handled automatically.</p>
          </div>
        </header>
        <StylePicker
          :slug="slug"
          :active-style-bible="config.style_bible"
          :show-custom-styles="false"
          @apply="onStyleApply"
        />
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { Character } from '../../../composables/useCharacters.js'
import {
  CONTINUITY_PRESET_EXCLUDE_KEYS,
  applyContinuityPagePreset,
  continuityDefaults,
  normalizeContinuityConfig,
} from '../../../composables/useContinuityConfig.js'
import type { ContinuityConfig, ContinuityPagePreset } from '../../../composables/useContinuityConfig.js'
// One source of truth with the backend for the episode's story inventory —
// kinds, labels, id minting and the doc shape (Episode Visual Setup Phase 1).
import {
  STORY_ENTITY_KINDS,
  STORY_ENTITY_KIND_LABELS,
  canonicalStoryEntityId,
  emptyStoryEntities,
} from '../../../../electron/server/contracts/story-entities.js'
import type {
  StoryEntitiesDoc,
  StoryEntitiesExtraction,
  StoryEntitiesRead,
  StoryEntity,
  StoryEntityKind,
  StoryEntityProposal,
} from '../../../../electron/server/contracts/story-entities.js'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Character Sheet')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, put, post, del } = useApi()
const { success, error: showError } = useToast()
const cm = useCharacters(slug)

const episodeId = ref('')

// Config shape, defaults, and the preset boundary live in the composable so
// they are importable by tests — see composables/useContinuityConfig.ts.
const config = ref<ContinuityConfig>(continuityDefaults())

// v1.0.356 — ONE whole-page preset for the entire continuity setup. Replaces
// the fragmented style controls the user had to manage separately. A channel's
// continuity LOOK (anchors, references, denoise, Style Bible, and negative
// prompt) is usually the same across episodes, so saving it ONCE fills the
// whole page in one click instead of re-picking every attribute. Lives in
// the TopActionBar's preset row (same spot as Scripts/Prompts).
//
// autoApplyOnLoad is OFF: the episode's own continuity.json drives the fields
// on load; the preset is applied only on explicit Apply (then Save anchors &
// settings to persist it into this episode).
//
// Snapshot/apply cover the FULL config minus the transient `updated_at` and
// minus the episode's own anchor toggle — the look/episode-state boundary is
// documented on CONTINUITY_PRESET_EXCLUDE_KEYS / applyContinuityPagePreset.
//
// Scene rhythm is NOT part of this preset. It was, between 2026-08-18 and the
// owner's 2026-10-17 reversal: `pacing` is an excluded key again, the panel
// that sets it is Scene Plan's "Visual timing & motion", and Scene Review reads
// it back from the plan. The green notice this page used to carry about the
// preset's scene rhythm is deleted with it, not reworded — this page no longer
// owns rhythm, so a preset applied here has nothing to report and the live
// value never moves. (Full history: AGENTS.md §5 and
// docs/architecture/agents-decisions.md §5.)
const pagePresets = usePresets<ContinuityPagePreset>({
  slug: slug.value,
  configKey: 'continuity_page',
  presetType: 'continuity-page',
  autoApplyOnLoad: false,
  excludeKeys: CONTINUITY_PRESET_EXCLUDE_KEYS,
  snapshot: () => {
    // Deep clone so the stored preset doesn't alias the live config refs.
    const { updated_at: _drop, ...rest } = config.value
    return JSON.parse(JSON.stringify(rest)) as ContinuityPagePreset
  },
  apply: (data) => {
    // The live episode rhythm is carried across the fold untouched; see
    // applyContinuityPagePreset. Nothing here reads or reports it.
    config.value = applyContinuityPagePreset(config.value, data)
  },
})

// The shared Style Library owns all customer-visible style selection. Its
// prompt data remains an internal render detail, saved with the episode.
function onStyleApply(data: { style_bible: string; negative_prompt: string }): void {
  config.value.style_bible = data.style_bible || ''
  config.value.negative_prompt = data.negative_prompt || ''
  success('Style applied — Save visual setup to keep it for this episode')
}

const characters = ref<Character[]>([])
const charsLoading = ref(false)
const charactersLoaded = ref(false)
const saving = ref(false)

// The page edits a draft that only "Save visual setup" persists. Track what
// is on disk so leaving or switching episode warns before dropping edits, and
// refuse to save over a setup that could not be read.
const configLoaded = ref(false)
const configLoadError = ref('')

// ── Story context: the episode's entity inventory (its own sidecar) ──
// Cast / locations / world facts / objects live in story-entities.json
// beside continuity.json — story facts, never the channel look (§5/§7).
// The page edits a draft here too; only Save visual setup persists it.
const storyDoc = ref<StoryEntitiesDoc>(emptyStoryEntities())
const storyLoaded = ref(false)
const storyLoadError = ref('')
const storyChapters = ref<number | null>(null)
/** Current completed-script fingerprint from the server; null = not measurable. */
const storyFingerprint = ref<string | null>(null)
const storySnapshot = ref('')
const storyJson = (doc: StoryEntitiesDoc) => JSON.stringify(doc.entities)
// Extraction proposals are a review draft: they live only until the customer
// adds the kept ones (or discards them). Nothing is written before Save.
const extracting = ref(false)
const extractError = ref('')
const proposals = ref<StoryEntityProposal[]>([])
const proposalKeep = ref<Record<string, boolean>>({})
const proposalUpdateFacts = ref<Record<string, boolean>>({})
const extractionRecord = computed(() => storyDoc.value.extraction ?? null)
const extractionDate = computed(() => {
  const at = extractionRecord.value?.extracted_at
  if (!at) return ''
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString()
})
const scriptChangedSinceExtraction = computed(() => {
  const record = extractionRecord.value
  return !!record?.script_fingerprint
    && !!storyFingerprint.value
    && record.script_fingerprint !== storyFingerprint.value
})
const proposalAddCount = computed(() =>
  proposals.value.filter(proposal => !proposal.existing && proposalKeep.value[proposal.id]).length,
)
const proposalUpdateCount = computed(() =>
  proposals.value.filter(proposal => proposal.existing && proposalUpdateFacts.value[proposal.id]).length,
)
const extractDisabled = computed(() =>
  !episodeId.value
  || !storyLoaded.value
  || !!storyLoadError.value
  || extracting.value
  || storyChapters.value === null
  || storyChapters.value === 0,
)
const extractDisabledReason = computed(() => {
  if (!episodeId.value) return 'Pick an episode first.'
  if (storyLoadError.value) return 'The saved story context could not be read — use Retry above.'
  if (!storyLoaded.value) return 'Loading this episode’s story context…'
  if (extracting.value) return 'Reading the completed script…'
  if (storyChapters.value === null) return 'The completed script folder is not on disk, so there is nothing to extract from.'
  if (storyChapters.value === 0) return 'No completed chapter files were found for this episode.'
  return 'Read the completed chapters and propose the story entities they use.'
})
// Channel-owned, never episode-owned (§4): it is not blanked when the episode
// changes. OFF unless the channel's config says otherwise.
const channelAutomation = ref(false)
const automationSaving = ref(false)
// A half-typed new entity is episode-owned draft text as much as the
// composition prompt (§4): it counts as unsaved so the guard asks before
// the episode changes under it.
const newEntityKind = ref<StoryEntityKind>('object')
const newEntityName = ref('')
const storyDirty = computed(() =>
  (storyLoaded.value && storyJson(storyDoc.value) !== storySnapshot.value)
  || !!newEntityName.value.trim(),
)

const savedSnapshot = ref('')
const snapshotOf = (c: ContinuityConfig) => { const { updated_at: _u, ...rest } = c; return JSON.stringify(rest) }
const dirty = computed(() =>
  (configLoaded.value && snapshotOf(config.value) !== savedSnapshot.value)
  || storyDirty.value,
)
useUnsavedGuard(dirty, 'visual setup changes', { episodeSwitch: true })
const saveStatus = computed(() => {
  if (saving.value) return 'Saving visual setup…'
  if (!episodeId.value) return 'Pick an episode first'
  if (configLoadError.value) return 'Saving is off until the saved setup loads — use Retry above'
  if (storyLoadError.value) return 'Saving is off until the story context loads — use Retry above'
  if (!configLoaded.value) return 'Loading this episode’s setup…'
  if (!storyLoaded.value) return 'Loading this episode’s story context…'
  return dirty.value ? 'Unsaved changes' : ''
})
const droppedAnchorNotice = ref('')
// AGENTS.md §4 — set when an episode change clears written composition-prompt
// text, so the clear is announced rather than silent.
const compositionPromptNotice = ref('')

// ── Episode sheet (master img2img reference) ─────────────────────────
const masterExists = ref<boolean | null>(null)
const masterVersion = ref(0)
const uploadingSheet = ref(false)
const masterUrl = computed(() =>
  `/api/projects/${slug.value}/episodes/${episodeId.value}/img2img-references/file/master.png?v=${masterVersion.value}`,
)

const episodeAnchorEnabled = computed({
  get: () => config.value.use_episode_sheet,
  set: (enabled: boolean) => {
    // Older continuity files carried two sheet switches. Keep both in sync so
    // saved presets and the renderer have one clear customer choice without
    // breaking old episode data.
    //
    // This switch is no longer decorative. `generators/continuity-render.ts`
    // reads it (as the same OR of both names) and, when it is on, attaches the
    // episode's one reference image to every character scene of a Scene Review
    // render — `img2img-references/composition.png` if a composition template
    // was generated, otherwise the anchor uploaded here.
    config.value.use_episode_sheet = enabled
    config.value.references.sheet = enabled
  },
})

function firstImage(c: Character): string | null {
  return c.references?.images?.[0] || null
}
function charImageUrl(c: Character, filename: string): string {
  return `/api/projects/${slug.value}/characters/${c.id}/reference-image/${encodeURIComponent(filename)}`
}

const anchorsWithoutImages = computed(() =>
  characters.value
    .filter(c => config.value.anchor_character_ids.includes(c.id) && !firstImage(c))
    .map(c => c.name),
)

function toggleAnchor(id: string): void {
  const ids = config.value.anchor_character_ids
  const i = ids.indexOf(id)
  if (i >= 0) ids.splice(i, 1)
  else ids.push(id)
  config.value.references.characters = ids.length > 0
}

let characterScopeSequence = 0

async function loadCharacters(): Promise<void> {
  const ep = episodeId.value
  const project = slug.value
  const scope = characterScopeSequence
  const current = () => scope === characterScopeSequence && project === slug.value && ep === episodeId.value
  if (!ep) { characters.value = []; return }
  charsLoading.value = true
  try {
    const loaded = await cm.listForEpisode(ep)
    if (!current()) return
    characters.value = loaded
    charactersLoaded.value = true
    dropUnknownAnchors()
  } catch (e: any) {
    if (current() && !e?.__slugRace) showError(e?.data?.detail || 'Failed to load characters')
  } finally {
    if (current()) charsLoading.value = false
  }
}

async function loadConfig(): Promise<void> {
  const ep = episodeId.value
  const project = slug.value
  const scope = characterScopeSequence
  const current = () => scope === characterScopeSequence && project === slug.value && ep === episodeId.value
  configLoaded.value = false
  configLoadError.value = ''
  if (!ep) { config.value = continuityDefaults(); return }
  try {
    const r = await get<{ exists: boolean; config: ContinuityConfig }>(`/projects/${project}/continuity/${ep}`)
    if (!current()) return
    config.value = r.exists ? normalizeContinuityConfig(r.config) : continuityDefaults()
    savedSnapshot.value = snapshotOf(config.value)
    configLoaded.value = true
    dropUnknownAnchors()
  } catch (e: any) {
    // Never fall back to defaults silently: a later Save would overwrite the
    // real setup with an empty one.
    if (current() && !e?.__slugRace) configLoadError.value = e?.data?.detail || e?.message || 'The server did not answer.'
  }
}

// ── Story context (the episode's entity inventory) ──────────────────
// A failed read refuses Save rather than falling back to an empty
// inventory that a later Save would write over the real one (§8) — the
// same rule the continuity read above follows.
async function loadStory(): Promise<void> {
  const ep = episodeId.value
  const project = slug.value
  const scope = characterScopeSequence
  const current = () => scope === characterScopeSequence && project === slug.value && ep === episodeId.value
  storyLoaded.value = false
  storyLoadError.value = ''
  if (!ep) {
    storyDoc.value = emptyStoryEntities()
    storyChapters.value = null
    storySnapshot.value = ''
    return
  }
  try {
    const r = await get<StoryEntitiesRead>(`/projects/${project}/story-entities/${ep}`)
    if (!current()) return
    storyDoc.value = {
      schema_version: 1,
      entities: (Array.isArray(r?.doc?.entities) ? r.doc.entities : []).map(e => ({
        ...e,
        // An absent link reads as the empty choice the cast select shows —
        // the server keeps treating '' as "no link" on the next save.
        character_id: e.character_id ?? '',
      })),
      updated_at: r?.doc?.updated_at || '',
      // Server-owned provenance: what script the last extraction read.
      ...(r?.doc?.extraction ? { extraction: r.doc.extraction } : {}),
    }
    // `chapters` is number|null from the server: null is "not on disk /
    // not measured", never rendered as zero chapters (§6).
    storyChapters.value = typeof r?.chapters === 'number' ? r.chapters : null
    storyFingerprint.value = typeof r?.script_fingerprint === 'string' ? r.script_fingerprint : null
    storySnapshot.value = storyJson(storyDoc.value)
    storyLoaded.value = true
  } catch (e: any) {
    if (current() && !e?.__slugRace) storyLoadError.value = e?.data?.detail || e?.message || 'The server did not answer.'
  }
}

function addStoryEntity(): void {
  const name = newEntityName.value.trim()
  if (!name || !storyLoaded.value) return
  const now = new Date().toISOString()
  storyDoc.value.entities.push({
    // Minted from kind + name against the ids already in play, so a retry
    // of the same save adopts the same record instead of duplicating it.
    id: canonicalStoryEntityId(newEntityKind.value, name, storyDoc.value.entities.map(e => e.id)),
    kind: newEntityKind.value,
    name,
    description: '',
    important: false,
    review: 'keep',
    reference_images: [],
    created_at: now,
    updated_at: now,
  })
  newEntityName.value = ''
}

/** Drop = retired from the inventory, restorable — nothing is deleted (§5). */
function toggleStoryReview(entity: StoryEntity): void {
  entity.review = entity.review === 'drop' ? 'keep' : 'drop'
}

/** Ownership of a cast link is this episode's own roster — looked up, never parsed. */
function characterName(id?: string): string | null {
  if (!id) return null
  return characters.value.find(c => c.id === id)?.name ?? null
}

// ── Extraction from the completed script ────────────────────────────
// Proposals are review-only. The customer keeps/drops each one; only then
// are they added to the draft, and Save visual setup writes the sidecar.
async function extractStoryEntities(): Promise<void> {
  if (extractDisabled.value) return
  const ep = episodeId.value
  const project = slug.value
  const scope = characterScopeSequence
  const current = () => scope === characterScopeSequence && project === slug.value && ep === episodeId.value
  extracting.value = true
  extractError.value = ''
  try {
    const result = await post<{ ok: true } & StoryEntitiesExtraction>(
      `/projects/${project}/story-entities/${ep}/extract`,
      {},
    )
    if (!current()) return
    proposals.value = Array.isArray(result?.proposals) ? result.proposals : []
    proposalKeep.value = Object.fromEntries(
      proposals.value.filter(proposal => !proposal.existing).map(proposal => [proposal.id, true]),
    )
    proposalUpdateFacts.value = {}
    storyFingerprint.value = result.script_fingerprint
    storyChapters.value = result.chapters
    // The server recorded this extraction; mirror it locally so the freshness
    // notice is truthful before the next page load without reloading the
    // draft (which would drop unsaved entity edits).
    storyDoc.value.extraction = {
      extracted_at: result.extracted_at,
      model: result.model,
      chapters: result.chapters,
      script_fingerprint: result.script_fingerprint,
    }
    const count = proposals.value.length
    if (!count) {
      success('The completed script names no story entities yet — nothing to add.')
    } else {
      const skipped = result.skipped_rows
      success(
        `Found ${count} entit${count === 1 ? 'y' : 'ies'} — review them below.`
        + (skipped ? ` ${skipped} unreadable row${skipped === 1 ? ' was' : 's were'} left out.` : ''),
      )
    }
  } catch (e: any) {
    if (current()) extractError.value = e?.data?.detail || e?.message || 'The server did not answer.'
  } finally {
    if (current()) extracting.value = false
  }
}

/** Add the kept proposals to the draft; existing entities keep their decision. */
function addKeptProposals(): void {
  if (!storyLoaded.value) return
  const now = new Date().toISOString()
  let changed = 0
  for (const proposal of proposals.value) {
    const existing = storyDoc.value.entities.find(entity => entity.id === proposal.id)
    if (existing) {
      // A dropped entity stays dropped: only its facts can be refreshed, and
      // only when the customer ticked that box.
      if (proposalUpdateFacts.value[proposal.id] && proposal.description) {
        existing.description = proposal.description
        existing.updated_at = now
        changed++
      }
      continue
    }
    if (!proposalKeep.value[proposal.id]) continue
    storyDoc.value.entities.push({
      id: proposal.id,
      kind: proposal.kind,
      name: proposal.name,
      description: proposal.description,
      important: proposal.important,
      review: 'keep',
      reference_images: [],
      created_at: now,
      updated_at: now,
    })
    changed++
  }
  proposals.value = []
  proposalKeep.value = {}
  proposalUpdateFacts.value = {}
  success(
    changed
      ? `${changed} ${changed === 1 ? 'entity' : 'entities'} added to the inventory — Save visual setup to keep ${changed === 1 ? 'it' : 'them'}.`
      : 'Nothing changed.',
  )
}

function discardProposals(): void {
  proposals.value = []
  proposalKeep.value = {}
  proposalUpdateFacts.value = {}
}

// ── Channel automation (stored OFF; the existing settings route) ─────
async function loadChannelAutomation(): Promise<void> {
  try {
    const config = await get<Record<string, unknown>>(`/projects/${slug.value}/settings/config`)
    channelAutomation.value = config?.story_entity_automation === true
  } catch {
    // The switch stays off; the rest of the page still works.
  }
}

async function saveChannelAutomation(): Promise<void> {
  const wanted = channelAutomation.value
  automationSaving.value = true
  try {
    await put(`/projects/${slug.value}/settings/config`, { story_entity_automation: wanted })
    success(
      wanted
        ? 'Saved ON for this channel. Automatic extraction is not wired in this release, so episodes still extract when you press the button.'
        : 'Automatic story context is off for this channel.',
    )
  } catch (e: any) {
    channelAutomation.value = !wanted
    showError(e?.data?.detail || 'Failed to save the channel automation setting')
  } finally {
    automationSaving.value = false
  }
}

/** Anchor ids of deleted/unassigned characters can't be seen or unticked — drop them and say so. */
function dropUnknownAnchors(): void {
  if (!configLoaded.value || !charactersLoaded.value) return
  const known = new Set(characters.value.map(c => c.id))
  const ids = config.value.anchor_character_ids
  const unknown = ids.filter(id => !known.has(id))
  if (!unknown.length) return
  config.value.anchor_character_ids = ids.filter(id => known.has(id))
  config.value.references.characters = config.value.anchor_character_ids.length > 0
  droppedAnchorNotice.value = `${unknown.length} selected character${unknown.length === 1 ? ' was' : 's were'} deleted or unassigned and ${unknown.length === 1 ? 'has' : 'have'} been unticked.`
}

async function saveConfig(): Promise<void> {
  const ep = episodeId.value
  const project = slug.value
  const scope = characterScopeSequence
  const current = () => scope === characterScopeSequence && project === slug.value && ep === episodeId.value
  if (!ep || !configLoaded.value || !storyLoaded.value) return
  saving.value = true
  // Which half is in flight, so a failure names the half that failed
  // instead of claiming a save that did not land (§8).
  let half: 'visual setup' | 'story context' = 'visual setup'
  try {
    const saved = await put<{ ok: true; config: ContinuityConfig }>(`/projects/${project}/continuity/${ep}`, JSON.parse(JSON.stringify(config.value)))
    if (!current()) return
    config.value = normalizeContinuityConfig(saved.config)
    savedSnapshot.value = snapshotOf(config.value)
    droppedAnchorNotice.value = ''
    // Story context rides the same Save button, its own sidecar. Only the
    // half that changed is written — a clean inventory is already on disk.
    if (storyDirty.value) {
      half = 'story context'
      const savedStory = await put<{ ok: true; doc: StoryEntitiesDoc }>(
        `/projects/${project}/story-entities/${ep}`,
        { schema_version: 1, entities: storyDoc.value.entities },
      )
      if (!current()) return
      if (!savedStory?.doc || !Array.isArray(savedStory.doc.entities)) {
        throw new Error('the server did not confirm the story context save')
      }
      storyDoc.value = savedStory.doc
      storySnapshot.value = storyJson(savedStory.doc)
    }
    success('Visual setup saved')
  } catch (e: any) {
    if (!current()) return
    if (half === 'story context') {
      showError(`Visual setup saved, but story context failed — ${e?.data?.detail || e?.message || 'the server did not answer'}`)
    } else {
      showError(e?.data?.detail || 'Failed to save continuity settings')
    }
  } finally {
    if (current()) saving.value = false
  }
}

// ── Episode sheet upload (base64 JSON → existing master route) ───────
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const idx = dataUrl.indexOf('base64,')
      resolve(idx >= 0 ? dataUrl.slice(idx + 'base64,'.length) : dataUrl)
    }
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
}

async function onSheetFiles(files: File[]): Promise<void> {
  const file = files[0]
  const ep = episodeId.value
  const project = slug.value
  const scope = characterScopeSequence
  const current = () => scope === characterScopeSequence && project === slug.value && ep === episodeId.value
  if (!file || !ep) return
  uploadingSheet.value = true
  try {
    const data_base64 = await fileToBase64(file)
    if (!current()) return
    await post(`/projects/${project}/episodes/${ep}/img2img-references/master`, {
      filename: file.name,
      data_base64,
    })
    if (!current()) return
    masterVersion.value++       // cache-bust the preview
    masterExists.value = true
    episodeAnchorEnabled.value = true
    success('Episode visual anchor uploaded and switched on — Save visual setup to use it')
  } catch (e: any) {
    if (current()) showError(e?.data?.detail || 'Failed to upload episode sheet')
  } finally {
    if (current()) uploadingSheet.value = false
  }
}

// ── Composition template (img2img-references/composition.png) ─────────
const compositionExists = ref<boolean | null>(null)
const compositionVersion = ref(0)
const uploadingComposition = ref(false)
const generatingComposition = ref(false)
const compositionPrompt = ref('')
// Restore the last explicit model choice before the picker mounts (AGENTS.md §7).
const COMPOSITION_MODEL_KEY = 'storyStudio:compositionModel'
const compositionModel = ref((() => { try { return localStorage.getItem(COMPOSITION_MODEL_KEY) || '' } catch { return '' } })())
watch(compositionModel, (id) => { try { if (id) localStorage.setItem(COMPOSITION_MODEL_KEY, id) } catch { /* private mode */ } })
const compositionUrl = computed(() =>
  `/api/projects/${slug.value}/episodes/${episodeId.value}/img2img-references/file/composition.png?v=${compositionVersion.value}`,
)

async function onCompositionFiles(files: File[]): Promise<void> {
  const file = files[0]
  const ep = episodeId.value
  const project = slug.value
  const scope = characterScopeSequence
  const current = () => scope === characterScopeSequence && project === slug.value && ep === episodeId.value
  if (!file || !ep) return
  uploadingComposition.value = true
  try {
    const data_base64 = await fileToBase64(file)
    if (!current()) return
    await post(`/projects/${project}/episodes/${ep}/img2img-references/composition`, {
      filename: file.name,
      data_base64,
    })
    if (!current()) return
    compositionVersion.value++
    compositionExists.value = true
    // Uploading one is the customer saying they want it used. The flag is
    // still theirs to turn back off with the checkbox beside the preview.
    config.value.references.composition = true
    success('Composition template uploaded and switched on — Save visual setup to use it')
  } catch (e: any) {
    if (current()) showError(e?.data?.detail || 'Failed to upload composition template')
  } finally {
    if (current()) uploadingComposition.value = false
  }
}

async function removeComposition(): Promise<void> {
  if (!episodeId.value) return
  if (!await useConfirm().ask({ title: 'Remove composition template?', message: 'The template (uploaded or generated) is deleted. A generated one would need to be generated again.', confirmLabel: 'Remove', danger: true })) return
  try {
    await del(`/projects/${slug.value}/episodes/${episodeId.value}/img2img-references/composition`)
    compositionExists.value = false
    compositionVersion.value++
    config.value.references.composition = false
    success('Composition template removed')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to remove composition template')
  }
}

async function generateComposition(): Promise<void> {
  if (!episodeId.value || !compositionPrompt.value.trim() || !compositionModel.value) return
  generatingComposition.value = true
  try {
    await post(`/projects/${slug.value}/episodes/${episodeId.value}/img2img-references/composition/generate`, {
      prompt: compositionPrompt.value.trim(),
      model: compositionModel.value,
    })
    success('Generating the composition template — watch it on the Jobs page')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to start composition template generation')
  } finally {
    generatingComposition.value = false
  }
}

async function removeSheet(): Promise<void> {
  if (!episodeId.value) return
  if (!await useConfirm().ask({ title: 'Remove episode visual anchor?', message: 'The anchor image (uploaded or generated) is deleted. A generated one would need to be generated again.', confirmLabel: 'Remove', danger: true })) return
  try {
    await del(`/projects/${slug.value}/episodes/${episodeId.value}/img2img-references/master`)
    masterExists.value = false
    masterVersion.value++
    episodeAnchorEnabled.value = false
    success('Episode visual anchor removed')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to remove episode sheet')
  }
}

// A generated composition template lands on disk when its job finishes: show
// it and switch it on in the draft (the customer still saves the setup).
const { jobs } = useJobs()
const compositionJobStatus = computed(() =>
  jobs.value.find(j => j.type === 'composition_generate' && j.project_slug === slug.value && j.episode_id === episodeId.value)?.status,
)
watch(compositionJobStatus, (status, previous) => {
  if (status !== 'done' || !previous || previous === 'done') return
  void loadRefs().then(() => {
    if (compositionExists.value) {
      compositionVersion.value++
      config.value.references.composition = true
      success('Composition template is ready and switched on — Save visual setup to use it')
    }
  })
})

// Authoritative existence check for the episode visual anchor. This avoids a
// fragile hidden-image probe and keeps the compact preview truthful.
async function loadRefs(): Promise<void> {
  const ep = episodeId.value
  const project = slug.value
  const scope = characterScopeSequence
  const current = () => scope === characterScopeSequence && project === slug.value && ep === episodeId.value
  if (!ep) { masterExists.value = false; compositionExists.value = false; return }
  try {
    const r = await get<{ master?: { url: string }; composition?: { url: string } }>(
      `/projects/${project}/episodes/${ep}/img2img-references`,
    )
    if (!current()) return
    masterExists.value = !!r.master
    compositionExists.value = !!r.composition
  } catch (e: any) {
    if (current() && !e?.__slugRace) { masterExists.value = false; compositionExists.value = false }
  }
}

// Reload everything on episode change.
watch([slug, episodeId], () => {
  characterScopeSequence++
  masterExists.value = null
  masterVersion.value++
  compositionExists.value = null
  compositionVersion.value++
  charsLoading.value = false
  saving.value = false
  uploadingSheet.value = false
  uploadingComposition.value = false
  // The episode's anchor/continuity config is episode-scoped. `loadConfig`
  // already replaces it with defaults when the read FAILS, but that is still
  // one await away: between the switch and the new read the previous episode's
  // anchors, pacing and references stayed live on the page. Blank synchronously
  // (AGENTS.md §4), matching the pattern the sibling pages use.
  config.value = continuityDefaults()
  configLoaded.value = false
  configLoadError.value = ''
  charactersLoaded.value = false
  droppedAnchorNotice.value = ''
  // Every remaining episode-owned draft field is blanked on the change too
  // (AGENTS.md §4): the roster resolves from this episode's own files, the
  // composition prompt was written for the episode just left, and the generate
  // flag belongs to a request that may never land here. Text the customer
  // typed is announced, not silently dropped.
  compositionPromptNotice.value = compositionPrompt.value.trim()
    ? 'Composition prompt was cleared because the episode changed. Saved templates are untouched.'
    : ''
  compositionPrompt.value = ''
  generatingComposition.value = false
  characters.value = []
  // The story inventory is episode-owned too (§4): blank it synchronously
  // so the previous episode's cast/places/world facts never stand on the
  // new episode's screen while its read is in flight. The half-typed
  // add-row name goes with it — the unsaved guard already asked about it.
  storyDoc.value = emptyStoryEntities()
  storyLoaded.value = false
  storyLoadError.value = ''
  storyChapters.value = null
  storyFingerprint.value = null
  storySnapshot.value = ''
  newEntityName.value = ''
  // Extraction proposals belong to the episode just left (§4): blank them
  // synchronously rather than let its cast stand on the new episode's screen.
  extracting.value = false
  extractError.value = ''
  proposals.value = []
  proposalKeep.value = {}
  proposalUpdateFacts.value = {}
  void loadCharacters()
  void loadConfig()
  void loadStory()
  void loadRefs()
  void pagePresets.load()
}, { immediate: true, flush: 'sync' })
// Channel-owned setting: read once per channel, never blanked by an episode
// change (it belongs to the channel, not the episode — §4).
watch(slug, () => void loadChannelAutomation(), { immediate: true })
// The announcement has done its job once the customer writes a new prompt for
// the episode now on screen.
watch(compositionPrompt, (value) => {
  if (value.trim()) compositionPromptNotice.value = ''
})
</script>

<style scoped>
.cs-link, .cs-char-card .cs-link { color: var(--accent); text-decoration: none; }
.cs-link:hover { text-decoration: underline; }
.cs-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.cs-section-head h3 { margin: 3px 0 0; }
.cs-section-head p { margin: 4px 0 0; }
.cs-kicker { color: var(--accent); font-size: var(--font-xs); font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
.cs-anchor-layout { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(330px, .75fr); gap: 20px; margin-top: 16px; }
.cs-anchor-characters, .cs-episode-anchor { min-width: 0; }
.cs-composition-block { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
.cs-composition-generate { margin-top: 12px; }
.cs-composition-generate > summary { cursor: pointer; font-size: var(--font-xs); color: var(--text-muted); }
.cs-composition-generate > summary:hover { color: var(--text-primary); }
.cs-episode-anchor { padding-left: 20px; border-left: 1px solid var(--border); }
.cs-field-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; }
.cs-field-head > span { color: var(--text-muted); font-size: var(--font-xs); }
.cs-character-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 9px; margin-top: 10px; }
.cs-character-tile { position: relative; min-width: 0; overflow: hidden; padding: 0 0 8px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; text-align: left; transition: border-color .15s, background .15s, transform .15s; }
.cs-character-tile:hover { border-color: var(--accent); transform: translateY(-1px); }
.cs-character-tile:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-dim); }
.cs-character-tile.selected { border-color: var(--accent); background: var(--accent-dim); }
.cs-character-tile.missing { border-style: dashed; }
.cs-character-tile img, .cs-character-placeholder { display: grid; width: 100%; height: 76px; object-fit: cover; place-items: center; background: var(--bg-tertiary); color: var(--text-muted); font-size: 24px; }
.cs-character-name, .cs-character-state { display: block; overflow: hidden; padding: 0 8px; text-overflow: ellipsis; white-space: nowrap; }
.cs-character-name { margin-top: 8px; font-size: 12px; font-weight: 700; }
.cs-character-state { margin-top: 2px; color: var(--text-muted); font-size: var(--font-xs); }
.cs-character-tile.selected .cs-character-state { color: var(--accent); }
.cs-empty-inline { margin-top: 12px; padding: 12px; border: 1px dashed var(--border); border-radius: 8px; }
.cs-warn { margin: 9px 0 0; color: var(--warning, #ca8a04); }
.cs-saved-badge {
  display: inline-block;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: var(--font-xs);
  font-weight: 600;
  background: rgba(91, 179, 124, 0.16);
  color: rgb(34, 134, 70);
}
.cs-reference-card { display: grid; grid-template-columns: minmax(170px, 250px) minmax(0, 1fr); gap: 12px; align-items: stretch; margin-top: 10px; }
.cs-reference-preview { display: grid; min-height: 155px; overflow: hidden; place-items: center; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-tertiary); }
.cs-reference-preview img { width: 100%; height: 100%; max-height: 210px; object-fit: contain; }
.cs-reference-actions { display: flex; min-width: 0; flex-direction: column; justify-content: space-between; gap: 9px; }
.cs-reference-action-row { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.cs-reference-action-row .btn { margin-left: auto; }
.cs-reference-dropzone { margin-top: 8px; }
.cs-reference-actions .cs-reference-dropzone { margin-top: 0; }
:deep(.cs-reference-dropzone.ref-dropzone) { min-height: 82px; padding: 11px 12px; }
:deep(.cs-reference-dropzone .ref-dropzone-icon) { font-size: 17px; }
:deep(.cs-reference-dropzone-empty.ref-dropzone) { min-height: 118px; }
.cs-checkbox { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-top: 4px; cursor: pointer; }
.cs-look-card :deep(.style-picker) { margin-top: 14px; }
.cs-story-list { display: flex; flex-direction: column; gap: 10px; }
.cs-story-row { display: flex; flex-direction: column; gap: 7px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-secondary); }
.cs-story-row.is-dropped { opacity: .62; border-style: dashed; }
.cs-story-row-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cs-story-kind { flex: 0 0 auto; width: 122px; }
.cs-story-name { flex: 1 1 160px; min-width: 0; }
.cs-story-row-cast { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.cs-story-row-cast .input { max-width: 260px; }
.cs-story-description { width: 100%; resize: vertical; }
.cs-story-add-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cs-story-add-row .cs-story-name { flex: 1 1 180px; }
.cs-story-head-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cs-story-proposals { padding-top: 14px; border-top: 1px solid var(--border); }
.cs-proposal-row.is-dropped { opacity: .72; }
.cs-proposal-kind { padding: 2px 8px; border-radius: 999px; background: var(--bg-tertiary); color: var(--text-muted); font-size: var(--font-xs); font-weight: 700; }
.cs-proposal-name { font-size: 13px; }
.cs-proposal-badge { color: var(--text-muted); font-size: var(--font-xs); }
.cs-proposal-description { margin: 0; font-size: 13px; line-height: 1.5; }
.cs-story-automation { display: flex; flex-direction: column; gap: 2px; padding-top: 14px; border-top: 1px solid var(--border); }
.cs-story-automation .cs-checkbox { margin-top: 0; }
@media (max-width: 900px) {
  .cs-anchor-layout { grid-template-columns: 1fr; }
  .cs-episode-anchor { padding: 18px 0 0; border-top: 1px solid var(--border); border-left: 0; }
}
@media (max-width: 620px) {
  .cs-section-head { flex-direction: column; gap: 8px; }
  .cs-section-head .btn { width: 100%; }
  .cs-reference-card { grid-template-columns: 1fr; }
  .cs-reference-preview { min-height: 190px; }
}
</style>
