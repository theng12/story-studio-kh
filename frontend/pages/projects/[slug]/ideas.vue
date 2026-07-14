<template>
  <div>
    <div class="flex justify-between items-center">
      <div>
        <h1>Ideas Generator</h1>
        <p class="text-muted mt-1">{{ allIdeas.length }} ideas &middot; {{ statusCounts.accepted }} accepted &middot; Next: {{ nextEpisode }}</p>
      </div>
      <div class="flex gap-2">
        <button
          v-if="statusCounts.accepted > 0"
          class="btn btn-secondary btn-sm"
          :disabled="compactState.opening"
          title="Shift accepted episodes backward to fill any gaps in the numbering — e.g. after deleting TN0001-TN0007 from the start, this slides TN0008+ down to TN0001+. Reversible via the Revert banner on the Unlinked Uploads tab for 30 days afterwards."
          @click="openCompactDialog"
        >
          <LoadingSpinner v-if="compactState.opening" size="sm" />
          {{ compactState.opening ? 'Loading…' : '↓ Compact codes' }}
        </button>
      </div>
    </div>

    <!-- v1.0.93+ hydration-error banner. The Ideas page hits two endpoints
         on mount (`/projects/:slug` + `/projects/:slug/settings/config`)
         and the third (`/projects/:slug/ideas`) right after. Failures
         used to be swallowed → "ideas disappeared", "project missing"
         flashes, silent revert to sleep-story format. Now each failure
         mode surfaces with a specific message + recovery action. -->
    <div v-if="hydrationError" class="hydration-banner" :class="`is-${hydrationError.kind}`">
      <template v-if="hydrationError.kind === 'project-missing'">
        <strong>⚠ Project not found.</strong>
        The URL points at <code>{{ slug }}</code> but no project with that slug exists on this Mac.
        <NuxtLink to="/" class="banner-link">← Back to projects</NuxtLink>
      </template>
      <template v-else-if="hydrationError.kind === 'project-fetch'">
        <strong>⚠ Couldn't load project.</strong>
        {{ hydrationError.detail }}
        <button class="banner-link" @click="retryHydration">Retry</button>
      </template>
      <template v-else-if="hydrationError.kind === 'project-no-format'">
        <strong>⚠ No format set on this project.</strong>
        Generation will fall back to <code>sleep-story</code> until you pick one —
        prayer / devotional vocab won't read correctly until a B-Roll Narration
        (or other) format is chosen.
        <NuxtLink :to="`/projects/${slug}/settings#format`" class="banner-link">
          Open Format settings →
        </NuxtLink>
      </template>
      <template v-else-if="hydrationError.kind === 'config-fetch'">
        <strong>⚠ Couldn't load project settings.</strong>
        Your saved topic and title branding may be out of date. {{ hydrationError.detail }}
        <button class="banner-link" @click="retryHydration">Retry</button>
      </template>
    </div>
    <div v-if="ideasLoadError" class="hydration-banner is-ideas-fetch">
      <strong>⚠ Couldn't load ideas:</strong> {{ ideasLoadError }}
      <button class="banner-link" @click="loadIdeas">Retry</button>
    </div>

    <!-- v1.0.117+ — Workflow vs Manage tabs. The page used to be one long
         scroll: generator card on top, then the search/filter/table for
         existing ideas. Users editing the catalog had to scroll past the
         entire generator form every time, and users brainstorming had a
         giant table parked underneath. Splitting into two `v-show` panes
         lets each mode get the screen alone. ?tab= keeps the URL honest
         so deep links / back-forward / refresh land on the same view. -->
    <div class="form-tabs mt-3">
      <button
        type="button"
        :class="['form-tab', { active: ideasTab === 'workflow' }]"
        @click="ideasTab = 'workflow'"
      >
        ✨ Workflow
        <span class="text-muted text-xs ml-1">(generate · promote · import)</span>
      </button>
      <button
        type="button"
        :class="['form-tab', { active: ideasTab === 'manage' }]"
        @click="ideasTab = 'manage'"
      >
        📋 Manage
        <span class="text-muted text-xs ml-1">({{ allIdeas.length }})</span>
      </button>
    </div>

    <!-- ── Workflow tab ────────────────────────────────────────────────── -->
    <div v-show="ideasTab === 'workflow'">

    <!-- Channel "what worked" inspiration. Auto-included server-side in
         the LLM prompt; this card surfaces what's being injected so the
         user can see the vibe reference. Hides silently when no analytics
         data is available. -->
    <TopPerformersInspiration :slug="slug" class="mt-3" />

    <!-- Generator -->
    <div class="generator-panel mt-3">
      <h3 class="generator-title">Generate New Ideas</h3>

      <!-- v1.0.170 — Channel context strip. Replaces the two stacked config
           cards (the old "Effective state" card + the "Format indicator"
           card) that showed Format up to 3× before the form. One quiet line
           summarises the three things that drive generation — Format · Topic
           · Title shape — and an expandable "Change setup" panel holds the
           detail + jump links the old cards carried. The strip turns into a
           RED warning only when something is actually broken (no explicit
           format on the project), preserving the "catch it before you spend
           an API call" safety the old card had. -->
      <!-- v1.0.183 — uses the shared ContextStrip; the summary chips +
           detail panel are page-specific slots. -->
      <ContextStrip
        v-model:open="setupExpanded"
        :has-warning="hasEffectiveStateWarning"
        warn-label="⚠ check setup"
        open-label="▾ Hide setup"
        closed-label="⚙ Change setup"
      >
        <template #summary>
          <span class="context-chip">
            <span class="context-key">Format</span>
            <strong :class="{ 'is-fallback': !projectHasExplicitFormat }">{{ formatDisplayName || formatId || 'unknown' }}</strong>
          </span>
          <span class="context-dot" aria-hidden="true">·</span>
          <span class="context-chip">
            <span class="context-key">Topic</span>
            <strong :class="{ 'is-fallback': !form.niche_id }">{{ form.niche_id || 'none' }}</strong>
            <span v-if="form.niche_id !== projectNicheId" class="context-override">(override)</span>
          </span>
          <span class="context-dot" aria-hidden="true">·</span>
          <span class="context-chip">
            <span class="context-key">Titles</span>
            <strong v-if="titleConfig.prefix || titleConfig.suffix">"{{ titleConfig.prefix }}…{{ titleConfig.suffix }}"</strong>
            <strong v-else class="is-fallback">as-is</strong>
          </span>
        </template>

        <!-- Expandable detail — the content the two old cards carried. -->
          <div class="context-detail-row">
            <span class="context-detail-label">Format</span>
            <strong class="context-detail-value" :class="{ 'is-fallback': !projectHasExplicitFormat }">
              {{ formatDisplayName || formatId || 'unknown' }}
            </strong>
            <span
              v-if="activeFormat"
              class="context-badge"
              :class="activeFormat.builtin ? 'badge-builtin' : 'badge-custom'"
            >{{ activeFormat.builtin ? 'Built-in' : 'Custom' }}</span>
            <span v-if="!projectHasExplicitFormat" class="context-fallback-tag">⚠ no format set — generation falls back to defaults</span>
            <NuxtLink :to="`/projects/${slug}/settings#format`" class="effective-link">Switch format</NuxtLink>
            <NuxtLink
              :to="`/projects/${slug}/settings?newFormat=1#format`"
              class="effective-link subtle"
              title="Open Settings → Format and launch '+ Create from Sample'."
            >+ New custom</NuxtLink>
          </div>
          <p v-if="activeFormat?.description" class="context-detail-desc">{{ activeFormat.description }}</p>
          <p class="context-detail-hint text-muted text-sm">
            All dropdowns + the LLM prompt below pull tone, vocab, and example ideas from this format.
          </p>

          <div class="context-detail-row">
            <span class="context-detail-label">Topic</span>
            <strong class="context-detail-value" :class="{ 'is-fallback': !form.niche_id }">
              {{ form.niche_id || '(none — format defaults only)' }}
            </strong>
            <span v-if="form.niche_id !== projectNicheId" class="context-override-tag">
              override for this batch (project saved: {{ projectNicheId || 'none' }})
            </span>
            <NuxtLink :to="`/projects/${slug}/settings`" @click.prevent="goToNicheTab" class="effective-link">
              Change project topic
            </NuxtLink>
          </div>

          <div class="context-detail-row">
            <span class="context-detail-label">Titles</span>
            <strong v-if="titleConfig.prefix || titleConfig.suffix" class="context-detail-value">
              "{{ titleConfig.prefix }}<em>{{ effectiveStateSampleTitle }}</em>{{ titleConfig.suffix }}"
            </strong>
            <span v-else class="context-detail-value is-fallback">(no branding — titles emitted as-is)</span>
            <span class="text-muted text-xs">Edit the prefix/suffix in the form below.</span>
          </div>
      </ContextStrip>

      <!-- Idea-generator preset.
           Captures the entire form (genre/theme/mood/keywords/count/model,
           pattern, niche override, title prefix/suffix) so a user with
           multiple channel framings ("Morning Prayer", "Evening Prayer",
           "Daily Devotional") can switch between them in one click. Same
           PresetPicker pattern used elsewhere. -->
      <PresetPicker
        label="Ideas preset"
        hint="Saves the niche, prefix/suffix, pattern, mood/theme/audience, and the rest of this form. Pick one and click Apply to load; Save as… to capture the current form."
        :presets="ideasPresets.presets.value"
        :active-id="ideasPresets.activeId.value"
        @update:active-id="ideasPresets.setActive"
        @apply="onIdeasPresetApplied"
        @overwrite="ideasPresets.overwrite(); success('Preset saved')"
        @save-as="(n: string) => ideasPresets.saveAs(n).then(() => success(`Saved: ${n}`))"
        @rename="(n: string) => ideasPresets.rename(n).then(() => success(`Renamed to ${n}`))"
        @delete="ideasPresets.remove(); success('Preset deleted')"
      />

      <!-- v1.0.170 — the standalone "Format Indicator" card was merged into
           the Channel context strip above (Format chip + the expandable
           "Change setup" panel carry its name/badge/description/switch +
           create-custom links). Removing it ends the "Format shown 3×"
           clutter that opened the page. -->

      <p class="text-muted text-sm generator-blurb">
        Pick an audience and a few descriptive fields, then click <strong>Generate Ideas</strong> — you'll get a short list of episode titles to accept or dismiss.
        Not sure where to start? <strong>🎲 Randomize</strong> fills the form for you (no cost until you Generate), or <strong>✨ Surprise Me</strong> does both at once.
      </p>
      <div class="generator-body">
        <!-- v1.0.171 — the form is grouped into three labelled sections so
             the long flat field list reads as distinct decisions:
               1. What to make   — the creative inputs
               2. Topic & titles — subject domain + title shaping/branding
               3. Generation settings — model + per-idea item count
             No fields were removed; everything that existed is still here,
             just grouped + relabelled in plain language (UI text only). -->

        <!-- ── 1. What to make ─────────────────────────────────────────── -->
        <fieldset class="form-section">
          <legend class="form-section-title">What to make</legend>
          <div class="grid-2">
            <div class="form-group">
              <label>
                Audience
                <span v-if="audienceFromFormat" class="vocab-source-tag" :title="`Pulled from ${formatDisplayName} format`">
                  · {{ formatDisplayName }}
                </span>
              </label>
              <ComboInput
                v-model="form.audience"
                :options="audienceOptions"
                placeholder="Pick or type an audience…"
                searchable
                allow-custom
              />
            </div>
            <div class="form-group">
              <label>
                Genre
                <span class="vocab-source-tag" :title="vocabSourceTooltip('genre')">
                  · {{ vocabSourceLabel('genre') }}
                </span>
              </label>
              <ComboInput v-model="form.genre" :options="allGenres" placeholder="Pick or add a genre" searchable allow-custom @add-custom="onAddGenre" />
            </div>
            <div class="form-group">
              <label>
                Theme (optional)
                <span class="vocab-source-tag" :title="vocabSourceTooltip('theme')">
                  · {{ vocabSourceLabel('theme') }}
                </span>
              </label>
              <ComboInput v-model="form.theme" :options="allThemes" placeholder="Pick or add a theme" searchable allow-custom @add-custom="onAddTheme" />
            </div>
            <div class="form-group">
              <label>
                Mood
                <span class="vocab-source-tag" :title="vocabSourceTooltip('mood')">
                  · {{ vocabSourceLabel('mood') }}
                </span>
              </label>
              <ComboInput v-model="form.mood" :options="allMoods" placeholder="Pick or add a mood" searchable allow-custom @add-custom="onAddMood" />
            </div>
          </div>
          <div class="grid-3 mt-2">
            <div class="form-group col-span-2">
              <label>
                Keywords
                <span class="vocab-source-tag" :title="vocabSourceTooltip('keyword')">
                  · {{ vocabSourceLabel('keyword') }}
                </span>
              </label>
              <ChipInput v-model="form.keywords" :suggestions="allKeywords" placeholder="Pick from common keywords or type to add…" allow-custom :max="12" @add-custom="onAddKeyword" />
            </div>
            <div class="form-group">
              <label>How many ideas
                <span class="text-muted" style="font-size: 11px; font-weight: normal;">
                  — episode candidates per click
                </span>
              </label>
              <input v-model.number="form.count" class="input" type="number" min="1" max="15" />
            </div>
          </div>
          <div class="grid-2 mt-2">
            <div class="form-group">
              <label>Creative freedom</label>
              <select v-model="form.creative_mode" class="select">
                <option value="guided">Balanced — format-aware, flexible</option>
                <option value="open">Open — let the model lead</option>
                <option value="strict">Guardrails — predictable and constrained</option>
              </select>
              <p class="text-muted text-xs mt-1">Open removes fixed examples and random fiction levers; output structure remains reliable.</p>
            </div>
            <div class="form-group">
              <label>Your creative direction <span class="text-muted">(optional)</span></label>
              <textarea v-model="form.creative_direction" class="textarea" rows="3" placeholder="What should the model explore, surprise you with, or avoid sounding like?" />
            </div>
          </div>
        </fieldset>

        <!-- ── 2. Topic & titles ───────────────────────────────────────── -->
        <fieldset class="form-section">
          <legend class="form-section-title">Topic &amp; titles</legend>

          <!-- Topic (a.k.a. niche) override (optional). The Ideas Generator
               runs through getEffectiveFormat({ nicheIdOverride }), so this
               dropdown swaps subject vocab + audience hint for THIS batch
               only — the project's saved topic under Settings is untouched.
               (Field/config key is still niche_id; UI label says "Topic".) -->
          <div class="form-group">
            <label>Topic <span class="text-muted" style="font-size:11px;font-weight:normal;">— subject domain for this batch</span></label>
            <NichePicker v-model="form.niche_id" />
            <div v-if="form.niche_id !== projectNicheId" class="niche-override-banner">
              <span class="banner-icon">↪</span>
              <span class="banner-text">
                <strong>Overriding</strong> the project's saved topic
                <span v-if="projectNicheId">(<code>{{ projectNicheId }}</code>)</span>
                <span v-else>(none)</span>
                for this generation only.
                <a class="banner-link" @click.prevent="form.niche_id = projectNicheId">
                  Reset to project default
                </a>
              </span>
            </div>
          </div>

          <!-- Title template (optional). When set, every generated idea's
               title is shaped to this template — the literal {X} placeholder
               is replaced by each idea's own subject. Blank = default LLM
               titling. Persisted per project. -->
          <div class="ideas-title-template-block mt-2">
            <label class="ideas-title-template-label">
              Title shape <span class="text-muted">(optional template)</span>
            </label>
            <input
              v-model="form.title_template"
              type="text"
              class="input input-sm"
              placeholder="e.g. Fall asleep to {X}   ·   leave blank for free-form titles"
              spellcheck="false"
            />
            <p class="ideas-title-template-hint text-muted">
              Use <code>{X}</code> as the subject placeholder. Each generated
              idea fills it with its own subject — so 10 ideas with template
              <code>"Fall asleep to {X}"</code> become 10 different
              "Fall asleep to …" titles. Blank = the LLM titles freely.
            </p>
          </div>

          <!-- Channel branding (prefix/suffix). Same project-config keys as
               the Metadata Generator (broll_channel_title_prefix/suffix), so
               editing here also updates the final YouTube title wrap. -->
          <div class="ideas-title-wrap-block mt-2">
            <div class="title-wrap-header">
              <strong>Channel branding on titles</strong>
              <span class="text-muted text-xs">
                · added to the front/back of every generated title. Synced with the Metadata Generator.
              </span>
            </div>
            <div class="grid-2 mt-1">
              <div class="form-group">
                <label>Before the title</label>
                <input
                  v-model="titleConfig.prefix"
                  type="text"
                  class="input"
                  placeholder="e.g. Morning Prayer: "
                />
                <span class="text-muted text-xs">Trailing space / punctuation included verbatim.</span>
              </div>
              <div class="form-group">
                <label>After the title</label>
                <input
                  v-model="titleConfig.suffix"
                  type="text"
                  class="input"
                  placeholder="e.g.  | Daily Prayer Channel"
                />
                <span class="text-muted text-xs">Leading space included verbatim if you want a gap.</span>
              </div>
            </div>
            <p v-if="titleConfig.prefix || titleConfig.suffix" class="text-muted text-xs mt-1 hint-line">
              Preview:
              <code>{{ titlePreviewText }}</code>
            </p>
          </div>
        </fieldset>

        <!-- ── 3. Generation settings ──────────────────────────────────── -->
        <fieldset class="form-section">
          <legend class="form-section-title">Generation settings</legend>
          <div class="grid-2">
            <ModelSelector
              v-if="modelPreferenceReady"
              v-model="form.model"
              :project-slug="slug"
            />
            <div v-else class="form-group">
              <label>AI Model</label>
              <div class="input text-muted" aria-live="polite">Restoring your last used model…</div>
            </div>

            <!-- Pinned per-idea item/chapter count. Most useful for listicle
                 / explainer formats where the title encodes the count
                 ("10 mysteries explained"). Blank = LLM picks per-idea. -->
            <div class="form-group">
              <label>
                How many items per video
                <span class="text-muted" style="font-size: 11px; font-weight: normal;">
                  — pin to force "{{ form.items_per_listicle || 'N' }} {{ formatId === 'listicle' ? 'mysteries / paradoxes / cases' : 'chapters' }}…" in every title. Leave blank for auto.
                </span>
              </label>
              <input
                v-model.number="form.items_per_listicle"
                class="input"
                type="number"
                min="1"
                max="100"
                :placeholder="formatId === 'listicle' ? 'e.g. 10' : 'auto (let LLM pick)'"
              />
            </div>
          </div>
        </fieldset>
      </div>

      <!-- Action cluster lives in its own blocked region so the progress -->
      <!-- spinner and wrapping chips don't bleed into the table below when -->
      <!-- the viewport narrows (pain-point #3). -->
      <div class="generator-actions">
        <div class="generator-actions-primary">
          <button class="btn btn-primary" :disabled="generating" @click="generate">
            <LoadingSpinner v-if="generating" size="sm" label="Generating ideas…" show-label />
            <template v-else>Generate Ideas</template>
          </button>
          <button
            class="btn btn-secondary"
            :disabled="generating"
            title="Fills genre, theme, mood, audience, and keywords with random picks from the pools. Review or tweak before generating — no API cost."
            @click="randomizeForm"
          >
            🎲 Randomize
          </button>
          <button
            class="btn btn-secondary"
            :disabled="generating"
            title="Randomize the form AND generate immediately. Spends an API call on each click."
            @click="surpriseMe"
          >
            <LoadingSpinner v-if="generating" size="sm" label="Surprising you…" show-label />
            <template v-else>✨ Surprise Me</template>
          </button>
        </div>
        <!-- v1.0.171 — the three "other ways to add" buttons (rare power
             ops) collapse behind one disclosure so they no longer sit at the
             same visual weight as Generate. Click to reveal. -->
        <div class="generator-actions-secondary">
          <button
            type="button"
            class="btn btn-ghost btn-sm other-ways-toggle"
            :aria-expanded="otherWaysOpen"
            @click="otherWaysOpen = !otherWaysOpen"
          >
            {{ otherWaysOpen ? '▾' : '▸' }} Other ways to add
          </button>
          <template v-if="otherWaysOpen">
            <button class="btn btn-secondary btn-sm" @click="openAddIdea">+ Add idea manually</button>
            <button class="btn btn-secondary btn-sm" @click="openPasteIdeas">📋 Paste from an LLM</button>
            <button class="btn btn-secondary btn-sm" @click="openImportFolder">📂 Import episode folder</button>
          </template>
        </div>
      </div>
    </div>

    </div><!-- /Workflow tab -->

    <!-- ── Manage tab ──────────────────────────────────────────────────── -->
    <div v-show="ideasTab === 'manage'">

    <!-- Search + Filter -->
    <div v-if="allIdeas.length > 0" class="toolbar mt-3">
      <input v-model="searchQuery" class="input search-input" placeholder="Search titles, themes, mood..." />
      <div class="filter-pills">
        <button :class="['pill', { active: statusFilter === 'all' }]" @click="statusFilter = 'all'">All ({{ allIdeas.length }})</button>
        <button :class="['pill', { active: statusFilter === 'new' }]" @click="statusFilter = 'new'">New ({{ statusCounts.new }})</button>
        <button :class="['pill', { active: statusFilter === 'accepted' }]" @click="statusFilter = 'accepted'">Accepted ({{ statusCounts.accepted }})</button>
        <button :class="['pill', { active: statusFilter === 'dismissed' }]" @click="statusFilter = 'dismissed'">Dismissed ({{ statusCounts.dismissed }})</button>
      </div>
      <!-- Source filter: separates organic ideas (generated by the in-app
           generator) from imported episodes (folder-import or YouTube
           channel imports — `batch_id === 'imported'`). Useful for the
           50+ YouTube-import case where the user wants to bulk-flag those
           as already-done so the pipeline stops nagging. -->
      <div class="filter-pills source-pills">
        <span class="source-label">Source</span>
        <button :class="['pill', { active: sourceFilter === 'all' }]" @click="sourceFilter = 'all'">
          All ({{ sourceCounts.all }})
        </button>
        <button :class="['pill', { active: sourceFilter === 'generated' }]" @click="sourceFilter = 'generated'">
          Generated ({{ sourceCounts.generated }})
        </button>
        <button :class="['pill', { active: sourceFilter === 'imported' }]" @click="sourceFilter = 'imported'">
          Imported ({{ sourceCounts.imported }})
        </button>
      </div>
    </div>

    <!-- Bulk-mark-done banner: only appears when the user is filtering
         to Imported AND there's at least one not-yet-marked-done imported
         episode. One click flips them all via the bulk-by-source endpoint
         — single atomic write + single cache invalidation. -->
    <div v-if="sourceFilter === 'imported' && unmarkedImportedCount > 0" class="bulk-mark-banner mt-2">
      <div class="bulk-mark-text">
        <strong>{{ unmarkedImportedCount }}</strong> imported episode{{ unmarkedImportedCount === 1 ? '' : 's' }}
        not yet marked done. Mark them all so the pipeline stops nagging?
      </div>
      <button
        class="btn btn-primary btn-sm"
        :disabled="bulkMarkRunning"
        @click="bulkMarkAllImported(true)"
      >
        {{ bulkMarkRunning ? 'Marking…' : `Mark all ${unmarkedImportedCount} as already done` }}
      </button>
    </div>

    <!-- Bulk-toolbar for multi-select on accepted episodes. Lives below the
         filter row so it doesn't fight the existing "Accept Selected" toolbar
         (which targets `status === 'new'` ideas only). -->
    <div v-if="selectedDoneIds.size > 0" class="bulk-mark-banner subtle mt-2">
      <div class="bulk-mark-text">
        <strong>{{ selectedDoneIds.size }}</strong> accepted episode{{ selectedDoneIds.size === 1 ? '' : 's' }} selected.
      </div>
      <div class="flex gap-2">
        <button
          class="btn btn-primary btn-sm"
          :disabled="bulkMarkRunning"
          @click="bulkMarkSelected(true)"
        >Mark selected as already done</button>
        <button
          class="btn btn-secondary btn-sm"
          :disabled="bulkMarkRunning"
          @click="bulkMarkSelected(false)"
          title="Drop the manual override on these episodes — they'll revert to file detection."
        >Unmark</button>
        <button
          class="btn btn-ghost btn-sm"
          :disabled="bulkMarkRunning"
          @click="selectedDoneIds.clear()"
        >Clear</button>
      </div>
    </div>

    <!-- Ideas Table -->
    <div v-if="pageIdeas.length > 0" class="table-container mt-2">
      <table class="ideas-table">
        <thead>
          <tr>
            <th scope="col" class="th-check">
              <input type="checkbox" @change="toggleAll" :checked="allPageSelected" aria-label="Select all ideas on this page" />
            </th>
            <th scope="col" class="sortable" @click="toggleSort('episode_code')">Code {{ sortIcon('episode_code') }}</th>
            <th scope="col" class="sortable" @click="toggleSort('title')">Title {{ sortIcon('title') }}</th>
            <th scope="col" class="sortable" @click="toggleSort('status')">Status {{ sortIcon('status') }}</th>
            <th scope="col" class="sortable" @click="toggleSort('mood')">Mood {{ sortIcon('mood') }}</th>
            <th scope="col" class="sortable" @click="toggleSort('suggested_length')">Length {{ sortIcon('suggested_length') }}</th>
            <th scope="col" class="sortable" @click="toggleSort('suggested_chapters')" :title="`Suggested ${sectionLabel.plural} count`">{{ sectionLabel.Singular.slice(0, 3) }} {{ sortIcon('suggested_chapters') }}</th>
            <th scope="col" class="sortable" @click="toggleSort('generated_at')">Date {{ sortIcon('generated_at') }}</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="idea in pageIdeas" :key="idea.id">
            <tr :class="['idea-row', `status-${idea.status}`, { 'is-imported': idea.batch_id === 'imported', 'is-marked-done': idea.marked_done }]" @click="toggleExpand(idea.id)">
              <td class="td-check" @click.stop>
                <!-- Two select states co-existing: "new" rows go into
                     selectedIds (drives Accept Selected); "accepted" rows
                     go into selectedDoneIds (drives Mark-done bulk). The
                     checkbox visual is the same — the row's status
                     determines which set it joins. -->
                <input
                  v-if="idea.status === 'new'"
                  type="checkbox"
                  :checked="selectedIds.has(idea.id)"
                  @change="toggleSelect(idea.id)"
                />
                <input
                  v-else-if="idea.status === 'accepted' && idea.episode_code"
                  type="checkbox"
                  :checked="selectedDoneIds.has(idea.episode_code)"
                  @change="toggleDoneSelect(idea.episode_code)"
                  :title="`Select this accepted episode for bulk mark-done actions.`"
                />
              </td>
              <td class="td-code">
                <span v-if="idea.episode_code" class="code-badge">{{ idea.episode_code }}</span>
                <span v-else class="text-muted">—</span>
                <span
                  v-if="idea.batch_id === 'imported'"
                  class="source-tag imported-tag"
                  title="Imported from an existing folder or YouTube channel"
                >imported</span>
              </td>
              <td class="td-title">
                {{ idea.title }}
                <span
                  v-if="idea.marked_done"
                  class="manual-done-tag"
                  title="Manually marked done — pipeline treats every component as complete."
                >✓ Done (manual)</span>
              </td>
              <td><span :class="['status-badge', idea.status]">{{ idea.status }}</span></td>
              <td class="text-muted">{{ idea.mood }}</td>
              <td class="text-muted">{{ idea.suggested_length }}</td>
              <td class="text-muted">{{ idea.suggested_chapters }}</td>
              <td class="text-muted td-date">{{ shortDate(idea.generated_at) }}</td>
              <td class="td-actions" @click.stop>
                <button v-if="idea.status === 'new'" class="btn btn-sm btn-primary" @click="showAcceptDialog(idea)">Accept</button>
                <button v-if="idea.status === 'new'" class="btn btn-sm btn-secondary" @click="dismiss(idea.id)">Dismiss</button>
                <button v-if="idea.status === 'accepted'" class="btn btn-sm btn-secondary" @click="openRenumberDialog(idea)" title="Change this episode's code (renames folder + asset files)">Renumber</button>
                <button v-if="idea.status === 'accepted'" class="btn btn-sm btn-danger" @click="resetIdea(idea)">Reset</button>
                <button class="btn-icon" @click="openEditIdea(idea)" aria-label="Edit idea" title="Edit idea">✎</button>
                <button class="btn-icon danger" @click="remove(idea.id)" aria-label="Delete idea" title="Delete idea">&#10005;</button>
              </td>
            </tr>
            <tr v-if="expandedId === idea.id" class="expand-row">
              <td colspan="9">
                <div class="expand-content">
                  <p class="expand-logline">{{ idea.logline }}</p>
                  <div class="expand-tags">
                    <span v-for="t in idea.themes" :key="t" class="idea-tag">{{ t }}</span>
                    <span class="text-muted text-xs">Model: {{ idea.model_used }}</span>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <div v-if="totalPages > 1" class="pagination mt-2">
      <button class="btn btn-sm btn-secondary" :disabled="page === 1" @click="page--">← Prev</button>
      <span class="page-info">Page {{ page }} of {{ totalPages }} ({{ filteredIdeas.length }} ideas)</span>
      <button class="btn btn-sm btn-secondary" :disabled="page === totalPages" @click="page++">Next →</button>
    </div>

    <EmptyState
      v-else-if="allIdeas.length === 0 && !generating"
      class="mt-3"
      icon="✨"
      title="No ideas yet"
      message="Use the generator above to brainstorm story concepts. Choose a genre, mood, and any keywords you'd like the AI to work with."
    >
    </EmptyState>

    <!-- Filter-active empty state (ideas exist but filter shows none) -->
    <EmptyState
      v-else-if="pageIdeas.length === 0 && allIdeas.length > 0 && !generating"
      class="mt-3"
      icon="🔍"
      title="No ideas match your filter"
      message="Try clearing your search or switching to the 'All' filter."
    />

    <div v-if="pageIdeas.length > 0 && generating" class="mt-2 generating-inline">
      <LoadingSpinner size="sm" label="Generating more ideas…" show-label />
    </div>

    </div><!-- /Manage tab -->

    <!-- Accept dialog -->
    <Modal
      :visible="!!acceptDialogIdea"
      size="sm"
      labelledby="accept-idea-title"
      @close="acceptDialogIdea = null"
    >
      <h2 id="accept-idea-title">Accept Idea</h2>
      <div class="accept-preview">
        <h3>{{ acceptDialogIdea?.title }}</h3>
        <p class="text-muted">{{ acceptDialogIdea?.logline }}</p>

        <!-- Episode-code chooser. Default = next available; override
             lets the user fill a known gap or pick a specific code.
             Validation lives below — Accept is disabled while invalid. -->
        <div class="accept-code-chooser mt-2">
          <label class="code-choice">
            <input type="radio" v-model="acceptCodeMode" value="next" />
            <span>Use next available: <strong class="text-accent">{{ nextEpisode }}</strong></span>
          </label>
          <label class="code-choice">
            <input type="radio" v-model="acceptCodeMode" value="custom" />
            <span>
              Custom code:
              <span class="code-prefix">{{ episodePrefix }}</span>
              <input
                v-model.number="acceptCustomNumber"
                type="number"
                min="1"
                class="input code-input"
                :disabled="acceptCodeMode !== 'custom'"
                :placeholder="String(nextEpisodeNum)"
              />
            </span>
          </label>
          <p v-if="acceptCodeMode === 'custom' && acceptCodeError" class="accept-code-error">
            {{ acceptCodeError }}
          </p>
          <p v-else-if="acceptCodeMode === 'custom' && acceptCustomNumber" class="accept-code-resolved">
            → <strong class="text-accent">{{ resolvedCustomCode }}</strong>
          </p>
        </div>
      </div>
      <div class="accept-options mt-3">
        <button
          class="btn btn-secondary btn-lg flex-1"
          :disabled="!acceptCodeValid"
          @click="doAccept('folders')"
        >Create Folders Only</button>
        <button
          class="btn btn-primary btn-lg flex-1"
          :disabled="!acceptCodeValid"
          @click="doAccept('script')"
        >Folders &amp; Open Script</button>
      </div>
      <button class="btn btn-sm btn-secondary mt-2 w-full" @click="acceptDialogIdea = null">Cancel</button>
    </Modal>

    <!-- Renumber dialog (per-episode rename) -->
    <Modal
      :visible="!!renumberDialogIdea"
      size="sm"
      labelledby="renumber-title"
      @close="renumberDialogIdea = null"
    >
      <h2 id="renumber-title">Renumber episode</h2>
      <div class="accept-preview">
        <h3>{{ renumberDialogIdea?.title }}</h3>
        <p class="text-muted">
          Currently <strong class="text-accent">{{ renumberDialogIdea?.episode_code }}</strong>.
          Renames the episode folder, all per-asset filenames inside (audio, images, video,
          merged audio, final video), updates <code>episode_info.json</code>, and patches
          <code>ideas.json</code> atomically. The YouTube sidecar (if any) is preserved.
        </p>
        <div class="accept-code-chooser mt-2">
          <label class="code-choice">
            <input type="radio" v-model="renumberCodeMode" value="next" />
            <span>Use next available: <strong class="text-accent">{{ nextEpisode }}</strong></span>
          </label>
          <label class="code-choice">
            <input type="radio" v-model="renumberCodeMode" value="custom" />
            <span>
              Custom code:
              <span class="code-prefix">{{ episodePrefix }}</span>
              <input
                v-model.number="renumberCustomNumber"
                type="number"
                min="1"
                class="input code-input"
                :disabled="renumberCodeMode !== 'custom'"
              />
            </span>
          </label>
          <p v-if="renumberCodeError" class="accept-code-error">{{ renumberCodeError }}</p>
          <p v-else-if="resolvedRenumberCode" class="accept-code-resolved">
            → <strong class="text-accent">{{ resolvedRenumberCode }}</strong>
          </p>
        </div>
      </div>
      <div class="accept-options mt-3">
        <button
          class="btn btn-primary btn-lg flex-1"
          :disabled="!renumberValid || renumberRunning"
          @click="doRenumber"
        >
          {{ renumberRunning ? 'Renumbering…' : 'Renumber' }}
        </button>
      </div>
      <button class="btn btn-sm btn-secondary mt-2 w-full" @click="renumberDialogIdea = null">Cancel</button>
    </Modal>

    <!-- Import Episode Folder modal -->
    <div v-if="importOpen" class="modal-overlay" @click.self="importOpen = false">
      <div class="modal" style="max-width: 680px;">
        <h2>Import Episode Folder</h2>

        <!-- Mode switch. Single-folder is the default so existing muscle
             memory still works; flipping to Parent reveals the auto-scan
             flow for bulk imports (e.g. dropping in 30 archive episodes
             at once). The two modes share importCopy ("keep originals")
             since that decision applies the same way to both. -->
        <div class="import-mode-row mt-2" role="tablist" aria-label="Import mode">
          <label class="import-mode-option" :class="{ active: importMode === 'single' }">
            <input type="radio" value="single" v-model="importMode" :disabled="parentImporting" />
            <span class="import-mode-label">Single folder</span>
            <span class="import-mode-hint">Pick one episode folder.</span>
          </label>
          <label class="import-mode-option" :class="{ active: importMode === 'parent' }">
            <input type="radio" value="parent" v-model="importMode" :disabled="parentImporting" />
            <span class="import-mode-label">Parent (auto-import subfolders)</span>
            <span class="import-mode-hint">Each immediate subfolder becomes its own episode. Subfolders inside subfolders are ignored.</span>
          </label>
        </div>

        <p v-if="importMode === 'single'" class="text-muted text-md mt-2">
          Pick an existing folder named like <code>EP0009 - The Luminous Grove at Dawn</code>.
          We'll detect what's inside, add any missing subfolders, and register it as an accepted episode
          so it can flow through the pipeline.
        </p>
        <p v-else class="text-muted text-md mt-2">
          Pick a <strong>parent</strong> folder — we'll list every immediate subfolder so you can
          tick which to import. Codes are auto-resolved (keep parsed if free, else next available).
          Use single-folder mode if you need to override per-folder.
        </p>

        <!-- Single-folder mode -->
        <template v-if="importMode === 'single'">
        <div class="flex gap-2 mt-2">
          <input v-model="importPath" class="input flex-1" placeholder="Path to episode folder" />
          <button class="btn btn-sm btn-secondary" @click="browseImportFolder">Browse…</button>
          <button class="btn btn-sm btn-secondary" :disabled="!importPath || inspecting" @click="doInspect">
            {{ inspecting ? 'Inspecting…' : 'Inspect' }}
          </button>
        </div>

        <div v-if="inspectResult?.error" class="import-error mt-2">
          {{ inspectResult.error }}
        </div>

        <div v-else-if="inspectResult?.ok" class="import-preview mt-2">
          <!-- Episode-code chooser. When the parsed code is free, the
               user picks between keeping it (typical for re-importing a
               specific episode by its published number) and using the
               next-available code (typical for treating the import as a
               new addition to the sequence). When the parsed code is
               taken, only the next-available option is shown — keeping
               it would conflict with an existing accepted idea. -->
          <div class="import-row">
            <span class="label">Episode code:</span>
            <div class="code-choice">
              <label
                v-if="!inspectResult.parsed_code_taken"
                class="code-option"
                :class="{ active: importCodeChoice === 'parsed' }"
              >
                <input type="radio" value="parsed" v-model="importCodeChoice" />
                <strong>{{ inspectResult.parsed_code }}</strong>
                <span class="code-hint">Keep original (from folder name)</span>
              </label>
              <label
                class="code-option"
                :class="{ active: importCodeChoice === 'next' }"
              >
                <input type="radio" value="next" v-model="importCodeChoice" />
                <strong>{{ inspectResult.next_available_code }}</strong>
                <span class="code-hint">
                  Use next available
                  <template v-if="inspectResult.parsed_code_taken">
                    (original {{ inspectResult.parsed_code }} is already taken)
                  </template>
                </span>
              </label>
            </div>
          </div>
          <div class="import-row">
            <span class="label">Title:</span>
            <strong>{{ inspectResult.final_title || '(none)' }}</strong>
          </div>

          <div v-if="inspectResult.conflicts.length" class="import-conflicts mt-2">
            <div v-for="c in inspectResult.conflicts" :key="c" class="conflict-item">⚠ {{ c }}</div>
          </div>

          <h4 class="mt-2 text-md">Detected assets</h4>
          <div class="asset-grid">
            <div v-for="(bucket, key) in assetLabels" :key="key" class="asset-cell">
              <span class="asset-check">{{ inspectResult.assets[key] ? '✓' : '·' }}</span>
              <span class="asset-name">{{ bucket }}</span>
              <span v-if="inspectResult.file_counts[key]" class="asset-count">{{ inspectResult.file_counts[key] }}</span>
            </div>
          </div>

          <div v-if="inspectResult.missing_subfolders.length" class="import-info mt-2">
            {{ inspectResult.missing_subfolders.length }} subfolder(s) will be created:
            <code>{{ inspectResult.missing_subfolders.slice(0, 3).join(', ') }}{{ inspectResult.missing_subfolders.length > 3 ? '…' : '' }}</code>
          </div>

          <label class="flex gap-2 mt-2 items-center text-sm">
            <input type="checkbox" v-model="importCopy" />
            <span>
              <strong>Keep originals</strong> — copy files into the project (recommended).
              Uncheck to <em>move</em> files (originals deleted after a successful import).
            </span>
          </label>

          <div v-if="inspectResult.warnings.length" class="import-warnings mt-2">
            <div v-for="w in inspectResult.warnings" :key="w">{{ w }}</div>
          </div>

          <!-- Heads-up: after the folder lands we'll open the
               Pipeline-style mapping dialog so the user sees how files
               will be renamed. Setting expectations here means clicking
               "Import Episode" doesn't surprise them with a second
               modal popping up. -->
          <div v-if="anyClassifiableAssets" class="import-info mt-2">
            ↳ After import, we'll open the <strong>asset mapping dialog</strong> so you
            can confirm how detected files get renamed into the canonical
            structure (or re-map any rows that look wrong).
          </div>
        </div>
        </template>

        <!-- Parent-folder mode -->
        <template v-else>
          <div class="flex gap-2 mt-2">
            <input v-model="parentPath" class="input flex-1" placeholder="Path to parent folder" :disabled="parentImporting" />
            <button class="btn btn-sm btn-secondary" :disabled="parentImporting" @click="browseParentFolder">Browse…</button>
            <button class="btn btn-sm btn-secondary" :disabled="!parentPath || parentScanning || parentImporting" @click="scanParentSubfolders">
              {{ parentScanning ? 'Scanning…' : 'Scan' }}
            </button>
          </div>

          <label class="flex gap-2 mt-2 items-center text-sm">
            <input type="checkbox" v-model="importCopy" :disabled="parentImporting" />
            <span>
              <strong>Keep originals</strong> — copy files into the project (recommended).
              Applies to every subfolder. Uncheck to <em>move</em> files (originals deleted after a successful import).
            </span>
          </label>

          <div v-if="parentSubfolders.length > 0" class="parent-sub-list mt-2">
            <div class="parent-sub-header">
              <span><strong>{{ parentSelectedCount }}</strong> of {{ parentSubfolders.length }} selected</span>
              <button
                class="btn btn-xs btn-ghost"
                :disabled="parentImporting"
                @click="parentSubfolders.forEach(r => r.selected = parentSelectedCount !== parentSubfolders.length)"
              >
                {{ parentSelectedCount === parentSubfolders.length ? 'Deselect all' : 'Select all' }}
              </button>
            </div>
            <div class="parent-sub-rows">
              <label v-for="row in parentSubfolders" :key="row.path" class="parent-sub-row" :class="['status-' + row.status]">
                <input type="checkbox" v-model="row.selected" :disabled="parentImporting || row.status === 'importing'" />
                <span class="parent-sub-name">{{ row.name }}</span>
                <span class="parent-sub-status">
                  <template v-if="row.status === 'pending'"></template>
                  <template v-else-if="row.status === 'importing'">⟳ importing…</template>
                  <template v-else-if="row.status === 'done'">✓ {{ row.message }}</template>
                  <template v-else-if="row.status === 'error'">⚠ {{ row.message }}</template>
                </span>
              </label>
            </div>
          </div>
          <p v-else-if="parentPath && !parentScanning" class="text-muted text-sm mt-2">
            No subfolders here yet. Click <em>Scan</em> after picking a parent.
          </p>
        </template>

        <div class="flex gap-2 mt-3 justify-end">
          <button class="btn btn-secondary" :disabled="parentImporting" @click="importOpen = false">
            {{ parentImporting ? 'Close after finish' : 'Cancel' }}
          </button>
          <button
            v-if="importMode === 'single'"
            class="btn btn-primary"
            :disabled="!canImport || importing"
            @click="doImport"
          >
            {{ importing ? 'Importing…' : 'Import Episode' }}
          </button>
          <button
            v-else
            class="btn btn-primary"
            :disabled="parentSelectedCount === 0 || parentImporting"
            @click="doParentImport"
          >
            {{ parentImporting ? 'Importing…' : `Import ${parentSelectedCount} Episode${parentSelectedCount === 1 ? '' : 's'}` }}
          </button>
        </div>
      </div>
    </div>

    <!-- Asset mapping dialog — auto-opens after a folder import that
         turned up classifiable files. Pre-populates with the discovered
         items so the user reviews + commits in one pass. The mode
         (copy vs move) honours the inspector toggle: keep-originals
         checked → copy, unchecked → move (deletes originals). -->
    <AssetImportDialog
      v-if="assetMapEpisode"
      :visible="!!assetMapEpisode"
      :slug="slug"
      :episode-code="assetMapEpisode.episode_code"
      :prefilled-items="assetMapEpisode.prefilled"
      :default-mode="assetMapEpisode.mode"
      @close="assetMapEpisode = null"
      @imported="onAssetsMapped"
    />

    <!-- Paste ideas from LLM modal -->
    <div v-if="pasteOpen" class="modal-overlay" @click.self="pasteOpen = false">
      <div class="modal modal-wide">
        <h2>Paste Ideas from LLM</h2>
        <p class="text-muted text-md mt-1">
          Copy the prompt below into ChatGPT, Claude, or any LLM. Paste the JSON array it produces into the box below and click <strong>Preview</strong>.
        </p>

        <!-- Pane 1: Preset prompt -->
        <div class="mt-2">
          <div class="flex gap-2 items-center">
            <label class="text-sm font-semibold">1. Preset prompt</label>
            <button class="btn btn-sm btn-secondary ml-auto" :disabled="!pastePrompt" @click="copyPastePrompt">
              {{ pastePromptCopied ? '✓ Copied' : 'Copy Prompt' }}
            </button>
          </div>
          <!-- Source-of-truth strip: shows what the prompt is built from
               (project's active format + optionally a Pattern preset).
               Switching format requires a round-trip to Settings → Format
               because format affects script + image-prompt generation
               too — surfacing it here is informational, not editable. -->
          <div class="paste-prompt-source">
            <span class="paste-prompt-source-label">Built from</span>
            <span class="paste-prompt-source-chip" :title="`This prompt is generated for the project's currently-active format (${formatDisplayName}). Change it from Settings → Format.`">
              Format: <strong>{{ formatDisplayName }}</strong>
            </span>
            <NuxtLink :to="`/projects/${slug}/settings#format`" class="paste-prompt-source-link" title="Open Settings → Format to change the active format. The prompt will refresh when you come back.">Switch</NuxtLink>
            <button
              type="button"
              class="paste-prompt-source-link"
              title="Override this format's idea-generation rules, guidance text, and other fields for this project only — without leaving the page."
              @click="openFormatOverrideEditor"
            >Customize prompt</button>
            <span v-if="form.title_template" class="paste-prompt-source-chip" title="A title template is folded into the prompt — every generated title is shaped to it, with {X} replaced by each idea's subject. Clear it via the Title template field above.">
              Title: <strong>{{ form.title_template }}</strong>
              <button
                type="button"
                class="paste-prompt-source-clear"
                title="Clear the title template — the LLM titles freely."
                aria-label="Clear title template"
                @click="form.title_template = ''"
              >✕</button>
            </span>
            <span v-else class="paste-prompt-source-hint">No title template — the LLM titles freely. Set one in the field above to fold a shape into the prompt.</span>
          </div>
          <pre class="paste-prompt-box">{{ pastePrompt || 'Loading…' }}</pre>
        </div>

        <!-- Pane 2: Paste box -->
        <div class="mt-2">
          <label class="text-sm font-semibold">2. Paste the JSON array your LLM produced</label>
          <textarea
            v-model="pasteInput"
            class="textarea paste-input-box"
            rows="8"
            placeholder='[&#10;  { "title": "...", "logline": "...", "themes": [...], "suggested_chapters": 10, "suggested_length": "45 min", "mood": "..." }&#10;]'
          />
          <div class="flex gap-2 mt-1 items-center">
            <button class="btn btn-sm btn-primary" :disabled="!pasteInput.trim() || pastePreviewing" @click="doPastePreview">
              {{ pastePreviewing ? 'Previewing…' : 'Preview' }}
            </button>
            <span v-if="pastePreviewError" class="text-danger text-sm">
              {{ pastePreviewError }}
            </span>
          </div>
        </div>

        <!-- Pane 3: Preview table -->
        <div v-if="pastePreviewValid.length || pastePreviewRejected.length" class="mt-3">
          <label class="text-sm font-semibold">
            3. Preview — {{ pastePreviewValid.length }} ready to import{{ pastePreviewRejected.length ? `, ${pastePreviewRejected.length} rejected` : '' }}
          </label>
          <div v-if="pastePreviewValid.length" class="paste-preview-table mt-1">
            <div class="paste-preview-row paste-preview-header">
              <span class="ppr-num"></span>
              <span class="ppr-title">Title</span>
              <span class="ppr-logline">Logline</span>
              <span class="ppr-themes">Themes</span>
              <span class="ppr-chapters">{{ sectionLabel.Plural }}</span>
              <span class="ppr-length">Length</span>
              <span class="ppr-mood">Mood</span>
              <span class="ppr-remove"></span>
            </div>
            <div v-for="(row, i) in pastePreviewValid" :key="`v-${i}`" class="paste-preview-row">
              <span class="ppr-num">{{ i + 1 }}</span>
              <span class="ppr-title">{{ row.title }}</span>
              <span class="ppr-logline">{{ row.logline }}</span>
              <span class="ppr-themes">{{ row.themes.join(', ') }}</span>
              <span class="ppr-chapters">{{ row.suggested_chapters }}</span>
              <span class="ppr-length">{{ row.suggested_length }}</span>
              <span class="ppr-mood">{{ row.mood }}</span>
              <button class="btn-icon ppr-remove" @click="pastePreviewValid.splice(i, 1)" title="Remove this row">✕</button>
            </div>
          </div>

          <div v-if="pastePreviewRejected.length" class="paste-rejected mt-2">
            <div class="text-sm font-semibold text-danger">
              Rejected rows ({{ pastePreviewRejected.length }}) — fix the LLM output and re-preview, or ignore and import the rest:
            </div>
            <div v-for="rej in pastePreviewRejected" :key="rej.index" class="paste-rejected-row">
              <span class="paste-rejected-index">#{{ rej.index + 1 }}</span>
              <span class="paste-rejected-reason">{{ rej.reason }}</span>
              <code class="paste-rejected-raw">{{ typeof rej.raw === 'object' ? JSON.stringify(rej.raw).slice(0, 120) : String(rej.raw).slice(0, 120) }}</code>
            </div>
          </div>
        </div>

        <div class="flex gap-2 mt-3 justify-end">
          <button class="btn btn-secondary" @click="pasteOpen = false">Cancel</button>
          <button
            class="btn btn-primary"
            :disabled="!pastePreviewValid.length || pasteImporting"
            @click="doPasteImport"
          >
            {{ pasteImporting ? 'Importing…' : `Import ${pastePreviewValid.length || 0} idea${pastePreviewValid.length === 1 ? '' : 's'}` }}
          </button>
        </div>
      </div>
    </div>

    <!-- Format override drawer — stacked above the Paste modal so the user
         can tweak the format's idea-generation rules, audience default,
         narrator style, etc. without leaving. Same FormatOverrideEditor
         component the Settings page uses; saves to project.format_overrides
         then refetches the displayed paste-prompt. -->
    <div v-if="formatOverrideOpen" class="format-override-drawer-overlay" @click.self="closeFormatOverrideEditor">
      <div class="format-override-drawer">
        <header class="fod-header">
          <div>
            <h3>Customize prompt — {{ formatDisplayName }}</h3>
            <p class="text-muted text-sm mt-1" style="margin: 0;">
              Per-project overrides. Empty fields fall back to the built-in format's defaults.
              Changes also apply to script + image-prompt + metadata generation.
            </p>
          </div>
          <button class="btn-icon" title="Close" @click="closeFormatOverrideEditor">✕</button>
        </header>
        <div class="fod-body">
          <FormatOverrideEditor
            v-model="formatOverridesDraft"
            :base-format="selectedBaseFormat"
          />
        </div>
        <footer class="fod-footer">
          <span v-if="formatOverridesError" class="text-danger text-sm">{{ formatOverridesError }}</span>
          <button class="btn btn-secondary" :disabled="formatOverridesSaving" @click="closeFormatOverrideEditor">Cancel</button>
          <button class="btn btn-primary" :disabled="formatOverridesSaving" @click="saveFormatOverrides">
            {{ formatOverridesSaving ? 'Saving…' : 'Save overrides' }}
          </button>
        </footer>
      </div>
    </div>

    <!-- v1.0.165 — Pattern editor modal removed with the rest of the
         Pattern system. The title-template field above covers the one
         capability the user actually used. -->

    <!-- Add/Edit idea modal -->
    <div v-if="editorOpen" class="modal-overlay" @click.self="editorOpen = false">
      <div class="modal" style="max-width: 560px;">
        <h2>{{ editorMode === 'add' ? 'Add Idea' : 'Edit Idea' }}</h2>
        <p v-if="editorMode === 'edit' && editorIdea?.status === 'accepted'" class="text-muted text-sm mt-1">
          This idea is already accepted — editing won't rename the episode folder.
        </p>
        <div class="form-group mt-2">
          <label>Title *</label>
          <input v-model="editorForm.title" class="input" placeholder="A compelling episode title" />
        </div>
        <div class="form-group mt-1">
          <label>Logline</label>
          <textarea v-model="editorForm.logline" class="textarea" rows="3" placeholder="1-2 sentence hook" />
        </div>
        <div class="grid-2 mt-1">
          <div class="form-group">
            <label>Mood</label>
            <ComboInput v-model="editorForm.mood" :options="allMoods" placeholder="Pick or add a mood" searchable allow-custom @add-custom="onAddMood" />
          </div>
          <div class="form-group">
            <label>Themes</label>
            <ChipInput v-model="editorForm.themesList" :suggestions="allThemes" placeholder="Pick or type to add…" allow-custom :max="6" @add-custom="onAddTheme" />
          </div>
        </div>
        <div class="grid-2 mt-1">
          <div class="form-group">
            <label>{{ sectionLabel.Plural }}</label>
            <input v-model.number="editorForm.suggested_chapters" class="input" type="number" min="1" max="30" />
          </div>
          <div class="form-group">
            <label>Length</label>
            <input v-model="editorForm.suggested_length" class="input" list="length-options" placeholder="45 min" />
            <datalist id="length-options">
              <option value="30 min" />
              <option value="45 min" />
              <option value="60 min" />
              <option value="90 min" />
            </datalist>
          </div>
        </div>
        <div class="flex gap-2 mt-3 justify-end">
          <button class="btn btn-secondary" @click="editorOpen = false">Cancel</button>
          <button class="btn btn-primary" :disabled="!editorForm.title.trim() || editorSaving" @click="saveEditor">
            {{ editorSaving ? 'Saving…' : (editorMode === 'add' ? 'Add Idea' : 'Save Changes') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Sticky multi-select action bar — floats at the bottom of the
         viewport so the user can scroll the imported list and still
         reach Accept without scrolling back to the top. Only renders
         when something is selected; fade-in/out keeps it from snapping
         in jarringly on first tick. -->
    <Transition name="bulk-bar">
      <div v-if="selectedIds.size > 0" class="ideas-bulk-bar" role="region" aria-label="Bulk selection actions">
        <span class="ideas-bulk-bar-count">{{ selectedIds.size }} selected</span>
        <button class="btn btn-primary btn-sm" @click="batchAccept">Accept Selected</button>
        <button class="btn btn-secondary btn-sm" @click="selectedIds.clear()">Clear</button>
      </div>
    </Transition>

    <!-- Compact / Fill Gaps modal (v1.0.40). Shows the rename plan
         before any disk renames or ideas.json patches land. Confirms
         the operation, surfaces per-rename errors after, and points
         the user at the Revert banner on the Unlinked Uploads tab if
         they need to roll back. -->
    <Teleport to="body">
      <div v-if="compactState.open" class="compact-modal-backdrop" @click="closeCompactDialog" />
      <div v-if="compactState.open" class="compact-modal" role="dialog" aria-label="Compact episode codes" @click.stop>
        <div class="compact-modal-header">
          <strong>↓ Compact episode codes</strong>
          <button class="compact-modal-close" type="button" title="Close" @click="closeCompactDialog">✕</button>
        </div>
        <div class="compact-modal-body">
          <template v-if="compactState.preview && compactState.preview.rename_plan.length === 0">
            <p class="text-muted" style="font-size: 13px; margin: 0;">
              Nothing to compact — all {{ compactState.preview.total_accepted }} accepted episode{{ compactState.preview.total_accepted === 1 ? '' : 's' }}
              already sit at codes {{ projectPrefix }}0001 through {{ projectPrefix }}{{ String(compactState.preview.total_accepted).padStart(4, '0') }}.
            </p>
          </template>
          <template v-else-if="compactState.preview">
            <p class="text-muted" style="font-size: 13px; margin: 0;">
              <strong>{{ compactState.preview.rename_plan.length }}</strong>
              episode{{ compactState.preview.rename_plan.length === 1 ? '' : 's' }} will be renamed.
              <span v-if="compactState.preview.noop_count > 0">
                {{ compactState.preview.noop_count }} already in place.
              </span>
              <br />
              Each rename touches the episode folder, every <code>{{ '{code}' }}</code>-scoped subfolder, and asset filenames inside.
              The <code>.renumber-undo.json</code> safety net is written first, so this is fully reversible from the Unlinked Uploads tab for 30 days.
            </p>
            <div class="compact-rename-list">
              <div
                v-for="(r, idx) in compactState.preview.rename_plan.slice(0, 12)"
                :key="r.old_code"
                class="compact-rename-row"
              >
                <code>{{ r.old_code }}</code>
                <span class="text-muted">→</span>
                <code>{{ r.new_code }}</code>
                <span class="compact-rename-title text-muted">{{ r.title }}</span>
              </div>
              <div v-if="compactState.preview.rename_plan.length > 12" class="text-muted" style="font-size: 12px; padding: 4px 0;">
                + {{ compactState.preview.rename_plan.length - 12 }} more
              </div>
            </div>
          </template>
          <p v-if="compactState.error" class="text-danger" style="font-size: 12px; margin: 8px 0 0;">
            ⚠ {{ compactState.error }}
          </p>
        </div>
        <div class="compact-modal-footer">
          <button type="button" class="btn btn-ghost btn-sm" @click="closeCompactDialog">Cancel</button>
          <button
            v-if="compactState.preview && compactState.preview.rename_plan.length > 0"
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="compactState.running"
            @click="confirmCompact"
          >
            <LoadingSpinner v-if="compactState.running" size="sm" />
            {{ compactState.running
              ? 'Compacting…'
              : `Compact ${compactState.preview.rename_plan.length}` }}
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { canonicalFormatId } from '~/composables/useFormats'
import { resolveInitialIdeaModel } from '~/utils/idea-model-preference'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Ideas')
const route = useRoute()
const _router = useRouter()
const slug = computed(() => route.params.slug as string)
const { get, post, del, patch } = useApi()
const { success, error: showError, successUndoable } = useToast()

// v1.0.117+ — Page tabs: Workflow (generator) vs Manage (catalog).
// Same ?tab= sync pattern as image-prompts.vue (v1.0.88). Defaults to
// 'workflow' on first visit so a fresh project's empty-state lands on
// the generator instead of an empty table. The query param is the
// source of truth — back/forward + refresh keep the tab consistent.
const ideasTab = ref<'workflow' | 'manage'>(
  route.query.tab === 'manage' ? 'manage' : 'workflow',
)
watch(() => route.query.tab, (v) => {
  const next = v === 'manage' ? 'manage' : 'workflow'
  if (next !== ideasTab.value) ideasTab.value = next
})
watch(ideasTab, (v) => {
  const cur = String(route.query.tab || 'workflow')
  if (cur === v) return
  _router.replace({ query: { ...route.query, tab: v } })
})
const { ask } = useConfirm()
const { project } = useProject()
// v1.0.165 — the Pattern customization system was removed; its one
// piece of value (the {X} title shape) is now a plain `title_template`
// string field on the Ideas form. The pattern lookup composable,
// PatternPicker / PatternEditorModal components, and per-pattern
// warning-header plumbing all went with it.
// Full Format objects (with script/idea/imagePrompts/metadata blocks) —
// the lite `formatsById` map above only carries the idea block, but
// FormatOverrideEditor needs the full base-format. useFormats() also
// gives us the list-cache that the editor's built-in picker queries.
const { find: findFullFormat, refresh: refreshFormats } = useFormats()

const PER_PAGE = 10
const generating = ref(false)
const allIdeas = ref<any[]>([])
const searchQuery = ref('')
const statusFilter = ref('all')
const sortField = ref('generated_at')
const sortDir = ref<'asc' | 'desc'>('desc')
const selectedIds = ref(new Set<string>())
const acceptDialogIdea = ref<any>(null)
const expandedId = ref<string | null>(null)
const nextEpisodeNum = ref(1)
const episodePrefix = ref('EP')
const page = ref(1)

// ── Source filter + bulk-mark-done state ──────────────────────────────────
// Source filter mirrors the backend's `batch_id === 'imported'` provenance
// flag. Generated = anything organic (LLM batches, paste-ideas, manual
// adds). Imported = folder + YouTube imports — these are typically what
// the user wants to bulk-flag as already-done. selectedDoneIds tracks
// accepted episodes the user has multi-checked for the bulk-mark action.
type SourceFilter = 'all' | 'generated' | 'imported'
const sourceFilter = ref<SourceFilter>('all')
const selectedDoneIds = ref(new Set<string>())  // keyed by episode_code (not idea.id)
const bulkMarkRunning = ref(false)

const sourceCounts = computed(() => ({
  all: allIdeas.value.length,
  imported: allIdeas.value.filter(i => i.batch_id === 'imported').length,
  generated: allIdeas.value.filter(i => i.batch_id !== 'imported').length,
}))

// Imported episodes that haven't been marked done yet — drives the
// banner copy + the bulk button's count. Excludes already-done so the
// banner disappears once the user has flipped them all.
const unmarkedImportedCount = computed(() => allIdeas.value.filter(
  i => i.batch_id === 'imported' && i.status === 'accepted' && !i.marked_done && i.episode_code,
).length)

function toggleDoneSelect(code: string) {
  if (selectedDoneIds.value.has(code)) selectedDoneIds.value.delete(code)
  else selectedDoneIds.value.add(code)
}

async function bulkMarkAllImported(done: boolean) {
  if (bulkMarkRunning.value) return
  bulkMarkRunning.value = true
  try {
    const r = await post<{ changed: number; episode_codes: string[] }>(
      `/projects/${slug.value}/episodes/bulk-mark-done-by-source`,
      { source: 'imported', done },
    )
    success(`${r.changed} episode${r.changed === 1 ? '' : 's'} marked ${done ? 'done' : 'not done'}`)
    await loadIdeas()
  } catch (e: any) {
    showError(e?.data?.detail || 'Bulk mark-done failed')
  } finally {
    bulkMarkRunning.value = false
  }
}

async function bulkMarkSelected(done: boolean) {
  if (bulkMarkRunning.value || selectedDoneIds.value.size === 0) return
  bulkMarkRunning.value = true
  const codes = Array.from(selectedDoneIds.value)
  try {
    const r = await post<{ changed: number; total_requested: number }>(
      `/projects/${slug.value}/episodes/bulk-mark-done`,
      { episode_codes: codes, done },
    )
    success(`${r.changed} of ${r.total_requested} episode${r.total_requested === 1 ? '' : 's'} marked ${done ? 'done' : 'not done'}`)
    selectedDoneIds.value.clear()
    await loadIdeas()
  } catch (e: any) {
    showError(e?.data?.detail || 'Bulk mark-done failed')
  } finally {
    bulkMarkRunning.value = false
  }
}

const form = reactive({
  genre: 'fantasy',
  theme: '',
  audience: 'adults',
  mood: 'calming',
  keywords: [] as string[],
  count: 5,
  // Resolved from last-used memory/history before ModelSelector mounts.
  // Empty is intentional: a paid model must never be a hidden default.
  model: '',
  creative_mode: 'guided' as 'strict' | 'guided' | 'open',
  creative_direction: '',
  // v1.0.165+ — optional title template. Empty = LLM titles freely.
  // When set (e.g. "Fall asleep to {X}"), the backend instructs the
  // LLM to shape every generated title to it, substituting {X} with
  // each idea's own subject. Persists per-project across reloads.
  title_template: '',
  // v1.0.70: pinned chapter / item count per idea. Empty / 0 / null =
  // let the LLM pick per-idea. When set, every generated idea's title
  // and suggested_chapters will equal this value (see backend
  // rewriteLeadingCount + pinned-chapters prompt rule).
  items_per_listicle: null as number | null,
  // v1.0.92+ — per-generation niche override. Hydrated from the project's
  // saved niche_id on mount, but the user can dial it up/down here without
  // touching the project meta. Empty string = "no niche for this batch"
  // (sent as `__none__` to force override even when the project has one).
  niche_id: '',
})

// Tracks the project's currently-saved niche so the UI can show
// "Overriding saved niche '<name>'" when the picker doesn't match.
// Empty string = project has no saved niche.
const projectNicheId = ref<string>('')

// v1.0.170 — Channel context strip disclosure. Collapsed by default so the
// page opens straight onto the generator; the strip's one-line summary
// (Format · Topic · Titles) is always visible, and clicking it reveals the
// detail panel that the old config cards used to show inline.
const setupExpanded = ref(false)
// v1.0.171 — "Other ways to add" (manual / paste / import) collapsed by
// default so these rare power ops don't compete with the Generate button.
const otherWaysOpen = ref(false)

// v1.0.93+ — channel-level title prefix/suffix. Reads from + writes to
// the SAME project-config keys the Metadata Generator uses (broll_channel_
// title_prefix / broll_channel_title_suffix), so editing on either surface
// keeps both in sync. The backend's /generate/ideas route wraps every
// generated idea's title with these values; if both are empty, no
// wrapping happens.
const titleConfig = reactive({
  prefix: '',
  suffix: '',
})
const TITLE_PREFIX_KEY = 'broll_channel_title_prefix'
const TITLE_SUFFIX_KEY = 'broll_channel_title_suffix'

// Sample title used in the live preview. Pulled from the prayer niche
// example pool when the project is on the prayer niche; otherwise a
// generic placeholder so the user can still visualise the wrap.
const titlePreviewText = computed(() => {
  const base = 'A Prayer for Anxious Hearts'
  return (titleConfig.prefix || '') + base + (titleConfig.suffix || '')
})

// v1.0.93+ — Ideas Generator presets. Captures the full form so users
// running multiple channel framings on one project (e.g. "Morning Prayer"
// AND "Evening Prayer" AND "Daily Devotional" all on Abiding Faith) can
// switch in one click instead of retyping seven fields per batch. Device-
// aware filtering comes from usePresets directly — presets saved on Mac A
// stay hidden on Mac B by default with a toggle to reveal.
const ideasPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'ideas_generator',
  // v1.0.93+ — explicit Apply only. The Ideas form is driven primarily
  // by project meta (format_id + niche_id); auto-applying a preset on
  // mount races the project-meta hydration and silently overwrites the
  // saved niche on every navigation. User must click Apply to load a
  // preset into the form.
  autoApplyOnLoad: false,
  snapshot: () => ({
    // Form fields. Episode-specific keys are stripped automatically by
    // usePresets (DEFAULT_EXCLUDE_KEYS handles episode_id / title), but
    // ideas form doesn't carry those anyway — this is all channel-shape
    // state: genre, theme, mood, keywords, audience, count, model.
    genre: form.genre,
    theme: form.theme,
    audience: form.audience,
    mood: form.mood,
    keywords: [...form.keywords],
    count: form.count,
    model: form.model,
    creative_mode: form.creative_mode,
    creative_direction: form.creative_direction,
    title_template: form.title_template,
    items_per_listicle: form.items_per_listicle,
    niche_id: form.niche_id,
    title_prefix: titleConfig.prefix,
    title_suffix: titleConfig.suffix,
  }),
  apply: (data: any) => {
    if (!data || typeof data !== 'object') return
    if (typeof data.genre === 'string') form.genre = data.genre
    if (typeof data.theme === 'string') form.theme = data.theme
    if (typeof data.audience === 'string') form.audience = data.audience
    if (typeof data.mood === 'string') form.mood = data.mood
    if (Array.isArray(data.keywords)) form.keywords = [...data.keywords]
    if (typeof data.count === 'number') form.count = data.count
    if (typeof data.model === 'string') form.model = data.model
    if (['strict', 'guided', 'open'].includes(data.creative_mode)) form.creative_mode = data.creative_mode
    if (typeof data.creative_direction === 'string') form.creative_direction = data.creative_direction
    if (typeof data.title_template === 'string') form.title_template = data.title_template
    if (data.items_per_listicle === null || typeof data.items_per_listicle === 'number') {
      form.items_per_listicle = data.items_per_listicle
    }
    if (typeof data.niche_id === 'string') form.niche_id = data.niche_id
    if (typeof data.title_prefix === 'string') titleConfig.prefix = data.title_prefix
    if (typeof data.title_suffix === 'string') titleConfig.suffix = data.title_suffix
  },
})

function onIdeasPresetApplied() {
  ideasPresets.applyActive()
  success('Preset applied')
}

// ── Pattern + format wiring for the Ideas page ────────────────────────────
//
// PatternPicker filters by current format (Part 2 of this rollout). We
// fetch the project's effective format id from settings/config so the
// picker shows only patterns paired with that format by default. Last-
// used pattern + subject are persisted in the same config under
// `idea_generator_last_pattern` / `idea_generator_last_subject` —
// matches the *_last_* convention used by other generator pages.
const formatId = ref<string>('scenes')
// v1.0.83+: reactive section-label vocabulary for the active format
// ("Chapter" for sleep-story, "Reason" for bound-explainer, "Topic" for
// listicle). Used in form labels, table column headers, and inline copy
// so the Ideas page matches whatever the script will be structured as.
const sectionLabel = useSectionLabel(formatId)
// Map of format-id → display name, populated from /api/formats. Used to
// show "Format: Sleep Story" above the paste-prompt instead of "sleep-story",
// and to surface a "Switch" link to Settings → Format. Best-effort: if the
// fetch fails we fall back to displaying the id.
const formatNamesById = ref<Record<string, string>>({})
const formatDisplayName = computed(() => formatNamesById.value[formatId.value] || formatId.value)
// v1.0.165 — replaced the LAST_PATTERN_KEY / LAST_SUBJECT_KEY pair with
// a single title-template key. The old pattern preset persistence went
// with the Pattern system removal.
const LAST_TITLE_TEMPLATE_KEY = 'idea_generator_last_title_template'
// v1.0.71: also persist the last-used theme + items_per_listicle so a
// user who runs "10 mysteries" once doesn't have to retype it every
// generation. Sticks per-project (lives in settings/config alongside
// the title-template key), so each project keeps its own recent picks.
const LAST_THEME_KEY = 'idea_generator_last_theme'
const LAST_ITEMS_KEY = 'idea_generator_last_items_per_listicle'
// Legacy per-project model memory remains for compatibility. Current builds
// use app-wide last-used memory first, then heal from real generation history.
const LAST_MODEL_KEY = 'idea_generator_last_model'
const LAST_MODEL_STORAGE_KEY = 'story-studio.ideas.last_model.v1'
const modelPreferenceReady = ref(false)
let legacyProjectModel = ''

function readRememberedIdeaModel(): string {
  try { return window.localStorage.getItem(LAST_MODEL_STORAGE_KEY) || '' }
  catch { return '' }
}

function writeRememberedIdeaModel(model: string): void {
  if (!model) return
  try { window.localStorage.setItem(LAST_MODEL_STORAGE_KEY, model) }
  catch { /* private mode / storage failure is non-fatal */ }
}

function finishModelPreferenceHydration(): void {
  if (modelPreferenceReady.value) return
  const resolved = resolveInitialIdeaModel({
    rememberedModel: readRememberedIdeaModel(),
    ideas: allIdeas.value,
    legacyProjectModel,
  })
  if (resolved) {
    form.model = resolved
    writeRememberedIdeaModel(resolved)
  }
  // Mounting the picker only now prevents its first-usable fallback from
  // winning the race against project settings and real generation history.
  modelPreferenceReady.value = true
}
// v1.0.92+ — remember the most recent niche override per project. Resets
// to project.niche_id on next load when the user hasn't picked one yet.
const LAST_NICHE_KEY = 'idea_generator_last_niche_override'
let patternHydrated = false

/**
 * v1.0.66+ — keep the FULL format objects (not just id+name) so the
 * Ideas Generator dropdowns + Randomize / Surprise Me can pull
 * vocabularies from `format.idea.{genre|theme|mood|keyword}Vocabulary`.
 * Without this, BrainWise (listicle format) would still see sleep-
 * story-flavoured "coming-of-age / quiet rebellion / lantern" options
 * baked into the page even though the format has its own vocab.
 */
type FormatLite = {
  id: string
  name: string
  description?: string
  builtin?: boolean
  idea?: {
    audienceDefault?: string
    moodVocabulary?: string[]
    themeVocabulary?: string[]
    genreVocabulary?: string[]
    keywordVocabulary?: string[]
    guidanceText?: string
  }
  /** v1.0.102+ — script defaults read for the Add/Edit Idea editor so
   *  suggested_chapters / suggested_length pre-fill from the format
   *  instead of hardcoded 10 / '45 min' (sleep-story). */
  script?: {
    defaultChapterCount?: number
    defaultLengthMinutes?: number
  }
}
const formatsById = ref<Record<string, FormatLite>>({})
const activeFormat = computed<FormatLite | null>(() =>
  formatsById.value[formatId.value] || null,
)

async function loadFormatNames() {
  try {
    const list = await get<Array<FormatLite>>('/formats')
    const map: Record<string, string> = {}
    const fullMap: Record<string, FormatLite> = {}
    for (const f of list || []) {
      if (f && typeof f.id === 'string') {
        map[f.id] = f.name || f.id
        fullMap[f.id] = f
      }
    }
    formatNamesById.value = map
    formatsById.value = fullMap
  } catch { /* fall back to displaying the id */ }
}

// v1.0.93+ — page-level hydration error surface. Replaces the silent
// `catch { }` blocks that used to swallow failures (leading to "project
// missing" flashes and the form silently reverting to sleep-story).
// Each error state has a specific message + an action the user can take.
const hydrationError = ref<{ kind: 'project-missing' | 'project-fetch' | 'config-fetch' | 'project-no-format'; detail?: string } | null>(null)

async function retryHydration(): Promise<void> {
  hydrationError.value = null
  const ok = await loadPatternPreferences()
  if (ok) {
    // Re-run downstream loads after a successful retry. Stays in sync
    // with the orchestrated mount block below.
    await Promise.all([loadFormatNames(), loadIdeas(), ideasPresets.load()])
    finishModelPreferenceHydration()
  }
}

// v1.0.93+ Effective channel state card support.
//
// `projectHasExplicitFormat` distinguishes "user picked sleep-story
// deliberately" (good) from "form defaulted to sleep-story because meta
// fetch failed or returned no format_id" (bad). The Format slot in the
// card goes red only when the latter.
const projectHasExplicitFormat = computed(() => {
  return !hydrationError.value || hydrationError.value.kind !== 'project-no-format'
})

const hasEffectiveStateWarning = computed(() => {
  return !projectHasExplicitFormat.value || !form.niche_id
})

// Sample title in the live wrap preview. Uses the niche's first example
// topic when available so it's representative of what the user will get.
const effectiveStateSampleTitle = computed(() => {
  return 'A Prayer for Anxious Hearts'
})

function goToNicheTab(): void {
  // The Niche tab is at `/projects/:slug/settings` with activeTab=niche
  // (settings.vue reads from window state on mount via a manual jump in
  // the prior commit). For now route to the settings page; the user
  // clicks the Niche tab there.
  navigateTo(`/projects/${slug.value}/settings`)
}

async function loadPatternPreferences(): Promise<boolean> {
  // The project's chosen format lives on the project META, not on
  // /settings/config. settings.vue + scripts.vue both read meta.format_id;
  // ideas.vue used to read /settings/config.format_id which is always
  // undefined → formatId stayed at the 'narrative' default and BrainWise
  // (listicle) projects saw lantern/observatory/coming-of-age vocab. Fix:
  // hit project meta for format_id, settings/config for the *_last_*
  // pattern/subject memory.
  //
  // v1.0.93+ — returns true on success so the orchestrating mount can
  // gate downstream loads on it. Errors surface via `hydrationError`
  // (banner in the template) rather than being swallowed.
  let metaNiche = ''
  let metaFormatLoaded = false
  try {
    const meta = await get<any>(`/projects/${slug.value}`)
    if (!meta) {
      hydrationError.value = { kind: 'project-missing' }
      return false
    }
    if (typeof meta?.format_id === 'string' && meta.format_id) {
      formatId.value = canonicalFormatId(meta.format_id)
      metaFormatLoaded = true
    }
    if (typeof meta?.niche_id === 'string') metaNiche = meta.niche_id
  } catch (e: any) {
    hydrationError.value = { kind: 'project-fetch', detail: e?.data?.detail || e?.message || 'unknown error' }
    return false
  }
  projectNicheId.value = metaNiche
  // No format on the project meta → the page would silently fall back
  // to sleep-story. Surface this loudly via the banner; the user can
  // click through to Settings → Format to set one.
  if (!metaFormatLoaded) {
    hydrationError.value = { kind: 'project-no-format' }
    // Continue hydration anyway — the form is still usable, just with
    // sleep-story defaults that the user can see flagged in the banner
    // and the effective-state card.
  }
  try {
    const cfg = await get<any>(`/projects/${slug.value}/settings/config`)
    if (typeof cfg?.[LAST_TITLE_TEMPLATE_KEY] === 'string') form.title_template = cfg[LAST_TITLE_TEMPLATE_KEY]
    // Legacy per-project memory is considered only after app-wide memory and
    // real Ideas history. Old builds polluted this key with hardcoded GPT-4o.
    legacyProjectModel = typeof cfg?.[LAST_MODEL_KEY] === 'string' ? cfg[LAST_MODEL_KEY] : ''
    if (typeof cfg?.[LAST_THEME_KEY] === 'string') form.theme = cfg[LAST_THEME_KEY]
    if (typeof cfg?.[LAST_ITEMS_KEY] === 'number' && cfg[LAST_ITEMS_KEY] > 0) {
      form.items_per_listicle = cfg[LAST_ITEMS_KEY]
    }
    // Niche override hydration: prefer the last per-project override (if
    // user picked one recently), otherwise fall back to the project's
    // saved niche so the picker shows the active value out of the box.
    if (typeof cfg?.[LAST_NICHE_KEY] === 'string') {
      form.niche_id = cfg[LAST_NICHE_KEY]
    } else {
      form.niche_id = metaNiche
    }
    // v1.0.93+ — hydrate channel title prefix/suffix from the same keys
    // the Metadata Generator uses. One source of truth — editing in
    // either surface updates the other.
    if (typeof cfg?.[TITLE_PREFIX_KEY] === 'string') titleConfig.prefix = cfg[TITLE_PREFIX_KEY]
    if (typeof cfg?.[TITLE_SUFFIX_KEY] === 'string') titleConfig.suffix = cfg[TITLE_SUFFIX_KEY]
  } catch (e: any) {
    // Config fetch failure is non-fatal — the project state itself was
    // loaded above. Surface a soft warning + still set the niche default.
    hydrationError.value = { kind: 'config-fetch', detail: e?.data?.detail || e?.message || 'unknown error' }
    form.niche_id = metaNiche
  }
  patternHydrated = true
  return true
}

// Persists the per-project Ideas-form preferences (title template, theme,
// listicle count, niche override, channel title wrap). Named for history;
// v1.0.165 swapped the pattern fields for the title template.
async function saveIdeaPreferences() {
  // Skip the initial hydration round-trip — only fire on user-initiated
  // changes. Without this guard, the watch fires once when load sets the
  // initial value, writing the same value straight back.
  if (!patternHydrated) return
  try {
    const { put } = useApi()
    const preferences: Record<string, unknown> = {
      [LAST_TITLE_TEMPLATE_KEY]: form.title_template,
      [LAST_THEME_KEY]: form.theme,
      [LAST_ITEMS_KEY]: form.items_per_listicle,
      [LAST_NICHE_KEY]: form.niche_id,
      // v1.0.93+ — channel title wrap is persisted on every edit so the
      // metadata page picks it up on next load without an explicit save.
      [TITLE_PREFIX_KEY]: titleConfig.prefix,
      [TITLE_SUFFIX_KEY]: titleConfig.suffix,
    }
    // Never write an unresolved/empty model during initial hydration.
    if (modelPreferenceReady.value && form.model) {
      preferences[LAST_MODEL_KEY] = form.model
    }
    await put(`/projects/${slug.value}/settings/config`, preferences)
  } catch { /* non-fatal — selection still works in-session */ }
}

watch(() => form.title_template, saveIdeaPreferences)
watch(() => form.model, (model, previous) => {
  if (!modelPreferenceReady.value || !model || model === previous) return
  writeRememberedIdeaModel(model)
  void saveIdeaPreferences()
})
watch(() => form.theme, saveIdeaPreferences)
watch(() => form.items_per_listicle, saveIdeaPreferences)
watch(() => form.niche_id, saveIdeaPreferences)
watch(() => titleConfig.prefix, saveIdeaPreferences)
watch(() => titleConfig.suffix, saveIdeaPreferences)
// v1.0.93+ — five separate onMounted() calls used to race each other,
// and the worst offender was usePresets() auto-applying an active preset
// AFTER loadPatternPreferences() had populated the project niche →
// silently reverting the form on every navigation. Now sequenced:
//   1. Project state first (format_id + niche_id from meta). This is
//      the source of truth for the channel; everything else is layered.
//   2. Reference data in parallel (format list, custom lists, ideas).
//   3. Presets last (autoApplyOnLoad: false — they populate the dropdown
//      but don't touch the form until the user clicks Apply).
// loadCustomLists has its own onMounted() lower in this file because
// it's defined near the custom-list state block — kept there to avoid
// scattering the state ownership.
onMounted(async () => {
  const ok = await loadPatternPreferences()
  if (!ok) return  // banner is visible; downstream loads would compound the error noise
  await Promise.all([
    loadFormatNames(),
    loadIdeas(),
    ideasPresets.load(),  // dropdown only; no auto-apply
  ])
  finishModelPreferenceHydration()
})

// ── Generic fallback pools ────────────────────────────────────
//
// v1.0.67+ — every built-in format now ships its own
// genreVocabulary + keywordVocabulary, so these GENERIC_FALLBACK_*
// pools are only used when:
//   1. A custom format omits a vocab field (acceptable — author opted out)
//   2. A future built-in format ships without a vocab field by mistake
//   3. The user is on a project whose format_id doesn't resolve to any
//      loaded format (broken state — banner above warns about this)
//
// The pools are deliberately format-neutral now: tone-mixed words
// that work for sleep stories AND listicles AND true-crime, instead
// of the old sleep-story-leaning "lantern / observatory / weaver"
// bias that broke BrainWise users in v1.0.65.
const GENERIC_FALLBACK_GENRES = [
  'fantasy', 'mystery', 'documentary', 'explainer', 'comedy', 'thriller',
  'science', 'history', 'adventure', 'slice-of-life', 'anthology',
]
const GENERIC_FALLBACK_MOODS = [
  'calming', 'mysterious', 'curious', 'reflective', 'engaging',
  'tense', 'wry', 'hopeful', 'matter-of-fact', 'playful',
  'haunting', 'uplifting', 'contemplative',
]
const GENERIC_FALLBACK_THEMES = [
  'self-discovery', 'survival', 'curiosity', 'origins', 'transformation',
  'memory', 'identity', 'community', 'wonder', 'consequence',
]
const GENERIC_FALLBACK_KEYWORDS = [
  'forest', 'ocean', 'city', 'desert', 'mountain', 'storm',
  'ancient', 'modern', 'discovery', 'mystery', 'scientist',
  'artist', 'witness', 'evidence', 'journey',
]

const customGenres = ref<string[]>([])
const customMoods = ref<string[]>([])
const customThemes = ref<string[]>([])
const customKeywords = ref<string[]>([])

// v1.0.97+ — Niche-merged vocab pools.
//
// The backend's applyNicheToFormat() merges niche vocab INTO the
// effective format for the LLM prompt. The frontend's chip-input
// suggestions + Randomize button used to read ONLY format.idea.* —
// so all 100+ niche-specific keywords (prayer's "Lord", "Sabbath",
// "Prayer Before Bed", etc.) were invisible in the UI, even though
// they reached the LLM. Fix: merge format + niche pools client-side
// the same way the backend does, so the chip input shows the full
// union AND Randomize picks from the union.
const { niches: allNichesList } = useNiches()
const activeNiche = computed(() => {
  const id = form.niche_id
  if (!id) return null
  return allNichesList.value?.find(n => n.id === id) || null
})

/**
 * Resolve a vocab pool. Merges format + niche vocab when both have
 * entries for this field; falls back to whichever has entries; final
 * fallback is the GENERIC_FALLBACK_* pool (format-neutral). Dedupes
 * so a word appearing in both pools only shows once.
 */
function vocabFor(field: 'genre' | 'mood' | 'theme' | 'keyword'): readonly string[] {
  const fmt = activeFormat.value?.idea
  const niche = activeNiche.value
  const merged: string[] = []
  if (fmt) {
    const fmtPool =
      field === 'genre'   ? fmt.genreVocabulary :
      field === 'mood'    ? fmt.moodVocabulary :
      field === 'theme'   ? fmt.themeVocabulary :
      /* keyword */         fmt.keywordVocabulary
    if (fmtPool?.length) merged.push(...fmtPool)
  }
  if (niche?.vocabulary) {
    const nichePool =
      field === 'genre'   ? niche.vocabulary.genre :
      field === 'mood'    ? niche.vocabulary.mood :
      field === 'theme'   ? niche.vocabulary.theme :
      /* keyword */         niche.vocabulary.keyword
    if (nichePool?.length) merged.push(...nichePool)
  }
  if (merged.length > 0) {
    return Array.from(new Set(merged))
  }
  // No format vocab AND no niche vocab → fall back to generic pool.
  switch (field) {
    case 'genre':   return GENERIC_FALLBACK_GENRES
    case 'mood':    return GENERIC_FALLBACK_MOODS
    case 'theme':   return GENERIC_FALLBACK_THEMES
    case 'keyword': return GENERIC_FALLBACK_KEYWORDS
  }
}

/** True if this field's pool got contributions from the active format. */
function vocabFromFormat(field: 'genre' | 'mood' | 'theme' | 'keyword'): boolean {
  const fmt = activeFormat.value?.idea
  if (!fmt) return false
  if (field === 'genre')   return !!fmt.genreVocabulary?.length
  if (field === 'mood')    return !!fmt.moodVocabulary?.length
  if (field === 'theme')   return !!fmt.themeVocabulary?.length
  if (field === 'keyword') return !!fmt.keywordVocabulary?.length
  return false
}

/** True if this field's pool got contributions from the active niche. */
function vocabFromNiche(field: 'genre' | 'mood' | 'theme' | 'keyword'): boolean {
  const n = activeNiche.value?.vocabulary
  if (!n) return false
  if (field === 'genre')   return !!n.genre?.length
  if (field === 'mood')    return !!n.mood?.length
  if (field === 'theme')   return !!n.theme?.length
  if (field === 'keyword') return !!n.keyword?.length
  return false
}

/** Short label shown next to each field's heading. Now reflects BOTH
 *  format + niche when both contribute so the user can see at a glance
 *  why a particular keyword pool is wider than the format alone would
 *  imply. Examples:
 *    "From Sleep Story"
 *    "From B-Roll Narration + Prayer"
 *    "Generic" */
function vocabSourceLabel(field: 'genre' | 'mood' | 'theme' | 'keyword'): string {
  const fromFmt = vocabFromFormat(field)
  const fromNiche = vocabFromNiche(field)
  if (fromFmt && fromNiche) return `${formatDisplayName.value} + ${activeNiche.value!.name}`
  if (fromFmt) return formatDisplayName.value
  if (fromNiche) return activeNiche.value!.name
  return 'Generic'
}

/** Tooltip explaining where the dropdown's suggestions come from. Plain
 *  language ("topic" rather than the internal "niche"). */
function vocabSourceTooltip(field: 'genre' | 'mood' | 'theme' | 'keyword'): string {
  const fromFmt = vocabFromFormat(field)
  const fromNiche = vocabFromNiche(field)
  if (fromFmt && fromNiche) {
    return `These suggestions come from the ${formatDisplayName.value} format and the ${activeNiche.value!.name} topic combined.`
  }
  if (fromFmt) {
    return `These suggestions come from the ${formatDisplayName.value} format. Pick a Topic to add more subject-specific suggestions.`
  }
  if (fromNiche) {
    return `These suggestions come from the ${activeNiche.value!.name} topic. The current format doesn't add its own ${field} suggestions.`
  }
  return `Neither the ${formatDisplayName.value} format nor the chosen Topic adds ${field} suggestions, so these are generic. You can type your own anytime.`
}

const allGenres = computed(() => Array.from(new Set([...vocabFor('genre'), ...customGenres.value])).sort())
const allMoods = computed(() => Array.from(new Set([...vocabFor('mood'), ...customMoods.value])).sort())
const allThemes = computed(() => Array.from(new Set([...vocabFor('theme'), ...customThemes.value])).sort())
const allKeywords = computed(() => Array.from(new Set([...vocabFor('keyword'), ...customKeywords.value])).sort())

function onAddGenre(v: string) { if (!customGenres.value.includes(v)) { customGenres.value.push(v); persistCustomLists().catch(() => {}) } }
function onAddMood(v: string) { if (!customMoods.value.includes(v)) { customMoods.value.push(v); persistCustomLists().catch(() => {}) } }
function onAddTheme(v: string) { if (!customThemes.value.includes(v)) { customThemes.value.push(v); persistCustomLists().catch(() => {}) } }
function onAddKeyword(v: string) { if (!customKeywords.value.includes(v)) { customKeywords.value.push(v); persistCustomLists().catch(() => {}) } }

// ── Randomize / Surprise Me ───────────────────────────────────────────────
// Randomize fills the creative fields (genre, theme, mood, audience, keywords)
// from the existing pools — it does NOT touch `count` or `model` since those
// are user-controlled cost dials. Surprise Me randomizes then auto-generates.
const BASE_AUDIENCE_OPTIONS = ['adults', 'children', 'teens', 'all-ages']
// v1.0.66+: format's audienceDefault gets folded into the pool so e.g.
// listicle's "curious adults" is a valid randomize pick. The user's
// choice persists; this just expands what randomize CAN pick.
const audienceOptions = computed(() => {
  const fmtAud = activeFormat.value?.idea?.audienceDefault
  if (fmtAud && !BASE_AUDIENCE_OPTIONS.includes(fmtAud)) {
    return [fmtAud, ...BASE_AUDIENCE_OPTIONS]
  }
  return BASE_AUDIENCE_OPTIONS
})
/** True iff the active format declared its own audienceDefault (used by the label tag). */
const audienceFromFormat = computed(() => !!activeFormat.value?.idea?.audienceDefault)

// Seed the audience field from the format's default the first time
// the format loads on a fresh project — without this, listicle users
// see "adults" instead of "curious adults" until they manually pick.
// Only fires when the user hasn't typed anything custom yet (i.e. the
// field still holds the page's hardcoded 'adults' default).
let audienceSeeded = false
watch(activeFormat, (fmt) => {
  if (audienceSeeded) return
  const fmtAud = fmt?.idea?.audienceDefault
  if (fmtAud && form.audience === 'adults') {
    form.audience = fmtAud
    audienceSeeded = true
  }
}, { immediate: true })

function pickRandom<T>(arr: readonly T[]): T | undefined {
  if (!arr.length) return undefined
  return arr[Math.floor(Math.random() * arr.length)]
}

function pickRandomN<T>(arr: readonly T[], n: number): T[] {
  const pool = arr.slice()
  const out: T[] = []
  for (let i = 0; i < n && pool.length; i++) {
    const idx = Math.floor(Math.random() * pool.length)
    const [taken] = pool.splice(idx, 1)
    if (taken !== undefined) out.push(taken)
  }
  return out
}

function randomizeForm() {
  const genre = pickRandom(allGenres.value)
  const mood = pickRandom(allMoods.value)
  const audience = pickRandom(audienceOptions.value)
  if (genre) form.genre = genre
  if (mood) form.mood = mood
  if (audience) form.audience = audience
  // Theme is optional in the UI — always fill it when randomizing since the
  // user explicitly asked for a random starting point.
  form.theme = pickRandom(allThemes.value) || ''
  // 3–5 keywords keeps the prompt varied without blowing the 12-chip cap.
  const kwCount = 3 + Math.floor(Math.random() * 3)
  form.keywords = pickRandomN(allKeywords.value, kwCount)
  success(`Randomized: ${form.genre} · ${form.mood}${form.theme ? ' · ' + form.theme : ''}`)
}

async function surpriseMe() {
  randomizeForm()
  await generate()
}

// ── Add/Edit idea editor ─────────────────────────────────────────────────
const editorOpen = ref(false)
const editorMode = ref<'add' | 'edit'>('add')
const editorIdea = ref<any>(null)
const editorSaving = ref(false)

// v1.0.102+ — Idea editor defaults are now FORMAT-DRIVEN. Previously
// hardcoded 10 chapters / '45 min' (sleep-story). Read from the
// project's effective format via activeFormat (already loaded on the
// page for the format-indicator card). Falls back to the legacy
// 10/45 only when no format data is available (e.g. very first page
// load before /formats has returned).
const editorDefaultChapters = computed<number>(() => {
  const fmtDef = activeFormat.value?.script?.defaultChapterCount
  return typeof fmtDef === 'number' && fmtDef > 0 ? fmtDef : 10
})
const editorDefaultLengthMin = computed<number>(() => {
  const fmtDef = activeFormat.value?.script?.defaultLengthMinutes
  return typeof fmtDef === 'number' && fmtDef > 0 ? fmtDef : 45
})
const editorDefaultLengthStr = computed<string>(() => `${editorDefaultLengthMin.value} min`)

const editorForm = reactive({
  title: '', logline: '', mood: '',
  themesList: [] as string[],
  suggested_chapters: 10, suggested_length: '45 min',
})

function resetEditorForm(from?: any) {
  editorForm.title = from?.title || ''
  editorForm.logline = from?.logline || ''
  editorForm.mood = from?.mood || ''
  editorForm.themesList = Array.isArray(from?.themes) ? [...from.themes] : []
  editorForm.suggested_chapters = from?.suggested_chapters || editorDefaultChapters.value
  editorForm.suggested_length = from?.suggested_length || editorDefaultLengthStr.value
}

function openAddIdea() {
  editorMode.value = 'add'
  editorIdea.value = null
  resetEditorForm()
  editorOpen.value = true
}

function openEditIdea(idea: any) {
  editorMode.value = 'edit'
  editorIdea.value = idea
  resetEditorForm(idea)
  editorOpen.value = true
}

async function saveEditor() {
  editorSaving.value = true
  const payload = {
    title: editorForm.title.trim(),
    logline: editorForm.logline.trim(),
    mood: editorForm.mood.trim(),
    themes: editorForm.themesList,
    suggested_chapters: editorForm.suggested_chapters || editorDefaultChapters.value,
    suggested_length: editorForm.suggested_length.trim() || editorDefaultLengthStr.value,
  }
  try {
    if (editorMode.value === 'add') {
      const created = await post<any>(`/projects/${slug.value}/ideas`, payload)
      allIdeas.value.push(created)
      success('Idea added')
    } else if (editorIdea.value) {
      const updated = await patch<any>(`/projects/${slug.value}/ideas/${editorIdea.value.id}`, payload)
      const i = allIdeas.value.findIndex(x => x.id === updated.id)
      if (i >= 0) allIdeas.value[i] = updated
      success('Idea updated')
    }
    editorOpen.value = false
    // Remember new custom genre/mood for future autocomplete (mood only — genre isn't on an idea)
    if (payload.mood && !allMoods.value.includes(payload.mood)) {
      customMoods.value.push(payload.mood)
      persistCustomLists().catch(() => {})
    }
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to save idea')
  } finally {
    editorSaving.value = false
  }
}

async function loadCustomLists() {
  try {
    const config = await get<any>(`/projects/${slug.value}/settings/config`)
    customGenres.value = Array.isArray(config.custom_genres) ? config.custom_genres : []
    customMoods.value = Array.isArray(config.custom_moods) ? config.custom_moods : []
    customThemes.value = Array.isArray(config.custom_themes) ? config.custom_themes : []
    customKeywords.value = Array.isArray(config.custom_keywords) ? config.custom_keywords : []
  } catch {}
}

async function persistCustomLists() {
  const { put: putApi } = useApi()
  await putApi(`/projects/${slug.value}/settings/config`, {
    custom_genres: customGenres.value,
    custom_moods: customMoods.value,
    custom_themes: customThemes.value,
    custom_keywords: customKeywords.value,
  })
}

onMounted(loadCustomLists)

// ── Import Episode Folder ────────────────────────────────────────────────
const importOpen = ref(false)
const importPath = ref('')
const inspecting = ref(false)
const importing = ref(false)
const importCopy = ref(true)
// 'parsed' = keep the code from the folder name; 'next' = use the
// project's next available code. Defaults are set per-inspection in
// doInspect() so each new file picks the safest option (keep when
// available, next when taken).
const importCodeChoice = ref<'parsed' | 'next'>('parsed')
const inspectResult = ref<any>(null)

// Parent-folder mode: user picks one parent dir, we list every immediate
// subdir, they tick which to import, and we loop sequentially. Each row's
// `status` drives the inline progress UI so the user can see exactly where
// the loop is and which folders failed without losing the modal.
type ParentSubRow = {
  name: string
  path: string
  selected: boolean
  status: 'pending' | 'importing' | 'done' | 'skipped' | 'error'
  message: string
}
const importMode = ref<'single' | 'parent'>('single')
const parentPath = ref('')
const parentSubfolders = ref<ParentSubRow[]>([])
const parentScanning = ref(false)
const parentImporting = ref(false)

const assetLabels: Record<string, string> = {
  script: 'Script',
  metadata: 'Metadata',
  scene_prompts: 'Scene Prompts',
  thumb_prompts: 'Thumbnail Prompts',
  images: 'Scene Images',
  thumbnails: 'Thumbnail Images',
  audio: 'Audio',
  merged_audio: 'Merged Audio',
  video: 'Video',
}

const canImport = computed(() => !!inspectResult.value?.ok && !inspectResult.value.error)

// True when the inspector flagged ANY classifiable asset bucket — drives
// the "we'll open the mapping dialog after import" hint inside the modal.
const anyClassifiableAssets = computed(() => {
  const a = inspectResult.value?.assets
  if (!a) return false
  return Object.values(a).some(v => v === true)
})

function openImportFolder() {
  importOpen.value = true
  importMode.value = 'single'
  importPath.value = ''
  inspectResult.value = null
  importCopy.value = true
  parentPath.value = ''
  parentSubfolders.value = []
}

const parentSelectedCount = computed(() => parentSubfolders.value.filter(r => r.selected).length)

async function browseParentFolder() {
  try {
    const r = await post<{ path: string | null }>('/system/pick-folder', {
      title: 'Choose a parent folder — each subfolder will become its own episode',
      buttonLabel: 'Use This Parent',
    })
    if (!r.path) return
    parentPath.value = r.path
    await scanParentSubfolders()
  } catch (e: any) {
    showError(e.data?.detail || 'Folder picker failed')
  }
}

async function scanParentSubfolders() {
  if (!parentPath.value) return
  parentScanning.value = true
  parentSubfolders.value = []
  try {
    const r = await post<{ subfolders: { name: string; path: string }[] }>(
      '/system/list-subfolders',
      { parent: parentPath.value },
    )
    parentSubfolders.value = (r.subfolders || []).map(s => ({
      name: s.name,
      path: s.path,
      selected: true,
      status: 'pending' as const,
      message: '',
    }))
    if (parentSubfolders.value.length === 0) {
      showError('No subfolders found in that parent.')
    }
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to scan parent folder')
  } finally {
    parentScanning.value = false
  }
}

async function doParentImport() {
  if (parentImporting.value) return
  const queue = parentSubfolders.value.filter(r => r.selected)
  if (queue.length === 0) return
  parentImporting.value = true
  let imported = 0
  let failed = 0
  try {
    for (const row of queue) {
      row.status = 'importing'
      row.message = ''
      try {
        // Inspect first so we can auto-resolve the code: keep the parsed
        // code when free, fall back to next available when taken. Mirrors
        // the single-folder UX but without surfacing a radio per row —
        // 12 popups would be miserable.
        const inspect = await post<any>(`/projects/${slug.value}/episodes/inspect`, {
          source_path: row.path,
        })
        if (!inspect?.ok) {
          row.status = 'error'
          row.message = inspect?.error || 'Inspection failed'
          failed++
          continue
        }
        const overrideCode = inspect.parsed_code_taken
          ? inspect.next_available_code
          : inspect.parsed_code
        const r = await post<any>(`/projects/${slug.value}/episodes/import`, {
          source_path: row.path,
          copy_into_project: importCopy.value,
          override_code: overrideCode,
        })
        row.status = 'done'
        row.message = `${r.episode_code} — ${r.title}`
        imported++
      } catch (e: any) {
        row.status = 'error'
        row.message = e.data?.detail || 'Import failed'
        failed++
      }
    }
    await loadIdeas()
    if (imported > 0) {
      const tail = failed > 0 ? ` (${failed} failed)` : ''
      success(`Imported ${imported} episode${imported === 1 ? '' : 's'}${tail}`)
    } else if (failed > 0) {
      showError(`All ${failed} folder${failed === 1 ? '' : 's'} failed to import`)
    }
  } finally {
    parentImporting.value = false
  }
}

async function browseImportFolder() {
  try {
    const r = await post<{ path: string | null }>('/system/pick-folder', {})
    if (r.path) {
      importPath.value = r.path
      await doInspect()
    }
  } catch (e: any) {
    showError(e.data?.detail || 'Folder picker failed')
  }
}

async function doInspect() {
  if (!importPath.value) return
  inspecting.value = true
  try {
    const r = await post<any>(`/projects/${slug.value}/episodes/inspect`, {
      source_path: importPath.value,
    })
    inspectResult.value = r
    // Default the code choice based on whether the parsed code is free.
    // When taken, force "next" (the only legal option). When free,
    // default to keeping the parsed code — that's the typical intent
    // when re-importing a published episode by its known number.
    if (r?.ok) {
      importCodeChoice.value = r.parsed_code_taken ? 'next' : 'parsed'
    }
  } catch (e: any) {
    inspectResult.value = { ok: false, error: e.data?.detail || 'Inspection failed' }
  } finally {
    inspecting.value = false
  }
}

async function doImport() {
  if (!canImport.value) return
  importing.value = true
  try {
    // Translate the radio choice into the explicit code we're asking
    // the backend to use. Sending the actual code (rather than the
    // 'parsed'/'next' enum) keeps the API self-documenting and lets the
    // backend re-validate against its current state (in case a parallel
    // import happened to take the same number between inspect + import).
    const overrideCode = importCodeChoice.value === 'next'
      ? inspectResult.value?.next_available_code
      : inspectResult.value?.parsed_code
    const r = await post<any>(`/projects/${slug.value}/episodes/import`, {
      source_path: importPath.value,
      copy_into_project: importCopy.value,
      override_code: overrideCode,
    })
    success(`Imported ${r.episode_code} — ${r.title}`)
    importOpen.value = false
    await loadIdeas()
    // If the inspector found classifiable assets inside the source
    // folder, immediately open the Pipeline-style asset-import dialog
    // pre-populated with those files so the user can review the
    // canonical-rename plan and click Import (or re-map first). The
    // dialog uses 'move' mode because the source files are already
    // sitting inside the freshly-imported episode dir — moving them
    // to canonical paths in the same tree avoids a duplicate copy.
    const items = Array.isArray(r.prefilled_import_items) ? r.prefilled_import_items : []
    if (items.length > 0) {
      assetMapEpisode.value = {
        episode_code: r.episode_code,
        prefilled: items,
        // importCopy === true means "keep originals" → dialog should copy.
        // Unchecked → user wants the originals removed → dialog moves.
        mode: importCopy.value ? 'copy' : 'move',
      }
    }
  } catch (e: any) {
    showError(e.data?.detail || 'Import failed')
  } finally {
    importing.value = false
  }
}

// ── Post-import asset-mapping dialog ────────────────────────────────────
// Set after a successful folder import when the inspector discovered
// classifiable files. Drives the AssetImportDialog mount; null = closed.
interface AssetMapState { episode_code: string; prefilled: any[]; mode: 'copy' | 'move' }
const assetMapEpisode = ref<AssetMapState | null>(null)

async function onAssetsMapped(_summary: any) {
  // The importer invalidated its own cache server-side; refresh ideas
  // so the row reflects whatever new state the canonical files imply.
  await loadIdeas()
}

// ── In-modal preset editors ──────────────────────────────────────────────
// The Paste Ideas modal exposes a chip strip above the prompt so the
// user can override the format's prompt fields without leaving for
// Settings → Format. After save, refetchPastePrompt() refreshes the
// visible prompt so the user sees their changes immediately.
//
// v1.0.165 — the in-modal Pattern edit/copy helpers (activePattern,
// patternEditorOpen, openEditPatternForActive, copyActivePatternAsNew,
// onPatternSavedFromIdeas) were removed with the Pattern system. The
// title-template field handles the one capability that mattered.

// Format override drawer state — separate from the Settings page's
// version because we want a self-contained save/cancel flow that
// doesn't disturb the user's place in the Paste modal.
const formatOverrideOpen = ref(false)
const formatOverridesDraft = ref<Record<string, any> | null>(null)
const formatOverridesSaving = ref(false)
const formatOverridesError = ref('')

const selectedBaseFormat = computed(() => findFullFormat(formatId.value) || null)

async function openFormatOverrideEditor() {
  formatOverridesError.value = ''
  // Hydrate the draft with the project's current overrides so the user
  // sees their existing customisations as the starting point. Falls
  // through to null (no overrides) on any read error.
  try {
    const meta = await get<any>(`/projects/${slug.value}`)
    formatOverridesDraft.value = meta?.format_overrides ? JSON.parse(JSON.stringify(meta.format_overrides)) : null
  } catch {
    formatOverridesDraft.value = null
  }
  // Make sure the full Format library is loaded so selectedBaseFormat
  // resolves on first open of a fresh session.
  if (!selectedBaseFormat.value) await refreshFormats().catch(() => {})
  formatOverrideOpen.value = true
}

function closeFormatOverrideEditor() {
  if (formatOverridesSaving.value) return
  formatOverrideOpen.value = false
  formatOverridesDraft.value = null
  formatOverridesError.value = ''
}

async function saveFormatOverrides() {
  formatOverridesSaving.value = true
  formatOverridesError.value = ''
  try {
    const { put } = useApi()
    await put(`/projects/${slug.value}`, {
      format_id: formatId.value,
      format_overrides: formatOverridesDraft.value || undefined,
    })
    success('Format overrides saved')
    formatOverrideOpen.value = false
    formatOverridesDraft.value = null
    // Refresh the displayed paste-prompt so the user sees their edits.
    if (pasteOpen.value) await refetchPastePrompt()
  } catch (e: any) {
    formatOverridesError.value = e?.data?.detail || e?.message || 'Failed to save overrides'
    showError(formatOverridesError.value)
  } finally {
    formatOverridesSaving.value = false
  }
}

// ── Paste Ideas from LLM ────────────────────────────────────────────────
// Companion to /generate/ideas — lets the user generate ideas on an
// external LLM and paste the JSON array back in. Three panes: preset
// prompt (fetched from backend so wording can iterate without a frontend
// rebuild), paste textarea, preview table with per-row delete.
const pasteOpen = ref(false)
const pastePrompt = ref<string>('')
const pastePromptCopied = ref(false)
const pasteInput = ref('')
const pastePreviewing = ref(false)
const pasteImporting = ref(false)
const pastePreviewError = ref('')
interface PastePreviewRow {
  title: string; logline: string; themes: string[]
  suggested_chapters: number; suggested_length: string; mood: string
}
interface PasteRejectedRow { index: number; reason: string; raw: any }
const pastePreviewValid = ref<PastePreviewRow[]>([])
const pastePreviewRejected = ref<PasteRejectedRow[]>([])

async function openPasteIdeas() {
  pasteOpen.value = true
  pasteInput.value = ''
  pastePreviewError.value = ''
  pastePreviewValid.value = []
  pastePreviewRejected.value = []
  pastePromptCopied.value = false
  // Always re-fetch on open — the prompt now varies with the project's
  // active format AND the selected Pattern, both of which the user can
  // change between opens. Cheap (text/plain, server-side string assembly).
  await refetchPastePrompt()
}

// Re-fetched whenever the format or title template changes so the copied
// prompt always reflects the user's current selection. v1.0.165 — the
// pattern_id / pattern_subject query params were replaced by a single
// title_template param.
async function refetchPastePrompt() {
  const qs = new URLSearchParams()
  if (form.title_template) qs.set('title_template', form.title_template)
  const url = `/projects/${slug.value}/ideas/paste-prompt${qs.toString() ? `?${qs}` : ''}`
  try {
    pastePrompt.value = await get<string>(url)
  } catch {
    // Fall back to a minimal inline prompt if the route is unreachable —
    // the user can still paste, the preview will validate the shape.
    pastePrompt.value = 'Return a JSON array of objects with keys: title, logline, themes (array), suggested_chapters (int), suggested_length (string), mood (string).'
  }
  pastePromptCopied.value = false
}

// Live-refresh the prompt when the user changes the title template WHILE
// the modal is open. Skipped when closed (the next open refetches anyway).
watch(
  () => form.title_template,
  () => { if (pasteOpen.value) refetchPastePrompt() },
)

async function copyPastePrompt() {
  if (!pastePrompt.value) return
  // Primary: navigator.clipboard (works in browser + Electron with
  // clipboard-sanitized-write permission allowlisted in main.ts).
  try {
    await navigator.clipboard.writeText(pastePrompt.value)
    pastePromptCopied.value = true
    setTimeout(() => { pastePromptCopied.value = false }, 2000)
    return
  } catch { /* fall through to legacy path */ }
  // Fallback: hidden textarea + document.execCommand('copy'). Works on
  // Electron DMG builds where the permission handler previously blocked
  // navigator.clipboard entirely. Deprecated but still widely supported.
  try {
    const ta = document.createElement('textarea')
    ta.value = pastePrompt.value
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    if (ok) {
      pastePromptCopied.value = true
      setTimeout(() => { pastePromptCopied.value = false }, 2000)
      return
    }
  } catch { /* ignore */ }
  showError('Clipboard unavailable — select the prompt manually and copy')
}

async function doPastePreview() {
  if (!pasteInput.value.trim()) return
  pastePreviewing.value = true
  pastePreviewError.value = ''
  pastePreviewValid.value = []
  pastePreviewRejected.value = []
  try {
    const r = await post<{ valid: PastePreviewRow[]; rejected: PasteRejectedRow[] }>(
      `/projects/${slug.value}/ideas/import-paste?dry_run=1`,
      { json: pasteInput.value, dry_run: true },
    )
    pastePreviewValid.value = r.valid || []
    pastePreviewRejected.value = r.rejected || []
    if (!pastePreviewValid.value.length && !pastePreviewRejected.value.length) {
      pastePreviewError.value = 'Paste was parsed but produced zero rows'
    }
  } catch (e: any) {
    pastePreviewError.value = e?.data?.detail || 'Preview failed — check the JSON format'
  } finally {
    pastePreviewing.value = false
  }
}

async function doPasteImport() {
  if (!pastePreviewValid.value.length) return
  pasteImporting.value = true
  try {
    // Commit ONLY the rows currently in the preview — the user may have
    // deleted some with the ✕ button after the preview fetch. Rebuild the
    // JSON from the current reactive state rather than re-sending the
    // original paste (which would re-import the deleted rows).
    const payloadJson = JSON.stringify(pastePreviewValid.value)
    const r = await post<{ imported: number }>(
      `/projects/${slug.value}/ideas/import-paste`,
      { json: payloadJson },
    )
    success(`Imported ${r.imported} idea${r.imported === 1 ? '' : 's'} from paste`)
    pasteOpen.value = false
    await loadIdeas()
  } catch (e: any) {
    showError(e?.data?.detail || 'Import failed')
  } finally {
    pasteImporting.value = false
  }
}

const nextEpisode = computed(() => {
  const d = project.value?.episode_digits || 4
  return `${episodePrefix.value}${nextEpisodeNum.value.toString().padStart(d, '0')}`
})

const statusCounts = computed(() => ({
  new: allIdeas.value.filter(i => i.status === 'new').length,
  accepted: allIdeas.value.filter(i => i.status === 'accepted').length,
  dismissed: allIdeas.value.filter(i => i.status === 'dismissed').length,
}))

const filteredIdeas = computed(() => {
  let ideas = allIdeas.value
  if (statusFilter.value !== 'all') ideas = ideas.filter(i => i.status === statusFilter.value)
  if (sourceFilter.value === 'imported') ideas = ideas.filter(i => i.batch_id === 'imported')
  else if (sourceFilter.value === 'generated') ideas = ideas.filter(i => i.batch_id !== 'imported')
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase()
    ideas = ideas.filter(i =>
      i.title?.toLowerCase().includes(q) || i.logline?.toLowerCase().includes(q) ||
      i.themes?.some((t: string) => t.toLowerCase().includes(q)) ||
      i.mood?.toLowerCase().includes(q) || i.episode_code?.toLowerCase().includes(q))
  }
  // Sort
  ideas = [...ideas].sort((a, b) => {
    let va = a[sortField.value] ?? ''
    let vb = b[sortField.value] ?? ''
    if (typeof va === 'string') va = va.toLowerCase()
    if (typeof vb === 'string') vb = vb.toLowerCase()
    if (va < vb) return sortDir.value === 'asc' ? -1 : 1
    if (va > vb) return sortDir.value === 'asc' ? 1 : -1
    return 0
  })
  return ideas
})

const totalPages = computed(() => Math.max(1, Math.ceil(filteredIdeas.value.length / PER_PAGE)))
const pageIdeas = computed(() => {
  const start = (page.value - 1) * PER_PAGE
  return filteredIdeas.value.slice(start, start + PER_PAGE)
})
const allPageSelected = computed(() => {
  const newOnPage = pageIdeas.value.filter(i => i.status === 'new')
  return newOnPage.length > 0 && newOnPage.every(i => selectedIds.value.has(i.id))
})

// Reset page when filter changes
watch([statusFilter, searchQuery, sourceFilter], () => { page.value = 1 })

function toggleSort(field: string) {
  if (sortField.value === field) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else { sortField.value = field; sortDir.value = field === 'generated_at' ? 'desc' : 'asc' }
}
function sortIcon(field: string) { return sortField.value === field ? (sortDir.value === 'asc' ? '▲' : '▼') : '' }
function toggleExpand(id: string) { expandedId.value = expandedId.value === id ? null : id }
function toggleSelect(id: string) { selectedIds.value.has(id) ? selectedIds.value.delete(id) : selectedIds.value.add(id) }
function toggleAll(e: Event) {
  const checked = (e.target as HTMLInputElement).checked
  for (const idea of pageIdeas.value) {
    if (idea.status === 'new') { checked ? selectedIds.value.add(idea.id) : selectedIds.value.delete(idea.id) }
  }
}
function shortDate(d: string) {
  try { return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) } catch { return d }
}

