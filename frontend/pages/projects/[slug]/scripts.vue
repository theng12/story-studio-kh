<template>
  <div class="workspace-page creation-workspace scripts-workspace">
    <WorkspaceHero
      eyebrow="Create · Write"
      title="Script Generator"
      description="Create an outline, expand approved chapters, and keep the Formula’s writing rules visible from start to finish."
    >
      <template #aside>
        <div class="workspace-metrics" aria-label="Script workspace context">
          <span class="workspace-metric" :data-tone="form.episode_id ? 'success' : 'warning'"><strong>{{ form.episode_id || 'No episode' }}</strong> target</span>
          <span class="workspace-metric" data-tone="info"><strong>{{ scriptsTab }}</strong> workspace</span>
          <span v-if="scriptJobActiveForEpisode" class="workspace-metric" data-tone="warning"><strong>Active</strong> generation</span>
        </div>
      </template>
    </WorkspaceHero>
    <div class="workspace-command-surface creation-command-surface">
      <TopActionBar
      :project-slug="slug"
      :presets="scriptPresets"
      v-model:episode-id="form.episode_id"
      filter-field="script"
      generate-label="Create outline"
      :generate-loading="submitting || scriptJobActiveForEpisode"
      :generate-disabled="!canSubmit"
      :generate-status="scriptJobActiveForEpisode ? `Building outline for ${form.episode_id}…` : ''"
      @generate="submitOutline"
      @episode-selected="onEpisodeSelected"
      />
      <p class="workspace-command-copy">
        Create an outline, approve and expand it in <strong>Script</strong>. Your Formula controls the narrator, opening policy, and writing rules.
      </p>
    </div>

    <InheritedLlmLineupNotice :project-slug="slug" />

    <!-- v1.0.269 — Bring your own: paste a finished script or an outline and
         inject it into this episode, skipping format-shaped generation. -->
    <section v-if="form.episode_id" class="card workspace-section byo-card">
      <button class="byo-head" @click="byoOpen = !byoOpen">
        <span><strong>{{ byoOpen ? '▾' : '▸' }} ✍️ Bring your own</strong> — paste a script or outline</span>
        <span class="text-muted text-xs">skip generation; inject directly into the flow</span>
      </button>
      <div v-if="byoOpen" class="byo-body mt-2">
        <div class="form-group">
          <label class="byo-radio"><input type="radio" value="script" v-model="byoMode" /> <strong>Full script</strong> <span class="text-muted text-xs">→ ready for Audio → Subtitles → Scene Plan</span></label>
          <label class="byo-radio"><input type="radio" value="outline" v-model="byoMode" /> <strong>Outline only</strong> <span class="text-muted text-xs">→ then Expand Chapters writes the script</span></label>
        </div>
        <div class="form-group">
          <label>{{ byoMode === 'script' ? 'Script text' : 'Outline — one chapter per line' }}</label>
          <textarea
            v-model="byoText"
            class="textarea"
            rows="10"
            :placeholder="byoMode === 'script'
              ? 'Paste your full script. Use \'## Chapter 1: Title\' headings to split into chapters (and \'# Introduction\' for the intro); with no headings it imports as a single chapter.'
              : 'One chapter per line, e.g.\nChapter 1: The Discovery — they find the cave\nChapter 2: The Descent — climbing down into the dark'"
          />
          <span class="text-muted text-xs">
            {{ byoMode === 'script'
              ? 'Imported as this episode\'s script — overwrites any existing script for it.'
              : 'Imported as an approved outline — overwrites any existing outline. Then use Expand Chapters (Outline tab).' }}
          </span>
        </div>
        <button class="btn btn-primary btn-sm" :disabled="byoImporting || !byoText.trim()" @click="importContent">
          {{ byoImporting ? 'Importing…' : (byoMode === 'script' ? 'Import script' : 'Import outline') }}
        </button>
      </div>
    </section>

    <!-- v1.4.73 — the writing flow here is Outline → Script, and only that.
         The channel opening is its own optional stage in the sidebar; the
         comment that used to sit here claimed the opposite. -->
    <!-- v1.0.117+ — Tabs split out from the one long page that
         previously stacked outline form and chapter list one above the
         other. ?tab= keeps the URL honest so deep
         links + back/forward + refresh land on the same view.
         Default is 'outline' because that's the natural starting point of a
         fresh episode. -->
    <div class="form-tabs workspace-stage-tabs">
      <button
        type="button"
        :class="['form-tab', { active: scriptsTab === 'outline' }]"
        @click="scriptsTab = 'outline'"
      >
        📑 Outline
      </button>
      <button
        type="button"
        :class="['form-tab', { active: scriptsTab === 'script' }]"
        @click="scriptsTab = 'script'"
      >
        📝 Script
      </button>
    </div>

    <!-- Basics live on Outline.
         Hidden on Script tab so chapter regen has the whole pane to
         itself. Title / pattern / character / normalize stay visible
         on the first two tabs so the user always sees what episode
         they're configuring. -->
    <div class="card workspace-section" v-show="scriptsTab === 'outline'">
      <div class="form-group field-medium">
        <label>Episode Title</label>
        <input v-model="form.title" class="input" placeholder="The Whispering Forest" />
      </div>

      <!-- v1.0.165 — Pattern picker removed. The Script Generator's
           shape comes from the project's format + niche; the title
           template (when set on the Ideas page) already shaped the
           title that flows into the script. -->

      <!-- v1.0.176 — Character references are now opt-in. Off by default so
           a normal run is uncluttered + the LLM invents its own cast (the
           common case). Toggle on to pin a persistent cast; the picker only
           appears then. Turning it off clears the selection so an empty
           cast is never sent by accident. -->
      <div v-if="form.episode_id" class="form-group mt-2 field-wide">
        <label class="toggle-label">
          <input type="checkbox" v-model="useCharacters" />
          <span>Use character references</span>
        </label>
        <span class="text-muted text-xs hint-line">
          Off = the AI invents characters as it writes. On = pin a persistent
          cast (names + descriptions) the script must use.
        </span>
        <div v-if="useCharacters" class="mt-2">
          <CharacterPicker
            v-model="form.character_ids"
            :project-slug="slug"
            :episode-code="form.episode_id"
          />
        </div>
      </div>

      <!-- v1.4.73 — the channel opening moved OUT of this tab and onto its
           own page. It was a checkbox here that forgot itself on every
           context reload, drawn only for channels whose niche declared an
           opening profile — one niche of twenty-one. Sidebar → Introduction.
           Do not bring a copy of it back here: there must be exactly one
           place the channel says whether it opens with one. -->

      <!-- v1.0.117+ — Main settings (duration, model, narrator style),
           format context, niche overlay, recency, word counts, and the
           force-regen checkbox all live on the Outline tab. Wrapped in
           one v-show so we can hide the whole block on the Introduction
           tab without juggling per-row toggles. -->
      <div v-show="scriptsTab === 'outline'">

      <!-- Main settings. The Formula chooses the normal narrator; an episode
           can make a deliberate override without making voice selection a
           mandatory decision on every run. -->
      <div class="grid-2 mt-2">
        <div class="form-group">
          <ModelSelector v-model="form.model" :project-slug="slug" @model-meta="onScriptModelMeta" />
          <!-- Published rate for the SELECTED product, never a total: script
               length in tokens is unknown until the model has written it. -->
          <p v-if="selectedChatModel" class="script-rate" :class="`basis-${chatRateNote.basis}`" :title="chatRateNote.title">
            {{ CREDIT_BASIS_LABEL[chatRateNote.basis] }}: {{ chatRateNote.text }} — the total depends on length, and GenStudio reports the actual charge per job.
          </p>
        </div>
        <div class="form-group">
          <label>Formula narrator</label>
          <div class="formula-narrator-summary">
            <strong>{{ activeNarratorLabel }}</strong>
            <span>{{ activeNarratorDescription }}</span>
            <button v-if="availableNarratorStyles.length > 1 || customStyles.length" type="button" class="link-btn" @click="narratorOverrideOpen = !narratorOverrideOpen">
              {{ narratorOverrideOpen ? 'Hide override' : 'Change for this episode' }}
            </button>
          </div>
          <div v-if="narratorOverrideOpen" class="mt-1">
            <select v-model="form.style" class="select">
              <option value="auto">Formula default{{ availableNarratorStyles.length > 1 ? ' (auto-rotate)' : '' }}</option>
              <option v-for="style in availableNarratorStyles" :key="style.id" :value="style.id">
                {{ style.label }}
              </option>
              <optgroup label="Saved custom voices" v-if="customStyles.length">
                <option v-for="cs in customStyles" :key="cs.id" :value="cs.id">{{ cs.name }}</option>
              </optgroup>
              <option value="custom">Write a one-off voice…</option>
            </select>
          </div>
          <div v-if="narratorOverrideOpen && (form.style === 'custom' || showStyleDesc)" class="mt-1">
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
          <button v-if="narratorOverrideOpen && form.style !== 'custom' && form.style !== 'auto' && !showStyleDesc" class="btn-icon style-desc-toggle style-desc-show" @click="showStyleDesc = true">View description</button>
        </div>

      </div>

      <!-- Formula rules are the channel's visible writing contract, applied to
           both the outline and every chapter expansion. -->
      <section v-if="nicheContext || (recencyState && recencyState.enabled)" class="formula-rules-card">
        <div class="formula-rules-head">
          <div>
            <span class="formula-rules-kicker">Formula active</span>
            <strong>{{ nicheContext?.catalogName || nicheContext?.name || 'Project formula' }}</strong>
            <span v-if="nicheContext?.tagline" class="text-muted"> — {{ nicheContext.tagline }}</span>
          </div>
          <span class="formula-rules-summary">{{ scriptContextSummary }}</span>
        </div>

      <!-- Format context — read-only "what kind of script is this" hint.
           Pulls name + summary + recommended ranges from the project's
           effective format JSON; range chips light up amber when the
           user's current input falls outside the recommended envelope —
           purely informational, not a block. -->
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
      <div v-if="nicheContext" class="niche-overlay-card">
        <div class="niche-overlay-head">
          <span class="niche-overlay-icon" aria-hidden="true">🎯</span>
          <div class="niche-overlay-text">
            <strong>Writing rules for {{ nicheContext.catalogName || nicheContext.name }}</strong>
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
            <strong>+{{ nicheContext.scriptStructure.additionalRules.length }}</strong> Formula writing rules
          </span>
          <span v-if="nicheContext.perspectivePolicy" class="niche-chip">
            Voice <strong>{{ nicheContext.perspectivePolicy }}</strong>
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
            <h5 class="niche-overlay-h">Writing rules — used for the outline and every chapter</h5>
            <ul class="niche-overlay-list">
              <li v-for="(r, i) in nicheContext.scriptStructure.additionalRules" :key="i">{{ r }}</li>
            </ul>
          </div>
          <div v-if="nicheContext.narrativeQualityContract" class="niche-overlay-block">
            <h5 class="niche-overlay-h">Human-writing contract</h5>
            <p>{{ nicheContext.narrativeQualityContract.openingPolicy }}</p>
            <ul v-if="nicheContext.narrativeQualityContract.requiredHabits?.length" class="niche-overlay-list">
              <li v-for="habit in nicheContext.narrativeQualityContract.requiredHabits" :key="habit">{{ habit }}</li>
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
          <NuxtLink
            v-if="recencyState.log_size > 0"
            :to="`/projects/${slug}/recency`"
            class="link-btn recency-toggle"
            title="Manage every recency entry on this project — search, filter, remove individual items"
          >Manage log →</NuxtLink>
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

      </section>

      <!-- The one optional episode-specific creative control. Formula rules
           above remain fixed; this adds the particular direction for this run. -->
      <div class="guidance-card">
        <div class="guidance-head">
          <label for="manual-guidance" class="guidance-label">
            ✍️ Episode direction <span class="guidance-optional">optional</span>
          </label>
          <span class="guidance-count" :class="{ 'over': form.manual_guidance.length > MANUAL_GUIDANCE_MAX }">
            {{ form.manual_guidance.length }}/{{ MANUAL_GUIDANCE_MAX }}
          </span>
        </div>
        <p class="guidance-help text-muted text-xs">
          A concrete creative instruction for this episode. It is saved with the outline and carried into
          every chapter: a setting, angle, fact to foreground, or detail to avoid.
        </p>
        <textarea
          id="manual-guidance"
          v-model="form.manual_guidance"
          class="input guidance-textarea"
          rows="3"
          :maxlength="MANUAL_GUIDANCE_MAX"
          placeholder="e.g. Keep the economics grounded in a small neighbourhood cafe; foreground difficult trade-offs, not generic success advice."
        ></textarea>
      </div>

      <!-- Word count section — v1.0.168: TWO real inputs in order
           (1 chapters → 2 words/chapter). Total words + estimated duration
           are DERIVED and read-only. Editing chapters never rewrites your
           per-chapter target; duration is informational only. -->
      <div class="word-count-section">
        <p class="text-muted text-sm mb-1">
          Set <strong>{{ sectionLabel.plural }}</strong>, then <strong>words per {{ sectionLabel.singular }}</strong>.
          Total words and duration update automatically — changing one input never rewrites the other.
        </p>
        <div class="grid-4">
          <div class="form-group">
            <label>1 · {{ sectionLabel.Plural }}</label>
            <input v-model.number="form.chapters" class="input" type="number" min="1" max="30" @input="onChaptersChange" />
            <span class="sizing-sub text-muted">How many {{ sectionLabel.plural.toLowerCase() }} to write.</span>
          </div>
          <div class="form-group">
            <label>2 · Words / {{ sectionLabel.Singular }}</label>
            <input v-model.number="form.words_per_chapter" class="input" type="number" min="100" @input="onWordsPerChapterChange" />
            <span class="sizing-sub text-muted">Target length of each {{ sectionLabel.singular.toLowerCase() }}.</span>
          </div>
          <div class="form-group">
            <label>Total words <span class="calc-badge">derived</span></label>
            <div class="estimate-box">{{ form.total_words.toLocaleString() }}</div>
            <span class="sizing-sub text-muted">{{ form.chapters }} × {{ form.words_per_chapter.toLocaleString() }} / {{ sectionLabel.singular.toLowerCase() }}</span>
          </div>
          <div class="form-group">
            <label>Est. duration <span class="calc-badge">info only</span></label>
            <div class="estimate-box">≈ {{ estimatedDuration }} min</div>
            <span class="sizing-sub text-muted">at ~{{ wordsPerMinute }} w/min · does not control generation</span>
          </div>
        </div>
        <div class="word-summary">
          <strong>{{ form.chapters }}</strong> {{ sectionLabel.plural }}
          × <strong>{{ form.words_per_chapter.toLocaleString() }}</strong> words/{{ sectionLabel.singular }}
          = <strong>{{ form.total_words.toLocaleString() }}</strong> story body
          <template v-if="channelIntroEnabled"> + <strong>~{{ channelIntroWordTarget }}</strong> intro</template>
          = <strong class="text-accent">~{{ totalOutput.toLocaleString() }} total (~{{ estimatedTotalDuration }} min)</strong>
        </div>
        <p class="sizing-scale text-muted">
          Rough guide at ~{{ wordsPerMinute }} w/min:
          1,000 words ≈ {{ Math.round(1000 / wordsPerMinute) }} min ·
          5,000 ≈ {{ Math.round(5000 / wordsPerMinute) }} min ·
          10,000 ≈ {{ Math.round(10000 / wordsPerMinute) }} min.
          Duration is a reference estimate — it does not control generation.
        </p>

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

      <div class="script-regeneration-controls">
        <div class="script-regeneration-copy">
          <label class="checkbox-label">
            <input type="checkbox" v-model="form.force" />
            <strong>Force regenerate</strong>
          </label>
          <span class="text-muted text-xs">
            Overwrites the existing outline. Per-chapter regeneration remains available on the Script tab.
          </span>
        </div>
      </div>

      </div><!-- /Outline-only main-settings block -->
    </div>

    <!-- v1.0.117+ — Outline mismatch banners + OutlineReviewPanel only
         render on the Outline tab. Hidden on Introduction + Script. -->
    <div v-show="scriptsTab === 'outline'">

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

    </div><!-- /Outline tab -->

    <!-- v1.0.117+ — Script tab: per-chapter regen + script preview. -->
    <div v-show="scriptsTab === 'script'">

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

    </div><!-- /Script tab -->

    <!-- Save custom style preset modal (replaces blocked window.prompt) -->
    <div v-if="showSaveStyle" class="modal-overlay" @click.self="showSaveStyle = false">
      <div class="modal-small">
        <h3>Save style preset</h3>
        <p class="text-muted text-sm mt-1 mb-2">Give this narrator style a name so you can reuse it.</p>
        <input
          v-model="newStyleName"
          class="input"
          placeholder="e.g. Cozy Grandma, Dark Noir"
          @keyup.enter.stop.prevent="confirmSaveCustomStyle"
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
import { DEFAULT_EXCLUDE_KEYS } from '~/composables/usePresets'
import {
  canSubmitScriptOutline,
  effectiveFormatPathForEpisode,
  refreshScriptFormatState,
  scriptOutlineSubmissionParams,
  type ScriptFormatContext,
  type ScriptFormatRefreshState,
  type ScriptNarratorStyleOption,
} from '~/utils/scriptSizing'
import { CREDIT_BASIS_LABEL, describeChatRate } from '~/utils/genstudio-credit-cost'
// The preset controllers and several channel-level loaders intentionally
// capture the project slug at setup time. A new page instance on project
// navigation keeps those stores and the channel Introduction policy scoped to
// the channel that loaded them.
definePageMeta({ layout: 'dashboard', key: route => String(route.params.slug || '') })
useAppTitle('Script Generator')
const route = useRoute()
const _router = useRouter()
const slug = computed(() => route.params.slug as string)

