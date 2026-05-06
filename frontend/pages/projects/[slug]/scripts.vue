<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Script Generator</h1>
    </div>
    <TopActionBar
      :project-slug="slug"
      :presets="scriptPresets"
      v-model:episode-id="form.episode_id"
      filter-field="script"
      generate-label="Generate Script (Chapters)"
      loading-label="Queuing…"
      :generate-loading="submitting"
      :generate-disabled="!canSubmit"
      :generate-status="generateAllStatusText || (scriptGenerating ? `Generating script for ${form.episode_id}…` : '')"
      @generate="submitScript"
      @episode-selected="onEpisodeSelected"
      @preset-applied="success('Preset applied')"
      @preset-saved="success('Preset saved')"
      @preset-deleted="success('Preset deleted')"
    >
      <!-- Two-stage chained run; gated so intro is skipped if script fails.
           Lives next to the Script-only CTA so users can pick "just script"
           vs "everything" without leaving the action bar. -->
      <template #actions>
        <button
          class="btn btn-primary"
          :disabled="!canSubmit || submitting || generateAllStep === 'script' || generateAllStep === 'intro'"
          :title="!form.episode_id ? 'Pick an episode first' : 'Generate Script, then Introduction. Intro is skipped if Script fails.'"
          @click="generateAll"
        >
          <LoadingSpinner v-if="generateAllStep === 'script' || generateAllStep === 'intro'" size="sm" />
          {{ generateAllStep === 'script' ? 'Step 1/2: Script…'
             : generateAllStep === 'intro' ? 'Step 2/2: Introduction…'
             : '⚡ Generate All (Script + Intro)' }}
        </button>
      </template>
    </TopActionBar>

    <p class="text-muted mt-1 mb-2">
      Generate narration scripts for your episodes. Script (chapters) and introduction are generated separately — use
      <strong>⚡ Generate All</strong> to run them back-to-back; if the script fails, the intro is automatically skipped.
    </p>

    <div class="card mt-3">
      <div class="form-group field-medium">
        <label>Episode Title</label>
        <input v-model="form.title" class="input" placeholder="The Whispering Forest" />
      </div>

      <!-- Pattern picker (Phase 4b) — optional per-episode template that
           composes on top of the project's format. Empty = format defaults. -->
      <div class="form-group mt-2 field-wide">
        <PatternPicker
          v-model="form.pattern_id"
          v-model:subject="form.pattern_subject"
          :format-id="projectFormatId"
        />
      </div>

      <!-- Character picker (Phase 5) — optional cast. The LLM uses these
           names + descriptions instead of inventing characters. Multi-select. -->
      <div v-if="form.episode_id" class="form-group mt-2 field-wide">
        <CharacterPicker
          v-model="form.character_ids"
          :project-slug="slug"
          :episode-code="form.episode_id"
        />
      </div>

      <!-- Legacy-narration normaliser entry point. Sits below the cast
           picker because it's a cousin of the script-generation flow:
           "I have a script already, just need it in our format." Hides
           when no episode is selected (the route needs a code). -->
      <div v-if="form.episode_id" class="form-group mt-2 field-wide">
        <button
          class="btn btn-sm btn-secondary"
          title="Restructure a pre-Story-Studio narration docx into the canonical per-chapter format. Idempotent — already-canonical files are skipped."
          @click="normalizeOpen = true"
        >🛠 Normalize legacy narration…</button>
        <p class="text-muted text-xs hint-line">
          Got a script from before Story Studio (or hand-written prose)?
          Normalize it once and the rest of the pipeline (audio, subtitles,
          assembly) will read it correctly.
        </p>
      </div>
      <NormalizeNarrationDialog
        v-if="normalizeOpen && form.episode_id"
        :visible="normalizeOpen"
        :slug="slug"
        :episode-code="form.episode_id"
        @close="normalizeOpen = false"
        @normalized="onNarrationNormalized"
      />

      <!-- Introduction (on top, toggleable) -->
      <div class="intro-section mt-2">
        <div class="intro-header">
          <label class="toggle-label">
            <input type="checkbox" v-model="intro.enabled" />
            <h3>Introduction</h3>
          </label>
          <span v-if="intro.enabled" class="text-muted text-sm">~{{ intro.word_target }} words</span>
        </div>
        <div v-if="intro.enabled" class="intro-body">
          <!-- Intro-specific preset picker (separate pool from script presets) -->
          <PresetPicker
            label="Introduction Preset"
            hint="Snapshots just host name, word target, opening line, and beat list — not the chapter settings."
            :presets="introPresets.presets.value"
            :active-id="introPresets.activeId.value"
            @update:active-id="introPresets.setActive"
            @apply="onApplyIntroPreset"
            @overwrite="onOverwriteIntroPreset"
            @save-as="onSaveAsIntroPreset"
            @delete="onDeleteIntroPreset"
          />
          <div class="grid-2">
            <div class="form-group">
              <label>Host / Narrator Name</label>
              <input v-model="intro.host_name" class="input" placeholder="e.g. Vincent, Luna, your own name…" />
              <span class="text-muted text-xs">Leave blank to let the AI skip the host name.</span>
            </div>
            <div class="form-group">
              <label>Intro Word Target</label>
              <input v-model.number="intro.word_target" class="input" type="number" min="100" max="600" />
            </div>
          </div>
          <div class="form-group">
            <label>Custom Opening Line (optional)</label>
            <input v-model="intro.custom_opening" class="input" placeholder="Hello, and welcome back..." />
          </div>
          <label class="section-helper-label">
            Reorder, toggle each on/off, and click ▸ to add specific wording for any beat. Disabled beats are skipped entirely, not summarised.
          </label>
          <div class="intro-beats">
            <div v-for="(beat, i) in introBeats" :key="beat.id" class="beat-card">
              <div class="beat-row">
                <div class="beat-controls">
                  <button class="btn-icon" @click="moveBeat(i, -1)" :disabled="i === 0" title="Move up">▲</button>
                  <button class="btn-icon" @click="moveBeat(i, 1)" :disabled="i === introBeats.length - 1" title="Move down">▼</button>
                </div>
                <label class="toggle-label beat-label">
                  <input type="checkbox" v-model="beat.enabled" />
                  <span>{{ beat.label }}</span>
                </label>
                <button
                  class="btn-icon"
                  :class="{ 'has-custom': !!beat.customText?.trim() }"
                  :title="beat.customText?.trim() ? 'Custom wording set — click to edit' : 'Add specific wording for this beat'"
                  @click="beat.expanded = !beat.expanded"
                >
                  {{ beat.expanded ? '▾' : '▸' }}
                </button>
                <button class="btn-icon danger" v-if="beat.custom" @click="introBeats.splice(i, 1)" title="Remove">✕</button>
              </div>
              <div v-if="beat.expanded" class="beat-detail">
                <textarea
                  v-model="beat.customText"
                  class="textarea beat-textarea"
                  :placeholder="`Optional — specific wording or points you want this beat to cover. Example for '${beat.label}': ${beatPlaceholder(beat.id)}`"
                />
                <p class="text-muted text-xs hint-line">
                  Leave blank to let the AI write from the beat label only. Filled-in text is passed to the LLM as "specifically cover: {your text}".
                </p>
              </div>
            </div>
          </div>

          <!-- Inline add-section row (replaces the broken window.prompt call). -->
          <div class="beat-add-row mt-1">
            <input
              v-model="newBeatLabel"
              class="input input-sm"
              placeholder="Custom section name (e.g. 'Sponsor mention', 'Weekly riddle')"
              @keydown.enter.prevent="addCustomBeat"
            />
            <button class="btn btn-sm btn-secondary" :disabled="!newBeatLabel.trim()" @click="addCustomBeat">
              + Add Custom Section
            </button>
          </div>
          <button
            class="btn btn-sm btn-primary mt-3"
            :disabled="!scriptGenerated || submitting"
            @click="() => submitIntroduction()"
            :title="!scriptGenerated ? 'Generate the script first to enable introduction generation' : ''"
          >
            <LoadingSpinner v-if="submitting" size="sm" />
            Generate Introduction
          </button>
          <div v-if="intro.enabled && !scriptGenerated" class="intro-needs-script mt-2">
            ⓘ Generate the script first before creating the introduction. The introduction uses the chapter content as context.
          </div>
        </div>
      </div>

      <!-- Main settings -->
      <div class="grid-3 mt-2">
        <div class="form-group">
          <label>Duration</label>
          <select v-model="durationSelect" class="select" @change="onDurationChange">
            <option value="15">15 minutes</option>
            <option value="20">20 minutes</option>
            <option value="30">30 minutes</option>
            <option value="45">45 minutes</option>
            <option value="60">60 minutes</option>
            <option value="90">90 minutes</option>
            <option value="custom">Custom...</option>
          </select>
          <input v-if="durationSelect === 'custom'" v-model.number="form.length" type="number" min="5" max="180"
            class="input mt-1" placeholder="Minutes" />
        </div>
        <ModelSelector v-model="form.model" :project-slug="slug" />
        <div class="form-group">
          <label>Narrator Style</label>
          <select v-model="form.style" class="select">
            <optgroup label="Presets">
              <option value="auto">Auto-rotate</option>
              <option value="A">A — Warm & intimate first-person</option>
              <option value="B">B — Gentle third-person observer</option>
              <option value="C">C — Classic storyteller</option>
              <option value="D">D — Poetic & lyrical</option>
              <option value="E">E — Whimsical & playful</option>
              <option value="F">F — Mysterious & atmospheric</option>
              <option value="G">G — Grandparent bedtime voice</option>
              <option value="H">H — Nature documentary calm</option>
              <option value="I">I — Meditative & mindful</option>
              <option value="J">J — Fairy tale narrator</option>
            </optgroup>
            <optgroup label="Custom" v-if="customStyles.length">
              <option v-for="cs in customStyles" :key="cs.id" :value="cs.id">{{ cs.name }}</option>
            </optgroup>
            <option value="custom">+ Write custom style...</option>
          </select>
          <div v-if="form.style === 'custom' || showStyleDesc" class="mt-1">
            <div class="flex justify-between items-center mb-1" v-if="form.style !== 'custom'">
              <label class="style-desc-label">Style description</label>
              <button class="btn-icon style-desc-toggle" @click="showStyleDesc = false">Hide</button>
            </div>
            <textarea v-model="customStyleText" class="textarea style-textarea"
              placeholder="Describe the narrator's tone, perspective, and personality..." />
            <div class="flex gap-2 mt-1" v-if="form.style === 'custom'">
              <button class="btn btn-sm btn-secondary" @click="saveCustomStyle">Save as preset</button>
            </div>
          </div>
          <button v-if="form.style !== 'custom' && form.style !== 'auto' && !showStyleDesc" class="btn-icon style-desc-toggle style-desc-show" @click="showStyleDesc = true">
            View / edit description
          </button>
        </div>
      </div>

      <!-- Word count section — edit any field; others recalc from your primary input -->
      <div class="word-count-section">
        <p class="text-muted text-sm mb-1">
          Edit any field below — the others auto-update. The field you last edited drives the calculation.
        </p>
        <div class="grid-4">
          <div class="form-group" :class="{ 'is-primary': primaryField === 'chapters' }">
            <label>
              Chapters
              <span v-if="primaryField === 'chapters'" class="primary-badge">primary</span>
            </label>
            <input v-model.number="form.chapters" class="input" type="number" min="1" max="30" @input="onChaptersChange" />
          </div>
          <div class="form-group" :class="{ 'is-primary': primaryField === 'words_per_chapter' }">
            <label>
              Words/Chapter
              <span v-if="primaryField === 'words_per_chapter'" class="primary-badge">primary</span>
            </label>
            <input v-model.number="form.words_per_chapter" class="input" type="number" min="100" @input="onWordsPerChapterChange" />
          </div>
          <div class="form-group" :class="{ 'is-primary': primaryField === 'total_words' }">
            <label>
              Story Body Words
              <span v-if="primaryField === 'total_words'" class="primary-badge">primary</span>
              <span v-else class="calc-badge">excl. intro</span>
            </label>
            <input v-model.number="form.total_words" class="input" type="number" min="500" @input="onTotalWordsChange" />
          </div>
          <div class="form-group">
            <label>Est. Duration <span class="calc-badge">~{{ wordsPerMinute }} w/m</span></label>
            <div class="estimate-box">
              ~{{ estimatedDuration }} min
            </div>
          </div>
        </div>
        <div class="word-summary">
          <strong>{{ form.chapters }}</strong> chapters
          × <strong>{{ form.words_per_chapter.toLocaleString() }}</strong> words/chapter
          = <strong>{{ form.total_words.toLocaleString() }}</strong> story body
          <template v-if="intro.enabled"> + <strong>~{{ intro.word_target }}</strong> intro</template>
          = <strong class="text-accent">~{{ totalOutput.toLocaleString() }} total (~{{ estimatedTotalDuration }} min)</strong>
        </div>

        <!-- v1.0.70: title vs chapter-count consistency check. Many of
             our formats encode the count in the title ("10 mysteries
             explained"). When the user has changed `chapters` to a
             value that no longer matches the title's leading number,
             show an inline warning with a one-click sync button so the
             on-disk script doesn't ship with a misleading title. -->
        <div v-if="titleCountMismatch" class="title-mismatch-chip">
          <span>
            Your title says <strong>{{ titleCountMismatch.titleNumber }}</strong>
            but you've configured <strong>{{ form.chapters }}</strong> chapters.
            Generating now would produce a script that doesn't match the title.
          </span>
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            @click="syncTitleToChapters"
            :title="`Rewrite the title to use ${form.chapters} instead of ${titleCountMismatch.titleNumber}`"
          >
            Sync title to {{ form.chapters }}
          </button>
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            @click="form.chapters = titleCountMismatch.titleNumber"
            :title="`Use ${titleCountMismatch.titleNumber} chapters to match the title`"
          >
            Use {{ titleCountMismatch.titleNumber }} chapters
          </button>
        </div>

      </div>

      <div class="flex items-center gap-2 mt-2 flex-wrap">
        <label class="checkbox-label">
          <input type="checkbox" v-model="form.force" />
          Force regenerate (overwrite existing)
        </label>
        <span class="text-muted text-xs">
          Per-chapter regeneration is below — fix one chapter without redoing the rest.
        </span>
      </div>
    </div>

    <!-- Per-chapter source files panel (per-chapter refactor). One row per
         chapter with its own Regenerate button. The unified narration
         downstream consumers read is auto-assembled after every regen. -->
    <ChapterListPanel
      v-if="form.episode_id"
      :project-slug="slug"
      :episode-id="form.episode_id"
      :title="form.title"
      :script-ready="scriptGenerated"
      :form="form"
      :refresh-key="previewRefreshKey"
    />

    <!-- Preview panels: refresh after each generation completes via previewRefreshKey -->
    <ScriptPreview
      v-if="form.episode_id"
      :project-slug="slug"
      :episode-id="form.episode_id"
      :title="form.title"
      :refresh-key="previewRefreshKey"
    />
    <IntroductionPreview
      v-if="form.episode_id"
      :project-slug="slug"
      :episode-id="form.episode_id"
      :title="form.title"
      :refresh-key="previewRefreshKey"
    />

    <!-- Save custom style preset modal (replaces blocked window.prompt) -->
    <div v-if="showSaveStyle" class="modal-overlay" @click.self="showSaveStyle = false">
      <div class="modal-small">
        <h3>Save style preset</h3>
        <p class="text-muted text-sm mt-1 mb-2">Give this narrator style a name so you can reuse it.</p>
        <input
          v-model="newStyleName"
          class="input"
          placeholder="e.g. Cozy Grandma, Dark Noir"
          @keydown.enter="confirmSaveCustomStyle"
          @keydown.escape="showSaveStyle = false"
        />
        <div class="flex gap-2 mt-2 justify-end">
          <button class="btn btn-secondary" @click="showSaveStyle = false">Cancel</button>
          <button class="btn btn-primary" :disabled="!newStyleName.trim()" @click="confirmSaveCustomStyle">Save</button>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useAppTitle('Script Generator')
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { post, patch } = useApi()
const { success, error: showError } = useToast()
// v1.0.71: chunked-mode cost preview before submission. Mirrors the
// CHUNK_THRESHOLD_WORDS constant in electron/server/lib/chunked-narration.ts —
// keep in sync. Below this, the single-call path is used (no preview).
const CHUNK_THRESHOLD_WORDS = 10000
const { ask } = useConfirm()
const { scriptGenerating } = useGenerating()
const { confirmGeneration } = useConfirmation()
const submitting = ref(false)
const previewRefreshKey = ref(0)
// Tracks the full episode object selected via EpisodeSelector — needed so
// `scriptGenerated` can read from `episode.status.script` (the API-provided
// source of truth) instead of a local mutable ref.
const selectedEpisode = ref<any>(null)
// Source of truth: the episode-listing endpoint stamps `status.script: true`
// once the narration .docx is on disk. Using a computed off that means the
// flag is automatically correct after a refetch — no manual flips, no drift
// from preview-emitted side effects.
const scriptGenerated = computed(() => !!selectedEpisode.value?.status?.script)

const wordsPerMinute = 122
const durationSelect = ref('45')
const showStyleDesc = ref(false)
const customStyleText = ref('')
const customStyles = ref<Array<{ id: string; name: string; description: string }>>([])

const STYLE_DESCRIPTIONS: Record<string, string> = {
  A: 'Warm and intimate. First-person narrator, very close to the character\'s inner world. Feels like a whispered confidence.',
  B: 'Gentle third-person observer. Lyrical, slightly poetic, like watching from a warm window.',
  C: 'Classic quiet storyteller. Traditional "once there was" tone, timeless and cosy, like a fireside tale.',
  D: 'Poetic and lyrical. Rich metaphors, flowing sentences, language that sounds like music. Every paragraph is art.',
  E: 'Whimsical and playful. Light-hearted, a little cheeky, with gentle humour. Perfect for younger audiences or lighthearted tales.',
  F: 'Mysterious and atmospheric. Fog-shrouded prose, building intrigue slowly. The world feels ancient and full of secrets.',
  G: 'Grandparent bedtime voice. Warm, unhurried, with the cadence of someone who has told a thousand stories and loves every one.',
  H: 'Nature documentary calm. David Attenborough-style observation. Patient, reverent, finding wonder in small details.',
  I: 'Meditative and mindful. Present-tense awareness, grounding the listener in each sensory moment. Breath-paced prose.',
  J: 'Fairy tale narrator. Storybook formality with a wink. "Once upon a time" energy, clear moral arcs, satisfying endings.',
}

const showSaveStyle = ref(false)
const newStyleName = ref('')

function saveCustomStyle() {
  if (!customStyleText.value) {
    showError('Write a style description before saving.')
    return
  }
  newStyleName.value = ''
  showSaveStyle.value = true
}

function confirmSaveCustomStyle() {
  const name = newStyleName.value.trim()
  if (!name || !customStyleText.value) return
  const id = `style-${Date.now()}`
  customStyles.value.push({ id, name, description: customStyleText.value })
  form.style = id
  showSaveStyle.value = false
}

const form = reactive({
  episode_id: route.query.episode_id as string || '',
  title: route.query.title as string || '',
  length: Number(route.query.length) || 45,
  model: 'gpt-4o',
  style: 'auto',
  chapters: Number(route.query.chapters) || 10,
  total_words: 5500,
  words_per_chapter: 550,
  generate_image_prompts: false,
  generate_youtube_desc: false,
  force: false,
  // Pattern primitive (Phase 4b): empty pattern_id = no pattern (current
  // behavior). When set, the script generator fuses the named pattern on
  // top of the project's effective format, substituting {X} with subject.
  pattern_id: '',
  pattern_subject: '',
  // Character primitive (Phase 5): optional cast — selected ids flow through
  // /generate/script-only so the LLM uses these names + descriptions.
  character_ids: [] as string[],
})

// Look up the project's current format id so PatternPicker can show
// "pairs with this format" badges. Loads once on mount + when slug changes;
// project-meta arrival triggers the watcher that hydrates formatId.
const projectFormatId = ref('sleep-story')
const { project } = useProject()
watch(project, (p) => {
  if (p) projectFormatId.value = (p as any).format_id || 'sleep-story'
}, { immediate: true })

// Sync style description when style changes (must be after form definition)
watch(() => form.style, (s) => {
  const desc = STYLE_DESCRIPTIONS[s]
  if (desc !== undefined) {
    customStyleText.value = desc
    showStyleDesc.value = false
  } else if (s === 'custom') {
    customStyleText.value = ''
    showStyleDesc.value = true
  } else {
    const cs = customStyles.value.find(c => c.id === s)
    if (cs) customStyleText.value = cs.description
  }
})

const intro = reactive({
  enabled: true,
  host_name: '',
  word_target: 350,
  custom_opening: '',
})

// ── Presets ─────────────────────────────────────────────────────────────
// Two typed pools sharing the 'script' configKey:
//   - scriptPresets  → just chapter settings (form + custom style text)
//   - introPresets   → just intro settings (intro + beats)
// Legacy presets saved before typing are untyped and appear in both pickers
// as 'all'. Applying one still restores both halves because apply() reads
// whichever fields are present in `data`.
const scriptPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'script',
  presetType: 'script',
  snapshot: () => ({
    form: { ...form },
    customStyleText: customStyleText.value,
  }),
  apply: (data) => {
    if (data.form) Object.assign(form, data.form)
    if (data.intro) Object.assign(intro, data.intro)
    if (typeof data.customStyleText === 'string') customStyleText.value = data.customStyleText
  },
})

