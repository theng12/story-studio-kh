<template>
  <div class="workspace-page audio-assembly-workspace">
    <WorkspaceHero
      eyebrow="Assembly · Sound"
      title="Audio Assembly"
      description="Build one narration master from chapter audio, then layer the opening, music, ambience, silence, and ducking in a predictable order."
    />
    <TopActionBar
      :project-slug="slug"
      :presets="mergePresets"
      v-model:episode-id="episodeId"
      filter-field="merged_audio"
      :generate-label="generateLabel"
      :show-generate="false"
      @episode-selected="onEpisodeSelected"
      @preset-applied="onPresetApplied"
      @preset-saved="onPresetSaved"
    >
      <template #actions>
        <EpisodeImportButton
          :slug="slug"
          :episode-code="episodeId"
          default-tab="merged"
          @imported="refreshMergeStatus"
        />
      </template>
    </TopActionBar>

    <section v-if="episodeId" class="audio-assembly-action-bar" aria-label="Audio Assembly merge actions">
      <div class="audio-assembly-action-context">
        <span class="audio-context-item">
          <small>Episode</small>
          <strong>{{ selectedEpisode?.title || episodeId }}</strong>
        </span>
        <span class="audio-context-item">
          <small>Narration</small>
          <strong>{{ !scannedAssets || scanning ? 'Checking chapters…' : chapters.length ? `${chapterCount} chapter${chapterCount === 1 ? '' : 's'}` : 'No chapters ready' }}</strong>
        </span>
        <span class="audio-context-item">
          <small>Current merge</small>
          <strong :title="existingMergedAudio?.path || ''">
            {{ !scannedAssets || mergeStatus.loading ? 'Checking…' : mergeStatus.error ? 'Unavailable' : existingMergedAudio ? `${existingMergedAudio.path.split('/').pop()} · ${formatDuration(existingMergedAudio.duration)}` : 'None yet' }}
          </strong>
        </span>
      </div>

      <div class="audio-assembly-action-controls">
        <label class="audio-output-choice">
          <span>Output</span>
          <select
            v-model="writeMode"
            class="select select-sm"
            :disabled="mergeStatus.loading || !!mergeStatus.error || generating || mergeJobActiveForEpisode"
          >
            <option value="overwrite">
              {{ existingMergedAudio ? 'Replace existing merge' : 'Create merged audio' }}
            </option>
            <option value="new" :disabled="!existingMergedAudio">
              Create another version{{ existingMergedAudio ? ` (${nextVersionName.split('/').pop()})` : '' }}
            </option>
          </select>
        </label>
        <button
          v-if="existingMergedAudio"
          type="button"
          class="btn btn-ghost"
          @click="togglePreview(existingMergedAudio.path)"
        >{{ playingPath === existingMergedAudio.path ? 'Stop Preview' : 'Preview Current' }}</button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="!chapterAudioReady || mergeStatus.loading || !!mergeStatus.error || generating || mergeJobActiveForEpisode || musicChoiceMissing"
          @click="onGenerateClick"
        >{{ generating || mergeJobActiveForEpisode ? 'Merging…' : generateLabel }}</button>
      </div>

      <p class="audio-assembly-action-summary" role="status">
        <template v-if="mergeStatus.loading">
          Checking which merged file is current before enabling the action.
        </template>
        <template v-else-if="mergeStatus.error">
          Current merge status is unavailable.
          <button type="button" class="btn btn-sm btn-ghost" @click="refreshMergeStatus">Retry</button>
        </template>
        <template v-else-if="generating || mergeJobActiveForEpisode">
          Merging audio for {{ selectedEpisode?.title || episodeId }}…
        </template>
        <template v-else-if="musicChoiceMissing">
          Background Music is on, but no track is chosen for this episode. Pick a file under Background Music,
          switch to Music Pool, or turn music off.
        </template>
        <template v-else-if="writeMode === 'new' && existingMergedAudio">
          Keeps the current merge and writes {{ nextVersionName.split('/').pop() }} beside it.
        </template>
        <template v-else-if="existingMergedAudio">
          Replaces {{ existingMergedAudio.path.split('/').pop() }} with the next merge.
        </template>
        <template v-else>
          Creates this episode's first merged audio file.
        </template>
      </p>
    </section>

    <WorkspaceNotice class="mt-2" title="Fixed mixing order" tone="info">
      Intro → narration with music ducked underneath → ambience layered throughout. Reorder chapters and tune silence below.
    </WorkspaceNotice>

    <!-- FFmpeg Status -->
    <div class="ffmpeg-status mt-2" v-if="ffmpegStatus">
      <span v-if="ffmpegStatus.installed" class="badge badge-success">
        FFmpeg installed{{ ffmpegStatus.version ? ` (v${ffmpegStatus.version})` : '' }}
      </span>
      <template v-else>
        <span class="badge badge-error">FFmpeg not found</span>
        <!-- Audio merge depends on FFmpeg for the chapter concat + music
             mix step. When it's missing, give the user a one-tap path to
             the Settings → FFmpeg tab where the auto-installer lives,
             instead of leaving them with just an error badge. -->
        <NuxtLink :to="`/projects/${slug}/settings#ffmpeg`" class="btn btn-sm btn-primary ffmpeg-install-link">
          Install FFmpeg →
        </NuxtLink>
        <span class="text-muted text-xs ffmpeg-install-hint">
          One-click installer in Settings · no admin needed
        </span>
      </template>
    </div>

    <div
      v-if="episodeId && scannedAssets && !scanning && chapters.length && !chapterAudioReady"
      class="card mt-2 no-audio-warning"
    >
      <div class="warning-icon">⚠️</div>
      <div class="warning-body">
        <h3 class="warning-title">Audio Assembly is waiting for every chapter</h3>
        <p class="text-muted mt-1">
          {{ chapterAudioIssues.join(' ') }}
        </p>
        <div class="flex gap-2 mt-2">
          <NuxtLink :to="`/projects/${slug}/audio?episode_id=${encodeURIComponent(episodeId)}`" class="btn btn-primary btn-sm">
            Repair Missing Audio →
          </NuxtLink>
          <button class="btn btn-sm btn-secondary" @click="scanAssets" :disabled="scanning">
            Re-scan
          </button>
        </div>
      </div>
    </div>

    <!-- Apply-time path-check banner. Missing linked files are shown in a
         red actionable list with the form's existing Browse handlers.
         Cleared automatically when every invalid path has been replaced
         (or when the user picks a different preset). -->
    <div
      v-if="presetInvalidPaths.length > 0"
      class="card mt-2 preset-path-check"
      :class="{ 'is-critical': presetInvalidPaths.length > 0 }"
    >
      <div v-if="presetInvalidPaths.length > 0" class="path-check-invalid-block">
        <div class="path-check-title">
          <span aria-hidden="true">📂</span>
          {{ presetInvalidPaths.length }} linked
          {{ presetInvalidPaths.length === 1 ? 'file is' : 'files are' }}
          missing on this Mac
        </div>
        <div class="path-check-hint text-muted">
          Use <strong>Pick replacement</strong> to choose a local file for each, or open the
          relevant section below to remove/disable the entry.
        </div>
        <ul class="path-check-list">
          <li
            v-for="(row, i) in presetInvalidPaths"
            :key="`${row.key}-${row.index}-${i}`"
            class="path-check-row"
          >
            <span class="path-check-field">{{ pathFieldLabel(row.key) }}</span>
            <code class="path-check-value" :title="row.value">{{ shortenPath(row.value) }}</code>
            <span class="path-check-reason text-muted">{{ row.reason }}</span>
            <button
              class="btn btn-sm btn-secondary"
              @click="repickInvalidPath(row)"
            >Pick Replacement…</button>
          </li>
        </ul>
      </div>
    </div>

    <div v-if="scanning" class="card mt-2 scanning-status">
      <span class="gen-label">Scanning audio assets...</span>
      <div class="progress-bar mt-1"><div class="progress-fill" /></div>
    </div>

    <!-- Missing narration audio — can't merge without it. Surface loudly with -->
    <!-- a one-click route to the Audio Generator so the user doesn't have to -->
    <!-- guess the next step. -->
    <div v-if="episodeId && scannedAssets && !scanning && !chapters.length" class="card mt-2 no-audio-warning">
      <div class="warning-icon">⚠️</div>
      <div class="warning-body">
        <h3 class="warning-title">No narration audio for this episode</h3>
        <p class="text-muted mt-1">
          Audio Assembly merges chapter narration with music + ambience. You need to generate the chapter audio first —
          there's nothing to merge yet for {{ selectedEpisode?.title || episodeId }}.
        </p>
        <div class="flex gap-2 mt-2">
          <NuxtLink :to="`/projects/${slug}/audio?episode_id=${encodeURIComponent(episodeId)}`" class="btn btn-primary btn-sm">
            Go to Audio Generator →
          </NuxtLink>
          <button class="btn btn-sm btn-secondary" @click="scanAssets" :disabled="scanning">
            Re-scan
          </button>
        </div>
      </div>
    </div>

    <!-- Chapter Management -->
    <div v-if="scannedAssets && !scanning && chapters.length" class="card mt-2">
      <h3>Narration Chapters</h3>
      <p class="text-muted mt-1">
        Drag the ▲▼ arrows to reorder chapters. The intro clip (if enabled) always plays first — reordering chapters
        doesn't change intro timing. The silence gap below is inserted between every chapter, but not before the first.
      </p>

      <div v-if="chapters.length" class="audio-list-reorder mt-2">
        <div v-for="(ch, i) in chapters" :key="ch.path" class="audio-item-reorder">
          <span class="audio-order-num">{{ i + 1 }}</span>
          <button class="btn-icon play-btn" @click="togglePreview(ch.path)" :title="playingPath === ch.path ? 'Stop' : 'Play'">
            {{ playingPath === ch.path ? '&#9724;' : '&#9654;' }}
          </button>
          <span class="audio-name">{{ ch.label || ch.filename }}</span>
          <span class="text-muted text-sm audio-duration">{{ formatDuration(ch.duration) }}</span>
          <div class="audio-reorder-btns">
            <button class="btn-icon" :disabled="i === 0" @click="moveChapter(i, -1)" title="Move up">&#9650;</button>
            <button class="btn-icon" :disabled="i === chapters.length - 1" @click="moveChapter(i, 1)" title="Move down">&#9660;</button>
          </div>
        </div>
      </div>

      <!-- Gap Duration -->
      <div class="form-group mt-2 gap-duration-field">
        <label>Pause between chapters ({{ gapDuration }} s)</label>
        <SliderWithNumber v-model="gapDuration" :min="0" :max="30" :step="0.5" suffix="s" />
        <span class="text-muted text-xs">
          Quiet seconds after each chapter (Introduction → Chapter 1 → Chapter 2 …).
          <template v-if="formulaGapSec !== null">Your Series Formula suggests {{ formulaGapSec }} s.</template>
          Pauses inside a chapter follow the text on their own.
        </span>
      </div>

      <!-- v1.0.317 — Per-chunk pause. Only useful when at least one chapter
           was split into _part1/_part2/... files (long chapters at the TTS
           chunk cap). Default 0 = back-to-back concat (legacy behaviour);
           0.3-1s lets cloud TTS chunks "breathe" at the chunker boundary so
           the narration doesn't sound rushed mid-sentence. -->
      <div class="form-group mt-2 gap-duration-field" v-if="hasMultiPartChapters">
        <label>Per-chunk pause ({{ chunkSilenceSec.toFixed(1) }}s)</label>
        <SliderWithNumber v-model="chunkSilenceSec" :min="0" :max="3" :step="0.1" suffix="s" />
        <span class="text-muted text-xs">
          Inserted between parts of the SAME chapter ({{ chunkTransitionsTotal }} transition{{ chunkTransitionsTotal === 1 ? '' : 's' }} in this episode). Cloud TTS chunks end mid-breath — back-to-back can sound rushed. Try <strong>0.3-1s</strong> for a more natural rhythm. Leave at 0 to keep current behavior.
        </span>
      </div>

      <!-- Total Duration -->
      <div class="summary-bar mt-2" v-if="chapters.length">
        Total narration: {{ formatDuration(totalChapterDuration) }}
        + {{ chapterGapSecondsTotal }}s chapter gaps
        <template v-if="chunkSilenceSec > 0 && chunkTransitionsTotal > 0">
          + {{ chunkPauseSecondsTotal.toFixed(1) }}s chunk pauses
        </template>
        = {{ formatDuration(estimatedMergedDuration) }}
      </div>
    </div>

    <!-- Mix settings stay visible: the usual narration controls should not
         be hidden behind an "advanced" gate. Optional layers reveal their
         controls only when enabled, keeping the default surface compact. -->
    <section v-if="chapters.length" class="card mt-2 audio-mix-card">
      <header class="audio-mix-header">
        <div>
          <span class="workspace-section-kicker">Mix settings</span>
          <h3>Voice, pacing, and optional layers</h3>
          <p class="text-muted text-sm">Start with the narration, then add only the layers this episode needs.</p>
        </div>
        <div class="audio-mix-states" aria-label="Current mix settings">
          <span class="audio-mix-state">Voice {{ narrationVolume }}%</span>
          <span class="audio-mix-state" :class="{ active: normalizeVolume }">Normalize {{ normalizeVolume ? 'on' : 'off' }}</span>
          <span class="audio-mix-state" :class="{ active: music.enabled }">Music {{ music.enabled ? 'on' : 'off' }}</span>
          <span class="audio-mix-state" :class="{ active: backgroundNoise.enabled || ambientTracks.length > 0 }">Atmosphere {{ backgroundNoise.enabled || ambientTracks.length ? 'on' : 'off' }}</span>
        </div>
      </header>

    <!-- A standalone opening is distinct from the music lead-in below: this
         accepts a dedicated jingle, spoken tag, or any other clip. -->
    <div class="audio-mix-section audio-mix-section--intro">
      <div class="flex gap-2 items-center">
        <label class="checkbox-label" @click.stop>
          <input type="checkbox" v-model="intro.enabled" />
        </label>
        <h3>Standalone intro clip</h3>
      </div>
      <p class="text-muted text-sm mt-1">
        Optional jingle, spoken tag, or dedicated opening clip. To open with the first seconds of the selected music track instead, use <strong>Music lead-in</strong> below.
      </p>

      <div v-if="intro.enabled" class="mt-2">
        <div class="flex gap-2">
          <input v-model="intro.file" class="input flex-1" placeholder="Path to intro audio file" />
          <button class="btn btn-sm btn-secondary" @click="browseIntroFile">Browse…</button>
          <button v-if="intro.file"
            :class="['btn btn-sm', playingPath === intro.file ? 'btn-primary' : 'btn-secondary']"
            @click="togglePreview(intro.file)">
            {{ playingPath === intro.file ? 'Stop' : 'Preview' }}
          </button>
        </div>

        <div class="grid-2 mt-2">
          <div class="form-group">
            <label>Volume ({{ intro.volume }}%)</label>
            <SliderWithNumber v-model="intro.volume" :min="0" :max="100" :step="1" suffix="%" />
          </div>
          <div class="form-group">
            <label>Gap after intro ({{ intro.gap_after }}s)</label>
            <SliderWithNumber v-model="intro.gap_after" :min="0" :max="10" :step="0.5" :decimals="1" suffix="s" />
          </div>
        </div>
      </div>
    </div>

    <!-- The voice controls are one compact group: gain and normalization are
         both choices about the narration master, not two unrelated panels. -->
    <div class="audio-mix-section audio-mix-section--voice">
      <div class="audio-mix-section-heading">
        <div>
          <h3>Narration</h3>
          <p class="text-muted text-sm">Set the voice level, then normalize it for an even result across chapters.</p>
        </div>
        <label class="compact-toggle" @click.stop>
          <input type="checkbox" v-model="normalizeVolume" />
          <span>Normalize</span>
        </label>
      </div>
      <div class="form-group mt-2">
        <label>Level ({{ narrationVolume }}%)</label>
        <SliderWithNumber v-model="narrationVolume" :min="50" :max="200" :step="5" suffix="%" />
        <p class="text-muted text-sm mt-1">
          <template v-if="narrationVolume === 100">100% = original recorded level (unchanged).</template>
          <template v-else-if="narrationVolume > 100">
            Boosting voiceover to {{ (narrationVolume / 100).toFixed(2) }}× louder.<template v-if="narrationVolume > 130 && !normalizeVolume"> <strong>⚠ Above 130% without normalization can clip</strong> — turn on Normalize above for a safe, even level.</template>
          </template>
          <template v-else>Lowering voiceover to {{ (narrationVolume / 100).toFixed(2) }}× of the recorded level.</template>
          Applied on top of normalization if that's also on.
        </p>
      </div>
      <p v-if="normalizeVolume" class="text-muted text-sm mt-1">
        Uses a two-pass EBU R128 measurement, then applies corrections. It adds processing time but keeps chapter loudness consistent.
      </p>
    </div>

    <!-- Background Music -->
    <div class="audio-mix-section audio-mix-section--music">
      <div class="flex gap-2 items-center">
        <label class="checkbox-label" @click.stop>
          <input type="checkbox" v-model="music.enabled" />
        </label>
        <h3>Background Music</h3>
      </div>
      <p class="text-muted text-sm mt-1">
        Loops one or more music files under the narration. The post-narration volume kicks in once the last chapter ends, in case you want music to swell or fade out.
      </p>

      <div v-if="music.enabled" class="music-source-switch mt-2" role="radiogroup" aria-label="Background music source">
        <button
          type="button"
          :class="['music-source-option', { active: music.source === 'pool' }]"
          role="radio"
          :aria-checked="music.source === 'pool'"
          @click="setMusicSource('pool')"
        >
          <strong>Music Pool</strong>
          <span>Automatically choose one eligible channel track</span>
        </button>
        <button
          type="button"
          :class="['music-source-option', { active: music.source === 'manual' }]"
          role="radio"
          :aria-checked="music.source === 'manual'"
          @click="setMusicSource('manual')"
        >
          <strong>Choose for this episode</strong>
          <span>Use only the file or playlist selected below</span>
        </button>
      </div>

      <!-- The pool and the episode-specific playlist are intentionally
           exclusive sources. A pool pick never gets mixed with stale manual
           files from a previous episode. -->
      <MusicPoolPanel
        v-if="music.enabled && music.source === 'pool'"
        ref="musicPoolPanelRef"
        :project-slug="slug"
        :default-volumes="{
          volume: music.volume,
          post_narration_volume: music.post_narration_volume,
          fade_in: music.fade_in,
          fade_out: music.fade_out,
        }"
        @pool-changed="onPoolChanged"
      />

      <!-- Auto-pick banner: shows when the cycler chose this episode's -->
      <!-- track, with controls to swap or skip. -->
      <div v-if="music.enabled && music.source === 'pool' && poolPickedTrack" class="pool-pick-banner mt-2">
        <div class="ppb-icon" aria-hidden="true">🎶</div>
        <div class="ppb-text">
          <strong>Auto-picked from pool:</strong>
          <span class="ppb-track">{{ poolPickedTrack }}</span>
          <span v-if="poolPickedReason" class="text-muted ppb-reason">— {{ poolPickedReason }}</span>
        </div>
        <button
          type="button"
          class="link-btn ppb-action"
          @click="refreshPoolPeek"
          :disabled="poolPeekLoading"
        >Refresh</button>
        <button
          type="button"
          class="link-btn ppb-action"
          @click="clearPoolPick"
        >Skip — Use No Music</button>
      </div>

      <p v-else-if="music.enabled && music.source === 'pool' && !poolPeekLoading" class="text-muted text-sm mt-2">
        No eligible pool track is ready for this episode. Add or enable one in the Music Pool, or choose a file for this episode instead.
      </p>

      <div v-if="music.enabled && music.source === 'manual'" class="mt-2">
        <!-- Music File List with Play Buttons. The full path is shown on
             each row (filename in primary text, directory dimmed below)
             so the user can tell at a glance where each file lives —
             same transparency as the Intro Audio path input above. -->
        <div v-if="music.files.length" class="music-file-list">
          <div v-for="(file, i) in music.files" :key="i" class="music-file-item" :title="file">
            <button class="btn-icon play-btn" @click="togglePreview(file)" :title="playingPath === file ? 'Stop' : 'Preview'">
              {{ playingPath === file ? '&#9724;' : '&#9654;' }}
            </button>
            <div class="music-file-path">
              <div class="music-filename">{{ file.split('/').pop() }}</div>
              <div class="music-dir text-muted">{{ file.split('/').slice(0, -1).join('/') || '/' }}</div>
            </div>
            <button class="btn-icon danger" @click="music.files.splice(i, 1)" title="Remove">&#10005;</button>
          </div>
        </div>
        <p v-else class="text-muted text-sm">No music files added yet</p>

        <!-- Add music file -->
        <div class="flex gap-2 mt-1">
          <input v-model="newMusicPath" class="input flex-1" placeholder="Path to audio file" />
          <button class="btn btn-sm btn-secondary" @click="browseMusicFile">Browse…</button>
          <button class="btn btn-sm btn-secondary" @click="addMusicFile" :disabled="!newMusicPath">Add</button>
        </div>

        <!-- Quick-add from scanned files. Hover any chip to see the full
             source path — useful when the project has multiple music
             folders or files with similar names across them. -->
        <div v-if="scannedMusicFiles.length" class="quick-add-music mt-1">
          <span class="text-muted text-xs">Found in channel:</span>
          <div class="flex gap-2 mt-1 flex-wrap">
            <button v-for="mf in scannedMusicFiles" :key="mf.path"
              class="btn btn-sm btn-secondary"
              :title="mf.path"
              :disabled="music.files.includes(mf.path)"
              @click="addScannedMusicFile(mf.path)">
              + {{ mf.filename }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="music.enabled && hasSelectedMusic" class="mt-2">
        <!-- Levels apply to whichever single source is selected above. -->
        <div class="grid-2 mt-2">
          <div class="form-group">
            <label>Volume During Narration ({{ music.volume }}%)</label>
            <SliderWithNumber v-model="music.volume" :min="0" :max="100" :step="1" suffix="%" />
          </div>
          <div class="form-group">
            <label>Volume After Narration ({{ music.post_narration_volume }}%)</label>
            <SliderWithNumber v-model="music.post_narration_volume" :min="0" :max="100" :step="1" suffix="%" />
          </div>
        </div>
        <p class="text-muted text-sm" data-testid="music-level-hint">
          Every music track is first brought to one steady level, so the percentage is the music's level next to the
          voice: 100% is as loud as the narration, {{ music.volume }}% is about
          {{ music.volume > 0 ? Math.round(-20 * Math.log10(music.volume / 100)) : '∞' }} dB under it. 11% (about 19 dB under) keeps a
          sleep or documentary bed clearly beneath the voice. Tracks join with crossfades and the music fades in and out.
        </p>
        <div class="grid-2 mt-1">
          <div class="form-group">
            <label>Fade In ({{ music.fade_in }}s)</label>
            <SliderWithNumber v-model="music.fade_in" :min="0" :max="10" :step="0.5" :decimals="1" suffix="s" />
          </div>
          <div class="form-group">
            <label>Fade Out ({{ music.fade_out }}s)</label>
            <SliderWithNumber v-model="music.fade_out" :min="0" :max="10" :step="0.5" :decimals="1" suffix="s" />
          </div>
        </div>

        <!-- Music lead-in uses the selected music track, unlike the
             standalone intro clip above. Both are available deliberately:
             use this for one continuous music bed; use the standalone clip
             for a separate jingle or spoken tag. -->
        <div class="lead-in-block mt-2">
          <label class="checkbox-label" @click.stop>
            <input type="checkbox" v-model="music.lead_in_enabled" />
            <span>Music lead-in</span>
          </label>
          <p class="hint" style="margin: 4px 0 0;">
            Plays this track at <strong>100%</strong> for the chosen time, then ducks to
            <strong>{{ music.volume }}%</strong> as the voiceover begins — the voice is delayed by
            that long. This is not a separate intro clip.
          </p>
          <div v-if="music.lead_in_enabled" class="form-group mt-2">
            <label>Intro length ({{ music.lead_in_seconds }}s of full-volume music before the voice)</label>
            <SliderWithNumber v-model="music.lead_in_seconds" :min="2" :max="30" :step="1" suffix="s" />
          </div>
        </div>
      </div>
    </div>

    <!-- Background Noise -->
    <div class="audio-mix-section audio-mix-section--atmosphere">
      <div class="flex gap-2 items-center">
        <label class="checkbox-label" @click.stop>
          <input type="checkbox" v-model="backgroundNoise.enabled" />
        </label>
        <h3>Background Noise / Ambience</h3>
      </div>
      <p class="text-muted text-sm mt-1">
        Subtle bed of ambience (rain, fire, wind, or your own audio file) that plays under the whole episode for atmosphere.
      </p>

      <div v-if="backgroundNoise.enabled" class="mt-2">
        <div class="flex gap-2 mt-1">
          <button
            :class="['btn btn-sm', backgroundNoise.mode === 'preset' ? 'btn-primary' : 'btn-secondary']"
            @click="backgroundNoise.mode = 'preset'"
          >Built-in Sounds</button>
          <button
            :class="['btn btn-sm', backgroundNoise.mode === 'custom' ? 'btn-primary' : 'btn-secondary']"
            @click="backgroundNoise.mode = 'custom'"
          >Custom File</button>
        </div>

        <!-- Preset selector -->
        <div v-if="backgroundNoise.mode === 'preset'" class="mt-2">
          <div class="noise-preset-grid">
            <div v-for="np in noisePresets" :key="np.id"
              :class="['noise-preset-card', { active: backgroundNoise.preset === np.id }]"
              @click="backgroundNoise.preset = np.id">
              <span class="np-name">{{ np.label }}</span>
              <span class="np-desc">{{ np.description }}</span>
            </div>
          </div>
        </div>

        <!-- Custom file -->
        <div v-if="backgroundNoise.mode === 'custom'" class="mt-2">
          <div class="flex gap-2">
            <input v-model="backgroundNoise.custom_file" class="input flex-1" placeholder="Path to ambience audio file" />
            <button class="btn btn-sm btn-secondary" @click="browseNoiseFile">Browse…</button>
            <button v-if="backgroundNoise.custom_file"
              :class="['btn btn-sm', playingPath === backgroundNoise.custom_file ? 'btn-primary' : 'btn-secondary']"
              @click="togglePreview(backgroundNoise.custom_file)">
              {{ playingPath === backgroundNoise.custom_file ? 'Stop' : 'Preview' }}
            </button>
          </div>
        </div>

        <!-- Volume -->
        <div class="grid-3 mt-2">
          <div class="form-group">
            <label>Volume ({{ backgroundNoise.volume }}%)</label>
            <SliderWithNumber v-model="backgroundNoise.volume" :min="0" :max="100" :step="1" suffix="%" />
          </div>
          <div class="form-group">
            <label>Fade In ({{ backgroundNoise.fade_in }}s)</label>
            <SliderWithNumber v-model="backgroundNoise.fade_in" :min="0" :max="10" :step="0.5" :decimals="1" suffix="s" />
          </div>
          <div class="form-group">
            <label>Fade Out ({{ backgroundNoise.fade_out }}s)</label>
            <SliderWithNumber v-model="backgroundNoise.fade_out" :min="0" :max="10" :step="0.5" :decimals="1" suffix="s" />
          </div>
        </div>
      </div>
    </div>

    <!-- Multi-track ambient layers (v1.0.55+) -->
    <div class="ambient-layers-panel">
      <div class="flex gap-2 items-center">
        <h3 style="margin: 0;">Ambient Layers</h3>
        <span class="text-muted text-xs">
          ({{ ambientTracks.length }} layer{{ ambientTracks.length === 1 ? '' : 's' }})
        </span>
      </div>
      <p class="text-muted text-sm mt-1">
        Stack any number of ambient loops (rain, fire crackle, distant thunder, wind) — each plays
        <strong>simultaneously at its own volume</strong> alongside narration, music, and background noise.
        Different from <em>Background Music</em> above (which plays its files one after another as a single bed).
        Drop sources into the channel's <code>ambient/</code> folder, then click <strong>+ Add Track</strong>.
      </p>

      <div v-if="ambientTracks.length" class="mt-2" style="display: flex; flex-direction: column; gap: 8px;">
        <div
          v-for="(track, idx) in ambientTracks"
          :key="track.id"
          class="card"
          :style="`padding: 10px; border-left: 3px solid ${track.enabled ? 'var(--accent)' : 'var(--border)'}`"
        >
          <div class="flex gap-2 items-center" style="flex-wrap: wrap;">
            <label class="checkbox-label" @click.stop>
              <input type="checkbox" v-model="track.enabled" />
            </label>
            <strong style="flex: 1; word-break: break-all;">
              {{ track.source_filename || track.source_path.split('/').pop() || '(no file)' }}
            </strong>
            <span class="text-muted text-xs">#{{ idx + 1 }}</span>
            <button
              type="button"
              class="btn btn-sm btn-secondary"
              :disabled="idx === 0"
              title="Move up (rendered first in the stack)"
              @click="moveAmbientTrack(track.id, -1)"
            >↑</button>
            <button
              type="button"
              class="btn btn-sm btn-secondary"
              :disabled="idx === ambientTracks.length - 1"
              title="Move down"
              @click="moveAmbientTrack(track.id, 1)"
            >↓</button>
            <button
              type="button"
              class="btn btn-sm btn-danger"
              title="Remove this layer"
              @click="removeAmbientTrack(track.id)"
            >✕</button>
          </div>

          <div v-if="track.enabled" class="grid-3 mt-1">
            <div class="form-group">
              <label>Volume ({{ track.volume }}%)</label>
              <SliderWithNumber v-model="track.volume" :min="0" :max="100" :step="1" suffix="%" />
            </div>
            <div class="form-group">
              <label>Fade In ({{ track.fade_in }}s)</label>
              <SliderWithNumber v-model="track.fade_in" :min="0" :max="10" :step="0.5" :decimals="1" suffix="s" />
            </div>
            <div class="form-group">
              <label>Fade Out ({{ track.fade_out }}s)</label>
              <SliderWithNumber v-model="track.fade_out" :min="0" :max="10" :step="0.5" :decimals="1" suffix="s" />
            </div>
          </div>
        </div>
      </div>

      <div class="flex gap-2 mt-2" style="flex-wrap: wrap;">
        <button
          type="button"
          class="btn btn-sm btn-primary"
          @click="(refreshAmbientLibrary(), showAmbientPicker = true)"
        >+ Add Track</button>
        <button
          type="button"
          class="btn btn-sm btn-secondary"
          title="Open the channel's ambient/ folder so you can drop new audio loops in"
          @click="openAmbientFolder"
        >📁 Open Ambient Folder</button>
        <button
          type="button"
          class="btn btn-sm btn-secondary"
          :disabled="ambientLibraryLoading"
          @click="refreshAmbientLibrary"
        >🔄 Refresh</button>
      </div>

      <Modal :visible="showAmbientPicker" size="md" labelledby="ambient-picker-title" @close="showAmbientPicker = false">
        <div>
          <div class="flex gap-2 items-center" style="margin-bottom: 12px;">
            <h3 id="ambient-picker-title" style="margin: 0; flex: 1;">Pick an ambient track</h3>
            <button type="button" class="btn btn-sm btn-secondary" @click="showAmbientPicker = false">✕ Close</button>
          </div>
          <div v-if="ambientLibraryLoading" class="text-muted text-sm">Scanning ambient/ folder…</div>
          <div v-else-if="ambientLibraryError" class="text-danger text-sm">{{ ambientLibraryError }}</div>
          <div v-else-if="!ambientLibraryExists" class="text-muted text-sm">
            No <code>ambient/</code> folder yet. Click <strong>📁 Open ambient folder</strong> to create it
            and drop your audio files in (<code>.mp3</code> / <code>.wav</code> / <code>.m4a</code>).
          </div>
          <div v-else-if="!ambientLibrary.length" class="text-muted text-sm">
            <code>ambient/</code> folder is empty. Drop in ambience you have the rights to use.
          </div>
          <div v-else style="display: flex; flex-direction: column; gap: 6px; max-height: 60vh; overflow-y: auto;">
            <button
              v-for="f in ambientLibrary"
              :key="f.path"
              type="button"
              class="btn btn-secondary"
              style="text-align: left; padding: 10px; display: flex; gap: 10px; align-items: center;"
              @click="addAmbientTrack(f)"
            >
              <span style="font-size: 18px;">🌧️</span>
              <span style="flex: 1;">
                <strong>{{ f.filename }}</strong>
                <br>
                <span class="text-muted text-xs">
                  audio{{ f.duration ? ` · ${f.duration.toFixed(1)}s` : '' }}
                </span>
              </span>
            </button>
          </div>
          <p class="text-muted text-xs mt-2" style="margin-bottom: 0;">
            Source folder: <code class="wrap-path">{{ ambientLibraryDir }}</code>
          </p>
        </div>
      </Modal>
    </div>
    </section>

    <!-- Generate -->
    <div v-if="chapters.length" class="card mt-2">
      <h3>Generate Merged Audio</h3>
      <p class="text-muted text-sm mt-1">
        Combines everything above (chapters → silence gaps → optional intro / music / ambience) into a single track that downstream Video Assembly consumes.
      </p>

      <!-- Summary -->
      <div class="summary-panel mt-2">
        <div class="summary-grid">
          <div class="summary-row">
            <span class="text-muted">Chapters</span>
            <span>{{ chapterCount }} ({{ formatDuration(estimatedMergedDuration) }})</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Pause between chapters</span>
            <span>{{ gapDuration }}s between each chapter</span>
          </div>
          <div v-if="chunkTransitionsTotal" class="summary-row">
            <span class="text-muted">Chunk pauses</span>
            <span>{{ chunkSilenceSec.toFixed(1) }}s between {{ chunkTransitionsTotal }} split-chapter transition{{ chunkTransitionsTotal === 1 ? '' : 's' }}</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Intro</span>
            <span>{{ intro.enabled && intro.file ? intro.file.split('/').pop() : 'None' }}</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Narration Volume</span>
            <span>{{ narrationVolume }}%{{ narrationVolume === 100 ? ' (unchanged)' : '' }}</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Normalize</span>
            <span>{{ normalizeVolume ? 'Yes (EBU R128)' : 'No' }}</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Music</span>
            <span>{{ music.enabled && hasSelectedMusic ? `${music.source === 'pool' ? 'Pool: ' : ''}${selectedMusicFiles.length} file(s), ${music.volume}% vol` : 'None' }}</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Noise</span>
            <span>{{ backgroundNoise.enabled ? (backgroundNoise.mode === 'preset' ? backgroundNoise.preset.replace(/-/g, ' ') : 'Custom') + ', ' + backgroundNoise.volume + '% vol' : 'None' }}</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Ambient layers</span>
            <span>{{ ambientTracks.filter(track => track.enabled && track.source_path).length || 'None' }}</span>
          </div>
        </div>
      </div>

      <div v-if="episodeId" class="merge-output-status mt-2" aria-labelledby="merge-integrity-heading">
        <div>
          <h4 id="merge-integrity-heading">Output status</h4>
          <p class="text-muted text-sm">The merged file is the verified audio source for subtitles and video assembly.</p>
        </div>
        <div v-if="mergeStatus.loading" class="text-muted text-md"><LoadingSpinner size="sm" /> Checking…</div>
        <div v-else-if="mergeStatus.error" class="text-danger text-md">
          {{ mergeStatus.error }}
          <button class="btn btn-sm btn-ghost ml-2" @click="refreshMergeStatus">Retry</button>
        </div>
        <div v-else class="flex items-center gap-2 flex-wrap">
          <span class="integrity-pill" :class="mergeStatus.present ? 'ok' : 'warn'">
            <template v-if="mergeStatus.present">✓ Ready: {{ mergeStatus.file }}</template>
            <template v-else>Needs a merge</template>
          </span>
          <button class="btn btn-sm btn-ghost" :disabled="mergeStatus.loading" @click="refreshMergeStatus">Refresh</button>
        </div>
      </div>

    </div>

  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useAppTitle('Audio Assembly')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post } = useApi()
