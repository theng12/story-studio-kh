<template>
  <div>
    <h1>Settings</h1>

    <!-- Tab navigation -->
    <div class="tabs mt-3">
      <button v-for="tab in tabs" :key="tab.id" :class="['tab', { active: activeTab === tab.id }]" @click="activeTab = tab.id">
        {{ tab.label }}
      </button>
    </div>

    <!-- (API Keys moved out to app-level Settings — see <NuxtLink to="/app-settings">/app-settings</NuxtLink>.
         Keys are now per-machine, configured once for the whole app
         instead of per-project.) -->


    <!-- Models (Editable) -->
    <div v-if="activeTab === 'models'" class="card mt-2">
      <div class="card-header">
        <h3>Image Model Pricing</h3>
        <span class="text-muted" style="font-size:12px" v-if="config?.image_pricing_last_updated">
          Updated: {{ config.image_pricing_last_updated }}
        </span>
      </div>
      <table class="edit-table mt-1">
        <thead>
          <tr><th>Model</th><th>Credits/Image</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="(model, key) in editImageModels" :key="key">
            <td>
              {{ model.label }}
              <span v-if="model.is_custom" class="custom-badge" title="Added via the Add Custom Model form">Custom</span>
            </td>
            <td>
              <input v-model.number="model.credits_per_image" type="number" step="0.5" min="0" class="input input-sm" />
            </td>
            <td>
              <button
                v-if="model.is_custom"
                class="btn-icon"
                :title="`Remove custom model ${key}`"
                @click="removeCustomModel('image', String(key))"
              >&#10005;</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="flex gap-2 mt-2" style="align-items: center;">
        <button class="btn btn-primary" @click="saveImagePricing">Save Image Pricing</button>
        <SaveIndicator v-bind="savedHintProps('image_pricing')" />
      </div>

      <div class="card-header mt-3">
        <h3>Audio Model Pricing</h3>
        <span class="text-muted" style="font-size:12px" v-if="config?.audio_pricing_last_updated">
          Updated: {{ config.audio_pricing_last_updated }}
        </span>
      </div>
      <table class="edit-table mt-1">
        <thead>
          <tr><th>Model</th><th>$/1K chars</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="(model, key) in editAudioModels" :key="key">
            <td>
              {{ model.label }}
              <span v-if="model.is_custom" class="custom-badge" title="Added via the Add Custom Model form">Custom</span>
            </td>
            <td>
              <input v-model.number="model.cost_per_1k_chars" type="number" step="0.01" min="0" class="input input-sm" />
            </td>
            <td>
              <button
                v-if="model.is_custom"
                class="btn-icon"
                :title="`Remove custom model ${key}`"
                @click="removeCustomModel('audio', String(key))"
              >&#10005;</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="flex gap-2 mt-2" style="align-items: center;">
        <button class="btn btn-primary" @click="saveAudioPricing">Save Audio Pricing</button>
        <SaveIndicator v-bind="savedHintProps('audio_pricing')" />
      </div>

      <div class="card-header mt-3">
        <h3>Video Model Pricing</h3>
        <span class="text-muted" style="font-size:12px" v-if="(config as any)?.video_pricing_last_updated">
          Updated: {{ (config as any).video_pricing_last_updated }}
        </span>
      </div>
      <table class="edit-table mt-1">
        <thead>
          <tr><th>Model</th><th>Credits/Video</th><th>Modes</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="(model, key) in editVideoModels" :key="key">
            <td>
              {{ model.label }}
              <span v-if="model.is_custom" class="custom-badge" title="Added via the Add Custom Model form">Custom</span>
            </td>
            <td>
              <input v-model.number="model.credits_per_video" type="number" step="1" min="0" class="input input-sm" />
            </td>
            <td class="text-muted" style="font-size: 11px;">
              {{ (model.modes || []).join(', ') || '—' }}
            </td>
            <td>
              <button
                v-if="model.is_custom"
                class="btn-icon"
                :title="`Remove custom model ${key}`"
                @click="removeCustomModel('video', String(key))"
              >&#10005;</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="flex gap-2 mt-2" style="align-items: center;">
        <button class="btn btn-primary" @click="saveVideoPricing">Save Video Pricing</button>
        <SaveIndicator v-bind="savedHintProps('video_pricing')" />
      </div>

      <div class="mt-3">
        <AddCustomModelForm
          :existing="(config as any)?.models || []"
          @add="addCustomModel"
        />
      </div>
    </div>

    <!-- Voices (Editable) -->
    <div v-if="activeTab === 'voices'" class="card mt-2">
      <h3>Voice Presets</h3>
      <p class="text-muted mt-1 mb-2">
        Save ElevenLabs voice IDs for quick access from the Audio Generator.
        These show up as <strong>My Custom Voices</strong> in the picker.
      </p>

      <!-- Where-to-find-the-id helper. New users don't know ElevenLabs's
           voice URLs, and copy/paste from the dashboard isn't obvious. -->
      <p class="text-muted voice-helper-line">
        💡 Find a voice's ID in
        <a href="https://elevenlabs.io/app/voice-library" target="_blank" rel="noopener" class="voice-helper-link">ElevenLabs → Voice Library</a>:
        click any voice → "View Voice" → copy the long alphanumeric ID from the URL or the "Voice ID" field.
      </p>

      <div v-if="catalogLoadError" class="voice-catalog-warn">
        ⚠ Couldn't load your live ElevenLabs catalog ({{ catalogLoadError }}). Voice availability won't be checked here.
      </div>

      <div class="voice-list">
        <div
          v-for="(voice, i) in editVoices"
          :key="i"
          class="voice-row-edit"
          :class="{ 'voice-row-unavailable': isVoicePresetUnavailable(voice.voice_id) }"
        >
          <input v-model="voice.name" class="input input-sm voice-name-input" placeholder="Voice name" />
          <input v-model="voice.voice_id" class="input input-sm voice-id-input" placeholder="ElevenLabs voice ID" />
          <span
            v-if="isVoicePresetUnavailable(voice.voice_id)"
            class="voice-unavailable-pill"
            title="This voice isn't in your current ElevenLabs catalog — generation will fail until you re-add it or remove the preset."
          >
            unavailable
          </span>
          <button
            class="btn-icon"
            :disabled="!voice.voice_id || isVoicePresetUnavailable(voice.voice_id) || previewingVoiceId === voice.voice_id"
            :title="!voice.voice_id ? 'Enter a voice ID first' : isVoicePresetUnavailable(voice.voice_id) ? 'Voice unavailable in your ElevenLabs account' : (previewingVoiceId === voice.voice_id ? 'Stop preview' : 'Preview voice (1-sentence sample)')"
            @click="togglePreviewVoicePreset(voice.voice_id)"
          >
            {{ previewingVoiceId === voice.voice_id ? '◼' : '▶' }}
          </button>
          <button class="btn-icon danger" @click="editVoices.splice(i, 1)" title="Remove">&#10005;</button>
        </div>
      </div>

      <div class="flex gap-2 mt-2 items-center flex-wrap">
        <button class="btn btn-secondary btn-sm" @click="editVoices.push({ name: '', voice_id: '' })">
          + Add Voice
        </button>
        <button
          class="btn btn-secondary btn-sm"
          :disabled="catalogLoading"
          :title="catalogLoading ? 'Loading catalog…' : 'Pick from your ElevenLabs voices instead of pasting an ID'"
          @click="openCatalogPickerForPreset"
        >
          {{ catalogLoading ? 'Loading…' : '+ Add from catalog…' }}
        </button>
        <button class="btn btn-primary btn-sm" @click="saveVoices">Save Voice Presets</button>
        <SaveIndicator v-bind="savedHintProps('voices')" />
      </div>

      <!-- Catalog picker dialog — minimal flow: VoicePicker is reused, the
           emitted `update:modelValue` fills the next blank row (or appends
           one), and the dialog closes. -->
      <Modal v-if="showCatalogPicker" :visible="showCatalogPicker" size="md" labelledby="vp-add-from-catalog-title" @close="showCatalogPicker = false">
        <h3 id="vp-add-from-catalog-title">Add from your ElevenLabs catalog</h3>
        <p class="text-muted text-sm mt-1 mb-2">
          Pick any voice from your current ElevenLabs library — we'll fill the name and voice ID on a new preset row for you.
        </p>
        <VoicePicker
          v-model="pendingCatalogPick"
          :project-slug="slug"
          :custom-voices="[]"
          default-label="Pick a voice…"
        />
        <div class="flex gap-2 mt-3 justify-end">
          <button class="btn btn-secondary btn-sm" @click="showCatalogPicker = false">Cancel</button>
          <button
            class="btn btn-primary btn-sm"
            :disabled="!pendingCatalogPick"
            @click="confirmCatalogPick"
          >
            Add as preset
          </button>
        </div>
      </Modal>
    </div>

    <!-- Format -->
    <div v-if="activeTab === 'format'" class="card mt-2">
      <div class="format-tab-header">
        <div>
          <h3>Format</h3>
          <p class="text-muted mt-1 mb-2">
            <strong>Default for new projects is sleep-story.</strong>
            We ship 8 format presets — sleep-story, listicle, documentary,
            educational, comedy, adventure, true-crime, kids-fairytale.
            Pick one above, override fields per-project below, or create your
            own from a sample script via "+ Create from Sample".
            Built-in formats live in the app bundle; custom formats live alongside your
            projects and can be exported as <code>.json</code> files for sharing.
          </p>
        </div>
        <button class="btn btn-secondary btn-sm" @click="formatWizardOpen = true">
          + Create from Sample
        </button>
      </div>

      <FormatPicker v-model="formatId" @change="onFormatChanged" />

      <div class="mt-3">
        <FormatOverrideEditor
          v-model="formatOverrides"
          :base-format="selectedBaseFormat"
        />
      </div>

      <div class="mt-3 button-row">
        <button class="btn btn-primary" :disabled="formatSaving || !formatDirty" @click="saveFormatSettings">
          {{ formatSaving ? 'Saving…' : 'Save format settings' }}
        </button>
        <SaveIndicator v-bind="savedHintProps('format')" />
        <span v-if="formatSaveError" class="text-error">{{ formatSaveError }}</span>
      </div>

      <FormatFromSampleWizard
        :open="formatWizardOpen"
        :project-slug="slug"
        @close="formatWizardOpen = false"
        @saved="(id) => { formatId = id; formatOverrides = null; saveFormatSettings() }"
      />

      <!-- ── Patterns sub-section ─────────────────────────────────────── -->
      <!-- Lives inside the Format tab because patterns compose with formats —
           the user picks a format on the project + a pattern per-episode (or
           per-ideas-batch) on top. The card below mirrors the Format card's
           visual structure (header + help text + action button on the right). -->
      <div class="patterns-section mt-4">
        <div class="format-tab-header">
          <div>
            <h3>Patterns</h3>
            <p class="text-muted mt-1 mb-2">
              Patterns control title shape and body structure within a format
              (e.g. "Fall asleep to {X}", "History of {X} explained").
              <strong>We ship 8 presets.</strong> Pick one in the Script
              Generator or the Ideas Generator — or create your own here, either
              by hand or by extracting from a sample script.
            </p>
          </div>
          <div class="patterns-actions">
            <button class="btn btn-secondary btn-sm" @click="openNewPatternEditor">+ New Pattern</button>
            <button class="btn btn-secondary btn-sm" @click="patternWizardOpen = true">+ Extract from Sample</button>
          </div>
        </div>

        <div class="patterns-filter mt-2">
          <label class="filter-toggle">
            <input type="checkbox" v-model="patternsFilterToCurrent" />
            Show only patterns compatible with the current format
            <code v-if="patternsFilterToCurrent && formatId">({{ formatId }})</code>
          </label>
        </div>

        <div v-if="patternsLoading && !visiblePatterns.length" class="text-muted mt-2">Loading patterns…</div>
        <div v-else-if="!visiblePatterns.length" class="text-muted mt-2 empty-state">
          No patterns match the current filter.
          <button class="btn btn-ghost btn-sm" @click="patternsFilterToCurrent = false">Show all</button>
        </div>
        <div v-else class="pattern-grid mt-2">
          <div
            v-for="p in visiblePatterns"
            :key="p.id"
            class="pattern-card"
            :class="{ builtin: p.builtin }"
          >
            <div class="pat-card-head">
              <strong>{{ p.name }}</strong>
              <span class="pat-badge" :class="p.builtin ? 'badge-builtin' : 'badge-custom'">
                {{ p.builtin ? 'Built-in' : 'Custom' }}
              </span>
            </div>
            <div class="pat-card-template">
              <code>{{ p.titleTemplate }}</code>
              <span v-if="p.preferredFormats?.length" class="pat-card-formats">
                · {{ p.preferredFormats.join(', ') }}
              </span>
            </div>
            <p class="pat-card-desc">{{ p.description }}</p>
            <div class="pat-card-actions">
              <button
                class="btn btn-ghost btn-sm"
                :title="p.builtin ? 'Built-ins are read-only — copy as new to make changes.' : 'Edit pattern'"
                :disabled="p.builtin"
                @click="openEditPatternEditor(p)"
              >
                {{ p.builtin ? 'View only' : 'Edit' }}
              </button>
              <button
                class="btn btn-ghost btn-sm"
                title="Make a custom copy you can edit"
                @click="copyPatternAsNew(p)"
              >
                Copy as new
              </button>
              <button
                v-if="!p.builtin"
                class="btn btn-ghost btn-sm danger"
                @click="confirmDeletePattern(p)"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      </div>

      <PatternEditorModal
        :open="patternEditorOpen"
        :pattern="patternEditorTarget"
        @close="patternEditorOpen = false"
        @saved="onPatternSaved"
      />
      <PatternFromSampleWizard
        :open="patternWizardOpen"
        :project-slug="slug"
        @close="patternWizardOpen = false"
        @saved="onPatternSaved"
      />
    </div>

    <!-- Standards -->
    <div v-if="activeTab === 'standards'" class="card mt-2">
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
          <h3>Save {{ standardsSubTab === 'intro' ? 'intro' : 'standards' }} preset</h3>
          <p class="text-muted mt-1 mb-2" style="font-size:12px">Give this preset a name so you can reuse it across projects of the same style.</p>
          <input
            v-model="newPresetName"
            class="input"
            placeholder="e.g. Sleep Stories v2, Horror Narration"
            @keydown.enter="savePreset"
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
    <div v-if="activeTab === 'folders'" class="card mt-2">
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

    <!-- Assets tab moved to its own top-level page — see
         frontend/pages/projects/[slug]/assets.vue. The old tab content
         lived here before the extraction; delete-only refactor. -->

    <!-- Storage — per-episode disk usage + cleanup of uploaded final
         videos + external-root configuration. The pain point this
         tab solves: sleep stories produce 5-10 GB final videos that
         bog down iCloud sync. Once a video is on YouTube (sidecar
         shows video_id), the local copy is operationally redundant
         and can be deleted to reclaim disk. -->
    <div v-if="activeTab === 'storage'" class="card mt-2">
      <h3>Storage</h3>

      <!-- ── Cloud Sync Overview (top-of-tab indicator) ────────────────
           Surfaces all three storage subsystems with their current state
           and a 1-line description so users can scan it and know what's
           available + which warnings apply. Replaces the legacy
           "Cloud sync is paused" dashboard banner: that banner pointed
           at a feature that no longer exists; this card points at the
           feature that DID replace it. -->
      <div class="cloud-sync-overview">
        <div class="overview-head">
          <span class="overview-icon" aria-hidden="true">☁️</span>
          <div>
            <strong>Cloud sync overview</strong>
            <p class="overview-sub">
              Story Studio doesn't sync directly with iCloud/Dropbox/etc. —
              instead, you point it at a folder that your cloud provider
              already syncs, and the OS handles the rest. Three knobs below
              control where files land and how to free up space.
            </p>
          </div>
        </div>

        <div class="overview-grid">
          <a class="overview-card" href="#projects-root-section" @click.prevent="scrollTo('projects-root-section')">
            <div class="overview-card-head">
              <span class="overview-card-icon">📁</span>
              <strong>Projects folder</strong>
              <span :class="['overview-badge', projectsRoot?.is_overridden ? 'on' : 'off']">
                {{ projectsRoot?.is_overridden ? 'CUSTOM' : 'DEFAULT' }}
              </span>
            </div>
            <p class="overview-card-desc">
              {{ projectsRoot?.is_overridden
                ? 'Pointed at a custom path — typically a cloud-synced folder for cross-machine work.'
                : 'Lives in app data on this Mac only. Move it to iCloud Drive / Dropbox to work across machines.' }}
            </p>
            <code class="overview-card-path">{{ projectsRoot?.effective_path || '(loading)' }}</code>
          </a>

          <a class="overview-card" href="#external-video-section" @click.prevent="scrollTo('external-video-section')">
            <div class="overview-card-head">
              <span class="overview-card-icon">🎞</span>
              <strong>Final-video root</strong>
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
              <strong>Cleanup uploaded finals</strong>
              <span class="overview-badge info">
                {{ storage ? `${storage.episodes.filter(e => e.uploaded_to_youtube && e.bytes_final_video > 0).length} eligible` : 'unscanned' }}
              </span>
            </div>
            <p class="overview-card-desc">
              Once a final is uploaded to YouTube, the local copy is
              redundant and can be deleted to reclaim disk. Per-scene
              Veo / fal clips stay (they cost $$$ to regenerate).
            </p>
          </a>
        </div>

        <details class="overview-warnings">
          <summary>⚠ Limitations of cross-machine cloud sync</summary>
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
              <strong>5–10 GB final videos.</strong> Sleep stories produce
              huge final-video files. If you're on iCloud Drive with limited
              space, set the external final-video root above and/or use the
              cleanup button below.
            </li>
          </ul>
        </details>
      </div>

      <p class="text-muted mt-3 mb-2" style="font-size: 12px;">
        Below: the three knobs in detail. Click any card above to jump to
        its section, or scroll.
      </p>

      <!-- ── Projects storage location ──────────────────────────── -->
      <!-- Lets the user point the projects folder at any local path —
           typically inside iCloud Drive / Dropbox / Google Drive so
           the OS handles cross-machine sync. Per-machine setting
           (lives in app-settings.json which doesn't sync). -->
      <div id="projects-root-section" class="storage-section">
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
      <div id="external-video-section" class="storage-section storage-section--bordered">
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

      <!-- ── Per-episode storage breakdown ───────────────────────── -->
      <div id="per-episode-section" class="storage-section storage-section--bordered">
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

      <!-- ── Chunked-progress sidecars (v1.0.71+) ──────────────────── -->
      <!--
        Per-episode JSON sidecars that lib/chunked-narration.ts writes
        during long script generations to enable resume on cancel/crash.
        Once the unified narration is on disk with the expected chapter
        count, the sidecar has no further purpose — but we don't auto-
        delete (per user direction). This panel surfaces eligible
        sidecars and lets the user clean them up manually.
      -->
      <div id="chunked-sidecars-section" class="storage-section storage-section--bordered">
        <div class="flex items-center" style="justify-content: space-between; gap: 12px;">
          <div>
            <h4><span class="storage-section-icon" aria-hidden="true">🗑</span>Chunked-progress sidecars</h4>
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

      <!-- ── Legacy video_assembly preset migrator (v1.0.71+) ──────── -->
      <!--
        Pre-v1.0.64 video_assembly presets stored fields flat at the
        top of `data`. v1.0.68+ uses the bundle shape with five slot
        snapshots under `data.fallback.{intro,timeline,effects,subtitles,export}`.
        The runtime passthrough in pipeline.ts handles legacy shapes
        for batch runs, but the saved JSON stays in the old shape
        until explicitly migrated. Most users won't hit this — most
        new projects start clean. The button is here for projects
        that pre-date v1.0.64.
      -->
      <div id="legacy-preset-section" class="storage-section storage-section--bordered">
        <div class="flex items-center" style="justify-content: space-between; gap: 12px;">
          <div>
            <h4><span class="storage-section-icon" aria-hidden="true">📜</span>Legacy video assembly presets</h4>
            <p class="text-muted hint">
              Pre-v1.0.64 video assembly presets were saved with fields flat
              at the top of <code>data</code>; v1.0.68+ uses a bundle shape
              with five slot snapshots. The runtime passthrough handles
              legacy shapes for batch runs, but the saved JSON stays old.
              This button rewrites them in place.
            </p>
            <p class="text-muted voice-helper-line">
              💡 Safe to run any time. No-op if all your presets are already
              in the new shape — most new projects never hit this.
            </p>
          </div>
          <div class="flex gap-2">
            <button class="btn btn-secondary btn-sm" :disabled="legacyPresetScanLoading" @click="scanLegacyPresets">
              {{ legacyPresetScanLoading ? 'Scanning…' : (legacyPresetScan ? '↻ Rescan' : 'Scan') }}
            </button>
            <button
              class="btn btn-primary btn-sm"
              :disabled="!legacyPresetScan || legacyPresetMigrateRunning || legacyPresetScan.legacy_presets.length === 0"
              :title="!legacyPresetScan ? 'Run a scan first' : legacyPresetScan.legacy_presets.length === 0 ? 'All presets already in bundle shape' : `Rewrite ${legacyPresetScan.legacy_presets.length} preset(s) into the new bundle shape`"
              @click="migrateLegacyPresets"
            >
              {{ legacyPresetMigrateRunning
                ? 'Migrating…'
                : legacyPresetScan && legacyPresetScan.legacy_presets.length > 0
                  ? `Migrate ${legacyPresetScan.legacy_presets.length} preset(s)`
                  : 'Migrate' }}
            </button>
          </div>
        </div>

        <div v-if="legacyPresetScan" class="storage-summary mt-2">
          <span><strong>Total presets:</strong> {{ legacyPresetScan.total_presets }}</span>
          <span class="dot">·</span>
          <span><strong>Legacy shape:</strong> {{ legacyPresetScan.legacy_presets.length }}</span>
        </div>

        <div v-if="legacyPresetScan && legacyPresetScan.legacy_presets.length" class="storage-table mt-2">
          <div class="storage-row storage-head">
            <span class="col-code">Preset id</span>
            <span class="col-title">Name</span>
          </div>
          <div v-for="row in legacyPresetScan.legacy_presets" :key="row.id" class="storage-row">
            <span class="col-code"><strong>{{ row.id }}</strong></span>
            <span class="col-title">{{ row.name }}</span>
          </div>
        </div>

        <div v-if="lastLegacyMigrate" class="storage-result mt-2">
          <strong>Migration:</strong>
          {{ lastLegacyMigrate.migrated.length }} preset(s) rewritten.
          <span v-if="lastLegacyMigrate.skipped.length" class="error-text">{{ lastLegacyMigrate.skipped.length }} skipped.</span>
        </div>
      </div>
    </div>

    <!-- Confirmations -->
    <div v-if="activeTab === 'confirmations'" class="card mt-2">
      <h3>Generation Confirmations</h3>
      <p class="text-muted mt-1 mb-2">
        Choose which generators show a cost estimation dialog before starting. Disabled generators will skip the confirmation and start immediately.
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

    <!-- Performance -->
    <div v-if="activeTab === 'performance'" class="card mt-2">
      <h3>Image Generation Concurrency</h3>
      <p class="text-muted mt-1 mb-2">
        Number of image generation requests sent in parallel per job. Higher = faster, but providers have rate limits.
        Start at 5; raise cautiously if your provider allows. Lower if you see rate-limit errors.
      </p>
      <div class="form-group" style="max-width: 360px;">
        <label>Concurrency ({{ imageConcurrency }})</label>
        <SliderWithNumber v-model="imageConcurrency" :min="1" :max="10" :step="1" />
        <div class="flex gap-2 mt-1" style="font-size: 11px;">
          <span class="text-muted">1 (serial)</span>
          <span class="text-muted" style="margin-left:auto">10 (aggressive)</span>
        </div>
      </div>

      <div class="form-group mt-2" style="max-width: 360px;">
        <label>Launch stagger ({{ imageLaunchStaggerMs }} ms)</label>
        <SliderWithNumber v-model="imageLaunchStaggerMs" :min="0" :max="5000" :step="100" />
        <p class="text-muted mt-1" style="font-size: 12px;">
          Delays each parallel worker's first request by N×stagger so all
          {{ imageConcurrency }} workers don't hit the provider in the same
          millisecond. Set to <strong>0</strong> to disable.
          <strong>1000–2000 ms</strong> typically eliminates per-second 429s
          with no measurable throughput cost (only the first wave is delayed;
          rolling pool continues at full speed afterward).
        </p>
      </div>

      <!-- Audio (TTS) concurrency — default 3 matches ElevenLabs Starter -->
      <!-- tier's safe limit. fal.ai/GenAIPro handle backpressure via their -->
      <!-- queue APIs, so feel free to go higher on those providers. -->
      <h3 class="mt-3">Audio (TTS) Concurrency</h3>
      <p class="text-muted mt-1 mb-2">
        Parallel TTS requests per audio job. Default <strong>3</strong> — ElevenLabs tier limits:
        Free 2 · Starter 3 · Creator 5 · Pro 10 · Scale/Business 15. fal.ai and GenAIPro queue server-side, so higher is safe with a paid account.
      </p>
      <div class="form-group" style="max-width: 360px;">
        <label>Concurrency ({{ audioConcurrency }})</label>
        <SliderWithNumber v-model="audioConcurrency" :min="1" :max="15" :step="1" />
        <div class="flex gap-2 mt-1" style="font-size: 11px;">
          <span class="text-muted">1 (serial — slow)</span>
          <span class="text-muted" style="margin-left:auto">15 (Scale tier)</span>
        </div>
      </div>

      <div class="form-group mt-2" style="max-width: 360px;">
        <label>Launch stagger ({{ audioLaunchStaggerMs }} ms)</label>
        <SliderWithNumber v-model="audioLaunchStaggerMs" :min="0" :max="5000" :step="100" />
        <p class="text-muted mt-1" style="font-size: 12px;">
          Delays each TTS worker's first request by N×stagger to avoid bursty
          rate-limits at the start of a job. Set to <strong>0</strong> to
          disable. ElevenLabs is most sensitive to bursts at the Free/Starter
          tiers — try <strong>1000–1500 ms</strong> if you see 429s. fal.ai
          and GenAIPro queue server-side; stagger usually unnecessary there.
        </p>
      </div>

      <!-- Video concurrency — clips cost $0.50–$2 each so default is lower. -->
      <!-- fal.ai scales the concurrent-request limit from 2 to 40 as the -->
      <!-- account buys credits; 2 is the safe new-account default. -->
      <h3 class="mt-3">Video Concurrency</h3>
      <p class="text-muted mt-1 mb-2">
        Parallel video clip generations per job. Video clips are expensive (~$0.50–$2 each), so default <strong>2</strong> is conservative.
        fal.ai scales 2 → 40 with account credits; Veo via GenAIPro handles backpressure server-side.
      </p>
      <div class="form-group" style="max-width: 360px;">
        <label>Concurrency ({{ videoConcurrency }})</label>
        <SliderWithNumber v-model="videoConcurrency" :min="1" :max="8" :step="1" />
        <div class="flex gap-2 mt-1" style="font-size: 11px;">
          <span class="text-muted">1 (serial)</span>
          <span class="text-muted" style="margin-left:auto">8 (heavy)</span>
        </div>
      </div>

      <div class="form-group mt-2" style="max-width: 360px;">
        <label>Launch stagger ({{ videoLaunchStaggerMs }} ms)</label>
        <SliderWithNumber v-model="videoLaunchStaggerMs" :min="0" :max="5000" :step="100" />
        <p class="text-muted mt-1" style="font-size: 12px;">
          Delays each video worker's first submit by N×stagger. Veo / fal /
          Kie all rate-limit per-second submit attempts. Set to
          <strong>0</strong> to disable. <strong>1500–2500 ms</strong> is a
          safe starting point if you see 429s during video clip generation.
        </p>
      </div>

      <!-- TTS timeout: clients default to 20 min for GenAIPro, 5 min for -->
      <!-- fal.ai. A longer timeout avoids orphaning completed tasks whose -->
      <!-- results never got downloaded (GenAIPro keeps history only 1 day). -->
      <h3 class="mt-3">TTS Generation Timeout</h3>
      <p class="text-muted mt-1 mb-2">
        How long to wait for a single TTS chunk to complete on the provider's
        side before giving up. Leave blank to use the per-provider default
        (GenAIPro <strong>20 min</strong>, fal.ai <strong>5 min</strong>,
        ElevenLabs streams without a job timeout).
      </p>
      <div class="form-group" style="max-width: 420px;">
        <label>
          Timeout (minutes)
          <span class="field-hint">Blank = provider default · saved value persists across runs</span>
        </label>
        <input
          v-model.number="ttsTimeoutMinutes"
          type="number"
          min="1"
          max="120"
          step="1"
          class="input"
          :placeholder="ttsTimeoutPlaceholder"
          aria-label="TTS timeout in minutes"
        />
        <!-- "Currently active" chip — surfaces the effective timeout so
             the user sees what's actually in force, both before and
             after a save. Empty state shows the provider-default
             cascade; numeric state shows the override. -->
        <div class="meta-pill" :class="ttsTimeoutMinutes ? 'ok' : 'muted'" style="margin-top: 6px; font-size: 12px;">
          {{ ttsTimeoutActiveLabel }}
        </div>
        <span class="text-muted" style="font-size: 11px; display: block; margin-top: 6px;">
          Recommended: <strong>3–5 min</strong> for paragraph/scene-length
          chunks (ElevenLabs, fal.ai); <strong>10 min</strong> if you
          generate chapter-length GenAIPro tasks. <strong>1 min is too
          aggressive</strong> — many legitimate TTS calls take 30 s–2 min,
          so 1 min would fail healthy jobs. Higher values just keep a
          worker blocked longer on a genuinely stuck task before it gives up.
        </span>
      </div>

      <div class="flex gap-2 mt-2" style="align-items: center;">
        <button class="btn btn-primary" @click="savePerformance">Save Performance Settings</button>
        <SaveIndicator v-bind="savedHintProps('performance')" />
      </div>
    </div>

    <!-- Local TTS (Chatterbox) -->
    <div v-if="activeTab === 'local-tts'" class="card mt-2">
      <h3>Local TTS — Chatterbox (self-hosted)</h3>
      <p class="text-muted mt-1" style="font-size: 12px;">
        Generate narration using a Chatterbox TTS server running on your own
        machine (typically a Mac mini reached over Tailscale). No per-character
        cost, no upstream rate limits. Requires the server to be running and
        reachable. <a href="https://github.com/resemble-ai/chatterbox" target="_blank" rel="noopener" style="color: var(--accent);">Learn more →</a>
      </p>

      <div class="local-tts-row mt-3">
        <label class="local-tts-toggle">
          <input type="checkbox" v-model="chatterboxEnabledDraft" />
          <span><strong>Enable for this project</strong></span>
          <span class="text-muted" style="font-size: 11px; margin-left: 6px;">
            (When off, "Chatterbox – Default Voice" / "Chatterbox – Cloned Voice" are hidden from the audio model picker.)
          </span>
        </label>
      </div>

      <div class="local-tts-row mt-3">
        <label class="local-tts-label">Server URL (per machine)</label>
        <div class="local-tts-url-row">
          <input
            v-model="chatterboxBaseUrlDraft"
            type="text"
            class="input input-sm"
            :placeholder="chatterboxDefaultBaseUrl"
            spellcheck="false"
          />
          <button
            class="btn btn-sm btn-secondary"
            :disabled="chatterboxBaseUrlSaving"
            @click="saveChatterboxBaseUrl"
          >
            {{ chatterboxBaseUrlSaving ? 'Saving…' : 'Save URL' }}
          </button>
          <button
            class="btn btn-sm btn-secondary"
            :disabled="chatterboxTesting"
            @click="testChatterboxConnection"
          >
            {{ chatterboxTesting ? 'Testing…' : 'Test connection' }}
          </button>
        </div>
        <p class="text-muted mt-1" style="font-size: 11px;">
          Stored once per Mac (in app secrets), so moving this project to a
          machine without Tailscale won't carry a stale URL. Default:
          <code>{{ chatterboxDefaultBaseUrl }}</code>.
        </p>
        <div v-if="chatterboxTestResult" class="local-tts-pill mt-2" :class="{ ok: chatterboxTestResult.ok, err: !chatterboxTestResult.ok }">
          <span v-if="chatterboxTestResult.ok">
            ✓ Reachable
            <span v-if="chatterboxTestResult.device"> · device {{ chatterboxTestResult.device }}</span>
            <span v-if="chatterboxTestResult.modelLoaded === true"> · model loaded</span>
            <span v-else-if="chatterboxTestResult.modelLoaded === false"> · model not loaded yet</span>
            <span v-if="chatterboxTestResult.sampleRate"> · {{ chatterboxTestResult.sampleRate }} Hz</span>
          </span>
          <span v-else>
            ✗ {{ chatterboxTestResult.error || 'Unreachable' }}
          </span>
        </div>
      </div>

      <div class="local-tts-row mt-4">
        <label class="local-tts-label">Cloned voice reference (5–15 s clip)</label>
        <p class="text-muted" style="font-size: 11px; margin-top: 4px;">
          Upload a short, clean recording of the voice you want to clone. Used
          when you pick "Chatterbox – Cloned Voice" as the audio model. The
          file is sent to your local server and the returned reference id is
          stored on this project. One reference per project; uploading replaces.
        </p>
        <div class="local-tts-upload-row mt-2">
          <input
            ref="chatterboxFileInput"
            type="file"
            accept="audio/*"
            class="input input-sm"
            @change="onChatterboxReferenceFile"
          />
          <span v-if="chatterboxUploading" class="text-muted" style="font-size: 11px;">Uploading…</span>
        </div>
        <div v-if="chatterboxReferenceIdLocal" class="local-tts-current mt-2">
          <span class="text-muted" style="font-size: 11px;">Current reference id:</span>
          <code style="font-size: 11px;">{{ chatterboxReferenceIdLocal }}</code>
        </div>
      </div>

      <div class="flex gap-2 mt-3" style="align-items: center;">
        <button class="btn btn-primary" :disabled="chatterboxEnabledSaving" @click="saveChatterboxEnabled">
          {{ chatterboxEnabledSaving ? 'Saving…' : 'Save project settings' }}
        </button>
        <SaveIndicator v-bind="savedHintProps('chatterbox')" />
      </div>
    </div>

    <!-- FFmpeg -->
    <div v-if="activeTab === 'ffmpeg'" id="ffmpeg-section" class="card mt-2">
      <h3>FFmpeg</h3>
      <p class="text-muted mt-1" style="font-size: 12px;">
        FFmpeg is the engine behind Audio Assembly and Video Assembly — it concatenates
        narration chapters, mixes music, encodes the final MP4. Without it, those generators
        will refuse to start. The button below downloads a pre-built binary directly into the
        app's data folder; no admin password, no Homebrew, no Terminal needed.
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
          <span v-else class="badge badge-error">Not installed</span>
          <span v-if="ffmpegStatus.installed && ffmpegStatus.has_drawtext" class="badge badge-success">drawtext</span>
          <span v-if="ffmpegStatus.installed && !ffmpegStatus.has_drawtext" class="badge badge-warn">no drawtext</span>
          <span v-if="ffmpegStatus.installed && ffmpegStatus.has_libass" class="badge badge-success">libass</span>
          <span v-if="ffmpegStatus.installed && !ffmpegStatus.has_libass" class="badge badge-warn">no libass</span>
        </template>
      </div>
      <p v-if="ffmpegStatus?.installed && ffmpegStatus.path" class="text-muted mt-1" style="font-size: 11px;">
        Resolved path: <code>{{ ffmpegStatus.path }}</code>
      </p>
      <p v-if="ffmpegStatus?.installed && (!ffmpegStatus.has_drawtext || !ffmpegStatus.has_libass)" class="text-muted mt-1" style="font-size: 12px;">
        Your FFmpeg works but is missing optional filters: <strong>drawtext</strong> (text overlays)
        and/or <strong>libass</strong> (subtitle burn-in). The downloaded build below includes both.
      </p>

      <!-- One-click install. When a working FFmpeg is already detected,
           the install path is rarely useful — the bundled binary is what
           the app actually uses, and re-running the download just kicks
           off an unnecessary 80 MB hit. Collapse it behind a disclosure
           in that case. The full inline card stays visible when FFmpeg
           is genuinely missing OR while an install is in progress so
           the user can monitor it. -->
      <details
        :open="!ffmpegStatus?.installed || ffmpegInstalling"
        class="ffmpeg-install-block mt-2"
      >
        <summary
          v-if="ffmpegStatus?.installed && !ffmpegInstalling"
          class="ffmpeg-install-summary"
        >
          <span style="font-size: 13px;">Advanced: replace FFmpeg binary</span>
          <span class="text-muted" style="font-size: 11px;">
            (rarely needed — the bundled binary already works)
          </span>
        </summary>
        <h4 v-else style="margin: 0 0 8px 0;">One-click install</h4>
        <p class="text-muted" style="font-size: 12px; margin: 8px 0;">
          Downloads ffmpeg + ffprobe (~50 MB) from the official release mirror and installs them
          into the app's user-data folder. Safe to run multiple times. No admin password required.
        </p>
        <button
          class="btn btn-primary"
          @click="installFfmpeg"
          :disabled="ffmpegInstalling"
        >
          <span v-if="ffmpegInstalling">{{ ffmpegInstallMessage || 'Installing…' }} {{ ffmpegInstallProgress }}%</span>
          <span v-else-if="ffmpegStatus?.installed">Re-install / update FFmpeg</span>
          <span v-else>Install FFmpeg</span>
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
            <span v-if="ffmpegLogCopiedAt" class="text-muted" style="font-size: 11px;">Copied ✓</span>
          </div>
          <pre v-if="ffmpegInstallLog.length" class="ffmpeg-log-output mt-1">{{ ffmpegInstallLogText }}</pre>
          <p v-else-if="ffmpegInstallLogChecked" class="text-muted mt-1" style="font-size: 11px;">
            No ffmpeg-install entries in the last hour. The error may have happened before logging was wired up — try clicking Install again.
          </p>
        </div>
      </details>

      <!-- Manual install fallback -->
      <details class="ffmpeg-manual mt-3">
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
    <div v-if="activeTab === 'notifications'" class="card mt-2">
      <h3>Desktop notifications</h3>
      <p class="text-muted mt-1" style="font-size: 12px;">
        Pops a macOS / Windows notification when an overnight batch finishes
        or a long-running job completes, so you can walk away from the
        machine without silently missing the result. Clicking the
        notification focuses the app and jumps to the Jobs tab.
      </p>

      <!-- Enable/disable — single boolean, nested `notifications.enabled` in
           app-settings.json. Inline explanation calls out exactly what the
           notification shows, so the user knows what they're opting in to. -->
      <div class="form-group mt-2" style="max-width: 520px;">
        <label class="flex gap-2" style="align-items: center;">
          <input
            v-model="notifSettings.enabled"
            type="checkbox"
            @change="saveNotifSettings"
          />
          <span><strong>Enable desktop notifications</strong></span>
        </label>
        <span class="field-hint" style="display: block; margin-top: 4px;">
          When on, you'll see one notification per pipeline batch (e.g.
          <em>"Pipeline finished — 8/10 episodes succeeded. 2 failed. Elapsed 5h 12m."</em>)
          and one notification per long single job (e.g.
          <em>"Done: video_assembly — EP007 — 12m 40s"</em>). Queued and running
          jobs do not notify. Disable here to silence everything.
        </span>
      </div>

      <!-- Minimum duration — drives which non-batch jobs qualify as "long".
           Shown in minutes in the UI but stored in ms on disk (keeps the
           payload self-describing for scripts and future agents). Preview
           line echoes the effective threshold so the user can confirm their
           number landed correctly after tabbing out. -->
      <div class="form-group mt-3" style="max-width: 520px;">
        <label>
          Minimum duration for single-job notifications (minutes)
          <span class="field-hint">
            Only non-batch jobs running at least this long will notify — short
            fast jobs (e.g. a 30-second metadata regen) stay silent.
          </span>
        </label>
        <SliderWithNumber
          v-model="notifMinDurationMinutes"
          :min="1"
          :max="60"
          :step="1"
        />
        <div class="flex gap-2 mt-1" style="font-size: 11px;">
          <span class="text-muted">1 min (chatty)</span>
          <span class="text-muted" style="margin-left:auto">60 min (quiet)</span>
        </div>
        <span class="text-muted mt-1" style="display: block; font-size: 11px;">
          Effective threshold:
          <code>{{ notifMinDurationMinutes }} min</code>
          ({{ notifSettings.min_duration_ms.toLocaleString() }} ms).
          <span v-if="!notifSettings.enabled" style="color: var(--warn);">
            — currently disabled by the checkbox above.
          </span>
        </span>
      </div>

      <!-- Telegram channel (v1.0.60+). Independent of desktop — turn
           one off, the other still fires. The setup walkthrough is
           rendered as actionable numbered steps with buttons that
           open Telegram in a browser, paste in token + chat-id, and
           verify reachability — so the user never has to leave the
           settings page or read raw JSON. -->
      <div class="form-group mt-3" style="max-width: 600px;">
        <label class="flex gap-2" style="align-items: center;">
          <input
            v-model="notifSettings.telegram.enabled"
            type="checkbox"
            @change="saveNotifSettings"
          />
          <span><strong>Telegram notifications</strong></span>
        </label>
        <p class="text-muted" style="font-size: 12px; margin: 4px 0 0;">
          Sends the same batch / long-job pings to a Telegram chat — useful when you're away from this machine.
        </p>

        <!-- Step 1: open BotFather -->
        <div class="settings-step mt-2" style="border: 1px solid var(--border); border-radius: 6px; padding: 10px;">
          <div class="flex gap-2 items-center">
            <span class="step-number" style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%; background:var(--accent); color:#fff; font-size:11px; font-weight:600;">1</span>
            <strong style="font-size: 13px;">Create your bot</strong>
          </div>
          <p class="text-muted" style="font-size: 12px; margin: 6px 0 8px;">
            Click the button to open <code>@BotFather</code> in Telegram (or your browser).
            Send <code>/newbot</code>, follow the prompts (pick a name + username ending in <code>bot</code>),
            then copy the token BotFather gives you and paste below.
          </p>
          <div class="flex gap-2" style="align-items: center; flex-wrap: wrap;">
            <button
              type="button"
              class="btn btn-sm btn-secondary"
              @click="openExternal('https://t.me/BotFather')"
            >🤖 Open @BotFather</button>
            <span class="text-muted" style="font-size: 11px;">
              or copy this link:
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noopener"
                @click.prevent="openExternal('https://t.me/BotFather')"
                style="text-decoration: underline;"
              >https://t.me/BotFather</a>
            </span>
          </div>
        </div>

        <!-- Step 2: paste token -->
        <div class="settings-step mt-2" style="border: 1px solid var(--border); border-radius: 6px; padding: 10px;">
          <div class="flex gap-2 items-center">
            <span class="step-number" style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%; background:var(--accent); color:#fff; font-size:11px; font-weight:600;">2</span>
            <strong style="font-size: 13px;">Paste the bot token</strong>
          </div>
          <p class="text-muted" style="font-size: 12px; margin: 6px 0 8px;">
            BotFather replies with a token like <code>1234567890:ABCdefGHIjkl…</code>.
          </p>
          <input
            v-model="notifSettings.telegram.bot_token"
            type="text"
            class="input"
            placeholder="1234567890:ABCdef…"
            spellcheck="false"
            autocomplete="off"
            @change="saveNotifSettings"
          >
        </div>

        <!-- Step 3: send /start to your bot -->
        <div class="settings-step mt-2" style="border: 1px solid var(--border); border-radius: 6px; padding: 10px;">
          <div class="flex gap-2 items-center">
            <span class="step-number" style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%; background:var(--accent); color:#fff; font-size:11px; font-weight:600;">3</span>
            <strong style="font-size: 13px;">Send <code>/start</code> to your bot</strong>
          </div>
          <p class="text-muted" style="font-size: 12px; margin: 6px 0 8px;">
            Open Telegram, search your bot by the username you picked in step 1, and send any message
            (e.g. <code>/start</code> or just "hi"). This tells Telegram your bot is allowed to message you.
          </p>
          <p class="text-muted" style="font-size: 11px; margin: 0 0 8px;">
            Skip clicking the button below until you've done that — the next step pulls your chat id from the message you just sent.
          </p>
        </div>

        <!-- Step 4: detect chat id -->
        <div class="settings-step mt-2" style="border: 1px solid var(--border); border-radius: 6px; padding: 10px;">
          <div class="flex gap-2 items-center">
            <span class="step-number" style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%; background:var(--accent); color:#fff; font-size:11px; font-weight:600;">4</span>
            <strong style="font-size: 13px;">Detect your chat ID</strong>
          </div>
          <p class="text-muted" style="font-size: 12px; margin: 6px 0 8px;">
            Click the button below. The app reads your bot's recent messages and auto-fills your chat id.
            If it comes back empty, double-check that step 3 worked — Telegram only knows about chats that
            have actually messaged the bot.
          </p>
          <div class="flex gap-2 mt-1" style="align-items: center; flex-wrap: wrap;">
            <button
              type="button"
              class="btn btn-sm btn-primary"
              :disabled="telegramDetectBusy || !notifSettings.telegram.bot_token"
              @click="detectTelegramChatId"
            >{{ telegramDetectBusy ? 'Detecting…' : '🔍 Detect chat ID' }}</button>
            <span
              v-if="telegramDetectResult"
              :style="`font-size: 12px; color: ${telegramDetectResult.ok && telegramDetectResult.chat_id ? 'var(--success, #4ade80)' : 'var(--error, #f87171)'};`"
            >
              {{ telegramDetectResult.ok && telegramDetectResult.chat_id
                ? `✓ Found chat${telegramDetectResult.chat_label ? ' for ' + telegramDetectResult.chat_label : ''} — ID auto-filled below.`
                : `✕ ${telegramDetectResult.error || 'No chat found'}` }}
            </span>
          </div>
          <div class="form-group mt-2">
            <label>Chat ID</label>
            <input
              v-model="notifSettings.telegram.chat_id"
              type="text"
              class="input"
              placeholder="(auto-filled by the Detect button — or paste manually)"
              spellcheck="false"
              autocomplete="off"
              @change="saveNotifSettings"
            >
          </div>
        </div>

        <!-- Step 5: verify -->
        <div class="settings-step mt-2" style="border: 1px solid var(--border); border-radius: 6px; padding: 10px;">
          <div class="flex gap-2 items-center">
            <span class="step-number" style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%; background:var(--accent); color:#fff; font-size:11px; font-weight:600;">5</span>
            <strong style="font-size: 13px;">Send a test message</strong>
          </div>
          <p class="text-muted" style="font-size: 12px; margin: 6px 0 8px;">
            Confirms the bot can reach you. If you see the message in Telegram, you're done — every job
            completion ping from now on lands there too.
          </p>
          <div class="flex gap-2" style="align-items: center; flex-wrap: wrap;">
            <button
              type="button"
              class="btn btn-sm btn-primary"
              :disabled="telegramTestBusy || !notifSettings.telegram.bot_token || !notifSettings.telegram.chat_id"
              @click="testTelegram"
            >{{ telegramTestBusy ? 'Sending…' : '📨 Send test message' }}</button>
            <span
              v-if="telegramTestResult"
              :style="`font-size: 12px; color: ${telegramTestResult.ok ? 'var(--success, #4ade80)' : 'var(--error, #f87171)'};`"
            >
              {{ telegramTestResult.ok
                ? '✓ Test message sent. Check your Telegram.'
                : `✕ ${telegramTestResult.error || 'Send failed'}` }}
            </span>
          </div>
        </div>
      </div>

      <!-- Daily digest (v1.0.62+). Independent of per-event pings —
           this fires once per morning at the user's local time and
           summarises scheduling status across every project on the
           machine. Per-channel routing toggles live here so the user
           can route the digest to Telegram only (e.g.) while keeping
           desktop pop-ups for noisier per-event pings. -->
      <div class="form-group mt-3" style="max-width: 600px; border-top: 1px solid var(--border); padding-top: 12px;">
        <label class="flex gap-2" style="align-items: center;">
          <input
            v-model="notifSettings.digest.enabled"
            type="checkbox"
            @change="saveNotifSettings"
          />
          <span><strong>Daily digest</strong></span>
        </label>
        <p class="text-muted" style="font-size: 12px; margin: 4px 0 0;">
          Once-per-day summary with what's going live today, how much queue you have, and what's ready to upload.
          Pulls from your projects' existing scheduling data — no extra setup needed.
          Manual <strong>Send digest now</strong> below previews / tests without waiting for the schedule.
        </p>

        <div class="grid-2 mt-1" style="gap: 12px;">
          <div class="form-group">
            <label>Fire at (local time, 24h)</label>
            <input
              v-model="notifSettings.digest.time_local"
              type="time"
              class="input"
              :disabled="!notifSettings.digest.enabled"
              @change="saveNotifSettings"
            >
            <span class="text-muted text-xs">Default 09:00 — pick whatever lines up with when you start your day.</span>
          </div>
          <div class="form-group">
            <label>Last fired</label>
            <span class="text-muted text-xs" style="display: block; padding: 6px 0;">
              {{ notifSettings.digest.last_fired_date || '— never —' }}
            </span>
            <span class="text-muted text-xs">
              The scheduler skips fires for the same date so a quick app restart inside the fire window doesn't double-send.
            </span>
          </div>
        </div>

        <div class="form-group mt-1">
          <span style="display: block; margin-bottom: 4px; font-size: 12px;">Send digest to</span>
          <label class="checkbox-label flex gap-2" style="align-items: center; margin-right: 12px;">
            <input
              v-model="notifSettings.digest.desktop_enabled"
              type="checkbox"
              :disabled="!notifSettings.digest.enabled"
              @change="saveNotifSettings"
            />
            <span>Desktop pop-up</span>
          </label>
          <label class="checkbox-label flex gap-2" style="align-items: center;">
            <input
              v-model="notifSettings.digest.telegram_enabled"
              type="checkbox"
              :disabled="!notifSettings.digest.enabled"
              @change="saveNotifSettings"
            />
            <span>Telegram</span>
          </label>
          <span class="text-muted text-xs" style="display: block; margin-top: 4px;">
            Telegram routing only fires when the Telegram channel above is also configured + enabled.
          </span>
        </div>

        <div class="flex gap-2 mt-1" style="flex-wrap: wrap; align-items: center;">
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            :disabled="digestPreviewBusy"
            title="Show what the digest WOULD say right now without sending it anywhere"
            @click="loadDigestPreview"
          >{{ digestPreviewBusy ? 'Building…' : '👀 Preview digest body' }}</button>
          <button
            type="button"
            class="btn btn-sm btn-primary"
            :disabled="digestSendNowBusy"
            title="Send the digest right now to whichever channels are enabled above"
            @click="sendDigestNow"
          >{{ digestSendNowBusy ? 'Sending…' : '📨 Send digest now' }}</button>
          <span
            v-if="digestSendResult"
            :style="`font-size: 12px; color: ${digestSendResult.ok ? 'var(--success, #4ade80)' : 'var(--error, #f87171)'};`"
          >
            {{ digestSendResult.ok ? '✓ Digest sent.' : `✕ ${digestSendResult.reason || 'Send failed'}` }}
          </span>
        </div>

        <div v-if="digestPreview" class="mt-2" style="border: 1px solid var(--border); border-radius: 6px; padding: 10px; background: var(--surface-alt, #1a1a1a);">
          <strong style="font-size: 12px; display: block; margin-bottom: 6px;">{{ digestPreview.title }}</strong>
          <pre style="font-size: 11px; white-space: pre-wrap; margin: 0; font-family: var(--font-mono, monospace); color: var(--text-muted);">{{ digestPreview.body }}</pre>
        </div>
      </div>

      <!-- Live status indicator — confirms the last save actually hit disk
           and reminds the user this is an app-wide setting (not per-project),
           matching the wording in the Settings memory. The "Saving…" /
           error states are transient (in-flight feedback); the "Saved Xs
           ago" pill is persistent so a glance tells you the last edit
           landed even after the toast fades. -->
      <p class="text-muted mt-2" style="font-size: 11px;">
        Settings apply to every project on this machine and persist across
        app restarts. Saved automatically.
        <span v-if="notifSaveStatus === 'saving'">Saving…</span>
        <span v-else-if="notifSaveStatus === 'error'" style="color: var(--error);">Save failed — {{ notifSaveError }}</span>
      </p>
      <SaveIndicator v-bind="savedHintProps('notifications')" />
    </div>

    <!-- Named Roots -->
    <div v-if="activeTab === 'roots'" class="card mt-2">
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
              <td colspan="3" class="text-muted" style="font-size: 11px;">
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
        <span class="text-muted" style="font-size: 11px;">
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
    <div v-if="activeTab === 'project'" class="card mt-2">
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
          <span class="text-muted" style="font-size:11px">Season, Batch, Volume, Collection, etc.</span>
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
          <span class="text-muted" style="font-size: 11px;">
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
            <option :value="undefined">— Default (22 · People & Blogs) —</option>
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
            :placeholder="'22 (default — People & Blogs)'"
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
        <span class="text-muted" style="font-size: 11px;">
          <template v-if="ytCategoryHint">⚠ {{ ytCategoryHint }}</template>
          <template v-else-if="ytCategorySource">
            {{ ytCategorySource === 'live' ? 'Just fetched' : ytCategorySource === 'cache' ? 'From cache' : ytCategorySource === 'stale' ? 'Stale cache (fetch failed)' : 'Empty' }}
            · {{ ytCategoryList.length }} assignable categor{{ ytCategoryList.length === 1 ? 'y' : 'ies' }}
          </template>
          <template v-else>Click Refresh to load YouTube’s category list (cached 7 days).</template>
        </span>
      </div>

      <div class="form-group">
        <label>Brand <span class="text-muted" style="font-weight:normal">(channel-level identity — narrator persona, default voice, brand style keywords)</span></label>
        <div class="brand-picker">
          <select v-model="brandSelection" class="input" :disabled="brandsLoading">
            <option value="">— None (use literal defaults) —</option>
            <option v-for="b in availableBrands" :key="b.id" :value="b.id">{{ b.name }}</option>
          </select>
          <NuxtLink v-if="brandSelection" :to="`/brands/${brandSelection}`" class="btn btn-secondary btn-sm">
            Edit brand
          </NuxtLink>
          <NuxtLink to="/brands" class="btn btn-secondary btn-sm">Manage all brands…</NuxtLink>
        </div>
        <span v-if="brandSaveMessage" class="text-muted" style="font-size:11px">{{ brandSaveMessage }}</span>
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
               destination just for this one project (e.g. TerraNash to
               iCloud, Dozing Knight stays local). The destination is
               registered as a linked path so the slug keeps resolving
               after the move. -->
          <button
            class="btn btn-sm btn-secondary"
            :disabled="moveProjectDialogOpen || moveProjectMigrating"
            title="Move this project's folder to a different location (iCloud, an external drive, anywhere). Doesn't affect other projects. Choose whether to delete the source after a successful copy."
            @click="openMoveProjectDialog"
          >📦 Move this project to…</button>
        </div>
        <span class="text-muted" style="font-size:11px">
          Story Studio reads and writes all generated files here. Don't move this folder —
          if you do, use <strong>Repair Folder Structure</strong> below.
        </span>
        <p
          v-if="assetMigration.status.value && assetMigration.status.value.needed"
          class="text-muted mt-1"
          style="font-size:11px; max-width: 720px;"
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
           move. Powers the per-project "TerraNash to iCloud while
           Dozing Knight stays local" workflow. -->
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
          <p class="text-muted mt-1" style="font-size: 11px;">
            The project lands at <code class="path-display">{{ moveProjectDest ? moveProjectDest + '/' + (moveProjectStatus?.current_path?.split('/').pop() || project?.slug || '') : '(pick a destination first)' }}</code>.
          </p>

          <div
            v-if="moveProjectStatus?.icloud_blockers?.length"
            class="move-assets-blockers mt-2"
          >
            <strong>⛔ Blocked — fix before retrying:</strong>
            <p class="text-muted" style="font-size: 11px; margin: 4px 0;">
              {{ moveProjectStatus.icloud_blockers.length }} file(s) in this project are
              iCloud placeholders (not downloaded to this Mac). Right-click the project folder
              in Finder → "Download Now", wait for every file to lose the cloud icon, then retry.
            </p>
            <ul style="font-size: 11px; margin: 4px 0 0 18px; padding: 0;">
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
    <div v-if="activeTab === 'about'" class="card mt-2">
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
      <p class="text-muted mt-2" style="font-size:11px">
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
              <div v-if="reseasonState.preview.moves.length > 12" class="text-muted" style="font-size: 11px; padding: 4px 0;">
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
    const r = await post<{ path: string | null }>('/system/pick-folder', {
      title: 'Choose a destination folder for this project',
      buttonLabel: 'Use This Folder',
    })
    if (r?.path) moveProjectDest.value = r.path
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

