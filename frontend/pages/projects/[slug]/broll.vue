<!--
  Per-project B-Roll picker — only relevant for projects whose format
  declares visualSource: 'broll' (prayer / devotional / narration-over-
  stock formats). Mounted at /projects/:slug/broll, accessible via the
  format-aware sidebar entry. v1.0.89+.

  Surfaces:
   1. Pool subscription — which app-level B-Roll pool this project uses
   2. Episode selection — pick which episode this B-Roll selection feeds
   3. Selection mode — random / tag-filtered / themed / manual
   4. Pacing — timed segments (N sec each) vs rotate-on-end
   5. Transitions + B-Roll volume (mute / duck / full)
   6. Repeat avoidance — within-episode always on; cross-episode lookback
   7. Generated sequence preview + "Assemble video" trigger

  Phase 2 ships subscription + episode selection only; full selection
  + render fires in Phase 3.
-->
<template>
  <div class="broll-page">
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Video Assembly</h1>
    </div>

    <TopActionBar
      :project-slug="slug"
      :presets="brollPresets"
      v-model:episode-id="form.episode_id"
      filter-field="broll_picked"
      generate-label="Pick B-Roll for this episode"
      :generate-loading="picking"
      :generate-disabled="!subscribedPool || !form.episode_id || picking"
      :generate-status="picking ? `Selecting clips for ${form.episode_id}…` : ''"
      @generate="pickClips"
      @preset-applied="success('Preset applied')"
      @preset-saved="success('Preset saved')"
      @preset-deleted="success('Preset deleted')"
    />

    <p class="text-muted text-sm mt-2">
      This project uses the <strong>B-Roll Narration</strong> format. Scene Prompts / Scene
      Generator pages are hidden — the video's visual layer comes from your subscribed app-level
      B-Roll pool instead.
    </p>

    <!-- ── Pool subscription ─────────────────────────────────────── -->
    <section class="card mt-3">
      <h3>1. Pool subscription</h3>
      <div v-if="loadingPools" class="text-muted text-sm">Loading pools…</div>
      <div v-else-if="!pools.length" class="empty">
        No B-Roll pools registered on this Mac yet.
        <NuxtLink to="/broll-library">Open the B-Roll Library</NuxtLink> to register a pool first.
      </div>
      <div v-else class="pool-picker">
        <label>Pool for this project:</label>
        <select v-model="subscribedPoolId" class="select" @change="saveSubscription">
          <option value="">— pick a pool —</option>
          <option v-for="p in pools" :key="p.id" :value="p.id">
            {{ p.name }}{{ !p.online ? ' (offline)' : '' }}
          </option>
        </select>
        <NuxtLink to="/broll-library" class="text-sm">Manage pools →</NuxtLink>
      </div>
      <div v-if="subscribedPool && !subscribedPool.online" class="offline-banner mt-2">
        🔌 The pool's SSD isn't connected. Plug in <code>{{ subscribedPool.folder_path }}</code>
        before generating a selection.
      </div>
    </section>

    <!-- ── Selection settings ─────────────────────────────────────── -->
    <section v-if="subscribedPool" class="card mt-3">
      <h3>2. Selection settings</h3>
      <div class="grid-2">
        <div class="form-group">
          <label>Selection mode</label>
          <select v-model="form.selection_mode" class="select">
            <option value="random">Random — shuffle the whole pool</option>
            <option value="tagged">Tag-filtered — pool clips matching ANY of the selected tags</option>
            <option value="themed">Themed — pool clips matching ALL of the selected tags</option>
            <option value="manual">Manual — pick clips and order yourself (Phase 3)</option>
          </select>
          <span class="hint">
            Random ignores tags entirely. Tagged matches any of the picked tags (broader pool).
            Themed requires every selected tag (narrower pool — best for episode-specific themes
            like "sunrise + nature + water").
          </span>
        </div>

        <div v-if="form.selection_mode === 'tagged' || form.selection_mode === 'themed'" class="form-group">
          <label>Tags to match</label>
          <ChipInput
            v-model="form.tags"
            :suggestions="availableTags"
            placeholder="add a tag…"
            allow-custom
          />
          <span class="hint">
            Tags pulled from the pool. <strong>{{ matchingClipCount }}</strong> clip(s) match the
            current filter.
          </span>
        </div>
      </div>

      <div class="grid-2 mt-2">
        <div class="form-group">
          <label>Pacing</label>
          <div class="radio-row">
            <label><input type="radio" value="timed" v-model="form.pacing_mode" /> Timed segments</label>
            <label><input type="radio" value="rotate" v-model="form.pacing_mode" /> Rotate on clip end</label>
          </div>
          <div v-if="form.pacing_mode === 'timed'" class="mt-1">
            <label class="text-xs text-muted">Segment length (seconds)</label>
            <input v-model.number="form.segment_seconds" type="number" min="2" max="60" class="input input-sm" />
          </div>
          <span class="hint">
            <strong>Timed</strong> = each clip plays for N seconds regardless of native length.
            Clips shorter than N loop; longer clips are truncated.
            <strong>Rotate</strong> = each clip plays to its natural end, then switches.
            More natural pacing but unpredictable cut frequency.
          </span>
        </div>

        <div class="form-group">
          <label>B-Roll audio volume</label>
          <div class="volume-row">
            <input v-model.number="form.broll_volume" type="range" min="0" max="100" class="volume-slider" />
            <span class="volume-value">{{ form.broll_volume }}%</span>
            <button class="btn btn-ghost btn-sm" @click="form.broll_volume = 0" :title="'Strip B-Roll audio entirely'">
              🔇 Mute
            </button>
          </div>
          <span class="hint">
            0% = silence (recommended for prayer / devotional). 10–20% = ducked ambient texture.
            100% = unmuted. Narration mixed on top regardless.
          </span>
        </div>
      </div>

      <div class="form-group mt-2">
        <label>Repeat avoidance</label>
        <div class="checkbox-row">
          <label><input type="checkbox" checked disabled /> Within episode (always on)</label>
          <label>
            <input type="checkbox" :checked="form.broll_lookback > 0" @change="(e: any) => form.broll_lookback = e.target.checked ? 10 : 0" />
            Across recent episodes — last
            <input
              v-model.number="form.broll_lookback"
              type="number"
              min="0"
              max="100"
              class="input input-sm input-inline"
              :disabled="form.broll_lookback === 0"
            />
            uploads from this channel
          </label>
        </div>
        <span class="hint">
          A clip used in any of the last N uploads is excluded from the candidate pool for this
          episode. Set to 0 to allow repeats freely (useful when your pool is small).
        </span>
      </div>
    </section>

    <!-- ── Manual clip picker ────────────────────────────────────────
         Mounts only when selection_mode === 'manual'. Two columns:
         left = full pool grid (click a tile to add to the sequence),
         right = ordered sequence with up/down reorder + remove + per-
         clip target_duration input. Live total tracks against narration
         target. v1.0.89+. -->
    <section v-if="subscribedPool && form.selection_mode === 'manual'" class="card mt-3">
      <h3>3. Manual clip selection</h3>
      <p class="hint">
        Click a tile in the pool to add it to your sequence. Reorder with the ▲ ▼ buttons; remove
        with ✕. Each clip plays for its native duration by default — type a different number to
        loop short clips or trim long ones. The total duration target is your narration length
        ({{ formatDuration(narrationTargetSec) || '—' }}); pick clips until the cumulative duration
        covers it.
      </p>

      <div class="manual-layout">
        <div class="manual-pool">
          <div class="manual-pool-header">
            Pool ({{ clipsInPool.length }} clips)
            <input
              v-model="manualPoolFilter"
              class="input input-sm"
              placeholder="filter by tag / filename"
            />
          </div>
          <div class="manual-pool-grid">
            <button
              v-for="clip in filteredManualPool"
              :key="clip.filename"
              type="button"
              class="manual-tile"
              :class="{ used: manualSelection.some(m => m.filename === clip.filename) }"
              :title="`${clip.filename} · ${formatDuration(clip.duration)}\nTags: ${(clip.tags || []).join(', ') || '(none)'}`"
              @click="addToManualSelection(clip)"
            >
              <img :src="thumbnailUrl(subscribedPoolId, clip.filename)" :alt="clip.filename" class="manual-thumb" />
              <span class="manual-tile-name">{{ clip.filename }}</span>
              <span class="manual-tile-dur">{{ formatDuration(clip.duration) }}</span>
              <span v-if="manualSelection.some(m => m.filename === clip.filename)" class="manual-tile-badge">
                ✓ {{ manualSelection.filter(m => m.filename === clip.filename).length }}×
              </span>
            </button>
          </div>
        </div>

        <div class="manual-sequence">
          <div class="manual-sequence-header">
            Sequence ({{ manualSelection.length }} clips · {{ formatDuration(manualTotalSec) }})
            <span :class="['manual-total-pill', manualCoverageClass]" :title="manualCoverageTitle">
              {{ narrationTargetSec ? `${Math.round((manualTotalSec / narrationTargetSec) * 100)}%` : '—' }}
              of narration
            </span>
          </div>
          <div v-if="!manualSelection.length" class="manual-empty">
            Click clips on the left to start building your sequence.
          </div>
          <ol v-else class="manual-list">
            <li v-for="(m, idx) in manualSelection" :key="`${m.filename}-${idx}`" class="manual-row">
              <img :src="thumbnailUrl(subscribedPoolId, m.filename)" :alt="m.filename" class="manual-row-thumb" />
              <div class="manual-row-body">
                <span class="manual-row-name" :title="m.filename">{{ m.filename }}</span>
                <div class="manual-row-controls">
                  <label class="text-xs text-muted">Play for</label>
                  <input
                    v-model.number="m.target_duration"
                    type="number"
                    min="0.5"
                    :max="poolDurationFor(m.filename)"
                    step="0.5"
                    class="input input-sm input-inline"
                  />
                  <span class="text-xs text-muted">s · native {{ formatDuration(poolDurationFor(m.filename)) }}</span>
                </div>
              </div>
              <div class="manual-row-actions">
                <button class="btn btn-ghost btn-sm" :disabled="idx === 0" :title="'Move up'" @click="reorderManual(idx, -1)">▲</button>
                <button class="btn btn-ghost btn-sm" :disabled="idx === manualSelection.length - 1" :title="'Move down'" @click="reorderManual(idx, 1)">▼</button>
                <button class="btn btn-ghost btn-sm" :title="'Remove'" @click="manualSelection.splice(idx, 1)">✕</button>
              </div>
            </li>
          </ol>
        </div>
      </div>
    </section>

    <!-- ── Motion + transitions ──────────────────────────────────────
         Per-episode camera-move (zoom / pan / static) + clip-to-clip
         transition. Two registers: a single fixed motion vs a pool that
         rotates per segment. Transitions are global (one xfade between
         every clip pair) at v1.0.89; per-segment transition overrides
         can ship in a follow-up if useful. v1.0.89+. -->
    <section v-if="subscribedPool" class="card mt-3">
      <h3>4. Camera motion + transitions</h3>
      <div class="grid-2">
        <div class="form-group">
          <label>Per-clip motion</label>
          <div class="radio-row">
            <label><input type="radio" value="fixed" v-model="form.motion_mode" /> Fixed — same motion on every clip</label>
            <label><input type="radio" value="rotate" v-model="form.motion_mode" /> Rotate — cycle through a pool</label>
            <label><input type="radio" value="random" v-model="form.motion_mode" /> Random — pick from pool per clip</label>
          </div>
          <span class="hint">
            <strong>Fixed</strong> is the calmest — one quiet zoom across the whole episode.
            <strong>Rotate</strong> + <strong>Random</strong> give variety; pair with the static
            option in the pool to interleave still segments with moving ones for a natural rhythm.
          </span>

          <div v-if="form.motion_mode === 'fixed'" class="mt-2">
            <label class="text-xs text-muted">Motion</label>
            <select v-model="form.motion_default" class="select select-sm">
              <option v-for="m in motionOptions" :key="m.id" :value="m.id">{{ m.label }} — {{ m.hint }}</option>
            </select>
          </div>

          <div v-else class="mt-2">
            <label class="text-xs text-muted">Motion pool (pick at least 1)</label>
            <div class="motion-pool-grid">
              <label v-for="m in motionOptions" :key="m.id" class="motion-pool-chip" :class="{ active: form.motion_pool.includes(m.id) }">
                <input type="checkbox" :value="m.id" v-model="form.motion_pool" />
                {{ m.label }}
              </label>
            </div>
          </div>
        </div>

        <div class="form-group">
          <label>Transition between clips</label>
          <select v-model="form.transition_id" class="select">
            <option value="none">Hard cut (no transition) — cheapest render</option>
            <optgroup label="Crossfade">
              <option value="crossfade">Crossfade — classic blend</option>
              <option value="fade-fast">Crossfade (fast) — snappy</option>
              <option value="fade-slow">Crossfade (slow) — deliberate drift</option>
              <option value="fade-black">Fade through black</option>
              <option value="fade-white">Fade through white</option>
              <option value="dissolve">Dissolve — grainy</option>
            </optgroup>
            <optgroup label="Wipe">
              <option value="wipe-left">Wipe left</option>
              <option value="wipe-right">Wipe right</option>
              <option value="smooth-left">Smooth wipe left</option>
              <option value="smooth-right">Smooth wipe right</option>
            </optgroup>
            <optgroup label="Slide">
              <option value="slide-left">Slide left</option>
              <option value="slide-right">Slide right</option>
            </optgroup>
            <optgroup label="Shape">
              <option value="circle-open">Circle open</option>
              <option value="circle-close">Circle close</option>
            </optgroup>
          </select>
          <div v-if="form.transition_id !== 'none'" class="mt-2">
            <label class="text-xs text-muted">Transition length (seconds)</label>
            <input v-model.number="form.transition_duration" type="number" min="0.1" max="2" step="0.1" class="input input-sm input-inline" />
            <span class="hint">
              0.3–0.6s reads as deliberate; 0.8–1.5s feels meditative. Longer transitions also shorten
              the final video — total = sum(clip durations) − (n−1) × transition length.
            </span>
          </div>
        </div>
      </div>
    </section>

    <!-- ── Subtitles (optional) ────────────────────────────────────
         v1.0.126+ — Mirrors the scene-based Video Assembly page's
         subtitle UI in a simplified form. Backend already burns any
         .srt/.ass/.vtt found in the episode's subtitles_dir during
         broll-assemble (see broll-assemble.ts:144-302), so this UI
         just needs to put a file there. Three sources: derive one cue
         per chapter from chapter audio, import an existing file from
         disk, or transcribe the merged audio via Whisper. The endpoints
         under /projects/:slug/video-editor/subtitles/* are pipeline-
         agnostic — the same routes that power the scene-based UI work
         here verbatim.
    -->
    <section v-if="subscribedPool && form.episode_id" class="card mt-3">
      <h3>4. Subtitles (optional)</h3>
      <p class="text-muted mt-1">
        Generate or import a subtitle file for this episode. The
        <strong>Enable subtitles</strong> toggle controls whether the file
        gets burned in on the next assembly — leave it off to render
        without subtitles even if a file exists.
      </p>

      <!-- v1.0.127+ — Enable toggle. Replaces the v1.0.126 "delete the
           SRT to skip burn-in" workaround. State is persisted to
           config.broll_subtitles via useAutoSave. -->
      <div class="settings-section mt-2">
        <label class="checkbox-label">
          <input type="checkbox" v-model="brollSubtitles.enabled" />
          <span class="ml-1-tight">Enable subtitles</span>
        </label>
        <span class="text-muted text-xs hint-line">
          When on, the first matching file in <code>subtitles/</code> (priority: .srt → .ass → .vtt) is burned into the final video. Off skips the burn entirely.
        </span>
      </div>

      <p
        v-if="subtitlesStatus && subtitlesStatus.has_libass === false && brollSubtitles.enabled"
        class="validation-msg text-sm mt-1"
      >
        ⚠ This FFmpeg build doesn't include libass — subtitles can't be burned in.
        Reinstall the app's bundled ffmpeg or install a libass-enabled build
        (e.g. <code>brew install ffmpeg</code> with freetype + libass).
      </p>

      <!-- Source picker -->
      <div class="flex gap-2 mt-2 flex-wrap">
        <button
          :class="['btn btn-sm', subtitlesSource === 'chapters' ? 'btn-primary' : 'btn-secondary']"
          @click="subtitlesSource = 'chapters'"
        >📑 Auto from chapters</button>
        <button
          :class="['btn btn-sm', subtitlesSource === 'upload' ? 'btn-primary' : 'btn-secondary']"
          @click="subtitlesSource = 'upload'"
        >📂 Import .srt / .vtt</button>
        <button
          :class="['btn btn-sm', subtitlesSource === 'whisper' ? 'btn-primary' : 'btn-secondary']"
          @click="subtitlesSource = 'whisper'"
        >🎙 Transcribe (Whisper)</button>
      </div>

      <!-- Chapters -->
      <div v-if="subtitlesSource === 'chapters'" class="mt-2">
        <p class="text-muted text-sm">
          Derives one cue per chapter from the individual chapter audio files —
          fast, free, chapter-level granularity (one line per chapter).
        </p>
        <p
          v-if="subtitlesStatus && !subtitlesStatus.has_chapter_audio"
          class="validation-msg text-sm"
        >
          No chapter audio files found. Run the Audio Generator for this
          episode first, or pick a different source.
        </p>
        <!-- v1.0.127+ — Gap input. Audio Assembly inserts silence between
             chapters (default 5s, format-overridable via the format's
             audioMergeDefaults.gapDurationSec). The subtitle generator
             needs to use the SAME gap or cues drift forward through the
             episode. Default is seeded from the format on mount; the user
             can override here per-episode. -->
        <div class="flex items-center gap-2 mt-2 flex-wrap">
          <label class="text-sm text-muted" style="white-space: nowrap">Gap between chapters (sec)</label>
          <input
            v-model.number="brollSubtitles.gap_sec"
            type="number"
            min="0"
            max="30"
            step="0.5"
            class="input input-sm"
            style="width: 90px"
          />
          <span class="text-xs text-muted" v-if="brollFormatGapDefault !== null && brollSubtitles.gap_sec !== brollFormatGapDefault">
            format default: {{ brollFormatGapDefault }}s — restore?
            <button class="btn-icon" title="Restore format default" @click="brollSubtitles.gap_sec = brollFormatGapDefault ?? 5">↺</button>
          </span>
          <span class="text-xs text-muted" v-else-if="brollFormatGapDefault !== null">
            format default (audioMergeDefaults.gapDurationSec)
          </span>
          <span class="text-xs text-muted" v-else>
            should match the silence your Audio Assembly inserts between chapters
          </span>
        </div>
        <button
          class="btn btn-sm btn-secondary mt-2"
          :disabled="subtitlesGenerating || !form.episode_id || !subtitlesStatus?.has_chapter_audio"
          @click="generateBrollSubtitlesFromChapters"
        >
          {{ subtitlesGenerating ? 'Generating…' : `Generate SRT from chapters (gap: ${brollSubtitles.gap_sec}s)` }}
        </button>
      </div>

      <!-- Upload -->
      <div v-if="subtitlesSource === 'upload'" class="mt-2">
        <p class="text-muted text-sm">
          Pick a subtitle file from disk — Story Studio copies it into this
          episode's <code>subtitles/</code> folder and normalises line endings.
        </p>
        <div class="flex gap-2 mt-1 items-center" style="flex-wrap: wrap">
          <FilePicker
            v-model="brollSubtitleUploadPath"
            placeholder="/path/to/subtitles.srt"
            :filters="[{ name: 'Subtitles', extensions: ['srt', 'vtt'] }]"
            title="Choose a subtitle file"
            :output-root="project?.output_root || ''"
            clearable
          />
          <button
            class="btn btn-sm btn-primary"
            :disabled="subtitlesGenerating || !brollSubtitleUploadPath || !form.episode_id"
            @click="importBrollSubtitles"
          >
            {{ subtitlesGenerating ? 'Importing…' : 'Import' }}
          </button>
        </div>
      </div>

      <!-- Whisper -->
      <div v-if="subtitlesSource === 'whisper'" class="mt-2">
        <!-- v1.0.395 — engine: local Voice Studio Whisper (free) vs OpenAI (paid). -->
        <div class="flex gap-2 flex-wrap">
          <button
            type="button"
            :class="['btn btn-sm', brollWhisperEngine === 'voicestudio' ? 'btn-primary' : 'btn-secondary']"
            @click="brollWhisperEngine = 'voicestudio'"
          >💻 Voice Studio (local · free)</button>
          <button
            type="button"
            :class="['btn btn-sm', brollWhisperEngine === 'openai' ? 'btn-primary' : 'btn-secondary']"
            @click="brollWhisperEngine = 'openai'"
          >☁︎ OpenAI Whisper (paid)</button>
        </div>

        <!-- Local Voice Studio engine -->
        <template v-if="brollWhisperEngine === 'voicestudio'">
          <p class="text-muted text-sm mt-2">
            Transcribes the merged audio with a <strong>local Whisper model</strong> on your
            own Mac via Voice Studio — free, no API charge, fully offline.
          </p>
          <div v-if="brollVsAvailLoading" class="text-muted text-sm">Checking Voice Studio…</div>
          <template v-else-if="!brollVsAvail?.available">
            <p class="validation-msg text-sm">
              ⚠ Voice Studio transcription isn't reachable.
              <template v-if="!brollVsAvail?.configured">
                Set the URL in
                <NuxtLink :to="`/projects/${slug}/settings`" style="color: var(--accent)">Settings → Local Models</NuxtLink>,
                then start the modal.
              </template>
              <template v-else>Start the Voice Studio modal (and load a Whisper model), then re-check.</template>
            </p>
            <button class="btn btn-sm btn-ghost mt-1" :disabled="brollVsAvailLoading" @click="loadBrollVsAvailability">
              ↻ Re-check
            </button>
          </template>
          <template v-else>
            <div class="form-group mt-2">
              <label class="text-muted text-xs">Whisper model · on {{ brollVsAvail.device || 'mps' }}</label>
              <select v-model="brollVsModel" class="select select-sm">
                <option v-for="m in (brollVsAvail.models || [])" :key="m.repo" :value="m.repo">
                  {{ m.label || m.repo }}{{ m.size_gb ? ` · ${m.size_gb} GB` : '' }}{{ m.recommended ? ' · recommended' : '' }}{{ m.cached ? '' : ' · not downloaded' }}
                </option>
              </select>
            </div>
            <div v-if="brollVsSelectedNotCached" class="mt-1 text-sm">
              <button class="btn btn-sm btn-secondary" :disabled="downloadingBrollModel" @click="downloadBrollVsModel">
                {{ downloadingBrollModel ? 'Downloading…' : 'Download this model' }}
              </button>
              <span class="text-muted text-xs ml-1">Not on the modal yet — download once, then transcribe.</span>
            </div>
          </template>
        </template>

        <!-- OpenAI engine -->
        <template v-else>
          <p class="text-muted text-sm mt-2">
            Transcribes the merged audio via the <strong>OpenAI Whisper API</strong> —
            uses the OpenAI key in <strong>App Settings → API Keys</strong>. Costs
            ~$0.006/min on the <code>whisper-1</code> model, billed to your OpenAI account.
          </p>
          <p
            v-if="subtitlesStatus && !subtitlesStatus.has_openai_key"
            class="validation-msg text-sm"
          >
            OpenAI API key not set. Add one under App Settings → API Keys.
          </p>
        </template>

        <!-- Shared: merged-audio guard + existing-SRT reuse + go button -->
        <p
          v-if="subtitlesStatus && !subtitlesStatus.has_merged_audio"
          class="validation-msg text-sm"
        >
          No merged audio file found. Run Audio Assembly for this episode first.
        </p>
        <p v-if="brollHasExistingWhisperSrt" class="text-muted text-sm">
          <strong>{{ brollExistingWhisperSrtName }}</strong> already exists — the
          job reuses it unless you tick re-run below.
        </p>
        <label
          v-if="brollHasExistingWhisperSrt"
          class="flex items-center gap-1 mt-1 text-sm"
        >
          <input type="checkbox" v-model="brollWhisperForce" />
          Re-run transcription{{ brollWhisperEngine === 'openai' ? ' (charges Whisper API again)' : '' }}
        </label>
        <button
          class="btn btn-sm btn-secondary mt-1"
          :disabled="subtitlesGenerating || !canTranscribeBroll"
          @click="transcribeBrollWithWhisper"
        >
          {{ subtitlesGenerating ? 'Queuing…' : (brollHasExistingWhisperSrt && !brollWhisperForce ? 'Reuse existing transcript' : 'Transcribe now') }}
        </button>
      </div>

      <!-- Existing subtitle files for this episode -->
      <div
        v-if="subtitlesStatus?.existing_srts?.length"
        class="text-sm mt-3"
      >
        <label class="text-muted">
          Subtitle files on disk — pick which one to burn
        </label>
        <!-- v1.0.396 — AUTO option + one radio per file. The picked file is what
             the next assembly burns (persisted per episode). AUTO prefers the
             full stitched/whisper transcript and skips per-chapter partials. -->
        <label class="broll-srt-auto">
          <input
            type="radio"
            name="broll-sub-pick"
            :checked="!subtitlesStatus.selected_subtitle"
            :disabled="brollSubtitleSelecting"
            @change="selectBrollSubtitle(null)"
          />
          <strong>Auto</strong>
          <span class="text-muted text-xs">— pick the full transcript automatically (stitched / whisper; skips single-chapter files)</span>
        </label>
        <ul class="broll-srt-list">
          <li v-for="srt in subtitlesStatus.existing_srts" :key="srt.path">
            <input
              type="radio"
              name="broll-sub-pick"
              class="broll-srt-radio"
              :checked="subtitlesStatus.selected_subtitle === srt.filename"
              :disabled="brollSubtitleSelecting"
              :title="`Burn ${srt.filename} on the next assembly`"
              @change="selectBrollSubtitle(srt.filename)"
            />
            <code>{{ srt.filename }}</code>
            <span
              v-if="subtitlesStatus.selected_subtitle === srt.filename"
              class="broll-srt-pinned"
            >✓ burned next</span>
            <span class="text-muted" v-if="!brollSubtitles.enabled">
              — currently disabled by the toggle above; will be burned when re-enabled
            </span>
            <!-- v1.0.140+ — Drift warning. Surfaces when this SRT was
                 derived against a different merge gap than the audio
                 was actually merged with — re-deriving fixes the
                 progressive drift the user would otherwise see in the
                 burned-in subtitles. -->
            <span
              v-if="srt.drifts_from_current_merge"
              class="broll-srt-drift"
              :title="srt.drift_note || 'Gap mismatch — re-derive to fix drift.'"
            >
              ⚠ drift {{ srt.generated_with_gap_s != null
                ? `(was ${srt.generated_with_gap_s}s, now ${subtitlesStatus?.current_merge_gap_s}s)`
                : '' }}
            </span>
            <!-- v1.0.135+ — In-app delete. Removes the file from
                 subtitles_dir so the broll-assemble findSubtitlePath
                 walk won't pick it up. Confirms first because deletes
                 are not undoable from inside the app. -->
            <button
              type="button"
              class="btn-icon broll-srt-del"
              :disabled="brollSubtitlesDeletingFilename === srt.filename"
              :title="`Delete ${srt.filename} from this episode's subtitles folder`"
              aria-label="Delete subtitle file"
              @click="deleteBrollSubtitle(srt.filename)"
            >
              {{ brollSubtitlesDeletingFilename === srt.filename ? '⏳' : '✕' }}
            </button>
          </li>
        </ul>
      </div>
      <div v-else class="text-muted text-sm mt-3">
        No subtitle files for this episode yet. Pick a source above to
        generate or import one.
      </div>

      <!-- v1.0.127+ — Style picker. Reuses the same SubtitleStylePicker
           component the scene-based Video Assembly uses, so the visual
           language is identical across both pipelines. Style is persisted
           to config.broll_subtitles.style and sent to broll-assemble as
           force_style= on the ffmpeg subtitles filter. Only renders when
           subtitles are enabled — keeps the section quiet for users who
           leave the toggle off. -->
      <div v-if="brollSubtitles.enabled" class="settings-section mt-3">
        <h4>Style</h4>
        <p class="text-muted text-xs hint-line">
          Controls font, size, colour, outline, position, and background — applied via
          libass <code>force_style</code> at burn time. Style choices are saved per project
          so they survive reload + apply to every B-Roll assembly going forward.
        </p>
        <SubtitleStylePicker
          :slug="slug"
          :episode-id="form.episode_id"
          :style="brollSubtitles.style"
          :sample-text="'The forest whispered secrets older than memory.'"
          @update:style="(s) => Object.assign(brollSubtitles.style, s)"
        />
      </div>
    </section>

    <!-- ── Selected sequence preview ──────────────────────────────── -->
    <section v-if="selection.length" class="card mt-3">
      <h3>3. Selected sequence ({{ selection.length }} clips · {{ formatDuration(selectionDuration) }})</h3>
      <div class="sequence-row">
        <div v-for="(s, idx) in selection" :key="idx" class="seq-tile" :title="`${s.filename} · ${formatDuration(s.target_duration)}`">
          <img :src="thumbnailUrl(s.pool_id, s.filename)" :alt="s.filename" class="seq-thumb" />
          <span class="seq-idx">{{ idx + 1 }}</span>
          <span class="seq-duration">{{ formatDuration(s.target_duration) }}</span>
        </div>
      </div>
      <div class="seq-actions mt-2">
        <button
          class="btn btn-primary"
          :disabled="!form.episode_id || assembling || assembleJobActive"
          @click="assembleVideo"
        >
          <LoadingSpinner v-if="assembling || assembleJobActive" size="sm" />
          {{ (assembling || assembleJobActive) ? 'Assembling…' : '🎞 Assemble video' }}
        </button>
        <button class="btn btn-ghost" @click="pickClips" :disabled="picking">
          ↻ Re-pick (different shuffle)
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, reactive } from 'vue'

definePageMeta({ layout: 'dashboard' })
useAppTitle('B-Roll Picker')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put, del } = useApi()
const { success, error: showError } = useToast()
// v1.0.135+ — useConfirm composable for the in-app subtitle-delete
// confirmation dialog (subtitle deletes are not undoable from inside
// the app, so we ask once).
const { ask } = useConfirm()
const { project } = useProject()
const broll = useBrollPools()

const pools = broll.pools
const loadingPools = broll.loading

const subscribedPoolId = ref<string>('')
const subscribedPool = computed(() => pools.value.find(p => p.id === subscribedPoolId.value) || null)

const clipsInPool = ref<any[]>([])
const availableTags = ref<string[]>([])

const form = reactive({
  episode_id: '',
  selection_mode: 'random' as 'random' | 'tagged' | 'themed' | 'manual',
  tags: [] as string[],
  pacing_mode: 'rotate' as 'timed' | 'rotate',
  segment_seconds: 8,
  broll_volume: 0,
  broll_lookback: 10,
  // v1.0.89+ motion + transitions
  motion_mode: 'fixed' as 'fixed' | 'rotate' | 'random',
  motion_default: 'static' as 'static' | 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'pan-up' | 'pan-down',
  motion_pool: ['static', 'zoom-in', 'pan-right'] as string[],
  transition_id: 'crossfade' as string,
  transition_duration: 0.5,
})

// v1.0.121+ — Preset hookup. Mirrors the pattern used by every other
// generator page (scripts, audio, image-prompts, etc.). The composable
// strips `episode_id` automatically (it's in DEFAULT_EXCLUDE_KEYS) so a
// preset saved on TN0042 doesn't drag that episode reference onto TN0043
// when applied. `subscribedPoolId` and `manualSelection` deliberately
// stay OUTSIDE the snapshot — pool subscription is a per-project setting
// stored in config.json (not a preset concept), and manual-mode picks
// are per-episode by definition. Presets here capture the *tuning*
// (selection mode, tags, pacing, motion, transitions, volume, lookback)
// that a user wants to reuse across episodes or channels.
const brollPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'broll',
  presetType: 'broll',
  snapshot: () => ({ form: { ...form } }),
  apply: (data) => {
    if (data?.form) Object.assign(form, data.form)
  },
})

// v1.0.126+ — Subtitle state. v1.0.127+ — Full feature set:
//   - Enable toggle (replaces "must delete file to skip burn-in")
//   - Style picker (force_style passthrough to ffmpeg's subtitles filter)
//   - Format-aware gap default (read from audioMergeDefaults.gapDurationSec)
//   - Persisted to config.broll_subtitles via useAutoSave debounce
//
// `brollSubtitles` is the persistent state — survives navigation,
// flows into the assemble request. `subtitlesSource` is transient
// (which generator-tab is showing right now).
const subtitlesSource = ref<'chapters' | 'upload' | 'whisper'>('chapters')
const subtitlesGenerating = ref(false)
const subtitlesStatus = ref<{
  has_libass: boolean
  has_merged_audio: boolean
  has_chapter_audio: boolean
  has_openai_key: boolean
  existing_srts: Array<{
    path: string
    filename: string
    mtime: number
    // v1.0.140+ — Drift-detection fields populated by the backend when
    // a parallel `.srt.json` metadata sidecar exists. Missing on
    // pre-1.0.140 SRTs (hand-imported, Whisper-transcribed, etc.) and
    // ignored by the frontend in that case.
    generated_with_gap_s?: number | null
    drifts_from_current_merge?: boolean
    drift_note?: string
  }>
  subtitles_dir: string
  /** v1.0.140+ — The gap_duration the most recent audio-merge job
   *  used, read from the audio_chapters.json sidecar. null when no
   *  merge has run on 1.0.140+ yet. */
  current_merge_gap_s?: number | null
  /** v1.0.396 — user-pinned subtitle filename to burn (null = AUTO). */
  selected_subtitle?: string | null
} | null>(null)
const brollSubtitleSelecting = ref(false)
const brollSubtitleUploadPath = ref('')
const brollWhisperForce = ref(false)

