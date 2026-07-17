<template>
  <div class="workspace-page creation-workspace thumbnail-prompts-workspace">
    <WorkspaceHero
      eyebrow="Create · Art direction"
      title="Thumbnail Prompts"
      description="Translate the episode into focused cover-art direction while Scene Plan continues to own narration-timed story visuals."
    >
      <template #aside>
        <div class="workspace-metrics" aria-label="Thumbnail prompt workspace context">
          <span class="workspace-metric" :data-tone="form.episode_id ? 'success' : 'warning'"><strong>{{ form.episode_id || 'No episode' }}</strong> target</span>
          <span class="workspace-metric" data-tone="info"><strong>{{ activeForm.aspect_ratio }}</strong> frame</span>
          <span v-if="promptsJobActiveForEpisode" class="workspace-metric" data-tone="warning"><strong>Active</strong> generation</span>
        </div>
      </template>
    </WorkspaceHero>
    <div class="workspace-command-surface creation-command-surface">
      <TopActionBar
      :project-slug="slug"
      :presets="promptPresets"
      v-model:episode-id="form.episode_id"
      :filter-field="promptFilterField"
      :generate-label="generateLabel"
      loading-label="Generating…"
      :generate-loading="generating || promptsJobActiveForEpisode"
      :generate-disabled="!form.episode_id || (scriptGateApplies && !scriptReady)"
      :generate-status="(generating || promptsJobActiveForEpisode) ? `Generating prompts for ${form.episode_id}…` : scriptGateReason"
      @generate="generate"
      @preset-applied="success('Preset applied')"
      @preset-saved="success('Preset saved')"
      @preset-deleted="success('Preset deleted')"
      />
      <p class="workspace-command-copy">
        Create thumbnail-only prompts here. Narration-timed scene prompts remain authoritative in <strong>Scene Plan</strong>.
      </p>
    </div>

    <!-- v1.0.296 — inline rescan-from-disk affordance, parity with audio.vue.
         Surfaces only once we KNOW the script is missing (statusKnown && !scriptReady),
         NOT during the loading window — so a script that's actually on disk but
         cached stale gets a one-click re-check instead of a dead end. -->
    <div v-if="scriptGateApplies && form.episode_id && statusKnown && !scriptReady" class="rescan-hint mt-1">
      <span class="text-muted text-xs">
        No script detected for <strong>{{ form.episode_id }}</strong> —
        if it's actually on disk (e.g. just generated, or delivered by iCloud), force a re-check:
      </span>
      <button
        type="button"
        class="btn btn-link btn-xs"
        :disabled="rescanning"
        title="Wipe this project's status cache and re-stat every episode folder. Fixes the case where a script on disk wasn't picked up by the cached status."
        @click="onRescan"
      >
        {{ rescanning ? '↻ Rescanning…' : '↻ Rescan from disk' }}
      </button>
    </div>

    <div class="card workspace-section prompt-settings-panel">
      <!-- v1.0.179 — character references are opt-in here too (matches the
           Script page). Off by default → the LLM describes scene subjects
           freely. Toggle on to fold a pinned cast's names + descriptions
           into every scene/thumbnail prompt for consistency across
           regenerations. Turning it off clears the selection. -->
      <div v-if="form.episode_id" class="form-group field-wide">
        <label class="toggle-label">
          <input type="checkbox" v-model="useCharacters" />
          <span>Use character references</span>
        </label>
        <span class="text-muted text-xs hint-line">
          Off = the AI describes characters freely per prompt. On = pin a cast
          so every scene/thumbnail prompt reuses the same descriptions.
        </span>
        <div v-if="useCharacters" class="mt-2">
          <CharacterPicker
            v-model="activeForm.character_ids"
            :project-slug="slug"
            :episode-code="form.episode_id"
          />
        </div>
      </div>

      <div class="form-group field-medium">
        <ModelSelector v-model="activeForm.model" :project-slug="slug" />
      </div>

      <!-- Style preset -->
      <div class="grid-2">
        <div class="form-group">
          <label>{{ formTab === 'thumbnails' ? 'Visual Style' : 'Art Style' }}</label>
          <select v-model="activeForm.style_preset" class="select" @change="onStyleChange">
            <optgroup v-if="formTab === 'thumbnails'" label="Shared Style Gallery">
              <option v-for="style in BUILT_IN_STYLES" :key="style.id" :value="`shared:${style.id}`">
                {{ style.name }}
              </option>
            </optgroup>
            <optgroup label="Built-in Presets">
              <option value="storybook">Storybook Illustration</option>
              <option value="3d-render">3D Render</option>
              <option value="watercolor">Watercolor</option>
              <option value="anime">Anime / Manga</option>
              <option value="photorealistic">Photorealistic</option>
              <option value="cinematic">Cinematic</option>
              <option value="pixel-art">Pixel Art</option>
              <option value="oil-painting">Oil Painting</option>
              <option value="flat-design">Flat Design / Vector</option>
              <option value="charcoal">Charcoal / Sketch</option>
            </optgroup>
            <optgroup label="Custom" v-if="customStyles.length">
              <option v-for="cs in customStyles" :key="cs.id" :value="cs.id">{{ cs.name }}</option>
            </optgroup>
            <option value="custom">+ Write custom style...</option>
          </select>
          <button
            v-if="formTab === 'thumbnails'"
            type="button"
            class="btn btn-secondary btn-sm mt-1"
            @click="showVisualStyleGallery = !showVisualStyleGallery"
          >
            {{ showVisualStyleGallery ? 'Hide visual style gallery' : 'Browse visual style gallery…' }}
          </button>
        </div>
        <div class="form-group">
          <label>Aspect Ratio</label>
          <select v-model="activeForm.aspect_ratio" class="select">
            <option value="16:9">16:9 — Landscape (YouTube)</option>
            <option value="1:1">1:1 — Square (Instagram)</option>
            <option value="9:16">9:16 — Portrait (Stories/TikTok)</option>
            <option value="4:3">4:3 — Classic</option>
            <option value="3:4">3:4 — Portrait Classic</option>
            <option value="21:9">21:9 — Ultrawide</option>
          </select>
        </div>
      </div>

      <div v-if="formTab === 'thumbnails' && showVisualStyleGallery" class="card workspace-section nested-workspace-section">
        <StylePicker
          :slug="slug"
          :image-models="config?.image_models || {}"
          :active-style-bible="form.thumbnail.style_tag"
          @apply="applyThumbnailVisualStyle"
        />
      </div>

      <!-- Style pill — always visible when style_tag has content. Shows
           EXACTLY what gets sent to the LLM as the style descriptor.
           Eliminates the "is my custom style actually being used?"
           anxiety, $0 cost, no API calls.
           (The image-rendering Preview button that briefly lived here
           was moved off this page — it surfaced a kie.ai 422 because
           prompt generation doesn't naturally know which image
           model the user wants to test, and the right home for "render
           a sample of this style" is the Generator page where
           that context already exists. Pill stays here as the free
           visibility affordance.) -->
      <div v-if="activeForm.style_tag && activeForm.style_tag.trim()" class="style-preview-row">
        <div class="style-preview-pill" :title="activeForm.style_tag">
          <span class="style-preview-pill-icon" aria-hidden="true">🎨</span>
          <span class="style-preview-pill-label">Style:</span>
          <span class="style-preview-pill-text">{{ activeForm.style_tag.trim() }}</span>
        </div>
      </div>

      <div class="form-group" v-if="activeForm.style_preset === 'custom' || showStyleEditor">
        <label>Style Tag</label>
        <textarea v-model="activeForm.style_tag" class="textarea style-tag-textarea"
          placeholder="Describe the visual style…" />

        <!-- Reference-image style extraction (pain-point #7). Upload an -->
        <!-- image → Claude/GPT-4o returns a style-only description that -->
        <!-- populates the textarea above. Re-analyze lets users iterate on -->
        <!-- the focus hint without re-picking the file. -->
        <div class="style-extract mt-2">
          <div class="style-extract-row">
            <button
              type="button"
              class="btn btn-sm btn-secondary"
              :disabled="extracting"
              :title="referenceImagePath ? 'Pick a different image' : 'Pick a reference image to analyse'"
              @click="pickReferenceImage"
            >
              <LoadingSpinner v-if="extracting" size="sm" />
              <span v-else aria-hidden="true">📷</span>
              {{ referenceImagePath ? 'Change reference…' : 'Extract from reference image…' }}
            </button>

            <ModelMenu
              v-if="visionModels.length"
              v-model="visionModel"
              class="vision-model-select"
              :options="visionModelMenuOptions"
              media-type="llm"
              title="Reference analysis model"
              search-placeholder="Search vision models…"
              :disabled="extracting"
            />

            <button
              v-if="referenceImagePath"
              type="button"
              class="btn btn-sm btn-primary"
              :disabled="extracting"
              title="Re-run analysis on the same reference (useful after changing the focus hint below or the vision model above)"
              @click="extractStyle"
            >
              <LoadingSpinner v-if="extracting" size="sm" />
              ⟳ Re-analyze
            </button>
          </div>

          <!-- Optional focus hint — biases the vision model's vocabulary
               (e.g. "lighting", "palette", "illustration"). Backend's
               /analyze-style accepts this; UI exposes it so the user can
               re-analyze with a different focus without re-picking the
               reference. -->
          <div class="style-extract-focus-row mt-1">
            <label class="style-extract-focus-label" for="style-focus">Focus hint <span class="text-muted">(optional)</span></label>
            <input
              id="style-focus"
              v-model="extractFocus"
              type="text"
              class="input input-sm style-extract-focus-input"
              :disabled="extracting"
              placeholder="e.g. lighting, illustration, painterly mood"
              @keydown.enter.prevent="referenceImagePath && extractStyle()"
            />
          </div>

          <div v-if="referenceImagePath" class="style-extract-preview mt-2">
            <img
              :src="referencePreviewUrl"
              alt="Reference image"
              class="style-extract-thumb"
              :title="referenceImagePath"
            />
            <div class="style-extract-meta">
              <div class="style-extract-filename">{{ referenceImageName }}</div>
              <div v-if="lastAnalyzedAt" class="text-muted text-xs">
                Analyzed {{ lastAnalysisModel }} · {{ lastAnalyzedAtRelative }}
              </div>
              <div v-else class="text-muted text-xs">
                Hit Re-analyze to extract the style description.
              </div>
              <div class="flex gap-2 mt-1 flex-wrap">
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  title="Clean up the reference with AI before re-analysing — useful if it has watermarks or unwanted text."
                  @click="openReferenceEdit"
                >
                  ✨ Edit with AI
                </button>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  :disabled="!activeForm.style_tag.trim() || savingStylePreset"
                  :title="!activeForm.style_tag.trim() ? 'Generate or write a style description first' : 'Save the current description as a named custom style preset, reusable across episodes'"
                  @click="openSaveStylePreset"
                >
                  💾 Save as preset…
                </button>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  @click="clearReference"
                >
                  Remove reference
                </button>
              </div>
            </div>
          </div>

          <!-- Inline name-the-preset form. Hidden by default; flips open
               on "Save as preset" click. Keep it inline (vs. a Modal) so
               the user can still see the source description they're naming. -->
          <div v-if="showSavePresetForm" class="style-save-preset-form mt-2">
            <label class="style-save-preset-label">Name this style preset</label>
            <div class="flex gap-2">
              <input
                v-model="newPresetName"
                type="text"
                class="input input-sm flex-1"
                placeholder="e.g. Watercolour Sunset"
                :disabled="savingStylePreset"
                @keyup.enter.stop.prevent="saveStylePreset"
                @keydown.escape="cancelSaveStylePreset"
                ref="savePresetInputEl"
              />
              <button
                type="button"
                class="btn btn-primary btn-sm"
                :disabled="!newPresetName.trim() || savingStylePreset"
                @click="saveStylePreset"
              >
                <LoadingSpinner v-if="savingStylePreset" size="sm" />
                {{ savingStylePreset ? 'Saving…' : 'Save' }}
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="savingStylePreset"
                @click="cancelSaveStylePreset"
              >
                Cancel
              </button>
            </div>
            <p class="text-muted text-xs mt-1">
              Saved per-project under "Custom" in the Art Style dropdown above. Source model + reference path are recorded so you can trace later.
            </p>
          </div>

          <p class="text-muted text-xs mt-1">
            Tip: pick a thumbnail or scene image that matches the look you want. The vision model describes only the
            style (medium, palette, lighting, texture) — not the subject — and drops it into the textarea above.
            Costs a few cents per extract.
          </p>
        </div>
      </div>

      <!-- ── Form tabs: Thumbnail | Scene ─────────────────────────────────
           Two separate panels for the two distinct prompt types. Thumbnail
           is FIRST because in YouTube production the thumbnail is what you
           sweat first (it's the CTR lever); scenes follow once the cover
           image direction is locked. v1.0.87+. -->
      <!-- v1.0.201 — the in-page Thumbnail/Scene switcher was removed so each
           sidebar entry (Thumbnail Prompts / Scene Prompts) is its own focused
           view. The mode is set by the sidebar's ?tab=; switch via the sidebar.
           This keeps the split honest — formats that don't use scenes (broll,
           timestamp, continuity-chain) never surface scene controls here. -->
      <div class="generator-mode-head mt-2">
        <span class="generator-mode-icon" aria-hidden="true">{{ formTab === 'thumbnails' ? '🖼️' : '🎬' }}</span>
        <strong>{{ formTab === 'thumbnails' ? 'Thumbnail Prompts' : 'Scene Prompts' }}</strong>
        <span class="text-muted text-xs">{{ formTab === 'thumbnails' ? `${safeThumbCount} thumbnail prompt(s)` : `${effectiveSceneCount} scene prompt(s)` }}</span>
      </div>

      <!-- ── Scene Prompts section ─────────────────────────────────────── -->
      <div class="split-section mt-2" v-show="formTab === 'scenes'">
        <div class="split-header">
          <h3 class="split-title">🎬 Scene Prompts</h3>
          <span class="text-muted text-xs">{{ effectiveSceneCount }} prompts will be generated</span>
        </div>
        <!-- v1.0.87+: three always-visible fields, multiplication-only.
             Old layout had a dropdown locking the user into 1/2/3/4 or
             "Custom total" mode where they typed an absolute number. That
             felt arbitrary — bound-explainer wants 250 scenes from 8
             reasons (31/reason), and the dropdown's 1-4 cap forced
             everyone into Custom mode where the chapter relationship
             evaporated. The new flow is just: chapter count × scenes
             per chapter = total. User edits any of the first two, total
             follows. The third field stays read-only as the math display. -->
        <div class="grid-3">
          <!-- Field 1: chapter count (auto from outline, editable override). -->
          <div class="form-group">
            <label>
              {{ sectionLabel.Singular }} count
              <span v-if="actualChapterCount && form.scene.chapter_count_override === null"
                    class="text-muted text-xs">
                · auto from outline
              </span>
              <span v-else-if="actualChapterCount && form.scene.chapter_count_override !== null"
                    class="text-muted text-xs"
                    :title="`Outline has ${actualChapterCount} ${sectionLabel.plural}; you've overridden to ${form.scene.chapter_count_override}.`">
                · overridden
              </span>
            </label>
            <input
              :value="form.scene.chapter_count_override ?? actualChapterCount ?? 0"
              @input="onChapterCountInput($event)"
              class="input"
              type="number"
              min="1"
              max="200"
            />
          </div>
          <!-- Field 2: scenes per chapter (free numeric input, was a 1-4
               dropdown). Bumping to e.g. 8 multiplies cleanly against the
               chapter count without forcing the user into a separate
               Custom-total mode. Cap 100 is a sanity guard — 100 scenes
               per chapter × even 10 chapters = 1000 prompts, well past
               any reasonable single-episode budget. -->
          <div class="form-group">
            <label>Scenes per {{ sectionLabel.Singular }}</label>
            <input
              v-model.number="form.scene.scenes_per_chapter"
              class="input"
              type="number"
              min="1"
              max="100"
            />
          </div>
          <!-- Field 3: total = field1 × field2, read-only display. -->
          <div class="form-group">
            <label>Total</label>
            <div class="estimate-value">
              {{ effectiveSceneCount }} prompts
              <div class="text-muted text-xs">
                {{ effectiveChapterCount }} {{ sectionLabel.plural }} × {{ form.scene.scenes_per_chapter || 0 }} per {{ sectionLabel.singular }}
              </div>
            </div>
          </div>
        </div>
        <span class="text-muted text-xs scene-count-hint">
          Start with 1 per chapter to keep costs low — you can always generate
          more scenes for specific chapters later.
        </span>
      </div>

      <!-- ── Thumbnail Prompts section ─────────────────────────────────── -->
      <div class="split-section mt-2" v-show="formTab === 'thumbnails'">
        <div class="split-header">
          <h3 class="split-title">🖼️ Thumbnail Prompts</h3>
          <span class="text-muted text-xs">{{ safeThumbCount }} thumbnail variations</span>
        </div>
        <div class="grid-2">
          <div class="form-group">
            <label>Thumbnail Treatment</label>
            <select v-model="form.thumbnail.thumb_treatment_preset" class="select" @change="applyThumbnailTreatment">
              <option v-for="t in THUMBNAIL_TREATMENTS" :key="t.id" :value="t.id">{{ t.label }}</option>
            </select>
            <p class="text-muted text-xs hint-line">
              A starting recipe for composition and title treatment. Adjust the controls below freely; your Thumbnail Prompt preset saves the final mix.
            </p>
          </div>
          <div class="form-group">
            <label>Thumbnail Count</label>
            <input v-model.number="form.thumbnail.thumb_count" class="input" type="number" min="1" max="10" />
          </div>
          <div class="form-group">
            <label>Text Style</label>
            <select v-model="form.thumbnail.thumb_text_style" class="select">
              <option v-for="p in TEXT_STYLE_PRESETS" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
            <input
              v-if="form.thumbnail.thumb_text_style === 'custom'"
              v-model="form.thumbnail.thumb_text_style_custom"
              class="input mt-1"
              placeholder="e.g. holographic rainbow foil, pastel sparkles with subtle glow…"
              maxlength="240"
            />
            <p v-if="form.thumbnail.thumb_text_style === 'custom'" class="text-muted text-xs hint-line">
              Free-form description (up to 240 chars). Dropped verbatim into the LLM prompt — be specific.
            </p>
          </div>
        </div>
        <div class="grid-2 mt-2">
          <div class="form-group">
            <label>Creative freedom</label>
            <select v-model="form.thumbnail.thumb_creative_mode" class="select">
              <option value="guided">Balanced — distinctive but readable</option>
              <option value="open">Open — let the model art-direct</option>
              <option value="strict">Guardrails — full CTR checklist</option>
            </select>
          </div>
          <div class="form-group">
            <label>Concept strategy</label>
            <select v-model="form.thumbnail.thumb_strategy" class="select">
              <option value="auto">Model decides</option>
              <option value="character">Character-led</option>
              <option value="object">Symbol or object-led</option>
              <option value="environment">Environment-led</option>
              <option value="typographic">Typography-led</option>
              <option value="mystery">Mystery and reveal</option>
              <option value="documentary">Documentary evidence</option>
            </select>
          </div>
        </div>
        <div class="form-group mt-1">
          <label>Creative brief <span class="text-muted">(optional)</span></label>
          <textarea v-model="form.thumbnail.thumb_creative_direction" class="textarea" rows="2" placeholder="Give the model room, or state the one idea you care about most…" />
        </div>
        <div class="grid-2">
          <div class="form-group">
            <label>Text Position</label>
            <select v-model="form.thumbnail.thumb_text_position" class="select">
              <option value="center">Center</option>
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
            </select>
          </div>
          <div class="form-group">
            <label>Font Style</label>
            <select v-model="form.thumbnail.thumb_font_style" class="select">
              <option v-for="p in FONT_STYLE_PRESETS" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
            <input
              v-if="form.thumbnail.thumb_font_style === 'custom'"
              v-model="form.thumbnail.thumb_font_style_custom"
              class="input mt-1"
              placeholder="e.g. bold slab serif with rounded corners, art-deco inspired…"
              maxlength="240"
            />
          </div>
        </div>

        <!-- v1.0.224 — title-text mode + dynamic art direction ─────────── -->
        <div class="form-group mt-2">
          <label>Title text</label>
          <select v-model="form.thumbnail.thumb_title_mode" class="select">
            <option value="ai">Render the title into the image (AI)</option>
            <option value="composite">Text-free background — overlay the title afterward (Compose)</option>
          </select>
          <p class="text-muted text-xs hint-line">
            <template v-if="form.thumbnail.thumb_title_mode === 'composite'">
              The thumbnail is generated WITHOUT any text. After rendering, use the Compose dialog to overlay a crisp, perfectly legible title via your thumbnail template — the text / font / position pickers above are ignored in this mode.
            </template>
            <template v-else>
              The AI renders the episode title into the image using the text / font / position above (defaulting to this format's recommended style). Quick, but lettering can occasionally come out imperfect — switch to Compose for guaranteed-legible text.
            </template>
          </p>
        </div>

        <div class="form-group mt-2">
          <label>Art direction <span class="text-muted">(optional — overrides the format + best-practice defaults)</span></label>
          <textarea
            v-model="form.thumbnail.thumb_art_direction"
            class="textarea"
            rows="2"
            placeholder="e.g. extreme close-up on a shocked face, neon-on-black palette, bold arrow + circle highlight…"
          />
        </div>

        <div class="form-group mt-1">
          <label>Replicate a reference thumbnail <span class="text-muted">(optional)</span></label>
          <div class="flex gap-2 items-center flex-wrap">
            <button
              type="button"
              class="btn btn-sm btn-secondary"
              :disabled="extractingThumbRef"
              title="Pick a thumbnail you want to emulate — a vision model extracts its look and the prompt replicates it."
              @click="extractThumbReferenceStyle"
            >
              <LoadingSpinner v-if="extractingThumbRef" size="sm" />
              <span v-else aria-hidden="true">📷</span>
              {{ form.thumbnail.thumb_reference_style ? 'Change reference thumbnail…' : 'Extract style from a reference thumbnail…' }}
            </button>
            <button
              v-if="form.thumbnail.thumb_reference_style"
              type="button"
              class="btn btn-sm btn-secondary"
              title="Clear the reference style"
              @click="form.thumbnail.thumb_reference_style = ''"
            >
              ✕ Clear
            </button>
          </div>
          <textarea
            v-if="form.thumbnail.thumb_reference_style"
            v-model="form.thumbnail.thumb_reference_style"
            class="textarea mt-1"
            rows="3"
            placeholder="Extracted reference style (editable)…"
          />
        </div>

        <!-- Randomize + Surprise Me: full-size like the Ideas generator's -->
        <!-- action cluster so these feel like first-class actions, not -->
        <!-- afterthoughts (pain-point from test feedback). -->
        <div class="flex gap-2 mt-2 items-center flex-wrap">
          <button
            type="button"
            class="btn btn-secondary"
            title="Picks a random style + font preset (skips 'custom' to avoid blank fields)."
            @click="randomizeThumbStyles"
          >
            🎲 Randomize Styles
          </button>
          <button
            type="button"
            class="btn btn-secondary"
            :disabled="!form.episode_id || generating"
            :title="'Randomize style + font, then generate thumbnails immediately.'"
            @click="surpriseMeThumb"
          >
            ✨ Surprise Me
          </button>
        </div>
      </div>

      <div class="flex items-center gap-2 mt-2">
        <label class="checkbox-label">
          <input type="checkbox" v-model="activeForm.force" />
          Force regenerate (overwrite existing)
        </label>
      </div>
      <!-- Progress bar -->
      <div v-if="generating" class="progress-bar mt-1">
        <div class="progress-fill" />
      </div>
    </div>

    <!-- ── Per-prompt Regenerate ──────────────────────────────────────────
         Reads whatever prompts are already on disk for the selected
         episode and lets the user fire a single-prompt regen for any
         row they don't like. Same docx is re-saved with that one
         entry replaced. v1 is regen-only (no in-place edit) per
         the AskUserQuestion answer; edit can be added later.

         Per-prompt char counter (advisory): each row renders a coloured
         badge against the documented prompt-character cap of whichever
         image model the user has configured below. Pass a different
         model id from the dropdown to recolour the badges for that cap. -->
    <div v-if="form.episode_id" class="cap-preview-row">
      <label class="cap-preview-label">Char-count colours against image model:</label>
      <ModelMenu
        v-model="capPreviewModel"
        class="cap-preview-select"
        :options="capPreviewMenuOptions"
        media-type="image"
        title="Prompt compatibility model"
        search-placeholder="Search image models…"
        aria-label="Image model for prompt length checks"
      />
      <button type="button" class="cap-link" @click="showCapsTable = true">View all caps →</button>
    </div>
    <PromptReviewPanel
      v-if="form.episode_id"
      :project-slug="slug"
      :episode-id="form.episode_id"
      :title="selectedEpisode?.title || ''"
      :model="activeForm.model"
      :refresh-key="reviewRefreshKey"
      :scene-prompt-cap="capPreviewInfo.cap"
      :thumbnail-prompt-cap="capPreviewInfo.cap"
      :scene-model-label="capPreviewInfo.label"
      :thumbnail-model-label="capPreviewInfo.label"
      :pool="formTab"
    />

    <!-- Provider prompt-cap reference table. Same modal shape as the
         Generator page so users see a consistent surface. -->
    <div v-if="showCapsTable" class="modal-overlay" @click.self="showCapsTable = false">
      <div class="caps-modal">
        <div class="caps-modal-head">
          <h3>Image model prompt-character caps</h3>
          <button type="button" class="caps-modal-close" @click="showCapsTable = false" title="Close">×</button>
        </div>
        <p class="text-muted text-sm caps-modal-intro">
          Approximate per-prompt character limits documented by each provider. Prompts longer than the
          cap are typically rejected outright or silently truncated — wasting credits either way.
          Keep generated prompts under the cap of whichever model you plan to render with.
        </p>
        <div class="caps-table-wrap">
          <table class="caps-table">
            <thead>
              <tr>
                <th>Model</th>
                <th class="caps-th-right">Prompt cap</th>
                <th class="caps-th-right">Credits / image</th>
                <th>Refs?</th>
                <th>Provider</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in allModelCaps" :key="row.id"
                  :class="{ 'caps-row-active': row.id === capPreviewModel }">
                <td>{{ row.label }}</td>
                <td class="caps-td-right">
                  <template v-if="row.cap">~{{ row.cap.toLocaleString() }}</template>
                  <span v-else class="text-muted">—</span>
                </td>
                <td class="caps-td-right">
                  <template v-if="row.credits != null">{{ row.credits }}</template>
                  <span v-else class="text-muted">—</span>
                </td>
                <td>
                  <span v-if="row.supportsRefs" title="Supports reference / img2img images">✓</span>
                  <span v-else class="text-muted">—</span>
                </td>
                <td class="text-muted">{{ row.provider }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Tabs: Current / History -->
    <div v-if="generatedPrompts || history.length > 0" class="mt-3">
      <div class="tabs">
        <button :class="['tab', { active: activeTab === 'current' }]" @click="activeTab = 'current'">
          Current {{ generatedPrompts ? `(${formTab === 'thumbnails' ? generatedPrompts.thumbnails.length : generatedPrompts.scenes.length})` : '' }}
        </button>
        <button :class="['tab', { active: activeTab === 'history' }]" @click="activeTab = 'history'">
          History ({{ history.length }})
        </button>
      </div>

      <!-- Current tab -->
      <div v-if="activeTab === 'current' && generatedPrompts" class="card workspace-section prompt-result-panel">
        <div class="card-header">
          <h3>Review &amp; Edit</h3>
          <div class="flex gap-2">
            <button class="btn btn-sm btn-secondary" @click="saveToFile">Re-save edits</button>
            <button class="btn btn-sm btn-primary" @click="navigateTo(`/projects/${slug}/images`)">
              Generate Images →
            </button>
          </div>
        </div>

        <!-- v1.0.209 — only show the active pool so the split is honest:
             Scene-Prompts page shows scene results, Thumbnail-Prompts shows
             thumbnails. (Both are still on disk; this is just the view.) -->
        <template v-if="formTab === 'scenes'">
          <h3 class="mt-2">Scene Prompts ({{ generatedPrompts.scenes.length }})</h3>
          <div class="prompt-list mt-1">
            <div v-for="(scene, i) in generatedPrompts.scenes" :key="i" class="prompt-item">
              <div class="prompt-header">
                <strong>Scene {{ scene.number }}: {{ scene.title }}</strong>
                <button class="btn-icon" @click="removePrompt('scenes', Number(i))">✕</button>
              </div>
              <textarea v-model="scene.prompt" class="textarea prompt-edit" />
            </div>
          </div>
        </template>

        <template v-if="formTab === 'thumbnails'">
          <h3 class="mt-2">Thumbnail Prompts ({{ generatedPrompts.thumbnails.length }})</h3>
          <div class="prompt-list mt-1">
            <div v-for="(thumb, i) in generatedPrompts.thumbnails" :key="i" class="prompt-item">
              <div class="prompt-header">
                <strong>Thumbnail {{ thumb.number }}: {{ thumb.title }}</strong>
                <button class="btn-icon" @click="removePrompt('thumbnails', Number(i))">✕</button>
              </div>
              <textarea v-model="thumb.prompt" class="textarea prompt-edit" />
            </div>
          </div>
        </template>
      </div>

      <EmptyState
        v-if="activeTab === 'current' && !generatedPrompts"
        class="mt-1"
        icon="🎨"
        title="No prompts generated yet"
        message="Configure your style, scene count, and thumbnail settings above — then click Generate."
      />

      <!-- History tab -->
      <div v-if="activeTab === 'history'" class="card workspace-section prompt-history-panel">
        <EmptyState v-if="history.length === 0" icon="🕘" title="No history yet" message="Past prompt generations in this session will appear here." />
        <table v-else class="history-table">
          <thead>
            <tr>
              <th>Episode</th>
              <th>Style</th>
              <th>Ratio</th>
              <th>Scenes</th>
              <th>Thumbs</th>
              <th>Time</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(entry, i) in history" :key="i">
              <td class="td-code">{{ entry.episode_id }}</td>
              <td>{{ entry.style_preset }}</td>
              <td>{{ entry.aspect_ratio }}</td>
              <td>{{ entry.prompts.scenes.length }}</td>
              <td>{{ entry.prompts.thumbnails.length }}</td>
              <td class="text-muted">{{ formatTime(entry.generated_at) }}</td>
              <td>
                <button class="btn btn-sm btn-secondary" @click="loadFromHistory(entry)">Load</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Shared AI image-edit dialog for the reference image. Mounted at -->
    <!-- the page root; openReferenceEdit() flips the v-model. -->
    <ImageEditDialog
      v-model="referenceEditOpen"
      :project-slug="slug"
      :image-path="referenceImagePath || ''"
      @accepted="onReferenceEditAccepted"
    />

  </div>
</template>

<script setup lang="ts">
import { BUILT_IN_STYLES } from '~/composables/useBuiltInStyles'
definePageMeta({ layout: 'dashboard' })
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put } = useApi()
const { success, info: showInfo, error: showError } = useToast()

const generating = ref(false)
// Bumped after the bulk Generate completes so the per-prompt
// PromptReviewPanel re-fetches the freshly-saved docx and the user
// sees their just-generated prompts in the regen panel.
const reviewRefreshKey = ref(0)
const showStyleEditor = ref(false)

// v1.0.179 — character references opt-in (mirrors the Script page). Default
// OFF; toggle reveals the picker. Off clears the selection so a stale cast
// never leaks into a prompt run. Auto-on when the active form already carries
// characters (editing an episode that was set up with a cast).
const useCharacters = ref(false)
// NOTE: the watches that sync `useCharacters` ↔ `activeForm.character_ids` live
// *after* the `activeForm` computed is declared (below), because watch() runs
// its source getter once during setup — referencing activeForm up here threw
// "Cannot access 'activeForm' before initialization" under SSR (nuxt dev).
const generatedPrompts = ref<any>(null)
const activeTab = ref('current')

// Image-model picker for the per-prompt char-counter colour-coding. This
// page generates prompts via an LLM but doesn't render images itself —
// the user picks the image model on the Generator page later. The
// dropdown here is purely a preview: select the model you plan to use
// downstream and each row's char counter colours against THAT model's cap.
const capPreviewModel = ref<string>('')
const showCapsTable = ref(false)
const allModelCaps = computed(() => {
  const models = (config.value as any)?.image_models || {}
  return Object.entries(models).map(([id, raw]) => {
    const m = raw as any
    return {
      id,
      label: (m?.label as string) || id,
      provider: (m?.provider as string) || 'kie',
      cap: typeof m?.prompt_char_cap === 'number' ? m.prompt_char_cap : null,
      credits: typeof m?.credits_per_image === 'number' ? m.credits_per_image : null,
      supportsRefs: !!m?.supports_reference_images,
    }
  }).sort((a, b) => {
    if (a.cap == null && b.cap == null) return a.label.localeCompare(b.label)
    if (a.cap == null) return 1
    if (b.cap == null) return -1
    return a.cap - b.cap
  })
})
const capPreviewOptions = computed(() => allModelCaps.value)
const capPreviewMenuOptions = computed(() => [
  {
    id: '',
    label: 'Raw character counts only',
    group: 'Prompt checking',
    meta: 'Do not compare prompts against a model-specific limit.',
  },
  ...capPreviewOptions.value.map(model => ({
    id: model.id,
    label: model.label,
    group: model.provider || 'Image models',
    provider: model.provider,
    meta: model.cap ? `${model.cap.toLocaleString()} character prompt cap` : 'No documented prompt cap',
    badges: model.supportsRefs ? [{ label: 'References', tone: 'info' as const }] : [],
  })),
])
const capPreviewInfo = computed(() => {
  const id = capPreviewModel.value
  if (!id) return { cap: null as number | null, label: '' }
  const found = allModelCaps.value.find(m => m.id === id)
  return { cap: found?.cap ?? null, label: found?.label || '' }
})

// v1.0.87+: form section tab selector. The two prompt-type form panels
// (Thumbnail Prompts, Scene Prompts) used to render stacked — at full
// width they pushed the Generate buttons way off-screen and made the
// "which one am I tuning?" question ambiguous. Now they're tabs, with
// Thumbnail first because in YouTube production the cover image direction
// gets locked before the scene list (cover is the CTR lever; scenes
// follow from the cover's visual register).
//
// v1.0.88+: tab state syncs with the route's ?tab= query param so the
// sidebar's split "Thumbnail Prompts" / "Scene Prompts" entries land on
// the right tab AND browser back/forward navigation Just Works. Default
// is 'thumbnails' when the query is missing or invalid.
const formTab = ref<'thumbnails' | 'scenes'>('thumbnails')
const promptPageTitle = computed(() => formTab.value === 'thumbnails' ? 'Thumbnail Prompts' : 'Scene Prompts')
useAppTitle(promptPageTitle)
// v1.0.304 — the "Pending only" episode filter must reflect the ACTIVE pool.
// The two pools have independent asset status (scene_prompts vs thumb_prompts);
// the legacy `prompts` field is just an alias of scene_prompts, so using it on
// the Thumbnail tab marked an episode "done" based on SCENE prompts — an episode
// with thumbnails generated but no scenes still showed as pending here. Bind the
// filter to the pool that matches the tab.
const promptFilterField = computed(() => 'thumb_prompts')
// Top action-bar label reflects the active pool (the button only generates
// that pool now — see generate()).
const generateLabel = computed(() =>
  formTab.value === 'thumbnails' ? 'Generate Thumbnail Prompts' : 'Generate Scene Prompts',
)
// Push the query when the user clicks the inline tabs, so the URL
// reflects the visible state and the sidebar's active-state highlight
// follows. Uses replace so the back button doesn't accumulate every
// tab toggle.
const _router = useRouter()
if (route.query.tab === 'scenes') {
  void _router.replace({ query: { ...route.query, tab: 'thumbnails' } })
}

// User-saved style presets (Gap A from audit pain-point #7).
// Sourced reactively from the project config so a save flows back into
// the dropdown without a manual refresh. Tolerates `style_presets` being
// absent on older configs by treating undefined as an empty array.
interface StylePresetMeta {
  id: string
  name: string
  description: string
  source_model?: string
  source_reference?: string
  created_at: string
}
const { project, config, refreshConfig } = useProject()

// v1.0.83+: format-aware section label ("Chapter"/"Reason"/"Topic").
// Watches the project meta so swapping format in Settings live-updates
// the labels here without a full reload.
const projectFormatId = ref<string>('scenes')
watch(project, (p) => {
  if (!p) return
  const id = (p as any).format_id
  if (typeof id === 'string' && id) {
    projectFormatId.value = id
  } else {
    // v1.0.102+ — see scripts.vue for rationale. Defensive fallback;
    // logs to console so the case is debuggable when it fires.
    console.warn('[image-prompts.vue] project.format_id missing — falling back to sleep-story for section labels. Set a format in Settings → Format if this is unexpected.')
    projectFormatId.value = 'scenes'
  }
}, { immediate: true })
const sectionLabel = useSectionLabel(projectFormatId)
const customStyles = computed<StylePresetMeta[]>(
  () => Array.isArray((config.value as any)?.style_presets)
    ? (config.value as any).style_presets
    : [],
)

// ── Reference-image style extraction (pain-point #7) ─────────────────────
interface VisionModelCap { id: string; provider: 'anthropic' | 'openai' | 'unknown'; has_key: boolean }
const extracting = ref(false)
const referenceImagePath = ref<string | null>(null)
const lastAnalyzedAt = ref<string | null>(null)
const lastAnalysisModel = ref<string | null>(null)
const visionModels = ref<VisionModelCap[]>([])
const visionModel = ref<string>('claude-sonnet-4-6')
const visionModelMenuOptions = computed(() => visionModels.value.map(model => ({
  id: model.id,
  label: model.id,
  group: model.provider === 'anthropic' ? 'Anthropic' : model.provider === 'openai' ? 'OpenAI' : 'Vision models',
  provider: model.provider,
  disabled: !model.has_key,
  disabledReason: model.has_key ? undefined : 'Add this provider\'s API key to enable it.',
  badges: [{ label: 'Vision', tone: 'info' as const }],
})))

// Session history
interface HistoryEntry {
  episode_id: string
  style_preset: string
  aspect_ratio: string
  // Which independent prompt pool this entry captured.
  mode: 'scenes' | 'thumbnails'
  prompts: any
  generated_at: string
}
const history = ref<HistoryEntry[]>([])

// v1.0.304 — the sidebar pulse must match the pool actually generating:
// `promptGenerating` drives the "Scene Prompts" nav entry, `thumbPromptGenerating`
// drives "Thumbnail Prompts". Previously a thumbnail-only run set promptGenerating,
// so the SCENE Prompts entry pulsed during a thumbnail generation. Light only the
// flag(s) for the mode being run.
const { promptGenerating, thumbPromptGenerating } = useGenerating()
function setPromptPulse(mode: PromptMode, on: boolean) {
  if (mode === 'scenes') promptGenerating.value = on
  if (mode === 'thumbnails') thumbPromptGenerating.value = on
}

const STYLE_PRESETS: Record<string, string> = {
  'storybook': 'Storybook 2D illustration style, flat design, bold outlines, warm and luminous colour palette, bright golden and shiny accent details, soft cel-shaded depth, dreamlike and cosy atmosphere.',
  '3d-render': 'High-quality 3D rendered scene, soft ambient lighting, smooth materials, subtle depth of field, warm color grading, cinematic composition.',
  'watercolor': 'Delicate watercolor painting style, soft wet-on-wet washes, visible paper texture, gentle bleeding edges, pastel and muted tones, dreamy and ethereal atmosphere.',
  'anime': 'Japanese anime illustration style, clean linework, vibrant colors, expressive characters, dynamic composition, detailed backgrounds, Studio Ghibli inspired warmth.',
  'photorealistic': 'Photorealistic digital art, natural lighting, detailed textures, shallow depth of field, professional photography composition, atmospheric perspective.',
  'cinematic': 'Cinematic wide-angle shot, dramatic volumetric lighting, film grain, anamorphic lens flare, moody color grading, epic scale and atmosphere.',
  'pixel-art': 'Detailed pixel art style, limited color palette, clean pixels, retro game aesthetic, charming and nostalgic, warm tones.',
  'oil-painting': 'Classical oil painting style, visible brushstrokes, rich impasto texture, warm golden-hour lighting, Renaissance-inspired composition, deep saturated colors.',
  'flat-design': 'Modern flat design illustration, geometric shapes, bold solid colors, minimal shadows, clean vector aesthetic, contemporary and playful.',
  'charcoal': 'Charcoal drawing style, dramatic contrast, rough paper texture, expressive gestural strokes, moody atmosphere, monochrome with subtle warm tints.',
}

// Thumbnail text + font preset catalogs. Ids must match the backend maps
// in `electron/server/models/thumbnail-styles.ts` — when the user picks an
// id the backend resolves the rich phrase; when they pick `custom`, the
// `*_custom` text is sent as-is.
interface StylePreset { id: string; label: string }
const TEXT_STYLE_PRESETS: StylePreset[] = [
  { id: 'gold',             label: 'Golden Glow' },
  { id: 'white',            label: 'Clean White' },
  { id: 'neon',             label: 'Neon Glow' },
  { id: 'metallic',         label: '3D Metallic' },
  { id: 'chrome',           label: 'Chrome / Silver' },
  { id: 'script',           label: 'Elegant Script (gold)' },
  { id: 'fire',             label: 'Fiery Orange/Red' },
  { id: 'ice',              label: 'Icy Blue' },
  { id: 'gradient-sunset',  label: 'Sunset Gradient' },
  { id: 'gradient-ocean',   label: 'Ocean Gradient' },
  { id: 'comic',            label: 'Comic Book POP' },
  { id: 'horror',           label: 'Horror / Blood Drip' },
  { id: 'retro',            label: 'Retro 80s Synthwave' },
  { id: 'shadow',           label: 'Deep Drop Shadow' },
  { id: 'glitch',           label: 'Digital Glitch' },
  { id: 'embossed',         label: 'Embossed 3D Bevel' },
  { id: 'handwritten',      label: 'Handwritten Inked' },
  { id: 'vintage',          label: 'Vintage Sepia' },
  { id: 'pastel',           label: 'Soft Pastel' },
  { id: 'custom',           label: 'Custom (describe it…)' },
]
const FONT_STYLE_PRESETS: StylePreset[] = [
  { id: 'serif',        label: 'Serif (Classic)' },
  { id: 'script',       label: 'Script (Elegant)' },
  { id: 'bold',         label: 'Bold Sans-Serif' },
  { id: 'fantasy',      label: 'Fantasy' },
  { id: 'display',      label: 'Display / Headline' },
  { id: 'condensed',    label: 'Condensed Sans' },
  { id: 'handwritten',  label: 'Handwritten / Casual' },
  { id: 'gothic',       label: 'Blackletter Gothic' },
  { id: 'retro-chrome', label: 'Retro Chrome' },
  { id: 'futuristic',   label: 'Futuristic / Tech' },
  { id: 'typewriter',   label: 'Typewriter / Monospace' },
  { id: 'brush',        label: 'Brush Stroke' },
  { id: 'graffiti',     label: 'Graffiti / Street' },
  { id: 'playful',      label: 'Playful Rounded' },
  { id: 'stencil',      label: 'Stencil' },
  { id: 'hand-drawn',   label: 'Hand-Drawn Sketch' },
  { id: 'custom',       label: 'Custom (describe it…)' },
]

// v1.0.88+: form split into two completely independent per-kind sub-objects
// (form.thumbnail + form.scene). Each carries its own model, style,
// aspect ratio, character cast, and force flag — plus its own kind-
// specific fields (thumb_count + text/font styling for thumbnails;
// scenes_per_chapter + chapter_count_override for scenes). The `episode_id`
// stays at the top level because picking an episode applies to both
// kinds within the page.
//
// `activeForm` below is a computed proxy that returns the sub-object
// matching the active tab — template bindings on shared-field controls
// (model, style picker, aspect ratio) bind to this so editing the
// visible control updates the active kind's state only. Tab-specific
// controls (already gated by v-show) bind directly to
// `form.thumbnail.*` or `form.scene.*` so they don't accidentally read
// the wrong sub-form when the user is on the other tab.
type SharedFormFields = {
  model: string
  style_preset: string
  style_tag: string
  aspect_ratio: string
  character_ids: string[]
  force: boolean
}
type ThumbnailForm = SharedFormFields & {
  thumb_count: number
  thumb_treatment_preset: string
  thumb_text_style: string
  thumb_text_style_custom: string
  thumb_text_position: string
  thumb_font_style: string
  thumb_font_style_custom: string
  // v1.0.224 — dynamic thumbnail direction (auto-saved via the preset snapshot).
  thumb_title_mode: 'ai' | 'composite'
  thumb_art_direction: string
  thumb_reference_style: string
  thumb_creative_mode: 'strict' | 'guided' | 'open'
  thumb_strategy: 'auto' | 'character' | 'object' | 'environment' | 'typographic' | 'mystery' | 'documentary'
  thumb_creative_direction: string
}
type SceneForm = SharedFormFields & {
  scenes_per_chapter: number
  total_scenes: number
  // null = "use whatever the sidecar reports (actualChapterCount)".
  // See the per-kind seeding code further down for details.
  chapter_count_override: number | null
}
const form = reactive({
  episode_id: '',
  thumbnail: {
    model: 'gpt-4o',
    style_preset: 'storybook',
    style_tag: STYLE_PRESETS['storybook'],
    aspect_ratio: '16:9',
    character_ids: [] as string[],
    force: false,
    thumb_count: 5,
    thumb_treatment_preset: 'custom',
    thumb_text_style: 'gold',
    thumb_text_style_custom: '',
    thumb_text_position: 'center',
    thumb_font_style: 'serif',
    thumb_font_style_custom: '',
    thumb_title_mode: 'ai',
    thumb_art_direction: '',
    thumb_reference_style: '',
    thumb_creative_mode: 'guided',
    thumb_strategy: 'auto',
    thumb_creative_direction: '',
  } as ThumbnailForm,
  scene: {
    model: 'gpt-4o',
    style_preset: 'storybook',
    style_tag: STYLE_PRESETS['storybook'],
    aspect_ratio: '16:9',
    character_ids: [] as string[],
    force: false,
    scenes_per_chapter: 1,
    total_scenes: 10,
    chapter_count_override: null as number | null,
  } as SceneForm,
})

const showVisualStyleGallery = ref(false)

const THUMBNAIL_TREATMENTS = [
  { id: 'custom', label: 'Custom mix' },
  { id: 'bold-explainer', label: 'Bold Explainer' },
  { id: 'cinematic-minimal', label: 'Cinematic Minimal' },
  { id: 'cozy-story', label: 'Cozy Story' },
  { id: 'documentary-impact', label: 'Documentary Impact' },
  { id: 'text-free-compose', label: 'Text-Free Compose' },
] as const

function applyThumbnailVisualStyle(data: { style_bible: string; negative_prompt: string }): void {
  form.thumbnail.style_preset = 'custom'
  form.thumbnail.style_tag = data.style_bible || ''
  showStyleEditor.value = true
  showVisualStyleGallery.value = false
  success('Visual style applied to Thumbnail Prompts')
}

function applyThumbnailTreatment(): void {
  const id = form.thumbnail.thumb_treatment_preset
  if (id === 'custom') return
  const treatments: Record<string, Partial<ThumbnailForm>> = {
    'bold-explainer': {
      thumb_title_mode: 'ai',
      thumb_text_style: 'comic',
      thumb_font_style: 'display',
      thumb_text_position: 'center',
      thumb_art_direction: 'One dominant hero subject at large scale, immediate emotional readability, bold foreground/background separation, high contrast, clean title-safe negative space, energetic YouTube explainer composition.',
    },
    'cinematic-minimal': {
      thumb_title_mode: 'ai',
      thumb_text_style: 'white',
      thumb_font_style: 'condensed',
      thumb_text_position: 'bottom',
      thumb_art_direction: 'Premium cinematic key art with one unmistakable focal subject, controlled negative space, restrained palette, dramatic directional light, minimal clutter, sophisticated high-contrast title placement.',
    },
    'cozy-story': {
      thumb_title_mode: 'ai',
      thumb_text_style: 'pastel',
      thumb_font_style: 'playful',
      thumb_text_position: 'top',
      thumb_art_direction: 'Warm inviting storybook thumbnail, friendly expressive focal character, soft depth layers, comforting light, gentle color contrast, uncluttered composition and generous title-safe space.',
    },
    'documentary-impact': {
      thumb_title_mode: 'ai',
      thumb_text_style: 'shadow',
      thumb_font_style: 'bold',
      thumb_text_position: 'bottom',
      thumb_art_direction: 'High-impact documentary cover with a strong factual focal image, clear visual stakes, dramatic but credible lighting, restrained annotation energy, sharp silhouette separation and mobile-readable hierarchy.',
    },
    'text-free-compose': {
      thumb_title_mode: 'composite',
      thumb_text_style: 'white',
      thumb_font_style: 'bold',
      thumb_text_position: 'center',
      thumb_art_direction: 'Text-free thumbnail background designed for later title compositing, one strong focal subject, clean uncluttered negative-space region, high subject/background separation and no lettering inside the generated image.',
    },
  }
  Object.assign(form.thumbnail, treatments[id] || {})
}

// v1.0.259 — remember each tab's prompt settings (model / style / aspect /
// art-direction / cast) across reloads. `force` is a per-run regenerate flag,
// so reset it to false after the restore so a remembered run can't silently
// re-overwrite on the next visit.
useRememberedForm('image-prompts', slug, form, { include: ['thumbnail', 'scene'] })
form.thumbnail.force = false
form.scene.force = false

// v1.0.115+ — clear the in-flight indicator on episode swap. The local
// `generating` ref is normally true only during the POST window (reset
// in the submit handler's `finally`), but defensively clearing it on
// episode change prevents the TopActionBar from briefly showing
// "Generating prompts for [old ep]…" if the user is fast enough to swap
// while the POST is still inflight. Symmetrical with video-assembly.vue
// and audio-merge.vue.
watch(() => form.episode_id, (newEp, oldEp) => {
  if (newEp !== oldEp) generating.value = false
})

// The active sub-form. Template bindings on shared-field controls use
// this so a v-model write goes to the right kind. Computed unwraps in
// templates automatically so `activeForm.style_tag` Just Works there;
// in script we still need `.value`.
const activeForm = computed<ThumbnailForm | SceneForm>(() =>
  formTab.value === 'thumbnails' ? form.thumbnail : form.scene,
)

// v1.0.304 — moved here from the `useCharacters` declaration above: watch()
// evaluates its source getter during setup, so `() => activeForm.value.…` must
// run AFTER activeForm exists (the getter referencing it earlier TDZ-crashed
// the page under SSR / nuxt dev). Character-references opt-in (mirrors the
// Script page): toggling off clears the cast; an existing cast auto-enables it.
watch(useCharacters, (on) => {
  if (!on && activeForm.value.character_ids.length) activeForm.value.character_ids = []
})
watch(() => activeForm.value.character_ids.length, (n) => {
  if (n > 0 && !useCharacters.value) useCharacters.value = true
})

function pickRandomPresetId(presets: StylePreset[]): string {
  // Skip the 'custom' sentinel — randomizing into custom would leave the
  // *_custom text empty and confuse the user about why their thumbnail
  // didn't pick up the new style.
  const pool = presets.filter(p => p.id !== 'custom')
  const pick = pool[Math.floor(Math.random() * pool.length)]
  return pick!.id
}

function randomizeThumbStyles() {
  form.thumbnail.thumb_text_style = pickRandomPresetId(TEXT_STYLE_PRESETS)
  form.thumbnail.thumb_font_style = pickRandomPresetId(FONT_STYLE_PRESETS)
  success(`Rolled: ${form.thumbnail.thumb_text_style} + ${form.thumbnail.thumb_font_style}`)
}

async function surpriseMeThumb() {
  randomizeThumbStyles()
  await nextTick()
  await generateThumbnails()
}

// Source-of-truth episode hydration. `scriptReady` is the gate for the
// Generate buttons below — visual prompts read narration context from the
// script docx, so generating without it would 500 on the backend. Refetch
// when a script-only job lands so the gate enables itself live.
const { selectedEpisode, scriptReady, statusKnown, refetch: refetchEpisodeStatus } = useEpisodeStatus(
  computed(() => form.episode_id),
  slug,
  { refetchOnJobTypes: ['script-only'] },
)
// v1.0.296 — distinguish "still checking" from "confirmed no script". The
// definitive message must only show once statusKnown is true; before that the
// gate is locked but the copy says "Checking…" (see useEpisodeStatus header).
const noScriptTooltip = 'Generate the script first to unlock this generator.'
const checkingTooltip = 'Checking script status…'
// The reason text the gated buttons show: nothing if ready, "checking" while
// the status is still loading, the generate-first message once we KNOW it's
// missing. Centralised so every gated button stays consistent.
const scriptGateReason = computed(() => {
  // v1.0.299 — thumbnails are cover art (generated from the title/vibe; the
  // backend already falls back to the title when no narration exists). They
  // don't need the script, so there's no gate in thumbnail mode. Scene prompts
  // DO read the narration, so they stay gated.
  if (formTab.value === 'thumbnails') return ''
  if (!form.episode_id || scriptReady.value) return ''
  return statusKnown.value ? noScriptTooltip : checkingTooltip
})
// v1.0.299 — true when the script gate actually applies to the current mode.
const scriptGateApplies = computed(() => formTab.value !== 'thumbnails')

// v1.0.307 — keep Generate disabled for the WHOLE queued job, not just the
// brief enqueue POST that flips `generating` (see useJobs.isJobActiveFor).
// The `image_prompts` job type covers both scene and thumbnail prompt runs.
const { isJobActiveFor } = useJobs()
const promptsJobActiveForEpisode = computed(() => isJobActiveFor(form.episode_id, ['image_prompts']))

// v1.0.296 — inline rescan-from-disk affordance, parity with audio.vue. Hits
// /episodes?rescan=1 (wipes the project status cache + re-stats every folder),
// then re-pulls this episode's status so the Generate buttons enable without
// a page refresh. Covers the genuine stale-cache / iCloud-mtime case where the
// script is on disk but the cached status says otherwise.
const rescanning = ref(false)
async function onRescan() {
  if (rescanning.value || !form.episode_id) return
  rescanning.value = true
  try {
    await get(`/projects/${slug.value}/episodes?rescan=1`)
    await refetchEpisodeStatus()
    if (scriptReady.value) {
      success(`Script detected for ${form.episode_id} — you can generate prompts now.`)
    } else {
      showInfo(`Still no script for ${form.episode_id}. Generate it in the Scripts page first.`)
    }
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Rescan failed')
  } finally {
    rescanning.value = false
  }
}

// Authoritative chapter count for this episode comes from the chunked-progress
// sidecar (set when outline_only / script-only built). The episode record's
// `suggested_chapters` is only the IDEA-stage hint and goes stale the moment
// the user regenerates an outline at a different count — e.g. the user-
// reported case where EP0001 was generated as 7 from the idea, then expanded
// to 20 chapters; image-prompts kept showing "~7 prompts" because it still
// read the stale idea hint. The watcher below loads sidecar.total_chapters
// per episode pick; the computed prefers it and only falls back to the idea
// hint when no sidecar exists yet (pure idea-stage episode).
const actualChapterCount = ref<number | null>(null)
watch(
  () => [selectedEpisode.value?.episode_code, selectedEpisode.value?.title] as [string?, string?],
  async ([code, title]) => {
    actualChapterCount.value = null
    // Episode switch wipes any per-episode override. The new episode's
    // sidecar will repopulate actualChapterCount; if the user wants to
    // override there too they can type in the input again.
    form.scene.chapter_count_override = null
    if (!code || !slug.value) return
    try {
      const titleParam = title ? `?title=${encodeURIComponent(title)}` : ''
      const data = await get<{ total_chapters?: number }>(
        `/projects/${slug.value}/episodes/${code}/outline${titleParam}`,
      )
      if (typeof data?.total_chapters === 'number' && data.total_chapters > 0) {
        actualChapterCount.value = data.total_chapters
      }
    } catch {
      // No sidecar yet (idea-stage episode, never had a script generated)
      // — falls back to suggested_chapters in the computed below.
    }
  },
  { immediate: true },
)

// Authoritative chapter count for the form's math display + backend
// request. Resolution order:
//   1. User-typed override in the Chapter count input (form.scene.chapter_count_override).
//   2. actualChapterCount loaded from the chunked-progress sidecar.
//   3. Episode record's suggested_chapters (idea-stage hint).
//   4. 10 fallback (last resort, only when nothing else exists).
// User wins over auto-detection wins over idea hint wins over default.
// All coerced + NaN-guarded so a cleared input doesn't render "NaN".
const effectiveChapterCount = computed(() => {
  const override = Number(form.scene.chapter_count_override)
  if (Number.isFinite(override) && override > 0) return Math.round(override)
  const real = Number(actualChapterCount.value)
  if (Number.isFinite(real) && real > 0) return real
  const suggested = Number(selectedEpisode.value?.suggested_chapters)
  if (Number.isFinite(suggested) && suggested > 0) return suggested
  return 10
})

// Total scene prompt count the user will see "be generated."
// v1.0.87+: multiplication-only — chapter count × scenes-per-chapter.
// The previous "scenes_per_chapter === 0 → use total_scenes" custom-total
// path is gone; the form now always presents three multiplicand-style
// fields (chapter count, scenes per chapter, total readout). If the user
// wants 250 scenes from 8 chapters they type 32 in scenes-per-chapter
// and the readout shows 256; the chapter relationship stays visible.
const effectiveSceneCount = computed(() => {
  const perChapter = Number(form.scene.scenes_per_chapter)
  if (!Number.isFinite(perChapter) || perChapter < 1) return 0
  const total = effectiveChapterCount.value * Math.round(perChapter)
  return Number.isFinite(total) && total > 0 ? total : 0
})

// Back-compat alias for any older template / code that referenced
// `estimatedScenes`. New code should use effectiveSceneCount directly.
const estimatedScenes = effectiveSceneCount

// Handler for the explicit Chapter count input. Empty input → null
// (revert to auto-detect); typed number → override that wins. Anything
// non-finite or <1 collapses to null so a cleared field doesn't wedge
// the form at 0 chapters.
function onChapterCountInput(ev: Event): void {
  const raw = (ev.target as HTMLInputElement).value
  if (raw === '' || raw === null || raw === undefined) {
    form.scene.chapter_count_override = null
    return
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) {
    form.scene.chapter_count_override = null
    return
  }
  form.scene.chapter_count_override = Math.round(n)
}

// Same defensive coercion for the thumbnail variations display — clearing
// the number input would otherwise render "NaN thumbnail variations".
const safeThumbCount = computed(() => {
  const n = Number(form.thumbnail.thumb_count)
  return Number.isFinite(n) && n > 0 ? n : 0
})

// Clamp numeric form fields so clearing the input (→ NaN via v-model.number)
// doesn't wedge the form in a submit-blocking state. Default to a sensible
// minimum, user can still raise after typing again.
watch(() => form.thumbnail.thumb_count, (v) => {
  if (!Number.isFinite(v) || v < 1) form.thumbnail.thumb_count = 1
})
// v1.0.87+: form.scene.scenes_per_chapter is now a free integer input (not a
// 1/2/3/4/Custom dropdown). Clamp to >= 1 so a cleared field doesn't
// produce `0 prompts will be generated` confusion. Previously 0 was a
// sentinel for Custom-total mode — that mode is gone, so 0 is just
// invalid.
watch(() => form.scene.scenes_per_chapter, (v) => {
  if (!Number.isFinite(v) || v < 1) form.scene.scenes_per_chapter = 1
})
// Defensive: form.scene.total_scenes is no longer surfaced in the UI but the
// reactive prop still exists in `form` for back-compat with saved
// presets that carry it. Keep the floor watcher so a stale 0 from an
// old preset doesn't render NaN anywhere.
watch(() => form.scene.total_scenes, (v) => {
  if (!Number.isFinite(v) || v < 1) form.scene.total_scenes = 1
})

// ── Presets ─────────────────────────────────────────────────────────────
//
// v1.0.88+: presets are SPLIT per kind. Each tab maintains its own
// preset list (thumbnail_prompts_presets vs scene_prompts_presets) so a
// "10-thumbnail / handwritten" preset can't accidentally overwrite the
// scene config when you save it from the Thumbnails tab, and vice
// versa. The TopActionBar binds to whichever preset object matches
// the active tab via the `activePresets` computed below — preset
// pickers in the toolbar swap their list + active id when you flip
// the tab.
//
// Legacy `image_prompts_presets` is intentionally NOT migrated.
// Existing presets stay on disk under that key but no longer surface
// in the new UI (re-save from the new tabs to materialize them).
const thumbnailPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'thumbnail_prompts',
  snapshot: () => ({ form: { ...form.thumbnail } }),
  apply: (data) => { if (data?.form) Object.assign(form.thumbnail, data.form) },
})
const scenePresets = usePresets<any>({
  slug: slug.value,
  configKey: 'scene_prompts',
  snapshot: () => ({ form: { ...form.scene } }),
  apply: (data) => { if (data?.form) Object.assign(form.scene, data.form) },
})
// Bound to TopActionBar. Switching tabs swaps the entire preset
// surface (list, active id, save / overwrite / delete handlers).
const promptPresets = computed(() => thumbnailPresets)