const activeTab = ref('models')
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

// ── Format-from-sample wizard ──────────────────────────────────────────────
// Modal opened from the Format tab. Project-scoped because the LLM call uses
// this project's API keys; the saved format is app-level (lives in
// ${PROJECTS_ROOT}/.formats/) and shows up in every project's picker.
const formatWizardOpen = ref(false)

// ── Pattern management (sub-section of Format tab) ─────────────────────────
//
// Patterns are app-level (live in ${PROJECTS_ROOT}/.patterns/) but the
// extract-from-sample wizard is project-scoped because it uses the
// project's API keys. The list itself is shared — saving a pattern in
// one project makes it available in every project's picker.
import type { Pattern } from '~/composables/usePatterns'
const {
  patterns: allPatterns,
  isLoading: patternsLoading,
  compatibleWith: patternsCompatibleWith,
  remove: removePattern,
  refresh: refreshPatterns,
} = usePatterns()
const patternsFilterToCurrent = ref(true)
const patternEditorOpen = ref(false)
const patternEditorTarget = ref<Pattern | null>(null)
const patternWizardOpen = ref(false)

const visiblePatterns = computed<Pattern[]>(() => {
  if (!patternsFilterToCurrent.value) return allPatterns.value
  // compatibleWith returns patterns whose preferredFormats includes the
  // current format id OR has no preference at all. The latter is the
  // "this pattern is generic, applies anywhere" case — they always show.
  return patternsCompatibleWith(formatId.value)
})