const { success, error: showError } = useToast()
const { audioMergeGenerating } = useGenerating()
const { episodesRoot } = useProject()

// ── State ──
const episodeId = ref('')
const selectedEpisode = ref<any>(null)
const ffmpegStatus = ref<{ installed: boolean; version?: string } | null>(null)
const scannedAssets = ref<any>(null)
const scanning = ref(false)
const generating = ref(false)
const chapterAudioReady = computed(
  () => scannedAssets.value?.chapter_audio_readiness?.ready === true,
)
const chapterAudioIssues = computed<string[]>(
  () => scannedAssets.value?.chapter_audio_readiness?.issues || [],
)

// v1.0.307 — keep Generate disabled for the WHOLE queued merge job, not just
// the brief enqueue POST that flips `generating` (see useJobs.isJobActiveFor).
const { isJobActiveFor } = useJobs()
const mergeJobActiveForEpisode = computed(() => isJobActiveFor(episodeId.value, ['audio_merge']))

// v1.0.115+ — clear the in-flight indicator on episode swap. The local
// `generating` ref is normally true only during the POST window (it's
// reset in the submit handler's `finally`), so this is defensive — but
// if the user switches episodes while the POST is still in flight, we
// don't want the new episode's TopActionBar showing "Merging audio for
// [old ep]…". Symmetrical with the same fix in video-assembly.vue.
watch(episodeId, (newEp, oldEp) => {
  if (newEp !== oldEp) generating.value = false
})

