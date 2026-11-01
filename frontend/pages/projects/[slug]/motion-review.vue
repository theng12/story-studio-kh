<template>
  <div class="motion-workspace workspace-page">
    <WorkspaceHero
      eyebrow="Optional review pass"
      title="Motion Review"
      description="Turn approved stills into motion clips only where movement adds value. Untouched scenes remain valid still images through final assembly."
    >
      <template #aside>
        <div class="motion-hero-route" aria-label="Review workflow">
          <span class="is-complete">1</span><b>Plan</b><i />
          <span class="is-complete">2</span><b>Images</b><i />
          <span class="is-current">3</span><b>Motion</b>
        </div>
      </template>
    </WorkspaceHero>

    <div class="motion-command-bar workspace-command-surface">
      <TopActionBar
        :project-slug="slug"
        v-model:episode-id="episodeId"
        filter-field="scene_review"
        :presets="motionPresets"
        generate-label="Generate Missing Clips"
        :generate-loading="queuing || clipJobsActive"
        :generate-disabled="!canGenerate"
        :generate-status="generateStatus"
        @generate="generateMissing"
      />
    </div>

    <div class="motion-guide-grid">
      <WorkspaceNotice title="Stills remain the safe default" tone="info">
        Skip motion freely. Choosing a clip only replaces its still inside the same locked timestamp window.
        <template #actions>
          <NuxtLink :to="`/projects/${slug}/scene-review`" class="btn btn-sm btn-secondary">Back to Image Review</NuxtLink>
        </template>
      </WorkspaceNotice>

      <WorkspaceNotice title="External clips use the same timeline" tone="info">
        Upload a clip on the matching scene — MP4, MOV, WebM, MKV or any other format the app can decode; it is converted
        on import to the same shape this render uses. Long clips are trimmed and short external or legacy clips loop to
        fill the narration window. Clips generated with Follow narration hold their final frame instead when they cannot
        reach the full scene.
      </WorkspaceNotice>
    </div>

    <WorkspaceSection
      v-if="stats && !usesImagePool"
      eyebrow="Episode readiness"
      title="Motion decisions"
      description="Choose a clip or keep the approved still for the saved scope. This pass never changes narration timing."
      class="motion-control-deck"
      :class="{ 'motion-ready': allScopedMotionReviewed }"
    >
      <div class="motion-scope-summary" aria-live="polite">
        <div>
          <h3>Motion scope: {{ motionScopeLabel }}</h3>
          <p>{{ motionSceneIds.length }} eligible {{ motionSceneIds.length === 1 ? 'scene' : 'scenes' }} in this batch.</p>
          <p v-if="motionCrossingSceneIds.length" class="motion-scope-crossing">
            {{ motionCrossingLabel }} {{ motionScope.mode === 'share' ? `would take the video share past ${motionScope.share_percent}%` : 'crosses the opening boundary' }} and {{ motionScope.mode === 'share' ? 'would stay' : 'stays' }} still unless you explicitly include it.
          </p>
          <p v-if="motionScopeError" class="motion-scope-error">{{ motionScopeError }}</p>
        </div>
        <div class="scope-control" role="group" aria-label="Motion scope for this episode">
          <button v-for="o in SCOPE_CHOICES" :key="o.mode" type="button" class="btn btn-sm"
            :class="motionScope.mode === o.mode ? 'btn-primary' : 'btn-ghost'" :aria-pressed="motionScope.mode === o.mode"
            :disabled="scopeSaving || !episodeId" @click="saveMotionScope(o.mode)">{{ o.label }}</button>
          <label v-if="motionScope.mode === 'opening'" class="scope-opening">first
            <input v-model.number="openingSeconds" type="number" min="1" step="1" class="input scope-num" aria-label="Opening seconds" :disabled="scopeSaving" @change="saveMotionScope('opening')"> s</label>
          <template v-if="motionScope.mode === 'share'">
            <label class="scope-opening">video
              <input v-model.number="sharePercent" type="number" min="10" max="100" step="5" class="input scope-num" aria-label="Video share percent" :disabled="scopeSaving" @change="saveMotionScope('share')"> % of running time</label>
            <label class="scope-opening">filled by
              <select v-model="shareFormula" class="select" :disabled="scopeSaving" aria-label="Video share formula" @change="saveMotionScope('share')">
                <option v-for="f in SHARE_FORMULAS" :key="f.value" :value="f.value">{{ f.label }}</option>
              </select>
            </label>
            <span class="scope-share-summary">{{ shareSummary }}</span>
          </template>
          <NuxtLink v-if="motionScope.mode === 'selected'" :to="scenePlanMotionLink" class="btn btn-sm btn-ghost">Pick scenes in Scene Plan</NuxtLink>
          <NuxtLink :to="scenePlanMotionLink" class="btn btn-sm btn-ghost">Edit in Scene Plan</NuxtLink>
          <!-- Owner, 2026-10-27 — an episode that saved no scope is Off. The 25% is the control's
               starting value, not an episode's answer, so the page says both plainly. A
               text-to-video scene is an explicit per-scene plan and stays in Motion Review even
               while the share is Off, so "not needed" would be wrong for that episode. -->
          <p v-if="motionScope.mode === 'off'" class="scope-off-note text-sm">
            <template v-if="textToVideoCount">
              Off: still scenes stay still. {{ textToVideoCount === 1 ? 'One scene is' : `${textToVideoCount} scenes are` }}
              planned as text-to-video, so {{ textToVideoCount === 1 ? 'its clip still needs' : 'their clips still need' }} your approval here.
            </template>
            <template v-else>
              Off: every scene stays still and Motion Review is not needed for this episode.
              Turning on Video share starts at {{ DEFAULT_MOTION_SCOPE.share_percent }}% of running time, opening hook.
            </template>
          </p>
        </div>
      </div>
      <div class="motion-summary">
        <div class="motion-summary-copy">
          <span class="motion-summary-kicker">Episode readiness</span>
          <h3 v-if="motionSceneIds.length">{{ scopedMotionReviewed }} of {{ motionSceneIds.length }} motion decisions</h3>
          <h3 v-else>No motion decisions in this scope</h3>
          <p v-if="motionSceneIds.length">{{ scopedClipCount }} clips available · {{ motionSceneIds.length - scopedMotionReviewed }} decisions remaining</p>
          <p v-else>Scenes remain still unless a future saved scope includes them.</p>
        </div>
        <div class="motion-summary-score" :class="{ ready: allScopedMotionReviewed }">
          <strong>{{ motionSceneIds.length ? `${Math.round((scopedMotionReviewed / motionSceneIds.length) * 100)}%` : '—' }}</strong>
          <span>{{ motionSceneIds.length ? 'decided' : 'not applicable' }}</span>
        </div>
      </div>
      <div class="motion-progress" aria-hidden="true">
        <span :style="{ width: `${motionSceneIds.length ? (scopedMotionReviewed / motionSceneIds.length) * 100 : 0}%` }" />
      </div>
      <div class="motion-tool-row">
        <div class="motion-tool-heading">
          <strong>Motion controls</strong>
          <span>Choose how clips are made, then review each scoped scene.</span>
          <span v-if="isSketchDraw">A channel default (pen, hold, reveal, line weight) applies to new episodes and episodes with no clips yet.</span>
        </div>
        <div class="motion-renderer-row">
          <label class="model-field renderer-field">
            <span>Renderer</span>
            <select v-model="clipRenderer" class="select" :disabled="!presentationLoaded || presentationSaving" aria-label="Motion renderer" @change="saveMotionPresentation">
              <option value="image_to_video">Image to video</option>
              <option value="sketch_draw">Sketch Draw</option>
            </select>
          </label>
          <label v-if="isSketchDraw" class="model-field renderer-field">
            <span>Pen for {{ episodeId }}</span>
            <select v-model="penChoice" class="select" :disabled="!penLoaded || penSaving" aria-label="Sketch Draw pen for this episode" aria-describedby="sketch-pen-help" @change="saveEpisodePen">
              <option v-if="penUnreadable" value="" disabled>Choose a pen…</option>
              <option value="channel">Channel default ({{ penLabel(channelPen) }})</option>
              <option value="none">No pen</option>
              <option value="plain">Plain pen</option>
              <option value="name">Pen with channel name</option>
              <option value="logo" :disabled="!channelHasLogo">Pen with channel logo</option>
            </select>
          </label>
          <button v-if="isSketchDraw && penLoaded && episodePen && episodePen !== channelPen" type="button" class="btn btn-sm btn-ghost" :disabled="penSaving || presentationSaving" @click="setChannelPenDefault">
            Make this the channel default
          </button>
          <label v-if="isSketchDraw" class="model-field renderer-field">
            <span>Closing hold for {{ episodeId }}</span>
            <select v-model="holdChoice" class="select" :disabled="!holdLoaded || holdSaving" aria-label="Sketch Draw closing hold for this episode" aria-describedby="sketch-hold-help" @change="onHoldChoice">
              <option v-if="holdUnreadable" value="" disabled>Choose a hold…</option>
              <option value="channel">Channel default ({{ holdLabel(channelHold) }})</option>
              <option value="auto">Auto (follows the clip length)</option>
              <option value="off">No hold</option>
              <option value="fixed">Fixed seconds</option>
              <option value="range">Random range</option>
            </select>
          </label>
          <div v-if="isSketchDraw && holdLoaded && (holdChoice === 'fixed' || holdChoice === 'range')" class="hold-inputs">
            <label v-if="holdChoice === 'fixed'" class="model-field">
              <span>Seconds</span>
              <input v-model="holdDraft.fixed" type="number" class="input" min="0.1" :max="HOLD_MAX_SECONDS" step="0.1" inputmode="decimal" aria-label="Closing hold in seconds" aria-describedby="sketch-hold-help" @keydown.enter.prevent="applyHold">
            </label>
            <template v-else>
              <label class="model-field">
                <span>Shortest (s)</span>
                <input v-model="holdDraft.min" type="number" class="input" min="0.1" :max="HOLD_MAX_SECONDS" step="0.1" inputmode="decimal" aria-label="Shortest closing hold in seconds" aria-describedby="sketch-hold-help" @keydown.enter.prevent="applyHold">
              </label>
              <label class="model-field">
                <span>Longest (s)</span>
                <input v-model="holdDraft.max" type="number" class="input" min="0.1" :max="HOLD_MAX_SECONDS" step="0.1" inputmode="decimal" aria-label="Longest closing hold in seconds" aria-describedby="sketch-hold-help" @keydown.enter.prevent="applyHold">
              </label>
            </template>
            <button type="button" class="btn btn-sm" :disabled="holdSaving || !holdPending" @click="applyHold">Apply hold</button>
          </div>
          <button v-if="isSketchDraw && holdLoaded && episodeHold && JSON.stringify(episodeHold) !== JSON.stringify(channelHold)" type="button" class="btn btn-sm btn-ghost" :disabled="holdSaving || presentationSaving" @click="setChannelHoldDefault">
            Make this the channel default hold
          </button>
          <div v-if="isSketchDraw" class="model-field renderer-field">
            <span>Reveal style for {{ episodeId }}</span>
            <SketchRevealPicker :model-value="revealChoice" :reveals="revealCatalog" :weight="episodeLineWeight ?? channelLineWeight" :disabled="!revealLoaded || revealSaving || !lineWeightLoaded || lineWeightSaving || !revealCatalog.length" :error="revealCatalogError" label="Sketch Draw reveal style for this episode" title="Choose a reveal" :inherit-label="`Channel default (${revealLabel(channelReveal)})`" inherit-value="channel" allow-mix @pick="pickEpisodeReveal" @weight="saveLineWeight" />
            <p v-if="revealCatalogError" role="alert">{{ revealCatalogError }} <button type="button" class="btn btn-sm" @click="loadRevealCatalog">Retry</button></p>
          </div>
          <div v-if="isSketchDraw && revealChoice === 'mix'" class="hold-inputs">
            <SketchRevealPicker model-value="mix" :reveals="revealCatalog" :weight="episodeLineWeight ?? channelLineWeight" :mix="revealMixDraft" :disabled="revealSaving || !revealCatalog.length" multiple label="Choose Mix reveal styles" title="Choose Mix styles" description="Pick at least two styles. Each scene uses one." @mix="pickRevealMix" @weight="saveLineWeight" />
          </div>
          <button v-if="isSketchDraw && revealLoaded && episodeReveal && JSON.stringify(episodeReveal) !== JSON.stringify(channelReveal)" type="button" class="btn btn-sm btn-ghost" :disabled="revealSaving || presentationSaving" @click="setChannelRevealDefault">
            Make this the channel default reveal
          </button>
          <label v-if="isSketchDraw" class="model-field renderer-field">
            <span>Line weight for {{ episodeId }}</span>
            <select v-model="lineWeightChoice" class="select" :disabled="!lineWeightLoaded || lineWeightSaving" aria-label="Sketch Draw line weight for this episode" aria-describedby="sketch-line-weight-help" @change="onLineWeightChoice">
              <option v-if="lineWeightUnreadable" value="" disabled>Choose a line weight…</option>
              <option value="channel">Channel default ({{ lineWeightLabel(channelLineWeight) }})</option>
              <option v-for="weight in LINE_WEIGHTS" :key="weight" :value="weight">{{ lineWeightLabel(weight) }}</option>
            </select>
          </label>
          <button v-if="isSketchDraw && lineWeightLoaded && episodeLineWeight && episodeLineWeight !== channelLineWeight" type="button" class="btn btn-sm btn-ghost" :disabled="lineWeightSaving || presentationSaving" @click="setChannelLineWeightDefault">
            Make this the channel default weight
          </button>
          <div v-if="isSketchDraw" class="renderer-help-break" aria-hidden="true" />
          <p v-if="isSketchDraw" id="sketch-line-weight-help" class="renderer-help" role="status">
            How heavy the ink is drawn. This is {{ episodeId }}'s setting; other episodes are not affected. Each scene records the weight it actually drew with, so changing it re-generates only the scenes whose weight moved.
            <span v-if="!lineWeightLoaded">Loading this episode's line weight.</span>
            <span v-else-if="lineWeightUnreadable">{{ lineWeightUnreadable }} Choose a line weight to replace it; Sketch Draw waits until you do.</span>
            <span v-else-if="episodeLineWeight">{{ episodeId }} uses its own weight: {{ lineWeightLabel(episodeLineWeight) }}. Other episodes are not affected.</span>
            <span v-else>{{ episodeId }} follows the channel default weight: {{ lineWeightLabel(channelLineWeight) }}. Choosing a weight here changes only {{ episodeId }}.</span>
            <span v-if="lineWeightError" class="stale-note" role="alert">{{ lineWeightError }}</span>
            <span>Clips made before this setting keep their weight until you re-generate them.</span>
          </p>
          <p v-if="isSketchDraw" id="sketch-reveal-help" class="renderer-help" role="status">
            How each scene's finished drawing arrives. This is {{ episodeId }}'s setting; other episodes are not affected. Each scene records the style it actually drew with, so changing it re-generates only the scenes whose style moved.
            <span v-if="!revealLoaded">Loading this episode's reveal style.</span>
            <span v-else-if="revealUnreadable">{{ revealUnreadable }} Choose a reveal style to replace it; Sketch Draw waits until you do.</span>
            <span v-else-if="episodeReveal">{{ episodeId }} uses its own reveal: {{ revealLabel(episodeReveal) }}. Other episodes are not affected.</span>
            <span v-else-if="channelReveal">{{ episodeId }} follows the channel default reveal: {{ revealLabel(channelReveal) }}. Choosing a reveal here changes only {{ episodeId }}.</span>
            <span v-else>No reveal style chosen, so clips keep the reveal they were made with.</span>
            <span v-if="revealChoice === 'mix'">Each scene gets one of the picked styles, the same every time it is re-generated, and never the same style as the scene before it.</span>
            <span v-if="revealPending">Not applied yet. Apply the mix, or pick another option.</span>
            <span v-if="revealError" class="stale-note" role="alert">{{ revealError }}</span>
            <span>Clips made before this setting keep their reveal until you re-generate them.</span>
          </p>
          <p v-if="isSketchDraw" id="sketch-hold-help" class="renderer-help" role="status">
            The drawing finishes, then the complete image holds for the closing hold. A hold never takes more than half a scene, so the drawing always has time; scene length and narration do not change.
            <span v-if="!holdLoaded">Loading this episode's closing hold.</span>
            <span v-else-if="holdUnreadable">{{ holdUnreadable }} Choose a hold to replace it; Sketch Draw waits until you do.</span>
            <span v-else-if="episodeHold">{{ episodeId }} uses its own hold: {{ holdLabel(episodeHold) }}. Other episodes are not affected.</span>
            <span v-else>{{ episodeId }} follows the channel default hold: {{ holdLabel(channelHold) }}. Choosing a hold here changes only {{ episodeId }}.</span>
            <span v-if="holdChoice === 'range'">Each scene gets its own hold between the two, the same every time it is re-rendered.</span>
            <span v-if="holdPending">Not applied yet. Apply the hold, or pick another option, before generating.</span>
            <span v-if="holdError" class="stale-note" role="alert">{{ holdError }}</span>
            <span>Clips made before this setting keep their old hold until you re-generate them.</span>
          </p>
          <p v-if="isSketchDraw" id="sketch-pen-help" class="renderer-help" role="status">
            Draw the exact scene image, add colour, then hold the complete image for its Scene Plan window. Free, on this Mac.
            Each clip lasts exactly its scene window at your Video Assembly frame rate; prompt text does not change the drawing.
            <span v-if="!penLoaded">Loading this episode's pen.</span>
            <span v-else-if="penUnreadable">{{ penUnreadable }} Choose a pen to replace it; Sketch Draw waits until you do.</span>
            <span v-else-if="episodePen">{{ episodeId }} uses its own pen: {{ penLabel(episodePen) }}. Other episodes are not affected.</span>
            <span v-else>{{ episodeId }} follows the channel default pen: {{ penLabel(channelPen) }}. Choosing a pen here changes only {{ episodeId }}.</span>
            <span v-if="sketchPen === 'name'">Pen name: {{ channelName }}.</span>
            <span v-if="!channelHasLogo">Channel logo pen is unavailable. Add a logo in Channel Profile to use it.</span>
          </p>
          <p v-if="presentationError" class="stale-note" role="alert">{{ presentationError }}</p>
        </div>
        <div class="motion-tools" :class="{ 'sketch-tools': isSketchDraw }">
          <template v-if="!isSketchDraw">
          <label class="model-field">
            <span>Image-to-video model</span>
            <ModelMenu
              v-model="videoModel"
              :options="i2vModels"
              media-type="video"
              title="Choose an image-to-video model"
              placeholder="Pick an image-to-video model…"
              search-placeholder="Search video model or provider…"
              aria-label="Image-to-video model options"
              :catalogue-error="mediaModelsError"
            />
            <!-- Charged capability the assembled episode will not contain.
                 Shown at the point of choosing, next to the model that bills
                 for it, so a customer can pick a picture-only model instead. -->
            <span v-if="videoModelNotice" class="model-unavailable-notice" role="alert">
              {{ videoModelNotice }}
            </span>
            <span v-if="selectedVideoModelAudioNotice" class="model-audio-notice">
              {{ selectedVideoModelAudioNotice }}
            </span>
            <span v-if="appDefaultVideoGone" class="model-audio-notice" role="status">{{ appDefaultVideoGone }}</span>
          </label>
          <!-- The lane's own switches, rendered from what it publishes and nothing else.
               A model that publishes no switch shows no control here, so this page never
               decides on the lane's behalf. The lane's own note travels with the switch: it
               is the only honest statement of what unticking does (for `audio` on a local
               lane: picture and sound are denoised together, so a silent clip is not a
               quicker one). -->
          <label
            v-for="control in selectedVideoControls"
            :key="control.name"
            class="model-field switch-field"
          >
            <span>{{ switchLabel(control.name) }}</span>
            <span class="switch-row">
              <input
                :checked="switchValue(control)"
                type="checkbox"
                role="switch"
                :aria-label="`${switchLabel(control.name)} — published by the selected model`"
                @change="setSwitch(control, ($event.target as HTMLInputElement).checked)"
              >
              <span class="switch-word">{{ switchValue(control) ? 'On' : 'Off' }}</span>
            </span>
            <span v-if="control.note" class="switch-note">{{ control.note }}</span>
          </label>
          <label class="model-field resolution-field">
            <span>Aspect ratio</span>
            <select v-model="selectedAspectRatio" class="select" :disabled="!availableAspectRatios.length" aria-label="Aspect ratio">
              <option value="" disabled>{{ availableAspectRatios.length ? 'Choose an aspect ratio' : 'No aspect ratio available' }}</option>
              <option v-for="ratio in availableAspectRatios" :key="ratio" :value="ratio">{{ ratio }}</option>
            </select>
          </label>
          <label class="model-field resolution-field">
            <span>Resolution</span>
            <select
              class="select"
              :value="selectedResolution"
              :disabled="!availableResolutions.length"
              aria-label="Resolution"
              @change="chooseResolution"
            >
              <option v-if="!availableResolutions.length" value="">No resolution available</option>
              <option v-for="resolution in availableResolutions" :key="resolution" :value="resolution">
                {{ resolution }}
              </option>
            </select>
          </label>
          <fieldset class="duration-mode" :disabled="!selectedResolutionVariants.length">
            <legend>Clip timing</legend>
            <label>
              <input v-model="durationMode" type="radio" name="duration-mode" value="manual">
              <span><strong>Manual duration</strong><small>Use one listed length for every new clip.</small></span>
            </label>
            <label>
              <input v-model="durationMode" type="radio" name="duration-mode" value="follow_narration">
              <span><strong>Follow narration</strong><small>Round each scene up to its next listed length.</small></span>
            </label>
          </fieldset>
          <div v-if="durationMode === 'manual'" class="manual-duration">
            <div class="manual-duration-heading">
              <label for="manual-clip-length">Manual clip length</label>
              <span v-if="maximumDuration !== null">Maximum {{ maximumDuration }}s</span>
            </div>
            <div class="manual-duration-inputs">
              <input
                aria-label="Manual clip length slider"
                type="range"
                min="0"
                :max="Math.max(0, selectedResolutionVariants.length - 1)"
                step="1"
                :value="manualDurationIndex"
                :aria-valuetext="manualDurationSeconds === null ? undefined : `${manualDurationSeconds} seconds`"
                :disabled="!selectedResolutionVariants.length"
                @input="chooseManualSliderValue"
                @keydown="moveManualDuration"
              >
              <div class="duration-number-wrap">
                <input
                  id="manual-clip-length"
                  class="input duration-number"
                  aria-label="Manual clip length"
                  type="number"
                  inputmode="decimal"
                  step="any"
                  :min="minimumDuration ?? undefined"
                  :max="maximumDuration ?? undefined"
                  :value="manualDurationDraft"
                  :disabled="!selectedResolutionVariants.length"
                  @input="editManualDuration"
                  @blur="commitManualDuration"
                  @keydown.enter="commitManualDuration"
                >
                <span aria-hidden="true">seconds</span>
              </div>
            </div>
            <p class="duration-help">
              Available lengths: {{ publishedDurationLabels || 'None' }}. Typed values round up; values above the longest length use {{ maximumDuration }}s.
            </p>
          </div>
          <div v-else class="follow-duration-note">
            <strong>Each unsent scene is matched separately.</strong>
            <span>Longer clips are trimmed. If narration exceeds the listed maximum, the final frame holds for the visible shortfall.</span>
          </div>
          <div v-if="selectedResolutionVariants.length" class="batch-cost" aria-live="polite">
            <strong>{{ batchPlans.length }} {{ batchPlans.length === 1 ? 'clip' : 'clips' }}<template v-if="!videoHasUsdPrice"> · Estimated total {{ formatCredits(batchListedTotal) }}</template></strong>
            <span v-if="batchEstimatedUsd !== null">Estimate: {{ formatUsdAmount(batchEstimatedUsd) }} for {{ formatSeconds(batchDurationSeconds) }} of video.</span>
            <span v-else-if="!videoHasUsdPrice">Price is confirmed when each clip starts.</span>
            <span v-if="batchEstimatedMinutes > 0">Estimate: about {{ formatMinutes(batchEstimatedMinutes) }} of render time on this Mac.</span>
            <span v-if="existingClipCount">Existing clips stay out of this batch.</span>
          </div>
          <div v-if="clipMisfits.length" class="clip-misfit-banner" role="status">
            <strong>{{ clipMisfitLabel }}</strong>
            <span>Re-plan those scenes in Scene Plan, or fill the extra time here:</span>
            <span class="clip-misfit-actions">
              <button class="btn btn-sm btn-secondary" :disabled="fillingMisfits" @click="fillFlaggedScenes('chain')">Chain clips</button>
              <button class="btn btn-sm btn-secondary" :disabled="fillingMisfits" @click="fillFlaggedScenes('hold')">Hold last frame</button>
            </span>
          </div>
          </template>
          <button v-if="motionScope.mode === 'all'" class="btn btn-sm btn-secondary" :disabled="savingAll || scopedClipCount === 0" @click="approveAllClips">
            Approve All Fresh Clips
          </button>
          <button v-if="motionScope.mode === 'all'" class="btn btn-sm btn-ghost" :disabled="savingAll" @click="keepAllStills">Keep All as Stills</button>
        </div>
      </div>
    </WorkspaceSection>

    <WorkspaceNotice v-else-if="stats && usesImagePool" title="Motion Review is not used for Image Pool" tone="info">
      This episode assembles its saved Image Pool selection. Scene clips and motion decisions do not apply here.
      <template #actions>
        <NuxtLink :to="`/projects/${slug}/video-assembly?episode_id=${encodeURIComponent(episodeId)}`" class="btn btn-sm btn-secondary">Open Video Assembly</NuxtLink>
      </template>
    </WorkspaceNotice>

    <section v-if="!episodeId" class="card mt-3 empty-state">Pick an episode to review motion.</section>
    <section v-else-if="loading && !scenes.length" class="card mt-3 empty-state">Loading motion pass...</section>
    <section v-else-if="usesImagePool" class="card mt-3 empty-state">
      Image Pool is the selected visual source. Motion Review is not used for this episode.
    </section>
    <section v-else-if="loadError && !scenes.length" class="card mt-3 empty-state" role="alert">
      <p>We couldn't load this episode's scenes. Check your connection and try again.</p>
      <p class="load-error-detail">{{ loadError }}</p>
      <button class="btn btn-sm btn-secondary" :disabled="loading" @click="loadReview()">Try Again</button>
    </section>
    <section v-else-if="!scenes.length" class="card mt-3 empty-state">
      No scene plan is available yet. Complete Scene Plan and Scene Review first.
    </section>

    <ul v-else class="motion-grid mt-3">
      <li v-for="scene in renderedScenes" :key="scene.id" class="motion-card" :class="`choice-${scene.motion_choice || (scene.clip_exists ? 'legacy' : 'pending')}`">
        <div class="media-pair">
          <div class="media-box">
            <span class="media-label">Approved image</span>
            <img v-if="scene.image_filename" :src="imageUrl(scene)" :alt="`Scene ${scene.scene_index}`" loading="lazy" decoding="async" />
            <div v-else class="missing-media">Image missing</div>
          </div>
          <div class="media-box">
            <span class="media-label">Motion result</span>
            <video v-if="scene.clip_exists" :src="clipUrl(scene)" controls loop preload="none" />
            <div v-else-if="clipWork(scene)" class="missing-media clip-working" role="status">
              <span class="clip-spinner" aria-hidden="true" />{{ clipWork(scene) }}
            </div>
            <div v-else class="missing-media">No clip yet</div>
          </div>
        </div>

        <div class="motion-copy">
          <div class="scene-line">
            <strong>Scene {{ scene.scene_index }}</strong>
            <span>{{ scene.start_sec.toFixed(1) }}s to {{ scene.end_sec.toFixed(1) }}s</span>
            <span class="choice-badge" :class="{ working: !!clipWork(scene) }">{{ clipWork(scene) || choiceLabel(scene) }}</span>
          </div>
          <div class="scene-lane-row">
            <label class="model-field lane-field">
              <span>Visual lane</span>
              <select
                class="select"
                :value="sceneLane(scene)"
                :disabled="!!clipWork(scene) || laneSavingId === scene.id"
                :aria-label="`Visual lane for scene ${scene.scene_index}`"
                @change="setSceneLane(scene, ($event.target as HTMLSelectElement).value)"
              >
                <option value="still">Still image</option>
                <option value="sketch_draw">Sketch Draw</option>
                <option value="image_to_video">AI image-to-video</option>
                <option value="text_to_video">AI text-to-video</option>
                <option value="imported">Imported clip</option>
              </select>
            </label>
            <label v-if="sceneLane(scene) !== 'still' && sceneLane(scene) !== 'imported'" class="model-field fill-field">
              <span>If over the clip limit</span>
              <select
                class="select"
                :value="scene.fill_mode || 'hold'"
                :disabled="!!clipWork(scene) || laneSavingId === scene.id"
                :aria-label="`Fill mode for scene ${scene.scene_index}`"
                @change="setSceneFillMode(scene, ($event.target as HTMLSelectElement).value)"
              >
                <option value="hold">Hold last frame</option>
                <option value="chain">Chain clips</option>
              </select>
            </label>
          </div>
          <div v-if="scene.duration_plan" class="scene-duration-plan" :class="{ 'has-shortfall': scene.duration_plan.adjustment === 'hold' }">
            <span><small>Narration</small><strong>{{ formatSeconds(scene.duration_plan.narration_seconds) }}</strong></span>
            <span><small>Next request</small><strong>{{ formatSeconds(scene.duration_plan.requested_seconds) }}</strong></span>
            <span><small>Adjustment</small><strong>{{ scene.duration_plan.adjustment_label }}</strong></span>
            <span
              v-if="!videoHasUsdPrice"
              :title="`Minimum ${scene.duration_plan.variant.minimum_credits} credits · price list ${scene.duration_plan.variant.price_version}`"
            ><small>Estimated cost</small><strong>{{ formatCredits(scene.duration_plan.variant.credits_per_video) }}</strong></span>
          </div>
          <p class="transcript">{{ scene.transcript_segment }}</p>
          <details v-if="!isSketchDraw" class="disclosure" open>
            <summary>{{ sceneLane(scene) === 'text_to_video' ? 'Video direction (text-to-video)' : 'Motion direction' }}</summary>
            <p class="motion-prompt">{{ sceneLane(scene) === 'text_to_video'
              ? (scene.video_prompt || scene.motion_prompt || 'No video prompt. Add one in Scene Plan, or choose a still for this scene.')
              : (scene.motion_prompt || 'No motion prompt. Add one in Scene Plan, or keep this scene as a still.') }}</p>
          </details>
          <p v-if="!clipWork(scene) && !scene.clip_exists && generateBlocked(scene)" class="blocked-note">Generate Clip is off: {{ generateBlocked(scene) }}.</p>
          <div v-if="isSketchDraw" class="scene-reveal">
            <div class="model-field reveal-pin-field">
              <span>Reveal for this scene</span>
              <SketchRevealPicker :model-value="scenePinOf(scene)" :reveals="revealCatalog" :weight="episodeLineWeight ?? channelLineWeight" :disabled="!revealLoaded || !!revealUnreadable || revealSaving || pinSavingId === scene.id || !revealCatalog.length || lineWeightSaving" :label="`Reveal style for scene ${scene.scene_index}`" title="Choose a reveal for this scene" :inherit-label="`Follow the episode (${revealLabel(episodeReveal ?? channelReveal)})`" @pick="setScenePin(scene, $event)" @weight="saveLineWeight" />
            </div>
            <p v-if="scene.reveal_type" :id="`scene-reveal-help-${scene.id}`" class="reveal-note">
              {{ scenePinOf(scene) ? 'Pinned' : 'Draws' }}: {{ REVEAL_LABELS[scene.reveal_type] }}<template
                v-if="revealIsMix"
              >{{ scenePinOf(scene) ? ' — this pin wins over the Mix' : ' — picked by the Mix for this scene' }}</template>
              <span v-if="pinSavingId === scene.id"> Saving…</span>
            </p>
            <p v-else :id="`scene-reveal-help-${scene.id}`" class="reveal-note">
              {{ sceneRevealHelp() }}
            </p>
          </div>
          <p v-if="scene.clip_stale" class="stale-note">This clip needs to be generated again: {{ scene.clip_stale_reason || 'its source or scene window changed' }}. Re-generate before approval.</p>
        </div>

        <div class="motion-actions">
          <button
            class="btn btn-sm btn-secondary"
            :disabled="uploadingId === scene.id || animatingId === scene.id"
            @click="uploadClipOne(scene)"
          >{{ uploadingId === scene.id ? 'Uploading...' : 'Upload External Clip' }}</button>
          <button
            class="btn btn-sm btn-secondary"
            :disabled="!!generateBlocked(scene) || animatingId === scene.id || !!clipWork(scene)"
            :title="generateBlocked(scene) || undefined"
            @click="generateOne(scene)"
          >{{ animatingId === scene.id ? 'Queuing...' : clipWork(scene) ? 'Making clip…' : (scene.clip_exists ? 'Re-Generate Clip' : 'Generate Clip') }}</button>
          <button
            class="btn btn-sm btn-primary"
            :disabled="!scene.clip_exists || scene.clip_stale || savingId === scene.id"
            @click="setChoice(scene, 'clip')"
          >{{ sceneLane(scene) === 'text_to_video' ? 'Approve Clip' : 'Use Clip' }}</button>
          <button class="btn btn-sm btn-ghost" :disabled="savingId === scene.id" @click="setChoice(scene, 'still')">{{ sceneLane(scene) === 'text_to_video' ? 'Reject — use backup still' : 'Use Still' }}</button>
        </div>
      </li>
    </ul>
    <div
      v-if="renderedScenes.length < scenes.length"
      ref="sceneLoadSentinel"
      class="motion-list-more"
    >
      <span>{{ renderedScenes.length }} of {{ scenes.length }} scenes loaded</span>
      <button class="btn btn-sm btn-ghost" @click="loadMoreScenes">Load next {{ SCENE_RENDER_BATCH }}</button>
    </div>

    <Transition name="motion-float">
      <button
        v-if="showBackToTop"
        class="back-to-top"
        title="Back to top"
        aria-label="Scroll to top of page"
        @click="scrollToTop"
      >
        <span aria-hidden="true">↑</span>
        Back to top
      </button>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { DEFAULT_MOTION_SCOPE } from '@shared/motion-scope'