/**
 * v1.0.71+: format-aware seeding of intro defaults BEFORE preset.load().
 * Sleep-story projects keep the 350-word, multi-beat shape (welcome /
 * teaser / community / CTA / breathing / transition). Listicle /
 * explainer projects get a short host-personality intro by default
 * (~50 words, no breathing exercise). Saved presets still override
 * because preset.load() runs after this — only fresh projects with
 * no intro preset see the new defaults.
 */
async function applyIntroFormatDefaultsIfNoPreset() {
  try {
    const f = await get<any>(`/projects/${slug.value}/effective-format`)
    const ip = f?.script?.introDefaults
    if (!ip) return
    if (typeof ip.wordTarget === 'number' && ip.wordTarget > 0) {
      intro.word_target = ip.wordTarget
    }
    if (Array.isArray(ip.beats) && ip.beats.length) {
      // Replace the default beat list with the format's. Each format-supplied
      // beat becomes an editable IntroBeat row (custom: false so it can be
      // disabled but not deleted, mirroring the legacy hardcoded beats'
      // semantics).
      introBeats.value = (ip.beats as string[]).map((label, i) => ({
        id: `fmt-${i}`,
        label,
        enabled: true,
      }))
    }
  } catch {
    // Format endpoint unavailable / project missing — keep the legacy
    // hardcoded defaults. Non-fatal.
  }
}

