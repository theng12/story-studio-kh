<template>
  <div class="home">
    <!-- Header -->
    <header class="home-header">
      <div>
        <h1>Story Studio KH</h1>
        <p class="text-muted">Create, generate, and produce story episodes</p>
      </div>
      <div class="home-header-actions">
        <NuxtLink
          to="/usage"
          class="home-settings-btn"
          title="Cost dashboard — text-model API spend across all projects"
        >
          <span class="home-settings-icon" aria-hidden="true">$</span>
          <span class="home-settings-label">Usage</span>
        </NuxtLink>
        <button
          type="button"
          class="home-settings-btn"
          title="This Mac — API keys, appearance, server mode. Shared across every project on this machine, never synced. (Per-project settings live inside each project.)"
          aria-label="Open This Mac settings"
          @click="appSettingsModal.open()"
        >
          <span class="home-settings-icon" aria-hidden="true">⚙</span>
          <span class="home-settings-label">Settings</span>
        </button>
      </div>
    </header>

    <!-- iCloud-syncing banner: surfaces when one or more project rows
         are blocked on a macOS-level cloud download. The list still
         renders + Create / Add buttons stay clickable, so the user
         isn't trapped waiting for sync to finish before they can do
         anything. Polling at 5s promotes downloading rows once the
         file is local. -->
    <div
      v-if="downloadingProjects.length > 0"
      class="icloud-syncing-banner"
      role="status"
      aria-live="polite"
    >
      <span class="icb-icon" aria-hidden="true">⏬</span>
      <span class="icb-text">
        <strong>{{ downloadingProjects.length }} project{{ downloadingProjects.length === 1 ? '' : 's' }} downloading from iCloud Drive…</strong>
        They'll show up here once macOS finishes syncing the metadata.
        You can keep using the app meanwhile — Create and Add Existing work as usual.
      </span>
    </div>

    <!-- v1.0.316 — Couldn't-load state: distinct from genuine empty (Welcome).
         Auto-retry already ran (4 attempts × backoff); this is the manual-
         recovery exit. The backend usually comes back the moment the heavy
         audio merge / image batch step finishes a phase, so a single click
         typically works. -->
    <div v-if="!loading && projects.length === 0 && projectsLoadError" class="onboarding">
      <div class="onboarding-card">
        <div class="onboarding-icon" aria-hidden="true">&#9888;</div>
        <h2>Couldn't load your projects</h2>
        <p>
          We tried a few times. The backend is probably busy with a big job
          (audio merge, image batch). Wait a moment and try again — your
          projects and data are safe on disk.
        </p>
        <p class="text-muted" style="font-size: 12px;">{{ projectsLoadError }}</p>
        <div class="flex gap-2 mt-2" style="justify-content:center; flex-wrap:wrap">
          <button class="btn btn-primary btn-lg" :disabled="projectsRetrying" @click="retryLoadProjects">
            <LoadingSpinner v-if="projectsRetrying" size="sm" />
            {{ projectsRetrying ? 'Retrying…' : 'Retry' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Onboarding (no projects yet — and not just because they're all
         mid-download from iCloud). -->
    <div v-else-if="!loading && projects.length === 0" class="onboarding">
      <div class="onboarding-card">
        <div class="onboarding-icon">&#10024;</div>
        <h2>Welcome to Story Studio KH</h2>
        <p>Create your first project to start generating story episodes with AI.</p>
        <div class="flex gap-2 mt-2" style="justify-content:center; flex-wrap:wrap">
          <button class="btn btn-primary btn-lg" @click="showCreate = true">
            Create Your First Project
          </button>
          <button class="btn btn-secondary btn-lg" @click="openAddLinked">
            🔗 Add existing project folder…
          </button>
        </div>
        <p class="text-muted mt-2" style="font-size: 12px;">
          Got a project folder from another Mac via iCloud / Google Drive / OneDrive?
          Click <strong>Add existing project folder</strong> and pick the folder named after
          your project (the one that contains <code>project.json</code>). Nothing gets copied
          or moved — your existing assets just appear in this Mac's list.
        </p>
      </div>
    </div>

    <!-- Initial first-paint placeholder while we don't know yet whether
         the user has any projects. We keep this minimal so the shell
         (header + Create button below) renders immediately even when
         the projects API is slow on a fresh iCloud setup. -->
    <div v-else-if="loading && projects.length === 0" class="project-list">
      <div class="flex justify-between items-center mb-2">
        <h2>Your Projects</h2>
        <div class="flex gap-2">
          <button
            class="btn btn-secondary"
            title="Register a project folder that lives outside the default projects folder."
            @click="openAddLinked"
          >🔗 Add existing project folder…</button>
          <button class="btn btn-primary" @click="showCreate = true">+ New Project</button>
        </div>
      </div>
      <p class="text-muted">Scanning projects…</p>
    </div>

    <!-- Project list -->
    <div v-else class="project-list">
      <div class="flex justify-between items-center mb-2">
        <h2>Your Projects</h2>
        <div class="flex gap-2">
          <!-- Hidden projects chip — visible only when the user has
               soft-deleted at least one project. Click → toggles the
               expandable panel below the chip row. -->
          <button
            v-if="softDeleted.items.value.length > 0"
            class="btn btn-secondary"
            :title="`${softDeleted.items.value.length} project folder${softDeleted.items.value.length === 1 ? '' : 's'} hidden from this list but still on disk. Click to manage.`"
            @click="hiddenPanelOpen = !hiddenPanelOpen"
          >🗑️ Hidden ({{ softDeleted.items.value.length }})</button>
          <button
            class="btn btn-secondary"
            title="Register a project folder that lives outside the default projects folder (e.g. a project synced from another Mac via iCloud Drive). Doesn't copy or move anything; just adds it to the list on this Mac."
            @click="openAddLinked"
          >🔗 Add existing project folder…</button>
          <button class="btn btn-primary" @click="showCreate = true">+ New Project</button>
        </div>
      </div>

      <!-- Hidden projects panel — collapsed by default; expanded via
           the chip. Each row shows the slug, name, path, size, and
           three actions: open in Finder (non-destructive), restore
           (re-add to live list), and delete from disk (irreversible,
           confirmed). Empty disk + missing folder are surfaced as a
           muted "(folder no longer on disk)" tag so the user can
           one-click forget the stale tombstone. -->
      <div v-if="hiddenPanelOpen && softDeleted.items.value.length > 0" class="hidden-projects-panel mb-2">
        <div class="hidden-projects-header">
          <span><strong>🗑️ Hidden projects</strong></span>
          <span class="text-muted" style="font-size: 12px;">
            Removed from the app but still on disk. Restore to bring back, or permanently delete the folder when you're done with it.
          </span>
        </div>
        <div
          v-for="row in softDeleted.items.value"
          :key="row.slug"
          class="hidden-project-row"
        >
          <div class="hidden-project-info">
            <div><strong>{{ row.name }}</strong> <code style="font-size: var(--font-xs);">({{ row.slug }})</code></div>
            <div class="text-muted" style="font-size: var(--font-xs); word-break: break-all;">
              <code>{{ row.path }}</code>
            </div>
            <div class="text-muted" style="font-size: var(--font-xs);">
              <template v-if="row.exists">
                {{ formatBytes(row.estimated_bytes) }}
                <template v-if="row.deleted_at"> · hidden {{ formatRelativeTime(row.deleted_at) }}</template>
              </template>
              <template v-else>
                <span style="color: #f59e0b;">⚠ Folder no longer on disk</span>
                — you can clear this entry by clicking <em>Restore</em> then re-hiding (or just <em>Delete from disk</em> below).
              </template>
            </div>
          </div>
          <div class="hidden-project-actions">
            <button
              v-if="row.exists"
              class="btn btn-sm btn-secondary"
              title="Reveal the folder in Finder so you can inspect or move files manually."
              @click="softDeleted.revealInFinder(row.path)"
            >📁 Open in Finder</button>
            <button
              class="btn btn-sm btn-secondary"
              title="Bring this project back into the app's live list. Files are untouched."
              @click="restoreHiddenProject(row.slug)"
            >↩ Restore</button>
            <button
              class="btn btn-sm btn-danger"
              :title="row.exists
                ? `Permanently delete the folder + clear this entry. Cannot be undone.`
                : `Forget this entry — the folder is already gone.`"
              @click="hardDeleteHiddenProject(row)"
            >🗑️ Delete from disk</button>
          </div>
        </div>
      </div>

      <div class="grid-3">
        <template v-for="project in projects" :key="project.slug">
          <!-- iCloud-downloading row: greyed out, no click target, an
               inline pill showing the syncing state. The folder name
               (used as the slug) + path stay visible so the user knows
               which project this is. Promoted to the regular row below
               on the next /projects poll once the placeholder clears. -->
          <div
            v-if="project.status === 'downloading'"
            class="project-card project-card--downloading"
            :title="`Waiting for macOS to finish downloading metadata from iCloud Drive — path: ${project.output_root || project.slug}`"
          >
            <div class="project-card-header">
              <h3>{{ project.name || project.slug }}</h3>
              <div class="project-card-badges">
                <span class="badge badge-syncing">⏬ Syncing from iCloud</span>
              </div>
            </div>
            <div class="project-card-meta">
              <span style="word-break: break-all; font-family: ui-monospace, monospace; font-size: var(--font-xs);">
                {{ project.output_root || '' }}
              </span>
            </div>
          </div>

          <!-- Regular ready/error row -->
          <div
            v-else
            class="project-card"
            @click="navigateTo(`/projects/${project.slug}`)"
          >
            <div class="project-card-header">
              <h3>{{ project.name }}</h3>
              <div class="project-card-badges">
                <span
                  v-if="project.output_root_exists === false"
                  class="badge badge-error"
                  :title="`Folder not found on disk: ${project.output_root}. Use 'Add existing project folder…' to register its new location, or open the Project tab → 'Move this project to…' to relocate.`"
                >⚠ Folder missing</span>
                <!-- Linked-location chip — fires when this project's folder
                     lives outside the default PROJECTS_ROOT (registered via
                     Add existing project folder… or moved here via the
                     Project tab). Helps the operator distinguish "in iCloud"
                     from "on local disk" at a glance. -->
                <span
                  v-if="isLinkedSlug(project.slug)"
                  class="badge badge-linked"
                  :title="`Linked from ${linkedPathFor(project.slug)}. Right-click in the Project tab to relocate or unlink.`"
                >🔗 Linked</span>
                <span class="badge" :class="project.has_api_keys ? 'badge-done' : 'badge-queued'">
                  {{ project.has_api_keys ? 'Ready' : 'Setup needed' }}
                </span>
              </div>
            </div>
            <div class="project-card-meta">
              <span>Prefix: {{ project.episode_prefix }}</span>
              <span>Created {{ formatDate(project.created_at) }}</span>
              <span
                v-if="formatLabel(project.format_id)"
                class="project-format-chip"
                :title="`This project's video format — change it in Settings → Format.`"
              >📐 {{ formatLabel(project.format_id) }}</span>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Add existing project folder modal -->
    <div v-if="addLinkedOpen" class="modal-overlay" @click.self="closeAddLinked">
      <div class="modal" style="max-width: 620px;">
        <h2>Add existing project folder</h2>
        <p class="text-muted mt-1" style="font-size: 13px;">
          Register a Story Studio project folder that lives outside the default projects folder.
          Use this when an iCloud sync has brought a project from another Mac and you want it
          listed here, or when you've moved a project's folder manually on disk and need the
          app to find it again. <strong>Nothing is copied or moved</strong> — the folder stays
          where it is; this just adds it to this Mac's list.
        </p>

        <!-- "What folder?" guidance — the most common confusion is people
             pointing at the iCloud Drive root or the parent "Story Studio"
             folder instead of the per-project folder. -->
        <div class="add-linked-hint mt-2">
          <strong>📂 Pick the folder named after your project</strong>
          — the one that contains <code>project.json</code>.
          <div class="text-muted mt-1" style="font-size: 12px;">
            Example: <code>~/Library/Mobile Documents/com~apple~CloudDocs/Story Studio KH/projects/<strong>terranash</strong></code>
            — not the parent <code>projects</code> folder, and not the iCloud Drive root.
          </div>
        </div>

        <div class="flex gap-2 mt-2">
          <input
            v-model="addLinkedPath"
            class="input"
            placeholder="Absolute path to the project folder (the one with project.json)"
            style="flex: 1;"
          />
          <button class="btn btn-sm btn-secondary" @click="browseLinkedFolder">Browse…</button>
          <button
            class="btn btn-sm btn-secondary"
            :disabled="!addLinkedPath || addLinkedInspecting"
            @click="inspectLinked"
          >{{ addLinkedInspecting ? 'Inspecting…' : 'Inspect' }}</button>
        </div>

        <div v-if="addLinkedInspectResult" class="mt-2" style="font-size: 13px;">
          <div v-if="addLinkedInspectResult.reason" class="add-linked-error">
            ⚠ {{ addLinkedInspectResult.reason }}
            <!-- "Did you mean…?" chips for the parent-folder mistake.
                 Click → re-fill the path input with the child folder
                 + auto-rerun inspect so the user lands on the success
                 preview without another Browse trip. -->
            <div
              v-if="addLinkedInspectResult.suggestions && addLinkedInspectResult.suggestions.length"
              class="flex gap-2 mt-2"
              style="flex-wrap: wrap;"
            >
              <button
                v-for="sug in addLinkedInspectResult.suggestions"
                :key="sug.path"
                class="btn btn-sm btn-secondary"
                :title="sug.path"
                @click="pickSuggestion(sug.path)"
              >📁 {{ sug.name }}</button>
            </div>
          </div>
          <div v-else class="add-linked-preview">
            <div><strong>Project:</strong> {{ addLinkedInspectResult.name }}</div>
            <div><strong>Slug:</strong> <code>{{ addLinkedInspectResult.slug }}</code></div>
            <div><strong>Path:</strong> <code>{{ addLinkedInspectResult.path }}</code></div>
          </div>
        </div>

        <div v-if="addLinkedError" class="add-linked-error mt-2">{{ addLinkedError }}</div>

        <div class="flex gap-2 mt-3" style="justify-content: flex-end;">
          <button class="btn btn-secondary" @click="closeAddLinked">Cancel</button>
          <button
            class="btn btn-primary"
            :disabled="!addLinkedInspectResult || !!addLinkedInspectResult.reason || addLinkedAdding"
            @click="confirmAddLinked"
          >
            {{ addLinkedAdding ? 'Adding…' : 'Link this folder' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Create project modal -->
    <div v-if="showCreate" class="modal-overlay" @click.self="closeCreate">
      <div class="modal">
        <h2>Create New Project</h2>

        <!-- Step indicator (6 steps: Basics → Location → Video tools → GenStudio → Upload → Review).
             Mode picker (multi-machine vs local-only) was removed alongside the
             legacy manifest-sync feature — there's now only one mode. Cloud sync
             happens at the OS level by storing the projects folder inside iCloud
             Drive (or any synced location), configurable in Settings → Storage. -->
        <div class="steps">
          <div v-for="s in 6" :key="s" :class="['step', { active: step === s, done: step > s }]">
            {{ s }}
          </div>
        </div>

        <!-- Step 1: Basics -->
        <div v-if="step === 1">
          <div class="form-group">
            <label>Project Name</label>
            <input v-model="form.name" class="input" placeholder="My Sleep Stories" />
          </div>
          <div class="grid-3">
            <div class="form-group">
              <label>Episode Prefix</label>
              <input v-model="form.episode_prefix" class="input" placeholder="EP" />
            </div>
            <div class="form-group">
              <label>Group Label</label>
              <input v-model="form.season_prefix" class="input" placeholder="Season" />
              <span class="text-muted" style="font-size: var(--font-xs)">Season, Batch, Volume, etc.</span>
            </div>
            <div class="form-group">
              <label>Episodes per Group</label>
              <input v-model.number="form.season_size" class="input" type="number" min="1" />
            </div>
          </div>
          <div class="form-group">
            <label id="template-label">Folder Template</label>
            <div class="template-cards" role="radiogroup" aria-labelledby="template-label">
              <button
                v-for="t in templates"
                :key="t.id"
                type="button"
                role="radio"
                :aria-checked="form.template === t.id"
                :class="['template-card', { selected: form.template === t.id }]"
                @click="form.template = t.id"
                @keydown.space.prevent="form.template = t.id"
              >
                <span class="template-icon" aria-hidden="true">{{ templateIcon(t.id) }}</span>
                <strong>{{ t.name }}</strong>
                <p>{{ t.description }}</p>
              </button>
            </div>
          </div>

          <!-- Niche picker — PRIMARY content/voice chooser (v1.0.280+).
               The niche decides WHAT the video says and HOW it feels:
               vocabulary, title style, narrator voice, emotional tone, and
               visual mood. Format (below) only decides how it's built. Comes
               first because most users think "what's my channel about?" before
               "how is each video assembled?". -->
          <div class="form-group">
            <label id="niche-label">
              Content &amp; voice
              <span class="text-muted" style="font-size: var(--font-xs); font-weight: normal;">
                — the niche is your channel's voice: vocabulary, title style, narrator, mood. This is the main creative choice.
              </span>
            </label>
            <NichePicker v-model="form.niche_id" />
          </div>

          <!-- Channel Format picker (v1.0.68+).
               Picks WHICH content style the new project's prompts +
               vocab + image / metadata defaults are tuned for. Folder
               Template above governs the on-disk layout; Format below
               governs HOW the video is built (the niche governs WHAT it
               says). They're independent — any niche pairs with any
               format. Default 'scenes' (AI-generated stills) is used for
               users who skip the picker.
               v1.0.69: the auto-selected default format gets a
               "Default" badge so users know which one they'll ship
               with if they don't interact with the picker. -->
          <div class="form-group">
            <label id="format-label">
              Format — how it's built
              <span class="text-muted" style="font-size: var(--font-xs); font-weight: normal;">
                — the production pipeline (AI scenes, badges, character continuity, or stock footage). The niche above sets the voice. Change later from Settings → Format.
              </span>
            </label>
            <div v-if="formatsLoading" class="text-muted" style="font-size: 12px; padding: 8px 0;">
              Loading formats…
            </div>
            <!-- v1.0.70: 8 format cards no longer fit comfortably on one row,
                 so the picker becomes a carousel — overflow-x scroll with
                 chevron buttons that appear when there's more to see in
                 either direction. Avoids both horizontal scrollbars (ugly)
                 and shrinking cards into illegibility. -->
            <div v-else class="format-carousel">
              <button
                type="button"
                class="format-carousel-arrow left"
                aria-label="Scroll formats left"
                :disabled="!canScrollFormatsLeft"
                @click="scrollFormats(-1)"
              >‹</button>
              <div
                ref="formatCardsEl"
                class="template-cards format-cards"
                role="radiogroup"
                aria-labelledby="format-label"
                @scroll="onFormatScroll"
              >
                <button
                  v-for="f in formats"
                  :key="f.id"
                  type="button"
                  role="radio"
                  :aria-checked="form.format_id === f.id"
                  :class="['template-card', 'format-card', { selected: form.format_id === f.id }]"
                  @click="form.format_id = f.id"
                  @keydown.space.prevent="form.format_id = f.id"
                  :title="f.description || ''"
                >
                  <span class="template-icon" aria-hidden="true">{{ formatIcon(f.id) }}</span>
                  <strong>
                    {{ f.name }}
                    <span
                      v-if="f.id === DEFAULT_FORMAT_ID"
                      class="format-default-pill"
                      title="Auto-selected when you don't pick a format. Click another card to change."
                    >Default</span>
                  </strong>
                  <p>{{ formatBuildLine(f) }}</p>
                </button>
              </div>
              <button
                type="button"
                class="format-carousel-arrow right"
                aria-label="Scroll formats right"
                :disabled="!canScrollFormatsRight"
                @click="scrollFormats(1)"
              >›</button>
            </div>
            <div v-if="!formatsLoading && !formats.length" class="text-muted" style="font-size: 12px; padding: 4px 0;">
              No formats available — pick a folder template and continue;
              the format will default to <code>sleep-story</code> and you
              can change it from Settings → Format after creation.
            </div>
          </div>

          <div class="flex gap-2">
            <button class="btn btn-secondary" @click="closeCreate">Cancel</button>
            <button class="btn btn-primary" :disabled="!form.name" @click="step = 2">
              Next: Save Location
            </button>
          </div>
        </div>

        <!-- Step 2: Save Location (new) -->
        <div v-if="step ===2">
          <p class="text-muted mb-2" style="font-size: 13px;">
            Choose where on your computer this project's files (scripts, images,
            audio, video) should be saved. You'll be able to reach them in Finder
            any time. To work cross-machine, point at a cloud-synced folder
            (iCloud Drive / Dropbox / Google Drive). The Storage tab in Settings
            also lets you move all projects to a synced root after the fact.
          </p>
          <div class="form-group">
            <label>Save Location</label>
            <div class="flex gap-2 items-center mt-1" style="flex-wrap:wrap">
              <button type="button" class="btn btn-secondary" :disabled="picking" @click="pickFolder">
                📁 {{ picking ? 'Opening…' : 'Choose Folder…' }}
              </button>
              <code v-if="form.output_root" class="path-display">
                {{ form.output_root }}/{{ form.name }}
              </code>
              <span v-else class="text-muted" style="font-size:12px">No folder selected yet</span>
            </div>
          </div>
          <div class="warning-box">
            <strong>⚠️ Keep this folder where you put it.</strong><br />
            Story Studio remembers the location. If you later move, rename, or delete this folder, generation jobs will fail until you run
            <em>Settings → Repair Folder Structure</em>.
          </div>
          <div class="flex gap-2 mt-2">
            <button class="btn btn-secondary" @click="step = 1">Back</button>
            <button class="btn btn-primary" :disabled="!form.output_root" @click="step = 3">
              Next: Video tools
            </button>
          </div>
        </div>

        <!-- Step 3: Video tools (FFmpeg) -->
        <div v-if="step ===3">
          <p class="text-muted mb-2" style="font-size: 13px;">
            Story Studio uses <strong>FFmpeg</strong> to merge chapter audio and to
            assemble your final video. Let's make sure it's ready before you start —
            that way you won't hit a blocker in the middle of your first episode.
          </p>

          <div v-if="ffmpegChecking" class="ffmpeg-status-box">
            <span class="ffmpeg-status-icon">⏳</span>
            <div><strong>Checking for FFmpeg…</strong></div>
          </div>

          <div v-else-if="ffmpegStatus?.installed" class="ffmpeg-status-box ffmpeg-ok">
            <span class="ffmpeg-status-icon" aria-hidden="true">✓</span>
            <div style="min-width: 0;">
              <strong>FFmpeg is ready.</strong>
              <template v-if="ffmpegStatus.source === 'bundled'">
                <div class="text-muted" style="font-size: 12px; margin-top: 2px;">
                  Version <code>{{ ffmpegStatus.version }}</code> ·
                  Built into Story Studio — no system install needed.
                </div>
                <div class="text-muted" style="font-size: var(--font-xs); margin-top: 4px;">
                  (You won't see this binary in <code>which ffmpeg</code> or in <code>/usr/local/bin</code> —
                  it lives inside the .app and only Story Studio uses it.)
                </div>
              </template>
              <template v-else>
                <div class="text-muted" style="font-size: 12px; margin-top: 2px;">
                  Version <code>{{ ffmpegStatus.version }}</code>
                  · Detected on your system
                </div>
              </template>
              <div v-if="ffmpegStatus.path" class="text-muted" style="font-size: var(--font-xs); word-break: break-all; margin-top: 4px;">
                <code>{{ ffmpegStatus.path }}</code>
              </div>
            </div>
          </div>

          <div v-else>
            <div class="ffmpeg-status-box ffmpeg-missing">
              <span class="ffmpeg-status-icon" aria-hidden="true">⚠️</span>
              <div>
                <strong>FFmpeg is not installed.</strong>
                <p class="text-muted" style="font-size: 12px; margin: 4px 0 0;">
                  Pick one option below. You can continue as soon as it's verified.
                </p>
              </div>
            </div>

            <div v-if="!ffmpegInstalling" class="mt-2">
              <button
                class="btn btn-primary"
                style="width: 100%;"
                :disabled="ffmpegChecking"
                @click="installFFmpeg"
              >
                Download automatically (~80&nbsp;MB)
              </button>
              <p class="text-muted mt-1" style="font-size: var(--font-xs); text-align: center;">
                Pre-built FFmpeg binary, saved inside the app's data folder.
              </p>

              <div class="manual-install mt-2">
                <p class="text-muted" style="font-size: 12px;">Or install it yourself:</p>
                <div class="manual-commands mt-1">
                  <code v-if="isMac">brew install ffmpeg</code>
                  <code v-else-if="isLinux">sudo apt install ffmpeg</code>
                  <code v-else>Download from ffmpeg.org/download.html and add to PATH</code>
                </div>
                <button
                  class="btn btn-secondary btn-sm mt-1"
                  :disabled="ffmpegChecking"
                  @click="recheckFFmpeg"
                >
                  {{ ffmpegChecking ? 'Checking…' : 'I\'ve installed it — check again' }}
                </button>
              </div>
            </div>

            <div v-if="ffmpegInstalling" class="ffmpeg-progress mt-2">
              <div class="progress-text">{{ ffmpegProgressMessage }}</div>
              <div class="progress-bar mt-1">
                <div class="progress-fill" :style="{ width: ffmpegProgressPercent + '%' }" />
              </div>
              <p class="text-muted mt-1" style="font-size: var(--font-xs);">
                This may take a minute — don't close the window.
              </p>
            </div>
          </div>

          <div v-if="ffmpegError" class="ffmpeg-error mt-2">
            <p style="color: var(--error); font-size: 13px; margin: 0;">{{ ffmpegError }}</p>
          </div>

          <div class="flex gap-2 mt-2">
            <button class="btn btn-secondary" :disabled="ffmpegInstalling" @click="step = 2">Back</button>
            <button
              class="btn btn-primary"
              :disabled="!ffmpegStatus?.installed || ffmpegInstalling"
              @click="step = 4"
            >
              Next: GenStudio
            </button>
          </div>
        </div>

        <!-- Step 4: the sole GenStudio generation boundary -->
        <div v-if="step ===4">
          <p class="text-muted mb-2">
            Story Studio uses one scoped GenStudio API key for every AI catalog,
            generation job, and credit event. You can add or rotate it later from
            <button
              type="button"
              @click="appSettingsModal.open()"
              style="background: none; border: 0; padding: 0; font: inherit; color: var(--accent); text-decoration: underline; cursor: pointer;"
            >Settings → This Mac</button>.
          </p>
          <div class="precheck-banner precheck-info" style="margin-bottom: 12px;">
            <span>
              🔑 <strong>One app-wide connection.</strong>
              The key is stored once on this Mac, remains masked after save, and is used by every project.
              <span v-if="appKeysAlreadyConfigured > 0">
                A GenStudio key is already configured. Leave this field blank to keep it, or paste a replacement.
              </span>
            </span>
          </div>

          <!-- Per-key verification. Each row tests its key on blur OR on
               explicit Test-button click — never on every keystroke (rate
               limits). Editing a key resets its pill back to "untested" so a
               green pill can't outlive the key it vouches for. The "Continue
               without testing" link per row is a per-key bypass: it lets the
               operator advance with an unverified key (e.g. GenStudio temporarily down)
               without globally turning off verification. -->
          <div
            v-for="row in keyRows"
            :key="row.provider"
            class="form-group"
          >
            <label class="key-label">
              <span>{{ row.label }}</span>
              <KeyTestPill :status="keyTests[row.provider].status" :message="keyTests[row.provider].message" />
              <span
                v-if="keyTests[row.provider].bypassed"
                class="bypass-pill"
                title="You chose to advance without verifying this key. You can re-test in Settings later."
              >
                ⤼ Bypassed
              </span>
              <span
                v-if="appKeysExisting[row.provider] && !apiKeys[row.provider].trim()"
                class="bypass-pill"
                title="This provider already has a key configured at app level. Leave the row blank to keep it; type to replace."
              >
                ✓ Already configured
              </span>
            </label>
            <div class="key-row">
              <ApiKeyInput
                v-model="apiKeys[row.provider]"
                :placeholder="row.placeholder"
                :aria-label="row.label"
                @update:model-value="resetKeyStatus(row.provider)"
                @blur="onKeyBlur(row.provider)"
              />
              <button
                type="button"
                class="btn btn-sm btn-secondary key-test-btn"
                :disabled="!apiKeys[row.provider].trim() || keyTests[row.provider].status === 'testing'"
                :title="!apiKeys[row.provider].trim() ? 'Enter a key to test' : `Call ${row.label.split(' API Key')[0]} to verify this key`"
                @click="testOneKey(row.provider)"
              >
                {{ keyTests[row.provider].status === 'testing' ? 'Testing…' : 'Test' }}
              </button>
            </div>
            <!-- Per-key bypass: appears only when the key needs gating
                 (entered, not valid, not already bypassed). Lets the
                 operator say "I know, I'll fix it later" without flipping
                 a global skip that affects every row. -->
            <button
              v-if="apiKeys[row.provider].trim()
                && keyTests[row.provider].status !== 'valid'
                && keyTests[row.provider].status !== 'testing'
                && !keyTests[row.provider].bypassed"
              type="button"
              class="bypass-link"
              :title="'Skip verification for this key only. You can test it in Settings → This Mac later.'"
              @click="bypassKey(row.provider)"
            >
              Continue without testing — I'll add this later
            </button>
          </div>

          <!-- The test checks the configured GenStudio URL and every scope
               Story Studio needs without submitting a billable generation. -->
          <div class="flex gap-2 items-center mt-2" style="flex-wrap:wrap">
            <button
              type="button"
              class="btn btn-secondary"
              :disabled="keysTesting || providedKeyCount === 0"
              :title="providedKeyCount === 0 ? 'Enter a GenStudio key to test' : 'Verify the GenStudio URL, key, and required scopes without generating'"
              @click="testAllKeys"
            >
              {{
                keysTesting ? 'Testing…' : '🔍 Test GenStudio scopes'
              }}
            </button>
            <span v-if="verificationSummary" class="text-muted" style="font-size: 12px;">
              {{ verificationSummary }}
            </span>
          </div>

          <div class="flex gap-2 mt-2">
            <button class="btn btn-secondary" @click="step = 3">Back</button>
            <button
              class="btn btn-primary"
              :disabled="!canAdvancePastKeys"
              :title="nextBlockReason"
              @click="step = 5"
            >
              Next: Upload destinations
            </button>
          </div>
        </div>

        <!-- Step 5: Upload destinations ─────────────────────────────────────
             Inserted between GenStudio and Review so the machine is pinned
             to the right YouTube channel at setup — not 30 minutes later,
             which is when a wrong-channel upload could already have happened
             (see audit-reports/04 §3). Each row is skippable so users without
             a TikTok/FB presence aren't blocked. -->
        <div v-if="step ===5">
          <div class="flex justify-between items-center mb-2" style="gap: 8px; flex-wrap: wrap;">
            <p class="text-muted" style="font-size: 13px; margin: 0; flex: 1 1 260px;">
              Connect the accounts you'll publish to. Each row is optional —
              skip any you don't use and add them later in Settings → Upload.
            </p>
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              title="Mark YouTube as skipped. The project is created without any OAuth tokens; connect later from Settings → Upload."
              @click="skipAllUploads"
            >Skip all — connect later</button>
          </div>

          <!-- YouTube row -->
          <div class="upload-row" :class="{ skipped: uploadStep.youtube.skipped, connected: !!uploadStep.youtube.channelId }">
            <div class="upload-row-head">
              <div>
                <strong>▶ YouTube</strong>
                <span v-if="uploadStep.youtube.channelId" class="state-pill state-set">✓ Connected</span>
                <span v-else-if="uploadStep.youtube.skipped" class="state-pill state-muted">Skipped</span>
                <span v-else class="state-pill state-empty">Not connected</span>
              </div>
              <div class="upload-row-actions">
                <button
                  v-if="!uploadStep.youtube.skipped && !uploadStep.youtube.channelId"
                  type="button"
                  class="btn btn-sm btn-ghost"
                  :disabled="uploadStep.youtube.connecting"
                  @click="uploadStep.youtube.skipped = true"
                >Skip</button>
                <button
                  v-if="uploadStep.youtube.skipped"
                  type="button"
                  class="btn btn-sm btn-ghost"
                  @click="uploadStep.youtube.skipped = false"
                >Un-skip</button>
              </div>
            </div>

            <!-- Connect form (hidden when skipped or connected) -->
            <div v-if="!uploadStep.youtube.skipped && !uploadStep.youtube.channelId" class="upload-row-body">
              <p class="text-muted" style="font-size: 12px; margin: 4px 0 8px;">
                Paste your Google Cloud <strong>Desktop-app</strong> OAuth client — the
                <code>client_id</code> + <code>client_secret</code> from APIs &amp; Services → Credentials.
                Tokens land in this project's <code>secrets.json</code> (mode 0600) and never leave your machine.
              </p>
              <div class="form-group">
                <label style="font-size: 12px;">client_id</label>
                <input
                  v-model="uploadStep.youtube.clientId"
                  class="input input-sm"
                  placeholder="xxxxxxxx.apps.googleusercontent.com"
                  :disabled="uploadStep.youtube.clientSaving || uploadStep.youtube.connecting"
                />
              </div>
              <div class="form-group">
                <label style="font-size: 12px;">client_secret</label>
                <input
                  v-model="uploadStep.youtube.clientSecret"
                  type="password"
                  class="input input-sm"
                  placeholder="GOCSPX-..."
                  :disabled="uploadStep.youtube.clientSaving || uploadStep.youtube.connecting"
                />
              </div>
              <div class="flex gap-2 items-center" style="flex-wrap: wrap;">
                <button
                  type="button"
                  class="btn btn-sm btn-secondary"
                  :disabled="!canSaveYoutubeClient || uploadStep.youtube.clientSaving || uploadStep.youtube.connecting"
                  @click="saveYoutubeClientInWizard"
                >
                  {{ uploadStep.youtube.clientSaving ? 'Saving…' : (uploadStep.youtube.clientSaved ? '✓ Saved — re-save' : 'Save client') }}
                </button>
                <button
                  type="button"
                  class="btn btn-sm btn-primary"
                  :disabled="!uploadStep.youtube.clientSaved || uploadStep.youtube.connecting"
                  :title="uploadStep.youtube.clientSaved
                    ? 'Opens Google consent in your system browser. After approval, the redirect lands on our loopback server and the channel name appears here.'
                    : 'Save the client_id + client_secret first.'"
                  @click="connectYoutubeInWizard"
                >
                  {{ uploadStep.youtube.connecting ? (uploadStep.youtube.connectPhase || 'Connecting…') : '🔌 Connect YouTube' }}
                </button>
                <span
                  v-if="uploadStep.youtube.connectError"
                  class="text-danger"
                  style="font-size: 12px;"
                >{{ uploadStep.youtube.connectError }}</span>
              </div>
            </div>

            <!-- Connected card -->
            <div v-if="uploadStep.youtube.channelId" class="upload-row-body connected-card">
              <img
                v-if="uploadStep.youtube.channelThumb"
                :src="uploadStep.youtube.channelThumb"
                alt=""
                class="channel-thumb-sm"
              />
              <div style="flex: 1; min-width: 0;">
                <strong style="display: block;">{{ uploadStep.youtube.channelTitle }}</strong>
                <div class="text-muted" style="font-size: var(--font-xs);">
                  Channel id <code>{{ uploadStep.youtube.channelId }}</code>
                </div>
                <div class="text-muted" style="font-size: var(--font-xs);">
                  Tokens saved to this project's <code>secrets.json</code>.
                </div>
              </div>
            </div>
          </div>

          <!-- TikTok row (coming soon — always skippable) -->
          <div class="upload-row coming-soon">
            <div class="upload-row-head">
              <div>
                <strong>◉ TikTok</strong>
                <span class="state-pill state-muted">Coming in v2</span>
              </div>
            </div>
            <p class="text-muted" style="font-size: 12px; margin: 4px 0 0;">
              TikTok Content Posting API integration is planned for v2. You'll be able to connect here once it ships.
            </p>
          </div>

          <!-- Facebook row (coming soon — always skippable) -->
          <div class="upload-row coming-soon">
            <div class="upload-row-head">
              <div>
                <strong>f Facebook Pages</strong>
                <span class="state-pill state-muted">Coming in v2</span>
              </div>
            </div>
            <p class="text-muted" style="font-size: 12px; margin: 4px 0 0;">
              Facebook Page upload integration is planned for v2. You'll be able to connect here once it ships.
            </p>
          </div>

          <!-- Once the project is created on disk (needed so OAuth tokens can
               land in its secrets.json), going back to earlier steps would
               desync what's already persisted. Disable Back in that case. -->
          <div v-if="createdProject" class="text-muted mt-2" style="font-size: var(--font-xs);">
            Project <code>{{ createdProject.slug }}</code> has been created on disk so OAuth tokens
            can be persisted. Use Settings after Finish if you need to change earlier steps.
          </div>

          <div class="flex gap-2 mt-2">
            <button
              class="btn btn-secondary"
              :disabled="!!createdProject || uploadStep.youtube.connecting"
              :title="createdProject ? 'Project has been created — use Settings after Finish to edit earlier steps.' : ''"
              @click="step = 4"
            >Back</button>
            <button
              class="btn btn-primary"
              :disabled="uploadStep.youtube.connecting"
              @click="step = 6"
            >Next: Review</button>
          </div>
        </div>

        <!-- Step 6: Review -->
        <div v-if="step ===6">
          <div class="review-list">
            <div class="review-item">
              <span class="text-muted">Name</span>
              <span>{{ form.name }}</span>
            </div>
            <div class="review-item">
              <span class="text-muted">Folder Template</span>
              <span>{{ form.template }}</span>
            </div>
            <div class="review-item">
              <span class="text-muted">Content &amp; voice</span>
              <span v-if="form.niche_id">{{ selectedNicheName }}</span>
              <span v-else class="review-warn">⚠ No niche — generic voice</span>
            </div>
            <div class="review-item">
              <span class="text-muted">Format (how it's built)</span>
              <span>
                {{ formatIcon(form.format_id) }}
                {{ formats.find(f => f.id === form.format_id)?.name || form.format_id }}
              </span>
            </div>
            <div class="review-item">
              <span class="text-muted">Prefix</span>
              <span>{{ form.episode_prefix }}</span>
            </div>
            <div class="review-item">
              <span class="text-muted">Save Location</span>
              <span class="path-display-inline">{{ form.output_root }}/{{ form.name }}</span>
            </div>
            <div class="review-item">
              <span class="text-muted">Video tools</span>
              <span>
                <template v-if="ffmpegStatus?.installed">
                  ✓ FFmpeg {{ ffmpegStatus.version }}
                  <span class="text-muted" style="font-size: var(--font-xs);">
                    ({{ ffmpegStatus.source === 'bundled' ? 'bundled' : 'system' }})
                  </span>
                </template>
                <template v-else>Not installed</template>
              </span>
            </div>
            <div class="review-item">
              <span class="text-muted">GenStudio</span>
              <span>{{ keyCount ? 'Connected' : 'Not connected' }}</span>
            </div>
            <div class="review-item">
              <span class="text-muted">Upload</span>
              <span style="text-align: right;">
                <template v-if="uploadStep.youtube.channelId">
                  YouTube (<strong>{{ uploadStep.youtube.channelTitle }}</strong>)
                </template>
                <template v-else>YouTube (skipped)</template>
                <span class="text-muted"> / TikTok (skipped) / Facebook (skipped)</span>
              </span>
            </div>
          </div>
          <div class="flex gap-2 mt-2">
            <button class="btn btn-secondary" :disabled="creating" @click="step = 5">Back</button>
            <button class="btn btn-primary" :disabled="creating" @click="createProject">
              {{ creating ? 'Finishing…' : (createdProject ? 'Finish' : 'Create Project') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Import project modal -->
    <div v-if="showImport" class="modal-overlay" @click.self="closeImport">
      <div class="modal">
        <h2>Import Existing Project</h2>
        <p class="text-muted mb-2" style="font-size: 13px;">
          Pick a project folder — the app reads its structure and registers it here.
          No manifest required. API keys and presets are set up once per computer.
        </p>

        <!-- Step 1: pick folder -->
        <div v-if="importStep === 'pick'">
          <div class="form-group">
            <label>Project folder</label>
            <div class="flex gap-2 items-center mt-1" style="flex-wrap:wrap">
              <button class="btn btn-secondary" :disabled="importing" @click="pickImportFolder">
                📁 {{ importing ? 'Reading…' : 'Choose Folder…' }}
              </button>
              <code v-if="importSource" class="path-display">{{ importSource }}</code>
            </div>
          </div>
          <div v-if="importError" class="text-danger mt-2" style="font-size: 13px;">
            {{ importError }}
          </div>
          <div class="flex gap-2 mt-2">
            <button class="btn btn-secondary" @click="closeImport">Cancel</button>
          </div>
        </div>

        <!-- Step 2: confirm (folder inspected) -->
        <div v-if="importStep === 'confirm' && importPreview">
          <div class="review-list">
            <div class="review-item">
              <span class="text-muted">Project</span>
              <span>
                {{ importPreview.name }}
                <span class="source-tag">{{ sourceLabel(importPreview.source) }}</span>
              </span>
            </div>
            <div class="review-item">
              <span class="text-muted">Slug</span>
              <span><code>{{ importPreview.slug }}</code></span>
            </div>
            <div class="review-item">
              <span class="text-muted">Episodes</span>
              <span>
                {{ importPreview.episode_prefix }} × {{ importPreview.episode_digits }} digits
                <span class="text-muted" style="font-size: var(--font-xs);">(e.g. {{ sampleCode }})</span>
              </span>
            </div>
            <div class="review-item">
              <span class="text-muted">Season layout</span>
              <span>{{ importPreview.season_prefix }} NNN · {{ importPreview.season_size }} episodes/season</span>
            </div>
            <div v-if="importPreview.existing_match" class="review-item">
              <span class="text-muted">Already registered</span>
              <span>Yes — as <code>{{ importPreview.existing_match.slug }}</code>. Importing will re-point it to this folder.</span>
            </div>
          </div>

          <div v-if="importPreview.warnings && importPreview.warnings.length" class="warning-box mt-2">
            <strong>Heads-up:</strong>
            <ul style="margin: 4px 0 0; padding-left: 20px;">
              <li v-for="w in importPreview.warnings" :key="w">{{ w }}</li>
            </ul>
          </div>

          <div v-if="importPreview.needs_confirmation && importPreview.needs_confirmation.length" class="confirmation-box mt-2">
            <strong>Please confirm:</strong>
            <div
              v-for="(c, i) in importPreview.needs_confirmation"
              :key="i"
              class="form-group"
              style="margin-top: 8px;"
            >
              <label v-if="c.field === 'episode_prefix'">
                Episode prefix
                <span class="text-muted" style="font-size: var(--font-xs);">
                  (saw: {{ (c.candidates || []).join(', ') || '—' }})
                </span>
              </label>
              <label v-else-if="c.field === 'episode_digits'">
                Episode digits
                <span class="text-muted" style="font-size: var(--font-xs);">
                  (saw: {{ (c.candidates || []).join(', ') }})
                </span>
              </label>
              <label v-else-if="c.field === 'season_size'">
                Episodes per season
                <span class="text-muted" style="font-size: var(--font-xs);">
                  (observed: {{ (c.observed_sizes || []).join(', ') }})
                </span>
              </label>
              <label v-else-if="c.field === 'season_prefix'">
                Season label
                <span class="text-muted" style="font-size: var(--font-xs);">
                  (saw: {{ (c.candidates || [c.observed]).filter(Boolean).join(', ') }})
                </span>
              </label>

              <select
                v-if="c.field === 'episode_prefix' && (c.candidates || []).length"
                class="input"
                :value="overrides.episode_prefix ?? importPreview.episode_prefix"
                @change="overrides.episode_prefix = ($event.target as HTMLSelectElement).value"
              >
                <option v-for="opt in c.candidates" :key="opt" :value="opt">{{ opt }}</option>
              </select>
              <select
                v-else-if="c.field === 'episode_digits'"
                class="input"
                :value="overrides.episode_digits ?? importPreview.episode_digits"
                @change="overrides.episode_digits = Number(($event.target as HTMLSelectElement).value)"
              >
                <option v-for="opt in c.candidates" :key="opt" :value="opt">{{ opt }}</option>
              </select>
              <input
                v-else-if="c.field === 'season_size'"
                type="number"
                min="1"
                class="input"
                :value="overrides.season_size ?? importPreview.season_size"
                @input="overrides.season_size = Number(($event.target as HTMLInputElement).value)"
              />
              <input
                v-else-if="c.field === 'season_prefix'"
                class="input"
                :value="overrides.season_prefix ?? importPreview.season_prefix"
                @input="overrides.season_prefix = ($event.target as HTMLInputElement).value"
              />
            </div>
          </div>

          <div v-if="importError" class="text-danger mt-2" style="font-size: 13px;">
            {{ importError }}
          </div>
          <div class="flex gap-2 mt-2">
            <button class="btn btn-secondary" @click="importStep = 'pick'">Back</button>
            <button class="btn btn-primary" :disabled="importing" @click="commitImport">
              {{ importing ? 'Importing…' : (importPreview.existing_match ? 'Re-point to this folder' : 'Import Project') }}
            </button>
          </div>
        </div>

        <!-- Step 3: slug collision -->
        <div v-if="importStep === 'collision' && importResult">
          <p class="text-muted mb-2" style="font-size: 13px;">
            You already have a different project registered under the slug
            <code>{{ importResult.slug }}</code>. Pick a new slug for this import.
          </p>
          <div class="form-group">
            <label>New slug</label>
            <input v-model="collisionSlug" class="input" placeholder="e.g. my-sleep-stories-2" />
            <span class="text-muted" style="font-size: var(--font-xs);">Lowercase letters, digits, and hyphens only.</span>
          </div>
          <div v-if="importError" class="text-danger mt-2" style="font-size: 13px;">
            {{ importError }}
          </div>
          <div class="flex gap-2 mt-2">
            <button class="btn btn-secondary" @click="importStep = 'confirm'">Back</button>
            <button
              class="btn btn-primary"
              :disabled="!collisionSlug || importing"
              @click="commitImport"
            >
              {{ importing ? 'Retrying…' : 'Import as new slug' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// pickFolder() branches between Electron's native dialog and the in-app
// FileBrowserModal (server mode / remote tailnet browser). Not auto-imported
// — it's a bare named export, not a useX composable.
import { pickFolder as pickFolderShared } from '~/composables/usePathPicker'
import { canonicalFormatId, formatBuildLine } from '~/composables/useFormats'
import { useNiches } from '~/composables/useNiches'

useAppTitle()
const { get, post, put } = useApi()
const { success, error: showError } = useToast()
const linkedProjects = useLinkedProjects()
const softDeleted = useSoftDeletedProjects()
// Expanded/collapsed state for the "🗑️ Hidden projects" panel — closed
// by default so the home page stays clean even when there are leftovers.
const hiddenPanelOpen = ref(false)
const { ask } = useConfirm()
const appSettingsModal = useAppSettingsModal()

const loading = ref(true)
const projects = ref<any[]>([])
const templates = ref<any[]>([])
// v1.0.316 — sticky error state for the projects fetch. Distinguishes "no
// projects yet (show Welcome onboarding)" from "fetch failed (show Retry)".
// Cleared when a fetch succeeds with any result, even an empty array.
const projectsLoadError = ref<string>('')
const projectsRetrying = ref(false)

// ── Linked-projects "Add existing project folder…" dialog ─────────────────
const addLinkedOpen = ref(false)
const addLinkedPath = ref('')
const addLinkedInspecting = ref(false)
const addLinkedAdding = ref(false)
const addLinkedError = ref('')
const addLinkedInspectResult = ref<{
  path: string
  exists: boolean
  slug?: string
  name?: string
  reason?: string
  suggestions?: Array<{ path: string; name?: string; slug?: string }>
} | null>(null)

function openAddLinked(): void {
  addLinkedOpen.value = true
  addLinkedPath.value = ''
  addLinkedInspectResult.value = null
  addLinkedError.value = ''
}
function closeAddLinked(): void {
  addLinkedOpen.value = false
}
async function browseLinkedFolder(): Promise<void> {
  try {
    const path = await pickFolderShared({
      title: 'Pick a Story Studio project folder',
      button_label: 'Use This Folder',
      initial_path: addLinkedPath.value || undefined,
    })
    if (!path) return
    addLinkedPath.value = path
    await inspectLinked()
  } catch (e: any) {
    addLinkedError.value = e?.data?.detail || e?.message || 'Folder picker failed'
  }
}
async function inspectLinked(): Promise<void> {
  if (!addLinkedPath.value) return
  addLinkedInspecting.value = true
  addLinkedError.value = ''
  try {
    addLinkedInspectResult.value = await linkedProjects.inspect(addLinkedPath.value)
  } catch (e: any) {
    addLinkedInspectResult.value = null
    addLinkedError.value = e?.data?.detail || e?.message || 'Inspection failed'
  } finally {
    addLinkedInspecting.value = false
  }
}
/**
 * "Did you mean…?" chip handler for parent-folder picks. Re-fills the
 * path input with the suggested child + immediately re-runs inspect so
 * the user lands on the success preview without manual re-typing.
 */
async function pickSuggestion(childPath: string): Promise<void> {
  addLinkedPath.value = childPath
  await inspectLinked()
}
async function confirmAddLinked(): Promise<void> {
  if (!addLinkedInspectResult.value || addLinkedInspectResult.value.reason) return
  addLinkedAdding.value = true
  addLinkedError.value = ''
  try {
    const info = await linkedProjects.add(addLinkedInspectResult.value.path)
    success(`Linked '${info.name || info.slug}' — refresh to see it in the list.`)
    closeAddLinked()
    await loadData()
  } catch (e: any) {
    addLinkedError.value = e?.data?.detail || e?.message || 'Failed to add linked project'
  } finally {
    addLinkedAdding.value = false
  }
}

/** True when the slug appears in the linked-projects registry. */
function isLinkedSlug(slug: string): boolean {
  return linkedProjects.linked.value.some(p => p.slug === slug && p.exists)
}
function linkedPathFor(slug: string): string {
  return linkedProjects.linked.value.find(p => p.slug === slug)?.path || ''
}

function templateIcon(id: string): string {
  const map: Record<string, string> = {
    blank: '📄',
    'sleep-stories': '🌙',
  }
  return map[id] || '📦'
}

// ── Channel Format picker (v1.0.68+) ──────────────────────────────────
// Loads built-in + user-custom formats from /api/formats so the
// Step-1 picker stays current as the user adds new built-ins to
// electron/server/formats/ or custom formats via Settings → Format.
type FormatLite = {
  id: string; name: string; description?: string; builtin?: boolean
  // v1.0.280+ presentation fields (the /formats endpoint returns full Format
  // objects) — used to render the "how it's built" line on each card.
  visualSource?: string; sceneAlignment?: string
  script?: { chaptersIndependent?: boolean }
}
// Mirrors electron/server/services/format-loader.ts:DEFAULT_FORMAT_ID.
// Frontend can't import the backend constant directly (no shared
// module boundary today), so we duplicate it. Keep both in sync.
const DEFAULT_FORMAT_ID = 'scenes'
const formats = ref<FormatLite[]>([])
const formatsLoading = ref(false)

// v1.0.302 — compact format label for the project-card badge. Maps the raw
// format_id to its friendly name (stripping the parenthetical so the chip
// stays short), falling back to the default format for unknown / legacy
// alias ids (e.g. 'sleep-story' → 'Narrative Video'). Returns '' until the
// formats list has loaded, so the chip simply doesn't render yet.
function formatLabel(id?: string): string {
  if (!formats.value.length) return ''
  const fid = canonicalFormatId(id || DEFAULT_FORMAT_ID)
  const f = formats.value.find(ff => ff.id === fid)
    || formats.value.find(ff => ff.id === DEFAULT_FORMAT_ID)
  const name = f?.name || ''
  return name.split(' (')[0]!.trim()
}

// Carousel scroll state (v1.0.70). Tracks whether the format-cards
// strip can scroll further in either direction so the chevron buttons
// can grey themselves out at the edges. Recomputed on every scroll +
// after the cards render (formats load is async).
const formatCardsEl = ref<HTMLElement | null>(null)
const canScrollFormatsLeft = ref(false)
const canScrollFormatsRight = ref(false)
function onFormatScroll() {
  const el = formatCardsEl.value
  if (!el) return
  canScrollFormatsLeft.value = el.scrollLeft > 4
  canScrollFormatsRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
}
function scrollFormats(direction: 1 | -1) {
  const el = formatCardsEl.value
  if (!el) return
  // Scroll by ~75% of the visible width so the next card sets are
  // mostly fresh, with a small overlap to keep the user oriented.
  const delta = Math.round(el.clientWidth * 0.75) * direction
  el.scrollBy({ left: delta, behavior: 'smooth' })
}
// Re-evaluate edge state once formats finish loading (the strip's
// scrollWidth is 0 until then) and any time the list size changes.
watch([formats, formatsLoading], () => {
  // Wait for the DOM to render before measuring
  setTimeout(onFormatScroll, 0)
})
async function loadFormats() {
  formatsLoading.value = true
  try {
    formats.value = await get<FormatLite[]>('/formats') || []
  } catch {
    formats.value = []
  } finally {
    formatsLoading.value = false
  }
}
function formatIcon(id: string): string {
  // Stable emoji map for built-ins so the wizard reads at a glance.
  // Custom formats fall through to a generic ☆ — Settings → Format
  // doesn't ask the user for an emoji and we don't want to bake a
  // mapping that requires a code change every time someone ships
  // a new built-in.
  //
  // v1.0.162 — pruned to the consolidated formats. Niches do the content
  // variation now; formats only describe the production pipeline.
  // v1.0.280 — format↔niche refactor: narrative / narrated-scenes /
  // narration-synced collapsed into the unified 'scenes' format.
  const map: Record<string, string> = {
    'scenes':            '📖',
    'listicle':          '📊',
    'continuity-chain':  '🎭',
  }
  return map[id] || '☆'
}
// v1.0.280+ — the picker card shows a "how it's built" line (formatBuildLine,
// from useFormats) instead of the JSON description's first sentence, so users
// choose a production pipeline rather than reading presentation-shell prose.

const showCreate = ref(false)
const step = ref(1)
const creating = ref(false)
const picking = ref(false)

const form = reactive<{
  name: string
  template: string
  episode_prefix: string
  season_prefix: string
  season_size: number
  output_root: string
  format_id: string
  /** Niche is OPTIONAL — empty string means "no niche, format defaults only".
   *  The project-creation API treats undefined and empty as "unset". */
  niche_id: string
}>({
  name: '',
  template: 'blank',
  episode_prefix: 'EP',
  season_prefix: 'Season',
  season_size: 20,
  output_root: '',
  // Default matches the project-manager fallback so users who don't
  // touch the Channel Format picker get the default 'scenes' format.
  format_id: 'scenes',
  niche_id: '',
})

// v1.0.280+ — niche is the primary content choice; resolve its display name
// for the review step. useNiches shares a module-level cache (NichePicker
// already populates it), so this is a cheap lookup.
const { find: findNiche } = useNiches()
const selectedNicheName = computed(() => findNiche(form.niche_id)?.name || form.niche_id)

function closeCreate() {
  showCreate.value = false
  step.value = 1
  form.output_root = ''
  // Intentionally leave ffmpegStatus populated — re-checking FFmpeg every
  // time the user reopens the wizard is pointless (the binary doesn't move
  // between opens). It gets refreshed if the user revisits Step 3.
  // Key tests are per-wizard-session; don't carry stale pills into the
  // next create flow.
  for (const p of KEY_PROVIDERS) {
    keyTests[p] = { status: 'untested', message: '', bypassed: false }
    lastTestedKey[p] = ''
  }
  keysTesting.value = false
  // Upload step state lives across the whole wizard so the user's
  // half-completed YouTube connection survives Back/Next navigation, but
  // must reset when the wizard is closed / reopened on a different project.
  createdProject.value = null
  uploadStep.youtube.skipped = false
  uploadStep.youtube.clientId = ''
  uploadStep.youtube.clientSecret = ''
  uploadStep.youtube.clientSaving = false
  uploadStep.youtube.clientSaved = false
  uploadStep.youtube.connecting = false
  uploadStep.youtube.connectPhase = ''
  uploadStep.youtube.connectError = ''
  uploadStep.youtube.channelId = ''
  uploadStep.youtube.channelTitle = ''
  uploadStep.youtube.channelThumb = ''
}

// ── FFmpeg wizard step ────────────────────────────────────────────────────
// Mirrors FfmpegSetupDialog but lives inline in the wizard so the user is
// funneled through it BEFORE they spend 15 minutes generating script +
// audio + images only to hit a missing-ffmpeg block at video assembly.

interface FfmpegStatus {
  installed: boolean
  version?: string
  source: 'bundled' | 'system' | 'not-found'
  path?: string
  has_drawtext?: boolean
  has_libass?: boolean
}
const ffmpegStatus = ref<FfmpegStatus | null>(null)
const ffmpegChecking = ref(false)
const ffmpegInstalling = ref(false)
const ffmpegError = ref('')
const ffmpegProgressMessage = ref('')
const ffmpegProgressPercent = ref(0)
const isMac = ref(false)
const isLinux = ref(false)

async function checkFFmpeg() {
  ffmpegChecking.value = true
  ffmpegError.value = ''
  try {
    const status = await get<FfmpegStatus>('/ffmpeg/status')
    ffmpegStatus.value = status
  } catch (e: any) {
    ffmpegStatus.value = { installed: false, source: 'not-found' }
    ffmpegError.value = e.data?.detail || 'Could not check FFmpeg status.'
  } finally {
    ffmpegChecking.value = false
  }
}

async function installFFmpeg() {
  ffmpegInstalling.value = true
  ffmpegError.value = ''
  ffmpegProgressMessage.value = 'Starting download…'
  ffmpegProgressPercent.value = 0
  // Poll the backend's in-memory install state every second. Replaced an
  // earlier "fake tick" that just drifted the bar by 2% every 800ms; the
  // real polling now reflects actual download / extract progress and
  // surfaces the correct message at each phase.
  const poll = setInterval(async () => {
    try {
      const p = await get<any>('/ffmpeg/install-progress')
      if (typeof p.percent === 'number') ffmpegProgressPercent.value = p.percent
      if (p.message) ffmpegProgressMessage.value = p.message
      if (p.status === 'done' || p.status === 'error' || p.status === 'idle') {
        clearInterval(poll)
      }
    } catch { /* polling is best-effort */ }
  }, 1000)
  try {
    const result = await post<any>('/ffmpeg/install', {})
    if (result?.ok && result.status?.installed) {
      // Pre-flight verified: /install only returns ok after verifyBinary()
      // spawns `ffmpeg -version` and confirms the version banner. We also
      // re-read /status to pick up the authoritative source/version labels.
      ffmpegStatus.value = result.status
      ffmpegProgressMessage.value = 'FFmpeg installed.'
      ffmpegProgressPercent.value = 100
    } else {
      ffmpegError.value =
        'Installation finished but FFmpeg could not be verified. Try the manual install steps above.'
    }
  } catch (e: any) {
    ffmpegError.value = e.data?.detail || 'Download failed. Try manual installation.'
  } finally {
    clearInterval(poll)
    ffmpegInstalling.value = false
  }
}

async function recheckFFmpeg() {
  await checkFFmpeg()
  if (!ffmpegStatus.value?.installed) {
    ffmpegError.value = 'FFmpeg still not detected. Make sure it\'s installed and on PATH, then try again.'
  }
}

async function pickFolder() {
  picking.value = true
  try {
    const path = await pickFolderShared({
      title: 'Choose project save location',
      initial_path: form.output_root || undefined,
    })
    if (path) form.output_root = path
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Folder picker failed')
  } finally {
    picking.value = false
  }
}

const apiKeys = reactive({
  genstudio: '',
})

// Track which providers already have an app-level key so the wizard can
// say "✓ already configured" and skip overwriting on save when the row
// is left blank. We never receive the actual key value — masked only.
const appKeysExisting = reactive<Record<string, boolean>>({
  genstudio: false,
})
const appKeysAlreadyConfigured = computed(
  () => Object.values(appKeysExisting).filter(Boolean).length,
)
async function loadExistingAppKeys() {
  try {
    const res = await get<{ providers: Array<{ providerId: string; hasKey: boolean }> }>(
      '/app-settings/api-keys',
    )
    for (const r of res.providers) {
      if (r.providerId in appKeysExisting) appKeysExisting[r.providerId] = !!r.hasKey
    }
  } catch {
    // Backend offline / fresh install — fine, nothing pre-configured.
  }
}

// ── Upload destinations (wizard Step 5) ───────────────────────────────────
// The OAuth loopback flow lives per-project (tokens land in secrets.json),
// so we must create the project on disk BEFORE we can save the Google
// Cloud client or start the consent flow. `createdProject` is the handle;
// `ensureProjectCreated()` is idempotent — the first connect attempt (or
// the Review "Create Project" button) materializes it, subsequent calls
// just return the existing ref.
const createdProject = ref<any>(null)

const uploadStep = reactive({
  youtube: {
    skipped: false,
    clientId: '',
    clientSecret: '',
    clientSaving: false,
    clientSaved: false,
    connecting: false,
    connectPhase: '',
    connectError: '',
    channelId: '',
    channelTitle: '',
    channelThumb: '',
  },
})

const canSaveYoutubeClient = computed(
  () => !!uploadStep.youtube.clientId.trim() && !!uploadStep.youtube.clientSecret.trim(),
)

function skipAllUploads() {
  uploadStep.youtube.skipped = true
  // TikTok + Facebook are effectively always-skipped in v1 (their backend
  // rows return enabled: false), so nothing else to touch here.
}

/**
 * Create the project on disk + save API keys, exactly once. Subsequent
 * calls return the already-created record. This is the hinge that lets
 * the upload step share the same code path as the per-project upload
 * page: both talk to /projects/:slug/upload/... against the real slug.
 */
async function ensureProjectCreated(): Promise<any> {
  if (createdProject.value) return createdProject.value
  const project = await post<any>('/projects', {
    name: form.name,
    template: form.template,
    episode_prefix: form.episode_prefix,
    season_prefix: form.season_prefix,
    season_size: form.season_size,
    output_root: form.output_root,
    // v1.0.68+: send the wizard's Channel Format choice. Backend
    // accepts the field optional; sending the literal string the
    // server's format-loader knows about keeps the round trip clean.
    format_id: form.format_id || undefined,
    // Niche is optional (subject-domain layer). Empty string means
    // "no niche, format defaults only" — strip it on the wire so the
    // backend's optional-field handling kicks in.
    niche_id: form.niche_id || undefined,
  })
  // The one GenStudio key is stored at app level (per-Mac, not per-project).
  // A blank field leaves the existing masked credential untouched.
  const entries: Array<[string, string]> = [
    ['genstudio', apiKeys.genstudio],
  ]
  for (const [providerId, value] of entries) {
    const trimmed = (value || '').trim()
    if (!trimmed) continue
    try {
      await put(`/app-settings/api-keys/${providerId}`, { apiKey: trimmed })
    } catch (e) {
      // Don't block project creation on a single key write failing —
      // the user can fix it from App Settings afterwards. Log to the
      // existing toast surface.
      console.warn('[wizard] failed to save api key for', providerId, e)
    }
  }
  createdProject.value = project
  return project
}

async function saveYoutubeClientInWizard() {
  if (!canSaveYoutubeClient.value) return
  const y = uploadStep.youtube
  y.clientSaving = true
  y.connectError = ''
  try {
    const project = await ensureProjectCreated()
    await put(`/projects/${project.slug}/upload/oauth-client`, {
      platform: 'youtube',
      client_id: y.clientId.trim(),
      client_secret: y.clientSecret.trim(),
    })
    y.clientSaved = true
    success('OAuth client saved — click Connect to authorize.')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to save OAuth client')
  } finally {
    y.clientSaving = false
  }
}

async function connectYoutubeInWizard() {
  const y = uploadStep.youtube
  if (!y.clientSaved) return
  y.connecting = true
  y.connectError = ''
  y.connectPhase = 'Preparing…'
  try {
    const project = await ensureProjectCreated()
    const { flow_id, auth_url } = await post<{ flow_id: string; auth_url: string }>(
      `/projects/${project.slug}/upload/oauth/start`,
      { platform: 'youtube' },
    )
    y.connectPhase = 'Waiting for consent…'
    window.open(auth_url, '_blank', 'noopener,noreferrer')
    // Poll the flow status. Matches useUploadAccounts.waitForOAuthFlow's
    // 1500ms cadence + 5-minute ceiling — Google consent + redirect is
    // typically 5–30s, longer when 2FA is involved.
    const start = Date.now()
    const timeoutMs = 5 * 60 * 1000
    while (Date.now() - start < timeoutMs) {
      const s = await get<any>(`/projects/${project.slug}/upload/oauth/status?flow_id=${flow_id}`)
      if (s.status === 'success') {
        // Re-read the accounts list (authoritative) rather than trust the
        // transient flow status payload — this way the channel thumb URL
        // + id lines up with what the per-project upload page will show.
        const accountsRes = await get<any>(`/projects/${project.slug}/upload/accounts`)
        const yt = (accountsRes?.accounts?.youtube || [])[0]
        if (yt) {
          y.channelId = yt.remote_id || ''
          y.channelTitle = yt.remote_title || ''
          y.channelThumb = yt.thumbnail_url || ''
        } else {
          y.channelId = s.channel?.channel_id || ''
          y.channelTitle = s.channel?.channel_title || ''
          y.channelThumb = s.channel?.thumbnail_url || ''
        }
        success(`Connected ${y.channelTitle || 'YouTube channel'}`)
        return
      }
      if (s.status === 'error' || s.status === 'unknown') {
        y.connectError = s.error || 'OAuth flow failed'
        return
      }
      await new Promise(r => setTimeout(r, 1500))
    }
    y.connectError = 'Timed out waiting for consent.'
  } catch (e: any) {
    y.connectError = e?.data?.detail || e?.message || 'Failed to connect'
  } finally {
    y.connecting = false
    y.connectPhase = ''
  }
}

const keyCount = computed(() => Number(!!apiKeys.genstudio.trim() || appKeysExisting.genstudio))

// ── Per-key verification ─────────────────────────────────────────────────
// The wizard verifies the scoped GenStudio key BEFORE letting
// the user advance past Step 4. Without this, typos surface as opaque 401s
// 5–15 minutes into the first generation job. Empty inputs are fine — users
// who only plan to use script generation shouldn't be forced to paste every
// key. The "Skip verification" checkbox is the escape hatch for when the
// network is flaky or the user genuinely wants to defer.
type KeyProvider = 'genstudio'
type KeyTestStatus = 'untested' | 'testing' | 'valid' | 'invalid' | 'unreachable'

const KEY_PROVIDERS: KeyProvider[] = ['genstudio']

const keyRows: Array<{ provider: KeyProvider; label: string; placeholder?: string }> = [
  { provider: 'genstudio', label: 'Scoped GenStudio API key', placeholder: 'gsk_…' },
]

const keyTests = reactive<Record<KeyProvider, { status: KeyTestStatus; message: string; bypassed: boolean }>>({
  genstudio: { status: 'untested', message: '', bypassed: false },
})

const keysTesting = ref(false)
// Track the key value last tested per provider so we can avoid redundant
// re-tests on blur if nothing changed (the operator clicking elsewhere
// shouldn't ping the provider every time).
const lastTestedKey = reactive<Record<KeyProvider, string>>({
  genstudio: '',
})

function resetKeyStatus(provider: KeyProvider) {
  // Any edit invalidates the prior test AND any bypass — otherwise a green
  // (or bypassed) pill could outlive the key it was vouching for.
  if (keyTests[provider].status !== 'untested' || keyTests[provider].bypassed) {
    keyTests[provider] = { status: 'untested', message: '', bypassed: false }
  }
  lastTestedKey[provider] = ''
}

async function testOneKey(provider: KeyProvider) {
  const apiKey = apiKeys[provider].trim()
  if (!apiKey) return
  if (keyTests[provider].status === 'testing') return
  keyTests[provider] = { status: 'testing', message: '', bypassed: false }
  try {
    const r = await post<{ valid: boolean; reachable: boolean; message: string }>(
      `/app-settings/api-keys/${provider}/test`,
      { apiKey },
    )
    const status: KeyTestStatus = r.valid
      ? 'valid'
      : (r.reachable ? 'invalid' : 'unreachable')
    keyTests[provider] = { status, message: r.message || '', bypassed: false }
    lastTestedKey[provider] = apiKey
  } catch (e: any) {
    keyTests[provider] = {
      status: 'unreachable',
      message: e?.data?.detail || e?.message || 'Test request failed',
      bypassed: false,
    }
    lastTestedKey[provider] = apiKey
  }
}

function onKeyBlur(provider: KeyProvider) {
  // Auto-test on blur — but only if the value actually changed since the
  // last probe, to avoid spamming the provider when the operator tabs
  // through fields. Empty inputs don't trigger anything.
  const apiKey = apiKeys[provider].trim()
  if (!apiKey) return
  if (keyTests[provider].status === 'testing') return
  if (apiKey === lastTestedKey[provider] && keyTests[provider].status !== 'untested') return
  void testOneKey(provider)
}

function bypassKey(provider: KeyProvider) {
  // Per-key escape hatch. Preserve any existing failure message so the
  // operator (and a future helper) can still see *why* it was bypassed.
  keyTests[provider] = {
    status: keyTests[provider].status,
    message: keyTests[provider].message,
    bypassed: true,
  }
}

const providedKeyCount = computed(() =>
  KEY_PROVIDERS.filter(p => apiKeys[p].trim()).length,
)

// Bypassed keys are treated as "operator decided" — they don't count as
// blockers below, but they also aren't 'valid'. Excluding them from the
// remaining checks means a row with status='invalid' + bypassed=true won't
// be counted as a blocker.
const hasUntestedProvidedKeys = computed(() =>
  KEY_PROVIDERS.some(p => apiKeys[p].trim() && keyTests[p].status === 'untested' && !keyTests[p].bypassed),
)

const hasInvalidKey = computed(() =>
  KEY_PROVIDERS.some(p => apiKeys[p].trim() && keyTests[p].status === 'invalid' && !keyTests[p].bypassed),
)

const hasUnreachable = computed(() =>
  KEY_PROVIDERS.some(p => apiKeys[p].trim() && keyTests[p].status === 'unreachable' && !keyTests[p].bypassed),
)

const verificationSummary = computed(() => {
  if (keysTesting.value) return 'Checking GenStudio scopes…'
  const tested = KEY_PROVIDERS.filter(p => apiKeys[p].trim() && keyTests[p].status !== 'untested')
  const bypassed = KEY_PROVIDERS.filter(p => apiKeys[p].trim() && keyTests[p].bypassed).length
  if (tested.length === 0 && bypassed === 0) return ''
  const valid = tested.filter(p => keyTests[p].status === 'valid' && !keyTests[p].bypassed).length
  const invalid = tested.filter(p => keyTests[p].status === 'invalid' && !keyTests[p].bypassed).length
  const unreachable = tested.filter(p => keyTests[p].status === 'unreachable' && !keyTests[p].bypassed).length
  const parts: string[] = []
  if (valid) parts.push(`${valid} valid`)
  if (invalid) parts.push(`${invalid} invalid`)
  if (unreachable) parts.push(`${unreachable} unreachable`)
  if (bypassed) parts.push(`${bypassed} bypassed`)
  return parts.join(' · ')
})

async function testAllKeys() {
  if (keysTesting.value) return
  const targets = KEY_PROVIDERS.filter(p => apiKeys[p].trim())
  if (targets.length === 0) return
  keysTesting.value = true
  for (const p of targets) keyTests[p] = { status: 'testing', message: '', bypassed: false }
  try {
    // Run in parallel — each probe is 5 s timeout so a bad one shouldn't hold
    // up the others. allSettled so a single throw doesn't abort the batch.
    await Promise.allSettled(targets.map(async (p) => {
      const apiKey = apiKeys[p].trim()
      try {
        const r = await post<{ valid: boolean; reachable: boolean; message: string }>(
          `/app-settings/api-keys/${p}/test`,
          { apiKey },
        )
        const status: KeyTestStatus = r.valid
          ? 'valid'
          : (r.reachable ? 'invalid' : 'unreachable')
        keyTests[p] = { status, message: r.message || '', bypassed: false }
      } catch (e: any) {
        // The endpoint itself is unreachable — treat as network trouble, not
        // a bad key, so the user investigates connectivity first.
        keyTests[p] = {
          status: 'unreachable',
          message: e?.data?.detail || e?.message || 'Test request failed',
          bypassed: false,
        }
      }
      lastTestedKey[p] = apiKey
    }))
  } finally {
    keysTesting.value = false
  }
}

// Gating rules for the GenStudio step. If the user enters a replacement key,
// it must either
//      test them (all valid) or tick "Skip verification". Empty wizard (no
//      keys at all) is allowed through without either.
const keyVerificationOk = computed(() => {
  if (providedKeyCount.value === 0) return true
  if (keysTesting.value) return false
  // Every non-empty key must be either valid OR explicitly bypassed by the
  // operator. Invalid/unreachable/untested without a bypass all count as
  // blockers — the user either fixes the key, bypasses it for now, or
  // removes the key.
  return KEY_PROVIDERS.every(p => {
    if (!apiKeys[p].trim()) return true
    if (keyTests[p].bypassed) return true
    return keyTests[p].status === 'valid'
  })
})

const canAdvancePastKeys = computed(() => keyVerificationOk.value)

const nextBlockReason = computed(() => {
  if (keysTesting.value) return 'Waiting for key tests to finish…'
  if (providedKeyCount.value === 0) return ''
  if (hasInvalidKey.value) return 'One or more keys were rejected by the provider. Fix them, or click "Continue without testing" on each row.'
  if (hasUnreachable.value) return "Couldn't reach a provider. Check your network, retry, or click \"Continue without testing\" on the affected row."
  if (hasUntestedProvidedKeys.value) return 'Click "Test" on each row to verify, or "Continue without testing" to defer.'
  return ''
})

/** Pretty-print a byte count for the hidden-projects panel. */
function formatBytes(bytes: number): string {
  if (bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** "5 minutes ago" / "yesterday" / "3 days ago" — coarse but clear. */
function formatRelativeTime(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime()
    if (!isFinite(ms) || ms < 0) return ''
    const min = Math.floor(ms / 60000)
    if (min < 1) return 'just now'
    if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`
    const h = Math.floor(min / 60)
    if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
    const d = Math.floor(h / 24)
    if (d === 1) return 'yesterday'
    if (d < 30) return `${d} days ago`
    return new Date(iso).toLocaleDateString()
  } catch { return '' }
}

/**
 * Restore a hidden project — re-shows it in the live list. Files were
 * never deleted so this just flips the visibility flag.
 */
async function restoreHiddenProject(slug: string): Promise<void> {
  const ok = await softDeleted.restore(slug)
  if (ok) {
    success(`Restored "${slug}"`)
    await loadData()
  } else {
    showError(softDeleted.lastError.value || 'Failed to restore')
  }
}

/**
 * Hard-delete a hidden project — actually rm-rfs the folder. Two-step
 * confirmation since this is the only irreversible action in the
 * whole soft-delete flow.
 */
async function hardDeleteHiddenProject(row: { slug: string; path: string; exists: boolean; estimated_bytes: number }): Promise<void> {
  const sizeStr = row.exists ? formatBytes(row.estimated_bytes) : '0 B (folder already gone)'
  const ok = await ask({
    title: `Permanently delete "${row.slug}"?`,
    message:
      `This will remove the folder + everything inside it from disk:\n\n${row.path}\n\n` +
      `Size: ${sizeStr}\n\nThis CANNOT be undone. To keep the files, click Cancel and use "Restore" or "Open in Finder" instead.`,
    confirmLabel: 'Delete from disk',
    cancelLabel: 'Cancel',
    danger: true,
  })
  if (!ok) return
  const done = await softDeleted.hardDelete(row.slug)
  if (done) {
    success(`Permanently deleted "${row.slug}"`)
  } else {
    showError(softDeleted.lastError.value || 'Failed to delete')
  }
}

function formatDate(date: string) {
  return new Date(date).toLocaleDateString()
}

/**
 * v1.0.316 — Fetch /projects with backoff retry. Backstops the case where the
 * backend's event loop is briefly stalled (long-running audio merge job
 * spawning ffprobe per file), which used to fail the one-shot fetch and leave
 * the page stuck on the empty-onboarding state until a manual reload.
 *
 * Tries up to 4 times (initial + 3 retries) with delays 1s / 3s / 9s. On
 * success, clears projectsLoadError. On final failure, sets the error and
 * returns []; the template shows a "Retry" panel instead of the Welcome card.
 *
 * Worst case the user waits 13s + the last attempt's request time before the
 * Retry button appears — almost always invisible because the stalls are
 * sub-second and the first or second retry succeeds.
 */
async function fetchProjectsWithRetry(): Promise<any[]> {
  const delays = [1_000, 3_000, 9_000]
  let lastErr: any = null
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const r = await get<any[]>('/projects')
      projectsLoadError.value = ''
      return Array.isArray(r) ? r : []
    } catch (e: any) {
      lastErr = e
      if (attempt === delays.length) break
      console.warn(`[index] /projects attempt ${attempt + 1} failed; retrying in ${delays[attempt]}ms…`, e?.message || e)
      await new Promise(r => setTimeout(r, delays[attempt]))
    }
  }
  const msg = lastErr?.data?.detail || lastErr?.message || 'backend offline?'
  projectsLoadError.value = msg
  showError(`Couldn't load projects — ${msg}`)
  return []
}

/** Manual retry handler for the empty-state Retry button (v1.0.316). */
async function retryLoadProjects() {
  if (projectsRetrying.value) return
  projectsRetrying.value = true
  try {
    const fresh = await fetchProjectsWithRetry()
    projects.value = fresh
  } finally {
    projectsRetrying.value = false
  }
}

async function loadData() {
  loading.value = true
  try {
    // Load projects + templates + linked-projects registry in parallel.
    // The linked list powers the 🔗 Linked location chip and is per-Mac
    // (lives in app-settings.json on the backend; never synced).
    //
    // Each promise has its own catch so one slow / failed endpoint
    // doesn't blank out the whole list. /projects is the most important —
    // if even that fails, we surface a toast + leave projects empty so
    // the onboarding state renders (Welcome card with the buttons), not
    // a forever-spinning blank screen.
    const [p, t] = await Promise.all([
      // v1.0.316 — auto-retry the projects fetch on transient failure. The
      // backend's event loop can briefly stall during a heavy audio merge
      // (per-file ffprobe spawns) and a single failed fetch used to leave
      // the page stuck on the empty-onboarding state until manual reload.
      // Backoff: 1s, 3s, 9s. Sets projectsLoadError on final failure so the
      // empty state shows a Retry button instead of the Welcome card; cleared
      // on any success (even when the response is genuinely an empty array).
      fetchProjectsWithRetry(),
      get<any[]>('/projects/templates').catch((e: any) => {
        console.error('[index] /projects/templates failed:', e)
        return [] as any[]
      }),
      linkedProjects.refresh(),  // already swallows its own errors internally
      softDeleted.refresh(),      // same — populates the 🗑️ Hidden chip
      // v1.0.68+: load formats so the Create Project wizard's
      // Channel Format picker is ready as soon as the user opens
      // it. Failures here aren't fatal — the picker shows an
      // empty-state message and the project defaults to sleep-story.
      loadFormats(),
    ])
    projects.value = Array.isArray(p) ? p : []
    templates.value = Array.isArray(t) ? t : []
    // If any project came back as 'downloading', poll until they all
    // settle — see startDownloadPoll for cap + cadence rationale.
    if (downloadingProjects.value.length > 0) startDownloadPoll()
  } catch (e: any) {
    // Catch-all for anything Promise.all couldn't tame (e.g. composable
    // throwing during refresh). Logging-only — UI falls back to the
    // empty-projects onboarding state.
    console.error('[index] loadData unexpected failure:', e)
  } finally {
    loading.value = false
  }
}

// ── iCloud-aware project loading ─────────────────────────────────────────
// On a fresh Mac with iCloud just set up, project.json files are still
// placeholders (`.<name>.icloud`) and `fs.readFile` on them blocks while
// macOS fetches from the cloud. The backend now returns those rows with
// `status: 'downloading'` so the home page can render them as greyed-out
// placeholders instead of hanging the whole list. We poll /projects
// every 5s while any are downloading to promote them to 'ready'.

const downloadingProjects = computed(() =>
  projects.value.filter((p: any) => p?.status === 'downloading'),
)

const POLL_INTERVAL_MS = 5_000
const MAX_POLL_ITERATIONS = 60   // ~5 min cap
let pollTimer: ReturnType<typeof setInterval> | null = null
let pollIterations = 0

function stopDownloadPoll() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  pollIterations = 0
}

function startDownloadPoll() {
  if (pollTimer) return  // already polling
  pollIterations = 0
  pollTimer = setInterval(async () => {
    pollIterations++
    try {
      const fresh = await get<any[]>('/projects')
      projects.value = Array.isArray(fresh) ? fresh : []
    } catch {
      // Poll failures are non-fatal — keep the existing list and try again
      // next tick. A persistent backend outage would already have shown
      // a toast on the initial load.
    }
    if (downloadingProjects.value.length === 0) {
      stopDownloadPoll()
      return
    }
    if (pollIterations >= MAX_POLL_ITERATIONS) {
      stopDownloadPoll()
      showError(
        'iCloud sync is taking longer than usual — open Finder, right-click ' +
        'the project folder, and choose "Download Now" to force the download.',
      )
    }
  }, POLL_INTERVAL_MS)
}

// Stop the poll if the user navigates away — Vue auto-runs onUnmounted
// cleanup, so this is just a safety net.
onBeforeUnmount(() => stopDownloadPoll())

async function createProject() {
  creating.value = true
  try {
    // Idempotent — if the user already connected a YouTube account in
    // Step 5, the project already exists and this is a no-op.
    const project = await ensureProjectCreated()
    success(
      uploadStep.youtube.channelId
        ? `Project "${project.name}" created and bound to ${uploadStep.youtube.channelTitle}.`
        : `Project "${project.name}" created!`,
    )
    closeCreate()
    navigateTo(`/projects/${project.slug}`)
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to create project')
  } finally {
    creating.value = false
  }
}

// Watch template selection to update prefix
watch(() => form.template, (t) => {
  const tpl = templates.value.find(x => x.id === t)
  // Auto-set prefix based on template (user can always override)
  if (t === 'sleep-stories' && form.episode_prefix === 'EP') {
    form.episode_prefix = 'SS'
  } else if (t === 'blank' && form.episode_prefix === 'SS') {
    form.episode_prefix = 'EP'
  }
})

// ── Import existing project ───────────────────────────────────────────────
// Three states: pick → confirm → commit. Commit either succeeds outright or
// falls through to a slug-collision prompt. The confirm step shows what the
// app inferred from the folder; ambiguous fields get inline fix-ups that
// flow back through `overrides` at commit time.

type InspectSource = 'manifest-v2' | 'manifest-v1-legacy' | 'inferred'

interface NeedsConfirmationItem {
  field: 'episode_prefix' | 'episode_digits' | 'season_size' | 'season_prefix'
  reason: string
  candidates?: any[]
  observed?: string
  observed_sizes?: number[]
}

interface ImportPreview {
  name: string
  slug: string
  project_id: string | null
  episode_prefix: string
  episode_digits: number
  season_size: number
  season_prefix: string
  folder_template: string
  subfolder_names: Record<string, string>
  source: InspectSource
  needs_confirmation: NeedsConfirmationItem[]
  warnings: string[]
  existing_match?: { slug: string; project_id: string }
}

interface ImportResult {
  action: 'imported' | 'relocated' | 'collision'
  slug: string
  project_id: string
  output_root: string
  warnings: string[]
  existing_slug?: string
  existing_project_id?: string
}

const showImport = ref(false)
const importStep = ref<'pick' | 'confirm' | 'collision'>('pick')
const importing = ref(false)
const importSource = ref('')
const importError = ref('')
const importPreview = ref<ImportPreview | null>(null)
const importResult = ref<ImportResult | null>(null)
const collisionSlug = ref('')
const overrides = reactive<{
  name?: string
  episode_prefix?: string
  episode_digits?: number
  season_size?: number
  season_prefix?: string
}>({})

const sampleCode = computed(() => {
  if (!importPreview.value) return ''
  const prefix = overrides.episode_prefix ?? importPreview.value.episode_prefix
  const digits = overrides.episode_digits ?? importPreview.value.episode_digits
  return `${prefix}${'0'.repeat(Math.max(digits - 1, 0))}1`
})

function sourceLabel(source: InspectSource): string {
  if (source === 'manifest-v2') return 'from manifest'
  if (source === 'manifest-v1-legacy') return 'from legacy manifest'
  return 'detected from folder'
}

function openImport() {
  showImport.value = true
  importStep.value = 'pick'
  importing.value = false
  importSource.value = ''
  importError.value = ''
  importPreview.value = null
  importResult.value = null
  collisionSlug.value = ''
  for (const k of Object.keys(overrides)) delete (overrides as any)[k]
}

function closeImport() {
  showImport.value = false
}

async function pickImportFolder() {
  importing.value = true
  importError.value = ''
  try {
    const path = await pickFolderShared({
      title: 'Pick a project folder to import',
      initial_path: importSource.value || undefined,
    })
    if (!path) return
    importSource.value = path
    const inspect = await post<ImportPreview>('/projects/import/inspect', { source_path: path })
    importPreview.value = inspect
    for (const k of Object.keys(overrides)) delete (overrides as any)[k]
    importStep.value = 'confirm'
  } catch (e: any) {
    importError.value = e?.data?.detail || 'Could not read that folder.'
  } finally {
    importing.value = false
  }
}

async function commitImport() {
  importing.value = true
  importError.value = ''
  try {
    const body: Record<string, any> = { source_path: importSource.value }
    if (importStep.value === 'collision' && collisionSlug.value) {
      body.adopt_as_slug = collisionSlug.value
    }
    const dirtyOverrides = Object.fromEntries(
      Object.entries(overrides).filter(([, v]) => v !== undefined && v !== ''),
    )
    if (Object.keys(dirtyOverrides).length) body.overrides = dirtyOverrides

    const result = await post<ImportResult>('/projects/import', body)
    importResult.value = result
    if (result.action === 'collision') {
      importStep.value = 'collision'
      importError.value = `Slug "${result.slug}" is already used by a different project. Pick another.`
      return
    }
    await loadData()
    const label = importPreview.value?.name || result.slug
    success(
      result.action === 'relocated'
        ? `Re-pointed "${label}" to its new folder.`
        : `Imported "${label}"!`,
    )
    showImport.value = false
    navigateTo(`/projects/${result.slug}`)
  } catch (e: any) {
    importError.value = e.data?.detail || 'Import failed.'
  } finally {
    importing.value = false
  }
}

// Kick off an FFmpeg status check the first time the user enters Step 3,
// and again if they come back to it with an unknown state. We don't re-check
// automatically after that — the user has explicit "check again" + "install"
// buttons once they're on the step.
watch(step, (s) => {
  if (s === 3 && !ffmpegChecking.value && !ffmpegInstalling.value) {
    if (!ffmpegStatus.value || !ffmpegStatus.value.installed) {
      checkFFmpeg()
    }
  }
  if (s === 4) {
    // Pre-load which providers already have an app-level key so the
    // wizard shows "✓ already configured" and we don't silently
    // overwrite on save when the user leaves a row blank.
    void loadExistingAppKeys()
  }
})

onMounted(async () => {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent.toLowerCase() : ''
  isMac.value = ua.includes('mac')
  isLinux.value = ua.includes('linux') && !ua.includes('android')
  loadData()
})
</script>

<style scoped>
.home {
  max-width: 900px;
  margin: 0 auto;
  padding: 40px 24px;
}

.home-header {
  margin-bottom: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.home-header h1 {
  font-size: 32px;
  font-weight: 700;
  color: var(--accent);
}

.home-header-actions {
  display: flex;
  gap: 8px;
}

.home-settings-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-tertiary);
  color: var(--text-muted);
  text-decoration: none;
  font-size: 13px;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.home-settings-btn:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border-color: var(--accent);
}

.home-settings-icon {
  font-size: 16px;
  line-height: 1;
}

.onboarding {
  display: flex;
  justify-content: center;
  padding: 60px 0;
}

.onboarding-card {
  text-align: center;
  max-width: 400px;
}

.onboarding-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.onboarding-card h2 {
  font-size: 24px;
  margin-bottom: 12px;
}

/* Overrides the global `.grid-3` for the project list only: auto-fits as
   many cards as will fit at 280px-or-wider each. This keeps the cards
   readable inside narrow Electron windows (800–1000px) instead of
   squeezing three cards into that width and forcing titles + badges to
   shatter across multiple lines. Other `.grid-3` usages elsewhere are
   unaffected. */
.project-list .grid-3 {
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
}

.project-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 20px;
  cursor: pointer;
  transition: all 0.2s;
}

.project-card:hover {
  border-color: var(--accent);
  transform: translateY(-2px);
  box-shadow: var(--shadow);
}

/* iCloud-syncing banner: cyan/info tone (not amber) — the situation is
   recoverable, just slow. Single-row layout matching the
   restart-recovery banner on the Jobs page so the design language stays
   consistent across the app. */
.icloud-syncing-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 12px 0 4px;
  padding: 10px 14px;
  background: rgba(99, 145, 200, 0.10);
  border: 1px solid rgba(99, 145, 200, 0.30);
  border-left: 3px solid rgb(99, 145, 200);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  color: var(--text-secondary);
}
.icb-icon { font-size: 16px; flex-shrink: 0; }
.icb-text { flex: 1; line-height: 1.45; }
.icb-text strong { color: var(--text-primary); }

/* Downloading project card: greyed out, no hover / click feedback so
   the user understands it isn't actionable yet. The pill + path
   substitute for the usual project metadata. */
.project-card--downloading {
  opacity: 0.65;
  cursor: progress;
  background: var(--bg-primary);
}
.project-card--downloading:hover {
  border-color: var(--border);
  transform: none;
  box-shadow: none;
}

.badge-syncing {
  background: rgba(99, 145, 200, 0.18);
  color: rgb(140, 175, 220);
  border: 1px solid rgba(99, 145, 200, 0.35);
}

.project-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 12px;
}

.project-card-header h3 {
  font-size: 16px;
  font-weight: 600;
  /* Allow the title to shrink and wrap under the badges when the card
     is narrow. Without `min-width:0` a flex child refuses to shrink past
     its intrinsic content width, which pushes the badges off the card.
     `overflow-wrap: break-word` only breaks words that would otherwise
     overflow — it won't shatter normal-length titles. */
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: break-word;
}

/* Keep both badges together on the right. `flex-shrink: 0` stops the
   group from collapsing when the title is long; `flex-wrap` lets the
   two badges stack vertically on narrow cards so they don't visually
   collide with the wrapping title text. Badge text itself never wraps —
   splitting "Setup needed" across two lines looks broken. */
.project-card-badges {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.project-card-badges .badge {
  white-space: nowrap;
}

/* "🔗 Linked" badge — distinct sky-blue accent so the operator scans
   linked projects (synced via Add existing project folder…) apart
   from default-location ones at a glance. */
.badge-linked {
  background: rgba(56, 189, 248, 0.15);
  color: rgb(14, 165, 233);
  border: 1px solid rgba(56, 189, 248, 0.4);
}

/* Add existing project folder modal — error + success summaries. */
.add-linked-error {
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: rgba(239, 68, 68, 0.08);
  border-left: 3px solid #ef4444;
  font-size: 12px;
  color: #ef4444;
}
.add-linked-preview {
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: rgba(52, 211, 153, 0.08);
  border-left: 3px solid #34d399;
  font-size: 12px;
  display: grid; gap: 4px;
}
.add-linked-preview code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: var(--font-xs);
  word-break: break-all;
}
/* "What folder?" guidance card — explains which folder to pick. Lives
   above the path input so it's seen BEFORE the user clicks Browse. */
.add-linked-hint {
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  background: rgba(56, 189, 248, 0.08);
  border-left: 3px solid #38bdf8;
  font-size: 13px;
  color: var(--text);
}
.add-linked-hint code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: var(--font-xs);
  word-break: break-all;
  background: rgba(0,0,0,0.06);
  padding: 1px 4px;
  border-radius: 3px;
}

/* Hidden projects panel — surfaces soft-deleted slugs so the user can
   restore them, reveal in Finder, or permanently delete. Muted styling
   so it doesn't compete with the live project list above it. */
.hidden-projects-panel {
  border: 1px solid var(--border, rgba(255,255,255,0.1));
  border-radius: var(--radius-md, 8px);
  background: rgba(255, 255, 255, 0.02);
  padding: 12px 16px;
  display: grid;
  gap: 8px;
}
.hidden-projects-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 8px;
  border-bottom: 1px dashed rgba(255,255,255,0.08);
  margin-bottom: 4px;
}
.hidden-project-row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 8px 0;
  border-bottom: 1px dashed rgba(255,255,255,0.06);
}
.hidden-project-row:last-child {
  border-bottom: none;
}
.hidden-project-info {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 2px;
}
.hidden-project-info code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.hidden-project-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.project-card-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-muted);
}
/* v1.0.302 — format badge on the project card. */
.project-format-chip {
  margin-left: auto;
  background: var(--accent-dim, rgba(240, 198, 116, 0.12));
  color: var(--accent, #f0c674);
  padding: 1px 8px;
  border-radius: 10px;
  font-size: var(--font-xs);
  white-space: nowrap;
}

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: 40px;
  width: min(880px, 92vw);
  max-height: 90vh;
  overflow-y: auto;
}