import { selectLiveImageToVideoModel } from '~/utils/genstudio-video-model-selection'
import { genStudioModelLockReason } from '~/utils/live-genstudio-model-selection'
import { describeVideoModelRate, formatCredits } from '~/utils/genstudio-credit-cost'
import { formatUsd, hasPriceTruth } from '~/utils/genstudio-price-usd'
import { variantsForVideoOperation } from '~/utils/genstudio-video-variants'
import type { GenStudioVideoControl } from '~/composables/useGenStudioMediaModels'
import { emptyDefaultModels, normalizeDefaultModels, resolveEffectiveModel } from '~/utils/live-genstudio-model-selection'
import { motionBatchEligible, sketchSelectionReady } from '~/utils/motion-review-sketch'
import { HOLD_MAX_SECONDS, holdDrafts, holdFromDraft, holdLabel, type HoldChoice, type HoldDrafts, type SketchHold } from '~/utils/sketch-hold'
import { REVEAL_LABELS, REVEAL_TYPES, setRevealCatalog, applyRevealPreset, revealChoiceOf, revealForPreset, revealFromDraft, revealLabel, revealMixDraft as revealMixFor, type SketchReveal, type SketchRevealStyle, type SketchRevealType } from '~/utils/sketch-reveal'
import { LINE_WEIGHTS, lineWeightFromDraft, lineWeightLabel, type LineWeightChoice, type SketchLineWeight } from '~/utils/sketch-line-weight'