/**
 * v1.0.72+: format-aware seeding of chapter count + length + word-count
 * derivations. Replaces the deleted "Quick Presets" reference-table that
 * pinned hardcoded sleep-story numbers (45min/10ch/5500w). Each format
 * now drives its own defaults via script.defaultChapterCount +
 * script.defaultLengthMinutes; words_per_chapter is derived at the
 * project's wpm rate.
 *
 * URL query params (?length=, ?chapters=) still win — they come from
 * "Generate this episode" deep-links elsewhere in the app and represent
 * an explicit caller intent. Saved presets win over both because
 * preset.load() runs AFTER this function.
 */
async function applyScriptFormatDefaultsIfNoPreset() {
  // Skip if URL pinned both — caller intent dominates the format default.
  const urlLength = route.query.length
  const urlChapters = route.query.chapters
  const lengthFromUrl = urlLength !== undefined && urlLength !== null && urlLength !== ''
  const chaptersFromUrl = urlChapters !== undefined && urlChapters !== null && urlChapters !== ''
  try {
    const f = await get<any>(`/projects/${slug.value}/effective-format`)
    const sf = f?.script
    if (!sf) return
    if (!chaptersFromUrl && typeof sf.defaultChapterCount === 'number' && sf.defaultChapterCount > 0) {
      form.chapters = sf.defaultChapterCount
    }
    if (!lengthFromUrl && typeof sf.defaultLengthMinutes === 'number' && sf.defaultLengthMinutes > 0) {
      form.length = sf.defaultLengthMinutes
    }
    // Derive total + per-chapter from the (possibly-updated) length and
    // chapter count. Always recompute these — they're cached values whose
    // canonical inputs just changed.
    if (form.chapters > 0 && form.length > 0) {
      form.total_words = Math.round(form.length * wordsPerMinute)
      form.words_per_chapter = Math.round(form.total_words / form.chapters)
    }
    // Snap the duration dropdown back to a known option so the UI doesn't
    // flash 'custom' when the format default happens to match a standard
    // value (15/20/30/45/60/90).
    durationSelect.value = STANDARD_DURATIONS.has(form.length) ? String(form.length) : 'custom'
  } catch {
    // Format endpoint unavailable / project missing — keep the form's
    // hardcoded defaults. Non-fatal.
  }
}