.modal h2 {
  margin-bottom: 24px;
}

.steps {
  display: flex;
  gap: 8px;
  margin-bottom: 28px;
}

.step {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  background: var(--bg-tertiary);
  color: var(--text-muted);
}

.step.active {
  background: var(--accent);
  color: #0f1117;
}

.step.done {
  background: var(--success);
  color: #0f1117;
}

.template-cards {
  display: flex;
  gap: 12px;
}

.template-card {
  flex: 1;
  padding: 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.2s;
  color: inherit;
  text-align: left;
  font: inherit;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.template-card:hover { border-color: var(--border-light); }
.template-card.selected {
  border-color: var(--accent);
  background: var(--accent-dim);
}
.template-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.template-card.disabled-card {
  position: relative;
  opacity: 0.55;
  cursor: not-allowed;
  border-style: dashed;
}
.template-card.disabled-card:hover { border-color: var(--border); }
.coming-soon-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: var(--font-xs);
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  letter-spacing: 0.4px;
  border: 1px solid var(--border);
}
/* v1.0.69 — visible "Default" pill on the auto-selected Channel Format
   card. Without this, users who don't read the picker walk away with
   sleep-story silently chosen. The pill is small and quiet enough not
   to compete with the active selection ring.
   v1.0.70 — pin to the top-right corner of the card so a long format
   name (e.g. "Sleep Story") doesn't push the pill off-screen inside
   the carousel's narrow card width. The card itself is positioned
   relatively so the pill anchors to its bounds. */
