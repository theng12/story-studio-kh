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
          on screen long enough to read, no crowding within 0.5s of another approved cue, valid treatment
          and placement. This never skips those checks; it only skips waiting for you once a preset has
          earned your trust. Run proposals manually a few times first — anything that fails a check is held
          back here with the reason, never silently dropped, so you can approve or exclude it yourself.
          Notes about a long hold or a label low in the frame are advice, not failures, and never hold a
          cue back.
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
        <ModelSelector v-model="form.model" :project-slug="slug" writing-step label="Cue proposal model" />
        <label>Density
          <select v-model="form.density" class="select">
            <option value="restrained">Restrained — only key orientation</option>
            <option value="standard">Standard — useful context</option>
            <option value="editorial">Editorial — more frequent labels</option>
          </select>
        </label>
        <label>Default corner
          <select v-model="form.placement" class="select">
            <option v-for="corner in CORNERS" :key="corner" :value="corner">{{ cornerLabel(corner) }}</option>
          </select>
        </label>
        <div class="cue-default-position">
          <div class="cue-default-position-copy">
            <strong>Default position</strong>
            <p class="text-muted text-xs">
              Drag to place new cues precisely instead of in a corner — useful when a channel logo
              always sits in the same place. Every cue a proposal creates starts here; you can still
              move any single cue afterwards.
            </p>
            <button
              v-if="form.position_x_pct !== null && form.position_y_pct !== null"
              type="button"
              class="btn btn-sm btn-secondary"
              @click="form.position_x_pct = null; form.position_y_pct = null"
            >Use the Corner Instead</button>
          </div>
          <div
            class="cue-frame cue-frame-default"
            role="application"
            aria-label="Default contextual cue position"
            @pointerdown="startDefaultDrag"
            @pointermove="moveDefaultDrag"
            @pointerup="stopCueDrag"
            @pointercancel="stopCueDrag"
          >
            <div class="cue-safe-boundary" :style="safeBoundaryStyle" />
            <span class="cue-frame-chip" :style="cueChipStyle(form as any)">Cue</span>
          </div>
          <div class="cue-axis-fields">
            <label>Across ({{ cuePosition(form as any).xPct.toFixed(0) }}%)
              <input
                type="range" :min="CUE_SAFE_MARGIN_PCT" :max="100 - CUE_SAFE_MARGIN_PCT" step="0.5"
                :value="cuePosition(form as any).xPct"
                @input="setDefaultAxis('x', Number(($event.target as HTMLInputElement).value))"
              />
            </label>
            <label>Down ({{ cuePosition(form as any).yPct.toFixed(0) }}%)
              <input
                type="range" :min="CUE_SAFE_MARGIN_PCT" :max="100 - CUE_SAFE_MARGIN_PCT" step="0.5"
                :value="cuePosition(form as any).yPct"
                @input="setDefaultAxis('y', Number(($event.target as HTMLInputElement).value))"
              />
            </label>
          </div>
        </div>
        <label class="cue-auto-approve">
          <input v-model="form.auto_approve" type="checkbox" :disabled="config.auto_approve_cues" @change="onAutoApproveEdited" />
          <span>
            <strong>Auto-approve safe proposals</strong>
            <small v-if="config.auto_approve_cues">Not used — the project setting above already approves each safe cue.</small>
            <small v-else>Off by default. Each cue must pass the same checks as manual review; one that fails waits here for you. Use only after you trust this preset; Pipeline can then continue automatically.</small>
          </span>
        </label>
        <WorkspaceNotice
          v-if="autoApproveNotice"
          class="cue-auto-approve-notice"
          :tone="autoApproveNotice.on ? 'warning' : 'info'"
          :title="autoApproveNotice.on
            ? (autoApproveNotice.changed ? 'That preset switched on Auto-approve safe proposals' : 'That preset keeps Auto-approve safe proposals on')
            : (autoApproveNotice.changed ? 'That preset switched off Auto-approve safe proposals' : 'That preset keeps Auto-approve safe proposals off')"
        >
          <template v-if="autoApproveNotice.on">
            A preset carries this setting along with the model and the density, so choosing one for
            its model changes this too. Proposals that pass every structural check will now be
            approved without you looking at them. Untick it above if you would rather review this
            batch yourself — that leaves the preset alone until you save over it.
          </template>
          <template v-else>
            A preset carries this setting along with the model and the density, so choosing one for
            its model changes this too. Every proposed cue will now wait for your approval. Tick it
            above if you want this preset to approve safe cues for you, then save over the preset to
            keep that.
          </template>
        </WorkspaceNotice>
      </div>
    </section>

    <WorkspaceNotice v-if="!config.enabled" tone="info" title="Contextual Cues are off">
      Pick an episode and save a cue preset whenever you like. Enable this project setting only when you are ready to propose, review, and require contextual cues for Video Assembly.
    </WorkspaceNotice>

    <template v-else>
      <WorkspaceNotice v-if="loadError" tone="warning" :title="/Scene Plan/.test(loadError) ? 'Contextual Cues need a Scene Plan' : 'This episode\'s cues could not be opened'">
        {{ loadError }}
      </WorkspaceNotice>
      <WorkspaceNotice v-else-if="proposalProgress" tone="info" title="Saved partial proposal">
        {{ proposalProgress.completed_batches.length }} of {{ proposalProgress.total_batches }} batches are safely checkpointed.
        {{ proposalProgress.total_scenes - completedProposalScenes }} scenes remain. Press Propose cues with the same model and settings and it continues from where it stopped — only the missing batches are requested. Video Assembly still treats this timeline as incomplete.
      </WorkspaceNotice>
      <WorkspaceNotice v-else-if="timeline?.auto_approval_holds?.length" tone="warning" title="Held back from auto-approval">
        {{ timeline.auto_approval_holds.length }} cue{{ timeline.auto_approval_holds.length === 1 ? '' : 's' }} failed a structural check
        during the last automatic pass and stayed in review instead of being approved — see the reason marked on
        each cue below. This episode will render without them until you approve or exclude them yourself.
      </WorkspaceNotice>
      <WorkspaceNotice v-else-if="blockingValidation.length" tone="warning" title="Resolve these cues before Video Assembly">
        {{ blockingValidation[0]?.detail }}
      </WorkspaceNotice>
      <WorkspaceNotice v-else-if="timeline && !proposedCount" tone="success" title="Cue timeline ready">
        Every cue is resolved. Approved cues will render exactly as reviewed; disabled cues will not render.
      </WorkspaceNotice>

      <section v-if="timeline" class="card cue-list">
        <div class="cue-list-heading">
          <div><span class="section-kicker">Reviewed timeline</span><h2>{{ timeline.cues.length }} cue{{ timeline.cues.length === 1 ? '' : 's' }}</h2></div>
          <div class="cue-list-actions">
            <!-- v1.3.3 — edits save themselves; this says where that has got
                 to, and never claims "saved" for a write that failed. -->
            <span class="cue-save-state" :data-state="saveState" role="status">{{ saveStateLabel }}</span>
            <!-- v1.2.6 — bulk approve for the still-unreviewed cues only. It
                 names its own count and never touches a cue the customer
                 already excluded. Since v1.3.3 it marks the form dirty like
                 every other edit and rides the same auto-save. -->
            <button
              v-if="proposedCount"
              class="btn btn-secondary btn-sm"
              :disabled="saving || cueJobActive"
              title="Approves the cues still awaiting review. Cues you excluded are left as they are."
              @click="approveAllProposed"
            >Approve all {{ proposedCount }}</button>
            <!-- Not disabled when everything is saved: pressing it then must
                 confirm that rather than look broken. -->
            <button class="btn btn-secondary btn-sm" :disabled="saving" @click="saveTimeline">Save Changes</button>
          </div>
        </div>
        <p v-if="cueJobActive" class="cue-job-lock" role="status">A proposal is running — edits are paused until it finishes.</p>
        <p v-if="!timeline.cues.length" class="text-muted">No cues were proposed. That is valid—this episode will continue without contextual labels.</p>
        <!-- Disables every field and button in the rows while a proposal runs:
             the job writes this timeline when it finishes. -->
        <fieldset class="cue-rows" :disabled="cueJobActive">
        <article v-for="cue in timeline.cues" :key="cue.id" class="cue-row" :class="`is-${cue.status}`">
          <p v-if="cueErrors.get(cue.id)?.length" class="cue-hold-reason">
            Not saved: {{ cueErrors.get(cue.id)!.join(' ') }}
          </p>
          <p v-if="holdReasons.get(cue.id)?.length" class="cue-hold-reason">
            Held back from auto-approval: {{ holdReasons.get(cue.id)!.join('; ') }}
          </p>
          <p v-if="cueWarnings.get(cue.id)?.length" class="cue-warning">
            {{ cueWarnings.get(cue.id)!.join(' ') }}
          </p>
          <div class="cue-time">{{ time(cue.start_sec) }}–{{ time(cue.end_sec) }}</div>
          <!-- The frame preview IS the position control: drag the label to
               place it. It draws each cue where the renderer will draw it,
               which is also the first time this preview has shown placement
               at all rather than treatment alone. -->
          <div
            class="cue-frame"
            role="application"
            :aria-label="`Position for ${cue.title || 'this cue'}`"
            @pointerdown="startCueDrag(cue, $event)"
            @pointermove="moveCueDrag(cue, $event)"
            @pointerup="stopCueDrag"
            @pointercancel="stopCueDrag"
          >
            <div class="cue-safe-boundary" :style="safeBoundaryStyle" />
            <div class="cue-preview" :class="`preview-${cue.template}`" :style="cueChipStyle(cue)">
              <span v-if="cue.template === 'map-pin'" class="cue-preview-pin">●</span>
              <span v-else-if="cue.template === 'archival-caption'" class="cue-preview-kicker">ARCHIVE</span>
              <span v-else-if="cue.template === 'chapter-plate'" class="cue-preview-kicker">CHAPTER</span>
              <span v-else class="cue-preview-kicker">CONTEXT</span>
              <strong>{{ cue.title || 'Cue title' }}</strong>
              <small v-if="cue.subtitle">{{ cue.subtitle }}</small>
            </div>
          </div>
          <div class="cue-fields">
            <input v-model="cue.title" class="input" maxlength="80" placeholder="Main label" @input="markDirty()" />
            <input v-model="cue.subtitle" class="input" maxlength="100" placeholder="Optional second line" @input="markDirty()" />
            <div class="cue-meta">
              <select v-model="cue.kind" class="select select-sm" @change="markDirty()"><option value="location_date">Location / date</option><option value="historical_context">Historical context</option><option value="person">Person</option><option value="chapter">Chapter</option></select>
              <select v-model="cue.template" class="select select-sm" @change="markDirty()"><option value="documentary-label">Documentary label</option><option value="map-pin">Location pin</option><option value="archival-caption">Archival caption</option><option value="chapter-plate">Chapter plate</option></select>
              <select
                class="select select-sm"
                :value="hasPreciseCuePosition(cue) ? '' : cue.placement"
                :title="ignoresCorner(cue) ? 'A chapter plate is drawn centred, so the corner does not move it. Drag the preview to place it precisely.' : 'Quick corner preset'"
                @change="useCueCorner(cue, ($event.target as HTMLSelectElement).value as any)"
              >
                <option v-if="hasPreciseCuePosition(cue)" value="" disabled>Placed by hand</option>
                <option v-for="corner in CORNERS" :key="corner" :value="corner">{{ cornerLabel(corner) }}</option>
              </select>
              <select class="select select-sm" :value="cue.entrance" @change="setTransition(cue, ($event.target as HTMLSelectElement).value)"><option value="fade">Fade</option><option value="dissolve">Dissolve</option><option value="slide">Slide</option></select>
              <label>Start <input v-model.number="cue.start_sec" class="input input-time" type="number" step="0.1" @input="markDirty()" /></label>
              <label>End <input v-model.number="cue.end_sec" class="input input-time" type="number" step="0.1" @input="markDirty()" /></label>
              <!-- Keyboard path for the drag pad above, exactly as the
                   subtitle picker pairs its pad with plain range inputs. -->
              <label>Across
                <input
                  class="input input-time" type="number" :min="CUE_SAFE_MARGIN_PCT" :max="100 - CUE_SAFE_MARGIN_PCT" step="0.5"
                  :value="cuePosition(cue).xPct"
                  @input="setCueAxis(cue, 'x', Number(($event.target as HTMLInputElement).value))"
                />
              </label>
              <label>Down
                <input
                  class="input input-time" type="number" :min="CUE_SAFE_MARGIN_PCT" :max="100 - CUE_SAFE_MARGIN_PCT" step="0.5"
                  :value="cuePosition(cue).yPct"
                  @input="setCueAxis(cue, 'y', Number(($event.target as HTMLInputElement).value))"
                />
              </label>
              <button
                v-if="hasPreciseCuePosition(cue)"
                class="btn btn-sm btn-secondary"
                title="Apply this cue's position to every other cue on this episode"
                @click="applyPositionToAll(cue)"
              >Use Everywhere</button>
            </div>
          </div>
          <div class="cue-actions">
            <button class="btn btn-sm" :class="cue.status === 'approved' ? 'btn-primary' : 'btn-secondary'" @click="setStatus(cue, 'approved')">Approve</button>
            <button class="btn btn-sm btn-secondary" :class="{ 'is-active': cue.status === 'disabled' }" @click="setStatus(cue, 'disabled')">Exclude</button>
          </div>
        </article>
        </fieldset>
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
import { UNCONFIRMED_SUBMISSION } from '~/composables/useFreshGenerationAction'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { cuesAwaitingApproval, storedPresetAutoApprove } from '../../../utils/contextual-cues.js'
import {
  CONTEXTUAL_CUE_CORNERS,
  CONTEXTUAL_CUE_CORNER_LABELS,
  CUE_SAFE_MARGIN_PCT,
  clampCuePct,
  hasPreciseCuePosition,
  isContextualCueCorner,
  nearestCueCorner,
  resolveContextualCuePosition,
  type ContextualCueCorner,
} from '@shared/contextual-cue-position'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Contextual Cues')

