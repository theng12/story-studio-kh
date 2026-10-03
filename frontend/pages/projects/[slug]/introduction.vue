<!--
  The Introduction — v1.4.73.

  This page exists because the answer to "does this channel open with a host?"
  had nowhere to live. It was a checkbox on the Script page's Outline tab that
  reset itself on every context reload, drawn only for channels whose niche
  happened to declare an `openingProfile` — one niche of twenty-one, so seven
  of ten channels had no control at all and no explanation.

  Four rules this page must keep:

  1. IT IS ALWAYS IN THE SIDEBAR, whether or not the channel uses an opening.
     A page that appears only once the feature is switched on cannot teach
     anybody that the feature exists; it just moves the hiding place.

  2. GENERATION FOLLOWS WHAT IS SAVED HERE, not what anyone clicked last.
     If this channel says it opens with an Introduction, every path that
     writes an episode writes one — this page, and an unattended batch alike.
     The batch's separate tick-box is gone.

  3. EVERY BEAT SAYS WHAT IT DOES, on screen, without being opened. Seven
     unexplained labels teaches no more than a hidden checkbox did. The
     wording is served by the API, so there is one copy of it.

  4. A SAVED RECIPE CANNOT REACH THE BATCH. Presets fill this form in;
     pressing Save is what changes what gets written. `introduction-only`
     stays in the pipeline's NO_PRESET_STEPS, because a step that is added
     automatically must never be able to demand a preset — that demand is
     what refused entire batches on every channel that had never saved one.
