<template>
  <div class="workspace-page creation-workspace ideas-workspace">
    <WorkspaceHero
      eyebrow="Create · Discover"
      title="Ideas Generator"
      description="Shape channel-fit concepts, test title directions, and promote the strongest ideas into production-ready episodes."
    >
      <template #aside>
        <div class="workspace-metrics" aria-label="Ideas workspace context">
          <span class="workspace-metric"><strong>{{ allIdeas.length }}</strong> ideas</span>
          <span class="workspace-metric" data-tone="success"><strong>{{ statusCounts.accepted }}</strong> accepted</span>
          <span class="workspace-metric" data-tone="info"><strong>{{ nextEpisode }}</strong> next code</span>
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
        <small v-if="statusCounts.accepted > 0" class="text-muted text-xs control-hint">Closes gaps in episode numbers. Undo for 30 days.</small>
        </div>
      </template>
    </WorkspaceHero>

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
        <strong>⚠ No production path is set on this project.</strong>
        Ideas will use the app's standard settings until you choose a production path in Channel Identity.
        <NuxtLink :to="`/projects/${slug}/settings#channel`" class="banner-link">
          Open Channel Identity →
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
    <div class="workspace-command-surface creation-command-surface">
      <div class="form-tabs">
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
      <p class="workspace-command-copy">
        Use <strong>Workflow</strong> to generate, promote, or import. Use <strong>Manage</strong> to search and maintain the complete idea catalog.
      </p>
    </div>

    <InheritedLlmLineupNotice :project-slug="slug" />

    <!-- ── Workflow tab ────────────────────────────────────────────────── -->
    <div v-show="ideasTab === 'workflow'">

    <!-- Channel "what worked" inspiration. Auto-included server-side in
         the LLM prompt; this card surfaces what's being injected so the
         user can see the vibe reference. Hides silently when no analytics
         data is available. -->
    <TopPerformersInspiration :slug="slug" class="mt-3" />

    <!-- Generator -->
    <div class="card workspace-section generator-panel">
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
            <span class="context-key">Production</span>
            <strong :class="{ 'is-fallback': !projectHasExplicitFormat }">{{ formatDisplayName || 'Not chosen yet' }}</strong>
          </span>
          <span class="context-dot" aria-hidden="true">·</span>
          <span class="context-chip">
            <span class="context-key">Formula</span>
            <strong :class="{ 'is-fallback': !form.niche_id }">{{ activeFormulaName }}</strong>
          </span>
          <span class="context-dot" aria-hidden="true">·</span>
          <span class="context-chip">
            <span class="context-key">Topics</span>
            <strong :class="{ 'is-fallback': !form.topic_pack_ids.length }">{{ activeTopicPackLabel }}</strong>
          </span>
        </template>

        <!-- Expandable detail — the content the two old cards carried. -->
          <div class="context-detail-row">
            <span class="context-detail-label">Production path</span>
            <strong class="context-detail-value" :class="{ 'is-fallback': !projectHasExplicitFormat }">
              {{ formatDisplayName || 'Not chosen yet' }}
            </strong>
            <span
              v-if="activeFormat"
              class="context-badge"
              :class="activeFormat.builtin ? 'badge-builtin' : 'badge-custom'"
            >{{ activeFormat.builtin ? 'Built-in' : 'Custom' }}</span>
            <span v-if="!projectHasExplicitFormat" class="context-fallback-tag">⚠ no format set — generation falls back to defaults</span>
            <NuxtLink :to="`/projects/${slug}/settings#channel`" class="effective-link">Open Channel Identity</NuxtLink>
          </div>
          <p v-if="activeFormat?.description" class="context-detail-desc">{{ activeFormat.description }}</p>
          <p class="context-detail-hint text-muted text-sm">
            The Continuity Engine controls visual construction. Formula and Topic Packs below control the written series.
          </p>

          <div class="context-detail-row">
            <span class="context-detail-label">Formula</span>
            <strong class="context-detail-value" :class="{ 'is-fallback': !form.niche_id }">
              {{ activeFormulaName }}
            </strong>
          </div>

          <div class="context-detail-row">
            <span class="context-detail-label">Topic Packs</span>
            <strong class="context-detail-value" :class="{ 'is-fallback': !form.topic_pack_ids.length }">{{ activeTopicPackLabel }}</strong>
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

      <div class="identity-context-action">
        <span>Formula and Topic Packs shape every idea in this batch.</span>
        <button type="button" class="btn btn-secondary btn-sm" @click="identityPickerOpen = true">Choose Formula &amp; Topics</button>
      </div>

      <ChannelIdentityPickerModal
        :visible="identityPickerOpen"
        :project-slug="slug"
        :selected-formula-id="projectNicheId"
        :selected-topic-pack-ids="projectTopicPackIds"
        :project-content-pack-versions="projectContentPackVersions"
        action-label="Apply to channel"
        @close="identityPickerOpen = false"
        @saved="onIdeasIdentitySaved"
      />

      <div class="idea-composer">
        <div class="idea-composer-heading">
          <div>
            <span class="idea-step-label">Creative brief</span>
            <h4>What should this batch explore?</h4>
            <p>Write naturally. A sentence, a rough question, or a detailed direction all work.</p>
          </div>
          <span class="idea-open-badge">Freeform first</span>
        </div>

        <textarea
          v-model="form.creative_direction"
          class="textarea idea-brief-input"
          rows="4"
          placeholder="Example: Find surprising human stories behind ordinary inventions. Avoid familiar success stories; focus on overlooked failures, strange trade-offs, and vivid moments that can carry a full episode."
        />

        <div class="idea-choice-row">
          <div class="idea-choice-group freedom-group">
            <div class="idea-choice-heading">
              <span>Creative freedom</span>
              <small>How tightly should the channel format guide the model?</small>
            </div>
            <div class="freedom-options" role="radiogroup" aria-label="Creative freedom">
              <button
                v-for="mode in creativeModes"
                :key="mode.id"
                type="button"
                class="freedom-option"
                :class="{ active: form.creative_mode === mode.id }"
                role="radio"
                :aria-checked="form.creative_mode === mode.id"
                @click="form.creative_mode = mode.id"
              >
                <strong>{{ mode.label }}</strong>
                <span>{{ mode.description }}</span>
              </button>
            </div>
          </div>

          <div class="idea-choice-group lens-group">
            <div class="idea-choice-heading">
              <span>Optional lenses</span>
              <small>Combine any that help. Leave empty for full freedom.</small>
            </div>
            <div class="creative-lenses">
              <button
                v-for="lens in creativeLensOptions"
                :key="lens.prompt"
                type="button"
                class="creative-lens"
                :class="{ active: form.creative_lenses.includes(lens.prompt) }"
                :aria-pressed="form.creative_lenses.includes(lens.prompt)"
                @click="toggleCreativeLens(lens.prompt)"
              >{{ lens.label }}</button>
            </div>
          </div>
        </div>

        <label class="originality-guard" :class="{ active: form.avoid_repeated_ideas }">
          <input v-model="form.avoid_repeated_ideas" type="checkbox" />
          <span class="originality-copy">
            <strong>Prevent repeated ideas</strong>
            <small>
              Checks every saved idea in this project plus the current batch.
              {{ allIdeas.length }} existing concept{{ allIdeas.length === 1 ? '' : 's' }} protected.
            </small>
          </span>
          <span class="originality-state">{{ form.avoid_repeated_ideas ? 'On · recommended' : 'Off' }}</span>
        </label>

        <!-- Preset and model live ABOVE the disclosure, not inside it. Both
             answer "what am I about to run", which every other generator shows
             without a click — Ideas was the only page that buried them. The
             per-batch overrides below stay collapsed: they are usually blank,
             and hoisting them would push the creative brief off the screen. -->
        <PresetPicker
          label="Ideas preset"
          hint="Save or restore this complete creative setup. Presets stay on this Mac."
          :presets="ideasPresets.presets.value"
          :active-id="ideasPresets.activeId.value"
          @update:active-id="ideasPresets.setActive"
          @apply="onIdeasPresetApplied"
          @overwrite="onIdeasPresetOverwrite"
          @save-as="onIdeasPresetSaveAs"
          @rename="onIdeasPresetRename"
          @delete="onIdeasPresetDelete"
        />

        <section class="idea-refinement-card idea-refinement-wide idea-generation-card">
          <div class="idea-refinement-heading">
            <div><strong>Generation settings</strong><small>Your last model is restored automatically.</small></div>
          </div>
          <div class="generation-settings-grid">
            <!-- While the shared LLM lineup is on, the queue replaces this
                 batch's model with the lineup's, so a picker here would do
                 nothing. Say so instead of offering a dead control. -->
            <div v-if="ideasLineupModelCount" class="form-group lineup-model-readonly">
              <label>AI Model</label>
              <div class="input text-muted">Shared LLM lineup ({{ ideasLineupModelCount }} model{{ ideasLineupModelCount === 1 ? '' : 's' }})</div>
              <span class="text-muted text-xs">The lineup picks the model while it is on. Change it in <NuxtLink :to="`/projects/${slug}/pipeline`">Pipeline</NuxtLink>.</span>
            </div>
            <ModelSelector v-else-if="modelPreferenceReady" v-model="form.model" :project-slug="slug" />
            <div v-else class="form-group"><label>AI Model</label><div class="input text-muted">Restoring your last used model…</div></div>
            <div class="form-group">
              <label>Items or chapters per video <span class="text-muted">(optional)</span></label>
              <input v-model.number="form.items_per_listicle" class="input" type="number" min="1" max="100" placeholder="Auto" />
              <span class="text-muted text-xs">Leave blank unless every idea needs the same fixed count.</span>
            </div>
          </div>
        </section>

        <AdvancedDisclosure
          v-model:open="ideaRefinementsOpen"
          label="Refine topic, audience, and titles"
          :badge="refinementBadge"
        >
          <div class="idea-refinement-shell">
            <div class="idea-refinement-grid">
              <section class="idea-refinement-card">
                <div class="idea-refinement-heading">
                  <span class="idea-refinement-number">01</span>
                  <div><strong>Creative attributes</strong><small>Optional. Blank means the model chooses.</small></div>
                </div>
                <div class="compact-grid">
                  <div class="form-group">
                    <label>Audience <span v-if="audienceFromFormat" class="vocab-source-tag">· {{ formatDisplayName }}</span></label>
                    <ComboInput v-model="form.audience" :options="audienceOptions" placeholder="Use format default" searchable allow-custom />
                  </div>
                  <div class="form-group">
                    <label>Genre <span class="vocab-source-tag">· {{ vocabSourceLabel('genre') }}</span></label>
                    <ComboInput v-model="form.genre" :options="allGenres" placeholder="Model chooses" searchable allow-custom @add-custom="onAddGenre" />
                  </div>
                  <div class="form-group">
                    <label>Theme</label>
                    <ComboInput v-model="form.theme" :options="allThemes" placeholder="Model chooses" searchable allow-custom @add-custom="onAddTheme" />
                  </div>
                  <div class="form-group">
                    <label>Mood</label>
                    <ComboInput v-model="form.mood" :options="allMoods" placeholder="Model chooses" searchable allow-custom @add-custom="onAddMood" />
                  </div>
                </div>
                <div class="form-group compact-keywords">
                  <label>Required keywords</label>
                  <ChipInput v-model="form.keywords" :suggestions="allKeywords" placeholder="None required" allow-custom :max="12" @add-custom="onAddKeyword" />
                </div>
              </section>

              <section class="idea-refinement-card">
                <div class="idea-refinement-heading">
                  <span class="idea-refinement-number">02</span>
                  <div><strong>Topic and title shape</strong><small>Override only when this batch needs it.</small></div>
                </div>
                <div class="form-group">
                  <label>Channel identity</label>
                  <div class="channel-identity-readonly">
                    <strong>{{ activeFormulaName }}</strong>
                    <span>{{ activeTopicPackLabel }}</span>
                    <small class="text-muted text-xs">Change these with “Choose Formula &amp; Topics” above.</small>
                  </div>
                </div>
                <div class="form-group">
                  <label>Title template <span class="text-muted">(optional)</span></label>
                  <input v-model="form.title_template" type="text" class="input" placeholder="e.g. The hidden story of {X}" spellcheck="false" />
                  <span class="text-muted text-xs">Use <code>{X}</code> for a different subject in every idea.</span>
                </div>
                <div class="compact-grid">
                  <div class="form-group"><label>Title prefix</label><input v-model="titleConfig.prefix" class="input" placeholder="Before every title" /></div>
                  <div class="form-group"><label>Title suffix</label><input v-model="titleConfig.suffix" class="input" placeholder="After every title" /></div>
                </div>
                <span class="text-muted text-xs">Channel-wide — also used for metadata.</span>
                <p v-if="titleConfig.prefix || titleConfig.suffix" class="title-wrap-preview">Preview: <code>{{ titlePreviewText }}</code></p>
              </section>

            </div>
          </div>
        </AdvancedDisclosure>
      </div>

      <div class="idea-launch-dock">
        <div class="idea-launch-summary">
          <span class="launch-summary-label">Ready to explore</span>
          <strong>{{ creativeBriefSummary }}</strong>
        </div>
        <label class="idea-count-control">
          <span>Ideas</span>
          <input v-model.number="form.count" class="input" type="number" min="1" max="100" />
        </label>
        <div class="generator-actions-primary">
          <button class="btn btn-primary" :disabled="generating || ideaCampaignActive" @click="generate">
            <LoadingSpinner v-if="generating" size="sm" label="Queuing campaign…" show-label />
            <template v-else-if="ideaCampaignActive">Idea Campaign running…</template>
            <template v-else>Queue {{ form.count }} ideas</template>
          </button>
          <button
            class="btn btn-secondary"
            :disabled="generating || ideaCampaignActive"
            title="Fills genre, theme, mood, audience, and keywords with random picks from the pools. Review or tweak before generating — no API cost."
            @click="randomizeForm"
          >
            Randomize attributes
          </button>
          <button
            class="btn btn-secondary"
            :disabled="generating || ideaCampaignActive"
            title="Randomize the form AND generate immediately. Spends an API call on each click."
            @click="surpriseMe"
          >
            <LoadingSpinner v-if="generating" size="sm" label="Surprising you…" show-label />
            <template v-else>Surprise me</template>
          </button>
          <NuxtLink v-if="ideaCampaignActive" :to="`/projects/${slug}/jobs`" class="btn btn-ghost btn-sm">View in Jobs</NuxtLink>
        </div>
      </div>
      <p class="text-muted text-xs control-hint">
        <strong>Randomize</strong> fills the fields under “Refine” for free. <strong>Surprise me</strong> fills them and queues {{ form.count }} ideas right away.
      </p>
      <div class="generator-actions-secondary">
          <button
            type="button"
            class="btn btn-ghost btn-sm other-ways-toggle"
            :aria-expanded="otherWaysOpen"
            @click="otherWaysOpen = !otherWaysOpen"
          >
            <span class="ds-chevron" :class="{ 'is-open': otherWaysOpen }" aria-hidden="true" /> Add ideas another way
          </button>
          <template v-if="otherWaysOpen">
            <button class="btn btn-secondary btn-sm" @click="openAddIdea">+ Add idea manually</button>
            <button class="btn btn-secondary btn-sm" @click="openPasteIdeas">Paste from an LLM</button>
            <button class="btn btn-secondary btn-sm" @click="openImportFolder">Import episode folder</button>
          </template>
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
        <small class="text-muted text-xs control-hint">Marking them done stops the pipeline asking for work on them. “Unmark” goes back to checking their files.</small>
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
              <!-- `title` carries the full string for hover, because even two
                   clamped lines can cut a long documentary headline. -->
              <td class="td-title" :title="idea.title">
                <span class="idea-title-text">{{ idea.title }}</span>
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
                <button
                  v-if="idea.status === 'new'"
                  class="btn btn-sm btn-secondary"
                  :disabled="dismissingIds.has(idea.id)"
                  @click="dismiss(idea.id)"
                >{{ dismissingIds.has(idea.id) ? 'Dismissing…' : 'Dismiss' }}</button>
                <button v-if="idea.status === 'accepted'" class="btn btn-sm btn-secondary" @click="openRenumberDialog(idea)" title="Change this episode's code (renames folder + asset files)">Change code</button>
                <button v-if="idea.status === 'accepted'" class="btn btn-sm btn-danger" title="Move this episode's files to the project's _trash and un-accept" @click="resetIdea(idea)">Un-accept</button>
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

    <!-- v-if, not v-else-if: an empty state must never hide behind the
         pagination row (that produced an empty "Page 3 of 2"). -->
    <EmptyState
      v-if="allIdeas.length === 0 && !generating"
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
          :disabled="!acceptCodeValid || accepting"
          @click="doAccept('folders')"
        >{{ accepting ? 'Accepting…' : 'Create Folders Only' }}</button>
        <button
          class="btn btn-primary btn-lg flex-1"
          :disabled="!acceptCodeValid || accepting"
          @click="doAccept('script')"
        >{{ accepting ? 'Accepting…' : 'Folders & Open Script' }}</button>
      </div>
      <button class="btn btn-sm btn-secondary mt-2 w-full" :disabled="accepting" @click="acceptDialogIdea = null">Cancel</button>
    </Modal>

    <!-- Renumber dialog (per-episode rename) -->
    <Modal
      :visible="!!renumberDialogIdea"
      size="sm"
      labelledby="renumber-title"
      @close="renumberDialogIdea = null"
    >
      <h2 id="renumber-title">Change episode code</h2>
      <div class="accept-preview">
        <h3>{{ renumberDialogIdea?.title }}</h3>
        <p class="text-muted">
          Currently <strong class="text-accent">{{ renumberDialogIdea?.episode_code }}</strong>.
          The new code is applied everywhere — the episode's folder, every file inside it, and its saved details — and any YouTube upload link stays attached.
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
          {{ renumberRunning ? 'Changing…' : 'Change code' }}
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
      :key="assetMapEpisode.episode_code"
      :visible="!!assetMapEpisode"
      :slug="slug"
      :episode-code="assetMapEpisode.episode_code"
      :prefilled-items="assetMapEpisode.prefilled"
      :default-mode="assetMapEpisode.mode"
      @close="openNextAssetMap"
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
          <!-- Source-of-truth strip: Channel Identity is informational here;
               Formula and Topic Pack changes happen once in Settings. -->
          <div class="paste-prompt-source">
            <span class="paste-prompt-source-label">Built from</span>
            <span class="paste-prompt-source-chip" :title="`This prompt uses ${activeFormulaName} and ${activeTopicPackLabel}. Change Channel Identity in Settings.`">
              Formula: <strong>{{ activeFormulaName }}</strong>
            </span>
            <NuxtLink :to="`/projects/${slug}/settings#channel`" class="paste-prompt-source-link" title="Open Channel Identity to change the Formula, Topic Packs, or production behavior.">Channel Identity</NuxtLink>
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

    <!-- v1.0.165 — Pattern editor modal removed with the rest of the
         Pattern system. The title-template field above covers the one
         capability the user actually used. -->

    <!-- Add/Edit idea modal -->
    <div v-if="editorOpen" class="modal-overlay" @click.self="editorOpen = false">
      <div class="modal" style="max-width: 560px;">
        <h2>{{ editorMode === 'add' ? 'Add Idea' : 'Edit Idea' }}</h2>
        <p v-if="editorMode === 'edit' && editorIdea?.status === 'accepted'" class="text-muted text-sm mt-1">
          This idea is already accepted — changing the title also renames its episode folder to match.
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
        <button class="btn btn-primary btn-sm" :disabled="bulkIdeasRunning" @click="batchAccept">
          {{ bulkIdeasRunning ? 'Working…' : 'Accept Selected' }}
        </button>
        <button class="btn btn-secondary btn-sm" :disabled="bulkIdeasRunning" @click="dismissSelected">Dismiss Selected</button>
        <button class="btn btn-secondary btn-sm" :disabled="bulkIdeasRunning" @click="selectedIds.clear()">Clear</button>
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
              Each episode's folder and the files inside it take the new code.
              You can undo this from the Unlinked Uploads tab for 30 days.
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
                <!-- Single-line by design (this is a dense preview row), so the
                     full title has to be reachable on hover. -->
                <span class="compact-rename-title text-muted" :title="r.title">{{ r.title }}</span>
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
import { projectSlug } from '~/utils/project-slug'
import { scriptDeepLinkQuery } from '~/utils/scriptSizing'