function openNewPatternEditor() {
  patternEditorTarget.value = null
  patternEditorOpen.value = true
}

function openEditPatternEditor(p: Pattern) {
  if (p.builtin) return  // safety — button is disabled but guard regardless
  patternEditorTarget.value = p
  patternEditorOpen.value = true
}

/**
 * Open the editor pre-filled with this pattern's data but with id and
 * name suffixed " (copy)" + builtin=false so the user can save it as
 * their own custom variant. Solves "I love this built-in but want to
 * tweak the closing line" without making the user retype every field.
 */
function copyPatternAsNew(p: Pattern) {
  const copy: Pattern = {
    ...p,
    id: deriveCopyId(p.id),
    name: p.name.endsWith('(copy)') ? p.name : `${p.name} (copy)`,
    builtin: false,
    schemaVersion: 1,
  }
  patternEditorTarget.value = null  // create-mode (id field unlocked)
  // Stash the copy data via a quick re-open after the dialog mounts.
  // Simpler than threading a "prefill" prop through the editor: open
  // create-mode, then let the editor's reset-on-open hook fire, then
  // mutate target to populate it. Cleanest is just: pass the copy as
  // an "edit target" with builtin=false; the editor unlocks id when
  // the edit target's id matches an existing built-in (the create
  // path handles unlocked id naturally).
  patternEditorTarget.value = copy
  patternEditorOpen.value = true
}