// usePresets captures the project slug at setup. Recreate this page for a
// project navigation so controls and scene state cannot carry into another project.
definePageMeta({ layout: 'dashboard', key: route => String(route.params.slug || '') })
useAppTitle('Motion Review')

type MotionChoice = 'pending' | 'clip' | 'still'
type VisualLane = 'still' | 'sketch_draw' | 'image_to_video' | 'text_to_video' | 'imported'
type MotionShareFormula = 'opening_hook' | 'key_moments' | 'spread' | 'chronological'
type MotionScope =
  | { mode: 'off' }
  | { mode: 'opening'; end_sec: number }
  | { mode: 'selected'; scene_ids: string[] }
  | { mode: 'all' }
  | { mode: 'share'; share_percent: number; formula?: MotionShareFormula }
interface MotionScene {
  id: string
  scene_index: number
  start_sec: number
  end_sec: number
  transcript_segment: string
  motion_prompt?: string
  approved: boolean
  image_filename: string | null
  clip_exists?: boolean
  clip_stale?: boolean
  clip_stale_reason?: string
  clip_renderer?: 'sketch_draw' | 'image_to_video' | 'text_to_video' | 'external'
  /** The reveal style this Sketch Draw scene resolves to, or null for other renderers. */
  reveal_type?: SketchRevealType | null
  /** The style this scene is pinned to, or null when it follows the episode's reveal. */
  reveal_pin?: SketchRevealType | null
  motion_choice?: MotionChoice
  /** Multi-lane video expansion: this scene's editorial lane. */
  visual_lane?: VisualLane
  video_prompt?: string
  key_moment?: boolean
  /** The planner's suggestion; used only where the customer has not decided. */
  key_moment_suggested?: boolean
  fill_mode?: 'chain' | 'hold'
  backup_still?: boolean
}
interface MotionStats {
  total_scenes: number
  approved: number
  with_image: number
  with_clip: number
  motion_reviewed: number
  all_motion_reviewed: boolean
}
type DurationMode = 'manual' | 'follow_narration'
type DurationPlan = {
  narration_seconds: number
  requested_seconds: number
  adjustment: 'exact' | 'trim' | 'hold' | 'loop'
  adjustment_label: string
  variant: VideoVariant
}

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const initialEpisodeId = typeof route.query.episode_id === 'string'
  ? route.query.episode_id
  : typeof route.query.episode === 'string'
    ? route.query.episode
    : ''
const episodeId = ref(initialEpisodeId)
const { get, post, put } = useApi()
const { success, error: showError, info } = useToast()
const { ask } = useConfirm()
const { isJobActiveFor, jobs } = useJobs()
const scenes = ref<MotionScene[]>([])
const SCENE_RENDER_BATCH = 24
const renderedSceneLimit = ref(SCENE_RENDER_BATCH)
const renderedScenes = computed(() => scenes.value.slice(0, renderedSceneLimit.value).map(scene => ({
  ...scene,
  duration_plan: durationPlanForScene(scene),
})))
const sceneLoadSentinel = ref<HTMLElement | null>(null)
let sceneLoadObserver: IntersectionObserver | null = null
let reviewLoadSequence = 0
function loadMoreScenes(): void {
  renderedSceneLimit.value = Math.min(scenes.value.length, renderedSceneLimit.value + SCENE_RENDER_BATCH)
}
const stats = ref<MotionStats | null>(null)
const motionScope = ref<MotionScope>({ mode: 'off' })
const motionSceneIds = ref<string[]>([])
const motionCrossingSceneIds = ref<string[]>([])
const motionScopeError = ref('')
const visualSource = ref<'scene_plan' | 'image_pool'>('scene_plan')
const animateMinSeconds = ref(0)
const loading = ref(false)
// Why the last load failed, shown with a Try again button instead of the false "no scene plan yet".
const loadError = ref('')
const queuing = ref(false)
const savingAll = ref(false)
const savingId = ref<string | null>(null)
const animatingId = ref<string | null>(null)
const uploadingId = ref<string | null>(null)
const videoModel = ref('')
const clipRenderer = ref<'image_to_video' | 'sketch_draw'>('image_to_video')
type PenMode = 'none' | 'plain' | 'name' | 'logo'
// The channel default, and this episode's own pen when it has one. The pen that renders is the
// episode's, else the channel's; the server resolves it the same way for freshness and Assembly.
const channelPen = ref<PenMode>('none')
const episodePen = ref<PenMode | null>(null)
const penChoice = ref<'' | 'channel' | PenMode>('channel')
// Set when this episode's saved pen file cannot be read: the effective pen is then unknown, not "none".
const penUnreadable = ref('')
const sketchPen = computed<PenMode>(() => episodePen.value ?? channelPen.value)
const penLoaded = ref(false)
const penSaving = ref(false)
const PEN_LABELS: Record<PenMode, string> = { none: 'no pen', plain: 'plain pen', name: 'pen with channel name', logo: 'pen with channel logo' }
const penLabel = (pen: PenMode) => PEN_LABELS[pen]
const isSketchDraw = computed(() => clipRenderer.value === 'sketch_draw')
// The closing hold follows the pen's pattern: a channel default, and this episode's own when it has one.
const channelHold = ref<SketchHold>({ mode: 'auto' })
const episodeHold = ref<SketchHold | null>(null)
const holdChoice = ref<HoldChoice>('channel')
const holdDraft = ref<HoldDrafts>(holdDrafts(null))
const holdLoaded = ref(false)
const holdSaving = ref(false)
// Set when this episode's saved hold file cannot be read: the effective hold is then unknown, not "auto".
const holdUnreadable = ref('')
const holdError = ref('')
const acceptedHoldChoice = (): HoldChoice => holdUnreadable.value ? '' : episodeHold.value?.mode ?? 'channel'
// Fixed and range wait for Apply; this is true while what is shown is not what is saved.
const holdPending = computed(() => {
  if (holdChoice.value !== 'fixed' && holdChoice.value !== 'range') return false
  const parsed = holdFromDraft(holdChoice.value, holdDraft.value)
  return !parsed.ok || JSON.stringify(parsed.hold) !== JSON.stringify(episodeHold.value)
})
// The reveal follows the pen's and hold's pattern: a channel default, and this episode's own when
// it has one. The reveal that renders is the episode's, else the channel's; the server resolves it
// the same way for freshness, generation and Assembly.
const revealCatalog = ref<Array<{ id: string; label: string }>>([])
const revealCatalogError = ref('')
async function loadRevealCatalog() {
  try {
    const result = await get<{ reveals: Array<{ id: string; label: string }> }>('/sketch-reveals')
    if (!Array.isArray(result.reveals) || !result.reveals.length) throw new Error('No reveal styles were returned.')
    setRevealCatalog(result.reveals)
    revealCatalog.value = result.reveals
    revealCatalogError.value = ''
  } catch (error: any) { revealCatalogError.value = `Could not load reveal styles: ${error?.message || 'try again.'}` }
}
const channelReveal = ref<SketchReveal | null>(null)
const episodeReveal = ref<SketchReveal | null>(null)
// `'channel'` follows the channel default; a style (or `'mix'`) is this episode's own; `''` is the
// placeholder shown while the saved file is unreadable.
const revealChoice = ref<'' | 'channel' | SketchRevealStyle>('channel')
const revealMixDraft = ref<SketchRevealType[]>(revealMixFor(null))
const revealLoaded = ref(false)
const revealSaving = ref(false)
// Set when this episode's saved reveal file cannot be read: the effective reveal is then unknown,
// never "not chosen".
const revealUnreadable = ref('')
const revealError = ref('')
const acceptedRevealChoice = (): typeof revealChoice.value =>
  revealUnreadable.value ? '' : episodeReveal.value ? revealChoiceOf(episodeReveal.value) : 'channel'
// True while the reveal in force is a Mix, so a scene row can say whether its style was picked or pinned.
const revealIsMix = computed(() => (episodeReveal.value ?? channelReveal.value)?.style === 'mix')
// The pin on a scene: the episode's own (or, until it has one, the channel default's), else none.
function scenePinOf(scene: MotionScene): SketchRevealType | '' {
  return episodeReveal.value?.overrides?.[scene.id] ?? scene.reveal_pin ?? ''
}
/** Why a scene shows no resolved style: nothing chosen yet, or this scene is a provider clip. */
function sceneRevealHelp(): string {
  if (revealUnreadable.value) return 'Choose a reveal style above to pin this scene.'
  if (!(episodeReveal.value ?? channelReveal.value)) return 'Choose a reveal style for this episode, or pin one here.'
  return 'This scene is not a Sketch Draw clip, so it has no reveal to show.'
}
const pinSavingId = ref<string | null>(null)
// A Mix waits for Apply; this is true while what is shown is not what is saved.
const revealPending = computed(() => {
  if (revealChoice.value !== 'mix') return false
  const parsed = revealFromDraft('mix', revealMixDraft.value)
  return !parsed.ok || JSON.stringify(parsed.reveal) !== JSON.stringify(episodeReveal.value)
})
// The ink weight follows the same pattern: a channel default, and this episode's own when it has
// one. Absent means normal, the engine's own weight, so a clip keeps the look it was drawn with.
const channelLineWeight = ref<SketchLineWeight>('normal')
const episodeLineWeight = ref<SketchLineWeight | null>(null)
const lineWeightChoice = ref<LineWeightChoice>('channel')
const lineWeightLoaded = ref(false)
const lineWeightSaving = ref(false)
// Set when this episode's saved weight file cannot be read: the effective weight is then unknown.
const lineWeightUnreadable = ref('')
const lineWeightError = ref('')
const acceptedLineWeightChoice = (): LineWeightChoice =>
  lineWeightUnreadable.value ? '' : episodeLineWeight.value ?? 'channel'