definePageMeta({ layout: 'dashboard', key: route => String(route.params.slug || '') })
useAppTitle('Ideas')
const route = useRoute()
const _router = useRouter()
const slug = computed(() => projectSlug(route.params.slug))
const { get, post, del, patch } = useApi()
const freshIdeaCampaignAction = useFreshGenerationAction()
const { success, error: showError, successUndoable } = useToast()
const { jobs: ideaJobs, isJobActiveFor } = useJobs()
const ideaCampaignActive = computed(() => isJobActiveFor('ideas', ['idea_campaign']))

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
const { project, config: projectConfig, slug: loadedProjectSlug } = useProject()
// Same reading as InheritedLlmLineupNotice: when the shared lineup is on, the
// job queue replaces an Idea Campaign's model with the lineup's.
const ideasLineupModels = computed<string[]>(() => {
  if (loadedProjectSlug.value !== slug.value) return []
  const lineup = (projectConfig.value as any)?.llm_lineup
  return lineup?.enabled === true && Array.isArray(lineup.models)
    ? lineup.models.filter((model: unknown): model is string => typeof model === 'string' && !!model.trim())
    : []
})
const ideasLineupModelCount = computed(() => ideasLineupModels.value.length)
// v1.0.165 — the Pattern customization system was removed; its one
// piece of value (the {X} title shape) is now a plain `title_template`
// string field on the Ideas form. The pattern lookup composable,
// PatternPicker / PatternEditorModal components, and per-pattern
// warning-header plumbing all went with it.
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

