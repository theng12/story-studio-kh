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
      generate-label="Generate Outline"
      loading-label="Queuing…"
      :generate-loading="submitting"
      :generate-disabled="!canSubmit"
      :generate-status="scriptGenerating ? `Building outline for ${form.episode_id}…` : ''"
      @generate="submitOutline"
      @episode-selected="onEpisodeSelected"
      @preset-applied="success('Preset applied')"
      @preset-saved="success('Preset saved')"
      @preset-deleted="success('Preset deleted')"
    />

    <p class="text-muted mt-1 mb-2">
      Generate narration scripts in two phases: <strong>Generate Outline</strong> first, review and edit topics in the
      panel below, then <strong>Expand</strong> the chapters you want. The <strong>Generate Introduction</strong>
      button below unlocks once the script chapters are on disk — the introduction needs the chapters as context.
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
          <!-- v1.0.101+ Duration dropdown is now format-driven. broll-narration
               shows [5, 8, 10, 15, 20, 30]; sleep-story keeps its
               [20, 30, 45, 60, 90, 120]; each format owns its own
               recommended set via script.durationPresets in its JSON. -->
          <select v-model="durationSelect" class="select" @change="onDurationChange()">
            <option v-for="d in durationOptions" :key="d" :value="String(d)">
              {{ d }} minute{{ d === 1 ? '' : 's' }}
            </option>
            <option value="custom">Custom...</option>
          </select>
          <input v-if="durationSelect === 'custom'" v-model.number="form.length" type="number" min="1" max="240"
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

      <!-- Format context — read-only "what kind of script is this" hint.
           Replaces the deleted Quick Presets row (which pinned hardcoded
           sleep-story numbers across all formats). Pulls name + summary +
           recommended ranges from the project's effective format JSON,
           so each channel sees its own context (sleep-story shows the
           dreamy 6-14 chapter envelope, listicle shows 3-20, etc.). The
           range chips light up amber when the user's current input falls
           outside the recommended envelope — purely informational, not a
           block. Hidden when format metadata hasn't loaded yet. -->
      <div v-if="formatContext" class="format-context-card">
        <div class="format-context-header">
          <span class="format-context-icon" aria-hidden="true">ⓘ</span>
          <span class="format-context-name">{{ formatContext.name }}</span>
          <span v-if="formatContext.summary" class="format-context-summary">— {{ formatContext.summary }}</span>
        </div>
        <div class="format-context-recs">
          <span v-if="formatContext.chapterCountRange" :class="['rec-chip', { 'rec-chip-warn': chaptersOutOfRange }]"
            :title="chaptersOutOfRange || `Your ${sectionLabel.singular} count is within the format’s typical envelope.`">
            <span class="rec-chip-label">{{ sectionLabel.Plural }}</span>
            <strong>{{ formatContext.chapterCountRange[0] }}–{{ formatContext.chapterCountRange[1] }}</strong>
            <span class="rec-chip-current">you: {{ form.chapters }}</span>
          </span>
          <span v-if="formatContext.lengthMinutesRange" :class="['rec-chip', { 'rec-chip-warn': lengthOutOfRange }]"
            :title="lengthOutOfRange || 'Your duration is within the format’s typical envelope.'">
            <span class="rec-chip-label">Duration</span>
            <strong>{{ formatContext.lengthMinutesRange[0] }}–{{ formatContext.lengthMinutesRange[1] }} min</strong>
            <span class="rec-chip-current">you: {{ form.length }} min</span>
          </span>
          <span v-if="recommendedWordsPerChapter" class="rec-chip"
            :title="`Computed from this format's default ${formatContext.defaultLengthMinutes}-minute / ${formatContext.defaultChapterCount}-${sectionLabel.singular} shape at ~${wordsPerMinute} w/min.`">
            <span class="rec-chip-label">Typical w/{{ sectionLabel.singular }}</span>
            <strong>~{{ recommendedWordsPerChapter.toLocaleString() }}</strong>
            <span class="rec-chip-current">you: {{ form.words_per_chapter.toLocaleString() }}</span>
          </span>
        </div>
        <div v-if="chaptersOutOfRange || lengthOutOfRange" class="format-context-warn">
          <span v-if="chaptersOutOfRange">⚠ {{ chaptersOutOfRange }}.</span>
          <span v-if="lengthOutOfRange">⚠ {{ lengthOutOfRange }}.</span>
          <span class="text-muted">Generation will still proceed — this is just a hint.</span>
        </div>
      </div>

      <!-- v1.0.105+ — Niche overlay visibility. Surfaces what the active -->
      <!-- niche is overriding on top of the format. Without this, the user -->
      <!-- saw merged numbers in the format-context card with no signal -->
      <!-- that the niche was the source of the override. -->
      <div v-if="nicheContext && hasNicheStructureOverride" class="niche-overlay-card">
        <div class="niche-overlay-head">
          <span class="niche-overlay-icon" aria-hidden="true">🎯</span>
          <div class="niche-overlay-text">
            <strong>Niche overlay active: {{ nicheContext.name }}</strong>
            <span v-if="nicheContext.tagline" class="text-muted niche-overlay-tagline"> — {{ nicheContext.tagline }}</span>
          </div>
          <button
            type="button"
            class="link-btn niche-overlay-toggle"
            @click="showNicheOverlayDetail = !showNicheOverlayDetail"
          >
            {{ showNicheOverlayDetail ? 'Hide detail' : 'See what changed' }} {{ showNicheOverlayDetail ? '↑' : '↓' }}
          </button>
        </div>
        <div class="niche-overlay-chips">
          <span v-if="nicheContext.scriptStructure?.defaultChapterCount" class="niche-chip">
            Chapter count <strong>{{ nicheContext.scriptStructure.defaultChapterCount }}</strong>
          </span>
          <span v-if="nicheContext.scriptStructure?.chapterCountRange" class="niche-chip">
            Range <strong>{{ nicheContext.scriptStructure.chapterCountRange[0] }}–{{ nicheContext.scriptStructure.chapterCountRange[1] }}</strong>
          </span>
          <span v-if="nicheContext.scriptStructure?.pacingArc?.length" class="niche-chip">
            Pacing arc <strong>{{ nicheContext.scriptStructure.pacingArc.length }} sections</strong>
          </span>
          <span v-if="nicheContext.scriptStructure?.additionalRules?.length" class="niche-chip">
            <strong>+{{ nicheContext.scriptStructure.additionalRules.length }}</strong> rules layered on format
          </span>
        </div>
        <div v-if="showNicheOverlayDetail" class="niche-overlay-detail">
          <div v-if="nicheContext.scriptStructure?.pacingArc?.length" class="niche-overlay-block">
            <h5 class="niche-overlay-h">Pacing arc — sent to the LLM as the chapter structure</h5>
            <ol class="niche-overlay-list">
              <li v-for="(p, i) in nicheContext.scriptStructure.pacingArc" :key="i">{{ p }}</li>
            </ol>
          </div>
          <div v-if="nicheContext.scriptStructure?.additionalRules?.length" class="niche-overlay-block">
            <h5 class="niche-overlay-h">Additional rules — appended to the format's existing script rules</h5>
            <ul class="niche-overlay-list">
              <li v-for="(r, i) in nicheContext.scriptStructure.additionalRules" :key="i">{{ r }}</li>
            </ul>
          </div>
          <p class="text-muted niche-overlay-footer">
            These flow into the script prompt at generation time. The outline-review panel below renders
            <strong>one row per chapter</strong>, so for this niche you'll see
            <strong>{{ nicheContext.scriptStructure?.defaultChapterCount ?? form.chapters }} rows</strong>
            in the outline once it's generated.
          </p>
        </div>
      </div>

      <!-- v1.0.106+ — Recency avoidance strip. Renders when the active -->
      <!-- niche declares `recencyAvoidance` (currently: prayer's      -->
      <!-- scripture references). Shows how many items are currently   -->
      <!-- being avoided + the lookback window + inline lookback knob. -->
      <div v-if="recencyState && recencyState.enabled" class="recency-card">
        <div class="recency-head">
          <span class="recency-icon" aria-hidden="true">🔁</span>
          <div class="recency-text">
            <strong>Avoiding repetition</strong> —
            the next prompt will tell the LLM to skip
            <strong>{{ recencyState.recent_items.length }}</strong>
            <em>{{ recencyState.label }}</em>
            used in the last
            <strong>{{ recencyState.lookback }}</strong>
            episode{{ recencyState.lookback === 1 ? '' : 's' }}.
          </div>
          <button
            v-if="recencyState.recent_items.length > 0"
            type="button"
            class="link-btn recency-toggle"
            @click="showRecencyDetail = !showRecencyDetail"
          >
            {{ showRecencyDetail ? 'Hide' : 'See list' }} {{ showRecencyDetail ? '↑' : '↓' }}
          </button>
        </div>
        <div class="recency-controls">
          <label class="recency-lookback-label">
            Lookback window
            <input
              v-model.number="recencyLookbackInput"
              type="number"
              class="input recency-lookback-input"
              :min="0"
              :max="200"
              :placeholder="String(recencyState.lookback)"
              @change="saveRecencyLookback"
            />
            <span class="text-muted recency-lookback-hint">
              episodes ·
              <template v-if="recencyState.lookback_source === 'project'">your override</template>
              <template v-else-if="recencyState.lookback_source === 'niche'">niche default</template>
              <template v-else>built-in default</template>
            </span>
          </label>
          <button
            v-if="recencyState.log_size > 0"
            type="button"
            class="link-btn recency-clear"
            :disabled="recencyClearing"
            @click="clearRecencyLog"
          >
            {{ recencyClearing ? 'Clearing…' : `Clear log (${recencyState.log_size} entries)` }}
          </button>
        </div>
        <div v-if="recencyState.recent_items.length === 0" class="text-muted recency-empty">
          Nothing logged yet. The log fills in automatically after each script generates — first
          episode picks freely; subsequent episodes will steer away from items the channel just used.
        </div>
        <div v-if="showRecencyDetail && recencyState.recent_items.length > 0" class="recency-list-wrap">
          <div class="text-muted recency-list-h">Currently being avoided</div>
          <div class="recency-list">
            <span v-for="(item, i) in recencyState.recent_items" :key="i" class="recency-pill">{{ item }}</span>
          </div>
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
              {{ sectionLabel.Plural }}
              <span v-if="primaryField === 'chapters'" class="primary-badge">primary</span>
            </label>
            <input v-model.number="form.chapters" class="input" type="number" min="1" max="30" @input="onChaptersChange" />
          </div>
          <div class="form-group" :class="{ 'is-primary': primaryField === 'words_per_chapter' }">
            <label>
              Words/{{ sectionLabel.Singular }}
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
          <strong>{{ form.chapters }}</strong> {{ sectionLabel.plural }}
          × <strong>{{ form.words_per_chapter.toLocaleString() }}</strong> words/{{ sectionLabel.singular }}
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

    <!-- v1.0.105+ — Outline-niche mismatch banner. Fires when the
         loaded outline's chapter count differs from the active niche's
         recommended defaultChapterCount. Common cause: outline was
         generated before the niche was set (or before scriptStructure
         landed in v1.0.103), so the outline shows 1 row when the niche
         expects 3. Banner tells the user EXACTLY what to do instead of
         leaving them to spot the mismatch on their own. -->
    <div v-if="outlineNicheMismatch" class="outline-mismatch-banner">
      <div class="omb-icon" aria-hidden="true">📑</div>
      <div class="omb-text">
        <strong>Outline doesn't match the niche's structure</strong> —
        this outline has <strong>{{ outlineTotalChapters }} chapter{{ outlineTotalChapters === 1 ? '' : 's' }}</strong>,
        but <strong>{{ nicheContext?.name }}</strong> recommends
        <strong>{{ nicheContext?.scriptStructure?.defaultChapterCount }}</strong>
        (one per pacing-arc section).
        Bump <strong>Chapters</strong> in the form above to
        <strong>{{ nicheContext?.scriptStructure?.defaultChapterCount }}</strong>
        and regenerate the outline to use the full
        {{ nicheContext?.scriptStructure?.pacingArc?.length || 0 }}-section structure.
      </div>
      <button
        type="button"
        class="btn btn-sm btn-secondary omb-action"
        @click="setChaptersToNicheDefault"
      >
        Set chapters to {{ nicheContext?.scriptStructure?.defaultChapterCount }}
      </button>
    </div>

    <!-- v1.0.108+ — format-level mismatch banner. Same shape as the -->
    <!-- niche banner above, but driven off the format's default (no -->
    <!-- niche needed). Hidden when the niche banner is already firing -->
    <!-- so only one CTA shows at a time. -->
    <div v-if="outlineFormatMismatch" class="outline-mismatch-banner">
      <div class="omb-icon" aria-hidden="true">📑</div>
      <div class="omb-text">
        <strong>Outline doesn't match the format's typical shape</strong> —
        this outline has <strong>{{ outlineTotalChapters }} chapter{{ outlineTotalChapters === 1 ? '' : 's' }}</strong>,
        but <strong>{{ formatContext?.name }}</strong> recommends
        <strong>{{ formatContext?.defaultChapterCount }}</strong>.
        Bump <strong>Chapters</strong> above and regenerate the outline
        to use the format's intended arc, or stay where you are if you
        deliberately want a different shape.
      </div>
      <button
        type="button"
        class="btn btn-sm btn-secondary omb-action"
        @click="setChaptersToFormatDefault"
      >
        Set chapters to {{ formatContext?.defaultChapterCount }}
      </button>
    </div>

    <!-- Outline review (Phase 3 of the outline-first refactor). Hidden
         until the user runs Generate Outline (or any prior outline_only
         left a sidecar on disk). Per-row editable title / hook / facts
         / synopsis / beats / words override + per-row Expand + bulk
         Expand all / Expand selected. Approval state gates expansion. -->
    <OutlineReviewPanel
      v-if="panelsReady && form.episode_id"
      :project-slug="slug"
      :episode-id="form.episode_id"
      :title="form.title"
      :default-words="form.words_per_chapter || 500"
      :form="form"
      :refresh-key="outlineRefreshKey"
      @expansion-queued="onExpansionQueued"
      @outline-loaded="onOutlineLoaded"
    />

    <!-- Per-chapter source files panel (per-chapter refactor). One row per
         chapter with its own Regenerate button. The unified narration
         downstream consumers read is auto-assembled after every regen. -->
    <ChapterListPanel
      v-if="panelsReady && form.episode_id"
      :project-slug="slug"
      :episode-id="form.episode_id"
      :title="form.title"
      :script-ready="scriptGenerated"
      :form="form"
      :refresh-key="previewRefreshKey"
    />

    <!-- Preview panels: refresh after each generation completes via previewRefreshKey -->
    <ScriptPreview
      v-if="panelsReady && form.episode_id"
      :project-slug="slug"
      :episode-id="form.episode_id"
      :title="form.title"
      :refresh-key="previewRefreshKey"
    />
    <IntroductionPreview
      v-if="panelsReady && form.episode_id"
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