const channelName = ref('')
const channelHasLogo = ref(false)
const presentationLoaded = ref(false)
const presentationSaving = ref(false)
const presentationError = ref('')
let acceptedRenderer: 'image_to_video' | 'sketch_draw' = 'image_to_video'
async function loadMotionPresentation() {
  try {
    const result = await get<{ renderer: typeof clipRenderer.value; pen: PenMode; hold?: SketchHold; reveal?: SketchReveal | null; line_weight?: SketchLineWeight; channel_name: string; has_logo: boolean }>(`/projects/${slug.value}/motion-presentation`)
    clipRenderer.value = result.renderer
    channelPen.value = result.pen
    if (result.hold) channelHold.value = result.hold
    // Absent and null both mean "never chosen"; a stored value that cannot be read is a server error.
    channelReveal.value = result.reveal ?? null
    // Absent means normal, the engine's own weight.
    channelLineWeight.value = result.line_weight ?? 'normal'
    channelName.value = result.channel_name
    channelHasLogo.value = result.has_logo
    acceptedRenderer = result.renderer
    presentationLoaded.value = true
    presentationError.value = ''
  } catch (error: any) { presentationError.value = error?.data?.detail || error?.message || 'Could not load channel motion settings. Reopen Motion Review to retry.' }
}
// The renderer is a channel choice; it never touches any pen.
async function saveMotionPresentation() {
  presentationSaving.value = true
  presentationError.value = ''
  try {
    await put(`/projects/${slug.value}/motion-presentation`, { renderer: clipRenderer.value })
    acceptedRenderer = clipRenderer.value
    await loadReview()
  } catch (error: any) {
    clipRenderer.value = acceptedRenderer
    presentationError.value = error?.data?.detail || error?.message || 'Could not save the renderer. Try again.'
    showError(presentationError.value)
  } finally { presentationSaving.value = false }
}
// AGENTS.md §4: the pen belongs to one episode. A late answer for the previous episode is dropped.
async function loadEpisodePen() {
  const ep = episodeId.value
  if (!ep) return
  try {
    const result = await get<{ episode_pen: PenMode | null; channel_pen: PenMode; error?: string }>(`/projects/${slug.value}/scene-review/${encodeURIComponent(ep)}/motion-pen`)
    if (ep !== episodeId.value) return
    episodePen.value = result.episode_pen
    channelPen.value = result.channel_pen
    penUnreadable.value = result.error || ''
    penChoice.value = result.error ? '' : result.episode_pen ?? 'channel'
    penLoaded.value = true
  } catch (error: any) {
    if (ep === episodeId.value) presentationError.value = error?.data?.detail || error?.message || `Could not load the pen for ${ep}. Switch episodes and back to retry.`
  }
}
// AGENTS.md §4: the hold belongs to one episode. A late answer for the previous episode is dropped.
async function loadEpisodeHold() {
  const ep = episodeId.value
  if (!ep) return
  try {
    const result = await get<{ episode_hold: SketchHold | null; channel_hold: SketchHold; error?: string }>(`/projects/${slug.value}/scene-review/${encodeURIComponent(ep)}/motion-hold`)
    if (ep !== episodeId.value) return
    episodeHold.value = result.episode_hold
    channelHold.value = result.channel_hold
    holdUnreadable.value = result.error || ''
    holdChoice.value = acceptedHoldChoice()
    holdDraft.value = holdDrafts(result.episode_hold ?? result.channel_hold)
    holdLoaded.value = true
  } catch (error: any) {
    if (ep === episodeId.value) presentationError.value = error?.data?.detail || error?.message || `Could not load the closing hold for ${ep}. Switch episodes and back to retry.`
  }
}
async function saveEpisodeHold(next: SketchHold | null) {
  const ep = episodeId.value
  holdSaving.value = true
  holdError.value = ''
  presentationError.value = ''
  try {
    await put(`/projects/${slug.value}/scene-review/${encodeURIComponent(ep)}/motion-hold`, { hold: next })
    if (ep !== episodeId.value) return
    episodeHold.value = next
    holdUnreadable.value = ''
    holdChoice.value = acceptedHoldChoice()
    holdDraft.value = holdDrafts(next ?? channelHold.value)
    await loadReview()
  } catch (error: any) {
    if (ep !== episodeId.value) return
    holdChoice.value = acceptedHoldChoice()
    holdDraft.value = holdDrafts(episodeHold.value ?? channelHold.value)
    holdError.value = error?.data?.detail || error?.message || `Could not save the closing hold for ${ep}. Try again.`
    showError(holdError.value)
  } finally { if (ep === episodeId.value) holdSaving.value = false }
}
// Off, auto and "follow the channel" need no numbers, so they save at once; fixed and range wait for Apply.
function onHoldChoice() {
  holdError.value = ''
  if (holdChoice.value === 'fixed' || holdChoice.value === 'range') {
    holdDraft.value = holdDrafts(episodeHold.value ?? channelHold.value)
    return
  }
  const parsed = holdFromDraft(holdChoice.value, holdDraft.value)
  if (parsed.ok) void saveEpisodeHold(parsed.hold)
}
function applyHold() {
  const parsed = holdFromDraft(holdChoice.value, holdDraft.value)
  if ('error' in parsed) { holdError.value = parsed.error; return }
  holdError.value = ''
  void saveEpisodeHold(parsed.hold)
}
// AGENTS.md §4: the reveal belongs to one episode. A late answer for the previous episode is dropped.
async function loadEpisodeReveal() {
  const ep = episodeId.value
  if (!ep) return
  try {
    const result = await get<{ episode_reveal: SketchReveal | null; channel_reveal: SketchReveal | null; error?: string }>(`/projects/${slug.value}/scene-review/${encodeURIComponent(ep)}/motion-reveal`)
    if (ep !== episodeId.value) return
    episodeReveal.value = result.episode_reveal
    channelReveal.value = result.channel_reveal
    revealUnreadable.value = result.error || ''
    revealChoice.value = acceptedRevealChoice()
    revealMixDraft.value = revealMixFor(result.episode_reveal)
    revealLoaded.value = true
  } catch (error: any) {
    if (ep === episodeId.value) presentationError.value = error?.data?.detail || error?.message || `Could not load the reveal style for ${ep}. Switch episodes and back to retry.`
  }
}
// This episode's reveal, or null to follow the channel default again.
async function saveReveal(next: SketchReveal | null) {
  const ep = episodeId.value
  revealSaving.value = true
  revealError.value = ''
  presentationError.value = ''
  try {
    await put(`/projects/${slug.value}/scene-review/${encodeURIComponent(ep)}/motion-reveal`, { reveal: next })
    if (ep !== episodeId.value) return
    episodeReveal.value = next
    revealUnreadable.value = ''
    revealChoice.value = acceptedRevealChoice()
    revealMixDraft.value = revealMixFor(next)
    success(next
      ? `Sketch Draw reveal for ${ep} is now ${revealLabel(next)}. Scenes whose style changed need re-generating; the rest are kept.`
      : `${ep} follows the channel default reveal again. Its clips keep the reveal they were made with until you re-generate them.`)
    await loadReview()
  } catch (error: any) {
    if (ep !== episodeId.value) return
    revealChoice.value = acceptedRevealChoice()
    revealMixDraft.value = revealMixFor(episodeReveal.value)
    revealError.value = error?.data?.detail || error?.message || `Could not save the reveal style for ${ep}. Try again.`
    showError(revealError.value)
  } finally { if (ep === episodeId.value) revealSaving.value = false }
}
// AGENTS.md §4: the weight belongs to one episode. A late answer for the previous episode is dropped.
async function loadEpisodeLineWeight() {
  const ep = episodeId.value
  if (!ep) return
  try {
    const result = await get<{ episode_line_weight: SketchLineWeight | null; channel_line_weight: SketchLineWeight; error?: string }>(`/projects/${slug.value}/scene-review/${encodeURIComponent(ep)}/motion-line-weight`)
    if (ep !== episodeId.value) return
    episodeLineWeight.value = result.episode_line_weight
    channelLineWeight.value = result.channel_line_weight
    lineWeightUnreadable.value = result.error || ''
    lineWeightChoice.value = acceptedLineWeightChoice()
    lineWeightLoaded.value = true
  } catch (error: any) {
    if (ep === episodeId.value) presentationError.value = error?.data?.detail || error?.message || `Could not load the line weight for ${ep}. Switch episodes and back to retry.`
  }
}
// This episode's weight, or null to follow the channel default again.
async function saveLineWeight(next: SketchLineWeight | null) {
  const ep = episodeId.value
  lineWeightSaving.value = true
  lineWeightError.value = ''
  presentationError.value = ''
  try {
    await put(`/projects/${slug.value}/scene-review/${encodeURIComponent(ep)}/motion-line-weight`, { line_weight: next })
    if (ep !== episodeId.value) return
    episodeLineWeight.value = next
    lineWeightUnreadable.value = ''
    lineWeightChoice.value = acceptedLineWeightChoice()
    success(next
      ? `Sketch Draw line weight for ${ep} is now ${lineWeightLabel(next)}. Scenes whose weight changed need re-generating; the rest are kept.`
      : `${ep} follows the channel default line weight again. Its clips keep the weight they were drawn with until you re-generate them.`)
    await loadReview()
  } catch (error: any) {
    if (ep !== episodeId.value) return
    lineWeightChoice.value = acceptedLineWeightChoice()
    lineWeightError.value = error?.data?.detail || error?.message || `Could not save the line weight for ${ep}. Try again.`
    showError(lineWeightError.value)
  } finally { if (ep === episodeId.value) lineWeightSaving.value = false }
}
// A weight needs no further picking, so it saves at once.
function onLineWeightChoice() {
  if (!lineWeightChoice.value) return
  lineWeightError.value = ''
  if (lineWeightChoice.value === 'channel') { void saveLineWeight(null); return }
  const parsed = lineWeightFromDraft(lineWeightChoice.value)
  if (parsed.ok) void saveLineWeight(parsed.weight)
}
// Deliberate: moves the channel default, so episodes without a weight of their own follow it.
async function setChannelLineWeightDefault() {
  const ep = episodeId.value
  const weight = episodeLineWeight.value
  if (!weight) return
  if (!await ask({
    title: 'Make this the channel default line weight?',
    message: `Episodes without their own weight will use ${lineWeightLabel(weight)}; their Sketch Draw clips whose weight changes will need re-generating. ${ep} and episodes with their own weight are not affected.`,
    confirmLabel: 'Make channel default',
  })) return
  presentationSaving.value = true
  presentationError.value = ''
  try {
    await put(`/projects/${slug.value}/motion-presentation`, { renderer: clipRenderer.value, line_weight: weight })
    channelLineWeight.value = weight
    success(`Channel default line weight is now ${lineWeightLabel(weight)}. Episodes without their own weight follow it.`)
    if (ep === episodeId.value) await loadReview()
  } catch (error: any) {
    presentationError.value = error?.data?.detail || error?.message || 'Could not save the channel default line weight. Try again.'
    showError(presentationError.value)
  } finally { presentationSaving.value = false }
}
function pickEpisodeReveal(value: string) {
  revealChoice.value = value
  onRevealChoice()
}
function pickRevealMix(value: string[]) {
  revealMixDraft.value = value
  applyReveal()
}
// A single style and "follow the channel" need no picking, so they save at once; a Mix waits for Apply.
function onRevealChoice() {
  // The unreadable-file placeholder is not a choice; nothing to save until a real style is picked.
  if (!revealChoice.value) return
  revealError.value = ''
  if (revealChoice.value === 'mix') {
    revealMixDraft.value = revealMixFor(episodeReveal.value)
    return
  }
  if (revealChoice.value === 'channel') { void saveReveal(null); return }
  const parsed = revealFromDraft(revealChoice.value, [])
  if (parsed.ok) {
    const overrides = episodeReveal.value?.overrides
    void saveReveal(parsed.reveal && overrides ? { ...parsed.reveal, overrides: { ...overrides } } : parsed.reveal)
  }
}
function applyReveal() {
  const parsed = revealFromDraft('mix', revealMixDraft.value)
  if ('error' in parsed) { revealError.value = parsed.error; return }
  revealError.value = ''
  // The episode's own pins are editorial choices about THIS episode; a Mix edit must not drop them.
  const overrides = episodeReveal.value?.overrides
  void saveReveal(parsed.reveal && overrides ? { ...parsed.reveal, overrides: { ...overrides } } : parsed.reveal)
}
/**
 * Pin ONE scene to a reveal style, or clear the pin so it follows the episode again.
 *
 * A pin is this episode's, so it lives in the episode's reveal. An episode that was following the
 * channel gets its own copy of the channel's look (or Line, the engine's own style, when nobody has
 * chosen) before the pin is added — a pin cannot exist without a reveal to belong to. That is the
 * same detach the pen and hold do, and it is announced: the episode stops following the channel.
 */
async function setScenePin(scene: MotionScene, type: string) {
  const ep = episodeId.value
  if (!ep) return
  const base = episodeReveal.value ?? channelReveal.value ?? { style: 'line' as const, mix: [] }
  const overrides = { ...(base.overrides ?? {}) }
  if (type) overrides[scene.id] = type as SketchRevealType
  else delete overrides[scene.id]
  let next: SketchReveal | null = { style: base.style, mix: [...base.mix], ...(Object.keys(overrides).length ? { overrides } : {}) }
  // Clearing the last pin from a look that is exactly the channel's leaves nothing of its own:
  // hand the episode back to the channel rather than freezing a copy of today's default.
  if (!type && Object.keys(overrides).length === 0 && channelReveal.value && JSON.stringify(next) === JSON.stringify(channelReveal.value)) next = null
  const detached = !episodeReveal.value
  pinSavingId.value = scene.id
  revealError.value = ''
  presentationError.value = ''
  try {
    await put(`/projects/${slug.value}/scene-review/${encodeURIComponent(ep)}/motion-reveal`, { reveal: next })
    if (ep !== episodeId.value) return
    episodeReveal.value = next
    revealUnreadable.value = ''
    revealChoice.value = acceptedRevealChoice()
    revealMixDraft.value = revealMixFor(next)
    const label = REVEAL_LABELS[scene.reveal_type ?? 'line']
    success(type
      ? `Scene ${scene.scene_index} is pinned to ${REVEAL_LABELS[type as SketchRevealType]}, which wins over the Mix.${detached ? ` ${ep} now has its own reveal (${revealLabel(next)}); other episodes are not affected.` : ''} Re-generate this scene to apply it.`
      : next
        ? `Scene ${scene.scene_index} follows ${ep}'s reveal again (${label} here). Re-generate this scene to apply it.`
        : `Scene ${scene.scene_index} follows ${ep}'s reveal again, and ${ep} follows the channel default again. Re-generate this scene to apply it.`)
    await loadReview()
  } catch (error: any) {
    if (ep !== episodeId.value) return
    revealError.value = error?.data?.detail || error?.message || `Could not save the pin for scene ${scene.scene_index}. Try again.`
    showError(revealError.value)
  } finally { if (ep === episodeId.value) pinSavingId.value = null }
}
// Deliberate: moves the channel default, so episodes without a reveal of their own follow it.
async function setChannelRevealDefault() {
  const ep = episodeId.value
  const reveal = episodeReveal.value
  if (!reveal) return
  if (!await ask({
    title: 'Make this the channel default reveal?',
    message: `Episodes without their own reveal will use ${revealLabel(reveal)}; their Sketch Draw clips whose style changes will need re-generating. ${ep} and episodes with their own reveal are not affected.`,
    confirmLabel: 'Make channel default',
  })) return
  presentationSaving.value = true
  presentationError.value = ''
  try {
    // Per-scene pins name this episode's scenes, so they never become a channel default.
    const look = revealForPreset(reveal)!
    await put(`/projects/${slug.value}/motion-presentation`, { renderer: clipRenderer.value, reveal: look })
    channelReveal.value = look
    success(`Channel default reveal is now ${revealLabel(reveal)}. Episodes without their own reveal follow it.`)
    if (ep === episodeId.value) await loadReview()
  } catch (error: any) {
    presentationError.value = error?.data?.detail || error?.message || 'Could not save the channel default reveal. Try again.'
    showError(presentationError.value)
  } finally { presentationSaving.value = false }
}
// Deliberate: moves the channel default, so episodes without a hold of their own re-render under it.
async function setChannelHoldDefault() {
  const ep = episodeId.value
  const hold = episodeHold.value
  if (!hold) return
  if (!await ask({
    title: 'Make this the channel default hold?',
    message: `Episodes without their own hold will use ${holdLabel(hold)}; their Sketch Draw clips whose hold changes will need re-generating. ${ep} and episodes with their own hold are not affected.`,
    confirmLabel: 'Make channel default',
  })) return
  presentationSaving.value = true
  presentationError.value = ''
  try {
    await put(`/projects/${slug.value}/motion-presentation`, { renderer: clipRenderer.value, hold })
    channelHold.value = hold
    success(`Channel default hold is now ${holdLabel(hold)}. Episodes without their own hold follow it.`)
    if (ep === episodeId.value) await loadReview()
  } catch (error: any) {
    presentationError.value = error?.data?.detail || error?.message || 'Could not save the channel default hold. Try again.'
    showError(presentationError.value)
  } finally { presentationSaving.value = false }
}
async function saveEpisodePen() {
  const ep = episodeId.value
  // The unreadable-file placeholder is not a choice; nothing to save until a real pen is picked.
  if (!penChoice.value) return
  const next = penChoice.value === 'channel' ? null : penChoice.value
  penSaving.value = true
  presentationError.value = ''
  try {
    await put(`/projects/${slug.value}/scene-review/${encodeURIComponent(ep)}/motion-pen`, { pen: next })
    if (ep !== episodeId.value) return
    episodePen.value = next
    penUnreadable.value = ''
    await loadReview()
  } catch (error: any) {
    if (ep !== episodeId.value) return
    penChoice.value = penUnreadable.value ? '' : episodePen.value ?? 'channel'
    presentationError.value = error?.data?.detail || error?.message || `Could not save the pen for ${ep}. Try again.`
    showError(presentationError.value)
  } finally { if (ep === episodeId.value) penSaving.value = false }
}
// Deliberate: moves the channel default, so episodes without a pen of their own re-render under it.
async function setChannelPenDefault() {
  const ep = episodeId.value
  const pen = episodePen.value
  if (!pen) return
  if (!await ask({
    title: 'Make this the channel default pen?',
    message: `Episodes without their own pen will use ${penLabel(pen)}; their existing Sketch Draw clips will need re-generating. ${ep} and episodes with their own pen are not affected.`,
    confirmLabel: 'Make channel default',
  })) return
  presentationSaving.value = true
  presentationError.value = ''
  try {
    await put(`/projects/${slug.value}/motion-presentation`, { renderer: clipRenderer.value, pen })
    channelPen.value = pen
    success(`Channel default pen is now ${penLabel(pen)}. Episodes without their own pen follow it, and their Sketch Draw clips need re-generating.`)
    if (ep === episodeId.value) await loadReview()
  } catch (error: any) {
    presentationError.value = error?.data?.detail || error?.message || 'Could not save the channel default pen. Try again.'
    showError(presentationError.value)
  } finally { presentationSaving.value = false }
}
/**
 * The operator's own choice for each published switch, by published name.
 *
 * Only a switch the SELECTED model publishes is ever rendered, so a value here
 * for a model that publishes none is ignored rather than sent. An untouched
 * switch has no entry at all, which is what keeps "the model's own default"
 * and "the operator asked for this" two different requests all the way down to
 * the idempotency key.
 */
const switchChoices = ref<Record<string, boolean>>({})
const selectedAspectRatio = ref('')
const selectedResolution = ref('')
const durationMode = ref<DurationMode>('manual')
const manualDurationSeconds = ref<number | null>(null)
const manualDurationDraft = ref('')
const {
  videoModels: genStudioVideoModels,
  loaded: mediaModelsLoaded,
  error: mediaModelsError,
  refresh: refreshGenStudioMediaModels,
} = useGenStudioMediaModels()
const cacheBuster = ref(Date.now())
const motionPresets = usePresets({
  slug: slug.value,
  configKey: 'motion_review',
  presetType: 'motion-review',
  // Applying a preset moves THIS episode's reveal, so it is never applied by arriving on the page:
  // that is the 2026-08-03 shape (a stored look silently replacing the one the owner chose). The
  // preset is applied only when the owner clicks Apply.
  autoApplyOnLoad: false,
  // `overrides` holds this episode's per-scene pins, keyed by scene id: a preset must not carry
  // them onto another episode (AGENTS.md §4/§5). The style and mix DO travel — they are the look.
  excludeKeys: [...DEFAULT_EXCLUDE_KEYS, 'overrides'],
  snapshot: () => ({
    model: videoModel.value,
    aspect_ratio: selectedAspectRatio.value || undefined,
    operation: STORY_STUDIO_VIDEO_OPERATION,
    duration_seconds: manualDurationSeconds.value ?? undefined,
    resolution: selectedResolution.value || undefined,
    duration_mode: durationMode.value,
    // A reusable setting, so it belongs in the preset (AGENTS.md §5). It is stored by
    // published name, and the pipeline resolves it against the model that will run: a
    // preset applied to a model without that switch simply carries nothing.
    ...(Object.keys(switchChoices.value).length ? { switches: { ...switchChoices.value } } : {}),
    // The reveal look (style + mix) travels; `revealForPreset` drops the pins explicitly.
    ...(revealForPreset(episodeReveal.value) ? { reveal: revealForPreset(episodeReveal.value) } : {}),
    // The ink weight is a reusable look, so it belongs in the preset (AGENTS.md §5). Absent means
    // normal, the engine's own weight, so a preset with no weight leaves the live one alone.
    ...(episodeLineWeight.value ? { line_weight: episodeLineWeight.value } : {}),
  }),
  apply: (data: any) => {
    // A model the live catalogue does not have is never restored: the picker
    // drops it below and says the one sentence it can honestly say.
    if (typeof data?.model === 'string') {
      videoModel.value = data.model
      selectLiveVideoModel()
    }
    // Restored whole rather than merged: a preset that stored no switches must not inherit the
    // previous one's choices, and a key is only kept when it is a real boolean — a stored string
    // is a corrupt preset, not a value to coerce.
    switchChoices.value = Object.fromEntries(
      Object.entries((data?.switches || {}) as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'boolean'),
    ) as Record<string, boolean>
    if (typeof data?.aspect_ratio === 'string') selectedAspectRatio.value = data.aspect_ratio.trim()
    normalizeSelectedAspectRatio()
    selectedResolution.value = typeof data?.resolution === 'string' ? data.resolution.trim() : ''
    manualDurationSeconds.value = Number.isFinite(Number(data?.duration_seconds)) ? Number(data.duration_seconds) : null
    manualDurationDraft.value = manualDurationSeconds.value === null ? '' : String(manualDurationSeconds.value)
    durationMode.value = data?.duration_mode === 'follow_narration' ? 'follow_narration' : 'manual'
    // The reveal look is applied to THIS episode: its own pins are carried across the apply
    // explicitly, because `excludeKeys` strips them from `data` on the way in as well as out.
    // Only once this episode's own reveal is known, so an apply never races its load and blanks it.
    if (revealLoaded.value) {
      const nextReveal = applyRevealPreset(data?.reveal, episodeReveal.value)
      if (JSON.stringify(nextReveal) !== JSON.stringify(episodeReveal.value)) void saveReveal(nextReveal)
    }
    // The ink weight is applied to THIS episode, and only once this episode's own weight is known,
    // so an apply never races its load. A preset that stored no weight leaves the live one alone.
    if (lineWeightLoaded.value && typeof data?.line_weight === 'string' && LINE_WEIGHTS.includes(data.line_weight as SketchLineWeight)) {
      const nextWeight = data.line_weight as SketchLineWeight
      if (nextWeight !== episodeLineWeight.value) void saveLineWeight(nextWeight)
    }
  },
})