-->
<template>
  <div class="workspace-page introduction-workspace">
    <WorkspaceHero
      eyebrow="Story · Optional"
      title="Introduction"
      :description="heroDescription"
    >
      <template #aside>
        <div class="workspace-metrics" aria-label="Introduction status">
          <span class="workspace-metric" :data-tone="segment.enabled ? 'success' : undefined">
            <strong>{{ segment.enabled ? 'On' : 'Off' }}</strong> for this channel
          </span>
          <span v-if="segment.enabled" class="workspace-metric">
            <strong>~{{ recipe.word_target }}</strong> words
          </span>
          <span v-if="segment.enabled" class="workspace-metric">
            <strong>{{ enabledBeats.length }}</strong> {{ enabledBeats.length === 1 ? 'beat' : 'beats' }}
          </span>
        </div>
      </template>
    </WorkspaceHero>

    <div class="workspace-command-surface">
      <TopActionBar
        :project-slug="slug"
        :presets="introPresets"
        v-model:episode-id="episodeId"
        filter-field="introduction"
        generate-label="Write this episode's opening"
        :generate-loading="generating"
        :generate-disabled="!canGenerateIntroduction"
        :generate-status="actionStatus"
        @generate="generateForEpisode"
      />
      <p class="muted mt-1">
        The preset bar above keeps a reusable recipe you can load on any channel. It does not change what
        this channel writes — only <strong>Save for this channel</strong> below does.
      </p>
      <p v-if="scriptReadinessState === 'missing'" class="muted mt-1">
        <NuxtLink :to="`/projects/${slug}/scripts?episode_id=${encodeURIComponent(episodeId)}`">Open Script Generator</NuxtLink>
      </p>
    </div>

    <InheritedLlmLineupNotice :project-slug="slug" />

    <!-- The setting was inferred rather than chosen. Say so, and ask. -->
    <WorkspaceNotice v-if="segment.inferred_at" tone="warning" title="This was worked out from your existing episodes">
      Nothing in this channel ever recorded whether it opens with an Introduction, so this app looked at
      what the channel has actually made. It found episodes that already have one, and switched this on.
      That is a guess from evidence, not something you chose. Check the settings below and press Save —
      whichever way you leave it — and this notice goes away.
    </WorkspaceNotice>

    <section class="card intro-command">
      <div>
        <span class="section-kicker">Channel setting</span>
        <h2>This channel opens with an Introduction</h2>
        <p>
          Some channels open with a host greeting the audience; some open on the story itself. This is
          where that choice lives, and it is the only place it lives. Turn it on and every episode this
          channel writes gets an opening — from this page and from an unattended batch run alike.
        </p>
        <p class="intro-cost-note">
          An opening is about {{ recipe.word_target }} words against a full episode's script, so it is a
          small part of what an episode costs to write. It is read aloud as part of the same narration
          the episode already pays to voice, so it adds no separate audio charge.
        </p>
      </div>
      <label class="intro-switch">
        <input v-model="segment.enabled" type="checkbox" :disabled="saving" />
        <span>{{ segment.enabled ? 'Enabled' : 'Disabled' }}</span>
      </label>
    </section>

    <WorkspaceNotice v-if="!segment.enabled" tone="info" title="Introduction is off">
      Episodes written for this channel will begin at chapter one. You can still set an opening up below
      and turn it on later; nothing here is generated until it is switched on. An opening pasted in by
      hand on the Script page is still kept — this setting decides what the app writes, not what you write.
    </WorkspaceNotice>
    <WorkspaceNotice v-else tone="success" title="Every episode this channel writes will get an opening">
      That includes unattended batch runs. There is no separate box to tick on the Pipeline any more —
      it follows this setting, so an opening can no longer be missed by forgetting to ask for one.
    </WorkspaceNotice>

    <section class="card intro-recipe">
      <div class="recipe-heading">
        <div>
          <span class="section-kicker">The opening's recipe</span>
          <h2>What it says, every time</h2>
          <p>
            This belongs to the channel, not to a saved preset and not to one episode. The words are
            written fresh for each episode; what you set here is the shape they follow.
          </p>
          <!--
            Where this recipe came from.

            The audit's finding, applied to the recipe: a value the app worked
            out and a value somebody chose look identical on screen and are not
            the same kind of thing. Every channel that predates v1.4.73 is
            handed its Formula's opening rather than the old sleep-shaped seven,
            and it must not be presented as though its owner picked it.

            Three states, not two, because "edited but not saved" is a real
            state and saying "this is your own opening" before Save would be
            the same lie in the other direction.
          -->
          <p class="recipe-provenance" :data-state="provenanceState">
            {{ provenanceLine }}
          </p>
        </div>
        <button class="btn btn-primary" :disabled="saving || (!dirty && !segment.inferred_at)" @click="save">
          {{ saving ? 'Saving…' : 'Save for this channel' }}
        </button>
      </div>

      <div class="recipe-fields">
        <label class="recipe-field">
          <span class="field-label">Host or narrator name</span>
          <input v-model="recipe.host_name" class="input" placeholder="e.g. Luna, Vincent, or your own name" />
          <small class="field-help">Leave blank and the opening will not name a host.</small>
        </label>
        <label class="recipe-field">
          <span class="field-label">Length</span>
          <input
            v-model.number="recipe.word_target"
            class="input"
            type="number"
            :min="wordTargetMin"
            :max="wordTargetMax"
          />
          <small class="field-help">
            Roughly how many words the opening runs to, between {{ wordTargetMin }} and {{ wordTargetMax }}.
          </small>
        </label>
        <label class="recipe-field recipe-field-wide">
          <span class="field-label">Opening line</span>
          <input v-model="recipe.custom_opening_line" class="input" placeholder="Hello, and welcome back…" />
          <small class="field-help">
            Leave blank to let the opening find its own first line. Filled in, it is used word for word.
          </small>
        </label>
      </div>

      <!--
        Which model writes it.

        Two states, not one dropdown. A bare picker cannot express "follow the
        Script Generator" — it would have to show SOME model, and `ModelSelector`
        fills an empty value with the cheapest usable product the moment it
        mounts. That would turn every channel that has never touched this into
        one that has chosen, silently, on first visit. So the default is a
        choice you can see, and the picker only appears once somebody has
        actually asked for a different model.
      -->
      <div class="recipe-model">
        <span class="field-label">Which model writes it</span>
        <label class="model-choice">
          <input type="radio" :checked="usesScriptModel" @change="useScriptModel" />
          <span>
            <strong>The same one as the chapters</strong>
            <small>
              Whatever is saved under Main settings in the
              <NuxtLink :to="`/projects/${slug}/scripts`">Script Generator</NuxtLink>. This is what
              every channel does unless it says otherwise, and nothing is substituted if that is
              unset — the opening is refused with an explanation instead.
            </small>
          </span>
        </label>
        <label class="model-choice">
          <input type="radio" :checked="!usesScriptModel" @change="useOwnModel" />
          <span>
            <strong>A different model, chosen here</strong>
            <small>
              Used by everything that writes this channel's opening — this page, the Script page's
              chained run, and an unattended batch alike.
            </small>
          </span>
        </label>
        <ModelSelector
          v-if="!usesScriptModel"
          v-model="recipe.model"
          :project-slug="slug"
          label="Model for this channel's opening"
        />
      </div>

      <div class="beats-heading">
        <h3>What the opening covers</h3>
        <p>
          In order. Every beat says what it actually produces — switch one off and it is skipped
          entirely rather than summarised. Open a beat to say what you want it to cover in this
          channel's own words.
        </p>
      </div>

      <div class="intro-beats">
        <div v-for="(beat, i) in recipe.beats" :key="beat.id" class="beat-card">
          <div class="beat-row">
            <div class="beat-controls">
              <button class="btn-icon" :disabled="i === 0" title="Move up" @click="moveBeat(i, -1)">▲</button>
              <button class="btn-icon" :disabled="i === recipe.beats.length - 1" title="Move down" @click="moveBeat(i, 1)">▼</button>
            </div>
            <label class="beat-label">
              <input v-model="beat.enabled" type="checkbox" />
              <span>{{ beat.label }}</span>
            </label>
            <button
              class="btn-icon"
              :class="{ 'has-custom': !!beat.custom_text?.trim() }"
              :title="beat.custom_text?.trim() ? 'Wording set — click to edit' : 'Say what this beat should cover'"
              @click="toggleExpanded(beat.id)"
            ><span class="ds-chevron" :class="{ 'is-open': expanded.has(beat.id) }" aria-hidden="true" /></button>
            <button class="btn-icon danger" title="Remove" @click="removeBeat(i)">✕</button>
          </div>
          <!--
            The explanation is not optional detail behind the disclosure arrow.
            "Community question" means nothing to somebody who has never run a
            channel, and seven unexplained labels is the same failure as hiding
            the feature, reached by a different route. It is always on screen.
          -->
          <p v-if="beatDescription(beat.id)" class="beat-description">
            {{ beatDescription(beat.id) }}
            <em v-if="beatSuitsNote(beat.id)" class="beat-suits">{{ beatSuitsNote(beat.id) }}</em>
          </p>
          <div v-if="expanded.has(beat.id)" class="beat-detail">
            <textarea
              v-model="beat.custom_text"
              class="textarea beat-textarea"
              :placeholder="`Optional — what this beat should cover. For example: ${beatPlaceholder(beat.id)}`"
            />
          </div>
        </div>
      </div>

      <!--
        Two ways to add one, because they are different acts.

        Putting back a beat you removed must restore the BEAT, not a lookalike
        with the same words typed into it: the left-hand picker adds it by its
        catalogue id, so its explanation and its example come back with it.
        Before this, removing "Story teaser" and retyping the label produced a
        beat called `custom-1756…` whose explanation was gone for good.
      -->
      <div class="beat-add-row">
        <select v-if="restorableBeats.length" v-model="restoreBeatId" class="input input-sm">
          <option value="">Put a standard beat back…</option>
          <option v-for="b in restorableBeats" :key="b.id" :value="b.id">{{ b.label }}</option>
        </select>
        <button
          v-if="restorableBeats.length"
          class="btn btn-sm btn-secondary"
          :disabled="!restoreBeatId"
          @click="restoreBeat"
        >
          + Add
        </button>
        <input
          v-model="newBeatLabel"
          class="input input-sm"
          placeholder="…or write your own — e.g. Sponsor mention, Weekly riddle"
          @keydown.enter.prevent="addBeat"
        />
        <button class="btn btn-sm btn-secondary" :disabled="!newBeatLabel.trim()" @click="addBeat">
          + Add beat
        </button>
      </div>
    </section>

    <!-- "still running" and "it failed" are different answers, and the empty
         preview panel cannot tell them apart on its own. -->
    <p v-if="segment.enabled && episodeId && introductionInFlight" class="intro-job-status running">
      Writing the opening… the preview updates itself when it finishes.
    </p>
    <p v-else-if="segment.enabled && episodeId && introFailure" class="intro-job-status failed">
      {{ introFailure }}
    </p>

    <IntroductionPreview
      v-if="episodeId"
      :project-slug="slug"
      :episode-id="episodeId"
      :refresh-key="previewRefreshKey"
      @saving-change="onPreviewSavingChange"
      @script-readiness="scriptReadiness = $event"
    />
  </div>