// Delay mounting heavy v-if'd panels (OutlineReviewPanel + ChapterListPanel +
// preview cards) by one tick after the page itself mounts. Without this gate,
// the panels' mount races with NuxtPage's RouterView slot resolution during
// navigation finalisation — Vue's componentUpdateFn ends up calling
// hostParentNode(prevTree.el) where prevTree.el is null, throwing
// "Cannot read properties of null (reading 'parentNode')" and freezing the
// renderer until Cmd+R. The page's stable shell renders first; panels join
// on the next tick when navigation has fully settled.
const panelsReady = ref(false)
const { post, patch } = useApi()
const { success, error: showError } = useToast()
// v1.0.72+: with chunked-always, every script flows through outline +
// expansion regardless of size. This threshold no longer gates which
// pipeline runs — it only gates the cost-preview confirmation dialog,
// so users with sub-threshold drafts (e.g. 5 chapters × 200 words ≈
// trivial) aren't interrupted by a price estimate that adds no value.
// Mirrors CHUNK_THRESHOLD_WORDS in electron/server/lib/chunked-narration.ts
// (currently 9000) so "long enough to warrant a cost preview" matches
// "long enough that the backend would have triggered chunking pre-1.0.72".
const CHUNK_THRESHOLD_WORDS = 9000
const { ask } = useConfirm()
const { scriptGenerating } = useGenerating()
const { confirmGeneration } = useConfirmation()
const submitting = ref(false)
const previewRefreshKey = ref(0)
// Bumped whenever the outline panel needs to reload — e.g. after an
// outline_only or expand_chapters job completes (the panel's own job
// watcher also reloads on terminal status, this is a manual nudge for
// non-job triggers like episode switch).
const outlineRefreshKey = ref(0)

