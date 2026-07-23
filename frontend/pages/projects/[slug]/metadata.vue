<template>
  <div class="workspace-page creation-workspace metadata-workspace">
    <WorkspaceHero
      eyebrow="Create · Package"
      title="Metadata Generator"
      description="Prepare the final title, description, tags, links, and chapter information from the approved episode script."
    >
      <template #aside>
        <div class="workspace-metrics" aria-label="Metadata workspace context">
          <span class="workspace-metric" :data-tone="episodeId ? 'success' : 'warning'"><strong>{{ episodeId || 'No episode' }}</strong> target</span>
          <span class="workspace-metric" :data-tone="scriptReady ? 'success' : 'warning'"><strong>{{ scriptReady ? 'Ready' : 'Needed' }}</strong> script</span>
          <span v-if="metadataBusy" class="workspace-metric" data-tone="info"><strong>Active</strong> generation</span>
        </div>
      </template>
    </WorkspaceHero>
    <div class="workspace-command-surface creation-command-surface">
      <TopActionBar
      :project-slug="slug"
      :presets="metadataPresets"
      v-model:episode-id="episodeId"
      filter-field="metadata"
      generate-label="Generate Metadata"
      loading-label="Generating…"
      :generate-loading="metadataBusy"
      :generate-disabled="!episodeId || !scriptReady"
      :generate-status="metadataBusy ? `Generating metadata for ${episodeId}…` : scriptGateReason"
      @generate="generateAll"
      @episode-selected="onEpisodeSelected"
      @preset-applied="success('Preset applied')"
      @preset-saved="success('Preset saved')"
      @preset-deleted="success('Preset deleted')"
      />
      <p class="workspace-command-copy">
        Generate the complete publishing package at once, or open the section editor below to refine individual outputs.
        <NuxtLink :to="`/projects/${slug}/metadata-template`" class="meta-template-link">Edit channel template →</NuxtLink>
      </p>
    </div>

    <!-- v1.0.298 — persistent generation feedback. The button spinner covers
         "is it running"; this row covers "is it done, and did it work" AFTER
         the spinner clears + the transient toast fades. Running → live status;
         done → success/error/cancelled that stays put until the next run or an
         episode switch. -->
    <div v-if="metadataBusy" class="meta-result meta-result-running">
      <LoadingSpinner size="sm" />
      <span>Generating metadata for <strong>{{ episodeId }}</strong>… you can switch episodes; it keeps running in the background.</span>
    </div>
    <div
      v-else-if="lastGenResult"
      :class="['meta-result', `meta-result-${lastGenResult.kind}`]"
    >
      <span class="meta-result-icon" aria-hidden="true">{{ lastGenResult.kind === 'success' ? '✓' : lastGenResult.kind === 'cancelled' ? '⊘' : '✗' }}</span>
      <span>{{ lastGenResult.message }}</span>
      <button type="button" class="btn btn-link btn-xs meta-result-dismiss" @click="lastGenResult = null">Dismiss</button>
    </div>

    <!-- Channel "what worked" inspiration. Auto-included server-side in
         the title generator's LLM prompt; this card surfaces the titles
         being used as a vibe reference. Hides silently when no analytics
         data is available. -->
    <TopPerformersInspiration :slug="slug" class="mt-3" />

    <!-- Shared AI model — applies to every section below. Labelled as -->
    <!-- such so users don't wonder why moving this control changes all -->
    <!-- three generators (consistency with image-prompts, which uses one -->
    <!-- shared model across Scene + Thumbnail pools). -->
    <div class="card workspace-section shared-settings">
      <div class="shared-settings-label">
        <span>AI Model</span>
        <span class="text-muted text-xs font-normal">used by all sections below</span>
      </div>
      <div class="form-group shared-settings-control">
        <ModelSelector v-model="model" :project-slug="slug" />
      </div>
    </div>

    <!-- v1.0.198 — starter templates. Format-neutral starting points that
         replace the old sleep-story-only default. The format-matched one is
         applied automatically on a fresh episode; pick another to switch. -->
    <div class="card workspace-section starter-templates">
      <div class="shared-settings-label">
        <span>Starter template</span>
        <span class="text-muted text-xs font-normal">a starting point for the description sections — tweak after applying</span>
      </div>
      <div class="starter-templates-row mt-1">
        <button
          v-for="t in starterTemplates"
          :key="t.id"
          type="button"
          :class="['starter-tpl-btn', { active: activeTemplateId === t.id }]"
          :title="t.description"
          @click="applyStarterTemplate(t.id)"
        >{{ t.label }}</button>
        <button
          type="button"
          class="starter-tpl-btn starter-tpl-reset"
          title="Re-apply this format's default template (discards section tweaks; presets untouched)"
          @click="resetToFormatDefault"
        >↺ Reset to format default</button>
      </div>
      <!-- v1.0.200 — live outline: the enabled sections in render order. -->
      <div v-if="enabledSectionLabels.length" class="section-outline mt-2">
        <span class="text-muted text-xs">Description shape:</span>
        <template v-for="(lbl, i) in enabledSectionLabels" :key="i">
          <span class="outline-chip">{{ lbl }}</span><span v-if="i < enabledSectionLabels.length - 1" class="outline-sep">→</span>
        </template>
      </div>
    </div>

    <!-- v1.0.182 — the three section editors collapse behind the shared
         AdvancedDisclosure. The common path is: pick model → Generate
         Metadata (top button runs all three) → review the Preview. Open
         only to fine-tune title mode, the description's channel template,
         or tag count. Open state remembered per project. -->
    <AdvancedDisclosure
      label="Customize sections (title mode · description template · tags)"
      :persist-key="META_ADV_KEY"
    >
    <!-- ═══════ 1. SEO Video Title ═══════ -->
    <div class="card mt-2">
      <div class="card-header">
        <h3>1. SEO Video Title</h3>
        <p class="text-muted text-sm">Generate title options optimized for multiple platforms</p>
      </div>

      <!-- Title mode picker — drives whether we copy the idea title
           verbatim (v1.0.90+ default; preserves the title you picked at
           Ideas Generator time), paraphrase via LLM, or use the user's
           typed string. Fixed modes (idea / manual) skip the LLM entirely
           and produce one title; the count + platform-preset rows are
           dimmed for those modes since they don't apply. -->
      <div class="form-group mt-1">
        <label>Title mode</label>
        <div class="title-mode-row">
          <label class="title-mode-option">
            <input type="radio" value="use_idea_title" v-model="titleConfig.mode" />
            <span><strong>Use idea title</strong> (default) — copy the episode's idea title verbatim, with optional channel prefix / suffix.</span>
          </label>
          <label class="title-mode-option">
            <input type="radio" value="paraphrase" v-model="titleConfig.mode" />
            <span><strong>AI paraphrase</strong> — generate N SEO-rewritten title options and pick the first.</span>
          </label>
          <label class="title-mode-option">
            <input type="radio" value="manual" v-model="titleConfig.mode" />
            <span><strong>Manual title</strong> — type your own, with optional channel prefix / suffix.</span>
          </label>
        </div>
      </div>

      <div v-if="titleConfig.mode === 'manual'" class="form-group mt-1">
        <label>Manual title</label>
        <input
          v-model="titleConfig.manualTitle"
          type="text"
          class="input"
          placeholder="e.g. The Tea Blender in the Morning Mist"
        />
      </div>

      <!-- Channel prefix + suffix (v1.0.90+). Locks a constant string at
           the front and/or back of every episode title for this project —
           "Morning Prayer:" or " | Daily Prayer Channel" or both. Both
           live on the project config (broll_channel_title_prefix /
           broll_channel_title_suffix) so every metadata generation uses
           the same values without re-typing per episode. -->
      <div v-if="titleConfig.mode !== 'paraphrase'" class="grid-2 mt-1">
        <div class="form-group">
          <label>Channel prefix <span class="text-muted">(prepended to every title)</span></label>
          <input
            v-model="titleConfig.prefix"
            type="text"
            class="input"
            placeholder="e.g. Morning Prayer:  "
          />
          <span class="text-muted text-xs">Saved per project. Use a trailing space / punctuation if you want a gap between the prefix and the title.</span>
        </div>
        <div class="form-group">
          <label>Channel suffix <span class="text-muted">(appended to every title)</span></label>
          <input
            v-model="titleConfig.suffix"
            type="text"
            class="input"
            placeholder="e.g.  | Daily Prayer Channel"
          />
        </div>
      </div>
      <div v-if="titleConfig.mode !== 'paraphrase'" class="form-group mt-1">
        <p class="text-muted text-xs hint-line">
          Preview:
          <code>{{ titlePreviewText }}</code>
        </p>
      </div>

      <div class="grid-3 mt-1" :class="{ 'controls-dimmed': titleConfig.mode !== 'paraphrase' }">
        <div class="form-group">
          <label>Platform preset</label>
          <select v-model="titleConfig.preset" @change="onTitlePresetChange" class="select" :disabled="titleConfig.mode !== 'paraphrase'">
            <option value="Universal">Universal (100 — fits all)</option>
            <option value="YouTube">YouTube (100)</option>
            <option value="TikTok">TikTok (100)</option>
            <option value="Facebook">Facebook (255)</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        <div class="form-group">
          <label>Max length (characters)</label>
          <input v-model.number="titleConfig.maxLength" type="number" min="10" max="300" class="input" />
        </div>
        <div class="form-group">
          <label>Number of options</label>
          <input
            v-model.number="titleConfig.count"
            type="number"
            min="1"
            max="20"
            class="input"
            :disabled="titleConfig.mode !== 'paraphrase'"
            :title="titleConfig.mode !== 'paraphrase' ? 'Fixed-title modes always produce one title.' : ''"
          />
        </div>
      </div>

      <label class="checkbox-label mt-1" :class="{ 'controls-dimmed': titleConfig.mode !== 'paraphrase' }">
        <input
          type="checkbox"
          v-model="titleConfig.includeScriptContext"
          :disabled="titleConfig.mode !== 'paraphrase'"
        />
        Include script context for grounding
      </label>

      <div v-if="titleOptions.length" class="title-options mt-2">
        <div
          v-for="(t, i) in titleOptions"
          :key="i"
          :class="['title-option', { selected: preview.title === t }]"
          @click="preview.title = t"
        >
          <span class="title-option-text">{{ t }}</span>
          <span class="title-option-count">{{ t.length }} / {{ titleConfig.maxLength }}</span>
        </div>
      </div>

      <button
        class="btn btn-sm btn-primary mt-2"
        :disabled="!episodeId || genTitles || genAll || !scriptReady"
        :title="scriptGateReason || 'Generate only the SEO title options — description and tags stay untouched.'"
        @click="generateTitles"
      >
        <LoadingSpinner v-if="genTitles" size="sm" />
        {{ genTitles ? 'Generating titles…' : 'Generate Titles Only' }}
      </button>
    </div>

    <!-- ═══════ 2. Description ═══════ -->
    <div class="card mt-2">
      <div class="card-header">
        <h3>2. Description</h3>
        <p class="text-muted text-sm">Toggle sections on/off, drag to reorder. AI fills content per episode.</p>
      </div>

      <div class="form-group mt-1 narrow-field">
        <label>Max length (characters) — YouTube max is 5000</label>
        <input v-model.number="descConfig.maxChars" type="number" min="100" max="5000" class="input" />
      </div>

      <p class="text-muted text-sm mt-1">
        <span aria-hidden="true">⋮⋮</span>
        Drag sections to reorder, or use the arrow buttons. Toggle the checkbox to include/exclude.
        <strong>Order matters</strong> — the final description renders each enabled section top-to-bottom in the order shown here.
      </p>

      <div class="section-list mt-1">
        <div
          v-for="(section, i) in sections"
          :key="section.id"
          :class="['section-item', { disabled: !section.enabled, 'drag-over': dragOverIndex === i }]"
          :draggable="true"
          @dragstart="onDragStart(i, $event)"
          @dragover.prevent="onDragOver(i)"
          @dragleave="onDragLeave"
          @drop.prevent="onDrop(i)"
          @dragend="onDragEnd"
        >
          <div class="section-header">
            <div class="section-head-left">
              <span class="drag-handle" aria-hidden="true" title="Drag to reorder">⋮⋮</span>
              <div class="reorder-btns">
                <button
                  class="reorder-btn"
                  type="button"
                  :aria-label="`Move ${section.label} up`"
                  @click="moveSection(i, -1)"
                  :disabled="i === 0"
                >▲</button>
                <button
                  class="reorder-btn"
                  type="button"
                  :aria-label="`Move ${section.label} down`"
                  @click="moveSection(i, 1)"
                  :disabled="i === sections.length - 1"
                >▼</button>
              </div>
              <label class="toggle-label">
                <input type="checkbox" v-model="section.enabled" />
                <strong>{{ section.label }}</strong>
              </label>
            </div>
            <button v-if="section.type === 'custom'" class="btn-icon danger" @click="sections.splice(i, 1)" aria-label="Remove section">✕</button>
          </div>

          <div v-if="section.enabled && section.config" class="section-config">
            <!-- HOOK: characters + optional brand-prefix instead of sentence count -->
            <div v-if="section.id === 'hook'">
              <div class="form-group">
                <label>Hook length (characters)</label>
                <input v-model.number="section.config.characters" type="number" min="80" max="500" step="10" class="input input-narrow" />
                <p class="text-muted text-xs hint-line">
                  Soft target the LLM aims for, ±15%. ~250 chars is the YouTube SEO snippet sweet spot.
                </p>
              </div>
              <div class="form-group">
                <label>Starting format <span class="text-muted font-normal">(optional — leave blank for LLM-suggested opener)</span></label>
                <input v-model="section.config.starting_format" class="input" placeholder="Optional opening line, e.g. “In this video…” or your channel's standard intro" />
                <p class="text-muted text-xs hint-line">
                  If set, every hook will begin with EXACTLY this text, then continue naturally.
                </p>
              </div>
            </div>

            <!-- NARRATOR: just a name (was bundled inside the old 'metadata' section) -->
            <div v-if="section.id === 'narrator'" class="form-group">
              <label>Narrator name</label>
              <input v-model="section.config.name" class="input" placeholder="e.g. Your Narrator" />
            </div>

            <!-- MUSIC: title + link + disclaimer (NEW dedicated section) -->
            <div v-if="section.id === 'music'">
              <div class="form-group">
                <label>Music title</label>
                <input v-model="section.config.title" class="input" placeholder="e.g. Inner Sound — Jesse Gallagher" />
              </div>
              <div class="form-group">
                <label>Music link</label>
                <input v-model="section.config.link" class="input" placeholder="https://... (YouTube Audio Library, Artlist, etc.)" />
              </div>
              <div class="form-group">
                <label>Music disclaimer</label>
                <textarea v-model="section.config.disclaimer" class="textarea config-textarea" placeholder="License / attribution text" />
              </div>
            </div>

            <!-- CHANNELS: array (own + recommended) using the videos[] pattern -->
            <div v-if="section.id === 'channels'">
              <label class="section-helper-label">
                Add your own channel(s) and recommended channels. Mark each so the description groups them correctly.
              </label>
              <div v-for="(ch, ci) in section.config.channels" :key="ci" class="link-row">
                <select v-model="ch.kind" class="select link-select-kind">
                  <option value="own">Our channel</option>
                  <option value="recommended">Recommended</option>
                </select>
                <input v-model="ch.name" class="input link-input-name" placeholder="Channel name" />
                <input v-model="ch.url" class="input link-input-url" placeholder="https://youtube.com/@..." />
                <button class="btn-icon danger" @click="section.config.channels.splice(ci, 1)" aria-label="Remove channel">✕</button>
              </div>
              <button class="btn btn-sm btn-secondary mt-1" @click="section.config.channels.push({ name: '', url: '', kind: 'recommended' })">+ Add Channel</button>
            </div>

            <div v-if="section.id === 'videos'">
              <label class="section-helper-label">Add video links to recommend in the description</label>
              <div v-for="(vid, vi) in section.config.videos" :key="vi" class="link-row">
                <input v-model="vid.name" class="input link-input-name" placeholder="Video title" />
                <input v-model="vid.url" class="input link-input-url" placeholder="https://youtube.com/watch?v=..." />
                <button class="btn-icon danger" @click="section.config.videos.splice(vi, 1)">✕</button>
              </div>
              <button class="btn btn-sm btn-secondary mt-1" @click="section.config.videos.push({ name: '', url: '' })">+ Add Video</button>
            </div>

            <div v-if="section.id === 'playlists'">
              <label class="section-helper-label">Add playlist links to feature in the description</label>
              <!-- Dropdown picker: pulls playlists from the project's
                   connected YouTube channel via the same endpoint the
                   Upload page uses. Picking a playlist inserts a new
                   row prefilled with the title + canonical URL — no
                   more copy/pasting playlist links. The manual
                   "+ Add Playlist" below stays for playlists from
                   OTHER channels (collabs, recommended, etc). -->
              <div v-if="availablePlaylists.length" class="link-row playlist-picker-row mt-1">
                <select
                  class="input playlist-picker-select"
                  :value="''"
                  title="Pick a playlist from your connected YouTube channel. Inserts the title + URL into a new row below — no copy/pasting."
                  @change="e => addPlaylistFromChannel((e.target as HTMLSelectElement).value)"
                >
                  <option value="" disabled>📥 Add from your YouTube channel…</option>
                  <option v-for="pl in availablePlaylists" :key="pl.id" :value="pl.id">
                    {{ pl.title }}{{ pl.itemCount != null ? ` (${pl.itemCount} videos)` : '' }}
                  </option>
                </select>
                <button
                  class="btn-icon"
                  :disabled="playlistsLoading"
                  title="Refresh the playlist list from YouTube. Cached 60s otherwise."
                  @click="loadAvailablePlaylists(true)"
                >↻</button>
              </div>
              <div v-else-if="!playlistsLoading && playlistsError" class="text-muted text-xs playlist-picker-error">
                Couldn't load YouTube playlists ({{ playlistsError }}). You can still paste links manually below.
              </div>
              <div v-for="(pl, pi) in section.config.playlists" :key="pi" class="link-row">
                <input v-model="pl.name" class="input link-input-name" placeholder="Playlist name" />
                <input v-model="pl.url" class="input link-input-url" placeholder="https://youtube.com/playlist?list=..." />
                <button class="btn-icon danger" @click="section.config.playlists.splice(pi, 1)">✕</button>
              </div>
              <button class="btn btn-sm btn-secondary mt-1" @click="section.config.playlists.push({ name: '', url: '' })">+ Add Playlist (manual link)</button>
            </div>

            <!-- CTA: subscribe/like only — separate from the support section now.
                 Keeps the "free way to help" ask distinct from the "pay to support"
                 ask, which the user wanted broken apart. -->
            <div v-if="section.id === 'cta'">
              <label class="section-helper-label">
                Optional custom subscribe/like lines. Leave empty to let the LLM write its own short CTA.
              </label>
              <div v-for="(line, li) in section.config.custom_lines" :key="li" class="link-row">
                <input v-model="section.config.custom_lines[li]" class="input flex-1" placeholder="e.g. Hit the bell so you never miss a new story." />
                <button class="btn-icon danger" @click="section.config.custom_lines.splice(li, 1)" aria-label="Remove line">✕</button>
              </div>
              <button class="btn btn-sm btn-secondary mt-1" @click="section.config.custom_lines.push('')">+ Add CTA Line</button>
            </div>

            <!-- SUPPORT: array of platforms, was Patreon-only on the old cta.
                 Keeps the same UX as videos/channels (kind dropdown + URL +
                 optional label only when kind='custom'). -->
            <div v-if="section.id === 'support'">
              <label class="section-helper-label">
                Where can viewers support the channel? Patreon, Ko-fi, Buy Me a Coffee, YouTube Members, or any custom platform.
              </label>
              <div v-for="(plat, pi) in section.config.platforms" :key="pi" class="link-row support-row">
                <select v-model="plat.kind" class="select support-select-kind">
                  <option value="patreon">Patreon</option>
                  <option value="kofi">Ko-fi</option>
                  <option value="buymeacoffee">Buy Me a Coffee</option>
                  <option value="youtube-members">YouTube Members</option>
                  <option value="custom">Custom…</option>
                </select>
                <input
                  v-if="plat.kind === 'custom'"
                  v-model="plat.label"
                  class="input support-input-label"
                  placeholder="Label (e.g. Stripe link)"
                />
                <input v-model="plat.url" class="input flex-1" placeholder="https://..." />
                <button class="btn-icon danger" @click="section.config.platforms.splice(pi, 1)" aria-label="Remove platform">✕</button>
              </div>
              <button class="btn btn-sm btn-secondary mt-1" @click="section.config.platforms.push({ kind: 'patreon', url: '' })">+ Add Platform</button>
            </div>

            <div v-if="section.id === 'affiliate'" class="form-group">
              <label>Affiliate disclaimer text</label>
              <textarea v-model="section.config.text" class="textarea config-textarea" />
            </div>

            <div v-if="section.id === 'ai-disclosure'" class="form-group">
              <label>AI disclosure text</label>
              <textarea v-model="section.config.text" class="textarea config-textarea" />
            </div>

            <!-- v1.0.198 (M1b) — Sources: the episode's research citations,
                 appended (real links) when you generate. Toggle the section
                 off to omit sources entirely. -->
            <div v-if="section.id === 'sources'" class="sources-section">
              <div v-if="!episodeId" class="text-muted text-xs">Pick an episode to load its research sources.</div>
              <div v-else-if="!researchLoaded" class="text-muted text-xs">
                No research for this episode — sources come from the
                <NuxtLink :to="`/projects/${slug}/research`" class="meta-template-link">Research</NuxtLink> step.
                Nothing is added until you run research.
              </div>
              <template v-else>
                <div class="sources-bulk">
                  <span class="text-muted text-xs">In description ({{ includedSrcPreview.length }}):</span>
                  <button type="button" class="btn btn-xs btn-secondary" :disabled="savingResearch" @click="bulkSrc('all')">All</button>
                  <button type="button" class="btn btn-xs btn-secondary" :disabled="savingResearch" @click="bulkSrc('verified')" title="Only sources cited by a verified claim">Verified-backing</button>
                  <button type="button" class="btn btn-xs btn-ghost" :disabled="savingResearch" @click="bulkSrc('none')">None</button>
                </div>
                <ul class="sources-list">
                  <li v-for="(c, i) in researchCitations" :key="i" :class="{ 'src-off': c.url && !srcIncluded(c) }">
                    <input
                      v-if="c.url"
                      type="checkbox"
                      :checked="srcIncluded(c)"
                      :disabled="savingResearch"
                      @change="setSrcIncluded(c, ($event.target as HTMLInputElement).checked)"
                    />
                    <a v-if="c.url" :href="c.url" target="_blank" rel="noopener noreferrer">{{ c.title || c.url }}</a>
                    <span v-else>{{ c.title }}</span>
                    <span v-if="c.url && verifiedBackingSet.has(i)" class="src-vbadge" title="Cited by a verified claim">verified-backing</span>
                  </li>
                </ul>
                <p class="text-muted text-xs sources-note">
                  Appended to the description with real links when you generate. Your picks are shared with the Research page.
                </p>
              </template>
            </div>

            <div v-if="section.id === 'hashtags'" class="form-group">
              <label>Number of hashtags to generate (inside description)</label>
              <input v-model.number="section.config.count" type="number" min="5" max="30" class="input input-narrow" />
            </div>

            <div v-if="section.type === 'custom'">
              <div class="form-group">
                <label>Block title</label>
                <input v-model="section.label" class="input" />
              </div>
              <div class="form-group">
                <label>Instructions for AI</label>
                <textarea v-model="section.config.instructions" class="textarea config-textarea" placeholder="Describe what this section should contain..." />
              </div>
            </div>

            <!-- v1.0.199 — generic editor: a catalog section type flagged
                 `generic` renders its fields here, so a new simple section
                 type needs no bespoke editor block above. -->
            <div v-for="f in genericFieldsFor(section.id)" :key="f.key" class="form-group">
              <label>{{ f.label }}</label>
              <textarea v-if="f.type === 'textarea'" v-model="section.config[f.key]" class="textarea config-textarea" />
              <input v-else :type="f.type === 'number' ? 'number' : 'text'" v-model="section.config[f.key]" class="input" />
            </div>
          </div>
        </div>
      </div>

      <div class="flex items-center gap-2 mt-2 flex-wrap">
        <!-- v1.0.199 — add any built-in section type (from the catalog) to the
             current template, not just custom ones. -->
        <select v-if="addableSections.length" class="select select-sm add-section-select" @change="onAddSection" title="Add a built-in section to this description">
          <option value="">+ Add section…</option>
          <option v-for="c in addableSections" :key="c.id" :value="c.id">{{ c.label }}</option>
        </select>
        <button class="btn btn-sm btn-secondary" @click="addCustomBlock">+ Add Custom Section</button>
        <button
          class="btn btn-sm btn-primary"
          :disabled="!episodeId || genDesc || genAll || !scriptReady"
          :title="scriptGateReason || 'Generate only the description — titles and tags stay untouched.'"
          @click="generateDescription"
        >
          <LoadingSpinner v-if="genDesc" size="sm" />
          {{ genDesc ? 'Generating description…' : 'Generate Description Only' }}
        </button>
      </div>
    </div>

    <!-- ═══════ 3. Tags ═══════ -->
    <div class="card mt-2">
      <div class="card-header">
        <h3>3. YouTube Tags</h3>
        <p class="text-muted text-sm">Tags boost discoverability — separate from in-description hashtags</p>
      </div>
      <div class="form-group mt-1 narrow-field-wide">
        <label>Number of tags</label>
        <input v-model.number="tagConfig.count" type="number" min="1" max="50" class="input" />
      </div>
      <button
        class="btn btn-sm btn-primary mt-2"
        :disabled="!episodeId || genTags || genAll || !scriptReady"
        :title="scriptGateReason || 'Generate only YouTube tags — titles and description stay untouched.'"
        @click="generateTags"
      >
        <LoadingSpinner v-if="genTags" size="sm" />
        {{ genTags ? 'Generating tags…' : 'Generate Tags Only' }}
      </button>
    </div>
    </AdvancedDisclosure>


    <!-- ═══════ Preview ═══════ -->
    <div class="card mt-2">
      <div class="card-header">
        <h3>Preview</h3>
        <div class="flex gap-2 items-center">
          <SaveIndicator :state="autoSave.state.value" :saved-at="autoSave.savedAt.value" :error-message="autoSave.errorMessage.value" />
          <span class="text-muted text-xs">
            <template v-if="sessionVersion">Editing v{{ sessionVersion }} (auto-saving)</template>
            <template v-else-if="versions.length">Loaded v{{ selectedVersion }} — first edit creates v{{ nextVersionNumber }}</template>
            <template v-else>First save will create v1</template>
          </span>
          <div v-if="versions.length" class="form-group history-picker">
            <label class="text-muted history-label">History</label>
            <select v-model.number="selectedVersion" @change="loadVersion" class="select select-sm" :title="`${versions.length} version(s) on disk`">
              <option v-for="v in versions" :key="v.version" :value="v.version">
                v{{ v.version }}{{ v.savedAt ? ` — ${formatDate(v.savedAt)}` : '' }}
              </option>
            </select>
          </div>
          <button
            class="btn btn-sm btn-secondary"
            :title="'Force a new version snapshot right now (otherwise autosave handles this)'"
            @click="forkToNewVersion"
          >
            🔱 Fork to v{{ nextVersionNumber }}
          </button>
        </div>
      </div>

      <div class="form-group mt-1">
        <label>
          Title
          <span class="char-count" :class="{ 'over-limit': preview.title.length > titleConfig.maxLength }">
            {{ preview.title.length }} / {{ titleConfig.maxLength }}
          </span>
          <button class="btn-icon" @click="copy(preview.title, 'Title')" title="Copy title">📋</button>
        </label>
        <input v-model="preview.title" class="input" placeholder="SEO video title — click an option above or edit here" />
      </div>

      <div class="form-group mt-1">
        <label>
          Description
          <span class="char-count" :class="{ 'over-limit': preview.description.length > descConfig.maxChars }">
            {{ preview.description.length }} / {{ descConfig.maxChars }}
          </span>
          <button
            class="btn-icon"
            :title="insertChaptersHint"
            :disabled="insertingChapters"
            @click="insertChapterTimestamps"
          >📑</button>
          <button class="btn-icon" @click="copy(preview.description, 'Description')" title="Copy description">📋</button>
        </label>
        <textarea v-model="preview.description" class="textarea preview-textarea" placeholder="Generated description will appear here" />
      </div>

      <div class="form-group mt-1">
        <label>
          Tags
          <span class="char-count">{{ preview.tags.length }} tags</span>
          <button class="btn-icon" @click="copy(tagsAsString, 'Tags')" title="Copy tags as comma-separated string">📋</button>
        </label>
        <textarea v-model="tagsAsString" class="textarea tags-textarea" :placeholder="tagsPlaceholder" />
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useAppTitle('Metadata Generator')
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put } = useApi()
const { success, error: showError } = useToast()
const { metaGenerating } = useGenerating()