// ── Merged-audio integrity pill ──
interface MergeStatusState { loading: boolean; error: string; present: boolean; file: string }
const mergeStatus = reactive<MergeStatusState>({
  loading: false, error: '', present: false, file: '',
})

let scanSequence = 0
let mergeStatusSequence = 0
let poolPeekSequence = 0
let audioScopeSequence = 0
let mergeSubmitSequence = 0
async function refreshMergeStatus() {
  const request = ++mergeStatusSequence
  const episode = episodeId.value
  const project = slug.value
  const current = () => request === mergeStatusSequence && episode === episodeId.value && project === slug.value
  mergeStatus.present = false
  mergeStatus.file = ''
  if (!episode) { mergeStatus.loading = false; return }
  mergeStatus.loading = true
  mergeStatus.error = ''
  try {
    const r = await get<any>(`/projects/${slug.value}/episodes/${episodeId.value}/audio-merge-status`)
    if (!current()) return
    mergeStatus.present = !!r.present
    mergeStatus.file = r.file || ''
  } catch (e: any) {
    if (!current()) return
    mergeStatus.error = e?.data?.detail || e?.message || 'Could not check merge integrity'
  } finally {
    if (current()) mergeStatus.loading = false
  }
}

/**
 * Refresh both the asset scan and the integrity pill in parallel whenever
 * the episode changes. The previous setup split this across two paths
 * (`onEpisodeSelected` for scanAssets, this watcher for refreshMergeStatus),
 * which meant a page load with a remembered episodeId only refreshed the
 * integrity pill — the chapter list stayed empty until the user re-picked
 * the episode. Combining them fixes that and halves the time-to-data on
 * episode switches.
 */