</template>

<script setup lang="ts">
import { UNCONFIRMED_SUBMISSION } from '~/composables/useFreshGenerationAction'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useApi } from '../../../composables/useApi.js'
import { useToast } from '../../../composables/useToast.js'
import { usePresets } from '../../../composables/usePresets.js'
import { useJobs } from '../../../composables/useJobs.js'
import {
  introductionInFlight as introductionInFlightFor,
  introductionJobSignal as introductionJobSignalFor,
  settleIntroductionJobs,
} from '../../../composables/useIntroductionJobWatch.js'

// Presets are project-scoped and usePresets captures its slug when this page
// is created. Force a fresh page instance when the route moves between
// projects so one channel's recipe, enabled state, or preset controller can
// never be saved or generated against the next channel.
definePageMeta({ layout: 'dashboard', key: route => String(route.params.slug || '') })
useAppTitle('Introduction')

type Beat = { id: string; label: string; enabled: boolean; custom_text?: string }
type Recipe = {
  host_name: string
  word_target: number
  custom_opening_line: string
  beats: Beat[]
  /** '' = follow the Script Generator's model. See the radio pair above. */
  model: string
}
type Segment = { enabled: boolean; recipe: Recipe; inferred_at?: string }
type BeatDefinition = { id: string; label: string; description: string; example: string; suitsNote?: string }
type SegmentsResponse = {
  segments: Record<string, Segment>
  /** What each standard beat produces. Served by the API; never copied here. */
  beat_library: BeatDefinition[]
  opening_profile: { id: string; label: string; description: string } | null
  /** Is the recipe above the Formula's, or an edit of this channel's own? */
  opening_follows_formula?: boolean
  /** The Formula's name, so the page can say which one it is following. */
  formula_name?: string
  word_target_min: number
  word_target_max: number
}