const episodeId = ref('')
const model = ref('gpt-4o')

// v1.0.182 — Phase-2 scaffold. The three section editors collapse behind the
// shared <AdvancedDisclosure>; this key persists the open state per project.
// The component owns the localStorage read/write.
const META_ADV_KEY = `metadata_advanced_open_${slug.value}`

// Source-of-truth gating: every metadata generator (descriptions, titles,
// tags, "Generate All") reads narration context from the script docx, so
// we disable the buttons until episode.status.script flips true. Refetches
// when a script-only job lands so the page enables itself live without a
// reload.
const { selectedEpisode, scriptReady, statusKnown } = useEpisodeStatus(episodeId, slug, {
  refetchOnJobTypes: ['script-only'],
})
const noScriptTooltip = 'Generate the script first to unlock this generator.'
// v1.0.296 — gate copy distinguishes "still checking" from "confirmed missing".
const scriptGateReason = computed(() => {
  if (!episodeId.value || scriptReady.value) return ''
  return statusKnown.value ? noScriptTooltip : 'Checking script status…'
})

// Generating flags (independent per section)
const genTitles = ref(false)
const genDesc = ref(false)
const genTags = ref(false)
const genAll = ref(false)

// v1.0.115+ — per-episode "is a metadata job in flight" computed. The
// existing `genAll` ref stays true through the whole job (waitForJob
// blocks until done), but when the user swaps episodes mid-render it
// kept the new episode's TopActionBar stuck in "Generating metadata for
// [new ep]…" loading state even though the job belongs to the OLD ep.
// Derive from the jobs list instead so the UI reflects whichever
// episode the user is currently looking at.
const { jobs: metaJobs } = useJobs()
const metadataJobActiveForEpisode = computed(() => {
  if (!episodeId.value) return false
  return metaJobs.value.some((j: any) =>
    j.episode_id === episodeId.value &&
    j.project_slug === slug.value &&
    j.type === 'metadata' &&
    (j.status === 'queued' || j.status === 'running'),
  )
})