async function loadEpisodeData() {
  if (!episodeId.value) return
  await Promise.all([scanAssets(), refreshMergeStatus()])
}

/**
 * Trailing-edge debounce — collapses a burst of episodeId changes (e.g.
 * a future bulk-selection flow that programmatically cycles episodes)
 * into one fetch. 200 ms is below human-noticeable latency for an
 * interactive selector and well above the typical event-loop tick.
 */
let episodeLoadTimer: ReturnType<typeof setTimeout> | null = null
function loadEpisodeDataDebounced() {
  if (episodeLoadTimer) clearTimeout(episodeLoadTimer)
  episodeLoadTimer = setTimeout(() => {
    episodeLoadTimer = null
    void loadEpisodeData()
  }, 200)
}

watch([slug, episodeId], (_, previous) => {
  audioScopeSequence++
  scanSequence++
  mergeStatusSequence++
  poolPeekSequence++
  // The immediate run precedes the form declarations; later switches clear
  // their episode data immediately, before the debounced request begins.
  if (previous?.length) {
    scannedAssets.value = null
    chapters.value = []
    scanning.value = false
    Object.assign(mergeStatus, { loading: false, error: '', present: false, file: '' })
    poolPickedTrack.value = ''
    poolPickedPath.value = ''
    poolPickedReason.value = ''
    poolPeekLoading.value = false
  }
  if (episodeLoadTimer) clearTimeout(episodeLoadTimer)
  episodeLoadTimer = null
  if (episodeId.value) loadEpisodeDataDebounced()
}, { immediate: true, flush: 'sync' })
// No loadProject watcher here: useProject() is a module-level singleton and
// the dashboard layout this page declares already loads the project on the
// same slug. A second watcher only repeated the same two GETs on every visit.

// A completed merge may advance the selected Music Pool track. Refresh its
// panel and current pick without making the user leave the workspace.
watch(() => audioMergeGenerating.value, (now, prev) => {
  if (prev === true && now === false) {
    musicPoolPanelRef.value?.refresh()
    void refreshPoolPeek()
  }
})

onUnmounted(() => {
  scanSequence++
  mergeStatusSequence++
  poolPeekSequence++
  audioScopeSequence++
  if (episodeLoadTimer) {
    clearTimeout(episodeLoadTimer)
    episodeLoadTimer = null
  }
})

const gapDuration = ref(3)
/** The Series Formula's own chapter pause, shown beside the control. */
const formulaGapSec = ref<number | null>(null)
// v1.0.317 — per-chunk pause for cloud TTS chunked chapters. Default 0 keeps
// the legacy back-to-back concat behaviour exactly. Surfaced only when at
// least one chapter has multiple `_partN` files.
const chunkSilenceSec = ref(0)
const normalizeVolume = ref(false)
// v1.0.333 — base voiceover loudness as a 0-100+ UI percentage (sent as 0-1+
// to the backend's narration_volume). 100 = unchanged; >100 boosts a soft
// voiceover; only the narration track is affected, not music/noise/ambient.
const narrationVolume = ref(100)

const chapters = ref<Array<{ filename: string; path: string; label: string; duration?: number }>>([])

const music = reactive({
  enabled: false,
  // A channel Music Pool and a hand-picked episode playlist are separate
  // sources. Keeping the choice in the preset prevents accidental mixing.
  source: 'pool' as 'pool' | 'manual',
  files: [] as string[],
  // 1.4.270 — music is levelled and this is its level relative to the narration: 11% ≈ 19 dB under the voice.
  volume: 11,
  post_narration_volume: 40,
  fade_in: 3,
  fade_out: 5,
  // v1.0.397 — use the first N seconds of this same track as a full-volume
  // intro, then duck to "Volume During Narration" as the voice starts. Off by
  // default; you can still upload a separate intro file in the Intro section.
  lead_in_enabled: false,
  lead_in_seconds: 8,
})
const newMusicPath = ref('')
// Remember the channel's music bed choice (on/off, Pool vs hand-picked, levels) per Mac, like
// the other generator pages. Without it every visit started with Background Music OFF, so an
// episode could be merged with no bed unless the owner remembered to switch it on each time
// (Dreamlands E2E, 2026-10-03). Hand-picked files are per episode and are not remembered.
useRememberedForm('audio-merge-music', slug, music, {
  include: ['enabled', 'source', 'volume', 'post_narration_volume', 'fade_in', 'fade_out', 'lead_in_enabled', 'lead_in_seconds'],
})