type Cue = {
  id: string; scene_id: string; start_sec: number; end_sec: number; title: string; subtitle?: string
  kind: 'location_date' | 'historical_context' | 'person' | 'chapter'; placement: ContextualCueCorner
  position_x_pct?: number | null; position_y_pct?: number | null
  template: 'documentary-label' | 'map-pin' | 'archival-caption' | 'chapter-plate'; entrance: 'fade' | 'slide' | 'dissolve'; exit: 'fade' | 'slide' | 'dissolve'; status: 'proposed' | 'approved' | 'disabled'; created_at: string; updated_at: string
}
type CueConfig = { enabled: boolean; auto_approve_cues: boolean }
type CueProposalForm = {
  model: string
  density: 'restrained' | 'standard' | 'editorial'
  /** All four corners — see `@shared/contextual-cue-position`. */
  placement: ContextualCueCorner
  position_x_pct?: number | null
  position_y_pct?: number | null
  auto_approve: boolean
}
type AutoApprovalHold = { cue_id: string; reasons: string[] }
type Timeline = { schema_version: 1; generated_at: string; source_scene_plan_generated_at: string; cues: Cue[]; auto_approval_holds?: AutoApprovalHold[] }
type ProposalProgress = { total_scenes: number; total_batches: number; completed_batches: Array<{ scene_ids: string[] }>; provisional_cues?: Cue[] }

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put } = useApi()
const freshCueAction = useFreshGenerationAction()
const { success, error: showError, showAction } = useToast()
const { isJobActiveFor } = useJobs()
const episodeId = ref('')
const config = ref<CueConfig>({ enabled: false, auto_approve_cues: false })
const form = ref<CueProposalForm>({ model: '', density: 'restrained', placement: 'top-right', position_x_pct: null, position_y_pct: null, auto_approve: false })
useRememberedForm('contextual-cues', slug, form, { include: ['model', 'density', 'placement', 'position_x_pct', 'position_y_pct', 'auto_approve'], version: 1 })
const timeline = ref<Timeline | null>(null)
// Which project and episode the loaded timeline belongs to. The selection can
// move while a write is in flight; a save must address the timeline it came
// from, never whichever route happens to be selected by the time it fires.
const timelineProjectSlug = ref('')
const timelineEpisodeId = ref('')
let cueScopeEpoch = 0
let cueProjectEpoch = 0
let timelineLoadSequence = 0
const proposalProgress = ref<ProposalProgress | null>(null)
const validation = ref<Array<{ cue_id?: string; detail: string; severity?: 'error' | 'warning' }>>([])
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
  if (!form.value.model) return 'Choose a live Gateway model.'
  return timeline.value?.cues?.length ? 'Refreshes unresolved proposals; approved and excluded cues stay intact.' : 'Creates a reviewed cue proposal from this episode’s Scene Plan.'
})

