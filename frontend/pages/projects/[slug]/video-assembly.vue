<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Video Assembly</h1>
    </div>
    <TopActionBar
      :project-slug="slug"
      :presets="videoBundlePresets"
      v-model:episode-id="episodeId"
      filter-field="video_assembly"
      generate-label="Generate Video"
      loading-label="Rendering…"
      :generate-loading="generating"
      :generate-disabled="!episodeId"
      :generate-status="generating ? `Rendering video for ${selectedEpisode?.title || episodeId}…${activeJobProgress > 0 ? ` (${activeJobProgress}%)` : ''}` : ''"
      @generate="generateVideo"
      @episode-selected="onEpisodeSelected"
      @preset-applied="success('Bundle applied — all 5 steps updated')"
      @preset-saved="success('Bundle saved')"
      @preset-deleted="success('Bundle deleted')"
    />

    <p class="text-muted mt-1 mb-2">
      Assemble scene images (or AI clips), narration, and music into a finished video via FFmpeg.
      The 6 steps are: <strong>Intro → Title Image → Scene Images → Audio → Effects & Overlays → Export</strong> —
      outputs a single <code>.mp4</code> in the episode's <code>10 Video Assembly Output</code> folder.
    </p>

    <!-- Stepper Bar -->
    <div class="stepper mt-3">
      <template v-for="step in 6" :key="step">
        <div
          :class="['step-circle', { active: currentStep === step, completed: step < maxStepReached && step < currentStep }]"
          @click="goToStep(step)"
          :title="stepLabels[step - 1]"
        >
          <span v-if="step < maxStepReached && step < currentStep">&#10003;</span>
          <span v-else>{{ step }}</span>
        </div>
        <div v-if="step < 6" :class="['step-line', { completed: step < currentStep }]" />
      </template>
    </div>
    <div class="step-labels">
      <span v-for="(label, i) in stepLabels" :key="i" :class="{ active: currentStep === i + 1 }">{{ label }}</span>
    </div>

    <!-- ============ STEP 1: Select & Validate Assets ============ -->
    <div v-if="currentStep === 1" class="card mt-2">
      <h3>Step 1: Select &amp; Validate Assets</h3>
      <p class="text-muted mt-1">Choose an episode and scan for available scene images and audio</p>

      <div class="ffmpeg-status mt-2" v-if="ffmpegStatus">
        <span v-if="ffmpegStatus.installed" class="badge badge-success">
          FFmpeg installed{{ ffmpegStatus.version ? ` (v${ffmpegStatus.version})` : '' }}
        </span>
        <template v-else-if="ffmpegStatus.check_error">
          <!-- The check itself failed (backend unreachable, permission
               error, corrupt binary). Distinct from "not installed" —
               the operator's next move is "fix the backend / re-run the
               check", not "click Install FFmpeg". -->
          <span class="badge badge-warn" :title="ffmpegStatus.check_error">FFmpeg check failed</span>
          <button class="btn btn-sm btn-secondary ml-2-tight" @click="checkFfmpeg">Retry check</button>
        </template>
        <template v-else>
          <span class="badge badge-error">FFmpeg not found</span>
          <!-- Video assembly is the heaviest FFmpeg consumer in the app
               (xfade, encode, vignette, etc). When missing, route the
               user straight to Settings → FFmpeg where the one-click
               installer lives. -->
          <NuxtLink :to="`/projects/${slug}/settings#ffmpeg`" class="btn btn-sm btn-primary ml-2-tight">
            Install FFmpeg →
          </NuxtLink>
        </template>
        <span v-if="ffmpegStatus.installed && ffmpegStatus.has_drawtext" class="badge badge-success">Text overlays</span>
        <span v-if="ffmpegStatus.installed && !ffmpegStatus.has_drawtext" class="badge badge-warn">Text overlays unavailable</span>
      </div>
      <div v-if="ffmpegStatus?.check_error" class="ffmpeg-warning mt-1">
        <p class="text-muted text-md">
          We couldn't determine FFmpeg's status: <code>{{ ffmpegStatus.check_error }}</code>.
          This is different from "not installed" — likely the backend is unreachable, the
          binary isn't executable, or detection hit a permissions error. Try the
          <NuxtLink :to="`/projects/${slug}/settings#ffmpeg`" class="ffmpeg-inline-link">FFmpeg page in Settings</NuxtLink>
          for the full diagnostic.
        </p>
      </div>
      <div v-else-if="ffmpegStatus && !ffmpegStatus.installed" class="ffmpeg-warning mt-1">
        <p class="text-muted text-md">
          FFmpeg is required to assemble videos. Use the
          <NuxtLink :to="`/projects/${slug}/settings#ffmpeg`" class="ffmpeg-inline-link">one-click installer in Settings</NuxtLink>,
          or install manually with <code>brew install ffmpeg</code>.
        </p>
      </div>
      <div v-if="ffmpegStatus?.installed && !ffmpegStatus?.has_drawtext" class="ffmpeg-warning mt-1">
        <p class="text-muted text-md">
          Text overlays (title cards, chapter titles) require the <code>drawtext</code> filter. The
          <NuxtLink :to="`/projects/${slug}/settings#ffmpeg`" class="ffmpeg-inline-link">bundled FFmpeg</NuxtLink>
          in Settings includes drawtext + libass — re-installing from there usually fixes this.
        </p>
        <p class="text-muted text-sm hint-line">
          Videos will still generate without text — just the black/colored cards without the text overlay.
        </p>
      </div>

      <div v-if="scanning" class="scanning-status mt-2">
        <span class="gen-label">Scanning assets...</span>
        <div class="progress-bar"><div class="progress-fill" /></div>
      </div>

      <div v-if="scannedAssets && !scanning" class="assets-overview mt-2">
        <h4>Found Assets</h4>

        <!-- Scene Images -->
        <div class="asset-section mt-1">
          <label>Scene Images ({{ scannedAssets.scenes?.length || 0 }})</label>
          <div class="thumb-grid mt-1" v-if="scannedAssets.scenes?.length">
            <div
              v-for="(img, i) in scannedAssets.scenes"
              :key="i"
              class="scene-thumb-small"
              :title="img.filename"
            >
              {{ img.number || Number(i) + 1 }}
            </div>
          </div>
          <p v-else class="text-muted text-md">No scene images found</p>
        </div>

        <!-- Thumbnails -->
        <div class="asset-section mt-2" v-if="scannedAssets.thumbnails?.length">
          <label>Thumbnails ({{ scannedAssets.thumbnails.length }})</label>
          <div class="thumb-grid mt-1">
            <div
              v-for="(thumb, i) in scannedAssets.thumbnails"
              :key="i"
              class="scene-thumb-small"
              :title="thumb.filename"
            >
              T{{ Number(i) + 1 }}
            </div>
          </div>
        </div>

        <!-- Merged Audio (primary input — produced by the upstream Audio Assembly step) -->
        <div class="asset-section mt-2">
          <label>Merged Audio</label>
          <div v-if="hasMergedAudio" class="merged-audio-row">
            <span class="badge badge-success mr-2-tight">✓ Ready</span>
            <span class="audio-name flex-1">{{ scannedAssets.merged_audio[0].filename }}</span>
            <span class="text-muted text-sm">{{ formatDuration(scannedAssets.merged_audio[0].duration) }}</span>
          </div>
          <div v-else class="validation-msg">
            No merged audio file found. Run the <strong>Audio Assembly</strong> step first to produce a single merged track.
          </div>
          <p v-if="scannedAssets.skip_chapters" class="text-muted text-xs hint-line">
            Individual chapter/intro audio files are ignored — the merged track is authoritative.
          </p>
        </div>

        <!-- Already-rendered videos (informational) -->
        <div class="asset-section mt-2" v-if="scannedAssets.rendered_videos?.length">
          <label>Previously Rendered</label>
          <div class="audio-list mt-1">
            <div v-for="(v, i) in scannedAssets.rendered_videos" :key="i" class="audio-item">
              <span class="audio-name">{{ v.filename }}</span>
              <span class="text-muted text-sm">{{ formatRelativeTime(v.mtime) }}</span>
            </div>
          </div>
          <p class="text-muted text-xs hint-line">
            Re-running assembly will produce a new versioned file — it will not overwrite these.
          </p>
        </div>

        <!-- Validation Messages -->
        <div v-if="!step1Valid" class="validation-msg mt-2">
          <span v-if="!scannedAssets.scenes?.length">* At least 1 scene image is required</span>
          <span v-if="!hasMergedAudio">* Merged audio file is required (run Audio Assembly first)</span>
        </div>
      </div>

      <div class="step-nav mt-3">
        <span />
        <button class="btn btn-primary" :disabled="!step1Valid" @click="goToStep(2)">Continue</button>
      </div>
    </div>

    <!-- ============ STEP 2: Branding & Intro ============ -->
    <div v-if="currentStep === 2" class="card mt-2">
      <h3>Step 2: Intro</h3>
      <p class="text-muted mt-1">Optional pre-roll clip that plays before the title image and scenes.</p>

      <PresetPicker
        label="Intro preset"
        hint="Captures the intro clip settings below. Use 'Save as…' to name a new preset."
        :presets="introPresets.presets.value"
        :active-id="introPresets.activeId.value"
        @update:active-id="introPresets.setActive"
        @apply="introPresets.applyActive(); success('Intro preset applied')"
        @overwrite="introPresets.overwrite(); success('Intro preset saved')"
        @save-as="(n) => introPresets.saveAs(n).then(() => success('Intro preset saved'))"
        @delete="introPresets.remove(); success('Intro preset deleted')"
      />

      <!-- Intro Video -->
      <div class="settings-section mt-2">
        <div class="flex gap-2 items-center">
          <label class="checkbox-label" @click.stop>
            <input type="checkbox" v-model="intro.enabled" />
          </label>
          <h4>Intro Video</h4>
        </div>

        <div v-if="intro.enabled" class="mt-2">
          <div class="form-group">
            <label>Intro Video Path <span class="text-muted text-xs">(.mp4, .mov, .mkv, .webm)</span></label>
            <FilePicker
              v-model="intro.video_path"
              placeholder="Path to intro video file"
              :filters="[{ name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'webm'] }]"
              title="Choose an intro video"
              aria-label="Intro video path"
              clearable
            />
          </div>
          <label class="checkbox-label mt-1">
            <input type="checkbox" v-model="intro.save_as_default" />
            Set as project default
          </label>
          <p class="text-muted text-sm mt-1">The intro video will play before the title image and scenes</p>
        </div>
      </div>

      <!-- Outro Video -->
      <div class="settings-section mt-2">
        <div class="flex gap-2 items-center">
          <label class="checkbox-label" @click.stop>
            <input type="checkbox" v-model="outro.enabled" />
          </label>
          <h4>Outro Video</h4>
        </div>

        <div v-if="outro.enabled" class="mt-2">
          <div class="form-group">
            <label>Outro Video Path <span class="text-muted text-xs">(.mp4, .mov, .mkv, .webm)</span></label>
            <FilePicker
              v-model="outro.video_path"
              placeholder="Path to outro video file"
              :filters="[{ name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'webm'] }]"
              title="Choose an outro video"
              aria-label="Outro video path"
              clearable
            />
          </div>
          <p class="text-muted text-sm mt-1">
            The outro clip plays at the very end — after the post-audio tail. It never receives
            effects (no colour grading, vignette, or grain), so a pre-made black-screen or
            branded clip slots in cleanly without bloating file size.
          </p>
        </div>
      </div>

      <!-- Timeline clips (user-supplied, multi-position) -->
      <div class="settings-section mt-2">
        <div class="flex gap-2 items-center justify-between">
          <h4 class="m-0">Timeline Clips</h4>
          <button class="btn btn-sm btn-secondary" @click="addTimelineClip">+ Add clip</button>
        </div>
        <p class="text-muted text-sm mt-1">
          Insert your own video clips at named positions in the final render — sponsor stings, credits,
          black-screen padding, etc. Clips play in the order shown within each anchor. They're always
          effect-free (no colour grade, vignette, or grain) and don't go through the scene transitions.
          Use <strong>After outro (very end)</strong> for sleep-story black screens so the channel
          "dark room" stays uninterrupted.
        </p>
        <div v-if="!timelineClips.length" class="text-muted text-sm mt-1 italic-empty">
          No timeline clips yet. Use the button above to add one.
        </div>
        <div v-for="(clip, i) in timelineClips" :key="clip.id" class="timeline-clip-row mt-2">
          <div class="flex gap-2 items-center timeline-clip-header">
            <span class="text-muted text-xs timeline-clip-num">#{{ i + 1 }}</span>
            <label class="checkbox-label m-0" :title="clip.enabled ? 'Click to disable this clip' : 'Click to enable this clip'">
              <input type="checkbox" v-model="clip.enabled" />
            </label>
            <select
              :value="clip.kind || 'video'"
              class="select select-sm timeline-kind-select"
              :title="TIMELINE_KIND_OPTIONS.find(o => o.value === (clip.kind || 'video'))?.hint"
              @change="setTimelineClipKind(clip.id, ($event.target as HTMLSelectElement).value as TimelineClipKind)"
            >
              <option v-for="opt in TIMELINE_KIND_OPTIONS" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
            <select v-model="clip.anchor" class="select select-sm timeline-anchor-select" :title="TIMELINE_ANCHOR_OPTIONS.find(o => o.value === clip.anchor)?.hint">
              <option v-for="opt in TIMELINE_ANCHOR_OPTIONS" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
            <div class="flex gap-1 ml-auto">
              <button class="btn btn-sm btn-secondary" :disabled="i === 0" @click="moveTimelineClip(clip.id, -1)" title="Move up">▲</button>
              <button class="btn btn-sm btn-secondary" :disabled="i === timelineClips.length - 1" @click="moveTimelineClip(clip.id, 1)" title="Move down">▼</button>
              <button class="btn btn-sm btn-danger" @click="removeTimelineClip(clip.id)" title="Remove this clip">✕</button>
            </div>
          </div>

          <!-- Video kind: pick an .mp4/.mov/.mkv/.webm. -->
          <FilePicker
            v-if="(clip.kind || 'video') === 'video'"
            v-model="clip.video_path"
            placeholder="Path to video file"
            :filters="[{ name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'webm'] }]"
            title="Choose a timeline clip"
            :aria-label="`Timeline clip ${i + 1} path`"
            clearable
          />

          <!-- Static kind: image picker + duration in minutes. Stored as
               seconds on the clip; the UI converts for legibility (a 2-hour
               sleep-story tail is much easier to enter as 120 min). -->
          <template v-else>
            <FilePicker
              v-model="(clip as TimelineClipStatic).image_path"
              placeholder="Path to still image"
              :filters="[{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]"
              title="Choose a still image for the static segment"
              :aria-label="`Timeline clip ${i + 1} image path`"
              clearable
            />
            <div class="flex gap-2 mt-1 items-center">
              <label class="dim-inline-label">Duration (min)</label>
              <input
                type="number"
                class="input input-sm input-w-100"
                min="0.1"
                step="0.5"
                :value="clipDurationMinutes(clip as TimelineClipStatic)"
                @input="setClipDurationMinutes(clip as TimelineClipStatic, parseFloat(($event.target as HTMLInputElement).value))"
              />
              <span class="text-muted text-xs">
                = {{ ((clip as TimelineClipStatic).duration_sec || 0).toFixed(0) }}s
              </span>
            </div>
            <p class="text-muted text-xs mt-1">
              Static segment — pipeline synthesises this from the single image at the project's resolution + fps.
              Audio (background music / ambient noise) comes from the Music tab in Step 4 and loops automatically across this duration.
            </p>
          </template>

          <p class="text-muted text-xs mt-1">
            {{ TIMELINE_ANCHOR_OPTIONS.find(o => o.value === clip.anchor)?.hint }}
          </p>
        </div>
      </div>

      <div class="step-nav mt-3">
        <button class="btn btn-secondary" @click="goToStep(1)">Back</button>
        <button class="btn btn-primary" @click="goToStep(3)">Continue</button>
      </div>
    </div>

    <!-- ============ STEP 3: Title & Timeline ============ -->
    <div v-if="currentStep === 3" class="card mt-2">
      <h3>Step 3: Title &amp; Timeline</h3>
      <p class="text-muted mt-1">Configure title image, scene recycling, and transitions</p>

      <PresetPicker
        label="Timeline preset"
        hint="Captures everything on this step — title image, recycling, duration, post-audio, transition and animation."
        :presets="timelinePresets.presets.value"
        :active-id="timelinePresets.activeId.value"
        @update:active-id="timelinePresets.setActive"
        @apply="timelinePresets.applyActive(); success('Timeline preset applied')"
        @overwrite="timelinePresets.overwrite(); success('Timeline preset saved')"
        @save-as="(n) => timelinePresets.saveAs(n).then(() => success('Timeline preset saved'))"
        @delete="timelinePresets.remove(); success('Timeline preset deleted')"
      />

      <!-- Title Image -->
      <div class="settings-section mt-2">
        <div class="flex gap-2 items-center">
          <label class="checkbox-label" @click.stop>
            <input type="checkbox" v-model="titleImage.enabled" />
          </label>
          <h4>Title Image</h4>
        </div>

        <div v-if="titleImage.enabled" class="mt-2">
          <!-- Thumbnail picker with image previews -->
          <div v-if="scannedAssets?.thumbnails?.length" class="form-group">
            <label>Select Thumbnail</label>
            <div class="thumb-picker-images mt-1">
              <div
                v-for="(thumb, i) in scannedAssets.thumbnails"
                :key="i"
                :class="['thumb-card-img', { selected: titleImage.image_path === thumb.path }]"
                @click="titleImage.image_path = thumb.path"
                :title="thumb.filename"
              >
                <img :src="getImagePreviewUrl(thumb.path)" :alt="thumb.filename" class="thumb-preview" />
                <span class="thumb-label">T{{ Number(i) + 1 }}</span>
              </div>
            </div>
          </div>

          <div class="form-group mt-1">
            <label>Custom Image Path</label>
            <FilePicker
              v-model="titleImage.image_path"
              placeholder="Path to title image (or pick from thumbnails above)"
              :filters="[{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]"
              title="Choose a title image"
              aria-label="Title image path"
              clearable
            />
          </div>

          <!-- Title Image Preview -->
          <div v-if="titleImage.enabled && titleImage.image_path" class="title-image-preview mt-2">
            <div class="flex gap-2 items-center justify-between flex-wrap">
              <label class="sub-section-label">Preview</label>
              <button
                type="button"
                class="btn btn-sm btn-secondary"
                title="Edit this image with AI — describe what to change in plain English. Source is never overwritten unless you opt in."
                @click="openImageEditor(titleImage.image_path, 'title')"
              >
                🪄 Edit with AI
              </button>
            </div>
            <div class="preview-frame mt-1">
              <img :src="getImagePreviewUrl(titleImage.image_path)" alt="Title image preview" class="preview-img" />
            </div>
            <p class="text-muted text-xs hint-line">This image will display for {{ titleImage.duration }}s before scenes begin</p>
          </div>

          <div class="grid-3 mt-1">
            <div class="form-group">
              <label>Duration ({{ titleImage.duration }}s)</label>
              <SliderWithNumber v-model="titleImage.duration" :min="1" :max="15" :step="1" suffix="s" />
              <p class="text-muted text-xs hint-line">
                Adds {{ titleImage.duration }}s to the total runtime. Typical sleep-story range: 3–5s.
              </p>
            </div>
            <div class="form-group">
              <label>Transition Type</label>
              <select v-model="titleImage.transition_type" class="select">
                <option value="">Use main transition</option>
                <option value="crossfade">Crossfade</option>
                <option value="fade-black">Fade to Black</option>
                <option value="dissolve">Dissolve</option>
                <option value="wipe-left">Wipe Left</option>
                <option value="wipe-right">Wipe Right</option>
                <option value="none">None</option>
              </select>
            </div>
            <div class="form-group">
              <label>Transition Duration ({{ titleImage.transition_duration || transition.duration }}s)</label>
              <SliderWithNumber
                v-model="titleImage.transition_duration"
                :min="0.5"
                :max="3.0"
                :step="0.1"
                :decimals="1"
                suffix="s"
                :disabled="titleImage.transition_type === 'none'"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Scene Recycling -->
      <div class="settings-section mt-2">
        <h4>Scene Recycling</h4>
        <p class="text-muted text-sm hint-line">
          Scenes cycle through in order, repeating until the audio finishes. Video length is fixed by the narration —
          recycling only affects <em>pacing</em>: fewer seconds per scene = faster cuts, more seconds = slower pacing.
          Excluded scenes are skipped entirely.
        </p>

        <div class="grid-2 mt-2">
          <div class="form-group">
            <label>Seconds Per Scene</label>
            <input v-model.number="sceneRecycling.seconds_per_scene" type="number" min="1" max="60" class="input input-sm input-w-80" />
            <p class="text-muted text-xs hint-line">
              Sleep-story default 20–40s. Shorter is more energetic; longer keeps the viewer settled.
            </p>
          </div>
          <div class="form-group">
            <label class="checkbox-label mt-1">
              <input type="checkbox" v-model="sceneRecycling.shuffle" />
              Shuffle scene order on each cycle
            </label>
            <p class="text-muted text-xs hint-line-tight">
              Off = scenes play in numerical order. On = random order per cycle, reduces repetition feeling.
            </p>
          </div>
        </div>

        <!-- Scene Exclude Cards -->
        <div v-if="scenes.length" class="mt-2">
          <label class="sub-section-label">
            Scene Selection <span class="text-muted font-normal">(click to exclude)</span>
          </label>
          <div class="scene-exclude-grid mt-1">
            <div v-for="scene in scenes" :key="scene.number"
              :class="['scene-exclude-card', { excluded: sceneRecycling.excluded_scenes.includes(scene.number) }]"
              @click="toggleSceneExclude(scene.number)"
              :title="sceneRecycling.excluded_scenes.includes(scene.number) ? 'Excluded - click to include' : 'Included - click to exclude'"
            >
              {{ scene.number }}
            </div>
          </div>
          <p class="text-muted text-xs hint-line">
            {{ scenes.length - sceneRecycling.excluded_scenes.length }} of {{ scenes.length }} scenes active
          </p>
        </div>
      </div>

      <!-- Transition Settings -->
      <div class="settings-section mt-2">
        <div class="flex gap-2 items-center justify-between flex-wrap">
          <h4>Scene Transitions</h4>
          <div class="flex gap-2 items-center">
            <button class="btn btn-sm btn-secondary" @click="transition.type = 'none'">Hard cut</button>
            <PresetPicker
              v-if="transitionPresets"
              label="Transition preset"
              :presets="transitionPresets.presets.value"
              :active-id="transitionPresets.activeId.value"
              @update:active-id="transitionPresets.setActive"
              @apply="transitionPresets.applyActive(); success('Transition preset applied')"
              @overwrite="transitionPresets.overwrite(); success('Transition preset saved')"
              @save-as="(n) => transitionPresets.saveAs(n).then(() => success('Transition preset saved'))"
              @delete="transitionPresets.remove(); success('Transition preset deleted')"
            />
          </div>
        </div>
        <p class="text-muted text-sm hint-line">
          Pick one primary transition, optionally tick additional ones into a pool for randomization.
        </p>

        <div v-if="!transitionsCatalog.length" class="text-muted text-sm catalog-loading">Loading transitions…</div>
        <TransitionPicker
          v-else
          :slug="slug"
          :episode-id="episodeId"
          :transitions="transitionsCatalog"
          :primary-id="transition.type"
          :pool="transition.pool"
          :duration="transition.duration"
          :randomize-mode="transition.randomize_mode"
          @update:primary-id="(id) => transition.type = id"
          @update:pool="(p) => transition.pool = p"
          @update:duration="(d) => transition.duration = d"
          @update:randomize-mode="(m) => transition.randomize_mode = m"
        />
      </div>

      <!-- Scene Animation -->
      <div class="settings-section mt-2">
        <div class="flex gap-2 items-center justify-between flex-wrap">
          <h4>Scene Animation</h4>
          <PresetPicker
            v-if="animationPresets"
            label="Animation preset"
            :presets="animationPresets.presets.value"
            :active-id="animationPresets.activeId.value"
            @update:active-id="animationPresets.setActive"
            @apply="animationPresets.applyActive(); success('Animation preset applied')"
            @overwrite="animationPresets.overwrite(); success('Animation preset saved')"
            @save-as="(n) => animationPresets.saveAs(n).then(() => success('Animation preset saved'))"
            @delete="animationPresets.remove(); success('Animation preset deleted')"
          />
        </div>
        <p class="text-muted text-sm hint-line">
          How each scene image moves — pick one, or tick a pool and turn on randomize.
        </p>

        <div v-if="!animationsCatalog.length" class="text-muted text-sm catalog-loading">Loading animations…</div>
        <AnimationPicker
          v-else
          :slug="slug"
          :episode-id="episodeId"
          :animations="animationsCatalog"
          :primary-id="sceneAnimation.type"
          :pool="sceneAnimation.pool"
          :randomize-mode="sceneAnimation.randomize_mode"
          @update:primary-id="(id) => sceneAnimation.type = id"
          @update:pool="(p) => sceneAnimation.pool = p"
          @update:randomize-mode="(m) => sceneAnimation.randomize_mode = m"
        />

        <!-- Ken Burns controls -->
        <div v-if="sceneAnimation.type === 'ken-burns'" class="mt-2">
          <div class="grid-2">
            <div class="form-group">
              <label>Start Zoom ({{ sceneAnimation.zoom_start }}%)</label>
              <SliderWithNumber v-model="sceneAnimation.zoom_start" :min="90" :max="120" :step="1" suffix="%" />
            </div>
            <div class="form-group">
              <label>End Zoom ({{ sceneAnimation.zoom_end }}%)</label>
              <SliderWithNumber v-model="sceneAnimation.zoom_end" :min="95" :max="130" :step="1" suffix="%" />
            </div>
          </div>
        </div>

        <!-- Parallax controls -->
        <div v-if="sceneAnimation.type === 'parallax-drift'" class="mt-2">
          <div class="grid-2">
            <div class="form-group">
              <label>Direction</label>
              <select v-model="sceneAnimation.parallax_direction" class="select">
                <option value="left">Left</option>
                <option value="right">Right</option>
                <option value="up">Up</option>
                <option value="down">Down</option>
              </select>
            </div>
            <div class="form-group">
              <label>Speed ({{ sceneAnimation.parallax_speed }})</label>
              <SliderWithNumber v-model="sceneAnimation.parallax_speed" :min="1" :max="5" :step="1" />
            </div>
          </div>
        </div>

        <!-- Breathe controls -->
        <div v-if="sceneAnimation.type === 'breathe'" class="mt-2">
          <div class="grid-2">
            <div class="form-group">
              <label>Base Zoom ({{ sceneAnimation.breathe_base_zoom }}%)</label>
              <SliderWithNumber v-model="sceneAnimation.breathe_base_zoom" :min="100" :max="110" :step="1" suffix="%" />
            </div>
            <div class="form-group">
              <label>Amplitude ({{ sceneAnimation.breathe_amplitude }}%)</label>
              <SliderWithNumber v-model="sceneAnimation.breathe_amplitude" :min="1" :max="5" :step="1" suffix="%" />
            </div>
          </div>
        </div>

        <!-- Fade-in info -->
        <div v-if="sceneAnimation.type === 'fade-in'" class="mt-2">
          <p class="text-muted text-sm">Each scene will fade in from black over 1.5 seconds</p>
        </div>
      </div>

      <!-- Target Duration -->
      <div class="settings-section mt-2">
        <h4>Target Duration</h4>
        <div class="flex gap-2 mt-1 items-center">
          <button
            :class="['btn btn-sm', duration.mode === 'auto' ? 'btn-primary' : 'btn-secondary']"
            @click="duration.mode = 'auto'"
          >Auto (match audio)</button>
          <button
            :class="['btn btn-sm', duration.mode === 'custom' ? 'btn-primary' : 'btn-secondary']"
            @click="duration.mode = 'custom'"
          >Custom range</button>
        </div>

        <div v-if="duration.mode === 'custom'" class="grid-2 mt-1">
          <div class="form-group">
            <label>Minimum Duration</label>
            <div class="flex gap-2">
              <input v-model.number="duration.min_hours" type="number" min="0" max="10" class="input input-sm hm-num-input" />
              <span class="text-muted hm-num-suffix">h</span>
              <input v-model.number="duration.min_minutes" type="number" min="0" max="59" class="input input-sm hm-num-input" />
              <span class="text-muted hm-num-suffix">m</span>
            </div>
          </div>
          <div class="form-group">
            <label>Maximum Duration</label>
            <div class="flex gap-2">
              <input v-model.number="duration.max_hours" type="number" min="0" max="10" class="input input-sm hm-num-input" />
              <span class="text-muted hm-num-suffix">h</span>
              <input v-model.number="duration.max_minutes" type="number" min="0" max="59" class="input input-sm hm-num-input" />
              <span class="text-muted hm-num-suffix">m</span>
            </div>
          </div>
        </div>
        <p v-if="duration.mode === 'custom'" class="text-muted text-sm mt-1">
          A random duration between min and max will be chosen each time to vary video length
        </p>

        <!-- Duration summary -->
        <div class="summary-bar mt-2">
          <template v-if="duration.mode === 'auto'">
            Target: Auto ({{ formatDurationLong(totalAudioDuration) }}) -- scenes will cycle ~{{ estimatedCycles }} times
          </template>
          <template v-else>
            Target: {{ formatDurationLong(minDurationSec) }} -- {{ formatDurationLong(maxDurationSec) }} (scenes will cycle ~{{ estimatedCycles }} times)
          </template>
        </div>
      </div>

      <!-- Post-Audio Behavior -->
      <div class="settings-section mt-2">
        <h4>After Narration Ends</h4>
        <p class="text-muted text-sm hint-line">What happens to the video after all narration audio has played</p>

        <div class="post-audio-grid mt-2">
          <div v-for="pa in postAudioOptions" :key="pa.id"
            :class="['post-audio-card', { active: postAudio.behavior === pa.id }]"
            @click="postAudio.behavior = pa.id">
            <span class="pa-icon" v-html="pa.icon" />
            <span class="pa-name">{{ pa.label }}</span>
            <span class="pa-desc">{{ pa.description }}</span>
          </div>
        </div>

        <div v-if="postAudio.behavior === 'fade-to-black'" class="mt-2">
          <div class="form-group field-narrow">
            <label>Fade Duration ({{ postAudio.fade_duration }}s)</label>
            <SliderWithNumber v-model="postAudio.fade_duration" :min="3" :max="15" :step="1" suffix="s" />
          </div>
        </div>

        <div class="summary-bar mt-2" v-if="postAudioSummary">
          {{ postAudioSummary }}
        </div>
      </div>

      <div class="step-nav mt-3">
        <button class="btn btn-secondary" @click="goToStep(2)">Back</button>
        <button class="btn btn-primary" @click="goToStep(4)">Continue</button>
      </div>
    </div>

    <!-- ============ STEP 4: Effects & Overlays ============ -->
    <div v-if="currentStep === 4" class="card mt-2">
      <h3>Step 4: Effects &amp; Overlays</h3>
      <p class="text-muted mt-1">Color grading, visual effects, and optional text + logo overlays.</p>

      <PresetPicker
        label="Effects preset"
        hint="Captures logo, color grading, vignette, grain, letterbox, chroma key, and all the text overlays."
        :presets="effectsPresets.presets.value"
        :active-id="effectsPresets.activeId.value"
        @update:active-id="effectsPresets.setActive"
        @apply="effectsPresets.applyActive(); success('Effects preset applied')"
        @overwrite="effectsPresets.overwrite(); success('Effects preset saved')"
        @save-as="(n) => effectsPresets.saveAs(n).then(() => success('Effects preset saved'))"
        @delete="effectsPresets.remove(); success('Effects preset deleted')"
      />

      <!-- Split layout: sticky preview left, scrollable controls right -->
      <div class="effects-split-layout mt-2">
        <!-- LEFT: Sticky Effect Preview -->
        <div class="effects-preview-sticky" v-if="previewSceneImage">
          <div class="effect-preview-frame">
            <img :src="getImagePreviewUrl(previewSceneImage)" alt="Preview" class="effect-preview-img" :style="effectPreviewImgStyle" />
            <div v-if="vignette.enabled" class="effect-vignette-overlay" :style="vignetteOverlayStyle" />
            <div v-if="filmGrain.enabled" class="effect-grain-overlay" :style="{ opacity: filmGrain.strength / 80 }" />
            <template v-if="letterbox.enabled">
              <div class="letterbox-bar letterbox-top" :style="{ height: letterboxBarHeight, background: letterbox.color || 'black' }" />
              <div class="letterbox-bar letterbox-bottom" :style="{ height: letterboxBarHeight, background: letterbox.color || 'black' }" />
            </template>
            <!-- Unified overlay preview: logo composites onto the same
                 canvas used for effects, so the user sees the full stack. -->
            <img
              v-if="logo.enabled && logo.image_path"
              :src="getImagePreviewUrl(logo.image_path)"
              alt="Logo preview"
              class="effect-logo-overlay"
              :style="logoEffectPreviewStyle"
              @error="logoLoadError = true"
              @load="logoLoadError = false"
            />
          </div>
          <p class="text-muted preview-watermark">Live CSS preview — not FFmpeg render</p>
          <!-- Pain-point #14 fix: make the silent logo-load failure visible. -->
          <!-- Previously logoLoadError was set but never rendered, so users -->
          <!-- only discovered the broken path on export. -->
          <div v-if="logo.enabled && logo.image_path && logoLoadError" class="logo-error-note">
            ⚠ Could not load logo image from <code>{{ logo.image_path }}</code>. Re-pick the file below or check the path exists.
          </div>
        </div>

        <!-- RIGHT: Scrollable effect controls -->
        <div class="effects-controls-scroll">

      <!-- Logo Overlay (moved from old Step 2) -->
      <div class="settings-section mt-2">
        <div class="flex gap-2 items-center">
          <label class="checkbox-label" @click.stop>
            <input type="checkbox" v-model="logo.enabled" />
          </label>
          <h4>Logo Overlay</h4>
        </div>

        <div v-if="logo.enabled" class="mt-2">
          <div class="form-group">
            <label>Logo Image Path <span class="text-muted text-xs">(PNG recommended)</span></label>
            <FilePicker
              v-model="logo.image_path"
              placeholder="Path to logo image (e.g. /path/to/logo.png)"
              :filters="[{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]"
              title="Choose a logo image"
              aria-label="Logo image path"
              clearable
            />
            <button
              v-if="logo.image_path"
              type="button"
              class="btn btn-sm btn-secondary mt-1"
              title="Edit the logo with AI — useful for removing baked-in text or cleaning the background around a transparent PNG."
              @click="openImageEditor(logo.image_path, 'logo')"
            >
              🪄 Edit with AI
            </button>
          </div>

          <div class="grid-2 mt-1">
            <div>
              <label class="sub-section-label">Position</label>
              <div class="position-grid mt-1">
                <div v-for="pos in logoPositions" :key="pos.id"
                  :class="['pos-cell', { active: logo.position === pos.id }]"
                  @click="logo.position = pos.id"
                  :title="pos.label">
                  <span class="pos-dot" />
                </div>
              </div>
              <button
                :class="['btn btn-sm mt-1 text-xs', logo.position === 'custom' ? 'btn-primary' : 'btn-secondary']"
                @click="logo.position = 'custom'"
              >Custom</button>

              <div v-if="logo.position === 'custom'" class="flex gap-2 mt-1">
                <div class="form-group flex-1">
                  <label>X (px)</label>
                  <input v-model.number="logo.custom_x" type="number" min="0" class="input input-sm" />
                </div>
                <div class="form-group flex-1">
                  <label>Y (px)</label>
                  <input v-model.number="logo.custom_y" type="number" min="0" class="input input-sm" />
                </div>
              </div>
            </div>

            <div>
              <div class="form-group">
                <label>Opacity ({{ logo.opacity }}%)</label>
                <SliderWithNumber v-model="logo.opacity" :min="0" :max="100" :step="1" suffix="%" />
              </div>
              <div class="form-group mt-1">
                <label>Scale ({{ logo.scale }}% of video width)</label>
                <SliderWithNumber v-model="logo.scale" :min="1" :max="50" :step="1" suffix="%" />
              </div>
              <div class="form-group mt-1">
                <label>Margin ({{ logo.margin }}px)</label>
                <input v-model.number="logo.margin" type="number" min="0" max="200" class="input input-sm input-w-80" />
              </div>
              <label class="checkbox-label mt-1" title="When enabled, the logo stays hidden for the full duration of the intro clip and fades in as the title image appears. Useful when your intro already has its own branding.">
                <input type="checkbox" v-model="logo.hide_during_intro" />
                Hide during intro
              </label>
              <p class="text-muted text-xs hint-line-tight">
                Logo is invisible for the intro's full duration, then fades in over the title image.
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Color Grading -->
      <div class="settings-section mt-2">
        <div class="flex gap-2 items-center">
          <label class="checkbox-label" @click.stop>
            <input type="checkbox" v-model="colorGrading.enabled" />
          </label>
          <h4>Color Grading</h4>
        </div>

        <div v-if="colorGrading.enabled" class="mt-2">
          <!-- Preset grid: 1 None + 18 themed presets in a responsive
               auto-fill grid; Custom button sits below to make "I'm
               dialing my own values" a first-class state. -->
          <label class="sub-section-label">Preset</label>
          <div class="preset-grid mt-1">
            <div v-for="cp in colorGradingPresets" :key="cp.id"
              :class="['preset-card', { active: colorGrading.preset === cp.id }]"
              @click="applyColorPreset(cp.id)">
              <span class="preset-name">{{ cp.label }}</span>
              <span class="preset-desc">{{ cp.description }}</span>
            </div>
          </div>
          <button
            type="button"
            :class="['preset-custom-btn mt-1', { active: colorGrading.preset === 'custom' }]"
            :title="customPresetActive ? 'You\'ve customised the values below' : 'Start from neutral and dial in your own look'"
            @click="applyColorPreset('custom')"
          >
            <span class="preset-custom-label">Custom</span>
            <span class="preset-custom-hint">{{ customPresetActive ? 'Using your fine-tune values' : 'Use the sliders below' }}</span>
          </button>

          <!-- Fine-tune sliders -->
          <label class="sub-section-label sub-section-block mt-2">Fine-Tune Adjustments</label>
          <p class="text-muted text-xs fine-tune-hint">
            Small changes go a long way on video — try staying within ±0.15 for brightness/warmth/tint, and 0.85–1.15 for contrast/saturation unless you're going for an obvious stylised look.
          </p>
          <div class="grid-3 mt-1">
            <div class="form-group">
              <label>Brightness ({{ colorGrading.brightness > 0 ? '+' : '' }}{{ colorGrading.brightness.toFixed(2) }})</label>
              <SliderWithNumber v-model="colorGrading.brightness" :min="-0.5" :max="0.5" :step="0.01" :decimals="2" />
            </div>
            <div class="form-group">
              <label>Contrast ({{ colorGrading.contrast.toFixed(2) }})</label>
              <SliderWithNumber v-model="colorGrading.contrast" :min="0.5" :max="2.0" :step="0.01" :decimals="2" />
            </div>
            <div class="form-group">
              <label>Saturation ({{ colorGrading.saturation.toFixed(2) }})</label>
              <SliderWithNumber v-model="colorGrading.saturation" :min="0.0" :max="2.0" :step="0.01" :decimals="2" />
            </div>
          </div>
          <div class="grid-2 mt-1">
            <div class="form-group">
              <label>Warmth ({{ colorGrading.warmth > 0 ? '+' : '' }}{{ colorGrading.warmth.toFixed(2) }}) <span class="text-muted text-xs">cool &larr;&rarr; warm</span></label>
              <SliderWithNumber v-model="colorGrading.warmth" :min="-0.5" :max="0.5" :step="0.01" :decimals="2" />
            </div>
            <div class="form-group">
              <label>Tint ({{ colorGrading.tint > 0 ? '+' : '' }}{{ colorGrading.tint.toFixed(2) }}) <span class="text-muted text-xs">green &larr;&rarr; magenta</span></label>
              <SliderWithNumber v-model="colorGrading.tint" :min="-0.5" :max="0.5" :step="0.01" :decimals="2" />
            </div>
          </div>
          <button class="btn btn-sm btn-secondary mt-1" @click="colorGrading.brightness = 0; colorGrading.contrast = 1; colorGrading.saturation = 1; colorGrading.warmth = 0; colorGrading.tint = 0;">Reset Sliders</button>
        </div>
      </div>

      <!-- Vignette -->
      <div class="settings-section mt-2">
        <div class="flex gap-2 items-center">
          <label class="checkbox-label" @click.stop>
            <input type="checkbox" v-model="vignette.enabled" />
          </label>
          <h4>Vignette</h4>
          <span class="text-muted text-sm">(dark edges)</span>
        </div>
        <div v-if="vignette.enabled" class="mt-2">
          <div class="form-group">
            <label>Strength ({{ Math.round(vignette.strength * 100) }}%)</label>
            <SliderWithNumber v-model="vignette.strength" :min="0.05" :max="1.0" :step="0.01" :decimals="2" />
            <p class="text-muted text-xs mt-1">
              Subtle (0.20–0.35) keeps things natural; dramatic (&gt;0.60) is noticeable and can crush edge detail. Free-slidable at 0.01 precision.
            </p>
          </div>
        </div>
      </div>

      <!-- Film Grain -->
      <div class="settings-section mt-2">
        <div class="flex gap-2 items-center">
          <label class="checkbox-label" @click.stop>
            <input type="checkbox" v-model="filmGrain.enabled" />
          </label>
          <h4>Film Grain</h4>
          <span class="text-muted text-sm">(cinematic texture)</span>
        </div>
        <div v-if="filmGrain.enabled" class="mt-2">
          <div class="form-group">
            <label>Strength ({{ filmGrain.strength }})</label>
            <SliderWithNumber v-model="filmGrain.strength" :min="1" :max="50" :step="1" />
            <p class="text-muted text-sm mt-1">
              Values above 20 add visible noise and can significantly increase final file size —
              random noise doesn't compress well. <strong>10–15</strong> is a subtle cinematic look.
            </p>
          </div>
        </div>
      </div>

      <!-- Letterbox -->
      <div class="settings-section mt-2">
        <div class="flex gap-2 items-center">
          <label class="checkbox-label" @click.stop>
            <input type="checkbox" v-model="letterbox.enabled" />
          </label>
          <h4>Cinematic Letterbox</h4>
          <span class="text-muted text-sm">(black bars top/bottom)</span>
        </div>
        <div v-if="letterbox.enabled" class="mt-2">
          <div class="grid-2">
            <div class="form-group">
              <label>Aspect Ratio</label>
              <select v-model="letterbox.ratio" class="select">
                <option value="2.35:1">2.35:1 (CinemaScope)</option>
                <option value="2.00:1">2.00:1 (Univisium)</option>
                <option value="1.85:1">1.85:1 (Theatrical)</option>
              </select>
            </div>
            <div class="form-group">
              <label>Bar Color</label>
              <select v-model="letterbox.color" class="select">
                <option value="black">Black</option>
                <option value="#1a1a2e">Dark Navy</option>
                <option value="#2d1b2e">Dark Purple</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <!-- Chroma Key -->
      <div class="settings-section mt-2">
        <div class="flex gap-2 items-center">
          <label class="checkbox-label" @click.stop>
            <input type="checkbox" v-model="chromaKey.enabled" />
          </label>
          <h4>Chroma Key (Green Screen)</h4>
        </div>
        <div v-if="chromaKey.enabled" class="mt-2">
          <div class="form-group">
            <label>Green Screen Source <span class="text-muted text-xs">(video or image with green background)</span></label>
            <input v-model="chromaKey.source_path" class="input" placeholder="Path to green screen video/image" />
          </div>
          <div class="grid-3 mt-1">
            <div class="form-group">
              <label>Key Color</label>
              <div class="flex gap-2 items-center">
                <input v-model="chromaKey.color" type="color" class="color-swatch-input" />
                <input v-model="chromaKey.color" class="input input-sm input-w-100" />
              </div>
            </div>
            <div class="form-group">
              <label>Similarity ({{ chromaKey.similarity.toFixed(2) }})</label>
              <SliderWithNumber v-model="chromaKey.similarity" :min="0.01" :max="0.5" :step="0.01" :decimals="2" />
            </div>
            <div class="form-group">
              <label>Edge Blend ({{ chromaKey.blend.toFixed(2) }})</label>
              <SliderWithNumber v-model="chromaKey.blend" :min="0.0" :max="0.5" :step="0.01" :decimals="2" />
            </div>
          </div>
          <p class="text-muted text-sm mt-1">
            The green-screen source will be composited on top of your scene images after removing the keyed color.
          </p>
        </div>
      </div>

      <!-- Intro + title exclusion -->
      <div
        v-if="(intro.enabled || titleImage.enabled) && (colorGrading.enabled || vignette.enabled || filmGrain.enabled || (logo.enabled && logo.image_path) || (chromaKey.enabled && chromaKey.source_path) || (subtitles.enabled && subtitles.srt_path))"
        class="settings-section mt-2"
      >
        <label class="checkbox-label">
          <input type="checkbox" v-model="excludeIntroFromEffects" />
          Exclude intro and title from effects
        </label>
        <p class="text-muted text-xs hint-line">
          Color grading, vignette, film grain, subtitles, logo, and chroma key only start after the title image ends. Letterbox still applies throughout (it changes the frame shape).
        </p>
      </div>

      <!-- Text Overlays (collapsed by default) -->
      <h4 class="mt-3 text-overlays-heading">Text Overlays <span class="text-muted text-xs font-normal">(optional)</span></h4>

      <!-- Title Card -->
      <div class="collapsible mt-1">
        <div class="collapsible-header" @click="titleCardOpen = !titleCardOpen">
          <div class="flex gap-2 items-center">
            <label class="checkbox-label" @click.stop>
              <input type="checkbox" v-model="titleCard.enabled" />
            </label>
            <strong>Title Card</strong>
            <span v-if="!titleCard.enabled" class="badge badge-muted">OFF</span>
          </div>
          <span class="collapse-arrow">{{ titleCardOpen ? '&#9660;' : '&#9654;' }}</span>
        </div>
        <div v-if="titleCardOpen" class="collapsible-body">
          <div class="grid-2 mt-1">
            <div class="form-group">
              <label>Title Text</label>
              <input v-model="titleCard.text" class="input" placeholder="Episode title" :disabled="!titleCard.enabled" />
            </div>
            <div class="form-group">
              <label>Subtitle (optional)</label>
              <input v-model="titleCard.subtitle" class="input" placeholder="Subtitle text" :disabled="!titleCard.enabled" />
            </div>
          </div>
          <div class="grid-3 mt-1">
            <div class="form-group">
              <label>Duration ({{ titleCard.duration }}s)</label>
              <SliderWithNumber v-model="titleCard.duration" :min="1" :max="10" :step="1" suffix="s" :disabled="!titleCard.enabled" />
            </div>
            <div class="form-group">
              <label>Style</label>
              <select v-model="titleCard.style" class="select" :disabled="!titleCard.enabled">
                <option value="gold">Gold</option>
                <option value="white">White</option>
                <option value="neon">Neon</option>
                <option value="minimal">Minimal</option>
              </select>
            </div>
            <div class="form-group">
              <label>Background</label>
              <select v-model="titleCard.background" class="select" :disabled="!titleCard.enabled">
                <option value="black">Black</option>
                <option value="dark_blur">Dark Blur</option>
                <option value="gradient">Gradient</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <!-- Chapter Titles -->
      <div class="collapsible mt-1">
        <div class="collapsible-header" @click="chapterTitlesOpen = !chapterTitlesOpen">
          <div class="flex gap-2 items-center">
            <label class="checkbox-label" @click.stop>
              <input type="checkbox" v-model="chapterTitles.enabled" />
            </label>
            <strong>Chapter Titles</strong>
            <span v-if="!chapterTitles.enabled" class="badge badge-muted">OFF</span>
          </div>
          <span class="collapse-arrow">{{ chapterTitlesOpen ? '&#9660;' : '&#9654;' }}</span>
        </div>
        <div v-if="chapterTitlesOpen" class="collapsible-body">
          <div class="grid-3 mt-1">
            <div class="form-group">
              <label>Style</label>
              <select v-model="chapterTitles.style" class="select" :disabled="!chapterTitles.enabled">
                <option value="gold">Gold</option>
                <option value="white">White</option>
                <option value="neon">Neon</option>
                <option value="minimal">Minimal</option>
              </select>
            </div>
            <div class="form-group">
              <label>Position</label>
              <select v-model="chapterTitles.position" class="select" :disabled="!chapterTitles.enabled">
                <option value="top">Top</option>
                <option value="center">Center</option>
                <option value="bottom">Bottom</option>
              </select>
            </div>
            <div class="form-group">
              <label>Font Size</label>
              <select v-model="chapterTitles.font_size" class="select" :disabled="!chapterTitles.enabled">
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
              </select>
            </div>
          </div>
          <div class="form-group mt-1">
            <label>Duration ({{ chapterTitles.duration }}s)</label>
            <SliderWithNumber v-model="chapterTitles.duration" :min="1" :max="5" :step="1" suffix="s" :disabled="!chapterTitles.enabled" />
          </div>
        </div>
      </div>

      <!-- Outro Card -->
      <div class="collapsible mt-1">
        <div class="collapsible-header" @click="outroCardOpen = !outroCardOpen">
          <div class="flex gap-2 items-center">
            <label class="checkbox-label" @click.stop>
              <input type="checkbox" v-model="outroCard.enabled" />
            </label>
            <strong>Outro Card</strong>
            <span v-if="!outroCard.enabled" class="badge badge-muted">OFF</span>
          </div>
          <span class="collapse-arrow">{{ outroCardOpen ? '&#9660;' : '&#9654;' }}</span>
        </div>
        <div v-if="outroCardOpen" class="collapsible-body">
          <div class="grid-2 mt-1">
            <div class="form-group">
              <label>Text</label>
              <input v-model="outroCard.text" class="input" placeholder="Outro text" :disabled="!outroCard.enabled" />
            </div>
            <div class="form-group">
              <label>Style</label>
              <select v-model="outroCard.style" class="select" :disabled="!outroCard.enabled">
                <option value="gold">Gold</option>
                <option value="white">White</option>
                <option value="neon">Neon</option>
                <option value="minimal">Minimal</option>
              </select>
            </div>
          </div>
          <div class="form-group mt-1">
            <label>Duration ({{ outroCard.duration }}s)</label>
            <SliderWithNumber v-model="outroCard.duration" :min="2" :max="8" :step="1" suffix="s" :disabled="!outroCard.enabled" />
          </div>
        </div>
      </div>

        </div><!-- /.effects-controls-scroll -->
      </div><!-- /.effects-split-layout -->

      <div class="step-nav mt-3">
        <button class="btn btn-secondary" @click="goToStep(3)">Back</button>
        <button class="btn btn-primary" @click="goToStep(5)">Continue</button>
      </div>
    </div>

    <!-- ============ STEP 5: Subtitles (optional) ============ -->
    <div v-if="currentStep === 5" class="card mt-2">
      <h3>Step 5: Subtitles</h3>
      <p class="text-muted mt-1">Optional — burn a subtitle track into the final video.</p>

      <PresetPicker
        label="Subtitles preset"
        hint="Captures the style (font, size, colours, position) and enabled/source flags. The actual .srt file is per-episode and not stored in the preset."
        :presets="subtitlesPresets.presets.value"
        :active-id="subtitlesPresets.activeId.value"
        @update:active-id="subtitlesPresets.setActive"
        @apply="subtitlesPresets.applyActive(); success('Subtitles preset applied')"
        @overwrite="subtitlesPresets.overwrite(); success('Subtitles preset saved')"
        @save-as="(n) => subtitlesPresets.saveAs(n).then(() => success('Subtitles preset saved'))"
        @delete="subtitlesPresets.remove(); success('Subtitles preset deleted')"
      />

      <div class="settings-section mt-2">
        <label class="checkbox-label">
          <input type="checkbox" v-model="subtitles.enabled" />
          <span class="ml-1-tight">Enable subtitles</span>
        </label>
        <p v-if="subtitles.enabled && ffmpegStatus && !ffmpegStatus.has_libass"
           class="validation-msg text-sm mt-1">
          ⚠ This FFmpeg build doesn't include libass — subtitles can't be burned in.
          Install a build with libass (e.g. <code>brew install ffmpeg</code> with freetype+libass).
        </p>
      </div>

      <div v-if="subtitles.enabled" class="mt-2">
        <!-- Source tabs -->
        <div class="settings-section">
          <h4>Source</h4>
          <div class="flex gap-2 mt-1">
            <button :class="['btn btn-sm', subtitles.source === 'chapters' ? 'btn-primary' : 'btn-secondary']"
              @click="subtitles.source = 'chapters'">Auto from chapters</button>
            <button :class="['btn btn-sm', subtitles.source === 'upload' ? 'btn-primary' : 'btn-secondary']"
              @click="subtitles.source = 'upload'">Import .srt / .vtt</button>
            <button :class="['btn btn-sm', subtitles.source === 'whisper' ? 'btn-primary' : 'btn-secondary']"
              @click="subtitles.source = 'whisper'">Transcribe (Whisper)</button>
          </div>

          <!-- Chapters -->
          <div v-if="subtitles.source === 'chapters'" class="mt-2">
            <p class="text-muted text-sm">
              Derives one cue per chapter from the individual chapter audio files — fast, free, chapter-level only.
            </p>
            <p v-if="subtitlesStatus && !subtitlesStatus.has_chapter_audio"
               class="validation-msg text-sm">
              No chapter audio files found. Either run Audio Generator for this episode or pick a different source.
            </p>
            <button class="btn btn-sm btn-secondary mt-1"
              :disabled="subtitlesGenerating || !episodeId || !subtitlesStatus?.has_chapter_audio"
              @click="generateFromChapters">
              {{ subtitlesGenerating ? 'Generating…' : 'Generate SRT from chapters' }}
            </button>
          </div>

          <!-- Upload -->
          <div v-if="subtitles.source === 'upload'" class="mt-2">
            <p class="text-muted text-sm">Pick a subtitle file from disk — we'll copy and normalize it.</p>
            <div class="flex gap-2 mt-1 items-center">
              <FilePicker
                v-model="subtitleUploadPath"
                placeholder="/path/to/subtitles.srt"
                :filters="[{ name: 'Subtitles', extensions: ['srt', 'vtt'] }]"
                title="Choose a subtitle file"
                clearable
              />
              <button class="btn btn-sm btn-primary"
                :disabled="subtitlesGenerating || !subtitleUploadPath || !episodeId"
                @click="importSubtitles">
                {{ subtitlesGenerating ? 'Importing…' : 'Import' }}
              </button>
            </div>
          </div>

          <!-- Whisper -->
          <div v-if="subtitles.source === 'whisper'" class="mt-2">
            <p class="text-muted text-sm">
              Transcribes the merged audio via OpenAI Whisper. Gives word-level captions. Costs ~$0.006 per minute of audio.
            </p>
            <p v-if="subtitlesStatus && !subtitlesStatus.has_openai_key"
               class="validation-msg text-sm">
              OpenAI API key not set. Add one under Settings → API Keys.
            </p>
            <p v-if="subtitlesStatus && !subtitlesStatus.has_merged_audio"
               class="validation-msg text-sm">
              No merged audio file found. Run Audio Assembly for this episode first.
            </p>
            <p v-if="hasExistingWhisperSrt" class="text-muted text-sm">
              <strong>{{ existingWhisperSrtName }}</strong> already exists — the job will skip
              the (paid) Whisper API and reuse it. Tick below to re-run with a fresh charge.
            </p>
            <label v-if="hasExistingWhisperSrt"
                   class="flex items-center gap-1 mt-1 text-sm">
              <input type="checkbox" v-model="whisperForce" />
              Re-run transcription (charges Whisper API again)
            </label>
            <button class="btn btn-sm btn-secondary mt-1"
              :disabled="subtitlesGenerating || !episodeId || !subtitlesStatus?.has_merged_audio || !subtitlesStatus?.has_openai_key"
              @click="transcribeWithWhisper">
              {{ subtitlesGenerating ? 'Queued — check Jobs panel' : (hasExistingWhisperSrt && !whisperForce ? 'Reuse existing transcript' : 'Transcribe now') }}
            </button>
          </div>

          <!-- Current SRT -->
          <div v-if="subtitles.srt_path" class="text-sm mt-2">
            <label class="text-muted">Active SRT</label>
            <div class="flex gap-2 items-center">
              <span class="flex-1 srt-path-mono">{{ subtitles.srt_path.split('/').pop() }}</span>
              <button class="btn-icon" @click="subtitles.srt_path = ''">✕</button>
            </div>
          </div>
          <div v-if="subtitlesStatus?.existing_srts?.length" class="text-sm mt-1">
            <label class="text-muted">Other subtitle files found</label>
            <div class="flex gap-2 mt-1 flex-wrap">
              <button v-for="srt in subtitlesStatus.existing_srts" :key="srt.path"
                class="btn btn-sm btn-secondary"
                :disabled="subtitles.srt_path === srt.path"
                @click="subtitles.srt_path = srt.path">
                {{ srt.filename }}
              </button>
            </div>
          </div>
        </div>

        <!-- Style picker -->
        <div class="settings-section mt-2">
          <h4>Style</h4>
          <SubtitleStylePicker
            :slug="slug"
            :episode-id="episodeId"
            :style="subtitles.style"
            :backdrop-url="subtitleBackdropUrl"
            :sample-text="sampleSubtitleText"
            @update:style="(s) => subtitles.style = s"
          />
        </div>
      </div>

      <div class="step-nav mt-3">
        <button class="btn btn-secondary" @click="goToStep(4)">Back</button>
        <button class="btn btn-primary" @click="goToStep(6)">Continue</button>
      </div>
    </div>

    <!-- ============ STEP 6: Export & Generate ============ -->
    <div v-if="currentStep === 6" class="card mt-2">
      <h3>Step 6: Export &amp; Generate</h3>
      <p class="text-muted mt-1">Review settings and generate your video</p>

      <PresetPicker
        label="Export preset"
        hint="Captures resolution, quality and format."
        :presets="exportPresets.presets.value"
        :active-id="exportPresets.activeId.value"
        @update:active-id="exportPresets.setActive"
        @apply="exportPresets.applyActive(); success('Export preset applied')"
        @overwrite="exportPresets.overwrite(); success('Export preset saved')"
        @save-as="(n) => exportPresets.saveAs(n).then(() => success('Export preset saved'))"
        @delete="exportPresets.remove(); success('Export preset deleted')"
      />

      <!-- Quick-start presets: one-click sensible defaults across all 6 -->
      <!-- export options. Estimated size + render time are computed live -->
      <!-- using the same math as the main estimator below, so the user -->
      <!-- can compare before committing. -->
      <div class="quick-preset-section mt-3">
        <label class="quick-preset-label">Quick-start presets</label>
        <p class="text-muted text-xs hint-line-loose">
          One-click defaults tuned for the most common scenarios. Pick one and fine-tune below, or go straight to custom.
        </p>
        <div class="quick-preset-grid">
          <button
            v-for="preset in EXPORT_QUICK_PRESETS"
            :key="preset.id"
            type="button"
            :class="['quick-preset-card', {
              active: activeQuickPreset === preset.id,
              'hw-unavailable': isPresetHardwareMissing(preset),
            }]"
            :title="hardwareCardTooltip(preset)"
            @click="applyQuickPreset(preset)"
          >
            <div class="qp-header">
              <span class="qp-icon" aria-hidden="true">{{ preset.icon }}</span>
              <span class="qp-label">{{ preset.label }}</span>
              <span v-if="activeQuickPreset === preset.id" class="qp-active-badge">Active</span>
              <span v-if="isPresetHardwareMissing(preset)" class="qp-hw-warn-badge" title="Hardware encoder isn't available on this FFmpeg build — render falls back to CPU.">CPU fallback</span>
            </div>
            <span class="qp-tagline">{{ preset.tagline }}</span>
            <div class="qp-stats">
              <template v-if="canEstimate">
                <span>~{{ sizeForSettings(preset.settings) }} GB</span>
                <span class="qp-stat-sep">·</span>
                <span>~{{ renderTimeForSettings(preset.settings) }}</span>
              </template>
              <span v-else class="qp-stat-pending">size + render time appear once duration is known</span>
            </div>
          </button>
        </div>
      </div>

      <!-- Export Settings — every option carries inline explanation.
           Non-technical users shouldn't need to remember what CRF or
           HEVC means; the helper text explains the trade-off right
           where the choice is made. -->
      <div class="grid-2 mt-2">
        <!-- Resolution -->
        <div class="form-group">
          <label>Resolution</label>
          <select v-model="exportSettings.resolution" class="select">
            <option value="720p">720p — 1280×720</option>
            <option value="1080p">1080p — 1920×1080 (YouTube standard)</option>
            <option value="1440p">1440p — 2560×1440</option>
            <option value="4k">4K — 3840×2160</option>
          </select>
          <p class="text-muted text-sm mt-1">
            Bigger = sharper on larger screens, but file size scales roughly with pixel count.
            <strong>720p</strong> is ~44 % smaller than 1080p with barely-perceptible loss
            on sleep-story content (audience eyes are closed).
          </p>
        </div>

        <!-- Frame rate -->
        <div class="form-group">
          <label>Frame Rate</label>
          <select v-model.number="exportSettings.fps" class="select">
            <option :value="24">24 fps — cinematic (smallest)</option>
            <option :value="25">25 fps — PAL broadcast</option>
            <option :value="30">30 fps — YouTube default</option>
            <option :value="60">60 fps — smooth motion (largest)</option>
          </select>
          <p class="text-muted text-sm mt-1">
            For still-image sleep stories, <strong>24 fps</strong> looks identical to 30 and
            saves ~20 % file size. 60 fps is for action/gaming — roughly doubles file size.
          </p>
        </div>

        <!-- Quality tier (CRF) -->
        <div class="form-group">
          <label>Quality</label>
          <select v-model="exportSettings.quality" class="select" @change="onQualityChange">
            <option value="compact">Compact — smallest (CRF 32)</option>
            <option value="fast">Fast — draft (CRF 28)</option>
            <option value="medium">Medium — YouTube sweet spot (CRF 23)</option>
            <option value="high">High — archival (CRF 18)</option>
          </select>
          <p class="text-muted text-sm mt-1">
            Controls visual quality vs file size. <strong>Compact</strong> is for sleep
            stories where YouTube re-transcodes the upload anyway. <strong>High</strong>
            is for local archival — files are ~4× bigger than Fast.
          </p>
        </div>

        <!-- Encoding effort (preset, decoupled) -->
        <div class="form-group">
          <label>Encoding Effort</label>
          <select v-model="exportSettings.encoding_effort" class="select">
            <option value="hardware">Fast (hardware) — Apple Media Engine, ~10× faster</option>
            <option value="ultrafast">Ultrafast — fastest CPU render</option>
            <option value="medium">Medium — balanced</option>
            <option value="slow">Slow — smallest file</option>
          </select>
          <p class="text-muted text-sm mt-1">
            <strong>Fast (hardware)</strong> routes the encode through your Mac's Media Engine
            silicon (h264_videotoolbox) instead of the CPU. Around 8–15× faster than Medium —
            a 2.5-hour render finishes in 15–25 min. Files are slightly larger at the same
            visual quality, but for sleep-story footage (low motion, mostly static) the
            difference is invisible. Recommended for routine renders.
            <br><br>
            CPU presets: <strong>Slow</strong> emits ~30 % smaller files at the same quality
            but takes 5–10× longer than Medium. Use Slow for archival masters, Ultrafast for
            iteration. Hardware fallback to Ultrafast happens automatically if videotoolbox
            can't initialise on your hardware.
          </p>
        </div>

        <!-- Codec -->
        <div class="form-group">
          <label>Codec</label>
          <select v-model="exportSettings.codec" class="select" :disabled="exportSettings.format === 'webm'">
            <option value="h264">H.264 — universal (default)</option>
            <option value="h265">H.265 / HEVC — ~30 % smaller</option>
          </select>
          <p class="text-muted text-sm mt-1">
            <strong>H.264</strong> plays everywhere (any Mac/Windows/Android/browser since ~2005).
            <strong>HEVC</strong> is ~30 % smaller at equal quality but needs QuickTime 10.4+ /
            Safari 11+ / modern Chrome/Edge. Codec is ignored when format is WebM
            (which always uses VP9).
          </p>
        </div>

        <!-- Format -->
        <div class="form-group">
          <label>Container Format</label>
          <select v-model="exportSettings.format" class="select">
            <option value="mp4">MP4 — most compatible</option>
            <option value="mov">MOV — Apple ecosystem</option>
            <option value="webm">WebM — web-optimized (VP9)</option>
          </select>
          <p class="text-muted text-sm mt-1">
            <strong>MP4</strong> for YouTube uploads and general sharing. <strong>MOV</strong>
            for Final Cut / iMovie ingest. <strong>WebM</strong> for direct browser embedding
            (smallest web delivery, but not accepted by all upload services).
          </p>
        </div>
      </div>

      <!-- Live file-size + render-time estimator.
           Rough heuristic based on CRF baseline × resolution factor × fps factor ×
           preset factor × codec factor. Exact numbers depend on scene complexity;
           we say "approximate" explicitly so users don't treat it as a guarantee. -->
      <div class="estimator mt-3">
        <div class="estimator-row">
          <span class="estimator-label">Estimated file size</span>
          <span class="estimator-value">
            <template v-if="sizeEstimateGb !== null">~{{ sizeEstimateGb }} GB</template>
            <template v-else>—</template>
          </span>
          <span class="estimator-hint">
            <template v-if="sizeEstimateGb !== null">for {{ estimatedDurationMin }} min at current settings</template>
            <template v-else-if="duration.mode === 'auto'">scan an episode with merged audio first</template>
            <template v-else>set a target duration above</template>
          </span>
        </div>
        <div class="estimator-row">
          <span class="estimator-label">Estimated render time</span>
          <span class="estimator-value">
            <template v-if="renderTimeEstimate !== null">~{{ renderTimeEstimate }}</template>
            <template v-else>—</template>
          </span>
          <span class="estimator-hint">
            <template v-if="renderTimeEstimate !== null">varies with scene animation + effects complexity</template>
            <template v-else>needs target duration to compute</template>
          </span>
        </div>
        <p class="text-muted text-xs mt-1">
          These are rough estimates based on bitrate math, not a guarantee. Actual output
          depends on scene motion, film-grain strength, and post-processing load.
        </p>
      </div>

      <!-- Preset-per-step review. Shows what's actually applied for each
           step, with "Change" links that jump back to that step's picker
           so the user can swap without leaving the wizard. -->
      <div class="summary-panel mt-2">
        <h4>Presets in use</h4>
        <div class="summary-grid mt-1">
          <div class="summary-row">
            <span class="text-muted">Bundle</span>
            <span>
              <strong v-if="presetSummary.bundle">{{ presetSummary.bundle }}</strong>
              <span v-else class="text-muted">— (no bundle selected)</span>
            </span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Intro</span>
            <span>
              <strong v-if="presetSummary.intro">{{ presetSummary.intro }}</strong>
              <span v-else class="text-muted">— (no preset)</span>
              <button class="link-btn" @click="goToStep(2)">change</button>
            </span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Timeline</span>
            <span>
              <strong v-if="presetSummary.timeline">{{ presetSummary.timeline }}</strong>
              <span v-else class="text-muted">— (no preset)</span>
              <button class="link-btn" @click="goToStep(3)">change</button>
            </span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Effects</span>
            <span>
              <strong v-if="presetSummary.effects">{{ presetSummary.effects }}</strong>
              <span v-else class="text-muted">— (no preset)</span>
              <button class="link-btn" @click="goToStep(4)">change</button>
            </span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Subtitles</span>
            <span>
              <strong v-if="presetSummary.subtitles">{{ presetSummary.subtitles }}</strong>
              <span v-else class="text-muted">— (no preset)</span>
              <button class="link-btn" @click="goToStep(5)">change</button>
            </span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Export</span>
            <span>
              <strong v-if="presetSummary.export">{{ presetSummary.export }}</strong>
              <span v-else class="text-muted">— (no preset)</span>
              <button class="link-btn" @click="goToStep(6)">change</button>
            </span>
          </div>
        </div>
      </div>

      <!-- Full Summary Panel -->
      <div class="summary-panel mt-2">
        <h4>Summary</h4>
        <div class="summary-grid mt-1">
          <div class="summary-row">
            <span class="text-muted">Episode</span>
            <span>{{ selectedEpisode?.title || episodeId || '-' }}</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Intro Video</span>
            <span>{{ intro.enabled && intro.video_path ? intro.video_path.split('/').pop() : 'None' }}</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Outro Video</span>
            <span>{{ outro.enabled && outro.video_path ? outro.video_path.split('/').pop() : 'None' }}</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Logo Overlay</span>
            <span>{{ logo.enabled && logo.image_path ? logo.position + ', ' + logo.opacity + '% opacity, ' + logo.scale + '% scale' : 'None' }}</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Title Image</span>
            <span>{{ titleImage.enabled && titleImage.image_path ? titleImage.image_path.split('/').pop() + ' (' + titleImage.duration + 's)' : 'None' }}</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Scenes</span>
            <span>{{ activeSceneCount }} scenes</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Recycling</span>
            <span>{{ sceneRecycling.seconds_per_scene }}s/scene, shuffle {{ sceneRecycling.shuffle ? 'on' : 'off' }}, {{ sceneRecycling.excluded_scenes.length }} excluded</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Target Duration</span>
            <span v-if="duration.mode === 'auto'">Auto ({{ formatDurationLong(totalAudioDuration) }})</span>
            <span v-else>{{ formatDurationLong(minDurationSec) }} -- {{ formatDurationLong(maxDurationSec) }}</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">After Narration</span>
            <span>{{ postAudio.behavior.replace(/-/g, ' ') }}{{ postAudio.behavior === 'fade-to-black' ? ` (${postAudio.fade_duration}s)` : '' }}</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Audio</span>
            <span v-if="hasMergedAudio">Merged audio ({{ scannedAssets.merged_audio[0].filename }})</span>
            <span v-else class="text-muted">—</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Effects</span>
            <span>{{ activeEffectsList }}</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Text Overlays</span>
            <span>{{ activeOverlaysList }}</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Transition</span>
            <span>{{ transitionLabel }} ({{ transition.type === 'none' ? 'N/A' : transition.duration.toFixed(1) + 's' }})</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Resolution</span>
            <span>{{ exportSettings.resolution }}</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Quality / Format</span>
            <span>{{ exportSettings.quality }} / {{ exportSettings.format.toUpperCase() }}</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Estimated Size</span>
            <span>
              <template v-if="estimatedFileSize > 0">~{{ estimatedFileSize }}MB</template>
              <span v-else class="text-muted">— (need merged audio or a target duration)</span>
            </span>
          </div>
        </div>
      </div>

      <!-- Low-asset warning (shows when scenes will recycle many times) -->
      <div v-if="lowAssetWarning" class="validation-msg text-sm mt-2">
        ⚠ {{ lowAssetWarning }}
      </div>

      <!-- Generate lives in the top banner — reachable from every wizard step. -->
      <div v-if="generating || activeJobId" class="generating-status mt-2">
        <div class="gen-head">
          <span class="gen-label">
            <strong v-if="generating">Generating video</strong>
            <strong v-else>Finished</strong>
            for <strong>{{ selectedEpisode?.title || episodeId }}</strong>
            <span v-if="activeJobProgress > 0" class="gen-progress-pct">· {{ activeJobProgress }}%</span>
          </span>
          <span v-if="!generating" class="gen-close" @click="activeJobId = null; jobOutput = []; activeJobProgress = 0" title="Dismiss">✕</span>
        </div>
        <div class="progress-bar">
          <div
            class="progress-fill"
            :style="activeJobProgress > 0 ? { width: activeJobProgress + '%', animation: 'none' } : {}"
          />
        </div>
        <div v-if="jobOutput.length" class="job-output mt-1" ref="jobOutputEl">
          <div v-for="(line, i) in jobOutput" :key="i" class="output-line">{{ line }}</div>
        </div>
        <p v-if="generating" class="text-muted gen-hint">
          Live output from the render — streams from the jobs queue. You can navigate away; progress keeps running in the background.
        </p>
      </div>

      <div class="step-nav mt-3">
        <button class="btn btn-secondary" :disabled="generating" @click="goToStep(5)">Back</button>
        <span />
      </div>
    </div>

    <!-- AI image-edit modal (pain-point #14). Mounted once at the page -->
    <!-- root; `openImageEditor` sets the target + opens it for either -->
    <!-- the title image or the logo. -->
    <ImageEditDialog
      v-model="imageEditOpen"
      :project-slug="slug"
      :image-path="imageEditTarget || ''"
      @accepted="onImageEditAccepted"
    />

  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useAppTitle('Video Assembly')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put } = useApi()