const route = useRoute()
const slug = computed(() => String(route.params.slug))
const { get, put, post } = useApi()
const freshIntroductionAction = useFreshGenerationAction()
const { success, error: showError, showAction } = useToast()

const episodeId = ref('')
const scriptReadiness = ref<{ projectSlug: string; episodeId: string; state: 'loading' | 'ready' | 'missing' | 'error' } | null>(null)
const scriptReadinessState = computed(() => scriptReadiness.value?.projectSlug === slug.value
  && scriptReadiness.value?.episodeId === episodeId.value ? scriptReadiness.value.state : 'loading')
const canGenerateIntroduction = computed(() => segment.enabled && !!episodeId.value && !saving.value
  && scriptReadinessState.value === 'ready' && !scriptWriting.value && !generating.value && !previewSaving.value && !introductionInFlight.value)
const saving = ref(false)
const generating = ref(false)
const previewSaving = ref(false)
const loading = ref(true)
/**
 * What the server last confirmed, as one string. `dirty` is a comparison
 * against it, not a flag: a deep watch used to set the flag AFTER load() and
 * save() had cleared it, so the page claimed unsaved changes straight after
 * Save.
 */
const savedShape = ref('')
const currentShape = (): string => JSON.stringify({ enabled: segment.enabled, recipe: segment.recipe })
const dirty = computed(() => !loading.value && currentShape() !== savedShape.value)
useUnsavedGuard(dirty, 'Introduction edits')
const newBeatLabel = ref('')
const expanded = ref<Set<string>>(new Set())
const previewRefreshKey = ref(0)
const openingProfile = ref<SegmentsResponse['opening_profile']>(null)
const followsFormula = ref(false)
const formulaName = ref('')
/**
 * The recipe exactly as the server last sent it.
 *
 * `dirty` cannot stand in for this: it also counts the on/off switch, and
 * flipping the switch does not make an
 * opening this channel's own. This is compared against the recipe alone.
 */
const loadedRecipeShape = ref('')
// Replaced by the server's own bounds on load; these are only what the first
// paint uses. Kept in step with WORD_TARGET_MIN/MAX in lib/episode-segments.ts,
// where the floor dropped to 50 in v1.4.73 so a listicle's short opening stops
// being silently doubled.
const wordTargetMin = ref(50)
const wordTargetMax = ref(600)

const beatLibrary = ref<BeatDefinition[]>([])
const restoreBeatId = ref('')

const segment = reactive<Segment>({
  enabled: false,
  recipe: { host_name: '', word_target: 350, custom_opening_line: '', beats: [], model: '' },
})
const recipe = computed(() => segment.recipe)
const enabledBeats = computed(() => segment.recipe.beats.filter(b => b.enabled))

/**
 * The niche's opening profile is WORDING now, nothing more. It used to decide
 * whether this feature was drawn at all, which is why most channels never saw
 * it. A niche that describes its own opening style gets to say so here; a
 * niche that says nothing changes nothing.
 */
const heroDescription = computed(() => openingProfile.value?.description
  || 'A spoken opening before the story begins. Some channels use one every episode; some never do.')

function recipeShape(r: Recipe): string {
  return JSON.stringify([r.word_target, r.beats.map(b => [b.id, b.enabled !== false, (b.custom_text || '').trim()])])
}
const recipeTouched = computed(() => !loading.value
  && !!loadedRecipeShape.value
  && recipeShape(segment.recipe) !== loadedRecipeShape.value)

