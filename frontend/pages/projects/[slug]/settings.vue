<template>
  <div>
    <h1>Settings</h1>

    <!-- Tab navigation -->
    <div class="tabs mt-3">
      <button v-for="tab in tabs" :key="tab.id" :class="['tab', { active: activeTab === tab.id }]" @click="activeTab = tab.id">
        {{ tab.label }}
      </button>
    </div>

    <!-- API Keys -->
    <div v-if="activeTab === 'keys'" class="card mt-2">
      <h3>API Keys</h3>
      <p class="text-muted mt-1 mb-2">
        Add one or more accounts per provider. One account per provider is the <strong>default</strong> — generators use it automatically. Keys live in this project's <code>secrets.json</code> (mode 0600) and never leave the server.
      </p>

      <!-- Diagnose connectivity — runs the same precheck the wizard uses.
           Useful when the per-key Test button surfaces "Invalid key or
           network error" and the user can't tell which side is at fault.
           The reachable/unreachable split answers that in one click. -->
      <div class="precheck-diagnose">
        <div class="flex gap-2" style="align-items: center; flex-wrap: wrap;">
          <button
            class="btn btn-sm btn-secondary"
            :disabled="precheckState.loading"
            @click="runConnectivityPrecheck"
            title="Tests reachability to every AI provider host Story Studio talks to. Does not use your API keys."
          >
            <span v-if="precheckState.loading">Diagnosing…</span>
            <span v-else>Diagnose connectivity</span>
          </button>
          <span v-if="precheckState.result" class="text-muted" style="font-size: 11px;">
            {{ precheckState.result.reachable.length }}/{{ precheckState.result.reachable.length + precheckState.result.unreachable.length }} reachable
            · {{ precheckState.result.elapsed_ms }} ms
          </span>
          <span v-if="precheckState.error" class="text-danger" style="font-size: 11px;">
            {{ precheckState.error }}
          </span>
        </div>
        <div v-if="precheckState.result && precheckState.result.unreachable.length > 0" class="precheck-host-list">
          <code v-for="h in precheckState.result.unreachable" :key="h.host" class="precheck-host precheck-host-bad">
            ✗ {{ h.host }} <span class="text-muted">({{ h.reason }})</span>
          </code>
        </div>
        <div v-if="precheckState.result && precheckState.result.reachable.length > 0" class="precheck-host-list">
          <code v-for="h in precheckState.result.reachable" :key="h.host" class="precheck-host precheck-host-ok">
            ✓ {{ h.host }}
          </code>
        </div>
      </div>

      <ProviderAccounts
        v-for="p in KEY_PROVIDERS"
        :key="p.id"
        :slug="slug"
        :provider-id="p.id"
        :provider-name="p.name"
        :help-text="p.helpText"
        :placeholder="p.placeholder"
        :affiliate-url="(p as any).affiliateUrl"
        :accounts="(config as any)?.accounts?.[p.id] || []"
        @refresh="refreshConfig(slug)"
      />
    </div>

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
      <p class="text-muted mt-1 mb-2">Add ElevenLabs voice IDs for quick selection in the Audio panel.</p>

      <div class="voice-list">
        <div v-for="(voice, i) in editVoices" :key="i" class="voice-row-edit">
          <input v-model="voice.name" class="input input-sm" placeholder="Voice name" style="flex:1" />
          <input v-model="voice.voice_id" class="input input-sm" placeholder="ElevenLabs voice ID" style="flex:1.5" />
          <button class="btn-icon danger" @click="editVoices.splice(i, 1)" title="Remove">&#10005;</button>
        </div>
      </div>

      <div class="flex gap-2 mt-2" style="align-items: center;">
        <button class="btn btn-secondary btn-sm" @click="editVoices.push({ name: '', voice_id: '' })">
          + Add Voice
        </button>
        <button class="btn btn-primary btn-sm" @click="saveVoices">Save Voice Presets</button>
        <SaveIndicator v-bind="savedHintProps('voices')" />
      </div>
    </div>

    <!-- Format -->
    <div v-if="activeTab === 'format'" class="card mt-2">
      <div class="format-tab-header">
        <div>
          <h3>Format</h3>
          <p class="text-muted mt-1 mb-2">
            <strong>Default for new projects is sleep-story.</strong>
            We ship 7 format presets — pick one above, override fields per-project below,
            or create your own from a sample script via "+ Create from Sample".
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
              <strong>We ship 6 presets.</strong> Pick one in the Script
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
      <p class="text-muted mt-1 mb-2">
        See where the disk goes per episode and free up space safely.
        <strong>Final videos that are confirmed-uploaded to YouTube</strong>
        can be deleted locally — the YouTube sidecar (saved during upload)
        keeps the pipeline view happy, and the canonical copy lives on
        YouTube. Per-scene Veo / fal clips are surfaced separately because
        they cost real $$$ to regenerate; we never auto-clean those.
      </p>

      <!-- ── Projects storage location ──────────────────────────── -->
      <!-- Lets the user point the projects folder at any local path —
           typically inside iCloud Drive / Dropbox / Google Drive so
           the OS handles cross-machine sync. Per-machine setting
           (lives in app-settings.json which doesn't sync). -->
      <div class="storage-section">
        <h4>Projects storage location</h4>
        <p class="text-muted hint">
          Where this Mac stores your projects. Move it to an iCloud Drive
          (or Dropbox / Google Drive) folder to work across machines.
          The app restarts after the move to pick up the new location.
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
            @click="browseAndMoveProjectsRoot"
          >
            📂 Browse + move projects there & restart
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
        <details class="projects-root-warning mt-2">
          <summary>⚠ Per-machine limitations of cloud sync</summary>
          <ul>
            <li>
              <strong>API keys are per-machine.</strong> Each Mac encrypts
              its own keys; the synced folder won't carry them across.
              You'll re-enter keys (Settings → API Keys) on every device.
            </li>
            <li>
              <strong>One machine at a time.</strong> Don't have two Macs
              actively editing the same project — the cloud will keep
              whichever saves last and silently overwrite the other.
              Save + close on machine A → wait for sync → open on B.
            </li>
            <li>
              <strong>Job queue + session analytics may diverge.</strong>
              These files (<code>jobs.json</code>, <code>sessions.json</code>)
              live inside the project folder; cloud-syncing them across
              machines can confuse mid-flight job state. Avoid running
              generations on two machines targeting the same project at
              once.
            </li>
          </ul>
        </details>
        <div v-if="projectsRootStatus" :class="['projects-root-status', projectsRootStatusKind]">
          {{ projectsRootStatus }}
        </div>
      </div>

      <!-- ── External final-video root (per-machine) ─────────────── -->
      <div class="storage-section">
        <h4>External final-video root <span class="optional-tag">(per-machine, optional)</span></h4>
        <p class="text-muted hint">
          When set, freshly-rendered final videos land at this path
          instead of inside the project tree. Use a non-cloud-synced
          location (e.g. <code>~/Movies/Story Studio</code> or an external
          drive) to keep the GBs out of iCloud Drive. Project-tree finals
          still detect normally — both locations are checked. Stored in
          <code>app-settings.json</code> per-machine, so each device you
          work from picks its own path (or leaves it unset).
        </p>
        <div class="external-root-row">
          <!-- Read-only path display so users don't have to copy/paste a
               path. Browse opens the native folder picker; on success
               we auto-save (the picker IS the user's confirmation, no
               separate Save click needed). Clear empties + saves an
               empty value so the project tree is used again. -->
          <input
            v-model="externalRootInput"
            class="input"
            placeholder="(not set — finals stay in the project tree)"
            readonly
          />
          <button
            class="btn btn-primary btn-sm"
            :disabled="externalRootSaving"
            @click="browseAndSetExternalRoot"
          >
            {{ externalRootSaving ? 'Saving…' : '📂 Browse…' }}
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
      <div class="storage-section mt-3">
        <div class="flex items-center" style="justify-content: space-between; gap: 12px;">
          <div>
            <h4>Per-episode breakdown</h4>
            <p class="text-muted hint">
              Sorted largest first. Click "Free up final" to delete the
              local <code>{code}_final_video.*</code> files for an
              uploaded episode (the sidecar's <code>video_id</code>
              guards against accidental deletion of unpublished work).
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

      <!-- TTS timeout: clients default to 20 min for GenAIPro, 5 min for -->
      <!-- fal.ai. A longer timeout avoids orphaning completed tasks whose -->
      <!-- results never got downloaded (GenAIPro keeps history only 1 day). -->
      <h3 class="mt-3">TTS Generation Timeout</h3>
      <p class="text-muted mt-1 mb-2">
        How long to wait for a single TTS chunk to complete on the provider's
        side before giving up. GenAIPro chapter-length tasks often exceed 5 min.
        Leave blank to use the provider default.
      </p>
      <div class="form-group" style="max-width: 360px;">
        <label>
          Timeout (minutes)
          <span class="field-hint">GenAIPro default: 20 min · fal.ai default: 5 min</span>
        </label>
        <input
          v-model.number="ttsTimeoutMinutes"
          type="number"
          min="1"
          max="120"
          step="1"
          class="input"
          placeholder="Default"
          aria-label="TTS timeout in minutes"
        />
        <span class="text-muted" style="font-size: 11px;">
          Typical range: 15–30 min. Higher values risk blocking a job worker
          on a genuinely stuck task for longer.
        </span>
      </div>

      <div class="flex gap-2 mt-2" style="align-items: center;">
        <button class="btn btn-primary" @click="savePerformance">Save Performance Settings</button>
        <SaveIndicator v-bind="savedHintProps('performance')" />
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

      <!-- One-click install -->
      <div class="ffmpeg-install-block mt-2">
        <h4 style="margin: 0 0 8px 0;">One-click install</h4>
        <p class="text-muted" style="font-size: 12px; margin: 0 0 8px 0;">
          Downloads ffmpeg + ffprobe (~50 MB) from the official release mirror and installs them
          into the app's user-data folder. Safe to run multiple times. No admin password required.
        </p>
        <button
          class="btn btn-primary"
          @click="installFfmpeg"
          :disabled="ffmpegInstalling"
        >
          <span v-if="ffmpegInstalling">Installing… {{ ffmpegInstallProgress }}%</span>
          <span v-else-if="ffmpegStatus?.installed">Re-install / update FFmpeg</span>
          <span v-else>Install FFmpeg</span>
        </button>
        <div v-if="ffmpegInstallMessage" class="mt-1" style="font-size: 12px;" :style="{ color: ffmpegInstallError ? 'var(--error)' : 'var(--text-muted)' }">
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
      </div>

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
          <input v-model.number="projectForm.season_size" class="input" type="number" min="1" />
        </div>
      </div>
      <div class="form-group">
        <label>YouTube Channel URL (for video recommendations)</label>
        <input v-model="projectForm.youtube_channel_url" class="input" placeholder="https://youtube.com/@yourchannel" />
      </div>

      <div class="form-group">
        <label>Project Mode</label>
        <div class="flex gap-2 items-center" style="flex-wrap:wrap">
          <span v-if="projectForm.portable" class="badge badge-done" style="font-size: 12px;">
            📡 Multi-machine (synced)
          </span>
          <span v-else class="badge badge-queued" style="font-size: 12px;">
            💻 Local only
          </span>
          <button
            v-if="!projectForm.portable"
            class="btn btn-sm btn-primary"
            :disabled="togglingPortable"
            @click="enableCloudSync"
          >
            {{ togglingPortable ? 'Enabling…' : '📡 Enable cloud sync' }}
          </button>
          <button
            v-else
            class="btn btn-sm btn-secondary"
            :disabled="togglingPortable"
            @click="disableCloudSync"
          >
            {{ togglingPortable ? 'Disabling…' : 'Switch to local only' }}
          </button>
        </div>
        <span class="text-muted" style="font-size:11px">
          Multi-machine projects write a <code>.story-studio-project.json</code> manifest
          into the project folder so other computers can pick up the project via
          <em>Import existing</em>. Local-only keeps the manifest in userData only.
        </span>
      </div>

      <div class="form-group">
        <label>Project Files Location</label>
        <div class="flex gap-2 items-center" style="flex-wrap:wrap">
          <code class="path-display">{{ projectLocation || '(no location set)' }}</code>
          <button class="btn btn-sm btn-secondary" :disabled="!projectLocation" @click="revealInFinder">
            📂 Open in Finder
          </button>
        </div>
        <span class="text-muted" style="font-size:11px">
          Story Studio reads and writes all generated files here. Don't move this folder —
          if you do, use <strong>Repair Folder Structure</strong> below.
        </span>
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
        <h3>Danger Zone</h3>
        <p class="text-muted mt-1">Deleting a project removes all settings and job history. Generated files are not deleted.</p>
        <button class="btn btn-danger mt-2" @click="deleteProject">Delete Project</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useHead({ title: "Settings — Story Studio KH" })
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put, del } = useApi()
const { ask } = useConfirm()
const { project, config, refreshConfig, loadProject } = useProject()
const { success, error: showError } = useToast()