function onExpansionQueued(_payload: { jobId: string; chapters: number[] | null }) {
  // ChapterListPanel listens to its own job stream and refreshes when
  // the chapter-only / expand_chapters job lands. We just bump the
  // outline panel's refresh key so chapters_done lights up the "on disk"
  // pill the moment the job is queued (the actual chapters appear after
  // it completes; OutlineReviewPanel's job watcher handles that).
  outlineRefreshKey.value++
  previewRefreshKey.value++
  // v1.0.106+ — schedule a recency refresh after the job has had time
  // to finish + the executor has appended its matches. Polling every
  // 4s for 30s catches both fast (sub-second) and slow (multi-minute)
  // chapter expansions without aggressive polling.
  let attempts = 0
  const reloader = setInterval(() => {
    attempts++
    void loadRecencyState()
    if (attempts >= 8) clearInterval(reloader)
  }, 4000)
}

/**
 * Sync the form sizing inputs to whatever the outline sidecar persisted at
 * build time. Previously the form would silently revert to format defaults
 * after a reload — forcing the user to re-type chapter count + words/chapter
 * before they could click Expand. Sidecar is the authoritative record (the
 * backend also prefers it for expand-chapters), so mirroring it here keeps
 * the visible inputs honest. Also marks `userTouchedSizing` so subsequent
 * episode-dropdown picks don't bulldoze the synced values.
 */
function onOutlineLoaded(payload: {
  totalChapters: number
  wordsPerChapter: number | null
  totalWords: number | null
  lengthMinutes: number | null
}) {
  // v1.0.105+ — capture the outline's chapter count so the mismatch
  // banner can compare it to the niche's recommended default. Without
  // this we'd rely on form.chapters which gets bumped to the outline
  // value below — but the user can also bump form.chapters manually
  // and we want the banner to compare DISK STATE not FORM STATE.
  outlineTotalChapters.value = payload.totalChapters
  if (payload.totalChapters > 0) form.chapters = payload.totalChapters
  if (payload.wordsPerChapter && payload.wordsPerChapter > 0) {
    form.words_per_chapter = payload.wordsPerChapter
  }
  if (payload.totalWords && payload.totalWords > 0) {
    form.total_words = payload.totalWords
  } else if (form.chapters > 0 && form.words_per_chapter > 0) {
    form.total_words = form.chapters * form.words_per_chapter
  }
  if (payload.lengthMinutes && payload.lengthMinutes > 0) {
    form.length = payload.lengthMinutes
    durationSelect.value = standardDurationSet.value.has(form.length) ? String(form.length) : 'custom'
  }
  userTouchedSizing.value = true
}
// Tracks the full episode object selected via EpisodeSelector — needed so
// `scriptGenerated` can read from `episode.status.script` (the API-provided
// source of truth) instead of a local mutable ref.
const selectedEpisode = ref<any>(null)
// Source of truth: the episode-listing endpoint stamps `status.script: true`
// once the narration .docx is on disk. Using a computed off that means the
// flag is automatically correct after a refetch — no manual flips, no drift
// from preview-emitted side effects.
const scriptGenerated = computed(() => !!selectedEpisode.value?.status?.script)