const { success, error: showError } = useToast()
const { videoGenerating } = useGenerating()
const { confirmGeneration } = useConfirmation()
// Shared job-queue state. The dashboard layout already starts the SSE
// stream; we reuse the same module-singleton refs here so the wizard's
// in-flight panel is driven by the same source of truth as the Jobs page.
const { jobs: allJobs } = useJobs()

// --------------- Step Navigation ---------------
const stepLabels = ['Assets', 'Intro', 'Timeline', 'Effects', 'Subtitles', 'Export']
const currentStep = ref(1)
const maxStepReached = ref(1)

// --------------- Step 1: Assets ---------------
const episodeId = ref('')
const selectedEpisode = ref<any>(null)
const ffmpegStatus = ref<{ installed: boolean; version?: string; has_drawtext?: boolean; has_libass?: boolean; check_error?: string } | null>(null)
const scannedAssets = ref<any>(null)
const scanning = ref(false)

// --------------- Step 2: Branding ---------------
const logo = reactive({
  enabled: false,
  image_path: '',
  position: 'bottom-right' as string,
  custom_x: 0,
  custom_y: 0,
  opacity: 70,
  scale: 10,
  margin: 20,
  hide_during_intro: true,
})

const intro = reactive({
  enabled: false,
  video_path: '',
  save_as_default: false,
})

