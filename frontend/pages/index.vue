<template>
  <div class="home">
    <!-- Header -->
    <header class="home-header">
      <div>
        <h1>Story Studio KH</h1>
        <p class="text-muted">Create, generate, and produce story episodes</p>
      </div>
    </header>

    <!-- Onboarding (no projects) -->
    <div v-if="!loading && projects.length === 0" class="onboarding">
      <div class="onboarding-card">
        <div class="onboarding-icon">&#10024;</div>
        <h2>Welcome to Story Studio KH</h2>
        <p>Create your first project to start generating story episodes with AI.</p>
        <div class="flex gap-2 mt-2" style="justify-content:center; flex-wrap:wrap">
          <button class="btn btn-primary btn-lg" @click="showCreate = true">
            Create Your First Project
          </button>
          <button class="btn btn-secondary btn-lg" @click="openImport">
            📥 Import existing…
          </button>
        </div>
        <p class="text-muted mt-2" style="font-size: 12px;">
          Syncing your project folder from another computer via iCloud / Google Drive / OneDrive?
          Click <strong>Import existing</strong> to register it here.
        </p>
      </div>
    </div>

    <!-- Project list -->
    <div v-else-if="!loading" class="project-list">
      <div class="flex justify-between items-center mb-2">
        <h2>Your Projects</h2>
        <div class="flex gap-2">
          <button class="btn btn-secondary" @click="openImport">📥 Import existing…</button>
          <button class="btn btn-primary" @click="showCreate = true">+ New Project</button>
        </div>
      </div>

      <div class="grid-3">
        <div
          v-for="project in projects"
          :key="project.slug"
          class="project-card"
          @click="navigateTo(`/projects/${project.slug}`)"
        >
          <div class="project-card-header">
            <h3>{{ project.name }}</h3>
            <div class="project-card-badges">
              <span
                v-if="project.output_root_exists === false"
                class="badge badge-error"
                :title="`Folder not found on disk: ${project.output_root}. Import from its new location via 'Import existing…' to relocate.`"
              >⚠ Folder missing</span>
              <span v-if="project.portable" class="badge badge-done" title="Multi-machine — folder synced via cloud storage">📡 Synced</span>
              <span class="badge" :class="project.has_api_keys ? 'badge-done' : 'badge-queued'">
                {{ project.has_api_keys ? 'Ready' : 'Setup needed' }}
              </span>
            </div>
          </div>
          <div class="project-card-meta">
            <span>Prefix: {{ project.episode_prefix }}</span>
            <span>Created {{ formatDate(project.created_at) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Create project modal -->
    <div v-if="showCreate" class="modal-overlay" @click.self="closeCreate">
      <div class="modal">
        <h2>Create New Project</h2>

        <!-- Step 0: mode — multi-machine vs local -->
        <div v-if="!modeChosen">
          <p class="text-muted mb-2" style="font-size: 13px;">
            How do you want to save this project? You can switch modes later in Settings.
          </p>
          <div class="template-cards" role="radiogroup" aria-label="Project mode">
            <button
              type="button"
              role="radio"
              :aria-checked="form.portable === true"
              :class="['template-card', { selected: form.portable === true }]"
              @click="form.portable = true"
            >
              <span class="template-icon" aria-hidden="true">📡</span>
              <strong>Multi-machine</strong>
              <p>
                Save to a cloud-synced folder (iCloud Drive, Google Drive, OneDrive, etc.)
                so you can open this project from any computer. A
                <code>.story-studio-project.json</code> manifest travels with the folder
                so other machines can <em>Import existing…</em> and resume work.
              </p>
            </button>
            <button
              type="button"
              role="radio"
              :aria-checked="form.portable === false"
              :class="['template-card', { selected: form.portable === false }]"
              @click="form.portable = false"
            >
              <span class="template-icon" aria-hidden="true">💻</span>
              <strong>Local only</strong>
              <p>
                Save to this computer. Fastest — no cloud setup needed. You can always
                switch to multi-machine later by moving the project folder to a synced
                location and clicking <em>Enable cloud sync</em>.
              </p>
            </button>
          </div>
          <div class="flex gap-2 mt-2">
            <button class="btn btn-secondary" @click="closeCreate">Cancel</button>
            <button
              class="btn btn-primary"
              :disabled="form.portable === null"
              @click="modeChosen = true"
            >
              Next: Project Basics
            </button>
          </div>
        </div>

        <!-- Step indicator (6 steps: Basics → Location → Video tools → API Keys → Upload → Review) -->
        <div v-if="modeChosen" class="steps">
          <div v-for="s in 6" :key="s" :class="['step', { active: step === s, done: step > s }]">
            {{ s }}
          </div>
        </div>

        <!-- Step 1: Basics -->
        <div v-if="modeChosen && step === 1">
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
              <span class="text-muted" style="font-size:11px">Season, Batch, Volume, etc.</span>
            </div>
            <div class="form-group">
              <label>Episodes per Group</label>
              <input v-model.number="form.season_size" class="input" type="number" min="1" />
            </div>
          </div>
          <div class="form-group">
            <label id="template-label">Template</label>
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
          <div class="flex gap-2">
            <button class="btn btn-secondary" @click="modeChosen = false">Back</button>
            <button class="btn btn-primary" :disabled="!form.name" @click="step = 2">
              Next: Save Location
            </button>
          </div>
        </div>

        <!-- Step 2: Save Location (new) -->
        <div v-if="modeChosen && step === 2">
          <p v-if="form.portable" class="text-muted mb-2" style="font-size: 13px;">
            Pick a folder inside your cloud-sync location — <code>iCloud Drive</code>,
            <code>Google Drive</code>, <code>OneDrive</code>, etc. Whatever folder you
            pick will be mirrored to your other computers, and a
            <code>.story-studio-project.json</code> manifest will travel with it.
          </p>
          <p v-else class="text-muted mb-2" style="font-size: 13px;">
            Choose where on your computer this project's files (scripts, images, audio, video) should be saved. You'll be able to reach them any time in Finder.
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
        <div v-if="modeChosen && step === 3">
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
              <div class="text-muted" style="font-size: 12px; margin-top: 2px;">
                Version <code>{{ ffmpegStatus.version }}</code>
                · {{ ffmpegStatus.source === 'bundled' ? 'Bundled with app' : 'Detected on your system' }}
              </div>
              <div v-if="ffmpegStatus.path" class="text-muted" style="font-size: 11px; word-break: break-all; margin-top: 4px;">
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
              <p class="text-muted mt-1" style="font-size: 11px; text-align: center;">
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
              <p class="text-muted mt-1" style="font-size: 11px;">
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
              Next: API Keys
            </button>
          </div>
        </div>

        <!-- Step 4: API Keys -->
        <div v-if="modeChosen && step === 4">
          <p class="text-muted mb-2">Add API keys for the services you want to use. You can skip this and add them later in Settings.</p>

          <!-- Connectivity precheck banner.
               Without this, a user behind a corporate firewall, captive
               portal, or DNS-broken LAN can't distinguish "key is wrong"
               from "can't reach provider" — both surface as the same
               opaque error during `testApiKey`. The banner runs the
               backend precheck (GET /api/connectivity/precheck) when the
               step mounts and whenever the user clicks Retry.
               States:
                 • all reachable   → no banner (silence is good UX)
                 • some unreachable → yellow non-blocking warning
                 • all unreachable  → red block; Next disabled unless the
                   user explicitly opts to "Continue anyway" -->
          <div v-if="precheck.loading" class="precheck-banner precheck-info">
            <span>🔎 Checking connectivity to AI providers…</span>
          </div>
          <div
            v-else-if="precheck.result && precheck.result.unreachable.length > 0 && precheck.result.reachable.length === 0"
            class="precheck-banner precheck-error"
          >
            <div>
              <strong>Can't reach any AI provider.</strong>
              <p style="font-size: 12px; margin: 4px 0 0 0;">
                Check your network, DNS, firewall, or captive portal — your keys can't be verified until connectivity is restored.
              </p>
              <div class="precheck-host-list">
                <code v-for="h in precheck.result.unreachable" :key="h.host" class="precheck-host">
                  {{ h.host }} <span class="text-muted">({{ h.reason }})</span>
                </code>
              </div>
            </div>
            <div class="flex gap-2 mt-1">
              <button class="btn btn-sm btn-secondary" :disabled="precheck.loading" @click="runPrecheck">
                {{ precheck.loading ? 'Checking…' : 'Retry' }}
              </button>
              <button
                v-if="!precheck.override"
                class="btn btn-sm btn-secondary"
                @click="precheck.override = true"
                title="Skip the connectivity gate and proceed anyway."
              >
                Continue anyway
              </button>
              <span v-else class="text-muted" style="font-size: 11px; align-self: center;">
                Override enabled — Next is re-enabled.
              </span>
            </div>
          </div>
          <div
            v-else-if="precheck.result && precheck.result.unreachable.length > 0"
            class="precheck-banner precheck-warn"
          >
            <div>
              <strong>Some providers can't be reached.</strong>
              <p style="font-size: 12px; margin: 4px 0 0 0;">
                If you don't plan to use these, ignore this. Otherwise check your network before continuing.
              </p>
              <div class="precheck-host-list">
                <code v-for="h in precheck.result.unreachable" :key="h.host" class="precheck-host">
                  {{ h.label }} <span class="text-muted">({{ h.reason }})</span>
                </code>
              </div>
            </div>
            <button class="btn btn-sm btn-secondary mt-1" :disabled="precheck.loading" @click="runPrecheck">
              {{ precheck.loading ? 'Checking…' : 'Retry' }}
            </button>
          </div>
          <div v-else-if="precheck.error" class="precheck-banner precheck-warn">
            <span>Couldn't run connectivity check: {{ precheck.error }}.</span>
            <button class="btn btn-sm btn-secondary mt-1" @click="runPrecheck">Retry</button>
          </div>

          <!-- Per-key verification. Each row tests its key on blur OR on
               explicit Test-button click — never on every keystroke (rate
               limits). Editing a key resets its pill back to "untested" so a
               green pill can't outlive the key it vouches for. The "Continue
               without testing" link per row is a per-key bypass: it lets the
               operator advance with an unverified key (e.g. provider down)
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
              :title="'Skip verification for this key only. You can test it in Settings → API Keys later.'"
              @click="bypassKey(row.provider)"
            >
              Continue without testing — I'll add this later
            </button>
          </div>

          <!-- Convenience: test every entered key in one click. Per-row
               buttons are still primary; this is for operators who pasted
               all five and want a single click instead of five. -->
          <div class="flex gap-2 items-center mt-2" style="flex-wrap:wrap">
            <button
              type="button"
              class="btn btn-secondary"
              :disabled="keysTesting || providedKeyCount === 0"
              :title="providedKeyCount === 0 ? 'Add at least one key to test' : `Call each provider to verify the ${providedKeyCount} key${providedKeyCount === 1 ? '' : 's'} you have entered`"
              @click="testAllKeys"
            >
              {{
                keysTesting
                  ? 'Testing…'
                  : (providedKeyCount === 0
                      ? '🔍 Test keys'
                      : `🔍 Test all ${providedKeyCount} key${providedKeyCount === 1 ? '' : 's'}`)
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
             Inserted between API Keys and Review so the machine is pinned
             to the right YouTube channel at setup — not 30 minutes later,
             which is when a wrong-channel upload could already have happened
             (see audit-reports/04 §3). Each row is skippable so users without
             a TikTok/FB presence aren't blocked. -->
        <div v-if="modeChosen && step === 5">
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
                <div class="text-muted" style="font-size: 11px;">
                  Channel id <code>{{ uploadStep.youtube.channelId }}</code>
                </div>
                <div class="text-muted" style="font-size: 11px;">
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
          <div v-if="createdProject" class="text-muted mt-2" style="font-size: 11px;">
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
        <div v-if="modeChosen && step === 6">
          <div class="review-list">
            <div class="review-item">
              <span class="text-muted">Mode</span>
              <span>{{ form.portable ? '📡 Multi-machine (cloud-synced)' : '💻 Local only' }}</span>
            </div>
            <div class="review-item">
              <span class="text-muted">Name</span>
              <span>{{ form.name }}</span>
            </div>
            <div class="review-item">
              <span class="text-muted">Template</span>
              <span>{{ form.template }}</span>
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
                  <span class="text-muted" style="font-size: 11px;">
                    ({{ ffmpegStatus.source === 'bundled' ? 'bundled' : 'system' }})
                  </span>
                </template>
                <template v-else>Not installed</template>
              </span>
            </div>
            <div class="review-item">
              <span class="text-muted">API Keys</span>
              <span>{{ keyCount }} configured</span>
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
                <span class="text-muted" style="font-size: 11px;">(e.g. {{ sampleCode }})</span>
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
                <span class="text-muted" style="font-size: 11px;">
                  (saw: {{ (c.candidates || []).join(', ') || '—' }})
                </span>
              </label>
              <label v-else-if="c.field === 'episode_digits'">
                Episode digits
                <span class="text-muted" style="font-size: 11px;">
                  (saw: {{ (c.candidates || []).join(', ') }})
                </span>
              </label>
              <label v-else-if="c.field === 'season_size'">
                Episodes per season
                <span class="text-muted" style="font-size: 11px;">
                  (observed: {{ (c.observed_sizes || []).join(', ') }})
                </span>
              </label>
              <label v-else-if="c.field === 'season_prefix'">
                Season label
                <span class="text-muted" style="font-size: 11px;">
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
            <span class="text-muted" style="font-size: 11px;">Lowercase letters, digits, and hyphens only.</span>
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
useHead({ title: 'Story Studio KH' })
const { get, post, put } = useApi()
const { success, error: showError } = useToast()

const loading = ref(true)
const projects = ref<any[]>([])
const templates = ref<any[]>([])

function templateIcon(id: string): string {
  const map: Record<string, string> = {
    blank: '📄',
    'sleep-stories': '🌙',
  }
  return map[id] || '📦'
}
const showCreate = ref(false)
const step = ref(1)
const modeChosen = ref(false)
const creating = ref(false)
const picking = ref(false)

const form = reactive<{
  name: string
  template: string
  episode_prefix: string
  season_prefix: string
  season_size: number
  output_root: string
  /**
   * Defaults to `true` — the portable manifest is always written when
   * output_root is absolute anyway, so defaulting Multi-machine is the
   * honest UX. `null` is reserved for "user hasn't confirmed Step 0 yet".
   */
  portable: boolean | null
}>({
  name: '',
  template: 'blank',
  episode_prefix: 'EP',
  season_prefix: 'Season',
  season_size: 20,
  output_root: '',
  portable: true,
})

function closeCreate() {
  showCreate.value = false
  modeChosen.value = false
  step.value = 1
  form.portable = true
  form.output_root = ''
  // Intentionally leave ffmpegStatus populated — re-checking FFmpeg every
  // time the user reopens the wizard is pointless (the binary doesn't move
  // between opens). It gets refreshed if the user revisits Step 3.
  // Connectivity precheck, on the other hand, IS worth re-running on the
  // next wizard open: network state can change in the seconds between
  // "cancelled" and "reopened" (toggled VPN, joined a different Wi-Fi).
  precheck.result = null
  precheck.error = ''
  precheck.override = false
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
  ffmpegProgressMessage.value = 'Downloading FFmpeg…'
  ffmpegProgressPercent.value = 10
  // The backend currently doesn't stream progress, so we drive a best-effort
  // indeterminate tick so the bar visibly moves during the ~1min download.
  // If /ffmpeg/install gains SSE later, swap this for real progress.
  const tick = setInterval(() => {
    if (ffmpegProgressPercent.value < 85) ffmpegProgressPercent.value += 2
  }, 800)
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
    clearInterval(tick)
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
    const r = await post<{ path: string | null }>('/system/pick-folder', {})
    if (r.path) form.output_root = r.path
  } catch (e: any) {
    showError(e.data?.detail || 'Folder picker failed')
  } finally {
    picking.value = false
  }
}

const apiKeys = reactive({
  openai: '',
  anthropic: '',
  kie: '',
  fal: '',
  genaipro: '',
})

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
    portable: form.portable === true,
  })
  const keys: Record<string, string> = {}
  if (apiKeys.openai) keys.openai_api_key = apiKeys.openai
  if (apiKeys.anthropic) keys.anthropic_api_key = apiKeys.anthropic
  if (apiKeys.kie) keys.kie_api_key = apiKeys.kie
  if (apiKeys.fal) keys.fal_api_key = apiKeys.fal
  if (apiKeys.genaipro) keys.genaipro_api_key = apiKeys.genaipro
  if (Object.keys(keys).length > 0) {
    await put(`/projects/${project.slug}/settings/api-keys`, keys)
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

const keyCount = computed(() =>
  [apiKeys.openai, apiKeys.anthropic, apiKeys.kie, apiKeys.fal, apiKeys.genaipro].filter(Boolean).length
)

// ── Per-key verification ─────────────────────────────────────────────────
// The wizard verifies each provided key against its provider BEFORE letting
// the user advance past Step 4. Without this, typos surface as opaque 401s
// 5–15 minutes into the first generation job. Empty inputs are fine — users
// who only plan to use script generation shouldn't be forced to paste every
// key. The "Skip verification" checkbox is the escape hatch for when the
// network is flaky or the user genuinely wants to defer.
type KeyProvider = 'openai' | 'anthropic' | 'kie' | 'fal' | 'genaipro'
type KeyTestStatus = 'untested' | 'testing' | 'valid' | 'invalid' | 'unreachable'

const KEY_PROVIDERS: KeyProvider[] = ['openai', 'anthropic', 'kie', 'fal', 'genaipro']

const keyRows: Array<{ provider: KeyProvider; label: string; placeholder?: string }> = [
  { provider: 'openai',    label: 'OpenAI API Key (for script generation)',         placeholder: 'sk-...' },
  { provider: 'anthropic', label: 'Anthropic API Key (for script generation)',      placeholder: 'sk-ant-...' },
  { provider: 'kie',       label: 'kie.ai API Key (for image generation)' },
  { provider: 'fal',       label: 'fal.ai API Key (for audio generation)' },
  { provider: 'genaipro',  label: 'GenAIPro API Key (optional — alternative ElevenLabs TTS)' },
]

const keyTests = reactive<Record<KeyProvider, { status: KeyTestStatus; message: string; bypassed: boolean }>>({
  openai:    { status: 'untested', message: '', bypassed: false },
  anthropic: { status: 'untested', message: '', bypassed: false },
  kie:       { status: 'untested', message: '', bypassed: false },
  fal:       { status: 'untested', message: '', bypassed: false },
  genaipro:  { status: 'untested', message: '', bypassed: false },
})

const keysTesting = ref(false)
// Track the key value last tested per provider so we can avoid redundant
// re-tests on blur if nothing changed (the operator clicking elsewhere
// shouldn't ping the provider every time).
const lastTestedKey = reactive<Record<KeyProvider, string>>({
  openai: '', anthropic: '', kie: '', fal: '', genaipro: '',
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
      `/test-key/${provider}`,
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
  if (keysTesting.value) return 'Calling each provider…'
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
          `/test-key/${p}`,
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

// ── Connectivity precheck ────────────────────────────────────────────────
// Distinguishes "your API key is wrong" from "your network can't reach the
// provider." The backend runs concurrent 3-second probes against the base
// hosts we use for script/image/audio/video generation; we render a banner
// on wizard Step 4 (API Keys) so the user isn't left to burn 10 minutes
// re-pasting correct keys while on a broken network.
interface PrecheckResult {
  reachable: Array<{ host: string; label: string; status: number }>
  unreachable: Array<{ host: string; label: string; reason: string }>
  elapsed_ms: number
}
const precheck = reactive<{
  loading: boolean
  result: PrecheckResult | null
  error: string
  override: boolean
}>({ loading: false, result: null, error: '', override: false })

async function runPrecheck() {
  precheck.loading = true
  precheck.error = ''
  try {
    precheck.result = await get<PrecheckResult>('/connectivity/precheck')
    // A fresh successful probe resets the override. If everything is
    // reachable the override becomes moot; if some hosts are still down
    // the user re-confirms intent before the Next button re-activates.
    if (precheck.result.unreachable.length === 0) {
      precheck.override = false
    }
  } catch (e: any) {
    precheck.error = e?.data?.detail || e?.message || 'unknown error'
    precheck.result = null
  } finally {
    precheck.loading = false
  }
}

// Gating rules for the Next button on Step 4. Two independent concerns:
//   1. Connectivity — blocks only if ALL hosts unreachable and the user has
//      not clicked "Continue anyway". Partial outages stay non-blocking.
//   2. Per-key verification — if the user entered any keys, they must either
//      test them (all valid) or tick "Skip verification". Empty wizard (no
//      keys at all) is allowed through without either.
const connectivityOk = computed(() => {
  if (precheck.override) return true
  if (!precheck.result) return true
  if (precheck.result.reachable.length > 0) return true
  return false
})

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

const canAdvancePastKeys = computed(() => connectivityOk.value && keyVerificationOk.value)

const nextBlockReason = computed(() => {
  if (!connectivityOk.value) return 'Blocked until connectivity is restored, or click Continue anyway.'
  if (keysTesting.value) return 'Waiting for key tests to finish…'
  if (providedKeyCount.value === 0) return ''
  if (hasInvalidKey.value) return 'One or more keys were rejected by the provider. Fix them, or click "Continue without testing" on each row.'
  if (hasUnreachable.value) return "Couldn't reach a provider. Check your network, retry, or click \"Continue without testing\" on the affected row."
  if (hasUntestedProvidedKeys.value) return 'Click "Test" on each row to verify, or "Continue without testing" to defer.'
  return ''
})

function formatDate(date: string) {
  return new Date(date).toLocaleDateString()
}

async function loadData() {
  loading.value = true
  try {
    const [p, t] = await Promise.all([
      get<any[]>('/projects'),
      get<any[]>('/projects/templates'),
    ])
    projects.value = p
    templates.value = t
  } finally {
    loading.value = false
  }
}

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
    const r = await post<{ path: string | null }>('/system/pick-folder', {})
    if (!r.path) return
    importSource.value = r.path
    const inspect = await post<ImportPreview>('/projects/import/inspect', { source_path: r.path })
    importPreview.value = inspect
    for (const k of Object.keys(overrides)) delete (overrides as any)[k]
    importStep.value = 'confirm'
  } catch (e: any) {
    importError.value = e.data?.detail || 'Could not read that folder.'
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
// Connectivity precheck fires on entering Step 4 (API Keys) so the banner
// is ready before the user starts pasting keys. It re-runs only on explicit
// Retry after that; we don't auto-poll.
watch(step, (s) => {
  if (s === 3 && modeChosen.value && !ffmpegChecking.value && !ffmpegInstalling.value) {
    if (!ffmpegStatus.value || !ffmpegStatus.value.installed) {
      checkFFmpeg()
    }
  }
  if (s === 4 && modeChosen.value && !precheck.loading && !precheck.result) {
    runPrecheck()
  }
})

// ── Auto-restore last open page ──────────────────────────────────────────
// Operator was on `/projects/foo/audio` when the app went away. On the next
// launch we land them back there instead of forcing them through the project
// list. A 24h cap keeps stale sessions from trapping someone on a project
// they were "done with" but never explicitly navigated away from.
const RESTORE_MAX_AGE_MS = 24 * 60 * 60 * 1000
// Mirrors the server-side allowlist in services/last-session.ts. Kept literal
// here (not imported from the plugin) so home-page restore can't accidentally
// follow a route the renderer-side plugin would refuse to save.
const RESTORABLE_SUBS = new Set([
  'ideas', 'pipeline', 'scripts', 'metadata', 'image-prompts', 'images',
  'video', 'audio', 'audio-merge', 'video-assembly', 'upload',
  'tiktok-upload', 'facebook-upload', 'presets', 'assets', 'jobs', 'settings',
])

function isRestorablePath(p: string): boolean {
  const m = /^\/projects\/([^/]+)(?:\/([^/?#]+))?\/?$/.exec(p)
  if (!m) return false
  const sub = m[2] ?? 'index'
  return sub === 'index' || RESTORABLE_SUBS.has(sub)
}

/**
 * Auto-restore must fire AT MOST ONCE per Electron launch. Without this gate
 * the loop is: user clicks "All Projects" in the sidebar → navigates to `/`
 * → onMounted → restore re-fires → bounced back to the project page they
 * just left. SessionStorage is the right scope — a per-tab key that resets
 * only on a new Electron-window launch, exactly the "fresh start" boundary
 * we want.
 *
 * The flag is set BEFORE the eligibility checks so even when restore
 * declines (no last session, stale, non-restorable route), we still don't
 * try again on the next visit. If the user explicitly wants to resume,
 * they pick the project from the list manually.
 */
const RESTORE_ATTEMPTED_KEY = 'story-studio:restore-attempted'

async function maybeRestoreLastSession(): Promise<boolean> {
  if (typeof sessionStorage !== 'undefined') {
    if (sessionStorage.getItem(RESTORE_ATTEMPTED_KEY) === '1') return false
    sessionStorage.setItem(RESTORE_ATTEMPTED_KEY, '1')
  }
  try {
    const last = await get<{
      projectSlug?: string; route?: string; ts?: number;
      unclean_shutdown?: boolean;
    }>('/last-session')
    if (!last?.route || !last?.ts) return false
    if (Date.now() - last.ts > RESTORE_MAX_AGE_MS) return false
    if (!isRestorablePath(last.route)) return false
    // Tell the dashboard layout this navigation came from a restore so it
    // can render the "Resumed where you left off" chip. Cleared by the chip
    // dismiss / by an explicit return-to-home click.
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('story-studio:restored', '1')
    }
    await navigateTo(last.route)
    return true
  } catch {
    return false
  }
}

onMounted(async () => {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent.toLowerCase() : ''
  isMac.value = ua.includes('mac')
  isLinux.value = ua.includes('linux') && !ua.includes('android')
  // Try restore first — if it succeeds we're navigating away, no point
  // populating the project list. Leaving `loading` true avoids a flash of
  // the home UI before the route swap.
  const restored = await maybeRestoreLastSession()
  if (restored) return
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
}

.home-header h1 {
  font-size: 32px;
  font-weight: 700;
  color: var(--accent);
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

.project-card-meta {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-muted);
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
  padding: 32px;
  width: 520px;
  max-height: 85vh;
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
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  letter-spacing: 0.4px;
  border: 1px solid var(--border);
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
  font-size: 10px;
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
  font-size: 11px;
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
  font-size: 11px;
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
  font-size: 11px;
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
  font-size: 11px;
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