type CreativeMode = 'strict' | 'guided' | 'open'

const creativeModes: Array<{ id: CreativeMode; label: string; description: string }> = [
  { id: 'open', label: 'Explore freely', description: 'Brief leads; format stays as context.' },
  { id: 'guided', label: 'Balanced', description: 'Fresh ideas with a little channel guidance.' },
  { id: 'strict', label: 'Channel-safe', description: 'Predictable ideas inside firm guardrails.' },
]

const creativeLensOptions = [
  { label: 'Challenge assumptions', prompt: 'challenge the obvious framing or accepted assumption' },
  { label: 'Overlooked angles', prompt: 'find an overlooked angle that most episodes would miss' },
  { label: 'Human-first', prompt: 'ground the concept in specific human stakes and choices' },
  { label: 'Cinematic', prompt: 'favor visually rich situations with a strong cinematic hook' },
  { label: 'Curiosity and mystery', prompt: 'build curiosity around an unresolved question or hidden cause' },
  { label: 'Clear and useful', prompt: 'make the payoff concrete, understandable, and genuinely useful' },
]

const form = reactive({
  // Blank creative attributes are intentional. The freeform brief leads;
  // optional channel-format context remains available to the backend.
  genre: '',
  theme: '',
  audience: '',
  mood: '',
  keywords: [] as string[],
  count: 5,
  // Resolved from last-used memory/history before ModelSelector mounts.
  // Empty is intentional: a paid model must never be a hidden default.
  model: '',
  creative_mode: 'open' as CreativeMode,
  creative_direction: '',
  creative_lenses: [] as string[],
  avoid_repeated_ideas: true,
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
  topic_pack_ids: [] as string[],
})

// Tracks the project's currently-saved niche so the UI can show
// "Overriding saved niche '<name>'" when the picker doesn't match.
// Empty string = project has no saved niche.
const projectNicheId = ref<string>('')
const projectTopicPackIds = ref<string[]>([])
const projectTopicPacksExplicit = ref(false)
const projectContentPackVersions = ref<Record<string, string>>({})
const identityPickerOpen = ref(false)

// v1.0.170 — Channel context strip disclosure. Collapsed by default so the
// page opens straight onto the generator; the strip's one-line summary
// (Format · Topic · Titles) is always visible, and clicking it reveals the
// detail panel that the old config cards used to show inline.
const setupExpanded = ref(false)
const ideaRefinementsOpen = ref(false)
// v1.0.171 — "Other ways to add" (manual / paste / import) collapsed by
// default so these rare power ops don't compete with the Generate button.
const otherWaysOpen = ref(false)

function toggleCreativeLens(prompt: string) {
  const index = form.creative_lenses.indexOf(prompt)
  if (index >= 0) form.creative_lenses.splice(index, 1)
  else form.creative_lenses.push(prompt)
}

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

const refinementCount = computed(() => [
  form.genre,
  form.theme,
  form.audience,
  form.mood,
  form.keywords.length ? 'keywords' : '',
  form.niche_id !== projectNicheId.value ? 'topic' : '',
  JSON.stringify([...form.topic_pack_ids].sort()) !== JSON.stringify([...projectTopicPackIds.value].sort())
    ? 'topic packs'
    : '',
  form.title_template,
  titleConfig.prefix || titleConfig.suffix,
  // items_per_listicle and the model are deliberately NOT counted: both now sit
  // above the disclosure, and the badge must describe only what is hidden
  // behind it. Counting a visible field is how a "3 active" badge stops meaning
  // anything.
].filter(Boolean).length)