function deriveCopyId(srcId: string): string {
  // Append `-copy` (or `-copy-2`, etc. if it collides). Cheap collision
  // check against the loaded list — server still validates.
  const base = `${srcId}-copy`
  if (!allPatterns.value.some(p => p.id === base)) return base
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`
    if (!allPatterns.value.some(p => p.id === candidate)) return candidate
  }
  return base
}

async function confirmDeletePattern(p: Pattern) {
  if (p.builtin) return
  if (!confirm(`Delete pattern "${p.name}"? This removes the file at .patterns/${p.id}.json.`)) return
  try {
    await removePattern(p.id)
  } catch (e: any) {
    alert(e?.data?.detail || e?.message || 'Failed to delete pattern')
  }
}

function onPatternSaved(_id: string) {
  patternEditorOpen.value = false
  patternWizardOpen.value = false
  // Composable refresh already fires inside save/update; this re-pings
  // in case the wizard's child save didn't propagate to our slot.
  refreshPatterns().catch(() => {})
}

// ── Format tab state ───────────────────────────────────────────────────────
//
// Per the Format primitive (Phase 1), each project carries:
//   - format_id: which base format profile to apply (defaults to 'sleep-story')
//   - format_overrides: deep-partial of the resolved Format applied on top
//
// We mirror those into local refs while editing so the user can swap formats
// or tweak overrides freely without persisting until they hit Save. Initial
// load syncs from project.value once useProject hydrates; the watcher below
// handles slug changes (project switcher in the sidebar).
const { formats: allFormats, find: findFormat, refresh: refreshFormats } = useFormats()
const formatId = ref<string>('sleep-story')
const formatOverrides = ref<Record<string, any> | null>(null)
const formatSaving = ref(false)
const formatSaveError = ref('')
// Track baseline values to compute "dirty" — comparing JSON for overrides is
// the cheapest correctness check (deep equality across nested objects).
const formatBaselineJson = ref<string>('null')
const formatIdBaseline = ref<string>('sleep-story')

const selectedBaseFormat = computed(() => findFormat(formatId.value) || null)
const formatDirty = computed(() => {
  if (formatId.value !== formatIdBaseline.value) return true
  return JSON.stringify(formatOverrides.value || null) !== formatBaselineJson.value
})

function syncFormatFromProject() {
  const m = project.value as any
  if (!m) return
  formatId.value = m.format_id || 'sleep-story'
  formatOverrides.value = m.format_overrides || null
  formatIdBaseline.value = formatId.value
  formatBaselineJson.value = JSON.stringify(formatOverrides.value || null)
}

// Hydrate when project meta arrives + on slug change.
watch(project, syncFormatFromProject, { immediate: true })

function onFormatChanged(_fmt: any) {
  // Switching format wipes the override set — overrides are keyed against
  // the base format's structure (narrator-style ids, field set), so carrying
  // them across format switches would silently apply mismatched values.
  formatOverrides.value = null
}

async function saveFormatSettings() {
  formatSaving.value = true
  formatSaveError.value = ''
  try {
    const body: any = {
      format_id: formatId.value,
      format_overrides: formatOverrides.value || undefined,
    }
    await put(`/projects/${slug.value}`, body)
    formatIdBaseline.value = formatId.value
    formatBaselineJson.value = JSON.stringify(formatOverrides.value || null)
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

// v1.0.71: legacy video_assembly preset migrator state. Most projects
// have zero legacy presets — the section quietly stays empty unless
// the user has older saves from before v1.0.64.
interface LegacyPresetScan {
  total_presets: number
  legacy_presets: Array<{ id: string; name: string }>
}
interface LegacyMigrateResult {
  migrated: Array<{ id: string; name: string }>
  skipped: Array<{ id: string; reason: string }>
}
const legacyPresetScan = ref<LegacyPresetScan | null>(null)
const legacyPresetScanLoading = ref(false)
const legacyPresetMigrateRunning = ref(false)
const lastLegacyMigrate = ref<LegacyMigrateResult | null>(null)

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
    const r = await post<{ path: string | null }>('/system/pick-folder', {
      title: 'Choose external final-video folder',
      buttonLabel: 'Use this folder',
      defaultPath: externalRootInput.value || undefined,
    })
    if (!r.path) return  // User cancelled the dialog.
    externalRootInput.value = r.path
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
  const ok = confirm(
    `Delete ${uploadedFinalsCount.value} uploaded final video file(s) (${formatBytes(uploadedFinalsTotalBytes.value)})?\n\n` +
    `This is safe — the YouTube sidecar keeps the pipeline view marking these as done. ` +
    `You can re-render any time from images + merged audio.`,
  )
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
    const ok = confirm(
      `${row.episode_code} is NOT confirmed uploaded to YouTube. ` +
      `Delete the local final video anyway?\n\n` +
      `If you delete this and the upload sidecar isn't present, the pipeline view will go back to showing "video assembly missing".`,
    )
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