onMounted(async () => {
  await applyIntroFormatDefaultsIfNoPreset()
  await applyScriptFormatDefaultsIfNoPreset()
  await scriptPresets.load()
})

interface IntroBeat {
  id: string
  label: string
  enabled: boolean
  custom?: boolean
  /** Per-beat free-form direction for the LLM — threaded into the prompt */
  /** as "specifically cover: {customText}". Blank = let the AI write from */
  /** the label only (previous behaviour). */
  customText?: string
  /** Transient UI flag — does NOT persist across reloads. */
  expanded?: boolean
}

const introBeats = ref<IntroBeat[]>([
  { id: 'welcome', label: 'Welcome & host intro', enabled: true },
  { id: 'story_teaser', label: 'Story teaser', enabled: true },
  { id: 'community_question', label: 'Community question', enabled: true },
  { id: 'patreon', label: 'Patreon / membership mention', enabled: false },
  { id: 'subscribe_cta', label: 'Subscribe CTA', enabled: true },
  { id: 'relaxation', label: 'Relaxation / breathing exercise', enabled: true },
  { id: 'transition', label: 'Transition into story', enabled: true },
])

// Suggestive placeholders per known beat id — help users understand what
// kind of detail is useful to supply.
const BEAT_PLACEHOLDERS: Record<string, string> = {
  welcome: 'greet the audience and introduce yourself as Luna',
  story_teaser: "hint at tonight's setting (a misty forest) without spoiling the ending",
  community_question: 'ask listeners to share their favourite winter comfort food',
  patreon: 'mention the $5 tier gets a monthly bonus episode',
  subscribe_cta: 'invite viewers to subscribe and ring the bell icon',
  relaxation: 'lead a 3-breath relaxation with a 4-count inhale / 7-count hold / 8-count exhale',
  transition: 'transition by dimming the lights and inviting them to close their eyes',
}
function beatPlaceholder(id: string): string {
  return BEAT_PLACEHOLDERS[id] || 'specific points, phrasing, or tone you want for this beat'
}