const provenanceState = computed<'edited' | 'formula' | 'own'>(() => {
  if (recipeTouched.value) return 'edited'
  return followsFormula.value ? 'formula' : 'own'
})
const provenanceLine = computed(() => {
  const named = formulaName.value ? `the ${formulaName.value} Formula` : 'this channel\u2019s Formula'
  if (provenanceState.value === 'edited') {
    return 'Edited, and not saved yet. Press Save for this channel and this becomes this channel\u2019s own opening,'
      + ' kept exactly as you leave it.'
  }
  if (provenanceState.value === 'formula') {
    return `Following the opening that comes with ${named} \u2014 nobody here chose these beats or this`
      + ' length, they came with the Formula. Change anything and this channel keeps your version'
      + ' from then on.'
  }
  return `This channel\u2019s own opening. It no longer matches what ${named} ships, so it is left`
    + ' exactly as it is.'
})

const actionStatus = computed(() => {
  if (!segment.enabled) return 'Turn the Introduction on for this channel first.'
  if (!episodeId.value) return 'Choose an episode.'
  if (scriptWriting.value) return 'Wait for this episode’s script job to finish. Resume or cancel it in Jobs if paused.'
  if (scriptReadinessState.value === 'loading') return 'Checking this episode’s script…'
  if (scriptReadinessState.value === 'missing') return 'Generate a script first. This episode has no chapters yet.'
  if (scriptReadinessState.value === 'error') return 'Could not check the script. Refresh the preview to try again.'
  if (dirty.value) return 'Your recipe edits are saved for this channel first — the opening is written from what is saved.'
  return 'Writes the opening for this one episode. Its chapters must already exist — the opening introduces them.'
})

/**
 * Everything a standard beat says about itself comes from the server's
 * catalogue. This page used to keep its own copy of the placeholder examples
 * and no copy at all of the explanations; one list in one place cannot drift
 * from the beats it describes.
 */
const beatById = computed(() => new Map(beatLibrary.value.map(b => [b.id, b])))
function beatDescription(id: string): string { return beatById.value.get(id)?.description || '' }
function beatSuitsNote(id: string): string { return beatById.value.get(id)?.suitsNote || '' }
function beatPlaceholder(id: string): string {
  return beatById.value.get(id)?.example || 'the points, phrasing, or tone you want here'
}

/** Standard beats this channel has removed, offered back by id, not by label. */
const restorableBeats = computed(() => {
  const present = new Set(segment.recipe.beats.map(b => b.id))
  return beatLibrary.value.filter(b => !present.has(b.id))
})
function restoreBeat(): void {
  const definition = beatById.value.get(restoreBeatId.value)
  if (!definition) return
  segment.recipe.beats.push({ id: definition.id, label: definition.label, enabled: true })
  restoreBeatId.value = ''
}

/**
 * The model choice, as two states rather than one picker.
 *
 * A saved blank means "follow the Script Generator", so a channel that has
 * never been here keeps exactly the behaviour it has today. `ModelSelector`
 * heals an empty value to the cheapest usable product as soon as it mounts,
 * which is right when somebody is choosing and wrong when nobody is — so it is
 * only mounted once the second radio has actually been pressed.
 *
 * That is why the mode is its own state and not read back off the value: a
 * value alone cannot tell "not chosen" from "chosen, and the catalogue has not
 * answered yet". Saving in that gap writes a blank, which means the same thing
 * it has always meant. Nothing is ever invented.
 */
const modelMode = ref<'script' | 'own'>('script')
const usesScriptModel = computed(() => modelMode.value === 'script')
function useScriptModel(): void {
  modelMode.value = 'script'
  if (segment.recipe.model) segment.recipe.model = ''
}
function useOwnModel(): void {
  // Left blank deliberately: ModelSelector fills it with a current, usable
  // product on mount, which is a better starting point than any id spelt out
  // here — a hardcoded one would rot the day GenStudio retires it.
  modelMode.value = 'own'
}

function toggleExpanded(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}
function moveBeat(index: number, direction: number): void {
  const target = index + direction
  if (target < 0 || target >= segment.recipe.beats.length) return
  const beats = segment.recipe.beats
  ;[beats[index], beats[target]] = [beats[target], beats[index]]
}
function removeBeat(index: number): void {
  segment.recipe.beats.splice(index, 1)
}
function addBeat(): void {
  const label = newBeatLabel.value.trim()
  if (!label) return
  segment.recipe.beats.push({ id: `custom-${Date.now()}`, label, enabled: true })
  newBeatLabel.value = ''
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const data = await get<SegmentsResponse>(`/projects/${slug.value}/segments`)
    const introduction = data.segments?.introduction
    if (introduction) {
      segment.enabled = introduction.enabled
      segment.recipe = introduction.recipe
      segment.inferred_at = introduction.inferred_at
      modelMode.value = introduction.recipe.model?.trim() ? 'own' : 'script'
      loadedRecipeShape.value = recipeShape(introduction.recipe)
    }
    beatLibrary.value = Array.isArray(data.beat_library) ? data.beat_library : []
    openingProfile.value = data.opening_profile
    followsFormula.value = data.opening_follows_formula === true
    formulaName.value = data.formula_name || ''
    if (data.word_target_min) wordTargetMin.value = data.word_target_min
    if (data.word_target_max) wordTargetMax.value = data.word_target_max
  } catch (cause: any) {
    showError(cause?.data?.detail || 'Could not read this channel\'s Introduction settings')
  } finally {
    savedShape.value = currentShape()
    loading.value = false
  }
}