// v1.0.298 — the button + status must reflect the user's OWN in-flight click
// IMMEDIATELY, not wait for the job to propagate through the SSE/poll stream.
// `genAll` flips true synchronously on click; `metadataJobActiveForEpisode`
// (jobs-derived) covers the "switched away and came back" case. OR them so
// there's never a dead window where a generation is running but nothing shows.
const metadataBusy = computed(() => genAll.value || metadataJobActiveForEpisode.value)

// v1.0.298 — persistent outcome of the last "Generate Metadata" run. The
// transient toast fades in 5s; this stays until the next run or an episode
// switch, so the user always has a durable "did it work?" signal.
const lastGenResult = ref<null | { kind: 'success' | 'error' | 'cancelled'; message: string }>(null)

// Defensive — clear genAll on episode swap. The original waitForJob
// is still tracking the OLD episode's job in the background; this just
// stops it from gating the new episode's UI. Also clear the stale result
// banner — it belonged to the episode we just left.
watch(episodeId, (newEp, oldEp) => {
  if (newEp !== oldEp) {
    genAll.value = false
    lastGenResult.value = null
  }
})

// Section configs
const titleConfig = reactive({
  preset: 'Universal',
  maxLength: 100,
  count: 5,
  includeScriptContext: true,
  /**
   * v1.0.90+: default flipped from 'paraphrase' to 'use_idea_title' so
   * the title the user picked at Ideas Generator time stays the title
   * by default. Paraphrase is now opt-in for the "generate me 5 SEO
   * variants" workflow.
   *
   * 'use_idea_title' (default) — copy the episode's idea title verbatim.
   * 'paraphrase'                — LLM-rewrite into N SEO variants.
   * 'manual'                    — use `manualTitle` verbatim.
   * For the fixed modes (idea / manual) the project's saved channel
   * `prefix` is prepended and `suffix` appended. Fixed modes always
   * emit one title; the count slider applies only to paraphrase.
   */
  mode: 'use_idea_title' as 'paraphrase' | 'use_idea_title' | 'manual',
  /** Channel-level prefix locked in front of every title. Persisted on
   *  the project config so re-running metadata generation uses the same
   *  value without re-typing. */
  prefix: '',
  suffix: '',
  manualTitle: '',
})
const descConfig = reactive({ maxChars: 5000 })
const tagConfig = reactive({ count: 15 })