// The writing flow has two stages. Legacy ?tab=introduction links now land
// on Outline, where the optional channel opening is configured inline.
const scriptsTab = ref<'outline' | 'script'>(route.query.tab === 'script' ? 'script' : 'outline')
watch(() => route.query.tab, (v) => {
  const next = v === 'script' ? 'script' : 'outline'
  if (next !== scriptsTab.value) scriptsTab.value = next
})
watch(scriptsTab, (v) => {
  const cur = String(route.query.tab || 'outline')
  if (cur === v) return
  _router.replace({ query: { ...route.query, tab: v } })
})

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
const freshScriptAction = useFreshGenerationAction()
const { success, info: showInfo, error: showError } = useToast()
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

// v1.0.269 — Bring-your-own content import (full script or outline).
const byoOpen = ref(false)
const byoMode = ref<'script' | 'outline'>('script')
const byoText = ref('')
const byoImporting = ref(false)
async function importContent(): Promise<void> {
  if (!form.episode_id || !byoText.value.trim()) return
  byoImporting.value = true
  try {
    const ep = form.episode_id
    if (byoMode.value === 'script') {
      const r = await post<{ chapters: number; introduction: boolean }>(
        `/projects/${slug.value}/episodes/${ep}/import-script`,
        { title: form.title, text: byoText.value },
      )
      success(`Imported script — ${r.chapters} chapter(s)${r.introduction ? ' + intro' : ''}. Ready for Audio → Subtitles → Scene Plan.`)
      previewRefreshKey.value++   // refresh Chapter list + Script preview
    } else {
      const r = await post<{ chapters: number }>(
        `/projects/${slug.value}/episodes/${ep}/import-outline`,
        { title: form.title, text: byoText.value },
      )
      success(`Imported outline — ${r.chapters} chapter(s). Use Expand Chapters on the Outline tab.`)
      outlineRefreshKey.value++   // refresh the outline review panel
      scriptsTab.value = 'outline'
    }
    byoText.value = ''
    byoOpen.value = false
    refetchEpisodeStatus()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Import failed')
  } finally {
    byoImporting.value = false
  }
}

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
  style: string | null
  perspective: string | null
  customPerspective: string | null
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
  if (payload.style) form.style = payload.style
  if (payload.perspective) form.perspective = payload.perspective
  if (payload.customPerspective !== null) form.custom_perspective = payload.customPerspective
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
const durationSelect = ref('custom')
const showStyleDesc = ref(false)
const customStyleText = ref('')
const narratorOverrideOpen = ref(false)