const newBeatLabel = ref('')

const introPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'script',
  presetType: 'introduction',
  snapshot: () => ({
    intro: { ...intro },
    introBeats: introBeats.value.map(b => ({ ...b })),
  }),
  apply: (data) => {
    if (data.intro) Object.assign(intro, data.intro)
    if (Array.isArray(data.introBeats)) introBeats.value = data.introBeats
  },
})
onMounted(() => introPresets.load())

// Custom narrator styles live on the project (not on any preset) — they're
// a user-defined pool the Style dropdown picks from. Presets are the source
// of truth for every other form/intro/beats field, so those are NOT
// persisted here: prior behaviour used a parallel `script_settings` key
// whose autosave ran after preset load on mount, silently clobbering
// preset-applied values on beta-tester machines.
const { get, put } = useApi()
let saveStylesTimeout: ReturnType<typeof setTimeout> | null = null

async function loadCustomStyles() {
  try {
    const config = await get<any>(`/projects/${slug.value}/settings/config`)
    const list = config.script_custom_styles ?? config.script_settings?.custom_styles
    if (Array.isArray(list)) customStyles.value = list
  } catch {}
}

function autoSaveCustomStyles() {
  if (saveStylesTimeout) clearTimeout(saveStylesTimeout)
  saveStylesTimeout = setTimeout(async () => {
    try {
      await put(`/projects/${slug.value}/settings/config`, {
        script_custom_styles: customStyles.value,
      })
    } catch {}
  }, 1000)
}

watch(customStyles, autoSaveCustomStyles, { deep: true })

onMounted(loadCustomStyles)

// Refresh preview panels when a script-only or introduction-only job for
// the active episode finishes. The job stream from useJobs() is reactive,
// so we just watch for transitions to 'done'. Tracking seen job_ids
// prevents re-triggering on every render.
const { jobs } = useJobs()
const seenDoneJobs = new Set<string>()
watch(jobs, (list) => {
  for (const job of list) {
    if (job.status !== 'done' || seenDoneJobs.has(job.job_id)) continue
    if (job.type !== 'script-only' && job.type !== 'introduction-only') continue
    seenDoneJobs.add(job.job_id)
    if (job.episode_id === form.episode_id) {
      previewRefreshKey.value++
      // Refresh `selectedEpisode.status.*` from the API — that's what
      // `scriptGenerated` reads from, so without this the button stays
      // disabled even after the script-only job finishes on disk.
      refetchEpisodeStatus()
    }
  }
}, { deep: true })

// v1.0.48 — read from the shared `useEpisodes` cache instead of
// re-fetching `/projects/:slug/episodes` on every swap. On TerraNash
// (380+ episodes) the full-list fetch took 30s+, blocking the page
// from showing fresh data on every dropdown change. The cache is
// already warm from the EpisodeSelector mount, so a swap is now an
// O(N) array find — instant. Auto-revalidates on `done` job events
// inside the composable, so freshness after generations is handled
// without an explicit refetch here.
const { episodes: cachedEpisodeList, refresh: refreshEpisodeCache } = useEpisodes(slug)

async function refetchEpisodeStatus() {
  if (!form.episode_id) return
  // 1. Fast path: the shared cache already has every episode.
  const cached = cachedEpisodeList.value.find((e: any) => e.episode_code === form.episode_id)
  if (cached) {
    selectedEpisode.value = cached
    return
  }
  // 2. Cold cache (deep-link, fresh tab) → trigger a refresh through
  //    the composable. Returns when the cache fills; downstream reads
  //    pick up the value reactively.
  try {
    await refreshEpisodeCache()
    const fresh = cachedEpisodeList.value.find((e: any) => e.episode_code === form.episode_id)
    if (fresh) selectedEpisode.value = fresh
  } catch { /* keep stale episode rather than blanking the UI */ }
}

// Fetch on initial mount + any time the episode id changes (deep-link from
// the dashboard, preset apply, etc.). EpisodeSelector only emits its own
// event when the user picks from the dropdown, so without this, deep-links
// would leave selectedEpisode null and `scriptGenerated` stuck at false.
watch(() => form.episode_id, (id) => { if (id) refetchEpisodeStatus() }, { immediate: true })

// v1.0.48 — keep `selectedEpisode` in sync when the shared cache
// auto-revalidates (which happens whenever a generation job finishes
// via the SSE-driven `useJobs` watcher inside the composable). Without
// this, a freshly-completed `script-only` job updates the cache but
// `selectedEpisode.status.script` would stay false until the user
// re-clicked the dropdown.
watch(cachedEpisodeList, (list) => {
  if (!form.episode_id || !list?.length) return
  const fresh = list.find((e: any) => e.episode_code === form.episode_id)
  if (fresh) selectedEpisode.value = fresh
}, { deep: true })

// ── Legacy narration normaliser (Part 3 of mark-done plan) ────────────────
// Modal-only state; the dialog component handles the route call + result
// rendering. We refresh the episode status on success so the script /
// introduction badges flip without a manual reload.
const normalizeOpen = ref(false)
function onNarrationNormalized(_result: any) {
  refetchEpisodeStatus().catch(() => {})
}

function moveBeat(index: number, direction: number) {
  const newIndex = index + direction
  if (newIndex < 0 || newIndex >= introBeats.value.length) return
  const arr = introBeats.value
  const a = arr[index]
  const b = arr[newIndex]
  if (!a || !b) return
  arr[index] = b
  arr[newIndex] = a
}

function addCustomBeat() {
  // Previously used window.prompt() which is blocked in Electron renderers
  // (hence the "doesn't work" test feedback). Inline input + Enter is the
  // clean fix.
  const label = newBeatLabel.value.trim()
  if (!label) return
  introBeats.value.push({ id: `custom-${Date.now()}`, label, enabled: true, custom: true, expanded: true })
  newBeatLabel.value = ''
}

const totalOutput = computed(() =>
  form.total_words + (intro.enabled ? intro.word_target : 0)
)
const estimatedDuration = computed(() =>
  Math.round(form.total_words / wordsPerMinute)
)
const estimatedTotalDuration = computed(() =>
  Math.round(totalOutput.value / wordsPerMinute)
)
const canSubmit = computed(() => form.episode_id && form.title)