// Cheapest is only the first default. The selected published pair is what
// the generator submits, and it remains live-derived rather than cached.
const STORY_STUDIO_VIDEO_OPERATION = 'image-to-video'
type VideoVariant = {
  operation: string
  duration_seconds: number
  resolution: string
  /** Published per row by a Studio Hub lane; absent on every cloud lane. */
  aspect_ratio?: string
  credits_per_video: number
  minimum_credits: number
  price_version: string
}
function cheapestVariant(variants: readonly VideoVariant[]) {
  if (!variants.length) return null
  return [...variants].sort((a, b) => (
    a.credits_per_video - b.credits_per_video
    || a.minimum_credits - b.minimum_credits
    || a.duration_seconds - b.duration_seconds
    || a.resolution.localeCompare(b.resolution)
  ))[0]!
}

/**
 * What the customer is told when the selected model bills for a soundtrack
 * Story Studio's assembly will not use.
 *
 * This is DISCLOSURE, not a toggle. Video assembly builds one episode-wide
 * audio timeline (narration + optional music + optional ambience) and every
 * clip enters it as picture only; clips are looped, trimmed, cross-faded,
 * chunked and stream-copy concatenated, so there is no per-clip audio lane a
 * generated track could honestly be placed in. Offering a "keep the generated
 * audio" switch would be a switch that does nothing on the assembly path,
 * which is worse than saying so plainly.
 *
 * **A lane can also publish the opposite choice** — writing the clip with no
 * track at all — and that IS offered, because it is a real thing the lane does
 * (a local Studio Hub lane can publish `audio`, default on). Two sentences, because
 * the two situations are not the same: a lane that generates sound and offers no
 * switch is money spent on a track the episode discards, while a lane whose
 * switch is off still costs the same — the picture and the sound are denoised
 * together — and simply writes a silent file.
 */
const GENERATED_AUDIO_DISCLOSURE =
  'This model also generates its own audio track, and you are charged for it. '
  + 'Story Studio composes your narration mix over the picture, so the generated audio is not in the '
  + 'assembled episode — it is kept only in the downloaded clip file. Choose a picture-only model if '
  + 'you do not want to pay for a soundtrack the episode will not use.'

/** Said instead, once the published switch is OFF: the honest version of the same fact. */
const SILENT_CLIP_NOTICE =
  'Sound is off for this model, so its clips are written without an audio track. '
  + 'The clip is not cheaper and not faster — this model denoises picture and sound together — it is '
  + 'simply silent, and the episode uses your narration either way.'

const i2vModels = computed(() => {
  const discovered = genStudioVideoModels.value
    // Story Studio submits image-to-video only. The catalogue carries every
    // published mode; the restriction is applied here, at the picker.
    .filter(model => model.modes.includes(STORY_STUDIO_VIDEO_OPERATION))
    .map((model) => {
      const variants = variantsForVideoOperation(model.variants, STORY_STUDIO_VIDEO_OPERATION)
      const variant = cheapestVariant(variants)
      const rate = describeVideoModelRate({ ...model, variants })
      // An enforced limit has to be visible at the point of choosing.
      const noVariant = 'No published length or resolution'
      // Only a published `true` is disclosed. `false` and `null` (GenStudio
      // said nothing) both say nothing here — a silent model needs no warning,
      // and an unpublished field is not evidence of one either way.
      const generatesAudio = model.generates_audio === true
      // The same publication rule the switch itself uses: only a model that publishes the
      // control can have its sound turned off, so only those rows say so.
      const publishesAudioSwitch = Array.isArray(model.controls)
        && model.controls.some(control => control?.name === 'audio' && control?.type === 'boolean')
      return {
        id: `genstudio-video:${model.id}`,
        label: model.display_name,
        // Named once, by the group heading. `VideoModelResponse` publishes no
        // provider, so no `provider` is set and none is guessed from the id.
        group: 'Gateway',
        price: rate.text,
        priceTitle: rate.title,
        meta: variant
          ? `${variant.duration_seconds}s at ${variant.resolution}${hasPriceTruth(model) ? '' : ` — ${variant.credits_per_video} credits`}`
          : noVariant,
        description: (variant
          ? `The cheapest published option is selected first (${variant.duration_seconds}s at ${variant.resolution}). `
            + 'Choose a resolution, then use one published length or match each scene to its narration.'
          : 'The Gateway publishes no priced length or resolution for this model, so Story Studio '
            + 'cannot generate a clip with it.')
          + (generatesAudio ? ` ${GENERATED_AUDIO_DISCLOSURE}` : '')
          + (publishesAudioSwitch
            ? ' You can write its clips without sound below; the price is the same, because it makes'
              + ' picture and sound in one pass.'
            : ''),
        disabled: !model.available || model.locked === true || !variant,
        disabledReason: genStudioModelLockReason(model) || (!model.available
          ? 'This video model is not currently available.'
          : !variant
            ? 'The Gateway publishes no priced length or resolution for this model.'
            : undefined),
        badges: generatesAudio ? [{ label: 'Generates audio', tone: 'warning' as const }] : [],
              }
    })
  return discovered
})

/** The selected model's audio disclosure, or empty when there is nothing to
 *  disclose. Re-derived from the live catalogue on every model change. */
const selectedVideoModelAudioNotice = computed(() => {
  if (selectedVideoModel.value?.generates_audio !== true) return ''
  // The switch, when the lane publishes one, decides which of the two true sentences applies.
  const audioSwitch = selectedVideoControls.value.find(control => control.name === 'audio')
  if (audioSwitch && !switchValue(audioSwitch)) return SILENT_CLIP_NOTICE
  return GENERATED_AUDIO_DISCLOSURE
})
const selectedVideoModel = computed(() => {
  const raw = videoModel.value.startsWith('genstudio-video:')
    ? videoModel.value.slice('genstudio-video:'.length)
    : videoModel.value
  return genStudioVideoModels.value.find(item => item.id === raw) || null
})
// A row with gateway price truth carries zero-valued credit shapes; those are never shown as a cost.
const videoHasUsdPrice = computed(() => hasPriceTruth(selectedVideoModel.value))
const selectedVideoVariants = computed<VideoVariant[]>(() => (
  variantsForVideoOperation(selectedVideoModel.value?.variants, STORY_STUDIO_VIDEO_OPERATION)
))

/**
 * The switches the SELECTED model publishes, in the lane's own order.
 *
 * Nothing is inferred from the model's name or family: a row that publishes no `controls`
 * list renders no control at all, which is why a cloud lane shows none and a local
 * lane shows its own. A malformed entry is dropped rather than repaired — a switch this
 * page cannot describe is one it must not offer.
 */
const selectedVideoControls = computed<GenStudioVideoControl[]>(() => {
  const published = (selectedVideoModel.value as { controls?: unknown } | null)?.controls
  if (!Array.isArray(published)) return []
  return published.flatMap((entry): GenStudioVideoControl[] => {
    const candidate = entry as { name?: unknown, type?: unknown, default?: unknown, note?: unknown }
    const name = typeof candidate?.name === 'string' ? candidate.name.trim() : ''
    if (!name || String(candidate?.type ?? '').trim().toLowerCase() !== 'boolean') return []
    return [{
      name,
      type: 'boolean' as const,
      default: typeof candidate.default === 'boolean' ? candidate.default : null,
      note: typeof candidate.note === 'string' && candidate.note.trim() ? candidate.note.trim() : null,
    }]
  })
})

/** The switch's published name, as a label. The lane's own `note` carries the meaning. */
function switchLabel(name: string): string {
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : name
}

/**
 * What the switch shows: the operator's own choice, else the lane's published default.
 *
 * A lane that published no default shows the off position and the control is disabled — the
 * page cannot display a state nobody stated, and sending one would decide on the lane's behalf.
 */
function switchValue(control: GenStudioVideoControl): boolean {
  const chosen = switchChoices.value[control.name]
  return typeof chosen === 'boolean' ? chosen : control.default === true
}

function setSwitch(control: GenStudioVideoControl, value: boolean): void {
  switchChoices.value = { ...switchChoices.value, [control.name]: value }
}
/**
 * The ratios and resolutions that can actually be submitted, as PAIRS.
 *
 * These were two independent lists — every published ratio beside every published resolution —
 * which offered combinations no row carries: a Studio Hub video lane's `448p` class is 704x448
 * (11:7) or 448x448 (1:1) and its `256p` class is 448x256 (7:4) or 256x448 (4:7), so `11:7` at
 * `256p` is not a canvas the lane has. The lane refuses such a request, and offering it at all
 * was the UI repeating an error the catalogue never made. Where GenStudio states a ratio per
 * row, the rows decide both lists; where it states none (every cloud lane) the old behaviour is
 * unchanged, because there is no pairing to respect.
 */
const variantsStatingAspectRatio = computed(() => selectedVideoVariants.value
  .filter((variant): variant is VideoVariant & { aspect_ratio: string } => (
    typeof variant.aspect_ratio === 'string' && !!variant.aspect_ratio.trim()
  )))
const availableAspectRatios = computed(() => {
  const stated = variantsStatingAspectRatio.value.map(variant => variant.aspect_ratio.trim())
  if (stated.length) return [...new Set(stated)]
  return [...new Set(
    (selectedVideoModel.value?.aspect_ratios || []).filter(ratio => typeof ratio === 'string' && ratio.trim()),
  )]
})
const availableResolutions = computed(() => {
  const stated = variantsStatingAspectRatio.value
  if (stated.length && selectedAspectRatio.value) {
    const forRatio = stated.filter(variant => variant.aspect_ratio.trim() === selectedAspectRatio.value)
    if (forRatio.length) return [...new Set(forRatio.map(variant => variant.resolution))]
  }
  return [...new Set(selectedVideoVariants.value.map(variant => variant.resolution))]
})
const selectedResolutionVariants = computed(() => selectedVideoVariants.value
  .filter(variant => variant.resolution === selectedResolution.value)
  .filter(variant => !variantsStatingAspectRatio.value.length || !selectedAspectRatio.value
    || variant.aspect_ratio?.trim() === selectedAspectRatio.value)
  .sort((a, b) => a.duration_seconds - b.duration_seconds))
const selectedManualVariant = computed(() => selectedResolutionVariants.value
  .find(variant => variant.duration_seconds === manualDurationSeconds.value) || null)
const minimumDuration = computed(() => selectedResolutionVariants.value[0]?.duration_seconds ?? null)
const maximumDuration = computed(() => selectedResolutionVariants.value.at(-1)?.duration_seconds ?? null)
const publishedDurationLabels = computed(() => selectedResolutionVariants.value
  .map(variant => `${variant.duration_seconds}s`).join(', '))
const manualDurationIndex = computed(() => Math.max(0, selectedResolutionVariants.value
  .findIndex(variant => variant.duration_seconds === manualDurationSeconds.value)))

function setManualDuration(duration: number | null): void {
  manualDurationSeconds.value = duration
  manualDurationDraft.value = duration === null ? '' : String(duration)
}

function snappedVariant(requested: number): VideoVariant | null {
  if (!selectedResolutionVariants.value.length || !Number.isFinite(requested)) return null
  return selectedResolutionVariants.value.find(variant => variant.duration_seconds >= requested)
    || selectedResolutionVariants.value.at(-1)!
}

function syncPublishedSelection(variants: readonly VideoVariant[]): void {
  normalizeSelectedAspectRatio()
  if (!variants.length) {
    selectedResolution.value = ''
    setManualDuration(null)
    return
  }
  if (!variants.some(variant => variant.resolution === selectedResolution.value)) {
    selectedResolution.value = cheapestVariant(variants)!.resolution
  }
  const current = Number(manualDurationSeconds.value)
  const next = selectedResolutionVariants.value.find(variant => variant.duration_seconds === current)
    || (Number.isFinite(current) ? snappedVariant(current) : null)
    || cheapestVariant(selectedResolutionVariants.value)
  setManualDuration(next?.duration_seconds ?? null)
}

function normalizeSelectedAspectRatio(): void {
  if (availableAspectRatios.value.includes(selectedAspectRatio.value)) return
  // Where the rows state their own ratio, blank is not an option: the page has already shown which
  // canvases exist, and a request with no ratio lets the lane decide instead of the operator.
  // Default to the cheapest row's ratio, the way the resolution picker defaults to its cheapest
  // row. A product that states only a ratio LIST keeps the old behaviour, where an unpublished
  // saved ratio is cleared rather than replaced by one the operator did not choose.
  if (!variantsStatingAspectRatio.value.length) {
    selectedAspectRatio.value = ''
    return
  }
  const stated = cheapestVariant(selectedVideoVariants.value)?.aspect_ratio
  selectedAspectRatio.value = typeof stated === 'string' && availableAspectRatios.value.includes(stated.trim())
    ? stated.trim()
    : (availableAspectRatios.value[0] ?? '')
}

watch(selectedAspectRatio, () => {
  // A ratio change can move the resolution off the pairs: snap onto a row the new ratio carries.
  const resolutions = availableResolutions.value
  if (resolutions.length && !resolutions.includes(selectedResolution.value)) {
    selectedResolution.value = resolutions[0]
  }
  const durations = selectedResolutionVariants.value
  if (durations.length && !durations.some(variant => variant.duration_seconds === manualDurationSeconds.value)) {
    setManualDuration(cheapestVariant(durations)?.duration_seconds ?? null)
  }
})

watch(selectedVideoVariants, (variants) => {
  syncPublishedSelection(variants)
}, { immediate: true })
watch(availableAspectRatios, normalizeSelectedAspectRatio, { immediate: true })
/** Said when a saved selection names nothing the live catalogue publishes. */
const VIDEO_MODEL_UNAVAILABLE_MESSAGE = 'This model is no longer available — choose another.'
const videoModelNotice = ref('')
function selectLiveVideoModel(): void {
  const raw = videoModel.value.startsWith('genstudio-video:') ? videoModel.value.slice('genstudio-video:'.length) : videoModel.value
  if (!i2vModels.value.length) {
    // A read that finished with nothing offered does not have the saved model
    // either. One that has not finished yet is not evidence of anything, so the
    // value waits rather than being dropped on a slow network.
    if (mediaModelsLoaded.value && videoModel.value) {
      videoModel.value = ''
      videoModelNotice.value = VIDEO_MODEL_UNAVAILABLE_MESSAGE
    }
    return
  }
  const selected = selectLiveImageToVideoModel(raw, genStudioVideoModels.value)
  if (selected) {
    videoModel.value = `genstudio-video:${selected.id}`
    videoModelNotice.value = ''
    return
  }
  // Gone from the catalogue entirely: unselect it rather than leave a dead id
  // in the form to fail after the customer has queued paid work.
  if (!genStudioVideoModels.value.some(model => model.id === raw)) {
    videoModel.value = ''
    videoModelNotice.value = VIDEO_MODEL_UNAVAILABLE_MESSAGE
  }
}
watch([i2vModels, mediaModelsLoaded], selectLiveVideoModel, { immediate: true })

/**
 * Last of all, the app-wide default video model (Settings → Default models).
 *
 * A model this episode saved, or the page's remembered choice, always wins — this fills only an empty
 * field. Read only: it is never written into the episode or a preset. A default that has left the
 * catalogue fills nothing and says so.
 */