// v1.0.102+ — wordsPerMinute is now FORMAT-DRIVEN. Was hardcoded 122
// (sleep-story narration pace). Each format ships its own defaultWordsPerMinute:
// sleep-story stays 122 (slow); listicle/comedy 155-165 (fast);
// broll-narration / prayer 130 (breath-paced). Computed from
// formatContext.defaultWordsPerMinute with the legacy 122 as a fallback
// for any custom user format that hasn't been updated.
const LEGACY_WORDS_PER_MINUTE = 122
const wordsPerMinute = computed<number>(() => {
  const fmtWpm = formatContext.value?.defaultWordsPerMinute
  return typeof fmtWpm === 'number' && fmtWpm > 0 ? fmtWpm : LEGACY_WORDS_PER_MINUTE
})
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
  if (!p) return
  const id = (p as any).format_id
  if (typeof id === 'string' && id) {
    projectFormatId.value = id
  } else {
    // v1.0.102+ — log the silent fallback so future "why is this
    // generating sleep-story flavour?" debugging starts here.
    // In practice every project has a format_id (set at create time);
    // this branch only fires on data-corruption / partial-write edge
    // cases. Format-aware behaviour still falls back to the
    // sleep-story default downstream, but at least it's visible now.
    console.warn('[scripts.vue] project.format_id missing — falling back to sleep-story for PatternPicker filtering. Set a format in Settings → Format if this is unexpected.')
    projectFormatId.value = 'sleep-story'
  }
}, { immediate: true })

// v1.0.82+: format-aware section labels for the UI ("Chapter" for sleep-story,
// "Reason" for bound-explainer, "Topic" for listicle). The composable reads
// the section vocabulary from the loaded format list and updates reactively
// when projectFormatId changes (e.g. project switch in the sidebar).
const sectionLabel = useSectionLabel(projectFormatId)

/**
 * Format context exposed to the UI as a small read-only "what kind of
 * script is this" hint card. Populated by applyScriptFormatDefaultsIfNoPreset
 * after /effective-format resolves. The panel below the word-count inputs
 * reads these values to:
 *   - name + summary line: tell the user what flavour of script this is
 *   - recommended ranges:  show the format's own chapter / length / wpc
 *                          envelope so they can sanity-check overrides
 *   - delta indicator:     a subtle chip when the user's current numbers
 *                          fall outside the recommended range (still lets
 *                          them generate — it's a hint, not a block)
 */
interface FormatContext {
  id: string
  name: string
  summary: string                    // first sentence of description
  defaultChapterCount: number | null
  defaultLengthMinutes: number | null
  chapterCountRange: [number, number] | null
  lengthMinutesRange: [number, number] | null
  /** v1.0.101+ — duration values to show in the Duration dropdown.
   *  Populated from format.script.durationPresets; null falls back to
   *  the legacy sleep-story-flavoured [15, 20, 30, 45, 60, 90]. */
  durationPresets: number[] | null
  /** v1.0.102+ — words/minute for narration of this format. Drives the
   *  est-duration badge + the length↔total_words bidirectional snap.
   *  null falls back to the legacy 122 (sleep-story narration pace). */
  defaultWordsPerMinute: number | null
}
const formatContext = ref<FormatContext | null>(null)

// v1.0.105+ — Niche overlay visibility. The merged format already
// reflects niche overrides (defaultChapterCount, chapterCountRange,
// pacingArc, additionalRules), but until v1.0.105 there was no way for
// the user to SEE that the niche was the source — the chapter-range
// chip just showed the merged numbers. This block captures the niche
// alongside the format so the visibility strip below the format card
// can call out exactly what the niche layered on top.
interface NicheContext {
  id: string
  name: string
  tagline?: string
  scriptStructure?: {
    defaultChapterCount?: number
    chapterCountRange?: [number, number]
    pacingArc?: string[]
    additionalRules?: string[]
  }
}
const nicheContext = ref<NicheContext | null>(null)
const showNicheOverlayDetail = ref(false)
const hasNicheStructureOverride = computed(() => {
  const s = nicheContext.value?.scriptStructure
  if (!s) return false
  return !!(
    s.defaultChapterCount
    || (Array.isArray(s.chapterCountRange) && s.chapterCountRange.length === 2)
    || (Array.isArray(s.pacingArc) && s.pacingArc.length > 0)
    || (Array.isArray(s.additionalRules) && s.additionalRules.length > 0)
  )
})

// v1.0.105+ — outline-vs-niche structural mismatch tracking. Set by
// onOutlineLoaded when a sidecar lands on disk; drives the explainer
// banner that tells the user to bump + regenerate when the saved
// outline doesn't match the niche's recommended chapter count.
const outlineTotalChapters = ref(0)
const outlineNicheMismatch = computed(() => {
  if (outlineTotalChapters.value <= 0) return false
  const target = nicheContext.value?.scriptStructure?.defaultChapterCount
  if (!target || target <= 0) return false
  return outlineTotalChapters.value !== target
})

/**
 * v1.0.108+ — format-level mismatch banner. Fires for projects WITHOUT
 * a niche scriptStructure override (or with one that matches the
 * outline) when the saved outline's chapter count diverges from the
 * format's `defaultChapterCount`. Catches the bedtime / sleep-story /
 * listicle projects that don't ship a niche but still have a
 * format-default that the outline should respect.
 *
 * Hidden when the niche-level banner is already firing — one mismatch
 * call-to-action at a time keeps the page from feeling nag-y.
 */
const outlineFormatMismatch = computed(() => {
  if (outlineNicheMismatch.value) return false
  if (outlineTotalChapters.value <= 0) return false
  const target = formatContext.value?.defaultChapterCount
  if (!target || target <= 0) return false
  return outlineTotalChapters.value !== target
})

function setChaptersToNicheDefault() {
  const target = nicheContext.value?.scriptStructure?.defaultChapterCount
  if (!target || target <= 0) return
  form.chapters = target
  // Recompute the dependent fields so the word-summary stays consistent
  // — same logic onChaptersChange runs when the user types.
  if (form.words_per_chapter > 0) {
    form.total_words = form.chapters * form.words_per_chapter
  }
}

function setChaptersToFormatDefault() {
  const target = formatContext.value?.defaultChapterCount
  if (!target || target <= 0) return
  form.chapters = target
  if (form.words_per_chapter > 0) {
    form.total_words = form.chapters * form.words_per_chapter
  }
}

// ── v1.0.106+ Recency-avoidance state ──────────────────────────────────
// Renders the recency strip + lookback knob. Reads from /recency on
// mount + after every successful generation (a successful run appends
// to the log, so the count + items refresh).
interface RecencyState {
  enabled: boolean
  kind: string | null
  label: string | null
  lookback: number
  lookback_source: 'project' | 'niche' | 'default' | null
  recent_items: string[]
  log_size: number
  niche_id: string | null
}
const recencyState = ref<RecencyState | null>(null)
const recencyLookbackInput = ref<number | ''>('')
const showRecencyDetail = ref(false)
const recencyClearing = ref(false)

