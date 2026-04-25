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
      <div class="form-group" style="max-width: 520px;">
        <label>Episode Title</label>
        <input v-model="form.title" class="input" placeholder="The Whispering Forest" />
      </div>

      <!-- Pattern picker (Phase 4b) — optional per-episode template that
           composes on top of the project's format. Empty = format defaults. -->
      <div class="form-group mt-2" style="max-width: 720px;">
        <PatternPicker
          v-model="form.pattern_id"
          v-model:subject="form.pattern_subject"
          :format-id="projectFormatId"
        />
      </div>

      <!-- Introduction (on top, toggleable) -->
      <div class="intro-section mt-2">
        <div class="intro-header">
          <label class="toggle-label">
            <input type="checkbox" v-model="intro.enabled" />
            <h3>Introduction</h3>
          </label>
          <span v-if="intro.enabled" class="text-muted" style="font-size:12px">~{{ intro.word_target }} words</span>
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
              <span class="text-muted" style="font-size:11px">Leave blank to let the AI skip the host name.</span>
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
          <label style="font-size:12px; color:var(--text-muted); margin-bottom:8px; display:block">
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
                  class="textarea"
                  style="min-height: 54px; font-size: 12px;"
                  :placeholder="`Optional — specific wording or points you want this beat to cover. Example for '${beat.label}': ${beatPlaceholder(beat.id)}`"
                />
                <p class="text-muted" style="font-size: 11px; margin-top: 4px;">
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
          <div v-if="intro.enabled && !scriptGenerated" class="mt-2" style="font-size: 12px; color: var(--text-secondary); padding: 8px; background: var(--bg-tertiary); border-radius: var(--radius-sm); border-left: 3px solid var(--border-warning);">
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
              <label style="margin:0; font-size:11px">Style description</label>
              <button class="btn-icon" style="font-size:11px" @click="showStyleDesc = false">Hide</button>
            </div>
            <textarea v-model="customStyleText" class="textarea" style="min-height:50px; font-size:12px"
              placeholder="Describe the narrator's tone, perspective, and personality..." />
            <div class="flex gap-2 mt-1" v-if="form.style === 'custom'">
              <button class="btn btn-sm btn-secondary" @click="saveCustomStyle">Save as preset</button>
            </div>
          </div>
          <button v-if="form.style !== 'custom' && form.style !== 'auto' && !showStyleDesc" class="btn-icon" style="font-size:11px; margin-top:4px" @click="showStyleDesc = true">
            View / edit description
          </button>
        </div>
      </div>

      <!-- Reference Styles panel — paste 1–5 scripts, LLM extracts patterns -->
      <!-- (format/style/tone/structure), save as a project-scoped preset. -->
      <!-- When a style preset is active, its analysis merges into the -->
      <!-- custom_style_text sent with every script generation. -->
      <div class="reference-style-panel mt-2">
        <button
          type="button"
          class="rsp-toggle"
          :aria-expanded="stylePanelOpen"
          :title="stylePanelOpen ? 'Collapse reference styles' : 'Paste 1–5 reference scripts to analyze their format/style/tone/structure. The analysis is saved as a project-scoped preset you can apply to future script generations.'"
          @click="stylePanelOpen = !stylePanelOpen"
        >
          <span class="rsp-chev" :class="{ open: stylePanelOpen }">▸</span>
          <span>🎭 Reference Styles</span>
          <span v-if="activeStylePreset" class="rsp-badge">Using: {{ activeStylePreset.name }}</span>
          <span v-else class="text-muted" style="font-size: 11px; margin-left: auto;">
            Paste reference scripts to clone their style (optional)
          </span>
        </button>

        <div v-if="stylePanelOpen" class="rsp-body">
          <p class="text-muted" style="font-size: 12px; margin-top: 0;">
            Paste up to 5 existing scripts whose <strong>format / style / tone / structure</strong> you want future generations to follow.
            The LLM extracts the patterns — <strong>you can edit any field</strong> afterwards.
            Presets are saved per-project.
          </p>

          <!-- Preset picker -->
          <div class="rsp-row">
            <label class="rsp-label">Active preset</label>
            <select
              :value="stylePresets.activeId.value"
              class="select select-sm"
              @change="onStylePresetChange(($event.target as HTMLSelectElement).value)"
            >
              <option value="">— none (don't apply) —</option>
              <option v-for="p in stylePresets.presets.value" :key="p.id" :value="p.id">
                {{ p.name }}
              </option>
            </select>
            <button
              class="btn btn-sm btn-secondary"
              :disabled="!stylePresets.activeId.value"
              @click="applyActiveStylePreset"
              title="Load the selected preset's references + analysis into the fields below."
            >Load</button>
            <button
              class="btn btn-sm btn-secondary"
              :disabled="!stylePresets.activeId.value"
              @click="overwriteStylePreset"
              title="Save the current references + analysis back to the active preset."
            >Save</button>
            <button
              class="btn btn-sm btn-secondary"
              @click="openSaveStylePreset"
              title="Save as a new preset."
            >Save as…</button>
            <button
              v-if="stylePresets.activeId.value"
              class="btn btn-sm btn-danger"
              @click="deleteStylePreset"
            >Delete</button>
          </div>

          <!-- References list -->
          <div class="rsp-refs">
            <div
              v-for="(ref, idx) in styleReferences"
              :key="idx"
              class="rsp-ref"
            >
              <div class="rsp-ref-head">
                <input
                  v-model="ref.label"
                  class="input input-sm rsp-ref-label"
                  :placeholder="`Reference ${idx + 1} label (e.g. 'Favourite sleep story')`"
                />
                <span class="text-muted" style="font-size: 11px;">
                  {{ ref.text.length }} chars
                </span>
                <button
                  class="btn-icon"
                  title="Remove this reference"
                  @click="styleReferences.splice(idx, 1)"
                >✕</button>
              </div>
              <textarea
                v-model="ref.text"
                class="textarea"
                style="min-height: 120px; font-size: 12px;"
                placeholder="Paste the full text of an existing script you want future generations to imitate..."
              ></textarea>
            </div>
            <button
              v-if="styleReferences.length < 5"
              class="btn btn-sm btn-ghost"
              @click="styleReferences.push({ label: '', text: '' })"
            >+ Add reference ({{ styleReferences.length }}/5)</button>
          </div>

          <div class="rsp-analyze-row">
            <button
              class="btn btn-sm btn-primary"
              :disabled="styleAnalyzing || !styleReferences.some(r => r.text.trim())"
              :title="styleReferences.some(r => r.text.trim())
                ? 'Ask the LLM to extract format/style/tone/structure from the pasted scripts. You can edit the results.'
                : 'Paste at least one reference script first.'"
              @click="analyzeReferences"
            >
              <LoadingSpinner v-if="styleAnalyzing" size="sm" />
              {{ styleAnalyzing ? 'Analyzing…' : '🔍 Analyze' }}
            </button>
            <span v-if="styleAnalysisError" class="text-danger" style="font-size: 12px;">
              {{ styleAnalysisError }}
            </span>
          </div>

          <!-- Analysis fields (editable) -->
          <div v-if="hasStyleAnalysis" class="rsp-analysis">
            <div class="form-group">
              <label>Format <span class="text-muted" style="font-size: 11px; font-weight: normal;">— document shape, chapter structure, opening conventions, pacing beats. Edit if the LLM missed something.</span></label>
              <textarea v-model="styleAnalysis.format" class="textarea" style="min-height: 80px; font-size: 12px;" />
            </div>
            <div class="form-group">
              <label>Style <span class="text-muted" style="font-size: 11px; font-weight: normal;">— voice, diction, sentence rhythm, POV.</span></label>
              <textarea v-model="styleAnalysis.style" class="textarea" style="min-height: 80px; font-size: 12px;" />
            </div>
            <div class="form-group">
              <label>Tone <span class="text-muted" style="font-size: 11px; font-weight: normal;">— mood + emotional colour.</span></label>
              <textarea v-model="styleAnalysis.tone" class="textarea" style="min-height: 60px; font-size: 12px;" />
            </div>
            <div class="form-group">
              <label>Structure <span class="text-muted" style="font-size: 11px; font-weight: normal;">— narrative architecture, scene-close patterns, tension build.</span></label>
              <textarea v-model="styleAnalysis.structure" class="textarea" style="min-height: 80px; font-size: 12px;" />
            </div>
            <div class="form-group">
              <label>Notes <span class="text-muted" style="font-size: 11px; font-weight: normal;">— freeform scratchpad saved with the preset.</span></label>
              <textarea v-model="styleNotes" class="textarea" style="min-height: 50px; font-size: 12px;" />
            </div>
          </div>
        </div>
      </div>

      <!-- Save-as preset modal -->
      <Modal :visible="showSaveStylePreset" size="sm" labelledby="sav-preset-title" @close="showSaveStylePreset = false">
        <h3 id="sav-preset-title">Save Reference Style preset</h3>
        <p class="text-muted mt-1 mb-2" style="font-size: 12px;">
          Stored per-project. Pick a name — e.g. "Sleep stories (lyrical)", "Fairy tale cadence".
        </p>
        <input v-model="newStylePresetName" ref="newStylePresetInput" class="input" placeholder="Preset name" @keydown.enter="confirmSaveStylePreset" />
        <div class="flex gap-2 mt-2" style="justify-content: flex-end;">
          <button class="btn btn-secondary" @click="showSaveStylePreset = false">Cancel</button>
          <button class="btn btn-primary" :disabled="!newStylePresetName.trim()" @click="confirmSaveStylePreset">Save</button>
        </div>
      </Modal>

      <!-- Word count section — edit any field; others recalc from your primary input -->
      <div class="word-count-section">
        <p class="text-muted mb-1" style="font-size: 12px;">
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

        <div class="reference-table">
          <div class="ref-header">
            <span>Quick Presets</span>
          </div>
          <div class="ref-items">
            <div v-for="ref in durationRefs" :key="ref.min" :class="['ref-item', { active: isActiveRef(ref) }]" @click="applyPreset(ref)">
              <span class="ref-duration">{{ ref.min }} min</span>
              <span class="ref-words">{{ ref.words.toLocaleString() }} w</span>
              <span class="ref-chapters">{{ ref.chapters }} ch</span>
            </div>
          </div>
        </div>
      </div>

      <div class="flex items-center gap-2 mt-2" style="flex-wrap: wrap;">
        <label class="checkbox-label">
          <input type="checkbox" v-model="form.force" />
          Force regenerate (overwrite existing)
        </label>
        <span class="text-muted" style="font-size: 11px;">
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
        <p class="text-muted mt-1 mb-2" style="font-size:12px">Give this narrator style a name so you can reuse it.</p>
        <input
          v-model="newStyleName"
          class="input"
          placeholder="e.g. Cozy Grandma, Dark Noir"
          @keydown.enter="confirmSaveCustomStyle"
          @keydown.escape="showSaveStyle = false"
        />
        <div class="flex gap-2 mt-2" style="justify-content:flex-end">
          <button class="btn btn-secondary" @click="showSaveStyle = false">Cancel</button>
          <button class="btn btn-primary" :disabled="!newStyleName.trim()" @click="confirmSaveCustomStyle">Save</button>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useHead({ title: "Script Generator — Story Studio KH" })
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { post } = useApi()
const { success, error: showError } = useToast()
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
onMounted(() => scriptPresets.load())

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

// ── Reference Style presets (project-scoped) ───────────────────────────
// New in the 2026 Reference Styles feature: users paste 1–5 existing
// scripts, the LLM extracts format/style/tone/structure patterns, and the
// result is saved as an editable preset. When active, the analysis is
// prepended to custom_style_text so the script generator follows the
// cloned style.
//
// Storage uses `configKey: 'script_style'` so it lives in a separate
// bucket from the chapter/intro presets — the Reference Style preset
// picker only ever sees its own pool.
const stylePanelOpen = ref(false)
interface StyleReference { label: string; text: string }
const styleReferences = ref<StyleReference[]>([{ label: '', text: '' }])
const styleAnalysis = reactive({ format: '', style: '', tone: '', structure: '' })
const styleNotes = ref('')
const styleAnalysisRaw = ref('')
const styleAnalyzing = ref(false)
const styleAnalysisError = ref('')

const hasStyleAnalysis = computed(() =>
  !!(styleAnalysis.format || styleAnalysis.style || styleAnalysis.tone || styleAnalysis.structure),
)

const stylePresets = usePresets<any>({
  slug: slug.value,
  configKey: 'script_style',
  presetType: 'script-style',
  // Exclude refs + analysis fields from the episode-specific scrub list —
  // those are the point of the preset. Default excludes (episode_id, title
  // etc.) are fine; empty override to spell out the reasoning here.
  snapshot: () => ({
    references: styleReferences.value.map(r => ({ ...r })),
    analysis: { ...styleAnalysis },
    notes: styleNotes.value,
    raw: styleAnalysisRaw.value,
  }),
  apply: (data: any) => {
    if (!data) return
    if (Array.isArray(data.references)) {
      styleReferences.value = data.references.map((r: any) => ({
        label: String(r?.label || ''),
        text: String(r?.text || ''),
      }))
    }
    if (data.analysis) Object.assign(styleAnalysis, {
      format: String(data.analysis.format || ''),
      style: String(data.analysis.style || ''),
      tone: String(data.analysis.tone || ''),
      structure: String(data.analysis.structure || ''),
    })
    if (typeof data.notes === 'string') styleNotes.value = data.notes
    if (typeof data.raw === 'string') styleAnalysisRaw.value = data.raw
  },
})
onMounted(() => stylePresets.load())

const activeStylePreset = computed(() => {
  const id = stylePresets.activeId.value
  if (!id) return null
  return stylePresets.presets.value.find((p: any) => p.id === id) || null
})

// Merge the active style preset's analysis into custom_style_text so the
// script prompt sees it. We APPEND (not replace) — the narrator-style
// selection remains in effect; Reference Styles layers extra guidance.
const mergedStyleText = computed(() => {
  const parts: string[] = []
  if (customStyleText.value.trim()) parts.push(customStyleText.value.trim())
  if (hasStyleAnalysis.value) {
    const lines = ['', '=== REFERENCE STYLE (from pasted samples) ===']
    if (styleAnalysis.format)    lines.push(`Format: ${styleAnalysis.format}`)
    if (styleAnalysis.style)     lines.push(`Style: ${styleAnalysis.style}`)
    if (styleAnalysis.tone)      lines.push(`Tone: ${styleAnalysis.tone}`)
    if (styleAnalysis.structure) lines.push(`Structure: ${styleAnalysis.structure}`)
    if (styleNotes.value.trim()) lines.push(`Notes: ${styleNotes.value.trim()}`)
    parts.push(lines.join('\n'))
  }
  return parts.join('\n')
})

function onStylePresetChange(id: string) {
  stylePresets.setActive(id)
}
async function applyActiveStylePreset() {
  const p = stylePresets.applyActive()
  if (p) success(`Loaded "${p.name}"`)
}
async function overwriteStylePreset() {
  const p = await stylePresets.overwrite()
  if (p) success(`Saved to "${p.name}"`)
}
async function deleteStylePreset() {
  const p = await stylePresets.remove()
  if (p) {
    success(`Deleted "${p.name}"`)
    // Reset form so the UI doesn't stay showing the deleted preset's data.
    styleReferences.value = [{ label: '', text: '' }]
    Object.assign(styleAnalysis, { format: '', style: '', tone: '', structure: '' })
    styleNotes.value = ''
    styleAnalysisRaw.value = ''
  }
}

const showSaveStylePreset = ref(false)
const newStylePresetName = ref('')
const newStylePresetInput = ref<HTMLInputElement | null>(null)
function openSaveStylePreset() {
  newStylePresetName.value = ''
  showSaveStylePreset.value = true
  nextTick(() => newStylePresetInput.value?.focus())
}
async function confirmSaveStylePreset() {
  const name = newStylePresetName.value.trim()
  if (!name) return
  const p = await stylePresets.saveAs(name)
  showSaveStylePreset.value = false
  if (p) success(`Saved preset "${name}"`)
}

async function analyzeReferences() {
  const refs = styleReferences.value.filter(r => r.text.trim())
  if (!refs.length) return
  styleAnalyzing.value = true
  styleAnalysisError.value = ''
  try {
    const r = await post<{
      format: string; style: string; tone: string; structure: string
      raw: string; model_used: string
    }>(`/projects/${slug.value}/presets/script-style/analyze`, {
      references: refs.map(r => ({ label: r.label, text: r.text })),
    })
    styleAnalysis.format = r.format
    styleAnalysis.style = r.style
    styleAnalysis.tone = r.tone
    styleAnalysis.structure = r.structure
    styleAnalysisRaw.value = r.raw
    success(`Analysis complete (${r.model_used}). Review and edit any field.`)
  } catch (e: any) {
    styleAnalysisError.value = e?.data?.detail || e?.message || 'Analysis failed'
  } finally {
    styleAnalyzing.value = false
  }
}

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

// Re-pull just the active episode's row from /projects/:slug/episodes
// (the same endpoint EpisodeSelector uses) and replace selectedEpisode so
// downstream computeds (scriptGenerated, anything else gating on
// status.*) become correct without waiting for the user to re-pick.
async function refetchEpisodeStatus() {
  if (!form.episode_id) return
  try {
    const list = await get<any[]>(`/projects/${slug.value}/episodes`)
    const fresh = (list || []).find(e => e.episode_code === form.episode_id)
    if (fresh) selectedEpisode.value = fresh
  } catch { /* keep stale episode rather than blanking the UI */ }
}

// Fetch on initial mount + any time the episode id changes (deep-link from
// the dashboard, preset apply, etc.). EpisodeSelector only emits its own
// event when the user picks from the dropdown, so without this, deep-links
// would leave selectedEpisode null and `scriptGenerated` stuck at false.
watch(() => form.episode_id, (id) => { if (id) refetchEpisodeStatus() }, { immediate: true })

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

const durationRefs = [
  { min: 15, words: 1800, chapters: 5 },
  { min: 20, words: 2400, chapters: 6 },
  { min: 30, words: 3600, chapters: 8 },
  { min: 45, words: 5500, chapters: 10 },
  { min: 60, words: 7500, chapters: 12 },
  { min: 90, words: 11000, chapters: 15 },
]

// Sync: Duration dropdown → total words → words/chapter
function onDurationChange() {
  if (durationSelect.value !== 'custom') {
    form.length = Number(durationSelect.value)
    const ref = durationRefs.find(r => r.min === form.length)
    if (ref) {
      form.total_words = ref.words
      form.chapters = ref.chapters
    } else {
      form.total_words = Math.round(form.length * wordsPerMinute)
    }
    form.words_per_chapter = Math.round(form.total_words / form.chapters)
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
  durationSelect.value = durationRefs.find(r => r.min === form.length) ? String(form.length) : 'custom'
}

// Sync: Total words changed → recalc words/chapter + duration
function onTotalWordsChange() {
  primaryField.value = 'total_words'
  if (form.chapters > 0) {
    form.words_per_chapter = Math.round(form.total_words / form.chapters)
  }
  form.length = Math.round(form.total_words / wordsPerMinute)
  durationSelect.value = durationRefs.find(r => r.min === form.length) ? String(form.length) : 'custom'
}

// Apply a quick preset
function applyPreset(ref: { min: number; words: number; chapters: number }) {
  form.length = ref.min
  form.total_words = ref.words
  form.chapters = ref.chapters
  form.words_per_chapter = Math.round(ref.words / ref.chapters)
  durationSelect.value = String(ref.min)
}

function isActiveRef(ref: { min: number; words: number; chapters: number }) {
  return form.total_words === ref.words && form.chapters === ref.chapters
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
  //
  // mergedStyleText merges the active Reference Style preset's analysis
  // (if any) into custom_style_text so the script generator applies the
  // cloned format/style/tone/structure on top of the narrator style.
  const params = {
    ...form,
    custom_style_text: mergedStyleText.value,
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
    showError(e.data?.detail || 'Failed to queue script generation')
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
    showError(e.data?.detail || 'Failed to queue introduction generation')
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

.reference-table {
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}

.ref-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
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

.ref-items { display: flex; gap: 6px; flex-wrap: wrap; }
.ref-item {
  display: flex; flex-direction: column; align-items: center;
  padding: 8px 14px; border-radius: var(--radius-sm);
  background: var(--bg-primary); border: 1px solid var(--border);
  font-size: 12px; gap: 2px; transition: all 0.15s; cursor: pointer;
}
.ref-item:hover { border-color: var(--border-light); }
.ref-item.active { border-color: var(--accent); background: var(--accent-dim); }
.ref-duration { font-weight: 600; color: var(--text-primary); }
.ref-words { color: var(--accent); }
.ref-chapters { color: var(--text-muted); }

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

/* ── Reference Styles panel ───────────────────────────────────────── */
.reference-style-panel {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
}
.rsp-toggle {
  width: 100%;
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px;
  background: none; border: none;
  cursor: pointer;
  font-size: 13px; font-weight: 600;
  color: var(--text-primary);
  text-align: left;
}
.rsp-toggle:hover { background: var(--bg-hover); }
.rsp-chev {
  display: inline-block;
  transition: transform 0.15s ease;
  font-size: 11px;
  color: var(--text-muted);
}
.rsp-chev.open { transform: rotate(90deg); }
.rsp-badge {
  margin-left: auto;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--accent);
  background: var(--accent-dim);
  border-radius: 999px;
}
.rsp-body {
  padding: 12px;
  border-top: 1px solid var(--border);
}
.rsp-row {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.rsp-label { font-size: 11px; color: var(--text-muted); min-width: 80px; }
.rsp-refs { display: flex; flex-direction: column; gap: 10px; margin-bottom: 10px; }
.rsp-ref {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px;
  background: var(--bg-primary);
}
.rsp-ref-head {
  display: flex; align-items: center; gap: 6px;
  margin-bottom: 6px;
}
.rsp-ref-label { flex: 1; }
.rsp-analyze-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 0;
  border-top: 1px dashed var(--border);
  margin-top: 6px;
}
.rsp-analysis {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 10px;
}
</style>