const activeTab = ref('keys')
const syncing = ref(false)
const syncResults = ref<string[]>([])

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

// ── Connectivity precheck (API Keys tab) ─────────────────────────────────
// Lets the user distinguish "my API key is wrong" from "my network can't
// reach the provider" without having to interpret the ambiguous "Invalid
// key or network error" message. Does not use any stored keys.
interface PrecheckResult {
  reachable: Array<{ host: string; label: string; status: number }>
  unreachable: Array<{ host: string; label: string; reason: string }>
  elapsed_ms: number
}
const precheckState = reactive<{ loading: boolean; result: PrecheckResult | null; error: string }>({
  loading: false,
  result: null,
  error: '',
})
async function runConnectivityPrecheck() {
  precheckState.loading = true
  precheckState.error = ''
  try {
    precheckState.result = await get<PrecheckResult>('/connectivity/precheck')
  } catch (e: any) {
    precheckState.error = e?.data?.detail || e?.message || 'Precheck failed'
    precheckState.result = null
  } finally {
    precheckState.loading = false
  }
}
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
const externalRootSaving = ref(false)
const externalRootStatus = ref('')
const externalRootReachable = ref(false)
const migrateRunning = ref(false)
const lastMigration = ref<MigrationResult | null>(null)
const bulkRunning = ref(false)
const lastBulkCleanup = ref<CleanupResult | null>(null)
const rowCleanupRunning = ref<string | null>(null)

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
    externalRootStatus.value = r.value
      ? (r.reachable ? `✓ saved + reachable: ${r.value}` : `⚠ saved but ${r.reason}`)
      : 'Cleared (using project tree)'
    // Re-run audit so external-side counts refresh.
    if (storage.value) await loadStorageAudit()
  } catch (e: any) {
    externalRootStatus.value = `Error: ${e?.data?.detail || e?.message || 'failed to save'}`
  } finally {
    externalRootSaving.value = false
  }
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
    externalRootStatus.value = `Picker failed: ${e?.data?.detail || e?.message || 'unknown'}`
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
  // Step 0: pick the destination via the native folder picker.
  let pick: { path: string | null }
  try {
    pick = await post<{ path: string | null }>('/system/pick-folder', {
      title: 'Choose where to store projects',
      buttonLabel: 'Use this folder',
      defaultPath: projectsRoot.value?.effective_path,
    })
  } catch (e: any) {
    projectsRootStatus.value = `Picker failed: ${e?.data?.detail || e?.message}`
    projectsRootStatusKind.value = 'err'
    return
  }
  if (!pick.path) return  // User cancelled.

  // Step 0.5: pre-flight sizing so the confirmation dialog tells the
  // user what they're about to do.
  let preview: { source_path: string; files: number; bytes: number }
  try {
    preview = await post<typeof preview>('/app-settings/projects-root/preview-migration', {})
  } catch (e: any) {
    projectsRootStatus.value = `Couldn't size the migration: ${e?.data?.detail || e?.message}`
    projectsRootStatusKind.value = 'err'
    return
  }
  const sizeStr = formatBytes(preview.bytes)
  const ok = confirm(
    `Move projects to:\n  ${pick.path}\n\n` +
    `This will COPY ${preview.files} file(s) (${sizeStr}). ` +
    `The old location stays in place — delete it manually after verifying ` +
    `the new location works on next launch.\n\n` +
    `The app will restart after the copy completes.`,
  )
  if (!ok) return

  projectsRootBusy.value = true
  projectsRootStatus.value = `Copying ${preview.files} file(s) (${sizeStr})…`
  projectsRootStatusKind.value = 'ok'
  try {
    // Step 1: copy.
    const r = await post<{
      target_path: string; kept_old_at: string
      copied_files: number; copied_bytes: number; warnings: string[]
    }>('/app-settings/projects-root/migrate', { target_path: pick.path })

    // Step 2: persist the override AFTER the copy succeeds. If migrate
    // had thrown, the override stays at its previous value and the app
    // continues reading from the (still-intact) old location.
    await put('/app-settings/projects-root', { override: r.target_path })

    const warnSummary = r.warnings.length
      ? ` (${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'} — check the console)`
      : ''
    projectsRootStatus.value =
      `✓ Copied ${r.copied_files} file(s), ${formatBytes(r.copied_bytes)}` +
      `${warnSummary}. Restarting…`
    projectsRootStatusKind.value = 'ok'
    if (r.warnings.length) {
      console.warn('[projects-root migration] warnings:', r.warnings)
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

const tabs = [
  { id: 'keys', label: 'API Keys' },
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
  { id: 'ffmpeg', label: 'FFmpeg' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'project', label: 'Project' },
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
  // The endpoint is synchronous (waits for the download to finish before
  // responding). Backend fires progress callbacks but we don't have an SSE
  // stream yet — the message updates are limited to start / done / error.
  // If the download takes longer than 5 minutes, the backend's fetch
  // timeout fires and the call returns an error message.
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
  }
}
onMounted(() => {
  applyHash()
  if (activeTab.value === 'ffmpeg') refreshFfmpegStatus()
  loadNotifSettings()
})
watch(() => _route.hash, applyHash)

// ── Notifications tab (app-level, not per-project) ─────────────────────
// Backed by `/api/app-settings/notifications`. We debounce the save on
// slider drags so one gesture doesn't burn a PUT per integer tick.
interface NotifSettings { enabled: boolean; min_duration_ms: number }
const notifSettings = ref<NotifSettings>({ enabled: true, min_duration_ms: 300_000 })
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
    notifSettings.value = await get<NotifSettings>('/app-settings/notifications')
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
    notifSettings.value = await put<NotifSettings>('/app-settings/notifications', {
      enabled: notifSettings.value.enabled,
      min_duration_ms: notifSettings.value.min_duration_ms,
    })
    notifSaveStatus.value = 'saved'
    stampSaved('notifications')
  } catch (e: any) {
    notifSaveError.value = e?.data?.detail || e?.message || 'Unknown error'
    notifSaveStatus.value = 'error'
  }
}