function time(value: number): string { const minutes = Math.floor(value / 60); const seconds = Math.floor(value % 60); return `${minutes}:${String(seconds).padStart(2, '0')}` }
function setStatus(cue: Cue, status: Cue['status']): void { cue.status = status; markDirty() }

// ── The preset says what it changed ─────────────────────────────────────────
//
// v1.3.3. The owner applied his "Contextual Cues - DeepSeek" preset for its
// model and density and found "Auto-approve safe proposals" switched on: "i
// don't remember telling you that the it's preset for auto approved is being
// applied or not." The preset genuinely stores it, and it stays there — he was
// offered removal and declined (AGENTS.md, Preset Boundaries, 2026-08-18).
//
// So it is announced instead, in BOTH directions, exactly as v1.2.5 announces
// scene rhythm on the Character Sheet. A silent switch-OFF is the same defect
// as a silent switch-on; a preset that stores nothing changes nothing and says
// nothing, which is why `storedPresetAutoApprove` has three answers and not two.
const autoApproveNotice = ref<{ on: boolean; changed: boolean } | null>(null)
/** Any hand edit of the tick-box supersedes what the last applied preset said. */
function onAutoApproveEdited(): void { autoApproveNotice.value = null }

// ── Placement ───────────────────────────────────────────────────────────────
//
// The four corners stay one-click presets; dragging the frame preview sets a
// precise anchor that overrides the corner. Every interaction funnels through
// `setCuePosition`/`useCueCorner` so the two can never disagree — the same
// single-setter discipline `SubtitleStylePicker` uses for captions.
//
// Geometry itself is imported, never re-derived here: the preview has to draw
// each label exactly where FFmpeg will, and a preview that lies is worse than
// no preview at all.