const customStyles = ref<Array<{ id: string; name: string; description: string }>>([])

const MANUAL_GUIDANCE_MAX = 2000

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
  length: Number(route.query.length) || 0,
  // The live GenStudio picker selects the first usable catalog model. Do not
  // seed a retired direct-provider id here: a persisted preference is restored
  // first and then validated/healed against that same live catalog.
  model: '',
  style: 'auto',
  creative_mode: 'guided' as 'strict' | 'guided' | 'open',
  creative_direction: '',
  perspective: 'auto',
  custom_perspective: '',
  chapters: Number(route.query.chapters) || 0,
  total_words: 0,
  words_per_chapter: 0,
  generate_image_prompts: false,
  generate_youtube_desc: false,
  force: false,
  // v1.0.165 — pattern_id / pattern_subject removed with the Pattern
  // system. Title shaping now happens at idea-time via the Ideas page's
  // title-template field; the script generator reads format + niche.
  // Character primitive (Phase 5): optional cast — selected ids flow through
  // /generate/script-only so the LLM uses these names + descriptions.
  character_ids: [] as string[],
  // v1.0.297 — optional free-text producer guidance. Injected into the outline
  // + every chapter prompt: ad-hoc character names, a setting, tone notes, or
  // names to AVOID. Spread into the outline-only request by submitOutline, so
  // adding it here is all that's needed to send it.
  manual_guidance: '',
})