const refinementBadge = computed(() => refinementCount.value
  ? `${refinementCount.value} active`
  : 'optional')

const creativeBriefSummary = computed(() => {
  const parts: string[] = []
  parts.push(creativeModes.find(mode => mode.id === form.creative_mode)?.label || 'Explore freely')
  if (form.creative_direction.trim()) parts.push('custom brief')
  if (form.creative_lenses.length) parts.push(`${form.creative_lenses.length} lens${form.creative_lenses.length === 1 ? '' : 'es'}`)
  if (refinementCount.value) parts.push(`${refinementCount.value} refinement${refinementCount.value === 1 ? '' : 's'}`)
  return parts.join(' · ')
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
// AND "Evening Prayer" AND "Daily Devotional" all on one devotional channel) can
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
    creative_lenses: [...form.creative_lenses],
    avoid_repeated_ideas: form.avoid_repeated_ideas,
    title_template: form.title_template,
    items_per_listicle: form.items_per_listicle,
    // The channel-wide title prefix/suffix are NOT part of an Ideas preset (owner decision
    // 2026-10-03): Metadata uses them too, so a preset must never change them.
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
    if (Array.isArray(data.creative_lenses)) form.creative_lenses = data.creative_lenses.filter((value: unknown) => typeof value === 'string')
    if (typeof data.avoid_repeated_ideas === 'boolean') form.avoid_repeated_ideas = data.avoid_repeated_ideas
    if (typeof data.title_template === 'string') form.title_template = data.title_template
    if (data.items_per_listicle === null || typeof data.items_per_listicle === 'number') {
      form.items_per_listicle = data.items_per_listicle
    }
  },
})

function onIdeasPresetApplied() {
  ideasPresets.applyActive()
  success('Preset applied')
}

async function onIdeasPresetOverwrite() {
  try {
    await ideasPresets.overwrite()
    success('Preset saved and verified')
  } catch (error: any) {
    showError(error?.message || 'Preset could not be saved')
  }
}

async function onIdeasPresetSaveAs(name: string) {
  try {
    await ideasPresets.saveAs(name)
    success(`Saved and verified: ${name}`)
  } catch (error: any) {
    showError(error?.message || 'Preset could not be saved')
  }
}

async function onIdeasPresetRename(name: string) {
  try {
    await ideasPresets.rename(name)
    success(`Renamed and verified: ${name}`)
  } catch (error: any) {
    showError(error?.message || 'Preset could not be renamed')
  }
}

async function onIdeasPresetDelete() {
  try {
    await ideasPresets.remove()
    success('Preset deletion verified')
  } catch (error: any) {
    showError(error?.message || 'Preset could not be deleted')
  }
}

// ── Pattern + format wiring for the Ideas page ────────────────────────────
//
// PatternPicker filters by current format (Part 2 of this rollout). We
// fetch the project's effective format id from settings/config so the
// picker shows only patterns paired with that format by default. Last-
// used pattern + subject are persisted in the same config under
// `idea_generator_last_pattern` / `idea_generator_last_subject` —
// matches the *_last_* convention used by other generator pages.
const formatId = ref<string>('continuity-chain')
// v1.0.83+: reactive section-label vocabulary for the active format
// ("Chapter" for sleep-story, "Reason" for reasons-explainer, "Topic" for
// listicle). Used in form labels, table column headers, and inline copy
// so the Ideas page matches whatever the script will be structured as.
const sectionLabel = useSectionLabel(formatId)
// Map of format-id → display name, populated from /api/formats. Used to
// show "Format: Sleep Story" above the paste-prompt instead of "sleep-story",
// and to surface a "Switch" link to Settings → Format. Best-effort: if the
// fetch fails we fall back to displaying the id.
const formatNamesById = ref<Record<string, string>>({})
// When the format list fails to load, show the id as words ("narrated-scenes"
// → "Narrated scenes"), never the raw id.
const humanizeFormatId = (id: string) => id ? id.replace(/[-_]+/g, ' ').replace(/^\w/, c => c.toUpperCase()) : ''
const formatDisplayName = computed(() => formatNamesById.value[formatId.value] || humanizeFormatId(formatId.value))
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
let patternHydrated = false

/**
 * v1.0.66+ — keep the FULL format objects (not just id+name) so the
 * Ideas Generator dropdowns + Randomize / Surprise Me can pull
 * vocabularies from `format.idea.{genre|theme|mood|keyword}Vocabulary`.
 * Without this, compilation-mode (listicle format) would still see sleep-
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
  if (!slug.value) return
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

async function loadPatternPreferences(): Promise<boolean> {
  // The project's chosen format lives on the project META, not on
  // /settings/config. settings.vue + scripts.vue both read meta.format_id;
  // ideas.vue used to read /settings/config.format_id which is always
  // undefined → formatId stayed at the 'narrative' default and compilation-mode
  // (listicle) projects saw lantern/observatory/coming-of-age vocab. Fix:
  // hit project meta for format_id, settings/config for the *_last_*
  // pattern/subject memory.
  //
  // v1.0.93+ — returns true on success so the orchestrating mount can
  // gate downstream loads on it. Errors surface via `hydrationError`
  // (banner in the template) rather than being swallowed.
  if (!slug.value) return false

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
    projectTopicPacksExplicit.value = Array.isArray(meta?.topic_pack_ids)
    projectTopicPackIds.value = projectTopicPacksExplicit.value
      ? meta.topic_pack_ids.filter((value: unknown): value is string => typeof value === 'string')
      : []
    projectContentPackVersions.value = meta?.content_pack_versions && typeof meta.content_pack_versions === 'object'
      ? { ...meta.content_pack_versions }
      : {}
  } catch (e: any) {
    hydrationError.value = { kind: 'project-fetch', detail: e?.data?.detail || e?.message || 'unknown error' }
    return false
  }
  projectNicheId.value = metaNiche
  form.topic_pack_ids = [...projectTopicPackIds.value]
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
    // Channel Identity is the source of truth. Old campaign-only Formula
    // memories are deliberately ignored so a batch cannot silently drift
    // from the selected Formula or Topic Packs.
    form.niche_id = metaNiche
    form.topic_pack_ids = [...projectTopicPackIds.value]
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
    form.topic_pack_ids = [...projectTopicPackIds.value]
  }
  patternHydrated = true
  return true
}

async function onIdeasIdentitySaved(value: { formulaId: string; topicPackIds: string[] }): Promise<void> {
  projectNicheId.value = value.formulaId
  projectTopicPackIds.value = [...value.topicPackIds]
  projectTopicPacksExplicit.value = true
  form.niche_id = value.formulaId
  form.topic_pack_ids = [...value.topicPackIds]
  try {
    const meta = await get<any>(`/projects/${slug.value}`)
    projectNicheId.value = typeof meta?.niche_id === 'string' ? meta.niche_id : ''
    projectTopicPacksExplicit.value = Array.isArray(meta?.topic_pack_ids)
    projectTopicPackIds.value = projectTopicPacksExplicit.value
      ? meta.topic_pack_ids.filter((id: unknown): id is string => typeof id === 'string')
      : []
    projectContentPackVersions.value = meta?.content_pack_versions && typeof meta.content_pack_versions === 'object'
      ? { ...meta.content_pack_versions }
      : {}
    form.niche_id = projectNicheId.value
    form.topic_pack_ids = [...projectTopicPackIds.value]
    success('Channel Identity updated')
  } catch (error: any) {
    showError(error?.data?.detail || error?.message || 'Channel Identity was saved, but the project could not be refreshed.')
  }
}

// Persists the per-project Ideas-form preferences (title template, theme,
// listicle count, and channel title wrap). Named for history;
// v1.0.165 swapped the pattern fields for the title template.
async function saveIdeaPreferences(targetSlug: string = slug.value) {
  // Skip the initial hydration round-trip — only fire on user-initiated
  // changes. Without this guard, the watch fires once when load sets the
  // initial value, writing the same value straight back.
  if (!patternHydrated || !targetSlug) return
  try {
    const { put } = useApi()
    const preferences: Record<string, unknown> = {
      [LAST_TITLE_TEMPLATE_KEY]: form.title_template,
      [LAST_THEME_KEY]: form.theme,
      [LAST_ITEMS_KEY]: form.items_per_listicle,
      // v1.0.93+ — channel title wrap is persisted on every edit so the
      // metadata page picks it up on next load without an explicit save.
      [TITLE_PREFIX_KEY]: titleConfig.prefix,
      [TITLE_SUFFIX_KEY]: titleConfig.suffix,
    }
    // Never write an unresolved/empty model during initial hydration.
    if (modelPreferenceReady.value && form.model) {
      preferences[LAST_MODEL_KEY] = form.model
    }
    await put(`/projects/${targetSlug}/settings/config`, preferences)
  } catch { /* non-fatal — selection still works in-session */ }
}