// v1.0.395 — B-Roll Whisper engine: local Voice Studio (free) vs OpenAI (paid).
// Defaults to the local engine — the whole point of this control is to stop
// burning OpenAI credits. The backend transcribe route + generator already
// accept { engine, model }; this just surfaces the choice on the B-Roll page
// (mirrors the Subtitles workspace, which already had it).
interface BrollVsModel { repo: string; label?: string; size_gb?: number; recommended?: boolean; cached?: boolean }
interface BrollVsAvail { available: boolean; configured?: boolean; device?: string; default_model?: string; models?: BrollVsModel[] }
const brollWhisperEngine = ref<'voicestudio' | 'openai'>('voicestudio')
const brollVsAvail = ref<BrollVsAvail | null>(null)
const brollVsAvailLoading = ref(false)
const brollVsModel = ref('')
const downloadingBrollModel = ref(false)

// Persistent subtitle config — saved to config.broll_subtitles. Default
// shape matches what broll-assemble.ts expects on the wire + the
// VideoSubtitleStyle interface. `gap_sec` controls subtitle cue
// timestamps in the chapters-source generator; the default is replaced
// by the format's audioMergeDefaults.gapDurationSec on mount if the
// project's effective format declares one.
const brollSubtitles = reactive({
  enabled: false,
  gap_sec: 5,
  style: {
    font_family: 'Helvetica',
    font_size_px: 28,
    color_hex: '#FFFFFF',
    outline_color_hex: '#000000',
    outline_px: 2,
    background: 'none' as 'none' | 'semi' | 'full',
    position: 'bottom' as 'top' | 'center' | 'bottom',
    align: 'center' as 'left' | 'center' | 'right',
    max_chars_per_line: 42,
    max_lines: 2,
  },
})