// Standard duration values shown in the Duration dropdown. Used only to
// decide whether the current form.length matches a dropdown option (vs
// 'custom'). The old `durationRefs` table also pinned a hardcoded chapter
// count + word count per duration — those were sleep-story-flavoured
// (45min → 10 chapters → 5500 words) and have been removed in favour of
// format-driven defaults seeded once in applyScriptFormatDefaultsIfNoPreset.
// Per-episode overrides flow through the editable inputs below.
const STANDARD_DURATIONS = new Set([15, 20, 30, 45, 60, 90])

// Sync: Duration dropdown → total words (format-aware chapter count stays).
// Words/chapter recomputes from the new total ÷ existing chapters so a
// user changing duration doesn't accidentally reset the chapter count
// they (or the format default / preset) chose.
function onDurationChange() {
  if (durationSelect.value !== 'custom') {
    form.length = Number(durationSelect.value)
    form.total_words = Math.round(form.length * wordsPerMinute)
    if (form.chapters > 0) {
      form.words_per_chapter = Math.round(form.total_words / form.chapters)
    }
  }
}

// Track which word-count field was last edited, so we can visually highlight
// it as "primary" and make the sync rules obvious.
const primaryField = ref<'chapters' | 'words_per_chapter' | 'total_words'>('total_words')

// Sync: Chapters changed → recalc words/chapter (total stays)
function onChaptersChange() {
  primaryField.value = 'chapters'
  if (form.chapters > 0) {
    form.words_per_chapter = Math.round(form.total_words / form.chapters)
  }
}

// Sync: Words/chapter changed → recalc total words
function onWordsPerChapterChange() {
  primaryField.value = 'words_per_chapter'
  form.total_words = form.chapters * form.words_per_chapter
  form.length = Math.round(form.total_words / wordsPerMinute)
  durationSelect.value = STANDARD_DURATIONS.has(form.length) ? String(form.length) : 'custom'
}

// Sync: Total words changed → recalc words/chapter + duration
function onTotalWordsChange() {
  primaryField.value = 'total_words'
  if (form.chapters > 0) {
    form.words_per_chapter = Math.round(form.total_words / form.chapters)
  }
  form.length = Math.round(form.total_words / wordsPerMinute)
  durationSelect.value = STANDARD_DURATIONS.has(form.length) ? String(form.length) : 'custom'
}

/**
 * Rough cost estimate for chunked-mode script generation (v1.0.71+).
 *
 * Used for the pre-submission confirmation dialog. Numbers are
 * deliberately ROUGH — Anthropic / OpenAI pricing changes, model
 * choice (Sonnet vs Opus vs gpt-4o) shifts the bill, and per-call
 * input/output token counts vary with format and characters. We
 * present a min-max range based on Sonnet rates ($3/Mtok in,
 * $15/Mtok out) since that's the most common script-gen model;
 * users running Opus / Haiku scale linearly from there.
 *
 * Method:
 *   - 1 outline call: ~80 tokens output per chapter (full outline) or
 *     ~40 (compact). Ignored as a small fixed cost (<$0.10).
 *   - N expansion calls: each writes ~3 chapters × words_per_chapter
 *     × 1.3 tokens/word, plus ~3-6k input tokens (system + outline +
 *     transition window).
 *   - Listicle: parallel batches of 8 instead of sequential 3, fewer
 *     calls, but still output-token-dominated.
 */
function estimateChunkedCost(targetWords: number, chapters: number): {
  batches: number; expansionCalls: number; costRange: string
} {
  // Per-batch output tokens (rough). Narrative: 3 chapters per batch.
  // Listicle: 8 chapters per batch. We don't know the format here so
  // we report a band that covers both.
  const totalOutputTokens = Math.ceil(targetWords * 1.3)
  const expansionCallsNarrative = Math.ceil(chapters / 3)
  const expansionCallsListicle = Math.ceil(chapters / 8)
  // Average input tokens per call: ~5k (system prompt + outline +
  // transition window). For listicles, no transition window so closer
  // to ~3k.
  const totalInputTokens =
    expansionCallsNarrative * 5000 + 1500 // outline call adds ~1500 input
  const totalInputTokensListicle =
    expansionCallsListicle * 3000 + 1500
  // Sonnet pricing per Mtok.
  const PRICE_INPUT_PER_MTOK = 3
  const PRICE_OUTPUT_PER_MTOK = 15
  const costNarrative =
    (totalInputTokens / 1_000_000) * PRICE_INPUT_PER_MTOK +
    (totalOutputTokens / 1_000_000) * PRICE_OUTPUT_PER_MTOK
  const costListicle =
    (totalInputTokensListicle / 1_000_000) * PRICE_INPUT_PER_MTOK +
    (totalOutputTokens / 1_000_000) * PRICE_OUTPUT_PER_MTOK
  const lo = Math.min(costNarrative, costListicle)
  const hi = Math.max(costNarrative, costListicle)
  const fmt = (n: number): string => n < 0.1 ? `<$0.10` : `~$${n.toFixed(2)}`
  return {
    batches: 1 + expansionCallsNarrative, // approximate count for the message
    expansionCalls: expansionCallsNarrative,
    costRange: lo.toFixed(2) === hi.toFixed(2) ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`,
  }
}

/**
 * Detect a leading count number in a title string (v1.0.70).
 *
 * Mirrors electron/server/routes/ideas.ts:parseLeadingCount — keep
 * both in sync. Used to surface the title-vs-chapter mismatch warning
 * and to power the "Sync title" button below.
 */
function parseLeadingCount(title: string): { value: number; start: number; end: number } | null {
  if (!title) return null
  const m = title.match(/^(?:(?:the|top)\s+)?(\d+)\b/i)
  if (!m) return null
  const value = parseInt(m[1]!, 10)
  if (!Number.isFinite(value) || value <= 0) return null
  const start = m.index! + m[0].length - m[1]!.length
  return { value, start, end: start + m[1]!.length }
}

const titleCountMismatch = computed<{ titleNumber: number } | null>(() => {
  const m = parseLeadingCount(form.title)
  if (!m) return null
  if (m.value === form.chapters) return null
  if (form.chapters <= 0) return null
  return { titleNumber: m.value }
})

/**
 * Rewrite the title's leading number to match the current `chapters`
 * field. v1.0.70 — paired with titleCountMismatch above. Also POSTs
 * the new title to the idea-update endpoint so the change persists
 * across page reloads (the local form change alone wouldn't update
 * the stored idea).
 */
async function syncTitleToChapters() {
  const m = parseLeadingCount(form.title)
  if (!m) return
  const newTitle = form.title.slice(0, m.start) + String(form.chapters) + form.title.slice(m.end)
  form.title = newTitle
  // Persist back to the idea record so it sticks across reloads. The
  // selectedEpisode object holds the idea id in its episode_code /
  // idea_id field — we use the existing idea-update PATCH endpoint.
  if (selectedEpisode.value?.idea_id || selectedEpisode.value?.episode_code) {
    try {
      const ideaId = selectedEpisode.value.idea_id || selectedEpisode.value.episode_code
      await patch(`/projects/${slug.value}/ideas/${ideaId}`, { title: newTitle })
      // Also update the in-memory selectedEpisode so the next render sees it.
      if (selectedEpisode.value) selectedEpisode.value.title = newTitle
      success(`Title synced to ${form.chapters} chapters`)
    } catch (e: any) {
      // Local form is updated already — the script will use the new
      // title. Only the persisted idea record didn't get the rewrite.
      console.warn('[scripts] failed to persist synced title:', e?.message || e)
      success(`Title updated locally (couldn't persist to idea record)`)
    }
  } else {
    success(`Title synced to ${form.chapters} chapters`)
  }
}