// Typing in the title template / prefix / suffix used to PUT the config on
// every keystroke. Wait for a 500 ms pause; flush on leave so the last edit
// still lands (bound to the slug it was typed for).
let savePreferencesTimer: ReturnType<typeof setTimeout> | null = null
let savePreferencesSlug = ''
function queueSaveIdeaPreferences() {
  if (savePreferencesTimer) clearTimeout(savePreferencesTimer)
  savePreferencesSlug = slug.value
  savePreferencesTimer = setTimeout(() => {
    savePreferencesTimer = null
    void saveIdeaPreferences(savePreferencesSlug)
  }, 500)
}
onBeforeUnmount(() => {
  if (!savePreferencesTimer) return
  clearTimeout(savePreferencesTimer)
  savePreferencesTimer = null
  void saveIdeaPreferences(savePreferencesSlug)
})

watch(() => form.title_template, queueSaveIdeaPreferences)
watch(() => form.model, (model, previous) => {
  if (!modelPreferenceReady.value || !model || model === previous) return
  writeRememberedIdeaModel(model)
  queueSaveIdeaPreferences()
})
watch(() => form.theme, queueSaveIdeaPreferences)
watch(() => form.items_per_listicle, queueSaveIdeaPreferences)
watch(() => titleConfig.prefix, queueSaveIdeaPreferences)
watch(() => titleConfig.suffix, queueSaveIdeaPreferences)
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
// bias that broke compilation-mode users in v1.0.65.
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
const { topicPacks: allTopicPacks } = useTopicPacks()
watch([allNichesList, projectNicheId], () => {
  if (projectTopicPacksExplicit.value || !projectNicheId.value) return
  const formula = allNichesList.value?.find(niche => niche.id === projectNicheId.value)
  if (!formula) return
  projectTopicPackIds.value = [...(formula.defaultTopicPackIds || [])]
  if (form.niche_id === projectNicheId.value && form.topic_pack_ids.length === 0) {
    form.topic_pack_ids = [...projectTopicPackIds.value]
  }
}, { immediate: true })
const activeNiche = computed(() => {
  const id = form.niche_id
  if (!id) return null
  return allNichesList.value?.find(n => n.id === id) || null
})
const activeFormulaName = computed(() => activeNiche.value?.catalogName || activeNiche.value?.name || 'No Formula selected')
const activeTopicPackLabel = computed(() => {
  if (!form.topic_pack_ids.length) return 'No Topic Packs selected'
  const names = form.topic_pack_ids.map(id => allTopicPacks.value.find(pack => pack.id === id)?.name || id)
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0]
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

function onAddGenre(v: string) { void addCustomValue(customGenres.value, v) }
function onAddMood(v: string) { void addCustomValue(customMoods.value, v) }
function onAddTheme(v: string) { void addCustomValue(customThemes.value, v) }
function onAddKeyword(v: string) { void addCustomValue(customKeywords.value, v) }

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
  // These fields live inside the collapsed Refine panel — open it so the
  // picks are visible instead of changing hidden fields.
  ideaRefinementsOpen.value = true
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
      const { folder_sync: folderSync, ...updated } = await patch<any>(`/projects/${slug.value}/ideas/${editorIdea.value.id}`, payload)
      const i = allIdeas.value.findIndex(x => x.id === updated.id)
      if (i >= 0) allIdeas.value[i] = updated
      // An accepted episode's folder follows its title. When that rename
      // fails the title is still saved — say so plainly, in one message.
      const reason = String(folderSync?.warnings?.[0] || '').replace(/[.\s]+$/, '')
      if (folderSync && !folderSync.renamed && reason) {
        showError(`Title saved, but the folder could not be renamed: ${reason}. Your files are still in the old folder.`)
      } else if (reason) {
        success(`Idea updated and its folder renamed. Note: ${reason}.`)
      } else {
        success('Idea updated')
      }
    }
    editorOpen.value = false
    // Remember new custom genre/mood for future autocomplete (mood only — genre isn't on an idea)
    if (payload.mood && !allMoods.value.includes(payload.mood)) {
      void addCustomValue(customMoods.value, payload.mood)
    }
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to save idea')
  } finally {
    editorSaving.value = false
  }
}

const customListsLoaded = ref(false)

async function loadCustomLists() {
  try {
    const config = await get<any>(`/projects/${slug.value}/settings/config`)
    customGenres.value = Array.isArray(config.custom_genres) ? config.custom_genres : []
    customMoods.value = Array.isArray(config.custom_moods) ? config.custom_moods : []
    customThemes.value = Array.isArray(config.custom_themes) ? config.custom_themes : []
    customKeywords.value = Array.isArray(config.custom_keywords) ? config.custom_keywords : []
    customListsLoaded.value = true
  } catch (e: any) {
    customListsLoaded.value = false
    showError(e?.data?.detail || 'Could not load your saved custom suggestions')
  }
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

async function addCustomValue(target: string[], value: string) {
  const normalized = value.trim()
  if (!normalized || target.includes(normalized)) return
  if (!customListsLoaded.value) {
    showError('Custom suggestions are not loaded yet. Reload this page before adding one.')
    return
  }
  target.push(normalized)
  try {
    await persistCustomLists()
  } catch (e: any) {
    const index = target.indexOf(normalized)
    if (index >= 0) target.splice(index, 1)
    showError(e?.data?.detail || 'Could not save the custom suggestion')
  }
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
  metadata: 'YouTube Finalizer',
  scene_prompts: 'Scene Prompts',
  thumb_prompts: 'Thumbnail Prompts',
  images: 'Scene Images',
  thumbnails: 'Thumbnail Images',
  audio: 'Audio',
  merged_audio: 'Audio Assembly',
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
        // Same follow-up as a single-folder import: files found inside still
        // need the mapping step, or they sit there under their old names.
        if (Array.isArray(r.prefilled_import_items) && r.prefilled_import_items.length) {
          assetMapQueue.push({
            episode_code: r.episode_code,
            prefilled: r.prefilled_import_items,
            mode: importCopy.value ? 'copy' : 'move',
          })
        }
      } catch (e: any) {
        row.status = 'error'
        row.message = e.data?.detail || 'Import failed'
        failed++
      }
    }
    await loadIdeas()
    if (imported > 0) {
      const tail = failed > 0 ? ` (${failed} failed)` : ''
      const mapping = assetMapQueue.length
        ? ` ${assetMapQueue.length} need${assetMapQueue.length === 1 ? 's' : ''} their files mapped — close this window and the mapping window opens for each in turn.`
        : ''
      success(`Imported ${imported} episode${imported === 1 ? '' : 's'}${tail}.${mapping}`)
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
// A parent-folder import can turn up several episodes with files to map;
// they open one after another as each mapping window closes.
const assetMapQueue: AssetMapState[] = []
function openNextAssetMap() {
  assetMapEpisode.value = assetMapQueue.shift() || null
}
// Wait until the import window is closed so its per-folder results stay readable.
watch(importOpen, (open) => {
  if (!open && assetMapQueue.length && !assetMapEpisode.value) openNextAssetMap()
})

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
// The header checkbox selects whatever the row checkboxes can: New ideas (for
// Accept / Dismiss) and accepted episodes (for mark-done). It used to handle
// New only, so on the Accepted filter it did nothing.
const selectableOnPage = computed(() => pageIdeas.value.filter(
  i => i.status === 'new' || (i.status === 'accepted' && i.episode_code),
))
function isRowSelected(idea: any): boolean {
  return idea.status === 'new' ? selectedIds.value.has(idea.id) : selectedDoneIds.value.has(idea.episode_code)
}
const allPageSelected = computed(() =>
  selectableOnPage.value.length > 0 && selectableOnPage.value.every(isRowSelected))

// Reset page when filter changes
watch([statusFilter, searchQuery, sourceFilter], () => { page.value = 1 })
// …and pull it back when the list shrinks under it (delete, dismiss, reload),
// so the table never shows an empty "Page 3 of 2".
watch(totalPages, (pages) => { if (page.value > pages) page.value = pages })

function toggleSort(field: string) {
  if (sortField.value === field) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else { sortField.value = field; sortDir.value = field === 'generated_at' ? 'desc' : 'asc' }
}
function sortIcon(field: string) { return sortField.value === field ? (sortDir.value === 'asc' ? '▲' : '▼') : '' }
function toggleExpand(id: string) { expandedId.value = expandedId.value === id ? null : id }
function toggleSelect(id: string) { selectedIds.value.has(id) ? selectedIds.value.delete(id) : selectedIds.value.add(id) }
function toggleAll(e: Event) {
  const checked = (e.target as HTMLInputElement).checked
  for (const idea of selectableOnPage.value) {
    const set = idea.status === 'new' ? selectedIds.value : selectedDoneIds.value
    const key = idea.status === 'new' ? idea.id : idea.episode_code
    if (checked) set.add(key)
    else set.delete(key)
  }
}
function shortDate(d: string) {
  try { return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) } catch { return d }
}