// Keys tab: provider catalog driving the data-bound <ProviderAccounts> loop.
// Order mirrors the help text users expect (LLMs first, then image, then TTS).
const KEY_PROVIDERS = [
  { id: 'openai',     name: 'OpenAI',     placeholder: 'sk-...',      helpText: 'LLM for script/metadata generation and Whisper subtitles.' },
  { id: 'anthropic',  name: 'Anthropic',  placeholder: 'sk-ant-...',  helpText: 'Claude models for script/metadata generation.' },
  { id: 'kie',        name: 'kie.ai',     placeholder: '',            helpText: 'Image generation (all default image models) and DeepSeek chat.' },
  { id: 'fal',        name: 'fal.ai',     placeholder: '',            helpText: 'ElevenLabs TTS via fal, plus video models (Veo 3, Sora 2, Hailuo, Wan).' },
  { id: 'genaipro',   name: 'GenAIPro',   placeholder: '',            helpText: 'ElevenLabs TTS via genaipro.vn, plus Veo video.', affiliateUrl: 'https://genaipro.vn?ref=terranash' },
  { id: 'elevenlabs', name: 'ElevenLabs', placeholder: 'xi-api-key…', helpText: 'Official ElevenLabs API — select eleven_* models in the Audio tab.', affiliateUrl: 'https://try.elevenlabs.io/7q8n1q21uoau' },
  { id: 'google',     name: 'Google AI Studio', placeholder: 'AIza…', helpText: 'Gemini 2.5 Flash Image (nano-banana) for natural-language image editing (Video Assembly → Magic Eraser).' },
] as const

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
const projectForm = reactive({ name: '', episode_prefix: '', season_prefix: 'Season', season_size: 20, youtube_channel_url: '', portable: false })
const togglingPortable = ref(false)