async function loadIdeas() {
  try {
    const data = await get<any>(`/projects/${slug.value}/ideas`)
    // Defensive: only clobber the local list when the backend actually
    // returned an `ideas` array. A 200 with no body or a transient
    // upstream issue used to result in `data.ideas || []` blanking the
    // user's already-loaded ideas — symptom: "ideas occasionally
    // disappear on navigation". Now we only update when we have a real
    // array to update from.
    if (Array.isArray(data?.ideas)) {
      allIdeas.value = data.ideas
      nextEpisodeNum.value = data.next_episode_number || 1
      episodePrefix.value = data.episode_prefix || 'EP'
      // Successful load clears any prior load-error banner.
      ideasLoadError.value = ''
    } else {
      ideasLoadError.value = 'Project returned no ideas payload — try refreshing.'
    }
  } catch (e: any) {
    // Surface the failure instead of swallowing it. Keep the previously-
    // loaded ideas list intact so a transient blip doesn't wipe the
    // user's view.
    ideasLoadError.value = e?.data?.detail || e?.message || 'Couldn\'t load ideas from this project.'
  }
}
// v1.0.93+ — visible error surface for /ideas endpoint failures.
const ideasLoadError = ref('')

async function generate() {
  generating.value = true
  try {
    // Drop items_per_listicle when blank so the backend treats it as
    // unset (LLM picks within format range). Sending 0 / null would
    // get coerced to NaN by some validators; cleaner to omit.
    const body: any = { ...form, keywords: form.keywords }
    if (!body.items_per_listicle || body.items_per_listicle <= 0) {
      delete body.items_per_listicle
    }
    // Niche override semantics:
    //   - form.niche_id matches projectNicheId → omit (use project default)
    //   - form.niche_id !== projectNicheId AND empty → send '__none__'
    //     (force "no niche for this batch" even when project has one saved)
    //   - form.niche_id !== projectNicheId AND non-empty → send the override
    if (form.niche_id === projectNicheId.value) {
      delete body.niche_id
    } else if (!form.niche_id) {
      body.niche_id = '__none__'
    }
    // v1.0.93+ channel title wrap. Always sent (even when empty) so the
    // backend uses the form's current values rather than the project
    // config — keeps the live preview honest with what actually gets
    // generated. Backend treats both empty strings as "no wrapping".
    body.title_prefix = titleConfig.prefix
    body.title_suffix = titleConfig.suffix
    // v1.0.165 — the X-Pattern-Warning header path was removed with the
    // Pattern system. The title template is a plain string that can't
    // "fail to load", so there's nothing to warn about; a normal POST
    // is enough.
    await post(`/projects/${slug.value}/generate/ideas`, body)
    await loadIdeas()
    page.value = 1; sortField.value = 'generated_at'; sortDir.value = 'desc'
    success('Ideas generated!')
  } catch (e: any) { showError(e.data?.detail || 'Failed to generate') }
  finally { generating.value = false }
}