async function save(): Promise<boolean> {
  saving.value = true
  try {
    const data = await put<{ segments: Record<string, Segment>; opening_follows_formula?: boolean }>(
      `/projects/${slug.value}/segments/introduction`,
      { enabled: segment.enabled, recipe: segment.recipe },
    )
    const saved = data.segments?.introduction
    if (saved) {
      segment.enabled = saved.enabled
      segment.recipe = saved.recipe
      segment.inferred_at = saved.inferred_at
      modelMode.value = saved.recipe.model?.trim() ? 'own' : 'script'
      loadedRecipeShape.value = recipeShape(saved.recipe)
      // Saving may have just turned "following the Formula" into "this
      // channel's own". The answer comes back WITH the save: the server owns
      // that rule, and a page that worked it out separately would be a second
      // copy of it, free to disagree.
      followsFormula.value = data.opening_follows_formula === true
    }
    savedShape.value = currentShape()
    success(segment.enabled
      ? 'Saved. Every episode this channel writes will now open with an Introduction.'
      : 'Saved. Episodes will begin at chapter one.')
    return true
  } catch (cause: any) {
    showError(cause?.data?.detail || 'Could not save the Introduction settings')
    return false
  } finally {
    saving.value = false
  }
}

/**
 * Writing one episode's opening by hand.
 *
 * Nothing about HOW it is written is sent: the channel's recipe is read on the
 * server, so this button and an unattended batch produce the same opening from
 * the same instructions. That was the whole defect — two paths, two shapes.
 */
function onPreviewSavingChange(saving: boolean): void {
  previewSaving.value = saving
  // Saving can supersede an in-flight preview read; recheck instead of staying in 'loading'.
  if (!saving) previewRefreshKey.value += 1
}

async function generateForEpisode(): Promise<void> {
  if (!canGenerateIntroduction.value) return
  // The opening is written from what is SAVED for this channel, so unsaved
  // edits are saved first rather than silently ignored.
  if (dirty.value && !await save()) return
  generating.value = true
  const payload = { episode_id: episodeId.value }
  const operationId = freshIntroductionAction.begin(payload)
  try {
    const job = await post<{ job_id?: string }>(`/projects/${slug.value}/generate/introduction-only`, {
      ...payload,
      operation_id: operationId,
    })
    freshIntroductionAction.complete(operationId)
    if (job?.job_id) watchedIntroJobs.add(job.job_id)
    // No refresh-key bump here, deliberately. This POST only ENQUEUES — its
    // own toast says so. Bumping now reloads the panel at the one moment
    // there is nothing new on disk to find, and worse, replaces a previously
    // good preview with "No introduction generated yet". The panel is
    // refreshed by `introductionJobSignal` below, when the job actually ends.
    introFailure.value = ''
    success('Queued. The preview updates itself when it finishes.')
  } catch (cause: any) {
    if (cause?.data?.detail) showError(cause.data.detail)
    else showAction(UNCONFIRMED_SUBMISSION, 'Retry', () => generateForEpisode(), 'error')
  } finally {
    generating.value = false
  }
}

/**
 * The preview fills itself in when the job finishes.
 *
 * THE DEFECT. `generateForEpisode` only enqueues a job, and the page bumped
 * `previewRefreshKey` immediately afterwards. So `IntroductionPreview`
 * reloaded at QUEUE time, correctly found nothing on disk, and then nothing
 * ever bumped the key again — the panel sat on "No introduction generated
 * yet" until the operator reloaded the page by hand. The owner's words: "i
 * can't see the preview even after i click the refresh. it should be
 * automatic without me click the refresh though."
 *
 * THE SIGNAL, NOT A TIMER. `useJobs()` is already streaming this project's
 * queue over SSE from the dashboard layout, so completion is something the
 * page can be TOLD about. No interval is added here: an idle Introduction page
 * makes no requests of its own.
 *
 * NARROW WATCH, NOT `deep: true`. Watching the jobs array deeply fires on
 * every `output_lines` push from a running job — hundreds of times a second —
 * which is what froze the sidebar in v1.0.x. This derives a tiny string of the
 * relevant job ids and statuses and watches THAT, so it fires once per real
 * transition. Same shape as the script preview's watcher in scripts.vue.
 *
 * FAILURE IS A DIFFERENT ANSWER FROM "NOT YET". A failed generation used to
 * be indistinguishable from one still running: both showed the empty panel
 * forever. An errored job now says so, and keeps saying so until the next
 * attempt, because the operator is hitting real provider failures and needs to
 * know the difference between "wait" and "try again".
 */