const appDefaults = ref(emptyDefaultModels())
const appDefaultVideo = computed(() => resolveEffectiveModel(
  'video',
  videoModel.value.replace(/^genstudio-video:/, ''),
  i2vModels.value.map(option => option.id.replace(/^genstudio-video:/, '')),
  appDefaults.value,
))
const appDefaultVideoGone = computed(() => appDefaultVideo.value.goneNotice)
function fillAppDefaultVideoModel(): void {
  if (videoModel.value || isSketchDraw.value || !i2vModels.value.length) return
  const fallback = appDefaultVideo.value.model
  if (!fallback) return
  const option = i2vModels.value.find(entry => entry.id === `genstudio-video:${fallback}`)
  if (!option || option.disabled) return
  videoModel.value = option.id
}
watch(i2vModels, fillAppDefaultVideoModel, { immediate: true })

function chooseResolution(event: Event): void {
  const requested = manualDurationSeconds.value
  selectedResolution.value = (event.target as HTMLSelectElement).value
  const selected = requested === null ? null : snappedVariant(requested)
  setManualDuration(selected?.duration_seconds ?? cheapestVariant(selectedResolutionVariants.value)?.duration_seconds ?? null)
}

function chooseManualSliderValue(event: Event): void {
  const index = Number((event.target as HTMLInputElement).value)
  setManualDuration(selectedResolutionVariants.value[index]?.duration_seconds ?? null)
}

function editManualDuration(event: Event): void {
  manualDurationDraft.value = (event.target as HTMLInputElement).value
}

function commitManualDuration(): void {
  const selected = snappedVariant(Number(manualDurationDraft.value))
  setManualDuration(selected?.duration_seconds ?? manualDurationSeconds.value)
}

function moveManualDuration(event: KeyboardEvent): void {
  const movement = event.key === 'ArrowRight' || event.key === 'ArrowUp'
    ? 1
    : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
      ? -1
      : 0
  if (!movement) return
  event.preventDefault()
  const index = Math.min(
    selectedResolutionVariants.value.length - 1,
    Math.max(0, manualDurationIndex.value + movement),
  )
  setManualDuration(selectedResolutionVariants.value[index]?.duration_seconds ?? null)
}

function formatSeconds(seconds: number): string {
  return `${Math.round(seconds * 10) / 10}s`
}

/** "1.5 min" / "45 s" — an estimate, so it is rounded generously. */
function formatMinutes(minutes: number): string {
  if (minutes < 1) return `${Math.max(5, Math.round(minutes * 60 / 5) * 5)} s`
  return `${Math.round(minutes * 10) / 10} min`
}

const formatUsdAmount = formatUsd

function durationPlanForScene(scene: MotionScene): DurationPlan | null {
  if (isSketchDraw.value) return null
  const narration = Math.max(0, scene.end_sec - scene.start_sec)
  const variant = durationMode.value === 'follow_narration'
    ? snappedVariant(narration)
    : selectedManualVariant.value
  if (!variant) return null
  const difference = Math.round((variant.duration_seconds - narration) * 10) / 10
  if (difference > 0) return {
    narration_seconds: narration,
    requested_seconds: variant.duration_seconds,
    adjustment: 'trim',
    adjustment_label: `Trim ${formatSeconds(difference)}`,
    variant,
  }
  if (difference < 0) {
    const shortfall = formatSeconds(Math.abs(difference))
    return {
      narration_seconds: narration,
      requested_seconds: variant.duration_seconds,
      adjustment: durationMode.value === 'follow_narration' ? 'hold' : 'loop',
      adjustment_label: durationMode.value === 'follow_narration'
        ? `Hold final frame ${shortfall}`
        : `Loop clip for ${shortfall}`,
      variant,
    }
  }
  return {
    narration_seconds: narration,
    requested_seconds: variant.duration_seconds,
    adjustment: 'exact',
    adjustment_label: 'No adjustment',
    variant,
  }
}

function sceneTooShort(scene: MotionScene): boolean {
  return scene.end_sec - scene.start_sec < animateMinSeconds.value
}
function batchEligible(scene: MotionScene): boolean {
  return motionBatchEligible(scene, {
    isSketchDraw: isSketchDraw.value,
    scoped: scopedMotionSceneIds.value.has(scene.id),
    animateMinSeconds: animateMinSeconds.value,
    imagePool: usesImagePool.value,
  })
}
const eligibleClipCount = computed(() => scenes.value.filter(batchEligible).length)
const batchPlans = computed(() => scenes.value.filter(batchEligible)
  .map(durationPlanForScene)
  .filter((plan): plan is DurationPlan => plan !== null))
const batchListedTotal = computed(() => batchPlans.value
  .reduce((total, plan) => total + plan.variant.credits_per_video, 0))
const existingClipCount = computed(() => scenes.value.filter(scene => scene.clip_exists).length)

// ── Clip-length misfits ───────────────────────────────────────────────────────
// A planned model publishes its own min/max clip length. A scene outside that range cannot be
// made in one request, so it is flagged here (the owner, 2026-10-27) with both fixes offered.
const clipMisfits = computed(() => {
  const min = minimumDuration.value
  const max = maximumDuration.value
  if (min === null || max === null) return []
  return scopedMotionScenes.value
    .filter(scene => {
      const lane = scene.visual_lane || (scene.motion_choice === 'clip' ? 'image_to_video' : 'still')
      return lane !== 'still' && lane !== 'imported'
    })
    .map(scene => ({ scene, seconds: scene.end_sec - scene.start_sec }))
    .filter(({ seconds }) => seconds < min || seconds > max)
    .map(({ scene, seconds }) => ({
      scene,
      seconds,
      kind: seconds < min ? ('under' as const) : ('over' as const),
    }))
})
const clipMisfitLabel = computed(() => {
  if (!clipMisfits.value.length) return ''
  const under = clipMisfits.value.filter(m => m.kind === 'under').length
  const over = clipMisfits.value.length - under
  const parts: string[] = []
  if (under) parts.push(`${under} shorter than ${minimumDuration.value}s`)
  if (over) parts.push(`${over} longer than ${maximumDuration.value}s`)
  return `${clipMisfits.value.length} video ${clipMisfits.value.length === 1 ? 'scene is' : 'scenes are'} outside the planned model's clip length (${parts.join(', ')}).`
})
const fillingMisfits = ref(false)
async function fillFlaggedScenes(fillMode: 'chain' | 'hold') {
  const ep = episodeId.value
  if (!ep || !clipMisfits.value.length) return
  fillingMisfits.value = true
  try {
    await post(`/projects/${slug.value}/scene-plan/${ep}/fill-flagged-scenes`, {
      fill_mode: fillMode,
      scene_ids: clipMisfits.value.map(m => m.scene.id),
    })
    success(fillMode === 'chain'
      ? `Chaining clips for ${clipMisfits.value.length} flagged scene(s).`
      : `Holding the last frame for ${clipMisfits.value.length} flagged scene(s).`)
    await loadReview()
  } catch (error: any) {
    showError(error?.data?.detail || error?.message || 'Could not fill the flagged scenes')
  } finally {
    fillingMisfits.value = false
  }
}

// ── Estimates shown before anything is spent ─────────────────────────────────
// Paid: published price per second × chosen duration. Sketch Draw: measured frames/s on this Mac.
// Fleet Macs: free. Every number is labelled an estimate, because none is a receipt.
const batchDurationSeconds = computed(() => batchPlans.value
  .reduce((total, plan) => total + plan.requested_seconds, 0))
const videoPricePerSecond = computed(() => {
  // Only a published per-second USD is a price. Credits are not dollars, and a lane with no
  // published unit gets no estimate rather than a made-up one.
  const usd = (selectedVideoModel.value as { price_usd?: Record<string, number> } | null)?.price_usd
  const perSecond = Number(usd?.per_second)
  return Number.isFinite(perSecond) && perSecond > 0 ? perSecond : null
})
const batchEstimatedUsd = computed(() => {
  const perSecond = videoPricePerSecond.value
  if (perSecond === null) return null
  return perSecond * batchDurationSeconds.value
})
const batchEstimatedMinutes = computed(() => {
  if (isSketchDraw.value) {
    // ~8 frames/s measured for the Metal helper on Apple Silicon; a scene is fps × seconds.
    const fps = 24
    return (batchDurationSeconds.value * fps) / 8 / 60
  }
  // Cloud lanes: a per-clip queue + render window. 1.5 minutes per clip is the observed middle.
  return batchPlans.value.length * 1.5
})
const shareSummary = computed(() => {
  if (motionScope.value.mode !== 'share') return ''
  const total = scenes.value.reduce((sum, s) => sum + (s.end_sec - s.start_sec), 0)
  const target = total * (motionScope.value.share_percent / 100)
  return `≈ ${formatSeconds(target)} of ${formatSeconds(total)} becomes video; the rest stays still.`
})

const usesImagePool = computed(() => visualSource.value === 'image_pool')
const scopedMotionSceneIds = computed(() => new Set(motionSceneIds.value))
const motionScopeLabel = computed(() => {
  if (motionScope.value.mode === 'opening') return `Opening · first ${formatSeconds(motionScope.value.end_sec)}`
  if (motionScope.value.mode === 'selected') return 'Selected scenes'
  if (motionScope.value.mode === 'all') return 'Whole episode'
  if (motionScope.value.mode === 'share') return `Video share · ${motionScope.value.share_percent}% of running time`
  return 'Off'
})
const motionCrossingLabel = computed(() => {
  const scenesAtBoundary = scenes.value.filter(scene => motionCrossingSceneIds.value.includes(scene.id))
  if (scenesAtBoundary.length === 1) return `Scene ${scenesAtBoundary[0]!.scene_index}`
  return `${scenesAtBoundary.length} scenes`
})
const scopedMotionScenes = computed(() => scenes.value.filter(scene => scopedMotionSceneIds.value.has(scene.id)))
/** Scenes planned as text-to-video: motion work regardless of the share (owner, 2026-10-26/27). */
const textToVideoCount = computed(() => scenes.value.filter(scene => sceneLane(scene) === 'text_to_video').length)
const scopedClipCount = computed(() => scopedMotionScenes.value.filter(scene => scene.clip_exists).length)
const scopedMotionReviewed = computed(() => scopedMotionScenes.value.filter(scene => (
  scene.motion_choice === 'still'
  || (scene.clip_exists && !scene.clip_stale && (scene.motion_choice === 'clip' || scene.motion_choice == null))
)).length)
const allScopedMotionReviewed = computed(() => motionSceneIds.value.length > 0
  && scopedMotionReviewed.value === motionSceneIds.value.length)
const scenePlanMotionLink = computed(() => `/projects/${slug.value}/scene-plan?episode_id=${encodeURIComponent(episodeId.value)}#visual-timing`)

const clipJobsActive = computed(() => isJobActiveFor(episodeId.value, ['scene_clip_generate', 'scene_clips_batch']))
const selectionReady = computed(() => isSketchDraw.value
  ? sketchSelectionReady({ loaded: presentationLoaded.value && penLoaded.value && !penUnreadable.value && holdLoaded.value && !holdUnreadable.value && !holdPending.value
      && revealLoaded.value && !revealUnreadable.value && !revealPending.value,
      saving: presentationSaving.value || penSaving.value || holdSaving.value || revealSaving.value,
      pen: sketchPen.value, hasLogo: channelHasLogo.value })
  : !!selectedResolution.value
  && availableAspectRatios.value.includes(selectedAspectRatio.value)
  && !!selectedResolutionVariants.value.length
  && (durationMode.value === 'follow_narration' || !!selectedManualVariant.value)
  && !i2vModels.value.find(model => model.id === videoModel.value)?.disabled)
const canGenerate = computed(() => !usesImagePool.value && !!episodeId.value && (isSketchDraw.value || !!videoModel.value)
  && selectionReady.value && (isSketchDraw.value ? eligibleClipCount.value > 0 : batchPlans.value.length > 0))
const generateStatus = computed(() => {
  if (!episodeId.value) return 'Pick an episode first'
  if (usesImagePool.value) return 'Motion Review is not used for Image Pool episodes'
  if (isSketchDraw.value) {
    if (!presentationLoaded.value || !penLoaded.value) return presentationError.value || 'Loading Sketch Draw settings'
    if (!holdLoaded.value) return presentationError.value || 'Loading Sketch Draw settings'
    if (holdUnreadable.value) return 'Choose a closing hold'
    if (holdPending.value) return 'Apply the closing hold, or pick another option'
    if (!revealLoaded.value) return presentationError.value || 'Loading Sketch Draw settings'
    if (revealUnreadable.value) return 'Choose a reveal style'
    if (revealPending.value) return 'Apply the reveal mix, or pick another option'
    if (!selectionReady.value) return 'Choose an available pen'
    return eligibleClipCount.value ? `${eligibleClipCount.value} missing or stale clips ready for Sketch Draw on this Mac` : 'No approved missing or stale clips are waiting for Sketch Draw'
  }
  if (!i2vModels.value.length) return 'No image-to-video model is available right now. Scenes stay still.'
  if (!videoModel.value) return 'Pick an image-to-video model'
  if (!availableAspectRatios.value.includes(selectedAspectRatio.value)) return 'Choose an aspect ratio'
  if (!selectedResolutionVariants.value.length) return 'Choose a resolution'
  if (!canGenerate.value) return 'No approved missing clips are waiting for motion'
  return `${batchPlans.value.length} approved missing ${batchPlans.value.length === 1 ? 'clip is' : 'clips are'} ready`
})

function imageUrl(scene: MotionScene) {
  return `/api/projects/${slug.value}/scene-review/${episodeId.value}/image/${scene.id}?t=${cacheBuster.value}&thumb=1`
}
function clipUrl(scene: MotionScene) {
  return `/api/projects/${slug.value}/scene-review/${episodeId.value}/clip/${scene.id}?t=${cacheBuster.value}`
}
// The owner's mix control: a share of RUNNING TIME, or an explicit scope. Sketch Draw and the AI
// lanes read the same saved value, so both surfaces show one answer.
const SCOPE_CHOICES = [
  { mode: 'off', label: 'Off' },
  { mode: 'share', label: 'Video share' },
  { mode: 'opening', label: 'Opening' },
  { mode: 'all', label: 'All scenes' },
] as const
const SHARE_FORMULAS = [
  { value: 'opening_hook', label: 'Opening hook' },
  { value: 'key_moments', label: 'Key moments' },
  { value: 'spread', label: 'Spread evenly' },
  { value: 'chronological', label: 'Chronological' },
] as const
const scopeSaving = ref(false)
const openingSeconds = ref(60)
// The share control's STARTING value (owner, 2026-10-26; confirmed 2026-10-27): 25% /
// opening hook for every channel, new or existing. It is a default of the CONTROL, read
// here at use time — never stored on the channel or the episode. An episode that saved no
// scope of its own is Off, so nothing is in its motion scope until Share is turned on.
const sharePercent = ref(DEFAULT_MOTION_SCOPE.share_percent)
const shareFormula = ref<MotionShareFormula>(DEFAULT_MOTION_SCOPE.formula || 'opening_hook')
watch(motionScope, (scope) => {
  if (scope.mode === 'opening') openingSeconds.value = scope.end_sec
  if (scope.mode === 'share') {
    sharePercent.value = scope.share_percent
    shareFormula.value = scope.formula || 'opening_hook'
  }
}, { immediate: true })
async function saveMotionScope(mode: 'off' | 'opening' | 'all' | 'share') {
  const ep = episodeId.value
  if (!ep) return
  const seconds = Number(openingSeconds.value)
  if (mode === 'opening' && !(Number.isFinite(seconds) && seconds > 0)) { showError('Enter the opening length in seconds, more than 0.'); return }
  const percent = Math.round(Number(sharePercent.value))
  if (mode === 'share' && !(Number.isFinite(percent) && percent >= 10 && percent <= 100)) {
    showError('The video share must be between 10% and 100% of running time.')
    return
  }
  scopeSaving.value = true
  try {
    const motion_scope = mode === 'opening'
      ? { mode, end_sec: seconds }
      : mode === 'share'
        ? { mode, share_percent: percent, formula: shareFormula.value }
        : { mode }
    await put(`/projects/${slug.value}/scene-review/${encodeURIComponent(ep)}/motion-scope`, { motion_scope })
    if (ep === episodeId.value) await loadReview()
  } catch (error: any) {
    showError(error?.data?.detail || error?.message || 'Could not save the motion scope')
  } finally {
    scopeSaving.value = false
  }
}

