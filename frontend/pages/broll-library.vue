<!--
  B-Roll Library — app-level page (not per-project).

  Two main surfaces:
   1. Pool list (left rail): pick which registered pool to view, or add
      a new one. Each pool shows online state — the SSD might not be
      plugged in, in which case clip thumbnails still render from the
      per-Mac thumbnail cache but tags/scan are disabled.
   2. Clip grid (main): every clip in the selected pool, with thumbnail,
      duration, resolution, fps, and editable tag chips. Buttons for
      re-scan, normalize-all, and per-clip normalize.
-->
<template>
  <div class="broll-page">
    <header class="page-header">
      <div>
        <h1>Assets Library</h1>
        <p class="text-muted">
          App-level pool of stock footage shared across every project on this machine. Register a
          folder (typically your portable SSD) once; the app indexes clips, generates thumbnails,
          and optionally normalises everything to 1080p so video assembly stays fast.
        </p>
      </div>
      <button class="btn btn-primary" @click="openCreateModal()">+ Register pool</button>
    </header>

    <div v-if="loading" class="muted">Loading pools…</div>

    <EmptyState
      v-else-if="!pools.length"
      icon="&#127909;"
      title="No B-Roll pools yet"
      message="Register a folder on your SSD that holds the clips. Tags + indexing metadata live in a JSON sidecar inside that folder, so they travel with the SSD across Macs."
    >
      <template #action>
        <button class="btn btn-primary mt-2" @click="openCreateModal()">+ Register pool</button>
      </template>
    </EmptyState>

    <div v-else class="broll-layout">
      <!-- Pool list (left rail) -->
      <aside class="pool-rail">
        <!-- v1.0.405 — filter pools by media so image pools have a clear home. -->
        <div class="pool-filter">
          <button :class="['pool-filter-btn', { active: poolFilter === 'all' }]" @click="poolFilter = 'all'">All ({{ pools.length }})</button>
          <button :class="['pool-filter-btn', { active: poolFilter === 'video' }]" @click="poolFilter = 'video'">🎞 Video ({{ videoPoolCount }})</button>
          <button :class="['pool-filter-btn', { active: poolFilter === 'image' }]" @click="poolFilter = 'image'">🖼 Images ({{ imagePoolCount }})</button>
          <button :class="['pool-filter-btn', { active: poolFilter === 'audio' }]" @click="poolFilter = 'audio'">🔊 SFX ({{ audioPoolCount }})</button>
        </div>
        <p v-if="!filteredPools.length" class="muted pool-filter-empty">
          No {{ poolFilter === 'image' ? 'image' : poolFilter === 'video' ? 'video' : '' }} pools yet —
          <button class="link-btn" @click="openCreateModal()">register one</button>.
        </p>
        <button
          v-for="p in filteredPools"
          :key="p.id"
          :class="['pool-card', { active: p.id === selectedPoolId }]"
          @click="selectPool(p.id)"
        >
          <div class="pool-card-name">{{ p.name }}</div>
          <div class="pool-card-meta">
            <span :class="['pool-online', p.online ? 'is-online' : 'is-offline']">
              {{ p.online ? '● online' : '○ offline' }}
            </span>
            <span class="text-muted text-xs">{{ p.media === 'image' ? '🖼 image pool' : p.media === 'audio' ? '🔊 sfx pool' : `${p.fps_target}fps · 1080p` }}</span>
          </div>
          <div class="pool-card-path" :title="p.folder_path">{{ p.folder_path }}</div>
        </button>
      </aside>

      <!-- Selected pool: scan controls + clip grid -->
      <section v-if="selectedPool" class="pool-main">
        <div class="pool-header">
          <div>
            <h2>{{ selectedPool.name }}</h2>
            <div class="text-muted text-xs">
              {{ selectedPool.folder_path }} ·
              auto-normalize <strong>{{ selectedPool.auto_normalize ? 'ON' : 'OFF' }}</strong> ·
              target <strong>{{ selectedPool.fps_target }}fps · 1080p</strong>
            </div>
          </div>
          <div class="pool-actions">
            <button
              class="btn btn-sm btn-secondary"
              :disabled="!selectedPool.online || scanning"
              :title="!selectedPool.online ? 'Pool offline — plug in the SSD first' : 'Re-scan the folder for new / changed / removed clips'"
              @click="runScan"
            >
              <LoadingSpinner v-if="scanning" size="sm" />
              <span v-else>↻</span>
              {{ scanning ? 'Scanning…' : 'Re-scan' }}
            </button>
            <button
              class="btn btn-sm btn-secondary"
              :disabled="!selectedPool.online || normalizingAll || !unnormalizedCount"
              :title="!selectedPool.online ? 'Pool offline' : !unnormalizedCount ? 'All clips already normalised' : `Queue normalize jobs for the ${unnormalizedCount} clip(s) that haven't been re-encoded to 1080p ${selectedPool.fps_target}fps yet.`"
              @click="runNormalizeAll"
            >
              ⚡ Normalize all{{ unnormalizedCount ? ` (${unnormalizedCount})` : '' }}
            </button>
            <!-- Vision model for auto-tagging (both clips + images). -->
            <select
              v-model="autotagModel"
              class="select select-sm autotag-model-select"
              :disabled="autotagModelsLoading || !usableAutotagModels.length"
              title="Which vision model tags your clips/images. Local Chat Studio models are free; cloud models use their configured API key. Video clips tag from a midpoint frame; images tag directly."
            >
              <option v-if="autotagModelsLoading" value="" disabled>Loading models…</option>
              <optgroup v-for="group in autotagModelGroups" :key="group.provider" :label="group.label">
                <option
                  v-for="m in group.items"
                  :key="m.id"
                  :value="m.id"
                  :disabled="!isUsableAutotagModel(m.data)"
                  :title="autotagModelTooltip(m.data)"
                >
                  {{ m.data.label }}{{ autotagModelSuffix(m.data) }}
                </option>
              </optgroup>
            </select>
            <button
              class="btn btn-sm btn-secondary"
              :disabled="!selectedPool.online || autotagging || !untaggedCount"
              :title="!selectedPool.online ? 'Pool offline' : !untaggedCount ? 'Every clip/image already has at least one tag' : `Queue vision auto-tag jobs for the ${untaggedCount} item(s) with no tags yet, using ${autotagModel}.`"
              @click="runAutotagUntagged"
            >
              ✨ Auto-tag untagged{{ untaggedCount ? ` (${untaggedCount})` : '' }}
            </button>
            <button
              class="btn btn-sm btn-secondary"
              :disabled="!selectedPool.online || !clips.length"
              :title="!selectedPool.online ? 'Pool offline' : !clips.length ? 'No clips to rename' : 'Apply a naming template (e.g. prayer_{n:3}.{ext}) to every clip in this pool. Preview before applying.'"
              @click="openBulkRename"
            >
              ✏ Bulk rename
            </button>
            <button
              class="btn btn-ghost btn-sm"
              :title="'Toggle auto-normalize on new clips for this pool. When on, the next scan auto-queues normalize jobs for clips it newly indexed. Turn off if you want manual control or your SSD is slow.'"
              @click="toggleAutoNormalize"
            >
              auto-normalize: {{ selectedPool.auto_normalize ? 'ON' : 'OFF' }}
            </button>
            <button class="btn btn-ghost btn-sm" title="Rename this pool or repoint it to a different folder (e.g. you moved the drive)." @click="openEditModal">✎ Edit</button>
            <button class="btn btn-ghost btn-sm danger" @click="confirmDeletePool">✕ Unregister</button>
          </div>
        </div>

        <!-- v1.0.122+ — Tab nav for the selected pool. Three views:
             Clips (the existing grid + scan/normalize/autotag controls),
             Fetch (search Pexels/Pixabay + queue downloads into THIS pool),
             Asset Log (every clip's source + license + fetched_at). -->
        <div class="form-tabs mt-2">
          <button
            type="button"
            :class="['form-tab', { active: poolTab === 'clips' }]"
            @click="poolTab = 'clips'"
          >
            🎞 Clips
            <span class="text-muted text-xs ml-1">({{ clips.length }})</span>
          </button>
          <button
            type="button"
            :class="['form-tab', { active: poolTab === 'fetch' }]"
            @click="poolTab = 'fetch'"
          >
            🔎 {{ isAudioPool ? 'Fetch / Generate' : 'Fetch' }}
            <span class="text-muted text-xs ml-1">{{ isAudioPool ? '(Freesound · ElevenLabs)' : '(Pexels · Pixabay)' }}</span>
          </button>
          <button
            type="button"
            :class="['form-tab', { active: poolTab === 'log' }]"
            @click="poolTab = 'log'"
          >
            📋 Asset Log
            <span class="text-muted text-xs ml-1">({{ provenanceCount }})</span>
          </button>
        </div>

        <!-- ── Clips tab (existing pool view) ─────────────────────────── -->
        <div v-show="poolTab === 'clips'">

        <div v-if="!selectedPool.online" class="offline-banner">
          🔌 SSD not connected — connect <code>{{ selectedPool.folder_path }}</code> to scan or edit tags.
          Indexed clip metadata is preserved.
        </div>

        <div v-if="scanResult" class="scan-result">
          <strong>Scan complete</strong> —
          <span v-if="scanResult.added.length">+{{ scanResult.added.length }} new</span>
          <span v-if="scanResult.updated.length"> · {{ scanResult.updated.length }} updated</span>
          <span v-if="scanResult.unchanged.length"> · {{ scanResult.unchanged.length }} unchanged</span>
          <span v-if="scanResult.missing.length" class="text-warn"> · {{ scanResult.missing.length }} missing</span>
          <span v-if="scanResult.errors.length" class="text-danger"> · {{ scanResult.errors.length }} errors</span>
        </div>

        <!-- ── Pool jobs panel ─────────────────────────────────────────
             B-Roll normalize + auto-tag jobs are app-level (project_slug
             '_app_'), so they never showed up in any project's Jobs
             tab. v1.0.91+: inline panel here streams those jobs via
             /api/jobs/app/stream so the user sees normalize / autotag
             progress without leaving the page. Auto-collapses to the
             count when nothing is in flight; expands to a live list
             with progress lines when work is queued. -->
        <div v-if="visibleJobs.length || activeJobsCount > 0" class="pool-jobs">
          <button class="pool-jobs-header" type="button" @click="poolJobsExpanded = !poolJobsExpanded">
            <span class="pool-jobs-title">
              <span aria-hidden="true">⚙</span>
              Pool jobs
              <span class="pool-jobs-stats">
                <template v-if="activeJobsCount > 0">{{ activeJobsCount }} in progress</template>
                <template v-else>{{ visibleJobs.length }} recent</template>
              </span>
            </span>
            <span aria-hidden="true">{{ poolJobsExpanded ? '▾' : '▸' }}</span>
          </button>

          <div v-if="poolJobsExpanded" class="pool-jobs-list">
            <div v-for="job in visibleJobs" :key="job.job_id" :class="['pool-job-row', `is-${job.status}`]">
              <span class="pool-job-badge">{{ jobBadge(job) }}</span>
              <div class="pool-job-body">
                <div class="pool-job-title">{{ job.title || job.type }}</div>
                <div v-if="lastProgressLine(job)" class="pool-job-progress">{{ lastProgressLine(job) }}</div>
                <div v-if="job.status === 'error' && job.error" class="pool-job-error" :title="job.error">⚠ {{ job.error.slice(0, 200) }}</div>
              </div>
              <span class="pool-job-when">{{ relativeTime(job.finished_at || job.created_at) }}</span>
            </div>
            <div v-if="!visibleJobs.length" class="pool-jobs-empty">
              No recent pool jobs. Drop new clips into the folder + ↻ Re-scan to queue normalize jobs;
              click ✨ Auto-tag untagged to queue tag jobs.
            </div>
          </div>
        </div>

        <div v-if="clipsLoading" class="muted">Loading clips…</div>

        <div v-else-if="!clips.length" class="empty">
          No {{ selectedPool.media === 'image' ? 'images' : selectedPool.media === 'audio' ? 'sound effects' : 'clips' }} indexed yet. Drop
          {{ selectedPool.media === 'image' ? 'image files (jpg/png/webp…)' : selectedPool.media === 'audio' ? 'audio files (mp3/wav/m4a/ogg…)' : 'video files' }} into
          <code>{{ selectedPool.folder_path }}</code> via Finder and click <strong>↻ Re-scan</strong>.
        </div>

        <div v-else class="clip-grid">
          <article v-for="clip in clips" :key="clip.filename" :class="['clip-card', { 'is-missing': clip.missing }]">
            <div class="clip-thumb-wrap">
              <!-- Audio (SFX) pools have no thumbnail — play the clip inline. -->
              <template v-if="isAudioPool">
                <div class="clip-audio-wrap">
                  <audio
                    v-if="selectedPool.online && !clip.missing"
                    controls
                    preload="none"
                    class="clip-audio"
                    :src="audioUrl(selectedPoolId!, clip.filename)"
                  ></audio>
                  <div v-else class="clip-audio-offline">🔊 {{ clip.missing ? 'missing' : 'offline' }}</div>
                </div>
                <span class="clip-duration">{{ formatDuration(clip.duration) }}</span>
                <span v-if="clip.missing" class="clip-missing-badge">missing</span>
              </template>
              <template v-else>
                <img
                  :src="thumbnailUrl(selectedPoolId!, clip.filename)"
                  :alt="clip.filename"
                  class="clip-thumb"
                  loading="lazy"
                  @error="onThumbError"
                />
                <span class="clip-duration">{{ formatDuration(clip.duration) }}</span>
                <span v-if="clip.normalized" class="clip-normalized" :title="`Normalized to ${selectedPool.fps_target}fps 1080p`">✓ {{ selectedPool.fps_target }}fps</span>
                <span v-if="clip.missing" class="clip-missing-badge">missing</span>
              </template>
            </div>
            <div class="clip-body">
              <div class="clip-filename" :title="clip.filename">{{ clip.filename }}</div>
              <div class="clip-meta text-muted text-xs">
                <template v-if="isAudioPool">{{ formatDuration(clip.duration) }} · {{ formatBytes(clip.size_bytes) }}</template>
                <template v-else>{{ clip.width }}×{{ clip.height }} · {{ clip.fps }}fps · {{ formatBytes(clip.size_bytes) }}</template>
              </div>
              <ChipInput
                :model-value="clip.tags"
                placeholder="add tags…"
                allow-custom
                :disabled="!selectedPool.online"
                @update:model-value="(tags: string[]) => saveTags(clip.filename, tags)"
              />
              <div class="clip-actions">
                <button
                  v-if="!clip.normalized"
                  class="btn btn-ghost btn-sm"
                  :disabled="!selectedPool.online"
                  :title="'Re-encode this clip to ' + selectedPool.fps_target + 'fps 1080p H.264. Runs as a queued job — see Jobs panel.'"
                  @click="normalizeOne(clip.filename)"
                >
                  ⚡ Normalize
                </button>
                <button
                  v-if="!isAudioPool"
                  class="btn btn-ghost btn-sm"
                  :disabled="!selectedPool.online"
                  :title="'Vision-LLM tag suggestion from this clip thumbnail. Unioned with existing tags. ~$0.002 per call.'"
                  @click="autotagOne(clip.filename)"
                >
                  ✨ Auto-tag
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  :disabled="!selectedPool.online"
                  :title="'Rename this clip on disk. The sidecar entry + .broll-normalized/ variant follow automatically. Keep the file extension (e.g. .mp4) intact.'"
                  @click="openRenameOne(clip.filename)"
                >
                  ✏ Rename
                </button>
              </div>
              <!-- v1.0.122+ — Provenance hover. Native title attribute so
                   the user gets a tooltip on hover without an extra
                   component mount per clip. The clip-source-pill below
                   shows the source badge at-a-glance and links out. -->
              <div
                v-if="provenanceFor(clip.filename)"
                class="clip-source-row"
                :title="provenanceTooltip(clip.filename)"
              >
                <span :class="['clip-source-pill', `source-${provenanceFor(clip.filename)!.source}`]">
                  {{ provenanceFor(clip.filename)!.source }}
                </span>
                <a
                  class="clip-source-link"
                  :href="provenanceFor(clip.filename)!.source_url"
                  target="_blank"
                  rel="noopener noreferrer"
                  @click.stop
                >view source ↗</a>
              </div>
              <div v-else class="clip-source-row clip-source-local" title="Hand-added clip — no fetch provenance recorded.">
                <span class="clip-source-pill source-local">local</span>
              </div>
            </div>
          </article>
        </div>

        </div><!-- /Clips tab -->

        <!-- ── Fetch tab ──────────────────────────────────────────────── -->
        <div v-show="poolTab === 'fetch'">

          <!-- Audio pools: generate a sound effect from a text prompt via
               ElevenLabs. Saves the MP3 into the pool folder + re-scans. -->
          <div v-if="isAudioPool" class="sfx-gen">
            <div class="sfx-gen-title">🎛 Generate a sound effect <span class="text-muted text-xs">· ElevenLabs</span></div>
            <div class="sfx-gen-row">
              <input
                v-model="sfxPrompt"
                class="input sfx-gen-prompt"
                placeholder="e.g. distant thunder rumble, glass shatter, retro coin pickup…"
                :disabled="sfxGenerating"
                @keydown.enter="generateSfx"
              />
              <input
                v-model.number="sfxDuration"
                type="number"
                min="0.5"
                max="22"
                step="0.5"
                class="input sfx-gen-duration"
                title="Optional length in seconds (0.5–22). Leave blank to let ElevenLabs pick."
                placeholder="auto"
                :disabled="sfxGenerating"
              />
              <button
                class="btn btn-primary"
                :disabled="!sfxPrompt.trim() || sfxGenerating || !selectedPool?.online"
                :title="!selectedPool?.online ? 'Pool offline — plug in the SSD first' : 'Generate via ElevenLabs and add to this pool'"
                @click="generateSfx"
              >
                <LoadingSpinner v-if="sfxGenerating" size="sm" />
                {{ sfxGenerating ? 'Generating…' : '✨ Generate' }}
              </button>
            </div>
            <p class="fetch-hint text-muted text-xs">
              Needs an <strong>ElevenLabs</strong> API key (App Settings → API Keys). The clip lands tagged
              with your prompt keywords and plays inline under the <strong>🎞 Clips</strong> tab.
            </p>
            <div v-if="sfxGenError" class="fetch-error">⚠ {{ sfxGenError }}</div>
          </div>

          <div class="fetch-controls">
            <div class="fetch-providers" role="group" aria-label="Search providers">
              <label v-for="p in visibleProviders" :key="p.provider" :class="['fetch-provider', { 'is-unconfigured': !p.configured }]">
                <input
                  type="checkbox"
                  :checked="enabledProviders[p.provider]"
                  :disabled="!p.configured"
                  @change="(e: any) => enabledProviders[p.provider] = e.target.checked"
                />
                <span>{{ p.name }}</span>
                <span v-if="!p.configured" class="text-muted text-xs">no key</span>
              </label>
            </div>
            <div class="fetch-search-row">
              <input
                v-model="fetchQuery"
                class="input"
                :placeholder="isAudioPool ? 'rain, footsteps, sci-fi whoosh, applause…' : 'ocean sunset, calm beach, slow motion clouds…'"
                @keydown.enter="runFetchSearch"
              />
              <select v-if="!isAudioPool" v-model="fetchQuality" class="select" title="Quality preference. Falls back to next-best when the requested isn't available. HD matches normalize target (1080p) — UHD costs bandwidth + storage with no render benefit.">
                <option value="hd">HD (1080p)</option>
                <option value="uhd">UHD (4K)</option>
                <option value="sd">SD</option>
              </select>
              <button
                class="btn btn-primary"
                :disabled="!canFetchSearch"
                @click="runFetchSearch"
              >
                <LoadingSpinner v-if="fetchLoading" size="sm" />
                {{ fetchLoading ? 'Searching…' : 'Search' }}
              </button>
            </div>
            <p v-if="!anyProviderConfigured && isAudioPool" class="fetch-hint text-warn">
              No SFX provider configured. Add a free <strong>Freesound</strong> API token under
              <strong>App Settings → API Keys</strong> to search Creative-Commons sound effects,
              or use <strong>Generate</strong> above (ElevenLabs) to make one from a text prompt.
            </p>
            <p v-else-if="!anyProviderConfigured" class="fetch-hint text-warn">
              No fetch providers configured. Add a Pexels or Pixabay API key under
              <strong>App Settings → API Keys</strong> (both free, no attribution required),
              or tick the <strong>NASA</strong> checkbox above for key-free public-domain
              video from NASA's Image &amp; Video Library.
            </p>
          </div>

          <div v-if="fetchError" class="fetch-error">⚠ {{ fetchError }}</div>

          <div v-if="fetchResults.length" class="fetch-summary">
            <span>{{ fetchResults.length }} result{{ fetchResults.length === 1 ? '' : 's' }} · {{ alreadyHaveCount }} already in pool · {{ selectedFetchCount }} selected</span>
            <div class="fetch-summary-actions">
              <button class="btn btn-secondary btn-sm" :disabled="!fetchResults.length" @click="toggleSelectAll">
                {{ allSelectableSelected ? 'Deselect all' : 'Select all new' }}
              </button>
              <button
                class="btn btn-primary btn-sm"
                :disabled="!selectedFetchCount || queueingFetch || !selectedPool?.online"
                :title="!selectedPool?.online ? 'Pool offline — plug in the SSD first' : ''"
                @click="queueSelectedFetches"
              >
                {{ queueingFetch ? 'Queuing…' : `Add ${selectedFetchCount} to pool` }}
              </button>
            </div>
          </div>

          <div v-if="fetchResults.length" class="fetch-grid">
            <article
              v-for="r in fetchResults"
              :key="`${r.provider}-${r.source_id}`"
              :class="['fetch-card', { 'is-already-have': r.already_have, 'is-selected': isFetchSelected(r) }]"
            >
              <label class="fetch-card-select">
                <input
                  type="checkbox"
                  :checked="isFetchSelected(r)"
                  :disabled="r.already_have"
                  @change="toggleFetchPick(r)"
                />
              </label>
              <div class="fetch-thumb-wrap">
                <!-- Audio results have no still — preview the CC-licensed
                     mp3 inline straight from the provider's CDN URL. -->
                <div v-if="isAudioPool" class="fetch-audio-wrap">
                  <audio
                    v-if="r.files[0]?.url"
                    controls
                    preload="none"
                    class="fetch-audio"
                    :src="r.files[0].url"
                  ></audio>
                  <div v-else class="clip-audio-offline">🔊 no preview</div>
                </div>
                <img v-else :src="r.thumbnail_url" :alt="`${r.provider} ${r.source_id}`" loading="lazy" class="fetch-thumb" />
                <span class="fetch-duration">{{ formatDuration(r.duration) }}</span>
                <span :class="['fetch-provider-pill', `source-${r.provider}`]">{{ r.provider }}</span>
                <span v-if="r.already_have" class="fetch-have-badge" title="A clip from this provider with this source_id is already in this pool.">✓ in pool</span>
              </div>
              <div class="fetch-card-body">
                <div class="fetch-card-meta text-muted text-xs">
                  <template v-if="isAudioPool">by {{ r.author || 'Unknown' }}</template>
                  <template v-else>{{ r.width }}×{{ r.height }} · by {{ r.author || 'Unknown' }}</template>
                </div>
                <div class="fetch-card-license text-muted text-xs">
                  <a :href="r.license_url" target="_blank" rel="noopener noreferrer">{{ r.license }}</a> ·
                  <a :href="r.source_url" target="_blank" rel="noopener noreferrer">view source ↗</a>
                </div>
              </div>
            </article>
          </div>

          <div v-else-if="!fetchLoading && fetchQuery && !fetchError" class="muted">
            No results. Try different keywords, or enable another provider above.
          </div>

          <div v-else-if="!fetchQuery && isAudioPool" class="empty">
            Type keywords above and hit <strong>Search</strong> to find free Creative-Commons sound
            effects on Freesound — or <strong>Generate</strong> a bespoke one with ElevenLabs.
            Clips already in this pool are flagged automatically.
          </div>

          <div v-else-if="!fetchQuery" class="empty">
            Type keywords above and hit <strong>Search</strong> to find free stock B-Roll on Pexels and Pixabay.
            Clips you've already added to this pool are flagged automatically — you can re-search the same
            terms next month and only pick the new ones.
          </div>
        </div><!-- /Fetch tab -->

        <!-- ── Asset Log tab ──────────────────────────────────────────── -->
        <div v-show="poolTab === 'log'">
          <div class="log-toolbar">
            <input
              v-model="logSearch"
              class="input log-search"
              placeholder="Filter by filename, source, author, keywords…"
            />
            <select v-model="logSourceFilter" class="select select-sm">
              <option value="all">All sources</option>
              <template v-if="isAudioPool">
                <option value="freesound">Freesound</option>
              </template>
              <template v-else>
                <option value="pexels">Pexels</option>
                <option value="pixabay">Pixabay</option>
                <option value="nasa">NASA</option>
              </template>
            </select>
            <button
              class="btn btn-sm btn-secondary"
              :disabled="!filteredLogRows.length"
              :title="'Download the filtered rows as CSV — handy if you need to share license attribution outside the app.'"
              @click="exportLogCsv"
            >
              ⬇ Export CSV
            </button>
          </div>

          <div v-if="!provenanceCount" class="empty">
            No fetched clips yet. Use the <strong>🔎 Fetch</strong> tab to pull stock clips into this pool —
            each one writes a provenance sidecar that shows up here with source, license, date, and the
            keywords that found it. Hand-added clips don't have provenance records.
          </div>

          <table v-else class="log-table">
            <thead>
              <tr>
                <th @click="setLogSort('filename')" :class="logSortClass('filename')">Filename</th>
                <th @click="setLogSort('source')" :class="logSortClass('source')">Source</th>
                <th @click="setLogSort('author')" :class="logSortClass('author')">Author</th>
                <th @click="setLogSort('fetched_at')" :class="logSortClass('fetched_at')">Fetched</th>
                <th>Keywords</th>
                <th>License</th>
                <th>Link</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in filteredLogRows" :key="row.filename">
                <td class="log-cell-filename" :title="row.filename">{{ row.filename }}</td>
                <td><span :class="['clip-source-pill', `source-${row.source}`]">{{ row.source }}</span></td>
                <td class="text-muted">{{ row.author || '—' }}</td>
                <td class="text-muted text-xs">{{ formatLocalDateTime(row.fetched_at) }}</td>
                <td class="log-cell-keywords">
                  <span v-for="(kw, i) in row.search_keywords" :key="i" class="log-keyword">{{ kw }}</span>
                </td>
                <td class="text-xs"><a :href="row.license_url" target="_blank" rel="noopener noreferrer">{{ row.license }}</a></td>
                <td class="text-xs"><a :href="row.source_url" target="_blank" rel="noopener noreferrer">view ↗</a></td>
              </tr>
              <tr v-if="!filteredLogRows.length">
                <td colspan="7" class="muted">No rows match the filter.</td>
              </tr>
            </tbody>
          </table>
        </div><!-- /Asset Log tab -->
      </section>
    </div>

    <!-- Create pool modal -->
    <div v-if="createModalOpen" class="modal-overlay" @click.self="createModalOpen = false">
      <div class="create-modal">
        <h3>Register a B-Roll pool</h3>
        <p class="text-muted text-sm">
          Point at the folder on your SSD that holds the clips. The app writes a small JSON sidecar
          inside the folder for tags + index — that file travels with the SSD across Macs.
        </p>
        <div class="form-group">
          <label>Pool name <span class="req">*</span></label>
          <input
            v-model="createDraft.name"
            class="input"
            placeholder="e.g. Prayer B-Roll, Nature stock, City timelapses"
            autofocus
          />
        </div>
        <div class="form-group">
          <label>Folder path <span class="req">*</span></label>
          <!-- v1.0.118+ — Browse… button wired to usePathPicker so the
               user gets a native folder dialog (Electron desktop) or the
               in-app FileBrowserModal (server mode) instead of having to
               hand-type the path. The .path-input-row wrapper was sitting
               here in the original markup waiting for the button — just
               needed the click handler + styles. -->
          <div class="path-input-row">
            <input
              v-model="createDraft.folder_path"
              class="input"
              placeholder="/Volumes/SSD/prayer-broll"
            />
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              :disabled="picking"
              @click="onBrowseFolder"
            >
              📁 {{ picking ? 'Opening…' : 'Browse…' }}
            </button>
          </div>
          <span class="hint">
            Click <strong>Browse…</strong> to pick the folder, or paste the full absolute path.
            Tip: open the folder in Finder, right-click → Get Info, copy the "Where:" value.
          </span>
        </div>
        <!-- v1.0.403 — pool media type. 'image' makes an Image Pool (slideshow). -->
        <div class="form-group">
          <label>Pool type</label>
          <div class="radio-row">
            <label><input type="radio" value="video" v-model="createDraft.media" /> 🎞 Video clips (B-Roll)</label>
            <label><input type="radio" value="image" v-model="createDraft.media" /> 🖼 Still images (slideshow)</label>
            <label><input type="radio" value="audio" v-model="createDraft.media" /> 🔊 Sound effects (SFX)</label>
          </div>
          <span class="hint">
            <strong>Still images</strong> = a pool of your own pictures, shown as a paced slideshow
            (configurable seconds each, randomized with cross-episode no-repeat, subtitles burned in).
            Naming doesn't matter — selection is random by content.
          </span>
        </div>

        <!-- Video-only: normalize controls -->
        <template v-if="createDraft.media === 'video'">
          <div class="form-group">
            <label>Normalize target fps</label>
            <div class="radio-row">
              <label><input type="radio" :value="24" v-model="createDraft.fps_target" /> 24 fps (cinematic, default)</label>
              <label><input type="radio" :value="30" v-model="createDraft.fps_target" /> 30 fps (YouTube-native)</label>
            </div>
          </div>
          <div class="form-group">
            <label>
              <input type="checkbox" v-model="createDraft.auto_normalize" />
              Auto-normalize new clips on import
            </label>
            <span class="hint">
              <strong>Off by default.</strong> When on, every newly-indexed clip gets a queued
              normalize job to re-encode to 1080p at the target fps. For a fresh 200-clip pool that's
              1–3&nbsp;hours of CPU + disk, so leaving this off and clicking
              <em>⚡&nbsp;Normalize all</em> on the pool when you're ready is usually the safer
              choice. The original files are never modified — normalized variants live alongside
              them in a <code>.broll-normalized/</code> sidecar folder.
            </span>
          </div>
        </template>

        <!-- Image-only: slideshow defaults (overridable per episode later) -->
        <template v-else>
          <div class="form-group">
            <label>Seconds per image (default)</label>
            <input type="number" min="1" max="60" step="1" class="input" v-model.number="createDraft.seconds_per_image" />
            <span class="hint">How long each image holds on screen. ~8s is a calm default; you can override per episode.</span>
          </div>
          <div class="form-group">
            <label>No-repeat window (episodes)</label>
            <input type="number" min="0" max="200" step="1" class="input" v-model.number="createDraft.dedup_lookback" />
            <span class="hint">Avoid reusing an image used within this many recent episodes. 20 = good variety across a long run. Stills are never normalized or re-encoded.</span>
          </div>
        </template>
        <div v-if="createError" class="create-error">⚠ {{ createError }}</div>
        <div class="modal-actions">
          <button class="btn btn-ghost" @click="createModalOpen = false">Cancel</button>
          <button
            class="btn btn-primary"
            :disabled="!createDraft.name.trim() || !createDraft.folder_path.trim() || creating"
            @click="submitCreate"
          >
            {{ creating ? 'Registering…' : 'Register pool' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ── Edit pool modal (v1.0.405) — rename + repoint folder ──────────── -->
    <div v-if="editModalOpen" class="modal-overlay" @click.self="editModalOpen = false">
      <div class="modal">
        <h3>Edit pool</h3>
        <div class="form-group">
          <label>Pool name <span class="req">*</span></label>
          <input v-model="editDraft.name" class="input" placeholder="Prayer images (DAS)" />
        </div>
        <div class="form-group">
          <label>Folder path <span class="req">*</span></label>
          <div class="path-input-row">
            <input v-model="editDraft.folder_path" class="input" placeholder="/Volumes/HDD-2TB/capi-images" />
            <button type="button" class="btn btn-secondary btn-sm" :disabled="picking" @click="onBrowseEditFolder">
              📁 {{ picking ? 'Opening…' : 'Browse…' }}
            </button>
          </div>
          <span class="hint">
            <strong>Repoint</strong> to a different folder if you moved the drive. The clip/image tags live
            <em>inside</em> the folder, so a moved-intact folder keeps its tags; an empty new folder starts
            fresh until you Re-scan. Files are never modified.
          </span>
        </div>
        <div v-if="editError" class="create-error">⚠ {{ editError }}</div>
        <div class="modal-actions">
          <button class="btn btn-ghost" @click="editModalOpen = false">Cancel</button>
          <button
            class="btn btn-primary"
            :disabled="!editDraft.name.trim() || !editDraft.folder_path.trim() || editing"
            @click="submitEdit"
          >
            {{ editing ? 'Saving…' : 'Save changes' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ── Rename (single clip) modal ────────────────────────────────────
         Lightweight: just a text input + Save. We re-validate client-side
         (extension required, no path separators) so the user gets immediate
         feedback before round-tripping the server. The backend re-validates
         too — never trust the client's check alone. -->
    <div v-if="renameOneOpen" class="modal-overlay" @click.self="closeRenameOne">
      <div class="create-modal">
        <h3>Rename clip</h3>
        <p class="text-muted text-sm">
          Renames the file on disk and updates the pool's sidecar in one step.
          Any matching <code>.broll-normalized/</code> variant follows automatically.
          <strong>Keep the file extension</strong> (e.g. <code>.mp4</code>) intact —
          ffmpeg uses it to pick the right demuxer.
        </p>
        <div class="form-group">
          <label>Current name</label>
          <input class="input" :value="renameOneOld" disabled />
        </div>
        <div class="form-group">
          <label>New name <span class="req">*</span></label>
          <input
            v-model="renameOneNew"
            class="input"
            :class="{ 'has-error': !!renameOneClientError }"
            autofocus
            @keyup.enter="submitRenameOne"
          />
          <span v-if="renameOneClientError" class="hint text-danger">⚠ {{ renameOneClientError }}</span>
        </div>
        <div v-if="renameOneError" class="create-error">⚠ {{ renameOneError }}</div>
        <div class="modal-actions">
          <button class="btn btn-ghost" :disabled="renameOneBusy" @click="closeRenameOne">Cancel</button>
          <button
            class="btn btn-primary"
            :disabled="renameOneBusy || !!renameOneClientError || !renameOneNew.trim() || renameOneNew.trim() === renameOneOld"
            @click="submitRenameOne"
          >
            {{ renameOneBusy ? 'Renaming…' : 'Rename' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ── Bulk rename modal ─────────────────────────────────────────────
         User picks a template; we render a live preview of the first N
         resulting names before any disk writes happen. Tokens documented
         inline so the user doesn't have to leave the modal to find the
         token reference. Errors are surfaced per-row after apply so the
         user can see exactly which renames collided. -->
    <div v-if="bulkRenameOpen" class="modal-overlay" @click.self="closeBulkRename">
      <div class="create-modal bulk-rename-modal">
        <h3>Bulk rename — {{ selectedPool?.name || 'pool' }}</h3>
        <p class="text-muted text-sm">
          Apply a naming template to every clip in this pool. Originals are
          renamed on disk and the sidecar follows. Files are processed in
          their current alphabetical order; the <code>{n}</code> counter
          starts at the value below.
        </p>
        <div class="form-group">
          <label>Template <span class="req">*</span></label>
          <input
            v-model="bulkRenameTemplate"
            class="input"
            placeholder="e.g. prayer_{n:3}.{ext}"
            :disabled="bulkRenameBusy"
          />
          <span class="hint">
            Tokens:
            <code>{n}</code> 1-based index ·
            <code>{n:3}</code> zero-padded width ·
            <code>{ext}</code> original extension ·
            <code>{orig}</code> original basename ·
            <code>{sha}</code> first 8 chars of content hash.
            Must end with a valid extension (literal <code>.mp4</code> or <code>.{ext}</code>).
          </span>
        </div>
        <div class="form-group">
          <label>Start index</label>
          <input
            v-model.number="bulkRenameStart"
            class="input"
            type="number"
            min="1"
            max="999999"
            style="max-width: 140px"
            :disabled="bulkRenameBusy"
          />
        </div>

        <!-- Live preview: show first 8 + a "+N more" footer. Faster than
             scrolling a 250-row preview and almost always enough to spot
             a template that's about to wipe out unique names (e.g. {n}.mp4
             collapses everything into 1.mp4 / 2.mp4 / 3.mp4 — visible at
             a glance). -->
        <div v-if="bulkRenamePreview.length" class="bulk-rename-preview">
          <div class="bulk-rename-preview-head">
            <strong>Preview</strong>
            <span class="text-muted text-xs">
              showing first {{ bulkRenamePreview.length }} of {{ clips.length }}
            </span>
          </div>
          <table class="bulk-rename-table">
            <thead>
              <tr>
                <th>Current</th>
                <th>→</th>
                <th>New</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in bulkRenamePreview" :key="row.old">
                <td class="bulk-rename-old">{{ row.old }}</td>
                <td class="bulk-rename-arrow">→</td>
                <td :class="['bulk-rename-new', { 'is-error': row.error, 'is-unchanged': row.unchanged }]">
                  <span v-if="row.error">⚠ {{ row.error }}</span>
                  <span v-else-if="row.unchanged">(unchanged)</span>
                  <span v-else>{{ row.next }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Apply summary after a run completes. -->
        <div v-if="bulkRenameResult" class="bulk-rename-result">
          <div>
            <strong>{{ bulkRenameResult.renamed }} renamed</strong>
            <span v-if="bulkRenameResult.skipped"> · {{ bulkRenameResult.skipped }} skipped</span>
            <span v-if="bulkRenameResult.errors" class="text-danger"> · {{ bulkRenameResult.errors }} errors</span>
          </div>
          <details v-if="bulkRenameResult.errors > 0" class="bulk-rename-errors">
            <summary>View {{ bulkRenameResult.errors }} error{{ bulkRenameResult.errors === 1 ? '' : 's' }}</summary>
            <ul>
              <li v-for="row in bulkRenameResult.errorRows" :key="row.old_filename">
                <code>{{ row.old_filename }}</code> → <code>{{ row.new_filename }}</code>: {{ row.detail }}
              </li>
            </ul>
          </details>
        </div>

        <div v-if="bulkRenameError" class="create-error">⚠ {{ bulkRenameError }}</div>
        <div class="modal-actions">
          <button class="btn btn-ghost" :disabled="bulkRenameBusy" @click="closeBulkRename">
            {{ bulkRenameResult ? 'Close' : 'Cancel' }}
          </button>
          <button
            class="btn btn-primary"
            :disabled="bulkRenameBusy || !bulkRenameTemplate.trim() || !clips.length"
            @click="submitBulkRename"
          >
            {{ bulkRenameBusy ? 'Renaming…' : bulkRenameResult ? 'Run again' : `Rename ${clips.length} clip${clips.length === 1 ? '' : 's'}` }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, reactive } from 'vue'
// v1.0.118+ — pickFolder() branches between Electron's native dialog
// and the in-app FileBrowserModal (server mode) so the same callsite
// works in both modes. Not auto-imported (it's a bare named export,
// not a useX composable) — needs explicit import.
import { pickFolder } from '~/composables/usePathPicker'

definePageMeta({ layout: 'dashboard' })
useAppTitle('B-Roll Library')

const broll = useBrollPools()
const { ask } = useConfirm()
const { success, error: showError } = useToast()

// v1.0.118+ — Folder-picker state for the Register pool modal. `picking`
// is true while the dialog is open so the Browse button shows a loading
// label and ignores double-clicks.
const picking = ref(false)
async function onBrowseFolder() {
  picking.value = true
  try {
    const picked = await pickFolder({
      title: 'Choose B-Roll pool folder',
      initial_path: createDraft.value.folder_path || undefined,
      button_label: 'Use this folder',
    })
    if (picked) createDraft.value.folder_path = picked
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Folder picker failed')
  } finally {
    picking.value = false
  }
}

// ── Edit pool (rename + repoint folder) — v1.0.405 ──────────────────────
const editModalOpen = ref(false)
const editing = ref(false)
const editError = ref('')
const editDraft = ref({ name: '', folder_path: '' })

function openEditModal(): void {
  if (!selectedPool.value) return
  editDraft.value = { name: selectedPool.value.name, folder_path: selectedPool.value.folder_path }
  editError.value = ''
  editModalOpen.value = true
}

async function onBrowseEditFolder() {
  picking.value = true
  try {
    const picked = await pickFolder({
      title: 'Repoint pool to folder',
      initial_path: editDraft.value.folder_path || undefined,
      button_label: 'Use this folder',
    })
    if (picked) editDraft.value.folder_path = picked
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Folder picker failed')
  } finally {
    picking.value = false
  }
}

async function submitEdit(): Promise<void> {
  if (!selectedPool.value) return
  editing.value = true
  editError.value = ''
  try {
    const repointed = editDraft.value.folder_path.trim() !== selectedPool.value.folder_path
    await broll.updatePool(selectedPool.value.id, {
      name: editDraft.value.name.trim(),
      folder_path: editDraft.value.folder_path.trim(),
    })
    editModalOpen.value = false
    success(repointed ? 'Pool updated — click ↻ Re-scan to index the new folder.' : 'Pool updated.')
  } catch (e: any) {
    editError.value = e?.data?.detail || e?.message || 'Failed to update pool'
  } finally {
    editing.value = false
  }
}

// Live app-level jobs (broll_normalize + broll_autotag). The standard
// /projects/:slug/jobs feed filters by project_slug, so app-level
// jobs (project_slug='_app_') never show there — this composable
// streams them separately. v1.0.91+.
const appJobs = useAppJobs()

const pools = broll.pools
const loading = broll.loading

const selectedPoolId = ref<string>('')
const selectedPool = computed(() => pools.value.find(p => p.id === selectedPoolId.value) || null)

// v1.0.405 — media filter so image / audio pools have a clear "tab".
const poolFilter = ref<'all' | 'video' | 'image' | 'audio'>('all')
const poolMediaOf = (p: { media?: 'video' | 'image' | 'audio' }) =>
  (p.media === 'image' ? 'image' : p.media === 'audio' ? 'audio' : 'video')
const videoPoolCount = computed(() => pools.value.filter(p => poolMediaOf(p) === 'video').length)
const imagePoolCount = computed(() => pools.value.filter(p => poolMediaOf(p) === 'image').length)
const audioPoolCount = computed(() => pools.value.filter(p => poolMediaOf(p) === 'audio').length)
const filteredPools = computed(() =>
  poolFilter.value === 'all' ? pools.value : pools.value.filter(p => poolMediaOf(p) === poolFilter.value),
)
// True when the selected pool holds audio (SFX) — drives the inline <audio>
// player + hides video-only controls (thumbnail, normalize, vision auto-tag).
const isAudioPool = computed(() => poolMediaOf(selectedPool.value || {}) === 'audio')

const clips = ref<any[]>([])
const clipsLoading = ref(false)
const scanning = ref(false)
const scanResult = ref<any | null>(null)
const normalizingAll = ref(false)

const unnormalizedCount = computed(() =>
  clips.value.filter(c => !c.normalized && !c.missing).length,
)
const untaggedCount = computed(() =>
  clips.value.filter(c => !c.missing && !(c.tags && c.tags.length)).length,
)
const autotagging = ref(false)

interface AutotagModelRow {
  id: string
  label: string
  provider: string
  available: boolean
  disabled_reason?: string | null
  supports_vision: boolean
}

// Use the shared model catalog so B-Roll sees the same cloud + local choices
// as every other LLM picker. Text-only models remain visible but disabled:
// they cannot inspect the cached thumbnail frame that auto-tagging requires.
const autotagModel = ref<string>('gpt-4o')
const autotagModels = ref<AutotagModelRow[]>([])
const autotagModelsLoading = ref(false)
const usableAutotagModels = computed(() => autotagModels.value.filter(isUsableAutotagModel))
const autotagModelGroups = computed(() => {
  const rows: Record<string, AutotagModelRow> = {}
  for (const model of autotagModels.value) rows[model.id] = model
  return groupModels(rows, (_id, model) => model.provider || 'other')
})

function isUsableAutotagModel(model: AutotagModelRow): boolean {
  return model.available && !model.disabled_reason && model.supports_vision
}

function autotagModelSuffix(model: AutotagModelRow): string {
  if (model.disabled_reason) return ' (unavailable)'
  if (!model.available) return model.provider === 'chatstudio' ? ' (offline)' : ' (no key)'
  if (!model.supports_vision) return ' (text-only)'
  if (model.provider === 'chatstudio') return ' (local · free)'
  return ''
}

function autotagModelTooltip(model: AutotagModelRow): string {
  if (model.disabled_reason) return model.disabled_reason
  if (!model.available) {
    return model.provider === 'chatstudio'
      ? 'Start Chat Studio and load this model.'
      : 'No API key configured for this provider.'
  }
  if (!model.supports_vision) {
    return model.provider === 'deepseek'
      ? 'DeepSeek is text-only and cannot inspect B-Roll images or video frames.'
      : 'This text-only model cannot inspect B-Roll images or video frames.'
  }
  return model.provider === 'chatstudio'
    ? 'Runs locally for free. The loaded model must support image input.'
    : 'Vision-capable cloud model.'
}

onMounted(async () => {
  try {
    const saved = window.localStorage.getItem('brollAutotagModel')
    if (saved) autotagModel.value = saved
  } catch { /* no storage */ }
  autotagModelsLoading.value = true
  try {
    autotagModels.value = await apiGet<AutotagModelRow[]>('/models')
    const selected = autotagModels.value.find(model => model.id === autotagModel.value)
    if (!selected || !isUsableAutotagModel(selected)) {
      autotagModel.value = usableAutotagModels.value[0]?.id || ''
    }
  } catch {
    autotagModels.value = []
  } finally {
    autotagModelsLoading.value = false
  }
})
watch(autotagModel, (v) => {
  try { window.localStorage.setItem('brollAutotagModel', v) } catch { /* no storage */ }
})

// ── Pool jobs panel + auto-refresh ────────────────────────────────────
const poolJobsExpanded = ref(true)

/**
 * Filter app-level jobs down to the ones relevant to THIS pool. Both
 * broll_normalize and broll_autotag stash the pool_id in their params
 * (and we also use episode_id=pool.id as a secondary handle so older
 * code that filters by episode still works). Show running + queued
 * always; show the last 6 done/error/cancelled for trail context.
 */
const visibleJobs = computed(() => {
  if (!selectedPoolId.value) return []
  const matchesPool = (j: any) =>
    j.type === 'broll_normalize' || j.type === 'broll_autotag'
      ? (j.params?.pool_id === selectedPoolId.value || j.episode_id === selectedPoolId.value)
      : false
  const active = appJobs.jobs.value.filter(j => matchesPool(j) && (j.status === 'queued' || j.status === 'running'))
  const recent = appJobs.jobs.value
    .filter(j => matchesPool(j) && (j.status === 'done' || j.status === 'error' || j.status === 'cancelled'))
    .slice(0, 6)
  return [...active, ...recent]
})
const activeJobsCount = computed(() =>
  visibleJobs.value.filter(j => j.status === 'queued' || j.status === 'running').length,
)

function jobBadge(job: any): string {
  if (job.status === 'queued')    return '… queued'
  if (job.status === 'running')   return job.type === 'broll_normalize' ? '⚡ normalizing' : '✨ tagging'
  if (job.status === 'done')      return '✓ done'
  if (job.status === 'error')     return '⚠ error'
  if (job.status === 'cancelled') return '○ cancelled'
  return job.status
}
function lastProgressLine(job: any): string {
  const lines = job.output_lines || []
  if (!lines.length) return ''
  // Prefer the most informative recent line: progress lines refresh in
  // place, so the latest one is the live indicator. For done jobs the
  // final line is "Done → …" which is the right summary.
  return String(lines[lines.length - 1]).slice(0, 180)
}
function relativeTime(iso?: string | null): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const diff = (Date.now() - d.getTime()) / 1000
    if (diff < 30) return 'just now'
    if (diff < 60) return `${Math.round(diff)}s ago`
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    return d.toLocaleDateString()
  } catch { return '' }
}

// Auto-refresh the clip grid when any normalize / autotag job for the
// selected pool transitions to done — the sidecar's normalized flag and
// tags array have just changed and the UI should reflect it without
// a manual ↻ click.
let unsubDone: (() => void) | null = null
onMounted(() => {
  unsubDone = appJobs.onJobDone((job: any) => {
    if (job.status !== 'done') return
    if (job.type !== 'broll_normalize' && job.type !== 'broll_autotag') return
    const poolId = job.params?.pool_id || job.episode_id
    if (poolId && poolId === selectedPoolId.value) {
      void refreshClipsAfterJob()
    }
  })
})
onBeforeUnmount(() => { if (unsubDone) unsubDone() })

async function refreshClipsAfterJob(): Promise<void> {
  if (!selectedPoolId.value) return
  try {
    const r = await broll.listClips(selectedPoolId.value)
    clips.value = r.clips
    // v1.0.122+: refresh provenance too so a freshly-fetched clip's
    // sidecar shows up in the Asset Log and hover tooltips without
    // requiring a tab toggle / page refresh.
    void loadProvenance()
  } catch { /* tolerate */ }
}

// ── v1.0.122+ Pool tab nav (Clips / Fetch / Asset Log) ──────────────────
// URL-synced via ?tab= so refresh + back/forward + deep links work.
// Same shape as ideas.vue / scripts.vue / image-prompts.vue.
const _route = useRoute()
const _router = useRouter()
const poolTab = ref<'clips' | 'fetch' | 'log'>(
  _route.query.tab === 'fetch' ? 'fetch'
    : _route.query.tab === 'log' ? 'log'
    : 'clips',
)
watch(() => _route.query.tab, (v) => {
  const next = v === 'fetch' ? 'fetch' : v === 'log' ? 'log' : 'clips'
  if (next !== poolTab.value) poolTab.value = next
})
watch(poolTab, (v) => {
  const cur = String(_route.query.tab || 'clips')
  if (cur === v) return
  _router.replace({ query: { ..._route.query, tab: v } })
  // Lazy-load tab content the first time the user opens it. This keeps
  // the initial pool-page render cheap (no provenance scan, no
  // providers probe) for the common case of just wanting to view clips.
  if (v === 'fetch') void loadProvidersOnce()
  if (v === 'log' || v === 'clips') void loadProvenanceOnce()
})

// ── v1.0.122+ Fetch state ───────────────────────────────────────────────
type FetchProviderId = 'pexels' | 'pixabay' | 'nasa' | 'freesound'
interface ConfiguredProvider {
  provider: FetchProviderId
  name: string
  configured: boolean
  /** Pool media this provider feeds — used to gate which providers show. */
  media: 'video' | 'image' | 'audio'
}
interface FetchResultUi {
  provider: FetchProviderId
  source_id: string
  source_url: string
  thumbnail_url: string
  duration: number
  width: number
  height: number
  author: string
  author_url?: string
  license: string
  license_url: string
  files: Array<{ quality: string; url: string; width: number; height: number }>
  tags?: string[]
  already_have: boolean
}
const { get: apiGet, post: apiPost } = useApi()

const providersState = ref<ConfiguredProvider[]>([])
const enabledProviders = reactive<Record<FetchProviderId, boolean>>({
  pexels: true,
  pixabay: true,
  // v1.0.136+ — NASA Image & Video Library (public domain, no API key).
  // Defaults OFF because most users searching "ocean sunset" want stock
  // footage, not space telescope archives — NASA's catalog is niche
  // (space, science, missions). Users who want it tick the checkbox.
  nasa: false,
  // Freesound — the lone SFX provider, so it's on by default for audio pools.
  freesound: true,
})
// Only providers matching the selected pool's media are shown/searched —
// Freesound for audio (SFX) pools, Pexels/Pixabay/NASA for video pools.
const visibleProviders = computed<ConfiguredProvider[]>(() => {
  const media = poolMediaOf(selectedPool.value || {})
  return providersState.value.filter(p => p.media === media)
})
const anyProviderConfigured = computed(() => visibleProviders.value.some(p => p.configured))
const fetchQuery = ref('')
const fetchQuality = ref<'hd' | 'uhd' | 'sd'>('hd')
const fetchResults = ref<FetchResultUi[]>([])
const fetchLoading = ref(false)
const fetchError = ref<string | null>(null)
const selectedFetchKeys = ref<Set<string>>(new Set())
const queueingFetch = ref(false)

// ── SFX generation (ElevenLabs sound-generation, audio pools only) ───────
const sfxPrompt = ref('')
const sfxDuration = ref<number | null>(null)
const sfxGenerating = ref(false)
const sfxGenError = ref<string | null>(null)

const canFetchSearch = computed(() => {
  if (fetchLoading.value) return false
  if (!fetchQuery.value.trim()) return false
  if (!anyProviderConfigured.value) return false
  // At least one enabled-AND-configured provider (matching this pool's
  // media) needs to be ticked.
  return visibleProviders.value.some(p => p.configured && enabledProviders[p.provider])
})

const alreadyHaveCount = computed(() => fetchResults.value.filter(r => r.already_have).length)
const selectedFetchCount = computed(() => selectedFetchKeys.value.size)
const allSelectableSelected = computed(() => {
  const selectable = fetchResults.value.filter(r => !r.already_have)
  if (selectable.length === 0) return false
  return selectable.every(r => selectedFetchKeys.value.has(fetchKey(r)))
})

function fetchKey(r: { provider: string; source_id: string }): string {
  return `${r.provider}::${r.source_id}`
}
function isFetchSelected(r: FetchResultUi): boolean {
  return selectedFetchKeys.value.has(fetchKey(r))
}
function toggleFetchPick(r: FetchResultUi): void {
  if (r.already_have) return
  const k = fetchKey(r)
  const next = new Set(selectedFetchKeys.value)
  if (next.has(k)) next.delete(k); else next.add(k)
  selectedFetchKeys.value = next
}
function toggleSelectAll(): void {
  if (allSelectableSelected.value) {
    selectedFetchKeys.value = new Set()
  } else {
    const next = new Set<string>()
    for (const r of fetchResults.value) {
      if (!r.already_have) next.add(fetchKey(r))
    }
    selectedFetchKeys.value = next
  }
}

let _providersLoaded = false
async function loadProvidersOnce(): Promise<void> {
  if (_providersLoaded) return
  try {
    const r = await apiGet<{ providers: ConfiguredProvider[] }>('/broll-fetch/providers')
    providersState.value = r.providers
    _providersLoaded = true
    // If only one provider is configured, leave both enabled by default
    // and let the search route ignore the un-keyed one. The "no key"
    // dimmed label is enough UX signal.
  } catch (e: any) {
    fetchError.value = e?.data?.detail || e?.message || 'Failed to load providers'
  }
}

async function runFetchSearch(): Promise<void> {
  if (!canFetchSearch.value) return
  const q = fetchQuery.value.trim()
  fetchLoading.value = true
  fetchError.value = null
  fetchResults.value = []
  selectedFetchKeys.value = new Set()
  try {
    // Fan out to enabled+configured providers (matching pool media) in parallel.
    const providers = visibleProviders.value
      .filter(p => p.configured && enabledProviders[p.provider])
      .map(p => p.provider)
    const responses = await Promise.allSettled(
      providers.map(prov => apiGet<{ provider: string; results: FetchResultUi[] }>(
        `/broll-fetch/search?provider=${prov}&q=${encodeURIComponent(q)}&pool_id=${encodeURIComponent(selectedPoolId.value)}&per_page=20`,
      )),
    )
    const collected: FetchResultUi[] = []
    const errs: string[] = []
    for (let i = 0; i < responses.length; i++) {
      const res = responses[i]
      if (res?.status === 'fulfilled') {
        collected.push(...(res.value.results || []))
      } else if (res?.status === 'rejected') {
        const msg = res.reason?.data?.detail || res.reason?.message || 'Search failed'
        errs.push(`${providers[i]}: ${msg}`)
      }
    }
    fetchResults.value = collected
    if (errs.length && collected.length === 0) {
      // All providers failed — surface the union.
      fetchError.value = errs.join(' · ')
    } else if (errs.length) {
      // Partial failure — show a non-blocking hint via toast so the
      // user can act on what did come back.
      showError(`Partial search failure: ${errs.join(' · ')}`)
    }
  } catch (e: any) {
    fetchError.value = e?.data?.detail || e?.message || 'Search failed'
  } finally {
    fetchLoading.value = false
  }
}

async function queueSelectedFetches(): Promise<void> {
  if (!selectedFetchCount.value || !selectedPool.value) return
  queueingFetch.value = true
  try {
    // Group picks by provider so the backend gets one request per
    // provider with its full result list — fewer roundtrips than per-
    // clip POSTs, and the queue dedupe runs once per call. Built
    // dynamically so every provider (incl. nasa / freesound) is covered.
    const byProvider: Record<string, FetchResultUi[]> = {}
    for (const r of fetchResults.value) {
      if (!selectedFetchKeys.value.has(fetchKey(r))) continue
      if (r.already_have) continue
      ;(byProvider[r.provider] ??= []).push(r)
    }
    let totalQueued = 0
    for (const [provider, results] of Object.entries(byProvider)) {
      if (!results.length) continue
      const resp = await apiPost<{ queued: number; skipped: number }>(
        `/broll-pools/${selectedPoolId.value}/fetch`,
        {
          provider,
          results,
          search_keywords: fetchQuery.value.trim().split(/\s+/).filter(Boolean),
          quality: fetchQuality.value,
        },
      )
      totalQueued += resp.queued
    }
    if (totalQueued > 0) {
      success(`Queued ${totalQueued} fetch job${totalQueued === 1 ? '' : 's'}. Watch the Pool jobs panel under Clips for progress.`)
      // Clear selection — but keep results visible so the user can see
      // their picks have flipped to "in pool" once jobs finish + a
      // refresh fires.
      selectedFetchKeys.value = new Set()
      // Optimistically mark them as already-have so the UI updates
      // immediately; the next provenance refresh confirms.
      for (const r of fetchResults.value) {
        if (byProvider[r.provider]?.includes(r)) {
          r.already_have = true
        }
      }
    } else {
      showError('No jobs queued — every pick was already in the pool.')
    }
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to queue fetch')
  } finally {
    queueingFetch.value = false
  }
}

async function generateSfx(): Promise<void> {
  const text = sfxPrompt.value.trim()
  if (!text || sfxGenerating.value || !selectedPoolId.value) return
  sfxGenerating.value = true
  sfxGenError.value = null
  try {
    const body: { text: string; duration_seconds?: number } = { text }
    if (typeof sfxDuration.value === 'number' && sfxDuration.value > 0) {
      body.duration_seconds = sfxDuration.value
    }
    const resp = await apiPost<{ ok: boolean; filename: string }>(
      `/broll-pools/${selectedPoolId.value}/generate-sfx`,
      body,
    )
    success(`Generated ${resp.filename} — added to pool.`)
    sfxPrompt.value = ''
    sfxDuration.value = null
    // The route already re-scanned server-side; refresh the grid + provenance
    // so the new clip shows up immediately under the Clips tab.
    const fresh = await broll.listClips(selectedPoolId.value)
    clips.value = fresh.clips
    void loadProvenance()
  } catch (e: any) {
    sfxGenError.value = e?.data?.detail || e?.message || 'Failed to generate sound effect'
  } finally {
    sfxGenerating.value = false
  }
}

// ── v1.0.122+ Provenance state ──────────────────────────────────────────
interface ProvenanceRow {
  filename: string
  source: FetchProviderId
  source_id: string
  source_url: string
  author: string
  author_url?: string
  license: string
  license_url: string
  fetched_at: string
  search_keywords: string[]
  downloaded_width: number
  downloaded_height: number
  source_width: number
  source_height: number
  duration: number
}
const provenance = ref<ProvenanceRow[]>([])
const provenanceMap = computed<Record<string, ProvenanceRow>>(() => {
  const out: Record<string, ProvenanceRow> = {}
  for (const r of provenance.value) out[r.filename] = r
  return out
})
const provenanceCount = computed(() => provenance.value.length)
function provenanceFor(filename: string): ProvenanceRow | null {
  return provenanceMap.value[filename] || null
}
function provenanceTooltip(filename: string): string {
  const p = provenanceMap.value[filename]
  if (!p) return ''
  const lines = [
    `${p.source} #${p.source_id}`,
    `by ${p.author || 'Unknown'}`,
    `License: ${p.license}`,
    `Fetched: ${formatLocalDateTime(p.fetched_at)}`,
  ]
  if (p.search_keywords.length) lines.push(`Keywords: ${p.search_keywords.join(', ')}`)
  return lines.join('\n')
}

let _provenanceLoadedFor = ''
async function loadProvenance(): Promise<void> {
  if (!selectedPoolId.value) {
    provenance.value = []
    return
  }
  try {
    const r = await apiGet<{ records: ProvenanceRow[] }>(`/broll-pools/${selectedPoolId.value}/provenance`)
    provenance.value = r.records || []
    _provenanceLoadedFor = selectedPoolId.value
  } catch {
    // Provenance is best-effort UX — never block the page on a load failure.
    provenance.value = []
  }
}
async function loadProvenanceOnce(): Promise<void> {
  if (_provenanceLoadedFor === selectedPoolId.value && provenance.value.length) return
  await loadProvenance()
}

// Refresh provenance whenever the selected pool changes.
watch(selectedPoolId, () => { void loadProvenance() }, { immediate: false })

// ── v1.0.122+ Asset Log filtering + sorting ─────────────────────────────
const logSearch = ref('')
const logSourceFilter = ref<'all' | FetchProviderId>('all')
const logSort = ref<{ key: 'filename' | 'source' | 'author' | 'fetched_at'; dir: 'asc' | 'desc' }>({ key: 'fetched_at', dir: 'desc' })
function setLogSort(key: 'filename' | 'source' | 'author' | 'fetched_at'): void {
  if (logSort.value.key === key) {
    logSort.value.dir = logSort.value.dir === 'asc' ? 'desc' : 'asc'
  } else {
    logSort.value = { key, dir: key === 'fetched_at' ? 'desc' : 'asc' }
  }
}
function logSortClass(key: 'filename' | 'source' | 'author' | 'fetched_at'): string {
  return logSort.value.key === key ? `is-sort-${logSort.value.dir}` : 'sortable'
}
const filteredLogRows = computed<ProvenanceRow[]>(() => {
  const q = logSearch.value.trim().toLowerCase()
  let rows = provenance.value
  if (logSourceFilter.value !== 'all') rows = rows.filter(r => r.source === logSourceFilter.value)
  if (q) {
    rows = rows.filter(r =>
      r.filename.toLowerCase().includes(q)
      || r.source.toLowerCase().includes(q)
      || (r.author || '').toLowerCase().includes(q)
      || r.search_keywords.some(kw => kw.toLowerCase().includes(q)),
    )
  }
  const { key, dir } = logSort.value
  const mul = dir === 'asc' ? 1 : -1
  rows = [...rows].sort((a, b) => {
    const av = (a as any)[key] ?? ''
    const bv = (b as any)[key] ?? ''
    return av < bv ? -1 * mul : av > bv ? 1 * mul : 0
  })
  return rows
})

function exportLogCsv(): void {
  const rows = filteredLogRows.value
  if (!rows.length) return
  const headers = ['filename', 'source', 'source_id', 'author', 'license', 'license_url', 'fetched_at', 'keywords', 'source_url', 'downloaded_resolution', 'duration_sec']
  const csv = [
    headers.join(','),
    ...rows.map(r => [
      csvCell(r.filename),
      csvCell(r.source),
      csvCell(r.source_id),
      csvCell(r.author),
      csvCell(r.license),
      csvCell(r.license_url),
      csvCell(r.fetched_at),
      csvCell(r.search_keywords.join('; ')),
      csvCell(r.source_url),
      csvCell(`${r.downloaded_width}x${r.downloaded_height}`),
      csvCell(String(r.duration)),
    ].join(',')),
  ].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `broll-assets-${selectedPool.value?.name || 'pool'}-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
function csvCell(v: string): string {
  // Quote if contains comma, quote, or newline. Escape inner quotes.
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}
function formatLocalDateTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return iso
  }
}

// ── Pool selection ─────────────────────────────────────────────────────

async function loadAndSelect(): Promise<void> {
  await broll.loadPools()
  if (!selectedPoolId.value && pools.value.length) {
    selectedPoolId.value = pools.value[0]!.id
  }
}

async function selectPool(id: string): Promise<void> {
  selectedPoolId.value = id
}

watch(selectedPoolId, async (id) => {
  if (!id) return
  scanResult.value = null
  clipsLoading.value = true
  try {
    const r = await broll.listClips(id)
    clips.value = r.clips
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to load clips')
    clips.value = []
  } finally {
    clipsLoading.value = false
  }
}, { immediate: false })

watch(() => null, loadAndSelect, { immediate: true })

// ── Scan / normalize ──────────────────────────────────────────────────

async function runScan(): Promise<void> {
  if (!selectedPoolId.value || scanning.value) return
  scanning.value = true
  scanResult.value = null
  try {
    const r = await broll.scanPool(selectedPoolId.value)
    scanResult.value = r
    // Refresh the clip grid so newly-indexed clips show up.
    const fresh = await broll.listClips(selectedPoolId.value)
    clips.value = fresh.clips
    success(`Scan complete — +${r.added.length} new, ${r.updated.length} updated`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Scan failed')
  } finally {
    scanning.value = false
  }
}

async function runNormalizeAll(): Promise<void> {
  if (!selectedPoolId.value || normalizingAll.value) return
  normalizingAll.value = true
  try {
    const r = await broll.normalizeAll(selectedPoolId.value)
    success(`Queued ${r.queued} normalize job(s). Watch progress in the Jobs panel.`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to queue normalize')
  } finally {
    normalizingAll.value = false
  }
}

async function normalizeOne(filename: string): Promise<void> {
  if (!selectedPoolId.value) return
  try {
    await broll.normalizeClip(selectedPoolId.value, filename)
    success(`Queued normalize for ${filename}`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to queue normalize')
  }
}

async function autotagOne(filename: string): Promise<void> {
  if (!selectedPoolId.value) return
  try {
    await broll.autotagClip(selectedPoolId.value, filename, { model: autotagModel.value || undefined })
    success(`Queued auto-tag for ${filename}`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to queue auto-tag')
  }
}

async function runAutotagUntagged(): Promise<void> {
  if (!selectedPoolId.value || autotagging.value) return
  autotagging.value = true
  try {
    const r = await broll.autotagUntagged(selectedPoolId.value, { model: autotagModel.value || undefined })
    success(`Queued ${r.queued} auto-tag job(s) (${r.total_targets} candidate clips).`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to queue bulk auto-tag')
  } finally {
    autotagging.value = false
  }
}

async function toggleAutoNormalize(): Promise<void> {
  if (!selectedPool.value) return
  try {
    await broll.updatePool(selectedPool.value.id, {
      auto_normalize: !selectedPool.value.auto_normalize,
    })
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Update failed')
  }
}

async function confirmDeletePool(): Promise<void> {
  if (!selectedPool.value) return
  const ok = await ask({
    title: `Unregister pool "${selectedPool.value.name}"?`,
    body: 'Removes the pool from the app registry. Clip files and the on-folder sidecar JSON stay on disk — you can re-register the same folder later and tags will be intact.',
    confirmLabel: 'Unregister',
    danger: true,
  })
  if (!ok) return
  try {
    await broll.deletePool(selectedPool.value.id)
    selectedPoolId.value = pools.value[0]?.id || ''
    success('Pool unregistered')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Delete failed')
  }
}

// ── Clip tags ─────────────────────────────────────────────────────────

async function saveTags(filename: string, tags: string[]): Promise<void> {
  if (!selectedPoolId.value) return
  try {
    const updated = await broll.setClipTags(selectedPoolId.value, filename, tags)
    const idx = clips.value.findIndex(c => c.filename === filename)
    if (idx >= 0) clips.value[idx] = updated
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save tags')
  }
}

// ── Rename: single clip ───────────────────────────────────────────────
//
// Per-clip rename is the "I want to fix THIS one name" surface. Bulk
// rename below handles "I want to apply a template to the whole pool".
// Both ultimately call the same renameClip helper one row at a time —
// keeps the disk writes serial so two simultaneous renames can't race
// on the sidecar file.

const renameOneOpen = ref(false)
const renameOneOld = ref('')
const renameOneNew = ref('')
const renameOneBusy = ref(false)
const renameOneError = ref('')

// Mirrors the server's isValidFilename — runs client-side so the user
// gets feedback while typing. The server re-validates so this is purely
// a UX nicety; if the regex here drifts from the server it just means
// fewer pre-flight catches, never a wrong save.
function validateNewFilename(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return 'Name is required'
  if (trimmed.length > 200) return 'Name is too long (200 char limit)'
  if (trimmed.includes('/') || trimmed.includes('\\')) return 'No path separators allowed'
  if (trimmed.startsWith('.')) return 'Leading dot is reserved for hidden files'
  const dot = trimmed.lastIndexOf('.')
  if (dot <= 0 || dot === trimmed.length - 1) return 'Include a file extension (e.g. .mp4)'
  if (!/^[A-Za-z0-9._\- ()\[\]+&#'%@$~,;!=]+$/.test(trimmed)) {
    return 'Name contains unsupported characters'
  }
  return ''
}

const renameOneClientError = computed(() =>
  renameOneNew.value && renameOneNew.value !== renameOneOld.value
    ? validateNewFilename(renameOneNew.value)
    : '',
)

function openRenameOne(filename: string): void {
  renameOneOld.value = filename
  renameOneNew.value = filename
  renameOneError.value = ''
  renameOneOpen.value = true
}

function closeRenameOne(): void {
  if (renameOneBusy.value) return
  renameOneOpen.value = false
  renameOneOld.value = ''
  renameOneNew.value = ''
  renameOneError.value = ''
}

async function submitRenameOne(): Promise<void> {
  if (!selectedPoolId.value) return
  const next = renameOneNew.value.trim()
  if (!next || next === renameOneOld.value) return
  const err = validateNewFilename(next)
  if (err) { renameOneError.value = err; return }
  renameOneBusy.value = true
  renameOneError.value = ''
  try {
    const updated = await broll.renameClip(selectedPoolId.value, renameOneOld.value, next)
    const idx = clips.value.findIndex(c => c.filename === renameOneOld.value)
    if (idx >= 0) clips.value[idx] = updated
    success(`Renamed → ${updated.filename}`)
    renameOneOpen.value = false
    renameOneOld.value = ''
    renameOneNew.value = ''
  } catch (e: any) {
    renameOneError.value = e?.data?.detail || e?.message || 'Failed to rename'
  } finally {
    renameOneBusy.value = false
  }
}

// ── Rename: bulk ──────────────────────────────────────────────────────
//
// The bulk dialog is intentionally template-driven rather than free-form
// per-row editing: 250 input fields in a modal is a UX trap (you forget
// what row you're on, can't compare originals, can't see the pattern at
// a glance). A template + preview surfaces "what will this look like"
// before any disk writes happen.

const bulkRenameOpen = ref(false)
const bulkRenameTemplate = ref('clip_{n:3}.{ext}')
const bulkRenameStart = ref(1)
const bulkRenameBusy = ref(false)
const bulkRenameError = ref('')

interface BulkRenameRow {
  old_filename: string
  new_filename: string
  status: 'renamed' | 'skipped' | 'error'
  detail?: string
}
interface BulkRenameResult {
  renamed: number
  skipped: number
  errors: number
  errorRows: BulkRenameRow[]
}
const bulkRenameResult = ref<BulkRenameResult | null>(null)

function openBulkRename(): void {
  bulkRenameOpen.value = true
  bulkRenameError.value = ''
  bulkRenameResult.value = null
  // Don't reset the template — users will often run multiple batches with
  // tweaks (e.g. start index 1 batch, then 50, then 100), and re-typing
  // the template every time is annoying.
}

function closeBulkRename(): void {
  if (bulkRenameBusy.value) return
  bulkRenameOpen.value = false
}

// Compute the preview client-side using the same template grammar the
// backend implements (kept in sync via comments — if you change one,
// change the other). Capped at 8 rows so the modal doesn't balloon
// vertically on a 250-clip pool.
const bulkRenamePreview = computed<Array<{ old: string; next: string; error: string; unchanged: boolean }>>(() => {
  const template = bulkRenameTemplate.value
  if (!template) return []
  const rows: Array<{ old: string; next: string; error: string; unchanged: boolean }> = []
  const sorted = [...clips.value].sort((a, b) => a.filename.localeCompare(b.filename))
  let i = 0
  for (const clip of sorted.slice(0, 8)) {
    const idx = bulkRenameStart.value + i
    i++
    let next = template
    const dot = clip.filename.lastIndexOf('.')
    const origBase = dot > 0 ? clip.filename.slice(0, dot) : clip.filename
    const origExt = dot > 0 ? clip.filename.slice(dot + 1) : ''
    next = next.replace(/\{n:(\d+)\}/g, (_: string, w: string) => String(idx).padStart(Number(w), '0'))
    next = next.replace(/\{n\}/g, String(idx))
    next = next.replace(/\{ext\}/g, origExt)
    next = next.replace(/\{orig\}/g, origBase)
    next = next.replace(/\{sha\}/g, String(clip.sha256 || '').slice(0, 8))
    const error = next === clip.filename ? '' : validateNewFilename(next)
    rows.push({
      old: clip.filename,
      next,
      error,
      unchanged: next === clip.filename,
    })
  }
  return rows
})

async function submitBulkRename(): Promise<void> {
  if (!selectedPoolId.value) return
  const template = bulkRenameTemplate.value.trim()
  if (!template) return
  bulkRenameBusy.value = true
  bulkRenameError.value = ''
  bulkRenameResult.value = null
  try {
    // Sort by filename to guarantee deterministic indexing — same order as
    // the preview so what the user saw matches what runs.
    const filenames = [...clips.value]
      .sort((a, b) => a.filename.localeCompare(b.filename))
      .map(c => c.filename)
    const { rows } = await broll.renameClipsBulk(
      selectedPoolId.value,
      template,
      filenames,
      { start_index: bulkRenameStart.value },
    )
    const renamed = rows.filter(r => r.status === 'renamed').length
    const skipped = rows.filter(r => r.status === 'skipped').length
    const errorRows = rows.filter(r => r.status === 'error')
    bulkRenameResult.value = {
      renamed,
      skipped,
      errors: errorRows.length,
      errorRows,
    }
    if (renamed > 0) {
      // Re-fetch the clip grid so the renamed names + sidecar state
      // show up. The sidecar entries are keyed by the new filename, so
      // a fresh listClips call is the cleanest re-sync path.
      await refreshClipsAfterJob()
      success(`Renamed ${renamed} clip${renamed === 1 ? '' : 's'}${errorRows.length ? ` · ${errorRows.length} error${errorRows.length === 1 ? '' : 's'}` : ''}`)
    } else if (errorRows.length) {
      showError(`Bulk rename failed — see ${errorRows.length} error${errorRows.length === 1 ? '' : 's'} in the dialog`)
    } else {
      success('No changes — every clip already matches the template')
    }
  } catch (e: any) {
    bulkRenameError.value = e?.data?.detail || e?.message || 'Bulk rename failed'
  } finally {
    bulkRenameBusy.value = false
  }
}

// ── Create modal ──────────────────────────────────────────────────────

const createModalOpen = ref(false)
const createDraft = ref({
  name: '',
  folder_path: '',
  fps_target: 24 as 24 | 30,
  // v1.0.92+ — default OFF. Auto-normalize kicks off a long ffmpeg
  // re-encode queue (can be hours for a 200-clip pool on an external
  // drive). User opts in explicitly via the "⚡ Normalize all" button.
  auto_normalize: false,
  // v1.0.403 — Image Pool (slideshow) support.
  media: 'video' as 'video' | 'image' | 'audio',
  seconds_per_image: 8,
  dedup_lookback: 20,
})
const creating = ref(false)
const createError = ref('')

function openCreateModal(): void {
  createDraft.value = { name: '', folder_path: '', fps_target: 24, auto_normalize: false, media: 'video', seconds_per_image: 8, dedup_lookback: 20 }
  createError.value = ''
  createModalOpen.value = true
}

async function submitCreate(): Promise<void> {
  creating.value = true
  createError.value = ''
  try {
    const isImage = createDraft.value.media === 'image'
    const created = await broll.createPool({
      name: createDraft.value.name.trim(),
      folder_path: createDraft.value.folder_path.trim(),
      fps_target: createDraft.value.fps_target,
      auto_normalize: createDraft.value.auto_normalize,
      media: createDraft.value.media,
      ...(isImage ? { slideshow: {
        seconds_per_image: Math.max(1, Number(createDraft.value.seconds_per_image) || 8),
        dedup_lookback: Math.max(0, Number(createDraft.value.dedup_lookback) || 20),
      } } : {}),
    })
    createModalOpen.value = false
    selectedPoolId.value = created.id
    success(`Pool "${created.name}" registered. Click Re-scan to index clips.`)
  } catch (e: any) {
    createError.value = e?.data?.detail || e?.message || 'Failed to register pool'
  } finally {
    creating.value = false
  }
}

// ── URL + format helpers ──────────────────────────────────────────────

function thumbnailUrl(poolId: string, filename: string): string {
  return broll.thumbnailUrl(poolId, filename)
}

function audioUrl(poolId: string, filename: string): string {
  return broll.audioUrl(poolId, filename)
}

function formatDuration(sec: number): string {
  if (!sec) return ''
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}

function formatBytes(bytes: number): string {
  if (!bytes) return ''
  const mb = bytes / 1024 / 1024
  return mb < 1 ? `${Math.round(bytes / 1024)} KB` : `${mb.toFixed(1)} MB`
}

function onThumbError(e: Event): void {
  // Thumbnail not yet generated — leave the broken-image placeholder
  // intact; the user can re-scan to regenerate.
  (e.target as HTMLImageElement).style.opacity = '0.3'
}
</script>

<style scoped>
.broll-page { display: flex; flex-direction: column; gap: 16px; padding: 8px 0; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.page-header h1 { margin: 0 0 4px; font-size: 20px; }
.page-header .text-muted { font-size: 12px; line-height: 1.5; max-width: 720px; }
.empty { padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px; background: var(--bg-secondary); border-radius: 6px; }

.broll-layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 16px;
}

.pool-rail { display: flex; flex-direction: column; gap: 8px; }
.pool-card {
  text-align: left;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 6px);
  cursor: pointer;
  font: inherit;
  color: inherit;
}
.pool-card:hover { border-color: var(--accent, #6c8fff); }
/* v1.0.405 — pool media filter (All / Video / Images / SFX).
   2×2 grid: four nowrap buttons can't fit one row inside the 240px rail, and a
   flex row let them overflow rightward over the pool-main header (the "Prayer
   B-roll" <h2>). The grid keeps them contained; min-width:0 lets a long label
   ellipsize inside its cell instead of spilling out. */
.pool-filter { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 8px; }
.pool-filter-btn {
  padding: 5px 6px; font-size: 11.5px; cursor: pointer;
  border: 1px solid var(--border); border-radius: var(--radius-sm, 6px);
  background: transparent; color: var(--text-secondary); white-space: nowrap;
  min-width: 0; overflow: hidden; text-overflow: ellipsis;
}
.pool-filter-btn:hover { color: var(--text-primary); }
.pool-filter-btn.active { background: var(--accent, #6c8fff); color: #fff; border-color: var(--accent, #6c8fff); }
.pool-filter-empty { font-size: 12px; padding: 8px 2px; }
.link-btn { background: none; border: 0; padding: 0; color: var(--accent, #6c8fff); cursor: pointer; font: inherit; text-decoration: underline; }
/* v1.0.406 — compact vision-model picker in the autotag toolbar. */
.autotag-model-select { max-width: 230px; font-size: 12px; }
.pool-card.active { border-color: var(--accent, #6c8fff); background: rgba(108,143,255,0.06); }
.pool-card-name { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
.pool-card-meta { display: flex; justify-content: space-between; align-items: center; gap: 6px; font-size: 11px; margin-bottom: 4px; }
.pool-online.is-online { color: rgb(34, 197, 94); }
.pool-online.is-offline { color: var(--text-muted); }
.pool-card-path { font-family: var(--font-mono, monospace); font-size: 10px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.pool-main { display: flex; flex-direction: column; gap: 12px; }
.pool-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.pool-header h2 { margin: 0 0 4px; font-size: 16px; }
.pool-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.btn.danger { color: var(--error, #e25c5c); }
.btn.danger:hover { background: rgba(226, 92, 92, 0.08); }

.offline-banner {
  padding: 10px 14px;
  background: rgba(245, 158, 11, 0.10);
  border: 1px solid rgba(245, 158, 11, 0.30);
  color: rgb(180, 120, 8);
  border-radius: 4px;
  font-size: 12px;
}
.offline-banner code { background: rgba(0,0,0,0.10); padding: 1px 5px; border-radius: 3px; font-family: var(--font-mono, monospace); }

.scan-result {
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-primary);
}
.text-warn { color: rgb(180, 120, 8); }
.text-danger { color: var(--error, #e25c5c); }

.clip-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}
.clip-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 6px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.clip-card.is-missing { opacity: 0.55; }
.clip-thumb-wrap {
  position: relative;
  aspect-ratio: 16 / 9;
  background: var(--bg-tertiary);
}
.clip-thumb { width: 100%; height: 100%; object-fit: cover; display: block; }
/* Audio (SFX) pools: an inline player instead of a thumbnail. */
.clip-audio-wrap { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; padding: 8px; }
.clip-audio { width: 100%; height: 36px; }
.clip-audio-offline { color: var(--text-muted); font-size: 12px; }
.clip-duration {
  position: absolute; bottom: 6px; right: 6px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-family: var(--font-mono, monospace);
}
.clip-normalized {
  position: absolute; top: 6px; right: 6px;
  background: rgba(34, 197, 94, 0.85);
  color: #fff;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 600;
}
.clip-missing-badge {
  position: absolute; top: 6px; left: 6px;
  background: rgba(226, 92, 92, 0.85);
  color: #fff;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 600;
}
.clip-body { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.clip-filename {
  font-size: 12px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.clip-actions { display: flex; gap: 4px; }

/* Create modal */
.modal-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center;
  z-index: 200; padding: 24px;
}
.create-modal {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 18px 22px;
  width: min(560px, 96vw);
  display: flex; flex-direction: column; gap: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.25);
}
.create-modal h3 { margin: 0; font-size: 16px; }
.form-group { display: flex; flex-direction: column; gap: 4px; }
.form-group label { font-size: 12px; color: var(--text-primary); }
.form-group .hint { font-size: 11px; color: var(--text-muted); line-height: 1.4; }
.req { color: var(--error, #e25c5c); font-weight: bold; }

/* v1.0.118+ — Input + Browse button row inside the Register pool modal.
   The input grows; the button sits flush on the right with a fixed
   intrinsic size. align-items keeps the button height matched to the
   input so they share a baseline. */
.path-input-row { display: flex; gap: 6px; align-items: stretch; }
.path-input-row .input { flex: 1; min-width: 0; }
.path-input-row .btn { flex: 0 0 auto; white-space: nowrap; }
.radio-row { display: flex; gap: 16px; font-size: 12px; }
.create-error {
  padding: 6px 10px;
  background: rgba(226, 92, 92, 0.10);
  color: var(--error, #e25c5c);
  border-radius: 4px;
  font-size: 12px;
}
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }

/* ── Pool jobs panel ──────────────────────────────────────────────────
   Inline panel that surfaces app-level B-Roll jobs (normalize / autotag)
   for the active pool. SSE-driven via useAppJobs; collapsible. */
.pool-jobs {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 6px);
  overflow: hidden;
}
.pool-jobs-header {
  width: 100%;
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border: none; cursor: pointer;
  font: inherit; color: inherit;
  font-size: 12px;
}
.pool-jobs-header:hover { background: var(--bg-hover, var(--bg-tertiary)); }
.pool-jobs-title { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.pool-jobs-stats {
  font-weight: 400; font-size: 11px; color: var(--text-muted);
  padding: 1px 6px; border-radius: 8px; background: var(--bg-secondary);
}
.pool-jobs-list {
  display: flex; flex-direction: column;
  max-height: 320px; overflow-y: auto;
}
.pool-job-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}
.pool-job-badge {
  flex: 0 0 auto;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-family: var(--font-mono, monospace);
  font-weight: 600;
}
.pool-job-row.is-running .pool-job-badge { background: rgba(108, 143, 255, 0.16); color: var(--accent, #6c8fff); }
.pool-job-row.is-queued .pool-job-badge { background: var(--bg-tertiary); color: var(--text-muted); }
.pool-job-row.is-done .pool-job-badge { background: rgba(34, 197, 94, 0.16); color: rgb(21, 128, 61); }
.pool-job-row.is-error .pool-job-badge { background: rgba(220, 38, 38, 0.16); color: rgb(185, 28, 28); }
.pool-job-row.is-cancelled .pool-job-badge { background: var(--bg-tertiary); color: var(--text-muted); }
.pool-job-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pool-job-title {
  font-weight: 500; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pool-job-progress {
  font-family: var(--font-mono, monospace);
  font-size: 11px; color: var(--text-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pool-job-error {
  font-size: 11px; color: rgb(185, 28, 28);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pool-job-when {
  flex: 0 0 auto;
  font-size: 11px; color: var(--text-muted);
  font-family: var(--font-mono, monospace);
}
.pool-jobs-empty {
  padding: 12px;
  text-align: center;
  font-size: 12px; color: var(--text-muted);
}

/* v1.0.92+ Rename modals --------------------------------------------- */
.bulk-rename-modal {
  max-width: 720px;
  width: min(720px, 92vw);
}
.input.has-error {
  border-color: var(--error, #e25c5c);
}
.hint.text-danger {
  color: var(--error, #e25c5c);
}
.bulk-rename-preview {
  margin-top: 6px;
  padding: 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 4px);
}
.bulk-rename-preview-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 8px;
}
.bulk-rename-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-family: var(--font-mono, monospace);
}
.bulk-rename-table th {
  text-align: left;
  font-weight: 500;
  color: var(--text-muted);
  font-size: 11px;
  padding: 4px 8px 6px 0;
  border-bottom: 1px solid var(--border);
}
.bulk-rename-table td {
  padding: 4px 8px 4px 0;
  vertical-align: top;
}
.bulk-rename-old {
  color: var(--text-secondary);
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bulk-rename-arrow {
  color: var(--text-muted);
  width: 20px;
  text-align: center;
}
.bulk-rename-new {
  color: var(--text-primary);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bulk-rename-new.is-error {
  color: var(--error, #e25c5c);
}
.bulk-rename-new.is-unchanged {
  color: var(--text-muted);
  font-style: italic;
}
.bulk-rename-result {
  margin-top: 8px;
  padding: 10px 12px;
  background: rgba(108, 143, 255, 0.08);
  border: 1px solid rgba(108, 143, 255, 0.25);
  border-radius: var(--radius-sm, 4px);
  font-size: 12px;
  color: var(--text-secondary);
}
.bulk-rename-errors {
  margin-top: 6px;
}
.bulk-rename-errors summary {
  cursor: pointer;
  color: var(--accent, #6c8fff);
  user-select: none;
}
.bulk-rename-errors ul {
  margin: 8px 0 0 0;
  padding-left: 18px;
  font-size: 11px;
}
.bulk-rename-errors li {
  margin: 4px 0;
  line-height: 1.5;
}
.bulk-rename-errors code {
  background: var(--bg-tertiary);
  padding: 1px 4px;
  border-radius: 3px;
}

/* ── v1.0.122+ — Fetch tab + Asset Log + clip-source pill ────────────── */

/* Source pill (Pexels / Pixabay / local) — used in clip cards AND the
   Asset Log table. Colour-coded so the eye can scan a mixed pool. */
.clip-source-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 11px;
}
.clip-source-row.clip-source-local { opacity: 0.7; }
.clip-source-pill {
  text-transform: uppercase;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.clip-source-pill.source-pexels { background: rgba(5, 168, 122, 0.18); color: #5fd9b1; }
.clip-source-pill.source-pixabay { background: rgba(46, 192, 84, 0.18); color: #6fd58a; }
.clip-source-pill.source-freesound { background: rgba(232, 120, 24, 0.18); color: #f0a35e; }
.clip-source-pill.source-local { background: rgba(127, 127, 127, 0.18); color: var(--text-muted); }
.clip-source-link {
  font-size: 11px;
  color: var(--text-muted);
}
.clip-source-link:hover { color: var(--accent); }

/* Fetch tab controls + result grid */
.fetch-controls { margin: 12px 0; display: flex; flex-direction: column; gap: 10px; }
.fetch-providers { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.fetch-provider {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  cursor: pointer;
}
.fetch-provider.is-unconfigured { opacity: 0.55; cursor: not-allowed; }
.fetch-search-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.fetch-search-row .input { flex: 1 1 320px; min-width: 240px; }
.fetch-search-row .select { flex: 0 0 auto; }
.fetch-hint {
  font-size: 12px;
  padding: 8px 12px;
  background: rgba(234, 179, 8, 0.08);
  border: 1px solid rgba(234, 179, 8, 0.3);
  border-radius: 6px;
}
.fetch-error {
  margin: 10px 0;
  padding: 10px 12px;
  background: rgba(239, 68, 68, 0.10);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  font-size: 13px;
}
.fetch-summary {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: var(--text-muted);
  margin: 8px 0;
  gap: 12px;
  flex-wrap: wrap;
}
.fetch-summary-actions { display: flex; gap: 8px; }

.fetch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}
.fetch-card {
  position: relative;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  transition: border-color 0.12s, opacity 0.12s;
}
.fetch-card.is-already-have { opacity: 0.45; }
.fetch-card.is-selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.fetch-card-select {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 2;
  background: rgba(0, 0, 0, 0.55);
  padding: 4px;
  border-radius: 4px;
  cursor: pointer;
}
.fetch-thumb-wrap { position: relative; aspect-ratio: 16 / 9; background: #000; }
.fetch-thumb { width: 100%; height: 100%; object-fit: cover; display: block; }
/* Audio (SFX) fetch results preview inline instead of a still thumbnail. */
.fetch-audio-wrap {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  padding: 8px; background: var(--bg-tertiary);
}
.fetch-audio { width: 100%; }

/* SFX generation panel (audio pools, Fetch/Generate tab) */
.sfx-gen {
  margin: 12px 0;
  padding: 12px 14px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  display: flex; flex-direction: column; gap: 8px;
}
.sfx-gen-title { font-size: 14px; font-weight: 600; }
.sfx-gen-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.sfx-gen-prompt { flex: 1 1 320px; min-width: 240px; }
.sfx-gen-duration { flex: 0 0 92px; width: 92px; }
.fetch-duration {
  position: absolute;
  bottom: 6px;
  right: 6px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
}
.fetch-provider-pill {
  position: absolute;
  top: 6px;
  right: 6px;
  text-transform: uppercase;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: 999px;
}
.fetch-have-badge {
  position: absolute;
  bottom: 6px;
  left: 6px;
  background: rgba(127, 127, 127, 0.65);
  color: #fff;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
}
.fetch-card-body { padding: 8px 10px 10px; }
.fetch-card-meta { line-height: 1.4; }
.fetch-card-license { line-height: 1.4; margin-top: 4px; }
.fetch-card-license a { color: var(--text-muted); }
.fetch-card-license a:hover { color: var(--accent); }

/* Asset Log table */
.log-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 12px 0;
  flex-wrap: wrap;
}
.log-search { flex: 1 1 320px; min-width: 220px; }
.log-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.log-table th, .log-table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
.log-table th {
  font-weight: 600;
  color: var(--text-secondary);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
  user-select: none;
}
.log-table th.is-sort-asc::after { content: ' ▲'; }
.log-table th.is-sort-desc::after { content: ' ▼'; }
.log-cell-filename {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.log-cell-keywords { line-height: 1.6; }
.log-keyword {
  display: inline-block;
  padding: 1px 6px;
  margin: 1px 2px;
  background: var(--bg-tertiary);
  border-radius: 999px;
  font-size: 11px;
  color: var(--text-secondary);
}
</style>
