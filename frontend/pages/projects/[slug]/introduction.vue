<!--
  The Introduction — v1.4.73.

  This page exists because the answer to "does this channel open with a host?"
  had nowhere to live. It was a checkbox on the Script page's Outline tab that
  reset itself on every context reload, drawn only for channels whose niche
  happened to declare an `openingProfile` — one niche of twenty-one, so seven
  of ten channels had no control at all and no explanation.

  Two rules this page must keep:

  1. IT IS ALWAYS IN THE SIDEBAR, whether or not the channel uses an opening.
     A page that appears only once the feature is switched on cannot teach
     anybody that the feature exists; it just moves the hiding place.

  2. GENERATION FOLLOWS WHAT IS SAVED HERE, not what anyone clicked last.
     If this channel says it opens with an Introduction, every path that
     writes an episode writes one — this page, and an unattended batch alike.
     The batch's separate tick-box is gone.
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
        v-model:episode-id="episodeId"
        filter-field="introduction"
        generate-label="Write this episode's opening"
        loading-label="Writing…"
        :generate-loading="generating"
        :generate-disabled="!segment.enabled || !episodeId || generating"
        :generate-status="actionStatus"
        @generate="generateForEpisode"
      />
    </div>

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
        </div>
        <button class="btn btn-primary" :disabled="saving || !dirty" @click="save">
          {{ saving ? 'Saving…' : 'Save' }}
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

      <div class="beats-heading">
        <h3>What the opening covers</h3>
        <p>
          In order. Switch one off and it is skipped entirely rather than summarised. Open a beat to say
          what you want it to cover in this channel's own words.
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
            >{{ expanded.has(beat.id) ? '▾' : '▸' }}</button>
            <button class="btn-icon danger" title="Remove" @click="removeBeat(i)">✕</button>
          </div>
          <div v-if="expanded.has(beat.id)" class="beat-detail">
            <textarea
              v-model="beat.custom_text"
              class="textarea beat-textarea"
              :placeholder="`Optional — what this beat should cover. For example: ${beatPlaceholder(beat.id)}`"
            />
          </div>
        </div>
      </div>

      <div class="beat-add-row">
        <input
          v-model="newBeatLabel"
          class="input input-sm"
          placeholder="Add a beat — e.g. Sponsor mention, Weekly riddle"
          @keydown.enter.prevent="addBeat"
        />
        <button class="btn btn-sm btn-secondary" :disabled="!newBeatLabel.trim()" @click="addBeat">
          + Add beat
        </button>
      </div>
    </section>

    <IntroductionPreview
      v-if="segment.enabled && episodeId"
      :project-slug="slug"
      :episode-id="episodeId"
      :title="''"
      :refresh-key="previewRefreshKey"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useApi } from '../../../composables/useApi.js'
import { useToast } from '../../../composables/useToast.js'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Introduction')

type Beat = { id: string; label: string; enabled: boolean; custom_text?: string }
type Recipe = { host_name: string; word_target: number; custom_opening_line: string; beats: Beat[] }
type Segment = { enabled: boolean; recipe: Recipe; inferred_at?: string }
type SegmentsResponse = {
  segments: Record<string, Segment>
  opening_profile: { id: string; label: string; description: string } | null
  word_target_min: number
  word_target_max: number
}

const route = useRoute()
const slug = computed(() => String(route.params.slug))
const { get, put, post } = useApi()
const { success, error: showError } = useToast()

const episodeId = ref('')
const saving = ref(false)
const generating = ref(false)
const dirty = ref(false)
const loading = ref(true)
const newBeatLabel = ref('')
const expanded = ref<Set<string>>(new Set())
const previewRefreshKey = ref(0)
const openingProfile = ref<SegmentsResponse['opening_profile']>(null)
const wordTargetMin = ref(100)
const wordTargetMax = ref(600)