// Ideas whose delete is waiting out its Undo window (see remove()).
const pendingDeleteIds = new Set<string>()

async function loadIdeas() {
  if (!slug.value) return
  try {
    const data = await get<any>(`/projects/${slug.value}/ideas`)
    // Defensive: only clobber the local list when the backend actually
    // returned an `ideas` array. A 200 with no body or a transient
    // upstream issue used to result in `data.ideas || []` blanking the
    // user's already-loaded ideas — symptom: "ideas occasionally
    // disappear on navigation". Now we only update when we have a real
    // array to update from.
    if (Array.isArray(data?.ideas)) {
      // An idea whose delete is still in its Undo window must not come back
      // just because something else reloaded the list.
      allIdeas.value = data.ideas.filter((idea: any) => !pendingDeleteIds.has(idea.id))
      // The code a default Accept will really hand out (a recycled gap
      // first), so "Use next available" never promises the wrong code.
      nextEpisodeNum.value = data.next_accept_number || data.next_episode_number || 1
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
    // Formula and Topic Packs are channel identity, not a batch-level
    // variation. Never let an old Ideas preset silently override them.
    body.niche_id = projectNicheId.value || undefined
    body.topic_pack_ids = [...projectTopicPackIds.value]
    // v1.0.93+ channel title wrap. Always sent (even when empty) so the
    // backend uses the form's current values rather than the project
    // config — keeps the live preview honest with what actually gets
    // generated. Backend treats both empty strings as "no wrapping".
    body.title_prefix = titleConfig.prefix
    body.title_suffix = titleConfig.suffix
    // With the shared lineup on, the queue assigns the lineup's model anyway;
    // the request still has to name one, so name the lineup's first.
    if (!body.model && ideasLineupModels.value.length) body.model = ideasLineupModels.value[0]
    // v1.0.165 — the X-Pattern-Warning header path was removed with the
    // Pattern system. The title template is a plain string that can't
    // "fail to load", so there's nothing to warn about; a normal POST
    // is enough.
    const operationId = freshIdeaCampaignAction.begin(body)
    await post(`/projects/${slug.value}/generate/ideas/campaign`, { ...body, operation_id: operationId })
    freshIdeaCampaignAction.complete(operationId)
    success(`Idea Campaign queued for ${form.count} idea${form.count === 1 ? '' : 's'}. You can leave this page and track it in Jobs.`)
  } catch (e: any) { showError(e.data?.detail || 'Failed to queue Idea Campaign') }
  finally { generating.value = false }
}

// A campaign saves its ideas batch by batch, so a run that ends in error or
// is cancelled still leaves real ideas behind. Reload on every ending, and on
// each progress step while it runs, so saved ideas show up without a refresh.
const ideaCampaignJob = computed(() => ideaJobs.value.find(job => job.type === 'idea_campaign' && job.episode_id === 'ideas'))
watch(
  () => ideaCampaignJob.value?.status,
  async (status, previous) => {
    if (!status || !previous || status === previous) return
    if (!['done', 'error', 'cancelled'].includes(status)) return
    await loadIdeas()
    if (status === 'done') {
      page.value = 1
      sortField.value = 'generated_at'
      sortDir.value = 'desc'
    }
  },
)
watch(
  () => ideaCampaignJob.value?.progress,
  (progress, previous) => {
    if (ideaCampaignJob.value?.status === 'running' && progress !== previous) void loadIdeas()
  },
)

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

const accepting = ref(false)
async function doAccept(action: 'folders' | 'script') {
  const idea = acceptDialogIdea.value; if (!idea || accepting.value) return
  if (!acceptCodeValid.value) return
  accepting.value = true
  try {
    const body: any = { auto_generate_script: false }
    if (acceptCodeMode.value === 'custom') {
      body.override_code = resolvedCustomCode.value
    }
    const result = await post<any>(`/projects/${slug.value}/ideas/${idea.id}/accept`, body)
    acceptDialogIdea.value = null
    await loadIdeas()
    const code = result.episode_code
    success(`Accepted! ${code} folders created.`)
    if (action === 'script') navigateTo({
      path: `/projects/${slug.value}/scripts`,
      query: scriptDeepLinkQuery({
        episodeCode: code,
        title: idea.title,
        suggestedChapters: idea.suggested_chapters,
        suggestedLength: idea.suggested_length,
      }),
    })
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to accept')
    // Show the idea's real state after a failure, never a stale "New".
    await loadIdeas()
  } finally {
    accepting.value = false
  }
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
    const warnings: string[] = Array.isArray(r.warnings) ? r.warnings : []
    if (!warnings.length) {
      success(`${r.old_code} → ${r.new_code}`)
    } else {
      // One summary toast, not one error toast per warning. Re-running the
      // code change on the same episode is safe — each step is idempotent.
      const shown = warnings.slice(0, 2).map(w => w.replace(/[.\s]+$/, '')).join('; ')
      const more = warnings.length > 2 ? ` (+${warnings.length - 2} more)` : ''
      showError(`${r.old_code} → ${r.new_code} done, but ${warnings.length} step${warnings.length === 1 ? '' : 's'} need${warnings.length === 1 ? 's' : ''} a look: ${shown}${more}. Running it again is safe.`)
    }
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Renumber failed')
  } finally {
    renumberRunning.value = false
  }
}

interface BatchAcceptResponse {
  accepted: Array<{ episode_code: string }>
  skipped: Array<{ id: string; title: string }>
  failed: Array<{ id: string; title: string; reason: string }>
}
const bulkIdeasRunning = ref(false)

async function batchAccept() {
  if (!selectedIds.value.size || bulkIdeasRunning.value) return
  bulkIdeasRunning.value = true
  try {
    const r = await post<BatchAcceptResponse>(`/projects/${slug.value}/ideas/batch-accept`, { idea_ids: Array.from(selectedIds.value) })
    const accepted = r.accepted?.length || 0
    const skipped = r.skipped?.length || 0
    const failed = r.failed || []
    const requested = accepted + skipped + failed.length
    // Keep only the ones that still need attention selected, so a second
    // click retries just those.
    selectedIds.value = new Set(failed.map(f => f.id))
    if (!failed.length) {
      success(`Accepted ${accepted} idea${accepted === 1 ? '' : 's'}${skipped ? ` (${skipped} already accepted)` : ''}.`)
    } else {
      const details = failed.slice(0, 3).map(f => `${f.title}: ${String(f.reason).replace(/[.\s]+$/, '')}`).join('; ')
      const more = failed.length > 3 ? ` (+${failed.length - 3} more)` : ''
      showError(`Accepted ${accepted} of ${requested} — ${failed.length} need${failed.length === 1 ? 's' : ''} attention: ${details}${more}`)
    }
  } catch (e: any) {
    showError(e.data?.detail || 'Could not accept the selected ideas')
  } finally {
    bulkIdeasRunning.value = false
    await loadIdeas()
  }
}