const CORNERS = CONTEXTUAL_CUE_CORNERS
const cornerLabel = (corner: ContextualCueCorner): string => CONTEXTUAL_CUE_CORNER_LABELS[corner]

/** Where this cue will actually be drawn, corner or precise anchor alike. */
function cuePosition(cue: Pick<Cue, 'placement' | 'position_x_pct' | 'position_y_pct'>) {
  return resolveContextualCuePosition(cue)
}

/**
 * A chapter plate is a centred title card and ignores the corner preset, as it
 * always has. Saying so on the row keeps the corner menu from looking broken.
 */
const ignoresCorner = (cue: Cue): boolean => cue.template === 'chapter-plate' && !hasPreciseCuePosition(cue)

function setCuePosition(cue: Cue, xPct: number, yPct: number): void {
  cue.position_x_pct = Number(clampCuePct(xPct).toFixed(1))
  cue.position_y_pct = Number(clampCuePct(yPct).toFixed(1))
  // Keep the stored corner honest, so a cue that later drops its precise
  // anchor falls back to the corner it was nearest rather than the one it
  // happened to be proposed with.
  cue.placement = nearestCueCorner(cue.position_x_pct, cue.position_y_pct)
  markDirty()
}

/** Back to a plain corner preset — the precise anchor is dropped, not hidden. */
function useCueCorner(cue: Cue, corner: ContextualCueCorner): void {
  cue.placement = corner
  cue.position_x_pct = null
  cue.position_y_pct = null
  markDirty()
}

function setCueAxis(cue: Cue, axis: 'x' | 'y', value: number): void {
  const current = cuePosition(cue)
  setCuePosition(cue, axis === 'x' ? value : current.xPct, axis === 'y' ? value : current.yPct)
}

