<template>
  <div>
    <div class="flex justify-between items-center">
      <div>
        <h1>Ideas Generator</h1>
        <p class="text-muted mt-1">{{ allIdeas.length }} ideas &middot; {{ statusCounts.accepted }} accepted &middot; Next: {{ nextEpisode }}</p>
      </div>
    </div>

    <!-- Generator -->
    <div class="generator-panel mt-3">
      <h3 class="generator-title">Generate New Ideas</h3>
      <div class="generator-body">
        <div class="grid-2">
          <div class="form-group">
            <label>Genre</label>
            <ComboInput v-model="form.genre" :options="allGenres" placeholder="Pick or add a genre" searchable allow-custom @add-custom="onAddGenre" />
          </div>
          <div class="form-group">
            <label>Audience</label>
            <select v-model="form.audience" class="select">
              <option value="adults">Adults</option>
              <option value="children">Children (5-10)</option>
              <option value="teens">Teens</option>
              <option value="all-ages">All Ages</option>
            </select>
          </div>
          <div class="form-group">
            <label>Theme (optional)</label>
            <ComboInput v-model="form.theme" :options="allThemes" placeholder="Pick or add a theme" searchable allow-custom @add-custom="onAddTheme" />
          </div>
          <div class="form-group">
            <label>Mood</label>
            <ComboInput v-model="form.mood" :options="allMoods" placeholder="Pick or add a mood" searchable allow-custom @add-custom="onAddMood" />
          </div>
        </div>
        <div class="grid-3">
          <div class="form-group" style="grid-column: span 2;">
            <label>Keywords</label>
            <ChipInput v-model="form.keywords" :suggestions="allKeywords" placeholder="Pick from common keywords or type to add…" allow-custom :max="12" @add-custom="onAddKeyword" />
          </div>
          <div class="form-group">
            <label>Count</label>
            <input v-model.number="form.count" class="input" type="number" min="1" max="15" />
          </div>
        </div>
        <div class="grid-2">
          <ModelSelector v-model="form.model" :project-slug="slug" />
        </div>

        <!-- Pattern picker (optional). When set, generated ideas follow
             the pattern's titleTemplate (e.g. "Fall asleep to {X}") +
             tone hints. Skip for default LLM titling. Persisted per
             project so the user's choice sticks across reloads. -->
        <div class="ideas-pattern-block">
          <PatternPicker
            v-model="form.pattern_id"
            v-model:subject="form.pattern_subject"
            :format-id="formatId"
          />
        </div>
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
        <div class="generator-actions-secondary">
          <button class="btn btn-secondary btn-sm" @click="openAddIdea">+ Add Idea Manually</button>
          <button class="btn btn-secondary btn-sm" @click="openPasteIdeas">📋 Paste Ideas from LLM</button>
          <button class="btn btn-secondary btn-sm" @click="openImportFolder">📂 Import Episode Folder</button>
        </div>
      </div>
    </div>

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
            <th scope="col" class="sortable" @click="toggleSort('suggested_chapters')">Ch {{ sortIcon('suggested_chapters') }}</th>
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
                    <span class="text-muted" style="font-size:11px">Model: {{ idea.model_used }}</span>
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
          class="btn btn-secondary btn-lg"
          style="flex:1"
          :disabled="!acceptCodeValid"
          @click="doAccept('folders')"
        >Create Folders Only</button>
        <button
          class="btn btn-primary btn-lg"
          style="flex:1"
          :disabled="!acceptCodeValid"
          @click="doAccept('script')"
        >Folders &amp; Open Script</button>
      </div>
      <button class="btn btn-sm btn-secondary mt-2" style="width:100%" @click="acceptDialogIdea = null">Cancel</button>
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
          class="btn btn-primary btn-lg"
          style="flex:1"
          :disabled="!renumberValid || renumberRunning"
          @click="doRenumber"
        >
          {{ renumberRunning ? 'Renumbering…' : 'Renumber' }}
        </button>
      </div>
      <button class="btn btn-sm btn-secondary mt-2" style="width:100%" @click="renumberDialogIdea = null">Cancel</button>
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

        <p v-if="importMode === 'single'" class="text-muted mt-2" style="font-size: 13px;">
          Pick an existing folder named like <code>EP0009 - The Luminous Grove at Dawn</code>.
          We'll detect what's inside, add any missing subfolders, and register it as an accepted episode
          so it can flow through the pipeline.
        </p>
        <p v-else class="text-muted mt-2" style="font-size: 13px;">
          Pick a <strong>parent</strong> folder — we'll list every immediate subfolder so you can
          tick which to import. Codes are auto-resolved (keep parsed if free, else next available).
          Use single-folder mode if you need to override per-folder.
        </p>

        <!-- Single-folder mode -->
        <template v-if="importMode === 'single'">
        <div class="flex gap-2 mt-2">
          <input v-model="importPath" class="input" placeholder="Path to episode folder" style="flex:1" />
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

          <h4 class="mt-2" style="font-size: 13px;">Detected assets</h4>
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

          <label class="flex gap-2 mt-2" style="align-items: center; font-size: 12px;">
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
            <input v-model="parentPath" class="input" placeholder="Path to parent folder" style="flex:1" :disabled="parentImporting" />
            <button class="btn btn-sm btn-secondary" :disabled="parentImporting" @click="browseParentFolder">Browse…</button>
            <button class="btn btn-sm btn-secondary" :disabled="!parentPath || parentScanning || parentImporting" @click="scanParentSubfolders">
              {{ parentScanning ? 'Scanning…' : 'Scan' }}
            </button>
          </div>

          <label class="flex gap-2 mt-2" style="align-items: center; font-size: 12px;">
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
          <p v-else-if="parentPath && !parentScanning" class="text-muted mt-2" style="font-size: 12px;">
            No subfolders here yet. Click <em>Scan</em> after picking a parent.
          </p>
        </template>

        <div class="flex gap-2 mt-3" style="justify-content: flex-end;">
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
      <div class="modal" style="max-width: 760px;">
        <h2>Paste Ideas from LLM</h2>
        <p class="text-muted mt-1" style="font-size: 13px;">
          Copy the prompt below into ChatGPT, Claude, or any LLM. Paste the JSON array it produces into the box below and click <strong>Preview</strong>.
        </p>

        <!-- Pane 1: Preset prompt -->
        <div class="mt-2">
          <div class="flex gap-2" style="align-items: center;">
            <label style="font-size: 12px; font-weight: 600;">1. Preset prompt</label>
            <button class="btn btn-sm btn-secondary" style="margin-left:auto;" :disabled="!pastePrompt" @click="copyPastePrompt">
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
            <span v-if="form.pattern_id" class="paste-prompt-source-chip" title="A Pattern preset is folded into the prompt — title template + opening device. Change or clear it via the Pattern picker above.">
              Pattern: <strong>{{ form.pattern_id }}</strong>
              <button
                type="button"
                class="paste-prompt-source-clear"
                title="Clear the Pattern — prompt falls back to format defaults."
                aria-label="Clear pattern"
                @click="form.pattern_id = ''; form.pattern_subject = ''"
              >✕</button>
            </span>
            <span v-else class="paste-prompt-source-hint">No Pattern selected — pick one above to fold a title template into the prompt.</span>
          </div>
          <pre class="paste-prompt-box">{{ pastePrompt || 'Loading…' }}</pre>
        </div>

        <!-- Pane 2: Paste box -->
        <div class="mt-2">
          <label style="font-size: 12px; font-weight: 600;">2. Paste the JSON array your LLM produced</label>
          <textarea
            v-model="pasteInput"
            class="textarea paste-input-box"
            rows="8"
            placeholder='[&#10;  { "title": "...", "logline": "...", "themes": [...], "suggested_chapters": 10, "suggested_length": "45 min", "mood": "..." }&#10;]'
          />
          <div class="flex gap-2 mt-1" style="align-items: center;">
            <button class="btn btn-sm btn-primary" :disabled="!pasteInput.trim() || pastePreviewing" @click="doPastePreview">
              {{ pastePreviewing ? 'Previewing…' : 'Preview' }}
            </button>
            <span v-if="pastePreviewError" class="text-muted" style="color: var(--danger); font-size: 12px;">
              {{ pastePreviewError }}
            </span>
          </div>
        </div>

        <!-- Pane 3: Preview table -->
        <div v-if="pastePreviewValid.length || pastePreviewRejected.length" class="mt-3">
          <label style="font-size: 12px; font-weight: 600;">
            3. Preview — {{ pastePreviewValid.length }} ready to import{{ pastePreviewRejected.length ? `, ${pastePreviewRejected.length} rejected` : '' }}
          </label>
          <div v-if="pastePreviewValid.length" class="paste-preview-table mt-1">
            <div class="paste-preview-row paste-preview-header">
              <span style="min-width: 24px"></span>
              <span style="flex: 1.5">Title</span>
              <span style="flex: 2">Logline</span>
              <span style="flex: 1">Themes</span>
              <span style="width: 70px">Chapters</span>
              <span style="width: 80px">Length</span>
              <span style="flex: 1">Mood</span>
              <span style="width: 28px"></span>
            </div>
            <div v-for="(row, i) in pastePreviewValid" :key="`v-${i}`" class="paste-preview-row">
              <span style="min-width: 24px; color: var(--text-muted); font-size: 11px;">{{ i + 1 }}</span>
              <span style="flex: 1.5; font-weight: 600;">{{ row.title }}</span>
              <span style="flex: 2; font-size: 12px;">{{ row.logline }}</span>
              <span style="flex: 1; font-size: 12px;">{{ row.themes.join(', ') }}</span>
              <span style="width: 70px; text-align: center;">{{ row.suggested_chapters }}</span>
              <span style="width: 80px; font-size: 12px;">{{ row.suggested_length }}</span>
              <span style="flex: 1; font-size: 12px;">{{ row.mood }}</span>
              <button class="btn-icon" style="width: 28px;" @click="pastePreviewValid.splice(i, 1)" title="Remove this row">✕</button>
            </div>
          </div>

          <div v-if="pastePreviewRejected.length" class="paste-rejected mt-2">
            <div style="font-size: 12px; font-weight: 600; color: var(--danger);">
              Rejected rows ({{ pastePreviewRejected.length }}) — fix the LLM output and re-preview, or ignore and import the rest:
            </div>
            <div v-for="rej in pastePreviewRejected" :key="rej.index" class="paste-rejected-row">
              <span class="paste-rejected-index">#{{ rej.index + 1 }}</span>
              <span class="paste-rejected-reason">{{ rej.reason }}</span>
              <code class="paste-rejected-raw">{{ typeof rej.raw === 'object' ? JSON.stringify(rej.raw).slice(0, 120) : String(rej.raw).slice(0, 120) }}</code>
            </div>
          </div>
        </div>

        <div class="flex gap-2 mt-3" style="justify-content: flex-end;">
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

    <!-- Add/Edit idea modal -->
    <div v-if="editorOpen" class="modal-overlay" @click.self="editorOpen = false">
      <div class="modal" style="max-width: 560px;">
        <h2>{{ editorMode === 'add' ? 'Add Idea' : 'Edit Idea' }}</h2>
        <p v-if="editorMode === 'edit' && editorIdea?.status === 'accepted'" class="text-muted mt-1" style="font-size: 12px;">
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
            <label>Chapters</label>
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
        <div class="flex gap-2 mt-3" style="justify-content: flex-end;">
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
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useHead({ title: "Ideas — Story Studio KH" })
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, del, patch } = useApi()
const { success, error: showError, successUndoable } = useToast()
const { ask } = useConfirm()
const { project } = useProject()

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
// flag. Generated = anything organic (gpt-4o batches, paste-ideas, manual
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
  model: 'gpt-4o',
  // Pattern preset (optional). Empty = LLM uses default freeform titling.
  // Both fields persist per-project so the user's pick survives reloads.
  pattern_id: '',
  pattern_subject: '',
})