// Music Pool state remains separate from hand-picked episode files. Only a
// submitted pool pick advances the pool cursor after a successful merge.
const poolPickedTrack = ref('')
const poolPickedPath = ref('')
const poolPickedReason = ref('')
const poolPeekLoading = ref(false)
const musicPoolPanelRef = ref<{ refresh: () => Promise<void> } | null>(null)

watch(() => music.enabled, (enabled) => {
  if (enabled && music.source === 'pool' && !poolPickedPath.value) void refreshPoolPeek()
})

const backgroundNoise = reactive({
  enabled: false,
  mode: 'preset' as 'preset' | 'custom',
  preset: 'brown-noise' as string,
  custom_file: '',
  volume: 15,
  fade_in: 3,
  fade_out: 5,
})

const intro = reactive({
  enabled: false,
  file: '',
  volume: 100,
  gap_after: 2,
})

// Multi-track ambient layering (v1.0.55+). Parallel streams that play
// simultaneously — distinct from `music.files`, which concatenates.
// Drop sources into ${PROJECT}/ambient/ and pick from the picker below.
type AmbientTrackUI = {
  id: string
  enabled: boolean
  source_path: string
  source_filename?: string
  volume: number       // 0-100 in UI (sent as 0-1 in payload)
  fade_in: number
  fade_out: number
  loop?: boolean
}
const ambientTracks = reactive<AmbientTrackUI[]>([])
const ambientLibraryLoading = ref(false)
const ambientLibraryError = ref('')
const ambientLibrary = ref<Array<{ filename: string; path: string; duration?: number }>>([])
const ambientLibraryDir = ref('')
const ambientLibraryExists = ref(false)
const showAmbientPicker = ref(false)

async function refreshAmbientLibrary() {
  ambientLibraryLoading.value = true
  ambientLibraryError.value = ''
  try {
    const r = await $fetch(`/api/projects/${slug.value}/video-editor/ambient-files`) as {
      tracks: typeof ambientLibrary.value
      ambient_dir: string
      exists: boolean
    }
    ambientLibrary.value = r.tracks || []
    ambientLibraryDir.value = r.ambient_dir || ''
    ambientLibraryExists.value = !!r.exists
  } catch (e: any) {
    ambientLibraryError.value = e?.data?.detail || e?.message || 'Could not scan ambient folder'
  } finally {
    ambientLibraryLoading.value = false
  }
}

async function openAmbientFolder() {
  try {
    await $fetch(`/api/projects/${slug.value}/video-editor/ambient/open-folder`, { method: 'POST' })
    await refreshAmbientLibrary()
  } catch (e: any) {
    ambientLibraryError.value = e?.data?.detail || e?.message || 'Could not open ambient folder'
  }
}

function newAmbientId(): string {
  return `amb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function addAmbientTrack(file: { path: string; filename: string }) {
  void (async () => {
    ambientTracks.push({
      id: newAmbientId(),
      enabled: true,
      source_path: await collapseToPortablePath(file.path),
      source_filename: file.filename,
      // Sensible default for ambient layers — quieter than the
      // narration/music base so it sits underneath. User can crank it.
      volume: 20,
      fade_in: 2,
      fade_out: 3,
      loop: true,
    })
    showAmbientPicker.value = false
  })()
}

function removeAmbientTrack(id: string) {
  const idx = ambientTracks.findIndex(t => t.id === id)
  if (idx >= 0) ambientTracks.splice(idx, 1)
}

function moveAmbientTrack(id: string, dir: -1 | 1) {
  const idx = ambientTracks.findIndex(t => t.id === id)
  const next = idx + dir
  if (idx < 0 || next < 0 || next >= ambientTracks.length) return
  const tmp = ambientTracks[idx]!
  ambientTracks[idx] = ambientTracks[next]!
  ambientTracks[next] = tmp
}

// ── Presets ───────────────────────────────────────────────────────────────
// Unified preset wiring (matches every other generator page). The apply()
// branches below are defensive against partial-shape presets (e.g. a preset
// saved before ambient_tracks existed won't have that key) — usePresets
// itself stores everything in the `{id, name, data}` shape that the
// composable owns end-to-end. No legacy flat-shape format ever shipped to
// users for this preset type, so no one-time migration is needed.
const mergePresets = usePresets<any>({
  slug: slug.value,
  configKey: 'audio_merge',
  snapshot: () => ({
    intro: JSON.parse(JSON.stringify(intro)),
    music: JSON.parse(JSON.stringify(music)),
    background_noise: JSON.parse(JSON.stringify(backgroundNoise)),
    ambient_tracks: ambientTracks.map(t => ({ ...t })),
    gap_duration: gapDuration.value,
    chunk_silence_sec: chunkSilenceSec.value,
    normalize_volume: normalizeVolume.value,
    narration_volume: narrationVolume.value,
  }),
  apply: (data) => {
    if (!data) return
    if (data.intro) Object.assign(intro, data.intro)
    if (data.music) {
      Object.assign(music, data.music, {
        // Older presets had no source. A saved file list is clearly an
        // episode playlist; an empty list can safely use the channel pool.
        source: data.music.source === 'pool' || data.music.source === 'manual'
          ? data.music.source
          : data.music.files?.length ? 'manual' : 'pool',
        files: [...(data.music.files || [])],
      })
    }
    if (data.background_noise) Object.assign(backgroundNoise, data.background_noise)
    if (Array.isArray(data.ambient_tracks)) {
      ambientTracks.splice(0, ambientTracks.length, ...data.ambient_tracks.map((t: any) => ({ ...t })))
    }
    if (typeof data.gap_duration === 'number') gapDuration.value = data.gap_duration
    if (typeof data.chunk_silence_sec === 'number' && data.chunk_silence_sec >= 0) {
      chunkSilenceSec.value = data.chunk_silence_sec
    }
    if (typeof data.normalize_volume === 'boolean') normalizeVolume.value = data.normalize_volume
    if (typeof data.narration_volume === 'number') narrationVolume.value = data.narration_volume
  },
})

// Audio preview
const previewAudio = ref<HTMLAudioElement | null>(null)
const playingPath = ref('')

const noisePresets = [
  { id: 'brown-noise', label: 'Brown Noise', description: 'Deep, rumbling — best for sleep' },
  { id: 'pink-noise', label: 'Pink Noise', description: 'Balanced, natural sounding' },
  { id: 'white-noise', label: 'White Noise', description: 'Even frequencies, static-like' },
]

// ── Computed ──
const totalChapterDuration = computed(() => {
  return chapters.value.reduce((sum, ch) => sum + (ch.duration || 0), 0)
})

// v1.0.317 — distinguish "same chapter" transitions (between _part1/_part2/...
// of one chapter) from "different chapter" transitions. The per-chunk pause
// goes between same-chapter parts; the existing gap_duration goes between
// different chapters. Mirrors the backend's chapterKeyOf logic.
function chapterKeyFromFilename(filename: string): string {
  // Strip episode prefix (e.g. "TN0161_") then _part{N} / _v{N} suffixes.
  let base = (filename || '').replace(/\.[^.]+$/, '').replace(/^[A-Z]+\d+_/, '')
  while (/(?:_part\d+|_v\d+)$/i.test(base)) base = base.replace(/(?:_part\d+|_v\d+)$/i, '')
  return base
}
/** Chapters, not files: a chapter still held as separate parts counts once. */
const chapterCount = computed(() => new Set(chapters.value.map(chapter => chapterKeyFromFilename(chapter.filename))).size)
const chapterTransitions = computed(() => {
  let sameChapter = 0
  let differentChapter = 0
  for (let i = 0; i < chapters.value.length - 1; i++) {
    const a = chapterKeyFromFilename(chapters.value[i]?.filename || '')
    const b = chapterKeyFromFilename(chapters.value[i + 1]?.filename || '')
    if (a && b && a === b) sameChapter++
    else differentChapter++
  }
  return { sameChapter, differentChapter }
})
const chunkTransitionsTotal = computed(() => chapterTransitions.value.sameChapter)
const hasMultiPartChapters = computed(() => chunkTransitionsTotal.value > 0)
const chapterGapSecondsTotal = computed(() => chapterTransitions.value.differentChapter * gapDuration.value)
const chunkPauseSecondsTotal = computed(() => chunkTransitionsTotal.value * chunkSilenceSec.value)

const estimatedMergedDuration = computed(() => {
  return totalChapterDuration.value + chapterGapSecondsTotal.value + chunkPauseSecondsTotal.value
})

const scannedMusicFiles = computed(() => {
  return scannedAssets.value?.music_files || []
})

const selectedMusicFiles = computed(() => {
  if (music.source === 'pool') return poolPickedPath.value ? [poolPickedPath.value] : []
  return music.files
})

const hasSelectedMusic = computed(() => selectedMusicFiles.value.length > 0)
// Music on with nothing chosen used to merge silently WITHOUT a bed. "Choose for this episode"
// is remembered per Mac but its files are per episode, so returning to an episode showed
// Music on, "No music files added yet", and an enabled Replace button (Dreamlands E2E).
const musicChoiceMissing = computed(() => music.enabled && !hasSelectedMusic.value
  && !(music.source === 'pool' && poolPeekLoading.value))

const existingMergedAudio = computed(() => {
  const files = scannedAssets.value?.merged_files || []
  if (!files.length) return null
  const activeFilename = mergeStatus.file.split('/').pop()
  return files.find((file: { filename: string }) => file.filename === activeFilename) || null
})

// ── Functions ──
// formatDuration moved to ~/composables/useFormat.ts (formatDurationPrecise).
// Auto-imported by Nuxt — call sites in this file's template now resolve
// to the centralised version. See `formatDurationPrecise` for output format.
const formatDuration = formatDurationPrecise

/**
 * `adopt` — for a file the owner just PICKED: one outside this channel is
 * copied into the channel's `assets/` folder first, so the channel folder
 * carries everything it uses (self-contained channels, 2026-10-07).
 */
async function collapseToPortablePath(input: string, adopt = false): Promise<string> {
  const raw = String(input || '').trim()
  if (!raw) return ''
  try {
    const r = await post<{ output: string }>(`/system/resolve-asset-path`, {
      path: raw,
      output_root: episodesRoot.value,
      mode: adopt ? 'adopt' : 'portable',
    })
    return String(r?.output || raw)
  } catch {
    return raw
  }
}

async function normalizeAudioMergePathsInState(): Promise<void> {
  const scope = audioScopeSequence
  const normalize = async (getPath: () => string, setPath: (value: string) => void) => {
    const original = getPath()
    if (!original) return
    const portable = await collapseToPortablePath(original)
    if (scope === audioScopeSequence && getPath() === original) setPath(portable)
  }
  const files = [...music.files]
  const normalizedFiles = await Promise.all(files.map(f => collapseToPortablePath(f)))
  if (scope === audioScopeSequence && JSON.stringify(music.files) === JSON.stringify(files)) music.files = normalizedFiles
  if (scope !== audioScopeSequence) return
  await Promise.all([
    normalize(() => intro.file, value => { intro.file = value }),
    normalize(() => backgroundNoise.custom_file, value => { backgroundNoise.custom_file = value }),
    normalize(() => newMusicPath.value, value => { newMusicPath.value = value }),
    ...ambientTracks.map(track => normalize(() => track.source_path, value => { track.source_path = value })),
  ])
}

function moveChapter(index: number, direction: -1 | 1) {
  const newIndex = index + direction
  if (newIndex < 0 || newIndex >= chapters.value.length) return
  const a = chapters.value[index]
  const b = chapters.value[newIndex]
  if (!a || !b) return
  chapters.value[index] = b
  chapters.value[newIndex] = a
}

function togglePreview(filePath: string) {
  void (async () => {
    if (playingPath.value === filePath) {
      previewAudio.value?.pause()
      previewAudio.value = null
      playingPath.value = ''
      return
    }
    previewAudio.value?.pause()
    const url = `/api/projects/${slug.value}/audio-editor/preview-audio?path=${encodeURIComponent(filePath)}`
    const audio = new Audio(url)
    audio.onended = () => { playingPath.value = ''; previewAudio.value = null }
    // play() returns a Promise that rejects on missing files / unsupported
    // codec / autoplay block. Without this catch the click silently does
    // nothing and the user has no signal anything went wrong.
    audio.play().catch((err) => {
      console.error(`[audio-merge] preview failed for ${filePath}:`, err)
      showError(`Couldn't play preview — file may be missing or in an unsupported format: ${filePath.split('/').pop()}`)
      playingPath.value = ''
      previewAudio.value = null
    })
    previewAudio.value = audio
    playingPath.value = filePath
  })()
}