const { jobs } = useJobs()
// Reuse job updates to unlock the action when this episode's chapters finish.
const scriptJobs = computed(() => jobs.value.filter(job => job.project_slug === slug.value && job.episode_id === episodeId.value
  && ['script-only', 'chapter-only', 'expand_chapters'].includes(job.type)))
const scriptWriting = computed(() => scriptJobs.value.some(job => ['queued', 'running', 'paused'].includes(job.status)))
watch(() => scriptJobs.value.map(job => `${job.job_id}:${job.status}`).join('|'), () => { previewRefreshKey.value += 1 })
// Only jobs this page has SEEN queued or running can settle. Openings that
// finished before the page opened are history, not news — and the global job
// stream already toasts every finish, so this page adds no toast of its own.
const watchedIntroJobs = new Set<string>()
const introFailure = ref('')

const introductionInFlight = computed(() =>
  introductionInFlightFor(jobs.value, slug.value, episodeId.value))

const introductionJobSignal = computed(() =>
  introductionJobSignalFor(jobs.value, slug.value, episodeId.value))

watch(introductionJobSignal, () => {
  for (const transition of settleIntroductionJobs(jobs.value, slug.value, episodeId.value, watchedIntroJobs)) {
    introFailure.value = transition.outcome === 'error' ? transition.message || '' : ''
    if (transition.outcome === 'done') previewRefreshKey.value += 1
  }
}, { immediate: true })

// A new episode is a clean slate: the previous episode's failure is not this
// one's, and its preview must be re-read rather than inherited.
watch(episodeId, () => {
  introFailure.value = ''
  previewRefreshKey.value += 1
})

/**
 * Saved recipes, so a shape that works can be used on the next channel.
 *
 * The owner's words: "intro preset must be present. it's the most important
 * thing." It carries the RECIPE only — beats, wording, length, host, model.
 * Whether a channel opens with an Introduction at all stays with the channel
 * and is never in here, because that is the one thing that must not travel:
 * applying a recipe to a channel must not switch spending on for it.
 *
 * THIS CANNOT REACH THE UNATTENDED BATCH, and that is deliberate. Introduction
 * generation reads the channel's saved recipe and nothing else, and
 * `introduction-only` stays in the pipeline's NO_PRESET_STEPS, so a channel
 * that has never saved a preset still runs. That exact demand is what broke
 * every batch before v1.4.73 — a step that is added automatically must never
 * be able to require a preset. A preset here fills this form in; pressing Save
 * is still what changes what gets written.
 *
 * `autoApplyOnLoad: false` for the same reason the Ideas page uses it: the
 * channel's own saved recipe is the truth on arrival, and a preset applying
 * itself over the top on every visit would quietly rewrite it.
 */
const introPresets = usePresets<{ recipe: Recipe }>({
  slug: slug.value,
  configKey: 'introduction',
  presetType: 'introduction',
  autoApplyOnLoad: false,
  snapshot: () => ({ recipe: JSON.parse(JSON.stringify(segment.recipe)) }),
  apply: (data) => {
    if (!data?.recipe) return
    segment.recipe = {
      // A preset saved by an older build may be missing a field the page has
      // since gained. Start from a complete shape so applying one can never
      // leave a control bound to `undefined`.
      ...segment.recipe,
      ...data.recipe,
    }
    modelMode.value = segment.recipe.model?.trim() ? 'own' : 'script'
  },
})

onMounted(async () => {
  await load()
  await introPresets.load()
})
</script>

<style scoped>
.intro-job-status { margin: 14px 0 0; padding: 9px 12px; border-radius: var(--radius-md); font-size: var(--font-xs); line-height: 1.45; }
.intro-job-status.running { background: var(--accent-dim); color: var(--text-primary); }
.intro-job-status.failed { background: color-mix(in srgb, var(--error) 11%, transparent); color: var(--error); }