const draggingCueId = ref('')
function positionFromPointer(cue: Cue, event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement | null
  const rect = target?.getBoundingClientRect()
  if (!rect?.width || !rect.height) return
  setCuePosition(cue, ((event.clientX - rect.left) / rect.width) * 100, ((event.clientY - rect.top) / rect.height) * 100)
}
function startCueDrag(cue: Cue, event: PointerEvent): void {
  if (cueJobActive.value) return
  draggingCueId.value = cue.id
  ;(event.currentTarget as HTMLElement | null)?.setPointerCapture(event.pointerId)
  positionFromPointer(cue, event)
}
function moveCueDrag(cue: Cue, event: PointerEvent): void {
  if (draggingCueId.value === cue.id) positionFromPointer(cue, event)
}
function stopCueDrag(event: PointerEvent): void {
  draggingCueId.value = ''
  const target = event.currentTarget as HTMLElement | null
  if (target?.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
}

// The proposal form carries the same two fields as a cue, so the default pad
// reuses the same geometry — it just has no `dirty` flag to raise.
function setDefaultPosition(xPct: number, yPct: number): void {
  form.value.position_x_pct = Number(clampCuePct(xPct).toFixed(1))
  form.value.position_y_pct = Number(clampCuePct(yPct).toFixed(1))
  form.value.placement = nearestCueCorner(form.value.position_x_pct, form.value.position_y_pct)
}
function setDefaultAxis(axis: 'x' | 'y', value: number): void {
  const current = cuePosition(form.value as any)
  setDefaultPosition(axis === 'x' ? value : current.xPct, axis === 'y' ? value : current.yPct)
}
function defaultFromPointer(event: PointerEvent): void {
  const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  if (!rect?.width || !rect.height) return
  setDefaultPosition(((event.clientX - rect.left) / rect.width) * 100, ((event.clientY - rect.top) / rect.height) * 100)
}
function startDefaultDrag(event: PointerEvent): void {
  draggingCueId.value = '__default__'
  ;(event.currentTarget as HTMLElement | null)?.setPointerCapture(event.pointerId)
  defaultFromPointer(event)
}
function moveDefaultDrag(event: PointerEvent): void {
  if (draggingCueId.value === '__default__') defaultFromPointer(event)
}

/** Inline style putting the preview label where the render will put it. */
function cueChipStyle(cue: Pick<Cue, 'placement' | 'position_x_pct' | 'position_y_pct'>) {
  const { xPct, yPct } = cuePosition(cue)
  // Anchor at the outer thirds, mirroring `customAxis` in the renderer, so the
  // chip grows away from the edge exactly as the drawn label does.
  const tx = xPct <= 33 ? '0%' : xPct >= 67 ? '-100%' : '-50%'
  const ty = yPct <= 33 ? '0%' : yPct >= 67 ? '-100%' : '-50%'
  return { left: `${xPct}%`, top: `${yPct}%`, transform: `translate(${tx}, ${ty})` }
}
const safeBoundaryStyle = { inset: `${CUE_SAFE_MARGIN_PCT}%` }

/**
 * Put every cue where this one sits. Explicit and named with its count. Like
 * every other edit on this page it goes through `markDirty`, so it rides the
 * same auto-save rather than writing on its own (v1.3.3).
 */
function applyPositionToAll(source: Cue): void {
  const cues = timeline.value?.cues || []
  const { xPct, yPct } = cuePosition(source)
  const custom = hasPreciseCuePosition(source)
  for (const cue of cues) {
    if (cue.id === source.id) continue
    if (custom) setCuePosition(cue, xPct, yPct)
    else useCueCorner(cue, source.placement)
  }
  markDirty()
  success(`Moved ${cues.length - 1} other cue${cues.length === 2 ? '' : 's'} to match. Saving now.`)
}

/** Warnings never block; they are shown beside the cue they belong to. */
const cueWarnings = computed(() => {
  const map = new Map<string, string[]>()
  for (const issue of validation.value) {
    if (issue.severity !== 'warning' || !issue.cue_id) continue
    map.set(issue.cue_id, [...(map.get(issue.cue_id) || []), issue.detail])
  }
  return map
})
const blockingValidation = computed(() => validation.value.filter(issue => issue.severity !== 'warning'))
/** Errors (a refused save's included) marked on the cue they belong to. */
const cueErrors = computed(() => {
  const map = new Map<string, string[]>()
  for (const issue of blockingValidation.value) {
    if (!issue.cue_id) continue
    map.set(issue.cue_id, [...(map.get(issue.cue_id) || []), issue.detail])
  }
  return map
})
/**
 * v1.2.6 — approve every cue still awaiting review, in one click.
 *
 * Deliberately scoped to `proposed`. An excluded cue is a decision the
 * customer already made, and a bulk action that silently re-decides it is the
 * exact defect class AGENTS.md's "Preset Boundaries" section exists for. This
 * only resolves what was never resolved.
 *
 * v1.3.3 — it auto-saves, on the same debounce as every other edit, and gets
 * no special case. Considered and rejected: leaving a bulk approval in the
 * unsaved state for review. Two reasons.
 *
 * Approving fifteen cues one at a time would write them; approving the same
 * fifteen in one click would not. That is two save rules for one kind of edit,
 * distinguishable only by how the customer got there — the sort of difference
 * that is invisible until it loses work, which is the very complaint this
 * release answers.
 *
 * And the review it would protect happens later anyway. Saving an approval
 * commits nothing: an approved cue is written to the timeline, it is not
 * rendered, and it stays freely reversible right here until Video Assembly
 * runs. The counts in the page header and the status beside these buttons say
 * what just happened, so an accidental click is visible and one click away
 * from undone — and, because the write is debounced rather than immediate,
 * excluding a few straight afterwards coalesces into a single write.
 */
function approveAllProposed(): void {
  const pending = cuesAwaitingApproval(timeline.value?.cues || [])
  if (!pending.length) return
  for (const cue of pending) setStatus(cue, 'approved')
  success(`Approved ${pending.length} cue${pending.length === 1 ? '' : 's'}. Excluded cues were left as they are — saving now.`)
}
function setTransition(cue: Cue, value: string): void {
  const transition = value === 'slide' || value === 'dissolve' ? value : 'fade'
  cue.entrance = transition
  cue.exit = transition
  markDirty()
}
function isCurrentCueScope(projectSlug: string, episode: string, scopeEpoch: number): boolean {
  return cueScopeEpoch === scopeEpoch && slug.value === projectSlug && episodeId.value === episode
}
async function loadConfig(): Promise<void> {
  const projectSlug = slug.value
  const projectEpoch = cueProjectEpoch
  try {
    const data = await get<CueConfig>(`/projects/${projectSlug}/contextual-cues/config`)
    if (cueProjectEpoch !== projectEpoch || slug.value !== projectSlug) return
    config.value = data
  } catch (e: any) {
    if (cueProjectEpoch === projectEpoch && slug.value === projectSlug) showError(e?.data?.detail || 'Could not load contextual cue settings')
  }
}
async function saveConfig(): Promise<void> {
  const projectSlug = slug.value
  const projectEpoch = cueProjectEpoch
  const payload = { ...config.value }
  // The switch has already flipped (v-model); put it back if the save fails.
  const previousEnabled = !payload.enabled
  savingConfig.value = true
  try {
    const data = await put<CueConfig>(`/projects/${projectSlug}/contextual-cues/config`, payload)
    if (cueProjectEpoch !== projectEpoch || slug.value !== projectSlug) return
    config.value = data
    success(data.enabled ? 'Contextual Cues enabled' : 'Contextual Cues disabled — Video Assembly is no longer gated.')
  } catch (e: any) {
    if (cueProjectEpoch === projectEpoch && slug.value === projectSlug) {
      config.value.enabled = previousEnabled
      showError(e?.data?.detail || 'Could not save contextual cue settings')
    }
  } finally { savingConfig.value = false }
}
// v1.0.796 — "Approve cues automatically", persisted per project beside
// `enabled` above. Optimistic like saveConfig, but with its own revert and
// toast so flipping this doesn't misreport as an enabled/disabled change.
async function setAutoApproveCues(v: boolean): Promise<void> {
  const projectSlug = slug.value
  const projectEpoch = cueProjectEpoch
  const previous = config.value.auto_approve_cues
  config.value.auto_approve_cues = v
  savingConfig.value = true
  try {
    const data = await put<CueConfig>(`/projects/${projectSlug}/contextual-cues/config`, { ...config.value })
    if (cueProjectEpoch !== projectEpoch || slug.value !== projectSlug) return
    config.value = data
    success(v
      ? 'Cues will be approved automatically once they clear every structural check. Anything that fails stays here for review.'
      : 'Manual review is back on — every proposed cue needs your approval again.')
  } catch (e: any) {
    if (cueProjectEpoch === projectEpoch && slug.value === projectSlug) {
      config.value.auto_approve_cues = previous
      showError(e?.data?.detail || 'Could not save the setting')
    }
  } finally {
    savingConfig.value = false
  }
}
async function loadTimeline(): Promise<void> {
  // Never read over unsaved work. Every caller — the episode picker, the
  // enable switch, a finished proposal job — used to wipe `dirty` and discard
  // whatever had not been written yet.
  const projectSlug = slug.value
  const episode = episodeId.value
  const scopeEpoch = cueScopeEpoch
  await saveNow()
  if (!isCurrentCueScope(projectSlug, episode, scopeEpoch)) return
  if (dirty.value || saveError.value) {
    loadError.value = `Changes to episode ${timelineEpisodeId.value} are still on this page. Save them before opening episode ${episode}.`
    return
  }
  timeline.value = null; timelineProjectSlug.value = ''; timelineEpisodeId.value = ''; proposalProgress.value = null; validation.value = []; loadError.value = ''; dirty.value = false; saveError.value = ''; savedAt.value = ''
  if (!episode || !config.value.enabled) return
  const request = ++timelineLoadSequence
  try {
    const data = await get<any>(`/projects/${projectSlug}/contextual-cues/${episode}`)
    if (request !== timelineLoadSequence || !isCurrentCueScope(projectSlug, episode, scopeEpoch)) return
    timeline.value = data.timeline; timelineProjectSlug.value = projectSlug; timelineEpisodeId.value = episode; proposalProgress.value = data.proposal_progress || null; validation.value = data.validation || []
  } catch (e: any) {
    if (request === timelineLoadSequence && isCurrentCueScope(projectSlug, episode, scopeEpoch)) loadError.value = e?.data?.detail || 'Could not load the episode cue timeline.'
  }
}
async function propose(): Promise<void> {
  if (!episodeId.value || !config.value.enabled || !form.value.model) return
  const projectSlug = slug.value
  const episode = episodeId.value
  const scopeEpoch = cueScopeEpoch
  proposing.value = true
  const payload = { ...form.value }
  const operationId = freshCueAction.begin(payload)
  try {
    await post(`/projects/${projectSlug}/contextual-cues/${episode}/propose`, {
      ...payload,
      operation_id: operationId,
    })
    freshCueAction.complete(operationId)
    if (!isCurrentCueScope(projectSlug, episode, scopeEpoch)) return
    success('Contextual cue proposal queued. Review the timeline when the job completes.')
    setTimeout(() => { if (isCurrentCueScope(projectSlug, episode, scopeEpoch)) void loadTimeline() }, 1200)
  } catch (e: any) {
    if (!isCurrentCueScope(projectSlug, episode, scopeEpoch)) return
    if (e?.data?.detail) showError(e.data.detail)
    else showAction(UNCONFIRMED_SUBMISSION, 'Retry', () => propose(), 'error')
  } finally { proposing.value = false }
}
// ── Saving ──────────────────────────────────────────────────────────────────
//
// v1.3.3. "i keep forgetting to click save changes. so i want it to be
// automatic as well as a manual one for people who wants to click it again
// just to safe." Both, then: edits write themselves after a short pause, and
// Save changes stays — it flushes the pending write, or confirms there is
// nothing to write.
//
// Three things this must not do, in order of how badly they would hurt:
//   1. Lose an edit. A failed write keeps every change on screen and says so;
//      nothing is reverted and no toast is thrown over what he is typing.
//   2. Let an older write land last. Writes are queued on one tail, exactly as
//      `usePresets.persistNow()` does, so two are never in flight at once.
//   3. Revert a field under the cursor. A response that comes back to find the
//      timeline edited since it was sent is already stale — its copy of the
//      cues is dropped rather than written over what he typed meanwhile.

/**
 * How long the page waits after the last edit before writing.
 *
 * 800ms. Above it he types through: gaps between keystrokes inside a word run
 * roughly 200–400ms even for slow typists, so a cue title is one write and not
 * twenty. Below the ~1s mark where a pause starts reading as "nothing is
 * happening", which matters because the row beside the buttons says "saving in
 * a moment" until it fires.
 *
 * The debounce is deliberately not the only thing standing between an edit and
 * disk: leaving the page, switching episode, and reloading the timeline each
 * flush it first, so the interval never decides whether work survives.
 */
const AUTO_SAVE_DELAY_MS = 800
const savedAt = ref('')
const saveError = ref('')
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null
/**
 * Bumped by every local edit. A write records the value it was sent with; if
 * it has moved by the time the response arrives, the customer edited during
 * the round trip and the server's copy is out of date.
 */
let editSeq = 0
/** One write at a time, in order. */
let saveTail: Promise<void> = Promise.resolve()

/** The single entry point for "something on this page changed". */
function markDirty(): void {
  dirty.value = true
  editSeq += 1
  if (autoSaveTimer) clearTimeout(autoSaveTimer)
  autoSaveTimer = setTimeout(() => { autoSaveTimer = null; void saveNow() }, AUTO_SAVE_DELAY_MS)
}

/** Write now, cancelling any pending debounce. No-ops when nothing is dirty. */
function saveNow(): Promise<void> {
  if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null }
  const run = saveTail.then(writeTimeline, writeTimeline)
  saveTail = run.then(() => undefined, () => undefined)
  return run
}