// ── Pattern + format wiring for the Ideas page ────────────────────────────
//
// PatternPicker filters by current format (Part 2 of this rollout). We
// fetch the project's effective format id from settings/config so the
// picker shows only patterns paired with that format by default. Last-
// used pattern + subject are persisted in the same config under
// `idea_generator_last_pattern` / `idea_generator_last_subject` —
// matches the *_last_* convention used by other generator pages.
const formatId = ref<string>('sleep-story')
// Map of format-id → display name, populated from /api/formats. Used to
// show "Format: Sleep Story" above the paste-prompt instead of "sleep-story",
// and to surface a "Switch" link to Settings → Format. Best-effort: if the
// fetch fails we fall back to displaying the id.
const formatNamesById = ref<Record<string, string>>({})
const formatDisplayName = computed(() => formatNamesById.value[formatId.value] || formatId.value)
const LAST_PATTERN_KEY = 'idea_generator_last_pattern'
const LAST_SUBJECT_KEY = 'idea_generator_last_subject'
let patternHydrated = false

async function loadFormatNames() {
  try {
    const list = await get<Array<{ id: string; name: string }>>('/formats')
    const map: Record<string, string> = {}
    for (const f of list || []) if (f && typeof f.id === 'string') map[f.id] = f.name || f.id
    formatNamesById.value = map
  } catch { /* fall back to displaying the id */ }
}