async function loadRecencyState() {
  try {
    const r = await get<RecencyState>(`/projects/${slug.value}/recency`)
    recencyState.value = r
    // Pre-fill the input with the project override only — leaving it
    // empty when source is 'niche'/'default' lets the placeholder show
    // the resolved value so the user can see "30 inherited" without
    // confusing themselves with a typed-in number.
    recencyLookbackInput.value = r.lookback_source === 'project' ? r.lookback : ''
  } catch {
    recencyState.value = null
  }
}

async function saveRecencyLookback() {
  const raw = recencyLookbackInput.value
  const v = raw === '' ? 0 : Number(raw)
  if (!Number.isFinite(v) || v < 0) {
    recencyLookbackInput.value = ''
    return
  }
  try {
    await put(`/projects/${slug.value}/recency/lookback`, { lookback: v })
    await loadRecencyState()
  } catch {
    // Non-fatal: leave the input as-is so the user can retry.
  }
}

async function clearRecencyLog() {
  if (recencyClearing.value) return
  if (!confirm('Clear the entire recency log for this project? The LLM will be free to repeat recent items on the next generation.')) return
  recencyClearing.value = true
  try {
    await del(`/projects/${slug.value}/recency`)
    await loadRecencyState()
  } finally {
    recencyClearing.value = false
  }
}

// v1.0.101+ — Duration dropdown options are now format-driven.
// For broll-narration (prayer / devotional / motivation projects) the
// list becomes [5, 8, 10, 15, 20, 30] instead of the sleep-story
// [15, 20, 30, 45, 60, 90]. Falls back to the legacy set when the
// format JSON doesn't carry durationPresets (back-compat for any
// custom user formats that haven't been updated yet).
const LEGACY_DURATION_PRESETS = [15, 20, 30, 45, 60, 90]
const durationOptions = computed<number[]>(() => {
  const presets = formatContext.value?.durationPresets
  return Array.isArray(presets) && presets.length > 0 ? presets : LEGACY_DURATION_PRESETS
})
const standardDurationSet = computed<Set<number>>(() => new Set(durationOptions.value))

// First sentence (or first 160 chars, whichever is shorter) — formats ship
// long marketing-flavoured descriptions; we want a one-line summary.
function summariseDescription(desc: string): string {
  if (!desc) return ''
  const trimmed = desc.trim()
  const sentenceEnd = trimmed.search(/[.!?](\s|$)/)
  const firstSentence = sentenceEnd > 0 ? trimmed.slice(0, sentenceEnd + 1) : trimmed
  return firstSentence.length > 200 ? firstSentence.slice(0, 197) + '…' : firstSentence
}

// Recommended words/chapter at the format's own default length + chapter
// count. Shown alongside the user's current wpc so they can see at a
// glance whether they've drifted from "what this format normally does."
const recommendedWordsPerChapter = computed(() => {
  const fc = formatContext.value
  if (!fc?.defaultChapterCount || !fc?.defaultLengthMinutes) return null
  if (fc.defaultChapterCount <= 0) return null
  return Math.round((fc.defaultLengthMinutes * wordsPerMinute.value) / fc.defaultChapterCount)
})

// Out-of-range checks. Each returns either null (in range / no data) or
// a short human-readable note explaining the deviation.
const chaptersOutOfRange = computed<string | null>(() => {
  const range = formatContext.value?.chapterCountRange
  if (!range || form.chapters <= 0) return null
  const [lo, hi] = range
  if (form.chapters < lo) return `${form.chapters} is below this format's typical range (${lo}–${hi})`
  if (form.chapters > hi) return `${form.chapters} is above this format's typical range (${lo}–${hi})`
  return null
})
const lengthOutOfRange = computed<string | null>(() => {
  const range = formatContext.value?.lengthMinutesRange
  if (!range || form.length <= 0) return null
  const [lo, hi] = range
  if (form.length < lo) return `${form.length} min is below this format's typical range (${lo}–${hi})`
  if (form.length > hi) return `${form.length} min is above this format's typical range (${lo}–${hi})`
  return null
})

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
  // Snapshot captures EVERY user-tunable field on this page so reloading the
  // preset restores the visible form 1:1 — including the Introduction
  // enabled toggle + beat list. Earlier the snapshot omitted `intro`, so
  // unchecking Introduction + saving the preset never persisted that bit and
  // reloads landed back on `intro.enabled = true` from the hardcoded default.
  snapshot: () => ({
    form: { ...form },
    customStyleText: customStyleText.value,
    intro: { ...intro },
    introBeats: introBeats.value.map(b => ({ ...b })),
  }),
  apply: (data) => {
    if (data.form) Object.assign(form, data.form)
    if (data.intro) Object.assign(intro, data.intro)
    if (Array.isArray(data.introBeats)) introBeats.value = data.introBeats.map((b: any) => ({ ...b }))
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
      form.total_words = Math.round(form.length * wordsPerMinute.value)
      form.words_per_chapter = Math.round(form.total_words / form.chapters)
    }
    // Cache the format metadata for the read-only context panel below the
    // word-count inputs. Pulled from the same /effective-format payload —
    // no second round-trip. Range tuples are coerced; we fall back to null
    // when a field is malformed so the UI hides the corresponding chip
    // instead of rendering "0–0".
    const ccRange = Array.isArray(sf.chapterCountRange) && sf.chapterCountRange.length === 2
      && typeof sf.chapterCountRange[0] === 'number' && typeof sf.chapterCountRange[1] === 'number'
      ? [sf.chapterCountRange[0], sf.chapterCountRange[1]] as [number, number]
      : null
    const lmRange = Array.isArray(sf.lengthMinutesRange) && sf.lengthMinutesRange.length === 2
      && typeof sf.lengthMinutesRange[0] === 'number' && typeof sf.lengthMinutesRange[1] === 'number'
      ? [sf.lengthMinutesRange[0], sf.lengthMinutesRange[1]] as [number, number]
      : null
    // v1.0.101+ duration preset list. Filter to positive numbers so a
    // bad entry in the JSON can't produce a "0 minutes" option.
    const durationPresets = Array.isArray(sf.durationPresets)
      ? (sf.durationPresets as unknown[])
          .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
      : null
    formatContext.value = {
      id: typeof f.id === 'string' ? f.id : 'unknown',
      name: typeof f.name === 'string' ? f.name : 'Format',
      summary: summariseDescription(typeof f.description === 'string' ? f.description : ''),
      defaultChapterCount: typeof sf.defaultChapterCount === 'number' ? sf.defaultChapterCount : null,
      defaultLengthMinutes: typeof sf.defaultLengthMinutes === 'number' ? sf.defaultLengthMinutes : null,
      chapterCountRange: ccRange,
      lengthMinutesRange: lmRange,
      durationPresets: durationPresets && durationPresets.length > 0 ? durationPresets : null,
      defaultWordsPerMinute: typeof sf.defaultWordsPerMinute === 'number' && sf.defaultWordsPerMinute > 0
        ? sf.defaultWordsPerMinute
        : null,
    }
    // Snap the duration dropdown back to a known option so the UI doesn't
    // flash 'custom' when the format default matches a value in the
    // format's own preset list. v1.0.101+: uses the format's
    // durationPresets (via standardDurationSet computed) so broll-narration
    // selects "10 minutes" instead of falling through to "Custom...".
    durationSelect.value = standardDurationSet.value.has(form.length) ? String(form.length) : 'custom'

    // v1.0.105+ — second fetch for the niche so the overlay indicator
    // can show what the niche is overriding on top of the format. The
    // merged format already reflects the niche overrides; this fetch
    // is purely for visibility (showing the diff). Fail-soft: a
    // project without a niche just hides the overlay strip.
    try {
      const nicheRes = await get<{ niche: any | null }>(`/projects/${slug.value}/effective-niche`)
      const n = nicheRes?.niche
      if (n && typeof n.id === 'string') {
        nicheContext.value = {
          id: n.id,
          name: typeof n.name === 'string' ? n.name : n.id,
          tagline: typeof n.tagline === 'string' ? n.tagline : undefined,
          scriptStructure: n.scriptStructure || undefined,
        }
      } else {
        nicheContext.value = null
      }
    } catch {
      nicheContext.value = null
    }
  } catch {
    // Format endpoint unavailable / project missing — keep the form's
    // hardcoded defaults. Non-fatal.
  }
}