function addMusicFile() {
  void (async () => {
    const next = await collapseToPortablePath(newMusicPath.value, true)
    if (next && !music.files.includes(next)) {
      music.files.push(next)
      newMusicPath.value = ''
    }
  })()
}

function addScannedMusicFile(filePath: string) {
  void (async () => {
    const next = await collapseToPortablePath(filePath)
    if (next && !music.files.includes(next)) music.files.push(next)
  })()
}

const AUDIO_FILTERS = [
  { name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] },
  { name: 'All Files', extensions: ['*'] },
]

async function browseMusicFile() {
  try {
    const r = await post<{ path: string | null }>('/system/pick-file', {
      title: 'Choose a music file',
      buttonLabel: 'Add Music',
      filters: AUDIO_FILTERS,
    })
    const next = r.path ? await collapseToPortablePath(r.path, true) : ''
    if (next && !music.files.includes(next)) music.files.push(next)
  } catch (e: any) {
    showError(`Music file picker failed — ${e.data?.detail || e.message || 'unknown error'}`)
  }
}

async function browseNoiseFile() {
  try {
    const r = await post<{ path: string | null }>('/system/pick-file', {
      title: 'Choose an ambience file',
      buttonLabel: 'Use This File',
      filters: AUDIO_FILTERS,
    })
    if (r.path) backgroundNoise.custom_file = await collapseToPortablePath(r.path, true)
  } catch (e: any) {
    showError(`Ambience file picker failed — ${e.data?.detail || e.message || 'unknown error'}`)
  }
}

async function browseIntroFile() {
  try {
    const r = await post<{ path: string | null }>('/system/pick-file', {
      title: 'Choose an intro audio file',
      buttonLabel: 'Use This File',
      filters: AUDIO_FILTERS,
    })
    if (r.path) intro.file = await collapseToPortablePath(r.path, true)
  } catch (e: any) {
    showError(`Intro file picker failed — ${e.data?.detail || e.message || 'unknown error'}`)
  }
}

// ── Toast for save — names the preset so the user has unambiguous feedback
// that the save worked AND that the preset is now the active selection.
function onPresetSaved() {
  // The form state has just been re-snapshotted; re-validate to clear any
  // banner rows for paths the user fixed via the form's own Browse buttons
  // (i.e. paths repaired outside the Pick-replacement flow).
  void runPresetPathCheck()
}

// ── Local preset path-check wiring ───────────────────────────────────────
//
// Every path field we want to validate at apply-time. Kept declarative so
// the validator can walk it; changing the merge form's path fields means
// adding a row here, not threading new state through.
const AUDIO_MERGE_PATH_FIELDS: Array<{ key: string }> = [
  { key: 'intro.file' },
  { key: 'music.files[]' },
  { key: 'background_noise.custom_file' },
  { key: 'ambient_tracks[].source_path' },
]

const presetInvalidPaths = ref<Array<{ key: string; index: number | null; value: string; reason: string }>>([])

const { validate: validatePresetPaths } = usePresetPathValidation()

/** Build the current state object in the exact shape the snapshot would
 *  capture, so the validator walks the SAME tree as what was saved. We
 *  don't call `cleanSnapshot` itself here because that runs through the
 *  excludeKeys stripping logic; the path fields aren't affected by that,
 *  but reproducing the snapshot shape from form state is the contract. */
function currentMergeSnapshotForValidation() {
  return {
    intro: { file: intro.file },
    music: { files: [...music.files] },
    background_noise: { custom_file: backgroundNoise.custom_file },
    ambient_tracks: ambientTracks.map(t => ({ source_path: t.source_path })),
  }
}

async function runPresetPathCheck() {
  try {
    const result = await validatePresetPaths(
      currentMergeSnapshotForValidation(),
      AUDIO_MERGE_PATH_FIELDS,
      { episodesRoot: episodesRoot.value },
    )
    presetInvalidPaths.value = result.invalid
  } catch {
    // Validation is best-effort — if the round-trip fails (e.g. backend
    // restarting), leave the previous banner state in place rather than
    // flashing it on/off.
  }
}

/** Run after every Apply. The `applyActive()` synchronous emit happens
 *  inside TopActionBar; the page only sees the @preset-applied event, so
 *  the form state IS already updated when this fires. */
function onPresetApplied() {
  void (async () => {
    await normalizeAudioMergePathsInState()
    await runPresetPathCheck()
  })()
}

/** Friendly field label for the banner row. Keeps the user-facing string
 *  centralised so future renames don't drift between the form section
 *  headers and the banner copy. */
function pathFieldLabel(key: string): string {
  switch (key) {
    case 'intro.file':                       return 'Intro audio'
    case 'music.files[]':                    return 'Music bed'
    case 'background_noise.custom_file':     return 'Custom ambience'
    case 'ambient_tracks[].source_path':     return 'Ambient track'
    default:                                  return key
  }
}

/** Truncate long absolute paths for the banner (the full path lives in
 *  the title attribute for hover). Keeps the row scannable on a 1280px
 *  layout where the full /Users/.../Mobile Documents/... eats every
 *  pixel. */
function shortenPath(p: string): string {
  if (p.length <= 64) return p
  const parts = p.split('/')
  if (parts.length <= 3) return p
  return `${parts.slice(0, 2).join('/')}/…/${parts.slice(-2).join('/')}`
}

/** Dispatch the right Browse-style handler for the given invalid row,
 *  letting the user pick a replacement file from this Mac. After the
 *  pick lands the form state updates, then we re-run the validator
 *  so the banner row clears immediately. */
async function repickInvalidPath(row: { key: string; index: number | null; value: string }) {
  switch (row.key) {
    case 'intro.file':
      await browseIntroFile()
      break
    case 'music.files[]': {
      // music.files is an array — Browse appends, then we remove the OLD
      // (now-broken) entry so the user sees a swap, not an accumulation.
      const old = row.value
      await browseMusicFile()
      const idx = music.files.indexOf(old)
      if (idx >= 0) music.files.splice(idx, 1)
      break
    }
    case 'background_noise.custom_file':
      await browseNoiseFile()
      break
    case 'ambient_tracks[].source_path': {
      // Ambient tracks pre-allocate slots — pick a replacement for the
      // specific index that's broken, not "add another track".
      const i = row.index ?? -1
      if (i < 0 || i >= ambientTracks.length) return
      try {
        const r = await post<{ files: Array<{ path: string }> }>(`/system/pick-files`, {
          multi: false,
          accept: ['audio/*'],
        })
        const newPath = r?.files?.[0]?.path
        if (newPath) ambientTracks[i].source_path = await collapseToPortablePath(newPath, true)
      } catch (e: any) {
        showError(`Pick failed — ${e?.data?.detail || e?.message || 'unknown error'}`)
      }
      break
    }
  }
  await runPresetPathCheck()
}

async function checkFfmpeg() {
  try {
    ffmpegStatus.value = await get<any>(`/projects/${slug.value}/audio-editor/check-ffmpeg`)
  } catch {
    ffmpegStatus.value = { installed: false }
  }
}

async function scanAssets() {
  const request = ++scanSequence
  const episode = episodeId.value
  const project = slug.value
  const current = () => request === scanSequence && episode === episodeId.value && project === slug.value
  if (!episode) return
  scanning.value = true
  scannedAssets.value = null
  chapters.value = []
  try {
    const assets = await get(`/projects/${project}/audio-editor/scan/${episode}`)
    if (!current()) return
    scannedAssets.value = assets
    if (scannedAssets.value?.chapters?.length) {
      chapters.value = [...scannedAssets.value.chapters]
    }
  } catch (e: any) {
    if (!current()) return
    console.error(`[audio-merge] scan failed for ${episodeId.value}:`, e)
    showError(e.data?.detail || `Failed to scan audio assets for ${episodeId.value} — check the episode folder exists.`)
  } finally {
    if (current()) scanning.value = false
  }
  // After the scan, resolve the current pool selection without changing a
  // hand-picked playlist.
  if (current()) await refreshPoolPeek()
}