/**
 * v1.0.71+: format-aware seeding of the form's defaults BEFORE the
 * preset loader runs. Out-of-the-box the form had hardcoded sleep-
 * story numbers (5 thumbs, 16:9 aspect, 1 scene per chapter for ~10
 * total). For listicle channels with `imagePrompts.defaultScenesTotalRange:
 * [10, 10]` and `defaultThumbnails: 3`, those defaults were wrong.
 * Pull from the project's effective Format when present; preset.load()
 * still overrides if the user has saved one.
 *
 * v1.0.87+ note on the scene-count seeding: the form is now
 * multiplication-only (chapters × scenes-per-chapter). The format's
 * `defaultScenesTotalRange[0]` (the low end) is divided by the resolved
 * chapter count to set `scenes_per_chapter`. Example: bound-explainer
 * has range [60, 180] and an 8-chapter outline → 60/8 = 7.5 → ceil to
 * 8 scenes per chapter → 64 total prompts as the starting point.
 *
 * Per-format JSON keys consumed:
 *   imagePrompts.defaultScenesTotalRange  → form.scene.scenes_per_chapter
 *                                           (= ceil(lo / chapter_count))
 *   imagePrompts.defaultThumbnails        → form.thumbnail.thumb_count
 *   imagePrompts.recommendedAspect        → activeForm.value.aspect_ratio
 *   imagePrompts.defaultStyleTag          → activeForm.value.style_tag (with style_preset = 'custom'
 *                                           so the format's tuned visual language —
 *                                           "minimalist circular badge" for listicle,
 *                                           "editorial infographic" for educational —
 *                                           lands in the textarea instead of the
 *                                           hardcoded 'storybook' fallback. The user
 *                                           can still pick a STYLE_PRESETS option to
 *                                           override.)
 */