// v1.0.259 — remember the generation "how" across reloads. Allowlist ONLY the
// global knobs: length / chapters / total_words / words_per_chapter come from
// the idea per-episode (route query), and character_ids / force are per-run, so
// none of those are persisted.
useRememberedForm('scripts', slug, form, {
  include: ['model', 'style', 'generate_image_prompts', 'generate_youtube_desc'],
})

// Saved model ids are only preferences. Keep every generation action disabled
// until ModelSelector has confirmed a currently usable GenStudio catalog entry.
// This prevents an old persisted model id from enqueueing a job before the
// picker replaces it with the live fallback.
const scriptModelReady = ref(false)
function onScriptModelMeta(model: unknown): void {
  scriptModelReady.value = !!model
}

// v1.0.176 — character references are opt-in. Default OFF; the toggle reveals
// the picker. Turning it off clears any selection so an outdated cast can't
// leak into a run the user thinks is cast-free. Auto-enables when a loaded
// episode already carries characters (so editing an existing pick still
// shows it).
const useCharacters = ref(false)
watch(useCharacters, (on) => {
  if (!on && form.character_ids.length) form.character_ids = []
})
watch(() => form.character_ids.length, (n) => {
  if (n > 0 && !useCharacters.value) useCharacters.value = true
})

// Look up the project's current format id so the section-label
// vocabulary (Chapter / Topic / Section) resolves correctly. Loads
// once on mount + when slug changes; project-meta arrival triggers the
// watcher that hydrates formatId.
const projectFormatId = ref('scenes')
const { project } = useProject()
watch(project, (p) => {
  if (!p) return
  const id = (p as any).format_id
  if (typeof id === 'string' && id) {
    projectFormatId.value = id
  } else {
    // In practice every project has a format_id (set at create time);
    // this branch only fires on data-corruption / partial-write edge
    // cases. Section labels fall back to the narrative default.
    console.warn('[scripts.vue] project.format_id missing — falling back to narrative for section labels. Set a format in Settings → Format if this is unexpected.')
    projectFormatId.value = 'scenes'
  }
}, { immediate: true })