async function writeTimeline(): Promise<void> {
  if (!timeline.value || !timelineProjectSlug.value || !timelineEpisodeId.value || !dirty.value) return
  const sentAt = editSeq
  const projectSlug = timelineProjectSlug.value
  const episode = timelineEpisodeId.value
  const scopeEpoch = cueScopeEpoch
  const cues = JSON.parse(JSON.stringify(timeline.value.cues))
  saving.value = true
  try {
    const data = await put<any>(`/projects/${projectSlug}/contextual-cues/${episode}`, { cues })
    const stillOwnsTimeline = timelineProjectSlug.value === projectSlug && timelineEpisodeId.value === episode
    if (stillOwnsTimeline && editSeq === sentAt) {
      // A route switch may be waiting on this write. Mark the captured timeline
      // clean even then, but never hydrate its response into the new route.
      saveError.value = ''
      savedAt.value = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      dirty.value = false
    }
    if (!isCurrentCueScope(projectSlug, episode, scopeEpoch) || !stillOwnsTimeline || editSeq !== sentAt) return
    timeline.value = data.timeline
    validation.value = data.validation || []
  } catch (e: any) {
    // Keep the edits. `dirty` stays true, so the next edit or Save changes
    // retries — but nothing retries on a timer, because a backend that is down
    // would then be asked every 800ms forever.
    if (timelineProjectSlug.value === projectSlug && timelineEpisodeId.value === episode) {
      // A refused save names the cues at fault; keep that list so each one is
      // marked where it sits instead of leaving only a generic sentence.
      const issues = Array.isArray(e?.data?.issues) ? e.data.issues : []
      if (issues.length) validation.value = issues
      saveError.value = (e?.data?.detail || 'Could not save the cue timeline.') + (issues.length ? ' The cues at fault are marked below.' : '')
    }
  } finally {
    saving.value = false
  }
}