onMounted(async () => {
  // Defer heavy panel mount to next tick so the v-if'd panels don't race
  // with NuxtPage's RouterView slot resolution mid-navigation. See
  // panelsReady declaration above.
  await nextTick()
  panelsReady.value = true
  await applyIntroFormatDefaultsIfNoPreset()
  await applyScriptFormatDefaultsIfNoPreset()
  await scriptPresets.load()
  // v1.0.106+ — load the recency state for the avoidance strip. After
  // generation completes the executor appends to the log; we refresh
  // here so the strip + count reflect what's on disk.
  await loadRecencyState()
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
const { get, put, del } = useApi()
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
//
// IMPORTANT: this used to be `watch(jobs, ..., { deep: true })`, which
// fired on every output_lines push from a running expand_chapters job —
// hundreds of times per second across a multi-batch listicle. Combined
// with OutlineReviewPanel + ChapterListPanel deep-watching the same array,
// the UI thread couldn't service navigation events (sidebar tabs froze).
// Same fix pattern as those panels: derive a tiny signal of "relevant
// statuses" and watch THAT — fires once per real transition, not per
// progress update.
//
// Also added: outline_only and expand_chapters are now in the watched
// types so the script preview refreshes after the new flow completes
// (was previously stuck because the watcher only knew script-only +
// introduction-only).
const { jobs } = useJobs()
const seenDoneJobs = new Set<string>()
const watchedScriptTypes = new Set<string>([
  'script-only', 'introduction-only', 'outline_only', 'expand_chapters', 'chapter-only',
])
const scriptJobsSignal = computed(() =>
  jobs.value
    .filter(j => watchedScriptTypes.has(j.type) && j.episode_id === form.episode_id)
    .map(j => `${j.job_id}:${j.status}`)
    .sort()
    .join('|'),
)
watch(scriptJobsSignal, () => {
  // Walk the current jobs once and act on terminal transitions we
  // haven't already responded to. The signal only changes when a
  // job transitions, so this is bounded.
  for (const job of jobs.value) {
    if (job.status !== 'done' || seenDoneJobs.has(job.job_id)) continue
    if (!watchedScriptTypes.has(job.type)) continue
    if (job.episode_id !== form.episode_id) continue
    seenDoneJobs.add(job.job_id)
    previewRefreshKey.value++
    // Refresh `selectedEpisode.status.*` from the API — that's what
    // `scriptGenerated` reads from, so without this the intro button
    // stays disabled even after expand_chapters / script-only lands.
    refetchEpisodeStatus()
  }
})

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
// Shallow — useEpisodes replaces the array reference on cache invalidation
// (its load() reassigns the SWR slot's data ref), so the cheap reference-
// equality watch picks up real refreshes without firing on individual
// episode status mutations. The previous deep:true here was firing
// alongside the global watchers during expand_chapters and contributing
// to the same UI-thread starvation. v1.0.72.
watch(cachedEpisodeList, (list) => {
  if (!form.episode_id || !list?.length) return
  const fresh = list.find((e: any) => e.episode_code === form.episode_id)
  if (fresh) selectedEpisode.value = fresh
})

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
  Math.round(form.total_words / wordsPerMinute.value)
)
const estimatedTotalDuration = computed(() =>
  Math.round(totalOutput.value / wordsPerMinute.value)
)
const canSubmit = computed(() => form.episode_id && form.title)

// Standard duration values shown in the Duration dropdown. Used only to
// decide whether the current form.length matches a dropdown option (vs
// 'custom'). The old `durationRefs` table also pinned a hardcoded chapter
// count + word count per duration — those were sleep-story-flavoured
// (45min → 10 chapters → 5500 words) and have been removed in favour of
// format-driven defaults seeded once in applyScriptFormatDefaultsIfNoPreset.
// Per-episode overrides flow through the editable inputs below.
//
// v1.0.101+ — the old hardcoded STANDARD_DURATIONS = {15,20,30,45,60,90}
// constant is gone. The "is this a standard preset?" check now reads
// from `standardDurationSet` (computed from the format's
// durationPresets), so broll-narration's 10 minute default no longer
// flashes as "Custom..." on first paint.

// Sync: Duration dropdown → total words (format-aware chapter count stays).
// Words/chapter recomputes from the new total ÷ existing chapters so a
// user changing duration doesn't accidentally reset the chapter count
// they (or the format default / preset) chose.
//
// `fromUser=true` (the default for the dropdown's @change handler) marks
// the sizing as touched so subsequent episode picks won't overwrite. The
// internal callers (onEpisodeSelected) pass `false` so the auto-applied
// suggestion doesn't lock out the next swap.
function onDurationChange(fromUser: boolean = true) {
  if (durationSelect.value !== 'custom') {
    form.length = Number(durationSelect.value)
    form.total_words = Math.round(form.length * wordsPerMinute.value)
    if (form.chapters > 0) {
      form.words_per_chapter = Math.round(form.total_words / form.chapters)
    }
  }
  if (fromUser) userTouchedSizing.value = true
}

// Track which word-count field was last edited, so we can visually highlight
// it as "primary" and make the sync rules obvious.
const primaryField = ref<'chapters' | 'words_per_chapter' | 'total_words'>('total_words')

// Sticky-input guard: once the user has manually edited any sizing input
// (chapters / words/chapter / total words / duration), we stop auto-
// overwriting those fields when they pick a different episode. Without this,
// the dropdown selection bulldozed typed values back to 10 chapters and the
// length × 122 wpm "random number" — exact issue user reported. First
// selection (when nothing is touched) still applies episode suggestions so
// brand-new episodes get sensible defaults.
const userTouchedSizing = ref(false)

// Sync: Chapters changed → recalc words/chapter (total stays)
function onChaptersChange() {
  primaryField.value = 'chapters'
  userTouchedSizing.value = true
  if (form.chapters > 0) {
    form.words_per_chapter = Math.round(form.total_words / form.chapters)
  }
}

// Sync: Words/chapter changed → recalc total words
function onWordsPerChapterChange() {
  primaryField.value = 'words_per_chapter'
  userTouchedSizing.value = true
  form.total_words = form.chapters * form.words_per_chapter
  form.length = Math.round(form.total_words / wordsPerMinute.value)
  durationSelect.value = standardDurationSet.value.has(form.length) ? String(form.length) : 'custom'
}

// Sync: Total words changed → recalc words/chapter + duration
function onTotalWordsChange() {
  primaryField.value = 'total_words'
  userTouchedSizing.value = true
  if (form.chapters > 0) {
    form.words_per_chapter = Math.round(form.total_words / form.chapters)
  }
  form.length = Math.round(form.total_words / wordsPerMinute.value)
  durationSelect.value = standardDurationSet.value.has(form.length) ? String(form.length) : 'custom'
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
      // PATCH returns the updated idea + folder_sync block describing what
      // happened on disk: { renamed: boolean, warnings: string[] }. The
      // backend renames the episode folder to match the new title so
      // the next generator call doesn't strand assets in two folders.
      const resp = await patch<any>(`/projects/${slug.value}/ideas/${ideaId}`, { title: newTitle })
      // Also update the in-memory selectedEpisode so the next render sees it.
      if (selectedEpisode.value) selectedEpisode.value.title = newTitle

      const fs = resp?.folder_sync as { renamed?: boolean; warnings?: string[] } | null | undefined
      if (fs?.warnings && fs.warnings.length > 0) {
        // Surface non-fatal hiccups (destination collision, EXDEV, etc.)
        // so the user knows the rename didn't fully land. Title still
        // synced in ideas.json — disk is just stale.
        showError(`Title synced, but folder rename had issues: ${fs.warnings.join('; ')}`)
      } else if (fs?.renamed) {
        success(`Title synced to ${form.chapters} chapters · folder renamed`)
      } else {
        success(`Title synced to ${form.chapters} chapters`)
      }
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
  // Title always tracks the picked episode — it's tied 1:1 to ep identity
  // and the user wouldn't expect their last episode's title to follow them
  // to a new pick.
  form.title = ep.title
  // Sizing fields (chapters / length / total_words / words_per_chapter)
  // ONLY auto-apply on a fresh form. Once the user has typed in any of
  // those inputs (tracked by userTouchedSizing), episode swaps leave the
  // typed values alone — so picking a different episode doesn't bulldoze
  // "20 chapters × 700 words" back to "10 × 5490". User-reported issue.
  if (!userTouchedSizing.value) {
    form.chapters = ep.suggested_chapters || 10
    const dur = ep.suggested_length === '60 min' ? 60 : 45
    form.length = dur
    durationSelect.value = String(dur)
    onDurationChange(/* fromUser */ false)
  }
}

async function submitOutline(opts: { auto_approve?: boolean } = {}): Promise<boolean> {
  // Generate the OUTLINE only — Phase 3 of the outline-first refactor.
  // Replaces the legacy submitScript (which POSTed /generate/script-only,
  // running outline + expansion in one opaque job). Now we POST
  // /generate/outline-only first; the user reviews/edits in
  // OutlineReviewPanel then triggers expansion from there.
  //
  // generateAll() passes auto_approve: true so the chained run skips the
  // human review gate (the OutlineReviewPanel still renders, just shows
  // an already-approved outline).
  //
  // Returns true if the outline_only job reached 'done', false otherwise.
  const params: Record<string, any> = {
    ...form,
    custom_style_text: customStyleText.value,
  }
  if (opts.auto_approve) params.auto_approve = true

  // v1.0.71: chunked-mode pre-flight. When the target wordcount exceeds
  // ~10k words, expansion will issue MULTIPLE LLM calls (one per batch).
  // Surface a rough estimate now so the user understands the eventual
  // cost — the outline build itself is a single cheap call, but the
  // user sees the full picture upfront. Skipped below threshold.
  const targetWords = (form.chapters || 0) * (form.words_per_chapter || 0)
  if (targetWords > CHUNK_THRESHOLD_WORDS) {
    const estimate = estimateChunkedCost(targetWords, form.chapters || 0)
    const ok = await ask({
      title: 'Long script — chunked outline + expansion',
      message:
        `${form.chapters} chapters × ${form.words_per_chapter.toLocaleString()} words ` +
        `(~${targetWords.toLocaleString()} words total).\n\n` +
        `Step 1 (this click): build outline — 1 cheap LLM call.\n` +
        `Step 2 (after you review): expand into ${estimate.expansionCalls} batch${estimate.expansionCalls === 1 ? '' : 'es'}.\n\n` +
        `Estimated total cost: ${estimate.costRange} (Sonnet pricing).\n\n` +
        `Each chapter is written to disk as soon as it's generated, so cancel / crash / restart preserves partial work.`,
      confirmLabel: 'Generate outline',
      cancelLabel: 'Cancel',
    })
    if (!ok) return false
  }

  if (!await confirmGeneration(slug.value, 'script', params)) return false

  submitting.value = true
  scriptGenerating.value = true
  try {
    const job = await post<{ job_id: string }>(`/projects/${slug.value}/generate/outline-only`, params)
    success(opts.auto_approve ? 'Outline build queued (auto-approved)' : 'Outline build queued — review when it finishes!')
    const ok = await waitForJob(job.job_id)
    if (ok) outlineRefreshKey.value++
    return ok
  } catch (e: any) {
    console.error('[scripts] queue outline generation failed:', e)
    const detail = e.data?.detail
    const fallback = e?.status === 0 || e?.message?.includes('fetch')
      ? 'Backend unreachable — restart the app or check the Jobs panel.'
      : 'Failed to queue outline generation. Check the form fields above.'
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
    // Watch a derived status signal for THIS specific job so output_lines
    // pushes (which don't change status) don't fire the callback. Same
    // signal-based pattern the other jobs watchers use; immediate: true
    // on the watch handles the case where the job is already terminal
    // by the time the caller awaits.
    const targetStatus = computed(() => {
      const j = jobs.value.find((x: any) => x.job_id === jobId)
      return j?.status || ''
    })
    const stop = watch(targetStatus, (s) => {
      if (s === 'done') { stop(); resolve(true) }
      else if (s === 'error' || s === 'cancelled') { stop(); resolve(false) }
    }, { immediate: true })
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

// "Generate All" was removed in v1.0.72 with the outline-first refactor.
// The introduction needs the script chapters on disk for context — bundling
// it into a single button hid that dependency. The flow is now explicit:
//   1. Generate Outline (top of page)
//   2. Review + approve in OutlineReviewPanel below
//   3. Expand chapters (panel button)
//   4. Generate Introduction (form button further down — unlocks once
//      scriptGenerated flips true)
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

/* Format context — read-only "what kind of script is this" hint card.
   Sits above the word-count inputs so the user sees the format's typical
   envelope (chapter range, duration range, recommended wpc) before they
   override anything. Range chips light up amber via .rec-chip-warn when
   the user's current value is outside the recommended range. */
.format-context-card {
  margin-top: 8px;
  padding: 14px 16px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  border-left: 3px solid var(--accent);
  font-size: 13px;
  color: var(--text-primary);
}

/* v1.0.105+ — Niche overlay indicator. Sits directly under the format
   context card so the user can see at a glance which numbers are coming
   from the niche vs the format. Amber accent so it stands out from the
   blue format card without competing with the warn chip colour. */
.niche-overlay-card {
  margin-top: 6px;
  padding: 12px 16px;
  background: rgba(245, 188, 66, 0.06);
  border-radius: var(--radius-md);
  border-left: 3px solid #f5bc42;
  font-size: 13px;
  color: var(--text-primary);
}
.niche-overlay-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.niche-overlay-icon {
  font-size: 14px;
  line-height: 1;
}
.niche-overlay-text {
  flex: 1;
  min-width: 0;
}
.niche-overlay-tagline {
  font-size: 12px;
}
.niche-overlay-toggle {
  font-size: 11px;
  white-space: nowrap;
}
.niche-overlay-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.niche-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 2px 8px;
  background: rgba(245, 188, 66, 0.12);
  border: 1px solid rgba(245, 188, 66, 0.35);
  border-radius: 10px;
  font-size: 11px;
  color: var(--text-primary);
}
.niche-chip strong {
  font-weight: 700;
}
.niche-overlay-detail {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid rgba(245, 188, 66, 0.18);
}
.niche-overlay-block {
  margin-bottom: 10px;
}
.niche-overlay-h {
  margin: 0 0 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}
.niche-overlay-list {
  margin: 0;
  padding-left: 20px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
}
.niche-overlay-list li {
  margin: 2px 0;
}
.niche-overlay-footer {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.4;
}

/* v1.0.105+ — Outline ↔ niche mismatch banner. Fires above the
   outline-review panel when the saved outline's chapter count doesn't
   match the active niche's recommended default. Cyan accent so it's
   informational, not alarming (the outline still works — the banner
   just nudges the user to regenerate for the full niche structure). */
.outline-mismatch-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 0 0;
  padding: 12px 16px;
  background: rgba(110, 168, 254, 0.08);
  border-radius: var(--radius-md);
  border-left: 3px solid var(--accent, #6ea8fe);
  font-size: 13px;
  line-height: 1.45;
}
.omb-icon {
  font-size: 20px;
  flex-shrink: 0;
}
.omb-text {
  flex: 1;
  min-width: 0;
}
.omb-action {
  flex-shrink: 0;
  white-space: nowrap;
}

/* v1.0.106+ — Recency-avoidance strip. Green/teal accent so it reads
   as "this is making your output better" not "warning". Sits just below
   the niche overlay since it's the same logical layer (niche-level
   knobs influencing this episode's prompt). */
.recency-card {
  margin-top: 6px;
  padding: 12px 16px;
  background: rgba(80, 200, 160, 0.06);
  border-radius: var(--radius-md);
  border-left: 3px solid #4fd3a3;
  font-size: 13px;
  color: var(--text-primary);
}
.recency-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.recency-icon {
  font-size: 14px;
  line-height: 1;
}
.recency-text {
  flex: 1;
  min-width: 0;
}
.recency-text em {
  font-style: normal;
  color: var(--text-primary);
}
.recency-toggle {
  font-size: 11px;
  white-space: nowrap;
}
.recency-controls {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.recency-lookback-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-secondary);
}
.recency-lookback-input {
  width: 70px;
  padding: 2px 6px;
  font-size: 12px;
}
.recency-lookback-hint {
  font-size: 11px;
}
.recency-clear {
  font-size: 11px;
  color: var(--text-secondary);
}
.recency-empty {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.5;
}
.recency-list-wrap {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid rgba(80, 200, 160, 0.18);
}
.recency-list-h {
  font-size: 11px;
  margin-bottom: 6px;
}
.recency-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.recency-pill {
  display: inline-block;
  padding: 2px 8px;
  background: rgba(80, 200, 160, 0.12);
  border: 1px solid rgba(80, 200, 160, 0.30);
  border-radius: 10px;
  font-size: 11px;
  font-family: var(--mono, ui-monospace, SFMono-Regular, monospace);
  color: var(--text-primary);
}
.format-context-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.format-context-icon {
  color: var(--accent);
  font-size: 14px;
  line-height: 1;
}
.format-context-name {
  font-weight: 600;
  color: var(--text-primary);
}
.format-context-summary {
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.45;
}
.format-context-recs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.rec-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 5px 10px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-secondary);
  cursor: help;
  transition: border-color 0.15s, background 0.15s;
}
.rec-chip strong {
  color: var(--text-primary);
  font-weight: 600;
}
.rec-chip-label {
  color: var(--text-muted);
  text-transform: uppercase;
  font-size: 10.5px;
  letter-spacing: 0.4px;
}
.rec-chip-current {
  color: var(--text-muted);
  font-size: 11px;
}
.rec-chip-warn {
  border-color: rgba(255, 180, 0, 0.55);
  background: rgba(255, 180, 0, 0.10);
}
.rec-chip-warn .rec-chip-current {
  color: rgb(200, 140, 0);
  font-weight: 500;
}
.format-context-warn {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-secondary);
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.format-context-warn .text-muted {
  font-style: italic;
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
