<template>
  <div class="settings-workspace">
    <header class="settings-page-hero">
      <div class="settings-page-copy">
        <span class="settings-page-eyebrow">Control room</span>
        <h1>Settings</h1>
        <p>Configure this Mac and shape how <strong>{{ project?.name || 'this project' }}</strong> creates, stores, and finishes every episode.</p>
      </div>
      <div class="settings-page-key" aria-label="Settings storage key">
        <span><i class="key-dot key-machine" />This Mac</span>
        <span><i class="key-dot key-project" />This Project</span>
      </div>
    </header>

    <!-- v1.0.184 (S1) — grouped + scope-zoned settings nav. Replaces the flat
         15-tab row. Two scopes (This Mac vs This Project) make it obvious what
         travels with the project vs. what stays on this machine; topic groups
         within each make 15 entries scannable. `tabs` (flat) is still derived
         below for back-compat (deep links, saved tab state). -->
    <nav class="settings-nav mt-3">
      <div v-for="zone in tabZones" :key="zone.id" class="settings-zone">
        <div class="settings-zone-head">
          <span class="settings-zone-title">{{ zone.title }}</span>
          <span class="settings-zone-scope">{{ zone.scope }}</span>
        </div>
        <div v-for="group in zone.groups" :key="group.title" class="settings-group">
          <span class="settings-group-label">{{ group.title }}</span>
          <div class="settings-group-tabs">
            <button
              v-for="tab in group.tabs"
              :key="tab.id"
              :class="['tab', { active: activeTab === tab.id }]"
              :aria-current="activeTab === tab.id ? 'page' : undefined"
              @click="activeTab = tab.id"
            >
              <span class="settings-tab-icon" aria-hidden="true">{{ tab.icon }}</span>
              <span>{{ tab.label }}</span>
            </button>
          </div>
        </div>
      </div>
    </nav>

    <section
      v-if="activeZone && activeTabMeta"
      :class="['settings-active-intro', activeZone.id === 'machine' ? 'scope-machine' : 'scope-project']"
    >
      <span class="settings-active-icon" aria-hidden="true">{{ activeTabMeta.icon }}</span>
      <div class="settings-active-copy">
        <span class="settings-active-kicker">{{ activeZone.title }}</span>
        <h2>{{ activeTabMeta.label }}</h2>
        <p>{{ activeTabMeta.description }}</p>
      </div>
      <span class="settings-scope-pill">
        {{ activeZone.id === 'machine' ? 'Stays on this Mac' : 'Travels with project' }}
      </span>
    </section>

    <!-- App (per-machine): API Keys + Appearance + Server Mode + the
         account-scoped GenStudio catalog summary.
         v1.0.185 (S2) — folded the standalone App-Settings modal into the
         "This Mac" zone here. Same <ThisMacSettings> component the modal now
         wraps, so there is one source of truth. It owns its own data
         lifecycle (loads on mount / when this tab is shown). -->
    <div v-if="activeTab === 'app'" class="card settings-panel settings-panel-embedded mt-2">
      <ThisMacSettings />
      <GenStudioCatalogSettings />
    </div>

    <!-- Historical editor retained in source for project evidence migration; never customer-visible. -->
    <div v-if="false" class="card settings-panel mt-2">
      <div class="settings-section-head">
        <div>
          <span class="settings-section-kicker">Generation catalog</span>
          <h3>Model pricing &amp; limits</h3>
          <p>Maintain only the operational values Story Studio needs for estimates and safe provider requests.</p>
        </div>
        <span class="settings-section-count">{{ Object.keys(editImageModels).length + Object.keys(editVideoModels).length }} models</span>
      </div>

      <nav class="settings-segmented-nav" aria-label="Model pricing categories">
        <button
          v-for="view in modelPricingViews"
          :key="view.id"
          type="button"
          :class="['settings-segmented-button', { active: modelPricingView === view.id }]"
          :aria-current="modelPricingView === view.id ? 'page' : undefined"
          @click="modelPricingView = view.id"
        >
          <span aria-hidden="true">{{ view.icon }}</span>
          <span><strong>{{ view.label }}</strong><small>{{ view.description }}</small></span>
        </button>
      </nav>

      <section v-if="modelPricingView === 'image'" class="settings-subpanel">
      <div class="card-header">
        <h3>Image Model Pricing</h3>
        <span class="text-muted" style="font-size:12px" v-if="config?.image_pricing_last_updated">
          Updated: {{ config.image_pricing_last_updated }}
        </span>
      </div>
      <table class="edit-table mt-1">
        <thead>
          <tr><th>Model</th><th>Credits/Image</th></tr>
        </thead>
        <tbody>
          <tr v-for="(model, key) in editImageModels" :key="key">
            <td>{{ model.label }}</td>
            <td>
              <input v-model.number="model.credits_per_image" type="number" step="0.5" min="0" class="input input-sm" />
            </td>
          </tr>
        </tbody>
      </table>
      <div class="flex gap-2 mt-2" style="align-items: center;">
        <button class="btn btn-primary" @click="saveImagePricing">Save Image Pricing</button>
        <SaveIndicator v-bind="savedHintProps('image_pricing')" />
      </div>
      </section>

      <section v-if="modelPricingView === 'video'" class="settings-subpanel">
      <div class="card-header">
        <h3>Video Studio catalog</h3>
        <span class="text-muted" style="font-size:12px">Live via {{ videoModelSourceLabel }}</span>
      </div>
      <p class="text-muted mt-1 mb-2" style="font-size: 12px; line-height: 1.5;">
        Image-to-video only. Video Studio owns provider setup, availability, pricing, and model retirement;
        Story Studio reads the live catalog and falls back to the local Video Studio connection.
      </p>
      <table class="edit-table mt-1">
        <thead>
          <tr><th>Model</th><th>Lane</th><th>Max clip</th><th>Provider price</th></tr>
        </thead>
        <tbody>
          <tr v-for="(model, key) in editVideoModels" :key="key">
            <td>{{ model.label }}</td>
            <td>{{ model.provider_params?.is_cloud ? 'Cloud' : 'Local' }}</td>
            <td>{{ model.max_duration ? `${model.max_duration}s` : 'Provider default' }}</td>
            <td>{{ formatVideoStudioPrice(model) }}</td>
          </tr>
          <tr v-if="!Object.keys(editVideoModels).length">
            <td colspan="4" class="text-muted">No ready image-to-video models are currently available.</td>
          </tr>
        </tbody>
      </table>
      <div class="flex gap-2 mt-2" style="align-items: center;">
        <button class="btn btn-secondary" :disabled="refreshingVideoModels" @click="refreshVideoCatalog">
          {{ refreshingVideoModels ? 'Refreshing…' : 'Refresh live catalog' }}
        </button>
      </div>
      </section>
    </div>

    <!-- Saved cloud voices -->
    <div v-if="false" class="card settings-panel mt-2">
      <div class="voice-library-heading">
        <div>
          <h3>Voice library</h3>
          <p class="text-muted mt-1">
            Save voice or clone IDs once, then label every provider that can use them. Audio Generator only shows compatible voices.
          </p>
        </div>
        <span class="voice-count">{{ editVoices.length }} saved</span>
      </div>

      <div class="voice-library-toolbar">
        <div class="voice-provider-filters" aria-label="Filter voices by provider">
          <button
            type="button"
            class="voice-filter"
            :class="{ active: voiceProviderFilter === 'all' }"
            @click="voiceProviderFilter = 'all'"
          >All <span>{{ editVoices.length }}</span></button>
          <button
            v-for="provider in VOICE_PROVIDER_OPTIONS"
            :key="provider.id"
            type="button"
            class="voice-filter"
            :class="{ active: voiceProviderFilter === provider.id }"
            @click="voiceProviderFilter = provider.id"
          >{{ provider.label }} <span>{{ voiceProviderCounts[provider.id] || 0 }}</span></button>
        </div>
        <select v-model="voiceSort" class="select select-sm voice-sort" aria-label="Sort voices">
          <option value="provider">Provider, then name</option>
          <option value="name-asc">Name A-Z</option>
          <option value="name-desc">Name Z-A</option>
        </select>
      </div>

      <div v-if="filteredVoiceRows.length" class="voice-list">
        <article v-for="row in filteredVoiceRows" :key="row.voice.voice_id || row.index" class="voice-row-edit">
          <div class="voice-fields">
            <input v-model="row.voice.name" class="input input-sm voice-name-input" placeholder="Voice name" />
            <input v-model="row.voice.voice_id" class="input input-sm voice-id-input" placeholder="Voice or reference ID" spellcheck="false" />
          </div>
          <div class="voice-provider-labels">
            <span class="voice-provider-prompt">Works with</span>
            <label
              v-for="provider in VOICE_PROVIDER_OPTIONS"
              :key="provider.id"
              class="voice-provider-toggle"
              :class="{ active: row.voice.providers.includes(provider.id) }"
            >
              <input
                type="checkbox"
                :checked="row.voice.providers.includes(provider.id)"
                @change="toggleVoiceProvider(row.voice, provider.id)"
              />
              {{ provider.label }}
            </label>
          </div>
          <button class="btn-icon danger voice-remove" type="button" title="Remove voice" @click="editVoices.splice(row.index, 1)">&#10005;</button>
        </article>
      </div>
      <div v-else class="voice-empty">
        No voices match this provider. Add one below or choose another filter.
      </div>

      <div class="flex gap-2 mt-3 items-center flex-wrap">
        <button class="btn btn-secondary btn-sm" type="button" @click="addVoice">+ Add Voice</button>
        <button class="btn btn-primary btn-sm" type="button" @click="saveVoices">Save Voices</button>
        <SaveIndicator v-bind="savedHintProps('voices')" />
      </div>
    </div>

    <div v-if="activeTab === 'styles'" class="card settings-panel mt-2">
      <ProjectStyleLibrary
        :project-slug="slug"
        title="Project style library"
        :show-built-in-starters="true"
      />
    </div>

    <!-- Channel Identity — production path -->
    <div v-if="activeTab === 'channel'" class="card settings-panel mt-2">
      <div class="format-tab-header">
        <div>
          <h3>Continuity Engine</h3>
          <p class="text-muted mt-1 mb-2">
            This is the one production engine for every channel. Choose how it handles
            scene references; the <strong>Series Formula</strong> below
            owns titles, perspective, voice, and script structure.
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
            <div><strong>Explainer boards</strong><div class="text-muted text-xs">Independent subject-led scenes, ready for an optional visual recipe or composition reference.</div></div>
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

      <!-- v1.0.760 — per-project Research gate. -->
      <section class="channel-research-gate mt-3">
        <div class="settings-section-head">
          <div>
            <span class="settings-section-kicker">Evidence policy</span>
            <h3>Require reviewed research</h3>
            <p>
              For science, history, and other evidence-led channels. When this is on, an episode is not complete
              until its research has been generated <strong>and</strong> every claim has been marked Verified or
              Ignore on the Research page, with at least one claim kept. Generating research is not enough on
              its own.
            </p>
          </div>
          <span class="settings-section-count">{{ researchRequired ? 'Required' : 'Optional' }}</span>
        </div>
        <label class="research-gate-toggle">
          <input
            v-model="researchRequired"
            type="checkbox"
            :disabled="savingResearchGate"
            @change="saveResearchGate"
          />
          <span>
            <strong>Every research claim must be reviewed before an episode counts as complete</strong>
            <span class="research-gate-hint">
              Research with claims still awaiting a decision stays in the Research page's pending list and blocks
              the Production Board. One-click Pipeline runs decide the leftovers automatically and record that a
              machine did it, so unattended runs are never blocked. Turning this off restores the previous
              behaviour, where research is optional enrichment that never blocks anything.
            </span>
          </span>
        </label>
        <SaveIndicator v-bind="savedHintProps('research_gate')" />
      </section>

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

    </div>

    <div v-if="isChannelTab" class="card publishing-profile-card mt-2">
      <div class="settings-section-head">
        <div>
          <span class="settings-section-kicker">YouTube publishing</span>
          <h3>Publishing Profile</h3>
          <p>Set channel-wide links, credits, CTAs, disclosures, recurring tags, and an optional title wrapper once. The selected Series Formula continues to own episode-specific metadata.</p>
        </div>
        <NuxtLink :to="`/projects/${slug}/metadata-template`" class="btn btn-primary">Configure publishing profile</NuxtLink>
      </div>
    </div>

    <!-- Channel Identity — formula + subject lane layer. -->
    <div v-if="activeTab === 'channel'" class="card settings-panel mt-2">
      <div class="format-tab-header">
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

      <div class="sub-tabs mt-3">
        <button
          :class="['sub-tab', { active: nicheSubTab === 'project' }]"
          @click="nicheSubTab = 'project'"
        >Project formula</button>
        <button
          :class="['sub-tab', { active: nicheSubTab === 'library' }]"
          @click="nicheSubTab = 'library'"
        >Formula library <span class="sub-tab-count">· {{ nicheLibraryCount }}</span></button>
      </div>

      <!-- ── Sub-tab 1: Project niche picker ───────────────────────── -->
      <div v-if="nicheSubTab === 'project'" class="sub-tab-body">
        <h4 class="sub-tab-section-title">Choose the formula and subject lanes this channel uses</h4>
        <NichePicker v-model="nicheId" @change="onNicheChanged" />
        <TopicPackPicker
          v-model="topicPackIds"
          class="mt-3"
          :series-formula-id="nicheId"
          :disabled="nicheSaving"
        />

        <section v-if="selectedProductionKit" class="production-kit-card mt-3">
          <div class="production-kit-head">
            <div>
              <span class="settings-section-kicker">Formula production kit</span>
              <h4>{{ selectedProductionKit.label }}</h4>
              <p>{{ selectedProductionKit.description }}</p>
            </div>
            <span class="production-kit-status">Applies with Formula</span>
          </div>

          <div class="production-kit-grid">
            <div class="production-kit-item">
              <span>Visual style</span>
              <strong>{{ selectedProductionKitStyleName }}</strong>
              <small>Applied automatically unless you already chose a different project style.</small>
            </div>
            <div class="production-kit-item">
              <span>Thumbnail recipe</span>
              <strong>{{ selectedProductionKitThumbnailName }}</strong>
              <small>Selected automatically as the Formula default; still overridable in Thumbnail Prompts.</small>
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

        <div class="mt-3 button-row">
          <button class="btn btn-primary" :disabled="nicheSaving || !nicheDirty" @click="saveNicheSettings">
            {{ nicheSaving ? 'Saving…' : 'Save Channel Identity' }}
          </button>
          <SaveIndicator v-bind="savedHintProps('niche')" />
          <span v-if="nicheSaveError" class="text-error">{{ nicheSaveError }}</span>
        </div>

        <p class="text-muted text-xs mt-3">
          <strong>Channel default:</strong> this Formula and Pack selection automatically drives
          Ideas, Script, Metadata, and visual direction. Idea campaigns show it as status rather
          than asking you to select it again.
        </p>
        <p class="text-muted text-xs mt-1">
          Need to add a new formula? Switch to the <strong>Formula library</strong> sub-tab above.
        </p>
      </div>

      <!-- ── Sub-tab 2: Niche library (browse + create + delete) ─────── -->
      <div v-if="nicheSubTab === 'library'" class="sub-tab-body">
        <div class="niche-library-header">
          <h4 class="sub-tab-section-title">Formula library</h4>
          <button
            class="btn btn-primary btn-sm"
            :disabled="nicheCreateBusy"
            @click="openNicheCreator"
          >+ Create custom niche</button>
        </div>
        <p class="text-muted text-sm">
          All built-in + custom niches available on this machine. Built-in niches
          are read-only (shipped with the app). Custom niches are stored under your
          user data dir and can be deleted if no project still references them.
        </p>

        <div v-if="nicheLibLoading" class="muted mt-3">Loading niches…</div>
        <div v-else-if="nicheLibError" class="error-box mt-3">{{ nicheLibError }}</div>
        <div v-else-if="!nicheLibList.length" class="empty-box mt-3">
          No niches found. Create your first custom niche, or restore the built-ins
          by reinstalling the app.
        </div>

        <div v-else class="niche-lib-grid mt-3">
          <article
            v-for="n in nicheLibList"
            :key="n.id"
            class="niche-lib-tile"
            :class="{ 'tile-builtin': n.builtin, 'tile-custom': !n.builtin, 'tile-active': n.id === nicheId }"
          >
            <div class="tile-header">
              <h5>{{ n.name }}</h5>
              <span v-if="n.id === nicheId" class="badge badge-active">project niche</span>
              <span v-if="!n.builtin" class="badge badge-custom">custom</span>
              <span v-else class="badge badge-builtin">built-in</span>
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
              <div v-if="n.negativePromptAddendum" class="detail-row">
                <strong>Negative:</strong> {{ n.negativePromptAddendum }}
              </div>
            </details>
            <div class="tile-actions">
              <button
                v-if="n.id !== nicheId"
                class="btn btn-ghost btn-sm"
                :title="'Use this niche on the current project (still requires Save below).'"
                @click="useNicheOnProject(n.id)"
              >Use on this project</button>
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

    <!-- Optional project instructions — retained for channel-specific facts
         and constraints, but Formula rules stay authoritative. -->
    <div v-if="activeTab === 'standards'" class="card settings-panel mt-2">
      <div class="sub-tabs">
        <button v-for="st in standardsSubTabs" :key="st.id" :class="['sub-tab', { active: standardsSubTab === st.id }]" @click="standardsSubTab = st.id">
          {{ st.label }}
        </button>
      </div>

      <div class="sub-tab-body">
        <h3>{{ currentStandardDoc.title }}</h3>
        <p class="text-muted mt-1 mb-2">{{ currentStandardDoc.description }}</p>

        <!-- Starter templates + preset dropdown -->
        <div class="standards-toolbar">
          <div class="toolbar-group">
            <label class="toolbar-label">Start from</label>
            <select v-model="selectedTemplateId" class="select input-sm">
              <option value="">— pick a template —</option>
              <option v-for="t in currentTemplates" :key="t.id" :value="t.id">{{ t.name }}</option>
            </select>
            <button class="btn btn-secondary btn-sm" :disabled="!selectedTemplateId" @click="loadStarterTemplate">Load</button>
          </div>

          <div class="toolbar-group" v-if="currentPresets.length">
            <label class="toolbar-label">Saved presets</label>
            <select v-model="selectedPresetId" class="select input-sm">
              <option value="">— none —</option>
              <option v-for="p in currentPresets" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <button class="btn btn-secondary btn-sm" :disabled="!selectedPresetId" @click="loadPreset">Load</button>
            <button class="btn btn-secondary btn-sm" :disabled="!selectedPresetId" @click="deletePreset" title="Delete preset">✕</button>
          </div>

          <button class="btn btn-secondary btn-sm" @click="copyAsAiPrompt" title="Copy a chatbot-ready prompt to your clipboard">📋 Copy as AI refine prompt</button>
          <button class="btn btn-secondary btn-sm" @click="showSavePreset = true">💾 Save as preset</button>
        </div>

        <textarea
          v-model="currentStandardText"
          class="textarea"
          style="min-height: 400px; font-family: monospace; font-size: 13px;"
          :placeholder="currentStandardDoc.placeholder"
        />

        <div class="flex gap-2 mt-2" style="align-items: center;">
          <button class="btn btn-primary" @click="saveStandardsCurrent">Save</button>
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
            @keyup.enter.stop.prevent="savePreset"
            @keydown.escape="showSavePreset = false"
          />
          <div class="flex gap-2 mt-2" style="justify-content:flex-end">
            <button class="btn btn-secondary" @click="showSavePreset = false">Cancel</button>
            <button class="btn btn-primary" :disabled="!newPresetName.trim()" @click="savePreset">Save preset</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Folders -->
    <div v-if="activeTab === 'folders'" class="card settings-panel mt-2">
      <h3>Folder Structure</h3>
      <p class="text-muted mt-1 mb-2">
        Customize how episode subfolders are named. Each template must include <code>{'{code}'}</code> which is replaced with the episode code (e.g. TN0024).
      </p>

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
        <button class="btn btn-primary" @click="saveFolderConfig">Save Folder Config</button>
        <button class="btn btn-secondary" @click="resetFolderDefaults">Reset to Defaults</button>
        <SaveIndicator v-bind="savedHintProps('folder_config')" />
      </div>

      <p class="text-muted mt-2" style="font-size:12px">
        💡 After saving, use <strong>Sync Folders</strong> in the Project tab to rename existing episode folders to match the new names.
      </p>
    </div>

    <!-- (The Assets audit/repair UI once lived in this Settings tab, then in a
         standalone /assets page. v1.0.481 retired both: the audit matrix is
         redundant with the Production Board, and Repair moved into the board's
         ↻ Repair… dialog — see frontend/components/RepairAssetsDialog.vue.) -->

    <!-- Storage — per-episode disk usage + cleanup of uploaded final
         videos + external-root configuration. The pain point this
         tab solves: long-form video projects produce 5-10 GB final
         video files that bog down iCloud sync. Once a video is on
         YouTube (sidecar shows video_id), the local copy is
         operationally redundant and can be deleted to reclaim disk. -->
    <div v-if="activeTab === 'storage'" class="card settings-panel storage-panel mt-2">
      <header class="settings-section-head">
        <div>
          <span class="settings-section-kicker">Files &amp; capacity</span>
          <h3>Storage control center</h3>
          <p>Keep projects together, place large final videos deliberately, and reclaim space without touching source assets.</p>
        </div>
        <span class="settings-section-count">{{ storage ? formatBytes(storage.project_bytes_total) : 'Not scanned' }}</span>
      </header>

      <!-- ── Cloud Sync Overview (top-of-tab indicator) ────────────────
           Surfaces all three storage subsystems with their current state
           and a 1-line description so users can scan it and know what's
           available + which warnings apply. Replaces the legacy
           "Cloud sync is paused" dashboard banner: that banner pointed
           at a feature that no longer exists; this card points at the
           feature that DID replace it. -->
      <div class="cloud-sync-overview storage-map">
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
              <strong>Project library</strong>
              <span :class="['overview-badge', projectsRoot?.is_overridden ? 'on' : 'off']">
                {{ projectsRoot?.is_overridden ? 'CUSTOM' : 'DEFAULT' }}
              </span>
            </div>
            <p class="overview-card-desc">
              {{ projectsRoot?.is_overridden
                ? 'All project metadata and co-located assets start from this custom folder.'
                : 'Uses Story Studio’s standard project folder on this Mac.' }}
            </p>
            <code class="overview-card-path">{{ projectsRoot?.effective_path || '(loading)' }}</code>
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

          <a class="overview-card" href="#per-episode-section" @click.prevent="scrollTo('per-episode-section')">
            <div class="overview-card-head">
              <span class="overview-card-icon">🧹</span>
              <strong>Space recovery</strong>
              <span class="overview-badge info">
                {{ storage ? `${storage.episodes.filter(e => e.uploaded_to_youtube && e.bytes_final_video > 0).length} eligible` : 'unscanned' }}
              </span>
            </div>
            <p class="overview-card-desc">
              Safely remove uploaded final exports. Original audio, images,
              motion clips, and project files remain untouched.
            </p>
          </a>

          <a class="overview-card overview-card--advanced" href="#media-root-section" @click.prevent="scrollTo('media-root-section')">
            <div class="overview-card-head">
              <span class="overview-card-icon">⌁</span>
              <strong>Heavy media split</strong>
              <span :class="['overview-badge', mediaRootSavedValue ? 'on' : 'off']">
                {{ mediaRootSavedValue ? 'ACTIVE' : 'ADVANCED' }}
              </span>
            </div>
            <p class="overview-card-desc">
              {{ mediaRootSavedValue
                ? 'This project currently stores heavy media separately. Keep its mapped drive available.'
                : 'Optional only. Leave off when you want every project and its assets kept together.' }}
            </p>
            <code v-if="mediaRootSavedValue" class="overview-card-path">{{ mediaRootSavedValue }}</code>
          </a>
        </div>

        <details class="overview-warnings">
          <summary>Cross-machine and cloud-folder notes</summary>
          <ul>
            <li>
              <strong>API keys are per-machine.</strong> Each Mac encrypts its
              own keys with a machine-derived key — they don't decrypt across
              devices. You'll re-enter keys (Settings → API Keys) on every Mac.
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
      <!-- Lets the user point the projects folder at any local path —
           typically inside iCloud Drive / Dropbox / Google Drive so
           the OS handles cross-machine sync. Per-machine setting
           (lives in app-settings.json which doesn't sync). -->
      <div id="projects-root-section" class="storage-section storage-surface">
        <h4><span class="storage-section-icon" aria-hidden="true">📁</span>Projects storage location</h4>
        <p class="text-muted hint">
          Where this Mac stores your projects. Move it to an iCloud Drive
          (or Dropbox / Google Drive) folder to work across machines.
          The app restarts after the move to pick up the new location.
        </p>
        <p class="text-muted voice-helper-line">
          💡 Tip: For cross-machine sync, point this at a folder inside
          <code>~/Library/Mobile Documents/com~apple~CloudDocs/</code>
          (your iCloud Drive). Final videos can stay off iCloud using the
          External final-video root below.
        </p>
        <div class="projects-root-row">
          <div class="projects-root-info">
            <div class="projects-root-current">
              <strong>{{ projectsRoot?.effective_path || 'Loading…' }}</strong>
              <span v-if="projectsRoot" :class="['root-badge', projectsRoot.is_overridden ? 'custom' : 'default']">
                {{ projectsRoot.is_overridden ? 'CUSTOM' : 'DEFAULT' }}
              </span>
            </div>
            <div v-if="projectsRoot?.is_overridden" class="projects-root-default-note">
              Default location: <code>{{ projectsRoot.default_path }}</code>
            </div>
          </div>
        </div>
        <div class="projects-root-actions">
          <button
            class="btn btn-primary btn-sm"
            :disabled="projectsRootBusy"
            title="First-machine setup: copies your existing projects to the chosen location. Opens the macOS folder picker (only works in the packaged app — not in dev/tsx mode)."
            @click="browseAndMoveProjectsRoot"
          >
            📂 Browse + move projects there & restart
          </button>
          <button
            class="btn btn-secondary btn-sm"
            :disabled="projectsRootBusy"
            title="Second-machine setup: point at a folder that already has projects (e.g. an iCloud-synced folder from another Mac). Doesn't copy anything. Opens the macOS folder picker (only works in the packaged app)."
            @click="browseAndUseExistingProjectsRoot"
          >
            📂 Use existing folder (no copy)
          </button>
          <button
            v-if="projectsRoot?.is_overridden"
            class="btn btn-secondary btn-sm"
            :disabled="projectsRootBusy"
            title="Stop using the custom path; the app will read from the default location after restart"
            @click="resetProjectsRoot"
          >
            Reset to default
          </button>
        </div>
        <!-- (Removed: duplicate per-section warnings panel. The same
             content is in the top-of-tab Cloud sync overview card now,
             so it doesn't have to be re-disclosed in every section.) -->
        <div v-if="projectsRootStatus" :class="['projects-root-status', projectsRootStatusKind]">
          {{ projectsRootStatus }}
        </div>
        <div v-if="projectsRootPickerHelp" class="manual-path-hint">
          {{ projectsRootPickerHelp }}
        </div>
      </div>

      <!-- ── External final-video root (per-machine) ─────────────── -->
      <div id="external-video-section" class="storage-section storage-surface">
        <h4>
          <span class="storage-section-icon" aria-hidden="true">🎬</span>
          External final-video root
          <span class="optional-tag">(per-machine, optional)</span>
        </h4>
        <p class="text-muted hint">
          Final videos are big (5–10 GB each). If your project lives in
          iCloud Drive, set an external root on a local disk (e.g.
          <code>~/Movies/Story Studio</code> or an external drive) so iCloud
          doesn't sync those files. Project-tree finals still detect
          normally — both locations are checked at upload time. Stored in
          <code>app-settings.json</code> per-machine, so each device picks
          its own path (or leaves it unset).
        </p>
        <p class="text-muted voice-helper-line">
          💡 Type or paste a path directly — handy in dev mode or when the
          folder picker is blocked. Click "Save manual path" to persist.
        </p>
        <div class="external-root-row">
          <!-- Always-editable path so users can paste from Finder's
               "Get Info → Where", or use this as a fallback when the
               native picker isn't available (dev/tsx mode). Browse opens
               the picker and auto-saves on success. Clear empties + saves
               an empty value so the project tree is used again. -->
          <input
            v-model="externalRootInput"
            class="input"
            placeholder="(not set — finals stay in the project tree)"
            spellcheck="false"
          />
          <button
            class="btn btn-primary btn-sm"
            :disabled="externalRootSaving"
            title="Opens the macOS folder picker. Only works in the packaged app — in dev mode (tsx watch), type the path above and click Save manual path."
            @click="browseAndSetExternalRoot"
          >
            {{ externalRootSaving ? 'Saving…' : '📂 Browse…' }}
          </button>
          <button
            v-if="externalRootInput.trim() !== externalRootSavedValue"
            class="btn btn-secondary btn-sm"
            :disabled="externalRootSaving"
            title="Save the path you typed. Use this when Browse doesn't work (dev mode) or when you've pasted a path manually."
            @click="saveExternalRoot"
          >
            {{ externalRootSaving ? 'Saving…' : '💾 Save manual path' }}
          </button>
          <button
            v-if="externalRootInput"
            class="btn btn-ghost btn-sm"
            :disabled="externalRootSaving"
            title="Clear the external path — future finals will land in the project tree"
            @click="clearExternalRoot"
          >Clear</button>
          <button
            class="btn btn-secondary btn-sm"
            :disabled="!externalRootInput || migrateRunning"
            :title="!externalRootInput ? 'Pick the external path first' : 'Move existing final videos in this project to the external root'"
            @click="runMigration"
          >
            {{ migrateRunning ? 'Migrating…' : 'Migrate finals here →' }}
          </button>
        </div>
        <p v-if="externalRootStatus" :class="['external-root-status', externalRootReachable ? 'ok' : 'warn']">
          {{ externalRootStatus }}
        </p>
        <div v-if="externalRootPickerHelp" class="manual-path-hint">
          {{ externalRootPickerHelp }}
        </div>
        <div v-if="lastMigration" class="storage-result">
          <strong>Migration:</strong>
          {{ lastMigration.moved.length }} file(s) moved
          ({{ formatBytes(lastMigration.bytes_moved) }} freed from project tree).
          <span v-if="lastMigration.errors.length" class="error-text">
            {{ lastMigration.errors.length }} error(s).
          </span>
        </div>
      </div>

      <!-- ── External media root (Level B, per-project, opt-in) ──── -->
      <div class="storage-advanced-heading">
        <span>Optional storage split</span>
        <p>Leave this off when you want the project and all of its assets to stay together.</p>
      </div>
      <details id="media-root-section" class="storage-disclosure" :open="!!mediaRootSavedValue">
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
          portable token like <code>${MEDIA}</code> so the same project works
          across Macs — set where it points on each machine under
          <a href="#" @click.prevent="activeTab = 'roots'">Named Roots</a>.
          Leave blank to keep everything under the project's output folder (the default).
        </p>
        <div class="external-root-row">
          <input
            v-model="mediaRootInput"
            class="input"
            placeholder="(not set — media stays in the project tree)   e.g. ${MEDIA}"
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
      <div id="per-episode-section" class="storage-section storage-surface">
        <div class="flex items-center" style="justify-content: space-between; gap: 12px;">
          <div>
            <h4><span class="storage-section-icon" aria-hidden="true">📊</span>Per-episode breakdown</h4>
            <p class="text-muted hint">
              Sorted largest first. Click "Free up final" to delete the
              local <code>{code}_final_video.*</code> files for an
              uploaded episode (the sidecar's <code>video_id</code>
              guards against accidental deletion of unpublished work).
            </p>
            <p class="text-muted voice-helper-line">
              💡 The video on YouTube is the source of truth — re-render
              from images + merged audio, or re-download from YouTube, if
              you ever need a deleted final back. Audio + image assets are
              never touched by Free up final.
            </p>
          </div>
          <div class="flex gap-2">
            <button class="btn btn-secondary btn-sm" :disabled="auditLoading" @click="loadStorageAudit">
              {{ auditLoading ? 'Scanning…' : (storage ? '↻ Rescan' : 'Run scan') }}
            </button>
            <button
              class="btn btn-primary btn-sm"
              :disabled="!storage || bulkRunning || uploadedFinalsTotalBytes === 0"
              :title="uploadedFinalsTotalBytes === 0 ? 'No uploaded episodes have local final videos' : `Delete ${uploadedFinalsCount} uploaded final video(s) — frees ${formatBytes(uploadedFinalsTotalBytes)}`"
              @click="runBulkCleanup"
            >
              {{ bulkRunning
                ? 'Cleaning…'
                : `Free uploaded finals (${formatBytes(uploadedFinalsTotalBytes)})` }}
            </button>
          </div>
        </div>

        <div v-if="storage" class="storage-summary mt-2">
          <span><strong>Project total:</strong> {{ formatBytes(storage.project_bytes_total) }}</span>
          <span class="dot">·</span>
          <span><strong>Final videos:</strong> {{ formatBytes(storage.project_bytes_final_video) }}</span>
          <span class="dot">·</span>
          <span><strong>Per-scene clips:</strong> {{ formatBytes(storage.project_bytes_per_scene_clips) }}</span>
          <span v-if="storage.external_root_configured" class="dot">·</span>
          <span v-if="storage.external_root_configured">
            <strong>At external root:</strong> {{ formatBytes(storage.project_bytes_external_final_video) }}
          </span>
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
              <span v-if="row.uploaded_to_youtube" class="upload-badge ok" :title="`YouTube video ${row.youtube_video_id}`">
                ✓ uploaded
              </span>
              <span v-else class="upload-badge none">—</span>
            </span>
            <span class="col-actions">
              <button
                v-if="row.bytes_final_video > 0 || row.bytes_external_final_video > 0"
                class="btn btn-ghost btn-sm"
                :disabled="rowCleanupRunning === row.episode_code"
                :title="row.uploaded_to_youtube
                  ? `Delete the local final video file (frees ${formatBytes(row.bytes_final_video + row.bytes_external_final_video)})`
                  : 'Not uploaded yet — click anyway to delete (will prompt for confirmation)'"
                @click="cleanupRow(row)"
              >
                {{ rowCleanupRunning === row.episode_code ? 'Cleaning…' : 'Free up final' }}
              </button>
            </span>
          </div>
        </div>
        <div v-else-if="!auditLoading" class="text-muted hint mt-2">
          Click "Run scan" to compute per-episode disk usage.
        </div>
      </div>

      <div v-if="lastBulkCleanup" class="storage-result mt-2">
        <strong>Cleanup:</strong>
        {{ lastBulkCleanup.deleted_count }} file(s) deleted, freed {{ formatBytes(lastBulkCleanup.bytes_freed) }}.
        <span v-if="lastBulkCleanup.skipped_count">{{ lastBulkCleanup.skipped_count }} skipped (not uploaded).</span>
        <span v-if="lastBulkCleanup.failed_count" class="error-text">{{ lastBulkCleanup.failed_count }} failed.</span>
      </div>

      <div class="storage-advanced-heading">
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
      <details id="chunked-sidecars-section" class="storage-disclosure">
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

    </div>

    <!-- Confirmations -->
    <div v-if="activeTab === 'confirmations'" class="card settings-panel mt-2">
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
    </div>

    <!-- FFmpeg -->
    <div v-if="activeTab === 'ffmpeg'" id="ffmpeg-section" class="card settings-panel mt-2">
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
           an unnecessary replacement download. -->
      <details
        v-else
        :open="!ffmpegStatus?.installed || ffmpegInstalling"
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

      <!-- Manual install fallback -->
      <details v-if="ffmpegStatus?.source !== 'bundled'" class="ffmpeg-manual mt-3">
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
    <div v-if="activeTab === 'notifications'" class="card settings-panel notification-panel mt-2">
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

    <!-- Named Roots -->
    <div v-if="activeTab === 'roots'" class="card settings-panel mt-2">
      <h3>Named Roots</h3>
      <p class="text-muted mt-1 mb-2" style="font-size: 12px;">
        Map a label (e.g. <code>TERRANASH</code>) to a folder on <em>this</em> computer.
        Presets that reference <code>{{ '${TERRANASH}/logo.png' }}</code> will resolve to that folder
        here, and to a different absolute path on another machine — so you can sync projects via
        iCloud / Google Drive / OneDrive without rebinding every shared asset.
        The list is stored locally and <strong>never synced</strong>.
        <code>{{ '${PROJECT}' }}</code> is reserved and always points at the current project's output folder.
      </p>

      <div class="mt-2">
        <table class="edit-table">
          <thead>
            <tr><th style="width: 24%;">Name</th><th>Folder on this machine</th><th style="width: 1%;"></th></tr>
          </thead>
          <tbody>
            <tr v-for="(p, name) in namedRoots" :key="name">
              <td><code>{{ '${' + name + '}' }}</code></td>
              <td><code class="path-display">{{ p }}</code></td>
              <td>
                <button class="btn btn-sm btn-danger" @click="removeNamedRoot(name)">Remove</button>
              </td>
            </tr>
            <tr v-if="!Object.keys(namedRoots).length">
              <td colspan="3" class="text-muted" style="font-size: var(--font-xs);">
                No named roots defined yet. Add one below to start using portable preset paths.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="form-group mt-3">
        <label>Add named root</label>
        <div class="flex gap-2 items-center" style="flex-wrap:wrap">
          <input
            v-model="newRootName"
            class="input input-sm"
            placeholder="TERRANASH"
            style="width: 180px; font-family: monospace; text-transform: uppercase;"
          />
          <button class="btn btn-sm btn-secondary" :disabled="!newRootName || pickingRootFolder" @click="pickRootFolder">
            {{ pickingRootFolder ? 'Picking…' : '📂 Pick folder' }}
          </button>
          <code v-if="newRootPath" class="path-display">{{ newRootPath }}</code>
        </div>
        <span class="text-muted" style="font-size: var(--font-xs);">
          Letters A–Z, digits, and underscores. Start with a letter. Reserved: <code>PROJECT</code>.
        </span>
      </div>
      <div class="flex gap-2" style="align-items: center;">
        <button
          class="btn btn-primary"
          :disabled="!newRootName || !newRootPath || savingRoot"
          @click="saveNamedRoot"
        >
          {{ savingRoot ? 'Saving…' : 'Add Root' }}
        </button>
        <SaveIndicator v-bind="savedHintProps('roots')" />
      </div>
    </div>

    <!-- Project -->
    <div v-if="activeTab === 'project'" class="card settings-panel mt-2">
      <h3>Project Settings</h3>
      <div class="grid-2 mt-2">
        <div class="form-group">
          <label>Project Name</label>
          <input v-model="projectForm.name" class="input" />
        </div>
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
      <div class="form-group">
        <label>YouTube Channel URL (for video recommendations)</label>
        <input v-model="projectForm.youtube_channel_url" class="input" placeholder="https://youtube.com/@yourchannel" />
      </div>

      <!-- Item J — YouTube videoCategories.list ID. Applied to every fresh
           upload + metadata-only PATCH for this project. Default 22
           ("People & Blogs") if unset. Dropdown is populated from the
           backend's 7-day cache of YouTube's category list; soft fallback
           lets the user type a number even if the cache is empty / API
           is down. -->
      <div class="form-group">
        <label>
          YouTube Category
          <span class="text-muted" style="font-weight:normal">(applied to every upload + metadata PATCH)</span>
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
      <div class="form-group">
        <label>
          AI / Altered or Synthetic Content disclosure
          <span class="text-muted" style="font-weight:normal">(YouTube `status.containsSyntheticMedia`)</span>
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
          Fresh uploads pick this up automatically. The backfill action above PATCHes existing uploads
          (preserves privacy + schedule). Live YouTube quota: 1 unit per 50 videos read + 50 units per video updated.
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

      <div class="form-group">
        <label>Art Style <span class="text-muted" style="font-weight:normal">(auto-applied to every image prompt for this project; the style's preview image also feeds img2img renders. Overridable per run on the Image Prompts page.)</span></label>
        <div class="art-style-picker">
          <select v-model="artStyleSelection" class="input">
            <option value="">— None (use format / niche default) —</option>
            <optgroup v-if="savedStylePresets.length" label="Saved styles">
              <option v-for="s in savedStylePresets" :key="s.id" :value="s.id">{{ s.name }}</option>
            </optgroup>
            <optgroup label="Built-in styles">
              <option v-for="s in BUILT_IN_STYLES" :key="s.id" :value="`builtin:${s.id}`">{{ s.name }}</option>
            </optgroup>
          </select>
        </div>
        <span v-if="artStyleSaveMessage" class="text-muted" style="font-size: var(--font-xs)">{{ artStyleSaveMessage }}</span>
      </div>

      <!-- Per-project cloud-sync mode toggle removed alongside the
           legacy manifest-sync feature. There's now only one mode —
           cloud sync is configured app-wide via Settings → Storage →
           Projects storage location (point at iCloud Drive / etc.).
           A `.story-studio-project.json` manifest is still written
           into every project folder as a project_id identity marker
           for cross-machine import. -->

      <div class="form-group">
        <label>Project Files Location</label>
        <div class="flex gap-2 items-center" style="flex-wrap:wrap">
          <code class="path-display">{{ projectLocation || '(no location set)' }}</code>
          <button class="btn btn-sm btn-secondary" :disabled="!projectLocation" @click="revealInFinder">
            📂 Open in Finder
          </button>
          <!-- Move asset location button — only renders when the
               asset-migration status reports the assets are external
               to the project's metadata folder (i.e. a move would
               change something). Disabled while a check is in flight
               or a previous migration hasn't finished. -->
          <button
            v-if="assetMigration.status.value && assetMigration.status.value.needed"
            class="btn btn-sm btn-primary"
            :disabled="assetMigration.migrating.value || assetMigration.loading.value"
            :title="assetMigration.status.value.blockers.length > 0
              ? assetMigration.status.value.blockers.join('\n')
              : `Copy ${formatBytes(assetMigration.status.value.estimated_bytes || 0)} from the current location into the project folder so a single sync hop carries everything.`"
            @click="openMoveAssetsDialog"
          >
            {{ assetMigration.migrating.value ? '↻ Moving…' : '📦 Move asset location' }}
          </button>
          <!-- Move THIS PROJECT to a different folder. Distinct from the
               Storage tab's global "Move projects to…" — that one moves
               every project at once; this lets the operator pick a
               destination just for this one project (e.g. one channel to
               iCloud, another stays local). The destination is
               registered as a linked path so the slug keeps resolving
               after the move. -->
          <button
            class="btn btn-sm btn-secondary"
            :disabled="moveProjectDialogOpen || moveProjectMigrating"
            title="Move this project's folder to a different location (iCloud, an external drive, anywhere). Doesn't affect other projects. Choose whether to delete the source after a successful copy."
            @click="openMoveProjectDialog"
          >📦 Move this project to…</button>
        </div>
        <span class="text-muted" style="font-size: var(--font-xs)">
          Story Studio reads and writes all generated files here. Don't move this folder —
          if you do, use <strong>Repair Folder Structure</strong> below.
        </span>
        <p
          v-if="assetMigration.status.value && assetMigration.status.value.needed"
          class="text-muted mt-1"
          style="font-size: var(--font-xs); max-width: 720px;"
        >
          Assets currently sit at this absolute path. For cross-Mac iCloud sync to actually carry the
          files (not just the metadata), they need to live INSIDE the project's folder. Click
          <strong>Move asset location</strong> to copy them to <code class="path-display"
          >{{ assetMigration.status.value.projected_target }}</code> and rewrite this project's
          <code class="path-display">project.json</code> so future moves carry everything.
        </p>
      </div>

      <!-- Move asset location confirmation dialog -->
      <div v-if="moveAssetsDialogOpen" class="modal-overlay" @click.self="closeMoveAssetsDialog">
        <div class="modal" style="max-width: 620px;">
          <h2>Move asset location</h2>
          <p class="text-muted mt-1" style="font-size: 13px;">
            This copies your assets from the current external folder into the project's metadata
            folder so cross-Mac iCloud sync carries everything. Source files stay in place by
            default — verify the new location renders correctly before deleting the old one.
          </p>

          <div class="move-assets-summary mt-2">
            <div class="move-assets-row">
              <span class="text-muted">From</span>
              <code class="path-display">{{ assetMigration.status.value?.current_output_root || '' }}</code>
            </div>
            <div class="move-assets-row">
              <span class="text-muted">To</span>
              <code class="path-display">{{ assetMigration.status.value?.projected_target || '' }}</code>
            </div>
            <div class="move-assets-row">
              <span class="text-muted">Size</span>
              <span>
                {{ formatBytes(assetMigration.status.value?.estimated_bytes || 0) }}
                across {{ assetMigration.status.value?.estimated_files || 0 }} file(s)
              </span>
            </div>
          </div>

          <div
            v-if="assetMigration.status.value?.blockers?.length"
            class="move-assets-blockers mt-2"
          >
            <strong>⛔ Blocked — fix before retrying:</strong>
            <ul>
              <li v-for="(b, i) in assetMigration.status.value.blockers" :key="i">{{ b }}</li>
            </ul>
          </div>

          <label class="flex gap-2 mt-2" style="align-items: center; font-size: 12px;">
            <input type="checkbox" v-model="moveAssetsDeleteSource" />
            <span>
              <strong>Delete source folder after a successful copy.</strong>
              Off by default — leaves the original at <code class="path-display">{{ assetMigration.status.value?.current_output_root || '' }}</code>
              so you can verify the move before reclaiming the space.
            </span>
          </label>

          <div v-if="assetMigration.lastError.value" class="move-assets-error mt-2">
            {{ assetMigration.lastError.value }}
          </div>

          <div class="flex gap-2 mt-3" style="justify-content: flex-end;">
            <button
              class="btn btn-secondary"
              :disabled="assetMigration.migrating.value"
              @click="closeMoveAssetsDialog"
            >Cancel</button>
            <button
              class="btn btn-primary"
              :disabled="assetMigration.migrating.value || (assetMigration.status.value?.blockers?.length ?? 0) > 0"
              @click="runMoveAssets"
            >
              {{ assetMigration.migrating.value ? 'Moving…' : 'Move now' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Move-this-project-to dialog. Distinct from the asset-migration
           dialog above: this relocates the project's ENTIRE folder
           (metadata + assets) to a chosen destination, then registers
           it as a linked project so its slug keeps resolving after the
           move. Powers the per-project "one channel to iCloud while
           another stays local" workflow. -->
      <div v-if="moveProjectDialogOpen" class="modal-overlay" @click.self="closeMoveProjectDialog">
        <div class="modal" style="max-width: 660px;">
          <h2>Move this project to…</h2>
          <p class="text-muted mt-1" style="font-size: 13px;">
            Moves the entire project folder (metadata + assets) to the destination of your choice.
            The new location is registered as a linked folder so this Mac keeps finding the
            project by slug. Other projects are unaffected.
          </p>

          <div v-if="moveProjectStatus" class="move-assets-summary mt-2">
            <div class="move-assets-row">
              <span class="text-muted">From</span>
              <code class="path-display">{{ moveProjectStatus.current_path }}</code>
            </div>
            <div class="move-assets-row">
              <span class="text-muted">Size</span>
              <span>
                {{ formatBytes(moveProjectStatus.estimated_bytes || 0) }}
                across {{ moveProjectStatus.estimated_files || 0 }} file(s)
              </span>
            </div>
          </div>

          <div class="flex gap-2 mt-2" style="align-items: stretch; flex-wrap: wrap;">
            <input
              v-model="moveProjectDest"
              class="input"
              placeholder="Absolute parent folder for the project — the project's slug becomes a sub-folder there"
              style="flex: 1; min-width: 280px;"
            />
            <button class="btn btn-secondary btn-sm" @click="browseMoveProjectDest">Browse…</button>
          </div>
          <p class="text-muted mt-1" style="font-size: var(--font-xs);">
            The project lands at <code class="path-display">{{ moveProjectDest ? moveProjectDest + '/' + (moveProjectStatus?.current_path?.split('/').pop() || project?.slug || '') : '(pick a destination first)' }}</code>.
          </p>

          <div
            v-if="moveProjectStatus?.icloud_blockers?.length"
            class="move-assets-blockers mt-2"
          >
            <strong>⛔ Blocked — fix before retrying:</strong>
            <p class="text-muted" style="font-size: var(--font-xs); margin: 4px 0;">
              {{ moveProjectStatus.icloud_blockers.length }} file(s) in this project are
              iCloud placeholders (not downloaded to this Mac). Right-click the project folder
              in Finder → "Download Now", wait for every file to lose the cloud icon, then retry.
            </p>
            <ul style="font-size: var(--font-xs); margin: 4px 0 0 18px; padding: 0;">
              <li v-for="(b, i) in moveProjectStatus.icloud_blockers.slice(0, 5)" :key="i">
                <code>{{ b }}</code>
              </li>
            </ul>
          </div>

          <label class="flex gap-2 mt-2" style="align-items: center; font-size: 12px;">
            <input type="checkbox" v-model="moveProjectDeleteSource" />
            <span>
              <strong>Delete the original folder after a successful copy.</strong>
              Off by default — the source is kept (renamed with a <code>.bak-&lt;timestamp&gt;</code>
              suffix when it's in the default location, or left in place when it's already linked)
              so you can verify the move before reclaiming the space.
            </span>
          </label>

          <div v-if="moveProjectError" class="move-assets-error mt-2">{{ moveProjectError }}</div>

          <div class="flex gap-2 mt-3" style="justify-content: flex-end;">
            <button
              class="btn btn-secondary"
              :disabled="moveProjectMigrating"
              @click="closeMoveProjectDialog"
            >Cancel</button>
            <button
              class="btn btn-primary"
              :disabled="
                moveProjectMigrating
                  || !moveProjectDest
                  || (moveProjectStatus?.icloud_blockers?.length ?? 0) > 0
              "
              @click="runMoveProject"
            >
              {{ moveProjectMigrating ? 'Moving…' : 'Move now' }}
            </button>
          </div>
        </div>
      </div>

      <div class="flex gap-2" style="align-items: center;">
        <button class="btn btn-primary" @click="saveProject">Save Project Settings</button>
        <SaveIndicator v-bind="savedHintProps('project')" />
      </div>

      <!-- Sync Folders -->
      <div class="sync-zone mt-3">
        <h3>Repair Folder Structure</h3>
        <p class="text-muted mt-1">
          If your episode folders look off — missing subfolders, misplaced files, or
          you moved something by hand — click this to rebuild the expected layout.
          <strong>Nothing is deleted;</strong> files are only created or moved into place.
        </p>
        <button class="btn btn-secondary mt-2" :disabled="syncing" @click="syncFolders">
          {{ syncing ? 'Repairing…' : 'Repair Folder Structure' }}
        </button>
        <div v-if="syncResults.length" class="sync-results mt-2">
          <div v-for="(action, i) in syncResults" :key="i" class="sync-action">✓ {{ action }}</div>
        </div>
      </div>

      <!-- v1.0.107+ — Unlink from this Mac. Only meaningful for projects -->
      <!-- whose folder lives OUTSIDE the default PROJECTS_ROOT (i.e. the -->
      <!-- folder is registered in the linked-projects registry). Removes -->
      <!-- the project from this Mac's app list WITHOUT touching the      -->
      <!-- folder on disk — the iCloud / external / network folder stays  -->
      <!-- exactly where it is, the app just forgets about it. Other Macs -->
      <!-- that linked the same folder are unaffected. -->
      <div v-if="projectIsLinked" class="danger-zone mt-3">
        <h3>Unlink from this Mac</h3>
        <p class="text-muted mt-1">
          This project's folder lives at
          <code class="path-display">{{ projectLocationPath }}</code>
          — outside the app's default projects folder, so it's tracked as a
          <em>linked project</em>. Unlinking removes it from this Mac's app
          list <strong>WITHOUT touching files on disk</strong>.
          The folder, all chapters, all audio, all images stay exactly where
          they are. If the folder is in iCloud, iCloud's sync behaviour is
          unchanged — it was syncing the folder before the app knew about it
          and will continue afterward.
        </p>
        <p class="text-muted mt-1">
          To re-add this project later: <em>All Projects → Add existing project folder…</em>
          and pick the same path. Other Macs that linked the same folder are
          unaffected.
        </p>
        <button
          class="btn btn-danger mt-2"
          :disabled="unlinking"
          @click="unlinkFromThisMac"
        >
          {{ unlinking ? 'Unlinking…' : '🔗 Unlink from this Mac' }}
        </button>
      </div>

      <div class="danger-zone mt-3">
        <h3>Hide / Remove Project</h3>
        <p class="text-muted mt-1">
          <strong>Non-destructive:</strong> the project is removed from this app's
          list but every file stays on disk. You'll see a confirmation dialog with
          the folder path so you can open it in Finder afterward and decide what
          to keep or delete by hand. Re-importing the same folder via
          <em>Add existing project folder…</em> brings it right back. The home page
          shows a 🗑️ <em>Hidden projects</em> chip so you can restore or
          permanently delete later.
        </p>
        <button class="btn btn-danger mt-2" @click="deleteProject">Hide project (keep files)</button>
      </div>
    </div>

    <!-- About — version + build info, copyable for bug reports.
         Read at frontend build time from the root package.json (see
         nuxt.config.ts → runtimeConfig.public.appVersion). -->
    <div v-if="activeTab === 'about'" class="card settings-panel mt-2">
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
// Built-in art styles offered in the per-project Art Style selector below.
// Bare named export (not a useX composable), so import it explicitly —
// mirrors image-prompts.vue.
import { BUILT_IN_STYLES } from '~/composables/useBuiltInStyles'
import {
  VOICE_PROVIDER_OPTIONS,
  firstVoiceProviderIndex,
  normalizeSavedVoices,
  type SavedVoice,
  type VoiceProviderId,
} from '~/utils/voice-providers'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Settings')
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put, del } = useApi()
const { ask } = useConfirm()
const { project, config, refreshConfig, loadProject } = useProject()
const { success, error: showError, info } = useToast()
const assetMigration = useAssetMigration()

// `formatBytes` is already defined further down (used by the projects-
// root migration banner); reusing it keeps a single source of truth for
// byte formatting on this page.

// Move-asset-location dialog state. The source-of-truth for "should I
// migrate" + "what's the size" lives in the composable; this just
// gates the modal + holds the delete-source checkbox.
const moveAssetsDialogOpen = ref(false)
const moveAssetsDeleteSource = ref(false)

function openMoveAssetsDialog(): void {
  moveAssetsDeleteSource.value = false
  // Refresh status before opening so the dialog reflects up-to-date
  // blockers (e.g. user just downloaded an iCloud placeholder).
  void assetMigration.checkNow()
  moveAssetsDialogOpen.value = true
}
function closeMoveAssetsDialog(): void {
  moveAssetsDialogOpen.value = false
}
async function runMoveAssets(): Promise<void> {
  const r = await assetMigration.migrate({ delete_source: moveAssetsDeleteSource.value })
  if (r.ok) {
    success(
      moveAssetsDeleteSource.value
        ? 'Assets moved + source removed. Restart the app or re-render to confirm.'
        : 'Assets moved. Source kept at the original location until you delete it manually.',
    )
    closeMoveAssetsDialog()
    // Reload the project meta so projectLocation reflects the new
    // (now-relative) output_root once the backend has rewritten
    // project.json.
    if (project.value) {
      await loadProject((project.value as any).slug || '')
    }
  } else {
    showError(r.error || 'Move failed — see banner for details.')
  }
}

// ── Move-this-project-to dialog ─────────────────────────────────────────
// Per-project relocation — moves the entire project folder (metadata +
// assets) to a chosen destination, then registers it as a linked path
// so the slug keeps resolving. Distinct from the asset-migration above
// which only co-locates assets inside the existing project folder.
const linkedProjects = useLinkedProjects()
const moveProjectDialogOpen = ref(false)
const moveProjectDeleteSource = ref(false)
const moveProjectMigrating = ref(false)
const moveProjectError = ref('')
const moveProjectDest = ref('')
const moveProjectStatus = ref<{
  current_path: string
  is_default_location: boolean
  is_linked: boolean
  estimated_bytes: number
  estimated_files: number
  icloud_blockers: string[]
} | null>(null)

// v1.0.107+ — Unlink-from-this-Mac state. Read on Project tab activation
// so the danger-zone block can render conditionally without forcing the
// user to first click "Move this project to…" (which is the only other
// path that loads moveProjectStatus today). When `projectIsLinked` is
// false (project lives inside PROJECTS_ROOT), the block stays hidden —
// unlinking only applies to externally-tracked folders.
const projectIsLinked = ref(false)
const projectLocationPath = ref('')
const unlinking = ref(false)

async function loadProjectLocationStatus(): Promise<void> {
  try {
    const status = await linkedProjects.getMoveStatus(slug.value)
    projectIsLinked.value = !!status?.is_linked
    projectLocationPath.value = status?.current_path || ''
  } catch {
    // Non-fatal: a backend blip just hides the unlink block, doesn't
    // break the rest of the Project tab.
    projectIsLinked.value = false
    projectLocationPath.value = ''
  }
}

async function unlinkFromThisMac(): Promise<void> {
  if (!projectLocationPath.value || unlinking.value) return
  const confirmed = await ask({
    title: 'Unlink project from this Mac?',
    message: `Folder: ${projectLocationPath.value}\n\n` +
    `The folder and all its contents stay exactly where they are. The ` +
    `app just stops tracking it on this Mac. You can re-add it later via ` +
    `"Add existing project folder…" on the All Projects page.\n\n` +
    `Other Macs that linked the same folder are unaffected.`,
    confirmLabel: 'Unlink project',
    danger: true,
  })
  if (!confirmed) return
  unlinking.value = true
  try {
    const ok = await linkedProjects.remove(projectLocationPath.value)
    if (!ok) {
      const err = linkedProjects.lastError?.value || 'Failed to unlink — see console for details.'
      alert(err)
      return
    }
    // Project is no longer addressable by slug on this Mac → bounce
    // back to the All Projects list so the user doesn't sit on a now-
    // dead /projects/:slug/settings URL.
    await navigateTo('/')
  } finally {
    unlinking.value = false
  }
}

async function openMoveProjectDialog(): Promise<void> {
  moveProjectDialogOpen.value = true
  moveProjectDest.value = ''
  moveProjectError.value = ''
  moveProjectDeleteSource.value = false
  moveProjectStatus.value = null
  // Pre-fetch the size estimate + .icloud blocker scan so the dialog
  // can render the warning before the user picks a destination.
  try {
    moveProjectStatus.value = await linkedProjects.getMoveStatus(slug.value)
  } catch (e: any) {
    moveProjectError.value = e?.data?.detail || e?.message || 'Failed to inspect project'
  }
}
function closeMoveProjectDialog(): void {
  moveProjectDialogOpen.value = false
}
async function browseMoveProjectDest(): Promise<void> {
  try {
    const path = await pickFolderShared({
      title: 'Choose a destination folder for this project',
      button_label: 'Use This Folder',
      initial_path: moveProjectDest.value || undefined,
    })
    if (path) moveProjectDest.value = path
  } catch (e: any) {
    moveProjectError.value = e?.data?.detail || e?.message || 'Folder picker failed'
  }
}
async function runMoveProject(): Promise<void> {
  if (!moveProjectDest.value) return
  moveProjectMigrating.value = true
  moveProjectError.value = ''
  try {
    const result = await linkedProjects.moveProject(slug.value, moveProjectDest.value, {
      delete_source: moveProjectDeleteSource.value,
    })
    const dispositionMsg = result.source_disposition === 'deleted'
      ? 'Source folder deleted.'
      : result.source_disposition === 'renamed'
        ? `Source renamed to ${result.renamed_source_path}.`
        : 'Source de-registered (was already linked).'
    success(`Project moved to ${result.new_path}. ${dispositionMsg}`)
    closeMoveProjectDialog()
    // Reload project meta so the Project Files Location display reflects
    // the new path once the linked entry resolves.
    if (project.value) {
      await loadProject((project.value as any).slug || slug.value)
    }
  } catch (e: any) {
    moveProjectError.value = e?.data?.detail || e?.message || 'Move failed'
  } finally {
    moveProjectMigrating.value = false
  }
}

const activeTab = ref('app')
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
const formatDirty = computed(() => {
  if (formatId.value !== formatIdBaseline.value) return true
  if (continuityMode.value !== continuityModeBaseline.value) return true
  return false
})

// ── Research gate (v1.0.760) ───────────────────────────────────────────────
// Explicit tri-state read, mirroring resolveResearchRequired() on the backend:
// `true` is on, `false` is off, and ABSENT means this project was created
// before the gate existed → off, so nothing that already shipped is
// retroactively marked incomplete. New projects are stamped `true` at creation.
const researchRequired = ref(false)
const savingResearchGate = ref(false)

function syncResearchGateFromProject() {
  const m = project.value as any
  researchRequired.value = m?.research_required === true
}

async function saveResearchGate(): Promise<void> {
  savingResearchGate.value = true
  const next = researchRequired.value
  try {
    await put(`/projects/${slug.value}`, { research_required: next })
    stampSaved('research_gate')
    success(next
      ? 'Research is now required — every claim must be reviewed for an episode to count as complete'
      : 'Research is optional again — it no longer blocks episode completion')
    await loadProject(slug.value)
  } catch (e: any) {
    researchRequired.value = !next  // roll back the optimistic toggle
    showError(e?.data?.detail || 'Failed to save the research policy')
  } finally {
    savingResearchGate.value = false
  }
}

function syncFormatFromProject() {
  const m = project.value as any
  syncResearchGateFromProject()
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
  } finally {
    savingGuideDensity.value = false
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
  setProjectNiche,
  find: findNicheProfile,
  niches: nicheLibList,
  isLoading: nicheLibLoading,
  error: nicheLibError,
  createNiche: createNicheApi,
  deleteNiche: deleteNicheApi,
} = useNiches()
const nicheId = ref<string>('')
const topicPackIds = ref<string[]>([])
const nicheSaving = ref(false)
const nicheSaveError = ref('')
const nicheIdBaseline = ref<string>('')
const topicPackIdsBaseline = ref<string[]>([])
const normalizePackIds = (values: string[]) => [...new Set(values)].sort()
const nicheDirty = computed(() =>
  nicheId.value !== nicheIdBaseline.value
  || JSON.stringify(normalizePackIds(topicPackIds.value))
    !== JSON.stringify(normalizePackIds(topicPackIdsBaseline.value)))
// Sub-tab state for the merged Niche tab. Default to 'project' (the
// picker) since that's the common case; 'library' is for browse/create.
const nicheSubTab = ref<'project' | 'library'>('project')
const nicheLibraryCount = computed(() => nicheLibList.value?.length || 0)
const selectedNicheProfile = computed(() => findNicheProfile(nicheId.value))
const selectedProductionKit = computed(() => selectedNicheProfile.value?.productionKit || null)
const humanizeCatalogId = (value?: string) => (value || 'Not specified')
  .replace(/^builtin-/, '')
  .split(/[-_]/g)
  .filter(Boolean)
  .map(part => part.charAt(0).toUpperCase() + part.slice(1))
  .join(' ')
const selectedProductionKitStyleName = computed(() => {
  const id = selectedProductionKit.value?.recommendedVisualStyleId
  return BUILT_IN_STYLES.find(style => style.id === id)?.name || humanizeCatalogId(id)
})
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

function syncNicheFromProject() {
  const m = project.value as any
  if (!m) return
  nicheId.value = m.niche_id || ''
  topicPackIds.value = Array.isArray(m.topic_pack_ids)
    ? [...m.topic_pack_ids]
    : [...(findNicheProfile(nicheId.value)?.defaultTopicPackIds || [])]
  nicheIdBaseline.value = nicheId.value
  topicPackIdsBaseline.value = [...topicPackIds.value]
}

watch(project, syncNicheFromProject, { immediate: true })
watch(nicheLibList, () => {
  const meta = project.value as any
  if (!meta?.niche_id || Array.isArray(meta.topic_pack_ids)) return
  const defaults = findNicheProfile(meta.niche_id)?.defaultTopicPackIds || []
  topicPackIds.value = [...defaults]
  topicPackIdsBaseline.value = [...defaults]
}, { immediate: true })

function onNicheChanged(n: any) {
  topicPackIds.value = [...(n?.defaultTopicPackIds || [])]
}

async function saveNicheSettings() {
  nicheSaving.value = true
  nicheSaveError.value = ''
  try {
    await setProjectNiche(slug.value, nicheId.value || null, topicPackIds.value)
    const formulaStyleChanged = await applyFormulaVisualDefault(findNicheProfile(nicheId.value))
    nicheIdBaseline.value = nicheId.value
    topicPackIdsBaseline.value = [...topicPackIds.value]
    stampSaved('niche')
    success(nicheId.value
      ? `Series Formula and Topic Packs saved${formulaStyleChanged ? ' · production-kit style updated' : ''}`
      : 'Series Formula cleared')
    await loadProject(slug.value)
  } catch (e: any) {
    nicheSaveError.value = e?.data?.detail || e?.message || 'Failed to save niche settings'
    showError(nicheSaveError.value)
  } finally {
    nicheSaving.value = false
  }
}

// ── v1.0.96+ Niche library: create / delete / use-on-project ──────────
//
// Merged in from the standalone /niches sidebar page (now retired).
// All three actions operate on the SAME `useNiches()` cache that the
// NichePicker above reads from, so the picker auto-updates when the user
// creates or deletes a custom niche without a separate refresh.

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

/** Set the picker to this niche (still requires Save in the Project-niche
 *  sub-tab to persist). Hops back to the Project sub-tab so the user can
 *  immediately see the picker reflect their pick and click Save. */
function useNicheOnProject(id: string): void {
  nicheId.value = id
  nicheSubTab.value = 'project'
  success(`Selected "${id}" — click Save to apply to this project.`)
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
}
interface StorageAudit {
  project_bytes_total: number
  project_bytes_final_video: number
  project_bytes_per_scene_clips: number
  project_bytes_external_final_video: number
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
  items: Array<{ episode_code: string; status: string; bytes_freed: number; reason?: string }>
}

const storage = ref<StorageAudit | null>(null)
const auditLoading = ref(false)
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

// Bulk-cleanup target: only count uploaded episodes that still have a
// local final video. The button disables when this is 0.
const uploadedFinals = computed<StorageEntry[]>(() => {
  if (!storage.value) return []
  return storage.value.episodes.filter(e => e.uploaded_to_youtube && e.bytes_final_video > 0)
})
const uploadedFinalsCount = computed(() => uploadedFinals.value.length)
const uploadedFinalsTotalBytes = computed(() =>
  uploadedFinals.value.reduce((s, e) => s + e.bytes_final_video, 0),
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

async function saveExternalRoot() {
  externalRootSaving.value = true
  try {
    const { put } = useApi()
    const r = await put<{ ok: true; value: string; reachable: boolean; reason: string }>(
      '/app-settings/external-final-video-root',
      { value: externalRootInput.value.trim() },
    )
    externalRootReachable.value = r.reachable
    externalRootSavedValue.value = r.value || ''
    externalRootStatus.value = r.value
      ? (r.reachable ? `✓ saved + reachable: ${r.value}` : `⚠ saved but ${r.reason}`)
      : 'Cleared (using project tree)'
    // Successful save means whatever advice the picker-help panel was
    // showing no longer applies — the user moved on.
    externalRootPickerHelp.value = ''
    // Re-run audit so external-side counts refresh.
    if (storage.value) await loadStorageAudit()
  } catch (e: any) {
    externalRootStatus.value = `Error: ${e?.data?.detail || e?.message || 'failed to save'}`
  } finally {
    externalRootSaving.value = false
  }
}

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
    mediaRootStatus.value = `⚠ ${e?.data?.detail || e?.message || 'Could not resolve this path on this machine. Define it under Named Roots.'}`
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
 * on. The 503 case (Electron main process not detected) is the common
 * dev-mode gotcha — surfaced as instructions to use the manual path input
 * instead of as a raw error string.
 */
function pickerHelpFor(e: any): string {
  const status = e?.status ?? e?.response?.status
  const detail: string = e?.data?.detail || e?.message || ''
  if (status === 503 || /Electron main process not detected|Folder picker not available/i.test(detail)) {
    return 'The native folder picker only works in the packaged app, not in the dev server. Type or paste a path into the field above and click "Save manual path" instead.'
  }
  return `Folder picker failed: ${detail || 'unknown error'}. You can also type or paste a path above and click "Save manual path".`
}

/**
 * Open the native folder picker for the external root, and auto-save
 * the chosen path. Skips the save when the user cancels the dialog.
 *
 * Why no "Save" click after picking: the picker IS the user's
 * confirmation. Forcing a second Save click adds friction without
 * reducing risk (the picker doesn't bind anything until the user
 * confirms inside it). Pre-fills the dialog at the previously-saved
 * path so the user starts in a familiar spot when re-picking.
 */
async function browseAndSetExternalRoot() {
  externalRootPickerHelp.value = ''
  try {
    const path = await pickFolderShared({
      title: 'Choose external final-video folder',
      button_label: 'Use this folder',
      initial_path: externalRootInput.value || undefined,
    })
    if (!path) return  // User cancelled the dialog.
    externalRootInput.value = path
    await saveExternalRoot()
  } catch (e: any) {
    externalRootPickerHelp.value = pickerHelpFor(e)
  }
}

/**
 * Clear the external root — future finals land in the project tree
 * again. Detection still picks up files at the old external location
 * if any are still there (Path E in asset-status), so this is
 * non-destructive: nothing on disk changes.
 */
async function clearExternalRoot() {
  externalRootInput.value = ''
  await saveExternalRoot()
}

async function loadStorageAudit() {
  auditLoading.value = true
  try {
    storage.value = await get<StorageAudit>(`/projects/${slug.value}/storage-audit`)
  } catch (e: any) {
    storage.value = null
    alert(e?.data?.detail || e?.message || 'Storage audit failed')
  } finally {
    auditLoading.value = false
  }
}

async function runBulkCleanup() {
  if (!storage.value || uploadedFinalsCount.value === 0) return
  const ok = await ask({
    title: 'Delete uploaded final videos?',
    message: `Delete ${uploadedFinalsCount.value} uploaded final video file(s) (${formatBytes(uploadedFinalsTotalBytes.value)})?\n\n` +
    `This is safe — the YouTube sidecar keeps the pipeline view marking these as done. ` +
    `You can re-render any time from images + merged audio.`,
    confirmLabel: `Delete ${uploadedFinalsCount.value} files`, danger: true,
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
    alert(e?.data?.detail || e?.message || 'Bulk cleanup failed')
  } finally {
    bulkRunning.value = false
  }
}

async function cleanupRow(row: StorageEntry) {
  if (!row.uploaded_to_youtube) {
    const ok = await ask({
      title: 'Delete unconfirmed final video?',
      message: `${row.episode_code} is NOT confirmed uploaded to YouTube. ` +
      `Delete the local final video anyway?\n\n` +
      `If you delete this and the upload sidecar isn't present, the pipeline view will go back to showing "video assembly missing".`,
      confirmLabel: 'Delete anyway', danger: true,
    })
    if (!ok) return
  }
  rowCleanupRunning.value = row.episode_code
  try {
    await post<CleanupResult>(
      `/projects/${slug.value}/storage/cleanup-final/${row.episode_code}`,
      { force: !row.uploaded_to_youtube },
    )
    await loadStorageAudit()
  } catch (e: any) {
    alert(e?.data?.detail || e?.message || 'Cleanup failed')
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
    alert(e?.data?.detail || e?.message || 'Sidecar scan failed')
  } finally {
    sidecarScanLoading.value = false
  }
}

async function cleanupAllChunkedSidecars() {
  if (!sidecarScan.value || sidecarScan.value.eligible_count === 0) return
  const ok = confirm(
    `Delete ${sidecarScan.value.eligible_count} chunked-progress sidecar(s) ` +
    `(${formatBytes(sidecarScan.value.reclaimable_bytes)})?\n\n` +
    `These are only eligible because their unified narration is complete. ` +
    `Cleanup affects ONLY sidecar JSONs — chapter docx files, audio, and ` +
    `everything else stays put.`,
  )
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
    alert(e?.data?.detail || e?.message || 'Sidecar cleanup failed')
  } finally {
    sidecarCleanupRunning.value = false
  }
}

async function cleanupOneSidecar(episode_code: string) {
  sidecarCleanupRunning.value = true
  try {
    lastSidecarCleanup.value = await post<SidecarCleanupResult>(
      `/projects/${slug.value}/storage/cleanup-chunked-sidecars`,
      { episode_codes: [episode_code] },
    )
    await scanChunkedSidecars()
  } catch (e: any) {
    alert(e?.data?.detail || e?.message || 'Sidecar cleanup failed')
  } finally {
    sidecarCleanupRunning.value = false
  }
}

async function runMigration() {
  if (!externalRootInput.value) return
  const ok = await ask({
    title: 'Move final videos?',
    message: `Move all final videos in this project to the external root?\n\n` +
    `${externalRootInput.value}\n\n` +
    `Project-tree files will be removed after a successful move. ` +
    `Detection still works for both locations, so the pipeline view stays accurate.`,
    confirmLabel: 'Move videos', danger: true,
  })
  if (!ok) return
  migrateRunning.value = true
  try {
    const r = await post<MigrationResult>(
      `/projects/${slug.value}/storage/migrate-finals-to-external`,
      {},
    )
    lastMigration.value = r
    await loadStorageAudit()
  } catch (e: any) {
    alert(e?.data?.detail || e?.message || 'Migration failed')
  } finally {
    migrateRunning.value = false
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

interface ProjectsRootInfo {
  override: string
  effective_path: string
  default_path: string
  is_overridden: boolean
}

const projectsRoot = ref<ProjectsRootInfo | null>(null)
const projectsRootBusy = ref(false)
const projectsRootStatus = ref('')
const projectsRootStatusKind = ref<'ok' | 'warn' | 'err'>('ok')
// Friendly picker-failure panel — same role as `externalRootPickerHelp`
// for the Projects-root section. Lets us surface the dev-mode picker
// limitation as actionable guidance ("type a path manually") without
// burying it inside the same red-status line as a normal error.
const projectsRootPickerHelp = ref('')

async function loadProjectsRoot() {
  try {
    projectsRoot.value = await get<ProjectsRootInfo>('/app-settings/projects-root')
  } catch (e: any) {
    projectsRootStatus.value = `Couldn't read storage location: ${e?.data?.detail || e?.message}`
    projectsRootStatusKind.value = 'err'
  }
}
onMounted(loadProjectsRoot)

async function browseAndMoveProjectsRoot() {
  projectsRootPickerHelp.value = ''
  // Step 0: pick the destination via the shared folder picker.
  let pickedPath: string | null
  try {
    pickedPath = await pickFolderShared({
      title: 'Choose where to store projects',
      button_label: 'Use this folder',
      initial_path: projectsRoot.value?.effective_path,
    })
  } catch (e: any) {
    projectsRootPickerHelp.value = pickerHelpFor(e)
    return
  }
  if (!pickedPath) return  // User cancelled.
  const pick = { path: pickedPath }

  // Step 0.5: pre-flight sizing so the confirmation dialog tells the
  // user what they're about to do. Now also includes the per-project
  // external-asset tally — the v1.0.13 augmentation co-locates those
  // alongside the metadata copy, so the user reads the real total
  // before confirming a multi-hour run.
  let preview: {
    source_path: string
    files: number
    bytes: number
    asset_files: number
    asset_bytes: number
    projects_with_external_assets: number
  }
  try {
    preview = await post<typeof preview>('/app-settings/projects-root/preview-migration', {})
  } catch (e: any) {
    projectsRootStatus.value = `Couldn't size the migration: ${e?.data?.detail || e?.message}`
    projectsRootStatusKind.value = 'err'
    return
  }
  const totalSizeStr = formatBytes(preview.bytes)
  const metadataBytes = preview.bytes - preview.asset_bytes
  const breakdownLine = preview.projects_with_external_assets > 0
    ? `\n  ${formatBytes(metadataBytes)} metadata + ${formatBytes(preview.asset_bytes)} assets ` +
      `across ${preview.projects_with_external_assets} project(s) with external storage`
    : ''
  const longRunHint = preview.bytes > 50 * 1024 * 1024 * 1024
    ? `\n\n⚠ This is a large copy (>50 GB) and will take hours. Start before bed; ` +
      `closing the app mid-copy leaves the new location half-populated and the old one intact.`
    : ''
  const ok = confirm(
    `Move projects to:\n  ${pick.path}\n\n` +
    `This will COPY ${preview.files} file(s) (${totalSizeStr}).${breakdownLine}\n\n` +
    `The old location stays in place — delete it manually after verifying ` +
    `the new location works on next launch.\n\n` +
    `The app will restart after the copy completes.${longRunHint}`,
  )
  if (!ok) return

  projectsRootBusy.value = true
  projectsRootStatus.value = `Copying ${preview.files} file(s) (${totalSizeStr})…`
  projectsRootStatusKind.value = 'ok'
  try {
    // Step 1: copy.
    const r = await post<{
      target_path: string; kept_old_at: string
      copied_files: number; copied_bytes: number
      assets_copied_files: number; assets_copied_bytes: number
      per_project_asset_warnings: Array<{ slug: string; warning: string }>
      warnings: string[]
    }>('/app-settings/projects-root/migrate', { target_path: pick.path })

    // Step 2: persist the override AFTER the copy succeeds. If migrate
    // had thrown, the override stays at its previous value and the app
    // continues reading from the (still-intact) old location.
    await put('/app-settings/projects-root', { override: r.target_path })

    const warnCount = r.warnings.length + (r.per_project_asset_warnings?.length || 0)
    const warnSummary = warnCount
      ? ` (${warnCount} warning${warnCount === 1 ? '' : 's'} — check the console)`
      : ''
    const assetSummary = r.assets_copied_files > 0
      ? ` (incl. ${r.assets_copied_files} asset file(s), ${formatBytes(r.assets_copied_bytes)} co-located)`
      : ''
    projectsRootStatus.value =
      `✓ Copied ${r.copied_files} file(s), ${formatBytes(r.copied_bytes)}${assetSummary}` +
      `${warnSummary}. Restarting…`
    projectsRootStatusKind.value = 'ok'
    if (r.warnings.length) {
      console.warn('[projects-root migration] warnings:', r.warnings)
    }
    if (r.per_project_asset_warnings?.length) {
      console.warn('[projects-root migration] per-project asset warnings:', r.per_project_asset_warnings)
      // Surface a concise message for each project the user should
      // revisit on the new location. The recovery banner will pick
      // these up automatically on next boot, but flagging them here
      // shortens the feedback loop.
      const lines = r.per_project_asset_warnings.map(p => `  ${p.slug}: ${p.warning}`).join('\n')
      console.warn(`[projects-root migration] ${r.per_project_asset_warnings.length} project(s) need follow-up:\n${lines}`)
    }

    // Step 3: relaunch. Wait a beat so the user sees the success banner
    // before the window vanishes.
    setTimeout(async () => {
      try {
        await post('/system/restart-app', {})
      } catch (e: any) {
        // Dev mode (tsx) returns 503 — surface that as a clear next step.
        if (e?.status === 503) {
          alert(
            'App is in dev mode and can\'t auto-restart. ' +
            'Quit the app + run `npm run dev` again to pick up the new location.',
          )
        } else {
          alert(`Restart failed: ${e?.data?.detail || e?.message}. Quit + reopen manually.`)
        }
      }
    }, 800)
  } catch (e: any) {
    projectsRootStatus.value = `Migration failed: ${e?.data?.detail || e?.message}`
    projectsRootStatusKind.value = 'err'
    projectsRootBusy.value = false
  }
}

/**
 * Second-machine flow: the user has projects already synced to this
 * Mac via iCloud (or any cloud) and just wants to point the app at
 * that folder without copying anything. Picks the folder, inspects
 * how many projects it contains, confirms with the user, sets the
 * override, restarts.
 *
 * Differs from browseAndMoveProjectsRoot: no migrate step. The files
 * are already at the destination — copying would be a no-op at best
 * and would hit the "non-empty target" 409 from the migrator.
 */
async function browseAndUseExistingProjectsRoot() {
  projectsRootPickerHelp.value = ''
  let pickedPath: string | null
  try {
    pickedPath = await pickFolderShared({
      title: 'Choose existing projects folder',
      button_label: 'Use this folder',
      initial_path: projectsRoot.value?.effective_path,
    })
  } catch (e: any) {
    projectsRootPickerHelp.value = pickerHelpFor(e)
    return
  }
  if (!pickedPath) return  // user cancelled
  const pick = { path: pickedPath }

  // Inspect what's at the picked path so the confirmation message
  // is accurate. Saves the user from accidentally pointing at the
  // wrong folder + getting an empty dashboard with no idea why.
  let inspect: { project_count: number; sample_slugs: string[]; exists: boolean }
  try {
    inspect = await post<typeof inspect>(
      '/app-settings/projects-root/inspect-target',
      { target_path: pick.path },
    )
  } catch (e: any) {
    projectsRootStatus.value = `Inspect failed: ${e?.data?.detail || e?.message}`
    projectsRootStatusKind.value = 'err'
    return
  }

  // Build a confirmation message that matches what they're about to do.
  // Three branches: folder doesn't exist, folder is empty, folder has
  // projects (with sample slugs).
  let msg = ''
  if (!inspect.exists) {
    msg = `Folder doesn't exist yet:\n  ${pick.path}\n\n` +
      `Use it anyway? The app will create it on next launch and the dashboard will be empty until you copy projects in manually.`
  } else if (inspect.project_count === 0) {
    msg = `No Story Studio projects found at:\n  ${pick.path}\n\n` +
      `Use it anyway? The dashboard will be empty until you copy projects in (or pick a different folder).`
  } else {
    const sample = inspect.sample_slugs.slice(0, 5).join(', ')
    const more = inspect.project_count > 5 ? `, +${inspect.project_count - 5} more` : ''
    msg = `Found ${inspect.project_count} project${inspect.project_count === 1 ? '' : 's'} at:\n  ${pick.path}\n\n` +
      `(${sample}${more})\n\n` +
      `Point this app at that folder and restart? No files will be copied or moved.`
  }
  if (!confirm(msg)) return

  projectsRootBusy.value = true
  projectsRootStatus.value = inspect.project_count > 0
    ? `Setting location (${inspect.project_count} project${inspect.project_count === 1 ? '' : 's'} found)…`
    : 'Setting location…'
  projectsRootStatusKind.value = 'ok'
  try {
    await put('/app-settings/projects-root', { override: pick.path })
    projectsRootStatus.value = '✓ Saved. Restarting…'
    setTimeout(async () => {
      try { await post('/system/restart-app', {}) } catch (e: any) {
        if (e?.status === 503) {
          alert('App is in dev mode and can\'t auto-restart. Quit + run `npm run dev` again to pick up the new location.')
        } else {
          alert(`Restart failed: ${e?.data?.detail || e?.message}. Quit + reopen manually.`)
        }
      }
    }, 600)
  } catch (e: any) {
    projectsRootStatus.value = `Failed to save: ${e?.data?.detail || e?.message}`
    projectsRootStatusKind.value = 'err'
    projectsRootBusy.value = false
  }
}

async function resetProjectsRoot() {
  const ok = confirm(
    `Reset to the default projects location?\n\n` +
    `Default: ${projectsRoot.value?.default_path || '(loading)'}\n\n` +
    `Your projects will stay where they are — the app just stops using the\n` +
    `custom path on next launch. If the default location is empty, the\n` +
    `dashboard will be empty after restart (you can move projects manually\n` +
    `or re-pick the custom path).\n\n` +
    `The app will restart.`,
  )
  if (!ok) return
  projectsRootBusy.value = true
  projectsRootStatus.value = 'Resetting…'
  projectsRootStatusKind.value = 'ok'
  try {
    await put('/app-settings/projects-root', { override: '' })
    projectsRootStatus.value = '✓ Reset. Restarting…'
    setTimeout(async () => {
      try { await post('/system/restart-app', {}) } catch {
        alert('App is in dev mode and can\'t auto-restart. Quit + relaunch manually.')
      }
    }, 600)
  } catch (e: any) {
    projectsRootStatus.value = `Reset failed: ${e?.data?.detail || e?.message}`
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
  // the Project tab so the dropdown is populated without a click. Cached
  // 7d on the backend, so the cost is one extra fetch per session at
  // most (and usually zero — fully cache-served).
  if (t === 'project' && !ytCategoryList.value.length) {
    void loadYoutubeCategoryList()
  }
  if (t === 'project' && !ytAppDefaults.value) {
    void loadYoutubeAppDefaults()
  }
  // v1.0.107+ — load location status so the "Unlink from this Mac"
  // danger-zone renders only when the project is actually linked.
  if (t === 'project') void loadProjectLocationStatus()
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
    await saveProject()
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

// v1.0.184 (S1) — settings nav grouped into two SCOPE zones, then topic
// groups within each. The scope split is the headline win: per-machine items
// (FFmpeg / Notifications — save to /app-settings or the FFmpeg installer)
// are visually separated from per-project items (everything that saves to
// /projects/:slug/...), so it's obvious what travels with the project across
// Macs vs. what stays on this machine.
// (API Keys + Appearance + Server Mode still live in the App-Settings modal;
// S2 folds them into the "This Mac" zone here.)
//
// Scope verified by save target, not assumption:
//   per-project (PUT /projects/:slug/settings/config or project storage):
//     Voices, Format, Niche, Standards, Folders, Storage, Named Roots,
//     Confirmations, Project, About
//   per-machine (PUT /app-settings/*, FFmpeg installer):
//     App & Connections (including the read-only GenStudio account catalog),
//     FFmpeg, Notifications
const tabZones = [
  {
    id: 'machine',
    title: 'This Mac',
    scope: 'stays on this machine · never synced',
    groups: [
      { title: 'App', tabs: [
        // v1.0.185 (S2) — API Keys / Appearance / Server Mode merged in from
        // the old standalone App-Settings modal. One "Settings" surface now.
        { id: 'app', label: 'App & Connections', icon: '◇', description: 'Manage appearance, remote access, and the GenStudio account connection and live catalogs shared by every project on this Mac.' },
      ] },
      { title: 'Local & system', tabs: [
        { id: 'ffmpeg', label: 'FFmpeg', icon: '▶', description: 'Install and verify the media engine used for audio mixing, subtitles, effects, and final video exports.' },
        { id: 'notifications', label: 'Notifications', icon: '◉', description: 'Route important job outcomes to this Mac or Telegram and schedule a concise daily production brief.' },
      ] },
    ],
  },
  {
    id: 'project',
    title: 'This Project',
    scope: 'travels with the project',
    groups: [
      { title: 'Content', tabs: [
        { id: 'channel', label: 'Channel Identity', icon: '✦', description: 'Set the Series Formula, compatible Topic Packs, and Production Path that travel with this channel.' },
        { id: 'standards', label: 'Instructions', icon: '✓', description: 'Add optional project-specific rules and episode intro guidance. Series Formula rules remain authoritative.' },
      ] },
      { title: 'Generation', tabs: [
        { id: 'styles', label: 'Styles', icon: '✎', description: 'Curate the project visual language used by scene and thumbnail image generation.' },
      ] },
      { title: 'Files', tabs: [
        { id: 'folders', label: 'Folders', icon: '▤', description: 'Control the portable episode folder structure used throughout the production pipeline.' },
        { id: 'storage', label: 'Storage', icon: '◫', description: 'See where active project files live, reclaim uploaded finals safely, and manage optional split storage.' },
        { id: 'roots', label: 'Named Roots', icon: '⌁', description: 'Map portable asset tokens to folders on this Mac without hard-coding machine-specific paths.' },
      ] },
      { title: 'Other', tabs: [
        { id: 'confirmations', label: 'Confirmations', icon: '!', description: 'Choose where the app pauses for approval and where trusted actions may continue directly.' },
        { id: 'project', label: 'Project', icon: '□', description: 'Edit identity, numbering, grouping, output paths, and lifecycle controls for this project.' },
        { id: 'about', label: 'About', icon: 'i', description: 'Review app, build, project, and storage details useful for support and diagnostics.' },
      ] },
    ],
  },
]

// Flat list derived from the zones — preserves the old `tabs` contract for any
// code that iterates ids (deep-link validation, saved tab state, etc.).
const tabs = tabZones.flatMap(z => z.groups.flatMap(g => g.tabs))

// v1.0.186 (S3) — the zone (This Mac / This Project) that owns the active tab.
// Drives the in-page scope banner so the user always sees whether the panel
// they're editing is per-machine or per-project.
const activeZone = computed(() =>
  tabZones.find(z => z.groups.some(g => g.tabs.some(t => t.id === activeTab.value))) || null,
)

const activeTabMeta = computed(() => tabs.find(tab => tab.id === activeTab.value) || null)
const isChannelTab = computed(() => activeTab.value === 'channel')

type ModelPricingView = 'image' | 'video'
const modelPricingView = ref<ModelPricingView>('image')
const modelPricingViews: Array<{ id: ModelPricingView; label: string; icon: string; description: string }> = [
  { id: 'image', label: 'Image', icon: '▧', description: 'Per render' },
  { id: 'video', label: 'Video', icon: '▶', description: 'Image to video' },
]

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
  try {
    ffmpegStatus.value = await get<FfmpegStatus>('/ffmpeg/status')
    if (wasMissing && ffmpegStatus.value.installed) {
      showFfmpegRestartPrompt.value = true
    }
  } catch (e: any) {
    ffmpegStatus.value = { installed: false }
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

// Auto-switch to the FFmpeg tab when the route hash is `#ffmpeg`. This is
// what the "Install FFmpeg" buttons on the Audio Assembly and Video
// Assembly pages link to — clicking them lands the user directly here
// instead of dropping them onto a generic Settings page.
const _route = useRoute()
function applyHash() {
  const h = (_route.hash || '').toLowerCase()
  // Models are owned by the connected GenStudio account, not a project.
  // Preserve old links while relocating their destination to App & Connections.
  if (h === '#models') {
    activeTab.value = 'app'
    return
  }
  if (h === '#ffmpeg') {
    activeTab.value = 'ffmpeg'
    refreshFfmpegStatus()
    nextTick(() => {
      document.getElementById('ffmpeg-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return
  }
  // Generic hash → tab map. The old #format and #niche deep links now open
  // Channel Identity. Anything else that matches a tab id auto-switches
  // (e.g. `#about` from
  // "Copy version" links, etc.). Unrecognised hashes leave activeTab alone.
  if (h.startsWith('#')) {
    const rawTarget = h.slice(1)
    const target = rawTarget === 'format' || rawTarget === 'niche' ? 'channel' : rawTarget
    if (tabs.some(t => t.id === target)) activeTab.value = target
  }
}
onMounted(() => {
  applyHash()
  if (activeTab.value === 'ffmpeg') refreshFfmpegStatus()
  if (activeTab.value === 'project') void loadProjectLocationStatus()
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
  const tpl = currentTemplates.value.find(t => t.id === selectedTemplateId.value)
  if (!tpl) return
  if (currentStandardText.value.trim()) {
    const ok = await ask({
      title: 'Replace current text?',
      message: 'Loading this template will overwrite the text in the editor. Unsaved edits will be lost.',
      confirmLabel: 'Replace',
    })
    if (!ok) return
  }
  currentStandardText.value = tpl.content
  selectedTemplateId.value = ''
}

async function loadPreset() {
  const p = currentPresets.value.find(x => x.id === selectedPresetId.value)
  if (!p) return
  if (currentStandardText.value.trim()) {
    const ok = await ask({
      title: 'Replace current text?',
      message: 'Loading this preset will overwrite the text in the editor. Unsaved edits will be lost.',
      confirmLabel: 'Replace',
    })
    if (!ok) return
  }
  currentStandardText.value = p.content
}

async function savePreset() {
  const name = newPresetName.value.trim()
  if (!name) return
  const id = `preset-${Date.now()}`
  const preset: StandardPreset = { id, name, content: currentStandardText.value }
  const list = standardsSubTab.value === 'intro' ? introPresets : standardsPresets
  list.value.push(preset)
  try {
    await put(`/projects/${slug.value}/settings/config`, {
      [standardsSubTab.value === 'intro' ? 'intro_presets' : 'standards_presets']: list.value,
    })
    selectedPresetId.value = id
    success('Preset saved!')
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to save preset')
  }
  showSavePreset.value = false
  newPresetName.value = ''
}

async function deletePreset() {
  const list = standardsSubTab.value === 'intro' ? introPresets : standardsPresets
  list.value = list.value.filter(p => p.id !== selectedPresetId.value)
  try {
    await put(`/projects/${slug.value}/settings/config`, {
      [standardsSubTab.value === 'intro' ? 'intro_presets' : 'standards_presets']: list.value,
    })
    selectedPresetId.value = ''
    success('Preset deleted')
  } catch (e: any) { showError(e.data?.detail || 'Failed to delete') }
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
  try {
    if (standardsSubTab.value === 'intro') {
      await put(`/projects/${slug.value}/settings/config`, { intro_standards: introStandards.value })
    } else {
      // Standards endpoint accepts either JSON { content } or text/plain;
      // we go text/plain so there's no escape/diff noise on every keystroke.
      await put(`/projects/${slug.value}/settings/standards`, standards.value, {
        headers: { 'Content-Type': 'text/plain' },
      })
    }
    stampSaved('standards')
    success('Saved!')
  } catch (e: any) {
    showError('Failed to save')
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
// image prompt and feeds its preview image into img2img renders. Selecting a
// built-in style first materialises it into config.style_presets, then marks
// it active — the resolver only looks styles up in that array.
const artStyleSelection = ref('')
const artStyleSaveMessage = ref('')
let artStyleSelectionInitialized = false
let suppressArtStyleSelectionSave = false
const savedStylePresets = computed(() =>
  Array.isArray((config.value as any)?.style_presets) ? (config.value as any).style_presets : [])

watch(config, (c) => {
  if (!c) return
  if (!artStyleSelectionInitialized) {
    artStyleSelection.value = (c as any).active_style_preset_id || ''
    artStyleSelectionInitialized = true
  }
}, { immediate: true })

watch(artStyleSelection, async (next, prev) => {
  if (!artStyleSelectionInitialized) return
  if (suppressArtStyleSelectionSave) return
  if (next === prev) return
  artStyleSaveMessage.value = 'Saving…'
  try {
    const payload: Record<string, any> = {}
    let activeId = next
    if (next.startsWith('builtin:')) {
      const builtinId = next.slice('builtin:'.length)
      const bs = BUILT_IN_STYLES.find(b => b.id === builtinId)
      if (!bs) throw new Error('Unknown built-in style')
      activeId = bs.id
      // Materialise the built-in into style_presets if it isn't there yet
      // (idempotent — re-selecting the same built-in won't duplicate it).
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
    payload.active_style_preset_id = activeId
    // An explicit picker change becomes the user's choice. Future Formula
    // changes must not replace it automatically, even when it happens to be
    // the same style the prior Formula recommended.
    payload.formula_applied_style_id = ''
    await put(`/projects/${slug.value}/settings/config`, payload)
    await refreshConfig(slug.value)
    artStyleSaveMessage.value = activeId ? 'Art style applied to this project' : 'Art style cleared'
    setTimeout(() => { artStyleSaveMessage.value = '' }, 2500)
  } catch (e: any) {
    artStyleSaveMessage.value = e?.data?.detail || e?.message || 'Failed to save art style'
    // Roll back the visible value so the dropdown matches what's persisted.
    artStyleSelection.value = prev || ''
  }
})

/** Apply a Formula's recommended visual style only when the project has no
 * explicit style, or when its current style was applied by the previous
 * Formula production kit. This gives new channels one coherent setup while
 * preserving user-owned art direction on established projects. */
async function applyFormulaVisualDefault(niche: any): Promise<boolean> {
  const styleId = String(niche?.productionKit?.recommendedVisualStyleId || '').trim()
  const current = String((config.value as any)?.active_style_preset_id || '').trim()
  const previousFormulaStyle = String((config.value as any)?.formula_applied_style_id || '').trim()
  if (current && current !== previousFormulaStyle) return false
  if (!styleId) {
    if (!previousFormulaStyle) return false
    await put(`/projects/${slug.value}/settings/config`, {
      active_style_preset_id: '',
      formula_applied_style_id: '',
    })
    await refreshConfig(slug.value)
    suppressArtStyleSelectionSave = true
    artStyleSelection.value = ''
    await nextTick()
    suppressArtStyleSelectionSave = false
    return true
  }

  const builtin = BUILT_IN_STYLES.find(style => style.id === styleId)
  if (!builtin) return false
  const presets = Array.isArray((config.value as any)?.style_presets)
    ? [...(config.value as any).style_presets]
    : []
  if (!presets.some((preset: any) => preset?.id === builtin.id)) {
    presets.push({
      id: builtin.id,
      name: builtin.name,
      description: builtin.data.style_bible,
      created_at: new Date().toISOString(),
    })
  }

  await put(`/projects/${slug.value}/settings/config`, {
    style_presets: presets,
    active_style_preset_id: builtin.id,
    formula_applied_style_id: builtin.id,
  })
  await refreshConfig(slug.value)
  suppressArtStyleSelectionSave = true
  artStyleSelection.value = builtin.id
  await nextTick()
  suppressArtStyleSelectionSave = false
  return current !== builtin.id
}
// (Removed: per-project enable/disable cloud-sync handlers + portable
// form field. Cloud sync is now app-wide via Settings → Storage; the
// per-project mode toggle is dead.)

// Absolute path to the episodes folder — only present when output_root was picked.
// Relative output_root means the project still lives in the hidden userData folder
// and should be migrated via the auto-migration dialog.
const projectLocation = computed(() => {
  const p = project.value as any
  const root = p?.output_root
  if (!root || typeof root !== 'string') return ''
  // Only absolute paths are real locations on disk — relative means unmigrated.
  return root.startsWith('/') || /^[A-Za-z]:\\/.test(root) ? root : ''
})

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

// Editable copies of config data
const editImageModels = ref<Record<string, any>>({})
const editVideoModels = ref<Record<string, any>>({})
const videoModelSource = ref<'hub' | 'direct' | 'compatibility'>('compatibility')
const refreshingVideoModels = ref(false)
const videoModelSourceLabel = computed(() => videoModelSource.value === 'hub'
  ? 'the live catalog'
  : videoModelSource.value === 'direct' ? 'Direct Video Studio URL' : 'saved compatibility data')
const editVoices = ref<SavedVoice[]>([])
const voiceProviderFilter = ref<'all' | VoiceProviderId>('all')
const voiceSort = ref<'provider' | 'name-asc' | 'name-desc'>('provider')

const voiceProviderCounts = computed<Record<VoiceProviderId, number>>(() => {
  const counts = Object.fromEntries(VOICE_PROVIDER_OPTIONS.map(provider => [provider.id, 0])) as Record<VoiceProviderId, number>
  for (const voice of editVoices.value) {
    for (const provider of voice.providers) counts[provider]++
  }
  return counts
})

const filteredVoiceRows = computed(() => {
  const rows = editVoices.value
    .map((voice, index) => ({ voice, index }))
    .filter(row => voiceProviderFilter.value === 'all' || row.voice.providers.includes(voiceProviderFilter.value))
  return rows.sort((a, b) => {
    const nameOrder = a.voice.name.localeCompare(b.voice.name, undefined, { sensitivity: 'base' })
    if (voiceSort.value === 'name-asc') return nameOrder
    if (voiceSort.value === 'name-desc') return -nameOrder
    return firstVoiceProviderIndex(a.voice) - firstVoiceProviderIndex(b.voice) || nameOrder
  })
})

function toggleVoiceProvider(voice: SavedVoice, provider: VoiceProviderId) {
  if (voice.providers.includes(provider)) {
    if (voice.providers.length === 1) {
      info('Each voice needs at least one provider label.')
      return
    }
    voice.providers = voice.providers.filter(item => item !== provider)
  } else {
    voice.providers = VOICE_PROVIDER_OPTIONS
      .map(option => option.id)
      .filter(item => item === provider || voice.providers.includes(item))
  }
}

function addVoice() {
  const provider: VoiceProviderId = voiceProviderFilter.value === 'all' ? 'genstudio' : voiceProviderFilter.value
  editVoices.value.push({ name: '', voice_id: '', providers: [provider] })
}

// Folder config
interface FolderEntry { key: string; label: string; generator: string; order: number; template: string }
const folderConfig = ref<FolderEntry[]>([])
const folderDefaults = ref<Record<string, string>>({})

// Named roots (per-machine, never synced)
const namedRoots = ref<Record<string, string>>({})
const newRootName = ref('')
const newRootPath = ref('')
const pickingRootFolder = ref(false)
const savingRoot = ref(false)

async function loadNamedRoots() {
  try {
    const data = await get<{ roots: Record<string, string> }>('/system/named-roots')
    namedRoots.value = data.roots || {}
  } catch {
    namedRoots.value = {}
  }
}

async function pickRootFolder() {
  pickingRootFolder.value = true
  try {
    const path = await pickFolderShared({
      title: `Choose folder for $\{${newRootName.value.toUpperCase()}\}`,
      initial_path: newRootPath.value || undefined,
    })
    if (path) newRootPath.value = path
  } catch (e: any) {
    showError(e?.data?.detail || 'Could not open folder picker')
  } finally {
    pickingRootFolder.value = false
  }
}

async function saveNamedRoot() {
  const name = newRootName.value.trim().toUpperCase()
  const p = newRootPath.value
  if (!name || !p) return
  savingRoot.value = true
  try {
    const data = await post<{ roots: Record<string, string> }>('/system/named-roots', { name, path: p })
    namedRoots.value = data.roots || {}
    newRootName.value = ''
    newRootPath.value = ''
    stampSaved('roots')
    success(`Named root ${name} saved`)
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to save named root')
  } finally {
    savingRoot.value = false
  }
}

async function removeNamedRoot(name: string | number) {
  const ok = await ask({
    title: `Remove \${${name}}?`,
    message: 'Presets that reference this name will stop resolving on this machine until you re-add it.',
    confirmLabel: 'Remove',
  })
  if (!ok) return
  try {
    const data = await del<{ roots: Record<string, string> }>(`/system/named-roots/${name}`)
    namedRoots.value = data.roots || {}
    success(`Removed ${name}`)
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to remove')
  }
}

// Load folder config when tab becomes active
watch(activeTab, async (tab) => {
  if (tab === 'folders' && !folderConfig.value.length) {
    try {
      const data = await get<any>(`/projects/${slug.value}/settings/subfolder-config`)
      folderConfig.value = data.linkage
      folderDefaults.value = data.defaults
    } catch {}
  }
  if (tab === 'roots') {
    await loadNamedRoots()
  }
})

async function saveFolderConfig() {
  const subfolder_names: Record<string, string> = {}
  for (const entry of folderConfig.value) {
    subfolder_names[entry.key] = entry.template
  }
  try {
    await put(`/projects/${slug.value}/settings/subfolder-config`, { subfolder_names })
    await loadProject(slug.value)
    stampSaved('folder_config')
    success('Folder config saved!')
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to save folder config')
  }
}

function resetFolderDefaults() {
  for (const entry of folderConfig.value) {
    entry.template = folderDefaults.value[entry.key] || entry.template
  }
}

// Sync editable data from config
watch(config, (c) => {
  if (c) {
    // Item J — hydrate the YouTube category_id from config when it
    // arrives. Lives in this watch (not the chatterbox one above)
    // because projectForm is declared between them and the
    // `immediate: true` in the upper watch would TDZ-fault.
    const cAny = c as any
    projectForm.category_id = typeof cAny?.category_id === 'number' && cAny.category_id > 0
      ? cAny.category_id : undefined
    projectForm.mark_as_ai_generated = typeof cAny?.mark_as_ai_generated === 'boolean'
      ? cAny.mark_as_ai_generated : undefined
    editImageModels.value = JSON.parse(JSON.stringify(c.image_models || {}))
    editVideoModels.value = JSON.parse(JSON.stringify((c as any).video_models || {}))
    videoModelSource.value = (c as any).video_models_source || 'compatibility'
    editVoices.value = normalizeSavedVoices(c.voice_presets || [])
    standardsPresets.value = JSON.parse(JSON.stringify((c as any).standards_presets || []))
    introPresets.value = JSON.parse(JSON.stringify((c as any).intro_presets || []))
    introStandards.value = (c as any).intro_standards || ''
    // Load confirmation preferences
    const prefs = (c as any).confirmation_preferences || {}
    for (const gen of confirmGenerators) {
      confirmPrefs[gen.key] = prefs[gen.key] !== false // default true
    }
  }
}, { immediate: true })

// Load standards when tab becomes active
watch(activeTab, async (tab) => {
  if (tab === 'standards' && !standards.value) {
    try {
      const data = await get<{ content: string }>(`/projects/${slug.value}/settings/standards`)
      standards.value = data.content
    } catch {}
  }
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
    // Item J — category_id lives on ProjectConfig (not project meta), so
    // it's hydrated from `config` after refreshConfig fires (see watch
    // below). The initial undefined here means "show the default option
    // until config arrives".
    projectForm.category_id = undefined
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

async function saveImagePricing() {
  try {
    await put(`/projects/${slug.value}/settings/config`, { image_models: editImageModels.value })
    await refreshConfig(slug.value)
    stampSaved('image_pricing')
    success('Image pricing saved!')
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to save')
  }
}

function formatVideoStudioPrice(model: any): string {
  const price = model?.provider_params?.price
  if (!price || !Number.isFinite(Number(price.usd))) return model?.provider_params?.is_cloud ? 'See provider' : 'Local compute'
  const unit = String(price.unit || 'generation').replace(/^per_/, '').replaceAll('_', ' ')
  // model-drift-allow: the Video Studio catalogue's own published provider price,
  // rendered verbatim under a "Provider price" column. Story Studio neither
  // computes nor bills it — no GenStudio credit cost is ever shown in dollars.
  return `$${Number(price.usd).toFixed(2)} / ${unit}`
}

async function refreshVideoCatalog() {
  refreshingVideoModels.value = true
  try {
    const live = await get<any>(`/projects/${slug.value}/settings/config?refresh_video_models=1`)
    editVideoModels.value = JSON.parse(JSON.stringify(live.video_models || {}))
    videoModelSource.value = live.video_models_source || 'compatibility'
    success(`Video catalog refreshed via ${videoModelSourceLabel.value}.`)
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to refresh the Video Studio catalog')
  } finally {
    refreshingVideoModels.value = false
  }
}

async function saveVoices() {
  const unfinished = editVoices.value.find(voice => !voice.name.trim() || !voice.voice_id.trim())
  if (unfinished) {
    showError('Every voice needs both a name and a voice/reference ID. Remove unfinished rows or fill them in.')
    return
  }
  const invalid = editVoices.value.find(voice => voice.providers.length === 0)
  if (invalid) {
    showError(`Choose at least one provider for "${invalid.name}".`)
    return
  }
  const valid = normalizeSavedVoices(editVoices.value)
  try {
    await put(`/projects/${slug.value}/settings/config`, { voice_presets: valid })
    await refreshConfig(slug.value)
    stampSaved('voices')
    success('Voices saved!')
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to save')
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

async function saveProject() {
  try {
    // Item J — split the form: project-meta fields go to /projects/:slug,
    // ProjectConfig fields (currently only category_id) go to
    // /projects/:slug/settings/config. Two PUTs because the backend
    // routes are split — accepted as the simpler path vs. unifying the
    // two endpoints, which would touch a much larger surface.
    //
    // v1.0.45 — strip `season_size` from the regular save path. A
    // raw value-change wouldn't move on-disk folders, leaving every
    // season-aware path resolution silently broken. The Rebalance
    // button next to the field is the only path that commits a new
    // season_size (via /episodes/reseason, which moves folders too).
    const { category_id, mark_as_ai_generated, season_size: _droppedSize, ...projectMeta } = projectForm as any
    if (seasonSizeChanged.value) {
      // Reset the input to the server value so the Rebalance button's
      // "differs from server" gate doesn't keep firing after save.
      projectForm.season_size = serverSeasonSize.value
      info('Episodes per Group not saved — use the ↻ Rebalance button next to the field to apply size changes.')
    }
    await put(`/projects/${slug.value}`, projectMeta)
    // Two ProjectConfig fields wired through the same /settings/config PUT —
    // category_id (Item J, v1.0.20) + mark_as_ai_generated (v1.0.77, YouTube
    // synthetic-content disclosure). undefined means "inherit app default".
    await put(`/projects/${slug.value}/settings/config`, {
      category_id: typeof category_id === 'number' && category_id > 0 ? category_id : undefined,
      mark_as_ai_generated: typeof mark_as_ai_generated === 'boolean' ? mark_as_ai_generated : undefined,
    })
    await loadProject(slug.value)
    if (typeof refreshConfig === 'function') await refreshConfig(slug.value)
    stampSaved('project')
    success('Project settings saved!')
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to save')
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
      'You can restore the project anytime, or permanently delete it later from the home-page Hidden projects panel.',
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
.channel-research-gate {
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, var(--bg-secondary), var(--surface-raised));
}
.research-gate-toggle { display: flex; align-items: flex-start; gap: 10px; margin-top: 12px; cursor: pointer; }
.research-gate-toggle input { margin-top: 3px; flex: none; }
.research-gate-toggle > span { display: block; min-width: 0; }
.research-gate-toggle strong { display: block; font-size: 13px; color: var(--text-primary); }
.research-gate-hint { display: block; margin-top: 4px; font-size: 12px; line-height: 1.5; color: var(--text-muted); }
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
.settings-page-eyebrow,
.settings-active-kicker {
  color: var(--settings-gold);
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
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

.settings-nav {
  display: grid;
  grid-template-columns: minmax(260px, 0.72fr) minmax(540px, 1.28fr);
  gap: 12px;
}
.settings-zone {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 14px;
  background: color-mix(in srgb, var(--bg-secondary) 94%, transparent);
  box-shadow: inset 0 1px rgba(255,255,255,0.025);
}
.settings-zone-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 0 2px 10px;
  border-bottom: 1px solid var(--border);
}
.settings-zone-title { font-size: 13px; font-weight: 750; letter-spacing: 0.01em; color: var(--text-primary); }
.settings-zone-scope { font-size: var(--font-xs); color: var(--text-muted); }
.settings-group { padding: 10px 0 0; }
.settings-group + .settings-group { margin-top: 10px; border-top: 1px solid color-mix(in srgb, var(--border) 65%, transparent); }
.settings-group-label {
  display: block;
  margin: 0 2px 6px;
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.settings-group-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
.settings-group-tabs .tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 34px;
  padding: 7px 10px;
  border: 1px solid transparent;
  border-radius: 9px;
  color: var(--text-secondary);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: var(--font-xs);
  transition: border-color .16s, background .16s, color .16s, transform .16s;
}
.settings-group-tabs .tab:hover { color: var(--text-primary); border-color: var(--border); background: var(--bg-tertiary); transform: translateY(-1px); }
.settings-group-tabs .tab.active {
  color: var(--text-primary);
  border-color: color-mix(in srgb, var(--settings-green) 48%, var(--border));
  background: linear-gradient(135deg, rgba(88, 198, 146, 0.14), rgba(227, 180, 90, 0.06));
  box-shadow: 0 5px 18px rgba(0,0,0,0.12);
}
.settings-tab-icon { display: inline-grid; place-items: center; width: 18px; height: 18px; color: var(--settings-gold); font-size: 12px; }

.settings-active-intro {
  display: grid;
  grid-template-columns: 46px minmax(0, 1fr) auto;
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
.settings-active-icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 12px;
  color: var(--settings-gold);
  background: linear-gradient(145deg, rgba(227,180,90,.16), rgba(88,198,146,.1));
  border: 1px solid rgba(227,180,90,.18);
  font-size: 20px;
}
.settings-active-copy h2 { margin: 1px 0 3px; font-size: 18px; letter-spacing: -0.015em; }
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
.settings-segmented-nav {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
  padding: 7px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--bg-primary) 52%, transparent);
}
.settings-segmented-button {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  min-height: 52px;
  padding: 9px 12px;
  border: 1px solid transparent;
  border-radius: 10px;
  color: var(--text-secondary);
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
  transition: .16s ease;
}
.settings-segmented-button > span:first-child {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: var(--settings-gold);
  background: rgba(227,180,90,.09);
}
.settings-segmented-button > span:last-child { display: flex; min-width: 0; flex-direction: column; }
.settings-segmented-button strong { font-size: var(--font-xs); }
.settings-segmented-button small { color: var(--text-muted); font-size: var(--font-xs); }
.settings-segmented-button:hover { color: var(--text-primary); border-color: var(--border); background: var(--bg-tertiary); transform: translateY(-1px); }
.settings-segmented-button.active {
  color: var(--text-primary);
  border-color: rgba(88,198,146,.4);
  background: linear-gradient(145deg, rgba(88,198,146,.14), rgba(227,180,90,.06));
  box-shadow: 0 8px 22px rgba(0,0,0,.12);
}
.settings-subpanel {
  display: block;
  margin-top: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--bg-tertiary) 58%, transparent);
}
.settings-panel .edit-table { border: 1px solid var(--border); border-radius: 12px; border-collapse: separate; border-spacing: 0; overflow: hidden; }
.settings-panel .edit-table th { background: color-mix(in srgb, var(--bg-tertiary) 90%, var(--settings-green)); }
.settings-panel .edit-table tbody tr:hover td { background: rgba(88,198,146,.035); }

@media (max-width: 1100px) {
  .settings-nav { grid-template-columns: 1fr; }
}
@media (max-width: 720px) {
  .settings-page-hero { align-items: flex-start; flex-direction: column; padding: 20px; }
  .settings-page-key { width: 100%; justify-content: space-around; }
  .settings-group-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .settings-group-tabs .tab { width: 100%; }
  .settings-active-intro { grid-template-columns: 40px 1fr; }
  .settings-active-icon { width: 38px; height: 38px; }
  .settings-scope-pill { grid-column: 1 / -1; justify-self: start; }
  .settings-section-head { align-items: flex-start; flex-direction: column; }
  .settings-segmented-button { justify-content: center; }
  .settings-segmented-button small { display: none; }
}

.edit-table {
  width: 100%;
  border-collapse: collapse;
}

.edit-table th {
  text-align: left;
  font-size: 12px;
  color: var(--text-muted);
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}

.edit-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  font-size: 14px;
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

.voice-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.voice-library-heading,
.voice-library-toolbar,
.voice-row-edit {
  display: flex;
  gap: 8px;
  align-items: center;
}
.voice-library-heading {
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
}
.voice-count {
  color: var(--text-muted);
  font-size: var(--font-xs);
  padding: 4px 9px;
  border-radius: 999px;
  background: var(--bg-hover);
  white-space: nowrap;
}
.voice-library-toolbar {
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 14px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
}
.voice-provider-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.voice-filter {
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  background: transparent;
  padding: 5px 9px;
  cursor: pointer;
  font-size: 12px;
}
.voice-filter span { opacity: .7; margin-left: 3px; }
.voice-filter:hover,
.voice-filter.active {
  color: var(--text-primary);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 13%, transparent);
}
.voice-sort { width: 180px; flex: 0 0 auto; }
.voice-row-edit {
  position: relative;
  align-items: stretch;
  padding: 12px;
  padding-right: 42px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  flex-direction: column;
}
.voice-fields { display: grid; grid-template-columns: minmax(180px, .75fr) minmax(260px, 1.25fr); gap: 8px; }
.voice-name-input,
.voice-id-input { width: 100%; }
.voice-provider-labels { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.voice-provider-prompt { color: var(--text-muted); font-size: var(--font-xs); margin-right: 2px; }
.voice-provider-toggle {
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  padding: 4px 8px;
  font-size: var(--font-xs);
  cursor: pointer;
  user-select: none;
}
.voice-provider-toggle input { position: absolute; opacity: 0; pointer-events: none; }
.voice-provider-toggle.active {
  color: var(--text-primary);
  border-color: var(--success);
  background: color-mix(in srgb, var(--success) 12%, transparent);
}
.voice-remove { position: absolute; top: 9px; right: 8px; }
.voice-empty {
  padding: 22px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}
@media (max-width: 820px) {
  .voice-library-toolbar { flex-direction: column; }
  .voice-sort { width: 100%; }
  .voice-fields { grid-template-columns: 1fr; }
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
.notification-panel { overflow: hidden; }
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
.upload-badge.none { color: var(--text-muted); }

.storage-result {
  padding: 8px 12px; background: var(--bg-tertiary);
  border-left: 3px solid var(--success, #5fc070);
  border-radius: var(--radius-sm); font-size: 12px;
}
.storage-result .error-text { color: var(--error, #e25c5c); margin-left: 4px; }

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
@media (max-width: 1100px) {
  .production-kit-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 680px) {
  .production-kit-head { flex-direction: column; }
  .production-kit-grid { grid-template-columns: 1fr; }
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