async function loadPatternPreferences() {
  try {
    const cfg = await get<any>(`/projects/${slug.value}/settings/config`)
    if (typeof cfg?.format_id === 'string' && cfg.format_id) formatId.value = cfg.format_id
    if (typeof cfg?.[LAST_PATTERN_KEY] === 'string') form.pattern_id = cfg[LAST_PATTERN_KEY]
    if (typeof cfg?.[LAST_SUBJECT_KEY] === 'string') form.pattern_subject = cfg[LAST_SUBJECT_KEY]
  } catch { /* config unreadable → leave defaults */ }
  patternHydrated = true
}

async function savePatternPreferences() {
  // Skip the initial hydration round-trip — only fire on user-initiated
  // changes. Without this guard, the watch fires once when load sets the
  // initial value, writing the same value straight back.
  if (!patternHydrated) return
  try {
    const { put } = useApi()
    await put(`/projects/${slug.value}/settings/config`, {
      [LAST_PATTERN_KEY]: form.pattern_id,
      [LAST_SUBJECT_KEY]: form.pattern_subject,
    })
  } catch { /* non-fatal — selection still works in-session */ }
}

watch(() => form.pattern_id, savePatternPreferences)
watch(() => form.pattern_subject, savePatternPreferences)
onMounted(loadPatternPreferences)
onMounted(loadFormatNames)