async function applyFormatDefaultsIfNoPreset() {
  try {
    const f = await get<any>(`/projects/${slug.value}/effective-format`)
    const ip = f?.imagePrompts
    if (!ip) return
    if (Array.isArray(ip.defaultScenesTotalRange) && ip.defaultScenesTotalRange.length === 2) {
      const [lo] = ip.defaultScenesTotalRange
      if (typeof lo === 'number' && lo > 0) {
        // Map the format's preferred total to scenes-per-chapter using
        // the live chapter count (auto-detected from the outline sidecar
        // by the watcher above). Floor at 1 so single-chapter idea-stage
        // episodes still get a sensible default.
        const chapters = effectiveChapterCount.value || 1
        form.scene.scenes_per_chapter = Math.max(1, Math.ceil(lo / chapters))
      }
    }
    if (typeof ip.defaultThumbnails === 'number' && ip.defaultThumbnails > 0) {
      form.thumbnail.thumb_count = ip.defaultThumbnails
    }
    // v1.0.88+: seed BOTH sub-forms from the format defaults, not just
    // whichever tab happens to be active when this fires. Each kind
    // starts from the same shared default; the user can then diverge
    // them per tab after switching.
    if (typeof ip.recommendedAspect === 'string' && ip.recommendedAspect) {
      form.thumbnail.aspect_ratio = ip.recommendedAspect
      form.scene.aspect_ratio = ip.recommendedAspect
    }
    if (typeof ip.defaultStyleTag === 'string' && ip.defaultStyleTag.trim()) {
      // Switching to 'custom' opens the style editor (see onStyleChange);
      // we set style_tag manually here instead of going through that
      // handler so the page boots up with the editor already showing the
      // format's text.
      form.thumbnail.style_preset = 'custom'
      form.thumbnail.style_tag = ip.defaultStyleTag
      form.scene.style_preset = 'custom'
      form.scene.style_tag = ip.defaultStyleTag
    }
  } catch {
    // Format endpoint unavailable / project missing — keep the legacy
    // hardcoded values. Non-fatal.
  }
}