const outro = reactive({
  enabled: false,
  video_path: '',
})

// ── User-supplied timeline clips ───────────────────────────────────────
// Free-form list of videos to splice into the final render at named
// positions. Replaces the "stick it in the outro slot" workaround for
// multi-hour black screens on sleep-story channels. Stored as an ordered
// list so multiple clips sharing the same anchor play in the order shown.
type TimelineAnchor = 'before_intro' | 'after_intro' | 'after_scenes' | 'after_outro'
type TimelineClipKind = 'video' | 'static'
/**
 * Discriminated union: `video` clips need only a video_path; `static` clips
 * pair a single image with an explicit duration. The pipeline synthesises
 * the static segment via `ffmpeg -loop 1 -i image.jpg -t <dur>` instead
 * of re-encoding a multi-hour MP4 the user pre-rendered elsewhere — same
 * end result, ~99% smaller intermediate file, and the authoring loop
 * collapses from "re-render in your editor" to "swap the image".
 *
 * Old presets predate `kind` and don't carry it on disk. We default
 * undefined to 'video' on read so they keep working unchanged.
 */
interface TimelineClipBase {
  id: string
  anchor: TimelineAnchor
  enabled: boolean
}
interface TimelineClipVideo extends TimelineClipBase {
  kind: 'video'
  video_path: string
  // Always-present keys retained on the union so v-model bindings type-check
  // even when the picker is rendering the static-shape form. Kept empty
  // until the user toggles to that kind.
  image_path?: string
  duration_sec?: number
}
interface TimelineClipStatic extends TimelineClipBase {
  kind: 'static'
  image_path: string
  duration_sec: number
  video_path?: string
}
type TimelineClip = TimelineClipVideo | TimelineClipStatic
const timelineClips = ref<TimelineClip[]>([])