function onEpisodeSelected(ep: any) {
  // Capture the full episode object so `scriptGenerated` (computed off
  // ep.status.script) reflects API truth for this episode immediately.
  selectedEpisode.value = ep
  form.title = ep.title
  form.chapters = ep.suggested_chapters || 10
  const dur = ep.suggested_length === '60 min' ? 60 : 45
  form.length = dur
  durationSelect.value = String(dur)
  onDurationChange()
}

async function submitScript(): Promise<boolean> {
  // Generate script only (chapters, no introduction). Returns true if the
  // job reached 'done' on the queue, false otherwise — generateAll() relies
  // on the boolean to decide whether to proceed to the introduction stage.
  const params = {
    ...form,
    custom_style_text: customStyleText.value,
  }

  // v1.0.71: chunked-mode pre-flight. When the target wordcount exceeds
  // ~10k words, the backend dispatches to outline + per-batch expansion
  // (see lib/chunked-narration.ts). That's MULTIPLE LLM calls and a
  // proportional cost increase — surface a rough estimate before the
  // user kicks off a long expensive run by mistake. Sleep-story-style
  // 12-chapter / 700-word episodes stay under the threshold and skip
  // this dialog entirely.
  const targetWords = (form.chapters || 0) * (form.words_per_chapter || 0)
  if (targetWords > CHUNK_THRESHOLD_WORDS) {
    const estimate = estimateChunkedCost(targetWords, form.chapters || 0)
    const ok = await ask({
      title: 'Long script — chunked mode',
      message:
        `${form.chapters} chapters × ${form.words_per_chapter.toLocaleString()} words ` +
        `(~${targetWords.toLocaleString()} words total) exceeds the single-call threshold.\n\n` +
        `The script will be generated in ${estimate.batches} batches: ` +
        `1 outline call + ${estimate.expansionCalls} expansion call${estimate.expansionCalls === 1 ? '' : 's'}.\n\n` +
        `Estimated cost: ${estimate.costRange} (Sonnet pricing).\n\n` +
        `Each chapter is written to disk as soon as it's generated, so cancel / crash / restart preserves partial work.`,
      confirmLabel: 'Generate',
      cancelLabel: 'Cancel',
    })
    if (!ok) return false
  }

  if (!await confirmGeneration(slug.value, 'script', params)) return false

  submitting.value = true
  scriptGenerating.value = true
  try {
    const job = await post<{ job_id: string }>(`/projects/${slug.value}/generate/script-only`, params)
    success('Script generation queued!')
    // scriptGenerated will flip via the job-done watcher above
    // (refetchEpisodeStatus → episode.status.script → computed). No manual
    // flag flip here — that would diverge from the API source of truth.
    const ok = await waitForJob(job.job_id)
    return ok
  } catch (e: any) {
    // Distinguish "couldn't even queue it" (backend down / validation /
    // missing preset) from "queued but the job itself failed" — those go
    // through the SSE path and surface via the Jobs tab. Console log
    // keeps the raw error reachable when only the toast is shown.
    console.error('[scripts] queue script generation failed:', e)
    const detail = e.data?.detail
    const fallback = e?.status === 0 || e?.message?.includes('fetch')
      ? 'Backend unreachable — restart the app or check the Jobs panel.'
      : 'Failed to queue script generation. Check the form fields above.'
    showError(detail || fallback)
    scriptGenerating.value = false
    return false
  } finally {
    submitting.value = false
  }
}

// Promise-bridge over the SSE job stream: resolves true on 'done', false
// on 'error', and rejects (after a hard timeout) if the job vanishes from
// the queue without a terminal status. Used by generateAll() to gate the
// introduction stage on script success without polling.
function waitForJob(jobId: string, timeoutMs = 10 * 60 * 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const stop = watch(jobs, (list: readonly any[]) => {
      const j = list.find((x: any) => x.job_id === jobId)
      if (!j) return
      if (j.status === 'done') { stop(); resolve(true) }
      else if (j.status === 'error') { stop(); resolve(false) }
    }, { deep: true, immediate: true })
    setTimeout(() => { stop(); resolve(false) }, timeoutMs)
  })
}

// Intro preset picker handlers (kept separate from script preset handlers
// so each section's "Apply / Save / Save as / Delete" only mutates its own
// half of the form).
async function onApplyIntroPreset() {
  introPresets.applyActive()
  success('Introduction preset applied')
}
async function onOverwriteIntroPreset() {
  await introPresets.overwrite()
  success('Introduction preset saved')
}
async function onSaveAsIntroPreset(name: string) {
  await introPresets.saveAs(name)
  success(`Saved introduction preset "${name}"`)
}
async function onDeleteIntroPreset() {
  await introPresets.remove()
  success('Introduction preset deleted')
}

async function submitIntroduction(opts: { confirm?: boolean } = { confirm: true }): Promise<boolean> {
  // Generate introduction only (requires script to exist on disk).
  // `opts.confirm` lets generateAll() skip the confirmation dialog for the
  // intro stage — the user already approved the combined run up front.
  const params = {
    episode_id: form.episode_id,
    title: form.title,
    model: form.model,
    host_name: intro.host_name,
    word_target: intro.word_target,
    custom_opening: intro.custom_opening,
    // Inline per-beat customText into the label so the backend prompt loop
    // doesn't need its own contract change. Format: "Label — specifically
    // cover: <text>". Blank customText falls back to just the label.
    beats: introBeats.value.filter(b => b.enabled).map(b => {
      const t = (b.customText || '').trim()
      return t ? `${b.label} — specifically cover: ${t}` : b.label
    }),
  }
  if (opts.confirm !== false && !await confirmGeneration(slug.value, 'introduction', params)) return false

  submitting.value = true
  try {
    const job = await post<{ job_id: string }>(`/projects/${slug.value}/generate/introduction-only`, params)
    success('Introduction generation queued!')
    return await waitForJob(job.job_id)
  } catch (e: any) {
    console.error('[scripts] queue introduction generation failed:', e)
    const detail = e.data?.detail
    const fallback = e?.status === 0 || e?.message?.includes('fetch')
      ? 'Backend unreachable — restart the app or check the Jobs panel.'
      : 'Failed to queue introduction generation. Make sure the script is generated first.'
    showError(detail || fallback)
    return false
  } finally {
    submitting.value = false
  }
}