.format-default-pill {
  position: absolute;
  top: 6px;
  right: 6px;
  margin: 0;
  padding: 1px 6px;
  font-size: var(--font-xs);
  font-weight: 600;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  border: 1px solid var(--border);
  border-radius: 999px;
  /* Stay above the strong text it sits beside */
  z-index: 1;
}
.format-card { position: relative; }

/* v1.0.70 — Channel Format picker carousel. Eight format cards no
   longer fit on one row at the wizard's modal width, and squashing
   them past illegibility (or letting them spill into a horizontal
   scrollbar) was hiding cards from users who didn't realise they
   could scroll. The carousel keeps the existing card aesthetics, hides
   the scrollbar, and exposes scroll state via two chevron buttons that
   grey out at the edges. */
.format-carousel {
  position: relative;
  display: flex;
  align-items: stretch;
  gap: 4px;
}
.format-cards {
  flex: 1;
  overflow-x: auto;
  scroll-behavior: smooth;
  scroll-snap-type: x proximity;
  /* Hide the scrollbar — the chevrons replace it. We still allow
     trackpad swipes and arrow-key scroll for power users. */
  scrollbar-width: none;
  /* Generous bottom-padding so the focus outline on selected cards
     isn't clipped by the strip. */
  padding: 2px 2px 6px;
}
.format-cards::-webkit-scrollbar { display: none; }
.format-card {
  flex: 0 0 auto;
  min-width: 200px;
  max-width: 240px;
  scroll-snap-align: start;
}
.format-carousel-arrow {
  flex: 0 0 auto;
  width: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  line-height: 1;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 6px);
  cursor: pointer;
  transition: opacity 0.15s, color 0.15s, border-color 0.15s;
  /* Bigger touch target than the visible glyph for easier hit */
  padding: 0 6px;
  user-select: none;
}
.format-carousel-arrow:hover:not(:disabled) {
  color: var(--text-primary);
  border-color: var(--border-light);
}
.format-carousel-arrow:disabled {
  opacity: 0.3;
  cursor: default;
}