// ── Preset pools (built-ins + custom from config) ─────────────
const DEFAULT_GENRES = [
  'fantasy', 'nature', 'adventure', 'mythology', 'sci-fi', 'historical',
  'fairy-tale', 'mystery', 'folklore', 'magical-realism', 'slice-of-life',
  'romance', 'horror', 'noir', 'cyberpunk', 'steampunk', 'post-apocalyptic',
  'western', 'urban-fantasy', 'thriller', 'coming-of-age', 'mythic',
  'speculative-fiction', 'anthology', 'ghost-story', 'bedtime-story',
]
const DEFAULT_MOODS = [
  'calming', 'adventurous', 'mysterious', 'whimsical', 'cozy',
  'ethereal', 'melancholic', 'hopeful', 'bittersweet', 'reflective',
  'suspenseful', 'haunting', 'dreamy', 'nostalgic', 'serene',
  'tender', 'eerie', 'playful', 'contemplative', 'wistful',
  'uplifting', 'meditative', 'quiet', 'restful',
]
const DEFAULT_THEMES = [
  'overcoming fear', 'finding home', 'letting go', 'self-discovery',
  'second chances', 'friendship', 'resilience', 'growing up',
  'healing', 'forgiveness', 'belonging', 'legacy', 'transformation',
  'courage', 'inner peace', 'community', 'ancestry', 'memory',
  'balance with nature', 'wonder', 'loss and renewal', 'identity',
  'purpose', 'quiet rebellion', 'grief', 'acceptance',
]
const DEFAULT_KEYWORDS = [
  'forest', 'ocean', 'mountain', 'desert', 'village', 'island',
  'ancient', 'twilight', 'dawn', 'starlight', 'moonlit', 'lantern',
  'whisper', 'river', 'meadow', 'garden', 'thunderstorm', 'snow',
  'cabin', 'lighthouse', 'bridge', 'marketplace', 'library', 'observatory',
  'temple', 'orchard', 'ruin', 'vineyard', 'tundra', 'coast',
  'loom', 'compass', 'locket', 'map', 'clock', 'mirror',
  'wolf', 'fox', 'owl', 'stag', 'dragon', 'phoenix',
  'grandmother', 'child', 'wanderer', 'scholar', 'musician', 'sailor',
]

const customGenres = ref<string[]>([])
const customMoods = ref<string[]>([])
const customThemes = ref<string[]>([])
const customKeywords = ref<string[]>([])