/** Live clip work per scene: a single-scene job or a batch that names it. */
const clipWorkByScene = computed(() => {
  const work = new Map<string, string>()
  for (const job of jobs.value as any[]) {
    if (job.episode_id !== episodeId.value || !['queued', 'running', 'paused'].includes(job.status)) continue
    if (job.type !== 'scene_clip_generate' && job.type !== 'scene_clips_batch') continue
    const ids: unknown[] = job.type === 'scene_clip_generate' ? [job.params?.scene_id] : (job.params?.motion_scene_ids || [])
    const pct = typeof job.progress === 'number' && job.progress > 0 && job.progress < 100 ? ` ${Math.round(job.progress)}%` : ''
    const label = job.status === 'running' ? `Making clip…${pct}` : job.status === 'paused' ? 'Clip paused' : 'Clip queued'
    for (const id of ids) if (typeof id === 'string') work.set(id, label)
  }
  return work
})
function clipWork(scene: MotionScene): string { return clipWorkByScene.value.get(scene.id) || '' }
/** Why this scene's Generate Clip is off, in words; '' when it can run. */
function generateBlocked(scene: MotionScene): string {
  if (!scopedMotionSceneIds.value.has(scene.id)) return motionScope.value.mode === 'off'
    ? `motion scope is Off for this episode (${isSketchDraw.value ? 'choose a scope above' : 'set it in Scene Plan → Visual timing & motion'})`
    : `this scene is outside the episode's motion scope (${isSketchDraw.value ? 'choose a scope above' : 'Scene Plan → Visual timing & motion'})`
  if (!scene.image_filename) return 'the scene image is missing'
  if (sceneTooShort(scene)) return `shorter than this channel's ${animateMinSeconds.value}s animation minimum`
  if (isSketchDraw.value ? !scene.approved : !scene.motion_prompt) return isSketchDraw.value ? 'approve the image in Scene Review first' : 'no motion prompt (add one in Scene Plan)'
  if (!selectionReady.value) return generateStatus.value
  return ''
}
function choiceLabel(scene: MotionScene) {
  if (scene.motion_choice === 'clip') return 'Clip approved'
  if (scene.motion_choice === 'still') return 'Still selected'
  if (scene.clip_exists && scene.motion_choice == null) return 'Legacy clip'
  return scene.clip_exists ? 'Needs review' : 'Waiting for clip'
}

// A clip changed when a scene gained/lost/staled one; only then do cached image/video URLs need to
// be refreshed. Polling and decisions leave them alone so playing clips and scroll position survive.
const clipSignature = (list: MotionScene[]) => list.map(scene => `${scene.id}:${scene.clip_exists ? 1 : 0}:${scene.clip_stale ? 1 : 0}`).join('|')

async function loadReview(options: { bustCache?: boolean } = {}) {
  const ep = episodeId.value
  const requestSequence = ++reviewLoadSequence
  if (!ep) {
    resetEpisodeScopedMotionState()
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const result = await get<{
      scenes: MotionScene[]
      stats: MotionStats | null
      animate_min_seconds?: number
      motion_scope?: MotionScope
      motion_scene_ids?: string[]
      motion_crossing_scene_ids?: string[]
      motion_scope_error?: string
      visual_source?: 'scene_plan' | 'image_pool'
    }>(`/projects/${slug.value}/scene-review/${ep}`)
    if (requestSequence !== reviewLoadSequence || episodeId.value !== ep) return
    const nextScenes = result.scenes || []
    const clipsChanged = clipSignature(nextScenes) !== clipSignature(scenes.value)
    scenes.value = nextScenes
    stats.value = result.stats
    animateMinSeconds.value = Math.max(0, Number(result.animate_min_seconds) || 0)
    motionScope.value = result.motion_scope || { mode: 'off' }
    motionSceneIds.value = Array.isArray(result.motion_scene_ids) ? result.motion_scene_ids : []
    motionCrossingSceneIds.value = Array.isArray(result.motion_crossing_scene_ids) ? result.motion_crossing_scene_ids : []
    motionScopeError.value = typeof result.motion_scope_error === 'string' ? result.motion_scope_error : ''
    visualSource.value = result.visual_source === 'image_pool' ? 'image_pool' : 'scene_plan'
    if (options.bustCache || clipsChanged) cacheBuster.value = Date.now()
  } catch (error: any) {
    if (requestSequence !== reviewLoadSequence || episodeId.value !== ep) return
    loadError.value = error?.data?.detail || error?.message || 'Could not load Motion Review'
    showError(loadError.value)
  } finally {
    if (requestSequence === reviewLoadSequence && episodeId.value === ep) loading.value = false
  }
}

function generationPayload(): Record<string, string | number | boolean> | null {
  if (isSketchDraw.value) return selectionReady.value ? { renderer: 'sketch_draw' } : null
  if (!videoModel.value || !selectionReady.value) return null
  // Only a switch this model publishes AND the operator actually chose travels. The `audio`
  // wire field is carried by its published name, which is the lane's own contract — the same
  // rule that lets `duration_seconds` and `resolution` be named here and not invented.
  const chosenAudio = selectedVideoControls.value
    .filter(control => control.name === 'audio')
    .map(control => switchChoices.value[control.name])
    .find(value => typeof value === 'boolean')
  return {
    model: videoModel.value,
    aspect_ratio: selectedAspectRatio.value,
    operation: STORY_STUDIO_VIDEO_OPERATION,
    duration_mode: durationMode.value,
    resolution: selectedResolution.value,
    ...(durationMode.value === 'manual' && selectedManualVariant.value
      ? { duration_seconds: selectedManualVariant.value.duration_seconds }
      : {}),
    ...(typeof chosenAudio === 'boolean' ? { audio: chosenAudio } : {}),
  }
}

async function generateOne(scene: MotionScene) {
  if (usesImagePool.value || !scopedMotionSceneIds.value.has(scene.id)) return
  const payload = generationPayload()
  if (!payload) return
  const ep = episodeId.value
  if (scene.clip_exists && !await ask({
    title: `Re-generate the clip for scene ${scene.scene_index}?`,
    message: isSketchDraw.value ? 'This replaces the current clip with a local Sketch Draw clip. No credits are charged.' : 'This replaces the current clip, and re-generating is charged again.',
    confirmLabel: 'Re-Generate Clip',
    danger: true,
  })) return
  if (ep !== episodeId.value) return
  animatingId.value = scene.id
  try {
    await post(`/projects/${slug.value}/scene-review/${ep}/generate-clip`, {
      scene_id: scene.id,
      ...payload,
    })
    success(`Scene ${scene.scene_index} clip queued.`)
  } catch (error: any) {
    showError(error?.data?.detail || error?.message || 'Could not queue the clip')
  } finally {
    if (ep === episodeId.value) animatingId.value = null
  }
}

async function generateMissing() {
  const payload = generationPayload()
  const count = isSketchDraw.value ? eligibleClipCount.value : batchPlans.value.length
  if (!payload || !count) return
  const ep = episodeId.value
  if (!isSketchDraw.value && !await ask({
    title: `Generate ${count} ${count === 1 ? 'clip' : 'clips'}?`,
    message: `This starts ${count} paid ${count === 1 ? 'clip' : 'clips'}.`
      + (videoHasUsdPrice.value ? '' : ` Estimated total: ${formatCredits(batchListedTotal.value)}.`)
      + ' The price is confirmed when each clip starts.',
    confirmLabel: 'Generate Clips',
  })) return
  if (ep !== episodeId.value) return
  queuing.value = true
  try {
    const result = await post<{ queued: number; skipped: number; skipped_reasons?: Array<{ scene_id: string; reason: string }> }>(`/projects/${slug.value}/scene-review/${ep}/generate-missing-clips`, {
      ...payload,
    })
    const queued = result.queued || 0
    const reasons = (result.skipped_reasons || []).map(row => `${row.scene_id}: ${row.reason}`)
    if (queued) success(`${queued} ${queued === 1 ? 'clip' : 'clips'} queued.`)
    if (reasons.length) info(`Not queued — ${reasons.slice(0, 6).join('; ')}${reasons.length > 6 ? `; +${reasons.length - 6} more` : ''}.`)
    else if (!queued) info('Nothing new to queue. Every eligible scene already has a fresh, selected clip.')
  } catch (error: any) {
    showError(error?.data?.detail || error?.message || 'Could not queue motion clips')
  } finally {
    if (ep === episodeId.value) queuing.value = false
  }
}