async function dismissSelected() {
  if (!selectedIds.value.size || bulkIdeasRunning.value) return
  bulkIdeasRunning.value = true
  const ids = Array.from(selectedIds.value)
  const failed: string[] = []
  try {
    for (const id of ids) {
      try { await post(`/projects/${slug.value}/ideas/${id}/dismiss`) }
      catch { failed.push(id) }
    }
    selectedIds.value = new Set(failed)
    const done = ids.length - failed.length
    if (failed.length) showError(`Dismissed ${done} of ${ids.length}. ${failed.length} could not be dismissed — they are still selected.`)
    else success(`Dismissed ${done} idea${done === 1 ? '' : 's'}.`)
  } finally {
    bulkIdeasRunning.value = false
    await loadIdeas()
  }
}
const dismissingIds = ref(new Set<string>())
async function dismiss(id: string) {
  if (dismissingIds.value.has(id)) return
  dismissingIds.value.add(id)
  try {
    await post(`/projects/${slug.value}/ideas/${id}/dismiss`)
    await loadIdeas()
  } catch (e: any) {
    showError(e?.data?.detail || 'Could not dismiss this idea')
  } finally {
    dismissingIds.value.delete(id)
  }
}
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
    return `This moves the empty ${idea.episode_code} folder to the project's _trash folder and puts the idea back to New.`
  }
  const lines = [
    `This moves ${p.file_count} file${p.file_count === 1 ? '' : 's'} (${p.total_bytes_human}) from ${idea.episode_code} to the project's _trash folder and puts the idea back to New:`,
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
  const keep = 'Nothing is deleted — you can take the files back out of _trash.'
  lines.push(rel ? `Last modified ${rel}. ${keep}` : keep)
  return lines.join('\n')
}

async function resetIdea(idea: any) {
  let message = `Move this episode's files (${idea.episode_code}: script, prompts, any images or audio) to the project's _trash and un-accept the idea. Nothing is deleted.`
  try {
    const preview = await get<any>(`/projects/${slug.value}/ideas/${idea.id}/reset-preview`)
    message = buildResetMessage(idea, preview)
  } catch { /* fall back to generic copy — don't block the operator */ }
  const ok = await ask({
    title: `Un-accept "${idea.title}"?`,
    message,
    confirmLabel: 'Move to _trash and un-accept',
    danger: true,
  })
  if (!ok) return
  try {
    const r = await post<{ warnings?: string[] }>(`/projects/${slug.value}/ideas/${idea.id}/reset`)
    await loadIdeas()
    const warning = Array.isArray(r?.warnings) ? r.warnings[0] : ''
    if (warning) showError(`${idea.episode_code} un-accepted and its project files moved to _trash, but: ${warning}`)
    else success(`${idea.episode_code} un-accepted. Its files are in the project's _trash folder.`)
  } catch (e: any) { showError(e.data?.detail || 'Could not un-accept this episode') }
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
      message: `Removes ${label} from your idea list and frees the code ${code} for a future Accept. The episode's folder and files stay where they are — nothing on disk is deleted. You'll have 10 seconds to undo.`,
      confirmLabel: 'Delete idea',
      danger: true,
    })
    if (!ok) return
  }

  // Optimistic removal — applies after the confirm gate (if any) has
  // already passed. Bound to the slug it was clicked on, and hidden from any
  // reload until the real DELETE settles.
  const slugAtDelete = slug.value
  pendingDeleteIds.add(id)
  allIdeas.value = allIdeas.value.filter(i => i.id !== id)
  selectedIds.value.delete(id)

  successUndoable({
    message: `Deleted ${label}`,
    duration: 10_000,
    onUndo: () => {
      pendingDeleteIds.delete(id)
      if (allIdeas.value.some(i => i.id === id)) return
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
      try {
        await del(`/projects/${slugAtDelete}/ideas/${id}`)
      } catch (e: any) {
        // Already gone (a second delete, another window) is the outcome we
        // wanted — not a reason to bring the idea back.
        if ((e?.status ?? e?.statusCode ?? e?.response?.status) !== 404) throw e
      } finally {
        pendingDeleteIds.delete(id)
      }
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
/* Freeform-first idea composer. The default surface deliberately stays short:
   brief, freedom, lenses, launch. Specialized controls live in one shared
   AdvancedDisclosure instead of three permanently-open fieldsets. */
.generator-panel {
  padding: 16px;
  overflow: visible;
  background:
    radial-gradient(circle at 92% 0%, rgba(240, 198, 116, 0.08), transparent 30%),
    var(--bg-secondary);
}
.generator-title { margin: 0 0 12px; font-size: 18px; }
/* Visible one-line explanations under controls (not tooltip-only). */
.control-hint { display: block; margin: 6px 0 0; line-height: 1.4; }
.idea-composer {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--bg-tertiary) 78%, transparent);
}
.idea-composer-heading,
.idea-choice-heading,
.idea-refinement-heading,
.idea-launch-dock {
  display: flex;
  align-items: center;
}
.idea-composer-heading { justify-content: space-between; gap: 16px; margin-bottom: 10px; }
.idea-composer-heading h4 { margin: 2px 0 2px; font-size: 16px; }
.idea-composer-heading p { margin: 0; color: var(--text-muted); font-size: 12px; }
.idea-step-label,
.launch-summary-label {
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.idea-open-badge {
  flex: 0 0 auto;
  padding: 4px 9px;
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  border-radius: 999px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  font-size: var(--font-xs);
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.idea-brief-input {
  width: 100%;
  min-height: 108px;
  padding: 14px 15px;
  resize: vertical;
  font-size: 14px;
  line-height: 1.55;
  border-color: color-mix(in srgb, var(--accent) 38%, var(--border));
  background: var(--bg-primary);
}
.idea-brief-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent); }
.idea-choice-row {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(320px, 0.85fr);
  gap: 12px;
  margin-top: 12px;
}
.idea-choice-group {
  min-width: 0;
  padding: 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg-secondary) 84%, transparent);
}
.idea-choice-heading { justify-content: space-between; gap: 10px; margin-bottom: 8px; }
.idea-choice-heading > span { font-size: 12px; font-weight: 700; color: var(--text-primary); }
.idea-choice-heading small { font-size: var(--font-xs); color: var(--text-muted); text-align: right; }
.freedom-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.freedom-option {
  min-width: 0;
  padding: 9px 10px;
  text-align: left;
  color: var(--text-secondary);
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
}
.freedom-option:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); transform: translateY(-1px); }
.freedom-option.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--bg-primary)); }
.freedom-option strong,
.freedom-option span { display: block; overflow: hidden; text-overflow: ellipsis; }
.freedom-option strong { color: var(--text-primary); font-size: var(--font-xs); white-space: nowrap; }
.freedom-option span { margin-top: 3px; font-size: var(--font-xs); line-height: 1.35; color: var(--text-muted); }
.creative-lenses { display: flex; flex-wrap: wrap; gap: 6px; }
.creative-lens {
  padding: 6px 9px;
  color: var(--text-secondary);
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: var(--font-xs);
  cursor: pointer;
}
.creative-lens:hover { color: var(--text-primary); border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
.creative-lens.active { color: var(--accent); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 11%, transparent); }
.originality-guard {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg-secondary) 86%, transparent);
  cursor: pointer;
}
.originality-guard.active {
  border-color: color-mix(in srgb, var(--success) 48%, var(--border));
  background: color-mix(in srgb, var(--success) 7%, var(--bg-secondary));
}
.originality-guard input { margin: 0; accent-color: var(--success); }
.originality-copy { min-width: 0; }
.originality-copy strong,
.originality-copy small { display: block; }
.originality-copy strong { color: var(--text-primary); font-size: 12px; }
.originality-copy small { margin-top: 2px; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.4; }
.originality-state {
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
}
.originality-guard.active .originality-state {
  color: var(--success);
  border-color: color-mix(in srgb, var(--success) 40%, transparent);
}
.idea-composer :deep(.adv-disclosure) { margin-top: 12px; }
.idea-composer :deep(.adv-disclosure-toggle) { padding: 9px 11px; background: color-mix(in srgb, var(--bg-primary) 70%, transparent); }
.idea-refinement-shell { display: flex; flex-direction: column; gap: 10px; }
.idea-refinement-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.idea-refinement-card {
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
}
.idea-refinement-wide { grid-column: 1 / -1; }
/* Stands alone above the disclosure rather than inside the refinement grid, so
   it needs its own spacing — grid-column is inert outside a grid. */