// v1.0.259 — remember the title settings across reloads. prefix / suffix /
// manualTitle are excluded: prefix+suffix already persist on the project config
// (channel-level), and manualTitle is per-episode content.
useRememberedForm('metadata', slug, titleConfig, {
  include: ['preset', 'maxLength', 'count', 'includeScriptContext', 'mode'],
})
// `model` is a standalone ref bound to <ModelSelector v-model="model">. Bridge
// it through a 1-field reactive so the picked LLM is remembered too; on load we
// push the restored value into the ref once, then mirror ref→memo so later
// picks persist. An invalid restored model self-heals via ModelSelector.
const modelMemo = reactive({ model: model.value })
useRememberedForm('metadata-model', slug, modelMemo, { include: ['model'] })
if (modelMemo.model) model.value = modelMemo.model
watch(model, (m) => { modelMemo.model = m })

// Results / preview
const titleOptions = ref<string[]>([])
const preview = reactive({
  title: '',
  description: '',
  tags: [] as string[],
})
const versions = ref<Array<{ version: number; title: string; title_options?: string[]; description: string; tags: string[]; savedAt: string | null }>>([])
const selectedVersion = ref<number>(1)

// Section builder
interface SectionConfig { [key: string]: any }
interface Section { id: string; label: string; type: 'builtin' | 'custom'; enabled: boolean; config: SectionConfig }

// New section schema (Apr 2026 refactor):
//   - hook       — characters + optional starting_format prefix
//                  (was: number-of-sentences; sentences was too coarse for
//                  YouTube's snippet truncation which is character-based)
//   - narrator   — name (split out from old monolithic 'metadata' section)
//   - music      — title + link + disclaimer (NEW dedicated section)
//   - channels   — array of channels with optional kind=own|recommended
//                  (was: single channel inside 'metadata'; user now wants
//                  to recommend other channels too — same UX as 'videos')
//   - videos     — unchanged
//   - playlists  — unchanged
//   - cta        — subscribe/like only (split out from old conflated 'cta')
//   - support    — array of platforms (Patreon, Ko-fi, BMC, YT Members, custom)
//                  (was: Patreon-only field on the old 'cta' section)
//   - affiliate / ai-disclosure / hashtags — unchanged
//
// Old sections ('metadata', old-shape 'cta') are auto-migrated by the
// `apply` function in usePresets so existing presets transparently upgrade.
// v1.0.198 — format-neutral baseline. The old default had Narrator + Music
// credits ON and sleep-story copy ("…reviewed for quality and warmth"); both
// assumed a sleep-story channel. The page now applies a format-matched starter
// template on a fresh episode (see starterTemplates / applyStarterTemplate),
// so this baseline only shows for the brief pre-mount moment + as the "reset"
// fallback. Narrator/Music/Videos default OFF; copy is channel-neutral.
const NEUTRAL_AI_DISCLOSURE = 'Created with the help of AI tools and reviewed before publishing.'
const defaultSections: Section[] = [
  { id: 'hook', label: 'Hook / Intro Paragraph', type: 'builtin', enabled: true, config: { characters: 220, starting_format: '' } },
  { id: 'narrator', label: 'Narrator Credit', type: 'builtin', enabled: false, config: { name: '' } },
  { id: 'music', label: 'Music Credit', type: 'builtin', enabled: false, config: { title: '', link: '', disclaimer: 'Music used with permission. See link above for full credit.' } },
  { id: 'channels', label: 'Channel Mentions', type: 'builtin', enabled: false, config: { channels: [{ name: '', url: '', kind: 'own' as 'own' | 'recommended' }] } },
  { id: 'videos', label: 'Video Recommendations', type: 'builtin', enabled: false, config: { videos: [{ name: '', url: '' }] } },
  { id: 'playlists', label: 'Playlists', type: 'builtin', enabled: false, config: { playlists: [{ name: '', url: '' }] } },
  { id: 'cta', label: 'Subscribe / Like CTA', type: 'builtin', enabled: true, config: { custom_lines: [] as string[] } },
  { id: 'support', label: 'Support / Membership', type: 'builtin', enabled: false, config: { platforms: [] as Array<{ kind: string; url: string; label?: string }> } },
  { id: 'affiliate', label: 'Affiliate Disclaimer', type: 'builtin', enabled: false, config: { text: 'As an Amazon Associate we earn from qualifying purchases.' } },
  { id: 'ai-disclosure', label: 'AI Disclosure', type: 'builtin', enabled: true, config: { text: NEUTRAL_AI_DISCLOSURE } },
  { id: 'hashtags', label: 'Hashtags (inside description)', type: 'builtin', enabled: true, config: { count: 15 } },
]

/**
 * Migrate a sections[] array from the pre-Apr-2026 schema to the new
 * shape. Idempotent: running on already-new sections is a no-op.
 *
 * Mappings:
 *   hook { sentences } → hook { characters: sentences * 80, starting_format: '' }
 *     (~80 chars per sentence is a reasonable rule of thumb for prose;
 *      keeps the user's existing length intent even though the unit
 *      changed)
 *   metadata { narrator_*, music, channel_* } → split into narrator + music + channels
 *   cta { patreon_url, custom_text } → split into cta + support
 *
 * Returns { migrated, didMigrate } so the caller can show a one-time
 * toast when something actually changed.
 */
function migrateSections(input: Section[]): { migrated: Section[]; didMigrate: boolean } {
  let didMigrate = false
  const out: Section[] = []
  let injectedNarrator = false, injectedMusic = false, injectedChannels = false, injectedSupport = false

  for (const s of input) {
    // Old monolithic metadata section → split
    if (s.id === 'metadata') {
      didMigrate = true
      const cfg = s.config || {}
      out.push({ id: 'narrator', label: 'Narrator Credit', type: 'builtin', enabled: cfg.narrator_enabled !== false, config: { name: cfg.narrator_name || '' } })
      out.push({ id: 'music', label: 'Music Credit', type: 'builtin', enabled: !!cfg.music, config: { title: '', link: '', disclaimer: 'Music used with permission. See link above for full credit.' } })
      out.push({
        id: 'channels', label: 'Channel Mentions', type: 'builtin',
        enabled: cfg.channel_enabled !== false,
        config: {
          channels: cfg.channel_name
            ? [{ name: cfg.channel_name, url: '', kind: 'own' }]
            : [{ name: '', url: '', kind: 'own' }],
        },
      })
      injectedNarrator = injectedMusic = injectedChannels = true
      continue
    }

    // Old cta with patreon_url → split into cta + support
    if (s.id === 'cta' && s.config && ('patreon_url' in s.config || 'custom_text' in s.config)) {
      didMigrate = true
      const cfg = s.config || {}
      out.push({
        id: 'cta', label: 'Subscribe / Like CTA', type: 'builtin', enabled: s.enabled,
        config: { custom_lines: cfg.custom_text ? [cfg.custom_text] : [] },
      })
      out.push({
        id: 'support', label: 'Support / Membership', type: 'builtin', enabled: s.enabled,
        config: {
          platforms: cfg.patreon_url
            ? [{ kind: 'patreon', url: cfg.patreon_url }]
            : [],
        },
      })
      injectedSupport = true
      continue
    }

    // hook { sentences } → hook { characters }
    if (s.id === 'hook' && s.config && 'sentences' in s.config && !('characters' in s.config)) {
      didMigrate = true
      const sentences = Number(s.config.sentences) || 3
      out.push({
        ...s,
        config: { characters: Math.max(120, Math.min(500, sentences * 80)), starting_format: '' },
      })
      continue
    }

    out.push(s)
  }

  // If presets were saved before the new sections existed, inject defaults
  // for any new section the migration didn't already produce. Order is
  // best-effort — user can drag to reorder.
  const have = new Set(out.map(s => s.id))
  if (!have.has('narrator') && !injectedNarrator) {
    out.push({ id: 'narrator', label: 'Narrator Credit', type: 'builtin', enabled: false, config: { name: '' } })
    didMigrate = true
  }
  if (!have.has('music') && !injectedMusic) {
    out.push({ id: 'music', label: 'Music Credit', type: 'builtin', enabled: false, config: { title: '', link: '', disclaimer: 'Music used with permission. See link above for full credit.' } })
    didMigrate = true
  }
  if (!have.has('channels') && !injectedChannels) {
    out.push({ id: 'channels', label: 'Channel Mentions', type: 'builtin', enabled: false, config: { channels: [{ name: '', url: '', kind: 'own' }] } })
    didMigrate = true
  }
  if (!have.has('support') && !injectedSupport) {
    out.push({ id: 'support', label: 'Support / Membership', type: 'builtin', enabled: false, config: { platforms: [] } })
    didMigrate = true
  }

  return { migrated: out, didMigrate }
}

const sections = ref<Section[]>(JSON.parse(JSON.stringify(defaultSections)))