// v1.0.127+ — Format-driven default for the inter-chapter silence gap.
// audio-merge.ts uses `req.body.gap_duration ?? fmtMerge?.gapDurationSec ?? 5`
// when concatenating the chapter MP3s. Subtitle from-chapters needs to
// use the SAME value or its cues drift over the episode. We fetch the
// format on mount and seed `brollSubtitles.gap_sec` from it (unless the
// user already saved a different value to config).
const brollFormatGapDefault = ref<number | null>(null)
async function loadBrollFormatGapDefault(): Promise<void> {
  try {
    const f = await get<{ script?: { audioMergeDefaults?: { gapDurationSec?: number } } }>(
      `/projects/${slug.value}/effective-format`,
    )
    const fg = f?.script?.audioMergeDefaults?.gapDurationSec
    if (typeof fg === 'number' && fg >= 0) brollFormatGapDefault.value = fg
  } catch { /* tolerate — fallback default (5) stays in place */ }
}

// v1.0.127+ — Persist brollSubtitles to config.broll_subtitles whenever it
// changes. Debounced 800ms via useAutoSave so a series of rapid edits
// (slider drag in the style picker, gap arrow-key bumps) collapse into
// one PUT. Auto-flush on unmount/unload keeps the last change durable
// even if the user navigates away inside the debounce window.
const brollSubsAutoSave = useAutoSave({
  debounceMs: 800,
  save: async () => {
    if (!slug.value) return
    await put(`/projects/${slug.value}/settings/config`, {
      broll_subtitles: {
        enabled: brollSubtitles.enabled,
        gap_sec: brollSubtitles.gap_sec,
        style: { ...brollSubtitles.style },
      },
    })
  },
})
// Trigger save on any field change. Deep watch the reactive object so
// nested style edits also schedule a save.
watch(
  () => ({
    enabled: brollSubtitles.enabled,
    gap_sec: brollSubtitles.gap_sec,
    style: { ...brollSubtitles.style },
  }),
  () => { brollSubsAutoSave.scheduleSave() },
  { deep: true },
)