/**
 * Save changes. It must stay useful once saving is automatic: pressing it when
 * everything is already written confirms that rather than doing nothing
 * visible, and it never claims to have saved when the write failed.
 */
async function saveTimeline(): Promise<void> {
  if (!timeline.value) return
  const savedProjectSlug = timelineProjectSlug.value
  const savedEpisode = timelineEpisodeId.value
  if (!dirty.value) { success(saveError.value ? 'Nothing left to save.' : 'Everything here is already saved.'); return }
  await saveNow()
  if (saveError.value) showError(saveError.value)
  else {
    success('Contextual cue timeline saved')
    if (slug.value !== savedProjectSlug || episodeId.value !== savedEpisode) void loadTimeline()
  }
}

const saveState = computed<'saving' | 'error' | 'unsaved' | 'saved'>(() => {
  if (saving.value) return 'saving'
  if (saveError.value) return 'error'
  if (dirty.value) return 'unsaved'
  return 'saved'
})
const saveStateLabel = computed(() => {
  if (saving.value) return 'Saving…'
  if (saveError.value) return `Not saved — ${saveError.value} Your changes are still here; Save Changes tries again.`
  if (dirty.value) return 'Unsaved changes — saving in a moment'
  return savedAt.value ? `Saved at ${savedAt.value}` : 'Saved'
})

// Leaving the page flushes whatever the debounce is still holding. The request
// outlives the component, so navigating away a moment after typing is safe.
onBeforeUnmount(() => { void saveNow() })

// A different episode makes the last preset's announcement stale — it
// described something that happened on the episode you just left.
watch(slug, () => { cueProjectEpoch++; void loadConfig() }, { flush: 'sync' })
watch([slug, episodeId], () => { cueScopeEpoch++; autoApproveNotice.value = null; void loadTimeline() }, { flush: 'sync' })
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
    // All four corners. While this accepted only the two top ones, a preset
    // that stored a bottom corner silently lost it on every apply.
    if (isContextualCueCorner(data?.placement)) form.value.placement = data.placement
    // `typeof`, not `Number(...)` — `Number(null)` is 0, which would restore a
    // preset that stores no position as one pinned to the top-left corner.
    const precise = hasPreciseCuePosition(data as any)
    form.value.position_x_pct = precise ? Number(data.position_x_pct) : null
    form.value.position_y_pct = precise ? Number(data.position_y_pct) : null
    // Read the live value BEFORE the write, because afterwards "the preset set
    // it" and "it was already like that" are indistinguishable. A preset with
    // no stored opinion leaves the setting — and the notice — alone; it must
    // never fall back to `false`, which is what `=== true` used to do.
    const storedAutoApprove = storedPresetAutoApprove(data)
    autoApproveNotice.value = storedAutoApprove === null
      ? null
      : { on: storedAutoApprove, changed: form.value.auto_approve !== storedAutoApprove }
    if (storedAutoApprove !== null) form.value.auto_approve = storedAutoApprove
  },
})
onMounted(async () => {
  await loadConfig()
  await cuePresets.load()
  // `load()` re-applies the active preset on every mount to restore the form.
  // That is a restore, not a change the customer just made, so it announces
  // nothing — only an explicit Apply does.
  autoApproveNotice.value = null
})
</script>

<style scoped>
.contextual-cues-workspace :deep(.workspace-command-surface .top-action-bar) { margin: 0; border: 0; background: transparent; box-shadow: none; }
.cues-command { display:flex; align-items:center; justify-content:space-between; gap:2rem; margin:1rem 0; padding:1.25rem 1.5rem; }
.cue-toggle-copy h2,.cue-settings h2,.cue-list h2 { margin:.25rem 0; font-size:1.1rem; }.cue-toggle-copy p,.cue-settings p { margin:0; color:var(--text-muted); max-width:46rem; }
.section-kicker { display:block; color:var(--accent-gold); text-transform:uppercase; letter-spacing:.09em; font-weight:700; font-size:.72rem; }.cue-switch { display:flex; gap:.55rem; align-items:center; font-weight:700; white-space:nowrap; }.cue-switch input { width:1.2rem; height:1.2rem; accent-color:var(--accent-gold); }
.cues-auto-command { margin-top:-.3rem; border-left:3px solid var(--accent-gold); }.cues-auto-command .cue-toggle-copy p { max-width:52rem; }
.cue-hold-reason { grid-column:1/-1; margin:.85rem 0 -.35rem; padding:.5rem .7rem; color:var(--text-primary); background:color-mix(in srgb, var(--warning) 9%, var(--bg-secondary)); border:1px solid color-mix(in srgb, var(--warning) 42%, var(--border)); border-radius:.35rem; font-size:.8rem; line-height:1.4; }
/* Advisory only — deliberately quieter than .cue-hold-reason, which marks a
   cue that is actually held back. A note the customer may ignore must not
   look like one they must act on. */
.cue-warning { grid-column:1/-1; margin:.85rem 0 -.35rem; padding:.4rem .7rem; color:var(--text-muted); background:var(--bg-secondary); border-left:2px solid color-mix(in srgb, var(--warning) 55%, var(--border)); border-radius:.25rem; font-size:var(--font-xs); line-height:1.45; }
/* The frame preview doubles as the position pad. 16:9 so the label sits where
   it will sit on the delivered video, not on an arbitrary rectangle. */