// ── v1.0.198 — format-neutral starter templates ────────────────────────────
// Replace the one-size-fits-all (sleep-story) default with use-case starters.
// On a fresh episode the page applies the one matching the project's format;
// the picker lets the user switch. Each builds an ordered section list.
function sec(id: string, label: string, enabled: boolean, config: SectionConfig = {}): Section {
  return { id, label, type: 'builtin', enabled, config }
}
function tplPov(): Section[] {
  return [
    sec('hook', 'Hook / Intro Paragraph', true, { characters: 220, starting_format: '' }),
    sec('cta', 'Subscribe / Like CTA', true, { custom_lines: [] }),
    sec('channels', 'Channel Mentions', false, { channels: [{ name: '', url: '', kind: 'own' }] }),
    sec('support', 'Support / Membership', true, { platforms: [] }),
    sec('ai-disclosure', 'AI Disclosure', true, { text: NEUTRAL_AI_DISCLOSURE }),
    sec('hashtags', 'Hashtags (inside description)', true, { count: 15 }),
  ]
}
function tplExplainer(): Section[] {
  return [
    sec('hook', 'Hook / Intro Paragraph', true, { characters: 250, starting_format: '' }),
    sec('sources', '📚 Sources', true, {}),
    sec('cta', 'Subscribe / Like CTA', true, { custom_lines: [] }),
    sec('ai-disclosure', 'AI Disclosure', true, { text: NEUTRAL_AI_DISCLOSURE }),
    sec('hashtags', 'Hashtags (inside description)', true, { count: 15 }),
  ]
}
function tplListicle(): Section[] {
  return [
    sec('hook', 'Hook / Intro Paragraph', true, { characters: 200, starting_format: '' }),
    sec('cta', 'Subscribe / Like CTA', true, { custom_lines: [] }),
    sec('hashtags', 'Hashtags (inside description)', true, { count: 20 }),
  ]
}
function tplMinimal(): Section[] {
  return [
    sec('hook', 'Hook / Intro Paragraph', true, { characters: 150, starting_format: '' }),
    sec('hashtags', 'Hashtags (inside description)', true, { count: 12 }),
  ]
}
interface StarterTemplate { id: string; label: string; description: string; build: () => Section[] }
const starterTemplates: StarterTemplate[] = [
  { id: 'pov',       label: 'POV Creator',                   description: 'First-person creator channel — hook, CTA, support, links. No narrator/music credit.', build: tplPov },
  { id: 'explainer', label: 'Faceless Explainer / Documentary', description: 'Fact-checked explainer — includes a 📚 Sources section for your research citations.', build: tplExplainer },
  { id: 'listicle',  label: 'Listicle / Top-N',              description: 'Numbered-list videos — punchy hook, tag-heavy.', build: tplListicle },
  { id: 'minimal',   label: 'Minimal',                       description: 'Just a short hook + hashtags. Nothing else.', build: tplMinimal },
]
function templateIdForFormat(formatId: string): string {
  switch (formatId) {
    case 'continuity-chain': return 'pov'
    case 'scenes':           return 'explainer'
    case 'listicle':         return 'listicle'
    // legacy ids (pre-v1.0.280) — kept so old projects map correctly
    case 'narration-synced':
    case 'narrated-scenes':
    case 'narrative':        return 'explainer'
    default:                 return 'minimal'
  }
}
// ── v1.0.199 — section catalog (mirrors the backend registry) ──────────────
// The list of addable section types + their default config. The "Add section"
// menu reads this, so any built-in section composes onto any template, and a
// future simple type is one catalog entry (with `generic` + `fields` it needs
// no bespoke editor — rendered by the generic editor block below).
interface CatalogField { key: string; label: string; type: 'text' | 'number' | 'textarea' }
interface CatalogEntry { id: string; label: string; defaultConfig: () => SectionConfig; generic?: boolean; fields?: CatalogField[] }
const SECTION_CATALOG: CatalogEntry[] = [
  { id: 'hook',          label: 'Hook / Intro Paragraph',        defaultConfig: () => ({ characters: 220, starting_format: '' }) },
  { id: 'narrator',      label: 'Narrator Credit',               defaultConfig: () => ({ name: '' }) },
  { id: 'music',         label: 'Music Credit',                  defaultConfig: () => ({ title: '', link: '', disclaimer: 'Music used with permission. See link above for full credit.' }) },
  { id: 'channels',      label: 'Channel Mentions',              defaultConfig: () => ({ channels: [{ name: '', url: '', kind: 'own' }] }) },
  { id: 'videos',        label: 'Video Recommendations',         defaultConfig: () => ({ videos: [{ name: '', url: '' }] }) },
  { id: 'playlists',     label: 'Playlists',                     defaultConfig: () => ({ playlists: [{ name: '', url: '' }] }) },
  { id: 'sources',       label: '📚 Sources',                    defaultConfig: () => ({}) },
  { id: 'cta',           label: 'Subscribe / Like CTA',          defaultConfig: () => ({ custom_lines: [] }) },
  { id: 'support',       label: 'Support / Membership',          defaultConfig: () => ({ platforms: [] }) },
  { id: 'affiliate',     label: 'Affiliate Disclaimer',          defaultConfig: () => ({ text: 'As an Amazon Associate we earn from qualifying purchases.' }) },
  { id: 'ai-disclosure', label: 'AI Disclosure',                 defaultConfig: () => ({ text: NEUTRAL_AI_DISCLOSURE }) },
  { id: 'hashtags',      label: 'Hashtags (inside description)',  defaultConfig: () => ({ count: 15 }) },
]
const catalogById = (id: string) => SECTION_CATALOG.find(c => c.id === id)
// Section types not already in the current list — offered in the Add menu.
const addableSections = computed(() => SECTION_CATALOG.filter(c => !sections.value.some(s => s.id === c.id)))
function addSection(id: string): void {
  const c = catalogById(id)
  if (!c || sections.value.some(s => s.id === id)) return
  sections.value.push({ id: c.id, label: c.label, type: 'builtin', enabled: true, config: c.defaultConfig() })
}
function onAddSection(e: Event): void {
  const el = e.target as HTMLSelectElement
  if (el.value) addSection(el.value)
  el.value = ''
}
// Generic-editor support: a catalog type flagged `generic` renders its fields
// from the registry, so a new simple section type needs no bespoke editor.
function genericFieldsFor(id: string): CatalogField[] {
  const c = catalogById(id)
  return c?.generic ? (c.fields || []) : []
}

const activeTemplateId = ref<string>('')
function applyStarterTemplate(tplId: string, opts: { silent?: boolean } = {}): void {
  const tpl = starterTemplates.find(t => t.id === tplId)
  if (!tpl) return
  // Manual apply replaces the current sections — confirm so accidental clicks
  // don't wipe a configured description. Auto-apply on mount passes silent.
  if (!opts.silent && activeTemplateId.value && activeTemplateId.value !== tplId) {
    if (!confirm(`Apply the "${tpl.label}" starter template? This replaces the current description sections (your saved presets are untouched).`)) return
  }
  sections.value = tpl.build()
  activeTemplateId.value = tplId
}

// v1.0.200 (M2) — re-apply the format-matched starter template (a clean reset
// after experimenting), reading the format's declared default.
async function resetToFormatDefault(): Promise<void> {
  let tplId = 'minimal'
  try {
    const f = await get<any>(`/projects/${slug.value}/effective-format`)
    const declared = f?.metadata?.defaultStarterTemplate
    tplId = (typeof declared === 'string' && starterTemplates.some(t => t.id === declared))
      ? declared
      : templateIdForFormat(f?.id || '')
  } catch { /* fall back to minimal */ }
  applyStarterTemplate(tplId)
}

// v1.0.200 (M3) — live section outline: the enabled sections in render order,
// shown as a strip so you see the description's shape before generating.
const enabledSectionLabels = computed(() => sections.value.filter(s => s.enabled).map(s => s.label))

// ── v1.0.198 (M1b) — Sources section: the episode's research citations ──────
// Mirrors the Research page's per-source include picks (source of truth is
// research.json). Editing here persists straight back so both pages agree.
interface SrcCitation { title: string; url: string; snippet?: string; include_in_description?: boolean }
const researchCitations = ref<SrcCitation[]>([])
const researchClaims = ref<Array<{ status: string; citation_indices: number[] }>>([])
const researchLoaded = ref(false)
const savingResearch = ref(false)

async function loadResearchForSources(): Promise<void> {
  researchCitations.value = []
  researchClaims.value = []
  researchLoaded.value = false
  if (!episodeId.value) return
  try {
    const r = await get<{ exists: boolean; research?: any }>(`/projects/${slug.value}/research/${episodeId.value}`)
    if (r.exists && r.research) {
      researchCitations.value = r.research.citations || []
      researchClaims.value = r.research.claims || []
      researchLoaded.value = true
    }
  } catch { /* no research for this episode — section shows the hint */ }
}

function srcIncluded(c: SrcCitation): boolean { return c.include_in_description !== false }
const verifiedBackingSet = computed(() => {
  const s = new Set<number>()
  for (const cl of researchClaims.value) {
    if (cl.status === 'verified') for (const i of cl.citation_indices || []) s.add(i)
  }
  return s
})
const includedSrcPreview = computed(() => researchCitations.value.filter(c => c.url && srcIncluded(c)))

async function persistResearchIncludes(): Promise<void> {
  if (!episodeId.value || !researchLoaded.value) return
  savingResearch.value = true
  try {
    // Re-read then patch only the include flags so we never clobber the
    // claims/edits the Research page owns.
    const r = await get<{ exists: boolean; research?: any }>(`/projects/${slug.value}/research/${episodeId.value}`)
    if (!r.exists || !r.research) return
    const fresh = r.research
    fresh.citations = (fresh.citations || []).map((c: any, i: number) => ({
      ...c,
      include_in_description: researchCitations.value[i]?.include_in_description,
    }))
    await put(`/projects/${slug.value}/research/${episodeId.value}`, fresh)
  } catch { /* best-effort — the picks still apply for this session */ } finally {
    savingResearch.value = false
  }
}
async function setSrcIncluded(c: SrcCitation, val: boolean): Promise<void> {
  c.include_in_description = val
  await persistResearchIncludes()
}
async function bulkSrc(mode: 'all' | 'verified' | 'none'): Promise<void> {
  researchCitations.value.forEach((c, i) => {
    c.include_in_description = mode === 'all' ? true : mode === 'none' ? false : verifiedBackingSet.value.has(i)
  })
  await persistResearchIncludes()
}

// ── Unified preset wiring ──────────────────────────────────────────────────
// Swapped off the custom youtube_templates schema onto the same usePresets
// composable every other generator page uses. One-time migration below
// converts pre-existing youtube_templates into the unified preset store
// so the user never loses their saved layouts.
interface MetadataPresetSnapshot {
  sections: Section[]
  /** Shared LLM used by title, description, and tag generation. */
  model?: string
  /**
   * Title-generation config. Persisted alongside sections so picking a
   * preset restores BOTH the description layout AND the title strategy
   * (eg "Use idea title + cozy-sleep suffix"). Optional in the snapshot
   * shape so older presets without this field still apply cleanly.
   */
  titleConfig?: {
    preset?: string
    maxLength?: number
    count?: number
    includeScriptContext?: boolean
    mode?: 'paraphrase' | 'use_idea_title' | 'manual'
    /** Channel-level title prefix locked across every episode (v1.0.90+). */
    prefix?: string
    suffix?: string
    manualTitle?: string
  }
}