const brollHasExistingWhisperSrt = computed(() => {
  const list = subtitlesStatus.value?.existing_srts || []
  return list.some(s => /_whisper\.srt$/i.test(s.filename))
})
const brollExistingWhisperSrtName = computed(() => {
  const list = subtitlesStatus.value?.existing_srts || []
  const found = list.find(s => /_whisper\.srt$/i.test(s.filename))
  return found?.filename || ''
})

// The selected local model exists in the modal's catalog but isn't downloaded yet.
const brollVsSelectedNotCached = computed(() => {
  const m = (brollVsAvail.value?.models || []).find(x => x.repo === brollVsModel.value)
  return !!m && m.cached === false
})
// Engine-aware "can we transcribe" gate for the button.
const canTranscribeBroll = computed(() => {
  if (!form.episode_id || !subtitlesStatus.value?.has_merged_audio) return false
  if (brollWhisperEngine.value === 'openai') return !!subtitlesStatus.value?.has_openai_key
  return !!brollVsAvail.value?.available && !!brollVsModel.value
})

async function loadBrollSubtitlesStatus(): Promise<void> {
  if (!form.episode_id) {
    subtitlesStatus.value = null
    return
  }
  try {
    subtitlesStatus.value = await get(
      `/projects/${slug.value}/video-editor/subtitles/status/${form.episode_id}`,
    )
  } catch {
    // Non-fatal — leave previous value or null; the UI just hides the
    // condition-gated warnings.
  }
}