.intro-command,
.intro-recipe { margin: 1rem 0; padding: 1.25rem 1.5rem; }
.intro-command { display: grid; grid-template-columns: minmax(20rem, 1fr) auto; align-items: center; gap: 2rem; }
.intro-command h2,
.intro-recipe h2 { margin: .25rem 0; font-size: 1.1rem; }
.intro-command p { margin: 0 0 .5rem; color: var(--text-muted); max-width: 52rem; }
.intro-cost-note { margin-bottom: 0 !important; }
.section-kicker { color: var(--accent-gold); text-transform: uppercase; letter-spacing: .09em; font-size: .75rem; font-weight: 700; }
.intro-switch { display: flex; gap: .55rem; align-items: center; font-weight: 700; white-space: nowrap; }
.intro-switch input { width: 1.2rem; height: 1.2rem; accent-color: var(--accent-gold); }

.recipe-heading { display: flex; justify-content: space-between; align-items: start; gap: 1.5rem; margin-bottom: 1.25rem; }
.recipe-heading p { margin: .25rem 0 0; color: var(--text-muted); max-width: 48rem; }
/* Where the recipe came from. Quiet, but always present — it is a fact about
   the settings below, not a notification. */
.recipe-provenance {
  margin: .6rem 0 0 !important;
  padding: .45rem .7rem;
  border-radius: 6px;
  font-size: .82rem;
  line-height: 1.45;
  border-left: 3px solid var(--border);
  background: var(--surface-2, rgba(127, 127, 127, .08));
}
.recipe-provenance[data-state="formula"] { border-left-color: var(--accent, #6aa9ff); }
.recipe-provenance[data-state="edited"] { border-left-color: var(--warning, #d99a2b); }

.recipe-fields { display: grid; grid-template-columns: repeat(2, minmax(14rem, 1fr)); gap: .8rem; margin-bottom: 1.5rem; }
.recipe-field { display: grid; align-content: start; gap: .4rem; min-width: 0; }
.recipe-field-wide { grid-column: 1 / -1; }
.field-label { color: var(--text-primary); font-size: .85rem; font-weight: 700; }
.field-help { color: var(--text-muted); font-size: .78rem; line-height: 1.4; }

.recipe-model { display: grid; gap: .5rem; margin-bottom: 1.5rem; }
.model-choice { display: grid; grid-template-columns: auto 1fr; gap: .6rem; align-items: start; cursor: pointer; }
.model-choice input { margin-top: .2rem; width: 1.05rem; height: 1.05rem; accent-color: var(--accent-gold); }
.model-choice strong { display: block; font-size: .9rem; }
.model-choice small { display: block; color: var(--text-muted); font-size: .78rem; line-height: 1.45; max-width: 46rem; }

.beats-heading h3 { margin: 0 0 .2rem; font-size: 1rem; }
.beats-heading p { margin: 0 0 .9rem; color: var(--text-muted); max-width: 48rem; font-size: .88rem; }
.intro-beats { display: grid; gap: .45rem; }
.beat-card { border: 1px solid var(--border-color); border-radius: .5rem; padding: .5rem .65rem; background: color-mix(in srgb, var(--bg-input) 55%, transparent); }
.beat-row { display: flex; align-items: center; gap: .55rem; }
.beat-controls { display: flex; flex-direction: column; }
.beat-label { display: flex; align-items: center; gap: .5rem; flex: 1; min-width: 0; }
.beat-label input { width: 1.05rem; height: 1.05rem; accent-color: var(--accent-gold); }
.btn-icon { background: none; border: 0; color: var(--text-muted); cursor: pointer; padding: .1rem .3rem; font-size: .85rem; }
.btn-icon:disabled { opacity: .3; cursor: default; }
.btn-icon.has-custom { color: var(--accent-gold); }
.btn-icon.danger:hover { color: var(--danger, #c0392b); }
/* Always visible, never behind the disclosure arrow — the label alone does not
   tell a new user what "Community question" writes, and that is the whole
   complaint this answers. */
.beat-description { margin: .3rem 0 0 2.1rem; color: var(--text-muted); font-size: .8rem; line-height: 1.45; max-width: 52rem; }
.beat-suits { display: block; margin-top: .15rem; color: var(--accent-gold); font-style: normal; }
.beat-detail { padding-top: .5rem; }
.beat-textarea { width: 100%; min-height: 4rem; }
.beat-add-row { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .9rem; align-items: center; }
.beat-add-row select.input { flex: 0 1 16rem; }
.beat-add-row input.input { flex: 1 1 14rem; }

@media (max-width: 1100px) {
  .intro-command,
  .recipe-fields { grid-template-columns: 1fr; }
  .recipe-heading { flex-direction: column; }
}
</style>