const metadataPresets = usePresets<MetadataPresetSnapshot>({
  slug: slug.value,
  configKey: 'metadata',
  snapshot: () => ({
    sections: JSON.parse(JSON.stringify(sections.value)),
    model: model.value,
    titleConfig: {
      preset: titleConfig.preset,
      maxLength: titleConfig.maxLength,
      count: titleConfig.count,
      includeScriptContext: titleConfig.includeScriptContext,
      mode: titleConfig.mode,
      prefix: titleConfig.prefix,
      suffix: titleConfig.suffix,
      manualTitle: titleConfig.manualTitle,
    },
  }),
  apply: (data) => {
    if (!data?.sections) return
    // Run the schema migration before assigning. This handles any preset
    // saved before the Apr 2026 section split (old `metadata` /
    // `cta`-with-patreon shape) so the user's existing presets stay
    // usable without manual re-creation. The flag below ensures the
    // info toast fires once per migrated preset (keyed in localStorage).
    const { migrated, didMigrate } = migrateSections(JSON.parse(JSON.stringify(data.sections)))
    sections.value = migrated
    if (typeof data.model === 'string' && data.model.trim()) {
      model.value = data.model
    }
    // Apply titleConfig if the preset has it (older presets won't —
    // leave the user's current settings alone in that case).
    const tc = data.titleConfig
    if (tc) {
      if (tc.preset !== undefined) titleConfig.preset = tc.preset
      if (typeof tc.maxLength === 'number') titleConfig.maxLength = tc.maxLength
      if (typeof tc.count === 'number') titleConfig.count = tc.count
      if (typeof tc.includeScriptContext === 'boolean') titleConfig.includeScriptContext = tc.includeScriptContext
      if (tc.mode === 'paraphrase' || tc.mode === 'use_idea_title' || tc.mode === 'manual') {
        titleConfig.mode = tc.mode
      }
      if (typeof tc.prefix === 'string') titleConfig.prefix = tc.prefix
      if (typeof tc.suffix === 'string') titleConfig.suffix = tc.suffix
      if (typeof tc.manualTitle === 'string') titleConfig.manualTitle = tc.manualTitle
    }
    if (didMigrate) {
      const presetId = metadataPresets.activeId.value || 'unknown'
      const flagKey = `metadata-migration-toast-shown:${slug.value}:${presetId}`
      if (typeof window !== 'undefined' && !window.localStorage.getItem(flagKey)) {
        // Defer the toast so it shows AFTER the page mounts (calling
        // success() during component setup can be swallowed by Toast's
        // mount guard).
        nextTick(() => success('Your metadata preset was upgraded — review the new sections.'))
        try { window.localStorage.setItem(flagKey, '1') } catch { /* localStorage disabled — fine */ }
      }
    }
  },
})

// ── Computed ───────────────────────────────────────────────────────────────

// Live preview of the final title for fixed modes — what the generator
// will return (idea or manual title + optional suffix). Helps the user
// verify the suffix lands where they expect before they click Generate.
const titlePreviewText = computed(() => {
  if (titleConfig.mode === 'paraphrase') return ''
  const base = titleConfig.mode === 'manual'
    ? (titleConfig.manualTitle || '').trim()
    : (selectedEpisode.value?.title || '').trim()
  if (!base) {
    return titleConfig.mode === 'manual'
      ? '(type your title above)'
      : '(no episode selected)'
  }
  return (titleConfig.prefix || '') + base + (titleConfig.suffix || '')
})

const tagsAsString = computed({
  get: () => preview.tags.join(', '),
  set: (val: string) => { preview.tags = val.split(',').map(t => t.trim()).filter(Boolean) },
})

const nextVersionNumber = computed(() => {
  if (!versions.value.length) return 1
  return Math.max(...versions.value.map(v => v.version)) + 1
})

// ── Preset handling ────────────────────────────────────────────────────────

const PRESET_LIMITS: Record<string, number> = {
  YouTube: 100,
  TikTok: 100,
  Facebook: 255,
  Universal: 100,
}
function onTitlePresetChange() {
  if (titleConfig.preset !== 'custom' && PRESET_LIMITS[titleConfig.preset]) {
    titleConfig.maxLength = PRESET_LIMITS[titleConfig.preset]!
  }
}

// ── Section reorder ────────────────────────────────────────────────────────

function moveSection(i: number, dir: number) {
  const j = i + dir
  if (j < 0 || j >= sections.value.length) return
  const a = sections.value[i]
  const b = sections.value[j]
  if (!a || !b) return
  sections.value[i] = b
  sections.value[j] = a
}
function addCustomBlock() {
  sections.value.push({ id: `custom-${Date.now()}`, label: 'Custom Section', type: 'custom', enabled: true, config: { instructions: '' } })
}

// ── HTML5 Drag & Drop ──────────────────────────────────────────────────────

const dragIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)

function onDragStart(i: number, ev: DragEvent) {
  dragIndex.value = i
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move'
    ev.dataTransfer.setData('text/plain', String(i))
  }
}
function onDragOver(i: number) {
  if (dragIndex.value === null || dragIndex.value === i) return
  dragOverIndex.value = i
}
function onDragLeave() { dragOverIndex.value = null }
function onDrop(i: number) {
  const from = dragIndex.value
  if (from === null || from === i) { onDragEnd(); return }
  const moved = sections.value.splice(from, 1)[0]
  if (moved) sections.value.splice(i, 0, moved)
  onDragEnd()
}
function onDragEnd() {
  dragIndex.value = null
  dragOverIndex.value = null
}

// ── Episode selection + preview load ──────────────────────────────────────

// Synchronous fast-path: drop the EpisodeSelector's payload straight into
// `selectedEpisode` so loadExistingMetadata (triggered by the episodeId
// watch) can read the title immediately. The useEpisodeStatus composable
// will subsequently refetch and overwrite with the API row that carries
// status.* — same data, just guaranteed-fresh.
function onEpisodeSelected(ep: any) {
  selectedEpisode.value = ep
}

async function loadExistingMetadata() {
  if (!episodeId.value) return
  try {
    const title = selectedEpisode.value?.title || ''
    const data = await get<{ versions: typeof versions.value }>(
      `/projects/${slug.value}/episodes/${episodeId.value}/metadata?title=${encodeURIComponent(title)}`
    )
    versions.value = data.versions || []
    if (versions.value.length) {
      const latest = versions.value[versions.value.length - 1]!
      selectedVersion.value = latest.version
      applyVersion(latest)
    } else {
      selectedVersion.value = 1
      preview.title = ''
      preview.description = ''
      preview.tags = []
    }
  } catch {
    versions.value = []
  }
}

function applyVersion(v: { title: string; title_options?: string[]; description: string; tags: string[] }) {
  preview.title = v.title || ''
  preview.description = v.description || ''
  preview.tags = Array.isArray(v.tags) ? [...v.tags] : []
  // Restore the AI-generated title alternatives if the saved version
  // includes them (pipeline runs always do; on-page runs do too if the
  // user hasn't cleared them). Lets the user pick a different title
  // later without re-running generation.
  if (Array.isArray(v.title_options) && v.title_options.length) {
    titleOptions.value = [...v.title_options]
  }
}

function loadVersion() {
  const v = versions.value.find(x => x.version === selectedVersion.value)
  if (v) suppressAutoSaveDuring(() => applyVersion(v))
}

// ── Generation ─────────────────────────────────────────────────────────────

async function generateTitles() {
  if (!episodeId.value) return
  genTitles.value = true
  metaGenerating.value = true
  try {
    const data = await post<{ titles: string[] }>(`/projects/${slug.value}/generate/metadata/seo-titles`, {
      episode_id: episodeId.value,
      title: selectedEpisode.value?.title || '',
      model: model.value,
      count: titleConfig.count,
      max_length: titleConfig.maxLength,
      platform_preset: titleConfig.preset,
      include_script_context: titleConfig.includeScriptContext,
      title_mode: titleConfig.mode,
      title_prefix: titleConfig.prefix,
      title_suffix: titleConfig.suffix,
      manual_title: titleConfig.manualTitle,
    })
    titleOptions.value = data.titles
    if (!preview.title && data.titles[0]) preview.title = data.titles[0]
    success(`Generated ${data.titles.length} title options`)
  } catch (e: any) {
    console.error('[metadata] generate titles failed:', e)
    showError(e.data?.detail || `Failed to generate titles (model=${model.value}). Check that the model's API key is set in Settings.`)
  } finally {
    genTitles.value = false
    metaGenerating.value = false
  }
}

async function generateDescription() {
  if (!episodeId.value) return
  genDesc.value = true
  metaGenerating.value = true
  try {
    const data = await post<{ description: string }>(`/projects/${slug.value}/generate/metadata/description`, {
      episode_id: episodeId.value,
      title: selectedEpisode.value?.title || '',
      model: model.value,
      sections: sections.value.filter(s => s.enabled),
      max_chars: descConfig.maxChars,
    })
    preview.description = data.description
    success('Description generated')
  } catch (e: any) {
    console.error('[metadata] generate description failed:', e)
    showError(e.data?.detail || `Failed to generate description (model=${model.value}). Check that the model's API key is set in Settings.`)
  } finally {
    genDesc.value = false
    metaGenerating.value = false
  }
}

async function generateTags() {
  if (!episodeId.value) return
  genTags.value = true
  metaGenerating.value = true
  try {
    const data = await post<{ tags: string[] }>(`/projects/${slug.value}/generate/metadata/tags`, {
      episode_id: episodeId.value,
      title: selectedEpisode.value?.title || '',
      description: preview.description,
      model: model.value,
      count: tagConfig.count,
    })
    preview.tags = data.tags
    success(`Generated ${data.tags.length} tags`)
  } catch (e: any) {
    console.error('[metadata] generate tags failed:', e)
    showError(e.data?.detail || `Failed to generate tags (model=${model.value}). Check that the model's API key is set in Settings.`)
  } finally {
    genTags.value = false
    metaGenerating.value = false
  }
}

async function generateAll() {
  if (!episodeId.value) return
  // Capture the episode the user kicked off — if they switch mid-job we want
  // to apply the on-disk result to the ORIGINAL episode, not whatever they
  // navigated to. The EpisodeSelector confirm dialog already prompts the
  // user before the swap (it sees the queued/running 'metadata' job), but
  // they're still allowed to switch on confirm.
  const startedEpisodeId = episodeId.value
  const startedTitle = selectedEpisode.value?.title || ''
  genAll.value = true
  metaGenerating.value = true
  lastGenResult.value = null   // clear any prior outcome while this run is live
  try {
    // Queue via the job queue (parallel to /generate/script-only,
    // /generate/audio, etc.) so navigating away no longer cancels the
    // perceived work — the executor keeps running, writes the metadata
    // sidecar on completion, and useJobs() streams status updates.
    const job = await post<{ job_id: string }>(
      `/projects/${slug.value}/generate/metadata`,
      {
        episode_id: startedEpisodeId,
        title: startedTitle,
        model: model.value,
        sections: sections.value.filter(s => s.enabled),
        max_chars: descConfig.maxChars,
        title_count: titleConfig.count,
        title_max_length: titleConfig.maxLength,
        title_platform_preset: titleConfig.preset,
        title_mode: titleConfig.mode,
        title_prefix: titleConfig.prefix,
        title_suffix: titleConfig.suffix,
        manual_title: titleConfig.manualTitle,
        tag_count: tagConfig.count,
      }
    )
    success(`Queued — job ${job.job_id}. You can switch episodes; we'll keep generating in the background.`)
    const completed = await waitForJob(job.job_id)
    if (completed.status === 'cancelled') {
      lastGenResult.value = { kind: 'cancelled', message: `Metadata generation cancelled for ${startedEpisodeId}.` }
      showError('Metadata generation cancelled')
      return
    }
    if (completed.status === 'error') {
      throw new Error(completed.error || `Metadata generation failed (model=${model.value}). Check the Jobs panel for details.`)
    }
    // Job done — re-load the latest version from disk. If the user is still
    // looking at the same episode they kicked off, refresh the preview;
    // otherwise just leave their current view alone (the new version is on
    // disk and they'll see it when they navigate back).
    if (episodeId.value === startedEpisodeId) {
      sessionVersion.value = null
      await suppressAutoSaveDuring(() => loadExistingMetadata())
      lastGenResult.value = { kind: 'success', message: `Metadata generated for ${startedEpisodeId} — latest version applied below.` }
      success('All metadata generated — latest version applied.')
    } else {
      lastGenResult.value = { kind: 'success', message: `Metadata generated for ${startedEpisodeId} — switch back to that episode to view it.` }
      success(`Metadata for ${startedEpisodeId} generated — switch back to view.`)
    }
  } catch (e: any) {
    console.error('[metadata] generate all failed:', e)
    const msg = e.data?.detail || e?.message || `Failed to generate metadata (model=${model.value}). Check the Jobs panel for details.`
    lastGenResult.value = { kind: 'error', message: msg }
    showError(msg)
  } finally {
    genAll.value = false
    metaGenerating.value = false
  }
}