onMounted(async () => {
  // Format-aware seeding runs BEFORE preset load. If the user has an
  // active preset for the active tab, its values override these — but
  // the format defaults are the right starting point for projects with
  // no saved preset yet. v1.0.88+: load BOTH per-kind preset lists so
  // either tab can immediately use saved presets without a tab-switch
  // first.
  await applyFormatDefaultsIfNoPreset()
  void thumbnailPresets.load()
  void loadVisionCaps()
})

// ── Vision / style-extraction ──────────────────────────────────────────
const VISION_CAPABLE = new Set<string>([
  'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-3-5-sonnet-latest',
  'claude-3-5-sonnet-20241022', 'claude-3-opus-20240229',
  'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-5',
])

// Bumped after each accepted AI edit so the <img> re-fetches the file
// instead of showing the stale cached pre-edit pixels.
const referenceEditKey = ref(0)
const referencePreviewUrl = computed(() => {
  if (!referenceImagePath.value) return ''
  return `/api/projects/${slug.value}/video-editor/preview-image?path=${encodeURIComponent(referenceImagePath.value)}&k=${referenceEditKey.value}`
})

// "✨ Edit with AI" button on the reference-image preview row. Reuses the
// shared ImageEditDialog (mounted at template root). On accept, the dialog
// returns the new path; we keep the same path bound here when the user
// chooses Replace, or swap to the new versioned file otherwise.
const referenceEditOpen = ref(false)
function openReferenceEdit() {
  if (!referenceImagePath.value) return
  referenceEditOpen.value = true
}
function onReferenceEditAccepted(newPath: string) {
  void (async () => {
    referenceImagePath.value = await collapseToPortablePath(newPath)
    referenceEditKey.value++  // bust the preview cache
    // Clear any stale "Analyzed N min ago" — the image's content changed,
    // so the previous style extraction no longer describes it.
    lastAnalyzedAt.value = ''
    lastAnalysisModel.value = ''
  })()
}