// ── Generate All (Script → Introduction) ───────────────────────────────
// Two-stage pipeline with hard failure gating: if the script-only job ends
// in 'error' (or never reaches 'done' inside the timeout), we DO NOT queue
// the intro job. This is the only chained Generate All in the app — every
// other "Generate All" button hits a single atomic endpoint.
const generateAllStep = ref<'idle' | 'script' | 'intro' | 'done' | 'failed'>('idle')
const generateAllStatusText = computed(() =>
  generateAllStep.value === 'script' ? `Generate All — Step 1/2: Script for ${form.episode_id}`
  : generateAllStep.value === 'intro' ? `Generate All — Step 2/2: Introduction for ${form.episode_id}`
  : generateAllStep.value === 'done' ? '✓ Generate All complete'
  : generateAllStep.value === 'failed' ? '✗ Generate All stopped on failure'
  : ''
)

async function generateAll() {
  if (!form.episode_id) return
  generateAllStep.value = 'script'
  try {
    const scriptOk = await submitScript()
    if (!scriptOk) {
      generateAllStep.value = 'failed'
      showError('Script generation failed — introduction step skipped.')
      return
    }
    generateAllStep.value = 'intro'
    const introOk = await submitIntroduction({ confirm: false })
    generateAllStep.value = introOk ? 'done' : 'failed'
    if (introOk) success('Generate All complete: script + introduction.')
    else showError('Script succeeded, but introduction failed. You can retry the introduction step alone.')
  } finally {
    // Auto-clear progress chip after a short pause so it doesn't linger
    // through unrelated UI activity.
    setTimeout(() => { if (generateAllStep.value !== 'script' && generateAllStep.value !== 'intro') generateAllStep.value = 'idle' }, 5000)
  }
}
</script>

<style scoped>
/* Form-field width tokens used across the page. */
.field-medium { max-width: 520px; }
.field-wide   { max-width: 720px; }

/* Helper line that hangs directly under an input. */
.hint-line { margin-top: 4px; }

/* Repeating "short cue above an array of inputs" label style.
 * Mirrors the same class in metadata.vue. */
.section-helper-label {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 8px;
  display: block;
}

/* Beat detail textarea — compact, monospace-friendly. */
.beat-textarea { min-height: 54px; font-size: 12px; }

/* Banner shown when intro is enabled but the script hasn't been generated
 * yet. The amber border-left echoes "warning" without using the toast colour. */
.intro-needs-script {
  font-size: 12px;
  color: var(--text-secondary);
  padding: 8px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  border-left: 3px solid var(--warning);
}

/* Custom-style picker — the "Style description" mini-form that appears
 * when the user picks "+ Write custom style…". */
.style-desc-label { margin: 0; font-size: 11px; }
.style-desc-toggle { font-size: 11px; }
.style-desc-show { margin-top: 4px; }
.style-textarea { min-height: 50px; font-size: 12px; }

.word-count-section {
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  padding: 16px;
  margin-top: 8px;
}

.word-summary {
  margin-top: 10px;
  padding: 8px 12px;
  background: var(--bg-primary);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-secondary);
}

/* v1.0.70 — title-vs-chapter mismatch warning. Surfaces when the
   user's idea title encodes a count number ("7 historical cold
   cases") that no longer matches the chapter field. Subtle yellow
   so it doesn't compete with the primary-field highlight, but
   distinct enough to catch the eye before the user clicks
   Generate. */
.title-mismatch-chip {
  margin-top: 10px;
  padding: 8px 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  background: rgba(255, 180, 0, 0.10);
  border: 1px solid rgba(255, 180, 0, 0.35);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-primary);
}
.title-mismatch-chip > span {
  flex: 1 1 auto;
  min-width: 240px;
}

.calc-badge {
  font-size: 11px;
  color: var(--accent);
  font-weight: 400;
  margin-left: 4px;
}

/* Primary-field highlight: shows the user which input is driving the calculation */
.is-primary .input {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px rgba(240, 198, 116, 0.25);
}
.primary-badge {
  font-size: 10px;
  color: var(--accent);
  background: var(--accent-dim);
  padding: 1px 6px;
  border-radius: 8px;
  margin-left: 6px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.grid-4 {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}

.estimate-box {
  padding: 10px 14px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 600;
  color: var(--accent);
}

/* Introduction section */
.intro-section {
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  padding: 16px;
}

.intro-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.intro-header h3 { font-size: 14px; margin: 0; }

.intro-body {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.intro-beats {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.beat-card {
  display: flex;
  flex-direction: column;
  gap: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  overflow: hidden;
}

.beat-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
}

.beat-card .beat-row { border: none; border-radius: 0; background: transparent; padding: 6px 10px; }
.beat-detail { padding: 2px 10px 10px; border-top: 1px dashed var(--border); }
.btn-icon.has-custom { color: var(--accent); }

.beat-add-row { display: flex; gap: 6px; align-items: center; }
.beat-add-row .input { flex: 1; }

.beat-controls {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.beat-controls .btn-icon {
  font-size: 9px;
  padding: 1px 4px;
  line-height: 1;
}

.beat-label {
  flex: 1;
}

.toggle-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-secondary);
}

.btn-icon {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 4px;
}
.btn-icon:hover { background: var(--bg-hover); color: var(--text-primary); }
.btn-icon:disabled { opacity: 0.3; cursor: default; }
.btn-icon.danger:hover { color: var(--error); background: rgba(248,113,113,0.1); }

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-muted);
}
.generating-status { display: flex; flex-direction: column; gap: 4px; }
.gen-label { font-size: 12px; color: var(--accent); }
.progress-bar { height: 3px; background: var(--bg-tertiary); border-radius: 2px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--accent); border-radius: 2px; animation: progressIndeterminate 1.5s ease-in-out infinite; }
@keyframes progressIndeterminate { 0% { width: 0%; margin-left: 0; } 50% { width: 60%; margin-left: 20%; } 100% { width: 0%; margin-left: 100%; } }

.modal-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.6);
  display: flex; align-items: center; justify-content: center;
  z-index: 2000;
}
.modal-small {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 24px;
  width: 420px;
  max-width: calc(100vw - 48px);
}
.modal-small h3 { font-size: 16px; font-weight: 600; margin: 0; }

</style>