// ── Accept dialog: episode-code chooser ──────────────────────────────────
//
// `next` keeps the auto-assignment behaviour acceptIdea has always had
// (consume next_episode_number or first recycled). `custom` lets the
// user pick a specific code — typically to fill a known gap (e.g. they
// want this idea to land at TN0042 because the surrounding episodes are
// 41/43). Validation is live: the resolved code must NOT collide with
// any existing accepted episode AND must match the project's prefix +
// digits.
type AcceptCodeMode = 'next' | 'custom'
const acceptCodeMode = ref<AcceptCodeMode>('next')
const acceptCustomNumber = ref<number | null>(null)

// Reset chooser state every time the dialog opens for a new idea —
// otherwise the previous "Custom = TN0042" choice would persist into
// the next accept and silently apply.
watch(acceptDialogIdea, (v) => {
  if (v) {
    acceptCodeMode.value = 'next'
    acceptCustomNumber.value = null
  }
})

const acceptedCodes = computed(() => new Set(
  allIdeas.value
    .filter(i => i.status === 'accepted' && i.episode_code)
    .map(i => i.episode_code as string),
))

const resolvedCustomCode = computed(() => {
  if (typeof acceptCustomNumber.value !== 'number' || !Number.isFinite(acceptCustomNumber.value)) return ''
  const d = project.value?.episode_digits || 4
  return `${episodePrefix.value}${String(acceptCustomNumber.value).padStart(d, '0')}`
})