// v1.0.82+: format-aware section labels for the UI ("Chapter" for sleep-story,
// "Reason" for reasons-explainer, "Topic" for listicle). The composable reads
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
const formatContext = ref<ScriptFormatContext | null>(null)
type NarratorStyleOption = ScriptNarratorStyleOption

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
  catalogName?: string
  tagline?: string
  perspectivePolicy?: string
  narrativeQualityContract?: {
    openingPolicy?: string
    requiredHabits?: string[]
  }
  openingProfile?: {
    id: string
    label: string
    description: string
  }
  productionKit?: {
    episodeProfiles?: Array<{
      id: string
      label: string
      description: string
      ideaAxisValue: string
      narratorStyleId?: string
    }>
  }
  scriptStructure?: {
    defaultChapterCount?: number
    chapterCountRange?: [number, number]
    pacingArc?: string[]
    additionalRules?: string[]
  }
}
const nicheContext = ref<NicheContext | null>(null)
const showNicheOverlayDetail = ref(false)
const activeEpisodeProfile = computed(() => {
  const axisValue = selectedEpisode.value?.idea_dimensions?.['episode-profile']
    || selectedEpisode.value?.episode_profile
  if (!axisValue) return undefined
  return nicheContext.value?.productionKit?.episodeProfiles?.find(
    profile => profile.ideaAxisValue === axisValue,
  )
})
const availableNarratorStyles = computed<NarratorStyleOption[]>(() => formatContext.value?.narratorStyles || [])
const selectedNarratorStyle = computed<NarratorStyleOption | undefined>(() => {
  const styles = availableNarratorStyles.value
  if (!styles.length) return undefined
  if (form.style === 'auto') {
    const preferred = activeEpisodeProfile.value?.narratorStyleId
      || formatContext.value?.defaultNarratorStyleId
    return styles.find(style => style.id === preferred) || styles[0]
  }
  return styles.find(style => style.id === form.style)
})
const selectedCustomNarrator = computed(() => customStyles.value.find(style => style.id === form.style))
const activeNarratorLabel = computed(() => {
  if (form.style === 'custom') return 'One-off narrator direction'
  if (selectedCustomNarrator.value) return `Episode override — ${selectedCustomNarrator.value.name}`
  const selected = selectedNarratorStyle.value
  if (!selected) return 'Formula-controlled narrator'
  if (form.style === 'auto') {
    if (activeEpisodeProfile.value) {
      return `Formula profile — ${activeEpisodeProfile.value.label} · ${selected.label}`
    }
    return availableNarratorStyles.value.length > 1
      ? `Formula rotation — ${selected.label}`
      : `Formula default — ${selected.label}`
  }
  return `Episode override — ${selected.label}`
})
const activeNarratorDescription = computed(() => {
  if (form.style === 'custom') return 'Write a temporary narrator direction for this episode only.'
  if (form.style === 'auto' && activeEpisodeProfile.value) {
    return `${activeEpisodeProfile.value.description} Narrator: ${selectedNarratorStyle.value?.description || selectedNarratorStyle.value?.label || 'Formula default'}.`
  }
  return selectedCustomNarrator.value?.description
    || selectedNarratorStyle.value?.description
    || 'The active Formula supplies the narrator, point of view, and opening policy.'
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

// A concise, always-visible summary for the Formula contract.
const scriptContextSummary = computed<string>(() => {
  const fmt = formatContext.value?.name || 'format'
  const topic = nicheContext.value?.name || 'none'
  return `${fmt} · Topic: ${topic} · ${form.chapters} ${sectionLabel.value.plural.toLowerCase()} × ${form.words_per_chapter} words`
})

// A custom saved voice keeps its description editable; Formula voices are
// shown from the live effective-format payload rather than a stale UI list.
watch(() => form.style, (s) => {
  if (s === 'custom') {
    customStyleText.value = ''
    showStyleDesc.value = true
  } else {
    const cs = customStyles.value.find(c => c.id === s)
    customStyleText.value = cs?.description || ''
    showStyleDesc.value = false
  }
})

/**
 * v1.4.73 — whether this channel opens with an Introduction is READ, never
 * held here.
 *
 * What stood here was a page-local `reactive` that initialised `enabled` to
 * false, plus a watcher that forced it back to false every time the niche
 * context reloaded. Those two together WERE the defect: the page invented a
 * home for the answer because the answer had no home, and then reset it.
 * Intent now lives on the channel (Sidebar → Introduction) and this page only
 * asks what it says. Do not reintroduce local intro state here.
 */
const channelIntroEnabled = ref(false)
const channelIntroWordTarget = ref(0)
async function loadChannelIntroduction(): Promise<void> {
  try {
    const data = await get<{ segments?: Record<string, { enabled: boolean; recipe: { word_target: number } }> }>(
      `/projects/${slug.value}/segments`)
    const introduction = data.segments?.introduction
    channelIntroEnabled.value = introduction?.enabled === true
    channelIntroWordTarget.value = introduction?.recipe?.word_target || 0
  } catch {
    // Unreadable settings must not make this page claim the channel opens
    // with something. The Introduction page is where that is fixed.
    channelIntroEnabled.value = false
  }
}
onMounted(loadChannelIntroduction)

// ── Presets ─────────────────────────────────────────────────────────────
// Two typed pools sharing the 'script' configKey:
//   - scriptPresets  → just chapter settings (form + custom style text)
// Legacy presets saved before typing are untyped; applying one still
// restores whichever fields are present in `data`.
//
// v1.4.73 — the opening's recipe is NOT preset state any more. A preset is a
// snapshot of a moment; how this channel opens is a property of the channel.
// Keeping it here meant an unattended batch wrote whatever shape was captured
// the last time somebody pressed Save while the page showed something else.
// It lives on the channel now — Sidebar → Introduction.
const scriptPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'script',
  presetType: 'script',
  // Snapshot captures every chapter-writing field on this page so reloading
  // the preset restores the visible form 1:1. `intro` / `introBeats` on an
  // older saved preset are simply ignored — see the note above.
  // OWNER DECISIONS, 2026-09-20 (#10):
  //   `force`           — a per-run switch. A preset restoring `force: true`
  //                       would silently OVERWRITE existing work on the next
  //                       apply, which no reading of the decision permits.
  //   `manual_guidance` — the episode's written direction. Excluded; text meant
  //                       to persist goes in the channel-specific box instead.
  //   `character_ids`   — deliberately KEPT. The cast is channel/series-level
  //                       and the same across episodes, so restoring it is the
  //                       point of the preset.
  // The spread is load-bearing: `excludeKeys` REPLACES the default list, so
  // omitting it would start snapshotting `episode_id` again.
  excludeKeys: [...DEFAULT_EXCLUDE_KEYS, 'force', 'manual_guidance'],
  snapshot: () => ({
    form: { ...form },
    customStyleText: customStyleText.value,
  }),
  apply: (data) => {
    if (data.form) Object.assign(form, data.form)
    if (typeof data.customStyleText === 'string') customStyleText.value = data.customStyleText
    // A saved script preset is explicit sizing intent. Without this flag,
    // the next episode-selected event replaced values such as 3 × 1,000
    // with that episode's older generated suggestion.
    userTouchedSizing.value = true
  },
})


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
async function applyScriptFormatDefaultsIfNoPreset(episodeId = form.episode_id, episode?: any) {
  // Skip if URL pinned both — caller intent dominates the format default.
  const urlLength = route.query.length
  const urlChapters = route.query.chapters
  const lengthFromUrl = urlLength !== undefined && urlLength !== null && urlLength !== ''
  const chaptersFromUrl = urlChapters !== undefined && urlChapters !== null && urlChapters !== ''
  try {
    const state = {
      get selectedEpisodeCode() { return form.episode_id },
      set selectedEpisodeCode(value: string) { form.episode_id = value },
      get sizingTouched() { return userTouchedSizing.value },
      set sizingTouched(value: boolean) { userTouchedSizing.value = value },
      get chapters() { return form.chapters },
      set chapters(value: number) { form.chapters = value },
      get wordsPerChapter() { return form.words_per_chapter },
      set wordsPerChapter(value: number) { form.words_per_chapter = value },
      get formatContext() { return formatContext.value },
      set formatContext(value: ScriptFormatContext | null) { formatContext.value = value },
    } satisfies ScriptFormatRefreshState
    const applied = await refreshScriptFormatState({
      state,
      requestedEpisodeCode: episodeId,
      load: () => get<any>(effectiveFormatPathForEpisode(slug.value, episodeId)),
      suggestedChapters: episode?.suggested_chapters,
      suggestedLength: lengthFromUrl ? route.query.length : episode?.suggested_length,
      chaptersPinned: chaptersFromUrl,
    })
    if (!applied) return
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
          catalogName: typeof n.catalogName === 'string' ? n.catalogName : undefined,
          tagline: typeof n.tagline === 'string' ? n.tagline : undefined,
          perspectivePolicy: typeof n.perspectivePolicy === 'string' ? n.perspectivePolicy : undefined,
          narrativeQualityContract: n.narrativeQualityContract && typeof n.narrativeQualityContract === 'object'
            ? {
                openingPolicy: typeof n.narrativeQualityContract.openingPolicy === 'string'
                  ? n.narrativeQualityContract.openingPolicy
                  : undefined,
                requiredHabits: Array.isArray(n.narrativeQualityContract.requiredHabits)
                  ? n.narrativeQualityContract.requiredHabits.filter((habit: unknown): habit is string => typeof habit === 'string')
                  : undefined,
              }
            : undefined,
          openingProfile: n.openingProfile && typeof n.openingProfile === 'object'
            && typeof n.openingProfile.id === 'string'
            && typeof n.openingProfile.label === 'string'
            && typeof n.openingProfile.description === 'string'
            ? {
                id: n.openingProfile.id,
                label: n.openingProfile.label,
                description: n.openingProfile.description,
              }
            : undefined,
          productionKit: n.productionKit && typeof n.productionKit === 'object'
            ? n.productionKit
            : undefined,
          scriptStructure: n.scriptStructure || undefined,
        }
      } else {
        nicheContext.value = null
      }
    } catch {
      nicheContext.value = null
    }
  } catch {
    // Format endpoint unavailable / project missing — preserve whatever the
    // owner already entered and wait for an authoritative refresh. Non-fatal.
  }
}