// v1.0.396 — pin which subtitle file the next assembly burns (or clear → AUTO).
async function selectBrollSubtitle(filename: string | null): Promise<void> {
  if (!form.episode_id) return
  brollSubtitleSelecting.value = true
  try {
    const r = await put<{ selected_subtitle: string | null }>(
      `/projects/${slug.value}/video-editor/subtitles/select/${form.episode_id}`,
      { filename },
    )
    if (subtitlesStatus.value) subtitlesStatus.value.selected_subtitle = r.selected_subtitle
    success(filename ? `Will burn ${filename} on the next assembly` : 'Auto-pick re-enabled')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Could not set subtitle selection')
    await loadBrollSubtitlesStatus()
  } finally {
    brollSubtitleSelecting.value = false
  }
}

async function generateBrollSubtitlesFromChapters(): Promise<void> {
  if (!form.episode_id) return
  subtitlesGenerating.value = true
  try {
    const r = await post<{ srt_path: string; cues: number }>(
      `/projects/${slug.value}/video-editor/subtitles/from-chapters/${form.episode_id}`,
      // v1.0.127+ — use the configured gap (format-aware default seeded
      // on mount; user can override). Hardcoded 5 in v1.0.126 made cues
      // drift for projects whose audio_merge used a non-5 gap_duration.
      { gap_sec: brollSubtitles.gap_sec },
    )
    success(`Generated ${r.cues} chapter cues at ${brollSubtitles.gap_sec}s inter-chapter gap`)
    await loadBrollSubtitlesStatus()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Chapter subtitles failed')
  } finally {
    subtitlesGenerating.value = false
  }
}