.template-icon { font-size: 24px; line-height: 1; }

.template-card strong { font-size: 14px; color: var(--text-primary); }
.template-card p {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.4;
}

.review-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.review-item {
  display: flex;
  justify-content: space-between;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
  font-size: 14px;
  gap: 16px;
}

.review-warn {
  color: var(--warning, #d8a23c);
  font-size: 13px;
}

.path-display {
  display: inline-block;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  font-size: 12px;
  color: var(--accent);
  word-break: break-all;
  max-width: 100%;
}
.path-display-inline {
  font-family: 'SF Mono', Monaco, monospace;
  font-size: 12px;
  color: var(--accent);
  word-break: break-all;
  text-align: right;
}

.warning-box {
  background: rgba(251, 191, 36, 0.08);
  border: 1px solid rgba(251, 191, 36, 0.3);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
  margin-top: 12px;
}
.warning-box strong { color: var(--warning); }

/* "detected from folder" vs "from manifest" tag inside the Import dialog. */
.source-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: var(--font-xs);
  font-weight: 500;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  letter-spacing: 0.2px;
}

/* Confirmation block shown when the inferrer flags ambiguous fields. */
.confirmation-box {
  background: rgba(59, 130, 246, 0.08);
  border: 1px solid rgba(59, 130, 246, 0.3);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
}
.confirmation-box strong { color: var(--accent); }