.idea-generation-card { margin: 12px 0; }
.idea-refinement-heading { gap: 8px; margin-bottom: 10px; }
.idea-refinement-number {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  font-size: var(--font-xs);
  font-weight: 800;
}
.idea-refinement-heading strong,
.idea-refinement-heading small { display: block; }
.idea-refinement-heading strong { font-size: 12px; }
.idea-refinement-heading small { margin-top: 1px; color: var(--text-muted); font-size: var(--font-xs); }
.compact-grid,
.generation-settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.idea-refinement-card .form-group { margin: 0; min-width: 0; }
.idea-refinement-card .form-group + .form-group { margin-top: 8px; }
.compact-grid .form-group + .form-group,
.generation-settings-grid .form-group + .form-group { margin-top: 0; }
.compact-keywords { margin-top: 8px !important; }
.title-wrap-preview { margin: 7px 0 0; color: var(--text-muted); font-size: var(--font-xs); }
.title-wrap-preview code { color: var(--text-secondary); }
.idea-launch-dock {
  gap: 12px;
  margin-top: 12px;
  padding: 11px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
  border-radius: var(--radius-md);
  background: linear-gradient(100deg, color-mix(in srgb, var(--accent) 11%, var(--bg-tertiary)), var(--bg-tertiary));
}
.idea-launch-summary { flex: 1 1 220px; min-width: 0; }
.idea-launch-summary span,
.idea-launch-summary strong { display: block; }
.idea-launch-summary strong { margin-top: 2px; overflow: hidden; color: var(--text-secondary); font-size: var(--font-xs); text-overflow: ellipsis; white-space: nowrap; }
.idea-count-control { display: flex; align-items: center; gap: 7px; color: var(--text-muted); font-size: var(--font-xs); }
.idea-count-control .input { width: 64px; height: 34px; padding: 5px 8px; }
.generator-actions-primary { display: flex; gap: 7px; flex-wrap: wrap; align-items: center; }
.generator-actions-secondary { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
/* Disclosure toggle is a borderless/background-less .btn, so its only
 * affordance is the text colour. `--text-muted` (#6b7280) reads fine on the
 * light bg but only hits ~3.9:1 on the dark page bg (#0f1117) — under the
 * 4.5:1 floor, which is why it was nearly invisible in dark mode. Use the
 * theme-aware `--text-secondary` (good contrast in both themes, still lighter
 * than the primary actions) and brighten to primary on hover for affordance. */
.other-ways-toggle { color: var(--text-secondary); }
.other-ways-toggle:hover { color: var(--text-primary); }

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
.format-indicator-label { font-size: var(--font-xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); font-weight: 600; }
.format-indicator-name { font-size: 15px; color: var(--text-primary); }
.format-indicator-badge { font-size: var(--font-xs); text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 6px; border-radius: 8px; font-weight: 600; }
.format-indicator-badge.badge-builtin { background: var(--bg-tertiary); color: var(--text-muted); border: 1px solid var(--border); }
.format-indicator-badge.badge-custom  { background: var(--accent); color: var(--bg-primary); border: 1px solid var(--accent); }
.format-indicator-badge.badge-warn    { background: #5a3a00; color: #ffd58a; border: 1px solid #ffd58a; }
.format-indicator-desc { margin: 2px 0 0; font-size: 13px; color: var(--text-primary); line-height: 1.45; }
.format-indicator-hint { margin: 4px 0 0; line-height: 1.45; }
.format-indicator-actions { display: flex; flex-direction: column; gap: 6px; align-items: stretch; min-width: 160px; }
.format-indicator-actions .btn { width: 100%; text-align: center; }

/* Per-field "From [Format]" tags shown next to dropdown labels. */
.vocab-source-tag {
  font-size: var(--font-xs); font-weight: 500; color: var(--text-muted);
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
/* Generated titles are long documentary headlines. A single nowrap line
   ellipsised at 250px made most of them unreadable ("Why Earth's Magnetic
   Field Quietly Shapes the Atmosphe…"), so the title now wraps to two lines in
   a wider column and the cell carries a native `title` tooltip with the full
   string. The column still collapses gracefully — the table container already
   scrolls horizontally. */
.td-title { font-weight: 500; color: var(--text-primary); min-width: 220px; max-width: 520px; }
.idea-title-text {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2;
  overflow: hidden; overflow-wrap: anywhere; line-height: 1.35;
}
.td-date { white-space: nowrap; }
.td-actions { white-space: nowrap; display: flex; gap: 4px; align-items: center; }

.sortable { cursor: pointer; user-select: none; }
.sortable:hover { color: var(--accent); }

.idea-row { cursor: pointer; transition: background 0.1s; }
.idea-row:hover { background: var(--bg-hover); }
.idea-row.status-accepted { border-left: 3px solid var(--success); }
.idea-row.status-dismissed { opacity: 0.45; }

.status-badge { padding: 2px 8px; border-radius: 10px; font-size: var(--font-xs); font-weight: 500; }
.status-badge.new { background: rgba(251,191,36,0.15); color: var(--warning); }
.status-badge.accepted { background: rgba(74,222,128,0.15); color: var(--success); }
.status-badge.dismissed { background: rgba(107,114,128,0.15); color: var(--text-muted); }

.code-badge { font-size: var(--font-xs); font-weight: 600; color: var(--success); }

/* Expanded row */
.expand-row td { padding: 0; background: var(--bg-tertiary); }
.expand-content { padding: 12px 16px 14px; }
.expand-logline { font-size: 13px; line-height: 1.5; color: var(--text-secondary); margin-bottom: 8px; }
.expand-tags { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.idea-tag { background: var(--accent-dim); color: var(--accent); padding: 1px 8px; border-radius: 10px; font-size: var(--font-xs); }

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
  border-radius: 4px; font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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

.channel-identity-readonly { display: flex; flex-direction: column; gap: 5px; padding: 10px; border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border)); border-radius: 6px; background: var(--bg-secondary); font-size: var(--font-xs); }
.channel-identity-readonly strong { color: var(--text-primary); font-size: 13px; }
.channel-identity-readonly span { color: var(--text-secondary); }
.identity-context-action { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 8px; padding: 8px 12px; color: var(--text-muted); font-size: var(--font-xs); }
@media (max-width: 620px) {
  .identity-context-action { align-items: stretch; flex-direction: column; }
  .identity-context-action .btn { align-self: flex-start; }
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
.code-hint { color: var(--text-muted); font-size: var(--font-xs); }
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
  font-size: var(--font-xs); color: var(--accent);
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
  font-size: var(--font-xs); color: #eab308;
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
.import-mode-hint { font-size: var(--font-xs); color: var(--text-muted); }

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
.parent-sub-status { font-size: var(--font-xs); color: var(--text-muted); }
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  position: sticky;
  top: 0;
}
/* Paste-preview column shape — matches the per-row layout. */
/* v1.0.402 — min-widths so flexible columns keep readable width (no
   one-word-per-line crush); the table scrolls sideways if the window is too
   narrow to fit them all. */
.paste-preview-row .ppr-num      { flex: 0 0 auto; min-width: 24px; color: var(--text-muted); font-size: var(--font-xs); }
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.context-chip strong { font-weight: 600; }
.context-chip strong.is-fallback { color: var(--text-muted); font-weight: normal; font-style: italic; }
.context-override { color: var(--accent, #6c8fff); font-size: var(--font-xs); }
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
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.context-detail-value { color: var(--text-primary); font-weight: 500; }
.context-detail-value.is-fallback { color: var(--text-muted); font-style: italic; font-weight: normal; }
.context-detail-value em { font-style: italic; color: var(--accent, #6c8fff); }
.context-detail-desc { margin: 0 0 0 74px; font-size: 13px; color: var(--text-primary); line-height: 1.45; }
.context-detail-hint { margin: 0 0 0 74px; line-height: 1.4; }
.context-badge {
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
  color: rgba(240, 198, 116, 0.95);
  padding: 1px 8px;
  background: rgba(240, 198, 116, 0.10);
  border-radius: 999px;
}
.context-override-tag { color: var(--accent, #6c8fff); background: rgba(108, 143, 255, 0.10); }
.effective-link.subtle { margin-left: 0; opacity: 0.85; }

@media (max-width: 1180px) {
  .idea-choice-row { grid-template-columns: 1fr; }
  .idea-refinement-grid { grid-template-columns: 1fr; }
  .idea-refinement-wide { grid-column: auto; }
  .idea-launch-dock { align-items: flex-end; flex-wrap: wrap; }
}

@media (max-width: 720px) {
  .generator-panel,
  .idea-composer { padding: 12px; }
  .idea-composer-heading { align-items: flex-start; }
  .idea-open-badge { display: none; }
  .freedom-options,
  .compact-grid,
  .generation-settings-grid { grid-template-columns: 1fr; }
  .idea-choice-heading { align-items: flex-start; flex-direction: column; }
  .idea-choice-heading small { text-align: left; }
  .originality-guard { grid-template-columns: auto minmax(0, 1fr); }
  .originality-state { grid-column: 2; justify-self: start; }
  .idea-launch-dock { align-items: stretch; flex-direction: column; }
  .idea-count-control { justify-content: space-between; }
  .generator-actions-primary { display: grid; grid-template-columns: 1fr; }
  .generator-actions-primary .btn { width: 100%; }
}
</style>