async function importBrollSubtitles(): Promise<void> {
  if (!form.episode_id || !brollSubtitleUploadPath.value) return
  subtitlesGenerating.value = true
  try {
    const r = await post<{ srt_path: string; cues: number; warnings: string[] }>(
      `/projects/${slug.value}/video-editor/subtitles/import/${form.episode_id}`,
      { source_path: brollSubtitleUploadPath.value },
    )
    success(`Imported ${r.cues} cues${r.warnings?.length ? ` (${r.warnings.length} warnings)` : ''}`)
    brollSubtitleUploadPath.value = ''
    await loadBrollSubtitlesStatus()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Import failed')
  } finally {
    subtitlesGenerating.value = false
  }
}

// Load the local Voice Studio Whisper catalog (which models the modal has
// cached + ready). Mirrors the Subtitles workspace's loader: prefer the
// already-selected model, then the modal default, then a recommended/cached one.
async function loadBrollVsAvailability(): Promise<void> {
  brollVsAvailLoading.value = true
  try {
    const a = await get<BrollVsAvail>('/voicestudio/transcribe-availability')
    brollVsAvail.value = a
    const models = a.models || []
    const cached = new Set(models.filter(m => m.cached).map(m => m.repo))
    const pick =
      (brollVsModel.value && models.some(m => m.repo === brollVsModel.value)) ? brollVsModel.value :
      (a.default_model && cached.has(a.default_model)) ? a.default_model! :
      (models.find(m => m.recommended && m.cached)?.repo) ||
      (models.find(m => m.cached)?.repo) ||
      (models.find(m => m.recommended)?.repo) ||
      (models[0]?.repo) || ''
    if (pick) brollVsModel.value = pick
  } catch {
    brollVsAvail.value = { available: false }
  } finally {
    brollVsAvailLoading.value = false
  }
}

async function downloadBrollVsModel(): Promise<void> {
  if (!brollVsModel.value) return
  downloadingBrollModel.value = true
  try {
    await post('/voicestudio/download-model', { repo: brollVsModel.value })
    success('Model download started on the modal — re-checking availability…')
    await loadBrollVsAvailability()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to start model download')
  } finally {
    downloadingBrollModel.value = false
  }
}

// Lazy-load the local-model catalog the first time the user lands on the
// Whisper tab with the local engine selected (and when switching to it).
watch([subtitlesSource, brollWhisperEngine], ([src, eng]) => {
  if (src === 'whisper' && eng === 'voicestudio' && !brollVsAvail.value && !brollVsAvailLoading.value) {
    void loadBrollVsAvailability()
  }
})

async function transcribeBrollWithWhisper(): Promise<void> {
  if (!form.episode_id) return
  subtitlesGenerating.value = true
  try {
    await post(
      `/projects/${slug.value}/video-editor/subtitles/transcribe/${form.episode_id}`,
      {
        language: 'en',
        force: brollWhisperForce.value,
        engine: brollWhisperEngine.value,
        model: brollWhisperEngine.value === 'voicestudio' ? brollVsModel.value : undefined,
      },
    )
    success(
      brollHasExistingWhisperSrt.value && !brollWhisperForce.value
        ? 'Existing transcript will be reused — no transcription run'
        : brollWhisperEngine.value === 'voicestudio'
          ? 'Local Whisper transcription queued — check Jobs panel for progress'
          : 'OpenAI Whisper transcription queued — check Jobs panel for progress',
    )
    // No immediate srt_path set — the transcribe job is async. The user
    // pops back here later (or the status refreshes after the job 'done'
    // event) and the new SRT shows up in the existing-srts list.
    await loadBrollSubtitlesStatus()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to queue transcription')
  } finally {
    subtitlesGenerating.value = false
  }
}