const segment = reactive<Segment>({
  enabled: false,
  recipe: { host_name: '', word_target: 350, custom_opening_line: '', beats: [] },
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

const actionStatus = computed(() => {
  if (!segment.enabled) return 'Turn the Introduction on for this channel first.'
  if (!episodeId.value) return 'Choose an episode.'
  return 'Writes the opening for this one episode. Its chapters must already exist — the opening introduces them.'
})

const BEAT_PLACEHOLDERS: Record<string, string> = {
  welcome: 'greet the audience and introduce yourself',
  story_teaser: "hint at tonight's setting without spoiling the ending",
  community_question: 'ask listeners to share their favourite winter comfort food',
  patreon: 'mention what the membership tier includes',
  subscribe_cta: 'invite viewers to subscribe',
  relaxation: 'lead three slow breaths before the story starts',
  transition: 'invite them to close their eyes as the story begins',
}
function beatPlaceholder(id: string): string {
  return BEAT_PLACEHOLDERS[id] || 'the points, phrasing, or tone you want here'
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
  dirty.value = true
}
function removeBeat(index: number): void {
  segment.recipe.beats.splice(index, 1)
  dirty.value = true
}
function addBeat(): void {
  const label = newBeatLabel.value.trim()
  if (!label) return
  segment.recipe.beats.push({ id: `custom-${Date.now()}`, label, enabled: true })
  newBeatLabel.value = ''
  dirty.value = true
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
    }
    openingProfile.value = data.opening_profile
    if (data.word_target_min) wordTargetMin.value = data.word_target_min
    if (data.word_target_max) wordTargetMax.value = data.word_target_max
  } catch (cause: any) {
    showError(cause?.data?.detail || 'Could not read this channel\'s Introduction settings')
  } finally {
    loading.value = false
    dirty.value = false
  }
}

async function save(): Promise<void> {
  saving.value = true
  try {
    const data = await put<{ segments: Record<string, Segment> }>(
      `/projects/${slug.value}/segments/introduction`,
      { enabled: segment.enabled, recipe: segment.recipe },
    )
    const saved = data.segments?.introduction
    if (saved) {
      segment.enabled = saved.enabled
      segment.recipe = saved.recipe
      segment.inferred_at = saved.inferred_at
    }
    dirty.value = false
    success(segment.enabled
      ? 'Saved. Every episode this channel writes will now open with an Introduction.'
      : 'Saved. Episodes will begin at chapter one.')
  } catch (cause: any) {
    showError(cause?.data?.detail || 'Could not save the Introduction settings')
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
async function generateForEpisode(): Promise<void> {
  if (!episodeId.value) return
  generating.value = true
  try {
    await post(`/projects/${slug.value}/generate/introduction-only`, { episode_id: episodeId.value })
    success('Queued. Watch it in Jobs.')
    previewRefreshKey.value += 1
  } catch (cause: any) {
    showError(cause?.data?.detail
      || 'Could not queue the opening. The episode\'s chapters have to exist first.')
  } finally {
    generating.value = false
  }
}

watch(segment, () => { if (!loading.value) dirty.value = true }, { deep: true })
onMounted(load)
</script>

<style scoped>
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
.recipe-fields { display: grid; grid-template-columns: repeat(2, minmax(14rem, 1fr)); gap: .8rem; margin-bottom: 1.5rem; }
.recipe-field { display: grid; align-content: start; gap: .4rem; min-width: 0; }
.recipe-field-wide { grid-column: 1 / -1; }
.field-label { color: var(--text-primary); font-size: .85rem; font-weight: 700; }
.field-help { color: var(--text-muted); font-size: .78rem; line-height: 1.4; }

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
.beat-detail { padding-top: .5rem; }
.beat-textarea { width: 100%; min-height: 4rem; }
.beat-add-row { display: flex; gap: .5rem; margin-top: .9rem; }
.beat-add-row .input { flex: 1; }

@media (max-width: 1100px) {
  .intro-command,
  .recipe-fields { grid-template-columns: 1fr; }
  .recipe-heading { flex-direction: column; }
}
</style>