const TIMELINE_ANCHOR_OPTIONS: Array<{ value: TimelineAnchor; label: string; hint: string }> = [
  { value: 'before_intro', label: 'Before intro',           hint: 'Very start, before the intro clip' },
  { value: 'after_intro',  label: 'After intro',            hint: 'Between the intro/title and the first story scene' },
  { value: 'after_scenes', label: 'After scenes',           hint: 'Between the last scene and the post-audio fade/hold' },
  { value: 'after_outro',  label: 'After outro (very end)', hint: 'Very end — where multi-hour black screens go' },
]

const TIMELINE_KIND_OPTIONS: Array<{ value: TimelineClipKind; label: string; hint: string }> = [
  {
    value: 'video',
    label: 'Video file',
    hint: 'Use an existing .mp4/.mov/.mkv/.webm — the file is normalised to project resolution + fps and concatenated as-is. Audio is stripped.',
  },
  {
    value: 'static',
    label: 'Static image (loop)',
    hint: 'Display a single image for a fixed duration. Pipeline synthesises the segment internally — much faster prep, ~99% smaller intermediate, and you can swap the image without re-rendering.',
  },
]

function addTimelineClip() {
  // Default new clips to 'video' for back-compat with operators' muscle
  // memory. The first per-row control is a kind toggle so switching is
  // one click away.
  timelineClips.value.push({
    id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    kind: 'video',
    video_path: '',
    anchor: 'after_outro',
    enabled: true,
  })
}

/**
 * Switch a clip between kinds without losing the operator's anchor /
 * enabled state. Each kind owns its own path field; we leave the
 * other field intact so flip-flopping doesn't lose the picked file.
 */
function setTimelineClipKind(id: string, kind: TimelineClipKind) {
  const i = timelineClips.value.findIndex(c => c.id === id)
  if (i < 0) return
  const cur = timelineClips.value[i]
  if (cur.kind === kind) return
  if (kind === 'static') {
    timelineClips.value[i] = {
      id: cur.id,
      kind: 'static',
      anchor: cur.anchor,
      enabled: cur.enabled,
      image_path: cur.image_path || '',
      duration_sec: cur.duration_sec ?? 7200, // 2-hour default — the canonical sleep-story tail
      video_path: cur.video_path,
    }
  } else {
    timelineClips.value[i] = {
      id: cur.id,
      kind: 'video',
      anchor: cur.anchor,
      enabled: cur.enabled,
      video_path: cur.video_path || '',
      image_path: cur.image_path,
      duration_sec: cur.duration_sec,
    }
  }
}

/** Helper for the duration input — converts seconds ↔ minutes for UX. */
function clipDurationMinutes(clip: TimelineClipStatic): number {
  return Math.round((clip.duration_sec || 0) / 60 * 10) / 10
}
function setClipDurationMinutes(clip: TimelineClipStatic, mins: number) {
  const safe = Number.isFinite(mins) && mins > 0 ? mins : 0
  clip.duration_sec = Math.round(safe * 60)
}
function removeTimelineClip(id: string) {
  timelineClips.value = timelineClips.value.filter(c => c.id !== id)
}
function moveTimelineClip(id: string, direction: -1 | 1) {
  const idx = timelineClips.value.findIndex(c => c.id === id)
  if (idx < 0) return
  const newIdx = idx + direction
  if (newIdx < 0 || newIdx >= timelineClips.value.length) return
  const arr = timelineClips.value
  ;[arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]]
}

// Base values per preset — kept in one place so the live CSS preview
// (effectPreviewImgStyle) can apply the SAME math the backend uses
// (`buildColorGradingFilters` in electron/server/generators/video.ts).
// Without this lookup, picking a preset reset the sliders to neutral
// and the preview showed no change — even though the rendered video
// actually used the preset. Keep this list 1:1 in sync with the backend
// `presets` map in `buildColorGradingFilters`. The `id` strings are the
// identity contract between client and server.
//
// Adjustment ranges (matching backend):
//   brightness: -0.5 .. +0.5  (additive)
//   contrast:    0.5 ..  2.0  (multiplicative — base × slider)
//   saturation:  0.0 ..  2.0  (multiplicative — base × slider)
//   warmth:     -0.5 ..  +0.5 (additive — feeds colorbalance red/blue)
//   tint:       -0.5 ..  +0.5 (additive — feeds colorbalance green/magenta)
type ColorPresetBase = { brightness: number; contrast: number; saturation: number; warmth: number; tint: number }
const COLOR_PRESET_BASE: Record<string, ColorPresetBase> = {
  'none':              { brightness: 0,    contrast: 1.0,  saturation: 1.0,  warmth:  0,     tint:  0 },
  'warm-night':        { brightness: -0.05, contrast: 1.1,  saturation: 0.9,  warmth:  0.15,  tint:  0 },
  'cool-moonlight':    { brightness:  0.02, contrast: 1.05, saturation: 0.8,  warmth: -0.15,  tint: -0.05 },
  'cinematic':         { brightness: -0.03, contrast: 1.2,  saturation: 0.85, warmth:  0.05,  tint:  0 },
  'vintage':           { brightness:  0.05, contrast: 0.95, saturation: 0.7,  warmth:  0.20,  tint:  0.05 },
  'dreamy-haze':       { brightness:  0.08, contrast: 0.9,  saturation: 0.75, warmth:  0.10,  tint:  0.05 },
  'golden-hour':       { brightness:  0.03, contrast: 1.1,  saturation: 1.1,  warmth:  0.25,  tint:  0.02 },
  'noir':              { brightness: -0.10, contrast: 1.4,  saturation: 0.0,  warmth:  0,     tint:  0 },
  // ── New sleep-story presets (10) ──────────────────────────────────────
  'firelight':         { brightness: -0.05, contrast: 1.15, saturation: 1.0,  warmth:  0.30,  tint:  0 },
  'rainy-dusk':        { brightness: -0.02, contrast: 1.0,  saturation: 0.7,  warmth: -0.10,  tint:  0 },
  'lavender-mist':     { brightness:  0.05, contrast: 0.95, saturation: 0.85, warmth: -0.05,  tint:  0.08 },
  'forest-canopy':     { brightness: -0.03, contrast: 1.1,  saturation: 0.95, warmth: -0.05,  tint: -0.05 },
  'desert-twilight':   { brightness:  0.02, contrast: 1.05, saturation: 1.05, warmth:  0.18,  tint:  0.04 },
  'ocean-depths':      { brightness: -0.08, contrast: 1.15, saturation: 0.85, warmth: -0.20,  tint: -0.03 },
  'sepia-dream':       { brightness:  0.0,  contrast: 1.05, saturation: 0.4,  warmth:  0.15,  tint:  0.05 },
  'frosted-glass':     { brightness:  0.15, contrast: 0.85, saturation: 0.65, warmth: -0.05,  tint:  0 },
  'autumn-glow':       { brightness:  0.0,  contrast: 1.1,  saturation: 1.15, warmth:  0.20,  tint:  0.03 },
  'starlit-night':     { brightness: -0.10, contrast: 1.25, saturation: 0.6,  warmth: -0.18,  tint: -0.02 },
  'misty-morning':     { brightness:  0.10, contrast: 0.9,  saturation: 0.7,  warmth: -0.08,  tint:  0.02 },
  // Custom = neutral base, sliders are primary. The backend's
  // `buildColorGradingFilters` falls back to `none` for any unknown id,
  // so this entry is purely so the preview computes neutral × slider
  // and doesn't visually "snap" when the user toggles Custom.
  'custom':            { brightness: 0,    contrast: 1.0,  saturation: 1.0,  warmth:  0,     tint:  0 },
}

const colorGradingPresets = [
  { id: 'none',            label: 'None',            description: 'No color grading' },
  // Original 8
  { id: 'warm-night',      label: 'Warm Night',      description: 'Amber warmth, slightly dimmed' },
  { id: 'cool-moonlight',  label: 'Cool Moonlight',  description: 'Blue-silver tones, ethereal' },
  { id: 'cinematic',       label: 'Cinematic',       description: 'High contrast, muted colors' },
  { id: 'vintage',         label: 'Vintage',         description: 'Warm, desaturated, nostalgic' },
  { id: 'dreamy-haze',     label: 'Dreamy Haze',     description: 'Bright, soft, pastel feel' },
  { id: 'golden-hour',     label: 'Golden Hour',     description: 'Rich warm gold, vivid' },
  { id: 'noir',            label: 'Noir',            description: 'Black & white, high contrast' },
  // New 10 (sleep-story themed)
  { id: 'firelight',       label: 'Firelight',       description: 'Flickering hearth, deep amber' },
  { id: 'rainy-dusk',      label: 'Rainy Dusk',      description: 'Cool grey-blue, soft and damp' },
  { id: 'lavender-mist',   label: 'Lavender Mist',   description: 'Pale purple haze, dreamlike' },
  { id: 'forest-canopy',   label: 'Forest Canopy',   description: 'Deep green and teal shadows' },
  { id: 'desert-twilight', label: 'Desert Twilight', description: 'Pink horizon, warm amber sky' },
  { id: 'ocean-depths',    label: 'Ocean Depths',    description: 'Teal-blue gloom, mysterious' },
  { id: 'sepia-dream',     label: 'Sepia Dream',     description: 'Brown-tinted nostalgia' },
  { id: 'frosted-glass',   label: 'Frosted Glass',   description: 'Bright, washed, low-contrast' },
  { id: 'autumn-glow',     label: 'Autumn Glow',     description: 'Warm orange-red, vivid leaves' },
  { id: 'starlit-night',   label: 'Starlit Night',   description: 'Deep blue-black, silver edge' },
  { id: 'misty-morning',   label: 'Misty Morning',   description: 'Pale cool fog, soft and quiet' },
]