const allGenres = computed(() => Array.from(new Set([...DEFAULT_GENRES, ...customGenres.value])).sort())
const allMoods = computed(() => Array.from(new Set([...DEFAULT_MOODS, ...customMoods.value])).sort())
const allThemes = computed(() => Array.from(new Set([...DEFAULT_THEMES, ...customThemes.value])).sort())
const allKeywords = computed(() => Array.from(new Set([...DEFAULT_KEYWORDS, ...customKeywords.value])).sort())

function onAddGenre(v: string) { if (!customGenres.value.includes(v)) { customGenres.value.push(v); persistCustomLists().catch(() => {}) } }
function onAddMood(v: string) { if (!customMoods.value.includes(v)) { customMoods.value.push(v); persistCustomLists().catch(() => {}) } }
function onAddTheme(v: string) { if (!customThemes.value.includes(v)) { customThemes.value.push(v); persistCustomLists().catch(() => {}) } }
function onAddKeyword(v: string) { if (!customKeywords.value.includes(v)) { customKeywords.value.push(v); persistCustomLists().catch(() => {}) } }

// ── Randomize / Surprise Me ───────────────────────────────────────────────
// Randomize fills the creative fields (genre, theme, mood, audience, keywords)
// from the existing pools — it does NOT touch `count` or `model` since those
// are user-controlled cost dials. Surprise Me randomizes then auto-generates.
const AUDIENCE_OPTIONS = ['adults', 'children', 'teens', 'all-ages']

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
  const audience = pickRandom(AUDIENCE_OPTIONS)
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
  editorForm.suggested_chapters = from?.suggested_chapters || 10
  editorForm.suggested_length = from?.suggested_length || '45 min'
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
    suggested_chapters: editorForm.suggested_chapters || 10,
    suggested_length: editorForm.suggested_length.trim() || '45 min',
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

// Re-fetched whenever the format or pattern changes so the copied prompt
// always reflects the user's current selection. Query-params follow the
// same shape the in-app generate flow uses (pattern_id + pattern_subject).
async function refetchPastePrompt() {
  const qs = new URLSearchParams()
  if (form.pattern_id) qs.set('pattern_id', form.pattern_id)
  if (form.pattern_subject) qs.set('pattern_subject', form.pattern_subject)
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

// Live-refresh the prompt when the user changes pattern WHILE the modal
// is open. Skipped when the modal is closed (no DOM to update; the
// next open will refetch anyway).
watch(
  [() => form.pattern_id, () => form.pattern_subject],
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
    allIdeas.value = data.ideas || []
    nextEpisodeNum.value = data.next_episode_number || 1
    episodePrefix.value = data.episode_prefix || 'EP'
  } catch {}
}

async function generate() {
  generating.value = true
  try {
    await post(`/projects/${slug.value}/generate/ideas`, { ...form, keywords: form.keywords })
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
  // Gmail-style: optimistically hide the row, show an Undo toast, defer the
  // actual backend delete until the toast expires. If the user clicks Undo
  // within the 5 s window we put the row back in its original slot and the
  // destructive call never happens — no restore endpoint needed.
  const idx = allIdeas.value.findIndex(i => i.id === id)
  if (idx < 0) return
  const target = allIdeas.value[idx]
  const wasSelected = selectedIds.value.has(id)

  // Optimistic removal
  allIdeas.value = [...allIdeas.value.slice(0, idx), ...allIdeas.value.slice(idx + 1)]
  selectedIds.value.delete(id)

  const label = target.title ? `"${target.title}"` : 'idea'
  successUndoable({
    message: `Deleted ${label}`,
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

onMounted(loadIdeas)
</script>

<style scoped>
/* Generator panel */
.generator-panel { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 18px 20px 20px; }
.generator-title { margin: 0 0 12px; }
.generator-body { display: flex; flex-direction: column; gap: 12px; }
.generator-actions { margin-top: 16px; padding-top: 14px; border-top: 1px dashed var(--border); display: flex; flex-direction: column; gap: 10px; }
.generator-actions-primary { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.generator-actions-secondary { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }

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

.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; justify-content: center; align-items: center; z-index: 1000; }
.modal { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-xl); padding: 32px; width: 520px; }
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

/* Pattern picker on the Ideas page sits between the model row and the
   action buttons. Pad it so it doesn't run flush into either. */
.ideas-pattern-block {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
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
.paste-preview-table {
  max-height: 260px;
  overflow-y: auto;
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
</style>