onMounted(async () => {
  // Defer heavy panel mount to next tick so the v-if'd panels don't race
  // with NuxtPage's RouterView slot resolution mid-navigation. See
  // panelsReady declaration above.
  await nextTick()
  panelsReady.value = true
  // Live language catalogue, so the published rate below the model selector
  // is the selected product's own and never a remembered constant.
  void refreshGenStudioChatModels()
  await applyScriptFormatDefaultsIfNoPreset()
  await scriptPresets.load()
  // v1.0.106+ — load the recency state for the avoidance strip. After
  // generation completes the executor appends to the log; we refresh
  // here so the strip + count reflect what's on disk.
  await loadRecencyState()
})

// v1.4.73 — the beat list, its placeholders and the separate "introduction"
// preset pool all lived here. They are the opening's recipe, which now
// belongs to the channel and is edited on its own page. Nothing on this page
// describes how an opening is written any more.

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

// v1.0.115+ — per-episode "is a script-related job in flight" computed.
// The global `scriptGenerating` (from useGenerating) stays true as long
// as ANY script job is queued/running, so its status text leaked into
// pages where the current episode wasn't the one actually generating.
// This narrows it to the episode currently selected here.
const scriptJobActiveForEpisode = computed(() => {
  if (!form.episode_id) return false
  return jobs.value.some((j: any) =>
    j.episode_id === form.episode_id &&
    j.project_slug === slug.value &&
    watchedScriptTypes.has(j.type) &&
    (j.status === 'queued' || j.status === 'running'),
  )
})

// Defensive — clear `submitting` on episode swap.
watch(() => form.episode_id, (newEp, oldEp) => {
  if (newEp !== oldEp) submitting.value = false
})

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
// re-fetching `/projects/:slug/episodes` on every swap. On a large
// channel (380+ episodes) the full-list fetch took 30s+, blocking the page
// from showing fresh data on every dropdown change. The cache is
// already warm from the EpisodeSelector mount, so a swap is now an
// O(N) array find — instant. Auto-revalidates on `done` job events
// inside the composable, so freshness after generations is handled
// without an explicit refetch here.
const { episodes: cachedEpisodeList, refresh: refreshEpisodeCache } = useEpisodes(slug)

let episodeStatusSequence = 0

async function refetchEpisodeStatus() {
  const targetSlug = slug.value
  const targetEpisode = form.episode_id
  const requestSequence = ++episodeStatusSequence
  if (!targetEpisode) {
    selectedEpisode.value = null
    return
  }
  // Eligibility below is read from selectedEpisode.status. Clear a previous
  // episode before any async refresh so a failed B load cannot leave A's
  // script/introduction state authorizing actions for B.
  if (selectedEpisode.value?.episode_code !== targetEpisode) selectedEpisode.value = null
  // 1. Fast path: the shared cache already has every episode.
  const cached = cachedEpisodeList.value.find((e: any) => e.episode_code === targetEpisode)
  if (cached) {
    if (slug.value !== targetSlug || form.episode_id !== targetEpisode || requestSequence !== episodeStatusSequence) return
    selectedEpisode.value = cached
    return
  }
  // 2. Cold cache (deep-link, fresh tab) → trigger a refresh through
  //    the composable. Returns when the cache fills; downstream reads
  //    pick up the value reactively.
  try {
    await refreshEpisodeCache()
    if (slug.value !== targetSlug || form.episode_id !== targetEpisode || requestSequence !== episodeStatusSequence) return
    const fresh = cachedEpisodeList.value.find((e: any) => e.episode_code === targetEpisode)
    if (fresh) selectedEpisode.value = fresh
  } catch { /* the cleared state is safer than showing another episode */ }
}

// Fetch on initial mount + any time the episode id changes (deep-link from
// the dashboard, preset apply, etc.). EpisodeSelector only emits its own
// event when the user picks from the dropdown, so without this, deep-links
// would leave selectedEpisode null and `scriptGenerated` stuck at false.
watch(() => form.episode_id, (id) => {
  if (id) void refetchEpisodeStatus()
  else {
    episodeStatusSequence++
    selectedEpisode.value = null
  }
}, { immediate: true })

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

const totalOutput = computed(() =>
  form.total_words + (channelIntroEnabled.value ? channelIntroWordTarget.value : 0)
)
const estimatedDuration = computed(() =>
  Math.round(form.total_words / wordsPerMinute.value)
)
const estimatedTotalDuration = computed(() =>
  Math.round(totalOutput.value / wordsPerMinute.value)
)
const canSubmit = computed(() => {
  if (!scriptModelReady.value) return false
  return canSubmitScriptOutline({
    modelReady: true,
    episodeId: form.episode_id,
    title: form.title,
    sizingDeferred: !userTouchedSizing.value,
    sizing: {
      length: form.length,
      chapters: form.chapters,
      total_words: form.total_words,
      words_per_chapter: form.words_per_chapter,
    },
  })
})

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
// v1.0.168 — Sizing model. TWO inputs only: chapter count + words-per-chapter.
// Total words + the duration estimate are DERIVED and read-only. There is no
// cross-recalc — changing the chapter count NEVER rewrites your per-chapter
// word target, and duration is informational (total ÷ words-per-minute), no
// longer a control. A single one-directional watcher keeps the derived
// fields in sync from the two inputs (also covers preset/outline restore +
// format-switch, where chapters/wpc change programmatically). Writing
// total_words/length inside the watcher never retriggers it, so no loop.
function recomputeDerivedSizing() {
  const ch = form.chapters > 0 ? form.chapters : 0
  const wpc = form.words_per_chapter > 0 ? form.words_per_chapter : 0
  form.total_words = ch * wpc
  form.length = wordsPerMinute.value > 0 ? Math.round(form.total_words / wordsPerMinute.value) : 0
}

