<template>
  <div class="settings-workspace">
    <header class="settings-page-hero">
      <div class="settings-page-copy">
        <h1>Settings</h1>
        <p>Find one setting, see its scope, and change how <strong>{{ projectForm.name || project?.name || 'this project' }}</strong> works.</p>
      </div>
      <div class="settings-page-key" aria-label="Settings storage key">
        <span><i class="key-dot key-machine" />This Mac</span>
        <span><i class="key-dot key-project" />This Project</span>
      </div>
    </header>

    <SettingsSectionNav v-model="activeTab" :zones="tabZones" />

    <section
      v-if="activeZone && activeTabMeta"
      :class="['settings-active-intro', activeZone.id === 'machine' ? 'scope-machine' : 'scope-project']"
    >
      <div class="settings-active-copy">
        <h2 :id="activeTab">{{ activeTabMeta.label }}</h2>
        <span
          v-for="targetId in inactiveSettingsHashTargets"
          :id="targetId"
          :key="targetId"
          class="settings-hash-target"
          aria-hidden="true"
        ></span>
        <p>{{ activeTabMeta.description }}</p>
      </div>
      <span class="settings-scope-pill">
        {{ activeZone.id === 'machine' ? 'Stays on this Mac' : 'Travels with project' }}
      </span>
    </section>

    <div v-if="activeTab === 'connections'" class="card settings-panel settings-panel-embedded mt-2">
      <ThisMacSettings section="connections" />
      <GenStudioCatalogSettings />
      <YouTubeConnectionSettings :slug="slug" scope="connections" />
    </div>

    <div v-if="activeTab === 'performance'" class="card settings-panel settings-panel-embedded mt-2">
      <ThisMacSettings section="performance" />
    </div>

    <div v-if="activeTab === 'appearance'" class="card settings-panel settings-panel-embedded mt-2">
      <ThisMacSettings section="appearance" />
    </div>

    <!-- Channel Identity — production path -->
    <div v-if="activeTab === 'production'" class="card settings-panel mt-2">
      <div class="format-tab-header">
        <div>
          <h3>Continuity Engine</h3>
          <p class="text-muted mt-1 mb-2">
            This is the one production engine for every channel. Choose how it handles
            scene references. <a href="#identity">Channel identity</a> owns the
            Series Formula for titles, perspective, voice, and script structure.
          </p>
        </div>
      </div>

      <div class="continuity-engine-summary">
        <strong>Continuity Engine</strong>
        <span>Narration-timed scene planning, with independent or character-anchored reference behavior.</span>
      </div>

      <div class="continuity-mode-box mt-3">
        <div class="cm-label">Reference behavior</div>
        <p class="text-muted text-xs mt-1">Every channel uses the Continuity Engine. Choose the starting behavior for new episodes; Character Sheet can still refine an individual episode.</p>
        <div class="cm-options">
          <label class="cm-opt" :class="{ active: continuityMode === 'independent-stills' }">
            <input v-model="continuityMode" type="radio" value="independent-stills" />
            <div><strong>Independent illustrated scenes</strong><div class="text-muted text-xs">No previous-frame reference. Best for explainers, history, economics, and varied locations.</div></div>
          </label>
          <label class="cm-opt" :class="{ active: continuityMode === 'character-continuity' }">
            <input v-model="continuityMode" type="radio" value="character-continuity" />
            <div><strong>Character continuity</strong><div class="text-muted text-xs">Each scene references the previous render and character anchors for one recurring on-screen subject.</div></div>
          </label>
          <label class="cm-opt" :class="{ active: continuityMode === 'explainer-stills' }">
            <input v-model="continuityMode" type="radio" value="explainer-stills" />
            <div><strong>Explainer boards</strong><div class="text-muted text-xs">Independent subject-led scenes, ready for an optional composition reference.</div></div>
          </label>
        </div>
      </div>

      <div class="mt-3 button-row">
        <button class="btn btn-primary" :disabled="formatSaving || !formatDirty" @click="saveFormatSettings">
          {{ formatSaving ? 'Saving…' : 'Save Continuity behavior' }}
        </button>
        <SaveIndicator v-bind="savedHintProps('format')" />
        <span v-if="formatSaveError" class="text-error">{{ formatSaveError }}</span>
      </div>

      <section class="channel-visual-defaults mt-3">
        <div class="settings-section-head">
          <div>
            <span class="settings-section-kicker">Visual planning defaults</span>
            <h3>Recurring guide visibility</h3>
            <p>Controls how often Scene Plan includes its recurring on-screen guide in newly generated episodes. This is a channel rule, not a Character Sheet setting.</p>
          </div>
          <span class="settings-section-count">{{ guideDensityLabel }}</span>
        </div>
        <div class="channel-guide-density-row">
          <input
            v-model.number="guideDensity"
            type="range"
            min="0"
            max="100"
            step="5"
            class="channel-guide-density-slider"
            :disabled="savingGuideDensity"
            @change="saveGuideDensity"
          />
          <output class="channel-guide-density-value" :class="{ off: guideDensity === 0 }">{{ guideDensity }}%</output>
        </div>
        <p class="text-muted text-xs mt-1">
          <strong>0%</strong> means no recurring guide; <strong>100%</strong> means one in every scene. Existing Scene Plans stay unchanged—regenerate a plan to apply this default.
        </p>
        <SaveIndicator v-bind="savedHintProps('guide_density')" />
      </section>

      <section class="audio-quality-settings mt-3" aria-labelledby="audio-quality-settings-title">
        <div class="settings-section-head">
          <div>
            <h3 id="audio-quality-settings-title">Audio quality</h3>
            <p>Choose whether this channel checks chapter narration after subtitles exist. Normal Audio and Pipeline runs stay available in every mode.</p>
          </div>
          <span class="settings-section-count">{{ audioQualityModeSummary }}</span>
        </div>

        <div class="audio-quality-options" role="radiogroup" aria-label="Audio quality mode">
          <label v-for="option in audioQualityModeOptions" :key="option.value" :class="['audio-quality-option', { active: audioQualityMode === option.value }]">
            <input v-model="audioQualityMode" type="radio" :value="option.value" />
            <span>
              <strong>{{ option.label }} <small v-if="option.recommended">Recommended during calibration</small></strong>
              <span>{{ option.description }}</span>
            </span>
          </label>
        </div>

        <div v-if="audioQualityMode === 'check_and_repair'" class="audio-quality-alternate">
          <label>Alternate transcription model <span class="required" aria-hidden="true">*</span></label>
          <ModelMenu
            v-model="audioQualityAlternateModel"
            :options="audioQualityModelOptions"
            media-type="transcription"
            title="Choose the alternate transcription model"
            placeholder="Choose a published model…"
            search-placeholder="Search transcription models…"
            aria-label="Alternate transcription model"
          />
          <p class="text-muted text-xs mt-1">
            You choose the alternate. It must have a different published model ID from the first transcript; a different provider name alone does not make it a distinct model.
          </p>
          <p v-if="audioQualityCatalogLoading" class="text-muted text-xs mt-1"><LoadingSpinner size="sm" /> Loading published transcription models…</p>
          <p v-else-if="audioQualityCatalogError" class="text-warning text-xs mt-1">
            {{ audioQualityCatalogError }}
            <button type="button" class="btn btn-sm btn-ghost" @click="loadAudioQualityModels">Retry</button>
          </p>
          <p v-else-if="audioQualityCatalogStale" class="text-warning text-xs mt-1">
            {{ audioQualityCatalogStaleNote }}. Showing the last available catalog for display only; refresh it before starting a paid quality check.
            <button type="button" class="btn btn-sm btn-ghost" @click="loadAudioQualityModels">Refresh</button>
          </p>
        </div>

        <p v-if="audioQualityMode === 'check_and_repair'" class="audio-quality-cost-note">
          Replacement narration estimates are advisory because the current TTS contract has no hard aggregate credit ceiling. Audio requires an action-specific verification credit ceiling; transcription is quoted after candidate audio exists, and a higher quote holds that candidate for your approval.
        </p>

        <div class="audio-quality-save-row">
          <button
            type="button"
            class="btn btn-primary"
            :disabled="audioQualitySaving || !audioQualityDirty || !audioQualityValid"
            @click="saveAudioQuality"
          >{{ audioQualitySaving ? 'Saving…' : 'Save audio quality' }}</button>
          <SaveIndicator v-bind="savedHintProps('audio_quality')" />
          <span v-if="!audioQualityValid" class="text-warning text-xs">Choose an alternate transcription model to enable checked repair.</span>
          <span v-if="audioQualitySaveError" class="text-error text-xs">{{ audioQualitySaveError }}</span>
        </div>
      </section>

    </div>

    <div v-if="activeTab === 'publishing'" class="card publishing-profile-card settings-panel mt-2">
      <div class="settings-section-head">
        <div>
          <span class="settings-section-kicker">YouTube publishing</span>
          <h3>Publishing Profile</h3>
          <p>Set channel-wide links, credits, CTAs, disclosures, recurring tags, and an optional title wrapper once. The selected Series Formula continues to own episode-specific metadata.</p>
        </div>
        <NuxtLink :to="`/projects/${slug}/metadata-template`" class="btn btn-primary">Configure publishing profile</NuxtLink>
      </div>
    </div>

    <div v-if="activeTab === 'publishing'" class="card settings-panel settings-panel-embedded mt-2">
      <YouTubeConnectionSettings :slug="slug" scope="assignment" />
      <p class="settings-cross-link">
        YouTube accounts are shared by this Mac.
        <a href="#connections" @click="activeTab = 'connections'">Manage connected accounts</a>
      </p>
    </div>

    <!-- Channel Identity — formula + subject lane layer. -->
    <div v-if="['identity', 'production', 'publishing'].includes(activeTab)" class="card settings-panel mt-2">
      <div v-if="activeTab === 'identity'" class="format-tab-header">
        <div>
          <h3>Series Formula + Topic Packs</h3>
          <p class="text-muted mt-1 mb-2">
            The Series Formula defines the recurring hook, title style, script
            flow, and channel voice. Topic Packs supply reusable subject lanes.
            Mix one formula with several packs to expand without duplicating the
            channel structure. The Production Path above remains independent.
          </p>
        </div>
      </div>

      <div v-if="activeTab === 'identity'" class="sub-tabs mt-3">
        <button
          :class="['sub-tab', { active: nicheSubTab === 'project' }]"
          @click="nicheSubTab = 'project'"
        >Project formula</button>
        <button
          :class="['sub-tab', { active: nicheSubTab === 'library' }]"
          @click="nicheSubTab = 'library'"
        >Custom formulas <span class="sub-tab-count">· {{ nicheLibraryCount }}</span></button>
      </div>

      <!-- ── Sub-tab 1: Project niche picker ───────────────────────── -->
      <div v-if="activeTab !== 'identity' || nicheSubTab === 'project'" class="sub-tab-body">
        <h4 v-if="activeTab === 'identity'" class="sub-tab-section-title">Choose the formula and subject lanes this channel uses</h4>
        <section v-if="activeTab === 'identity'" class="channel-identity-summary">
          <div class="channel-identity-summary-copy">
            <span>Series Formula</span>
            <strong>{{ selectedFormulaLabel }}</strong>
            <small>{{ selectedNicheProfile?.description || (nicheId ? 'This saved Formula is currently unavailable from the library.' : 'General generation without a repeatable Formula.') }}</small>
          </div>
          <div class="channel-identity-summary-copy">
            <span>Topic Packs</span>
            <strong>{{ selectedTopicPackLabel }}</strong>
            <small>{{ topicPackIds.length ? 'Reusable subject inventories selected for this channel.' : 'No Topic Packs selected.' }}</small>
          </div>
          <button type="button" class="btn btn-primary" @click="identityPickerOpen = true">Choose Formula &amp; Topics</button>
        </section>

        <!-- v1.4.20 — how often this channel publishes. Channel-level, because
             an upload plan cannot exist before a YouTube account is connected. -->
        <section v-if="activeTab === 'publishing'" class="episode-shape-card">
          <div class="episode-shape-head">
            <div>
              <span class="settings-section-kicker">Publishing cadence</span>
              <h4>How often this channel puts out an episode</h4>
              <p class="text-muted text-sm mb-0">
                Set the rhythm once and each finished episode takes the next free slot on its own.
                <template v-if="cadenceHasPlan">
                  This channel already has an upload plan, so that plan is what actually schedules —
                  edit it using Manage upload plans below. What you set here seeds any new account you connect.
                </template>
                <template v-else>
                  This seeds a plan when you connect YouTube. If the channel is already connected, create or choose its plan below.
                </template>
              </p>
            </div>
          </div>

          <NuxtLink :to="`/projects/${slug}/upload/plans`" class="btn btn-ghost btn-sm mb-3">Manage upload plans</NuxtLink>

          <div v-if="cadenceLoaded" class="cadence-body">
            <div class="cadence-days">
              <button
                v-for="(label, day) in WEEKDAY_LABELS"
                :key="day"
                type="button"
                class="cadence-day"
                :class="{ on: cadenceWeekdays.includes(day) }"
                @click="toggleCadenceWeekday(day)"
              >{{ label }}</button>
            </div>

            <div class="episode-shape-fields mt-2">
              <label>
                <span>Time of day</span>
                <input v-model="cadenceTime" type="time" />
              </label>
              <label>
                <span>Every</span>
                <select v-model.number="cadenceIntervalWeeks">
                  <option :value="1">week</option>
                  <option :value="2">2 weeks</option>
                  <option :value="3">3 weeks</option>
                  <option :value="4">4 weeks</option>
                </select>
              </label>
              <label>
                <span>Time zone</span>
                <input v-model="cadenceTimezone" type="text" placeholder="Asia/Phnom_Penh" />
              </label>
            </div>

            <p class="episode-shape-maths text-muted text-sm">
              <template v-if="cadencePerMonth">
                That is about <strong>{{ cadencePerMonth }}</strong> episodes a month.
              </template>
              <template v-else>
                Pick at least one day — a schedule with no days can never produce a slot.
              </template>
            </p>

            <label class="episode-shape-check">
              <input v-model="autoScheduleOnRender" type="checkbox" />
              <span>
                Give each episode a publish time as soon as it finishes rendering
                <small class="text-muted">
                  Nothing is sent to YouTube — the episode just gets its slot, and you still press
                  upload. An episode that is already live, or already has a time, is left alone.
                </small>
              </span>
            </label>

            <p v-if="cadenceError" class="error-box mt-2">{{ cadenceError }}</p>

            <div class="episode-shape-actions">
              <button class="btn btn-sm btn-primary" type="button" :disabled="cadenceSaving" @click="saveCadence">
                {{ cadenceSaving ? 'Saving…' : 'Save cadence' }}
              </button>
            </div>
          </div>
        </section>

        <!-- v1.4.18 — the episode shape, editable. Sits with the Formula it
             belongs to rather than in the library, because it is a decision
             about THIS channel's episodes. -->
        <section v-if="activeTab === 'production' && nicheId" class="episode-shape-card">
          <div class="episode-shape-head">
            <div>
              <span class="settings-section-kicker">Episode shape</span>
              <h4>How long an episode runs, and how it is read</h4>
              <p class="text-muted text-sm mb-0">
                These are the numbers every new episode of this channel starts from. Change them
                whenever you like — the first change makes this channel its own copy of the Formula,
                so no other channel is affected.
              </p>
            </div>
            <button
              v-if="!shapeOpen"
              class="btn btn-sm btn-secondary"
              @click="openEpisodeShape"
            >Change</button>
          </div>

          <div v-if="!shapeOpen" class="episode-shape-grid">
            <div class="episode-shape-item">
              <span>Usual length</span>
              <strong>{{ selectedNicheProfile?.scriptStructure?.defaultLengthMinutes ?? 8 }} min</strong>
              <small>
                Allowed {{ selectedNicheProfile?.scriptStructure?.lengthMinutesRange?.[0] ?? 3 }}–{{
                  selectedNicheProfile?.scriptStructure?.lengthMinutesRange?.[1] ?? 20 }} min
              </small>
            </div>
            <div class="episode-shape-item">
              <span>Chapters</span>
              <strong>{{ selectedNicheProfile?.scriptStructure?.defaultChapterCount ?? 5 }}</strong>
              <small>
                Allowed {{ selectedNicheProfile?.scriptStructure?.chapterCountRange?.[0] ?? 1 }}–{{
                  selectedNicheProfile?.scriptStructure?.chapterCountRange?.[1] ?? 20 }}
              </small>
            </div>
            <div class="episode-shape-item">
              <span>Reading pace</span>
              <strong>{{ selectedNicheProfile?.scriptStructure?.defaultWordsPerMinute ?? 160 }} wpm</strong>
              <small>Slower for sleep and prayer, faster for explainers.</small>
            </div>
            <div class="episode-shape-item">
              <span>Chapters</span>
              <strong>{{ selectedNicheProfile?.scriptStructure?.chaptersIndependent ? 'Standalone' : 'One story' }}</strong>
              <small>
                {{ selectedNicheProfile?.scriptStructure?.chaptersIndependent
                  ? 'Each chapter is its own subject, like a list.'
                  : 'Chapters continue into each other.' }}
              </small>
            </div>
          </div>

          <form v-else class="episode-shape-form" @submit.prevent="saveEpisodeShape">
            <div class="episode-shape-fields">
              <label>
                <span>Usual length (minutes)</span>
                <input v-model.number="shapeForm!.defaultLengthMinutes" type="number" min="1" max="600" />
              </label>
              <label>
                <span>Shortest allowed</span>
                <input v-model.number="shapeForm!.minutesMin" type="number" min="1" max="600" />
              </label>
              <label>
                <span>Longest allowed</span>
                <input v-model.number="shapeForm!.minutesMax" type="number" min="1" max="600" />
              </label>
              <label>
                <span>Usual chapters</span>
                <input v-model.number="shapeForm!.defaultChapterCount" type="number" min="1" max="100" />
              </label>
              <label>
                <span>Fewest allowed</span>
                <input v-model.number="shapeForm!.chapterMin" type="number" min="1" max="100" />
              </label>
              <label>
                <span>Most allowed</span>
                <input v-model.number="shapeForm!.chapterMax" type="number" min="1" max="100" />
              </label>
              <label>
                <span>Reading pace (words per minute)</span>
                <input v-model.number="shapeForm!.defaultWordsPerMinute" type="number" min="50" max="300" />
              </label>
            </div>

            <p class="episode-shape-maths text-muted text-sm">
              At these settings an episode is about
              <strong>{{ shapeTotalWords.toLocaleString() }}</strong> words —
              roughly <strong>{{ shapeWordsPerChapter.toLocaleString() }}</strong> per chapter.
            </p>

            <label class="episode-shape-check">
              <input v-model="shapeForm!.chaptersIndependent" type="checkbox" />
              <span>
                Each chapter stands alone
                <small class="text-muted">
                  Tick this for lists and countdowns, where a chapter is its own subject. Leave it
                  clear when the chapters tell one continuing story.
                </small>
              </span>
            </label>

            <label class="episode-shape-tone">
              <span>Title voice</span>
              <textarea
                v-model="shapeForm!.metadataTitleStyleHint"
                rows="2"
                placeholder="Leave empty to use the format's own wording."
              ></textarea>
              <small class="text-muted">
                How titles for this channel should be pitched, in your words — for example
                “Name the creature and the strange fact. No mystery-baiting.”
              </small>
            </label>

            <p v-if="shapeError" class="error-box mt-2">{{ shapeError }}</p>

            <div class="episode-shape-actions">
              <button class="btn btn-sm btn-primary" type="submit" :disabled="shapeSaving">
                {{ shapeSaving ? 'Saving…' : 'Save episode shape' }}
              </button>
              <button class="btn btn-sm btn-ghost" type="button" :disabled="shapeSaving" @click="shapeOpen = false">
                Cancel
              </button>
            </div>
          </form>
        </section>

        <section v-if="activeTab === 'production' && selectedProductionKit" class="production-kit-card mt-3">
          <div class="production-kit-head">
            <div>
              <span class="settings-section-kicker">Formula production kit</span>
              <h4>{{ selectedProductionKit.label }}</h4>
              <p>{{ selectedProductionKit.description }}</p>
            </div>
            <span class="production-kit-status">Suggestions</span>
          </div>

          <div class="production-kit-grid">
            <div class="production-kit-item">
              <span>Suggested visual style</span>
              <template v-if="productionKitStyleSuggestion">
                <strong>{{ productionKitStyleSuggestion.name }}</strong>
                <small v-if="productionKitStyleSuggestion.inUse">
                  In use on this channel. Art style is always your choice — change it any time in
                  Settings → Art Style.
                </small>
                <template v-else-if="productionKitStyleSuggestion.installed">
                  <small>Installed, but not selected. Your current art style stays until you apply this.</small>
                  <button
                    class="btn btn-sm btn-secondary mt-1"
                    type="button"
                    :disabled="artStyleSaving"
                    @click="useSuggestedProductionKitStyle"
                  >
                    Use this style
                  </button>
                </template>
                <small v-else-if="visualStylesLoading">Checking installed Content Pack styles…</small>
                <small v-else-if="visualStylesError">
                  Could not check installed Content Pack styles. Retry in Settings → Art Style.
                </small>
                <small v-else>
                  Not installed. Get it from the
                  <NuxtLink to="/content-store">Content Store</NuxtLink>, or keep the style you already use.
                </small>
              </template>
              <template v-else>
                <strong>Your choice</strong>
                <small>This Formula suggests no particular look. Pick one in Settings → Art Style.</small>
              </template>
            </div>
            <div class="production-kit-item">
              <span>Thumbnail recipe</span>
              <strong>{{ selectedProductionKitThumbnailName }}</strong>
              <small>The Formula's default when you have not chosen one; overridable in Thumbnail Prompts.</small>
            </div>
            <div class="production-kit-item">
              <span>Motion</span>
              <strong>{{ selectedProductionKitMotionName }}</strong>
              <small>{{ selectedProductionKitMotionSummary }}</small>
            </div>
            <div class="production-kit-item">
              <span>Long-form presets</span>
              <strong>{{ selectedProductionKitDurations }}</strong>
              <small>Chapter count, narration pace, visual rhythm, and motion all come from the Formula.</small>
            </div>
          </div>

          <div v-if="selectedProductionKit.episodeProfiles?.length" class="production-kit-profiles">
            <span>Automatic episode profiles</span>
            <div>
              <span
                v-for="profile in selectedProductionKit.episodeProfiles"
                :key="profile.id"
                class="production-profile-pill"
                :title="profile.description"
              >{{ profile.label }}</span>
            </div>
            <small>Idea Campaign assigns and saves these lanes. Script and thumbnail behavior follow the saved idea profile—there is no per-run profile picker.</small>
          </div>
        </section>

        <div v-if="activeTab === 'identity'" class="mt-3 button-row"><SaveIndicator v-bind="savedHintProps('niche')" /></div>

        <p v-if="activeTab === 'identity'" class="text-muted text-xs mt-3">
          <strong>Channel default:</strong> this Formula and Pack selection automatically drives
          Ideas, Script, Metadata, and visual direction. Idea campaigns show it as status rather
          than asking you to select it again.
        </p>
        <p v-if="activeTab === 'identity'" class="text-muted text-xs mt-1">
          Need to author a local formula? Switch to <strong>Custom formulas</strong> above.
        </p>
      </div>

      <!-- ── Sub-tab 2: Niche library (browse + create + delete) ─────── -->
      <div v-if="activeTab === 'identity' && nicheSubTab === 'library'" class="sub-tab-body">
        <div class="niche-library-header">
          <h4 class="sub-tab-section-title">Custom formulas</h4>
          <button
            class="btn btn-primary btn-sm"
            :disabled="nicheCreateBusy"
            @click="openNicheCreator"
          >+ Create custom niche</button>
        </div>
        <p class="text-muted text-sm">
          Create and maintain formulas authored on this Mac. Browse Installed, Included,
          Built in, and Custom choices together from Choose Formula &amp; Topics.
        </p>

        <div v-if="nicheLibLoading" class="muted mt-3">Loading niches…</div>
        <div v-else-if="nicheLibError" class="error-box mt-3">{{ nicheLibError }}</div>
        <div v-else-if="!customNicheLibList.length" class="empty-box mt-3">
          No custom formulas yet. Create one here, then select it from the Channel Identity library.
        </div>

        <div v-else class="niche-lib-grid mt-3">
          <article
            v-for="n in customNicheLibList"
            :key="n.id"
            class="niche-lib-tile"
            :class="{ 'tile-builtin': n.builtin, 'tile-custom': !n.builtin, 'tile-active': n.id === nicheId }"
          >
            <div class="tile-header">
              <h5>{{ n.name }}</h5>
              <span v-if="n.id === nicheId" class="badge badge-active">project niche</span>
              <span class="badge badge-custom">custom</span>
              <span v-if="n.catalog?.version" class="badge">v{{ n.catalog.version }}</span>
            </div>
            <p v-if="n.tagline" class="tile-tagline">{{ n.tagline }}</p>
            <p class="tile-description">{{ n.description }}</p>
            <div class="tile-stats">
              <span><strong>{{ n.exampleTopics.length }}</strong> example {{ n.exampleTopics.length === 1 ? 'topic' : 'topics' }}</span>
              <span v-if="n.vocabulary?.keyword">
                <strong>{{ n.vocabulary.keyword.length }}</strong> keywords
              </span>
              <span v-if="n.titleShapeRules?.length">
                <strong>{{ n.titleShapeRules.length }}</strong> title rules
              </span>
              <span v-if="n.referenceImages?.length">
                <strong>{{ n.referenceImages.length }}</strong> refs
              </span>
              <span v-if="n.project_count">
                in <strong>{{ n.project_count }}</strong> {{ n.project_count === 1 ? 'project' : 'projects' }}
              </span>
            </div>
            <details class="tile-details">
              <summary>Example topics</summary>
              <ul class="topic-list">
                <li v-for="t in n.exampleTopics.slice(0, 10)" :key="t">{{ t }}</li>
                <li v-if="n.exampleTopics.length > 10" class="topic-more">+{{ n.exampleTopics.length - 10 }} more</li>
              </ul>
            </details>
            <details v-if="n.visualStyleSheet || n.scriptContext" class="tile-details">
              <summary>Generator context</summary>
              <div v-if="n.scriptContext" class="detail-row">
                <strong>Script:</strong> {{ n.scriptContext }}
              </div>
              <div v-if="n.visualStyleSheet" class="detail-row">
                <strong>Visual:</strong> {{ n.visualStyleSheet }}
              </div>
            </details>
            <div class="tile-actions">
              <button
                v-if="!n.builtin"
                class="btn btn-ghost btn-sm danger"
                :title="n.project_count ? `Can't delete — ${n.project_count} project(s) still reference this niche.` : 'Delete this custom niche.'"
                :disabled="!!n.project_count"
                @click="confirmDeleteNiche(n)"
              >Delete</button>
            </div>
          </article>
        </div>
      </div>
    </div>

    <ChannelIdentityPickerModal
      :visible="identityPickerOpen"
      :project-slug="slug"
      :selected-formula-id="nicheId"
      :selected-topic-pack-ids="topicPackIds"
      :project-content-pack-versions="projectContentPackVersions"
      @close="identityPickerOpen = false"
      @saved="onIdentitySaved"
    />

    <!-- v1.0.96+ Create-custom-niche modal. Lives under the Niche tab now
         (the standalone /niches sidebar page is gone). Same form fields as
         before — id, name, tagline, description, example topics, script
         context, visual style sheet. -->
    <Modal
      v-if="nicheCreateOpen"
      :visible="nicheCreateOpen"
      size="md"
      labelledby="niche-create-title"
      @close="closeNicheCreator"
    >
      <h3 id="niche-create-title">Create custom niche</h3>
      <p class="text-muted text-sm mt-1 mb-2">
        Custom niches live alongside the built-ins. Fill in the basics here;
        you can expand example topics, add a visual style sheet, or layer in
        title shape rules later by editing the JSON file directly.
      </p>
      <div class="form-group">
        <label><strong>id</strong> <span class="text-muted text-xs">lowercase slug — letters / digits / dashes / underscores</span></label>
        <input v-model="nicheDraft.id" class="input" placeholder="e.g. gemstones" :disabled="nicheCreateBusy" />
      </div>
      <div class="form-group mt-2">
        <label><strong>name</strong> <span class="text-muted text-xs">label shown in the picker</span></label>
        <input v-model="nicheDraft.name" class="input" placeholder="e.g. Gemstones & Minerals" :disabled="nicheCreateBusy" />
      </div>
      <div class="form-group mt-2">
        <label><strong>tagline</strong> <span class="text-muted text-xs">optional one-liner shown on the niche card</span></label>
        <input v-model="nicheDraft.tagline" class="input" placeholder="e.g. Crystalline, ancient, weirdly violent to form." :disabled="nicheCreateBusy" />
      </div>
      <div class="form-group mt-2">
        <label><strong>description</strong> <span class="text-muted text-xs">2-3 sentences describing what this niche covers</span></label>
        <textarea v-model="nicheDraft.description" class="input" rows="3" :disabled="nicheCreateBusy" />
      </div>
      <div class="form-group mt-2">
        <label><strong>example topics</strong> <span class="text-muted text-xs">one per line — feeds the Ideas generator's title bar</span></label>
        <textarea v-model="nicheDraftExampleTopicsText" class="input" rows="6" :disabled="nicheCreateBusy" placeholder="Diamond&#10;Ruby&#10;Sapphire&#10;…" />
      </div>
      <div class="form-group mt-2">
        <label><strong>script context</strong> <span class="text-muted text-xs">one-line context injected into the narration system prompt</span></label>
        <textarea v-model="nicheDraft.scriptContext" class="input" rows="2" :disabled="nicheCreateBusy" />
      </div>
      <div class="form-group mt-2">
        <label><strong>visual style sheet</strong> <span class="text-muted text-xs">long-form style instructions appended to every image prompt</span></label>
        <textarea v-model="nicheDraft.visualStyleSheet" class="input" rows="3" :disabled="nicheCreateBusy" />
      </div>
      <div v-if="nicheCreateError" class="error-box mt-2">{{ nicheCreateError }}</div>
      <div class="flex gap-2 mt-3" style="justify-content: flex-end">
        <button class="btn btn-secondary" :disabled="nicheCreateBusy" @click="closeNicheCreator">Cancel</button>
        <button class="btn btn-primary" :disabled="nicheCreateBusy || !nicheCanCreate" @click="submitNicheCreate">
          {{ nicheCreateBusy ? 'Creating…' : 'Create niche' }}
        </button>
      </div>
    </Modal>

    <!-- Folders -->
    <details v-if="activeTab === 'files'" class="card settings-panel settings-disclosure mt-2">
      <summary><span><strong>Episode folder names</strong><small>Templates used when Story Studio creates and syncs folders</small></span></summary>
      <h3>Folder Structure</h3>
      <p class="text-muted mt-1 mb-2">
        Customize how episode subfolders are named. Each template must include <code>{{ '{code}' }}</code> which is replaced with the episode code (e.g. TN0024).
      </p>
      <p v-if="folderConfigLoading" class="text-muted mt-2">Loading folder settings…</p>
      <p v-else-if="folderConfigError" class="text-error mt-2">{{ folderConfigError }}</p>

      <div v-if="folderConfig.length" class="folder-config-list">
        <div class="folder-config-header">
          <span class="col-order">#</span>
          <span class="col-label">Folder</span>
          <span class="col-template">Template</span>
          <span class="col-generator">Generator</span>
        </div>
        <div v-for="entry in folderConfig" :key="entry.key" class="folder-config-row">
          <span class="col-order text-muted">{{ entry.order.toString().padStart(2, '0') }}</span>
          <span class="col-label">{{ entry.label }}</span>
          <input v-model="entry.template" class="input input-sm col-template" />
          <span class="col-generator text-muted" style="font-size:12px">{{ entry.generator }}</span>
        </div>
      </div>

      <div class="flex gap-2 mt-3" style="align-items: center;">
        <button class="btn btn-primary" :disabled="folderConfigLoading || !!folderConfigError" @click="saveFolderConfig">Save Folder Config</button>
        <button class="btn btn-secondary" :disabled="folderConfigLoading || !!folderConfigError" @click="resetFolderDefaults">Reset to Defaults</button>
        <SaveIndicator v-bind="savedHintProps('folder_config')" />
      </div>

      <p class="text-muted mt-2" style="font-size:12px">
        💡 After saving, use <strong>Sync Folders</strong> in Files &amp; Behavior to rename existing episode folders to match the new names.
      </p>
    </details>

    <!-- (The Assets audit/repair UI once lived in this Settings tab, then in a
         standalone /assets page. v1.0.481 retired both: the audit matrix is
         redundant with the Production Board, and Repair moved into the board's
         ↻ Repair… dialog — see frontend/components/RepairAssetsDialog.vue.) -->

    <!-- "Smaller files": this Mac's default (Files & maintenance) and this project's override
         (Project files & behavior). Which assets are requested already compressed (AAC / JPEG). -->
    <div v-if="activeTab === 'maintenance'" class="card settings-panel mt-2">
      <GenerationCompressionPanel />
    </div>
    <div v-if="activeTab === 'files'" class="card settings-panel mt-2">
      <GenerationCompressionPanel :slug="slug" />
    </div>

    <!-- Storage — per-episode disk usage + cleanup of uploaded final
         videos + external-root configuration. A final is cleared only
         after its exact local bytes and current YouTube state are verified. -->
    <details v-if="activeTab === 'maintenance' || activeTab === 'files'" :open="activeTab === 'maintenance'" class="card settings-panel settings-disclosure storage-panel mt-2">
      <summary v-if="activeTab === 'files'"><span><strong>Storage &amp; cleanup</strong><small>Episode usage, recovery data, and optional media split</small></span></summary>
      <header class="settings-section-head">
        <div>
          <h3>{{ activeTab === 'maintenance' ? 'Library & exports' : 'Project storage' }}</h3>
          <p v-if="activeTab === 'maintenance'">Free up space from uploaded episodes, choose the shared Library, and see where exports land.</p>
          <p v-else>Keep this project portable, inspect episode usage, and manage recovery data.</p>
        </div>
        <span v-if="activeTab === 'files'" class="settings-section-count">{{ storage ? formatBytes(storage.project_bytes_total) : 'Not scanned' }}</span>
      </header>

      <!-- Free up space comes first on this tab: it is the most-wanted action here, and
           it needs no folder choice (files go to the project's own _trash). -->
      <MediaCleanupPanel v-if="activeTab === 'maintenance'" :slug="slug" />

      <!-- ── Cloud Sync Overview (top-of-tab indicator) ────────────────
           Surfaces all three storage subsystems with their current state
           and a 1-line description so users can scan it and know what's
           available + which warnings apply. Replaces the legacy
           "Cloud sync is paused" dashboard banner: that banner pointed
           at a feature that no longer exists; this card points at the
           feature that DID replace it. -->
      <div v-if="activeTab === 'maintenance'" class="cloud-sync-overview storage-map">
        <div class="overview-head">
          <span class="overview-icon" aria-hidden="true">◫</span>
          <div>
            <strong>Your storage map</strong>
            <p class="overview-sub">
              Two active destinations handle normal work. Advanced split-media
              storage stays out of the way unless you explicitly enable it.
            </p>
          </div>
        </div>

        <div class="overview-grid">
          <a class="overview-card" href="#projects-root-section" @click.prevent="scrollTo('projects-root-section')">
            <div class="overview-card-head">
              <span class="overview-card-icon">📁</span>
              <strong>Your Library</strong>
              <span :class="['overview-badge', library && !library.exists ? 'on' : 'off']">
                {{ library && !library.exists ? 'NOT FOUND' : 'IN USE' }}
              </span>
            </div>
            <p class="overview-card-desc">
              Every channel, your shared assets and your finished videos live in one folder.
            </p>
            <code class="overview-card-path">{{ library?.path || '(loading)' }}</code>
          </a>

          <a class="overview-card" href="#external-video-section" @click.prevent="scrollTo('external-video-section')">
            <div class="overview-card-head">
              <span class="overview-card-icon">🎞</span>
              <strong>Final videos</strong>
              <span :class="['overview-badge', externalRootInput ? 'on' : 'off']">
                {{ externalRootInput ? 'CUSTOM' : 'INSIDE PROJECT' }}
              </span>
            </div>
            <p class="overview-card-desc">
              {{ externalRootInput
                ? 'New ffmpeg renders land at the external path — keeps multi-GB videos out of cloud sync.'
                : 'New ffmpeg renders land inside each project (under the Video Assembly Output folder). Set an external path to avoid syncing 5–10 GB videos.' }}
            </p>
            <code v-if="externalRootInput" class="overview-card-path">{{ externalRootInput }}</code>
          </a>

          <a class="overview-card" href="#per-episode-section" @click.prevent="openSpaceRecovery">
            <div class="overview-card-head">
              <span class="overview-card-icon">🧹</span>
              <strong>Space recovery</strong>
              <span class="overview-badge info">
                {{ storage ? `${storage.episodes.filter(e => e.cleanup_eligible && (e.bytes_final_video > 0 || e.bytes_external_final_video > 0)).length} eligible` : 'unscanned' }}
              </span>
            </div>
            <p class="overview-card-desc">
              Verify eligible local exports before clearing them. Original audio,
              images, motion clips, and project files remain untouched.
            </p>
          </a>

          <a class="overview-card overview-card--advanced" href="#files" @click="activeTab = 'files'">
            <div class="overview-card-head">
              <span class="overview-card-icon">⌁</span>
              <strong>Project storage</strong>
              <span :class="['overview-badge', mediaRootSavedValue ? 'on' : 'off']">
                {{ mediaRootSavedValue ? 'SPLIT ACTIVE' : 'PROJECT' }}
              </span>
            </div>
            <p class="overview-card-desc">
              Episode usage, cleanup, recovery sidecars, and the optional heavy-media split live with this project's file settings.
            </p>
            <span class="overview-card-path">Open Files &amp; Behavior →</span>
          </a>
        </div>

        <details class="overview-warnings">
          <summary>Cross-machine and cloud-folder notes</summary>
          <ul>
            <li>
              <strong>API keys are per-machine.</strong> Each Mac encrypts its
              own keys with a machine-derived key — they don't decrypt across
              devices. You'll re-enter keys (Settings → This Mac) on every Mac.
            </li>
            <li>
              <strong>One Mac at a time.</strong> Don't have two Macs actively
              editing the same project — the cloud is last-write-wins per file
              and will silently overwrite the loser.
            </li>
            <li>
              <strong>Job queue + session analytics may diverge.</strong>
              <code>jobs.json</code> + <code>sessions.json</code> live inside
              the project folder; cross-syncing them can confuse mid-flight
              state. Avoid running generations on two Macs targeting the
              same project at once.
            </li>
            <li>
              <strong>5–10 GB final videos.</strong> Long-form video
              projects produce huge final-video files. If you're on iCloud
              Drive with limited space, set the external final-video root
              above and/or use the cleanup button below.
            </li>
          </ul>
        </details>
      </div>

      <!-- ── Projects storage location ──────────────────────────── -->
      <!-- v1.4.3 — one Library. This replaced the projects-root override, the
           per-Mac register of outside folders, the named-roots map and the
           free-floating export root. Changing it copies every channel across,
           which is why it is a deliberate action and not an inline edit. -->
      <div v-if="activeTab === 'maintenance'" id="projects-root-section" class="storage-section storage-surface">
        <h4><span class="storage-section-icon" aria-hidden="true">📁</span>Your Library</h4>
        <p class="text-muted hint">
          Everything Story Studio makes lives here: one folder per channel, a
          <code>_Project Assets</code> folder for files you share between channels, and an
          <code>Exports</code> folder for finished videos. Copy a channel folder in and it appears
          in the list; take it out and it is gone.
        </p>
        <div class="projects-root-row">
          <div class="projects-root-info">
            <div class="projects-root-current">
              <strong>{{ library?.path || 'Loading…' }}</strong>
              <span v-if="library && !library.exists" class="root-badge custom">NOT FOUND</span>
            </div>
            <div v-if="library && !library.exists" class="projects-root-default-note">
              Story Studio looked here and the folder is not there. If it is on a drive that is
              not plugged in, reconnect it — nothing has been lost.
            </div>
          </div>
        </div>
        <div class="projects-root-actions">
          <button
            class="btn btn-secondary"
            :disabled="projectsRootBusy"
            @click="browseAndMoveLibrary"
          >📂 Move my Library somewhere else</button>
        </div>
        <div v-if="projectsRootStatus" :class="['projects-root-status', projectsRootStatusKind]">
          {{ projectsRootStatus }}
        </div>
        <div v-if="projectsRootPickerHelp" class="manual-path-hint">
          {{ projectsRootPickerHelp }}
        </div>
      </div>

      <!-- ── External final-video root (per-machine) ─────────────── -->
      <!-- v1.4.4 — Archive uploaded videos. Library-wide, unlike everything
           else on this tab: he wants one button that clears finished films out
           of the way across every channel at once. -->
      <details v-if="activeTab === 'maintenance'" id="archive-section" class="storage-section storage-surface" :open="archiveBusy || !!archiveResult">
        <summary><h4 class="archive-summary"><span class="storage-section-icon" aria-hidden="true">📦</span>Advanced: move uploaded videos to another drive</h4></summary>
        <p class="text-muted hint">
          Moves finished videos that are <strong>confirmed uploaded to YouTube</strong> into a folder
          you choose, so what is left is a folder of finished films you can back up, park on a slow
          drive, or delete. The reviewed list contains only videos whose exact export can be proven
          uploaded; anything else, and all source media, stays exactly where it is. Move to another
          disk to recover capacity — moving within the same disk only reorganizes files.
        </p>

        <div class="form-group mt-2">
          <label>Look for videos in</label>
          <div class="flex gap-2 items-center">
            <input v-model="archiveSource" class="input" spellcheck="false"
                   placeholder="Defaults to your Library’s Exports folder" />
            <button class="btn btn-sm btn-secondary" aria-label="Browse archive source folder" :disabled="archiveBusy || archivePicking" @click="pickArchiveSource">📂</button>
          </div>
          <p class="text-muted text-sm mt-1">
            Leave blank for your Library’s <code>Exports</code> folder. Point it anywhere if your
            finished videos are somewhere else.
          </p>
        </div>

        <div class="form-group">
          <label>Move them to</label>
          <div class="flex gap-2 items-center">
            <input v-model="archiveDest" class="input" spellcheck="false" placeholder="Choose a folder…" />
            <button class="btn btn-sm btn-secondary" aria-label="Browse archive destination folder" :disabled="archiveBusy || archivePicking" @click="pickArchiveDest">📂</button>
          </div>
        </div>

        <div class="flex gap-2 items-center mt-2">
          <button class="btn btn-secondary" :disabled="archiveBusy || archivePicking" @click="loadArchivePreview">
            {{ archivePicking ? 'Opening folder picker…' : archiveChecking ? 'Checking…' : 'Check what would move' }}
          </button>
          <button v-if="archivePreview?.complete && archivePreview?.ready_count" class="btn btn-primary"
                  :disabled="archiveBusy || !archiveDest.trim()" @click="startArchive">
            Move {{ archivePreview.ready_count }} video(s) · {{ formatBytes(archivePreview.ready_bytes) }}
          </button>
          <button v-if="archiveRunning || archiveChecking" class="btn btn-danger" @click="stopArchive">Stop</button>
        </div>

        <!-- The bill, before it runs. -->
        <div v-if="archivePreview" class="mt-2">
          <p v-if="!archivePreview.source_exists" class="validation-msg text-sm">
            Nothing to scan — <code>{{ archivePreview.source_root }}</code> is not there.
          </p>
          <template v-else>
            <p v-if="!archivePreview.complete" class="validation-msg text-sm">
              Check stopped early. Nothing can move until the folder has been checked completely.
            </p>
            <p class="text-sm">
              <strong>{{ archivePreview.ready_count }}</strong> video(s) ready
              ({{ formatBytes(archivePreview.ready_bytes) }} ready to move),
              <strong>{{ archivePreview.skipped_count }}</strong> skipped
              ({{ formatBytes(archivePreview.skipped_bytes) }} staying put).
            </p>
            <ul v-if="archivePreview.by_channel.length" class="archive-channels">
              <li v-for="c in archivePreview.by_channel" :key="c.slug">
                {{ c.slug }} — {{ c.count }} video(s), {{ formatBytes(c.bytes) }}
              </li>
            </ul>
            <details v-if="archivePreview.ready_count" class="mt-1">
              <summary class="text-sm">Review {{ archivePreview.ready_count }} uploaded videos to move</summary>
              <ul class="archive-skipped">
                <li v-for="c in archiveReadyRows" :key="c.source_path">
                  <strong>{{ c.slug }} · {{ c.code }}</strong> — <code>{{ c.filename }}</code>
                  · {{ formatBytes(c.bytes) }}
                  <a v-if="c.youtube_video_id" :href="`https://www.youtube.com/watch?v=${encodeURIComponent(c.youtube_video_id)}`"
                     target="_blank" rel="noopener noreferrer">Open recorded YouTube upload</a>
                </li>
              </ul>
            </details>
            <details v-if="archivePreview.skipped_count" class="mt-1">
              <summary class="text-muted text-sm">Why {{ archivePreview.skipped_count }} were skipped</summary>
              <ul class="archive-skipped">
                <li v-for="c in archiveSkippedRows" :key="c.source_path">
                  <code>{{ c.filename }}</code> — {{ c.reason }}
                </li>
              </ul>
            </details>
          </template>
        </div>

        <div v-if="archiveChecking || archiveRunning || archiveResult" class="mt-2">
          <p v-if="archiveChecking" class="text-sm">
            Checking {{ archiveProgress.checked }} video file{{ archiveProgress.checked === 1 ? '' : 's' }} —
            <code>{{ archiveProgress.current }}</code>
            <span v-if="archiveStopping"> · stopping after this file…</span>
          </p>
          <p v-else-if="archiveRunning" class="text-sm">
            {{ archiveStage === 'checking' ? 'Rechecking proof' : 'Moving' }} {{ archiveProgress.done }} / {{ archiveProgress.total }} —
            <code>{{ archiveProgress.current }}</code>
            <span v-if="archiveStopping"> · stopping after this file…</span>
          </p>
          <p v-if="archiveResult" class="text-sm">
            ✓ Moved {{ archiveResult.moved.length }} video(s), {{ formatBytes(archiveResult.bytes_moved) }} total.
            <span v-if="archiveResult.cancelled">Stopped early — everything not yet moved is untouched.</span>
            <span v-if="archiveResult.failed.length">
              {{ archiveResult.failed.length }} could not be verified and were left in both places.
            </span>
          </p>
          <ul v-if="archiveResult?.warnings?.length" class="archive-skipped">
            <li v-for="w in archiveResult.warnings" :key="w">{{ w }}</li>
          </ul>
        </div>
      </details>

      <!-- v1.4.5 — read-only. This panel used to Save and Clear a per-machine
           export root, but v1.4.3 made that folder derived (`<Library>/Exports`)
           and removed the setter route — so its buttons had been posting to a
           404 ever since. It states where finished videos go, and the Archive
           panel above is how you move them somewhere else. -->
      <div v-if="activeTab === 'maintenance'" id="external-video-section" class="storage-section storage-surface">
        <h4>
          <span class="storage-section-icon" aria-hidden="true">🎬</span>
          Where finished videos go
        </h4>
        <p class="text-muted hint">
          New renders are saved into the <code>Exports</code> folder inside your Library. This is not
          a setting — move your Library in the section above to change it, or use
          <strong>Move uploaded videos to another drive</strong> to move finished films somewhere else entirely.
        </p>
        <div class="external-root-row">
          <code class="path-display">{{ externalRootSavedValue || '(loading)' }}</code>
        </div>
        <p v-if="externalRootStatus" :class="['external-root-status', externalRootReachable ? 'ok' : 'warn']">
          {{ externalRootStatus }}
        </p>
      </div>

      <!-- ── External media root (Level B, per-project, opt-in) ──── -->
      <div v-if="activeTab === 'files'" class="storage-advanced-heading">
        <span>Optional storage split</span>
        <p>Leave this off when you want the project and all of its assets to stay together.</p>
      </div>
      <details v-if="activeTab === 'files'" id="media-root-section" class="storage-disclosure" :open="!!mediaRootSavedValue">
        <summary class="storage-disclosure-summary">
          <span class="storage-section-icon" aria-hidden="true">⌁</span>
          <span><strong>Heavy media split</strong><small>Keep off to store every project and its assets together.</small></span>
          <span :class="['overview-badge', mediaRootSavedValue ? 'on' : 'off']">{{ mediaRootSavedValue ? 'ACTIVE' : 'OFF' }}</span>
        </summary>
        <div class="storage-disclosure-body">
        <p class="text-muted hint">
          Route this project's <strong>heavy media</strong> — scene images,
          thumbnails, audio, merged audio, final video — to a separate root
          (typically an external SSD), keeping the light artifacts (scripts,
          metadata, prompts, subtitles) in the project / iCloud tree. Use a
          portable token like <code>${ASSET}</code> so the same project works on any Mac —
          it always means the <code>_Project Assets</code> folder inside your Library.
          Leave blank to keep everything under the project's output folder (the default).
        </p>
        <div class="external-root-row">
          <input
            v-model="mediaRootInput"
            class="input"
            placeholder="(not set — media stays in the project tree)   e.g. ${ASSET}/Media"
            spellcheck="false"
          />
          <button
            class="btn btn-secondary btn-sm"
            :disabled="!mediaRootInput.trim() || mediaRootChecking"
            title="Check that this token/path resolves on this machine"
            @click="checkMediaRoot"
          >
            {{ mediaRootChecking ? 'Checking…' : '🔍 Check' }}
          </button>
          <button
            v-if="mediaRootInput.trim() !== mediaRootSavedValue"
            class="btn btn-primary btn-sm"
            :disabled="mediaRootSaving"
            @click="saveMediaRoot"
          >
            {{ mediaRootSaving ? 'Saving…' : '💾 Save' }}
          </button>
          <button v-if="mediaRootInput" class="btn btn-ghost btn-sm" :disabled="mediaRootSaving" @click="clearMediaRoot">
            Clear
          </button>
        </div>
        <p v-if="mediaRootStatus" :class="['external-root-status', mediaRootOk ? 'ok' : 'warn']">
          {{ mediaRootStatus }}
        </p>
        <p class="text-muted" style="font-size: var(--font-xs); margin-top: 4px;">
          ⚠ Advanced &amp; experimental. New media is written here going forward. To move your
          <strong>existing</strong> episodes' media onto this root, use the button below.
          Keep the drive connected during generation / rendering / migration.
        </p>
        <div class="external-root-row" style="margin-top: 8px;">
          <button
            class="btn btn-secondary btn-sm"
            :disabled="!mediaRootSavedValue || mediaMigrateRunning || mediaRootInput.trim() !== mediaRootSavedValue"
            :title="!mediaRootSavedValue ? 'Save a media root first' : (mediaRootInput.trim() !== mediaRootSavedValue ? 'Save your change first' : 'Preview, then move existing media to the media root')"
            @click="migrateMediaToRoot"
          >
            {{ mediaMigrateRunning ? 'Migrating…' : 'Migrate existing media here →' }}
          </button>
        </div>
        <div v-if="lastMediaMigration" class="storage-result">
          <strong>Media migration:</strong>
          {{ lastMediaMigration.files_moved }} file(s) moved
          ({{ formatBytes(lastMediaMigration.bytes_moved) }} off the project tree)
          across {{ lastMediaMigration.folders.length }} folder(s).
          <span v-if="lastMediaMigration.scene_plan_rewrites">
            {{ lastMediaMigration.scene_plan_rewrites }} scene-plan path(s) updated.
          </span>
          <span v-if="lastMediaMigration.errors.length" class="error-text">
            {{ lastMediaMigration.errors.length }} error(s): {{ lastMediaMigration.errors[0]?.reason }}
          </span>
        </div>
        </div>
      </details>

      <!-- ── Per-episode storage breakdown ───────────────────────── -->
      <div v-if="activeTab === 'files'" id="per-episode-section" class="storage-section storage-surface">
        <div class="flex items-center" style="justify-content: space-between; gap: 12px;">
          <div>
            <h4><span class="storage-section-icon" aria-hidden="true">📊</span>Per-episode breakdown</h4>
            <p class="text-muted hint">
              Sorted largest first. Eligible finals can be verified before their
              local <code>{code}_final_video.*</code> files are cleared.
            </p>
            <p class="text-muted voice-helper-line">
              💡 Before any final is cleared, Story Studio verifies its SHA-256
              against the accepted upload and refreshes the current processed
              video on the assigned YouTube channel. Unverified or legacy
              receipts remain local. Audio + image assets are never touched.
            </p>
          </div>
          <div class="flex gap-2">
            <button class="btn btn-secondary btn-sm" :disabled="auditLoading" @click="loadStorageAudit">
              {{ auditLoading ? 'Scanning…' : (storage ? '↻ Rescan' : 'Run scan') }}
            </button>
            <button
              class="btn btn-primary btn-sm"
              :disabled="!storage || bulkRunning || uploadedFinalsTotalBytes === 0"
              :title="uploadedFinalsTotalBytes === 0 ? 'No verification candidates have local final videos' : `Verify and clear ${uploadedFinalsCount} local final video(s) — up to ${formatBytes(uploadedFinalsTotalBytes)}`"
              @click="runBulkCleanup"
            >
              {{ bulkRunning
                ? 'Verifying…'
                : `Verify & clear candidates (${formatBytes(uploadedFinalsTotalBytes)})` }}
            </button>
          </div>
        </div>

        <div v-if="storage" class="storage-summary mt-2">
          <span><strong>Project total:</strong> {{ formatBytes(storage.project_bytes_total) }}</span>
          <span class="dot">·</span>
          <span><strong>Final videos:</strong> {{ formatBytes(storage.project_bytes_final_video) }}</span>
          <span class="dot">·</span>
          <span><strong>Per-scene clips:</strong> {{ formatBytes(storage.project_bytes_per_scene_clips) }}</span>
          <span v-if="storage.project_bytes_thumbnail_cache" class="dot">·</span>
          <span v-if="storage.project_bytes_thumbnail_cache" title="Small previews for the review grids. Safe to delete: they are rebuilt on demand.">
            <strong>Preview cache:</strong> {{ formatBytes(storage.project_bytes_thumbnail_cache) }}
          </span>
          <button
            v-if="storage.project_bytes_thumbnail_cache"
            class="btn btn-secondary btn-sm"
            :disabled="previewCacheClearing"
            title="Moves the small review-grid previews to this project's _trash folder. They rebuild automatically as you open Scene Review and Motion Review."
            @click="clearPreviewCache"
          >
            {{ previewCacheClearing ? 'Clearing…' : `Clear preview cache (${formatBytes(storage.project_bytes_thumbnail_cache)})` }}
          </button>
          <span v-if="storage.external_root_configured" class="dot">·</span>
          <span v-if="storage.external_root_configured">
            <strong>At external root:</strong> {{ formatBytes(storage.project_bytes_external_final_video) }}
          </span>
        </div>

        <div v-if="lastPreviewCacheClear" class="storage-result mt-2">
          Preview cache ({{ formatBytes(lastPreviewCacheClear.bytes) }}) moved to this project's <code>_trash</code> folder.
          It rebuilds automatically as you use the review pages.
        </div>

        <div v-if="storage" class="storage-table mt-2">
          <div class="storage-row storage-head">
            <span class="col-code">Code</span>
            <span class="col-title">Title</span>
            <span class="col-final">Final</span>
            <span class="col-clips">Clips</span>
            <span class="col-other">Audio + img + other</span>
            <span class="col-status">Upload</span>
            <span class="col-actions"></span>
          </div>
          <div
            v-for="row in sortedStorageRows"
            :key="row.episode_code"
            :class="['storage-row', { uploaded: row.uploaded_to_youtube, 'no-final': row.bytes_final_video === 0 }]"
          >
            <span class="col-code"><strong>{{ row.episode_code }}</strong></span>
            <span class="col-title" :title="row.title">{{ row.title }}</span>
            <span class="col-final">
              {{ formatBytes(row.bytes_final_video) }}
              <span v-if="row.bytes_external_final_video > 0" class="ext-badge" title="Final video also at the external root">
                + {{ formatBytes(row.bytes_external_final_video) }} ext
              </span>
            </span>
            <span class="col-clips">{{ formatBytes(row.bytes_per_scene_clips) }}</span>
            <span class="col-other">{{ formatBytes(row.bytes_audio + row.bytes_images + row.bytes_other) }}</span>
            <span class="col-status">
              <span v-if="row.cleanup_eligible" class="upload-badge ok" :title="`Candidate for fresh verification against YouTube video ${row.youtube_video_id}`">
                ✓ verify candidate
              </span>
              <span
                v-else-if="row.uploaded_to_youtube"
                class="upload-badge warn"
                :title="`${row.cleanup_reason || 'This receipt cannot authorize cleanup'} — video ${row.youtube_video_id}`"
              >
                ⚠ remains local
              </span>
              <span v-else class="upload-badge none">—</span>
            </span>
            <span class="col-actions">
              <button
                v-if="row.cleanup_eligible && (row.bytes_final_video > 0 || row.bytes_external_final_video > 0)"
                class="btn btn-ghost btn-sm"
                :disabled="rowCleanupRunning === row.episode_code"
                :title="`Verify this local final against its current YouTube upload, then clear it (up to ${formatBytes(row.bytes_final_video + row.bytes_external_final_video)})`"
                @click="cleanupRow(row)"
              >
                {{ rowCleanupRunning === row.episode_code ? 'Verifying…' : 'Verify & clear local video' }}
              </button>
            </span>
          </div>
        </div>
        <div v-else-if="!auditLoading" class="text-muted hint mt-2">
          Click "Run scan" to compute per-episode disk usage.
        </div>
      </div>

      <div v-if="activeTab === 'files' && lastBulkCleanup" class="storage-result mt-2">
        <strong>Cleanup:</strong>
        {{ lastBulkCleanup.deleted_count }} file(s) moved to _trash after verification ({{ formatBytes(lastBulkCleanup.bytes_freed) }}); the space is freed when you empty _trash.
        <span v-if="lastBulkCleanup.skipped_count">{{ lastBulkCleanup.skipped_count }} kept locally (could not verify).</span>
        <span v-if="lastBulkCleanup.failed_count" class="error-text">{{ lastBulkCleanup.failed_count }} failed.</span>
        <ul v-if="lastBulkCleanup.items.length" class="cleanup-item-results">
          <li v-for="item in lastBulkCleanup.items" :key="`${item.episode_code}:${item.file}`">
            <strong>{{ item.episode_code }}:</strong>
            {{ item.status === 'deleted' ? 'moved to _trash after verification' : (item.reason || item.status) }}
          </li>
        </ul>
      </div>

      <div v-if="activeTab === 'files'" class="storage-advanced-heading">
        <span>Advanced maintenance</span>
        <p>Recovery checkpoints are current safety data. Clean them only after a script is fully assembled.</p>
      </div>

      <!-- ── Chunked-progress sidecars (v1.0.71+) ──────────────────── -->
      <!--
        Per-episode JSON sidecars that lib/chunked-narration.ts writes
        during long script generations to enable resume on cancel/crash.
        Once the unified narration is on disk with the expected chapter
        count, the sidecar has no further purpose — but we don't auto-
        delete (per user direction). This panel surfaces eligible
        sidecars and lets the user clean them up manually.
      -->
      <details v-if="activeTab === 'files'" id="chunked-sidecars-section" class="storage-disclosure">
        <summary class="storage-disclosure-summary">
          <span class="storage-section-icon" aria-hidden="true">↻</span>
          <span><strong>Script recovery data</strong><small>Current resume checkpoints, not legacy assets.</small></span>
          <span class="overview-badge off">ADVANCED</span>
        </summary>
        <div class="storage-disclosure-body">
        <div class="flex items-center" style="justify-content: space-between; gap: 12px;">
          <div>
            <h4>Chunked-progress sidecars</h4>
            <p class="text-muted hint">
              Per-episode <code>{code}_chunked-progress.json</code> files
              written during long script generations. Track which chapters
              have landed so a cancelled / crashed run can resume from
              where it left off. Safe to delete once the episode's
              <code>{code}_Script_Narration.docx</code> is complete.
            </p>
            <p class="text-muted voice-helper-line">
              💡 Only sidecars whose chapters_done covers the total AND whose
              unified narration exists are listed as eligible. In-progress
              runs are never touched by this cleanup.
            </p>
          </div>
          <div class="flex gap-2">
            <button class="btn btn-secondary btn-sm" :disabled="sidecarScanLoading" @click="scanChunkedSidecars">
              {{ sidecarScanLoading ? 'Scanning…' : (sidecarScan ? '↻ Rescan' : 'Scan') }}
            </button>
            <button
              class="btn btn-primary btn-sm"
              :disabled="!sidecarScan || sidecarCleanupRunning || sidecarScan.eligible_count === 0"
              :title="!sidecarScan ? 'Run a scan first' : sidecarScan.eligible_count === 0 ? 'No eligible sidecars to clean up' : `Delete ${sidecarScan.eligible_count} sidecar(s) — frees ${formatBytes(sidecarScan.reclaimable_bytes)}`"
              @click="cleanupAllChunkedSidecars"
            >
              {{ sidecarCleanupRunning
                ? 'Cleaning…'
                : sidecarScan && sidecarScan.eligible_count > 0
                  ? `Clean up ${sidecarScan.eligible_count} eligible (${formatBytes(sidecarScan.reclaimable_bytes)})`
                  : 'Clean up eligible' }}
            </button>
          </div>
        </div>

        <div v-if="sidecarScan" class="storage-summary mt-2">
          <span><strong>Scanned:</strong> {{ sidecarScan.episodes.length }} episode{{ sidecarScan.episodes.length === 1 ? '' : 's' }}</span>
          <span class="dot">·</span>
          <span><strong>Eligible:</strong> {{ sidecarScan.eligible_count }}</span>
          <span class="dot">·</span>
          <span><strong>Reclaimable:</strong> {{ formatBytes(sidecarScan.reclaimable_bytes) }}</span>
        </div>

        <div v-if="sidecarScan && sidecarScan.episodes.some(e => e.sidecar_present)" class="storage-table mt-2">
          <div class="storage-row storage-head">
            <span class="col-code">Code</span>
            <span class="col-title">Status</span>
            <span class="col-final">Size</span>
            <span class="col-actions"></span>
          </div>
          <div
            v-for="row in sidecarScan.episodes.filter(e => e.sidecar_present)"
            :key="row.episode_code"
            :class="['storage-row', { uploaded: row.eligible }]"
          >
            <span class="col-code"><strong>{{ row.episode_code }}</strong></span>
            <span class="col-title" :title="row.reason || ''">
              <span v-if="row.eligible" class="upload-badge ok">✓ eligible</span>
              <span v-else class="text-muted">{{ row.reason || `${row.chapters_done || 0}/${row.total_chapters || 0} chapters` }}</span>
            </span>
            <span class="col-final">{{ formatBytes(row.sidecar_size_bytes || 0) }}</span>
            <span class="col-actions">
              <button
                class="btn btn-ghost btn-sm"
                :disabled="!row.eligible || sidecarCleanupRunning"
                :title="row.eligible ? `Delete this sidecar (frees ${formatBytes(row.sidecar_size_bytes || 0)})` : 'Not eligible'"
                @click="cleanupOneSidecar(row.episode_code)"
              >
                Clean up
              </button>
            </span>
          </div>
        </div>

        <div v-if="lastSidecarCleanup" class="storage-result mt-2">
          <strong>Cleanup:</strong>
          {{ lastSidecarCleanup.deleted.length }} sidecar(s) deleted, freed {{ formatBytes(lastSidecarCleanup.total_bytes_freed) }}.
          <span v-if="lastSidecarCleanup.skipped.length">{{ lastSidecarCleanup.skipped.length }} skipped.</span>
        </div>
        </div>
      </details>

    </details>

    <!-- Confirmations -->
    <details v-if="activeTab === 'files'" class="card settings-panel settings-disclosure mt-2">
      <summary><span><strong>Confirmation prompts</strong><small>Choose which generation and file actions ask first</small></span></summary>
      <h3>Generation Confirmations</h3>
      <p class="text-muted mt-1 mb-2">
        Choose which generators ask for confirmation before starting. Disabled generators skip the prompt and start immediately.
      </p>
      <div class="confirm-list">
        <label v-for="gen in confirmGenerationRows" :key="gen.key" class="confirm-row">
          <div class="confirm-info">
            <span class="confirm-label">{{ gen.label }}</span>
            <span class="confirm-desc text-muted">{{ gen.description }}</span>
          </div>
          <div class="toggle-switch" :class="{ active: confirmPrefs[gen.key] !== false }" @click="confirmPrefs[gen.key] = !(confirmPrefs[gen.key] !== false)">
            <div class="toggle-knob" />
          </div>
        </label>
      </div>

      <h3 class="mt-3">Action Confirmations</h3>
      <p class="text-muted mt-1 mb-2">
        Non-generation guardrails. Turn off to skip the dialog (the action fires immediately); turn on to restore the prompt after you dismissed it with "don't ask again".
      </p>
      <div class="confirm-list">
        <label v-for="gen in confirmActionRows" :key="gen.key" class="confirm-row">
          <div class="confirm-info">
            <span class="confirm-label">{{ gen.label }}</span>
            <span class="confirm-desc text-muted">{{ gen.description }}</span>
          </div>
          <div class="toggle-switch" :class="{ active: confirmPrefs[gen.key] !== false }" @click="confirmPrefs[gen.key] = !(confirmPrefs[gen.key] !== false)">
            <div class="toggle-knob" />
          </div>
        </label>
      </div>

      <div class="flex gap-2 mt-3" style="align-items: center;">
        <button class="btn btn-primary" @click="saveConfirmPrefs">Save Confirmation Preferences</button>
        <SaveIndicator v-bind="savedHintProps('confirm_prefs')" />
      </div>
    </details>

    <!-- FFmpeg -->
    <div v-if="activeTab === 'maintenance'" id="ffmpeg-section" class="card settings-panel mt-2">
      <h3>FFmpeg</h3>
      <p class="text-muted mt-1" style="font-size: 12px;">
        FFmpeg is the engine behind Audio Assembly and Video Assembly — it concatenates
        narration chapters, mixes music, and encodes the final MP4. The Story Studio DMG
        already includes the release-tested FFmpeg and FFprobe binaries. Re-check verifies
        that bundled copy; no separate download or Homebrew install is normally required.
      </p>

      <!-- Live status -->
      <div class="ffmpeg-status-row mt-2">
        <button class="btn btn-sm btn-secondary" @click="refreshFfmpegStatus" :disabled="ffmpegStatusLoading" :title="'Re-runs the FFmpeg / FFprobe detection — useful after a manual install.'">
          <span v-if="ffmpegStatusLoading">Checking…</span>
          <span v-else>Re-check status</span>
        </button>
        <template v-if="ffmpegStatus">
          <span v-if="ffmpegStatus.installed" class="badge badge-success">
            FFmpeg installed{{ ffmpegStatus.version ? ` (v${ffmpegStatus.version})` : '' }}
          </span>
          <span v-if="ffmpegStatus.installed && ffmpegStatus.source === 'bundled'" class="badge badge-success">Bundled with app</span>
          <span v-else-if="ffmpegStatus.installed && ffmpegStatus.source === 'app-data'" class="badge badge-warn">Recovery copy</span>
          <span v-else-if="ffmpegStatus.installed && ffmpegStatus.source === 'system'" class="badge">System copy</span>
          <span v-else class="badge badge-error">Not installed</span>
          <span v-if="ffmpegStatus.installed && ffmpegStatus.has_drawtext" class="badge badge-success">drawtext</span>
          <span v-if="ffmpegStatus.installed && !ffmpegStatus.has_drawtext" class="badge badge-warn">no drawtext</span>
          <span v-if="ffmpegStatus.installed && ffmpegStatus.has_libass" class="badge badge-success">libass</span>
          <span v-if="ffmpegStatus.installed && !ffmpegStatus.has_libass" class="badge badge-warn">no libass</span>
        </template>
      </div>
      <!-- F-04 (DS-11) — a failed check is its own state: not "not installed". -->
      <div v-if="ffmpegStatusError" class="ffmpeg-warning mt-1" role="alert">
        <p class="text-muted text-md">
          We couldn't determine FFmpeg's status: <code>{{ ffmpegStatusError }}</code>.
          This is different from "not installed" — the backend may be unreachable, or the
          binary isn't executable, or detection hit a permissions error.
        </p>
        <button type="button" class="btn btn-sm btn-secondary mt-1" @click="refreshFfmpegStatus">Retry check</button>
      </div>
      <p v-if="ffmpegStatus?.installed && ffmpegStatus.path" class="text-muted mt-1" style="font-size: var(--font-xs);">
        Resolved path: <code>{{ ffmpegStatus.path }}</code>
      </p>
      <p v-if="ffmpegStatus?.installed && (!ffmpegStatus.has_drawtext || !ffmpegStatus.has_libass)" class="text-muted mt-1" style="font-size: 12px;">
        Your FFmpeg works but is missing optional filters: <strong>drawtext</strong> (text overlays)
        and/or <strong>libass</strong> (subtitle burn-in). The downloaded build below includes both.
      </p>

      <div v-if="ffmpegStatus?.installed && ffmpegStatus.source === 'bundled'" class="ffmpeg-bundled-ready mt-2">
        <strong>Bundled and ready</strong>
        <span>
          This is the pinned build shipped and tested with Story Studio. It remains fixed
          until the app itself is updated, preventing an incompatible FFmpeg upgrade.
        </span>
      </div>

      <!-- Recovery installer only. A healthy release bundle must never invite
           an unnecessary replacement download, and an unknown status (not yet
           read, or a failed read) never justifies one either. -->
      <details
        v-else-if="ffmpegStatus"
        :open="!ffmpegStatus.installed || ffmpegInstalling"
        class="ffmpeg-install-block mt-2"
      >
        <summary
          v-if="ffmpegStatus?.installed && !ffmpegInstalling"
          class="ffmpeg-install-summary"
        >
          <span style="font-size: 13px;">Advanced: replace recovery FFmpeg</span>
          <span class="text-muted" style="font-size: var(--font-xs);">
            (only needed when the app bundle is unavailable)
          </span>
        </summary>
        <h4 v-else style="margin: 0 0 8px 0;">One-click install</h4>
        <p class="text-muted" style="font-size: 12px; margin: 8px 0;">
          Downloads the same pinned FFmpeg + FFprobe release used by this app, verifies its
          SHA-256 checksums, and installs it into the app's user-data folder as a recovery copy.
        </p>
        <button
          class="btn btn-primary"
          @click="installFfmpeg"
          :disabled="ffmpegInstalling"
        >
          <span v-if="ffmpegInstalling">{{ ffmpegInstallMessage || 'Installing…' }} {{ ffmpegInstallProgress }}%</span>
          <span v-else-if="ffmpegStatus?.installed">Replace recovery copy</span>
          <span v-else>Install recovery copy</span>
        </button>
        <div v-if="ffmpegInstallMessage && !ffmpegInstalling" class="mt-1" style="font-size: 12px;" :style="{ color: ffmpegInstallError ? 'var(--error)' : 'var(--text-muted)' }">
          {{ ffmpegInstallMessage }}
        </div>

        <!-- Restart prompt — appears after a successful install OR after
             a "Re-check status" flips the badges from red to green. The
             FFmpeg path is cached at module level on the backend; even
             though the cache is technically invalidated by the install
             flow, a full app restart guarantees every code path picks
             up the new binary (renderer-side caches, child processes
             already spawned, etc). One click does it. -->
        <div v-if="showFfmpegRestartPrompt" class="ffmpeg-restart-prompt mt-2">
          <span class="restart-msg">
            <strong>Install complete.</strong> Restart the app so Audio Assembly and Video Assembly pick up the new binary.
          </span>
          <div class="flex gap-2 mt-1">
            <button class="btn btn-sm btn-primary" @click="restartApp" :disabled="restarting" title="Quits and re-launches the app — about 2 seconds.">
              <span v-if="restarting">Restarting…</span>
              <span v-else>Restart now</span>
            </button>
            <button class="btn btn-sm btn-secondary" @click="showFfmpegRestartPrompt = false">Later</button>
          </div>
        </div>

        <!-- Diagnostic log block — appears on install failure so the user
             has a one-click way to copy the structured error trail back
             to support without hunting in Console.app or shell. The log
             entries come from `GET /ffmpeg/install-log` which filters
             today's server log down to ffmpeg-install:* messages from
             the last hour. -->
        <div v-if="ffmpegInstallError" class="ffmpeg-log-block mt-2">
          <div class="flex gap-2" style="align-items: center;">
            <button class="btn btn-sm btn-secondary" @click="loadInstallLog" :disabled="ffmpegLogLoading" title="Fetches the last hour of ffmpeg-install log entries">
              <span v-if="ffmpegLogLoading">Loading…</span>
              <span v-else-if="ffmpegInstallLog.length">Refresh log</span>
              <span v-else>Show install log</span>
            </button>
            <button v-if="ffmpegInstallLog.length" class="btn btn-sm btn-primary" @click="copyInstallLog" title="Copies the log entries + your platform info to the clipboard so you can paste it into a bug report">
              Copy log to clipboard
            </button>
            <span v-if="ffmpegLogCopiedAt" class="text-muted" style="font-size: var(--font-xs);">Copied ✓</span>
          </div>
          <pre v-if="ffmpegInstallLog.length" class="ffmpeg-log-output mt-1">{{ ffmpegInstallLogText }}</pre>
          <p v-else-if="ffmpegInstallLogChecked" class="text-muted mt-1" style="font-size: var(--font-xs);">
            No ffmpeg-install entries in the last hour. The error may have happened before logging was wired up — try clicking Install again.
          </p>
        </div>
      </details>
      <!-- The unknown branch of the installer chain: no repair action is
           offered until the status has actually been read. -->
      <p v-else class="text-muted mt-2" style="font-size: 13px;">
        Checking FFmpeg before offering any repair download…
      </p>

      <!-- Manual install fallback -->
      <details v-if="ffmpegStatus && ffmpegStatus.source !== 'bundled'" class="ffmpeg-manual mt-3">
        <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">
          Manual install (advanced)
        </summary>
        <div class="mt-2" style="font-size: 12px;">
          <p class="text-muted" style="margin-bottom: 8px;">
            If the one-click installer fails (e.g. firewall blocks the download), install FFmpeg
            yourself and the app will detect it on the next "Re-check status".
          </p>
          <p style="margin: 6px 0;"><strong>macOS (Homebrew):</strong></p>
          <pre class="ffmpeg-cmd"><code>brew install ffmpeg</code></pre>
          <p style="margin: 6px 0;"><strong>Ubuntu / Debian:</strong></p>
          <pre class="ffmpeg-cmd"><code>sudo apt install ffmpeg</code></pre>
          <p style="margin: 6px 0;"><strong>Windows:</strong></p>
          <p class="text-muted" style="margin-bottom: 4px;">
            Download a static build from
            <a href="https://www.gyan.dev/ffmpeg/builds/" target="_blank" rel="noopener" @click.prevent="openExternal('https://www.gyan.dev/ffmpeg/builds/')">gyan.dev/ffmpeg/builds</a>,
            extract <code>ffmpeg.exe</code> and <code>ffprobe.exe</code> to a folder, and add that folder to your PATH.
          </p>
        </div>
      </details>
    </div>

    <!-- Notifications -->
    <div v-if="activeTab === 'appearance'" class="card settings-panel notification-panel mt-2">
      <header class="settings-section-head">
        <div>
          <span class="settings-section-kicker">Attention routing</span>
          <h3>Notification center</h3>
          <p>Choose what deserves your attention, where it should reach you, and when the daily production brief arrives.</p>
        </div>
        <span class="settings-section-count">{{ notificationReadinessLabel }}</span>
      </header>

      <section class="notification-status-grid" aria-label="Notification channel status">
        <article :class="['notification-status-card', { active: notifSettings.enabled }]">
          <span class="notification-status-icon" aria-hidden="true">▣</span>
          <div><strong>Desktop</strong><small>{{ notifSettings.enabled ? 'Active on this Mac' : 'Muted' }}</small></div>
          <span :class="['notification-state', notifSettings.enabled ? 'ready' : 'off']">{{ notifSettings.enabled ? 'ON' : 'OFF' }}</span>
        </article>
        <article :class="['notification-status-card', { active: telegramReady }]">
          <span class="notification-status-icon" aria-hidden="true">↗</span>
          <div><strong>Telegram</strong><small>{{ telegramStatusText }}</small></div>
          <span :class="['notification-state', telegramReady ? 'ready' : notifSettings.telegram.enabled ? 'warn' : 'off']">{{ telegramReady ? 'READY' : notifSettings.telegram.enabled ? 'SETUP' : 'OFF' }}</span>
        </article>
        <article :class="['notification-status-card', { active: digestReady }]">
          <span class="notification-status-icon" aria-hidden="true">◷</span>
          <div><strong>Daily brief</strong><small>{{ digestStatusText }}</small></div>
          <span :class="['notification-state', digestReady ? 'ready' : notifSettings.digest.enabled ? 'warn' : 'off']">{{ digestReady ? 'SET' : notifSettings.digest.enabled ? 'CHECK' : 'OFF' }}</span>
        </article>
      </section>

      <div class="notification-layout">
        <section class="notification-section notification-section--events">
          <div class="notification-section-head">
            <div><span class="settings-section-kicker">What reaches you</span><h4>Alert events</h4></div>
            <span>{{ enabledNotificationEventCount }}/3 selected</span>
          </div>
          <div class="notification-event-grid">
            <label :class="['notification-event-card', { active: notifSettings.events.failures }]">
              <input v-model="notifSettings.events.failures" type="checkbox" />
              <span class="notification-event-mark" aria-hidden="true">!</span>
              <span><strong>Job needs attention</strong><small>Send immediately when any generation or assembly job fails.</small></span>
            </label>
            <label :class="['notification-event-card', { active: notifSettings.events.pipeline_finished }]">
              <input v-model="notifSettings.events.pipeline_finished" type="checkbox" />
              <span class="notification-event-mark" aria-hidden="true">✓</span>
              <span><strong>Pipeline run complete</strong><small>Send one result summary after every episode in the batch settles.</small></span>
            </label>
            <label :class="['notification-event-card', { active: notifSettings.events.long_job }]">
              <input v-model="notifSettings.events.long_job" type="checkbox" />
              <span class="notification-event-mark" aria-hidden="true">◷</span>
              <span><strong>Long job complete</strong><small>Notify for standalone jobs that ran longer than your threshold.</small></span>
            </label>
          </div>
        </section>

        <section class="notification-section notification-section--desktop">
          <div class="notification-channel-head">
            <span class="notification-channel-icon" aria-hidden="true">▣</span>
            <div><h4>Desktop alerts</h4><p>Native macOS or Windows alerts. Clicking one opens the matching project’s Jobs page.</p></div>
            <label class="notification-switch">
              <input v-model="notifSettings.enabled" type="checkbox" />
              <span aria-hidden="true" />
            </label>
          </div>
          <div :class="['notification-threshold', { disabled: !notifSettings.events.long_job }]">
            <div><strong>Long-job threshold</strong><small>Fast jobs stay quiet. Failures ignore this threshold and alert immediately.</small></div>
            <span class="notification-threshold-value">{{ notifMinDurationMinutes }} min</span>
            <SliderWithNumber v-model="notifMinDurationMinutes" :min="1" :max="60" :step="1" />
          </div>
        </section>

        <section class="notification-section notification-section--telegram">
          <div class="notification-channel-head">
            <span class="notification-channel-icon" aria-hidden="true">↗</span>
            <div><h4>Telegram</h4><p>Receive the same alerts on your phone when you are away from this Mac.</p></div>
            <label class="notification-switch">
              <input v-model="notifSettings.telegram.enabled" type="checkbox" />
              <span aria-hidden="true" />
            </label>
          </div>

          <details class="notification-setup" :open="notifSettings.telegram.enabled && !telegramReady">
            <summary>
              <span><strong>{{ telegramReady ? 'Connection settings' : 'Set up Telegram' }}</strong><small>{{ telegramReady ? 'Bot token and chat are configured.' : 'Three short steps. No JSON or command line needed.' }}</small></span>
              <span :class="['notification-state', telegramReady ? 'ready' : 'warn']">{{ telegramReady ? 'CONNECTED' : '3 STEPS' }}</span>
            </summary>
            <div class="notification-setup-body">
              <article class="notification-setup-step">
                <span>1</span>
                <div><strong>Create a Telegram bot</strong><p>Open BotFather, send <code>/newbot</code>, and follow its prompts. Copy the token it gives you.</p></div>
                <button type="button" class="btn btn-sm btn-secondary" @click="openExternal('https://t.me/BotFather')">Open BotFather ↗</button>
              </article>
              <article class="notification-setup-step">
                <span>2</span>
                <div class="notification-setup-fields">
                  <strong>Connect your bot</strong>
                  <p>Paste the token, then message your new bot with <code>/start</code>. Story Studio can detect that chat automatically.</p>
                  <label>Bot token</label>
                  <div class="notification-secret-row">
                    <input v-model="notifSettings.telegram.bot_token" :type="showTelegramToken ? 'text' : 'password'" class="input" placeholder="1234567890:ABCdef…" spellcheck="false" autocomplete="off" />
                    <button type="button" class="btn btn-sm btn-ghost" @click="showTelegramToken = !showTelegramToken">{{ showTelegramToken ? 'Hide' : 'Show' }}</button>
                  </div>
                  <div class="notification-connect-row">
                    <button type="button" class="btn btn-sm btn-secondary" :disabled="telegramDetectBusy || !notifSettings.telegram.bot_token" @click="detectTelegramChatId">
                      {{ telegramDetectBusy ? 'Looking for your chat…' : 'Detect my chat' }}
                    </button>
                    <input v-model="notifSettings.telegram.chat_id" type="text" class="input" placeholder="Chat ID (detected or pasted)" spellcheck="false" autocomplete="off" />
                  </div>
                  <p v-if="telegramDetectResult" :class="['notification-inline-result', telegramDetectResult.ok && telegramDetectResult.chat_id ? 'ok' : 'error']">
                    {{ telegramDetectResult.ok && telegramDetectResult.chat_id
                      ? `Chat connected${telegramDetectResult.chat_label ? `: ${telegramDetectResult.chat_label}` : ''}.`
                      : telegramDetectResult.error || 'No recent chat found. Send /start to the bot, then try again.' }}
                  </p>
                </div>
              </article>
              <article class="notification-setup-step">
                <span>3</span>
                <div><strong>Verify delivery</strong><p>Send one test before relying on Telegram for unattended overnight work.</p></div>
                <div class="notification-test-action">
                  <button type="button" class="btn btn-sm btn-primary" :disabled="telegramTestBusy || !telegramReady" @click="testTelegram">
                    {{ telegramTestBusy ? 'Sending test…' : 'Send test message' }}
                  </button>
                  <small v-if="telegramTestResult" :class="telegramTestResult.ok ? 'ok' : 'error'">{{ telegramTestResult.ok ? 'Delivered. Check Telegram.' : telegramTestResult.error || 'Delivery failed.' }}</small>
                </div>
              </article>
            </div>
          </details>
        </section>

        <section class="notification-section notification-section--digest">
          <div class="notification-channel-head">
            <span class="notification-channel-icon" aria-hidden="true">◷</span>
            <div><h4>Daily production brief</h4><p>A once-daily view of publishing today, scheduled inventory, and episodes awaiting upload across every project.</p></div>
            <label class="notification-switch">
              <input v-model="notifSettings.digest.enabled" type="checkbox" />
              <span aria-hidden="true" />
            </label>
          </div>
          <div :class="['notification-digest-controls', { disabled: !notifSettings.digest.enabled }]">
            <label class="notification-time-control"><span>Send at</span><input v-model="notifSettings.digest.time_local" type="time" class="input" :disabled="!notifSettings.digest.enabled" /><small>Local time. The app must be running.</small></label>
            <div class="notification-route-control">
              <span>Deliver to</span>
              <label><input v-model="notifSettings.digest.desktop_enabled" type="checkbox" :disabled="!notifSettings.digest.enabled" /> Desktop</label>
              <label><input v-model="notifSettings.digest.telegram_enabled" type="checkbox" :disabled="!notifSettings.digest.enabled || !telegramReady" /> Telegram</label>
              <small v-if="notifSettings.digest.telegram_enabled && !telegramReady">Finish Telegram setup before using it for the brief.</small>
            </div>
            <label class="notification-quiet-control"><input v-model="notifSettings.digest.quiet_when_empty" type="checkbox" :disabled="!notifSettings.digest.enabled" /><span><strong>Skip quiet days</strong><small>Do not send when nothing is scheduled to publish today.</small></span></label>
            <div class="notification-last-fired"><span>Last scheduled delivery</span><strong>{{ formattedDigestLastFired }}</strong></div>
          </div>
          <div class="notification-digest-actions">
            <button type="button" class="btn btn-sm btn-secondary" :disabled="digestPreviewBusy" @click="loadDigestPreview">{{ digestPreviewBusy ? 'Building preview…' : 'Preview brief' }}</button>
            <button type="button" class="btn btn-sm btn-primary" :disabled="digestSendNowBusy || !digestHasReadyDestination" @click="sendDigestNow">{{ digestSendNowBusy ? 'Sending now…' : 'Send now' }}</button>
            <span v-if="digestSendResult" :class="['notification-inline-result', digestSendResult.ok ? 'ok' : 'error']">{{ digestSendResult.ok ? 'Brief sent.' : digestSendResult.reason || 'Send failed.' }}</span>
          </div>
          <div v-if="digestPreview" class="notification-preview">
            <span class="settings-section-kicker">Preview</span>
            <strong>{{ digestPreview.title }}</strong>
            <pre>{{ digestPreview.body }}</pre>
          </div>
        </section>
      </div>

      <div class="notification-save-bar">
        <div>
          <strong>{{ notificationsDirty ? 'Unsaved notification changes' : 'Notification settings are saved' }}</strong>
          <span>Applies to every project on this Mac.</span>
          <span v-if="notifSaveStatus === 'error'" class="error">{{ notifSaveError }}</span>
        </div>
        <button type="button" class="btn btn-sm btn-ghost" @click="applyRecommendedNotifications">Use recommended alerts</button>
        <button type="button" class="btn btn-sm btn-secondary" :disabled="!notificationsDirty || notifSaveStatus === 'saving'" @click="discardNotificationChanges">Revert</button>
        <SaveIndicator v-bind="savedHintProps('notifications')" />
        <button type="button" class="btn btn-primary" :disabled="!notificationsDirty || notifSaveStatus === 'saving'" @click="saveNotifSettings">{{ notifSaveStatus === 'saving' ? 'Saving…' : 'Save notifications' }}</button>
      </div>
    </div>

    <!-- v1.4.3 — the Named Roots tab is gone. It mapped labels like
         ${MY_FOLDER} to a folder on THIS Mac, which made a project
         non-portable in exactly the situation portability was for: carry it to
         another machine and the label meant nothing until someone re-declared
         it by hand. Shared files now live at <Library>/_Project Assets and are
         written as ${ASSET}/…, which needs no per-machine setup. -->

    <!-- Project settings are grouped by where the values are used. They still
         save through the existing project + config endpoints. -->
    <div v-if="['identity', 'publishing', 'writing', 'files'].includes(activeTab)" class="card settings-panel mt-2">
      <h3>{{ activeTab === 'identity' ? 'Project identity' : activeTab === 'publishing' ? 'Publishing defaults' : activeTab === 'writing' ? 'Visual style' : 'Project files & behavior' }}</h3>
      <div v-if="activeTab === 'identity'" class="form-group mt-2">
          <label>Project Name</label>
          <input v-model="projectForm.name" class="input" />
      </div>
      <div v-if="activeTab === 'files'" class="grid-2 mt-2">
        <div class="form-group">
          <label>Episode Prefix</label>
          <input v-model="projectForm.episode_prefix" class="input" />
        </div>
        <div class="form-group">
          <label>Group Label</label>
          <input v-model="projectForm.season_prefix" class="input" placeholder="Season" />
          <span class="text-muted" style="font-size: var(--font-xs)">Season, Batch, Volume, Collection, etc.</span>
        </div>
        <div class="form-group">
          <label>Episodes per Group</label>
          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <input v-model.number="projectForm.season_size" class="input" type="number" min="1" max="1000" style="max-width: 120px;" />
            <button
              v-if="seasonSizeChanged"
              type="button"
              class="btn btn-sm btn-secondary"
              :disabled="reseasonState.opening"
              :title="`Preview the folder rebalance from ${serverSeasonSize} → ${projectForm.season_size} episodes per group, then commit. Reversible from the Unlinked Uploads tab for 30 days.`"
              @click="openReseasonPreview"
            >
              <LoadingSpinner v-if="reseasonState.opening" size="sm" />
              {{ reseasonState.opening ? 'Loading…' : `↻ Rebalance ${projectForm.season_size}/group →` }}
            </button>
          </div>
          <span class="text-muted" style="font-size: var(--font-xs);">
            Changing this rebalances every episode folder into the new grouping.
            <strong>Use the Rebalance button</strong> — the regular Save below ignores this field
            because a silent value change would mismatch all the on-disk folders.
            Reversible from the Unlinked Uploads tab for 30 days after rebalance.
          </span>
        </div>
      </div>
      <div v-if="activeTab === 'publishing'" class="form-group">
        <label>YouTube Channel URL (for video recommendations)</label>
        <input v-model="projectForm.youtube_channel_url" class="input" placeholder="https://youtube.com/@yourchannel" />
      </div>

      <!-- Item J — YouTube videoCategories.list ID. Applied to every fresh
           upload + metadata-only PATCH for this project. Default 22
           ("People & Blogs") if unset. Dropdown is populated from the
           backend's 7-day cache of YouTube's category list; soft fallback
           lets the user type a number even if the cache is empty / API
           is down. -->
      <div v-if="activeTab === 'publishing'" class="form-group">
        <label>
          YouTube Category
          <span class="text-muted" style="font-weight:normal">(used for new uploads and updates to existing videos)</span>
        </label>
        <div class="flex gap-2 items-center" style="flex-wrap: wrap;">
          <select
            v-if="ytCategoryList.length"
            v-model.number="projectForm.category_id"
            class="input"
            style="flex: 1; min-width: 240px;"
          >
            <option :value="undefined">— Default (24 · Entertainment) —</option>
            <option v-for="c in ytCategoryList" :key="c.id" :value="Number(c.id)">
              {{ c.id }} · {{ c.title }}
            </option>
          </select>
          <input
            v-else
            v-model.number="projectForm.category_id"
            type="number"
            min="1"
            class="input"
            style="flex: 1; min-width: 240px;"
            :placeholder="'24 (default — Entertainment)'"
          />
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            :disabled="ytCategoryLoading"
            @click="loadYoutubeCategoryList"
          >
            {{ ytCategoryLoading ? '↻ Fetching…' : '↻ Refresh categories' }}
          </button>
        </div>
        <span class="text-muted" style="font-size: var(--font-xs);">
          <template v-if="ytCategoryHint">⚠ {{ ytCategoryHint }}</template>
          <template v-else-if="ytCategorySource">
            {{ ytCategorySource === 'live' ? 'Just fetched' : ytCategorySource === 'cache' ? 'From cache' : ytCategorySource === 'stale' ? 'Stale cache (fetch failed)' : 'Empty' }}
            · {{ ytCategoryList.length }} assignable categor{{ ytCategoryList.length === 1 ? 'y' : 'ies' }}
          </template>
          <template v-else>Click Refresh to load YouTube’s category list (cached 7 days).</template>
        </span>
      </div>

      <!-- v1.0.77 — AI / synthetic content disclosure toggle + backfill action -->
      <div v-if="activeTab === 'publishing'" class="form-group">
        <label>
          AI / Altered or Synthetic Content disclosure
          <span class="text-muted" style="font-weight:normal">(shown in YouTube’s altered-content disclosure)</span>
        </label>
        <div class="flex gap-2 items-center" style="flex-wrap: wrap;">
          <select
            v-model="aiDisclosureSelection"
            class="input"
            style="flex: 1; min-width: 240px;"
          >
            <option value="default">Use app default ({{ ytAppDefaults?.default_mark_as_ai_generated === false ? 'OFF' : 'ON' }})</option>
            <option value="on">ON — mark uploads as AI-generated</option>
            <option value="off">OFF — do not disclose</option>
          </select>
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            :disabled="!!ytBackfillBusy"
            @click="onYoutubeBackfillPreview"
            title="Show what would change without applying"
          >
            {{ ytBackfillBusy === 'preview' ? '↻ Checking…' : '↻ Preview backfill' }}
          </button>
          <button
            type="button"
            class="btn btn-sm btn-primary"
            :disabled="!!ytBackfillBusy"
            @click="onYoutubeBackfillApply"
            title="Apply current AI disclosure + category to every uploaded video on this project"
          >
            {{ ytBackfillBusy === 'apply' ? 'Applying…' : 'Apply to all uploaded videos' }}
          </button>
        </div>
        <span class="text-muted" style="font-size: var(--font-xs);">
          Required by YouTube when your video contains realistic AI-generated narration, images, or footage.
          Fresh uploads use this automatically. The backfill action applies the selected disclosure and category
          to existing uploads while preserving privacy and schedule. Live YouTube quota: 1 unit per 50 videos read + 50 units per video updated.
        </span>
        <div v-if="ytBackfillResult" class="card mt-2" style="font-size: 12px;">
          <div class="flex gap-3" style="flex-wrap: wrap;">
            <span><strong>Scanned:</strong> {{ ytBackfillResult.scanned }}</span>
            <span><strong>Eligible:</strong> {{ ytBackfillResult.eligible }}</span>
            <span class="text-success"><strong>Updated:</strong> {{ ytBackfillResult.updated }}</span>
            <span><strong>Skipped (already ok):</strong> {{ ytBackfillResult.skipped }}</span>
            <span v-if="ytBackfillResult.failed" class="text-danger"><strong>Failed:</strong> {{ ytBackfillResult.failed }}</span>
            <span v-if="ytBackfillResult.missing" class="text-muted"><strong>Missing on YouTube:</strong> {{ ytBackfillResult.missing }}</span>
            <span v-if="ytBackfillResult.dry_run" class="text-warning"><strong>(dry run — nothing applied)</strong></span>
          </div>
          <div v-if="ytBackfillResult.message" class="text-muted mt-1">{{ ytBackfillResult.message }}</div>
          <details v-if="ytBackfillResult.details?.length" class="mt-1">
            <summary style="cursor: pointer;">Per-video details ({{ ytBackfillResult.details.length }})</summary>
            <ul style="margin: 6px 0 0; padding-left: 18px;">
              <li v-for="d in ytBackfillResult.details" :key="d.video_id">
                <code>{{ d.episode_code }}</code> ·
                <span :class="{ 'text-success': d.action === 'updated', 'text-muted': d.action === 'skipped', 'text-danger': d.action === 'failed', 'text-warning': d.action === 'missing' }">
                  {{ d.action }}
                </span>
                <template v-if="d.changed">
                  · {{ Object.entries(d.changed).map(([k, v]) => `${k}=${v}`).join(', ') }}
                </template>
                <template v-if="d.error || d.reason">
                  · <span class="text-muted">{{ d.error || d.reason }}</span>
                </template>
              </li>
            </ul>
          </details>
        </div>
      </div>

      <div v-if="activeTab === 'writing'" class="form-group">
        <label>Art Style <span class="text-muted" style="font-weight:normal">(auto-applied to every image prompt for this project; the style's preview image also feeds img2img renders. Overridable per run on the Image Prompts page.)</span></label>
        <div class="art-style-picker">
          <select v-model="artStyleSelection" class="input" :disabled="artStyleSaving">
            <option value="">— None (use format / niche default) —</option>
            <optgroup v-if="savedStylePresets.length" label="Saved styles">
              <option v-for="s in savedStylePresets" :key="s.id" :value="s.id">{{ s.name }}</option>
            </optgroup>
            <optgroup label="Style library">
              <option v-for="s in visualStyles" :key="s.id" :value="s.id">{{ s.name }}</option>
            </optgroup>
          </select>
        </div>
        <p v-if="visualStylesLoading" class="text-muted text-sm mt-1">
          Loading installed Content Pack styles…
        </p>
        <p v-else-if="visualStylesError" class="text-warning text-sm mt-1">
          Installed Content Pack styles are unavailable. Existing saved style data is unchanged.
          <button type="button" class="btn btn-ghost btn-sm" @click="refreshVisualStyles">Retry</button>
        </p>
        <p v-else-if="!visualStyles.length" class="text-muted text-sm mt-1">
          No Content Pack styles are installed. Add one from the
          <NuxtLink to="/content-store">Content Store</NuxtLink>.
        </p>
        <p v-if="unresolvedArtStyleId" class="text-warning text-sm mt-1">
          This channel is saved against the art style <code>{{ humanizeCatalogId(unresolvedArtStyleId) }}</code>,
          but nothing installed provides it — images are being generated without it. Pick a style
          above, or install the pack that provides it from the
          <NuxtLink to="/content-store">Content Store</NuxtLink>.
        </p>
        <span v-if="artStyleSaveMessage" class="text-muted" style="font-size: var(--font-xs)">{{ artStyleSaveMessage }}</span>
      </div>

      <!-- Per-project cloud-sync mode toggle removed alongside the
           legacy manifest-sync feature. There's now only one mode —
           cloud sync is configured app-wide via Settings → Storage →
           Projects storage location (point at iCloud Drive / etc.).
           A `.story-studio-project.json` manifest is still written
           into every project folder as a project_id identity marker
           for cross-machine import. -->

      <div v-if="activeTab === 'files'" class="form-group">
        <label>Project Files Location</label>
        <div class="flex gap-2 items-center" style="flex-wrap:wrap">
          <code class="path-display">{{ projectLocation || '(no location set)' }}</code>
          <button class="btn btn-sm btn-secondary" :disabled="!projectLocation" @click="revealInFinder">
            📂 Open in Finder
          </button>
        </div>
        <!-- v1.4.3 — "Move this project to…" and "Unlink from this Mac" are
             gone. Both existed to manage projects living OUTSIDE the projects
             folder, tracked in a per-Mac register. The owner removed that idea:
             *"i want to just copy and paste a folder and then connect it. i
             don't want connection like in the past where i have to link and
             stuff."* A channel is a folder in the Library now, so moving one is
             a drag in Finder and there is nothing to unlink from. -->
        <p class="text-muted text-sm mt-1">
          This channel is a folder in your Library. To move it, quit Story Studio and drag the
          folder — anywhere inside the Library works, and it will be found again on the next launch.
        </p>
      </div>

      <div v-if="activeTab !== 'writing'" class="flex gap-2 mt-3" style="align-items:center">
        <button class="btn btn-primary" @click="saveProject()">
          {{ activeTab === 'identity' ? 'Save project name' : activeTab === 'publishing' ? 'Save publishing defaults' : 'Save file settings' }}
        </button>
        <SaveIndicator v-bind="savedHintProps(`project_${activeTab}`)" />
      </div>

      <div v-if="activeTab === 'files'" class="danger-zone mt-3">
        <h3>Hide / Remove Project</h3>
        <p class="text-muted mt-1">
          <strong>Non-destructive:</strong> the project is removed from this app's
          list but every file stays on disk. You'll see a confirmation dialog with
          the folder path so you can open it in Finder afterward and decide what
          to keep or delete by hand. The way back is the 🗑️ <em>Hidden channels</em>
          panel on the All Projects page — <strong>Restore</strong> puts this project back
          exactly as it was, without touching a single file. Use that rather than moving
          the folder: hiding records the project as hidden, so moving its folder out and
          back would not bring it back on its own.
        </p>
        <button class="btn btn-danger mt-2" @click="deleteProject">Hide project (keep files)</button>
      </div>
    </div>

    <details v-if="activeTab === 'writing'" class="card settings-panel settings-disclosure mt-2">
      <summary><span><strong>Browse or create custom styles</strong><small>Open the project style library and custom style editor</small></span></summary>
      <ProjectStyleLibrary
        :project-slug="slug"
        title="Project style library"
        :show-catalog-starters="true"
      />
    </details>

    <!-- Optional project instructions — retained for channel-specific facts
         and constraints, but Formula rules stay authoritative. -->
    <details v-if="activeTab === 'writing'" class="card settings-panel settings-disclosure mt-2">
      <summary><span><strong>Writing instructions</strong><small>Project guidance, intro rules, and reusable presets</small></span></summary>
      <div class="sub-tabs">
        <button v-for="st in standardsSubTabs" :key="st.id" :disabled="writingControlsDisabled" :class="['sub-tab', { active: standardsSubTab === st.id }]" @click="standardsSubTab = st.id">
          {{ st.label }}
        </button>
      </div>

      <div class="sub-tab-body">
        <h3>{{ currentStandardDoc.title }}</h3>
        <p class="text-muted mt-1 mb-2">{{ currentStandardDoc.description }}</p>
        <p v-if="standardsLoading" class="text-muted mt-2">Loading saved instructions…</p>
        <p v-else-if="standardsError" class="text-error mt-2">{{ standardsError }}</p>

        <!-- Starter templates + preset dropdown -->
        <div class="standards-toolbar">
          <div class="toolbar-group">
            <label class="toolbar-label">Start from</label>
            <select v-model="selectedTemplateId" class="select input-sm" :disabled="writingControlsDisabled">
              <option value="">— pick a template —</option>
              <option v-for="t in currentTemplates" :key="t.id" :value="t.id">{{ t.name }}</option>
            </select>
            <button class="btn btn-secondary btn-sm" :disabled="writingControlsDisabled || !selectedTemplateId" @click="loadStarterTemplate">Load</button>
          </div>

          <div class="toolbar-group" v-if="currentPresets.length">
            <label class="toolbar-label">Saved presets</label>
            <select v-model="selectedPresetId" class="select input-sm" :disabled="writingControlsDisabled">
              <option value="">— none —</option>
              <option v-for="p in currentPresets" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <button class="btn btn-secondary btn-sm" :disabled="writingControlsDisabled || !selectedPresetId" @click="loadPreset">Load</button>
            <button class="btn btn-secondary btn-sm" :disabled="writingControlsDisabled || !selectedPresetId" @click="deletePreset">Delete preset</button>
          </div>

          <button class="btn btn-secondary btn-sm" :disabled="writingControlsDisabled" @click="copyAsAiPrompt" title="Copy a chatbot-ready prompt to your clipboard">📋 Copy as AI refine prompt</button>
          <button class="btn btn-secondary btn-sm" :disabled="writingControlsDisabled" @click="showSavePreset = true">💾 Save as preset</button>
        </div>

        <textarea
          v-model="currentStandardText"
          class="textarea"
          style="min-height: 400px; font-family: monospace; font-size: 13px;"
          :placeholder="currentStandardDoc.placeholder"
          :disabled="writingControlsDisabled"
        />

        <div class="flex gap-2 mt-2" style="align-items: center;">
          <button class="btn btn-primary" :disabled="writingControlsDisabled" @click="saveStandardsCurrent">Save</button>
          <SaveIndicator v-bind="savedHintProps('standards')" />
        </div>
      </div>

      <!-- Save preset modal -->
      <div v-if="showSavePreset" class="modal-overlay" @click.self="showSavePreset = false">
        <div class="modal-small">
          <h3>Save {{ standardsSubTab === 'intro' ? 'intro' : 'project instructions' }} preset</h3>
          <p class="text-muted mt-1 mb-2" style="font-size:12px">Give this preset a name so you can reuse it across projects of the same style.</p>
          <input
            v-model="newPresetName"
            class="input"
            placeholder="e.g. Sleep Stories v2, Horror Narration"
            :disabled="writingControlsDisabled"
            @keyup.enter.stop.prevent="savePreset"
            @keydown.escape="showSavePreset = false"
          />
          <div class="flex gap-2 mt-2" style="justify-content:flex-end">
            <button class="btn btn-secondary" :disabled="writingControlsDisabled" @click="showSavePreset = false">Cancel</button>
            <button class="btn btn-primary" :disabled="writingControlsDisabled || !newPresetName.trim()" @click="savePreset">Save preset</button>
          </div>
        </div>
      </div>
    </details>

    <!-- About — version + build info, copyable for bug reports.
         Read at frontend build time from the root package.json (see
         nuxt.config.ts → runtimeConfig.public.appVersion). -->
    <div v-if="activeTab === 'maintenance'" class="card settings-panel mt-2">
      <h3>About Story Studio KH</h3>
      <p class="text-muted mt-1" style="font-size:13px">
        When reporting an issue or asking for help, copy the version string below — it tells us exactly which build you're on so we can match it to the change history.
      </p>
      <div class="about-grid mt-3">
        <div class="about-row">
          <span class="about-label">Version</span>
          <span class="about-value">{{ appVersion }}</span>
        </div>
        <div class="about-row">
          <span class="about-label">Build date</span>
          <span class="about-value">{{ buildDate || '—' }}</span>
        </div>
        <div class="about-row">
          <span class="about-label">Project name</span>
          <span class="about-value">Story Studio KH</span>
        </div>
      </div>
      <button class="btn btn-secondary mt-3" @click="copyVersionString">
        {{ versionCopied ? 'Copied ✓' : 'Copy version string' }}
      </button>
      <p class="text-muted mt-2" style="font-size: var(--font-xs)">
        The same version is also pinned in the bottom-left of the sidebar so you can see it from any page.
      </p>
    </div>

    <!-- v1.0.45 — Reseason preview modal. Lists every episode that
         would move from its current `Season NNN/` parent to a new
         one at the requested season_size. Confirm runs the bulk fs
         move + commits the new size + leaves a `.reseason-undo.json`
         on the project root for 30-day rollback via the Unlinked
         Uploads tab. -->
    <Teleport to="body">
      <div v-if="reseasonState.open" class="reseason-modal-backdrop" @click="closeReseasonPreview" />
      <div v-if="reseasonState.open" class="reseason-modal" role="dialog" aria-label="Rebalance season folders" @click.stop>
        <div class="reseason-modal-header">
          <strong>↻ Rebalance season folders</strong>
          <button class="reseason-modal-close" type="button" title="Close" @click="closeReseasonPreview">✕</button>
        </div>
        <div class="reseason-modal-body">
          <template v-if="reseasonState.preview && reseasonState.preview.moves.length === 0">
            <p class="text-muted" style="font-size: 13px; margin: 0;">
              Nothing to rebalance — all
              {{ reseasonState.preview.total_accepted }} accepted episode{{ reseasonState.preview.total_accepted === 1 ? '' : 's' }}
              already sit at the same season number under
              <strong>{{ reseasonState.preview.new_season_size }}</strong> per group as they did at
              <strong>{{ reseasonState.preview.current_season_size }}</strong>.
              Confirming still updates the saved size so future episodes follow the new grouping.
            </p>
          </template>
          <template v-else-if="reseasonState.preview">
            <p class="text-muted" style="font-size: 13px; margin: 0;">
              From <strong>{{ reseasonState.preview.current_season_size }}</strong> →
              <strong>{{ reseasonState.preview.new_season_size }}</strong> episodes per group.
              <strong>{{ reseasonState.preview.moves.length }}</strong>
              folder{{ reseasonState.preview.moves.length === 1 ? '' : 's' }} will move,
              <span v-if="reseasonState.preview.noop_count > 0">
                {{ reseasonState.preview.noop_count }} stay where they are.
              </span>
              <br />
              External-root mirror (when configured) is rebalanced in the same step.
              The <code>.reseason-undo.json</code> safety net is written first — fully reversible from the
              Unlinked Uploads tab for 30 days.
            </p>
            <div class="reseason-move-list">
              <div
                v-for="(m, idx) in reseasonState.preview.moves.slice(0, 12)"
                :key="m.code"
                class="reseason-move-row"
              >
                <code>{{ m.code }}</code>
                <span class="text-muted">·</span>
                <span class="text-muted">{{ projectForm.season_prefix || 'Season' }} {{ String(m.old_season).padStart(3, '0') }} →
                  {{ projectForm.season_prefix || 'Season' }} {{ String(m.new_season).padStart(3, '0') }}</span>
                <span class="reseason-move-title text-muted">{{ m.title }}</span>
              </div>
              <div v-if="reseasonState.preview.moves.length > 12" class="text-muted" style="font-size: var(--font-xs); padding: 4px 0;">
                + {{ reseasonState.preview.moves.length - 12 }} more
              </div>
            </div>
          </template>
          <p v-if="reseasonState.error" class="text-danger" style="font-size: 12px; margin: 8px 0 0;">
            ⚠ {{ reseasonState.error }}
          </p>
        </div>
        <div class="reseason-modal-footer">
          <button type="button" class="btn btn-ghost btn-sm" @click="closeReseasonPreview">Cancel</button>
          <button
            v-if="reseasonState.preview"
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="reseasonState.running"
            @click="confirmReseason"
          >
            <LoadingSpinner v-if="reseasonState.running" size="sm" />
            {{ reseasonState.running
              ? 'Rebalancing…'
              : (reseasonState.preview.moves.length === 0
                ? 'Save new size'
                : `Rebalance ${reseasonState.preview.moves.length} folder${reseasonState.preview.moves.length === 1 ? '' : 's'}`) }}
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
// pickFolder() branches between Electron's native dialog and the in-app
// FileBrowserModal (server mode / remote tailnet browser). Not auto-imported
// — it's a bare named export, not a useX composable.
import { pickFolder as pickFolderShared } from '~/composables/usePathPicker'
import { resolveSettingsSectionHash, settingsAnchorTargetIds } from '~/utils/settingsNavigation'
import { projectSettingsSavePlan, type ProjectSettingsSaveSection } from '~/utils/projectSettingsSave'
// Reactive installed Content Pack catalog used by the per-project selector.
// Project-local saved styles remain independent compatibility data.
import { useVisualStyleCatalog } from '~/composables/useVisualStyleCatalog'
import type { AudioQualityMode } from '~/types/audio-quality'
import { genstudioStaleNote } from '~/utils/genstudio-freshness'
// Every Settings destination replaces content beneath the same heading. On a
// cross-page hash arrival there is nothing lower to scroll to, and Nuxt checks
// the hash before this client-only page mounts. Let same-page hashes use the
// concrete heading targets below, while an initial/cross-page arrival starts
// at the normal page position without asking the router to find unmounted DOM.
definePageMeta({ layout: 'dashboard', scrollToTop: to => !to.hash })
useAppTitle('Settings')
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put, patch, del } = useApi()
const {
  styles: visualStyles,
  loading: visualStylesLoading,
  error: visualStylesError,
  refresh: refreshVisualStyles,
} = useVisualStyleCatalog()
onMounted(() => { void refreshVisualStyles(); void loadCadence() })
const { ask } = useConfirm()
const { project, config, refreshConfig, loadProject } = useProject()
const { success, error: showError, info } = useToast()
const {
  modelId: audioQualityAlternateModel,
  options: audioQualityModelOptions,
  loading: audioQualityCatalogLoading,
  error: audioQualityCatalogError,
  isStale: audioQualityCatalogStale,
  sourceFreshness: audioQualityCatalogFreshness,
  load: loadAudioQualityModels,
} = useGenStudioTranscriptionModels()
const audioQualityCatalogStaleNote = computed(() => genstudioStaleNote(
  audioQualityCatalogStale.value,
  audioQualityCatalogFreshness.value?.loadedAt ?? null,
))
// v1.4.3 — the move-this-project-to dialog and the unlink flow lived here.
// Both are gone with the per-Mac register of folders outside the projects
// folder. `projectLocation` below still shows where this channel sits; moving
// it is a Finder drag inside the Library.

const activeTab = ref('connections')
const syncing = ref(false)
const syncResults = ref<string[]>([])

// ── About-tab bindings ──────────────────────────────────────────────────
// App version + build date come from runtimeConfig (set in nuxt.config.ts
// at build time from the root package.json). Surfaced here so beta
// testers can copy "Story Studio KH v1.0.11 · built 2026-04-27" into a
// bug report.
const { public: pubCfg } = useRuntimeConfig()
const appVersion = computed(() => (pubCfg.appVersion as string | undefined) || '0.0.0')
const buildDate = computed(() => (pubCfg.buildDate as string | undefined) || '')
const versionCopied = ref(false)
async function copyVersionString() {
  const txt = `Story Studio KH v${appVersion.value} · built ${buildDate.value}`
  try {
    await navigator.clipboard.writeText(txt)
    versionCopied.value = true
    setTimeout(() => { versionCopied.value = false }, 1400)
    success('Version copied')
  } catch {
    showError('Could not copy — your browser/OS blocked clipboard access.')
  }
}

// Per-action "Saved Xs ago" persistent indicator. Each successful save
// stamps a timestamp under its key; <SaveIndicator> renders a permanent
// pill so the operator can tell at a glance whether their last edit
// landed even after the toast fades. Replaces the ad-hoc savedStandardHint
// + notifSaveStatus → 'idle' auto-clear that used to disappear after
// 1.5–2s. Fed via savedHintProps(key) in the template.
const savedAt = reactive<Record<string, number | null>>({})
function stampSaved(key: string) { savedAt[key] = Date.now() }
function savedHintProps(key: string) {
  const ts = savedAt[key] ?? null
  return { state: (ts ? 'saved' : 'idle') as AutoSaveState, savedAt: ts }
}

// ── Continuity Engine state ────────────────────────────────────────────────
const formatId = ref<string>('continuity-chain')
const formatSaving = ref(false)
const formatSaveError = ref('')
type ContinuityMode = 'character-continuity' | 'independent-stills' | 'explainer-stills'
const continuityMode = ref<ContinuityMode>('independent-stills')
const continuityModeBaseline = ref<ContinuityMode>('independent-stills')
const formatIdBaseline = ref<string>('continuity-chain')
const guideDensity = ref(40)
const savingGuideDensity = ref(false)
const audioQualityMode = ref<AudioQualityMode>('off')
const audioQualityBaseline = ref(JSON.stringify({ mode: 'off' }))
const audioQualityLoadedSlug = ref('')
const audioQualitySaving = ref(false)
const audioQualitySaveError = ref('')
const audioQualityModeOptions: Array<{
  value: AudioQualityMode
  label: string
  description: string
  recommended?: boolean
}> = [
  { value: 'off', label: 'Off', description: 'Keep narration checks out of this channel.' },
  { value: 'flag_issues', label: 'Flag issues', recommended: true, description: 'Review saved source and transcript evidence locally. No provider request or credit charge.' },
  { value: 'check_and_repair', label: 'Check and repair', description: 'Inspect selected chapters and offer one reviewed repair when evidence supports it. May use credits.' },
]
const audioQualityDraft = computed(() => ({
  mode: audioQualityMode.value,
  ...(audioQualityAlternateModel.value ? { alternate_transcription_model: audioQualityAlternateModel.value } : {}),
}))
const audioQualityDirty = computed(() => JSON.stringify(audioQualityDraft.value) !== audioQualityBaseline.value)
const audioQualityValid = computed(() => audioQualityMode.value !== 'check_and_repair' || !!audioQualityAlternateModel.value)
const audioQualityModeSummary = computed(() => audioQualityMode.value === 'flag_issues'
  ? 'Flag issues'
  : audioQualityMode.value === 'check_and_repair'
    ? 'Check & repair'
    : 'Off')
const formatDirty = computed(() => {
  if (formatId.value !== formatIdBaseline.value) return true
  if (continuityMode.value !== continuityModeBaseline.value) return true
  return false
})

function syncFormatFromProject() {
  const m = project.value as any
  if (!m) return
  formatId.value = 'continuity-chain'
  continuityMode.value = m.continuity_mode === 'character-continuity' || m.continuity_mode === 'explainer-stills'
    ? m.continuity_mode
    : 'independent-stills'
  formatIdBaseline.value = formatId.value
  continuityModeBaseline.value = continuityMode.value
}

// Hydrate when project meta arrives + on slug change.
watch(project, syncFormatFromProject, { immediate: true })

// Channel-wide visual planning default. It remains in ProjectConfig under the
// existing `character_density` key, which Scene Plan reads whenever it creates
// a fresh plan. Character Sheet only owns per-episode anchors and pacing.
watch(config, (value) => {
  const density = Number((value as any)?.character_density)
  if (Number.isFinite(density)) guideDensity.value = Math.max(0, Math.min(100, Math.round(density)))
}, { immediate: true })

watch([slug, config], ([projectSlug, value]) => {
  if (!projectSlug || !value) return
  if (audioQualityLoadedSlug.value === projectSlug && audioQualityDirty.value) return
  const saved = (value as any).audio_quality
  audioQualityMode.value = saved?.mode === 'flag_issues' || saved?.mode === 'check_and_repair'
    ? saved.mode
    : 'off'
  audioQualityAlternateModel.value = typeof saved?.alternate_transcription_model === 'string'
    ? saved.alternate_transcription_model
    : ''
  audioQualityLoadedSlug.value = projectSlug
  audioQualityBaseline.value = JSON.stringify(audioQualityDraft.value)
}, { immediate: true })

watch(audioQualityMode, (mode) => {
  if (mode === 'check_and_repair') void loadAudioQualityModels()
})
const guideDensityLabel = computed(() =>
  guideDensity.value === 0 ? 'No recurring guide'
    : guideDensity.value >= 100 ? 'Guide in every scene'
      : `Guide in ~${guideDensity.value}% of scenes`)

async function saveGuideDensity(): Promise<void> {
  savingGuideDensity.value = true
  try {
    await put(`/projects/${slug.value}/settings/config`, { character_density: guideDensity.value })
    await refreshConfig(slug.value)
    stampSaved('guide_density')
    success(`Guide visibility saved — ${guideDensityLabel.value.toLowerCase()}`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to save guide visibility')
    // Put the slider back on the saved value rather than leave it showing one that was never saved.
    const saved = Number((config.value as any)?.character_density)
    if (Number.isFinite(saved)) guideDensity.value = Math.max(0, Math.min(100, Math.round(saved)))
  } finally {
    savingGuideDensity.value = false
  }
}

async function saveAudioQuality(): Promise<void> {
  if (!audioQualityValid.value || audioQualitySaving.value) return
  audioQualitySaving.value = true
  audioQualitySaveError.value = ''
  const targetSlug = slug.value
  const payload = audioQualityDraft.value
  try {
    await put(`/projects/${targetSlug}/settings/config`, { audio_quality: payload })
    if (slug.value !== targetSlug) return
    audioQualityBaseline.value = JSON.stringify(payload)
    if (config.value) (config.value as any).audio_quality = payload
    stampSaved('audio_quality')
    success('Audio quality setting saved')
  } catch (e: any) {
    audioQualitySaveError.value = e?.data?.detail || e?.message || 'Could not save audio quality'
    showError(audioQualitySaveError.value)
  } finally {
    if (slug.value === targetSlug) audioQualitySaving.value = false
  }
}

async function saveFormatSettings() {
  formatSaving.value = true
  formatSaveError.value = ''
  try {
    const body: any = {
      format_id: 'continuity-chain',
      content_mode: 'format',
      continuity_mode: continuityMode.value,
    }
    await put(`/projects/${slug.value}`, body)
    formatId.value = 'continuity-chain'
    formatIdBaseline.value = 'continuity-chain'
    continuityModeBaseline.value = continuityMode.value
    stampSaved('format')
    success('Format settings saved')
    await loadProject(slug.value)
  } catch (e: any) {
    formatSaveError.value = e?.data?.detail || e?.message || 'Failed to save format settings'
    showError(formatSaveError.value)
  } finally {
    formatSaving.value = false
  }
}

// ── Niche tab state (subject-domain layer) ─────────────────────────────────
//
// Niche is orthogonal to Format — empty string means "no niche, use format
// defaults only". Saved via the dedicated /projects/:slug/niche endpoint
// so the existing /projects/:slug
// PATCH path doesn't need to learn about a new field shape.

// v1.0.96+ — Niche tab also absorbs the standalone /niches sidebar page
// (browse / create custom / delete custom). One source for niche stuff.
const {
  find: findNicheProfile,
  niches: nicheLibList,
  isLoading: nicheLibLoading,
  error: nicheLibError,
  createNiche: createNicheApi,
  deleteNiche: deleteNicheApi,
  refresh: refreshNiches,
} = useNiches()
const { topicPacks: topicPackLibList } = useTopicPacks()
const nicheId = ref<string>('')
const topicPackIds = ref<string[]>([])
const identityPickerOpen = ref(false)
// Sub-tab state for the merged Niche tab. Default to 'project' (the
// picker) since that's the common case; 'library' is for browse/create.
const nicheSubTab = ref<'project' | 'library'>('project')
const customNicheLibList = computed(() => nicheLibList.value.filter(niche => !niche.builtin))
const nicheLibraryCount = computed(() => customNicheLibList.value.length)
const selectedNicheProfile = computed(() => findNicheProfile(nicheId.value))
const selectedFormulaLabel = computed(() => selectedNicheProfile.value?.catalogName || selectedNicheProfile.value?.name || nicheId.value || 'No Formula')
const selectedTopicPackLabel = computed(() => {
  if (!topicPackIds.value.length) return 'No Topic Packs'
  const names = topicPackIds.value.map(id => topicPackLibList.value.find(pack => pack.id === id)?.name || id)
  return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ')
})
const projectContentPackVersions = computed<Record<string, string>>(() => (project.value as any)?.content_pack_versions || {})
const selectedProductionKit = computed(() => selectedNicheProfile.value?.productionKit || null)
const humanizeCatalogId = (value?: string) => (value || 'Not specified')
  .replace(/^com\.storystudio\.(?:style|thumbnail|formula|topic)\./, '')
  .replace(/^builtin-/, '')
  .split(/[-_]/g)
  .filter(Boolean)
  .map(part => part.charAt(0).toUpperCase() + part.slice(1))
  .join(' ')
/**
 * A Formula SUGGESTS a visual style; it never writes one. The suggestion has
 * three honest states, and the card says which one you are in:
 *   - in use            → you already picked it, nothing to do
 *   - installed         → one click applies it
 *   - not installed     → we name it and point at the Content Store
 * Before v1.4.64 there was no state at all: saving the Formula silently wrote
 * a style into the project, so the look was decided for you and the picker
 * showed a value you never chose.
 */
const productionKitStyleSuggestionIds = computed<string[]>(() => {
  const ids = selectedNicheProfile.value?.recommendedVisualStyleIds
  return Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id.trim()) : []
})
const productionKitStyleSuggestion = computed(() => {
  const id = productionKitStyleSuggestionIds.value[0]
  if (!id) return null
  const installed = visualStyles.value.find(style => style.id === id) || null
  const active = String((config.value as any)?.active_style_preset_id || '').trim()
  return {
    id,
    name: installed?.name || humanizeCatalogId(id),
    installed: Boolean(installed),
    inUse: active === id,
  }
})
/** One click, and only ever from this button. Routes through the same picker
 *  the customer uses, so the choice is recorded exactly as a manual one. */
function useSuggestedProductionKitStyle(): void {
  const suggestion = productionKitStyleSuggestion.value
  if (artStyleSaving.value || !suggestion || !suggestion.installed || suggestion.inUse) return
  artStyleSelection.value = suggestion.id
}
const selectedProductionKitThumbnailName = computed(() =>
  humanizeCatalogId(selectedNicheProfile.value?.defaultThumbnailTemplateId))
const selectedProductionKitMotionName = computed(() =>
  selectedNicheProfile.value?.scriptStructure?.motionProfile?.label || 'Formula default')
const selectedProductionKitMotionSummary = computed(() => {
  const profile = selectedNicheProfile.value?.scriptStructure?.motionProfile
  if (!profile) return 'Uses the Formula’s normal scene behavior.'
  return `Opening: ${profile.opening.still}% still · ${profile.opening.gentle}% gentle · ${profile.opening.limited}% limited. Settled: ${profile.settled.still}% still · ${profile.settled.gentle}% gentle · ${profile.settled.limited}% limited.`
})
const selectedProductionKitDurations = computed(() => {
  const presets = selectedNicheProfile.value?.scriptStructure?.durationPresets || []
  return presets.length ? presets.map(value => `${value} min`).join(' · ') : 'Formula default'
})

// ── Publishing cadence (v1.4.20) ──────────────────────────────────────────
// The owner: "right now my upload plan is in upload center. what if i make it
// part of the channel creation? but also make it adjustable."
//
// The cadence belongs to the CHANNEL; the plan belongs to the ACCOUNT. A plan
// is keyed platform:account_id and so cannot exist before YouTube is connected
// — a channel can predate its account by months. Setting the cadence
// here means a channel has a rhythm from day one and the plan is created from
// it on connect. Once a plan exists the PLAN is the authority; this is a seed.
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const cadenceLoaded = ref(false)
const cadenceSaving = ref(false)
const cadenceError = ref('')
const cadenceWeekdays = ref<number[]>([])
const cadenceTime = ref('18:00')
const cadenceTimezone = ref('')
const cadenceIntervalWeeks = ref(1)
const autoScheduleOnRender = ref(false)
/** True once this channel has a real plan — from then on this screen is a seed. */
const cadenceHasPlan = ref(false)

function toggleCadenceWeekday(day: number) {
  const i = cadenceWeekdays.value.indexOf(day)
  if (i >= 0) cadenceWeekdays.value.splice(i, 1)
  else cadenceWeekdays.value.push(day)
  cadenceWeekdays.value.sort((a, b) => a - b)
}

/** Episodes a month at this cadence — the number that makes it concrete. */
const cadencePerMonth = computed(() => {
  const perWeek = cadenceWeekdays.value.length
  if (!perWeek) return 0
  return Math.round((perWeek / Math.max(1, cadenceIntervalWeeks.value)) * 4.345)
})

async function loadCadence() {
  try {
    const cfg: any = await get(`/projects/${slug.value}/settings/config`)
    const c = cfg?.publish_cadence || cfg?.config?.publish_cadence
    if (c?.schedule) {
      cadenceWeekdays.value = Array.isArray(c.schedule.weekdays) ? [...c.schedule.weekdays] : []
      cadenceTime.value = c.schedule.time_local || '18:00'
      cadenceTimezone.value = c.schedule.timezone || ''
      cadenceIntervalWeeks.value = c.schedule.interval_weeks || 1
    }
    const auto = cfg?.auto_schedule_on_render ?? cfg?.config?.auto_schedule_on_render
    autoScheduleOnRender.value = auto === true
    if (!cadenceTimezone.value) {
      cadenceTimezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    }
    // Does a plan already exist? If so this screen stops being the authority.
    try {
      const plans: any = await get(`/projects/${slug.value}/upload/plans`)
      const list = Array.isArray(plans) ? plans : (plans?.plans || [])
      cadenceHasPlan.value = list.length > 0
    } catch { cadenceHasPlan.value = false }
  } catch { /* a channel with no config yet is a fine starting state */ }
  cadenceLoaded.value = true
}

async function saveCadence() {
  cadenceSaving.value = true
  cadenceError.value = ''
  try {
    if (!cadenceWeekdays.value.length) {
      throw new Error('Pick at least one day, or the schedule can never produce a slot.')
    }
    await put(`/projects/${slug.value}/settings/config`, {
      publish_cadence: {
        schedule: {
          weekdays: [...cadenceWeekdays.value],
          time_local: cadenceTime.value,
          timezone: cadenceTimezone.value,
          interval_weeks: cadenceIntervalWeeks.value,
        },
        defaults: { privacy_status: 'private', made_for_kids: false },
      },
      auto_schedule_on_render: autoScheduleOnRender.value,
    })
    success(cadenceHasPlan.value
      ? 'Publishing cadence saved. Your existing upload plan is unchanged — edit that in Upload Center.'
      : 'Publishing cadence saved. It becomes this channel\'s plan when you connect YouTube.')
  } catch (e: any) {
    cadenceError.value = e?.data?.detail || e?.message || 'Could not save the cadence'
  } finally {
    cadenceSaving.value = false
  }
}

// ── Episode shape (v1.4.18) ───────────────────────────────────────────────
// 1.4.16 gave every Formula its own chapters, length and pace, and left no way
// to change them without editing JSON. The owner: "series formula editing ui.
// do it please then, i thought you already did it."
//
// This edits through PATCH /niches/:id/episode-shape, a MERGE. The
// full-document PUT beside it validates against `NicheSchema`, which does not
// contain scriptStructure, narratorStyles, pacingArc or titleShapeRules — so
// sending a real Formula through it is refused, and would have stripped those
// fields if it were not. See routes/niches.ts.
const shapeOpen = ref(false)
const shapeSaving = ref(false)
const shapeError = ref('')
interface EpisodeShapeForm {
  defaultChapterCount: number
  chapterMin: number
  chapterMax: number
  defaultLengthMinutes: number
  minutesMin: number
  minutesMax: number
  defaultWordsPerMinute: number
  chaptersIndependent: boolean
  metadataTitleStyleHint: string
}
const shapeForm = ref<EpisodeShapeForm | null>(null)

/** Roughly how many words a chapter carries at this shape — the number that
 *  makes a length and a pace mean something together. */
const shapeWordsPerChapter = computed(() => {
  const f = shapeForm.value
  if (!f || !f.defaultChapterCount) return 0
  return Math.round((f.defaultLengthMinutes * f.defaultWordsPerMinute) / f.defaultChapterCount)
})
const shapeTotalWords = computed(() => {
  const f = shapeForm.value
  return f ? Math.round(f.defaultLengthMinutes * f.defaultWordsPerMinute) : 0
})

function openEpisodeShape() {
  const n = selectedNicheProfile.value
  const ss: any = n?.scriptStructure || {}
  shapeError.value = ''
  shapeForm.value = {
    defaultChapterCount: ss.defaultChapterCount ?? 5,
    chapterMin: ss.chapterCountRange?.[0] ?? 1,
    chapterMax: ss.chapterCountRange?.[1] ?? 20,
    defaultLengthMinutes: ss.defaultLengthMinutes ?? 8,
    minutesMin: ss.lengthMinutesRange?.[0] ?? 3,
    minutesMax: ss.lengthMinutesRange?.[1] ?? 20,
    defaultWordsPerMinute: ss.defaultWordsPerMinute ?? 160,
    chaptersIndependent: !!ss.chaptersIndependent,
    metadataTitleStyleHint: (n as any)?.metadataTitleStyleHint || '',
  }
  shapeOpen.value = true
}

async function saveEpisodeShape() {
  const f = shapeForm.value
  if (!f || !nicheId.value) return
  shapeSaving.value = true
  shapeError.value = ''
  try {
    // project_slug is not optional in effect: without it the fork is written
    // and nothing points at it, so the change would look saved and do nothing.
    const res = await patch(
      `/niches/${encodeURIComponent(nicheId.value)}/episode-shape`
      + `?project_slug=${encodeURIComponent(slug.value)}`,
      {
        defaultChapterCount: Number(f.defaultChapterCount),
        chapterCountRange: [Number(f.chapterMin), Number(f.chapterMax)],
        defaultLengthMinutes: Number(f.defaultLengthMinutes),
        lengthMinutesRange: [Number(f.minutesMin), Number(f.minutesMax)],
        defaultWordsPerMinute: Number(f.defaultWordsPerMinute),
        chaptersIndependent: !!f.chaptersIndependent,
        metadataTitleStyleHint: f.metadataTitleStyleHint || '',
      },
    )
    // A built-in becomes a user copy on first edit, so the project's Formula id
    // changes underneath us. Reload both or the page keeps showing the old one.
    await refreshNiches()
    await loadProject(slug.value)
    syncNicheFromProject()
    shapeOpen.value = false
    success(res?.forked_from
      ? 'Episode shape saved — this channel now uses its own copy of the Formula'
      : 'Episode shape saved')
  } catch (e: any) {
    shapeError.value = e?.data?.detail || e?.message || 'Could not save the episode shape'
  } finally {
    shapeSaving.value = false
  }
}

function syncNicheFromProject() {
  const m = project.value as any
  if (!m) return
  nicheId.value = m.niche_id || ''
  topicPackIds.value = Array.isArray(m.topic_pack_ids)
    ? [...m.topic_pack_ids]
    : [...(findNicheProfile(nicheId.value)?.defaultTopicPackIds || [])]
}

watch(project, syncNicheFromProject, { immediate: true })
watch(nicheLibList, () => {
  const meta = project.value as any
  if (!meta?.niche_id || Array.isArray(meta.topic_pack_ids)) return
  const defaults = findNicheProfile(meta.niche_id)?.defaultTopicPackIds || []
  topicPackIds.value = [...defaults]
}, { immediate: true })

async function onIdentitySaved(value: { formulaId: string; topicPackIds: string[] }): Promise<void> {
  nicheId.value = value.formulaId
  topicPackIds.value = [...value.topicPackIds]
  stampSaved('niche')
  success(value.formulaId ? 'Series Formula and Topic Packs saved' : 'Series Formula cleared')
  await loadProject(slug.value)
}

// ── v1.0.96+ Niche library: create / delete / use-on-project ──────────
//
// Merged in from the standalone /niches sidebar page (now retired).
// Custom-formula actions share the catalogue cache with the Channel Identity
// library, so a newly created local Formula appears the next time it opens.

const nicheCreateOpen = ref(false)
const nicheCreateBusy = ref(false)
const nicheCreateError = ref('')
const nicheDraft = reactive({
  id: '',
  name: '',
  tagline: '',
  description: '',
  scriptContext: '',
  visualStyleSheet: '',
})
const nicheDraftExampleTopicsText = ref('')

const nicheCanCreate = computed(() => {
  if (!nicheDraft.id.trim()) return false
  if (!nicheDraft.name.trim()) return false
  if (!nicheDraft.description.trim()) return false
  if (!nicheDraftExampleTopicsText.value.trim()) return false
  return /^[a-z0-9][a-z0-9_-]*$/.test(nicheDraft.id.trim())
})

function openNicheCreator(): void {
  nicheDraft.id = ''
  nicheDraft.name = ''
  nicheDraft.tagline = ''
  nicheDraft.description = ''
  nicheDraft.scriptContext = ''
  nicheDraft.visualStyleSheet = ''
  nicheDraftExampleTopicsText.value = ''
  nicheCreateError.value = ''
  nicheCreateOpen.value = true
}
function closeNicheCreator(): void {
  if (nicheCreateBusy.value) return
  nicheCreateOpen.value = false
}
async function submitNicheCreate(): Promise<void> {
  if (!nicheCanCreate.value) return
  nicheCreateBusy.value = true
  nicheCreateError.value = ''
  try {
    const topics = nicheDraftExampleTopicsText.value
      .split('\n').map(s => s.trim()).filter(Boolean)
    await createNicheApi({
      id: nicheDraft.id.trim(),
      name: nicheDraft.name.trim(),
      description: nicheDraft.description.trim(),
      builtin: false,
      schemaVersion: 1,
      tagline: nicheDraft.tagline.trim() || undefined,
      exampleTopics: topics,
      scriptContext: nicheDraft.scriptContext.trim() || undefined,
      visualStyleSheet: nicheDraft.visualStyleSheet.trim() || undefined,
    })
    success(`Created custom niche "${nicheDraft.name.trim()}"`)
    nicheCreateOpen.value = false
  } catch (e: any) {
    nicheCreateError.value = e?.data?.detail || e?.message || 'Failed to create niche'
  } finally {
    nicheCreateBusy.value = false
  }
}

async function confirmDeleteNiche(n: { id: string; name: string; project_count?: number }): Promise<void> {
  if (n.project_count && n.project_count > 0) {
    showError(`Cannot delete "${n.name}" — ${n.project_count} project(s) still reference it. Change those projects' niches first.`)
    return
  }
  const ok = await ask({
    title: `Delete niche "${n.name}"?`,
    message: 'Removes the custom niche file from this Mac. Built-in niches cannot be deleted.',
    confirmLabel: 'Delete niche',
    danger: true,
  })
  if (!ok) return
  try {
    await deleteNicheApi(n.id)
    success(`Deleted "${n.name}"`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to delete niche')
  }
}

// (Removed: connectivity precheck state. It used to live alongside the
// API Keys tab on this page; the tab is gone, and the wizard on /
// runs its own precheck on entry to step 4.)

// ── Storage tab state ─────────────────────────────────────────────────────
//
// Audit/cleanup talks to the new /storage-* endpoints. External-root
// is per-machine (lives in app-settings, not project config) so we
// fetch it from /app-settings/external-final-video-root rather than
// the project's config. Lazy-loaded — first scan only fires when the
// user clicks the Run scan button so opening the tab is instant.

interface StorageEntry {
  episode_code: string
  title: string
  bytes_final_video: number
  bytes_per_scene_clips: number
  bytes_audio: number
  bytes_images: number
  bytes_other: number
  bytes_total: number
  bytes_external_final_video: number
  uploaded_to_youtube: boolean
  youtube_video_id: string
  cleanup_eligible: boolean
  cleanup_reason?: string
}
interface StorageAudit {
  project_bytes_total: number
  project_bytes_final_video: number
  project_bytes_per_scene_clips: number
  project_bytes_external_final_video: number
  project_bytes_thumbnail_cache?: number
  external_root_configured: boolean
  external_root: string
  episodes: StorageEntry[]
}
interface MigrationResult {
  moved: Array<{ episode_code: string; from: string; to: string; bytes: number }>
  errors: Array<{ episode_code: string; reason: string }>
  bytes_moved: number
}
interface MediaMigrationResult {
  dry_run: boolean
  folders: Array<{ episode_code: string; key: string; from: string; to: string; files: number; bytes: number }>
  scene_plan_rewrites: number
  errors: Array<{ episode_code: string; reason: string }>
  bytes_moved: number
  files_moved: number
}
interface CleanupResult {
  deleted_count: number; skipped_count: number; failed_count: number
  bytes_freed: number
  items: Array<{ episode_code: string; file: string; status: string; bytes_freed: number; reason?: string }>
}

const storage = ref<StorageAudit | null>(null)
const auditLoading = ref(false)
const previewCacheClearing = ref(false)
const lastPreviewCacheClear = ref<{ bytes: number; moved: boolean } | null>(null)
const externalRootInput = ref('')
// Mirror of the persisted value — drives the dirty-state for the "Save manual
// path" button (only shown when the input differs from what's saved).
const externalRootSavedValue = ref('')
const externalRootSaving = ref(false)
const externalRootStatus = ref('')
// Friendly picker-failure panel (shown beneath the External-root status).
// Distinct from `externalRootStatus` so the "Picker failed: …" message can
// be rephrased into actionable guidance without losing the save-status text.
const externalRootPickerHelp = ref('')
const externalRootReachable = ref(false)
const migrateRunning = ref(false)

// ── External media root (Level B, per-project, opt-in) ───────────────────────
// Routes heavy media (images/thumbnails/audio/merged audio/video) to a separate
// root (e.g. an external SSD) while light artifacts stay in the project tree.
// Stored in project.json as `media_root` (a ${NAME} token or absolute path).
const mediaRootInput = ref('')
const mediaRootSavedValue = ref('')
const mediaRootSaving = ref(false)
const mediaRootChecking = ref(false)
const mediaRootStatus = ref('')
const mediaRootOk = ref(false)
const mediaMigrateRunning = ref(false)
const lastMediaMigration = ref<MediaMigrationResult | null>(null)
const lastMigration = ref<MigrationResult | null>(null)
const bulkRunning = ref(false)
const lastBulkCleanup = ref<CleanupResult | null>(null)
const rowCleanupRunning = ref<string | null>(null)

// v1.0.71: chunked-progress sidecar cleanup (manual; never auto-wipes).
// listChunkedSidecars walks every accepted episode and tags each as
// `eligible` (unified narration done + chapters_done covers total) or
// gives a reason it's not safe to clean. The user reviews before
// triggering deletion.
interface SidecarEligibilityRow {
  episode_code: string
  sidecar_present: boolean
  sidecar_path: string
  sidecar_size_bytes?: number
  total_chapters?: number
  chapters_done?: number
  unified_present: boolean
  eligible: boolean
  reason?: string
}
interface SidecarScanResult {
  episodes: SidecarEligibilityRow[]
  eligible_count: number
  reclaimable_bytes: number
}
interface SidecarCleanupResult {
  deleted: Array<{ episode_code: string; path: string; bytes_freed: number }>
  skipped: Array<{ episode_code: string; reason: string }>
  total_bytes_freed: number
}
const sidecarScan = ref<SidecarScanResult | null>(null)
const sidecarScanLoading = ref(false)
const sidecarCleanupRunning = ref(false)
const lastSidecarCleanup = ref<SidecarCleanupResult | null>(null)

const sortedStorageRows = computed<StorageEntry[]>(() => {
  if (!storage.value) return []
  return [...storage.value.episodes].sort((a, b) => b.bytes_total - a.bytes_total)
})

// Bulk cleanup offers only candidates with a current content-hash receipt.
// The backend re-verifies exact bytes and current provider state before rm.
const uploadedFinals = computed<StorageEntry[]>(() => {
  if (!storage.value) return []
  return storage.value.episodes.filter(e => e.cleanup_eligible
    && (e.bytes_final_video > 0 || e.bytes_external_final_video > 0))
})
const uploadedFinalsCount = computed(() => uploadedFinals.value.length)
const uploadedFinalsTotalBytes = computed(() =>
  uploadedFinals.value.reduce((s, e) => s + e.bytes_final_video + e.bytes_external_final_video, 0),
)

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

async function loadExternalRoot() {
  try {
    const r = await get<{ value: string; reachable: boolean; reason: string }>(
      '/app-settings/external-final-video-root',
    )
    externalRootInput.value = r.value || ''
    externalRootSavedValue.value = r.value || ''
    externalRootReachable.value = r.reachable
    externalRootStatus.value = r.value
      ? (r.reachable ? `✓ reachable: ${r.value}` : `⚠ ${r.reason}`)
      : ''
  } catch { /* leave defaults — non-fatal */ }
}

// v1.4.5 — `saveExternalRoot`/`clearExternalRoot` deleted. The export folder is
// derived from the Library since v1.4.3 and its setter route went with the
// setting; these had been posting to a 404. `loadExternalRoot` stays — the GET
// is alive and reports where finished videos actually go.

// Verify the media_root token/path resolves on THIS machine (does not check
// that the drive is currently plugged in — just that ${MEDIA} is defined).
async function checkMediaRoot() {
  const val = mediaRootInput.value.trim()
  if (!val) { mediaRootStatus.value = ''; mediaRootOk.value = false; return }
  mediaRootChecking.value = true
  try {
    const r = await post<{ output: string; is_portable: boolean }>(
      '/system/resolve-asset-path', { path: val },
    )
    mediaRootOk.value = true
    mediaRootStatus.value = `✓ Resolves to ${r.output} — keep this drive connected when generating media.`
  } catch (e: any) {
    mediaRootOk.value = false
    mediaRootStatus.value = `⚠ ${e?.data?.detail || e?.message || 'Could not resolve this path on this Mac. Use a full folder path or ${ASSET}/….'}`
  } finally {
    mediaRootChecking.value = false
  }
}

async function saveMediaRoot() {
  mediaRootSaving.value = true
  try {
    const val = mediaRootInput.value.trim()
    await put(`/projects/${slug.value}`, { media_root: val })
    mediaRootSavedValue.value = val
    stampSaved('mediaRoot')
    if (val) { await checkMediaRoot() } else { mediaRootStatus.value = ''; mediaRootOk.value = false }
    success(val
      ? 'External media root saved — new media for this project will be written there.'
      : 'External media root cleared — media stays in the project tree.')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save external media root')
  } finally {
    mediaRootSaving.value = false
  }
}

async function clearMediaRoot() {
  mediaRootInput.value = ''
  await saveMediaRoot()
}

/**
 * Translate a /system/pick-folder failure into a one-liner the user can act
 * on. Only the explicit Electron-missing message identifies the common
 * dev-mode case: a generic 503 can instead mean Electron is still busy.
 */
function pickerHelpFor(e: any): string {
  const status = e?.status ?? e?.response?.status
  const detail: string = e?.data?.detail || e?.message || ''
  if (/Electron main process not detected|Folder picker not available/i.test(detail)) {
    return 'The native folder picker only works in the packaged app, not in the dev server. Type or paste a path into the field above instead.'
  }
  if (status === 503 || /timed? out|timeout/i.test(detail)) {
    return 'The folder picker is taking longer than expected. Wait for any open picker to close, then try again, or type or paste a path above.'
  }
  return `Folder picker failed: ${detail || 'unknown error'}. You can also type or paste a path above instead.`
}

// v1.4.5 — `browseAndSetExternalRoot` and `clearExternalRoot` went with
// `saveExternalRoot`. There is nothing to set: finished videos go to
// `<Library>/Exports`, and moving them elsewhere is what the Archive panel does.


async function loadStorageAudit() {
  auditLoading.value = true
  try {
    storage.value = await get<StorageAudit>(`/projects/${slug.value}/storage-audit`)
  } catch (e: any) {
    storage.value = null
    showError(e?.data?.detail || e?.message || 'Storage audit failed')
  } finally {
    auditLoading.value = false
  }
}

async function clearPreviewCache() {
  if (previewCacheClearing.value) return
  previewCacheClearing.value = true
  try {
    lastPreviewCacheClear.value = await post<{ bytes: number; moved: boolean }>(
      `/projects/${slug.value}/storage/clear-preview-cache`,
      {},
    )
    await loadStorageAudit()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Clearing the preview cache failed')
  } finally {
    previewCacheClearing.value = false
  }
}

async function runBulkCleanup() {
  if (!storage.value || uploadedFinalsCount.value === 0) return
  const ok = await ask({
    title: 'Verify and clear local videos?',
    message: `Verify ${uploadedFinalsCount.value} local final video file(s) (${formatBytes(uploadedFinalsTotalBytes.value)}) before clearing them?\n\n` +
    `Story Studio will compare each file's SHA-256 with its accepted upload and refresh the current processed video on the assigned YouTube channel immediately before deletion. ` +
    `Any file it cannot verify stays local and is reported below.`,
    confirmLabel: `Verify & clear ${uploadedFinalsCount.value} files`, danger: true,
  })
  if (!ok) return
  bulkRunning.value = true
  try {
    const r = await post<CleanupResult>(
      `/projects/${slug.value}/storage/bulk-cleanup-final`,
      { all_uploaded: true },
    )
    lastBulkCleanup.value = r
    await loadStorageAudit()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Bulk cleanup failed')
  } finally {
    bulkRunning.value = false
  }
}

async function cleanupRow(row: StorageEntry) {
  if (!row.cleanup_eligible) return
  if (!await ask({
    title: `Verify and clear ${row.episode_code}'s local video?`,
    message: 'Story Studio checks the file matches the accepted YouTube upload before deleting it. If it cannot verify the file, the file stays and you are told why.',
    confirmLabel: 'Verify & clear',
    danger: true,
  })) return
  rowCleanupRunning.value = row.episode_code
  try {
    const result = await post<CleanupResult>(
      `/projects/${slug.value}/storage/cleanup-final/${row.episode_code}`,
      {},
    )
    // A skipped file used to come back as a quiet 200: nothing happened and nothing said so.
    const kept = result?.items?.find(item => item.status !== 'deleted')
    if (result && !result.deleted_count && kept) info(`${row.episode_code}: the local video was kept — ${kept.reason || kept.status}.`)
    else if (result?.deleted_count) success(`${row.episode_code}: freed ${formatBytes(result.bytes_freed)}.`)
    await loadStorageAudit()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Cleanup failed')
  } finally {
    rowCleanupRunning.value = null
  }
}

// v1.0.71: chunked-sidecar scan + cleanup handlers. Mirrors the storage
// audit + bulk-cleanup pattern above but with strict per-episode
// eligibility (unified narration done + chapters_done covers total).
async function scanChunkedSidecars() {
  sidecarScanLoading.value = true
  try {
    sidecarScan.value = await get<SidecarScanResult>(
      `/projects/${slug.value}/storage/chunked-sidecars`,
    )
    lastSidecarCleanup.value = null
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Sidecar scan failed')
  } finally {
    sidecarScanLoading.value = false
  }
}

async function cleanupAllChunkedSidecars() {
  if (!sidecarScan.value || sidecarScan.value.eligible_count === 0) return
  const ok = await ask({
    title: `Remove ${sidecarScan.value.eligible_count} narration progress file(s)?`,
    message: `${formatBytes(sidecarScan.value.reclaimable_bytes)} of small progress files left over from finished narration. ` +
      'Only those files go — chapter documents, audio and everything else stay put.',
    confirmLabel: 'Remove them',
    danger: true,
  })
  if (!ok) return
  sidecarCleanupRunning.value = true
  try {
    lastSidecarCleanup.value = await post<SidecarCleanupResult>(
      `/projects/${slug.value}/storage/cleanup-chunked-sidecars`,
      { all_eligible: true },
    )
    // Re-scan so the table updates (cleaned rows drop out, in-progress
    // ones stay).
    await scanChunkedSidecars()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Sidecar cleanup failed')
  } finally {
    sidecarCleanupRunning.value = false
  }
}

async function cleanupOneSidecar(episode_code: string) {
  if (!await ask({
    title: `Remove ${episode_code}'s narration progress files?`,
    message: 'Only the leftover progress files go; chapter documents and audio stay put.',
    confirmLabel: 'Remove',
    danger: true,
  })) return
  sidecarCleanupRunning.value = true
  try {
    lastSidecarCleanup.value = await post<SidecarCleanupResult>(
      `/projects/${slug.value}/storage/cleanup-chunked-sidecars`,
      { episode_codes: [episode_code] },
    )
    await scanChunkedSidecars()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Sidecar cleanup failed')
  } finally {
    sidecarCleanupRunning.value = false
  }
}


// Move existing HEAVY media to the project's media root. Previews via a dry-run
// first, shows the totals in a confirm, then executes for real.
async function migrateMediaToRoot() {
  if (!mediaRootSavedValue.value) { showError('Set + save an external media root first.'); return }
  if (mediaRootInput.value.trim() !== mediaRootSavedValue.value) { showError('Save your media root change before migrating.'); return }
  mediaMigrateRunning.value = true
  try {
    const plan = await post<MediaMigrationResult>(
      `/projects/${slug.value}/storage/migrate-media-to-external`, { dry_run: true },
    )
    const totalFiles = plan.folders.reduce((s, f) => s + f.files, 0)
    const totalBytes = plan.folders.reduce((s, f) => s + f.bytes, 0)
    if (totalFiles === 0) { info('Nothing to migrate — no media found in the project tree.'); return }
    const ok = await ask({
      title: 'Move project media?',
      message: `Move ${totalFiles} media file(s) (${formatBytes(totalBytes)}) across ${plan.folders.length} folder(s) ` +
      `from the project tree to:\n\n${mediaRootSavedValue.value}\n\n` +
      `Files are copied, verified, then removed from the project tree. ` +
      `Keep the drive connected until it finishes. This is resumable if interrupted.`,
      confirmLabel: `Move ${totalFiles} files`, danger: true,
    })
    if (!ok) return
    const r = await post<MediaMigrationResult>(
      `/projects/${slug.value}/storage/migrate-media-to-external`, { dry_run: false },
    )
    lastMediaMigration.value = r
    if (r.errors.length) showError(`Migrated with ${r.errors.length} error(s) — see details below.`)
    else success(`Migrated ${r.files_moved} file(s) (${formatBytes(r.bytes_moved)}) to the media root.`)
    if (storage.value) await loadStorageAudit()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Media migration failed')
  } finally {
    mediaMigrateRunning.value = false
  }
}

// Load the external root setting on mount so the field is populated
// the first time the user opens the Storage tab.
onMounted(loadExternalRoot)

/**
 * Smooth-scroll to one of the storage subsections from the top-of-tab
 * overview cards. The target IDs are added to the section markers
 * (`projects-root-section`, `external-video-section`,
 * `per-episode-section`). Falls back to no-op when the target doesn't
 * exist (e.g. if a future refactor renames an anchor).
 */
/** The per-episode list lives on the Files tab; this card is on Maintenance, so switch first. */
function openSpaceRecovery() {
  activeTab.value = 'files'
  nextTick(() => scrollTo('per-episode-section'))
}

function scrollTo(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ── Projects storage location (cloud-sync setup) ──────────────────────────
//
// Surfaces the current PROJECTS_ROOT + lets the user pick a new location
// (typically inside iCloud Drive). The "Move + restart" flow is three
// HTTP calls in sequence:
//   1. POST /app-settings/projects-root/migrate { target_path }
//      → copies the projects folder; old location stays in place
//   2. PUT /app-settings/projects-root { override }
//      → persists the new path so next boot reads it
//   3. POST /system/restart-app
//      → relaunches Electron; new path takes effect
//
// Step 2 is split out from the migration call deliberately: we set the
// override AFTER the copy verifies, so a failed migration leaves the
// app pointing at the old (still-intact) location.

/**
 * The Library — one location, replacing the projects-root override (v1.4.3).
 *
 * Changing it is a COPY, done by the same mover the old flow used, then a
 * restart: long-lived state (job queue, watchers, caches) still points at the
 * old place until the app comes back up. The old folder is deliberately left
 * behind — deleting someone's library after copying it is not a decision this
 * app makes.
 */
interface LibraryStatus {
  configured: boolean
  path: string
  exists: boolean
  writable: boolean
  suggested: string
  assets_dir: string
  exports_dir: string
}

const library = ref<LibraryStatus | null>(null)
const projectsRootBusy = ref(false)
const projectsRootStatus = ref('')
const projectsRootStatusKind = ref<'ok' | 'warn' | 'err'>('ok')
const projectsRootPickerHelp = ref('')

async function loadLibrary() {
  try {
    library.value = await get<LibraryStatus>('/library')
  } catch (e: any) {
    projectsRootStatus.value = `Couldn't read your Library location: ${e?.data?.detail || e?.message}`
    projectsRootStatusKind.value = 'err'
  }
}
onMounted(loadLibrary)

/**
 * Archive uploaded videos (v1.4.4) — Library-wide.
 *
 * Preview first, then move. The run is fire-and-poll rather than one long
 * request: 220 GB takes many minutes and any proxy in between would give up
 * long before the copy did.
 */
type ArchiveSkipReason =
  | 'no_code' | 'unknown_channel' | 'ambiguous_channel'
  | 'not_uploaded' | 'not_reviewed' | 'collision'
interface ArchivePreviewRow {
  source_path: string; filename: string; bytes: number; code: string
  slug?: string; youtube_video_id?: string
  status: 'ready' | 'skipped'; reason?: string; reason_code?: ArchiveSkipReason
}
interface ArchivePreviewResult {
  source_root: string; source_exists: boolean
  complete: boolean; cancelled: boolean
  candidates: ArchivePreviewRow[]
  ready_count: number; ready_bytes: number
  skipped_count: number; skipped_bytes: number
  by_channel: Array<{ slug: string; count: number; bytes: number }>
}

const archiveSource = ref('')
const archiveDest = ref('')
const archiveBusy = ref(false)
const archiveRunning = ref(false)
const archiveChecking = ref(false)
const archivePicking = ref(false)
const archiveStopping = ref(false)
const archiveStage = ref<'checking' | 'moving' | null>(null)
const archivePreview = ref<ArchivePreviewResult | null>(null)
const archiveResult = ref<any>(null)
const archiveProgress = ref({ done: 0, total: 0, checked: 0, current: '' })
let archivePoll: ReturnType<typeof setInterval> | null = null
let archivePollInFlight = false
let archiveRestoreInFlight = false
let archivePanelDisposed = false

const archiveSkippedRows = computed(
  () => (archivePreview.value?.candidates || []).filter(c => c.status === 'skipped'),
)
const archiveReadyRows = computed(
  () => (archivePreview.value?.candidates || []).filter(c => c.status === 'ready'),
)

/**
 * What the skipped pile is actually made of, in his words.
 *
 * The confirm dialog used to describe every skip as "not confirmed uploaded".
 * That was wrong twice: files with no episode code at all were counted as
 * unproven uploads (his TerenceGaming folder is full of them), and until
 * v1.4.10 the sentence's promise — that nothing unproven would be touched —
 * was not true across channels. Say what is true instead.
 */
const archiveSkipSummary = computed(() => {
  const counts: Record<string, number> = {}
  for (const row of archiveSkippedRows.value) {
    const key = row.reason_code || 'other'
    counts[key] = (counts[key] || 0) + 1
  }
  const phrases: string[] = []
  const say = (key: string, one: string, many: string) => {
    const n = counts[key]
    if (n) phrases.push(`${n} ${n === 1 ? one : many}`)
  }
  say('not_uploaded', 'is not confirmed uploaded', 'are not confirmed uploaded')
  say('no_code', 'has no episode code', 'have no episode code')
  say('unknown_channel', 'cannot be tied to a channel', 'cannot be tied to a channel')
  say('ambiguous_channel', 'sits where more than one channel could own it',
    'sit where more than one channel could own them')
  say('other', 'is skipped for another reason', 'are skipped for other reasons')
  return phrases
})

async function pickArchiveSource() {
  if (archivePicking.value || archiveBusy.value) return
  archivePicking.value = true
  try {
    const p = await pickFolderShared({ title: 'Where are your finished videos?', button_label: 'Scan This Folder' })
    if (p) { archiveSource.value = p; archivePreview.value = null }
  } catch (e: any) {
    showError(pickerHelpFor(e))
  } finally {
    archivePicking.value = false
  }
}
async function pickArchiveDest() {
  if (archivePicking.value || archiveBusy.value) return
  archivePicking.value = true
  try {
    const p = await pickFolderShared({ title: 'Move finished videos into…', button_label: 'Move Here' })
    if (p) archiveDest.value = p
  } catch (e: any) {
    showError(pickerHelpFor(e))
  } finally {
    archivePicking.value = false
  }
}

async function loadArchivePreview() {
  if (archiveBusy.value || archivePicking.value) return
  archiveBusy.value = true
  archiveChecking.value = true
  archiveRunning.value = false
  archiveStopping.value = false
  archiveStage.value = 'checking'
  archiveProgress.value = { done: 0, total: 0, checked: 0, current: '' }
  archiveResult.value = null
  archivePreview.value = null
  try {
    await post('/library/archive/preview', {
      source_root: archiveSource.value.trim() || undefined,
    })
    if (archivePoll) clearInterval(archivePoll)
    archivePoll = setInterval(pollArchive, 1000)
    void pollArchive()
  } catch (e: any) {
    archiveChecking.value = false
    archiveStage.value = null
    archiveBusy.value = false
    showError(e?.data?.detail || e?.message || 'Could not check the folder')
  }
}

async function startArchive() {
  if (archiveBusy.value || archivePicking.value) return
  const preview = archivePreview.value
  if (!preview?.complete) return
  const approved = preview.candidates.filter(c => c.status === 'ready').map(c => c.source_path)
  const staying = archiveSkipSummary.value.length
    ? `${preview.skipped_count} video(s) stay where they are — ${archiveSkipSummary.value.join(', ')}.`
    : 'Nothing else in that folder is affected.'
  const ok = await ask({
    title: 'Move finished videos?',
    message: `${preview.ready_count} video(s) — ${formatBytes(preview.ready_bytes)} — will be COPIED to\n`
      + `  ${archiveDest.value}\n\n`
      + `Each one is checked at the destination before the original is removed, so nothing is lost `
      + `if the copy fails.\n\n`
      + `${staying}\n\n`
      + `Only the ${preview.ready_count} listed above will be moved — anything added to the folder `
      + `after this check is left alone.`,
    confirmLabel: 'Move them',
  })
  if (!ok) return

  archiveBusy.value = true
  archiveRunning.value = true
  archiveChecking.value = false
  archiveStopping.value = false
  archiveStage.value = 'checking'
  archiveProgress.value = { done: 0, total: approved.length, checked: 0, current: '' }
  archiveResult.value = null
  try {
    await post('/library/archive/run', {
      destination: archiveDest.value.trim(),
      // Bind the move to the root that produced this bill. Editing the input
      // after a completed review must not substitute a different folder.
      source_root: preview.source_root,
      // The reviewed set. The server re-checks each one's upload proof and can
      // only get stricter, but it will not move anything outside this list.
      approved,
    })
    if (archivePoll) clearInterval(archivePoll)
    archivePoll = setInterval(pollArchive, 1000)
    void pollArchive()
  } catch (e: any) {
    archiveRunning.value = false
    archiveBusy.value = false
    archiveStage.value = null
    showError(e?.data?.detail || e?.message || 'Could not start the sweep')
  }
}

function applyArchiveStatus(st: any): boolean {
  const phase = st.phase === 'preview' || st.phase === 'run' ? st.phase : null
  // A fresh server has no archive operation to restore. Do not turn that into
  // an empty result or a fake stopped scan when Settings first opens.
  if (!st.running && !phase) return false

  archiveStage.value = st.stage || null
  archiveProgress.value = {
    done: st.done || 0, total: st.total || 0, checked: st.checked || 0, current: st.current || '',
  }
  archiveStopping.value = !!st.stopping
  archiveBusy.value = !!st.running
  archiveChecking.value = !!st.running && phase === 'preview'
  archiveRunning.value = !!st.running && phase === 'run'
  if (st.running) return true

  if (archivePoll) { clearInterval(archivePoll); archivePoll = null }
  archiveStage.value = null
  if (phase === 'preview') {
    archivePreview.value = st.result || null
    archiveResult.value = null
  } else {
    archiveResult.value = st.result
    archivePreview.value = null
  }
  if (st.error) showError(st.error)
  return true
}

async function pollArchive() {
  if (archivePollInFlight) return
  archivePollInFlight = true
  try {
    applyArchiveStatus(await get<any>('/library/archive/status'))
  } catch { /* transient — keep polling */ }
  finally { archivePollInFlight = false }
}

async function stopArchive() {
  archiveStopping.value = true
  try { await post('/library/archive/stop', {}) } catch { /* best effort */ }
}

async function restoreArchiveInFlight() {
  if (archiveBusy.value || archivePoll || archiveRestoreInFlight || archivePanelDisposed) return
  archiveRestoreInFlight = true
  try {
    const st = await get<any>('/library/archive/status')
    if (archivePanelDisposed || archiveBusy.value || archivePoll) return
    if (applyArchiveStatus(st) && st.running) archivePoll = setInterval(pollArchive, 1000)
  } catch { /* the archive panel remains idle until its next explicit action */ }
  finally { archiveRestoreInFlight = false }
}

onBeforeUnmount(() => {
  archivePanelDisposed = true
  if (archivePoll) clearInterval(archivePoll)
  archivePoll = null
})

async function browseAndMoveLibrary() {
  projectsRootPickerHelp.value = ''
  let picked: string | null
  try {
    picked = await pickFolderShared({
      title: 'Choose where to keep your Library',
      button_label: 'Use This Folder',
    })
  } catch (e: any) {
    projectsRootPickerHelp.value = e?.data?.detail || e?.message || 'Could not open the folder picker.'
    return
  }
  if (!picked) return

  const ok = await ask({
    title: 'Move your Library?',
    message: `To: ${picked}\n\nEvery channel, your shared assets and your exports are COPIED there. ` +
      'The current folder is left exactly as it is, so nothing can be lost — you can delete it yourself once you have checked the new one. ' +
      'Story Studio restarts afterwards.',
    confirmLabel: 'Copy and restart',
  })
  if (!ok) return

  projectsRootBusy.value = true
  projectsRootStatus.value = 'Copying your Library…'
  projectsRootStatusKind.value = 'ok'
  try {
    await put('/library', { path: picked, move: true })
    projectsRootStatus.value = '✓ Moved. Restarting…'
    setTimeout(async () => {
      try { await post('/system/restart-app', {}) } catch (e: any) {
        if (e?.status === 503) {
          showError('App is in dev mode and can\'t auto-restart. Quit and start it again to use the new Library.')
        } else {
          showError(`Restart failed: ${e?.data?.detail || e?.message}. Quit and reopen manually.`)
        }
      }
    }, 600)
  } catch (e: any) {
    projectsRootStatus.value = `Move failed: ${e?.data?.detail || e?.message}`
    projectsRootStatusKind.value = 'err'
    projectsRootBusy.value = false
  }
}


// v1.0.150 — The Chatterbox standalone provider was removed. All the
// chatterbox* state, loaders, savers, test-connection, and reference-upload
// handlers that used to live here have been deleted. Old project.json
// files keep their chatterbox_enabled / chatterbox_reference_id fields on
// disk (we marked the types @deprecated) — nothing reads them anymore.

// v1.0.150 — onChatterboxReferenceFile + the config watcher hydrating
// chatterbox_enabled / chatterbox_reference_id were deleted together with
// the rest of the Chatterbox integration. The fields still exist on
// disk for legacy projects (see types.ts @deprecated tags) but nothing
// in the frontend reads them.

watch(activeTab, (t) => {
  // Item J — lazy-load the YouTube category list when the user enters
  // Publishing so the dropdown is populated without a click. Cached
  // 7d on the backend, so the cost is one extra fetch per session at
  // most (and usually zero — fully cache-served).
  if (t === 'publishing' && !ytCategoryList.value.length) {
    void loadYoutubeCategoryList()
  }
  if (t === 'publishing' && !ytAppDefaults.value) {
    void loadYoutubeAppDefaults()
  }
  if (t === 'maintenance') {
    // F-04 (DS-11) — entering the tab that owns the FFmpeg card must fetch the
    // real status before the card can propose an install or recovery download.
    // Re-probing only while the answer is unknown keeps the explicit
    // "Re-check status" button meaningful and avoids a hidden fetch per visit.
    if (!ffmpegStatus.value && !ffmpegStatusLoading.value) void refreshFfmpegStatus()
    void restoreArchiveInFlight()
  }
  // v1.0.107+ — load location status so the "Unlink from this Mac"
  // danger-zone renders only when the project is actually linked.

})

// ── Item J — YouTube videoCategories.list state ────────────────────────
// Direct fetch via `get` rather than instantiating the full
// useUploadAccounts composable here (which pulls a lot of unrelated
// state into Settings). The endpoint handles 7d caching + soft fallback
// server-side.
interface YtCategoriesResponse {
  source: 'cache' | 'live' | 'stale' | 'empty'
  region: string
  fetched_at?: string
  categories: Array<{ id: string; title: string }>
  hint?: string
}
const ytCategoryList = ref<Array<{ id: string; title: string }>>([])
const ytCategorySource = ref<'cache' | 'live' | 'stale' | 'empty' | ''>('')
const ytCategoryHint = ref<string>('')
const ytCategoryLoading = ref(false)
async function loadYoutubeCategoryList() {
  ytCategoryLoading.value = true
  ytCategoryHint.value = ''
  try {
    const r = await get<YtCategoriesResponse>(`/projects/${slug.value}/upload/youtube-categories?region=US`)
    ytCategoryList.value = r.categories || []
    ytCategorySource.value = (r.source || '') as any
    ytCategoryHint.value = r.hint || ''
  } catch (e: any) {
    ytCategoryHint.value = e?.data?.detail || e?.message || 'Failed to load categories'
  } finally {
    ytCategoryLoading.value = false
  }
}

// ── v1.0.77 — AI / Synthetic content disclosure + backfill ──────────────────
//
// `aiDisclosureSelection` is a UI-only tri-state that maps to the per-project
// `mark_as_ai_generated` boolean (or undefined for "use app default"). The
// app-level fallback is fetched on tab-open so the dropdown can show the
// resolved default to the user.
interface YtAppDefaults {
  default_mark_as_ai_generated: boolean
  default_yt_category_id: number
}
const ytAppDefaults = ref<YtAppDefaults | null>(null)
const aiDisclosureSelection = computed<'on' | 'off' | 'default'>({
  get() {
    const v = projectForm.mark_as_ai_generated
    if (v === true) return 'on'
    if (v === false) return 'off'
    return 'default'
  },
  set(value) {
    if (value === 'on') projectForm.mark_as_ai_generated = true
    else if (value === 'off') projectForm.mark_as_ai_generated = false
    else projectForm.mark_as_ai_generated = undefined
  },
})

interface YtBackfillRow {
  episode_code: string
  video_id: string
  action: 'updated' | 'skipped' | 'failed' | 'missing'
  changed?: Record<string, unknown>
  reason?: string
  error?: string
}
interface YtBackfillResp {
  scanned: number
  eligible: number
  updated: number
  skipped: number
  failed: number
  missing?: number
  dry_run?: boolean
  message?: string
  details?: YtBackfillRow[]
}
const ytBackfillBusy = ref<'' | 'preview' | 'apply'>('')
const ytBackfillResult = ref<YtBackfillResp | null>(null)

async function loadYoutubeAppDefaults() {
  try {
    ytAppDefaults.value = await get<YtAppDefaults>('/app-settings/youtube-defaults')
  } catch { /* non-fatal — dropdown just shows "ON" as the assumed default */ }
}

async function runYoutubeBackfill(dryRun: boolean) {
  ytBackfillBusy.value = dryRun ? 'preview' : 'apply'
  try {
    // If the user changed the AI toggle in the UI but hasn't hit Save yet,
    // the backfill would use the LAST-SAVED value — confusing. Force a
    // save first so the in-flight selection is what gets backfilled.
    // A failed save must stop here: otherwise every uploaded video is updated
    // from the OLD saved values while the form shows the new ones.
    if (!await saveProject('publishing')) return
    const r = await post<YtBackfillResp>(
      `/projects/${slug.value}/upload/youtube-backfill`,
      { dry_run: dryRun },
    )
    ytBackfillResult.value = r
    if (!dryRun) {
      if (r.updated > 0) success(`Updated ${r.updated} YouTube video${r.updated === 1 ? '' : 's'}.`)
      else info('No videos needed updating.')
    }
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Backfill failed')
  } finally {
    ytBackfillBusy.value = ''
  }
}

function onYoutubeBackfillPreview() { void runYoutubeBackfill(true) }
async function onYoutubeBackfillApply() {
  if (!await ask({ title: 'Update every uploaded video?', message: 'Apply the current AI disclosure and category to every uploaded video? This costs 50 YouTube quota units per video. Privacy and schedule are preserved.', confirmLabel: 'Apply to all', danger: true })) return
  await runYoutubeBackfill(false)
}

const tabZones = [
  {
    id: 'machine',
    title: 'This Mac',
    scope: 'Stays on this Mac',
    sections: [
      { id: 'connections', label: 'Connections', description: 'Gateway and YouTube accounts', keywords: 'gateway genstudio api key oauth models catalog channel' },
      { id: 'performance', label: 'Performance & recovery', description: 'Local workload and retry choices', keywords: 'throughput concurrency failed image subtitles timeout' },
      { id: 'appearance', label: 'Appearance & notifications', description: 'Display, access, text and alerts', keywords: 'theme remote server emoji telegram digest' },
      { id: 'maintenance', label: 'Files & maintenance', description: 'Shared Library, exports and diagnostics', keywords: 'ffmpeg about version archive storage' },
    ],
  },
  {
    id: 'project',
    title: 'This Project',
    scope: 'Travels with this project',
    sections: [
      { id: 'identity', label: 'Channel identity', description: 'Series Formula and Topic Packs', keywords: 'niche formula topics custom' },
      { id: 'production', label: 'Production defaults', description: 'Continuity, narration quality and episode shape', keywords: 'guide references chapters runtime motion audio voice transcript quality repair' },
      { id: 'writing', label: 'Writing & style', description: 'Instructions, intros and visual style', keywords: 'standards prompts art presets' },
      { id: 'publishing', label: 'Publishing', description: 'Channel assignment, profile and cadence', keywords: 'youtube upload schedule metadata category' },
      { id: 'files', label: 'Project files & behavior', description: 'Folders, storage, numbering and confirmations', keywords: 'episodes group archive cleanup paths' },
    ],
  },
]

const tabs = tabZones.flatMap(zone => zone.sections)
const settingsHashTargetIds = settingsAnchorTargetIds(tabs.map(tab => tab.id))
const inactiveSettingsHashTargets = computed(() => settingsHashTargetIds.filter(id => id !== activeTab.value))

// v1.0.186 (S3) — the zone (This Mac / This Project) that owns the active tab.
// Drives the in-page scope banner so the user always sees whether the panel
// they're editing is per-machine or per-project.
const activeZone = computed(() =>
  tabZones.find(zone => zone.sections.some(section => section.id === activeTab.value)) || null,
)

const activeTabMeta = computed(() => tabs.find(tab => tab.id === activeTab.value) || null)

// ── FFmpeg tab state ─────────────────────────────────────────────────────
// The backend exposes a self-contained installer at POST /ffmpeg/install
// that downloads the binary from the official release mirror into the app's
// user-data directory. No brew / sudo / Terminal needed. Status is fetched
// at GET /ffmpeg/status. Other generator pages link here via the URL hash
// `#ffmpeg` — see `route.hash` watcher below for the auto-tab-switch.
interface FfmpegStatus {
  installed: boolean
  version?: string
  source?: 'bundled' | 'app-data' | 'system' | 'not-found'
  has_drawtext?: boolean
  has_libass?: boolean
  path?: string
}
const ffmpegStatus = ref<FfmpegStatus | null>(null)
const ffmpegStatusLoading = ref(false)
// F-04 (DS-11) — the FFmpeg card proposes an install/recovery download from
// `ffmpegStatus.installed === false`, and a failed status check used to be
// written as exactly that (`{ installed: false }`). "I could not check" must
// not become "not installed" (AGENTS.md §6), and no install action may be
// offered for a status that was never read. `null` status = unknown.
const ffmpegStatusError = ref('')
const ffmpegInstalling = ref(false)
const ffmpegInstallProgress = ref(0)
const ffmpegInstallMessage = ref('')
const ffmpegInstallError = ref(false)

// Install-log fetch state. Populated on demand (after a failed install
// the user clicks "Show install log") rather than auto-loaded so a
// successful run doesn't hit the log endpoint unnecessarily.
interface InstallLogEntry { ts: string; level: string; message: string; phase?: string; error?: string; code?: string; stack?: string; [k: string]: any }
const ffmpegInstallLog = ref<InstallLogEntry[]>([])
const ffmpegInstallLogChecked = ref(false)
const ffmpegLogLoading = ref(false)
const ffmpegLogCopiedAt = ref(0)

// Restart prompt — shown after the in-app installer succeeds OR after a
// Re-check status flips the badges from missing → installed. The renderer
// keeps a stale "ffmpeg not found" state for some pages until the whole
// app restarts; one explicit relaunch saves the user from "I installed
// it but it's still broken" confusion.
const showFfmpegRestartPrompt = ref(false)
const restarting = ref(false)
const ffmpegInstallLogText = computed(() => {
  // Render entries as one-line-per-event with phase + duration + key
  // fields, then a separate stack/error block when present. Format
  // chosen so the user can paste into a chat/issue without further
  // formatting, and the assistant can scan it quickly.
  return ffmpegInstallLog.value.map(e => {
    const ts = e.ts || '?'
    const phase = e.phase || (e.message.split(':').slice(1).join(':') || '?')
    const ms = typeof e.ms === 'number' ? ` (${e.ms}ms)` : ''
    const errBits: string[] = []
    if (e.code) errBits.push(`code=${e.code}`)
    if (e.error) errBits.push(`error="${e.error}"`)
    const head = `[${ts}] ${e.level.toUpperCase()} ${phase}${ms}${errBits.length ? ' · ' + errBits.join(' ') : ''}`
    return e.stack ? `${head}\n  ${e.stack.split('\n').slice(0, 6).join('\n  ')}` : head
  }).join('\n')
})

async function refreshFfmpegStatus() {
  // Capture the previous state so we can detect a "missing → installed"
  // flip after the user installed ffmpeg externally (brew, manual). When
  // that happens, surface the restart prompt automatically — same UX as
  // the in-app installer success path.
  const wasMissing = !!ffmpegStatus.value && !ffmpegStatus.value.installed
  ffmpegStatusLoading.value = true
  ffmpegStatusError.value = ''
  try {
    ffmpegStatus.value = await get<FfmpegStatus>('/ffmpeg/status')
    if (wasMissing && ffmpegStatus.value.installed) {
      showFfmpegRestartPrompt.value = true
    }
  } catch (e: any) {
    // Unknown, not missing. The card keeps the installer closed and shows the
    // failure with a Retry instead of inviting a download it cannot justify.
    ffmpegStatus.value = null
    ffmpegStatusError.value = e?.data?.detail || e?.message || 'Could not check FFmpeg'
  } finally {
    ffmpegStatusLoading.value = false
  }
}

async function installFfmpeg() {
  if (ffmpegInstalling.value) return
  if (ffmpegStatus.value?.installed && ffmpegStatus.value.source === 'bundled') {
    success('Bundled FFmpeg is already verified — no download is needed')
    return
  }
  ffmpegInstalling.value = true
  ffmpegInstallProgress.value = 0
  ffmpegInstallError.value = false
  ffmpegInstallMessage.value = 'Starting download…'

  // Poll the install-progress endpoint every second while the POST is in
  // flight. The POST is synchronous (waits for the whole download to
  // finish), so without polling the user sees a frozen progress bar for
  // up to 5 minutes. The polling endpoint reads the same in-memory state
  // that downloadFFmpeg writes to on every phase transition.
  let pollHandle: ReturnType<typeof setInterval> | null = null
  pollHandle = setInterval(async () => {
    try {
      const p = await get<{ status: string; phase?: string; percent: number; message: string; error?: string }>('/ffmpeg/install-progress')
      if (typeof p.percent === 'number') ffmpegInstallProgress.value = p.percent
      if (p.message) ffmpegInstallMessage.value = p.message
      if (p.status === 'done' || p.status === 'error' || p.status === 'idle') {
        if (pollHandle) { clearInterval(pollHandle); pollHandle = null }
      }
    } catch { /* polling is best-effort */ }
  }, 1000)

  try {
    const result = await post<{ ok: boolean; path: string; status: FfmpegStatus }>('/ffmpeg/install', {})
    ffmpegInstallProgress.value = 100
    ffmpegInstallMessage.value = `Installed to ${result.path}`
    ffmpegStatus.value = result.status
    showFfmpegRestartPrompt.value = true
    success('FFmpeg installed successfully')
  } catch (e: any) {
    ffmpegInstallError.value = true
    ffmpegInstallMessage.value = e?.data?.detail || e?.message || 'Install failed — see manual instructions below'
    showError('FFmpeg install failed')
  } finally {
    if (pollHandle) clearInterval(pollHandle)
    ffmpegInstalling.value = false
  }
}

async function restartApp() {
  if (restarting.value) return
  restarting.value = true
  try {
    // Backend responds with `{ ok: true }`, then triggers `app.relaunch()
    // + app.exit(0)` after a 200ms grace. The fetch resolves before the
    // process dies, then the renderer is killed by the relaunch — Nuxt
    // boots fresh on the new process and lands the user back on this
    // same page (the URL is preserved by Electron's restoreSession).
    await post('/app/restart', {})
    // Don't reset `restarting` — the page is about to be replaced, and
    // showing the spinner during the brief relaunch window is the
    // correct affordance.
  } catch (e: any) {
    restarting.value = false
    showError(e?.data?.detail || 'Restart failed — please quit and reopen the app manually.')
  }
}

async function loadInstallLog() {
  ffmpegLogLoading.value = true
  ffmpegInstallLogChecked.value = true
  try {
    const resp = await get<{ entries: InstallLogEntry[]; path: string; total?: number; message?: string }>('/ffmpeg/install-log')
    ffmpegInstallLog.value = resp.entries || []
  } catch (e: any) {
    showError('Could not load install log: ' + (e?.data?.detail || e?.message || 'unknown'))
    ffmpegInstallLog.value = []
  } finally {
    ffmpegLogLoading.value = false
  }
}

async function copyInstallLog() {
  // Bundle the log entries WITH platform info so a recipient (assistant
  // or support engineer) doesn't have to ask "what arch / OS / app
  // version?" as a follow-up. Browsing this clipboard payload should
  // be enough to triage 90% of install failures.
  const platformInfo = [
    `Platform: ${navigator.platform || 'unknown'}`,
    `User agent: ${navigator.userAgent || 'unknown'}`,
    `App URL: ${window.location.origin}`,
    `Captured at: ${new Date().toISOString()}`,
  ].join('\n')
  const body = `=== Story Studio FFmpeg install log ===\n${platformInfo}\n\n--- log entries (${ffmpegInstallLog.value.length}) ---\n${ffmpegInstallLogText.value}\n=== end ===`
  try {
    await navigator.clipboard.writeText(body)
    ffmpegLogCopiedAt.value = Date.now()
    setTimeout(() => { if (Date.now() - ffmpegLogCopiedAt.value >= 2500) ffmpegLogCopiedAt.value = 0 }, 2700)
  } catch {
    showError('Could not copy — select the text in the log box and copy manually.')
  }
}

// Open external URLs in the system browser instead of the Electron window
// (which doesn't load arbitrary domains by default and would just blank out).
function openExternal(url: string) {
  if (typeof window !== 'undefined' && (window as any).require) {
    try {
      const { shell } = (window as any).require('electron')
      shell.openExternal(url)
      return
    } catch { /* fall through to web fallback */ }
  }
  window.open(url, '_blank', 'noopener')
}

const _route = useRoute()
function applyHash() {
  const rawTarget = (_route.hash || '').toLowerCase().replace(/^#/, '')
  const target = resolveSettingsSectionHash(rawTarget, tabs.map(tab => tab.id))
  if (!target) return
  activeTab.value = target
  if (rawTarget === 'free-up-space') {
    nextTick(() => document.getElementById('free-up-space')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }
  if (rawTarget === 'ffmpeg') {
    refreshFfmpegStatus()
    nextTick(() => {
      document.getElementById('ffmpeg-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }
}
onMounted(() => {
  applyHash()
  if (activeTab.value === 'maintenance') {
    refreshFfmpegStatus()
    void restoreArchiveInFlight()
  }

  loadNotifSettings()
})
watch(() => _route.hash, applyHash)

// ── Notifications tab (app-level, not per-project) ─────────────────────
// Backed by `/api/app-settings/notifications`. Edits are staged locally and
// committed together so a quick series of toggles cannot race overlapping
// PUT responses and restore an older value.
interface TelegramConfigUI { enabled: boolean; bot_token: string; chat_id: string }
interface EventsConfigUI { pipeline_finished: boolean; failures: boolean; long_job: boolean }
interface DigestConfigUI {
  enabled: boolean
  time_local: string
  desktop_enabled: boolean
  telegram_enabled: boolean
  quiet_when_empty?: boolean
  last_fired_date?: string
}
interface NotifSettings {
  enabled: boolean
  min_duration_ms: number
  events: EventsConfigUI
  telegram: TelegramConfigUI
  digest: DigestConfigUI
}
function defaultEvents(): EventsConfigUI { return { pipeline_finished: true, failures: true, long_job: true } }
const notifSettings = ref<NotifSettings>({
  enabled: true,
  min_duration_ms: 300_000,
  events: defaultEvents(),
  telegram: { enabled: false, bot_token: '', chat_id: '' },
  digest: { enabled: false, time_local: '09:00', desktop_enabled: true, telegram_enabled: true, quiet_when_empty: false },
})
const savedNotifSettings = ref<NotifSettings | null>(null)
const showTelegramToken = ref(false)
const notifSaveStatus = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')
const notifSaveError = ref('')
function cloneNotifSettings(value: NotifSettings): NotifSettings {
  return JSON.parse(JSON.stringify(value)) as NotifSettings
}
function normalizeNotifSettings(raw: Partial<NotifSettings> | null | undefined): NotifSettings {
  return {
    enabled: !!raw?.enabled,
    min_duration_ms: typeof raw?.min_duration_ms === 'number' ? raw.min_duration_ms : 300_000,
    events: raw?.events
      ? {
          pipeline_finished: raw.events.pipeline_finished !== false,
          failures: raw.events.failures !== false,
          long_job: raw.events.long_job !== false,
        }
      : defaultEvents(),
    telegram: raw?.telegram
      ? {
          enabled: !!raw.telegram.enabled,
          bot_token: raw.telegram.bot_token || '',
          chat_id: raw.telegram.chat_id || '',
        }
      : { enabled: false, bot_token: '', chat_id: '' },
    digest: raw?.digest
      ? {
          enabled: !!raw.digest.enabled,
          time_local: raw.digest.time_local || '09:00',
          desktop_enabled: raw.digest.desktop_enabled !== false,
          telegram_enabled: raw.digest.telegram_enabled !== false,
          quiet_when_empty: !!raw.digest.quiet_when_empty,
          last_fired_date: raw.digest.last_fired_date,
        }
      : { enabled: false, time_local: '09:00', desktop_enabled: true, telegram_enabled: true, quiet_when_empty: false },
  }
}
const notificationsDirty = computed(() =>
  !!savedNotifSettings.value
  && JSON.stringify(notifSettings.value) !== JSON.stringify(savedNotifSettings.value),
)
const telegramConfigured = computed(() =>
  !!notifSettings.value.telegram.bot_token.trim() && !!notifSettings.value.telegram.chat_id.trim(),
)
const telegramReady = computed(() => notifSettings.value.telegram.enabled && telegramConfigured.value)
const telegramStatusText = computed(() => {
  if (!notifSettings.value.telegram.enabled) return 'Not enabled'
  if (!notifSettings.value.telegram.bot_token.trim()) return 'Bot token needed'
  if (!notifSettings.value.telegram.chat_id.trim()) return 'Chat connection needed'
  return 'Connected for remote alerts'
})
const digestHasReadyDestination = computed(() =>
  (notifSettings.value.digest.desktop_enabled && notifSettings.value.enabled)
  || (notifSettings.value.digest.telegram_enabled && telegramReady.value),
)
const digestReady = computed(() => notifSettings.value.digest.enabled && digestHasReadyDestination.value)
const digestStatusText = computed(() => {
  if (!notifSettings.value.digest.enabled) return 'Not scheduled'
  if (!digestHasReadyDestination.value) return 'Choose an active destination'
  return `Daily at ${notifSettings.value.digest.time_local || '09:00'}`
})
const notificationReadinessLabel = computed(() => {
  const count = Number(notifSettings.value.enabled) + Number(telegramReady.value)
  return count === 0 ? 'Alerts muted' : `${count} channel${count === 1 ? '' : 's'} active`
})
const enabledNotificationEventCount = computed(() =>
  Object.values(notifSettings.value.events).filter(Boolean).length,
)
const formattedDigestLastFired = computed(() => {
  const raw = notifSettings.value.digest.last_fired_date
  if (!raw) return 'Never'
  const date = new Date(`${raw}T00:00:00`)
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : raw
})
const notifMinDurationMinutes = computed({
  get: () => Math.max(1, Math.round(notifSettings.value.min_duration_ms / 60_000)),
  set: (v: number) => {
    const m = Math.max(1, Math.min(60, Math.round(Number(v) || 1)))
    notifSettings.value.min_duration_ms = m * 60_000
  },
})
async function loadNotifSettings() {
  try {
    const r = await get<NotifSettings>('/app-settings/notifications')
    notifSettings.value = normalizeNotifSettings(r)
    savedNotifSettings.value = cloneNotifSettings(notifSettings.value)
    notifSaveStatus.value = 'idle'
    notifSaveError.value = ''
  } catch { /* leave defaults */ }
}
function discardNotificationChanges() {
  if (!savedNotifSettings.value) return
  notifSettings.value = cloneNotifSettings(savedNotifSettings.value)
  notifSaveStatus.value = 'idle'
  notifSaveError.value = ''
  telegramDetectResult.value = null
  telegramTestResult.value = null
  digestSendResult.value = null
}
function applyRecommendedNotifications() {
  notifSettings.value.enabled = true
  notifSettings.value.min_duration_ms = 5 * 60_000
  notifSettings.value.events = defaultEvents()
}
async function saveNotifSettings(): Promise<boolean> {
  notifSaveStatus.value = 'saving'
  notifSaveError.value = ''
  try {
    const saved = await put<NotifSettings>('/app-settings/notifications', {
      enabled: notifSettings.value.enabled,
      min_duration_ms: notifSettings.value.min_duration_ms,
      events: {
        pipeline_finished: notifSettings.value.events.pipeline_finished,
        failures: notifSettings.value.events.failures,
        long_job: notifSettings.value.events.long_job,
      },
      telegram: {
        enabled: notifSettings.value.telegram.enabled,
        bot_token: notifSettings.value.telegram.bot_token,
        chat_id: notifSettings.value.telegram.chat_id,
      },
      digest: {
        enabled: notifSettings.value.digest.enabled,
        time_local: notifSettings.value.digest.time_local,
        desktop_enabled: notifSettings.value.digest.desktop_enabled,
        telegram_enabled: notifSettings.value.digest.telegram_enabled,
        quiet_when_empty: notifSettings.value.digest.quiet_when_empty,
      },
    })
    notifSettings.value = normalizeNotifSettings(saved)
    savedNotifSettings.value = cloneNotifSettings(notifSettings.value)
    notifSaveStatus.value = 'saved'
    stampSaved('notifications')
    return true
  } catch (e: any) {
    notifSaveError.value = e?.data?.detail || e?.message || 'Unknown error'
    notifSaveStatus.value = 'error'
    return false
  }
}

// Telegram test-message round-trip. Sends with the values currently
// in the form (NOT the saved values) so the user can verify a token
// before committing it. Result is shown inline next to the button.
const telegramTestBusy = ref(false)
const telegramTestResult = ref<{ ok: boolean; error?: string } | null>(null)
async function testTelegram() {
  telegramTestBusy.value = true
  telegramTestResult.value = null
  try {
    const r = await post<{ ok: boolean; status: number; error?: string }>(
      '/app-settings/notifications/telegram-test',
      {
        bot_token: notifSettings.value.telegram.bot_token,
        chat_id: notifSettings.value.telegram.chat_id,
      },
    )
    telegramTestResult.value = { ok: !!r.ok, error: r.error }
  } catch (e: any) {
    telegramTestResult.value = {
      ok: false,
      error: e?.data?.detail || e?.data?.error || e?.message || 'Send failed',
    }
  } finally {
    telegramTestBusy.value = false
  }
}

// Daily digest preview + manual send-now (v1.0.62+). Preview hits a
// read-only endpoint that builds the digest body without dispatching;
// Send Now actually fires through whichever channels are routed on.
const digestPreviewBusy = ref(false)
const digestPreview = ref<{ title: string; body: string } | null>(null)
const digestSendNowBusy = ref(false)
const digestSendResult = ref<{ ok: boolean; reason?: string } | null>(null)
async function loadDigestPreview() {
  digestPreviewBusy.value = true
  try {
    const r = await get<{ payload: { title: string; body: string } }>(
      '/app-settings/notifications/digest-preview',
    )
    digestPreview.value = r.payload
  } catch (e: any) {
    digestPreview.value = {
      title: 'Preview failed',
      body: e?.data?.detail || e?.message || 'Could not build digest.',
    }
  } finally {
    digestPreviewBusy.value = false
  }
}
async function sendDigestNow() {
  digestSendNowBusy.value = true
  digestSendResult.value = null
  try {
    if (notificationsDirty.value && !await saveNotifSettings()) return
    const r = await post<{ ok: boolean; reason?: string; payload?: { title: string; body: string } }>(
      '/app-settings/notifications/send-digest-now',
      {},
    )
    digestSendResult.value = { ok: !!r.ok, reason: r.reason }
    // Mirror the dispatched body into the preview pane so the user can
    // confirm what just got sent without round-tripping through Telegram.
    if (r.ok && r.payload) digestPreview.value = r.payload
  } catch (e: any) {
    digestSendResult.value = {
      ok: false,
      reason: e?.data?.detail || e?.message || 'Send failed',
    }
  } finally {
    digestSendNowBusy.value = false
  }
}

// Auto-detect chat id by reading the bot's recent messages — saves
// the user from having to open `https://api.telegram.org/bot<TOKEN>/getUpdates`
// and parse JSON by hand. Empty result usually means the user hasn't
// sent /start to their bot yet; the inline message tells them so.
const telegramDetectBusy = ref(false)
const telegramDetectResult = ref<{
  ok: boolean
  chat_id?: string
  chat_label?: string
  error?: string
} | null>(null)
async function detectTelegramChatId() {
  telegramDetectBusy.value = true
  telegramDetectResult.value = null
  try {
    const r = await post<{
      ok: boolean
      chat_id?: string
      chat_label?: string
      total_updates?: number
      error?: string
    }>(
      '/app-settings/notifications/telegram-detect-chat-id',
      { bot_token: notifSettings.value.telegram.bot_token },
    )
    telegramDetectResult.value = {
      ok: !!r.ok,
      chat_id: r.chat_id,
      chat_label: r.chat_label,
      error: r.error,
    }
    // Auto-fill the chat id but keep it visibly staged with the other edits.
    if (r.ok && r.chat_id) {
      notifSettings.value.telegram.chat_id = r.chat_id
    }
  } catch (e: any) {
    telegramDetectResult.value = {
      ok: false,
      error: e?.data?.detail || e?.data?.error || e?.message || 'Detection failed',
    }
  } finally {
    telegramDetectBusy.value = false
  }
}

// (Removed: KEY_PROVIDERS catalog. The API Keys tab moved to app-level
// Settings — see /app-settings — so this page no longer drives a
// per-project key UI.)

// Assets audit logic moved to assets.vue (new top-level page).
const standards = ref('')
const introStandards = ref('')

// ── Standards sub-tabs, templates, and presets ────────────────────────────
const standardsSubTabs = [
  { id: 'production', label: 'Project instructions' },
  { id: 'intro', label: 'Episode intro rules' },
] as const
const standardsSubTab = ref<'production' | 'intro'>('production')
const selectedTemplateId = ref('')
const selectedPresetId = ref('')
const showSavePreset = ref(false)
const newPresetName = ref('')

interface StandardPreset { id: string; name: string; content: string }
const standardsPresets = ref<StandardPreset[]>([])
const introPresets = ref<StandardPreset[]>([])
const standardsLoading = ref(false)
const standardsError = ref('')
let loadStandardsRequest = 0
let standardsLoadedSlug = ''
let writingConfigScope = 0
let writingConfigLoadedSlug = ''
const standardsSaving = ref(false)
const presetSaving = ref(false)
const writingConfigReady = computed(() => writingConfigLoadedSlug === slug.value && !!config.value)
const writingControlsDisabled = computed(() => !writingConfigReady.value
  || standardsLoading.value || !!standardsError.value || standardsSaving.value || presetSaving.value)

const STANDARDS_TEMPLATES: Record<string, Array<{ id: string; name: string; content: string }>> = {
  production: [
    {
      id: 'sleep-stories',
      name: 'Sleep Stories (cozy, calming)',
      content: `# Production Standards — Sleep Stories\n\nTone: warm, slow-paced, gentle. Avoid conflict spikes, loud action, sudden jumps.\nPacing: long paragraphs, sensory detail, present-moment grounding.\nVocabulary: simple, evocative, avoid jargon. Read-aloud cadence.\nStructure per chapter:\n  - Opening sensory anchor (2-3 sentences)\n  - Gentle forward motion\n  - Soft close that hands off to the next chapter\nAvoid: explicit content, violence, cliffhangers, loud onomatopoeia.\nInclude: nature imagery, warm light, textures, slow breath.\n`,
    },
    {
      id: 'horror',
      name: 'Horror / Mystery',
      content: `# Production Standards — Horror\n\nTone: unsettling, patient, atmosphere over gore.\nPacing: slow burn; reveal dread through detail, not shock.\nVocabulary: tactile, decaying, cold. Concrete nouns.\nStructure per chapter:\n  - Normal-life anchor\n  - Small wrongness\n  - Escalation\n  - Soft cliffhanger\nAvoid: cheap jump scares, excessive gore, moralizing.\nInclude: unreliable perception, liminal spaces, silence.\n`,
    },
    {
      id: 'documentary',
      name: 'Documentary / Educational',
      content: `# Production Standards — Documentary\n\nTone: curious, authoritative but warm.\nPacing: steady; alternate fact with narrative.\nVocabulary: precise, with brief plain-language restatements.\nStructure per chapter:\n  - Hook (a vivid anecdote or question)\n  - Context / history\n  - Evidence / examples\n  - Takeaway\nAvoid: speculation presented as fact, moralizing, filler.\nInclude: dates, names, numbers — concrete, verifiable.\n`,
    },
    {
      id: 'blank',
      name: 'Blank scaffold',
      content: `# Production Standards\n\nTone:\nPacing:\nVocabulary:\nStructure per chapter:\nAvoid:\nInclude:\n`,
    },
  ],
  intro: [
    {
      id: 'welcome-long',
      name: 'Warm welcome (long)',
      content: `# Intro Format — Warm welcome\n\n1. Welcome & host intro (2-3 sentences, use {host_name} if provided)\n2. Story teaser (1-2 evocative sentences)\n3. Community question or reflection\n4. Subscribe / Patreon CTA (gentle, not pushy)\n5. Relaxation or breathing cue (2-3 sentences)\n6. Transition into chapter 1\n\nTotal target: ~350 words. Read time: ~2-3 minutes.\n`,
    },
    {
      id: 'short-teaser',
      name: 'Short teaser (podcast-style)',
      content: `# Intro Format — Short teaser\n\n1. Welcome & host intro (1 sentence)\n2. Story teaser (1 sentence)\n3. Subscribe CTA (1 sentence)\n4. Transition into chapter 1 (1 sentence)\n\nTotal target: ~80 words. Read time: ~30 seconds.\n`,
    },
    {
      id: 'blank-intro',
      name: 'Blank scaffold',
      content: `# Intro Format\n\nBeats:\n  - \n  - \n  - \n\nWord target:\nTone:\n`,
    },
  ],
}

const currentStandardText = computed({
  get: () => standardsSubTab.value === 'intro' ? introStandards.value : standards.value,
  set: (v: string) => {
    if (standardsSubTab.value === 'intro') introStandards.value = v
    else standards.value = v
  },
})

const currentTemplates = computed(() => STANDARDS_TEMPLATES[standardsSubTab.value] || [])
const currentPresets = computed(() => standardsSubTab.value === 'intro' ? introPresets.value : standardsPresets.value)
const currentStandardDoc = computed(() => {
  if (standardsSubTab.value === 'intro') {
    return {
      title: 'Intro Format',
      description: 'Reference used by the Script Generator for the introduction section. Define beats, word targets, and tone so the AI can match your channel\'s voice.',
      placeholder: 'Describe how your episode intros should be structured…',
    }
  }
  return {
      title: 'Optional project instructions',
      description: 'Use this only for channel-specific facts, terminology, exclusions, or recurring production rules. It is appended after the Series Formula and cannot replace Formula-owned voice, point of view, or structure.',
      placeholder: 'e.g. always use Khmer place names as written here; do not mention sponsors; pronounce these names this way…',
  }
})

async function loadStarterTemplate() {
  const scope = writingConfigScope
  if (writingControlsDisabled.value) return
  const tpl = currentTemplates.value.find(t => t.id === selectedTemplateId.value)
  if (!tpl) return
  if (currentStandardText.value.trim()) {
    const ok = await ask({
      title: 'Replace current text?',
      message: 'Loading this template will overwrite the text in the editor. Unsaved edits will be lost.',
      confirmLabel: 'Replace',
    })
    if (!ok || scope !== writingConfigScope) return
  }
  currentStandardText.value = tpl.content
  selectedTemplateId.value = ''
}

async function loadPreset() {
  const scope = writingConfigScope
  if (writingControlsDisabled.value) return
  const p = currentPresets.value.find(x => x.id === selectedPresetId.value)
  if (!p) return
  if (currentStandardText.value.trim()) {
    const ok = await ask({
      title: 'Replace current text?',
      message: 'Loading this preset will overwrite the text in the editor. Unsaved edits will be lost.',
      confirmLabel: 'Replace',
    })
    if (!ok || scope !== writingConfigScope) return
  }
  currentStandardText.value = p.content
}

async function savePreset() {
  if (writingControlsDisabled.value) return
  const name = newPresetName.value.trim()
  if (!name) return
  const projectSlug = slug.value
  const scope = writingConfigScope
  const subTab = standardsSubTab.value
  const id = `preset-${Date.now()}`
  const preset: StandardPreset = { id, name, content: currentStandardText.value }
  const list = subTab === 'intro' ? introPresets : standardsPresets
  const next = [...list.value, preset]
  const key = subTab === 'intro' ? 'intro_presets' : 'standards_presets'
  const current = () => projectSlug === slug.value && scope === writingConfigScope
  presetSaving.value = true
  try {
    await put(`/projects/${projectSlug}/settings/config`, {
      [key]: next,
    })
    if (!current()) return
    list.value = next
    selectedPresetId.value = id
    success('Preset saved!')
  } catch (e: any) {
    if (current()) showError(e.data?.detail || 'Failed to save preset')
  } finally {
    if (current()) presetSaving.value = false
  }
  if (current()) {
    showSavePreset.value = false
    newPresetName.value = ''
  }
}

async function deletePreset() {
  if (writingControlsDisabled.value) return
  const doomed = (standardsSubTab.value === 'intro' ? introPresets : standardsPresets).value.find(p => p.id === selectedPresetId.value)
  if (!await ask({ title: `Delete preset “${doomed?.name || 'this preset'}”?`, message: 'The text in the editor stays; only the saved preset is removed.', confirmLabel: 'Delete preset', danger: true })) return
  const projectSlug = slug.value
  const scope = writingConfigScope
  const subTab = standardsSubTab.value
  const list = subTab === 'intro' ? introPresets : standardsPresets
  const next = list.value.filter(p => p.id !== selectedPresetId.value)
  const key = subTab === 'intro' ? 'intro_presets' : 'standards_presets'
  const current = () => projectSlug === slug.value && scope === writingConfigScope
  presetSaving.value = true
  try {
    await put(`/projects/${projectSlug}/settings/config`, {
      [key]: next,
    })
    if (!current()) return
    list.value = next
    selectedPresetId.value = ''
    success('Preset deleted')
  } catch (e: any) {
    if (current()) showError(e.data?.detail || 'Failed to delete')
  } finally {
    if (current()) presetSaving.value = false
  }
}

async function copyAsAiPrompt() {
  const label = standardsSubTab.value === 'intro' ? 'episode intro format' : 'production standards'
  const wrapped = `I'm producing a narrated story-video channel. Help me refine and tighten the ${label} below.
Keep it concise, scannable, and written as clear rules the AI writer can follow.
Output the improved version only — no commentary, no markdown tables.

--- CURRENT ${label.toUpperCase()} ---
${currentStandardText.value || '(empty — generate a starter based on best practices)'}
--- END ---`
  try {
    await navigator.clipboard.writeText(wrapped)
    success('Copied! Paste into your chatbot, then paste the result back here.')
  } catch {
    showError('Could not copy — select the text and copy manually.')
  }
}

async function saveStandardsCurrent() {
  if (writingControlsDisabled.value) return
  const projectSlug = slug.value
  const scope = writingConfigScope
  const request = loadStandardsRequest
  const current = () => projectSlug === slug.value && scope === writingConfigScope && request === loadStandardsRequest
  const subTab = standardsSubTab.value
  const content = currentStandardText.value
  standardsSaving.value = true
  try {
    if (subTab === 'intro') {
      await put(`/projects/${projectSlug}/settings/config`, { intro_standards: content })
    } else {
      // Standards endpoint accepts either JSON { content } or text/plain;
      // we go text/plain so there's no escape/diff noise on every keystroke.
      await put(`/projects/${projectSlug}/settings/standards`, content, {
        headers: { 'Content-Type': 'text/plain' },
      })
    }
    if (!current()) return
    stampSaved('standards')
    success('Saved!')
  } catch (e: any) {
    if (!current()) return
    showError('Failed to save')
  } finally {
    if (current()) standardsSaving.value = false
  }
}
const projectForm = reactive<{
  name: string
  episode_prefix: string
  season_prefix: string
  season_size: number
  youtube_channel_url: string
  /**
   * Item J — YouTube videoCategories.list ID. Stored in ProjectConfig
   * (not project meta), so saveProject() splits this off and PUTs it to
   * /settings/config separately. Undefined = use the upload-metadata
   * default (24 · Entertainment, switched from 22 in v1.0.77).
   */
  category_id: number | undefined
  /**
   * v1.0.77 — Project-level toggle for the YouTube "altered or synthetic
   * content" disclosure flag. Threaded into uploadVideo's status block as
   * `containsSyntheticMedia`. Undefined = inherit the app-level default
   * (which itself defaults to true since Story Studio's primary use is
   * AI-generated content).
   */
  mark_as_ai_generated: boolean | undefined
}>({ name: '', episode_prefix: '', season_prefix: 'Season', season_size: 20, youtube_channel_url: '', category_id: undefined, mark_as_ai_generated: undefined })

// ── Per-project Art Style (v1.0.518) ──────────────────────────────────────
// The project's active art style is persisted as config.active_style_preset_id
// (an id in config.style_presets). The generator auto-applies it to every
// image prompt and feeds its preview image into img2img renders. A legacy
// project-local style already lives in config.style_presets. A signed
// catalog style resolves through its immutable Content Pack pin instead.
const artStyleSelection = ref('')
const artStyleSaveMessage = ref('')
const artStyleSaving = ref(false)
let artStyleSelectionInitialized = false
let artStyleRollback = false
let artStyleRouteEpoch = 0
const savedStylePresets = computed(() =>
  Array.isArray((config.value as any)?.style_presets) ? (config.value as any).style_presets : [])

/**
 * A saved style id that resolves to nothing renders nothing — the generator
 * quietly falls back and the picker still shows a name, so the project looks
 * configured while every prompt goes out without the style. Saving one is
 * refused now, but a project can still carry an id from an older build or
 * from a pack that has since been uninstalled. Say so, here, in the UI.
 */
const unresolvedArtStyleId = computed(() => {
  if (visualStylesLoading.value || visualStylesError.value) return ''
  const active = String((config.value as any)?.active_style_preset_id || '').trim()
  if (!active) return ''
  if (visualStyles.value.some(style => style.id === active)) return ''
  if (savedStylePresets.value.some((preset: any) =>
    preset?.id === active && String(preset?.description || '').trim())) return ''
  return active
})

watch(artStyleSelection, async (next, prev) => {
  if (artStyleRollback) {
    artStyleRollback = false
    return
  }
  if (!artStyleSelectionInitialized) return
  if (next === prev) return
  if (artStyleSaving.value) return
  const targetSlug = slug.value
  const routeEpoch = artStyleRouteEpoch
  artStyleSaving.value = true
  artStyleSaveMessage.value = 'Saving…'
  try {
    const payload: Record<string, any> = {}
    let activeId = next
    const bs = visualStyles.value.find(style => style.id === next)
    if (bs) {
      activeId = bs.id
      // A SIGNED style already resolves through the project's content pin, so
      // copying its prose into the project config would fork it: the pack
      // could be updated or revoked and this project would keep rendering a
      // stale private copy nobody could see or edit. Only an unqualified id
      // has nowhere else to live and needs its text materialised here.
      if (!activeId.startsWith('com.storystudio.')) {
        const existing = Array.isArray((config.value as any)?.style_presets)
          ? [...(config.value as any).style_presets]
          : []
        if (!existing.some((p: any) => p && p.id === bs.id)) {
          existing.push({
            id: bs.id,
            name: bs.name,
            description: bs.data.style_bible,
            created_at: new Date().toISOString(),
          })
          payload.style_presets = existing
        }
      }
    }
    payload.active_style_preset_id = activeId
    await put(`/projects/${targetSlug}/settings/config`, payload)
    if (slug.value !== targetSlug || artStyleRouteEpoch !== routeEpoch) return
    await refreshConfig(targetSlug)
    artStyleSaveMessage.value = activeId ? 'Art style applied to this project' : 'Art style cleared'
    setTimeout(() => { artStyleSaveMessage.value = '' }, 2500)
  } catch (e: any) {
    if (slug.value !== targetSlug || artStyleRouteEpoch !== routeEpoch) return
    artStyleSaveMessage.value = e?.data?.detail || e?.message || 'Failed to save art style'
    // Roll back the visible value so the dropdown matches what's persisted.
    artStyleRollback = true
    artStyleSelection.value = prev || ''
  } finally {
    artStyleSaving.value = false
  }
})

// Register the save watcher before immediate hydration: it consumes the
// suppression flag that config hydration sets, so the first user choice is
// never mistaken for an initial sync.
watch(config, (c) => {
  if (!c) return
  const persistedStyleId = (c as any).active_style_preset_id || ''
  if (artStyleSelection.value !== persistedStyleId) {
    artStyleRollback = true
    artStyleSelection.value = persistedStyleId
  }
  artStyleSelectionInitialized = true
}, { immediate: true })

watch(slug, () => {
  artStyleRouteEpoch++
  artStyleSaveMessage.value = ''
  if (artStyleSelection.value) {
    artStyleRollback = true
    artStyleSelection.value = ''
  }
})

// (Removed: per-project enable/disable cloud-sync handlers + portable
// form field. Cloud sync is now app-wide via Settings → Storage; the
// per-project mode toggle is dead.)

// Absolute path to the episodes folder, for the read-only "Reveal in Finder"
// row. Read from the resolved path the backend computes, not from a stored
// setting — there is no longer one, and there is no form here that could
// change it. The old version read the RELATIVE './episodes' and then filtered
// it back out for not looking absolute, so this row was blank for every real
// project.
const projectLocation = computed(() => project.value?.output_root_resolved || '')

async function revealInFinder() {
  if (!projectLocation.value) return
  const { askSkippable } = useConfirmSkip()
  const browser = typeof navigator !== 'undefined' && navigator.platform?.startsWith('Win')
    ? 'File Explorer'
    : typeof navigator !== 'undefined' && navigator.platform?.startsWith('Mac')
      ? 'Finder' : 'your file manager'
  const ok = await askSkippable({
    skipKey: 'reveal_folder',
    title: 'Open in Finder?',
    message: `This will open the project folder in ${browser}:\n${projectLocation.value}`,
    confirmLabel: 'Open',
  })
  if (!ok) return
  try {
    await post('/system/reveal-folder', { path: projectLocation.value })
  } catch (e: any) {
    showError(e.data?.detail || 'Could not open folder')
  }
}

// Confirmation preferences
// `group: 'generation'` → action-only dialogs before generation begins.
// `group: 'action'` → everyday action dialogs (Open in Finder, etc.)
// that don't cost money but still deserve a guardrail the user can
// disable once they've decided they trust it. Both live in the same
// `confirmation_preferences` map so one Save button covers all rows.
const confirmGenerators = [
  { key: 'script', label: 'Scripts', description: 'Episode script generation', group: 'generation' },
  { key: 'thumb_prompts', label: 'Thumbnail Prompts', description: 'Thumbnail image prompt generation', group: 'generation' },
  { key: 'thumb_images', label: 'Thumbnail Images', description: 'Thumbnail image generation', group: 'generation' },
  { key: 'scene_plan', label: 'Scene Plan', description: 'Narration-timed visual prompt generation', group: 'generation' },
  { key: 'scene_review', label: 'Scene Review', description: 'Scene image generation from the approved plan', group: 'generation' },
  { key: 'audio', label: 'Audio', description: 'TTS narration', group: 'generation' },
  { key: 'description', label: 'Description', description: 'YouTube description generation', group: 'generation' },
  { key: 'video', label: 'Video', description: 'Video assembly via FFmpeg', group: 'generation' },
  { key: 'reveal_folder', label: 'Open in Finder', description: 'Confirm before opening a folder in Finder / File Explorer', group: 'action' },
]
const confirmGenerationRows = computed(() => confirmGenerators.filter(g => g.group === 'generation'))
const confirmActionRows = computed(() => confirmGenerators.filter(g => g.group === 'action'))
const confirmPrefs = reactive<Record<string, boolean>>({})

// Folder config
interface FolderEntry { key: string; label: string; generator: string; order: number; template: string }
const folderConfig = ref<FolderEntry[]>([])
const folderDefaults = ref<Record<string, string>>({})
const folderConfigLoading = ref(false)
const folderConfigError = ref('')
let loadFolderConfigRequest = 0
let folderConfigLoadedSlug = ''

// v1.4.3 — the named-roots state and its loader/saver went with the tab. See
// the note where the tab used to be: shared files now live at
// <Library>/_Project Assets and are addressed as ${ASSET}/…

async function loadFolderConfig() {
  const projectSlug = slug.value
  const request = ++loadFolderConfigRequest
  const current = () => projectSlug === slug.value && request === loadFolderConfigRequest
  folderConfigLoading.value = true
  folderConfigError.value = ''
  try {
    const data = await get<any>(`/projects/${projectSlug}/settings/subfolder-config`)
    if (!current()) return
    folderConfig.value = Array.isArray(data.linkage) ? data.linkage : []
    folderDefaults.value = data.defaults || {}
    folderConfigLoadedSlug = projectSlug
  } catch (e: any) {
    if (!current()) return
    folderConfigError.value = e?.data?.detail || e?.message || 'Could not load folder settings.'
  } finally {
    if (current()) folderConfigLoading.value = false
  }
}

// Load folder config when tab becomes active.
watch(activeTab, (tab) => {
  if (tab === 'files' && folderConfigLoadedSlug !== slug.value) void loadFolderConfig()
})

async function saveFolderConfig() {
  if (folderConfigLoading.value || folderConfigError.value) return
  const projectSlug = slug.value
  const request = loadFolderConfigRequest
  const current = () => projectSlug === slug.value && request === loadFolderConfigRequest
  const subfolder_names: Record<string, string> = {}
  for (const entry of folderConfig.value) {
    subfolder_names[entry.key] = entry.template
  }
  try {
    await put(`/projects/${projectSlug}/settings/subfolder-config`, { subfolder_names })
    if (!current()) return
    await loadProject(projectSlug)
    if (!current()) return
    stampSaved('folder_config')
    success('Folder config saved!')
  } catch (e: any) {
    if (!current()) return
    showError(e.data?.detail || 'Failed to save folder config')
  }
}

function resetFolderDefaults() {
  for (const entry of folderConfig.value) {
    entry.template = folderDefaults.value[entry.key] || entry.template
  }
}

// Sync editable data from config
// What each draft field was last hydrated to. Saving the art style or the guide slider refreshes
// the whole config, and this watcher used to overwrite every field with it — silently throwing away
// an intro being typed or a category not yet saved. A field is replaced only on a new project, or
// when it still shows exactly what was last loaded (i.e. nothing unsaved is in it).
const hydratedDrafts: Record<string, unknown> = {}
function hydrateDraft<T>(key: string, current: T, incoming: T, freshProject: boolean): T {
  const untouched = Object.is(current, hydratedDrafts[key])
  hydratedDrafts[key] = incoming
  return freshProject || untouched ? incoming : current
}

watch(config, (c) => {
  if (c) {
    // Item J — hydrate the YouTube category_id from config when it
    // arrives. Lives in this watch (not the chatterbox one above)
    // because projectForm is declared between them and the
    // `immediate: true` in the upper watch would TDZ-fault.
    const cAny = c as any
    const fresh = writingConfigLoadedSlug !== slug.value
    projectForm.category_id = hydrateDraft('category_id', projectForm.category_id,
      typeof cAny?.category_id === 'number' && cAny.category_id > 0 ? cAny.category_id : undefined, fresh)
    projectForm.mark_as_ai_generated = hydrateDraft('mark_as_ai_generated', projectForm.mark_as_ai_generated,
      typeof cAny?.mark_as_ai_generated === 'boolean' ? cAny.mark_as_ai_generated : undefined, fresh)
    standardsPresets.value = JSON.parse(JSON.stringify((c as any).standards_presets || []))
    introPresets.value = JSON.parse(JSON.stringify((c as any).intro_presets || []))
    introStandards.value = hydrateDraft('intro_standards', introStandards.value, (c as any).intro_standards || '', fresh)
    writingConfigLoadedSlug = slug.value
    // Load confirmation preferences
    const prefs = (c as any).confirmation_preferences || {}
    for (const gen of confirmGenerators) {
      confirmPrefs[gen.key] = hydrateDraft(`confirm:${gen.key}`, confirmPrefs[gen.key], prefs[gen.key] !== false, fresh) // default true
    }
  }
}, { immediate: true })

async function loadStandards() {
  const projectSlug = slug.value
  const request = ++loadStandardsRequest
  const current = () => projectSlug === slug.value && request === loadStandardsRequest
  standardsLoading.value = true
  standardsError.value = ''
  try {
    const data = await get<{ content: string }>(`/projects/${projectSlug}/settings/standards`)
    if (!current()) return
    standards.value = data.content || ''
    standardsLoadedSlug = projectSlug
  } catch (e: any) {
    if (!current()) return
    standardsError.value = e?.data?.detail || e?.message || 'Could not load saved instructions.'
  } finally {
    if (current()) standardsLoading.value = false
  }
}

// Load standards when tab becomes active.
watch(activeTab, (tab) => {
  if (tab === 'writing' && standardsLoadedSlug !== slug.value) void loadStandards()
})

watch(slug, () => {
  writingConfigScope++
  writingConfigLoadedSlug = ''
  standards.value = ''
  introStandards.value = ''
  standardsPresets.value = []
  introPresets.value = []
  selectedTemplateId.value = ''
  selectedPresetId.value = ''
  showSavePreset.value = false
  newPresetName.value = ''
  standardsSaving.value = false
  presetSaving.value = false
  loadFolderConfigRequest++
  folderConfigLoadedSlug = ''
  folderConfig.value = []
  folderDefaults.value = {}
  folderConfigLoading.value = false
  folderConfigError.value = ''
  loadStandardsRequest++
  standardsLoadedSlug = ''
  standardsLoading.value = false
  standardsError.value = ''
  // F-05 (DS-11) — a different project is now on screen, so the previous
  // project's Publishing values must not stand (AGENTS.md §4). These two live
  // on ProjectConfig and are re-hydrated from this project's own config, which
  // is fetched after the slug changes; a failed or empty config read leaves
  // them blank rather than showing the last project's answer.
  projectForm.category_id = undefined
  projectForm.mark_as_ai_generated = undefined
  if (activeTab.value === 'files') void loadFolderConfig()
  if (activeTab.value === 'writing') void loadStandards()
})

// Sync project form. v1.0.45 — track the server-side season_size
// separately so the Reseason flow can detect "user wants to change it"
// and offer the rebalance preview, while the regular save flow filters
// out season_size to avoid silent mismatches with on-disk folders.
const serverSeasonSize = ref(20)
watch(project, (p) => {
  if (p) {
    projectForm.name = p.name
    projectForm.episode_prefix = p.episode_prefix
    projectForm.season_prefix = p.season_prefix || 'Season'
    projectForm.season_size = p.season_size || 20
    serverSeasonSize.value = p.season_size || 20
    projectForm.youtube_channel_url = (p as any).youtube_channel_url || ''
    // Level B external media root (lives on project meta). Seed the Storage-tab
    // control + verify it resolves on this machine for the status line.
    mediaRootInput.value = (p as any).media_root || ''
    mediaRootSavedValue.value = mediaRootInput.value
    if (mediaRootInput.value) void checkMediaRoot()
    // F-05 (DS-11) — `category_id` lives on ProjectConfig, not project meta, so
    // this watcher must not touch it. It used to blank the field on every
    // `project` replacement, and `loadProject()` fetches project meta and
    // config IN PARALLEL: whenever meta resolved after config, the hydrated
    // category was wiped and the next Publishing save persisted that silent
    // clear. The per-project reset now happens on the slug change itself (see
    // the `watch(slug, …)` reset above), which is the only event that actually
    // means "a different project is on screen" (AGENTS.md §4).
  }
}, { immediate: true })
const seasonSizeChanged = computed(() =>
  Number.isInteger(projectForm.season_size)
  && projectForm.season_size >= 1
  && projectForm.season_size !== serverSeasonSize.value,
)

// ── Reseason preview / apply (v1.0.45) ────────────────────────────────────
interface ReseasonMove {
  code: string
  title: string
  old_dir: string
  new_dir: string
  old_season: number
  new_season: number
}
interface ReseasonPreviewData {
  current_season_size: number
  new_season_size: number
  moves: ReseasonMove[]
  noop_count: number
  total_accepted: number
}
const reseasonState = reactive<{
  open: boolean
  opening: boolean
  running: boolean
  preview: ReseasonPreviewData | null
  error: string
}>({
  open: false,
  opening: false,
  running: false,
  preview: null,
  error: '',
})

async function openReseasonPreview() {
  if (!seasonSizeChanged.value) return
  if (reseasonState.opening || reseasonState.running) return
  reseasonState.opening = true
  reseasonState.error = ''
  try {
    reseasonState.preview = await get<ReseasonPreviewData>(
      `/projects/${slug.value}/episodes/reseason-preview?new_size=${projectForm.season_size}`,
    )
    reseasonState.open = true
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to compute reseason plan')
  } finally {
    reseasonState.opening = false
  }
}

function closeReseasonPreview() {
  if (reseasonState.running) return
  reseasonState.open = false
  reseasonState.preview = null
  reseasonState.error = ''
}

async function confirmReseason() {
  if (reseasonState.running || !reseasonState.preview) return
  reseasonState.running = true
  reseasonState.error = ''
  try {
    const r = await post<{
      ok: true
      moves: ReseasonMove[]
      moved: Array<{ code: string; from: string; to: string }>
      moved_external: Array<{ code: string; from: string; to: string }>
      errors: Array<{ stage: string; detail: string }>
    }>(`/projects/${slug.value}/episodes/reseason`, { new_size: reseasonState.preview.new_season_size })
    const movedCount = r.moved.length
    const externalCount = r.moved_external.length
    const errorCount = r.errors.length
    const parts: string[] = []
    if (movedCount) parts.push(`${movedCount} folder${movedCount === 1 ? '' : 's'} moved`)
    if (externalCount) parts.push(`${externalCount} external`)
    if (errorCount) parts.push(`${errorCount} error${errorCount === 1 ? '' : 's'}`)
    success(`Rebalanced · ${parts.length ? parts.join(', ') : 'no-op'}. Reversible from Unlinked Uploads tab for 30 days.`)
    reseasonState.open = false
    reseasonState.preview = null
    await loadProject(slug.value)
  } catch (e: any) {
    reseasonState.error = e?.data?.detail || e?.message || 'Rebalance failed'
  } finally {
    reseasonState.running = false
  }
}

async function saveConfirmPrefs() {
  try {
    await put(`/projects/${slug.value}/settings/config`, { confirmation_preferences: { ...confirmPrefs } })
    await refreshConfig(slug.value)
    stampSaved('confirm_prefs')
    success('Confirmation preferences saved!')
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to save')
  }
}

async function saveStandards() {
  try {
    await put(`/projects/${slug.value}/settings/standards`, standards.value, {
      headers: { 'Content-Type': 'text/plain' },
    })
    success('Production standards saved!')
  } catch (e: any) {
    showError('Failed to save standards')
  }
}

/** True only when the section was saved for the project still on screen. */
async function saveProject(requestedSection?: ProjectSettingsSaveSection): Promise<boolean> {
  try {
    const targetSlug = slug.value
    const section = requestedSection || (activeTab.value as ProjectSettingsSaveSection)
    if (!['identity', 'publishing', 'files'].includes(section)) return false
    const draftBeforeSave = { ...projectForm }
    const plan = projectSettingsSavePlan(section, draftBeforeSave, serverSeasonSize.value)

    // The regular Files save deliberately excludes season_size. Only the
    // Rebalance action can change it because that also moves existing folders.
    if (plan.hasPendingSeasonSize) {
      info('Episodes per Group not saved — use the ↻ Rebalance button next to the field to apply size changes.')
    }

    const savedProject = await put<any>(`/projects/${targetSlug}`, plan.project)
    if (plan.config) {
      await put(`/projects/${targetSlug}/settings/config`, plan.config)
    }
    if (slug.value !== targetSlug) return false
    if (project.value) {
      for (const key of Object.keys(plan.project)) {
        (project.value as any)[key] = savedProject[key]
      }
    }
    if (plan.config) {
      if (config.value) {
        for (const [key, value] of Object.entries(plan.config)) {
          if (value !== undefined) (config.value as any)[key] = value
        }
      }
    }

    // Mutate only the acknowledged fields in place. Replacing the whole refs
    // would hydrate every section and discard drafts hidden behind another link.
    stampSaved(`project_${section}`)
    success(`${section === 'identity' ? 'Project identity' : section === 'publishing' ? 'Publishing defaults' : 'Project files'} saved!`)
    return true
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to save')
    return false
  }
}

async function syncFolders() {
  const ok = await ask({
    title: 'Repair folder structure?',
    message: 'Renames folders to match current config, creates missing subfolders, moves files to the right places, and recycles missing episode numbers. Existing files are never deleted.',
    confirmLabel: 'Repair folders',
  })
  if (!ok) return
  syncing.value = true
  syncResults.value = []
  try {
    const result = await post<any>(`/projects/${slug.value}/sync-folders`)
    syncResults.value = result.actions || []
    success('Folders synced!')
  } catch (e: any) {
    showError(e.data?.detail || 'Sync failed')
  } finally {
    syncing.value = false
  }
}

async function deleteProject() {
  // The delete is non-destructive — files stay on disk. Confirm reflects
  // that ("hide" not "delete") so the user knows they can recover.
  const ok = await ask({
    title: `Hide "${project.value?.name}" from the app?`,
    message:
      'Files stay on disk — only the registration is removed. ' +
      'You can restore the project anytime, or permanently delete it later from the home-page Hidden channels panel.',
    confirmLabel: 'Hide project',
    danger: false,
  })
  if (!ok) return
  try {
    const result = await del<{ ok: boolean; disposition?: string; orphan_path?: string; name?: string }>(
      `/projects/${slug.value}`,
    )
    success(`Hidden "${result?.name || slug.value}" — files kept at ${result?.orphan_path || 'their location'}`)
    // Surface the orphan path in a follow-up dialog with Open-in-Finder.
    // The user explicitly asked to be told where the bytes still live so
    // they can manually clean up later.
    if (result?.orphan_path) {
      const reveal = await ask({
        title: 'Files are still on disk',
        message: `Your files are still at:\n\n${result.orphan_path}\n\nClick "Open in Finder" to reveal the folder, or "Got it" to dismiss. You can manage hidden projects from the home page anytime.`,
        confirmLabel: 'Open in Finder',
        cancelLabel: 'Got it',
        danger: false,
      })
      if (reveal) {
        try {
          await post('/system/reveal-folder', { path: result.orphan_path })
        } catch (e: any) {
          showError(e?.data?.detail || 'Could not open Finder')
        }
      }
    }
    navigateTo('/')
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to hide project')
  }
}
</script>

<style scoped>
/* v1.0.270 — content mode toggle (Format tab) */
.cm-box { border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
.cm-label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 8px; }
.cm-options { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 720px) { .cm-options { grid-template-columns: 1fr; } }
.cm-opt {
  display: flex; gap: 10px; align-items: flex-start; cursor: pointer;
  padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-secondary);
}
.cm-opt.active { border-color: var(--accent); background: rgba(108, 143, 255, 0.06); }
.cm-opt input { margin-top: 3px; }

/* ── Art style picker (Project tab) ────────────────────────────────────── */
.art-style-picker {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.art-style-picker .input { flex: 1; min-width: 200px; }

/* ── Format tab ──────────────────────────────────────────────────────── */
.format-tab-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
.format-tab-header > div { flex: 1; }
.format-tab-header h3 { margin: 0 0 4px; }
.channel-visual-defaults {
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, var(--bg-secondary), var(--surface-raised));
}
.channel-guide-density-row { display: flex; align-items: center; gap: 14px; margin-top: 12px; }
.channel-guide-density-slider { flex: 1; min-width: 0; accent-color: var(--accent); cursor: pointer; }
.channel-guide-density-value { min-width: 46px; color: var(--text-primary); font-size: 13px; font-weight: 700; text-align: right; }
.channel-guide-density-value.off { color: var(--text-muted); font-weight: 500; }

/* v1.0.165 — Patterns sub-section CSS removed with the Pattern system. */

/* ── FFmpeg tab ──────────────────────────────────────────────────────── */
.ffmpeg-status-row {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.ffmpeg-install-block {
  padding: 12px 14px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.ffmpeg-install-block > .ffmpeg-install-summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.ffmpeg-install-block > .ffmpeg-install-summary::-webkit-details-marker { display: none; }
.ffmpeg-install-block > .ffmpeg-install-summary::before {
  content: '▸';
  color: var(--text-muted);
  font-size: var(--font-xs);
  transition: transform 0.15s;
}
.ffmpeg-install-block[open] > .ffmpeg-install-summary::before { transform: rotate(90deg); }
.ffmpeg-cmd {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  margin: 2px 0 8px 0;
  font-family: 'SF Mono', Monaco, monospace;
  font-size: var(--font-xs);
  overflow-x: auto;
}
.ffmpeg-cmd code { background: transparent; padding: 0; }
.ffmpeg-manual a { color: var(--accent); text-decoration: underline; }

/* Restart prompt — visually distinct from the install block (green
   accent vs amber) so the success state reads as different from the
   "click to install" state. */
.ffmpeg-restart-prompt {
  padding: 10px 14px;
  background: rgba(46, 160, 67, 0.08);
  border-left: 3px solid var(--success, #3fb950);
  border-radius: var(--radius-sm);
  font-size: 13px;
}
.ffmpeg-restart-prompt .restart-msg { color: var(--text-primary); }

/* Install-log diagnostic block: surfaces only on failure. The <pre>
   keeps formatting (timestamps, indented stack lines) and lets the
   user select-copy fragments instead of the whole thing. */
.ffmpeg-log-block {
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}
.ffmpeg-log-output {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font-family: 'SF Mono', Monaco, monospace;
  font-size: var(--font-xs);
  line-height: 1.5;
  max-height: 280px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Connectivity Diagnose block on the API Keys tab. Reachable hosts are
   styled green, unreachable red — so the user can tell at a glance whether
   the issue is a single provider or a whole-network outage. */
.precheck-diagnose {
  padding: 10px 12px;
  margin-bottom: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
}
.precheck-host-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.precheck-host {
  font-size: var(--font-xs);
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: rgba(255,255,255,0.03);
}
.precheck-host-ok  { border-color: rgba(34, 197, 94, 0.35);  background: rgba(34, 197, 94, 0.08); }
.precheck-host-bad { border-color: rgba(239, 68, 68, 0.45);  background: rgba(239, 68, 68, 0.10); }

.settings-workspace {
  --settings-green: #58c692;
  --settings-gold: #e3b45a;
  padding-bottom: 48px;
}
.settings-page-hero {
  position: relative;
  overflow: hidden;
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 24px;
  padding: 24px 26px;
  border: 1px solid color-mix(in srgb, var(--settings-green) 28%, var(--border));
  border-radius: 18px;
  background:
    radial-gradient(circle at 90% 5%, rgba(227, 180, 90, 0.16), transparent 28%),
    radial-gradient(circle at 5% 110%, rgba(88, 198, 146, 0.18), transparent 35%),
    linear-gradient(135deg, color-mix(in srgb, var(--bg-secondary) 92%, #123a2b), var(--bg-secondary));
  box-shadow: 0 18px 45px rgba(0, 0, 0, 0.14);
}
.settings-page-hero::after {
  content: '';
  position: absolute;
  right: 11%;
  top: -54px;
  width: 160px;
  height: 160px;
  border: 1px solid rgba(227, 180, 90, 0.18);
  border-radius: 50%;
  pointer-events: none;
}
.settings-page-copy { position: relative; z-index: 1; max-width: 720px; }
.settings-page-copy h1 { margin: 3px 0 6px; font-size: clamp(28px, 3vw, 40px); letter-spacing: -0.035em; }
.settings-page-copy p { margin: 0; color: var(--text-secondary); font-size: 13px; line-height: 1.55; }
.settings-page-key {
  position: relative;
  z-index: 1;
  display: flex;
  gap: 12px;
  padding: 8px 11px;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 999px;
  background: rgba(0,0,0,0.12);
  white-space: nowrap;
}
.settings-page-key span { display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: var(--font-xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
.key-dot { width: 7px; height: 7px; border-radius: 50%; }
.key-machine { background: var(--settings-gold); }
.key-project { background: var(--settings-green); }


.settings-active-intro {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  margin: 14px 0 0;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg-secondary);
}
.settings-active-intro.scope-machine { border-left: 3px solid var(--settings-gold); }
.settings-active-intro.scope-project { border-left: 3px solid var(--settings-green); }
.settings-active-copy { position: relative; }
.settings-active-copy h2 { margin: 1px 0 3px; font-size: 18px; letter-spacing: -0.015em; }
.settings-hash-target { position: absolute; width: 1px; height: 1px; overflow: hidden; }
.settings-active-copy p { margin: 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.45; }
.settings-scope-pill {
  padding: 5px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: .07em;
  text-transform: uppercase;
  white-space: nowrap;
}

.settings-panel {
  border-radius: 16px;
  border-color: color-mix(in srgb, var(--border) 88%, var(--settings-green));
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg-secondary) 96%, #17362a), var(--bg-secondary) 180px);
  box-shadow: 0 20px 45px rgba(0,0,0,.12), inset 0 1px rgba(255,255,255,.025);
}
.settings-panel-embedded { padding: 14px; }
.settings-disclosure > summary {
  margin: -4px;
  padding: 8px;
  border-radius: 10px;
  cursor: pointer;
  list-style-position: outside;
}
.settings-disclosure > summary:hover { background: var(--bg-tertiary); }
.settings-disclosure > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.settings-disclosure > summary > span { display: inline-flex; flex-direction: column; gap: 2px; margin-left: 4px; vertical-align: middle; }
.settings-disclosure > summary strong { color: var(--text-primary); font-size: 14px; }
.settings-disclosure > summary small { color: var(--text-muted); font-size: var(--font-xs); font-weight: 400; }
.settings-disclosure[open] > summary { margin-bottom: 14px; border-bottom: 1px solid var(--border); border-radius: 10px 10px 0 0; }
.settings-panel > h3:first-child,
.settings-panel > .card-header:first-child h3 { font-size: 18px; letter-spacing: -.015em; }
.settings-section-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  padding: 2px 2px 16px;
}
.settings-section-kicker {
  color: var(--settings-gold);
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: .13em;
  text-transform: uppercase;
}
.settings-section-head h3 { margin: 3px 0 4px; font-size: 20px; letter-spacing: -.025em; }
.settings-section-head p { margin: 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.5; }
.settings-section-count {
  flex: 0 0 auto;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: .06em;
  text-transform: uppercase;
}

@media (max-width: 720px) {
  .settings-page-hero { align-items: flex-start; flex-direction: column; padding: 20px; }
  .settings-page-key { width: 100%; justify-content: space-around; }
  .settings-active-intro { grid-template-columns: 1fr; }
  .settings-scope-pill { grid-column: 1 / -1; justify-self: start; }
  .settings-section-head { align-items: flex-start; flex-direction: column; }
}


.input-sm {
  padding: 6px 10px;
  font-size: 13px;
  width: auto;
}

.btn-icon {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 4px 8px;
  border-radius: 4px;
}
.btn-icon:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.btn-icon.danger:hover {
  color: var(--error);
  background: rgba(248, 113, 113, 0.1);
}


.sync-zone {
  border-top: 1px solid var(--accent);
  padding-top: 20px;
}
.sync-zone h3 { color: var(--accent); }
.sync-results {
  background: var(--bg-primary);
  border-radius: var(--radius-sm);
  padding: 12px;
}
.sync-action {
  font-size: 13px;
  color: var(--success);
  padding: 2px 0;
}

/* ── Notification center ───────────────────────────────────────────── */
/* DS-12/F-14 — `overflow: hidden` made this panel the scroll container for its own
   `position: sticky; bottom: 10px` save bar. A hidden-overflow ancestor is a scroll
   container whose scroll position never changes, so the bar measured exactly its
   natural offset at every scroll position and its Save action was invisible until
   the very end of a 2680px page. `clip` still clips the panel's rounded corners but
   is not a scroll container, so the bar sticks against main.main-content instead. */
.notification-panel { overflow: clip; }
.notification-status-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; margin-bottom: 12px; }
.notification-status-card {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  gap: 9px;
  align-items: center;
  min-width: 0;
  padding: 11px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-tertiary) 58%, transparent);
}
.notification-status-card.active { border-color: rgba(88,198,146,.35); background: linear-gradient(135deg, rgba(88,198,146,.08), rgba(227,180,90,.035)); }
.notification-status-icon,
.notification-channel-icon {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  color: var(--settings-green);
  background: rgba(88,198,146,.1);
  font-size: 13px;
  font-weight: 800;
}
.notification-status-card > div { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.notification-status-card strong { font-size: var(--font-xs); }
.notification-status-card small { overflow: hidden; color: var(--text-muted); font-size: var(--font-xs); text-overflow: ellipsis; white-space: nowrap; }
.notification-state { padding: 3px 6px; border-radius: 999px; font-size: var(--font-xs); font-weight: 850; letter-spacing: .08em; white-space: nowrap; }
.notification-state.ready { color: #6bd6a8; background: rgba(88,198,146,.14); }
.notification-state.warn { color: #e0b760; background: rgba(227,180,90,.13); }
.notification-state.off { color: var(--text-muted); background: rgba(128,138,150,.12); }
.notification-layout { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.notification-section {
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--bg-tertiary) 60%, transparent);
}
.notification-section--events,
.notification-section--telegram,
.notification-section--digest { grid-column: 1 / -1; }
.notification-section-head,
.notification-channel-head { display: flex; gap: 11px; align-items: center; }
.notification-section-head { justify-content: space-between; margin-bottom: 11px; }
.notification-section-head h4,
.notification-channel-head h4 { margin: 2px 0 3px; font-size: 13px; }
.notification-section-head > span { color: var(--text-muted); font-size: var(--font-xs); }
.notification-channel-head > div:nth-child(2) { min-width: 0; flex: 1; }
.notification-channel-head p { margin: 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.45; }
.notification-event-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.notification-event-card {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 9px;
  align-items: start;
  padding: 11px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: color-mix(in srgb, var(--bg-primary) 48%, transparent);
  cursor: pointer;
  transition: .15s ease;
}
.notification-event-card:hover { border-color: rgba(227,180,90,.35); transform: translateY(-1px); }
.notification-event-card.active { border-color: rgba(88,198,146,.38); background: rgba(88,198,146,.07); }
.notification-event-card input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.notification-event-mark { display: grid; place-items: center; width: 27px; height: 27px; border-radius: 8px; color: var(--text-muted); background: var(--bg-tertiary); font-size: var(--font-xs); font-weight: 850; }
.notification-event-card.active .notification-event-mark { color: var(--settings-green); background: rgba(88,198,146,.12); }
.notification-event-card > span:last-child { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.notification-event-card strong { font-size: var(--font-xs); }
.notification-event-card small { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.45; }
.notification-switch { position: relative; flex: 0 0 auto; width: 34px; height: 20px; cursor: pointer; }
.notification-switch input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.notification-switch span { display: block; width: 100%; height: 100%; border-radius: 999px; background: rgba(128,138,150,.28); transition: .18s ease; }
.notification-switch span::after { content: ''; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: #c9ced4; transition: .18s ease; }
.notification-switch input:checked + span { background: rgba(88,198,146,.48); }
.notification-switch input:checked + span::after { left: 17px; background: #eaf9f2; }
.notification-threshold { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; align-items: end; margin-top: 15px; padding-top: 12px; border-top: 1px solid var(--border); }
.notification-threshold.disabled { opacity: .48; }
.notification-threshold > div { display: flex; flex-direction: column; gap: 3px; }
.notification-threshold strong { font-size: var(--font-xs); }
.notification-threshold small { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.4; }
.notification-threshold > :last-child { grid-column: 1 / -1; }
.notification-threshold-value { color: var(--settings-gold); font-size: var(--font-xs); font-weight: 800; }
.notification-setup { margin-top: 14px; border: 1px dashed var(--border); border-radius: 12px; background: rgba(0,0,0,.06); }
.notification-setup[open] { border-style: solid; }
.notification-setup > summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 13px; cursor: pointer; list-style: none; }
.notification-setup > summary::-webkit-details-marker { display: none; }
.notification-setup > summary > span:first-child { display: flex; flex-direction: column; gap: 2px; }
.notification-setup > summary strong { font-size: var(--font-xs); }
.notification-setup > summary small { color: var(--text-muted); font-size: var(--font-xs); }
.notification-setup-body { display: grid; gap: 0; border-top: 1px solid var(--border); }
.notification-setup-step { display: grid; grid-template-columns: 25px minmax(0, 1fr) auto; gap: 10px; align-items: start; padding: 13px; }
.notification-setup-step + .notification-setup-step { border-top: 1px solid var(--border); }
.notification-setup-step > span:first-child { display: grid; place-items: center; width: 23px; height: 23px; border-radius: 50%; color: #16231e; background: var(--settings-green); font-size: var(--font-xs); font-weight: 850; }
.notification-setup-step strong { font-size: var(--font-xs); }
.notification-setup-step p { margin: 3px 0 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.5; }
.notification-setup-fields { min-width: 0; }
.notification-setup-fields > label { display: block; margin: 10px 0 4px; color: var(--text-secondary); font-size: var(--font-xs); font-weight: 700; }
.notification-secret-row,
.notification-connect-row { display: flex; gap: 7px; align-items: center; }
.notification-secret-row .input,
.notification-connect-row .input { min-width: 0; flex: 1; }
.notification-connect-row { margin-top: 7px; }
.notification-test-action { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
.notification-test-action small,
.notification-inline-result { font-size: var(--font-xs); line-height: 1.4; }
.notification-test-action .ok,
.notification-inline-result.ok { color: var(--success); }
.notification-test-action .error,
.notification-inline-result.error { color: var(--error); }
.notification-digest-controls { display: grid; grid-template-columns: .7fr 1fr 1fr .7fr; gap: 10px; align-items: stretch; margin-top: 14px; }
.notification-digest-controls.disabled { opacity: .55; }
.notification-time-control,
.notification-route-control,
.notification-quiet-control,
.notification-last-fired { display: flex; min-width: 0; flex-direction: column; gap: 5px; padding: 10px; border: 1px solid var(--border); border-radius: 10px; background: rgba(0,0,0,.055); }
.notification-time-control > span,
.notification-route-control > span,
.notification-last-fired > span { color: var(--text-secondary); font-size: var(--font-xs); font-weight: 750; }
.notification-time-control small,
.notification-route-control small,
.notification-quiet-control small { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.35; }
.notification-route-control label { display: flex; align-items: center; gap: 5px; font-size: var(--font-xs); }
.notification-quiet-control { flex-direction: row; align-items: flex-start; cursor: pointer; }
.notification-quiet-control > span { display: flex; flex-direction: column; gap: 3px; }
.notification-quiet-control strong { font-size: var(--font-xs); }
.notification-last-fired strong { margin-top: auto; color: var(--settings-gold); font-size: var(--font-xs); }
.notification-digest-actions { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; margin-top: 10px; }
.notification-preview { margin-top: 10px; padding: 12px; border: 1px solid var(--border); border-radius: 11px; background: color-mix(in srgb, var(--bg-primary) 62%, transparent); }
.notification-preview > strong { display: block; margin: 4px 0 7px; font-size: var(--font-xs); }
.notification-preview pre { max-height: 280px; margin: 0; overflow: auto; color: var(--text-muted); font-family: var(--font-mono, monospace); font-size: var(--font-xs); line-height: 1.55; white-space: pre-wrap; }
.notification-save-bar { position: sticky; bottom: 10px; z-index: 4; display: flex; align-items: center; gap: 9px; margin-top: 12px; padding: 11px 12px; border: 1px solid rgba(88,198,146,.3); border-radius: 13px; background: color-mix(in srgb, var(--bg-secondary) 94%, rgba(88,198,146,.2)); box-shadow: 0 10px 28px rgba(0,0,0,.24); }
.notification-save-bar > div:first-child { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
.notification-save-bar strong { font-size: var(--font-xs); }
.notification-save-bar span { color: var(--text-muted); font-size: var(--font-xs); }
.notification-save-bar .error { color: var(--error); }

/* ── Storage tab ─────────────────────────────────────────────────────── */
.storage-panel { overflow: hidden; }
#archive-section > summary { cursor: pointer; }
.archive-summary { display: inline; margin: 0; }
.storage-section h4 {
  margin: 0 0 6px;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.storage-section .hint { margin: 4px 0 8px; font-size: var(--font-xs); line-height: 1.45; }
.storage-section-icon { font-size: 16px; line-height: 1; }
.storage-surface {
  margin-top: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--bg-tertiary) 58%, transparent);
  scroll-margin-top: 18px;
}
/* Top-bordered subsections inside the Storage card. The first subsection
   (Projects storage location) skips the modifier so the top of the card
   stays flush; everything below gets a clear horizontal divider + breathing
   room so it's obvious where one section ends and the next begins. */
.storage-section--bordered {
  border-top: 1px solid var(--border);
  margin-top: 24px;
  padding-top: 18px;
}
/* Inline help panel beneath a section's status row. Used to translate
   "Picker failed: …" into actionable guidance ("type the path manually")
   without burying the message inside the same line as a save error. */
.manual-path-hint {
  margin-top: 8px;
  padding: 10px 12px;
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.28);
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-secondary);
}
.optional-tag { color: var(--text-muted); font-size: var(--font-xs); font-weight: normal; }

/* ── Cloud sync overview (top-of-Storage indicator card) ─────────── */
.cloud-sync-overview {
  margin: 8px 0 0;
  padding: 14px 16px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-left: 3px solid #4b82c8;
  border-radius: var(--radius-sm);
}
.storage-map { border-left: 1px solid var(--border); border-radius: 14px; background: linear-gradient(145deg, rgba(24,72,55,.16), rgba(227,180,90,.04)); }
.overview-card--advanced { border-style: dashed; }
.overview-head {
  display: flex; gap: 12px; align-items: flex-start; margin-bottom: 12px;
}
.overview-icon { font-size: 20px; line-height: 1.2; flex-shrink: 0; }
.overview-head strong { display: block; margin-bottom: 2px; font-size: 14px; }
.overview-sub {
  margin: 0; font-size: var(--font-xs); color: var(--text-secondary); line-height: 1.5;
}
.overview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px;
  margin-bottom: 10px;
}
.overview-card {
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  text-decoration: none; color: inherit;
  transition: border-color 0.15s, transform 0.1s;
  cursor: pointer;
}
.overview-card:hover {
  border-color: #4b82c8;
  transform: translateY(-1px);
}
.overview-card-head {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
}
.overview-card-head strong { font-size: 12px; }
.overview-card-icon { font-size: 14px; }
.overview-badge {
  display: inline-block;
  padding: 1px 6px;
  font-size: var(--font-xs); font-weight: 700; letter-spacing: 0.05em;
  border-radius: 999px;
  margin-left: auto;
}
.overview-badge.on { background: rgba(75, 130, 200, 0.2); color: #60a5fa; }
.overview-badge.off { background: rgba(120, 130, 140, 0.18); color: var(--text-muted); }
.overview-badge.info { background: rgba(214, 155, 43, 0.15); color: var(--warning, #d69b2b); }
.overview-card-desc {
  margin: 0; font-size: var(--font-xs); color: var(--text-secondary); line-height: 1.45;
}
.overview-card-path {
  font-family: 'Menlo', 'Monaco', monospace;
  font-size: var(--font-xs); color: var(--text-muted);
  word-break: break-all;
}
.overview-warnings {
  margin-top: 8px;
  padding: 8px 12px;
  background: rgba(214, 155, 43, 0.08);
  border-left: 3px solid var(--warning, #d69b2b);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
}
.overview-warnings summary {
  cursor: pointer;
  color: var(--warning, #d69b2b);
  font-weight: 500;
}
.overview-warnings ul {
  margin: 8px 0 0;
  padding-left: 18px;
  line-height: 1.5;
}
.overview-warnings li { margin-bottom: 4px; color: var(--text-secondary); }
.overview-warnings code {
  background: var(--bg-secondary); padding: 1px 4px; border-radius: 3px;
  font-size: var(--font-xs);
}

.storage-advanced-heading { display: flex; align-items: baseline; gap: 10px; margin: 24px 2px 8px; }
.storage-advanced-heading > span { color: var(--settings-gold); font-size: var(--font-xs); font-weight: 800; letter-spacing: .13em; text-transform: uppercase; white-space: nowrap; }
.storage-advanced-heading p { margin: 0; color: var(--text-muted); font-size: var(--font-xs); }
.storage-disclosure { margin-top: 8px; border: 1px dashed var(--border); border-radius: 13px; background: color-mix(in srgb, var(--bg-primary) 42%, transparent); scroll-margin-top: 18px; }
.storage-disclosure[open] { border-style: solid; background: color-mix(in srgb, var(--bg-tertiary) 56%, transparent); }
.storage-disclosure-summary { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto 18px; gap: 10px; align-items: center; padding: 13px 15px; cursor: pointer; list-style: none; }
.storage-disclosure-summary::-webkit-details-marker { display: none; }
.storage-disclosure-summary > span:nth-child(2) { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.storage-disclosure-summary strong { font-size: var(--font-xs); }
.storage-disclosure-summary small { color: var(--text-muted); font-size: var(--font-xs); }
.storage-disclosure-summary::after { content: '+'; grid-column: 4; grid-row: 1; justify-self: end; color: var(--text-muted); font-size: 13px; }
.storage-disclosure[open] > .storage-disclosure-summary::after { content: '−'; }
.storage-disclosure-body { padding: 0 15px 15px; border-top: 1px solid var(--border); }
.storage-disclosure-body > :first-child { margin-top: 13px; }
.storage-disclosure .storage-row { grid-template-columns: 90px minmax(220px, 1fr) 100px 110px; min-width: 620px; }

/* ── Projects storage location ─────────────────────────────────────── */
.projects-root-row {
  padding: 10px 12px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  margin-bottom: 8px;
}
.projects-root-info { display: flex; flex-direction: column; gap: 4px; }
.projects-root-current {
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
}
.projects-root-current strong {
  font-family: 'Menlo', 'Monaco', monospace;
  font-size: 12px;
  word-break: break-all;
}
.root-badge {
  display: inline-block;
  padding: 1px 7px;
  font-size: var(--font-xs); font-weight: 700; letter-spacing: 0.06em;
  border-radius: 999px;
  flex-shrink: 0;
}
.root-badge.default { background: rgba(120, 130, 140, 0.18); color: var(--text-muted); }
.root-badge.custom { background: rgba(75, 130, 200, 0.22); color: #60a5fa; }
.projects-root-default-note {
  font-size: var(--font-xs); color: var(--text-muted);
}
.projects-root-default-note code {
  background: var(--bg-secondary); padding: 1px 4px; border-radius: 3px;
  font-size: var(--font-xs);
}
.projects-root-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.projects-root-warning {
  padding: 8px 12px;
  background: rgba(214, 155, 43, 0.08);
  border-left: 3px solid var(--warning, #d69b2b);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
}
.projects-root-warning summary {
  cursor: pointer;
  color: var(--warning, #d69b2b);
  font-weight: 500;
}
.projects-root-warning ul {
  margin: 8px 0 0;
  padding-left: 18px;
  line-height: 1.5;
}
.projects-root-warning li { margin-bottom: 4px; color: var(--text-secondary); }
.projects-root-warning code {
  background: var(--bg-secondary); padding: 1px 4px; border-radius: 3px;
  font-size: var(--font-xs);
}

.archive-channels, .archive-skipped { color: var(--text-secondary); margin: 6px 0; padding-left: 18px; }
.archive-skipped code { overflow-wrap: anywhere; }
.projects-root-status {
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.projects-root-status.ok { background: rgba(75, 200, 100, 0.10); color: var(--success, #5fc070); }
.projects-root-status.warn { background: rgba(214, 155, 43, 0.10); color: var(--warning, #d69b2b); }
.projects-root-status.err { background: rgba(226, 92, 92, 0.10); color: var(--error, #e25c5c); }

.external-root-row {
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
}
.external-root-row .input { flex: 1; min-width: 280px; }
.external-root-status {
  margin: 6px 0 0; padding: 6px 10px;
  background: var(--bg-tertiary); border-radius: var(--radius-sm);
  font-size: var(--font-xs);
}
.external-root-status.ok { color: var(--success, #5fc070); }
.external-root-status.warn { color: var(--warning, #d69b2b); }

.storage-summary {
  display: flex; flex-wrap: wrap; gap: 8px;
  padding: 8px 12px; background: var(--bg-tertiary);
  border-radius: var(--radius-sm); font-size: 12px;
}
.storage-summary .dot { color: var(--text-muted); }

.storage-table {
  display: flex; flex-direction: column; gap: 2px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-tertiary); padding: 4px;
  max-height: 60vh; overflow: auto;
}
.storage-row {
  display: grid;
  grid-template-columns: 80px 1.5fr 110px 90px 130px 100px 130px;
  gap: 8px; align-items: center;
  padding: 6px 8px; font-size: 12px;
  background: var(--bg-secondary); border-radius: var(--radius-sm);
  min-width: 900px;
}
.storage-row.storage-head {
  background: transparent; padding: 6px 8px 4px;
  font-size: var(--font-xs); font-weight: 600; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.04em;
}
.storage-row.uploaded { background: rgba(75, 200, 100, 0.06); }
.storage-row.no-final { opacity: 0.55; }
.col-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-final, .col-clips, .col-other { font-family: 'Menlo', 'Monaco', monospace; font-size: var(--font-xs); }
.col-final .ext-badge {
  margin-left: 4px; padding: 1px 5px;
  background: rgba(96, 165, 250, 0.18); color: #60a5fa;
  border-radius: 4px; font-size: var(--font-xs);
}

.upload-badge {
  display: inline-block; padding: 1px 7px;
  font-size: var(--font-xs); font-weight: 600;
  border-radius: 999px; text-transform: uppercase; letter-spacing: 0.04em;
}
.upload-badge.ok { background: rgba(75, 200, 100, 0.18); color: var(--success, #5fc070); }
.upload-badge.warn { background: rgba(224, 167, 44, 0.18); color: var(--warning, #d9a62e); }
.upload-badge.none { color: var(--text-muted); }

.storage-result {
  padding: 8px 12px; background: var(--bg-tertiary);
  border-left: 3px solid var(--success, #5fc070);
  border-radius: var(--radius-sm); font-size: 12px;
}
.storage-result .error-text { color: var(--error, #e25c5c); margin-left: 4px; }
.cleanup-item-results { margin: 6px 0 0; padding-left: 18px; }

@media (max-width: 980px) {
  .notification-status-grid { grid-template-columns: 1fr; }
  .notification-layout { grid-template-columns: 1fr; }
  .notification-section--events,
  .notification-section--telegram,
  .notification-section--digest { grid-column: auto; }
  .notification-event-grid { grid-template-columns: 1fr; }
  .notification-digest-controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  .notification-setup-step { grid-template-columns: 25px minmax(0, 1fr); }
  .notification-setup-step > .btn,
  .notification-test-action { grid-column: 2; align-items: flex-start; }
  .notification-secret-row,
  .notification-connect-row { align-items: stretch; flex-direction: column; }
  .notification-digest-controls { grid-template-columns: 1fr; }
  .notification-save-bar { position: static; align-items: stretch; flex-direction: column; }
  .notification-save-bar .btn { width: 100%; }
  .storage-advanced-heading { align-items: flex-start; flex-direction: column; gap: 3px; }
  .storage-disclosure-summary { grid-template-columns: 28px minmax(0, 1fr) 18px; }
  .storage-disclosure-summary .overview-badge { grid-column: 2; justify-self: start; margin-left: 0; }
  .storage-disclosure-summary::after { grid-column: 3; }
}

.folder-config-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.folder-config-header,
.folder-config-row {
  display: grid;
  grid-template-columns: 32px 140px 1fr 180px;
  gap: 10px;
  align-items: center;
  padding: 8px 4px;
}
.folder-config-header {
  font-size: var(--font-xs);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 1px solid var(--border);
}
.folder-config-row {
  border-bottom: 1px solid var(--border);
}
.folder-config-row:hover {
  background: var(--bg-hover);
}
.col-order { text-align: center; }
.col-label { font-weight: 500; font-size: 13px; }
.col-generator { font-style: italic; }

.confirm-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.confirm-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 8px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.15s;
}
.confirm-row:hover {
  background: var(--bg-hover);
}
.confirm-row:first-child {
  border-top: 1px solid var(--border);
}
.confirm-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.confirm-label {
  font-size: 14px;
  font-weight: 500;
}
.confirm-desc {
  font-size: 12px;
}
.toggle-switch {
  width: 44px;
  height: 24px;
  border-radius: 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  position: relative;
  transition: all 0.2s;
  flex-shrink: 0;
  cursor: pointer;
}
.toggle-switch.active {
  background: var(--accent);
  border-color: var(--accent);
}
.toggle-knob {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: white;
  position: absolute;
  top: 2px;
  left: 2px;
  transition: transform 0.2s;
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
}
.toggle-switch.active .toggle-knob {
  transform: translateX(20px);
}

.danger-zone {
  border-top: 1px solid var(--error);
  padding-top: 20px;
  margin-top: 20px;
}

.danger-zone h3 {
  color: var(--error);
}

/* Standards sub-tabs */
.sub-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 16px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-primary) 52%, transparent);
}
.sub-tab {
  padding: 8px 12px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--text-secondary);
  background: transparent;
  cursor: pointer;
  font-family: inherit;
  font-size: var(--font-xs);
  transition: all 0.15s;
}
.sub-tab:hover { color: var(--text-primary); border-color: var(--border); background: var(--bg-tertiary); }
.sub-tab.active {
  color: var(--text-primary);
  border-color: rgba(88,198,146,.4);
  background: linear-gradient(145deg, rgba(88,198,146,.14), rgba(227,180,90,.06));
}

.standards-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  padding: 10px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  margin-bottom: 12px;
}
.toolbar-group {
  display: flex;
  align-items: center;
  gap: 6px;
}
.toolbar-label {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--text-muted);
}

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

.path-display {
  display: inline-block;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  font-size: 12px;
  font-family: 'SF Mono', Monaco, monospace;
  color: var(--accent);
  word-break: break-all;
  max-width: 100%;
}

/* Move-asset-location dialog. Uses .modal-overlay above. .modal is a
   one-off here because most dialogs in this file inline their sizing
   on .modal-small; the asset-move modal needs more room for the
   blocker list + paths so we bake a wider variant. */
.modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 24px;
  width: 100%;
  max-height: calc(100vh - 80px);
  overflow-y: auto;
}
.move-assets-summary {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-tertiary);
  padding: 8px 12px;
  display: flex; flex-direction: column; gap: 6px;
}
.move-assets-row {
  display: grid; grid-template-columns: 60px 1fr; gap: 8px;
  align-items: baseline;
  font-size: 12px;
}
.move-assets-blockers {
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: rgba(239, 68, 68, 0.08);
  border-left: 3px solid #ef4444;
  font-size: 12px;
  color: #ef4444;
}
.move-assets-blockers ul { margin: 4px 0 0 18px; padding: 0; }
.move-assets-error {
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: rgba(239, 68, 68, 0.08);
  border-left: 3px solid #ef4444;
  font-size: 12px;
  color: #ef4444;
}

.badge-warning {
  background: rgba(234, 179, 8, 0.15); color: #eab308;
  border: 1px solid rgba(234, 179, 8, 0.3);
}

/* About tab — version/build readout. Two-column k/v with monospace value
   so the version string is easy to read and select for copying. */
.about-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 420px;
}
.about-row {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 12px;
  align-items: baseline;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
}
.about-label {
  color: var(--text-muted);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.about-value {
  color: var(--text-primary);
  font-family: 'JetBrains Mono', SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 13px;
  user-select: text;
}

/* v1.0.45 — Reseason preview modal. Same shape as Compact's preview
   modal (defined in upload.vue scope) — small, scrollable list of
   moves + a Confirm. Lives at the page root via Teleport so it
   overlays everything. */
.reseason-modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 999;
}
.reseason-modal {
  position: fixed; top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  width: min(620px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
  display: flex; flex-direction: column;
  z-index: 1000;
}
.reseason-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.reseason-modal-close {
  background: none; border: none; font-size: 16px;
  color: var(--text-secondary);
  cursor: pointer; padding: 0 4px;
}
.reseason-modal-close:hover { color: var(--text-primary); }
.reseason-modal-body {
  padding: 14px 16px;
  overflow-y: auto;
  flex: 1;
}
.reseason-modal-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
}
.reseason-move-list {
  margin-top: 12px;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  max-height: 320px;
  overflow-y: auto;
}
.reseason-move-row {
  display: flex; gap: 8px; align-items: center;
  padding: 3px 0;
  font-size: 12px;
}
.reseason-move-title {
  flex: 1; min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* v1.0.93+ Niche-moved-to-its-own-tab wayfinder inside the Format tab. */
.niche-moved-pointer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg-tertiary);
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm, 4px);
  font-size: 13px;
  flex-wrap: wrap;
}
.niche-moved-pointer strong { color: var(--accent, #6c8fff); }

.continuity-engine-summary {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent, #6c8fff);
  border-radius: var(--radius-sm, 6px);
  background: var(--bg-tertiary);
  font-size: 13px;
}
.continuity-engine-summary span { color: var(--text-muted); }

/* v1.0.96+ — Niche library inside the Settings → Niche tab. The
   standalone /niches sidebar page used to host this; merged here so
   all niche stuff lives under Settings. */
.sub-tab-section-title {
  margin: 4px 0 8px 0;
  font-size: 14px;
  color: var(--text-primary);
  font-weight: 500;
}
.sub-tab-count {
  color: var(--text-muted);
  font-weight: normal;
  font-size: var(--font-xs);
}
.niche-library-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-top: 6px;
  margin-bottom: 4px;
  gap: 12px;
  flex-wrap: wrap;
}
.niche-lib-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.niche-lib-tile {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-left-width: 3px;
  border-radius: var(--radius-sm, 4px);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: border-color 0.15s;
}
.niche-lib-tile.tile-builtin { border-left-color: var(--accent, #6c8fff); }
.niche-lib-tile.tile-custom { border-left-color: rgba(240, 198, 116, 0.85); }
.niche-lib-tile.tile-active {
  background: rgba(108, 143, 255, 0.06);
  border-color: var(--accent, #6c8fff);
}
.niche-lib-tile .tile-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.niche-lib-tile h5 {
  margin: 0;
  font-size: 14px;
  color: var(--text-primary);
}
.niche-lib-tile .badge {
  font-size: var(--font-xs);
  padding: 1px 7px;
  border-radius: 999px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.niche-lib-tile .badge-builtin { background: rgba(108, 143, 255, 0.12); color: var(--accent, #6c8fff); }
.niche-lib-tile .badge-custom { background: rgba(240, 198, 116, 0.14); color: rgba(240, 198, 116, 0.95); }
.niche-lib-tile .badge-active { background: rgba(108, 143, 255, 0.20); color: var(--accent, #6c8fff); font-weight: 500; }
.niche-lib-tile .tile-tagline {
  margin: 0;
  font-size: var(--font-xs);
  font-style: italic;
  color: var(--text-muted);
}
.niche-lib-tile .tile-description {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}
.niche-lib-tile .tile-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: var(--font-xs);
  color: var(--text-muted);
}
.niche-lib-tile .tile-details summary {
  cursor: pointer;
  font-size: var(--font-xs);
  color: var(--accent, #6c8fff);
  user-select: none;
}
.niche-lib-tile .topic-list {
  list-style: none;
  margin: 6px 0 0 0;
  padding: 0;
  font-size: var(--font-xs);
  line-height: 1.5;
}
.niche-lib-tile .topic-list li {
  color: var(--text-secondary);
}
.niche-lib-tile .topic-more {
  color: var(--text-muted);
  font-style: italic;
}
.niche-lib-tile .detail-row {
  margin-top: 6px;
  font-size: var(--font-xs);
  color: var(--text-secondary);
  line-height: 1.5;
}
.niche-lib-tile .tile-actions {
  display: flex;
  gap: 6px;
  margin-top: 2px;
  flex-wrap: wrap;
}
.niche-lib-tile .btn.danger { color: var(--error, #e25c5c); }

/* v1.4.20 — publishing cadence day picker. */
.cadence-body { margin-top: 14px; }
.cadence-days { display: flex; gap: 6px; flex-wrap: wrap; }
.cadence-day {
  border: 1px solid var(--border, #2a2a2a);
  background: transparent;
  color: inherit;
  border-radius: 999px;
  padding: 6px 14px;
  cursor: pointer;
  font-size: 13px;
}
.cadence-day.on { background: var(--accent, #d9a441); color: #1a1a1a; border-color: transparent; font-weight: 600; }

/* v1.4.18 — the episode shape, read as a summary and edited in place. */
.episode-shape-card {
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 10px;
  padding: 16px;
  background: var(--surface-2, rgba(255, 255, 255, 0.02));
}
.episode-shape-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.episode-shape-head h4 { margin: 2px 0 6px; }
.episode-shape-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-top: 14px;
}
.episode-shape-item { display: flex; flex-direction: column; gap: 2px; }
.episode-shape-item > span { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.65; }
.episode-shape-item > strong { font-size: 18px; }
.episode-shape-item > small { opacity: 0.6; }
.episode-shape-form { margin-top: 14px; }
.episode-shape-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.episode-shape-fields label { display: flex; flex-direction: column; gap: 4px; }
.episode-shape-fields label > span { font-size: 13px; opacity: 0.8; }
.episode-shape-maths { margin: 12px 0 0; }
.episode-shape-check { display: flex; gap: 10px; align-items: flex-start; margin-top: 14px; }
.episode-shape-check small { display: block; margin-top: 2px; }
.episode-shape-tone { display: flex; flex-direction: column; gap: 4px; margin-top: 14px; }
.episode-shape-tone > span { font-size: 13px; opacity: 0.8; }
.episode-shape-tone textarea { width: 100%; resize: vertical; }
.episode-shape-actions { display: flex; gap: 8px; margin-top: 16px; }

.production-kit-card {
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border));
  border-radius: 14px;
  padding: 16px;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--accent) 10%, transparent), transparent 48%),
    var(--bg-secondary);
}
.production-kit-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.production-kit-head h4 { margin: 3px 0 5px; }
.production-kit-head p {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-sm);
  line-height: 1.5;
  max-width: 900px;
}
.production-kit-status {
  flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, var(--accent) 52%, var(--border));
  border-radius: 999px;
  padding: 5px 9px;
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.production-kit-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-top: 14px;
}
.production-kit-item {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 11px 12px;
  background: color-mix(in srgb, var(--bg-primary) 72%, transparent);
}
.production-kit-item > span,
.production-kit-profiles > span {
  display: block;
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.production-kit-item strong {
  display: block;
  margin-top: 4px;
  color: var(--text-primary);
  font-size: var(--font-sm);
}
.production-kit-item small,
.production-kit-profiles small {
  display: block;
  margin-top: 5px;
  color: var(--text-muted);
  font-size: var(--font-xs);
  line-height: 1.4;
}
.production-kit-profiles {
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.production-kit-profiles > div {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 7px;
}
.production-profile-pill {
  border-radius: 999px;
  padding: 5px 9px;
  background: color-mix(in srgb, var(--accent) 14%, var(--bg-primary));
  color: var(--text-primary);
  font-size: var(--font-xs);
  font-weight: 600;
}
.audio-quality-settings {
  border-top: 1px solid var(--border);
  padding-top: 18px;
}
.audio-quality-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
  margin-top: 14px;
}
.audio-quality-option {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 9px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  cursor: pointer;
}
.audio-quality-option.active {
  border-color: color-mix(in srgb, var(--accent) 58%, var(--border));
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-secondary));
}
.audio-quality-option input { flex: none; margin-top: 3px; accent-color: var(--accent); }
.audio-quality-option > span { min-width: 0; }
.audio-quality-option strong { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--text-primary); font-size: var(--font-sm); }
.audio-quality-option strong small {
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--accent-dim);
  color: var(--accent);
  font-size: var(--font-xs);
}
.audio-quality-option > span > span { display: block; margin-top: 4px; color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.45; }
.audio-quality-alternate { max-width: 720px; margin-top: 14px; }
.audio-quality-alternate > label { display: block; margin-bottom: 6px; color: var(--text-primary); font-size: var(--font-sm); font-weight: 650; }
.audio-quality-cost-note {
  max-width: 75ch;
  margin: 12px 0 0;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: 1.5;
}
.audio-quality-save-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; }
@media (max-width: 1100px) {
  .production-kit-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 680px) {
  .production-kit-head { flex-direction: column; }
  .production-kit-grid { grid-template-columns: 1fr; }
  .audio-quality-options { grid-template-columns: 1fr; }
  .audio-quality-save-row .btn { width: 100%; justify-content: center; }
}

.channel-identity-summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  padding: 16px;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--border));
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 5%, var(--bg-secondary));
}
.channel-identity-summary-copy { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.channel-identity-summary-copy > span { color: var(--text-muted); font-size: var(--font-xs); font-weight: 700; }
.channel-identity-summary-copy > strong { overflow: hidden; color: var(--text-primary); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.channel-identity-summary-copy > small { color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.4; }
@media (max-width: 820px) {
  .channel-identity-summary { grid-template-columns: 1fr; align-items: stretch; }
  .channel-identity-summary .btn { justify-self: start; }
}

/* v1.0.391 — local server pool status card */
.pool-status-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  background: var(--bg-secondary);
  margin: 8px 0 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pool-status-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pool-row { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.pool-label { min-width: 130px; }
.pool-count { font-weight: 600; }
.pool-count.pool-ok { color: var(--accent); }
.pool-count.pool-zero { color: var(--danger, #e5534b); }
.pool-dots { display: inline-flex; gap: 3px; flex-wrap: wrap; }
.pool-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.pool-dot.on { background: var(--success, #3fb950); }
.pool-dot.off { background: var(--danger, #e5534b); opacity: 0.6; }
</style>