// v1.0.71: legacy video_assembly preset migrator handlers. scan
// returns a list of preset ids in the legacy flat shape; migrate
// rewrites them in place. No-op when nothing to migrate.
async function scanLegacyPresets() {
  legacyPresetScanLoading.value = true
  try {
    legacyPresetScan.value = await get<LegacyPresetScan>(
      `/projects/${slug.value}/storage/legacy-video-assembly-presets`,
    )
    lastLegacyMigrate.value = null
  } catch (e: any) {
    alert(e?.data?.detail || e?.message || 'Legacy preset scan failed')
  } finally {
    legacyPresetScanLoading.value = false
  }
}

async function migrateLegacyPresets() {
  if (!legacyPresetScan.value || legacyPresetScan.value.legacy_presets.length === 0) return
  const ok = confirm(
    `Migrate ${legacyPresetScan.value.legacy_presets.length} legacy video assembly preset(s)?\n\n` +
    `Each preset's fields will be repackaged into the v1.0.68 bundle shape ` +
    `(slot snapshots under data.fallback). The runtime behaviour stays identical — ` +
    `this is purely a save-format normalisation. Safe to run.`,
  )
  if (!ok) return
  legacyPresetMigrateRunning.value = true
  try {
    lastLegacyMigrate.value = await post<LegacyMigrateResult>(
      `/projects/${slug.value}/storage/migrate-video-assembly-presets`,
      {},
    )
    // Rescan so the table updates (migrated rows drop out).
    await scanLegacyPresets()
  } catch (e: any) {
    alert(e?.data?.detail || e?.message || 'Legacy preset migration failed')
  } finally {
    legacyPresetMigrateRunning.value = false
  }
}