// Poll a single job until it reaches a terminal state. Same pattern the
// ImageGeneratorPanel uses — useJobs() also streams updates globally, but a
// direct poll is the simplest way to await one specific job.
const JOB_POLL_INTERVAL_MS = 1500
async function waitForJob(jobId: string): Promise<any> {
  while (true) {
    const job: any = await get(`/projects/${slug.value}/jobs/${jobId}`)
    if (job?.status === 'done' || job?.status === 'error' || job?.status === 'cancelled') return job
    await new Promise(r => setTimeout(r, JOB_POLL_INTERVAL_MS))
  }
}

// ── Save ───────────────────────────────────────────────────────────────────

// Manual escape hatch: snapshot current edits as a fresh version on disk
// even mid-session. After forking, the autosave session adopts that new
// version so further keystrokes accumulate into it.
async function forkToNewVersion() {
  sessionVersion.value = null
  await autoSave.flush()
}

// ── Copy helpers ───────────────────────────────────────────────────────────

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    success(`${label} copied`)
  } catch {
    showError('Copy failed')
  }
}

const insertingChapters = ref(false)
const insertChaptersHint = computed(() =>
  insertingChapters.value
    ? 'Loading chapter timestamps…'
    : 'Insert YouTube chapter timestamps from this episode’s audio durations',
)

/**
 * Pull chapter durations from the episode's audio assets and prepend a
 * formatted "0:00 Intro / 4:32 Chapter 1 / …" block to the description.
 * Skipped when fewer than 3 chapters (YouTube needs 3+ to render the
 * clickable chapter UI) — surfaces a friendly toast instead.
 *
 * Already-prepended blocks are detected by a sentinel comment so a
 * second click doesn't stack duplicates; we replace the existing block
 * in place.
 */