const acceptCodeError = computed(() => {
  if (acceptCodeMode.value !== 'custom') return ''
  const n = acceptCustomNumber.value
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'Pick a number'
  if (!Number.isInteger(n) || n < 1) return 'Must be a positive integer'
  if (acceptedCodes.value.has(resolvedCustomCode.value)) {
    return `${resolvedCustomCode.value} is already in use`
  }
  return ''
})

const acceptCodeValid = computed(() => {
  if (acceptCodeMode.value === 'next') return true
  return !acceptCodeError.value && !!resolvedCustomCode.value
})

function showAcceptDialog(idea: any) { acceptDialogIdea.value = idea }

async function doAccept(action: 'folders' | 'script') {
  const idea = acceptDialogIdea.value; if (!idea) return
  if (!acceptCodeValid.value) return
  try {
    const body: any = { auto_generate_script: false }
    if (acceptCodeMode.value === 'custom') {
      body.override_code = resolvedCustomCode.value
    }
    const result = await post<any>(`/projects/${slug.value}/ideas/${idea.id}/accept`, body)
    acceptDialogIdea.value = null; await loadIdeas()
    const code = result.episode_code || nextEpisode.value
    success(`Accepted! ${code} folders created.`)
    if (action === 'script') navigateTo({ path: `/projects/${slug.value}/scripts`, query: { episode_id: code, title: idea.title, chapters: idea.suggested_chapters, length: idea.suggested_length === '60 min' ? '60' : '45' } })
  } catch (e: any) { showError(e.data?.detail || 'Failed to accept') }
}
// ── Renumber dialog (already-accepted episode rename) ────────────────────
const renumberDialogIdea = ref<any>(null)
const renumberCodeMode = ref<'next' | 'custom'>('next')
const renumberCustomNumber = ref<number | null>(null)
const renumberRunning = ref(false)