// Retained: tells the page the user has taken control of sizing, so format
// defaults + episode-swap suggestions stop overwriting their numbers.
const userTouchedSizing = ref(false)
// Retained for back-compat with code that references primaryField; with the
// derived model there is no longer a "primary" field, but the ref keeps
// existing call sites (e.g. setChaptersTo* helpers) compiling.
const primaryField = ref<'chapters' | 'words_per_chapter' | 'total_words'>('words_per_chapter')

// The two inputs only flag user control — they do NOT touch each other.
function onChaptersChange() {
  userTouchedSizing.value = true
}
function onWordsPerChapterChange() {
  userTouchedSizing.value = true
}

// Derived fields follow the two inputs (and the format's words-per-minute)
// one-directionally. immediate => correct on first paint.
watch(
  [() => form.chapters, () => form.words_per_chapter, wordsPerMinute],
  () => recomputeDerivedSizing(),
  { immediate: true },
)

/**
 * Call shape for chunked-mode script generation (v1.0.71+).
 *
 * This reports HOW MANY calls the expansion will make, and nothing about what
 * they will cost. A script's charge is token-priced and the output length is
 * not known until the model has written it, so no honest total exists before
 * the run. The published per-token rate for the SELECTED product is shown
 * separately by `chatRateNote`, and GenStudio reports the actual charge on the
 * finished job.
 *
 * The previous version of this function multiplied a guessed token count by a
 * hardcoded Sonnet USD price. That was wrong twice over: GenStudio bills in
 * credits, not dollars, and the rate belonged to a model the user may not have
 * selected. Do not reintroduce a locally computed total here.
 */
function estimateChunkedCalls(chapters: number): {
  batches: number; expansionCalls: number
} {
  // Narrative expansion writes ~3 chapters per call; listicles batch 8. The
  // narrative figure is the one reported because it is the larger call count.
  const expansionCallsNarrative = Math.ceil(chapters / 3)
  return {
    batches: 1 + expansionCallsNarrative,
    expansionCalls: expansionCallsNarrative,
  }
}

const { models: genStudioChatModels, refresh: refreshGenStudioChatModels } = useGenStudioChatModels()
const selectedChatModel = computed(() => genStudioChatModels.value.find(model => model.id === form.model))
/**
 * The published rate for the selected language product, recomputed whenever
 * that selection changes. Never a total — see `describeChatRate`.
 */
const chatRateNote = computed(() => describeChatRate(selectedChatModel.value))

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

async function onEpisodeSelected(ep: any) {
  // Capture the full episode object so `scriptGenerated` (computed off
  // ep.status.script) reflects API truth for this episode immediately.
  selectedEpisode.value = ep
  const episodeCode = ep.episode_code || form.episode_id
  if (ep.episode_code) form.episode_id = ep.episode_code
  await applyScriptFormatDefaultsIfNoPreset(episodeCode, ep)
  if (episodeCode !== form.episode_id) return
  // Title always tracks the picked episode — it's tied 1:1 to ep identity
  // and the user wouldn't expect their last episode's title to follow them
  // to a new pick.
  form.title = ep.title
}