async function refreshPoolPeek() {
  const request = ++poolPeekSequence
  const episode = episodeId.value
  const project = slug.value
  const current = () => request === poolPeekSequence && episode === episodeId.value
    && project === slug.value && music.source === 'pool'

  if (!episodeId.value || music.source !== 'pool') {
    poolPickedTrack.value = ''
    poolPickedPath.value = ''
    poolPickedReason.value = ''
    return
  }
  poolPeekLoading.value = true
  try {
    // v1.0.108+ — peek-next returns the full track object including
    // any per-track override knobs. Apply them onto the form's globals
    // so the merge job uses the right levels for THIS track.
    const r = await get<{
      track: {
        filename: string; path: string
        volume?: number
        post_narration_volume?: number
        fade_in?: number
        fade_out?: number
      }
      reason: string
    } | null>(
      `/projects/${slug.value}/music-pool/peek-next?episode_code=${encodeURIComponent(episodeId.value)}`,
    )
    if (!current()) return
    if (r && r.track) {
      if (!current()) return
      const portableTrackPath = await collapseToPortablePath(r.track.path)
      if (!current()) return
      poolPickedTrack.value = r.track.filename
      poolPickedPath.value = portableTrackPath
      poolPickedReason.value = r.reason
      // Per-track pool metadata applies only while this source is selected.
      applyTrackOverrides(r.track)
    } else {
      poolPickedTrack.value = ''
      poolPickedPath.value = ''
      poolPickedReason.value = ''
    }
  } catch {
    if (!current()) return
    // Leave the pool source empty: the user can retry, repair the pool, or
    // deliberately switch to an episode playlist.
    poolPickedTrack.value = ''
    poolPickedPath.value = ''
    poolPickedReason.value = ''
  } finally {
    if (request === poolPeekSequence) poolPeekLoading.value = false
  }
}

function setMusicSource(source: 'pool' | 'manual') {
  if (music.source === source) return
  poolPeekSequence++
  poolPeekLoading.value = false
  music.source = source
  if (source === 'pool') {
    void refreshPoolPeek()
  } else {
    poolPickedTrack.value = ''
    poolPickedPath.value = ''
    poolPickedReason.value = ''
  }
}

/** v1.0.108+ — when a pool-picked track has per-track override knobs
 *  set, apply them onto the form's music globals so the merge job uses
 *  the track-specific levels. Undefined fields leave the form alone. */
function applyTrackOverrides(track: {
  volume?: number
  post_narration_volume?: number
  fade_in?: number
  fade_out?: number
}) {
  if (typeof track.volume === 'number') music.volume = track.volume
  if (typeof track.post_narration_volume === 'number') music.post_narration_volume = track.post_narration_volume
  if (typeof track.fade_in === 'number') music.fade_in = track.fade_in
  if (typeof track.fade_out === 'number') music.fade_out = track.fade_out
}

function clearPoolPick() {
  // Pool picks are never inserted into the manual playlist, so skipping is
  // safe and cannot delete a hand-picked track from a saved preset.
  music.enabled = false
  poolPickedTrack.value = ''
  poolPickedPath.value = ''
  poolPickedReason.value = ''
}

async function onPoolChanged() {
  // Pool composition / strategy / cursor changed in the panel — re-fetch
  // the peek so the banner reflects the new "next track" without forcing
  // the user to navigate away + back.
  await refreshPoolPeek()
}

function onEpisodeSelected(ep: any) {
  selectedEpisode.value = ep
  // Stop any in-flight preview from the previous episode — otherwise
  // the audio keeps playing while the UI swaps to a different episode's
  // chapter list, which is disorienting.
  if (previewAudio.value) {
    previewAudio.value.pause()
    previewAudio.value = null
    playingPath.value = ''
  }
  // scanAssets() + refreshMergeStatus() now fire via the episodeId watcher
  // (loadEpisodeDataDebounced) whenever v-model:episode-id updates, which
  // happens in lockstep with this event. No need to duplicate the call here.
}

// Output disposition is an explicit action choice, separate from reusable mix
// presets. Replacing the episode's canonical merge is the normal/default path;
// creating another version remains available when a merge already exists.
const writeMode = ref<'overwrite' | 'new'>('overwrite')

watch(existingMergedAudio, (cur) => {
  // A versioned output needs an existing episode-owned merge. Clearing the
  // episode scan therefore clears that choice too; routine refreshes preserve
  // an explicit "Create another version" selection.
  if (!cur) writeMode.value = 'overwrite'
}, { immediate: true })

const nextVersionName = computed(() => {
  const cur = existingMergedAudio.value?.path?.split('/').pop() || ''
  const m = cur.match(/_v(\d+)\.mp3$/)
  const nextV = m ? parseInt(m[1], 10) + 1 : 2
  return cur.replace(/(_v\d+)?\.mp3$/, `_v${nextV}.mp3`)
})

const generateLabel = computed(() => {
  if (!existingMergedAudio.value) return 'Generate Merged Audio'
  return writeMode.value === 'overwrite' ? 'Replace Existing Merge' : `Save as ${nextVersionName.value.split('/').pop()}`
})

function onGenerateClick() {
  void generateMergedAudio(writeMode.value)
}

async function generateMergedAudio(writeMode: 'overwrite' | 'new' = 'overwrite') {
  if (!episodeId.value || generating.value || scanning.value || !chapters.value.length) return
  if (musicChoiceMissing.value) {
    showError('Background Music is on, but no track is chosen for this episode. Pick a file, switch to Music Pool, or turn music off.')
    return
  }
  const scope = audioScopeSequence
  const submit = ++mergeSubmitSequence
  generating.value = true
  try {
    await normalizeAudioMergePathsInState()
    if (scope !== audioScopeSequence) return
    const payload: Record<string, any> = {
      episode_id: episodeId.value,
      chapters: chapters.value.map(ch => ch.path),
      gap_duration: gapDuration.value,
      normalize_volume: normalizeVolume.value,
      narration_volume: narrationVolume.value / 100,
      write_mode: writeMode,
    }
    // v1.0.317 — opt-in per-chunk pause for cloud TTS chunked chapters. Only
    // sent when > 0 so the backend payload stays clean for the legacy default.
    if (chunkSilenceSec.value > 0) payload.chunk_silence_sec = chunkSilenceSec.value

    if (intro.enabled && intro.file) {
      payload.intro = {
        enabled: true,
        file: intro.file,
        volume: intro.volume / 100,
        gap_after: intro.gap_after,
      }
    }

    if (music.enabled && selectedMusicFiles.value.length) {
      payload.music = {
        enabled: true,
        files: selectedMusicFiles.value,
        volume: music.volume / 100,
        post_narration_volume: music.post_narration_volume / 100,
        fade_in: music.fade_in,
        fade_out: music.fade_out,
        // v1.0.397 — lead-in is a duration (seconds), not a volume — sent as-is.
        lead_in_enabled: music.lead_in_enabled,
        lead_in_seconds: music.lead_in_seconds,
      }
      // Only a real pool selection advances the project pool cursor. A
      // manually selected playlist must never be recorded as an auto pick.
      if (music.source === 'pool' && poolPickedTrack.value && poolPickedPath.value) {
        payload.music_pool_track = poolPickedTrack.value
      }
    }

    if (backgroundNoise.enabled) {
      payload.background_noise = {
        enabled: true,
        mode: backgroundNoise.mode,
        preset: backgroundNoise.preset,
        custom_file: backgroundNoise.mode === 'custom' ? backgroundNoise.custom_file : undefined,
        volume: backgroundNoise.volume / 100,
        fade_in: backgroundNoise.fade_in,
        fade_out: backgroundNoise.fade_out,
      }
    }

    // Multi-track ambient layers — only send enabled rows with a real
    // file path. Volume converts from UI's 0-100 scale to backend 0-1.
    const liveAmbient = ambientTracks.filter(t => t.enabled && t.source_path)
    if (liveAmbient.length) {
      payload.ambient_tracks = liveAmbient.map(t => ({
        id: t.id,
        enabled: true,
        source_path: t.source_path,
        volume: Math.max(0, Math.min(1, t.volume / 100)),
        fade_in: Math.max(0, t.fade_in),
        fade_out: Math.max(0, t.fade_out),
        loop: t.loop !== false,
      }))
    }

    audioMergeGenerating.value = true
    await post<any>(`/projects/${slug.value}/generate/audio-merge`, payload)
    success('Audio merge queued!')
  } catch (e: any) {
    // The sidebar pulse is shared across episodes. A stale failed request must
    // clear its own optimistic pulse, but never hide a newer submission.
    if (submit === mergeSubmitSequence) audioMergeGenerating.value = false
    if (scope !== audioScopeSequence) return
    console.error('[audio-merge] queue failed:', e)
    const fallback = !ffmpegStatus.value?.installed
      ? 'FFmpeg is not installed — install it from Settings → FFmpeg first.'
      : 'Failed to queue audio merge. Check that all selected files exist on disk.'
    showError(e.data?.detail || fallback)
  } finally {
    if (scope === audioScopeSequence) generating.value = false
  }
}

/**
 * Format-aware seeding of merge knobs BEFORE preset loaders run. The page
 * defaults `normalizeVolume=false` + `gapDuration=3` (the 3 s chapter pause, owner 2026-10-03) are sleep-story
 * shaped (calm narration is already loudness-consistent; long pauses
 * between chapters fit the genre). Listicle / explainer channels mix
 * delivery tones across chapters so EBU R128 normalisation matters,
 * and shorter inter-chapter gaps suit the snappier pacing.
 *
 * Saved presets still override these — preset.load() runs after seeding.
 */
async function applyMergeFormatDefaultsIfNoPreset() {
  try {
    const f = await get<any>(`/projects/${slug.value}/effective-format`)
    const m = f?.script?.audioMergeDefaults
    if (!m) return
    if (typeof m.normalizeVolume === 'boolean') normalizeVolume.value = m.normalizeVolume
    if (typeof m.gapDurationSec === 'number' && m.gapDurationSec >= 0) {
      gapDuration.value = m.gapDurationSec
      formulaGapSec.value = m.gapDurationSec
    }
  } catch {
    // Format endpoint unavailable / project missing — keep the legacy
    // hardcoded values (normalizeVolume=false, gapDuration=3). Non-fatal.
  }
}

// ── Lifecycle ──
onMounted(async () => {
  checkFfmpeg()
  await applyMergeFormatDefaultsIfNoPreset()
  await mergePresets.load()
  await normalizeAudioMergePathsInState()
  // v1.0.93+ — `mergePresets.load()` auto-applies the last-active preset
  // when there is one. Run the path-check after that so the banner is
  // already visible on first paint if any files from the saved preset
  // don't exist on this Mac. Without this, the user would have to click
  // Apply manually to surface stale paths after switching devices.
  void runPresetPathCheck()
})

onUnmounted(() => {
  previewAudio.value?.pause()
  previewAudio.value = null
})
</script>

<style scoped>
/* Same construct as welcome.vue's Library path: a filesystem path has nothing
   to break at, and there is no global `code` rule to inherit, so in a narrow
   window it pushes the panel sideways. Verified on the welcome screen. */
.wrap-path { overflow-wrap: anywhere; }

.integrity-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid transparent;
}
.integrity-pill.ok {
  background: rgba(34, 197, 94, 0.12);
  color: rgb(22, 163, 74);
  border-color: rgba(34, 197, 94, 0.3);
}
.integrity-pill.warn {
  background: rgba(245, 158, 11, 0.14);
  color: rgb(180, 83, 9);
  border-color: rgba(245, 158, 11, 0.35);
}