watch(renumberDialogIdea, (v) => {
  if (v) {
    renumberCodeMode.value = 'next'
    renumberCustomNumber.value = null
  }
})

const resolvedRenumberCode = computed(() => {
  if (renumberCodeMode.value === 'next') return nextEpisode.value
  if (typeof renumberCustomNumber.value !== 'number') return ''
  const d = project.value?.episode_digits || 4
  return `${episodePrefix.value}${String(renumberCustomNumber.value).padStart(d, '0')}`
})

const renumberCodeError = computed(() => {
  const code = resolvedRenumberCode.value
  if (!code) return 'Pick a code'
  if (code === renumberDialogIdea.value?.episode_code) return 'Same as current code — pick a different number'
  if (acceptedCodes.value.has(code)) return `${code} is already in use`
  if (renumberCodeMode.value === 'custom') {
    const n = renumberCustomNumber.value
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return 'Must be a positive integer'
  }
  return ''
})

const renumberValid = computed(() => !renumberCodeError.value && !!resolvedRenumberCode.value)

function openRenumberDialog(idea: any) {
  renumberDialogIdea.value = idea
}

async function doRenumber() {
  const idea = renumberDialogIdea.value
  if (!idea || !renumberValid.value) return
  renumberRunning.value = true
  try {
    const r = await post<any>(
      `/projects/${slug.value}/episodes/${idea.episode_code}/renumber`,
      { new_code: resolvedRenumberCode.value },
    )
    renumberDialogIdea.value = null
    await loadIdeas()
    const warnSuffix = (r.warnings || []).length
      ? ` (${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'})`
      : ''
    success(`${r.old_code} → ${r.new_code}${warnSuffix}`)
    if ((r.warnings || []).length) {
      // Surface non-fatal warnings via the toast text so the user
      // sees what didn't fully complete (e.g. "Source folder did not
      // exist on disk"). Re-running renumber on the same episode is
      // safe — operations are idempotent.
      r.warnings.forEach((w: string) => showError(`Renumber warning: ${w}`))
    }
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Renumber failed')
  } finally {
    renumberRunning.value = false
  }
}