async function submitOutline(): Promise<boolean> {
  // Generate the OUTLINE only — Phase 3 of the outline-first refactor.
  // Replaces the legacy submitScript (which POSTed /generate/script-only,
  // running outline + expansion in one opaque job). Now we POST
  // /generate/outline-only first; the user reviews/edits in
  // OutlineReviewPanel then triggers expansion from there.
  //
  // Returns true if the outline_only job reached 'done', false otherwise.
  const params: Record<string, any> = {
    ...scriptOutlineSubmissionParams(form, !userTouchedSizing.value),
    // Formula-owned episode profiles resolve Auto into a stable narrator
    // before the outline snapshot is saved. Chapter expansion therefore uses
    // the same voice without exposing another per-run selector.
    style: form.style === 'auto'
      ? (activeEpisodeProfile.value?.narratorStyleId || 'auto')
      : form.style,
    custom_style_text: customStyleText.value,
    // The old hidden creative-freedom fields are deliberately neutralised.
    // Episode direction is the single visible per-run writing instruction.
    creative_mode: 'guided',
    creative_direction: '',
  }
  // When enabled, the channel opening is generated only after the approved
  // outline has become completed chapters; it never has to be toggled again.
  autoIntroAfterScript.value = channelIntroEnabled.value

  // v1.0.71: chunked-mode pre-flight. When the target wordcount exceeds
  // ~10k words, expansion will issue MULTIPLE LLM calls (one per batch).
  // Surface a rough estimate now so the user understands the eventual
  // cost — the outline build itself is a single cheap call, but the
  // user sees the full picture upfront. Skipped below threshold.
  const targetWords = (form.chapters || 0) * (form.words_per_chapter || 0)
  if (targetWords > CHUNK_THRESHOLD_WORDS) {
    const estimate = estimateChunkedCalls(form.chapters || 0)
    const ok = await ask({
      title: 'Long script — chunked outline + expansion',
      message:
        `${form.chapters} chapters × ${form.words_per_chapter.toLocaleString()} words ` +
        `(~${targetWords.toLocaleString()} words total).\n\n` +
        `Step 1 (this click): build outline — 1 LLM call.\n` +
        `Step 2 (after you review): expand into ${estimate.expansionCalls} batch${estimate.expansionCalls === 1 ? '' : 'es'}.\n\n` +
        // The rate GenStudio publishes for the selected product, and an
        // explicit refusal to invent a total: script length in tokens is not
        // known until the model has written it.
        `Rate: ${chatRateNote.value.text}.\n` +
        `The total depends on how long the prompts and the written text turn out to be, ` +
        `so no up-front figure is shown. GenStudio reports the actual charge on each finished job — see Usage.\n\n` +
        `Each chapter is written to disk as soon as it's generated, so cancel / crash / restart preserves partial work.`,
      confirmLabel: 'Generate outline',
      cancelLabel: 'Cancel',
    })
    if (!ok) return false
  }

  if (!await confirmGeneration(slug.value, 'script', params)) return false
  const operationId = freshScriptAction.begin(params)
  params.operation_id = operationId

  submitting.value = true
  scriptGenerating.value = true
  try {
    const job = await post<{ job_id: string }>(`/projects/${slug.value}/generate/outline-only`, params)
    freshScriptAction.complete(operationId)
    success('Outline build queued — review when it finishes!')
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

async function submitIntroduction(opts: { confirm?: boolean } = { confirm: true }): Promise<boolean> {
  // Generate introduction only (requires script to exist on disk).
  // `opts.confirm` lets generateAll() skip the confirmation dialog for the
  // intro stage — the user already approved the combined run up front.
  //
  // v1.4.73 — nothing about HOW the opening is written is sent. The channel's
  // recipe is read on the server, so this chained run, the Introduction page's
  // own button and an unattended batch all write from identical instructions.
  const params = {
    episode_id: form.episode_id,
    title: form.title,
    model: form.model,
  }
  if (opts.confirm !== false && !await confirmGeneration(slug.value, 'introduction', params)) return false
  const operationId = freshScriptAction.begin(params)

  submitting.value = true
  try {
    const job = await post<{ job_id: string }>(`/projects/${slug.value}/generate/introduction-only`, {
      ...params,
      operation_id: operationId,
    })
    freshScriptAction.complete(operationId)
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

// ── Optional channel opening ────────────────────────────────────────────────
// The Outline flow is intentionally review-first. If this opening is enabled,
// it runs only after the user-approved outline has become completed chapters.
const introDone = computed(() => !!selectedEpisode.value?.status?.introduction)
const autoIntroAfterScript = ref(false)
const pageReadyForAutoIntro = ref(false)
// Fire once when chapters finish, if it was armed on this outline run. Never
// trigger this on a page load for an older completed episode.
watch(scriptGenerated, (now, prev) => {
  if (!pageReadyForAutoIntro.value) return
  if (now && !prev && autoIntroAfterScript.value && channelIntroEnabled.value && !introDone.value && !submitting.value) {
    autoIntroAfterScript.value = false
    success('Channel opening auto-generating…')
    void submitIntroduction({ confirm: false })
  }
})
onMounted(() => { setTimeout(() => { pageReadyForAutoIntro.value = true }, 1500) })
watch(() => selectedEpisode.value?.episode_id, () => { autoIntroAfterScript.value = false })

</script>

<style scoped>
.script-rate { margin: 6px 0 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.4; }
.script-rate.basis-unpublished { color: var(--warning, #d97706); }
.script-rate.basis-free { color: var(--success, #16a34a); }
/* v1.0.269 — bring-your-own import panel */
.byo-card { border: 1px dashed var(--border); }
.byo-head {
  width: 100%; display: flex; align-items: center; justify-content: space-between;
  gap: 12px; background: none; border: none; cursor: pointer; text-align: left;
  color: var(--text-primary); font-size: 14px; padding: 2px 0;
}
.byo-radio { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.byo-body .form-group { margin-top: 10px; }

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

/* Banner shown when intro is enabled but the script hasn't been generated
 * yet. The amber border-left echoes "warning" without using the toast colour. */

/* Custom-style picker — the "Style description" mini-form that appears
 * when the user picks "+ Write custom style…". */
.style-desc-label { margin: 0; font-size: var(--font-xs); }
.style-desc-toggle { font-size: var(--font-xs); }
.style-desc-show { margin-top: 4px; }
.style-textarea { min-height: 50px; font-size: 12px; }

.word-count-section {
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  padding: 16px;
  margin-top: 8px;
}

/* v1.0.297 — Story guidance card. */
.guidance-card {
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  padding: 16px;
  margin-top: 8px;
}
.guidance-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.guidance-label { font-weight: 600; font-size: 14px; }
.guidance-optional {
  font-weight: 400;
  font-size: var(--font-xs);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-left: 4px;
}
.guidance-count { font-size: var(--font-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
.guidance-count.over { color: var(--danger, #e06c75); font-weight: 600; }
.guidance-help { margin: 4px 0 8px; line-height: 1.45; }
.guidance-textarea { width: 100%; resize: vertical; min-height: 64px; font-family: inherit; }
.guidance-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.guidance-foot-hint { flex: 1 1 240px; line-height: 1.4; }

.opening-head-actions,
.formula-narrator-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.formula-narrator-summary {
  min-height: 42px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 6px);
  background: var(--bg-tertiary);
}
.formula-narrator-summary strong { font-size: 13px; }
.formula-narrator-summary span { flex: 1 1 220px; color: var(--text-muted); font-size: 12px; line-height: 1.4; }

.formula-rules-card {
  margin-top: 10px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--border));
  border-radius: var(--radius-md, 10px);
  background: color-mix(in srgb, var(--bg-tertiary) 91%, var(--accent) 9%);
}
.formula-rules-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  padding: 0 4px 4px;
}
.formula-rules-kicker {
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 700;
  letter-spacing: .08em;
  margin-right: 8px;
  text-transform: uppercase;
}
.formula-rules-summary { color: var(--text-muted); font-size: 12px; }

/* Format context — read-only "what kind of script is this" hint card.
   Sits above the word-count inputs so the user sees the format's typical
   envelope (chapter range, duration range, recommended wpc) before they
   override anything. Range chips light up amber via .rec-chip-warn when
   the user's current value is outside the recommended range. */
/* v1.0.174 — Phase-0 page template: collapsible context strip + advanced
   disclosure. This is the pattern the other flow pages will adopt. */
/* v1.0.183 — strip chrome moved to the shared ContextStrip component. Only
   .ctx-key / .ctx-value (used in this page's summary slot) remain. */
.ctx-key { color: var(--text-muted); font-size: var(--font-xs); text-transform: uppercase; letter-spacing: 0.04em; }
.ctx-value { font-weight: 500; }

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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.recency-lookback-input {
  width: 70px;
  padding: 2px 6px;
  font-size: 12px;
}
.recency-lookback-hint {
  font-size: var(--font-xs);
}
.recency-clear {
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.recency-empty {
  margin-top: 8px;
  font-size: var(--font-xs);
  line-height: 1.5;
}
.recency-list-wrap {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid rgba(80, 200, 160, 0.18);
}
.recency-list-h {
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
  letter-spacing: 0.4px;
}
.rec-chip-current {
  color: var(--text-muted);
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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

/* Names the language model the opening will be written with. The opening
 * deliberately has no picker of its own — this line is the answer to
 * "where do I choose the model for this?", not a second control. */







.beat-detail { padding: 2px 10px 10px; border-top: 1px dashed var(--border); }
.btn-icon.has-custom { color: var(--accent); }


.beat-controls {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.beat-controls .btn-icon {
  font-size: var(--font-xs);
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
.formula-voice-note {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
  border-radius: var(--radius-sm, 6px);
  background: color-mix(in srgb, var(--bg-tertiary) 88%, var(--accent) 12%);
  font-size: 12px;
}
.formula-voice-note span { color: var(--text-muted); line-height: 1.45; }
.script-regeneration-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 12px;
  padding: 11px 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 10px);
  background: color-mix(in srgb, var(--bg-secondary) 92%, var(--accent) 8%);
}
.script-regeneration-copy,
.script-maintenance-action {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.script-regeneration-copy .checkbox-label { color: var(--text-primary); white-space: nowrap; }
.script-maintenance-action { justify-content: flex-end; }
@media (max-width: 760px) {
  .script-regeneration-controls,
  .script-regeneration-copy,
  .script-maintenance-action {
    align-items: flex-start;
    flex-direction: column;
  }
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