async function runMigration() {
  if (!externalRootInput.value) return
  const ok = confirm(
    `Move all final videos in this project to the external root?\n\n` +
    `${externalRootInput.value}\n\n` +
    `Project-tree files will be removed after a successful move. ` +
    `Detection still works for both locations, so the pipeline view stays accurate.`,
  )
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
  // Step 0: pick the destination via the native folder picker.
  let pick: { path: string | null }
  try {
    pick = await post<{ path: string | null }>('/system/pick-folder', {
      title: 'Choose where to store projects',
      buttonLabel: 'Use this folder',
      defaultPath: projectsRoot.value?.effective_path,
    })
  } catch (e: any) {
    projectsRootPickerHelp.value = pickerHelpFor(e)
    return
  }
  if (!pick.path) return  // User cancelled.

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
  let pick: { path: string | null }
  try {
    pick = await post<{ path: string | null }>('/system/pick-folder', {
      title: 'Choose existing projects folder',
      buttonLabel: 'Use this folder',
      defaultPath: projectsRoot.value?.effective_path,
    })
  } catch (e: any) {
    projectsRootPickerHelp.value = pickerHelpFor(e)
    return
  }
  if (!pick.path) return  // user cancelled

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

// ── Local TTS (Chatterbox) tab state ────────────────────────────────────
// Per-project enable + per-project cloned reference id come from `config`.
// The base URL itself is per-machine (app secrets bucket), fetched on tab
// mount via /chatterbox/base-url. Test connection hits the live server.
const chatterboxDefaultBaseUrl = ref('http://100.66.3.3:5052')
const chatterboxBaseUrlDraft = ref('')
const chatterboxBaseUrlSaving = ref(false)
const chatterboxTesting = ref(false)
const chatterboxTestResult = ref<{ ok: boolean; device?: string; modelLoaded?: boolean; sampleRate?: number; error?: string } | null>(null)
const chatterboxEnabledDraft = ref(false)
const chatterboxEnabledSaving = ref(false)
const chatterboxReferenceIdLocal = ref('')
const chatterboxUploading = ref(false)
const chatterboxFileInput = ref<HTMLInputElement | null>(null)

async function loadChatterboxBaseUrl() {
  try {
    const r = await get<{ baseUrl: string; defaultBaseUrl: string }>('/chatterbox/base-url')
    chatterboxBaseUrlDraft.value = r.baseUrl || r.defaultBaseUrl
    if (r.defaultBaseUrl) chatterboxDefaultBaseUrl.value = r.defaultBaseUrl
  } catch {
    chatterboxBaseUrlDraft.value = chatterboxDefaultBaseUrl.value
  }
}

async function saveChatterboxBaseUrl() {
  const url = chatterboxBaseUrlDraft.value.trim()
  if (!url) {
    showError('Server URL is required.')
    return
  }
  chatterboxBaseUrlSaving.value = true
  try {
    await put('/chatterbox/base-url', { baseUrl: url })
    success('Chatterbox URL saved.')
    chatterboxTestResult.value = null
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save URL')
  } finally {
    chatterboxBaseUrlSaving.value = false
  }
}

async function testChatterboxConnection() {
  chatterboxTesting.value = true
  chatterboxTestResult.value = null
  try {
    chatterboxTestResult.value = await post('/chatterbox/test', { baseUrl: chatterboxBaseUrlDraft.value.trim() })
  } catch (e: any) {
    chatterboxTestResult.value = { ok: false, error: e?.data?.detail || e?.message || 'Test failed' }
  } finally {
    chatterboxTesting.value = false
  }
}

async function saveChatterboxEnabled() {
  chatterboxEnabledSaving.value = true
  try {
    await put(`/projects/${slug.value}/settings/config`, { chatterbox_enabled: chatterboxEnabledDraft.value })
    stampSaved('chatterbox')
    success('Local TTS settings saved.')
    await refreshConfig()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save')
  } finally {
    chatterboxEnabledSaving.value = false
  }
}

async function onChatterboxReferenceFile(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  // Lightweight validation — duration check needs decoding which we skip
  // here (server enforces the 10MB cap); type check is enough for V1.
  if (!file.type.startsWith('audio/')) {
    showError('Please upload an audio file (wav/mp3/m4a/etc.).')
    input.value = ''
    return
  }
  chatterboxUploading.value = true
  try {
    const buf = await file.arrayBuffer()
    // FileReader.readAsDataURL would also work but base64-encoding the
    // ArrayBuffer is straightforward and avoids the Promise dance.
    const base64 = btoa(
      new Uint8Array(buf).reduce((acc, b) => acc + String.fromCharCode(b), ''),
    )
    const resp = await post<{ ok: boolean; referenceId: string }>(
      `/projects/${slug.value}/chatterbox/reference`,
      { filename: file.name, data_base64: base64 },
    )
    chatterboxReferenceIdLocal.value = resp.referenceId
    success(`Reference uploaded — id ${resp.referenceId.slice(0, 12)}…`)
    await refreshConfig()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Reference upload failed')
  } finally {
    chatterboxUploading.value = false
    if (chatterboxFileInput.value) chatterboxFileInput.value.value = ''
  }
}

// Hydrate from project config (per-project enable + reference id) and from
// the per-machine base URL endpoint whenever config arrives or slug changes.
watch(config, (c) => {
  const cfg = c as any
  chatterboxEnabledDraft.value = !!cfg?.chatterbox_enabled
  chatterboxReferenceIdLocal.value = cfg?.chatterbox_reference_id || ''
  // Item J — `projectForm.category_id` is hydrated in a later watch
  // (line ~3654) because projectForm is declared after this point and
  // `immediate: true` would TDZ-error here.
}, { immediate: true })

watch(activeTab, (t) => {
  if (t === 'local-tts' && !chatterboxBaseUrlDraft.value) {
    void loadChatterboxBaseUrl()
  }
  // Item J — lazy-load the YouTube category list when the user enters
  // the Project tab so the dropdown is populated without a click. Cached
  // 7d on the backend, so the cost is one extra fetch per session at
  // most (and usually zero — fully cache-served).
  if (t === 'project' && !ytCategoryList.value.length) {
    void loadYoutubeCategoryList()
  }
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

const tabs = [
  // API keys moved to app-level Settings (see /app-settings) — they're
  // per-machine now, not per-project.
  { id: 'models', label: 'Models' },
  { id: 'voices', label: 'Voices' },
  { id: 'format', label: 'Format' },
  { id: 'standards', label: 'Standards' },
  { id: 'folders', label: 'Folders' },
  // Storage tab — surfaces per-episode disk usage + safe cleanup of
  // already-uploaded final videos. Lives next to Folders since both
  // are file-system concerns.
  { id: 'storage', label: 'Storage' },
  // 'assets' moved out to its own top-level page at /projects/:slug/assets —
  // the tab was cramped in Settings and the repair flow deserves the space.
  { id: 'roots', label: 'Named Roots' },
  { id: 'confirmations', label: 'Confirmations' },
  { id: 'performance', label: 'Performance' },
  { id: 'local-tts', label: 'Local TTS' },
  { id: 'ffmpeg', label: 'FFmpeg' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'project', label: 'Project' },
  // About — version + build date so beta testers can quote the exact build
  // they're on. Last because it's reference-only, not configuration.
  { id: 'about', label: 'About' },
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
  if (h === '#ffmpeg') {
    activeTab.value = 'ffmpeg'
    refreshFfmpegStatus()
    nextTick(() => {
      document.getElementById('ffmpeg-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return
  }
  // Generic hash → tab map. Anything that matches a tab id auto-switches
  // (e.g. `#format` from the Ideas page's "Switch" link, `#about` from
  // "Copy version" links, etc.). Unrecognised hashes leave activeTab alone.
  if (h.startsWith('#')) {
    const target = h.slice(1)
    if (tabs.some(t => t.id === target)) activeTab.value = target
  }
}
onMounted(() => {
  applyHash()
  if (activeTab.value === 'ffmpeg') refreshFfmpegStatus()
  loadNotifSettings()
  // The Ideas Generator's "+ New custom format" CTA lands here with
  // ?newFormat=1#format and expects the format-from-sample wizard to
  // auto-open so the user doesn't have to hunt for the button.
  if (_route.query.newFormat === '1' && activeTab.value === 'format') {
    nextTick(() => { formatWizardOpen.value = true })
  }
})
watch(() => _route.hash, applyHash)

// ── Notifications tab (app-level, not per-project) ─────────────────────
// Backed by `/api/app-settings/notifications`. We debounce the save on
// slider drags so one gesture doesn't burn a PUT per integer tick.
interface TelegramConfigUI { enabled: boolean; bot_token: string; chat_id: string }
interface DigestConfigUI {
  enabled: boolean
  time_local: string
  desktop_enabled: boolean
  telegram_enabled: boolean
  last_fired_date?: string
}
interface NotifSettings {
  enabled: boolean
  min_duration_ms: number
  telegram: TelegramConfigUI
  digest: DigestConfigUI
}
const notifSettings = ref<NotifSettings>({
  enabled: true,
  min_duration_ms: 300_000,
  telegram: { enabled: false, bot_token: '', chat_id: '' },
  digest: { enabled: false, time_local: '09:00', desktop_enabled: true, telegram_enabled: true },
})
const notifSaveStatus = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')
const notifSaveError = ref('')
const notifMinDurationMinutes = computed({
  get: () => Math.max(1, Math.round(notifSettings.value.min_duration_ms / 60_000)),
  set: (v: number) => {
    const m = Math.max(1, Math.min(60, Math.round(Number(v) || 1)))
    notifSettings.value.min_duration_ms = m * 60_000
    scheduleNotifSave()
  },
})
async function loadNotifSettings() {
  try {
    const r = await get<NotifSettings>('/app-settings/notifications')
    // Backend may omit telegram or digest on legacy installs — keep
    // the UI pre-populated with empty defaults so v-model bindings
    // don't break when reading nested fields.
    notifSettings.value = {
      enabled: !!r.enabled,
      min_duration_ms: typeof r.min_duration_ms === 'number' ? r.min_duration_ms : 300_000,
      telegram: r.telegram
        ? {
            enabled: !!r.telegram.enabled,
            bot_token: r.telegram.bot_token || '',
            chat_id: r.telegram.chat_id || '',
          }
        : { enabled: false, bot_token: '', chat_id: '' },
      digest: r.digest
        ? {
            enabled: !!r.digest.enabled,
            time_local: r.digest.time_local || '09:00',
            desktop_enabled: r.digest.desktop_enabled !== false,
            telegram_enabled: r.digest.telegram_enabled !== false,
            last_fired_date: r.digest.last_fired_date,
          }
        : { enabled: false, time_local: '09:00', desktop_enabled: true, telegram_enabled: true },
    }
  } catch { /* leave defaults */ }
}
let notifSaveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleNotifSave() {
  if (notifSaveTimer) clearTimeout(notifSaveTimer)
  notifSaveTimer = setTimeout(saveNotifSettings, 250)
}
async function saveNotifSettings() {
  if (notifSaveTimer) { clearTimeout(notifSaveTimer); notifSaveTimer = null }
  notifSaveStatus.value = 'saving'
  try {
    const saved = await put<NotifSettings>('/app-settings/notifications', {
      enabled: notifSettings.value.enabled,
      min_duration_ms: notifSettings.value.min_duration_ms,
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
      },
    })
    // Re-normalise (same shape as loadNotifSettings) — the backend may
    // have trimmed bot_token / chat_id whitespace.
    notifSettings.value = {
      enabled: !!saved.enabled,
      min_duration_ms: typeof saved.min_duration_ms === 'number' ? saved.min_duration_ms : 300_000,
      telegram: saved.telegram
        ? {
            enabled: !!saved.telegram.enabled,
            bot_token: saved.telegram.bot_token || '',
            chat_id: saved.telegram.chat_id || '',
          }
        : { enabled: false, bot_token: '', chat_id: '' },
      digest: saved.digest
        ? {
            enabled: !!saved.digest.enabled,
            time_local: saved.digest.time_local || '09:00',
            desktop_enabled: saved.digest.desktop_enabled !== false,
            telegram_enabled: saved.digest.telegram_enabled !== false,
            last_fired_date: saved.digest.last_fired_date,
          }
        : { enabled: false, time_local: '09:00', desktop_enabled: true, telegram_enabled: true },
    }
    notifSaveStatus.value = 'saved'
    stampSaved('notifications')
  } catch (e: any) {
    notifSaveError.value = e?.data?.detail || e?.message || 'Unknown error'
    notifSaveStatus.value = 'error'
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
    // Auto-fill the chat_id field on success so the user doesn't
    // copy/paste numbers between fields. Save immediately too —
    // no point making them click into the input + tab out to commit.
    if (r.ok && r.chat_id) {
      notifSettings.value.telegram.chat_id = r.chat_id
      saveNotifSettings()
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
  { id: 'production', label: 'Production Standards' },
  { id: 'intro', label: 'Intro Format' },
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
    title: 'Production Standards',
    description: 'These guidelines are included in AI prompts when generating scripts, ideas, and descriptions. Write them once here, then refine in any chatbot and paste the result back.',
    placeholder: 'Describe the tone, pacing, and rules for this project…',
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
   * default (22 · People & Blogs).
   */
  category_id: number | undefined
}>({ name: '', episode_prefix: '', season_prefix: 'Season', season_size: 20, youtube_channel_url: '', category_id: undefined })

// ── Brand picker ───────────────────────────────────────────────────────────
// Brand sits above Format in the resolution chain (channel-level identity).
// Selection is saved immediately via PUT /api/projects/:slug/brand so the
// dropdown behaves like an inline setting, not a form submission.
const { brands: availableBrands, loadAll: loadAllBrands, setProjectBrand } = useBrands()
const brandsLoading = ref(false)
const brandSelection = ref<string>('')
const brandSaveMessage = ref<string>('')
let brandSelectionInitialized = false

async function refreshBrandPicker() {
  brandsLoading.value = true
  try { await loadAllBrands() } finally { brandsLoading.value = false }
}

watch(project, async (p) => {
  if (!p) return
  await refreshBrandPicker()
  // Only set the initial value once — subsequent project re-fetches must
  // not stomp the user's in-progress selection.
  if (!brandSelectionInitialized) {
    brandSelection.value = (p as any).brand_id || ''
    brandSelectionInitialized = true
  }
}, { immediate: true })

watch(brandSelection, async (next, prev) => {
  if (!brandSelectionInitialized) return
  if (next === prev) return
  brandSaveMessage.value = 'Saving…'
  try {
    await setProjectBrand(slug.value, next || null)
    brandSaveMessage.value = next ? 'Brand assigned' : 'Brand cleared'
    setTimeout(() => { brandSaveMessage.value = '' }, 2500)
  } catch (e: any) {
    brandSaveMessage.value = e?.data?.detail || e?.message || 'Failed to save brand selection'
    // Roll back the visible value so the dropdown matches what's persisted.
    brandSelection.value = prev || ''
  }
})
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
// `group: 'generation'` → cost-estimate dialogs before paid generators.
// `group: 'action'` → everyday action dialogs (Open in Finder, etc.)
// that don't cost money but still deserve a guardrail the user can
// disable once they've decided they trust it. Both live in the same
// `confirmation_preferences` map so one Save button covers all rows.
const confirmGenerators = [
  { key: 'script', label: 'Scripts', description: 'Episode script generation', group: 'generation' },
  { key: 'scene_prompts', label: 'Scene Prompts', description: 'Scene image prompt generation', group: 'generation' },
  { key: 'thumb_prompts', label: 'Thumbnail Prompts', description: 'Thumbnail image prompt generation', group: 'generation' },
  { key: 'scene_images', label: 'Scene Images', description: 'Scene image generation via kie.ai', group: 'generation' },
  { key: 'thumb_images', label: 'Thumbnail Images', description: 'Thumbnail image generation via kie.ai', group: 'generation' },
  { key: 'audio', label: 'Audio', description: 'TTS narration via fal.ai', group: 'generation' },
  { key: 'description', label: 'Description', description: 'YouTube description generation', group: 'generation' },
  { key: 'video', label: 'Video', description: 'Video assembly via FFmpeg', group: 'generation' },
  { key: 'reveal_folder', label: 'Open in Finder', description: 'Confirm before opening a folder in Finder / File Explorer', group: 'action' },
]
const confirmGenerationRows = computed(() => confirmGenerators.filter(g => g.group === 'generation'))
const confirmActionRows = computed(() => confirmGenerators.filter(g => g.group === 'action'))
const confirmPrefs = reactive<Record<string, boolean>>({})

// Editable copies of config data
const editImageModels = ref<Record<string, any>>({})
const editAudioModels = ref<Record<string, any>>({})
const editVideoModels = ref<Record<string, any>>({})
const editVoices = ref<Array<{ name: string; voice_id: string }>>([])

// ── Voice catalog probe (Settings → Voices tab) ─────────────────────────
// We pull the live ElevenLabs catalog once when the user opens this tab so
// we can grey out saved presets that are no longer in their account
// (deleted upstream, subscription lapsed). Loaded lazily — not on every
// settings open — to avoid a wasted fetch on users who never visit this tab.
interface VoiceCatalogVoice { voice_id: string; name: string; category?: string }
const voiceCatalogIds = ref<Set<string>>(new Set())
const catalogLoading = ref(false)
const catalogLoadError = ref('')
const catalogLoadedOnce = ref(false)

async function loadVoiceCatalogForSettings() {
  if (catalogLoadedOnce.value || catalogLoading.value) return
  catalogLoading.value = true
  catalogLoadError.value = ''
  try {
    const data = await get<{ voices: VoiceCatalogVoice[]; source: string }>(
      `/projects/${slug.value}/voices/catalog`,
    )
    // Snapshot source can't tell us about cloned voices the user owns —
    // skip the availability check in that case (treat all as available).
    if (data.source === 'snapshot') {
      voiceCatalogIds.value = new Set()  // empty set → isVoicePresetUnavailable always false
    } else {
      voiceCatalogIds.value = new Set(data.voices.map(v => v.voice_id))
    }
    catalogLoadedOnce.value = true
  } catch (e: any) {
    catalogLoadError.value = e?.data?.detail || e?.message || 'Network error'
  } finally {
    catalogLoading.value = false
  }
}

function isVoicePresetUnavailable(voiceId: string): boolean {
  if (!voiceId) return false
  // While loading or if the catalog isn't usable, optimistic — don't
  // flash "unavailable" on every preset for several seconds.
  if (catalogLoading.value || !catalogLoadedOnce.value) return false
  if (voiceCatalogIds.value.size === 0) return false  // snapshot or empty
  return !voiceCatalogIds.value.has(voiceId)
}

// Per-row preview for saved voice presets. Reuses the same /preview-voice
// endpoint Audio Generator uses, with sensible TTS defaults so the user
// can audition a saved voice without leaving Settings.
const previewingVoiceId = ref<string>('')
const previewAudioEl = ref<HTMLAudioElement | null>(null)

function stopVoicePreview() {
  if (previewAudioEl.value) {
    previewAudioEl.value.pause()
    previewAudioEl.value = null
  }
  previewingVoiceId.value = ''
}

async function togglePreviewVoicePreset(voiceId: string) {
  if (!voiceId) return
  if (previewingVoiceId.value === voiceId) {
    stopVoicePreview()
    return
  }
  stopVoicePreview()
  previewingVoiceId.value = voiceId
  try {
    const resp = await post<{ audio_url?: string }>(
      `/projects/${slug.value}/preview-voice`,
      { voice_id: voiceId, model: 'turbo-v2.5', speed: 1.0, stability: 0.5, similarity: 0.75 },
    )
    if (!resp?.audio_url) {
      throw new Error('No audio returned')
    }
    const audio = new Audio(resp.audio_url)
    audio.addEventListener('ended', () => { stopVoicePreview() })
    audio.addEventListener('error', () => {
      stopVoicePreview()
      showError('Voice preview audio failed to load — the voice may be unavailable in your ElevenLabs account.')
    })
    previewAudioEl.value = audio
    await audio.play().catch((err) => {
      console.error('[settings/voices] preview play failed:', err)
      stopVoicePreview()
      showError(`Couldn't play preview for ${voiceId.slice(0, 8)}… — see console for details.`)
    })
  } catch (e: any) {
    console.error('[settings/voices] preview request failed:', e)
    stopVoicePreview()
    showError(e?.data?.detail || `Voice preview failed for ${voiceId.slice(0, 8)}…`)
  }
}

// "+ Add from catalog…" flow. The picker writes the picked voice_id to
// `pendingCatalogPick`; confirmCatalogPick then resolves it against the
// loaded catalog to fill name + voice_id on a new preset row.
const showCatalogPicker = ref(false)
const pendingCatalogPick = ref<string | null>(null)
const lastCatalogVoices = ref<VoiceCatalogVoice[]>([])

async function openCatalogPickerForPreset() {
  // Make sure we have catalog data so confirmCatalogPick can resolve names.
  // The picker itself fetches independently, but we need the same data
  // here for the name lookup on confirm.
  if (!catalogLoadedOnce.value) {
    catalogLoading.value = true
    try {
      const data = await get<{ voices: VoiceCatalogVoice[]; source: string }>(
        `/projects/${slug.value}/voices/catalog`,
      )
      lastCatalogVoices.value = data.voices || []
      voiceCatalogIds.value = new Set(lastCatalogVoices.value.map(v => v.voice_id))
      catalogLoadedOnce.value = true
    } catch (e: any) {
      catalogLoadError.value = e?.data?.detail || e?.message || 'Network error'
      showError('Could not load ElevenLabs catalog — paste a voice ID manually instead.')
      catalogLoading.value = false
      return
    } finally {
      catalogLoading.value = false
    }
  }
  pendingCatalogPick.value = null
  showCatalogPicker.value = true
}

function confirmCatalogPick() {
  const id = pendingCatalogPick.value
  if (!id) return
  // Look up the name in the cached catalog. If we missed it (cache was
  // empty at fetch time), fall back to the id as the name — user can
  // rename inline before saving.
  const found = lastCatalogVoices.value.find(v => v.voice_id === id)
  const name = found?.name || id.slice(0, 12) + '…'
  // If there's an empty trailing row, fill that — otherwise append.
  const last = editVoices.value[editVoices.value.length - 1]
  if (last && !last.name && !last.voice_id) {
    last.name = name
    last.voice_id = id
  } else {
    editVoices.value.push({ name, voice_id: id })
  }
  showCatalogPicker.value = false
  pendingCatalogPick.value = null
  success(`Added "${name}" — remember to hit Save below.`)
}

// Trigger catalog probe when the user lands on the voices tab.
watch(activeTab, (tab) => {
  if (tab === 'voices') {
    void loadVoiceCatalogForSettings()
  } else if (previewingVoiceId.value) {
    // Stop any in-flight preview when leaving the tab.
    stopVoicePreview()
  }
})

onUnmounted(() => stopVoicePreview())

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
    const data = await post<{ path: string | null }>('/system/pick-folder', {})
    if (data?.path) newRootPath.value = data.path
  } catch (e: any) {
    showError(e.data?.detail || 'Could not open folder picker')
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
    editImageModels.value = JSON.parse(JSON.stringify(c.image_models || {}))
    editAudioModels.value = JSON.parse(JSON.stringify(c.audio_models || {}))
    editVideoModels.value = JSON.parse(JSON.stringify((c as any).video_models || {}))
    editVoices.value = JSON.parse(JSON.stringify(c.voice_presets || []))
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

// ── Performance (image / audio / video concurrency + TTS timeout) ───────
const imageConcurrency = ref(5)
const audioConcurrency = ref(3)   // ElevenLabs Starter-tier safe default
const videoConcurrency = ref(2)   // fal.ai new-account safe default
// Launch stagger (ms) per modality. 0 = no stagger (default behaviour).
// Non-zero values delay each pool worker's FIRST task by index*stagger to
// smooth the initial-burst submit that triggers per-second 429s.
const imageLaunchStaggerMs = ref(0)
const audioLaunchStaggerMs = ref(0)
const videoLaunchStaggerMs = ref(0)
// Empty string means "use provider default" (no override stored). We keep
// the empty state distinct from 0 so users can clear it without saving 0.
const ttsTimeoutMinutes = ref<number | ''>('')

// Placeholder + status chip — surface the effective state so the user
// always knows what's in force. Empty input = provider-default cascade
// (the most common case for new projects); numeric input = explicit
// override. Without this, "blank" looked indistinguishable from "I
// haven't loaded yet" right after a save.
const ttsTimeoutPlaceholder = computed(() =>
  'e.g. 5 (leave blank for provider default)',
)
const ttsTimeoutActiveLabel = computed(() => {
  const t = ttsTimeoutMinutes.value
  if (typeof t === 'number' && t > 0) return `Active: ${t} min override (applies to every TTS provider)`
  return 'Active: provider default — GenAIPro 20 min · fal.ai 5 min · ElevenLabs streams'
})
watch(config, (c) => {
  if (c && (c as any).image_concurrency) {
    imageConcurrency.value = Math.max(1, Math.min(10, Number((c as any).image_concurrency) || 5))
  }
  if (c && (c as any).audio_concurrency) {
    audioConcurrency.value = Math.max(1, Math.min(15, Number((c as any).audio_concurrency) || 3))
  }
  if (c && (c as any).video_concurrency) {
    videoConcurrency.value = Math.max(1, Math.min(8, Number((c as any).video_concurrency) || 2))
  }
  // Stagger values default to 0 when unset; clamp 0..5000 to match backend.
  imageLaunchStaggerMs.value = Math.max(0, Math.min(5000,
    Number((c as any)?.image_launch_stagger_ms) || 0))
  audioLaunchStaggerMs.value = Math.max(0, Math.min(5000,
    Number((c as any)?.audio_launch_stagger_ms) || 0))
  videoLaunchStaggerMs.value = Math.max(0, Math.min(5000,
    Number((c as any)?.video_launch_stagger_ms) || 0))
  const t = (c as any)?.generation_timeouts?.tts_minutes
  ttsTimeoutMinutes.value = typeof t === 'number' && t > 0 ? t : ''
}, { immediate: true })

async function savePerformance() {
  try {
    const body: Record<string, any> = {
      image_concurrency: imageConcurrency.value,
      audio_concurrency: audioConcurrency.value,
      video_concurrency: videoConcurrency.value,
      image_launch_stagger_ms: imageLaunchStaggerMs.value,
      audio_launch_stagger_ms: audioLaunchStaggerMs.value,
      video_launch_stagger_ms: videoLaunchStaggerMs.value,
    }
    // Only persist the timeout when the user set one. An empty field means
    // "use the provider default" — store null so we don't accumulate stale
    // overrides in project configs.
    const t = ttsTimeoutMinutes.value
    body.generation_timeouts = {
      tts_minutes: typeof t === 'number' && t > 0 ? Math.round(t) : null,
    }
    await put(`/projects/${slug.value}/settings/config`, body)
    await refreshConfig(slug.value)
    stampSaved('performance')
    success('Performance settings saved')
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to save performance settings')
  }
}

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

async function saveAudioPricing() {
  try {
    await put(`/projects/${slug.value}/settings/config`, { audio_models: editAudioModels.value })
    await refreshConfig(slug.value)
    stampSaved('audio_pricing')
    success('Audio pricing saved!')
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to save')
  }
}

async function saveVideoPricing() {
  try {
    await put(`/projects/${slug.value}/settings/config`, { video_models: editVideoModels.value })
    await refreshConfig(slug.value)
    stampSaved('video_pricing')
    success('Video pricing saved!')
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to save')
  }
}

// ── Custom model CRUD (Delivery 4) ───────────────────────────────────────
// The canonical write path: compose the updated unified models[] array and
// PUT /settings/config — the backend's updateConfig splits it via fromUnified()
// so the legacy image_models/audio_models/video_models dicts (which generators
// still read) stay in lockstep.
interface UnifiedModel {
  id: string
  provider: string
  type: 'image' | 'audio' | 'video' | 'text'
  label: string
  is_custom?: boolean
  params: Record<string, any>
}

async function writeUnifiedModels(next: UnifiedModel[], msg: string) {
  try {
    await put(`/projects/${slug.value}/settings/config`, { models: next })
    await refreshConfig(slug.value)
    success(msg)
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to save custom model changes')
  }
}

async function addCustomModel(model: UnifiedModel) {
  const existing = ((config.value as any)?.models || []) as UnifiedModel[]
  // Id collisions were warned about in the form but not blocked — when the
  // user saves anyway we override the earlier entry rather than duplicating.
  const filtered = existing.filter(m => !(m.id === model.id && m.type === model.type))
  await writeUnifiedModels([...filtered, model], `Added custom ${model.type} model "${model.label}"`)
}

async function removeCustomModel(type: UnifiedModel['type'], id: string) {
  const ok = await ask({
    title: `Remove custom model "${id}"?`,
    message: 'This only removes the entry from this project — other projects keep their own copies.',
    confirmLabel: 'Remove model',
    danger: true,
  })
  if (!ok) return
  const existing = ((config.value as any)?.models || []) as UnifiedModel[]
  const next = existing.filter(m => !(m.id === id && m.type === type && m.is_custom))
  await writeUnifiedModels(next, `Removed custom ${type} model`)
}

async function saveVoices() {
  const valid = editVoices.value.filter(v => v.name && v.voice_id)
  try {
    await put(`/projects/${slug.value}/settings/config`, { voice_presets: valid })
    await refreshConfig(slug.value)
    stampSaved('voices')
    success('Voice presets saved!')
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
    const { category_id, season_size: _droppedSize, ...projectMeta } = projectForm as any
    if (seasonSizeChanged.value) {
      // Reset the input to the server value so the Rebalance button's
      // "differs from server" gate doesn't keep firing after save.
      projectForm.season_size = serverSeasonSize.value
      info('Episodes per Group not saved — use the ↻ Rebalance button next to the field to apply size changes.')
    }
    await put(`/projects/${slug.value}`, projectMeta)
    await put(`/projects/${slug.value}/settings/config`, { category_id: typeof category_id === 'number' && category_id > 0 ? category_id : undefined })
    await loadProject(slug.value)
    if (typeof refreshConfig === 'function') await refreshConfig()
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
/* ── Brand picker (Project tab) ────────────────────────────────────────── */
.brand-picker {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.brand-picker .input { flex: 1; min-width: 200px; }

/* ── Format tab ──────────────────────────────────────────────────────── */
.format-tab-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
.format-tab-header > div { flex: 1; }
.format-tab-header h3 { margin: 0 0 4px; }

/* ── Patterns sub-section ────────────────────────────────────────────── */
.patterns-section {
  border-top: 1px solid var(--border);
  padding-top: 18px;
}
.patterns-actions { display: flex; gap: 6px; flex-shrink: 0; }
.patterns-filter { padding: 0 2px; }
.filter-toggle {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--text-secondary); cursor: pointer;
}
.filter-toggle code {
  font-size: 11px; background: var(--bg-tertiary);
  padding: 1px 5px; border-radius: 3px;
}
.empty-state {
  display: flex; align-items: center; gap: 10px;
  padding: 14px; background: var(--bg-tertiary);
  border-radius: var(--radius-sm); font-size: 13px;
}

.pattern-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
.pattern-card {
  display: flex; flex-direction: column; gap: 6px;
  padding: 12px 14px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.pattern-card.builtin { background: var(--bg-secondary); }
.pat-card-head {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
}
.pat-card-head strong { font-size: 13px; }
.pat-badge {
  font-size: 10px; font-weight: 500;
  padding: 2px 7px; border-radius: 999px;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.badge-builtin { background: rgba(120, 130, 140, 0.18); color: var(--text-muted); }
.badge-custom { background: rgba(75, 130, 200, 0.18); color: var(--accent, #4b82c8); }
.pat-card-template {
  font-size: 11px;
}
.pat-card-template code {
  background: var(--bg-primary);
  padding: 2px 6px; border-radius: 3px;
  font-family: 'Menlo', 'Monaco', monospace;
}
.pat-card-formats { color: var(--text-muted); font-size: 10px; margin-left: 4px; }
.pat-card-desc {
  margin: 0; font-size: 11px; color: var(--text-secondary);
  line-height: 1.45;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.pat-card-actions {
  display: flex; gap: 4px; margin-top: auto; padding-top: 4px;
}
.pat-card-actions .btn-ghost.danger {
  color: var(--error, #e25c5c);
  margin-left: auto;
}

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
  font-size: 10px;
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
  font-size: 11px;
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
  font-size: 11px;
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
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: rgba(255,255,255,0.03);
}
.precheck-host-ok  { border-color: rgba(34, 197, 94, 0.35);  background: rgba(34, 197, 94, 0.08); }
.precheck-host-bad { border-color: rgba(239, 68, 68, 0.45);  background: rgba(239, 68, 68, 0.10); }

.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0;
}

.tab {
  padding: 10px 18px;
  font-size: 14px;
  color: var(--text-muted);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: all 0.2s;
  font-family: inherit;
}

.tab:hover { color: var(--text-primary); }
.tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
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
  gap: 8px;
}

.voice-row-edit {
  display: flex;
  gap: 8px;
  align-items: center;
}
/* Two-column input split — name compact, voice ID wider since it's longer. */
.voice-row-edit .voice-name-input { flex: 1; }
.voice-row-edit .voice-id-input   { flex: 1.5; }
/* Saved presets that ElevenLabs no longer has — dim the row so the user
 * notices, and the "unavailable" pill renders inline beside the inputs. */
.voice-row-edit.voice-row-unavailable .voice-name-input,
.voice-row-edit.voice-row-unavailable .voice-id-input {
  opacity: 0.55;
}
.voice-unavailable-pill {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(245, 158, 11, 0.18);
  color: rgb(180, 83, 9);
  text-transform: lowercase;
  white-space: nowrap;
}

/* Helper line + warning above the voice list. */
.voice-helper-line {
  font-size: 12px;
  margin-bottom: 12px;
}
.voice-helper-link {
  color: var(--accent);
  text-decoration: underline;
}
.voice-helper-link:hover {
  filter: brightness(1.1);
}
.voice-catalog-warn {
  margin-bottom: 10px;
  padding: 8px 12px;
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.35);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: rgb(180, 83, 9);
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

/* ── Storage tab ─────────────────────────────────────────────────────── */
.storage-section h4 {
  margin: 0 0 6px;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.storage-section .hint { margin: 4px 0 8px; font-size: 11px; line-height: 1.45; }
.storage-section-icon { font-size: 16px; line-height: 1; }
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
.optional-tag { color: var(--text-muted); font-size: 11px; font-weight: normal; }

/* ── Cloud sync overview (top-of-Storage indicator card) ─────────── */
.cloud-sync-overview {
  margin: 8px 0 0;
  padding: 14px 16px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-left: 3px solid #4b82c8;
  border-radius: var(--radius-sm);
}
.overview-head {
  display: flex; gap: 12px; align-items: flex-start; margin-bottom: 12px;
}
.overview-icon { font-size: 20px; line-height: 1.2; flex-shrink: 0; }
.overview-head strong { display: block; margin-bottom: 2px; font-size: 14px; }
.overview-sub {
  margin: 0; font-size: 11px; color: var(--text-secondary); line-height: 1.5;
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
  font-size: 9px; font-weight: 700; letter-spacing: 0.05em;
  border-radius: 999px;
  margin-left: auto;
}
.overview-badge.on { background: rgba(75, 130, 200, 0.2); color: #60a5fa; }
.overview-badge.off { background: rgba(120, 130, 140, 0.18); color: var(--text-muted); }
.overview-badge.info { background: rgba(214, 155, 43, 0.15); color: var(--warning, #d69b2b); }
.overview-card-desc {
  margin: 0; font-size: 11px; color: var(--text-secondary); line-height: 1.45;
}
.overview-card-path {
  font-family: 'Menlo', 'Monaco', monospace;
  font-size: 10px; color: var(--text-muted);
  word-break: break-all;
}
.overview-warnings {
  margin-top: 8px;
  padding: 8px 12px;
  background: rgba(214, 155, 43, 0.08);
  border-left: 3px solid var(--warning, #d69b2b);
  border-radius: var(--radius-sm);
  font-size: 11px;
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
  font-size: 10px;
}

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
  font-size: 9px; font-weight: 700; letter-spacing: 0.06em;
  border-radius: 999px;
  flex-shrink: 0;
}
.root-badge.default { background: rgba(120, 130, 140, 0.18); color: var(--text-muted); }
.root-badge.custom { background: rgba(75, 130, 200, 0.22); color: #60a5fa; }
.projects-root-default-note {
  font-size: 11px; color: var(--text-muted);
}
.projects-root-default-note code {
  background: var(--bg-secondary); padding: 1px 4px; border-radius: 3px;
  font-size: 10px;
}
.projects-root-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.projects-root-warning {
  padding: 8px 12px;
  background: rgba(214, 155, 43, 0.08);
  border-left: 3px solid var(--warning, #d69b2b);
  border-radius: var(--radius-sm);
  font-size: 11px;
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
  font-size: 10px;
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
  font-size: 11px;
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
  max-height: 60vh; overflow-y: auto;
}
.storage-row {
  display: grid;
  grid-template-columns: 80px 1.5fr 110px 90px 130px 100px 130px;
  gap: 8px; align-items: center;
  padding: 6px 8px; font-size: 12px;
  background: var(--bg-secondary); border-radius: var(--radius-sm);
}
.storage-row.storage-head {
  background: transparent; padding: 6px 8px 4px;
  font-size: 11px; font-weight: 600; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.04em;
}
.storage-row.uploaded { background: rgba(75, 200, 100, 0.06); }
.storage-row.no-final { opacity: 0.55; }
.col-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-final, .col-clips, .col-other { font-family: 'Menlo', 'Monaco', monospace; font-size: 11px; }
.col-final .ext-badge {
  margin-left: 4px; padding: 1px 5px;
  background: rgba(96, 165, 250, 0.18); color: #60a5fa;
  border-radius: 4px; font-size: 10px;
}

.upload-badge {
  display: inline-block; padding: 1px 7px;
  font-size: 10px; font-weight: 600;
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
  font-size: 11px;
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
  gap: 4px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.sub-tab {
  padding: 8px 14px;
  font-size: 13px;
  color: var(--text-muted);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}
.sub-tab:hover { color: var(--text-primary); }
.sub-tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
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
  font-size: 11px;
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

.custom-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  border-radius: 999px;
  background: rgba(124, 93, 250, 0.18);
  color: #b4a2ff;
  vertical-align: middle;
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

/* Local TTS (Chatterbox) tab */
.local-tts-row { display: flex; flex-direction: column; gap: 4px; }
.local-tts-toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.local-tts-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
.local-tts-url-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.local-tts-url-row .input { flex: 1; min-width: 240px; }
.local-tts-upload-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.local-tts-current { display: flex; gap: 6px; align-items: center; }
.local-tts-pill {
  display: inline-block;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
}
.local-tts-pill.ok  { background: rgba(34,197,94,0.12);   color: rgb(22,163,74);   border: 1px solid rgba(34,197,94,0.35); }
.local-tts-pill.err { background: rgba(220,38,38,0.10);   color: rgb(190,18,60);   border: 1px solid rgba(220,38,38,0.35); }

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
</style>