const postAudioOptions = [
  { id: 'fade-to-black', label: 'Fade to Black', icon: '&#9681;', description: 'Gradual fade then hold black' },
  { id: 'black-screen', label: 'Black Screen', icon: '&#9632;', description: 'Instant cut to black' },
  { id: 'hold-last-scene', label: 'Hold Last Scene', icon: '&#9634;', description: 'Freeze on final image' },
  { id: 'continue-cycling', label: 'Continue Cycling', icon: '&#8635;', description: 'Keep cycling scenes' },
]

const transitionTypes = [
  { id: 'crossfade', label: 'Crossfade' },
  { id: 'fade-black', label: 'Fade to Black' },
  { id: 'dissolve', label: 'Dissolve' },
  { id: 'wipe-left', label: 'Wipe Left' },
  { id: 'wipe-right', label: 'Wipe Right' },
  { id: 'none', label: 'Hard Cut' },
]

const sceneAnimationTypes = [
  { id: 'ken-burns', label: 'Ken Burns', icon: '&#128269;', description: 'Slow zoom in/out' },
  { id: 'parallax-drift', label: 'Parallax Drift', icon: '&#8596;', description: 'Slow directional pan' },
  { id: 'breathe', label: 'Breathe', icon: '&#9711;', description: 'Gentle pulse zoom' },
  { id: 'fade-in', label: 'Fade In', icon: '&#9728;', description: 'Scene fades from black' },
  { id: 'none', label: 'None', icon: '&#9632;', description: 'Static image' },
]

const logoPositions = [
  { id: 'top-left', label: 'Top Left' },
  { id: 'top-center', label: 'Top Center' },
  { id: 'top-right', label: 'Top Right' },
  { id: 'center-left', label: 'Center Left' },
  { id: 'center', label: 'Center' },
  { id: 'center-right', label: 'Center Right' },
  { id: 'bottom-left', label: 'Bottom Left' },
  { id: 'bottom-center', label: 'Bottom Center' },
  { id: 'bottom-right', label: 'Bottom Right' },
]

// --------------- Step 3: Title & Timeline ---------------
const titleImage = reactive({
  enabled: true,
  image_path: '',
  duration: 5,
  transition_type: '' as string,
  transition_duration: 0,
})

const sceneRecycling = reactive({
  seconds_per_scene: 10,
  shuffle: false,
  excluded_scenes: [] as number[],
})

const postAudio = reactive({
  behavior: 'fade-to-black' as string,
  fade_duration: 5,
})

const transition = reactive({
  type: 'crossfade',
  duration: 1.5,
  pool: [] as string[],
  randomize_mode: 'off' as 'off' | 'single' | 'per-scene',
})

const transitionsCatalog = ref<Array<{ id: string; label: string; xfade: string; category: string; hint?: string }>>([])

async function loadTransitionsCatalog() {
  try {
    const r = await get<{ transitions: typeof transitionsCatalog.value }>(`/projects/${slug.value}/video-editor/transitions/catalog`)
    transitionsCatalog.value = r.transitions || []
  } catch { /* non-fatal */ }
}

const transitionPresets = usePresets({
  slug: slug.value,
  configKey: 'transition',
  snapshot: () => ({
    type: transition.type,
    duration: transition.duration,
    pool: [...transition.pool],
    randomize_mode: transition.randomize_mode,
  }),
  apply: (data: any) => {
    if (!data) return
    if (typeof data.type === 'string') transition.type = data.type
    if (typeof data.duration === 'number') transition.duration = data.duration
    if (Array.isArray(data.pool)) transition.pool = [...data.pool]
    if (data.randomize_mode) transition.randomize_mode = data.randomize_mode
  },
})

const scenes = ref<Array<{
  image_path: string
  filename: string
  number: number
  title: string
  enabled: boolean
}>>([])

// --------------- Duration target ---------------
// Audio (narration source, chapter gap, music, noise) lives in the upstream
// Audio Assembly step. The video assembler consumes only the merged track.
const duration = reactive({
  mode: 'custom' as 'auto' | 'custom',
  min_hours: 2,
  min_minutes: 40,
  max_hours: 3,
  max_minutes: 10,
})

// --------------- Step 5: Effects & Overlays ---------------
const sceneAnimation = reactive({
  type: 'ken-burns' as string,
  zoom_start: 100,
  zoom_end: 108,
  parallax_direction: 'right' as string,
  parallax_speed: 2,
  breathe_amplitude: 2,
  breathe_base_zoom: 103,
  pool: [] as string[],
  randomize_mode: 'off' as 'off' | 'single' | 'per-scene',
})

const animationsCatalog = ref<Array<{ id: string; label: string; category: string; hint?: string }>>([])

async function loadAnimationsCatalog() {
  try {
    const r = await get<{ animations: typeof animationsCatalog.value }>(`/projects/${slug.value}/video-editor/animations/catalog`)
    animationsCatalog.value = r.animations || []
  } catch { /* non-fatal */ }
}

const animationPresets = usePresets({
  slug: slug.value,
  configKey: 'animation',
  snapshot: () => ({
    type: sceneAnimation.type,
    zoom_start: sceneAnimation.zoom_start,
    zoom_end: sceneAnimation.zoom_end,
    parallax_direction: sceneAnimation.parallax_direction,
    parallax_speed: sceneAnimation.parallax_speed,
    breathe_amplitude: sceneAnimation.breathe_amplitude,
    breathe_base_zoom: sceneAnimation.breathe_base_zoom,
    pool: [...sceneAnimation.pool],
    randomize_mode: sceneAnimation.randomize_mode,
  }),
  apply: (data: any) => {
    if (!data) return
    for (const k of [
      'type', 'zoom_start', 'zoom_end', 'parallax_direction', 'parallax_speed',
      'breathe_amplitude', 'breathe_base_zoom', 'randomize_mode',
    ]) {
      if (data[k] !== undefined) (sceneAnimation as any)[k] = data[k]
    }
    if (Array.isArray(data.pool)) sceneAnimation.pool = [...data.pool]
  },
})

const colorGrading = reactive({
  enabled: false,
  preset: 'none' as string,
  brightness: 0,
  contrast: 1.0,
  saturation: 1.0,
  warmth: 0,
  tint: 0,
})

const vignette = reactive({
  enabled: false,
  strength: 0.7,
})

const chromaKey = reactive({
  enabled: false,
  source_path: '',
  color: '#00FF00',
  similarity: 0.15,
  blend: 0.1,
})

const filmGrain = reactive({
  enabled: false,
  strength: 15,
})

const letterbox = reactive({
  enabled: false,
  ratio: '2.35:1' as string,
  color: 'black',
})

const excludeIntroFromEffects = ref(true)