async function uploadClipOne(scene: MotionScene) {
  if (scene.clip_exists && !await ask({
    title: `Replace the clip for scene ${scene.scene_index}?`,
    message: 'This replaces the current clip with your video file. If the current clip was generated, you would pay again to get it back.',
    confirmLabel: 'Choose video',
    danger: true,
  })) return
  const input = document.createElement('input')
  input.type = 'file'
  // Any container/codec the app can decode. The backend probes the file and converts it on
  // import; the extensions are listed as well because macOS file pickers read those, not the
  // MIME wildcard.
  input.accept = 'video/*,.mp4,.m4v,.mov,.webm,.mkv,.avi,.ts,.m2ts,.mpg,.mpeg,.wmv,.flv,.3gp,.ogv'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    uploadingId.value = scene.id
    try {
      const response = await fetch(
        `/api/projects/${slug.value}/scene-review/${episodeId.value}/upload-clip/${scene.id}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': file.type && file.type.startsWith('video/') ? file.type : 'application/octet-stream',
            'X-File-Name': encodeURIComponent(file.name),
          },
          body: file,
        },
      )
      if (!response.ok) {
        const detail = await response.json().catch(() => ({} as any))
        throw new Error(detail.detail || `Upload failed (${response.status})`)
      }
      await loadReview({ bustCache: true })
      success(`External clip uploaded for scene ${scene.scene_index}. Review it, then choose Use clip.`)
    } catch (error: any) {
      showError(error?.message || 'Could not upload the external clip')
    } finally {
      uploadingId.value = null
    }
  }
  input.click()
}

async function setChoice(scene: MotionScene, choice: 'clip' | 'still') {
  savingId.value = scene.id
  try {
    await put(`/projects/${slug.value}/scene-review/${episodeId.value}/motion-choice`, { scene_id: scene.id, choice })
    scene.motion_choice = choice
    await loadReview()
  } catch (error: any) {
    showError(error?.data?.detail || error?.message || 'Could not save the motion decision')
  } finally {
    savingId.value = null
  }
}

/** The lane a scene renders in. Absent means "derived": a clip is I2V, otherwise a still. */
function sceneLane(scene: MotionScene): VisualLane {
  return scene.visual_lane || (scene.motion_choice === 'clip' ? 'image_to_video' : 'still')
}

const laneSavingId = ref<string | null>(null)
async function setSceneLane(scene: MotionScene, lane: string) {
  const ep = episodeId.value
  if (!ep) return
  const next = lane as VisualLane
  // Apply locally first so the picker reflects the click immediately; the saved value is re-read below.
  scene.visual_lane = next
  if (next !== 'still') scene.motion_choice = 'clip'
  laneSavingId.value = scene.id
  try {
    await post(`/projects/${slug.value}/scene-plan/${ep}/set-visual-lane`, { scene_id: scene.id, visual_lane: next })
    await loadReview()
  } catch (error: any) {
    showError(error?.data?.detail || error?.message || 'Could not save the visual lane')
    await loadReview().catch(() => {})
  } finally {
    if (laneSavingId.value === scene.id) laneSavingId.value = null
  }
}

async function setSceneFillMode(scene: MotionScene, fillMode: string) {
  const ep = episodeId.value
  if (!ep) return
  const next = fillMode === 'chain' ? 'chain' : 'hold'
  scene.fill_mode = next
  laneSavingId.value = scene.id
  try {
    await post(`/projects/${slug.value}/scene-plan/${ep}/set-fill-mode`, { scene_id: scene.id, fill_mode: next })
  } catch (error: any) {
    showError(error?.data?.detail || error?.message || 'Could not save the fill mode')
  } finally {
    if (laneSavingId.value === scene.id) laneSavingId.value = null
  }
}

async function setAll(choice: 'clip' | 'still') {
  savingAll.value = true
  try {
    const result = await put<{ changed?: number }>(`/projects/${slug.value}/scene-review/${episodeId.value}/motion-choice`, { all: true, choice })
    const changed = Number(result?.changed) || 0
    await loadReview()
    if (choice === 'clip') {
      success(changed === scopedClipCount.value
        ? 'All fresh clips approved.'
        : `${changed} fresh clips approved. ${Math.max(0, scopedClipCount.value - changed)} clip(s) were already decided or need re-generating, so they were not approved.`)
    } else success('All scenes will use their still images.')
  } catch (error: any) {
    showError(error?.data?.detail || error?.message || 'Could not save motion decisions')
  } finally {
    savingAll.value = false
  }
}
const approveAllClips = () => setAll('clip')
async function keepAllStills() {
  if (!await ask({
    title: 'Keep every scene as a still?',
    message: 'No scene will use a motion clip. Your clips stay saved, and you can pick Use clip on any scene later.',
    confirmLabel: 'Keep All as Stills',
  })) return
  await setAll('still')
}

const showBackToTop = ref(false)
const SCROLL_THRESHOLD = 560
function getScrollContainer(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return document.querySelector('.main-content') as HTMLElement | null
}
function onScroll(): void {
  const el = getScrollContainer()
  if (el) showBackToTop.value = el.scrollTop > SCROLL_THRESHOLD
}
function scrollToTop(): void {
  getScrollContainer()?.scrollTo({ top: 0, behavior: 'smooth' })
}

let refreshTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void loadRevealCatalog()
  void loadMotionPresentation()
  // The preset list and last-used choice; `autoApplyOnLoad: false` above means this never re-applies
  // a stored look over the one this episode already has.
  void motionPresets.load()
  void refreshGenStudioMediaModels()
  refreshTimer = setInterval(() => {
    if (clipJobsActive.value && !loading.value) void loadReview()
  }, 3000)
  const el = getScrollContainer()
  if (el) {
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
  }
  if (typeof IntersectionObserver !== 'undefined') {
    sceneLoadObserver = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) loadMoreScenes()
    }, { root: el, rootMargin: '500px 0px' })
    if (sceneLoadSentinel.value) sceneLoadObserver.observe(sceneLoadSentinel.value)
  }
})
// The poll only runs while clip jobs are active, so the last job finishing between two polls
// would leave the page showing the old clips. Reload once, with fresh clip URLs, when they stop.
watch(clipJobsActive, (active, wasActive) => {
  if (wasActive && !active) void loadReview({ bustCache: true })
})
watch(sceneLoadSentinel, (next, previous) => {
  if (!sceneLoadObserver) return
  if (previous) sceneLoadObserver.unobserve(previous)
  if (next) sceneLoadObserver.observe(next)
})
onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer)
  getScrollContainer()?.removeEventListener('scroll', onScroll)
  sceneLoadObserver?.disconnect()
  sceneLoadObserver = null
})
/**
 * v1.4.194 — episode-scoped state must not survive an episode change.
 *
 * `loadReview` only ever REPLACED these on a successful load, so switching
 * episodes left the previous episode's scenes, stats, motion scope and checked
 * ids on screen for the whole of the new load — and permanently if the new load
 * failed, with an error banner as the only sign anything was wrong. The image
 * URLs were stale too: `cacheBuster` was bumped only on success, so every
 * `.../image/${scene.id}?t=...` kept resolving to the PREVIOUS episode's cached
 * thumbnails at the previous episode's ids.
 *
 * AGENTS.md §4: an episode change REPLACES the field, or blanks it. This blanks
 * it, and announces nothing because there is nothing yet to announce — the load
 * that follows either fills it or reports its own failure.
 */
function resetEpisodeScopedMotionState() {
  queuing.value = false
  savingAll.value = false
  savingId.value = null
  animatingId.value = null
  uploadingId.value = null
  scenes.value = []
  stats.value = null
  animateMinSeconds.value = 0
  motionScope.value = { mode: 'off' }
  motionSceneIds.value = []
  motionCrossingSceneIds.value = []
  motionScopeError.value = ''
  visualSource.value = 'scene_plan'
  loadError.value = ''
  cacheBuster.value = Date.now()
  // The pen is this episode's own: blank it until the new episode's answer arrives.
  episodePen.value = null
  penChoice.value = 'channel'
  penLoaded.value = false
  penSaving.value = false
  penUnreadable.value = ''
  // Likewise the closing hold.
  episodeHold.value = null
  holdChoice.value = 'channel'
  holdDraft.value = holdDrafts(null)
  holdLoaded.value = false
  holdSaving.value = false
  holdUnreadable.value = ''
  holdError.value = ''
  // Likewise the reveal, whose per-scene pins belong to one episode too.
  episodeReveal.value = null
  revealChoice.value = 'channel'
  revealMixDraft.value = revealMixFor(null)
  revealLoaded.value = false
  revealSaving.value = false
  revealUnreadable.value = ''
  revealError.value = ''
  pinSavingId.value = null
  // Likewise the ink weight, which is this episode's own too.
  episodeLineWeight.value = null
  lineWeightChoice.value = 'channel'
  lineWeightLoaded.value = false
  lineWeightSaving.value = false
  lineWeightUnreadable.value = ''
  lineWeightError.value = ''
}

watch(episodeId, () => {
  renderedSceneLimit.value = SCENE_RENDER_BATCH
  resetEpisodeScopedMotionState()
  void loadReview()
  void loadEpisodePen()
  void loadEpisodeHold()
  void loadEpisodeReveal()
  void loadEpisodeLineWeight()
}, { immediate: true })
</script>

<style scoped>
.motion-workspace {
  --motion-gold: #f0c66a;
  --motion-blue: #73a8df;
  --motion-green: #53c786;
  --motion-ink: #101710;
  padding-bottom: 72px;
}
.motion-hero-route { position: relative; z-index: 1; display: grid; grid-template-columns: 28px auto 22px 28px auto 22px 28px auto; align-items: center; gap: 7px; flex: 0 0 auto; }
.motion-hero-route span { display: grid; width: 28px; height: 28px; place-items: center; border: 1px solid var(--border); border-radius: 50%; color: var(--text-muted); font-size: var(--font-xs); font-weight: 800; }
.motion-hero-route span.is-complete { border-color: var(--motion-green); background: var(--motion-green); color: var(--motion-ink); }
.motion-hero-route span.is-current { border-color: var(--motion-blue); color: var(--motion-blue); box-shadow: 0 0 0 4px rgba(115,168,223,.1); }
.motion-hero-route b { color: var(--text-secondary); font-size: var(--font-xs); font-weight: 600; }
.motion-hero-route i { height: 1px; background: var(--border); }

/* Same fix as Scene Review (DS-12/F-15b): fixed 350px + 420px minimums pushed the Generate
   button and its status off the right edge at 1280px. The tracks may now shrink, and below
   1400px the button gets its own row. */
.motion-command-bar :deep(.top-action-bar) { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr) minmax(0, auto); align-items: end; gap: 16px; margin: 0; padding: 0; border: 0; background: transparent; box-shadow: none; }
.motion-command-bar :deep(.region-spacer) { display: none; }
.motion-command-bar :deep(.generate-region) { justify-content: flex-end; align-items: flex-end; }
.motion-command-bar :deep(.btn-primary-cta) { min-width: 180px; min-height: 38px; border-radius: 9px; white-space: nowrap; }

.motion-guide-grid { display: grid; grid-template-columns: 1.05fr .95fr; gap: 12px; margin-top: var(--space-4); }
.motion-guide-grid :deep(.workspace-notice) { margin-top: 0; }

.motion-control-deck { overflow: hidden; border-radius: 16px; }
.motion-summary, .motion-tools, .scene-line, .motion-actions { display: flex; align-items: center; gap: 12px; }
.motion-scope-summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
.motion-scope-summary h3 { margin: 0 0 4px; font-size: 16px; letter-spacing: -.015em; }
.motion-scope-summary p { margin: 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.45; }
.motion-scope-summary .motion-scope-crossing { margin-top: 5px; color: var(--warning, #d99558); }
.motion-scope-summary .motion-scope-error { margin-top: 5px; color: var(--danger, #d96a6a); }
.motion-summary { justify-content: space-between; padding-bottom: 16px; }
.motion-summary-kicker { color: var(--motion-blue); font-size: var(--font-xs); font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.motion-summary-copy h3 { margin: 5px 0 3px; font-size: 20px; letter-spacing: -.02em; }
.motion-summary-copy p { margin: 0; color: var(--text-muted); font-size: 12px; }
.motion-summary-score { display: grid; min-width: 82px; min-height: 58px; place-content: center; border: 1px solid color-mix(in srgb, var(--motion-blue) 42%, var(--border)); border-radius: 13px; background: color-mix(in srgb, var(--motion-blue) 9%, transparent); text-align: center; }
.motion-summary-score strong { color: var(--motion-blue); font-size: 19px; line-height: 1; }
.motion-summary-score span { margin-top: 4px; color: var(--text-muted); font-size: var(--font-xs); letter-spacing: .08em; text-transform: uppercase; }
.motion-summary-score.ready { border-color: color-mix(in srgb, var(--motion-green) 55%, var(--border)); background: color-mix(in srgb, var(--motion-green) 10%, transparent); }
.motion-summary-score.ready strong { color: var(--motion-green); }
.motion-progress { height: 4px; margin: 0 0 2px; overflow: hidden; border-radius: 999px; background: var(--bg-tertiary); }
.motion-progress span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--motion-blue), var(--motion-green)); }
.motion-tool-row { display: grid; gap: 12px; padding-top: 17px; border-top: 1px solid var(--border); }
.motion-tool-heading { display: flex; flex-direction: column; gap: 3px; }
.motion-tool-heading strong { font-size: 13px; }
.motion-tool-heading span { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.4; }
.motion-renderer-row { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; }
.motion-renderer-row .renderer-field { flex: 0 1 240px; min-width: 0; }
.renderer-help-break { flex: 0 0 100%; height: 0; }
.renderer-help { flex: 1 1 280px; max-width: 70ch; margin: 0; color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.5; }
.renderer-help span { display: block; }
.hold-inputs { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }
.hold-inputs .model-field { min-width: 0; flex: 0 1 104px; }
.motion-tools.sketch-tools { display: flex; flex-wrap: wrap; gap: 8px; }
.motion-tools.sketch-tools > .btn { grid-column: auto; grid-row: auto; }
.motion-tools { display: grid; grid-template-columns: minmax(300px, 1.2fr) minmax(140px, .45fr) minmax(420px, 1.4fr) max-content max-content; align-items: end; justify-content: stretch; }
.model-field { min-width: 280px; }
.model-field > span, .media-label { display: block; margin-bottom: 6px; color: var(--text-muted); font-size: var(--font-xs); font-weight: 750; letter-spacing: .07em; text-transform: uppercase; }
.resolution-field { min-width: 150px; }
.duration-mode { display: flex; min-width: 360px; margin: 0; padding: 0; border: 0; gap: 7px; }
.duration-mode legend, .manual-duration-heading label { margin-bottom: 6px; color: var(--text-muted); font-size: var(--font-xs); font-weight: 750; letter-spacing: .07em; text-transform: uppercase; }
.duration-mode label { display: flex; flex: 1 1 0; align-items: flex-start; gap: 8px; padding: 9px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-tertiary); cursor: pointer; }
.duration-mode label:has(input:checked) { border-color: color-mix(in srgb, var(--motion-blue) 70%, var(--border)); background: color-mix(in srgb, var(--motion-blue) 10%, var(--bg-tertiary)); }
.duration-mode input { margin-top: 2px; accent-color: var(--motion-blue); }
.duration-mode span { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.duration-mode strong { font-size: 12px; }
.duration-mode small { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.35; }
.duration-mode:disabled label { cursor: not-allowed; opacity: .55; }
.clip-working { display: flex; align-items: center; justify-content: center; gap: 10px; }
.clip-spinner { width: 16px; height: 16px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: clip-spin .9s linear infinite; }
@keyframes clip-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .clip-spinner { animation: none; } }
.choice-badge.working { color: var(--accent, #f59e0b); }
.blocked-note { margin-top: 8px; font-size: .85rem; opacity: .8; }
.scope-control { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.scope-off-note { flex-basis: 100%; margin: 4px 0 0; color: var(--text-secondary); }
.scope-opening { display: inline-flex; align-items: center; gap: 6px; font-size: .85rem; }
.scope-num { width: 5.5rem; }
.manual-duration { grid-column: 1 / -1; grid-row: 2; width: min(100%, 760px); }
.manual-duration-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.manual-duration-heading span { color: var(--text-secondary); font-size: var(--font-xs); font-weight: 700; }
.manual-duration-inputs { display: grid; grid-template-columns: minmax(150px, 1fr) 130px; align-items: center; gap: 10px; }
.manual-duration-inputs input[type='range'] { width: 100%; accent-color: var(--motion-blue); cursor: pointer; }
.duration-number-wrap { position: relative; }
.duration-number { width: 100%; padding-right: 53px; font-variant-numeric: tabular-nums; }
.duration-number-wrap > span { position: absolute; top: 50%; right: 10px; color: var(--text-muted); font-size: var(--font-xs); pointer-events: none; transform: translateY(-50%); }
.duration-help, .follow-duration-note span, .batch-cost span { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.4; }
.duration-help { margin: 6px 0 0; }
.follow-duration-note { display: flex; grid-column: 1 / -1; grid-row: 2; max-width: 760px; flex-direction: column; gap: 3px; padding: 9px 11px; border-radius: 10px; background: color-mix(in srgb, var(--motion-blue) 9%, var(--bg-tertiary)); }
.follow-duration-note strong { font-size: 12px; }
.batch-cost { display: flex; grid-column: 1 / 4; grid-row: 3; min-width: 280px; align-items: baseline; justify-content: flex-start; gap: 5px 12px; flex-wrap: wrap; padding-top: 9px; border-top: 1px solid var(--border); text-align: left; }
.batch-cost strong { font-size: 13px; font-variant-numeric: tabular-nums; }
.motion-tools > .btn { grid-row: 3; align-self: center; }
.motion-tools > .btn:first-of-type { grid-column: 4; }
.motion-tools > .btn:last-child { grid-column: 5; }
input:focus-visible, select:focus-visible, .duration-mode label:has(input:focus-visible) { outline: 2px solid var(--motion-blue); outline-offset: 2px; }
/* Prose, not a field label — override the uppercase caption styling above. */
.model-field > span.model-audio-notice,
.model-field > span.model-unavailable-notice {
  margin: 6px 0 0; max-width: 46ch;
  color: var(--warning, #d97706); font-size: var(--font-xs); font-weight: 500;
  letter-spacing: normal; text-transform: none; line-height: 1.45;
}
/* A published switch: the control, its state in words, and the lane's own sentence about what
   it does. The note is not decoration — it is the only honest statement of the trade-off. */
.switch-field { min-width: 200px; }
.switch-row { display: flex; align-items: center; gap: 8px; }
.switch-row input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--motion-blue); }
.switch-row input[type="checkbox"]:disabled { opacity: .5; }
.switch-word { color: var(--text, inherit); font-size: var(--font-sm); font-weight: 600; }
.model-field > span.switch-note {
  margin: 6px 0 0; max-width: 44ch; color: var(--text-muted);
  font-size: var(--font-xs); font-weight: 500; letter-spacing: normal; text-transform: none; line-height: 1.45;
}
.motion-ready { border-color: color-mix(in srgb, var(--motion-green) 65%, var(--border)); }

.motion-grid { display: grid; gap: 14px; padding: 0; list-style: none; }
.motion-list-more { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 14px; color: var(--text-muted); font-size: 12px; }
.motion-card { display: grid; grid-template-columns: minmax(380px, .9fr) minmax(320px, 1.1fr); gap: 18px; padding: 15px; border: 1px solid color-mix(in srgb, var(--motion-gold) 55%, var(--border)); border-radius: 14px; background: var(--bg-secondary); box-shadow: 0 6px 22px rgba(0,0,0,.07); transition: border-color .18s ease, transform .18s ease; content-visibility: auto; contain-intrinsic-size: auto 320px; }
.motion-card:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--motion-blue) 30%, var(--border)); }
.motion-card.choice-clip, .motion-card.choice-legacy { border-color: color-mix(in srgb, var(--motion-green) 55%, var(--border)); }
.motion-card.choice-still { border-color: color-mix(in srgb, var(--motion-blue) 55%, var(--border)); }
.media-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.media-box img, .media-box video, .missing-media { width: 100%; aspect-ratio: 16 / 9; border-radius: 9px; background: #0b0d0c; object-fit: contain; }
.missing-media { display: grid; place-items: center; border: 1px dashed var(--border); color: var(--text-muted); font-size: 12px; }
.motion-copy { min-width: 0; padding: 4px 2px; }
.scene-line { flex-wrap: wrap; }
.scene-line strong { font-size: 15px; }
.scene-line > span { color: var(--text-muted); font-size: 12px; }
.choice-badge { margin-left: auto; padding: 4px 9px; border-radius: 999px; background: var(--bg-tertiary); color: var(--text-primary) !important; font-weight: 650; }
.scene-duration-plan { display: grid; grid-template-columns: repeat(4, minmax(105px, 1fr)); gap: 7px; margin-top: 10px; }
.scene-duration-plan > span { display: flex; min-width: 0; flex-direction: column; gap: 2px; padding: 7px 8px; border-radius: 8px; background: var(--bg-tertiary); }
.scene-duration-plan small { color: var(--text-muted); font-size: var(--font-xs); letter-spacing: .04em; text-transform: uppercase; }
.scene-duration-plan strong { overflow-wrap: anywhere; font-size: var(--font-xs); font-variant-numeric: tabular-nums; }
.scene-duration-plan.has-shortfall > span:nth-child(3) { background: color-mix(in srgb, var(--warning, #d97706) 13%, var(--bg-tertiary)); color: var(--warning, #d99558); }
.transcript { margin: 10px 0; color: var(--text-secondary); line-height: 1.55; }
.motion-prompt { margin: 7px 0; color: var(--text-muted); line-height: 1.5; }
.stale-note { color: #d99558; font-weight: 650; }
.reveal-mix-item { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.85rem; }
.reveal-note { color: #8fa0b5; font-size: 0.85rem; }
/* The per-scene pin: the same model-field label + select as the controls above, sized for a row. */
.scene-reveal { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; margin-top: 10px; }
.scene-reveal .reveal-pin-field { min-width: 220px; flex: 0 1 240px; }
.scene-reveal .reveal-note { margin: 0 0 7px; }
.motion-actions { grid-column: 1 / -1; justify-content: flex-end; flex-wrap: wrap; padding-top: 12px; border-top: 1px solid var(--border); }
.motion-actions .btn { min-height: 33px; border-radius: 8px; }
.load-error-detail { font-size: var(--font-xs); opacity: .75; }
.empty-state { padding: 42px; border-radius: 15px; text-align: center; color: var(--text-muted); }

.back-to-top { position: fixed; right: 28px; bottom: 28px; z-index: 120; display: inline-flex; align-items: center; gap: 8px; min-height: 42px; padding: 0 16px 0 11px; border: 1px solid rgba(115,168,223,.5); border-radius: 999px; background: #20282d; color: #f5f8ff; font-size: 12px; font-weight: 750; cursor: pointer; box-shadow: 0 12px 34px rgba(0,0,0,.38); transition: transform .18s ease, border-color .18s ease, background .18s ease; }
.back-to-top span { display: grid; width: 24px; height: 24px; place-items: center; border-radius: 50%; background: var(--motion-blue); color: #101722; font-size: 15px; }
.back-to-top:hover { transform: translateY(-3px); border-color: var(--motion-blue); background: #29333a; }
.motion-float-enter-active, .motion-float-leave-active { transition: opacity .18s ease, transform .18s ease; }
.motion-float-enter-from, .motion-float-leave-to { opacity: 0; transform: translateY(10px); }

@media (max-width: 1400px) {
  .motion-command-bar :deep(.top-action-bar) { grid-template-columns: minmax(0, .85fr) minmax(0, 1.4fr); }
  .motion-command-bar :deep(.generate-region) { grid-column: 1 / -1; }
}

@media (max-width: 1220px) {
  .motion-command-bar :deep(.top-action-bar) { grid-template-columns: 1fr; align-items: stretch; }
  .motion-command-bar :deep(.generate-region) { justify-content: flex-start; }
  .motion-card { grid-template-columns: 1fr; }
}
/* The five-column tool grid needs ~1500px of the DECK, not of the window: with the sidebar open a
   1280px window leaves ~940px, which clipped Clip timing out of reach. Measure the deck itself. */
.motion-control-deck { container-type: inline-size; }
@container (max-width: 1520px) {
  .motion-tools { grid-template-columns: minmax(280px, 1fr) minmax(140px, .45fr); }
  .duration-mode { grid-column: 1 / -1; grid-row: 2; }
  .manual-duration, .follow-duration-note { grid-column: 1 / -1; grid-row: 3; }
  .batch-cost { grid-column: 1 / -1; grid-row: 4; }
  .motion-tools > .btn { grid-row: 5; }
  .motion-tools > .btn:first-of-type { grid-column: 1; justify-self: start; }
  .motion-tools > .btn:last-child { grid-column: 2; justify-self: end; }
}
@media (max-width: 900px) {
  .motion-hero-route { display: none; }
  .motion-guide-grid { grid-template-columns: 1fr; }
  .motion-tool-row { align-items: stretch; }
}
@media (max-width: 640px) {
  .motion-scope-summary { align-items: stretch; flex-direction: column; }
  .motion-summary { align-items: flex-start; flex-direction: column; }
  .motion-summary-score, .model-field { width: 100%; min-width: 0; }
  .motion-tools { grid-template-columns: 1fr; align-items: stretch; }
  .motion-tools > *, .duration-mode, .manual-duration, .follow-duration-note, .batch-cost,
  .motion-tools > .btn:first-of-type, .motion-tools > .btn:last-child { grid-column: 1; grid-row: auto; justify-self: stretch; }
  .duration-mode { min-width: 0; flex-direction: column; }
  .manual-duration-inputs { grid-template-columns: 1fr; }
  .media-pair { grid-template-columns: 1fr; }
  .scene-duration-plan { grid-template-columns: 1fr 1fr; }
  .motion-actions { justify-content: stretch; }
  .motion-actions .btn { flex: 1 1 100%; }
  .back-to-top { right: 16px; bottom: 16px; }
}
</style>