const referenceImageName = computed(() => {
  const p = referenceImagePath.value || ''
  return p.split('/').pop() || p
})

const lastAnalyzedAtRelative = computed(() => {
  if (!lastAnalyzedAt.value) return ''
  const diff = Date.now() - new Date(lastAnalyzedAt.value).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.round(diff / 60_000)} min ago`
  return `${Math.round(diff / 3600_000)} h ago`
})

async function loadVisionCaps() {
  try {
    const data = await get<{ models: VisionModelCap[]; default: string }>(
      `/projects/${slug.value}/vision/caps`,
    )
    visionModels.value = data.models || []
    // Default: current image-prompts model if it's vision-capable AND has a
    // key, else the first vision-capable model that has a key, else the
    // server-suggested default.
    const current = activeForm.value.model
    if (VISION_CAPABLE.has(current) && visionModels.value.find(m => m.id === current && m.has_key)) {
      visionModel.value = current
    } else {
      const firstWithKey = visionModels.value.find(m => m.has_key)
      visionModel.value = firstWithKey?.id || data.default
    }
  } catch { /* tolerate — keep default */ }
}

async function collapseToPortablePath(input: string): Promise<string> {
  const raw = String(input || '').trim()
  if (!raw) return ''
  try {
    const r = await post<{ output: string }>(`/system/resolve-asset-path`, {
      path: raw,
      output_root: project.value?.output_root,
      mode: 'portable',
    })
    return String(r?.output || raw)
  } catch {
    return raw
  }
}

async function pickReferenceImage() {
  try {
    const r = await post<{ path: string | null }>('/system/pick-file', {
      title: 'Choose a reference image',
      buttonLabel: 'Use as Reference',
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (!r.path) return
    referenceImagePath.value = await collapseToPortablePath(r.path)
    lastAnalyzedAt.value = null
    lastAnalysisModel.value = null
    // Auto-extract on first pick — saves the user one click. Re-analyze is
    // for iterating on the model/focus without re-picking.
    await extractStyle()
  } catch (e: any) {
    showError(`Reference picker failed — ${e.data?.detail || e.message || 'unknown error'}`)
  }
}

// Optional focus hint sent alongside the image+prompt on /analyze-style.
// Backend uses it to bias the vision model's vocabulary (e.g. "lighting"
// vs "palette" vs "illustration").
const extractFocus = ref('')

async function extractStyle() {
  if (!referenceImagePath.value) {
    showError('Pick a reference image first')
    return
  }
  extracting.value = true
  try {
    const data = await post<{ style_text: string; model_used: string }>(
      `/projects/${slug.value}/analyze-style`,
      {
        image_path: referenceImagePath.value,
        model: visionModel.value,
        // Empty string = no focus; backend tolerates either undefined or
        // empty. Trim defensively in case the user accidentally pasted
        // whitespace.
        focus: extractFocus.value.trim() || undefined,
      },
    )
    // Switch to custom style so the textarea is visible + editable.
    activeForm.value.style_preset = 'custom'
    showStyleEditor.value = true
    activeForm.value.style_tag = data.style_text
    lastAnalyzedAt.value = new Date().toISOString()
    lastAnalysisModel.value = data.model_used
    success(`Style extracted via ${data.model_used}`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Style analysis failed')
  } finally {
    extracting.value = false
  }
}

function clearReference() {
  referenceImagePath.value = null
  lastAnalyzedAt.value = null
  lastAnalysisModel.value = null
}

// v1.0.224 — thumbnail-scoped reference replication. Distinct from the scene
// style extractor above (which writes the scene style_tag): this pulls a
// thumbnail's look into form.thumbnail.thumb_reference_style, which the
// generator injects as the reference layer of the thumbnail art direction.
const extractingThumbRef = ref(false)
async function extractThumbReferenceStyle() {
  try {
    const r = await post<{ path: string | null }>('/system/pick-file', {
      title: 'Choose a reference thumbnail',
      buttonLabel: 'Use as Reference',
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (!r.path) return
    const portablePath = await collapseToPortablePath(r.path)
    extractingThumbRef.value = true
    const data = await post<{ style_text: string; model_used: string }>(
      `/projects/${slug.value}/analyze-style`,
      {
        image_path: portablePath,
        model: visionModel.value,
        focus: 'YouTube thumbnail: focal subject, composition, lighting, color palette, mood, and title-text treatment',
      },
    )
    form.thumbnail.thumb_reference_style = data.style_text
    success(`Reference thumbnail style extracted via ${data.model_used}`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Reference style extraction failed')
  } finally {
    extractingThumbRef.value = false
  }
}

// ── Save-as-preset flow ─────────────────────────────────────────────────
// Captures whatever's in activeForm.value.style_tag right now (could be a vision-
// extracted description, a hand-written one, or a fork of an existing
// custom preset) and persists it under a name in config.style_presets.
const showSavePresetForm = ref(false)
const newPresetName = ref('')
const savingStylePreset = ref(false)
const savePresetInputEl = ref<HTMLInputElement | null>(null)

function openSaveStylePreset() {
  if (!activeForm.value.style_tag.trim()) return
  showSavePresetForm.value = true
  newPresetName.value = ''
  // Focus the input on next tick so keyboard users can type immediately
  // without an extra Tab press.
  nextTick(() => savePresetInputEl.value?.focus())
}

function cancelSaveStylePreset() {
  showSavePresetForm.value = false
  newPresetName.value = ''
}

/**
 * Generate a stable, file-system-safe id from a name. Collision with an
 * existing id is resolved by suffixing `-2`, `-3`, … so a user saving
 * "Watercolour" twice ends up with `watercolour` and `watercolour-2`
 * rather than overwriting the first silently.
 */
function makeStylePresetId(name: string, existing: StylePresetMeta[]): string {
  const base = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'style'
  if (!existing.some(c => c.id === base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    if (!existing.some(c => c.id === candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

async function saveStylePreset() {
  const name = newPresetName.value.trim()
  if (!name || !activeForm.value.style_tag.trim() || savingStylePreset.value) return
  savingStylePreset.value = true
  try {
    const existing = customStyles.value
    const newPreset: StylePresetMeta = {
      id: makeStylePresetId(name, existing),
      name,
      description: activeForm.value.style_tag.trim(),
      source_model: lastAnalysisModel.value || undefined,
      source_reference: referenceImagePath.value || undefined,
      created_at: new Date().toISOString(),
    }
    // Persist via the existing settings/config PUT — same path voice_presets
    // uses. The route's UpdateConfig schema passes `style_presets` through
    // (we registered it in contracts/index.ts), so this single round-trip
    // both saves the preset and refreshes the dropdown via the reactive
    // config ref.
    await put(`/projects/${slug.value}/settings/config`, {
      style_presets: [...existing, newPreset],
    })
    await refreshConfig(slug.value)
    // Switch the dropdown to the new entry so the user immediately sees
    // their save reflected. Selecting it also re-fills the textarea (a no-op
    // here since it already matches), keeping behaviour predictable.
    activeForm.value.style_preset = newPreset.id
    showSavePresetForm.value = false
    newPresetName.value = ''
    success(`Saved "${newPreset.name}" — pick it from the Art Style dropdown next time.`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save style preset')
  } finally {
    savingStylePreset.value = false
  }
}

// ── Reference path persistence (Gap C from audit pain-point #7) ──────────
// Per-project localStorage key so iCloud-synced project switches stay
// remembered across reloads. Cleared explicitly via clearReference.
const REF_PATH_LS_KEY = computed(() => `story-studio:${slug.value}:image-prompts:reference-path`)

async function loadPersistedReferencePath() {
  if (typeof window === 'undefined') return  // SSR safety, even though Nuxt runs in SPA mode here
  try {
    const raw = window.localStorage.getItem(REF_PATH_LS_KEY.value)
    if (raw && typeof raw === 'string' && raw.trim()) {
      referenceImagePath.value = await collapseToPortablePath(raw)
    }
  } catch { /* localStorage may be unavailable in private mode — ignore */ }
}

watch(referenceImagePath, (v) => {
  if (typeof window === 'undefined') return
  try {
    if (v) window.localStorage.setItem(REF_PATH_LS_KEY.value, v)
    else   window.localStorage.removeItem(REF_PATH_LS_KEY.value)
  } catch { /* ignore quota / private-mode errors */ }
})

onMounted(() => { void loadPersistedReferencePath() })

function onStyleChange() {
  if (activeForm.value.style_preset.startsWith('shared:')) {
    const id = activeForm.value.style_preset.slice('shared:'.length)
    const style = BUILT_IN_STYLES.find(item => item.id === id)
    if (style) {
      activeForm.value.style_tag = style.data.style_bible
      showStyleEditor.value = true
    }
    return
  }
  if (activeForm.value.style_preset in STYLE_PRESETS) {
    activeForm.value.style_tag = STYLE_PRESETS[activeForm.value.style_preset] || ''
    showStyleEditor.value = false
    return
  }
  if (activeForm.value.style_preset === 'custom') {
    activeForm.value.style_tag = ''
    showStyleEditor.value = true
    return
  }
  // User-saved custom preset — id matches an entry in config.style_presets.
  // Treat selection as "load this description and put me in editable mode"
  // so the user can fork the preset (tweak + save under a new name) without
  // mutating the original.
  const saved = customStyles.value.find(cs => cs.id === activeForm.value.style_preset)
  if (saved) {
    activeForm.value.style_tag = saved.description
    showStyleEditor.value = true
  }
}

function removePrompt(type: 'scenes' | 'thumbnails', index: number) {
  if (generatedPrompts.value) generatedPrompts.value[type].splice(index, 1)
}

function formatTime(d: string) {
  try { return new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }
  catch { return d }
}

function loadFromHistory(entry: HistoryEntry) {
  generatedPrompts.value = JSON.parse(JSON.stringify(entry.prompts))
  form.episode_id = entry.episode_id
  activeTab.value = 'current'
  success(`Loaded prompts for ${entry.episode_id}`)
}

// Generation helpers — `mode` picks which half of the payload the backend
// returns. 'scenes' / 'thumbnails' keep the other half untouched on disk
// (the save endpoint only writes docx files for arrays actually present
// in the payload), so a Scene-only run never clobbers an existing thumb
// file, and vice-versa.
type PromptMode = 'scenes' | 'thumbnails'

// v1.0.87+: image-prompts generation now runs as an enqueued background
// job (Jobs tab visibility, per-step output_lines, retryable on error)
// instead of a synchronous LLM call. Flow:
//   1. POST /generate/image-prompts → returns the queued Job ({ job_id, … }).
//   2. Poll GET /jobs/:jobId until status ∈ {done, error, cancelled}.
//   3. On done: GET /episodes/:id/image-prompts to read the just-written
//      docx, populate the inline-edit pane, bump the per-prompt review-
//      panel refresh key.
//   4. On error: surface the stored job error.
//
// Why poll instead of subscribing to the Jobs SSE stream: the SSE
// composable is already wired by the dashboard layout for the Jobs panel
// + per-page generating indicators; subscribing again from this page
// would double-count badges. A small poll-by-id loop is simpler and
// has the same UX latency (1.5s tick is fast enough for a 1-3 min job).

const JOB_POLL_INTERVAL_MS = 1500

async function waitForJob(slug: string, jobId: string): Promise<any> {
  while (true) {
    const job: any = await get(`/projects/${slug}/jobs/${jobId}`)
    if (job?.status === 'done' || job?.status === 'error' || job?.status === 'cancelled') {
      return job
    }
    await new Promise(r => setTimeout(r, JOB_POLL_INTERVAL_MS))
  }
}

async function runGenerate(mode: PromptMode) {
  if (!form.episode_id) return
  generating.value = true
  setPromptPulse(mode, true)
  try {
    const job: any = await post(`/projects/${slug.value}/generate/image-prompts`, {
      episode_id: form.episode_id,
      model: activeForm.value.model,
      style_tag: activeForm.value.style_tag,
      aspect_ratio: activeForm.value.aspect_ratio,
      // v1.0.87+: always multiplication. No more Custom-total mode —
      // the backend's executor multiplies scenes_per_chapter × chapter_
      // count to get the final scene count and proceeds straight into
      // chunked generation. total_scenes is no longer sent; the
      // executor still reads it as a fallback for legacy presets but
      // the form no longer surfaces it.
      scenes_per_chapter: form.scene.scenes_per_chapter,
      chapter_count: effectiveChapterCount.value,
      thumb_count: form.thumbnail.thumb_count,
      thumb_text_style: form.thumbnail.thumb_text_style,
      thumb_text_style_custom: form.thumbnail.thumb_text_style_custom,
      thumb_text_position: form.thumbnail.thumb_text_position,
      thumb_font_style: form.thumbnail.thumb_font_style,
      thumb_font_style_custom: form.thumbnail.thumb_font_style_custom,
      thumb_title_mode: form.thumbnail.thumb_title_mode,
      thumb_art_direction: form.thumbnail.thumb_art_direction,
      thumb_reference_style: form.thumbnail.thumb_reference_style,
      thumb_creative_mode: form.thumbnail.thumb_creative_mode,
      thumb_strategy: form.thumbnail.thumb_strategy,
      thumb_creative_direction: form.thumbnail.thumb_creative_direction,
      title: selectedEpisode.value?.title || '',
      mode,
      // Cast for this generation. Backend resolves these via
      // character-manager and folds the descriptions into the LLM prompt
      // so every scene/thumbnail prompt actually includes them.
      character_ids: activeForm.value.character_ids,
    })

    // Job is now in the queue + visible in the Jobs panel. Surface that
    // immediately so the user knows the click registered, then poll for
    // completion. We don't block paint while the job runs — the existing
    // `generating` flag keeps the button disabled + spinner showing.
    success(`Queued ${mode === 'scenes' ? 'scene prompts' : 'thumbnail prompts'} — job ${job.job_id}`)

    const completed = await waitForJob(slug.value, job.job_id)
    if (completed.status === 'error') {
      throw new Error(completed.error || 'Job failed (see Jobs panel for details)')
    }
    if (completed.status === 'cancelled') {
      showError('Generation cancelled')
      return
    }

    // Job done — executor wrote the docx to disk. Pull it back so the
    // inline-edit pane reflects the new prompts.
    const titleParam = selectedEpisode.value?.title
      ? `?title=${encodeURIComponent(selectedEpisode.value.title)}`
      : ''
    const onDisk: any = await get(
      `/projects/${slug.value}/episodes/${form.episode_id}/image-prompts${titleParam}`,
    )

    // Merge into the inline review pane. Scene-only / thumb-only runs
    // preserve the OTHER half from whatever was already there on disk
    // (the executor only writes the half it generated).
    if (!generatedPrompts.value) {
      generatedPrompts.value = { scenes: onDisk?.scenes || [], thumbnails: onDisk?.thumbnails || [] }
    } else {
      generatedPrompts.value = {
        ...generatedPrompts.value,
        scenes: mode === 'scenes' ? (onDisk?.scenes || []) : generatedPrompts.value.scenes,
        thumbnails: mode === 'thumbnails' ? (onDisk?.thumbnails || []) : generatedPrompts.value.thumbnails,
      }
    }

    history.value.unshift({
      episode_id: form.episode_id,
      style_preset: activeForm.value.style_preset,
      aspect_ratio: activeForm.value.aspect_ratio,
      mode,
      prompts: JSON.parse(JSON.stringify(generatedPrompts.value)),
      generated_at: new Date().toISOString(),
    })

    activeTab.value = 'current'
    // Bump the review-panel refresh key so the per-prompt panel
    // re-fetches the freshly-written docx.
    reviewRefreshKey.value++

    const sceneCt = onDisk?.scenes?.length || 0
    const thumbCt = onDisk?.thumbnails?.length || 0
    const msg = mode === 'scenes' ? `Generated ${sceneCt} scene prompts`
      : `Generated ${thumbCt} thumbnail prompts`
    success(msg)
  } catch (e: any) {
    // Name the pool that failed so the toast is actionable.
    const poolLabel = mode === 'scenes' ? 'scene prompts'
      : 'thumbnail prompts'
    console.error(`[image-prompts] ${poolLabel} generation failed:`, e)
    showError(e.data?.detail || e.message || `Failed to generate ${poolLabel}`)
  } finally {
    generating.value = false
    setPromptPulse(mode, false)
  }
}

// v1.0.209 — the top action-bar button respects the active split tab so
// the Thumbnail-Prompts page generates ONLY thumbnails and the Scene-Prompts
// page generates ONLY scenes (it used to always run 'all', which is why a
// thumbnail-only run still produced scene prompts).
async function generate() {
  await runGenerate(formTab.value === 'thumbnails' ? 'thumbnails' : 'scenes')
}
// generateThumbnails is still used by surpriseMeThumb (randomize → generate).
// The legacy per-pool inline buttons were removed in v1.0.304 — the top action
// bar generates the active tab's pool, so a separate "…Only" button was redundant.
async function generateThumbnails() { await runGenerate('thumbnails') }

async function saveToFile() {
  if (!generatedPrompts.value) return
  try {
    await post(`/projects/${slug.value}/generate/image-prompts/save`, {
      episode_id: form.episode_id,
      title: selectedEpisode.value?.title || '',
      prompts: generatedPrompts.value,
    })
    success(`${promptPageTitle.value} saved to .docx!`)
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to save')
  }
}
</script>

<style scoped>
/* v1.0.296 — inline rescan-from-disk hint (parity with audio.vue). */
.rescan-hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  border-left: 3px solid var(--accent);
  border-radius: 4px;
  font-size: 12px;
}
.rescan-hint .btn-link {
  background: transparent;
  border: none;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  font-size: 12px;
  text-decoration: none;
}
.rescan-hint .btn-link:hover { color: var(--accent-hover); text-decoration: underline; }
.rescan-hint .btn-link:disabled { opacity: 0.6; cursor: not-allowed; }

/* v1.0.201 — focused-view header (replaces the thumbnail/scene switcher). */
.generator-mode-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.generator-mode-head strong { font-size: 15px; }
.generator-mode-icon { font-size: 16px; }

/* Form-field width tokens (mirror scripts.vue). */
.field-medium { max-width: 520px; }
.field-wide   { max-width: 720px; }

/* Helper line that hangs directly under an input. */
.hint-line { margin-top: 4px; }

/* Style-tag textarea — short, no monospace. */
.style-tag-textarea { min-height: 60px; font-size: 13px; }

/* Vision-model menu sits inline without truncating long model names. */
.vision-model-select { width: min(420px, 100%); }

/* Optional focus-hint row beneath the extract / re-analyze buttons.
 * Compact label-input pair so it doesn't dominate the section. */
.style-extract-focus-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.style-extract-focus-label {
  font-size: 11px;
  color: var(--text-secondary);
  font-weight: 500;
}
.style-extract-focus-input { flex: 1; min-width: 200px; }

/* Inline name-the-preset form. Lives under the reference preview block,
 * sized to read as a small subordinate flow (not a competing card). */
.style-save-preset-form {
  padding: 10px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.style-save-preset-label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

/* Sub-section title for Scenes / Thumbnails split — smaller than h3. */
.split-title { font-size: 14px; margin: 0; }

/* Inline hint that appears under the "Scenes per Chapter" select. */
.scene-count-hint { display: block; margin-top: 4px; }

/* Visual separation for the per-section blocks (Scenes vs Thumbnails) */
.split-section {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 14px 16px;
}
.split-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.estimate-value {
  padding: 10px 14px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--accent);
  font-size: 14px;
}

/* Progress bar */
.progress-bar {
  height: 3px;
  background: var(--bg-tertiary);
  border-radius: 2px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  animation: progressIndeterminate 1.5s ease-in-out infinite;
}

@keyframes progressIndeterminate {
  0% { width: 0%; margin-left: 0; }
  50% { width: 60%; margin-left: 20%; }
  100% { width: 0%; margin-left: 100%; }
}

/* Tabs */
.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
}

.tab {
  padding: 10px 18px;
  font-size: 14px;
  color: var(--text-muted);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  font-family: inherit;
}
.tab:hover { color: var(--text-primary); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }

/* Form section tabs (Thumbnail | Scene): styles moved to
 * assets/css/main.css in v1.0.117 so ideas.vue + scripts.vue can
 * reuse them. Same visual register as the Current/History tabs above
 * so the page reads as one tabbed surface. */

/* History table */
.history-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.history-table th {
  text-align: left;
  font-size: 12px;
  color: var(--text-muted);
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.history-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.td-code { font-weight: 600; color: var(--accent); }

/* Prompts */
.prompt-list { display: flex; flex-direction: column; gap: 12px; }
.prompt-item { background: var(--bg-tertiary); border-radius: var(--radius-md); padding: 12px; }
.prompt-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 14px; }
.prompt-edit { min-height: 60px; font-size: 13px; background: var(--bg-primary); }
.btn-icon { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 14px; padding: 4px 8px; border-radius: 4px; }
.btn-icon:hover { color: var(--error); background: rgba(248, 113, 113, 0.1); }
.checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; color: var(--text-muted); }

/* Style pill — free, always-visible read-out of form.style_tag.
   Tells the user exactly what gets sent to the LLM as the style
   descriptor, so "is my style actually being used?" is answered just
   by glancing at it. */
.style-preview-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}
.style-preview-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(99, 102, 241, 0.10);
  border: 1px solid rgba(99, 102, 241, 0.28);
  font-size: 11px;
  color: var(--text-secondary);
  max-width: min(640px, 100%);
  cursor: help;
}
.style-preview-pill-icon { font-size: 12px; }
.style-preview-pill-label { font-weight: 600; color: var(--text-primary); }
.style-preview-pill-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
  min-width: 0;
}

.style-extract { padding: 10px 12px; background: var(--bg-tertiary); border-radius: var(--radius-sm); border: 1px dashed var(--border); }
.style-extract-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.style-extract-preview { display: flex; gap: 12px; align-items: flex-start; }
.style-extract-thumb { width: 80px; height: 80px; object-fit: cover; border-radius: var(--radius-sm); border: 1px solid var(--border); flex-shrink: 0; }
.style-extract-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.style-extract-filename { font-size: 12px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.style-extract-clear { align-self: flex-start; margin-top: 4px; padding: 2px 8px; font-size: 11px; color: var(--text-muted); }
.style-extract-clear:hover { color: var(--error); }

/* Char-counter colour preview picker — mirrors the small inline controls
   the images.vue page uses for its cap pill. */
.cap-preview-row {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin: 12px 0 4px;
  font-size: 12px;
}
.cap-preview-label { color: var(--text-muted); }
.cap-preview-select {
  width: min(420px, 100%);
}
.cap-link {
  font-size: 11px;
  background: none; border: none;
  color: var(--accent, #6c8fff);
  cursor: pointer; padding: 0;
  text-decoration: underline;
}
.cap-link:hover { color: var(--text-primary); }

/* Provider caps reference modal. Same shape as the Generator
   page's modal. */
.caps-modal {
  background: var(--bg-secondary);
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--border);
  padding: 18px 22px;
  max-width: 720px;
  width: 90vw;
  max-height: 85vh;
  display: flex; flex-direction: column;
  box-shadow: 0 8px 32px rgba(0,0,0,0.25);
}
.caps-modal-head {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 6px;
}
.caps-modal-head h3 { margin: 0; font-size: 16px; color: var(--text-primary); }
.caps-modal-close {
  background: none; border: none; font-size: 22px;
  color: var(--text-muted); cursor: pointer; padding: 0 6px; line-height: 1;
}
.caps-modal-close:hover { color: var(--text-primary); }
.caps-modal-intro { margin: 4px 0 12px; line-height: 1.5; }
.caps-table-wrap { overflow: auto; flex: 1 1 auto; }
.caps-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.caps-table th, .caps-table td {
  padding: 6px 10px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
.caps-table th {
  position: sticky; top: 0;
  background: var(--bg-secondary);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  font-weight: 600;
}
.caps-th-right, .caps-td-right { text-align: right !important; font-variant-numeric: tabular-nums; }
.caps-row-active { background: rgba(108, 143, 255, 0.08); }
.caps-row-active td:first-child::before { content: '▸ '; color: var(--accent, #6c8fff); }
</style>