async function insertChapterTimestamps() {
  if (!episodeId.value) {
    showError('Pick an episode first.')
    return
  }
  insertingChapters.value = true
  try {
    const title = (selectedEpisode.value?.title || '').trim()
    const params = new URLSearchParams({ title })
    const r = await get<{ formatted: string; chapters: any[]; reason?: string }>(
      `/projects/${slug.value}/episodes/${encodeURIComponent(episodeId.value)}/chapter-timestamps?${params}`,
    )
    if (!r.formatted) {
      const detail = r.reason === 'fewer-than-3-chapters'
        ? 'Need at least 3 chapter audio files for YouTube to render the chapter UI.'
        : 'No chapter audio found for this episode.'
      showError(detail)
      return
    }
    const SENTINEL_BEGIN = '<!-- chapters:start -->'
    const SENTINEL_END = '<!-- chapters:end -->'
    const block = `${SENTINEL_BEGIN}\n${r.formatted}\n${SENTINEL_END}`
    const current = preview.description || ''
    if (current.includes(SENTINEL_BEGIN) && current.includes(SENTINEL_END)) {
      // Replace the existing block in place — preserves user-edited
      // content surrounding it.
      preview.description = current.replace(
        new RegExp(`${SENTINEL_BEGIN}[\\s\\S]*?${SENTINEL_END}`),
        block,
      )
      success('Chapters refreshed')
    } else {
      preview.description = `${block}\n\n${current}`.trim()
      success(`Inserted ${r.chapters.length} chapters`)
    }
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to load chapter timestamps')
  } finally {
    insertingChapters.value = false
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

// ── One-time migration + preset load ───────────────────────────────────────
// If this project still carries the legacy `youtube_templates` config key
// and has no `metadata_presets` yet, convert once and persist under the new
// keys so `usePresets` can take over. Old keys are left in place as a
// safety net — removed in a later release.
async function migrateLegacyMetadataTemplates() {
  try {
    const config = await get<any>(`/projects/${slug.value}/settings/config`)
    const alreadyMigrated = Array.isArray(config.metadata_presets) && config.metadata_presets.length
    const hasLegacy = Array.isArray(config.youtube_templates) && config.youtube_templates.length
    if (alreadyMigrated || !hasLegacy) return

    // Legacy shape: { id, name, sections? }. New shape: { id, name, data: { sections } }.
    const migrated = config.youtube_templates
      .filter((t: any) => t && t.id && t.name)
      .map((t: any) => ({
        id: t.id,
        name: t.name,
        data: { sections: Array.isArray(t.sections) ? t.sections : [] },
      }))

    await put(`/projects/${slug.value}/settings/config`, {
      metadata_presets: migrated,
      metadata_last_preset: config.youtube_last_template || (migrated[0]?.id ?? ''),
    })
  } catch {
    // Migration failures are non-fatal — user can still use the defaults and
    // save new presets from scratch.
  }
}

// ── Auto-save (debounced, true autosave with silent versioning) ────────────
//
// Behaviour: the FIRST debounced save in an editing "session" creates a new
// version on disk. All subsequent saves in the same session overwrite that
// version in place. A new session starts when the episode changes, a
// different version is loaded, or generation runs (any of which calls
// `resetAutoSaveSession`). This keeps version history meaningful — one
// version per editing session — instead of one version per keystroke.

const sessionVersion = ref<number | null>(null)

function resetAutoSaveSession() {
  sessionVersion.value = null
  autoSave.reset()
}

const autoSave = useAutoSave({
  debounceMs: 800,
  save: async () => {
    if (!episodeId.value) return
    // Skip if there's nothing meaningful to persist yet
    if (!preview.title && !preview.description && !preview.tags.length) return
    const writingTo = sessionVersion.value
    const data = await post<{ version: number }>(`/projects/${slug.value}/generate/metadata/save`, {
      episode_id: episodeId.value,
      title: selectedEpisode.value?.title || '',
      metadata_title: preview.title,
      // Round-trip the AI-generated title alternatives so an overwrite save
      // doesn't wipe the alternates the pipeline saved. The backend defaults
      // to a single-entry list if we don't send anything.
      title_options: titleOptions.value,
      description: preview.description,
      tags: preview.tags,
      // First save in a session → new version. Re-saves in the same session
      // overwrite the version we just created so a paragraph of typing
      // doesn't fan out to v7..v12 silently.
      save_mode: writingTo == null ? 'new' : 'overwrite',
      version: writingTo ?? undefined,
    })
    sessionVersion.value = data.version
    // Refresh the version dropdown without re-triggering autosave.
    await suppressAutoSaveDuring(() => loadExistingMetadata())
    selectedVersion.value = data.version
  },
})

let suppressAutoSave = false

async function suppressAutoSaveDuring<T>(fn: () => Promise<T> | T): Promise<T> {
  suppressAutoSave = true
  try { return await fn() } finally {
    // Release on next tick so the watchers triggered by the operation don't fire saves
    await nextTick()
    suppressAutoSave = false
  }
}

watch([() => preview.title, () => preview.description, () => preview.tags], () => {
  if (suppressAutoSave) return
  autoSave.scheduleSave()
}, { deep: true })

// ── Watchers ───────────────────────────────────────────────────────────────

watch(episodeId, async () => {
  await suppressAutoSaveDuring(() => loadExistingMetadata())
  resetAutoSaveSession()
  void loadResearchForSources()
})

// Loading a different version explicitly should also start a new editing
// session, otherwise autosave would silently overwrite the version the
// user just opened with their next keystroke.
watch(selectedVersion, () => {
  sessionVersion.value = null
})

// ── YouTube-playlist picker for the Playlists section ────────────────────
// The Playlists metadata section used to be manual {name, url} inputs the
// user filled by copy-pasting links from YouTube. This dropdown pulls the
// channel's actual playlists via the same /upload/playlists endpoint the
// Upload Center uses, so the user can pick one and we prefill name + URL.
// Errors are non-fatal — if the call fails the manual inputs still work.
interface ChannelPlaylist {
  id: string
  title: string
  itemCount?: number
}
const availablePlaylists = ref<ChannelPlaylist[]>([])
const playlistsLoading = ref(false)
const playlistsError = ref('')

async function loadAvailablePlaylists(forceRefresh = false) {
  playlistsLoading.value = true
  playlistsError.value = ''
  try {
    // Backend route: /projects/:slug/upload/playlists?force=1
    const r = await get<{ playlists: ChannelPlaylist[] }>(
      `/projects/${slug.value}/upload/playlists${forceRefresh ? '?force=1' : ''}`,
    )
    availablePlaylists.value = Array.isArray(r?.playlists) ? r.playlists : []
  } catch (e: any) {
    // Most common reason: no YouTube account connected on this project,
    // or quota exceeded. Either way the user can still paste URLs.
    playlistsError.value = e?.data?.detail || e?.message || 'unknown'
    availablePlaylists.value = []
  } finally {
    playlistsLoading.value = false
  }
}

function addPlaylistFromChannel(playlistId: string) {
  if (!playlistId) return
  const pl = availablePlaylists.value.find(p => p.id === playlistId)
  if (!pl) return
  const url = `https://youtube.com/playlist?list=${pl.id}`
  // Resolve the playlists section from the page-level `sections` ref —
  // can't reference the v-for `section` from here. Section ids are
  // unique within the active preset.
  const playlistSection = sections.value.find((s: any) => s.id === 'playlists')
  if (!playlistSection) return
  // If the user has an empty initial row sitting there (the seeded
  // {name:'', url:''}), fill that one rather than push a duplicate.
  const empty = (playlistSection.config.playlists as any[]).find((p: any) => !p.name && !p.url)
  if (empty) {
    empty.name = pl.title
    empty.url = url
  } else {
    ;(playlistSection.config.playlists as any[]).push({ name: pl.title, url })
  }
}

/**
 * v1.0.71+: seed titleConfig / descConfig / tagConfig defaults from the
 * project's effective Format BEFORE preset.load() runs. Out-of-the-box
 * the page hardcoded sleep-story numbers (5000-char description, 5
 * titles, 100-char title cap, 15 tags) — for listicle / educational /
 * kids projects those were wrong but the user had no obvious cue. By
 * pulling format.metadata.defaultMaxChars / defaultTitleCount /
 * defaultTitleMaxLength / defaultTagCount when present, every new
 * project gets sensible starting values without needing to load a
 * saved preset first.
 *
 * If a preset is later applied, its saved values override these
 * format defaults — no behaviour change for users with their own
 * presets. Format-blind formats (custom JSONs that predate the
 * defaults block) fall through to the legacy hardcoded numbers.
 */
async function applyFormatDefaultsIfNoPreset() {
  try {
    const f = await get<any>(`/projects/${slug.value}/effective-format`)
    const meta = f?.metadata
    if (!meta) return
    if (typeof meta.defaultMaxChars === 'number' && meta.defaultMaxChars > 0) {
      descConfig.maxChars = meta.defaultMaxChars
    }
    if (typeof meta.defaultTitleCount === 'number' && meta.defaultTitleCount > 0) {
      titleConfig.count = meta.defaultTitleCount
    }
    if (typeof meta.defaultTitleMaxLength === 'number' && meta.defaultTitleMaxLength > 0) {
      titleConfig.maxLength = meta.defaultTitleMaxLength
    }
    if (typeof meta.defaultTagCount === 'number' && meta.defaultTagCount > 0) {
      tagConfig.count = meta.defaultTagCount
    }
    // v1.0.102+ — hydrate the format's broadKeywords for the Tags
    // placeholder so prayer / motivation / educational channels don't
    // see "sleep story, bedtime story, relaxation" as the example.
    if (Array.isArray(meta.broadKeywords) && meta.broadKeywords.length > 0) {
      formatBroadKeywords.value = meta.broadKeywords.slice(0, 5)
    }
    // v1.0.198 — apply the format-matched starter template's section set so a
    // fresh episode opens with sensible, channel-appropriate sections instead
    // of the old sleep-story default. preset.load() (called right after in
    // onMounted) overrides this when the user has a saved preset, so existing
    // presets are unaffected.
    // v1.0.199 — the format declares its starter template (metadata.
    // defaultStarterTemplate); fall back to the id-based mapping for formats
    // that haven't declared one. So adding a new format needs no edit here.
    const declared = (meta as any).defaultStarterTemplate
    const tplId = (typeof declared === 'string' && starterTemplates.some(t => t.id === declared))
      ? declared
      : templateIdForFormat(f?.id || '')
    applyStarterTemplate(tplId, { silent: true })
  } catch {
    // Format endpoint unavailable / project missing — keep the legacy
    // hardcoded values (5000 / 5 / 100 / 15). Non-fatal.
  }
}

// v1.0.102+ — format-driven Tags placeholder. Populated from
// format.metadata.broadKeywords; empty array falls back to a generic
// hint.
const formatBroadKeywords = ref<string[]>([])
const tagsPlaceholder = computed<string>(() => {
  if (formatBroadKeywords.value.length > 0) {
    return `Comma-separated tags (e.g. ${formatBroadKeywords.value.join(', ')})`
  }
  return 'Comma-separated tags'
})

onMounted(async () => {
  await migrateLegacyMetadataTemplates()
  // Format-aware seeding runs BEFORE preset load. If the user has an
  // active preset, its values override these — but the format defaults
  // are the right starting point for projects with no saved preset yet.
  await applyFormatDefaultsIfNoPreset()
  await metadataPresets.load()
  // Best-effort load — failure is fine, the manual inputs still work.
  loadAvailablePlaylists().catch(() => {})
  // v1.0.198 (M1b) — research sources for the Sources section (episodeId may
  // already be set from query/restore, so the watcher won't have fired yet).
  void loadResearchForSources()
})
</script>

<style scoped>
/* v1.0.298 — generation feedback row (running / success / error / cancelled). */
.meta-result {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: var(--radius-md, 6px);
  font-size: 13px;
  border-left: 3px solid var(--border, #444);
  background: var(--bg-tertiary);
}
.meta-result-icon { font-weight: 700; }
.meta-result-running { border-left-color: var(--accent); }
.meta-result-success { border-left-color: var(--success, #5fb37a); }
.meta-result-success .meta-result-icon { color: var(--success, #5fb37a); }
.meta-result-error { border-left-color: var(--danger, #e06c75); }
.meta-result-error .meta-result-icon { color: var(--danger, #e06c75); }
.meta-result-cancelled { border-left-color: var(--warning, #f0c674); }
.meta-result-cancelled .meta-result-icon { color: var(--warning, #f0c674); }
.meta-result-dismiss { margin-left: auto; flex: 0 0 auto; }

.combined-card {
  background: linear-gradient(135deg, rgba(96,165,250,0.08), rgba(167,139,250,0.08));
  border: 1px solid rgba(96,165,250,0.2);
}

.shared-settings { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 12px 16px; }

/* v1.0.198 — starter-template picker. */
.starter-templates { padding: 12px 16px; }
.starter-templates-row { display: flex; flex-wrap: wrap; gap: 8px; }
.starter-tpl-btn {
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.starter-tpl-btn:hover { border-color: var(--accent); color: var(--text-primary); }
.starter-tpl-btn.active { border-color: var(--accent); background: var(--accent-dim); color: var(--accent); }
.starter-tpl-reset { margin-left: auto; color: var(--text-muted); }
.starter-tpl-reset:hover { color: var(--text-primary); }

/* v1.0.200 — live section outline. */
.section-outline { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.outline-chip {
  font-size: var(--font-xs);
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.outline-sep { color: var(--text-muted); font-size: var(--font-xs); }

/* v1.0.198 (M1b) — Sources section. */
.sources-section { display: flex; flex-direction: column; gap: 6px; }
.sources-bulk { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sources-list { list-style: none; margin: 4px 0 0; padding: 0; font-size: 12px; }
.sources-list li { display: flex; align-items: center; gap: 6px; margin: 4px 0; line-height: 1.4; flex-wrap: wrap; }
.sources-list li.src-off { opacity: 0.5; }
.sources-note { margin: 4px 0 0; line-height: 1.5; }
.src-vbadge {
  font-size: var(--font-xs);
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(91, 179, 124, 0.16);
  color: #5bb37c;
}
.shared-settings-label { display: flex; flex-direction: column; gap: 2px; font-size: 13px; font-weight: 600; color: var(--text-secondary); min-width: 110px; }
.shared-settings-control { max-width: 420px; margin: 0; }

/* Inline helper line directly under an input (e.g. "soft target ±15%"). */
.hint-line { margin-top: 4px; }

/* Section helper label — a short cue above an array of inputs.
 * Used for the channels / videos / playlists / cta / support pickers
 * where "label" wouldn't apply to a single input. */
.section-helper-label {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 8px;
  display: block;
}

/* Narrow form-field widths (used by per-section number inputs). */
.input-narrow { max-width: 140px; }
.narrow-field { max-width: 280px; }
.narrow-field-wide { max-width: 200px; }

/* Description "Number of tags" / "Hashtag count" use input-narrow.
 * Hashtags-section has its own width via the same class. */

/* Link-row column widths — name, url, kind selector. */
.link-row .link-input-name { flex: 1; }
.link-row .link-input-url  { flex: 1.5; }
.link-row .link-select-kind { max-width: 140px; }
.link-row .support-select-kind { max-width: 170px; }
.link-row .support-input-label { max-width: 160px; }

/* Playlist picker (the "+ Add from your YouTube channel" combo row). */
.playlist-picker-row { margin-bottom: 6px; }
.playlist-picker-row .playlist-picker-select { flex: 2.5; }
.playlist-picker-error { margin-bottom: 6px; }

/* Description-area version history dropdown. */
.history-picker { margin-bottom: 0; }
.history-picker .history-label {
  font-size: var(--font-xs);
  display: block;
  margin-bottom: 2px;
}

.card-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }

/* Title-mode picker (radio rows + dimmed downstream controls) */
.title-mode-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}
.title-mode-option {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px 0;
}
.title-mode-option input[type="radio"] {
  margin-top: 3px;
  accent-color: var(--accent);
  cursor: pointer;
}
.controls-dimmed {
  opacity: 0.55;
  pointer-events: none;
}

/* Title options */
.title-options { display: flex; flex-direction: column; gap: 6px; }
.title-option {
  padding: 10px 14px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s;
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
}
.title-option:hover { border-color: var(--accent); background: var(--bg-hover); }
.title-option.selected { border-color: var(--accent); background: rgba(240, 198, 116, 0.1); }
.title-option-text { flex: 1; font-size: 14px; }
.title-option-count { font-size: var(--font-xs); color: var(--text-muted); font-family: 'SF Mono', monospace; white-space: nowrap; }

/* Char count badge */
.char-count {
  font-size: var(--font-xs);
  color: var(--text-muted);
  font-weight: 400;
  margin-left: 8px;
  font-family: 'SF Mono', monospace;
}
.char-count.over-limit { color: var(--error); font-weight: 600; }

/* Section list with drag & drop */
.section-list { display: flex; flex-direction: column; gap: 8px; }

.section-item {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 14px;
  transition: opacity 0.2s, border-color 0.15s, transform 0.15s;
  cursor: grab;
}
.section-item:active { cursor: grabbing; }
.section-item.disabled { opacity: 0.4; }
.section-item.drag-over {
  border-color: var(--accent);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(240, 198, 116, 0.15);
}

.section-header { display: flex; justify-content: space-between; align-items: center; }
.section-head-left { display: flex; align-items: center; gap: 8px; }

.drag-handle {
  color: var(--text-muted);
  font-size: 18px;
  cursor: grab;
  user-select: none;
  padding: 0 2px;
  line-height: 1;
}
.drag-handle:hover { color: var(--text-primary); }

.section-config { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }

.reorder-btns { display: flex; flex-direction: column; gap: 2px; }
.reorder-btn {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-xs);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  line-height: 1;
  min-height: 20px;
  min-width: 28px;
  transition: all 0.15s;
}
.reorder-btn:hover:not(:disabled) { background: var(--accent-dim); color: var(--accent); border-color: rgba(240, 198, 116, 0.3); }
.reorder-btn:disabled { opacity: 0.3; cursor: default; }
.reorder-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.config-textarea { width: 100%; min-height: 70px; font-size: 13px; line-height: 1.5; resize: vertical; }

/* Preview */
.preview-textarea {
  width: 100%;
  min-height: 350px;
  font-family: 'SF Mono', Monaco, monospace;
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
}
.tags-textarea {
  width: 100%;
  min-height: 80px;
  font-size: 13px;
  resize: vertical;
}

.link-row { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.meta-toggles { display: flex; gap: 20px; }
.toggle-label { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 14px; }

.btn-icon {
  background: none; border: none; color: var(--text-muted);
  cursor: pointer; font-size: 14px; padding: 4px 8px; border-radius: 4px;
}
.btn-icon:hover { background: var(--bg-hover); color: var(--text-primary); }
.btn-icon.danger:hover { color: var(--error); background: rgba(248,113,113,0.1); }

.checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; color: var(--text-muted); }

.select-sm { padding: 4px 8px; font-size: 12px; }

.ml-auto { margin-left: auto; }

/* Save-as modal */
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
.modal-small h3 { font-size: 16px; font-weight: 600; }

</style>