// v1.0.135+ — In-app subtitle delete. Replaces the "delete from Finder"
// fallback in the original v1.0.126 Subtitles section. Confirms first
// because the delete is not undoable from inside the app. Per-filename
// in-flight indicator so multiple deletes can't race (only one button
// shows the spinner at a time; others stay clickable until clicked).
const brollSubtitlesDeletingFilename = ref<string | null>(null)
async function deleteBrollSubtitle(filename: string): Promise<void> {
  if (!form.episode_id || !filename) return
  if (brollSubtitlesDeletingFilename.value) return  // single-flight gate
  const ok = await ask({
    title: `Delete ${filename}?`,
    message: `This removes the file from the episode's subtitles/ folder. ` +
             `If this was the file your next assembly would have burned in, ` +
             `the render will go out with no subtitles until you generate / import another.`,
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return
  brollSubtitlesDeletingFilename.value = filename
  try {
    // Backend returns the fresh existing_srts list so we can swap state
    // in-place without a second GET. Fall back to a full status reload
    // if the response shape ever drifts.
    const r = await del<{ existing_srts: Array<{
      path: string; filename: string; mtime: number
      generated_with_gap_s?: number | null
      drifts_from_current_merge?: boolean
      drift_note?: string
    }>; deleted: string }>(
      `/projects/${slug.value}/video-editor/subtitles/${form.episode_id}/${encodeURIComponent(filename)}`,
    )
    if (subtitlesStatus.value && Array.isArray(r?.existing_srts)) {
      subtitlesStatus.value = { ...subtitlesStatus.value, existing_srts: r.existing_srts }
    } else {
      await loadBrollSubtitlesStatus()
    }
    success(`Deleted ${filename}`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || `Failed to delete ${filename}`)
  } finally {
    brollSubtitlesDeletingFilename.value = null
  }
}

// Refresh status on episode change so the existing-SRT list + condition
// gates (has_chapter_audio / has_merged_audio / has_openai_key) all
// reflect the currently-selected episode.
watch(() => form.episode_id, (newEp, oldEp) => {
  if (newEp !== oldEp) {
    void loadBrollSubtitlesStatus()
    // Clear in-flight + per-episode upload state so a stale path doesn't
    // import into the new episode if the user was mid-flow.
    brollSubtitleUploadPath.value = ''
    brollWhisperForce.value = false
  }
})

// Motion catalogue (UI source — mirrors lib/broll-motion.ts BROLL_MOTIONS).
const motionOptions = [
  { id: 'static',    label: 'Static',        hint: 'No camera move' },
  { id: 'zoom-in',   label: 'Slow Zoom In',  hint: 'Subtle push toward subject' },
  { id: 'zoom-out',  label: 'Slow Zoom Out', hint: 'Subtle pull-back reveal' },
  { id: 'pan-left',  label: 'Pan Left',      hint: 'Drift left' },
  { id: 'pan-right', label: 'Pan Right',     hint: 'Drift right' },
  { id: 'pan-up',    label: 'Pan Up',        hint: 'Drift upward' },
  { id: 'pan-down',  label: 'Pan Down',      hint: 'Drift downward' },
]

// Manual selection state: ordered list of {filename, target_duration}.
const manualSelection = ref<Array<{ filename: string; target_duration: number }>>([])
const manualPoolFilter = ref('')
const narrationTargetSec = ref<number>(0)

function poolDurationFor(filename: string): number {
  return clipsInPool.value.find(c => c.filename === filename)?.duration || 0
}

function addToManualSelection(clip: any): void {
  const dur = Math.min(clip.duration, 15) // default per-clip cap matches rotate-mode default
  manualSelection.value.push({ filename: clip.filename, target_duration: Math.max(0.5, dur) })
}
function reorderManual(idx: number, delta: -1 | 1): void {
  const next = idx + delta
  if (next < 0 || next >= manualSelection.value.length) return
  const a = manualSelection.value[idx]!
  const b = manualSelection.value[next]!
  manualSelection.value[idx] = b
  manualSelection.value[next] = a
}

const filteredManualPool = computed(() => {
  const q = manualPoolFilter.value.trim().toLowerCase()
  if (!q) return clipsInPool.value
  return clipsInPool.value.filter(c =>
    c.filename.toLowerCase().includes(q) ||
    (c.tags || []).some((t: string) => t.toLowerCase().includes(q)),
  )
})

const manualTotalSec = computed(() =>
  manualSelection.value.reduce((s, m) => s + (m.target_duration || 0), 0),
)
const manualCoverageClass = computed(() => {
  if (!narrationTargetSec.value) return 'is-neutral'
  const pct = manualTotalSec.value / narrationTargetSec.value
  if (pct < 0.9) return 'is-short'
  if (pct > 1.2) return 'is-long'
  return 'is-good'
})
const manualCoverageTitle = computed(() => {
  if (!narrationTargetSec.value) return 'Pick an episode to see narration duration'
  const pct = (manualTotalSec.value / narrationTargetSec.value) * 100
  if (pct < 90) return `Sequence is shorter than narration — final video will end at ${formatDuration(manualTotalSec.value)} not ${formatDuration(narrationTargetSec.value)}.`
  if (pct > 120) return `Sequence exceeds narration by ${formatDuration(manualTotalSec.value - narrationTargetSec.value)}. Excess gets trimmed at render time.`
  return `Good coverage — sequence matches narration length.`
})

const matchingClipCount = computed(() => {
  if (form.selection_mode === 'random' || form.selection_mode === 'manual') return clipsInPool.value.length
  const tagSet = new Set(form.tags.map(t => t.toLowerCase()))
  if (!tagSet.size) return 0
  return clipsInPool.value.filter(c => {
    const clipTags = new Set((c.tags || []).map((t: string) => t.toLowerCase()))
    if (form.selection_mode === 'tagged') {
      // ANY match
      for (const t of tagSet) if (clipTags.has(t)) return true
      return false
    }
    // themed = ALL match
    for (const t of tagSet) if (!clipTags.has(t)) return false
    return true
  }).length
})

const selection = ref<Array<{ pool_id: string; filename: string; target_duration: number }>>([])
const selectionDuration = computed(() => selection.value.reduce((s, c) => s + c.target_duration, 0))

const picking = ref(false)
const assembling = ref(false)

// v1.0.307 — keep Assemble disabled for the WHOLE queued render, not just the
// brief enqueue POST that flips `assembling` (see useJobs.isJobActiveFor). The
// /broll/assemble route fires the shared video_assembly job.
const { isJobActiveFor } = useJobs()
const assembleJobActive = computed(() => isJobActiveFor(form.episode_id, ['video_assembly', 'broll_assemble']))

// ── Init ───────────────────────────────────────────────────────────────

async function loadConfig(): Promise<void> {
  try {
    const cfg = await get<any>(`/projects/${slug.value}/settings/config`)
    subscribedPoolId.value = cfg?.broll_pool_id || ''
    form.broll_lookback = cfg?.broll_lookback ?? 10
    // v1.0.127+ — Hydrate persistent subtitle config. Defensive Object.assign
    // so a partial config (missing style or gap_sec) keeps the defaults.
    const saved = cfg?.broll_subtitles
    if (saved && typeof saved === 'object') {
      if (typeof saved.enabled === 'boolean') brollSubtitles.enabled = saved.enabled
      if (typeof saved.gap_sec === 'number' && saved.gap_sec >= 0) brollSubtitles.gap_sec = saved.gap_sec
      if (saved.style && typeof saved.style === 'object') Object.assign(brollSubtitles.style, saved.style)
    }
  } catch { /* tolerate */ }
}

async function loadPoolClips(): Promise<void> {
  if (!subscribedPoolId.value) {
    clipsInPool.value = []
    availableTags.value = []
    return
  }
  try {
    const r = await broll.listClips(subscribedPoolId.value)
    clipsInPool.value = r.clips.filter((c: any) => !c.missing)
    const allTags = new Set<string>()
    for (const c of clipsInPool.value) for (const t of (c.tags || [])) allTags.add(t)
    availableTags.value = Array.from(allTags).sort()
  } catch {
    clipsInPool.value = []
    availableTags.value = []
  }
}

watch(subscribedPoolId, () => { void loadPoolClips() })

onMounted(async () => {
  await broll.loadPools()
  await loadConfig()
  await loadPoolClips()
  // v1.0.121+ — Hydrate presets AFTER loadConfig so an active preset's
  // values overlay the project-level defaults (matches how every other
  // generator page sequences these two). `load()` auto-applies the active
  // preset on mount per the composable's default — see usePresets opts.
  await brollPresets.load()
  // v1.0.126+ — Status drives the libass / chapter-audio / merged-audio /
  // openai-key gates in the new Subtitles section. Loaded after presets
  // so applying a preset doesn't race with the status fetch.
  await loadBrollSubtitlesStatus()
  // v1.0.127+ — Format-aware gap default. If the user has never saved a
  // broll_subtitles.gap_sec (i.e. it's still the hardcoded 5), seed it
  // from the format's audioMergeDefaults.gapDurationSec so the first
  // "Generate SRT from chapters" run produces cues that line up with
  // what audio-merge actually wrote between chapters.
  await loadBrollFormatGapDefault()
  if (brollFormatGapDefault.value !== null && brollSubtitles.gap_sec === 5) {
    brollSubtitles.gap_sec = brollFormatGapDefault.value
  }
})

// ── Pool subscription ──────────────────────────────────────────────────

async function saveSubscription(): Promise<void> {
  try {
    await put(`/projects/${slug.value}/settings/config`, {
      broll_pool_id: subscribedPoolId.value || undefined,
    })
    success(subscribedPoolId.value ? 'Pool subscribed' : 'Pool unsubscribed')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save')
  }
}

// ── Selection (Phase 3 backend) ────────────────────────────────────────

async function pickClips(): Promise<void> {
  if (!subscribedPoolId.value || !form.episode_id || picking.value) return
  // Manual mode requires at least one picked clip on the client.
  if (form.selection_mode === 'manual' && manualSelection.value.length === 0) {
    showError('Manual mode — pick at least one clip in the sequence first.')
    return
  }
  picking.value = true
  try {
    const r = await post<{ selection: typeof selection.value; target_duration?: number; warnings?: string[] }>(
      `/projects/${slug.value}/broll/pick`,
      {
        episode_id: form.episode_id,
        pool_id: subscribedPoolId.value,
        selection_mode: form.selection_mode,
        tags: form.tags,
        pacing_mode: form.pacing_mode,
        segment_seconds: form.segment_seconds,
        broll_lookback: form.broll_lookback,
        broll_volume: form.broll_volume,
        // v1.0.89+ — manual + motion + transition payload
        ...(form.selection_mode === 'manual' ? { manual_selection: manualSelection.value } : {}),
        motion_mode: form.motion_mode,
        motion_default: form.motion_default,
        motion_pool: form.motion_pool.length ? form.motion_pool : ['static'],
        transition_id: form.transition_id,
        transition_duration: form.transition_duration,
      },
    )
    selection.value = r.selection || []
    narrationTargetSec.value = r.target_duration || 0
    if (r.warnings?.length) {
      for (const w of r.warnings) showError(w)
    }
    success(`Selected ${selection.value.length} clip(s) for ${form.episode_id}`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Selection failed')
  } finally {
    picking.value = false
  }
}

// ── Assemble (Phase 3 — fires the existing video_assembly job) ────────

async function assembleVideo(): Promise<void> {
  if (!form.episode_id || assembling.value) return
  assembling.value = true
  try {
    const job = await post<{ job_id: string }>(`/projects/${slug.value}/broll/assemble`, {
      episode_id: form.episode_id,
      pool_id: subscribedPoolId.value,
      broll_volume: form.broll_volume,
      // v1.0.127+ — Subtitle controls. Backend defaults missing fields
      // to enabled=true + no style override (legacy behaviour), so we
      // only need to send what's actually configured. Sending style
      // only when subtitles are enabled keeps the wire payload clean.
      subtitles_enabled: brollSubtitles.enabled,
      ...(brollSubtitles.enabled ? { subtitles_style: brollSubtitles.style } : {}),
    })
    success(`Queued — job ${job.job_id}. Watch progress in the Jobs panel.`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Assembly failed to queue')
  } finally {
    assembling.value = false
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function thumbnailUrl(poolId: string, filename: string): string {
  return broll.thumbnailUrl(poolId, filename)
}

function formatDuration(sec: number): string {
  if (!sec) return '0s'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}
</script>

<style scoped>
.broll-page { display: flex; flex-direction: column; gap: 12px; }
.empty { padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px; background: var(--bg-secondary); border-radius: 6px; }
.empty a { color: var(--accent, #6c8fff); margin-left: 4px; }
.card { padding: 14px 18px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-md, 6px); }
.card h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; }

.pool-picker { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pool-picker label { font-size: 12px; color: var(--text-muted); }

.offline-banner {
  padding: 8px 12px;
  background: rgba(245, 158, 11, 0.10);
  border: 1px solid rgba(245, 158, 11, 0.30);
  color: rgb(180, 120, 8);
  border-radius: 4px;
  font-size: 12px;
}
.offline-banner code { background: rgba(0,0,0,0.10); padding: 1px 5px; border-radius: 3px; font-family: var(--font-mono, monospace); }

.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.form-group { display: flex; flex-direction: column; gap: 4px; }
.form-group label { font-size: 12px; color: var(--text-primary); }
.form-group .hint { font-size: 11px; color: var(--text-muted); line-height: 1.4; }

.radio-row, .checkbox-row { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.checkbox-row label { display: flex; align-items: center; gap: 6px; }
.input-sm { padding: 3px 6px; font-size: 12px; }
.input-inline { display: inline-block; width: 60px; margin: 0 4px; }

.volume-row { display: flex; align-items: center; gap: 8px; }
.volume-slider { flex: 1; }
.volume-value { font-family: var(--font-mono, monospace); font-size: 12px; min-width: 40px; text-align: right; }

.sequence-row {
  display: flex; flex-wrap: wrap; gap: 6px;
}
.seq-tile {
  position: relative;
  width: 120px; height: 67px;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
  background: var(--bg-tertiary);
}
.seq-thumb { width: 100%; height: 100%; object-fit: cover; }
.seq-idx {
  position: absolute; top: 2px; left: 4px;
  background: rgba(0,0,0,0.65); color: #fff;
  padding: 1px 5px; border-radius: 3px; font-size: 10px;
  font-family: var(--font-mono, monospace);
}
.seq-duration {
  position: absolute; bottom: 2px; right: 4px;
  background: rgba(0,0,0,0.65); color: #fff;
  padding: 1px 5px; border-radius: 3px; font-size: 10px;
  font-family: var(--font-mono, monospace);
}

.seq-actions { display: flex; gap: 8px; }

/* ── Manual selection grid + sequence list ───────────────────────── */
.manual-layout {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 8px;
}
.manual-pool, .manual-sequence {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px;
  background: var(--bg-tertiary);
  min-height: 240px;
  max-height: 500px;
  overflow: auto;
}
.manual-pool-header, .manual-sequence-header {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font-size: 12px; font-weight: 600; margin-bottom: 8px;
}
.manual-pool-header .input-sm { width: 160px; }
.manual-pool-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;
}
.manual-tile {
  position: relative;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0; overflow: hidden;
  cursor: pointer;
  font: inherit; text-align: left; color: inherit;
  display: flex; flex-direction: column;
}
.manual-tile:hover { border-color: var(--accent, #6c8fff); }
.manual-tile.used { opacity: 0.6; border-style: dashed; }
.manual-thumb { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; display: block; }
.manual-tile-name {
  padding: 3px 5px 0;
  font-size: 9px; line-height: 1.2;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text-primary);
}
.manual-tile-dur {
  padding: 0 5px 3px;
  font-size: 9px; color: var(--text-muted);
  font-family: var(--font-mono, monospace);
}
.manual-tile-badge {
  position: absolute; top: 4px; right: 4px;
  background: rgba(34,197,94,0.85); color: #fff;
  padding: 1px 5px; border-radius: 3px; font-size: 9px; font-weight: 600;
}

.manual-empty {
  padding: 24px 8px; text-align: center;
  font-size: 12px; color: var(--text-muted);
}
.manual-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
.manual-row {
  display: flex; gap: 8px; align-items: center;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px;
}
.manual-row-thumb { width: 60px; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 3px; flex-shrink: 0; }
.manual-row-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.manual-row-name { font-size: 11px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.manual-row-controls { display: flex; align-items: center; gap: 4px; }
.manual-row-actions { display: flex; gap: 2px; flex-direction: column; }
.manual-row-actions .btn { padding: 1px 6px; font-size: 11px; }

.manual-total-pill {
  font-size: 11px; padding: 2px 8px; border-radius: 10px;
  font-family: var(--font-mono, monospace);
}
.manual-total-pill.is-short { background: rgba(245, 158, 11, 0.12); color: rgb(180, 120, 8); }
.manual-total-pill.is-good  { background: rgba(34, 197, 94, 0.12); color: rgb(21, 128, 61); }
.manual-total-pill.is-long  { background: rgba(108, 143, 255, 0.12); color: var(--accent, #6c8fff); }
.manual-total-pill.is-neutral { background: var(--bg-tertiary); color: var(--text-muted); }

/* ── Motion pool chip picker ──────────────────────────────────────── */
.motion-pool-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 4px;
}
.motion-pool-chip {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 8px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 12px;
  font-size: 11px;
  cursor: pointer;
}
.motion-pool-chip.active { background: rgba(108, 143, 255, 0.12); border-color: var(--accent, #6c8fff); color: var(--accent, #6c8fff); font-weight: 600; }
.motion-pool-chip input { margin: 0; }

.select-sm { font-size: 12px; padding: 3px 6px; }

/* v1.0.126+ — Subtitle file list inside the new Subtitles section.
   Tight spacing so multiple files don't dominate the section. The
   filename is monospace so SRT/ASS/VTT extensions read clearly. */
.broll-srt-list {
  margin: 6px 0 8px;
  padding-left: 0;
  list-style: none;
}
.broll-srt-list li {
  margin: 2px 0;
  line-height: 1.45;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
/* v1.0.396 — burn-target selection (Auto + per-file radios). */
.broll-srt-auto {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0 2px;
  cursor: pointer;
  flex-wrap: wrap;
}
.broll-srt-radio { flex: 0 0 auto; cursor: pointer; }
.broll-srt-pinned {
  font-size: 11px;
  color: #5bb37c;
  font-weight: 600;
}
.broll-srt-list code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--text-primary);
}
/* v1.0.135+ — In-line delete button on each subtitle row. Sized to
   match the surrounding text + spinner so the row doesn't jump when
   the click flips it to ⏳. The danger hover is opt-in (not the
   default state) so the row reads as informational. */
.broll-srt-del {
  margin-left: 8px;
  padding: 0 6px;
  font-size: 12px;
  line-height: 1;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
}
.broll-srt-del:hover:not(:disabled) {
  color: #e25c5c;
  border-color: rgba(226, 92, 92, 0.4);
  background: rgba(226, 92, 92, 0.08);
}
.broll-srt-del:disabled { opacity: 0.6; cursor: default; }

/* v1.0.140+ — Drift warning chip on subtitle rows where the SRT was
   derived against a different audio-merge gap than the current one.
   Yellow-tinted so it reads as "needs attention" without being a
   hard error — the SRT still burns; it just drifts visibly. Hover
   shows the full explanation from drift_note. */
.broll-srt-drift {
  margin-left: 8px;
  padding: 0 6px;
  font-size: 11px;
  color: #d4a017;
  background: rgba(212, 160, 23, 0.10);
  border: 1px solid rgba(212, 160, 23, 0.35);
  border-radius: 3px;
  cursor: help;
}
.validation-msg {
  color: #c97a4a;
  background: rgba(201, 122, 74, 0.08);
  border: 1px solid rgba(201, 122, 74, 0.25);
  border-radius: 4px;
  padding: 6px 10px;
}
</style>