.cue-frame { position:relative; aspect-ratio:16/9; background:#0b1220; border:1px solid #364152; border-radius:.45rem; overflow:hidden; cursor:crosshair; touch-action:none; }
.cue-safe-boundary { position:absolute; border:1px dashed color-mix(in srgb, var(--accent-gold) 38%, transparent); border-radius:.25rem; pointer-events:none; }
/* The chip must read as a LABEL SITTING SOMEWHERE, not as the panel itself.
   At full size it filled most of the miniature and a bottom-anchored one
   overflowed and was clipped, so the very thing this control exists to show —
   position — was the thing you could not see. Held to a fraction of the frame
   and shrunk to match. */
.cue-frame .cue-preview { position:absolute; max-width:64%; max-height:62%; min-height:0; gap:0; padding:.2rem .3rem; border-radius:.2rem; overflow:hidden; pointer-events:none; }
.cue-frame .cue-preview strong { font-size:.62rem; line-height:1.1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cue-frame .cue-preview small,.cue-frame .cue-preview-kicker { font-size:.5rem; line-height:1.15; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cue-frame .cue-preview-pin { font-size:.7rem; }
.cue-frame-default { width:12rem; }
.cue-frame-chip { position:absolute; padding:.2rem .45rem; color:#fff; background:#111827; border:1px solid #364152; border-radius:.25rem; font-size:var(--font-xs); pointer-events:none; }
.cue-default-position { grid-column:1/-1; display:grid; grid-template-columns:minmax(14rem,1fr) auto auto; gap:1rem; align-items:center; padding:.7rem .8rem; background:var(--bg-secondary); border:1px solid var(--border-color); border-radius:.4rem; }
.cue-default-position-copy p { margin:.2rem 0 .45rem; }
.cue-axis-fields { display:grid; gap:.35rem; min-width:9rem; }
.cue-axis-fields label { display:grid; gap:.15rem; color:var(--text-muted); font-size:var(--font-xs); }
.cue-settings { display:grid; grid-template-columns:minmax(16rem, .85fr) minmax(30rem, 1.6fr); align-items:start; gap:1.5rem; margin-bottom:1rem; padding:1.25rem 1.5rem; }.cue-settings-controls { display:grid; grid-template-columns:repeat(auto-fit, minmax(16rem, 1fr)); gap:1rem; align-items:end; }.cue-settings-controls > label .select { width:100%; min-width:0; }.cue-settings-controls > label { display:grid; gap:.4rem; color:var(--text-muted); font-size:.82rem; }.cue-auto-approve { grid-column:1/-1; display:flex !important; align-items:flex-start; gap:.55rem; padding:.55rem .65rem; background:var(--bg-secondary); border:1px solid var(--border-color); border-radius:.4rem; }.cue-auto-approve input { margin-top:.14rem; accent-color:var(--accent-gold); }.cue-auto-approve strong,.cue-auto-approve small { display:block; }.cue-auto-approve small { margin-top:.15rem; color:var(--text-muted); line-height:1.35; }
.cue-auto-approve-notice { grid-column:1/-1; margin:0; }
.cue-rows { display:contents; }
.cue-job-lock { margin:0 0 .75rem; padding:.5rem .7rem; color:var(--text-primary); background:var(--accent-dim); border-radius:.35rem; font-size:.82rem; }
.cue-list { padding:1.25rem; }.cue-list-heading { display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:1rem; }.cue-list-actions { display:flex; gap:.4rem; align-items:center; flex-wrap:wrap; }
/* Saved is the resting state and must not compete with the buttons beside it;
   only the states that need something from the customer take a colour. */
.cue-save-state { max-width:32rem; color:var(--text-muted); font-size:var(--font-xs); line-height:1.35; }
.cue-save-state[data-state="unsaved"],.cue-save-state[data-state="saving"] { color:var(--accent-gold); }
.cue-save-state[data-state="error"] { color:var(--warning); font-weight:600; }/* The placement column is wider than the old 11rem preview: it now has to
   show WHERE a label sits, which needs frame around the label to sit in. */
.cue-row { display:grid; grid-template-columns:7.5rem 15rem minmax(20rem,1fr) auto; gap:1rem; padding:1rem 0; border-top:1px solid var(--border-color); }.cue-row.is-approved { border-left:3px solid var(--success); padding-left:.75rem; }.cue-row.is-disabled { opacity:.55; }.cue-time { color:var(--accent-gold); font-variant-numeric:tabular-nums; font-weight:700; padding-top:.55rem; }.cue-preview { min-height:4.8rem; display:flex; flex-direction:column; justify-content:center; gap:.13rem; padding:.65rem .8rem; color:#fff; background:#111827; border:1px solid #364152; border-radius:.45rem; overflow:hidden; }.cue-preview strong { font-size:.78rem; line-height:1.15; }.cue-preview small,.cue-preview-kicker { color:#b6c0d1; font-size:.6rem; letter-spacing:.08em; text-transform:uppercase; }.cue-preview-pin { color:#f4c75d; font-size:1rem; line-height:.7; }.preview-map-pin { border-left:3px solid #f4c75d; }.preview-archival-caption { color:#f4ead1; background:#2c211b; border-color:#66513f; font-family:Georgia,serif; }.preview-chapter-plate { text-align:center; background:linear-gradient(135deg,#111827,#2b3445); }.cue-fields { display:grid; grid-template-columns:1fr 1fr; gap:.5rem; }.cue-meta { grid-column:1/-1; display:grid; grid-template-columns:repeat(auto-fill, minmax(9.5rem, 1fr)); gap:.45rem .55rem; align-items:center; }.cue-meta .select { width:100%; min-width:0; }.cue-meta label { display:flex; gap:.3rem; align-items:center; justify-content:space-between; color:var(--text-muted); font-size:.78rem; }.cue-meta label .input-time { width:auto; flex:1; min-width:0; }.input-time { width:5.5rem; }.cue-actions { display:flex; gap:.4rem; align-items:start; }.is-active { outline:1px solid var(--accent-gold); }
@media (max-width:980px) { .cue-settings,.cue-settings-controls { grid-template-columns:1fr; } }
@media (max-width:1000px) { .cue-row { grid-template-columns:7.5rem 1fr auto; }.cue-preview { grid-column:2; } }
@media (max-width:800px) { .cues-command { align-items:stretch; flex-direction:column; }.cue-row { grid-template-columns:1fr; }.cue-preview { grid-column:auto; }.cue-fields { grid-template-columns:1fr; }.cue-actions { justify-content:flex-start; } }
</style>