async function batchAccept() {
  if (!selectedIds.value.size) return
  try {
    await post(`/projects/${slug.value}/ideas/batch-accept`, { idea_ids: Array.from(selectedIds.value) })
    selectedIds.value.clear(); await loadIdeas()
    success('Batch accepted!')
  } catch (e: any) { showError(e.data?.detail || 'Failed') }
}
async function dismiss(id: string) { await post(`/projects/${slug.value}/ideas/${id}/dismiss`); await loadIdeas() }
function formatRelativeTime(iso: string | null): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diff = Date.now() - then
  if (diff < 0) return 'just now'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`
  const yr = Math.floor(day / 365)
  return `${yr} year${yr === 1 ? '' : 's'} ago`
}

function buildResetMessage(idea: any, p: any): string {
  if (!p?.exists || !p?.file_count) {
    return `This deletes the empty ${idea.episode_code}/ folder and returns the idea to its unused state.`
  }
  const lines = [
    `This deletes ${p.file_count} file${p.file_count === 1 ? '' : 's'} (${p.total_bytes_human}) from ${idea.episode_code}/ on disk:`,
    '',
  ]
  const b = p.breakdown || {}
  if (b.images) lines.push(`• ${b.images} image${b.images === 1 ? '' : 's'}`)
  if (b.audio) lines.push(`• ${b.audio} audio chunk${b.audio === 1 ? '' : 's'}`)
  if (b.video) lines.push(`• ${b.video} video file${b.video === 1 ? '' : 's'}`)
  if (b.scripts) lines.push(`• ${b.scripts} script${b.scripts === 1 ? '' : ''}/doc${b.scripts === 1 ? '' : 's'}`)
  if (b.other) lines.push(`• ${b.other} other file${b.other === 1 ? '' : 's'}`)
  const rel = formatRelativeTime(p.last_modified_iso)
  lines.push('')
  lines.push(rel ? `Last modified ${rel}. Cannot be undone.` : 'Cannot be undone.')
  return lines.join('\n')
}

async function resetIdea(idea: any) {
  let message = `This deletes the ${idea.episode_code} folder on disk (script, prompts, any generated images/audio) and returns the idea to its unused state.`
  try {
    const preview = await get<any>(`/projects/${slug.value}/ideas/${idea.id}/reset-preview`)
    message = buildResetMessage(idea, preview)
  } catch { /* fall back to generic copy — don't block the operator */ }
  const ok = await ask({
    title: `Reset "${idea.title}"?`,
    message,
    confirmLabel: 'Reset idea',
    danger: true,
  })
  if (!ok) return
  try { await post(`/projects/${slug.value}/ideas/${idea.id}/reset`); await loadIdeas(); success('Reset done.') }
  catch (e: any) { showError(e.data?.detail || 'Failed') }
}
async function remove(id: string) {
  // Two-tier safeguard, calibrated to the cost of a misclick:
  //
  // - **New / dismissed** ideas: no on-disk work, no episode_code, low
  //   blast radius if deleted by accident. Gmail-style optimistic
  //   hide + 10 s undo toast (extended from 5 s on user feedback —
  //   "felt too quick to recover from a fat-finger").
  //
  // - **Accepted** ideas: have an episode_code, a folder, possibly
  //   rendered assets, possibly an upload sidecar. Misclick here can
  //   cost real work. We block on a confirm dialog FIRST — even if
  //   the user clicks through immediately, the explicit step gives
  //   them a moment to read the warning. Undo is still wired up after
  //   confirmation, so the recovery path is layered (confirm → undo).
  const idx = allIdeas.value.findIndex(i => i.id === id)
  if (idx < 0) return
  const target = allIdeas.value[idx]
  const wasSelected = selectedIds.value.has(id)
  const label = target.title ? `"${target.title}"` : 'idea'

  if (target.status === 'accepted') {
    const code = target.episode_code || '?'
    const ok = await ask({
      title: `Delete accepted episode ${code}?`,
      message: `Removes ${label} from ideas.json and recycles ${code} so a future Accept can reuse the number. The on-disk folder + any rendered assets / sidecar / uploaded video link are NOT deleted (we don't touch user files automatically) — they'll just be unowned until you clean them up manually or hit ${code} again. After this, an undo toast gives you 10 seconds to take it back.`,
      confirmLabel: 'Delete idea',
      danger: true,
    })
    if (!ok) return
  }

  // Optimistic removal — applies after the confirm gate (if any) has
  // already passed.
  allIdeas.value = [...allIdeas.value.slice(0, idx), ...allIdeas.value.slice(idx + 1)]
  selectedIds.value.delete(id)

  successUndoable({
    message: `Deleted ${label}`,
    duration: 10_000,
    onUndo: () => {
      // Splice back at the original index so the user's view doesn't jump.
      allIdeas.value = [
        ...allIdeas.value.slice(0, idx),
        target,
        ...allIdeas.value.slice(idx),
      ]
      if (wasSelected) selectedIds.value.add(id)
    },
    onTimeout: async () => {
      // Only here do we actually hit the backend. If this fails the toast
      // helper will call onUndo to restore the UI and surface an error.
      await del(`/projects/${slug.value}/ideas/${id}`)
    },
  })
}

// ── Compact / Fill Gaps (v1.0.40) ────────────────────────────────────────
// Lazy-loads the rename plan when the user clicks "Compact codes" — the
// preview is a synthetic computation server-side (no disk writes), so
// it's cheap to fetch on demand rather than maintain it as a watched
// computed.
interface CompactRename { old_code: string; new_code: string; title: string }
interface CompactPreview {
  rename_plan: CompactRename[]
  noop_count: number
  total_accepted: number
  current_next_episode_number: number
  target_next_episode_number: number
}
const compactState = reactive<{
  open: boolean
  opening: boolean
  running: boolean
  preview: CompactPreview | null
  error: string
}>({
  open: false,
  opening: false,
  running: false,
  preview: null,
  error: '',
})

const projectPrefix = computed(() => episodePrefix.value)

async function openCompactDialog() {
  if (compactState.opening || compactState.running) return
  compactState.opening = true
  compactState.error = ''
  try {
    compactState.preview = await get<CompactPreview>(`/projects/${slug.value}/episodes/compact-preview`)
    compactState.open = true
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to compute compact plan')
  } finally {
    compactState.opening = false
  }
}

function closeCompactDialog() {
  if (compactState.running) return
  compactState.open = false
  compactState.preview = null
  compactState.error = ''
}

async function confirmCompact() {
  if (compactState.running) return
  compactState.running = true
  compactState.error = ''
  try {
    const r = await post<{
      ok: true
      rename_plan: CompactRename[]
      renamed: Array<{ old_code: string; new_code: string }>
      errors: Array<{ stage: string; detail: string }>
    }>(`/projects/${slug.value}/episodes/compact`, {})
    const renamedCount = r.renamed.length
    const errorCount = r.errors.length
    if (errorCount === 0) {
      success(`Compacted ${renamedCount} episode${renamedCount === 1 ? '' : 's'}. Reversible from the Unlinked Uploads tab for 30 days.`)
    } else {
      success(`${renamedCount} compacted, ${errorCount} error${errorCount === 1 ? '' : 's'} — see logs. Already-revertible from the Unlinked Uploads tab.`)
    }
    compactState.open = false
    compactState.preview = null
    await loadIdeas()
  } catch (e: any) {
    compactState.error = e?.data?.detail || e?.message || 'Compact failed'
  } finally {
    compactState.running = false
  }
}

// loadIdeas + ideasPresets.load() are orchestrated in the main mount
// block above (sequenced after loadPatternPreferences). Stale separate
// onMounted() calls used to live here and were the race-condition source.
</script>

<style scoped>
/* Generator panel */
.generator-panel { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 18px 20px 20px; }
.generator-title { margin: 0 0 4px; }
.generator-blurb { margin: 0 0 12px; }
.generator-body { display: flex; flex-direction: column; gap: 14px; }
.generator-actions { margin-top: 16px; padding-top: 14px; border-top: 1px dashed var(--border); display: flex; flex-direction: column; gap: 10px; }
.generator-actions-primary { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.generator-actions-secondary { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
/* Disclosure toggle is a borderless/background-less .btn, so its only
 * affordance is the text colour. `--text-muted` (#6b7280) reads fine on the
 * light bg but only hits ~3.9:1 on the dark page bg (#0f1117) — under the
 * 4.5:1 floor, which is why it was nearly invisible in dark mode. Use the
 * theme-aware `--text-secondary` (good contrast in both themes, still lighter
 * than the primary actions) and brighten to primary on hover for affordance. */
.other-ways-toggle { color: var(--text-secondary); }
.other-ways-toggle:hover { color: var(--text-primary); }

/* v1.0.171 — grouped form sections. Each fieldset is a labelled box so the
   long field list reads as three distinct decisions instead of one wall. */
.form-section {
  border: 1px solid var(--border, #2a2a2a);
  border-radius: var(--radius-sm, 6px);
  padding: 12px 14px 14px;
  margin: 0;
  min-width: 0;   /* let grid children shrink inside the fieldset */
}
.form-section-title {
  padding: 0 6px;
  margin-left: -2px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted, #9a9a9a);
}

/* Format Indicator Card — sits between the title and the form. Visual
   anchor that tells the user which format flavours every dropdown +
   prompt below. Sized to be noticeable but not dominant. */
.format-indicator-card {
  display: flex; gap: 16px; align-items: stretch; flex-wrap: wrap;
  background: var(--accent-dim); border: 1px solid var(--accent);
  border-radius: var(--radius-md); padding: 12px 14px; margin: 6px 0 14px;
}
.format-indicator-main { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.format-indicator-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.format-indicator-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); font-weight: 600; }
.format-indicator-name { font-size: 15px; color: var(--text-primary); }
.format-indicator-badge { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 6px; border-radius: 8px; font-weight: 600; }
.format-indicator-badge.badge-builtin { background: var(--bg-tertiary); color: var(--text-muted); border: 1px solid var(--border); }
.format-indicator-badge.badge-custom  { background: var(--accent); color: var(--bg-primary); border: 1px solid var(--accent); }
.format-indicator-badge.badge-warn    { background: #5a3a00; color: #ffd58a; border: 1px solid #ffd58a; }
.format-indicator-desc { margin: 2px 0 0; font-size: 13px; color: var(--text-primary); line-height: 1.45; }
.format-indicator-hint { margin: 4px 0 0; line-height: 1.45; }
.format-indicator-actions { display: flex; flex-direction: column; gap: 6px; align-items: stretch; min-width: 160px; }
.format-indicator-actions .btn { width: 100%; text-align: center; }

/* Per-field "From [Format]" tags shown next to dropdown labels. */
.vocab-source-tag {
  font-size: 10px; font-weight: 500; color: var(--text-muted);
  text-transform: none; letter-spacing: 0; margin-left: 4px;
}

/* Toolbar */
.toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.search-input { max-width: 260px; }
.filter-pills { display: flex; gap: 4px; }
.pill { padding: 4px 12px; font-size: 12px; color: var(--text-muted); background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 16px; cursor: pointer; font-family: inherit; }
.pill:hover { color: var(--text-primary); }
.pill.active { background: var(--accent-dim); color: var(--accent); border-color: var(--accent); }

/* Table */
.table-container { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: auto; max-height: calc(100vh - 320px); }
.ideas-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ideas-table thead { background: var(--bg-tertiary); position: sticky; top: 0; z-index: 1; }
.ideas-table th { padding: 10px 12px; text-align: left; font-weight: 500; color: var(--text-secondary); font-size: 12px; white-space: nowrap; border-bottom: 1px solid var(--border); background: var(--bg-tertiary); }
.ideas-table td { padding: 10px 12px; border-bottom: 1px solid var(--border); }
.th-check { width: 40px; }
.td-check { width: 40px; }
.td-code { white-space: nowrap; width: 70px; }
.td-title { font-weight: 500; color: var(--text-primary); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.td-date { white-space: nowrap; }
.td-actions { white-space: nowrap; display: flex; gap: 4px; align-items: center; }

.sortable { cursor: pointer; user-select: none; }
.sortable:hover { color: var(--accent); }

.idea-row { cursor: pointer; transition: background 0.1s; }
.idea-row:hover { background: var(--bg-hover); }
.idea-row.status-accepted { border-left: 3px solid var(--success); }
.idea-row.status-dismissed { opacity: 0.45; }

.status-badge { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; }
.status-badge.new { background: rgba(251,191,36,0.15); color: var(--warning); }
.status-badge.accepted { background: rgba(74,222,128,0.15); color: var(--success); }
.status-badge.dismissed { background: rgba(107,114,128,0.15); color: var(--text-muted); }

.code-badge { font-size: 11px; font-weight: 600; color: var(--success); }

/* Expanded row */
.expand-row td { padding: 0; background: var(--bg-tertiary); }
.expand-content { padding: 12px 16px 14px; }
.expand-logline { font-size: 13px; line-height: 1.5; color: var(--text-secondary); margin-bottom: 8px; }
.expand-tags { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.idea-tag { background: var(--accent-dim); color: var(--accent); padding: 1px 8px; border-radius: 10px; font-size: 11px; }

/* Pagination */
.pagination { display: flex; justify-content: center; align-items: center; gap: 16px; }
.page-info { font-size: 13px; color: var(--text-muted); }

/* Misc */
.btn-icon { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 13px; padding: 3px 6px; border-radius: 4px; }
.btn-icon.danger:hover { color: var(--error); background: rgba(248,113,113,0.1); }

.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; justify-content: center; align-items: center; z-index: 1000; padding: 24px; }
/* v1.0.402 — modals are responsive + internally scrollable so the footer
   buttons are always reachable on any window size (was a fixed 520px with no
   max-height, which cut off the Import button on the paste-ideas modal). */
.modal { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-xl); padding: 32px; width: min(520px, 92vw); box-sizing: border-box; max-height: calc(100vh - 48px); overflow-y: auto; }
/* Wide variant for content-heavy modals (e.g. the paste-ideas preview table).
   Scales with the window instead of a fixed cap. */
.modal.modal-wide { width: min(1100px, 94vw); }
.modal h2 { margin-bottom: 20px; }
.accept-preview { background: var(--bg-tertiary); border-radius: var(--radius-md); padding: 16px; }
.accept-preview h3 { color: var(--accent); margin-bottom: 4px; }
.accept-code { font-size: 15px; }
.accept-options { display: flex; gap: 12px; }

/* Episode-code chooser (used by both Accept + Renumber dialogs). The
   shape mirrors the radio + inline-input pattern from the folder-import
   override flow so the UX is consistent across all three places where
   the user picks an episode code. */
.accept-code-chooser {
  display: flex; flex-direction: column; gap: 8px;
  padding-top: 4px; border-top: 1px dashed var(--border);
  margin-top: 8px;
}
.code-choice {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 13px; cursor: pointer;
}
.code-choice input[type="radio"] { margin: 0; }
.code-prefix {
  display: inline-block; padding: 2px 6px;
  background: var(--bg-secondary); border-radius: 3px;
  font-family: 'Menlo', 'Monaco', monospace; font-size: 12px;
  color: var(--text-muted);
}
.code-input {
  width: 80px; padding: 2px 6px; font-size: 12px;
  display: inline-block; margin-left: 4px;
}
.accept-code-error {
  margin: 0; padding: 6px 10px;
  background: rgba(226, 92, 92, 0.10);
  color: var(--error, #e25c5c);
  border-radius: 4px; font-size: 11px;
}
.accept-code-resolved {
  margin: 0; font-size: 12px; color: var(--text-secondary);
}

/* v1.0.165+ — Title-template block on the Ideas page (replaced the
   Pattern picker). Sits between the niche row and the action buttons;
   dashed top divider + breathing room so it doesn't run flush. */
.ideas-title-template-block {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}
.ideas-title-template-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 4px;
}
.ideas-title-template-hint {
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.5;
}

/* v1.0.92+ — Niche picker block on the Ideas page. Same visual rhythm as
   the title-template block above it (dashed top divider + breathing room)
   so the two optional layers feel paired without crowding the form. */
.ideas-niche-block {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* v1.0.93+ — Channel title wrap block. Visually paired with the niche
   block above (same dashed divider) so the two channel-shape controls
   (niche + title wrap) cluster together visually. */
.ideas-title-wrap-block {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}
.title-wrap-header {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 4px;
}
.hint-line code {
  background: var(--bg-tertiary);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
}
.niche-override-banner {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px 12px;
  background: rgba(108, 143, 255, 0.08);
  border: 1px solid rgba(108, 143, 255, 0.25);
  border-radius: var(--radius-sm, 4px);
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}
.niche-override-banner .banner-icon {
  color: var(--accent, #6c8fff);
  font-weight: 600;
}
.niche-override-banner code {
  background: var(--bg-tertiary);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11px;
}
.niche-override-banner .banner-link {
  color: var(--accent, #6c8fff);
  cursor: pointer;
  text-decoration: underline;
  margin-left: 6px;
}
.niche-override-banner .banner-link:hover {
  opacity: 0.8;
}

/* Import modal */
.import-error {
  padding: 10px 12px;
  background: rgba(248, 113, 113, 0.10);
  border-left: 3px solid var(--error);
  border-radius: var(--radius-sm);
  font-size: 12px; color: var(--error);
}
.import-preview {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px;
}
.import-row { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; }
.import-row .label { font-size: 12px; color: var(--text-muted); min-width: 100px; }

/* Episode-code chooser — two radio cards side-by-side. The active card
   gets an accent border so the user's selection is unambiguous. */
.code-choice { display: flex; gap: 8px; flex-wrap: wrap; flex: 1; }
.code-option {
  display: flex; align-items: baseline; gap: 6px;
  padding: 6px 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12px;
  transition: border-color 0.12s, background 0.12s;
}
.code-option:hover { border-color: var(--accent); }
.code-option.active { border-color: var(--accent); background: rgba(240, 198, 116, 0.06); }
.code-option input { margin-right: 2px; cursor: pointer; }
.code-option strong { color: var(--text-primary); }
.code-hint { color: var(--text-muted); font-size: 11px; }
.import-conflicts { display: flex; flex-direction: column; gap: 4px; }
.conflict-item {
  padding: 6px 8px; background: rgba(234, 179, 8, 0.10);
  border-left: 3px solid #eab308;
  border-radius: var(--radius-sm);
  font-size: 12px; color: #eab308;
}
.asset-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 6px; }
.asset-cell {
  display: flex; gap: 6px; align-items: center;
  padding: 4px 8px; font-size: 12px;
}
.asset-check {
  width: 16px; text-align: center; font-weight: 700;
}
.asset-cell:has(.asset-check:not(:empty)) .asset-check { color: var(--accent); }
.asset-name { flex: 1; color: var(--text-secondary); }
.asset-count {
  font-size: 11px; color: var(--accent);
  background: rgba(240, 198, 116, 0.12);
  padding: 0 6px; border-radius: 999px;
}
.import-info {
  padding: 8px 10px; background: rgba(96, 165, 250, 0.08);
  border-left: 3px solid #60a5fa;
  border-radius: var(--radius-sm);
  font-size: 12px; color: #60a5fa;
}
.import-warnings {
  font-size: 11px; color: #eab308;
  display: flex; flex-direction: column; gap: 2px;
}

/* Mode switch sits above the path field — Single vs Parent. Two stacked
   radio cards so the labels can carry a one-line hint each (per the
   explain-as-you-go rule: every option needs an inline why). */
.import-mode-row {
  display: flex; gap: 8px;
  flex-wrap: wrap;
}
.import-mode-option {
  flex: 1; min-width: 240px;
  display: grid; grid-template-columns: 18px 1fr; column-gap: 8px; row-gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-tertiary);
  cursor: pointer;
  transition: border-color .12s, background .12s;
}
.import-mode-option:hover { border-color: var(--accent); }
.import-mode-option.active {
  border-color: var(--accent);
  background: rgba(240, 198, 116, 0.08);
}
.import-mode-option input { grid-row: span 2; align-self: center; }
.import-mode-label { font-size: 13px; font-weight: 600; }
.import-mode-hint { font-size: 11px; color: var(--text-muted); }

/* Parent-mode subfolder list — checkable rows with an inline status
   slot so per-folder progress (importing / done / error) shows up
   without leaving the modal. */
.parent-sub-list {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-tertiary);
  overflow: hidden;
}
.parent-sub-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 12px;
  font-size: 12px; color: var(--text-muted);
  border-bottom: 1px solid var(--border);
}
.parent-sub-rows {
  max-height: 280px; overflow-y: auto;
}
.parent-sub-row {
  display: grid; grid-template-columns: 18px 1fr auto; gap: 8px;
  align-items: center;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.parent-sub-row:last-child { border-bottom: none; }
.parent-sub-row.status-importing { background: rgba(96, 165, 250, 0.08); }
.parent-sub-row.status-done { color: var(--text-muted); }
.parent-sub-row.status-error { background: rgba(239, 68, 68, 0.08); }
.parent-sub-name { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.parent-sub-status { font-size: 11px; color: var(--text-muted); }
.parent-sub-row.status-error .parent-sub-status { color: #ef4444; }
.parent-sub-row.status-done .parent-sub-status { color: #34d399; }

/* Floating bulk-action bar at the bottom of the viewport. Sits above the
   modal-overlay z-index but below modals (z=1000) so opening a modal
   while a selection is active still hides the bar visually. */
.ideas-bulk-bar {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex; align-items: center; gap: 12px;
  padding: 10px 16px;
  border-radius: 999px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.3);
  z-index: 50;
}
.ideas-bulk-bar-count {
  font-size: 12px; font-weight: 600;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(240, 198, 116, 0.18);
  color: var(--accent);
}
.bulk-bar-enter-active, .bulk-bar-leave-active {
  transition: opacity .18s ease, transform .18s ease;
}
.bulk-bar-enter-from, .bulk-bar-leave-to {
  opacity: 0;
  transform: translate(-50%, 12px);
}

/* Paste-ideas modal */
.paste-prompt-box {
  margin: 6px 0 0;
  padding: 10px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-wrap: break-word;
  max-height: 200px;
  overflow-y: auto;
}

/* Source-of-truth strip above the paste prompt: explains the prompt
   varies with format + pattern, gives a Switch link to format settings
   and a Clear button for the active pattern. Subtle so it doesn't fight
   the prompt itself for attention. */
.paste-prompt-source {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--text-muted);
}
.paste-prompt-source-label {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
  color: var(--text-muted);
}
.paste-prompt-source-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-secondary);
}
.paste-prompt-source-chip strong {
  color: var(--text-primary);
  font-weight: 600;
}
.paste-prompt-source-link {
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
  /* Reset button defaults so <button class="paste-prompt-source-link"> looks
     like the existing NuxtLink — the chip strip mixes both element types. */
  background: transparent;
  border: none;
  padding: 0;
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
}
.paste-prompt-source-link:hover { color: var(--accent-hover); text-decoration: underline; }
.paste-prompt-source-clear {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0 0 0 4px;
  font-size: 11px;
  line-height: 1;
}
.paste-prompt-source-clear:hover { color: var(--error, #ef4444); }
.paste-prompt-source-hint {
  font-style: italic;
  color: var(--text-muted);
  opacity: 0.85;
}
.paste-input-box {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  margin-top: 6px;
}

/* Format override drawer — slides in over the Paste Ideas modal so the
   user can override the active format's prompt fields without leaving
   the page. z-index sits ABOVE .modal-overlay (which most modals in
   this app peg around 100-200) so the drawer floats correctly. */
.format-override-drawer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  justify-content: flex-end;
  z-index: 300;
}
.format-override-drawer {
  width: min(640px, 100%);
  height: 100vh;
  background: var(--bg-primary);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.2);
}
.fod-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}
.fod-header h3 { margin: 0; font-size: 15px; }
.fod-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}
.fod-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: flex-end;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
}
.fod-footer .text-danger {
  margin-right: auto;
  text-align: left;
}
.paste-preview-table {
  max-height: 40vh;
  overflow-y: auto;
  /* v1.0.402 — scroll sideways on a narrow window instead of crushing columns
     to one word per line. */
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
}
.paste-preview-row {
  display: flex;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
  align-items: baseline;
}
.paste-preview-row:last-child { border-bottom: none; }
.paste-preview-header {
  background: var(--bg-secondary);
  font-weight: 600;
  color: var(--text-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  position: sticky;
  top: 0;
}
/* Paste-preview column shape — matches the per-row layout. */
/* v1.0.402 — min-widths so flexible columns keep readable width (no
   one-word-per-line crush); the table scrolls sideways if the window is too
   narrow to fit them all. */
.paste-preview-row .ppr-num      { flex: 0 0 auto; min-width: 24px; color: var(--text-muted); font-size: 11px; }
.paste-preview-row .ppr-title    { flex: 1.5 1 0; min-width: 150px; font-weight: 600; }
.paste-preview-row .ppr-logline  { flex: 2 1 0; min-width: 220px; }
.paste-preview-row .ppr-themes   { flex: 1 1 0; min-width: 120px; }
.paste-preview-row .ppr-chapters { flex: 0 0 auto; width: 70px; text-align: center; }
.paste-preview-row .ppr-length   { flex: 0 0 auto; width: 80px; }
.paste-preview-row .ppr-mood     { flex: 1 1 0; min-width: 120px; }
.paste-preview-row .ppr-remove   { flex: 0 0 auto; width: 28px; }
/* In header row: the title-column override above (font-weight 600) shouldn't
   stack on top of the header's own font-weight; keep it clean. */
.paste-preview-header .ppr-num,
.paste-preview-header .ppr-title,
.paste-preview-header .ppr-logline,
.paste-preview-header .ppr-themes,
.paste-preview-header .ppr-chapters,
.paste-preview-header .ppr-length,
.paste-preview-header .ppr-mood {
  font-weight: 600;
  color: var(--text-muted);
}
.paste-rejected {
  padding: 8px 10px;
  background: rgba(248, 113, 113, 0.08);
  border-left: 3px solid var(--error, #ef4444);
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.paste-rejected-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin-top: 4px;
}
.paste-rejected-index {
  font-weight: 600;
  color: var(--error, #ef4444);
  min-width: 28px;
}
.paste-rejected-reason { color: var(--text-primary); flex-shrink: 0; }
.paste-rejected-raw {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

/* ── Source filter + bulk-mark-done UI ────────────────────────────────── */

.source-pills {
  margin-left: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.source-label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-right: 4px;
}

/* Banner shown when (a) Source = Imported AND there are unmarked ones,
   or (b) the user has multi-selected accepted ideas. The "subtle" variant
   is used for the multi-select toolbar — softer treatment so it doesn't
   compete visually with the import banner above it. */
.bulk-mark-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: rgba(46, 160, 67, 0.08);
  border: 1px solid rgba(46, 160, 67, 0.32);
  border-radius: var(--radius-md);
  font-size: 13px;
}
.bulk-mark-banner.subtle {
  background: var(--bg-tertiary);
  border-color: var(--border);
}
.bulk-mark-text { color: var(--text-primary); }

/* Inline tags on the table rows — surface provenance + manual-done state
   without adding a column. Kept compact so they don't push the title out. */
.source-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  border-radius: 4px;
}
.imported-tag {
  background: rgba(96, 165, 250, 0.12);
  color: #60a5fa;
  border: 1px solid rgba(96, 165, 250, 0.3);
}
.manual-done-tag {
  display: inline-flex;
  align-items: center;
  margin-left: 8px;
  padding: 1px 7px;
  font-size: 10px;
  font-weight: 600;
  border-radius: 999px;
  background: rgba(46, 160, 67, 0.18);
  color: var(--success, #3fb950);
  border: 1px solid rgba(46, 160, 67, 0.35);
}

/* Marked-done rows get a subtle green left-border so they stand out at a
   glance in the accepted-list view (where most rows look the same otherwise). */
.idea-row.is-marked-done { border-left: 3px solid var(--success, #3fb950); }
.idea-row.is-imported .td-code { color: #60a5fa; }

/* Compact / Fill Gaps modal — scoped tightly so we don't pick up generic
   modal styles from the dashboard layout that might fight our padding /
   width budget. */
.compact-modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 999;
}
.compact-modal {
  position: fixed; top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  width: min(560px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
  display: flex; flex-direction: column;
  z-index: 1000;
}
.compact-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.compact-modal-close {
  background: none; border: none; font-size: 16px;
  color: var(--text-secondary);
  cursor: pointer; padding: 0 4px;
}
.compact-modal-close:hover { color: var(--text-primary); }
.compact-modal-body {
  padding: 14px 16px;
  overflow-y: auto;
  flex: 1;
}
.compact-modal-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
}
.compact-rename-list {
  margin-top: 12px;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  max-height: 320px;
  overflow-y: auto;
}
.compact-rename-row {
  display: flex; gap: 8px; align-items: center;
  padding: 3px 0;
  font-size: 12px;
}
.compact-rename-row code { font-size: 12px; }
.compact-rename-title {
  flex: 1; min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* v1.0.93+ Hydration error banners. Two kinds of failure surface here:
   project-level (project-missing / project-fetch / project-no-format /
   config-fetch) and ideas-level (ideas-fetch). All render the same
   visual shape — yellow card with a strong call-out + a recovery action
   on the right. The is-project-missing variant goes red because it
   means the page can't usefully be operated until the URL is fixed. */
.hydration-banner {
  margin-top: 12px;
  padding: 10px 14px;
  background: rgba(240, 198, 116, 0.08);
  border: 1px solid rgba(240, 198, 116, 0.30);
  border-left: 3px solid rgba(240, 198, 116, 0.80);
  border-radius: var(--radius-sm, 4px);
  font-size: 13px;
  line-height: 1.5;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.hydration-banner.is-project-missing,
.hydration-banner.is-project-fetch {
  background: rgba(226, 92, 92, 0.08);
  border-color: rgba(226, 92, 92, 0.35);
  border-left-color: var(--error, #e25c5c);
}
.hydration-banner code {
  background: var(--bg-tertiary);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 12px;
}
.hydration-banner .banner-link {
  margin-left: auto;
  color: var(--accent, #6c8fff);
  cursor: pointer;
  background: none;
  border: 0;
  font-size: 13px;
  text-decoration: underline;
  padding: 0;
}

/* v1.0.93+ Effective channel state card. Shows what's actually driving
   the next generation so the user can catch state drift (format reverted,
   niche missing, etc.) BEFORE spending an API call. Renders as three
   neat rows; turns yellow when any slot is in a fallback state. */
.effective-state-card {
  margin-top: 10px;
  padding: 10px 14px;
  background: var(--bg-tertiary);
  border-left: 3px solid var(--accent, #6c8fff);
  border-radius: var(--radius-sm, 4px);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.effective-state-card.has-warning {
  border-left-color: rgba(240, 198, 116, 0.85);
  background: rgba(240, 198, 116, 0.04);
}
.effective-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
}
.effective-label {
  display: inline-block;
  width: 80px;
  color: var(--text-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.effective-value {
  color: var(--text-primary);
  font-weight: 500;
}
.effective-value.is-fallback {
  color: var(--text-muted);
  font-style: italic;
  font-weight: normal;
}
.effective-value em {
  font-style: italic;
  color: var(--accent, #6c8fff);
}
.effective-fallback-tag,
.effective-override-tag {
  font-size: 11px;
  color: rgba(240, 198, 116, 0.95);
  padding: 1px 8px;
  background: rgba(240, 198, 116, 0.10);
  border-radius: 999px;
}
.effective-override-tag {
  color: var(--accent, #6c8fff);
  background: rgba(108, 143, 255, 0.10);
}
.effective-link {
  margin-left: auto;
  font-size: 12px;
  color: var(--accent, #6c8fff);
  text-decoration: underline;
}

/* v1.0.183 — the strip chrome (.context-strip / .context-summary /
   .context-detail / .context-warn / .context-toggle) now lives in the shared
   ContextStrip component. Only the slot-content styles below remain — they
   style the chips + detail rows this page passes into the component's slots.
   (.context-chip / .context-key / .is-fallback / .context-dot /
   .context-override are also re-declared :slotted in the component, but
   keeping them here is harmless and covers the detail panel too.) */
.context-chip { display: inline-flex; align-items: baseline; gap: 6px; }
.context-key {
  color: var(--text-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.context-chip strong { font-weight: 600; }
.context-chip strong.is-fallback { color: var(--text-muted); font-weight: normal; font-style: italic; }
.context-override { color: var(--accent, #6c8fff); font-size: 11px; }
.context-dot { color: var(--border, #3a3a3a); }
.context-detail-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
  margin-top: 6px;
}
.context-detail-label {
  display: inline-block;
  width: 64px;
  color: var(--text-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.context-detail-value { color: var(--text-primary); font-weight: 500; }
.context-detail-value.is-fallback { color: var(--text-muted); font-style: italic; font-weight: normal; }
.context-detail-value em { font-style: italic; color: var(--accent, #6c8fff); }
.context-detail-desc { margin: 0 0 0 74px; font-size: 13px; color: var(--text-primary); line-height: 1.45; }
.context-detail-hint { margin: 0 0 0 74px; line-height: 1.4; }
.context-badge {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 2px 6px;
  border-radius: 8px;
  font-weight: 600;
}
.context-badge.badge-builtin { background: var(--bg-tertiary); color: var(--text-muted); border: 1px solid var(--border); }
.context-badge.badge-custom  { background: var(--accent); color: var(--bg-primary); border: 1px solid var(--accent); }
.context-fallback-tag,
.context-override-tag {
  font-size: 11px;
  color: rgba(240, 198, 116, 0.95);
  padding: 1px 8px;
  background: rgba(240, 198, 116, 0.10);
  border-radius: 999px;
}
.context-override-tag { color: var(--accent, #6c8fff); background: rgba(108, 143, 255, 0.10); }
.effective-link.subtle { margin-left: 0; opacity: 0.85; }
</style>