.badge { display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 500; }
.badge-success { background: rgba(74, 222, 128, 0.15); color: var(--success); border: 1px solid rgba(74, 222, 128, 0.3); }
.badge-error { background: rgba(239, 68, 68, 0.15); color: var(--error); border: 1px solid rgba(239, 68, 68, 0.3); }

/* Output disposition and the primary merge action, in the page flow above the
   mix form. It used to be `position: sticky` and floated over the chapter rows
   scrolling beneath it, hiding them. */
.audio-assembly-action-bar {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px 16px;
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--border));
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
}
.audio-assembly-action-context {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  align-items: center;
}
.audio-context-item {
  min-width: 0;
  padding-right: 8px;
  border-right: 1px solid var(--border);
}
.audio-context-item:last-child { border-right: 0; }
.audio-context-item small,
.audio-context-item strong { display: block; }
.audio-context-item small,
.audio-output-choice > span {
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-weight: 700;
  letter-spacing: .06em;
  text-transform: uppercase;
}
.audio-context-item strong {
  overflow: hidden;
  color: var(--text-primary);
  font-size: var(--font-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.audio-assembly-action-controls {
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  gap: 8px;
}
.audio-output-choice {
  display: grid;
  min-width: 250px;
  gap: 3px;
  margin: 0;
}
.audio-output-choice .select,
.audio-assembly-action-controls .btn { min-height: var(--control-height-md); }
.audio-assembly-action-summary {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--text-muted);
  font-size: var(--font-xs);
  line-height: 1.4;
}

.audio-list-reorder { display: flex; flex-direction: column; gap: 3px; }
.audio-item-reorder { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--bg-tertiary); border-radius: var(--radius-sm); font-size: 13px; border: 1px solid var(--border); }
.audio-order-num { width: 22px; height: 22px; border-radius: 50%; background: var(--accent-dim); color: var(--accent); font-size: var(--font-xs); font-weight: 600; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.audio-reorder-btns { display: flex; flex-direction: column; gap: 0; flex-shrink: 0; }
.audio-reorder-btns .btn-icon { font-size: var(--font-xs); padding: 1px 4px; line-height: 1; }
.audio-reorder-btns .btn-icon:disabled { opacity: 0.2; cursor: default; }
.audio-name { color: var(--text-secondary); flex: 1; }
.audio-duration { min-width: 60px; text-align: right; }

/* Sub-controls under the FFmpeg "not installed" badge. */
.ffmpeg-install-link { margin-left: 8px; }
.ffmpeg-install-hint { margin-left: 8px; }

/* Width-constrained gap-duration slider — keeps it from stretching across
 * the full card on wide screens. */
.gap-duration-field { max-width: 300px; }

/* One compact, always-visible mix surface replaces the old advanced
   disclosure plus five disconnected full-width cards. */
.audio-mix-card { padding: 0 20px; }
.audio-mix-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 18px;
  padding: 18px 0 14px;
}
.audio-mix-header h3 { margin: 3px 0 4px; }
.audio-mix-header p { margin: 0; }
.workspace-section-kicker {
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 700;
  letter-spacing: .1em;
  text-transform: uppercase;
}
.audio-mix-states { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.audio-mix-state {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  background: var(--bg-primary);
  font-size: var(--font-xs);
  white-space: nowrap;
}
.audio-mix-state.active { border-color: rgba(74, 222, 128, .35); color: var(--success); background: rgba(74, 222, 128, .08); }
.audio-mix-section {
  padding: 14px 0;
  border-top: 1px solid var(--border);
}
.audio-mix-section > :first-child { margin-top: 0; }
.audio-mix-section--intro { display: grid; grid-template-columns: minmax(170px, .6fr) minmax(0, 1.4fr); column-gap: 18px; align-items: start; }
.audio-mix-section--intro > .mt-2 { grid-column: 1 / -1; margin-top: 10px; }
.audio-mix-section--intro > .flex { padding-top: 2px; }
.audio-mix-section-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.audio-mix-section-heading h3 { margin: 0; }
.audio-mix-section-heading p { margin: 4px 0 0; }
.compact-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--font-xs);
  cursor: pointer;
  white-space: nowrap;
}
.compact-toggle:has(input:checked) { border-color: rgba(74, 222, 128, .4); color: var(--success); background: rgba(74, 222, 128, .08); }
.audio-mix-section--music > .flex:first-child,
.audio-mix-section--atmosphere > .flex:first-child { margin-bottom: 4px; }
.ambient-layers-panel { margin-top: 14px; padding-top: 14px; border-top: 1px dashed var(--border); }
.ambient-layers-panel > .flex:first-child { margin-bottom: 4px; }
.merge-output-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
}
.merge-output-status h4 { margin: 0 0 3px; font-size: 13px; }
.merge-output-status p { margin: 0; }
@media (max-width: 760px) {
  .audio-assembly-action-bar { grid-template-columns: 1fr; padding: 9px; }
  .audio-assembly-action-controls { display: grid; grid-template-columns: minmax(0, 1fr) repeat(2, auto); }
  .audio-output-choice { min-width: 0; }
  .audio-mix-card { padding: 0 14px; }
  .audio-mix-header, .merge-output-status { flex-direction: column; align-items: stretch; }
  .audio-mix-states { justify-content: flex-start; }
  .audio-mix-section--intro { grid-template-columns: 1fr; row-gap: 10px; }
  .music-source-switch { grid-template-columns: 1fr; }
}

.btn-icon { background: none; border: none; cursor: pointer; font-size: 14px; color: var(--text-muted); padding: 4px; line-height: 1; }
.btn-icon:hover { color: var(--text-primary); }
.btn-icon.danger:hover { color: var(--error); }
.play-btn { color: var(--accent); font-size: 12px; }

.checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; color: var(--text-secondary); }

.music-file-list { display: flex; flex-direction: column; gap: 4px; }
.music-file-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--bg-primary); border-radius: var(--radius-sm); border: 1px solid var(--border); font-size: 13px; }
/* Two-line path display: filename in primary text, directory dimmed
 * below. Surfaces the source folder so the user can tell which file
 * is which when several music folders contain similarly-named files. */
.music-file-path { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.3; }
.music-filename { color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.music-dir { font-size: var(--font-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }

.quick-add-music { padding: 8px; background: var(--bg-primary); border-radius: var(--radius-sm); border: 1px dashed var(--border); }

.music-source-switch {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.music-source-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  min-height: 62px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  color: var(--text-secondary);
  cursor: pointer;
  text-align: left;
}
.music-source-option:hover { border-color: var(--text-secondary); }
.music-source-option.active { border-color: var(--accent); background: var(--accent-dim); color: var(--text-primary); }
.music-source-option strong { font-size: 13px; }
.music-source-option span { font-size: var(--font-xs); line-height: 1.35; }

.noise-preset-grid { display: flex; gap: 10px; flex-wrap: wrap; }
.noise-preset-card { padding: 12px 16px; border-radius: var(--radius-md); background: var(--bg-primary); border: 2px solid var(--border); cursor: pointer; transition: all 0.15s; min-width: 140px; display: flex; flex-direction: column; gap: 4px; }
.noise-preset-card:hover { border-color: var(--text-secondary); }
.noise-preset-card.active { border-color: var(--accent); background: var(--accent-dim); }
.np-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.np-desc { font-size: var(--font-xs); color: var(--text-muted); }

.summary-bar { padding: 10px 14px; background: var(--accent-dim); border-radius: var(--radius-sm); font-size: 13px; color: var(--accent); font-weight: 500; border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent); }

.summary-panel { padding: 16px; background: var(--bg-tertiary); border-radius: var(--radius-md); border: 1px solid var(--border); }
.summary-grid { display: flex; flex-direction: column; gap: 6px; }
.summary-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.summary-row:last-child { border-bottom: none; }
.summary-row .text-muted { min-width: 100px; }

.no-audio-warning { display: flex; gap: 14px; align-items: flex-start; border-left: 3px solid rgba(245, 158, 11, 0.6); }
.warning-icon { font-size: 22px; line-height: 1; flex-shrink: 0; padding-top: 2px; }
.warning-body { flex: 1; min-width: 0; }
.warning-title { margin: 0; font-size: 15px; color: var(--text-primary); }

@media (max-width: 520px) {
  .audio-assembly-action-context { grid-template-columns: 1fr 1fr; }
  .audio-context-item:nth-child(2) { border-right: 0; }
  .audio-context-item:last-child { grid-column: 1 / -1; }
  .audio-assembly-action-controls { grid-template-columns: 1fr; }
  .audio-assembly-action-controls .btn { width: 100%; justify-content: center; }
}

.gen-label { font-size: 13px; color: var(--accent); }
.progress-bar { height: 3px; background: var(--bg-tertiary); border-radius: 2px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--accent); border-radius: 2px; animation: progressIndeterminate 1.5s ease-in-out infinite; }
@keyframes progressIndeterminate { 0% { width: 0%; margin-left: 0; } 50% { width: 60%; margin-left: 20%; } 100% { width: 0%; margin-left: 100%; } }

.scanning-status { display: flex; flex-direction: column; gap: 4px; }

/* Apply-time path check: invalid references are blocking and each row offers
   a direct replacement action. */
.preset-path-check {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: color-mix(in srgb, var(--accent) 5%, transparent);
  border-left: 3px solid color-mix(in srgb, var(--accent) 55%, transparent);
}
.preset-path-check.is-critical {
  background: rgba(226, 92, 92, 0.06);
  border-left-color: var(--error, #e25c5c);
}
.path-check-invalid-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.path-check-title {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  font-weight: 500;
  color: var(--error, #e25c5c);
}
.path-check-hint {
  font-size: var(--font-xs);
  line-height: 1.5;
}
.path-check-list {
  list-style: none;
  margin: 4px 0 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.path-check-row {
  display: grid;
  grid-template-columns: 130px 1fr auto auto;
  gap: 10px;
  align-items: center;
  padding: 6px 8px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm, 4px);
  font-size: 12px;
}
.path-check-field {
  font-weight: 500;
  color: var(--text-primary);
}
.path-check-value {
  font-family: var(--font-mono, monospace);
  font-size: var(--font-xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.path-check-reason {
  font-size: var(--font-xs);
  color: var(--error, #e25c5c);
  white-space: nowrap;
}

/* v1.0.107+ — Music-pool auto-pick banner */
.pool-pick-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: rgba(179, 157, 255, 0.08);
  border-radius: var(--radius-md, 8px);
  border-left: 3px solid #b39dff;
  font-size: 13px;
  flex-wrap: wrap;
}
.ppb-icon {
  font-size: 18px;
  flex-shrink: 0;
}
.ppb-text {
  flex: 1;
  min-width: 0;
}
.ppb-track {
  font-family: var(--mono, ui-monospace, SFMono-Regular, monospace);
  margin-left: 4px;
}
.ppb-reason {
  font-size: var(--font-xs);
  margin-left: 6px;
}
.ppb-action {
  font-size: var(--font-xs);
  white-space: nowrap;
}
</style>