async function enableCloudSync() {
  const ok = await ask({
    title: 'Enable cloud sync for this project?',
    message: 'Story Studio will write a .story-studio-project.json manifest into the project folder on every save. Other computers can then pick this project up via "Import existing". Make sure the project folder is inside a cloud-synced location (iCloud, Google Drive, OneDrive, etc.).',
    confirmLabel: 'Enable cloud sync',
  })
  if (!ok) return
  togglingPortable.value = true
  try {
    await put(`/projects/${slug.value}`, { portable: true })
    projectForm.portable = true
    await loadProject(slug.value)
    success('Cloud sync enabled. A manifest will be written on the next save.')
  } catch (e: any) {
    showError(e.data?.detail || 'Could not enable cloud sync')
  } finally {
    togglingPortable.value = false
  }
}

async function disableCloudSync() {
  const ok = await ask({
    title: 'Switch this project to local-only?',
    message: 'The manifest at the project folder root will no longer be refreshed on save. Existing manifests are not deleted. You can re-enable anytime.',
    confirmLabel: 'Switch to local',
  })
  if (!ok) return
  togglingPortable.value = true
  try {
    await put(`/projects/${slug.value}`, { portable: false })
    projectForm.portable = false
    await loadProject(slug.value)
    success('Switched to local only.')
  } catch (e: any) {
    showError(e.data?.detail || 'Could not switch modes')
  } finally {
    togglingPortable.value = false
  }
}

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
// Empty string means "use provider default" (no override stored). We keep
// the empty state distinct from 0 so users can clear it without saving 0.
const ttsTimeoutMinutes = ref<number | ''>('')
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
  const t = (c as any)?.generation_timeouts?.tts_minutes
  ttsTimeoutMinutes.value = typeof t === 'number' && t > 0 ? t : ''
}, { immediate: true })