/* FFmpeg step */
.ffmpeg-status-box {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-primary);
  font-size: 13px;
  line-height: 1.4;
}
.ffmpeg-status-box.ffmpeg-ok {
  border-color: rgba(34, 197, 94, 0.35);
  background: rgba(34, 197, 94, 0.08);
}
.ffmpeg-status-box.ffmpeg-ok strong { color: var(--success); }
.ffmpeg-status-box.ffmpeg-missing {
  border-color: rgba(251, 191, 36, 0.35);
  background: rgba(251, 191, 36, 0.08);
}
.ffmpeg-status-box.ffmpeg-missing strong { color: var(--warning); }

/* Connectivity precheck banner — rendered at the top of wizard Step 4.
   Reuses the ffmpeg-status-box look so the wizard has visual consistency
   across "thing is checking / ok / needs attention" messaging. */
.precheck-banner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  margin-bottom: 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-primary);
  font-size: 13px;
  line-height: 1.4;
}
.precheck-banner.precheck-info  { border-color: rgba(59, 130, 246, 0.35); background: rgba(59, 130, 246, 0.08); }
.precheck-banner.precheck-warn  { border-color: rgba(251, 191, 36, 0.35); background: rgba(251, 191, 36, 0.08); }
.precheck-banner.precheck-warn  strong { color: var(--warning); }
.precheck-banner.precheck-error { border-color: rgba(239, 68, 68, 0.45);  background: rgba(239, 68, 68, 0.10); }
.precheck-banner.precheck-error strong { color: var(--error, #ef4444); }
.precheck-host-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.precheck-host {
  font-size: var(--font-xs);
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border);
}
.key-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.key-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
.key-row :deep(.api-key-input) {
  flex: 1;
  min-width: 0;
}
.key-test-btn {
  flex-shrink: 0;
  white-space: nowrap;
}
.bypass-link {
  display: inline-block;
  margin-top: 6px;
  padding: 2px 0;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  font-style: italic;
  text-decoration: underline;
  cursor: pointer;
}
.bypass-link:hover {
  color: var(--text-primary);
}
.bypass-pill {
  display: inline-block;
  margin-left: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: var(--font-xs);
  font-weight: 500;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  white-space: nowrap;
}
.ffmpeg-status-icon {
  font-size: 22px;
  line-height: 1;
  flex-shrink: 0;
}
.manual-install {
  padding: 10px 12px;
  border-top: 1px solid var(--border);
  margin-top: 8px;
}
.manual-commands {
  background: var(--bg-primary);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}
.manual-commands code {
  font-size: 13px;
  color: var(--accent);
}
.ffmpeg-progress .progress-text {
  font-size: 13px;
  color: var(--text-secondary);
}
.progress-bar {
  height: 6px;
  background: var(--bg-tertiary);
  border-radius: 3px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
  transition: width 0.3s ease;
}
.ffmpeg-error {
  padding: 10px 12px;
  border: 1px solid rgba(239, 68, 68, 0.35);
  border-radius: var(--radius-sm);
  background: rgba(239, 68, 68, 0.08);
}

/* Upload destinations step */
.upload-row {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  padding: 12px 14px;
  margin-bottom: 10px;
}
.upload-row.connected {
  border-color: rgba(74, 222, 128, 0.4);
  background: rgba(74, 222, 128, 0.06);
}
.upload-row.skipped {
  opacity: 0.75;
}
.upload-row.coming-soon {
  border-style: dashed;
  opacity: 0.7;
}
.upload-row-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.upload-row-head strong { margin-right: 8px; }
.upload-row-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.upload-row-body { margin-top: 10px; }
.connected-card {
  display: flex;
  gap: 10px;
  align-items: center;
}
.channel-thumb-sm {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.state-pill {
  display: inline-block;
  font-size: var(--font-xs);
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  letter-spacing: 0.3px;
  border: 1px solid var(--border);
  vertical-align: middle;
}
.state-pill.state-set {
  color: var(--success);
  border-color: rgba(74, 222, 128, 0.4);
  background: rgba(74, 222, 128, 0.12);
}
.state-pill.state-empty {
  color: var(--text-muted);
  background: var(--bg-tertiary);
}
.state-pill.state-muted {
  color: var(--text-secondary);
  background: var(--bg-tertiary);
}
</style>