// --------------- Step 5: Subtitles ---------------
const subtitles = reactive({
  enabled: false,
  source: 'chapters' as 'chapters' | 'upload' | 'whisper',
  srt_path: '',
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

const subtitleUploadPath = ref('')
const subtitlesGenerating = ref(false)
const subtitlesStatus = ref<{
  has_libass: boolean
  has_merged_audio: boolean
  has_chapter_audio: boolean
  has_openai_key: boolean
  existing_srts: Array<{ path: string; filename: string; mtime: number }>
  subtitles_dir: string
} | null>(null)

const sampleSubtitleText = computed(() => {
  if (scannedAssets.value?.scenes?.[0]?.title) {
    return String(scannedAssets.value.scenes[0].title)
  }
  return 'The forest whispered secrets older than memory.'
})

const subtitleBackdropUrl = computed(() => {
  const scene = scannedAssets.value?.scenes?.[0]
  return scene ? getImagePreviewUrl(scene.path) : ''
})

async function loadSubtitlesStatus() {
  if (!episodeId.value) return
  try {
    subtitlesStatus.value = await get(`/projects/${slug.value}/video-editor/subtitles/status/${episodeId.value}`)
  } catch { /* non-fatal */ }
}

async function generateFromChapters() {
  if (!episodeId.value) return
  subtitlesGenerating.value = true
  try {
    const r = await post<{ srt_path: string; cues: number }>(
      `/projects/${slug.value}/video-editor/subtitles/from-chapters/${episodeId.value}`,
      { gap_sec: 5 },
    )
    subtitles.srt_path = r.srt_path
    success(`Generated ${r.cues} chapter cues`)
    await loadSubtitlesStatus()
  } catch (e: any) {
    showError(e.data?.detail || 'Chapter subtitles failed')
  } finally {
    subtitlesGenerating.value = false
  }
}

async function importSubtitles() {
  if (!episodeId.value || !subtitleUploadPath.value) return
  subtitlesGenerating.value = true
  try {
    const r = await post<{ srt_path: string; cues: number; warnings: string[] }>(
      `/projects/${slug.value}/video-editor/subtitles/import/${episodeId.value}`,
      { source_path: subtitleUploadPath.value },
    )
    subtitles.srt_path = r.srt_path
    success(`Imported ${r.cues} cues${r.warnings?.length ? ` (${r.warnings.length} warnings)` : ''}`)
    subtitleUploadPath.value = ''
    await loadSubtitlesStatus()
  } catch (e: any) {
    showError(e.data?.detail || 'Import failed')
  } finally {
    subtitlesGenerating.value = false
  }
}

// Whether a previous Whisper SRT (`{code}_whisper.srt`) already exists for
// this episode — the backend skips re-billing in that case unless `force`
// is true, so the UI surfaces that explicitly.
const hasExistingWhisperSrt = computed(() => {
  const list = subtitlesStatus.value?.existing_srts || []
  return list.some(s => /_whisper\.srt$/i.test(s.filename))
})
const existingWhisperSrtName = computed(() => {
  const list = subtitlesStatus.value?.existing_srts || []
  const found = list.find(s => /_whisper\.srt$/i.test(s.filename))
  return found?.filename || ''
})
const whisperForce = ref(false)

async function transcribeWithWhisper() {
  if (!episodeId.value) return
  subtitlesGenerating.value = true
  try {
    await post(
      `/projects/${slug.value}/video-editor/subtitles/transcribe/${episodeId.value}`,
      { language: 'en', force: whisperForce.value },
    )
    success(
      hasExistingWhisperSrt.value && !whisperForce.value
        ? 'Existing transcript will be reused — no Whisper charge'
        : 'Whisper transcription queued — check Jobs panel for progress'
    )
    // We don't set srt_path here because the job is async. The user reloads
    // the status pill when the job finishes and can then pick the SRT.
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to queue transcription')
  } finally {
    subtitlesGenerating.value = false
  }
}

const titleCardOpen = ref(false)
const chapterTitlesOpen = ref(false)
const outroCardOpen = ref(false)

const titleCard = reactive({
  enabled: false,
  text: '',
  subtitle: '',
  duration: 5,
  style: 'gold' as string,
  background: 'black',
})
const chapterTitles = reactive({
  enabled: false,
  style: 'white' as string,
  position: 'bottom' as string,
  duration: 3,
  font_size: 'medium' as string,
})
const outroCard = reactive({
  enabled: false,
  text: 'Thanks for watching',
  duration: 4,
  style: 'white',
})

// --------------- Step 6: Export ---------------
const exportSettings = reactive<{
  resolution: '720p' | '1080p' | '1440p' | '4k'
  quality: 'compact' | 'fast' | 'medium' | 'high'
  fps: 24 | 25 | 30 | 60
  encoding_effort: 'ultrafast' | 'medium' | 'slow' | 'hardware'
  codec: 'h264' | 'h265'
  format: 'mp4' | 'mov' | 'webm'
}>({
  resolution: '1080p',
  quality: 'high',
  fps: 30,
  encoding_effort: 'medium',
  codec: 'h264',
  format: 'mp4',
})

/**
 * Quality-tier → CRF value. Mirrors `QUALITY_PRESETS` in the backend;
 * duplicating here so the file-size estimator can compute reactively
 * without round-trips. Kept in ONE map (not two) to prevent drift.
 */
const QUALITY_CRF: Record<string, number> = {
  compact: 32, fast: 28, medium: 23, high: 18,
}
const DEFAULT_EFFORT_FOR_QUALITY: Record<string, 'ultrafast' | 'medium' | 'slow'> = {
  compact: 'ultrafast', fast: 'ultrafast', medium: 'medium', high: 'slow',
}
const generating = ref(false)
const jobOutput = ref<string[]>([])
// ID of the currently-queued video-assembly job, set by the composable
// when `generateVideo()` resolves. Watched below to mirror the in-flight
// job's output_lines + status onto the UI via useJobs() SSE stream.
const activeJobId = ref<string | null>(null)
const activeJobProgress = ref(0)

// --------------- Per-slot preset lists ---------------
// One usePresets() instance per wizard step. The list-of-named-presets
// pattern mirrors what transition/animation already do, so the UI stays
// uniform and a new bundle (see below) can compose one choice per slot.
// Each `apply()` is defensive about the preset shape — older / partial
// presets are tolerated via the per-field `if (data.x) ...` checks.

const introPresets = usePresets({
  slug: slug.value,
  configKey: 'intro',
  // Presets saved before outro support have a flat shape: { enabled, video_path,
  // save_as_default }. New presets nest `outro` alongside those keys. The apply
  // branch tolerates both — missing `outro` just means the saved preset predates
  // the feature, so we clear outro state rather than leaving stale values.
  snapshot: () => ({
    ...intro,
    outro: { ...outro },
    // Deep-clone the timeline list so the preset can't accidentally share
    // references with live reactive state (two-way tethering would cause
    // the preset's stored data to drift every time the user edits a row
    // before hitting Save). New key in this preset schema — older presets
    // won't have it and the apply branch falls back to an empty list.
    timeline_clips: timelineClips.value.map(c => ({ ...c })),
  }),
  apply: (data: any) => {
    if (!data) return
    Object.assign(intro, data)
    if (data.outro) Object.assign(outro, data.outro)
    else { outro.enabled = false; outro.video_path = '' }
    // Legacy presets predate this field → reset to empty. We always replace
    // rather than merge because these are user-owned list items, not
    // fields that benefit from partial overlay. Migrate-on-read: presets
    // saved before the static variant existed don't carry `kind` — set
    // it to 'video' so the union type is well-formed in memory.
    timelineClips.value = Array.isArray(data.timeline_clips)
      ? data.timeline_clips.map((c: any): TimelineClip => {
          const kind: TimelineClipKind = c.kind === 'static' ? 'static' : 'video'
          if (kind === 'static') {
            return {
              id: c.id,
              kind: 'static',
              anchor: c.anchor,
              enabled: c.enabled !== false,
              image_path: c.image_path || '',
              duration_sec: typeof c.duration_sec === 'number' && c.duration_sec > 0 ? c.duration_sec : 7200,
            }
          }
          return {
            id: c.id,
            kind: 'video',
            anchor: c.anchor,
            enabled: c.enabled !== false,
            video_path: c.video_path || '',
          }
        })
      : []
  },
})

const timelinePresets = usePresets({
  slug: slug.value,
  configKey: 'timeline',
  snapshot: () => ({
    title_image: { ...titleImage },
    scene_recycling: { ...sceneRecycling },
    duration: { ...duration },
    post_audio: { ...postAudio },
    transition: { ...transition, pool: [...transition.pool] },
    scene_animation: { ...sceneAnimation, pool: [...sceneAnimation.pool] },
  }),
  apply: (data: any) => {
    if (!data) return
    if (data.title_image) Object.assign(titleImage, data.title_image)
    if (data.scene_recycling) Object.assign(sceneRecycling, data.scene_recycling)
    if (data.duration) Object.assign(duration, data.duration)
    if (data.post_audio) Object.assign(postAudio, data.post_audio)
    if (data.transition) {
      Object.assign(transition, data.transition)
      if (Array.isArray(data.transition.pool)) transition.pool = [...data.transition.pool]
    }
    if (data.scene_animation) {
      Object.assign(sceneAnimation, data.scene_animation)
      if (Array.isArray(data.scene_animation.pool)) sceneAnimation.pool = [...data.scene_animation.pool]
    }
  },
})

const effectsPresets = usePresets({
  slug: slug.value,
  configKey: 'effects',
  snapshot: () => ({
    logo: { ...logo },
    color_grading: { ...colorGrading },
    vignette: { ...vignette },
    film_grain: { ...filmGrain },
    letterbox: { ...letterbox },
    chroma_key: { ...chromaKey },
    exclude_intro_from_effects: excludeIntroFromEffects.value,
    title_card: { ...titleCard },
    chapter_titles: { ...chapterTitles },
    outro_card: { ...outroCard },
  }),
  apply: (data: any) => {
    if (!data) return
    if (data.logo) Object.assign(logo, data.logo)
    if (data.color_grading) Object.assign(colorGrading, data.color_grading)
    if (data.vignette) Object.assign(vignette, data.vignette)
    if (data.film_grain) Object.assign(filmGrain, data.film_grain)
    if (data.letterbox) Object.assign(letterbox, data.letterbox)
    if (data.chroma_key) Object.assign(chromaKey, data.chroma_key)
    if (typeof data.exclude_intro_from_effects === 'boolean') {
      excludeIntroFromEffects.value = data.exclude_intro_from_effects
    }
    if (data.title_card) Object.assign(titleCard, data.title_card)
    if (data.chapter_titles) Object.assign(chapterTitles, data.chapter_titles)
    if (data.outro_card) Object.assign(outroCard, data.outro_card)
  },
})

const subtitlesPresets = usePresets({
  slug: slug.value,
  configKey: 'subtitles',
  snapshot: () => ({
    enabled: subtitles.enabled,
    source: subtitles.source,
    // srt_path is episode-specific (points at a file on disk for this
    // episode). Intentionally excluded from the preset — re-generate per
    // episode via the Step 5 buttons.
    style: { ...subtitles.style },
  }),
  apply: (data: any) => {
    if (!data) return
    if (typeof data.enabled === 'boolean') subtitles.enabled = data.enabled
    if (data.source) subtitles.source = data.source
    if (data.style) Object.assign(subtitles.style, data.style)
  },
})

const exportPresets = usePresets({
  slug: slug.value,
  configKey: 'export',
  snapshot: () => ({ ...exportSettings }),
  apply: (data: any) => { if (data) Object.assign(exportSettings, data) },
})

// --------------- Bundle preset (one-click apply across all 5 slots) ------
// A bundle's `data` carries two things:
//   - preset-ID pointers (one per slot) — the preferred apply path when
//     each slot has a saved preset that still exists;
//   - a `fallback` object that snapshots the full current form state for
//     each slot — used when a pointer is missing (user never saved a
//     slot preset) or broken (the referenced slot preset was deleted).
//
// This makes bundles self-sufficient: the user can click "Save as" on
// the bundle picker without having first saved anything in the 5 step
// pickers, and the bundle still captures + restores the exact wizard
// state on reload. The original pointer-only design silently produced
// empty bundles in that case, which looked like "my presets vanished".
//
// Bundles saved under the old schema (pointers only, no fallback) still
// work — the fallback lookup is optional-chained everywhere.
const { put: _put } = useApi()

// Slot-shape helpers reused by both the slot-level presets and the bundle
// fallback. Keeping them as named functions means the bundle snapshot
// stays cheap to read and there's a single source of truth for each
// slot's serialisation shape.
function snapshotIntroData() { return { ...intro } }
function applyIntroData(data: any) { if (data) Object.assign(intro, data) }

function snapshotTimelineData() {
  return {
    title_image: { ...titleImage },
    scene_recycling: { ...sceneRecycling },
    duration: { ...duration },
    post_audio: { ...postAudio },
    transition: { ...transition, pool: [...transition.pool] },
    scene_animation: { ...sceneAnimation, pool: [...sceneAnimation.pool] },
  }
}
function applyTimelineData(data: any) {
  if (!data) return
  if (data.title_image) Object.assign(titleImage, data.title_image)
  if (data.scene_recycling) Object.assign(sceneRecycling, data.scene_recycling)
  if (data.duration) Object.assign(duration, data.duration)
  if (data.post_audio) Object.assign(postAudio, data.post_audio)
  if (data.transition) {
    Object.assign(transition, data.transition)
    if (Array.isArray(data.transition.pool)) transition.pool = [...data.transition.pool]
  }
  if (data.scene_animation) {
    Object.assign(sceneAnimation, data.scene_animation)
    if (Array.isArray(data.scene_animation.pool)) sceneAnimation.pool = [...data.scene_animation.pool]
  }
}

function snapshotEffectsData() {
  return {
    logo: { ...logo },
    color_grading: { ...colorGrading },
    vignette: { ...vignette },
    film_grain: { ...filmGrain },
    letterbox: { ...letterbox },
    chroma_key: { ...chromaKey },
    exclude_intro_from_effects: excludeIntroFromEffects.value,
    title_card: { ...titleCard },
    chapter_titles: { ...chapterTitles },
    outro_card: { ...outroCard },
  }
}
function applyEffectsData(data: any) {
  if (!data) return
  if (data.logo) Object.assign(logo, data.logo)
  if (data.color_grading) Object.assign(colorGrading, data.color_grading)
  if (data.vignette) Object.assign(vignette, data.vignette)
  if (data.film_grain) Object.assign(filmGrain, data.film_grain)
  if (data.letterbox) Object.assign(letterbox, data.letterbox)
  if (data.chroma_key) Object.assign(chromaKey, data.chroma_key)
  if (typeof data.exclude_intro_from_effects === 'boolean') {
    excludeIntroFromEffects.value = data.exclude_intro_from_effects
  }
  if (data.title_card) Object.assign(titleCard, data.title_card)
  if (data.chapter_titles) Object.assign(chapterTitles, data.chapter_titles)
  if (data.outro_card) Object.assign(outroCard, data.outro_card)
}

function snapshotSubtitlesData() {
  return {
    enabled: subtitles.enabled,
    source: subtitles.source,
    style: { ...subtitles.style },
  }
}
function applySubtitlesData(data: any) {
  if (!data) return
  if (typeof data.enabled === 'boolean') subtitles.enabled = data.enabled
  if (data.source) subtitles.source = data.source
  if (data.style) Object.assign(subtitles.style, data.style)
}

function snapshotExportData() { return { ...exportSettings } }
function applyExportData(data: any) { if (data) Object.assign(exportSettings, data) }

const videoBundlePresets = usePresets({
  slug: slug.value,
  configKey: 'video_bundle',
  snapshot: () => ({
    intro_preset_id: introPresets.activeId.value,
    timeline_preset_id: timelinePresets.activeId.value,
    effects_preset_id: effectsPresets.activeId.value,
    subtitles_preset_id: subtitlesPresets.activeId.value,
    export_preset_id: exportPresets.activeId.value,
    fallback: {
      intro: snapshotIntroData(),
      timeline: snapshotTimelineData(),
      effects: snapshotEffectsData(),
      subtitles: snapshotSubtitlesData(),
      export: snapshotExportData(),
    },
  }),
  apply: (data: any) => {
    if (!data) return
    const slots = [
      { ref: introPresets,     key: 'intro_preset_id',     cfgKey: 'intro_last_preset',     fallbackKey: 'intro',     applyFallback: applyIntroData },
      { ref: timelinePresets,  key: 'timeline_preset_id',  cfgKey: 'timeline_last_preset',  fallbackKey: 'timeline',  applyFallback: applyTimelineData },
      { ref: effectsPresets,   key: 'effects_preset_id',   cfgKey: 'effects_last_preset',   fallbackKey: 'effects',   applyFallback: applyEffectsData },
      { ref: subtitlesPresets, key: 'subtitles_preset_id', cfgKey: 'subtitles_last_preset', fallbackKey: 'subtitles', applyFallback: applySubtitlesData },
      { ref: exportPresets,    key: 'export_preset_id',    cfgKey: 'export_last_preset',    fallbackKey: 'export',    applyFallback: applyExportData },
    ]
    const updates: Record<string, string> = {}
    for (const s of slots) {
      const id = data[s.key]
      const match = id ? s.ref.presets.value.find((p: any) => p.id === id) : null
      if (match) {
        // Preferred path: slot preset exists, use it.
        s.ref.activeId.value = id
        s.ref.applyActive()
        updates[s.cfgKey] = id
      } else {
        // Fallback: apply the snapshot bundled with the bundle. Clear the
        // slot's activeId so the UI doesn't show a stale preset name that
        // no longer matches the form state.
        const fb = data.fallback?.[s.fallbackKey]
        if (fb) {
          s.applyFallback(fb)
          if (s.ref.activeId.value) {
            s.ref.activeId.value = ''
            updates[s.cfgKey] = ''
          }
        }
      }
    }
    if (Object.keys(updates).length) {
      // Errors here used to be silently swallowed, which left users with
      // a "bundle applied" toast but no persisted selection — on reload
      // the slot dropdowns reset. Surface the failure so the user knows
      // the apply didn't stick to disk and can retry.
      _put(`/projects/${slug.value}/settings/config`, updates).catch((e: any) => {
        showError(`Bundle applied locally but failed to persist: ${e?.data?.detail || e?.message || 'unknown error'}`)
      })
    }
  },
})

// --------------- Computed ---------------
const totalAudioDuration = computed(() => {
  // Merged audio produced by the upstream Audio Assembly step is the
  // single source of truth for narration length.
  const merged = scannedAssets.value?.merged_audio?.[0]
  return merged?.duration || 0
})

const hasMergedAudio = computed(() => {
  return (scannedAssets.value?.merged_audio?.length || 0) > 0
})

const activeSceneCount = computed(() => {
  return scenes.value.length - sceneRecycling.excluded_scenes.length
})

const minDurationSec = computed(() => {
  return duration.min_hours * 3600 + duration.min_minutes * 60
})

const maxDurationSec = computed(() => {
  return duration.max_hours * 3600 + duration.max_minutes * 60
})

const estimatedCycles = computed(() => {
  const sceneCount = activeSceneCount.value
  if (sceneCount <= 0 || sceneRecycling.seconds_per_scene <= 0) return 0
  const cycleDuration = sceneCount * sceneRecycling.seconds_per_scene
  const targetDuration = duration.mode === 'auto'
    ? totalAudioDuration.value
    : (minDurationSec.value + maxDurationSec.value) / 2
  if (cycleDuration <= 0) return 0
  return Math.max(1, Math.round(targetDuration / cycleDuration))
})

// Heuristic warning: many cycles with few scenes = very obvious repetition.
// Fires when scenes are about to recycle more than ~8 times.
const lowAssetWarning = computed(() => {
  const sceneCount = activeSceneCount.value
  const cycles = estimatedCycles.value
  if (sceneCount < 1 || cycles < 8) return null
  return `Heads up — only ${sceneCount} scene${sceneCount === 1 ? '' : 's'} will cycle ~${cycles} times to fill the target duration. Viewers will notice the repetition. Add more scenes, shorten the episode, or enable shuffle.`
})

/**
 * Rough Mbps baseline at 1080p 30fps with `medium` preset + H.264, per
 * quality tier. Calibrated from real renders: user's 3h ×1080p × fast ×
 * ultrafast previously ran ~8 Mbps (10 GB / 3h ≈ 7.4 Mbps sans grain).
 * These are the "content-complexity-neutral" baselines; actual renders
 * of still-image sleep stories tend to sit a touch below.
 */
const BASE_MBPS_BY_QUALITY: Record<string, number> = {
  compact: 0.8,  // CRF 32
  fast:    1.5,  // CRF 28
  medium:  3.0,  // CRF 23
  high:    6.0,  // CRF 18
}
const RESOLUTION_FACTOR: Record<string, number> = {
  '720p': 0.44, '1080p': 1.0, '1440p': 1.78, '4k': 4.0,
}
const FPS_FACTOR: Record<number, number> = {
  24: 0.85, 25: 0.88, 30: 1.0, 60: 1.6,
}
const PRESET_FACTOR: Record<string, number> = {
  // Hardware encodes are ~10-15% larger than libx264 medium at the same
  // visual quality (Apple trades compression efficiency for speed).
  ultrafast: 2.0, medium: 1.0, slow: 0.75, hardware: 1.15,
}
const CODEC_FACTOR: Record<string, number> = {
  h264: 1.0, h265: 0.65,
}

/**
 * Rough single-thread encode-speed multiplier — how many wall-clock
 * seconds per 1 second of output, relative to medium preset. HEVC is
 * ~3× slower than H.264 at the same preset. Hardware is ~10× faster
 * than medium on M-series Macs (estimate; varies with chip generation).
 */
const EFFORT_SPEED_FACTOR: Record<string, number> = {
  ultrafast: 0.1, medium: 0.4, slow: 1.2, hardware: 0.04,
}
const CODEC_SPEED_FACTOR: Record<string, number> = {
  h264: 1.0, h265: 3.0,
}
const RESOLUTION_SPEED_FACTOR: Record<string, number> = {
  '720p': 0.5, '1080p': 1.0, '1440p': 1.8, '4k': 4.5,
}

const estimatedDurationSec = computed(() => {
  const target = duration.mode === 'auto'
    ? totalAudioDuration.value
    : (minDurationSec.value + maxDurationSec.value) / 2
  return Math.max(0, target)
})

const estimatedDurationMin = computed(() => Math.round(estimatedDurationSec.value / 60))

/**
 * Whether the duration is large enough to give a meaningful estimate.
 * In auto mode, this is gated on merged audio being scanned — the previous
 * implementation clamped size to 0.1 GB and rendered "~0.10 GB for 0 min"
 * which looked like a real estimate but was just the floor. 5s is the
 * smallest useful figure (anything shorter renders as a frame's worth).
 */
const canEstimate = computed(() => estimatedDurationSec.value >= 5)

const sizeEstimateGb = computed(() => {
  if (!canEstimate.value) return null
  const mbps = (BASE_MBPS_BY_QUALITY[exportSettings.quality] || 3)
    * (RESOLUTION_FACTOR[exportSettings.resolution] || 1)
    * (FPS_FACTOR[exportSettings.fps] || 1)
    * (PRESET_FACTOR[exportSettings.encoding_effort] || 1)
    * (CODEC_FACTOR[exportSettings.format === 'webm' ? 'h264' : exportSettings.codec] || 1)
  const sizeGb = (mbps * estimatedDurationSec.value) / 8 / 1024
  return Math.max(0.1, sizeGb).toFixed(sizeGb < 1 ? 2 : 1)
})

const renderTimeEstimate = computed(() => {
  if (!canEstimate.value) return null
  // Baseline: 1080p medium preset H.264 takes ~0.4s per output-second
  // on a modern Apple Silicon. Scales with effort + codec + resolution.
  const perSec = (EFFORT_SPEED_FACTOR[exportSettings.encoding_effort] || 0.4)
    * (CODEC_SPEED_FACTOR[exportSettings.format === 'webm' ? 'h264' : exportSettings.codec] || 1)
    * (RESOLUTION_SPEED_FACTOR[exportSettings.resolution] || 1)
  const secs = perSec * estimatedDurationSec.value
  if (secs < 60) return `${Math.round(secs)}s`
  if (secs < 3600) return `${Math.round(secs / 60)} min`
  const h = Math.floor(secs / 3600)
  const m = Math.round((secs % 3600) / 60)
  return `${h}h ${m}m`
})

// Legacy `estimatedFileSize` consumed in the bottom Summary panel — MB number.
// Returns 0 when duration is too short to estimate so the Summary row reads
// "~0MB" rather than misleadingly showing the floor. Template can detect 0
// and substitute "—" if it wants softer copy.
const estimatedFileSize = computed(() => {
  if (!canEstimate.value) return 0
  return Math.max(1, Math.round(parseFloat(sizeEstimateGb.value!) * 1024))
})

// ── Quick-start export presets ────────────────────────────────────────────
// Three hard-coded defaults covering the common cases. User-saved presets
// live in the PresetPicker above; these are the "I just want a good default
// without learning CRF" escape hatches. Each previews its estimated size
// + render time using the same factor math as the live estimator below.
interface QuickExportPreset {
  id: string
  label: string
  icon: string
  tagline: string
  longHint: string
  settings: {
    resolution: 'compact' | '720p' | '1080p' | '1440p' | '4k'
    fps: 24 | 25 | 30 | 60
    quality: 'compact' | 'fast' | 'medium' | 'high'
    encoding_effort: 'ultrafast' | 'medium' | 'slow' | 'hardware'
    codec: 'h264' | 'h265'
    format: 'mp4' | 'mov' | 'webm'
  }
}

const EXPORT_QUICK_PRESETS: QuickExportPreset[] = [
  {
    id: 'youtube-fast-hw',
    label: 'YouTube — Fast (recommended)',
    icon: '⚡',
    tagline: 'Hardware-accelerated. ~10× faster than the CPU fallback below.',
    longHint: '1080p · 30 fps · Medium (CRF 23) · H.264 · h264_videotoolbox · MP4 — uses your Mac\'s Media Engine. Routine renders finish in minutes; sleep-story-style footage shows no visible quality loss. Same final file as the Compatible (CPU) preset, just produced faster.',
    settings: { resolution: '1080p', fps: 30, quality: 'medium', encoding_effort: 'hardware', codec: 'h264', format: 'mp4' },
  },
  {
    id: 'youtube-common',
    label: 'YouTube — Compatible (CPU)',
    icon: '▶️',
    tagline: 'CPU fallback. Same output as Fast, just slower.',
    longHint: '1080p · 30 fps · Medium (CRF 23) · H.264 · MP4 — produces an identical file to the Fast (hardware) preset via the CPU encoder. Use this when the hardware path doesn\'t initialise on a specific machine (rare on Apple Silicon, more common on older Macs / non-Apple hardware).',
    settings: { resolution: '1080p', fps: 30, quality: 'medium', encoding_effort: 'medium', codec: 'h264', format: 'mp4' },
  },
  {
    id: 'compact-sharing',
    label: 'Compact / Sharing',
    icon: '📱',
    tagline: 'Phone-friendly. ~⅓ the size of YouTube — fits in iMessage.',
    longHint: '720p · 30 fps · Medium (CRF 23) · H.265/HEVC · MP4 (hardware) — phone-screen resolution at the same visual quality as YouTube, with HEVC\'s ~30 % savings on top. Small enough for iMessage / WhatsApp / AirDrop without splitting. Needs a modern device for playback (any iPhone / Mac since 2017, recent Android, modern browsers).',
    settings: { resolution: '720p', fps: 30, quality: 'medium', encoding_effort: 'hardware', codec: 'h265', format: 'mp4' },
  },
  {
    id: 'fastest-render',
    label: 'Fastest CPU',
    icon: '🏎️',
    tagline: 'Draft iteration — 5–10× faster than Medium CPU.',
    longHint: '720p · 24 fps · Fast (CRF 28) · Ultrafast preset · H.264 · MP4 — for reviewing pacing before the real render.',
    settings: { resolution: '720p', fps: 24, quality: 'fast', encoding_effort: 'ultrafast', codec: 'h264', format: 'mp4' },
  },
  {
    id: 'best-quality',
    label: 'Best Quality',
    icon: '💎',
    tagline: 'Archival. HEVC + slow preset. Longest render.',
    longHint: '1440p · 30 fps · High (CRF 18) · Slow preset · H.265/HEVC · MP4 — for keeping a pristine master. Playback needs a modern Mac/Windows.',
    settings: { resolution: '1440p', fps: 30, quality: 'high', encoding_effort: 'slow', codec: 'h265', format: 'mp4' },
  },
]

function sizeForSettings(s: QuickExportPreset['settings']): string | null {
  if (!canEstimate.value) return null
  const mbps = (BASE_MBPS_BY_QUALITY[s.quality] || 3)
    * (RESOLUTION_FACTOR[s.resolution] || 1)
    * (FPS_FACTOR[s.fps] || 1)
    * (PRESET_FACTOR[s.encoding_effort] || 1)
    * (CODEC_FACTOR[s.format === 'webm' ? 'h264' : s.codec] || 1)
  const sizeGb = (mbps * estimatedDurationSec.value) / 8 / 1024
  return Math.max(0.1, sizeGb).toFixed(sizeGb < 1 ? 2 : 1)
}

function renderTimeForSettings(s: QuickExportPreset['settings']): string | null {
  if (!canEstimate.value) return null
  const perSec = (EFFORT_SPEED_FACTOR[s.encoding_effort] || 0.4)
    * (CODEC_SPEED_FACTOR[s.format === 'webm' ? 'h264' : s.codec] || 1)
    * (RESOLUTION_SPEED_FACTOR[s.resolution] || 1)
  const secs = perSec * estimatedDurationSec.value
  if (secs < 60) return `${Math.round(secs)}s`
  if (secs < 3600) return `${Math.round(secs / 60)} min`
  const h = Math.floor(secs / 3600)
  const m = Math.round((secs % 3600) / 60)
  return `${h}h ${m}m`
}

/**
 * True when the preset asks for hardware encoding (`encoding_effort: 'hardware'`)
 * AND the corresponding videotoolbox encoder is missing from this FFmpeg
 * build (probed at status-check time on the backend). Returning false when
 * `hw_encoders` is undefined preserves back-compat with cached status
 * objects from older app versions — we only mark as unavailable when we
 * have positive evidence the encoder is missing.
 */
function isPresetHardwareMissing(preset: QuickExportPreset): boolean {
  if (preset.settings.encoding_effort !== 'hardware') return false
  const hw = ffmpegStatus.value?.hw_encoders
  if (!hw) return false
  // Hardware presets pick the encoder via the codec field. WebM is special-
  // cased to h264 in the size-math elsewhere, but no hardware preset uses
  // WebM today, so this branch is safe.
  return preset.settings.codec === 'h265' ? !hw.h265 : !hw.h264
}

function hardwareCardTooltip(preset: QuickExportPreset): string {
  if (isPresetHardwareMissing(preset)) {
    const codecLabel = preset.settings.codec === 'h265' ? 'hevc_videotoolbox' : 'h264_videotoolbox'
    return `${preset.longHint}\n\n⚠ ${codecLabel} isn't in this FFmpeg build — picking this preset will render via the CPU fallback (slower, same output).`
  }
  return preset.longHint
}

function applyQuickPreset(preset: QuickExportPreset) {
  Object.assign(exportSettings, preset.settings)
  // Quick presets deliberately aren't saved export presets — they're just
  // in-memory defaults. Clear any lingering active export-preset pointer so
  // the bundle preset's snapshot doesn't record a stale pointer to a
  // user-saved preset that no longer matches the form state. Without this,
  // saving a bundle after a quick-preset click captured:
  //   { export_preset_id: <old>, fallback.export: <new quick-preset values> }
  // and on apply the bundle followed the stale pointer (loading the old
  // preset's data) instead of using the fallback — which is exactly the
  // "I saved the quick preset but apply restored old selections" bug.
  if (exportPresets.activeId.value) {
    exportPresets.activeId.value = ''
    exportPresets.persist().catch(() => { /* best-effort; UI already updated */ })
  }
  success(`Applied ${preset.label} preset`)
}

const activeQuickPreset = computed(() => {
  const s = exportSettings
  return EXPORT_QUICK_PRESETS.find(p =>
    p.settings.resolution === s.resolution
    && p.settings.fps === s.fps
    && p.settings.quality === s.quality
    && p.settings.encoding_effort === s.encoding_effort
    && p.settings.codec === s.codec
    && p.settings.format === s.format,
  )?.id || null
})

/**
 * When the user picks a new quality tier, auto-update the encoding effort
 * to that tier's DEFAULT so existing presets keep their legacy behaviour
 * (fast→ultrafast, medium→medium, high→slow). Users can always override
 * afterwards. Compact defaults to ultrafast for iteration speed.
 */
function onQualityChange() {
  const def = DEFAULT_EFFORT_FOR_QUALITY[exportSettings.quality]
  if (def) exportSettings.encoding_effort = def
}

const step1Valid = computed(() => {
  return scannedAssets.value
    && scannedAssets.value.scenes?.length > 0
    && (scannedAssets.value.merged_audio?.length > 0
        || scannedAssets.value.audio_sections?.length > 0)
})

const canProceed = computed(() => {
  switch (currentStep.value) {
    case 1: return step1Valid.value
    case 2: return true
    case 3: return true
    case 4: return true
    case 5: return true
    case 6: return true
    default: return false
  }
})

const transitionLabel = computed(() => {
  const labels: Record<string, string> = {
    crossfade: 'Crossfade',
    'fade-black': 'Fade to Black',
    dissolve: 'Dissolve',
    'wipe-left': 'Wipe Left',
    'wipe-right': 'Wipe Right',
    none: 'None (Hard Cut)',
  }
  return labels[transition.type] || transition.type
})

const activeEffectsList = computed(() => {
  const items: string[] = []
  if (sceneAnimation.type !== 'none') {
    const labels: Record<string, string> = {
      'ken-burns': `Ken Burns (${sceneAnimation.zoom_start}→${sceneAnimation.zoom_end}%)`,
      'parallax-drift': `Parallax ${sceneAnimation.parallax_direction}`,
      'breathe': 'Breathe',
      'fade-in': 'Fade-In',
    }
    items.push(labels[sceneAnimation.type] || sceneAnimation.type)
  }
  if (colorGrading.enabled) items.push(colorGrading.preset !== 'none' ? colorGrading.preset.replace(/-/g, ' ') : 'Custom grading')
  if (vignette.enabled) items.push('Vignette')
  if (filmGrain.enabled) items.push('Film Grain')
  if (letterbox.enabled) items.push(`Letterbox ${letterbox.ratio}`)
  if (chromaKey.enabled) items.push('Chroma Key')
  return items.length ? items.join(', ') : 'None'
})

const activeOverlaysList = computed(() => {
  const items: string[] = []
  if (titleCard.enabled) items.push('Title Card')
  if (chapterTitles.enabled) items.push('Chapter Titles')
  if (outroCard.enabled) items.push('Outro')
  return items.length ? items.join(', ') : 'None'
})

// Pretty names for the review block on Step 6. Pulls `active` preset names
// from each slot's list so the user sees human-readable labels, not UUIDs.
// Undefined for a slot means "no preset picked yet" — the summary falls back
// to a muted dash in that case.
const presetSummary = computed(() => {
  const nameFor = (list: any[], id: string) => list.find(p => p.id === id)?.name
  return {
    bundle: nameFor(videoBundlePresets.presets.value, videoBundlePresets.activeId.value),
    intro: nameFor(introPresets.presets.value, introPresets.activeId.value),
    timeline: nameFor(timelinePresets.presets.value, timelinePresets.activeId.value),
    effects: nameFor(effectsPresets.presets.value, effectsPresets.activeId.value),
    subtitles: nameFor(subtitlesPresets.presets.value, subtitlesPresets.activeId.value),
    export: nameFor(exportPresets.presets.value, exportPresets.activeId.value),
  }
})

const postAudioSummary = computed(() => {
  const narrDur = totalAudioDuration.value
  const targetDur = duration.mode === 'auto' ? narrDur : (minDurationSec.value + maxDurationSec.value) / 2
  const postDur = Math.max(0, targetDur - narrDur)
  if (postDur <= 0) return 'No post-audio section — narration fills the full duration'
  const b = postAudio.behavior
  if (b === 'fade-to-black') return `Scenes play during narration (~${formatDurationLong(narrDur)}), then ${postAudio.fade_duration}s fade to black + ${formatDurationLong(Math.max(0, postDur - postAudio.fade_duration))} hold black`
  if (b === 'black-screen') return `Scenes play during narration (~${formatDurationLong(narrDur)}), then ${formatDurationLong(postDur)} black screen`
  if (b === 'hold-last-scene') return `Scenes play during narration (~${formatDurationLong(narrDur)}), then hold last scene for ${formatDurationLong(postDur)}`
  return `Scenes continue cycling for the full ${formatDurationLong(targetDur)} target duration`
})

// Transition preview backgrounds (use scene images or gradients)
const scenePreviewBgA = computed(() => {
  const scene = scannedAssets.value?.scenes?.[0]
  if (scene) return { backgroundImage: `url(${getImagePreviewUrl(scene.path)})`, backgroundSize: 'cover', backgroundPosition: 'center' }
  return { background: 'linear-gradient(135deg, #2d3436, #636e72)' }
})

const scenePreviewBgB = computed(() => {
  const scene = scannedAssets.value?.scenes?.[1] || scannedAssets.value?.scenes?.[0]
  if (scene) return { backgroundImage: `url(${getImagePreviewUrl(scene.path)})`, backgroundSize: 'cover', backgroundPosition: 'center' }
  return { background: 'linear-gradient(135deg, #6c5ce7, #a29bfe)' }
})

// Effect preview computeds
const previewSceneImage = computed(() => scannedAssets.value?.scenes?.[0]?.path || '')

const effectPreviewImgStyle = computed(() => {
  const filters: string[] = []
  if (colorGrading.enabled) {
    // Mirror backend `buildColorGradingFilters` math so the preview tracks
    // what FFmpeg will render. Without this layering the preview ignored
    // the preset entirely and only reflected the (often-neutral) sliders.
    //   brightness/warmth/tint = base + slider (additive)
    //   contrast/saturation    = base × slider (multiplicative)
    // Type assertion: `none` is always present in COLOR_PRESET_BASE, so
    // the `??` chain can never produce undefined — but TS's strict
    // optional-access rule needs the explicit narrowing.
    const base: ColorPresetBase = COLOR_PRESET_BASE[colorGrading.preset] ?? COLOR_PRESET_BASE['none']!
    const brightness = base.brightness + (colorGrading.brightness || 0)
    const contrast   = base.contrast   * (colorGrading.contrast   ?? 1.0)
    const saturation = base.saturation * (colorGrading.saturation ?? 1.0)
    const warmth     = base.warmth     + (colorGrading.warmth     || 0)
    // CSS approximation of FFmpeg's eq + colorbalance:
    //   eq brightness translates roughly 1:1 to CSS brightness() offset
    //   eq contrast/saturation map directly to CSS contrast()/saturate()
    //   colorbalance warmth is approximated via hue-rotate (cool ↔ warm).
    //   This is a *visual hint*, not a true colour-accurate render.
    filters.push(`brightness(${(1 + brightness).toFixed(2)})`)
    filters.push(`contrast(${contrast.toFixed(2)})`)
    filters.push(`saturate(${saturation.toFixed(2)})`)
    const warmDeg = warmth * -30
    if (Math.abs(warmDeg) > 0.5) filters.push(`hue-rotate(${warmDeg.toFixed(1)}deg)`)
  }
  const style: Record<string, string> = {}
  if (filters.length) style.filter = filters.join(' ')

  // Scene animation CSS
  if (sceneAnimation.type === 'ken-burns') {
    style.animation = 'kenBurnsPreview 8s ease-in-out infinite alternate'
  } else if (sceneAnimation.type === 'parallax-drift') {
    const dir = sceneAnimation.parallax_direction
    style.animation = `parallax${dir.charAt(0).toUpperCase() + dir.slice(1)}Preview 8s linear infinite alternate`
  } else if (sceneAnimation.type === 'breathe') {
    style.animation = 'breathePreview 4s ease-in-out infinite'
  } else if (sceneAnimation.type === 'fade-in') {
    style.animation = 'fadeInPreview 3s ease-in infinite'
  }

  return style
})

const vignetteOverlayStyle = computed(() => {
  const s = vignette.strength
  const spread = Math.round(s * 120)
  const blur = Math.round(s * 80)
  return { boxShadow: `inset 0 0 ${blur}px ${spread}px rgba(0,0,0,${(s * 0.8).toFixed(2)})` }
})

const letterboxBarHeight = computed(() => {
  const ratioMap: Record<string, number> = { '2.35:1': 2.35, '2.00:1': 2.0, '1.85:1': 1.85 }
  const ratio = ratioMap[letterbox.ratio] || 2.35
  const frameAspect = 16 / 9
  if (ratio <= frameAspect) return '0px'
  const barPct = ((1 - frameAspect / ratio) / 2) * 100
  return `${barPct.toFixed(1)}%`
})

// Logo preview
const logoLoadError = ref(false)

// ── AI image-edit dialog (pain-point #14) ────────────────────────────────
// Drives the 🪄 Edit with AI buttons on the title image + logo blocks. We
// remember which slot was opened so `accepted` swaps the right field.
const imageEditOpen = ref(false)
const imageEditTarget = ref<string | null>(null)
const imageEditSlot = ref<'title' | 'logo' | null>(null)

function openImageEditor(path: string, slot: 'title' | 'logo') {
  if (!path) return
  imageEditTarget.value = path
  imageEditSlot.value = slot
  imageEditOpen.value = true
}

function onImageEditAccepted(newPath: string) {
  if (imageEditSlot.value === 'title') {
    titleImage.image_path = newPath
  } else if (imageEditSlot.value === 'logo') {
    logo.image_path = newPath
    logoLoadError.value = false  // new file; let the <img> re-probe
  }
  imageEditTarget.value = null
  imageEditSlot.value = null
}

// Show the first scene image as the preview backdrop so the user sees the
// logo against a real frame — matches the actual render much better than a
// flat color.
const previewBgStyle = computed(() => {
  const scene = scannedAssets.value?.scenes?.[0]
  if (scene) {
    return {
      backgroundImage: `url("${getImagePreviewUrl(scene.path)}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundColor: 'var(--bg-tertiary)',
    } as Record<string, string>
  }
  return { backgroundColor: 'var(--bg-tertiary)' } as Record<string, string>
})

// Logo preview for the Step 4 unified overlay canvas (effect-preview-frame).
// Uses percentages so the preview scales with whatever size the frame ends up at,
// unlike the old fixed 480x270 preview-canvas this replaced.
const logoEffectPreviewStyle = computed(() => {
  const widthPct = Math.max(1, Math.min(logo.scale || 10, 50))
  const marginPct = Math.max(0, Math.min((logo.margin || 20) / 1920 * 100, 25))
  const style: Record<string, string> = {
    width: `${widthPct}%`,
    height: 'auto',
    opacity: String((logo.opacity ?? 100) / 100),
    position: 'absolute',
    objectFit: 'contain',
    pointerEvents: 'none',
  }
  if (logo.position === 'custom') {
    style.left = `${(logo.custom_x / 1920) * 100}%`
    style.top = `${(logo.custom_y / 1080) * 100}%`
  } else {
    const [vPos, hPos] = (logo.position || 'bottom-right').split('-')
    if (vPos === 'top') style.top = `${marginPct}%`
    else if (vPos === 'center') style.top = `50%`, style.transform = 'translateY(-50%)'
    else style.bottom = `${marginPct}%`
    if (hPos === 'left') style.left = `${marginPct}%`
    else if (hPos === 'center') {
      style.left = `50%`
      style.transform = (style.transform || '') + ' translateX(-50%)'
    } else style.right = `${marginPct}%`
  }
  return style
})

const logoPreviewStyle = computed(() => {
  const canvasW = 480
  const canvasH = 270
  const logoW = Math.round(canvasW * (logo.scale / 100))
  const margin = Math.round(logo.margin * (canvasW / 1920))

  // Don't force height — let the real image's aspect ratio take over.
  // Fallback height is used only for the error card below it.
  const approxH = Math.round(logoW * 0.6)
  const style: Record<string, string> = {
    width: `${logoW}px`,
    height: 'auto',
    opacity: `${logo.opacity / 100}`,
    position: 'absolute',
    objectFit: 'contain',
  }

  if (logo.position === 'custom') {
    const sx = logo.custom_x * (canvasW / 1920)
    const sy = logo.custom_y * (canvasH / 1080)
    style.left = `${sx}px`
    style.top = `${sy}px`
  } else {
    const parts = logo.position.split('-')
    const vPos = parts[0] || 'bottom'
    const hPos = parts[1] || 'right'

    if (vPos === 'top') style.top = `${margin}px`
    else if (vPos === 'center') style.top = `${(canvasH - approxH) / 2}px`
    else style.bottom = `${margin}px`

    if (hPos === 'left') style.left = `${margin}px`
    else if (hPos === 'center' || !hPos) style.left = `${(canvasW - logoW) / 2}px`
    else style.right = `${margin}px`
  }

  return style
})

// --------------- Functions ---------------
// formatDuration moved to ~/composables/useFormat.ts (formatDurationPrecise).
// Auto-imported by Nuxt — call sites in this file's template now resolve
// to the centralised version. `formatDurationLong` (a different terse
// "1h2m" / "5m" format used by the duration summary copy below) stays
// local since its format is unique to this page.
const formatDuration = formatDurationPrecise

function formatDurationLong(seconds: number): string {
  if (!seconds || seconds <= 0) return '0m'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h${m > 0 ? m + 'm' : ''}`
  return `${m}m`
}

function formatRelativeTime(mtimeMs: number): string {
  if (!mtimeMs) return ''
  const diffSec = (Date.now() - mtimeMs) / 1000
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`
  return `${Math.round(diffSec / 86400)}d ago`
}

function toggleSceneExclude(sceneNumber: number) {
  const idx = sceneRecycling.excluded_scenes.indexOf(sceneNumber)
  if (idx >= 0) {
    sceneRecycling.excluded_scenes.splice(idx, 1)
  } else {
    sceneRecycling.excluded_scenes.push(sceneNumber)
  }
}

function applyColorPreset(preset: string) {
  // Special case: 'custom' means "stop tracking a named preset; the
  // sliders ARE the look now". Don't wipe the slider values — that's
  // the opposite of what the user wants. For every named preset we
  // still reset the sliders so the preset's base shines through cleanly.
  colorGrading.preset = preset
  if (preset === 'custom') return
  colorGrading.brightness = 0
  colorGrading.contrast = 1.0
  colorGrading.saturation = 1.0
  colorGrading.warmth = 0
  colorGrading.tint = 0
}

// True when the user has either explicitly picked Custom OR has tweaked
// any slider away from neutral while a named preset is selected. Drives
// the Custom button's hint text so the UI is honest about state.
const customPresetActive = computed(() => {
  if (colorGrading.preset === 'custom') return true
  return Math.abs(colorGrading.brightness || 0) > 0.001
    || Math.abs((colorGrading.contrast ?? 1) - 1) > 0.001
    || Math.abs((colorGrading.saturation ?? 1) - 1) > 0.001
    || Math.abs(colorGrading.warmth || 0) > 0.001
    || Math.abs(colorGrading.tint || 0) > 0.001
})

function getImagePreviewUrl(filePath: string): string {
  return `/api/projects/${slug.value}/video-editor/preview-image?path=${encodeURIComponent(filePath)}`
}

// Asset scan + ffmpeg check + preset load/save were 150+ lines of orchestration
// logic with no rendering concerns — they now live in `useVideoAssemblyIo`.
// The composable mutates the reactive state we pass in, so the template below
// still binds to the same refs.
const { checkFfmpeg, scanAssets, generateVideo: runGenerateVideo } = useVideoAssemblyIo({
  slug, episodeId, selectedEpisode, ffmpegStatus, scannedAssets, scanning, scenes,
  excludeIntroFromEffects,
  logo, intro, outro, timelineClips, titleImage, sceneRecycling, transition, sceneAnimation, postAudio,
  duration, colorGrading, vignette, filmGrain, letterbox, chromaKey,
  titleCard, chapterTitles, outroCard, exportSettings,
  // generateVideo() needs these three plus post+confirmGeneration+videoGenerating
  // passed at call-time so the composable doesn't duplicate those imports.
  subtitles, generating, jobOutput, activeJobId,
})

function onEpisodeSelected(ep: any) {
  selectedEpisode.value = ep
  if (ep?.title) {
    titleCard.text = ep.title
  }
  scanAssets()
  loadSubtitlesStatus()
}

function goToStep(n: number) {
  if (n < 1 || n > 6) return
  // Refresh subtitle status whenever the user lands on that step so
  // newly-completed Whisper jobs show up.
  if (n === 5 && episodeId.value) loadSubtitlesStatus()
  if (n < currentStep.value) {
    currentStep.value = n
    return
  }
  if (!canProceed.value && n > currentStep.value) return
  currentStep.value = n
  if (n > maxStepReached.value) {
    maxStepReached.value = n
  }
}

// The 130-line payload builder + cost-confirm + queue submit flow now lives
// in useVideoAssemblyIo.generateVideo(). Page keeps a thin wrapper so the
// template's `@click="generateVideo"` binding doesn't change.
async function generateVideo() {
  await runGenerateVideo({ post, confirmGeneration, videoGenerating })
}

// --------------- Lifecycle ---------------

// Keyboard shortcuts: ⌘←/⌘→ (macOS) or Ctrl+←/→ (Win/Linux) step nav.
// Skipped when the user is typing — otherwise it would eat arrow-key nav
// inside the wizard's sliders and text inputs.
function handleWizardShortcut(e: KeyboardEvent) {
  if (!(e.metaKey || e.ctrlKey)) return
  const target = e.target as HTMLElement | null
  const tag = target?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
  if (e.key === 'ArrowRight' && currentStep.value < 6) {
    e.preventDefault()
    goToStep(currentStep.value + 1)
  } else if (e.key === 'ArrowLeft' && currentStep.value > 1) {
    e.preventDefault()
    goToStep(currentStep.value - 1)
  }
}

// Mirror the active video-assembly job onto the wizard's in-flight panel.
// useJobs() streams updates via SSE, so every push to `output_lines` on
// the backend shows up here within one tick. We flip `generating` off
// only when the job reaches a terminal state — unlike the old behaviour
// that flipped it off the instant the POST returned (hiding the panel
// within milliseconds of clicking Generate).
const jobOutputEl = ref<HTMLElement | null>(null)
watch(
  () => {
    const id = activeJobId.value
    if (!id) return null
    return allJobs.value.find(j => j.job_id === id) || null
  },
  async (job) => {
    if (!job) return
    jobOutput.value = [...(job.output_lines || [])]
    activeJobProgress.value = typeof job.progress === 'number' ? job.progress : 0
    const terminal = job.status === 'done' || job.status === 'error' || job.status === 'cancelled'
    if (terminal) {
      generating.value = false
      videoGenerating.value = false
      // Leave activeJobId set so the final output panel stays visible
      // after completion — user can read what happened. Clearing it on
      // a new render start (next click of Generate) will reset the panel.
    }
    // Pin the scroll to the newest line so the user always sees current
    // progress without having to scroll manually.
    await nextTick()
    if (jobOutputEl.value) jobOutputEl.value.scrollTop = jobOutputEl.value.scrollHeight
  },
  { deep: true },
)

onMounted(async () => {
  checkFfmpeg()
  loadTransitionsCatalog()
  loadAnimationsCatalog()
  // Slots must finish loading before the bundle runs its auto-apply, since
  // the bundle looks up preset IDs inside each slot's list. Doing them
  // sequentially (cheap parallel fetches) before triggering the bundle
  // avoids a race where the bundle's apply silently no-ops because the
  // slots are still empty.
  await Promise.all([
    transitionPresets.load(),
    animationPresets.load(),
    introPresets.load(),
    timelinePresets.load(),
    effectsPresets.load(),
    subtitlesPresets.load(),
    exportPresets.load(),
  ])
  await videoBundlePresets.load()
  window.addEventListener('keydown', handleWizardShortcut)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleWizardShortcut)
})
</script>

<style scoped>
/* ── Inline-style sweep helpers (2026-05-02) ─────────────────────────────
 * The cluster below replaced ~135 inline `style="..."` blocks. They keep
 * the existing visuals 1:1 — the only goal is to make the markup re-themable
 * by funnelling all values through tokens or shared classes. */

/* Tight margin/spacing variants (smaller than the .ml-2 / .mt-1 family). */
.ml-1-tight { margin-left: 6px; }
.ml-2-tight { margin-left: 8px; }
.mr-2-tight { margin-right: 8px; }
.m-0 { margin: 0; }

/* Helper-line below an input. -loose has more bottom space; -tight less top. */
.hint-line { margin-top: 4px; }
.hint-line-tight { margin-top: 2px; }
.hint-line-loose { margin: 2px 0 8px; }

/* Form-field width constraints. */
.field-narrow { max-width: 300px; }
.input-w-80  { width: 80px; }
.input-w-100 { width: 100px; }

/* Sub-section labels — one-step smaller than h4, in muted-secondary tone.
 * Use .sub-section-block to force a block flow. */
.sub-section-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}
.sub-section-block { display: block; }

/* Dim, secondary inline label that sits next to a number input. */
.dim-inline-label {
  font-size: 12px;
  color: var(--text-muted);
}

/* Hours/minutes pair inputs in the duration picker. */
.hm-num-input { width: 60px; }
.hm-num-suffix { line-height: 32px; }

/* Italic placeholder when a list is empty. */
.italic-empty { font-style: italic; }

/* Timeline-clip row controls. */
.timeline-clip-header  { margin-bottom: 6px; }
.timeline-clip-num     { min-width: 28px; }
.timeline-kind-select  { max-width: 180px; }
.timeline-anchor-select { max-width: 220px; }

/* Logo-effect preview watermark — tiny tag glued under the preview. */
.preview-watermark {
  font-size: 10px;
  margin-top: 6px;
  text-align: center;
}

/* Catalog-loading state for transitions/animations selectors. */
.catalog-loading { margin-top: 8px; }

/* Color-picker: small swatch input + hex text input combo. */
.color-swatch-input {
  width: 40px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
}

/* Subtitles SRT path display (monospaced filename). */
.srt-path-mono { font-family: ui-monospace, monospace; }

/* Color-grading "Fine-Tune" hint sits very close to the label above. */
.fine-tune-hint { margin: 2px 0 6px; }

/* "(optional)" rider beside the Text Overlays heading. */
.text-overlays-heading { color: var(--text-secondary); }

/* Stepper */
.stepper { display: flex; align-items: center; justify-content: center; gap: 0; padding: 20px 0 4px; }
.step-circle { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 600; border: 2px solid var(--border); color: var(--text-muted); background: var(--bg-secondary); cursor: pointer; transition: all 0.2s; flex-shrink: 0; }
.step-circle:hover { border-color: var(--text-secondary); }
.step-circle.active { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
.step-circle.completed { border-color: var(--success); color: var(--success); background: rgba(74, 222, 128, 0.1); }
.step-line { width: 48px; height: 2px; background: var(--border); flex-shrink: 0; }
.step-line.completed { background: var(--success); }

.step-labels { display: flex; justify-content: center; gap: 50px; padding: 6px 0 0; }
.step-labels span { font-size: 11px; color: var(--text-muted); text-align: center; width: 36px; }
.step-labels span.active { color: var(--accent); font-weight: 600; }

/* Step navigation */
.step-nav { display: flex; justify-content: space-between; align-items: center; }

/* FFmpeg status */
.ffmpeg-status { display: flex; gap: 8px; flex-wrap: wrap; }
.badge { display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 500; }
.badge-success { background: rgba(74, 222, 128, 0.15); color: var(--success); border: 1px solid rgba(74, 222, 128, 0.3); }
.badge-error { background: rgba(239, 68, 68, 0.15); color: var(--error); border: 1px solid rgba(239, 68, 68, 0.3); }
.badge-warn { background: rgba(251, 191, 36, 0.15); color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.3); }
.badge-muted { background: var(--bg-tertiary); color: var(--text-muted); border: 1px solid var(--border); font-size: 10px; padding: 2px 8px; }
.ffmpeg-warning code { background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px; font-size: 12px; }
.ffmpeg-inline-link { color: var(--accent); text-decoration: underline; cursor: pointer; }
.ffmpeg-inline-link:hover { color: var(--accent-hover, var(--accent)); }


/* Asset thumbnails */
.thumb-grid { display: flex; flex-wrap: wrap; gap: 6px; }
.scene-thumb-small { width: 40px; height: 40px; border-radius: 4px; background: var(--bg-tertiary); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--text-muted); font-weight: 600; }

/* Thumbnail picker with image previews */
.thumb-picker-images { display: flex; flex-wrap: wrap; gap: 10px; }
.thumb-card-img { position: relative; width: 160px; height: 90px; border-radius: var(--radius-md); border: 2px solid var(--border); cursor: pointer; transition: all 0.15s; overflow: hidden; background: var(--bg-tertiary); }
.thumb-card-img:hover { border-color: var(--text-secondary); transform: scale(1.02); }
.thumb-card-img.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
.thumb-preview { width: 100%; height: 100%; object-fit: cover; }
.thumb-label { position: absolute; bottom: 4px; left: 4px; background: rgba(0,0,0,0.7); color: white; font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 3px; }

/* Title image preview */
.title-image-preview { }
.preview-frame { width: 480px; max-width: 100%; aspect-ratio: 16/9; border-radius: var(--radius-md); border: 1px solid var(--border); overflow: hidden; background: var(--bg-tertiary); }
.preview-img { width: 100%; height: 100%; object-fit: cover; }

/* Legacy thumbnail picker (text-only) */
.thumb-picker { display: flex; flex-wrap: wrap; gap: 8px; }
.thumb-card { padding: 10px 14px; border-radius: var(--radius-md); background: var(--bg-tertiary); border: 2px solid var(--border); cursor: pointer; transition: all 0.15s; display: flex; flex-direction: column; gap: 4px; align-items: center; min-width: 80px; }
.thumb-card:hover { border-color: var(--text-secondary); }
.thumb-card.selected { border-color: var(--accent); background: var(--accent-dim); }
.thumb-num { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.thumb-name { font-size: 10px; color: var(--text-muted); max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Audio list */
.merged-audio-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--bg-tertiary); border-radius: var(--radius-sm); font-size: 13px; border: 1px solid var(--border); }
.audio-list { display: flex; flex-direction: column; gap: 4px; }
.audio-item { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; background: var(--bg-tertiary); border-radius: var(--radius-sm); font-size: 13px; }
.audio-name { color: var(--text-secondary); }

/* Reorderable audio list */

/* Asset section */
.asset-section label { font-size: 13px; font-weight: 600; color: var(--text-secondary); }

/* Validation */
.validation-msg { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--error); }

/* Settings section */
.settings-section { padding: 16px; background: var(--bg-tertiary); border-radius: var(--radius-md); border: 1px solid var(--border); }
.settings-section h4 { font-size: 14px; color: var(--text-primary); }

/* Logo Position Grid */
.position-grid { display: grid; grid-template-columns: repeat(3, 40px); gap: 4px; }
.pos-cell { width: 40px; height: 28px; border: 1px solid var(--border); border-radius: 4px; display: flex; align-items: center; justify-content: center; cursor: pointer; background: var(--bg-tertiary); transition: all 0.15s; }
.pos-cell:hover { border-color: var(--text-secondary); }
.pos-cell.active { border-color: var(--accent); background: var(--accent-dim); }
.pos-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); }
.pos-cell.active .pos-dot { background: var(--accent); }

/* Preview Canvas */
.preview-canvas { width: 480px; height: 270px; border-radius: var(--radius-md); border: 1px solid var(--border); position: relative; overflow: hidden; }
.preview-logo-img { pointer-events: none; }
.preview-logo-error { background: rgba(255, 0, 0, 0.2); border: 1px dashed rgba(255, 120, 120, 0.8); border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; color: #fff; letter-spacing: 0.5px; padding: 4px 8px; }

/* Scene Exclude Grid */
.scene-exclude-grid { display: flex; flex-wrap: wrap; gap: 6px; }
.scene-exclude-card { width: 40px; height: 40px; border-radius: 4px; background: var(--bg-tertiary); border: 1px solid var(--success); display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--success); font-weight: 600; cursor: pointer; transition: all 0.15s; }
.scene-exclude-card:hover { opacity: 0.8; }
.scene-exclude-card.excluded { border-color: var(--error); color: var(--error); opacity: 0.4; text-decoration: line-through; }

/* Music File List */

/* Quick-add music */

/* Optional banner */
.optional-banner { padding: 10px 14px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; color: var(--text-muted); font-style: italic; }

/* Summary bar */
.summary-bar { padding: 10px 14px; background: var(--accent-dim); border-radius: var(--radius-sm); font-size: 13px; color: var(--accent); font-weight: 500; border: 1px solid rgba(240, 198, 116, 0.2); }

/* Collapsible sections */
.collapsible { border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; }
.collapsible-header { display: flex; align-items: center; justify-content: space-between; padding: 12px; background: var(--bg-tertiary); border-radius: var(--radius-sm); cursor: pointer; user-select: none; }
.collapsible-header:hover { background: var(--bg-hover); }
.collapsible-body { padding: 12px 16px 16px; }
.collapse-arrow { font-size: 10px; color: var(--text-muted); }

/* Preview box */
.preview-box { padding: 8px 12px; background: var(--bg-primary); border-radius: var(--radius-sm); border: 1px dashed var(--border); }

/* Estimator panel — live file-size + render-time preview for the Export
   step. Visually distinct from the summary panel below so users see it
   as "output preview" not "settings review". */
.estimator {
  padding: 14px 16px;
  background: var(--bg-tertiary);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-md);
}
.estimator-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 13px;
  padding: 4px 0;
}
.estimator-label {
  min-width: 160px;
  color: var(--text-muted);
}
.estimator-value {
  font-weight: 600;
  font-size: 15px;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.estimator-hint {
  color: var(--text-muted);
  font-size: 11px;
}

/* Summary panel */
.summary-panel { padding: 16px; background: var(--bg-tertiary); border-radius: var(--radius-md); border: 1px solid var(--border); }
.summary-panel h4 { font-size: 14px; margin-bottom: 4px; }
.summary-grid { display: flex; flex-direction: column; gap: 6px; }
.summary-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.summary-row:last-child { border-bottom: none; }
.summary-row .text-muted { min-width: 130px; }
.link-btn { background: transparent; border: none; color: var(--accent); cursor: pointer; font-size: 11px; padding: 0 0 0 8px; text-decoration: underline; }
.link-btn:hover { color: var(--text-primary); }

/* Generate button */
.btn-lg { padding: 12px 40px; font-size: 16px; font-weight: 600; }

/* Generating status */
.generating-status { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; background: var(--bg-tertiary); border-radius: var(--radius-sm); border: 1px solid var(--border); }
.gen-head { display: flex; justify-content: space-between; align-items: center; }
.gen-progress-pct { color: var(--accent); font-family: 'SF Mono', Monaco, monospace; margin-left: 4px; }
.gen-close { cursor: pointer; color: var(--text-muted); padding: 2px 8px; border-radius: 4px; font-size: 14px; }
.gen-close:hover { color: var(--text-primary); background: var(--bg-hover); }
.gen-hint { font-size: 11px; margin-top: 4px; }
.generating-status .job-output { max-height: 220px; overflow-y: auto; background: var(--bg-primary); border-radius: var(--radius-sm); padding: 10px; font-family: 'SF Mono', Monaco, monospace; font-size: 11px; }
.generating-status .output-line { color: var(--text-secondary); line-height: 1.6; }
.gen-label { font-size: 13px; color: var(--accent); }
.progress-bar { height: 3px; background: var(--bg-tertiary); border-radius: 2px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--accent); border-radius: 2px; animation: progressIndeterminate 1.5s ease-in-out infinite; }
@keyframes progressIndeterminate { 0% { width: 0%; margin-left: 0; } 50% { width: 60%; margin-left: 20%; } 100% { width: 0%; margin-left: 100%; } }

/* Job output */
.job-output { max-height: 200px; overflow-y: auto; background: var(--bg-primary); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 12px; font-family: monospace; font-size: 11px; }
.output-line { color: var(--text-secondary); line-height: 1.6; }

/* Scanning status */
.scanning-status { display: flex; flex-direction: column; gap: 4px; }

/* Checkbox */
.checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; color: var(--text-secondary); }

/* Coming soon banner */
.coming-soon-banner {
  display: flex; gap: 16px; align-items: center;
  background: var(--accent-dim); border: 1px solid rgba(240, 198, 116, 0.3);
  border-radius: var(--radius-md); padding: 20px;
}
.cs-icon { font-size: 32px; }
.coming-soon-banner p { font-size: 13px; margin-top: 4px; }

/* Slider */
.slider { width: 100%; }

/* Assets overview */
.assets-overview h4 { font-size: 15px; color: var(--text-primary); }

/* Button icon */
.btn-icon { background: none; border: none; cursor: pointer; font-size: 14px; color: var(--text-muted); padding: 4px; line-height: 1; }
.btn-icon:hover { color: var(--text-primary); }
.btn-icon.danger:hover { color: var(--error); }

/* ===== Post-Audio Behavior Grid ===== */
.post-audio-grid { display: flex; flex-wrap: wrap; gap: 10px; }
.post-audio-card { padding: 12px 14px; border-radius: var(--radius-md); background: var(--bg-primary); border: 2px solid var(--border); cursor: pointer; transition: all 0.15s; min-width: 130px; display: flex; flex-direction: column; gap: 3px; align-items: center; text-align: center; }
.post-audio-card:hover { border-color: var(--text-secondary); }
.post-audio-card.active { border-color: var(--accent); background: var(--accent-dim); }
.pa-icon { font-size: 20px; opacity: 0.6; }
.pa-name { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.pa-desc { font-size: 10px; color: var(--text-muted); }

/* ===== Transition Preview Grid ===== */
.transition-preview-grid { display: flex; flex-wrap: wrap; gap: 10px; }
.transition-card { cursor: pointer; border: 2px solid var(--border); border-radius: var(--radius-md); padding: 6px; transition: all 0.15s; width: 160px; }
.transition-card:hover { border-color: var(--text-secondary); }
.transition-card.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.transition-preview-box { width: 100%; height: 80px; border-radius: 4px; overflow: hidden; position: relative; background: #111; }
.tr-scene-a, .tr-scene-b { position: absolute; inset: 0; background-size: cover; background-position: center; }
.tr-scene-b { opacity: 0; }
.tr-label { display: block; text-align: center; font-size: 11px; font-weight: 600; color: var(--text-secondary); margin-top: 4px; }

/* Transition animations — play on hover of the card */
.transition-card:hover .tr-anim-crossfade { animation: trCrossfade 2.5s ease-in-out infinite; }
.transition-card:hover .tr-anim-fade-black { animation: trFadeBlack 3s ease-in-out infinite; }
.transition-card:hover .tr-anim-dissolve { animation: trDissolve 2.5s ease-in-out infinite; }
.transition-card:hover .tr-anim-wipe-left { animation: trWipeLeft 2.5s ease-in-out infinite; }
.transition-card:hover .tr-anim-wipe-right { animation: trWipeRight 2.5s ease-in-out infinite; }
.transition-card:hover .tr-anim-none { animation: trHardCut 2s steps(1) infinite; }

/* Active card always plays */
.transition-card.active .tr-anim-crossfade { animation: trCrossfade 2.5s ease-in-out infinite; }
.transition-card.active .tr-anim-fade-black { animation: trFadeBlack 3s ease-in-out infinite; }
.transition-card.active .tr-anim-dissolve { animation: trDissolve 2.5s ease-in-out infinite; }
.transition-card.active .tr-anim-wipe-left { animation: trWipeLeft 2.5s ease-in-out infinite; }
.transition-card.active .tr-anim-wipe-right { animation: trWipeRight 2.5s ease-in-out infinite; }
.transition-card.active .tr-anim-none { animation: trHardCut 2s steps(1) infinite; }

@keyframes trCrossfade { 0%,30% { opacity: 0; } 70%,100% { opacity: 1; } }
@keyframes trFadeBlack { 0%,20% { opacity: 0; background: transparent; } 35%,65% { opacity: 1; background: black; } 80%,100% { opacity: 1; background: transparent; } }
@keyframes trDissolve { 0%,30% { opacity: 0; filter: blur(4px); } 70%,100% { opacity: 1; filter: blur(0); } }
@keyframes trWipeLeft { 0%,30% { clip-path: inset(0 100% 0 0); opacity: 1; } 70%,100% { clip-path: inset(0 0 0 0); opacity: 1; } }
@keyframes trWipeRight { 0%,30% { clip-path: inset(0 0 0 100%); opacity: 1; } 70%,100% { clip-path: inset(0 0 0 0); opacity: 1; } }
@keyframes trHardCut { 0%,49% { opacity: 0; } 50%,100% { opacity: 1; } }

/* ===== Scene Animation Preview Grid (Step 3) ===== */
.animation-preview-grid { display: flex; flex-wrap: wrap; gap: 10px; }
.animation-preview-card { cursor: pointer; border: 2px solid var(--border); border-radius: var(--radius-md); padding: 6px; transition: all 0.15s; width: 150px; }
.animation-preview-card:hover { border-color: var(--text-secondary); }
.animation-preview-card.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.anim-preview-box { width: 100%; height: 78px; border-radius: 4px; overflow: hidden; position: relative; background: #1a1a2e; }
.anim-preview-img, .anim-preview-placeholder { width: 100%; height: 100%; object-fit: cover; will-change: transform, opacity; transform-origin: center center; }
.anim-preview-placeholder { background: linear-gradient(135deg, #2d3436, #636e72); }
.anim-card-label { display: block; text-align: center; font-size: 11px; font-weight: 600; color: var(--text-secondary); margin-top: 4px; }
.anim-card-desc { display: block; text-align: center; font-size: 9px; color: var(--text-muted); }

/* Animation demos — always play on active, hover on others */
.animation-preview-card:hover .anim-demo-ken-burns,
.animation-preview-card.active .anim-demo-ken-burns { animation: kenBurnsPreview 6s ease-in-out infinite alternate; }
.animation-preview-card:hover .anim-demo-parallax-drift,
.animation-preview-card.active .anim-demo-parallax-drift { animation: parallaxRightPreview 5s linear infinite alternate; transform: scale(1.08); }
.animation-preview-card:hover .anim-demo-breathe,
.animation-preview-card.active .anim-demo-breathe { animation: breathePreview 3s ease-in-out infinite; }
.animation-preview-card:hover .anim-demo-fade-in,
.animation-preview-card.active .anim-demo-fade-in { animation: fadeInPreview 2.5s ease-in infinite; }
.animation-preview-card:hover .anim-demo-none,
.animation-preview-card.active .anim-demo-none { /* no animation — static */ }

/* ===== Step 5 Split Layout ===== */
.effects-split-layout { display: flex; gap: 20px; align-items: flex-start; }
/* The toolbar above is no longer sticky (it scrolls away with the page),
   so the preview just pins to the top of the scroll container with a
   small breathing-room offset. */
.effects-preview-sticky {
  position: sticky;
  top: 16px;
  flex-shrink: 0;
  width: 340px;
}
.effects-controls-scroll { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.logo-error-note { margin-top: 8px; padding: 8px 10px; background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: var(--radius-sm); color: rgb(185, 28, 28); font-size: 11px; line-height: 1.4; }
.logo-error-note code { background: rgba(0,0,0,0.1); padding: 1px 4px; border-radius: 3px; font-size: 10px; word-break: break-all; }

/* Quick-start export presets */
.quick-preset-section { }
.quick-preset-label { font-size: 13px; font-weight: 600; color: var(--text-secondary); display: block; }
.quick-preset-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
.quick-preset-card {
  padding: 12px;
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  border: 2px solid var(--border);
  cursor: pointer;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: border-color 0.15s, background 0.15s;
  color: inherit;
  font: inherit;
}
.quick-preset-card:hover { border-color: var(--text-secondary); }
.quick-preset-card.active { border-color: var(--accent); background: var(--accent-dim); }
.qp-header { display: flex; align-items: center; gap: 8px; }
.qp-icon { font-size: 18px; line-height: 1; }
.qp-label { font-size: 13px; font-weight: 600; color: var(--text-primary); flex: 1; }
.qp-active-badge { font-size: 10px; padding: 2px 6px; border-radius: 999px; background: var(--accent); color: var(--bg-primary); font-weight: 600; }
/* Hardware-encoder-missing state: preset still clickable (backend falls
 * back to CPU automatically) but visually de-emphasised + warn-tinted so
 * the user knows their pick won't deliver the speed promise. */
.qp-hw-warn-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(245, 158, 11, 0.18);
  color: rgb(180, 83, 9);
  font-weight: 600;
  text-transform: lowercase;
  white-space: nowrap;
}
.quick-preset-card.hw-unavailable {
  border-color: rgba(245, 158, 11, 0.4);
  background: rgba(245, 158, 11, 0.05);
}
.quick-preset-card.hw-unavailable .qp-tagline {
  opacity: 0.75;
}
.qp-tagline { font-size: 11px; color: var(--text-muted); line-height: 1.4; }
.qp-stats { display: flex; gap: 6px; font-size: 11px; color: var(--text-secondary); font-variant-numeric: tabular-nums; margin-top: 2px; }
.qp-stat-sep { color: var(--text-muted); }
.qp-stat-pending { color: var(--text-muted); font-style: italic; }
@media (max-width: 900px) {
  .effects-split-layout { flex-direction: column; }
  .effects-preview-sticky { position: static; width: 100%; }
}

/* ===== Effect Preview Panel ===== */
.effect-preview-frame { width: 100%; aspect-ratio: 16/9; border-radius: var(--radius-md); border: 1px solid var(--border); overflow: hidden; position: relative; background: #111; }
.effect-preview-img { width: 100%; height: 100%; object-fit: cover; will-change: transform, filter; transform-origin: center center; }
.effect-vignette-overlay { position: absolute; inset: 0; pointer-events: none; border-radius: inherit; }
.effect-grain-overlay { position: absolute; inset: 0; pointer-events: none; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.4'/%3E%3C/svg%3E"); background-size: 100px 100px; mix-blend-mode: overlay; }
.letterbox-bar { position: absolute; left: 0; right: 0; pointer-events: none; }
.letterbox-top { top: 0; }
.letterbox-bottom { bottom: 0; }

/* Scene animation preview keyframes */
@keyframes kenBurnsPreview { 0% { transform: scale(1); } 100% { transform: scale(1.08); } }
@keyframes parallaxRightPreview { 0% { transform: translateX(0) scale(1.08); } 100% { transform: translateX(-15px) scale(1.08); } }
@keyframes parallaxLeftPreview { 0% { transform: translateX(0) scale(1.08); } 100% { transform: translateX(15px) scale(1.08); } }
@keyframes parallaxUpPreview { 0% { transform: translateY(0) scale(1.08); } 100% { transform: translateY(10px) scale(1.08); } }
@keyframes parallaxDownPreview { 0% { transform: translateY(0) scale(1.08); } 100% { transform: translateY(-10px) scale(1.08); } }
@keyframes breathePreview { 0%,100% { transform: scale(1.01); } 50% { transform: scale(1.05); } }
@keyframes fadeInPreview { 0% { opacity: 0; } 30%,100% { opacity: 1; } }

/* Noise preset grid */

/* Color grading preset grid */
/* Color-grading preset grid. `auto-fill` + minmax adapts to the
   sticky-preview split (which makes the right column narrow on small
   widths) so 19 cards lay out cleanly across 1–6 columns without
   manual breakpoints. */
.preset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
}
.preset-card {
  padding: 10px 14px; border-radius: var(--radius-md);
  background: var(--bg-primary); border: 2px solid var(--border);
  cursor: pointer; transition: all 0.15s;
  display: flex; flex-direction: column; gap: 2px;
  min-width: 0; /* permit shrinking inside grid cell */
}
.preset-card:hover { border-color: var(--text-secondary); }
.preset-card.active { border-color: var(--accent); background: var(--accent-dim); }
.preset-name { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.preset-desc { font-size: 10px; color: var(--text-muted); }

/* Custom button — visually distinct from the named-preset grid so the
   user reads it as a mode switch ("the sliders are now primary") rather
   than as another preset. Full-width, dashed border = "your own values". */
.preset-custom-btn {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  width: 100%;
  padding: 10px 14px; border-radius: var(--radius-md);
  background: transparent; border: 2px dashed var(--border);
  color: var(--text-primary); cursor: pointer; transition: all 0.15s;
  text-align: left;
}
.preset-custom-btn:hover { border-color: var(--text-secondary); background: var(--bg-primary); }
.preset-custom-btn.active { border-color: var(--accent); background: var(--accent-dim); border-style: solid; }
.preset-custom-label { font-size: 12px; font-weight: 600; }
.preset-custom-hint { font-size: 10px; color: var(--text-muted); }

/* Input small */
.input-sm { padding: 4px 6px; font-size: 12px; }
</style>