async function savePerformance() {
  try {
    const body: Record<string, any> = {
      image_concurrency: imageConcurrency.value,
      audio_concurrency: audioConcurrency.value,
      video_concurrency: videoConcurrency.value,
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

// Sync project form
watch(project, (p) => {
  if (p) {
    projectForm.name = p.name
    projectForm.episode_prefix = p.episode_prefix
    projectForm.season_prefix = p.season_prefix || 'Season'
    projectForm.season_size = p.season_size || 20
    projectForm.youtube_channel_url = (p as any).youtube_channel_url || ''
    projectForm.portable = (p as any).portable === true
  }
}, { immediate: true })

// Key add/remove/test/set-default state now lives in ProviderAccounts.vue —
// the data-driven Keys tab defers all per-provider interactions to that
// component and just listens for `refresh` to re-read the safe config.

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
    await put(`/projects/${slug.value}`, projectForm)
    await loadProject(slug.value)
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
  // Themed in-app dialog (see ConfirmDialog.vue) — window.confirm would
  // block the Electron renderer and look out of place in the dark theme.
  const ok = await ask({
    title: `Delete "${project.value?.name}"?`,
    message: 'This removes the project metadata and all episode data under it. This cannot be undone.',
    confirmLabel: 'Delete project',
    danger: true,
  })
  if (!ok) return
  try {
    await del(`/projects/${slug.value}`)
    success('Project deleted')
    navigateTo('/')
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to delete')
  }
}
</script>

<style scoped>
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
.storage-section h4 { margin: 0 0 6px; font-size: 14px; }
.storage-section .hint { margin: 4px 0 8px; font-size: 11px; line-height: 1.45; }
.optional-tag { color: var(--text-muted); font-size: 11px; font-weight: normal; }

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
</style>
