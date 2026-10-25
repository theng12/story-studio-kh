<!--
  Subtitles workshop.

  Dedicated home for CREATING an episode's subtitles, between Audio Assembly
  and Scene Plan (needs the chapter audio). The live transcription catalog
  supplies the selectable models. Imported tracks and transcribed chapter
  SRTs ({code}_{slug}.srt) live in the episode's "09 Subtitles Output" folder,
  which Scene Plan stitches and Video Assembly burns in.
-->
<template>
  <div class="workspace-page">
    <WorkspaceHero
      eyebrow="Assembly · Transcript"
      title="Subtitles"
      description="Build narration-aligned subtitle tracks from chapter audio, then hand the verified timeline to Scene Plan and Video Assembly."
    >
      <template #aside>
        <div class="workspace-metrics" aria-label="Subtitle readiness">
          <span class="workspace-metric" :data-tone="!subtitleFreshnessUnavailable && coverage.total && coverage.done === coverage.total ? 'success' : 'warning'">
            <strong>{{ subtitleFreshnessUnavailable ? '?' : coverage.done }}/{{ coverage.total }}</strong> chapters
          </span>
          <span class="workspace-metric" :data-tone="episodeId ? 'info' : 'warning'">
            <strong>{{ episodeId || 'No episode' }}</strong> target
          </span>
        </div>
      </template>
    </WorkspaceHero>

    <TopActionBar
      :project-slug="slug"
      :presets="subtitlesPresets"
      v-model:episode-id="episodeId"
      filter-field="subtitles"
      :generate-label="subtitleActionLabel(null, transcribeLabel)"
      :generate-loading="transcribing || transcribeJobActive"
      :generate-disabled="!canTranscribe"
      :generate-status="transcribeJobActive ? `Transcribing ${episodeId}…` : (canTranscribe ? '' : transcribeDisabledReason)"
      @generate="transcribe"
    />

    <WorkspaceNotice v-if="!episodeId" tone="info" title="Choose an episode">
      Select an episode above to inspect subtitle coverage and manage its transcription.
    </WorkspaceNotice>

    <template v-else>
      <!-- Status -->
      <WorkspaceSection
        eyebrow="Readiness"
        title="Subtitle coverage"
        description="Every narration section must have a usable subtitle file before the timeline is complete."
      >
        <div v-if="loading" class="text-muted text-sm mt-1">
          <LoadingSpinner size="sm" /> Checking subtitle status…
        </div>
        <template v-else>
          <!-- E-04 (DS-10) — a failed read is not an empty episode. Without this
               branch the app asserted the missing-chapter-audio claim about an
               episode it never managed to look at. -->
          <div v-if="statusError" class="validation-msg text-sm mt-2" role="alert">
            <p>
              We couldn't read this episode's subtitle status: <code>{{ statusError }}</code>.
              This is a failed check — it does not mean the chapter audio is missing.
            </p>
            <button type="button" class="btn btn-sm btn-secondary mt-1" @click="loadStatus">Retry</button>
          </div>
          <p v-else-if="!status?.has_chapter_audio && (status?.chapter_audio_present || 0) > 0" class="validation-msg text-sm mt-2">
            ⏳ {{ status?.chapter_audio_present }} of {{ status?.chapter_audio_expected }} chapters of {{ episodeId }} are narrated so far.
            Ready chapters can be checked individually below. Full-episode timing waits for complete narration and Audio Assembly —
            follow the rest in the <NuxtLink :to="`/projects/${slug}/audio`" class="inline-link">Audio Generator</NuxtLink>.
          </p>
          <p v-else-if="!status?.has_chapter_audio" class="validation-msg text-sm mt-2">
            ⚠ No chapter audio found for {{ episodeId }}. Generate audio in the
            <NuxtLink :to="`/projects/${slug}/audio`" class="inline-link">Audio Generator</NuxtLink>
            first — subtitles are built from it.
          </p>
          <p v-else-if="!status?.audio_assembly_ready" class="validation-msg text-sm mt-2">
            ⚠ Audio chapters are ready, but Audio Assembly is not complete.
            Open <NuxtLink :to="`/projects/${slug}/audio-merge`" class="inline-link">Audio Assembly</NuxtLink>
            for the full episode timeline, or select ready chapters below to check their narration first.
            <span v-if="status?.audio_assembly_issues?.length">
              {{ status.audio_assembly_issues.join(' ') }}
            </span>
          </p>
          <div v-if="!statusError && (status?.chapter_audio_present || 0) > 0" class="mt-2 text-sm">
            <div class="sub-coverage">
              <span class="sub-coverage-bar" aria-hidden="true">
                <span class="sub-coverage-fill" :style="{ width: subtitleFreshnessUnavailable ? '0%' : coveragePct + '%' }" />
              </span>
              <span class="text-muted">
                <strong>{{ subtitleFreshnessUnavailable ? '?' : coverage.done }}/{{ coverage.total }}</strong>
                {{ subtitleFreshnessUnavailable ? 'chapter freshness unavailable' : 'chapter(s) current' }}
                <template v-if="!subtitleFreshnessUnavailable && coverage.total && coverage.done === coverage.total && subtitleTimelineComplete"> — ready for Scene Plan ✓</template>
                <template v-else-if="!subtitleFreshnessUnavailable && coverage.total && coverage.done === coverage.total && planningSourceRevalidationRequired"> — chapters transcribed; Scene Plan re-checks the corrected timeline before it makes anything</template>
                <template v-else-if="!subtitleFreshnessUnavailable && coverage.total && coverage.done === coverage.total"> — chapter files exist; check the timeline below</template>
              </span>
            </div>
            <WorkspaceNotice v-if="status?.stale_sections?.length" tone="warning" title="Chapter audio changed" class="mt-2">
              <p>{{ status.stale_sections.map(section => section.replaceAll('_', ' ')).join(', ') }} needs updated subtitles. Other chapter transcripts are still current.</p>
            </WorkspaceNotice>
            <WorkspaceNotice v-if="status?.freshness_unavailable" tone="warning" title="Subtitle freshness unavailable" class="mt-2">
              <p>{{ status.freshness_reason || 'Could not verify the selected chapter audio sources.' }} Refresh status before transcribing or stitching.</p>
            </WorkspaceNotice>
            <WorkspaceNotice
              v-if="subtitleTimelineIntegrity && (!subtitleTimelineIntegrity.complete || hasMeasuredCueGaps)"
              :tone="subtitleTimelineIntegrity.complete ? 'warning' : 'error'"
              :title="hasMeasuredCueGaps ? (allGapsSilent ? 'The narration is missing speech' : 'Subtitles skip part of the narration') : 'Subtitle timeline verification is incomplete'"
              class="mt-2 sub-gap-notice"
            >
              <p v-if="hasMeasuredCueGaps && allGapsSilent">
                The narration itself is missing speech here — re-making the chapter’s audio fixes it.
                Re-transcribing can’t, because there is nothing to hear. Re-narrate makes the chapter’s audio again, then its subtitles automatically.
              </p>
              <p v-else-if="hasMeasuredCueGaps">
                This is almost always the narration: the voice skipped a sentence or hummed instead of speaking, and re-making the chapter’s audio fixes it.
                Re-narrate makes the chapter’s audio again, then its subtitles automatically. If you listen and hear clear speech, only the subtitles missed it — re-transcribe instead.
              </p>
              <p v-else-if="planningSourceRevalidationRequired">
                This is the uncorrected timeline. Scene Plan re-checks the corrected timeline before it makes anything.
              </p>
              <p v-else>Subtitle timeline verification is incomplete. Re-stitch it, then recheck before Scene Plan.</p>
              <ul v-if="subtitleTimelineIntegrity.blocking_cue_gaps?.length" class="sub-gap-list">
                <li v-for="(gap, index) in subtitleTimelineIntegrity.blocking_cue_gaps || []" :key="`${gap.previous_end_sec}-${gap.next_start_sec}-${index}`">
                  <strong>{{ gap.section_slugs.map(section => section.replaceAll('_', ' ')).join(', ') || 'Chapter could not be identified' }}</strong>
                  <div>Time without subtitles: <strong>{{ gap.gap_sec.toFixed(1) }} seconds</strong></div>
                  <div v-if="gap.section_local_start_sec !== undefined && gap.section_local_end_sec !== undefined">
                    In chapter audio: <strong>{{ formatSeconds(gap.section_local_start_sec) }}–{{ formatSeconds(gap.section_local_end_sec) }}</strong> (minutes:seconds)
                  </div>
                  <div v-else>The chapter audio position is unavailable; use the full episode timeline below.</div>
                  <div class="text-muted">In full episode: {{ formatSeconds(gap.previous_end_sec) }}–{{ formatSeconds(gap.next_start_sec) }} (minutes:seconds)</div>
                  <div v-if="gap.audio" class="sub-gap-audio" :class="`is-${gap.audio}`">{{ gapAudioSentence(gap.audio) }}</div>
                </li>
              </ul>
              <p v-if="hasMeasuredCueGaps" class="text-sm">{{ captionGapPolicyMessage }} Chapter audio times start at the beginning of that chapter. Full episode times include the chapters before it. Listen starts up to two seconds before the first gap with a known chapter position.</p>
              <template #actions>
                <NuxtLink
                  v-if="planningSourceRevalidationRequired && !hasMeasuredCueGaps"
                  :to="`/projects/${slug}/scene-plan?episode_id=${encodeURIComponent(episodeId)}`"
                  class="btn btn-sm btn-secondary"
                >Open Scene Plan</NuxtLink>
                <div v-for="section in gapActionSections" :key="section" class="sub-gap-actions">
                  <NuxtLink
                    v-if="gapSections.has(section)"
                    :to="renarrateLink(slug, episodeId, section)"
                    class="btn btn-sm btn-primary"
                    :title="`Opens Audio Generator to make ${subtitleChapterLabel(section)}'s narration again, then its subtitles automatically.`"
                  >Re-narrate {{ subtitleChapterLabel(section) }}</NuxtLink>
                  <button
                    type="button"
                    :class="['btn', 'btn-sm', gapSections.has(section) ? 'btn-secondary' : 'btn-primary']"
                    :disabled="!canTranscribeChapter(section) || transcribing"
                    :title="canTranscribeChapter(section) ? `Checks ${section.replaceAll('_', ' ')} directly. Episode timing is refreshed after Audio Assembly.` : transcribeDisabledReason"
                    @click="retranscribeChapter(section)"
                  >{{ subtitleActionLabel(section, `Re-transcribe ${section.replaceAll('_', ' ')}`) }}</button>
                  <button type="button" class="btn btn-sm btn-secondary" @click="reviewChapterAudio(section, true)">Listen to {{ section.replaceAll('_', ' ') }}</button>
                  <NuxtLink :to="subtitleSectionLink(section)" class="inline-link">Review subtitles</NuxtLink>
                </div>
                <p v-if="gapSections.size" class="text-xs text-muted sub-gap-hint">Re-narrate replaces the chapter’s audio with a new take. Re-transcribe only re-reads the audio you have now.</p>
              </template>
            </WorkspaceNotice>
            <WorkspaceNotice
              v-if="missingSentenceChapters.length"
              tone="warning"
              title="The narration skips script sentences"
              class="mt-2 sub-gap-notice"
            >
              <p>
                These sentences are in the script but not in what the narration says — the voice skipped them or mumbled through them.
                Listen to the chapter; if they are missing, Re-narrate makes the chapter’s audio again, then its subtitles automatically.
              </p>
              <ul class="sub-gap-list">
                <li v-for="chapter in missingSentenceChapters" :key="chapter.slug">
                  <strong>{{ subtitleChapterLabel(chapter.slug) }}</strong> — {{ chapter.sentences.length }} sentence{{ chapter.sentences.length === 1 ? '' : 's' }} not heard
                  <ul class="sub-missing-sentences">
                    <li v-for="(sentence, index) in chapter.sentences.slice(0, 3)" :key="index">“{{ sentence }}”</li>
                    <li v-if="chapter.sentences.length > 3" class="text-muted">and {{ chapter.sentences.length - 3 }} more</li>
                  </ul>
                </li>
              </ul>
              <template #actions>
                <div v-for="chapter in missingSentenceChapters" :key="chapter.slug" class="sub-gap-actions">
                  <NuxtLink
                    :to="renarrateLink(slug, episodeId, chapter.slug)"
                    class="btn btn-sm btn-primary"
                    :title="`Opens Audio Generator to make ${subtitleChapterLabel(chapter.slug)}'s narration again, then its subtitles automatically.`"
                  >Re-narrate {{ subtitleChapterLabel(chapter.slug) }}</NuxtLink>
                  <button type="button" class="btn btn-sm btn-secondary" @click="reviewChapterAudio(chapter.slug)">Listen to {{ subtitleChapterLabel(chapter.slug) }}</button>
                </div>
              </template>
            </WorkspaceNotice>
            <div v-if="audioReview" ref="audioReviewPanel" tabindex="-1">
              <ChapterAudioPreview
                :key="`${slug}:${episodeId}:${audioReview.section}:${audioReview.startSeconds}`"
                :project-slug="slug" :episode-id="episodeId" :section="audioReview.section"
                :start-seconds="audioReview.startSeconds" @close="audioReview = null"
              />
            </div>
            <p v-if="sections.length" class="text-muted text-xs mt-2">
              Tick chapters to (re)make just those; unticked chapters are left alone. Each ticked chapter is a new request<template v-if="!isFreeToRun(genstudioSelectedModel)">, so the model's current price may be charged</template>.
            </p>
            <p v-if="subtitleSelectionUnavailable" class="validation-msg">Selected chapters could not be verified. Refresh status or <button type="button" class="btn btn-xs btn-secondary" @click="selectedSubtitleSections = []">Clear Unavailable Selection</button>.</p>
            <div v-if="sections.length" class="sub-selection-actions" role="group" aria-label="Subtitle chapter selection">
              <strong aria-live="polite">{{ selectedSubtitleIds.length }} selected</strong>
              <button type="button" class="btn btn-xs btn-secondary" :disabled="transcribing || transcribeJobActive || !subtitleAttentionIds.length" @click="selectSubtitleAttention">Select needs attention ({{ subtitleAttentionIds.length }})</button>
              <button type="button" class="btn btn-xs btn-secondary" :disabled="transcribing || transcribeJobActive || !selectedSubtitleSections.length" @click="selectedSubtitleSections = []">Clear Selection</button>
              <button type="button" class="btn btn-sm btn-primary" :disabled="!canTranscribe || !selectedSubtitleIds.length" :title="transcribeDisabledReason" @click="transcribe">{{ subtitleActionLabel(null, `Generate / Regenerate Selected (${selectedSubtitleIds.length})`) }}</button>
            </div>
            <ul v-if="sections.length" class="sub-chapter-list mt-2">
              <li v-for="s in sections" :id="`sub-section-${s.slug}`" :key="s.slug" class="sub-chapter-row" tabindex="-1">
                <input v-model="selectedSubtitleSections" type="checkbox" :value="s.slug" :aria-label="`Select ${s.label} subtitles`" :disabled="transcribing || transcribeJobActive">
                <span class="sub-chapter-mark" :class="{ ok: chapterHasCurrentSrt(s.slug), stale: chapterIsStale(s.slug) }" aria-hidden="true">
                  {{ chapterHasCurrentSrt(s.slug) ? '✓' : chapterIsStale(s.slug) ? '!' : '○' }}
                </span>
                <span class="sub-chapter-name">{{ s.label }}</span>
                <span class="text-muted text-xs">{{ subtitleFreshnessUnavailable ? 'freshness unavailable' : chapterIsStale(s.slug) ? 'audio changed — update subtitles' : chapterHasSrt(s.slug) ? 'transcribed' : 'no SRT yet' }}</span>
                <!-- v1.2.2 — readiness is not only "is there an SRT" but "is the
                     SRT usable". A transcribed chapter full of hallucinated
                     script is worse than a missing one, because it looks done. -->
                <span v-if="chapterIsGarbled(s.slug)" class="garbled-tag" title="Some cues look like transcription errors — see Subtitle files below.">
                  ⚠ garbled text
                </span>
                <NuxtLink
                  v-if="s.quality && s.quality.state !== 'not_checked'"
                  :class="['audio-quality-link', `tone-${audioQualityTone(s.quality.state)}`]"
                  :to="audioSectionLink(s.slug)"
                  :title="s.quality.reason || 'Open Audio to review the source and transcript evidence.'"
                >Audio: {{ audioQualityLabel(s.quality.state) }}</NuxtLink>
                <div class="sub-chapter-action">
                  <button type="button" class="btn btn-xs btn-secondary" :aria-label="`Listen to ${s.label} audio`" @click="reviewChapterAudio(s.slug)">Listen</button>
                  <NuxtLink :to="audioSectionLink(s.slug)" class="btn btn-xs btn-secondary" :aria-label="`Open Audio Generator for ${s.label}`">Audio Generator</NuxtLink>
                  <button
                    :class="['btn', 'btn-xs', chapterHasCurrentSrt(s.slug) ? 'btn-secondary' : 'btn-primary']"
                    type="button"
                    :disabled="!canTranscribeChapter(s.slug) || transcribing"
                    :aria-label="`${chapterIsStale(s.slug) ? 'Update' : chapterHasSrt(s.slug) ? 'Regenerate' : 'Generate'} ${s.label} subtitles`"
                    :title="canTranscribeChapter(s.slug) ? `Makes new subtitles for ${s.label} only${isFreeToRun(genstudioSelectedModel) ? '' : ' (a new request at the model\'s current price)'}.` : transcribeDisabledReason"
                    @click="retranscribeChapter(s.slug)"
                  >{{ subtitleActionLabel(s.slug, chapterIsStale(s.slug) ? 'Update Subtitles' : chapterHasSrt(s.slug) ? 'Regenerate Subtitles' : 'Generate Subtitles') }}</button>
                </div>
              </li>
            </ul>
          </div>
        </template>
      </WorkspaceSection>

      <!-- Transcribe -->
      <WorkspaceSection
        eyebrow="Create"
        title="Transcription settings"
        description="Current chapter subtitles are preserved. Transcription updates only missing or outdated sections unless you choose to re-run them all."
      >
        <div class="form-group mt-2">
          <label for="sub-method">How subtitles are made</label>
          <select id="sub-method" v-model="subtitleMethod" class="input">
            <option value="">Transcribe the audio (Khmer uses the script's own words)</option>
            <option value="script">Script-timed (fast, exact text)</option>
          </select>
          <small class="text-muted">
            Script-timed shows the script's own words, timed by the narration's sections — no transcription model and nothing charged.
          </small>
        </div>
        <div v-if="subtitleMethod !== 'script'" class="mt-2">
          <div v-if="genstudioModelsLoading" class="text-muted text-sm">
            <LoadingSpinner size="sm" /> Loading transcription models…
          </div>
          <p v-else-if="genstudioModelsError" class="validation-msg text-sm">
            ⚠ {{ genstudioModelsError }}
            <NuxtLink :to="`/projects/${slug}/settings#connections`" class="inline-link">Open transcription settings</NuxtLink>
            or <a href="#" class="inline-link" @click.prevent="loadGenstudioModels">retry</a>.
          </p>
          <div v-else class="form-group">
            <label>Transcription model</label>
            <ModelMenu
              v-model="genstudioModel"
              :options="genstudioModelOptions"
              media-type="transcription"
              title="Choose a transcription model"
              placeholder="Pick a transcription model…"
              search-placeholder="Search transcription models…"
              aria-label="Transcription model options"
            />
          </div>
          <!-- Language choices come only from the selected live model. -->
          <div v-if="genstudioSelectedModel" class="form-group mt-2">
            <label for="sub-language">Spoken language</label>
            <select
              v-if="languageControl.options.length"
              id="sub-language"
              v-model="language"
              class="input"
            >
              <option
                v-for="option in languageControl.options"
                :key="option.value"
                :value="option.value"
              >{{ option.label }}</option>
            </select>
            <small v-if="languageControl.options.length" class="text-muted">
              {{ genstudioSelectedModel.display_name }} publishes these languages.
              <template v-if="languageControl.autoDetectPublished">
                <strong>Auto-detect</strong> sends no language and lets the model decide.
              </template>
            </small>
            <small v-else class="validation-msg">
              This model has not published a supported language list or auto-detect. Choose another transcription model; no request can be submitted.
            </small>
          </div>
        </div>

        <label class="flex items-center gap-1 mt-2 text-sm">
          <input type="checkbox" v-model="force" />
          Re-run chapters that already have a verified SRT
        </label>

        <!-- Owner decision 2026-10-03: no third "Transcribe chapters" button here. The top bar
             transcribes the episode and each chapter row has its own button. -->
        <p class="text-muted text-xs mt-2">
          {{ transcribeJobActive ? 'Running… progress shows in Jobs / the bell.' : `Start with "${subtitleActionLabel(null, transcribeLabel)}" at the top of the page, or use a chapter's own button above.` }}
        </p>
        <p v-if="subtitleRetryPending" class="text-muted text-xs mt-1" role="status">
          {{ UNCONFIRMED_SUBMISSION }}
        </p>
      </WorkspaceSection>

      <WorkspaceSection
        eyebrow="Import"
        title="Import subtitles"
        description="Bring an existing subtitle track into this episode."
      >
        <div class="sub-method">
          <div class="sub-method-import">
            <strong class="text-sm">Import .srt / .vtt</strong>
            <p class="text-muted text-xs mt-1">Bring your own subtitle file — we copy + normalize it into this episode.</p>
            <div class="flex gap-2 mt-1 items-center">
              <FilePicker
                v-model="importPath"
                placeholder="/path/to/subtitles.srt"
                :filters="[{ name: 'Subtitles', extensions: ['srt', 'vtt'] }]"
                title="Choose a subtitle file"
                :episodes-root="episodesRoot"
                clearable
              />
              <button class="btn btn-sm btn-primary" :disabled="importing || !importPath" @click="importSrt">
                {{ importing ? 'Importing…' : 'Import' }}
              </button>
            </div>
          </div>
        </div>
      </WorkspaceSection>

      <!-- Existing files -->
      <section class="card mt-3">
        <h3>Subtitle files <span v-if="status?.existing_srts?.length" class="text-muted text-sm">({{ status.existing_srts.length }})</span></h3>
        <p v-if="!status?.existing_srts?.length" class="text-muted text-sm mt-1">No subtitle files yet for this episode. Generate some above.</p>
        <ul v-else class="sub-file-list mt-2">
          <template v-for="srt in status.existing_srts" :key="srt.path">
            <li class="sub-file-row">
              <span class="sub-file-name">{{ srt.filename }}</span>
              <span v-if="hasQualityFindings(srt.quality)" class="garbled-tag" title="Some cues look like transcription errors — details below.">
                ⚠ garbled text
              </span>
              <span :class="['word-timing-tag', `wt-${srt.word_timings || 'unknown'}`]" :title="wordTimingHint(srt.word_timings)">
                {{ wordTimingLabel(srt.word_timings) }}
              </span>
              <button
                class="btn-icon"
                :class="{ active: previewFilename === srt.filename }"
                :title="previewFilename === srt.filename ? 'Hide preview' : 'Preview subtitle text'"
                @click="viewSrt(srt.filename)"
              >👁</button>
              <button class="btn-icon" title="Remove this subtitle file (moves it to the project's _trash folder)" :aria-label="`Remove ${srt.filename}`" @click="deleteSrt(srt.filename)">✕</button>
            </li>
            <!-- v1.2.2 — the offending cues shown in place, so the file above can
                 be judged without opening it. Advisory only: nothing is disabled
                 and the file is never rewritten. The chapter-level re-generation
                 action lives in the coverage list above. -->
            <li v-if="hasQualityFindings(srt.quality)" class="sub-file-quality">
              <SubtitleQualityWarning :quality="srt.quality" :subject="srt.filename" />
            </li>
          </template>
        </ul>

        <!-- v1.0.494/495 — inline preview of the generated cues so accuracy can
             be verified without opening Finder. Per-chapter files preview here;
             the stitched timeline SRT previews in its own section below. -->
        <SubtitleCuePreview
          v-if="previewFilename && !isStitchedPreview"
          class="mt-3"
          :filename="previewFilename"
          :loading="previewLoading"
          :meta="previewMeta"
          :cues="previewCues"
          :raw="previewRaw"
          @close="closePreview"
        />

        <p v-if="anyTranscriptWithoutWordTimings" class="text-muted text-xs mt-2">
          Word-by-word caption styles need per-word timings. Story Studio asks for them on every
          transcription from v1.1.0 onward; a transcript made before that has none, so those styles
          estimate word timing from the caption timings instead. Transcribe the episode again above
          to collect them — there is no extra charge for the timings themselves, but the
          transcription itself is billed as usual. Tick "Re-run chapters that already have a
          verified SRT" first — without it, chapters that already have an SRT are skipped.
        </p>
        <p class="text-muted text-xs mt-2">Folder: <code class="sub-dir">{{ status?.subtitles_dir }}</code></p>
      </section>

      <!-- Stitch into the timeline (v1.0.218 — moved here from Scene Plan so
           subtitles + their stitch live in one workspace). -->
      <section class="card mt-3">
        <h3>Stitch into the timeline</h3>
        <p class="text-muted text-sm mt-1">
          Combine the per-chapter SRTs above into one global-timeline SRT —
          each chapter is offset by its audio duration + the merge gap. This
          stitched SRT is what <strong>Scene Plan</strong> reads and
          <strong>Video Assembly</strong> burns in.
        </p>

        <p v-if="!status?.has_merged_audio" class="validation-msg text-sm mt-2">
          ⚠ Run <NuxtLink :to="`/projects/${slug}/audio-merge`" class="inline-link">Audio Assembly</NuxtLink>
          first — stitching needs the per-section durations + gap.
        </p>
        <p v-else-if="status?.freshness_unavailable" class="validation-msg text-sm mt-2">
          ⚠ {{ status.freshness_reason || 'Could not verify the selected chapter audio sources.' }} Refresh status before stitching.
        </p>
        <p v-else-if="staleSubtitleSections.size" class="validation-msg text-sm mt-2">
          ⚠ {{ staleSubtitleSections.size }} chapter {{ staleSubtitleSections.size === 1 ? 'has' : 'have' }} changed audio and needs updated subtitles.
          Update the affected chapters above before stitching; their old SRTs cannot be used with the current audio.
        </p>
        <p v-else-if="coverage.total && coverage.done < coverage.total" class="validation-msg text-sm mt-2">
          ⚠ Only {{ coverage.done }}/{{ coverage.total }} chapters transcribed. Stitch will skip the
          missing ones — transcribe them all above for complete subtitles.
        </p>

        <div v-if="stitchStatus?.stitched_srt" class="mt-2 text-sm">
          Stitched SRT exists:
          <strong>{{ stitchStatus.stitched_srt.meta?.total_cues ?? '?' }} cues</strong>
          across <strong>{{ stitchStatus.stitched_srt.meta?.sections?.length ?? '?' }} section(s)</strong>,
          <strong>{{ stitchStatus.stitched_srt.meta?.total_duration_sec?.toFixed(1) ?? '?' }}s</strong> total.
          <span class="text-muted text-xs">Last stitched: <time v-if="status?.last_stitched_at" :datetime="status.last_stitched_at" :title="nativeStitchTime(status.last_stitched_at)">{{ formatLastStitchedAt(status.last_stitched_at) }}</time><span v-else>time unavailable</span>.</span>
        </div>
        <p v-else class="text-muted text-sm mt-2">Not stitched yet.</p>

        <div class="mt-2 flex gap-2 items-center">
          <button class="btn btn-sm btn-primary" :disabled="stitching || !status?.has_merged_audio || status?.freshness_unavailable || staleSubtitleSections.size > 0" @click="stitchSubtitles">
            {{ stitching ? 'Stitching…' : (stitchStatus?.stitched_srt ? 'Re-stitch' : 'Stitch subtitles') }}
          </button>
          <button
            v-if="stitchedSrtFile"
            class="btn btn-sm btn-secondary"
            @click="viewSrt(stitchedSrtFile)"
          >
            {{ previewFilename === stitchedSrtFile ? 'Hide Preview' : '👁 Preview Stitched' }}
          </button>
        </div>

        <!-- Preview of the stitched timeline SRT — the exact file Scene Plan
             reads and Video Assembly burns in. -->
        <SubtitleCuePreview
          v-if="previewFilename && isStitchedPreview"
          class="mt-3"
          :filename="previewFilename"
          :loading="previewLoading"
          :meta="previewMeta"
          :cues="previewCues"
          :raw="previewRaw"
          @close="closePreview"
        />

        <div v-if="stitchError" class="validation-msg text-sm mt-2" style="white-space: pre-wrap;">
          ✗ {{ stitchError }}
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import {
  DEFAULT_TRANSCRIPTION_LANGUAGE,
  defaultTranscriptionLanguage,
  isTranscriptionLanguageUsable,
  transcriptionLanguageControl,
  transcriptionLanguageRequestFields,
} from '~/utils/transcription-language'
import type { SubtitleQualityReport } from '~/types/subtitle-quality'
import { UNCONFIRMED_SUBMISSION } from '~/composables/useFreshGenerationAction'
import { isFreeToRun } from '~/utils/genstudio-price-usd'
import { gapAudioSentence, renarrateLink, subtitleChapterLabel } from '@shared/subtitle-gaps'
import { hasQualityFindings } from '~/types/subtitle-quality'
import { audioQualityLabel, audioQualityTone, type AudioQualityEvidence } from '~/types/audio-quality'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Subtitles')

interface ExistingSrt {
  path: string
  filename: string
  mtime: number
  /**
   * v1.1.0 — whether this transcript was asked for WITH per-word timings.
   * Story Studio started asking in 1.1.0; transcripts from before that stay
   * coarse unless the customer deliberately re-transcribes, and word-by-word
   * caption styles interpolate for them. Surfacing it is the only thing that
   * explains why two episodes in one project can differ.
   */
  word_timings?: 'banked' | 'none' | 'unknown'
  /**
   * v1.2.2 — text-quality inspection of this file's cues. `null` for formats
   * that are not plain transcripts (.ass), which are not checked rather than
   * asserted clean.
   */
  quality?: SubtitleQualityReport | null
}
/**
 * Say what is actually known, in three states, without alarm. 'unknown' is a
 * real answer for an imported or stitched file — claiming either of the other
 * two for it would be a guess.
 */
function wordTimingLabel(state?: string): string {
  if (state === 'banked') return 'word timings'
  if (state === 'none') return 'no word timings'
  return ''
}
function wordTimingHint(state?: string): string {
  if (state === 'banked') return 'Transcribed with per-word timings, so word-by-word caption styles can be exact.'
  if (state === 'none') return 'Transcribed before Story Studio asked for word timings. Word-by-word styles estimate from the caption timings. Re-transcribe to collect them.'
  return 'Imported or stitched — Story Studio has no record of how it was transcribed.'
}

interface SubtitleStatus {
  has_libass: boolean
  has_merged_audio: boolean
  has_chapter_audio: boolean
  chapter_audio_present?: number
  chapter_audio_expected?: number
  audio_assembly_ready: boolean
  audio_assembly_issues: string[]
  existing_srts: ExistingSrt[]
  stale_sections?: string[]
  freshness_unavailable?: boolean
  freshness_reason?: string | null
  last_stitched_at?: string | null
  planning_transcript_source?: 'raw' | 'corrected' | null
  planning_source_revalidation_required?: boolean
  /** Script sentences each chapter's narration never said (script vs transcript). */
  missing_sentences?: Array<{ slug: string; sentences: string[] }>
  timeline_integrity?: {
    complete: boolean
    missing_sections: string[]
    max_cue_gap_sec: number
    caption_gap_mode?: 'off' | 'warn' | 'block'
    blocking_cue_gaps?: Array<{
      previous_end_sec: number
      next_start_sec: number
      gap_sec: number
      section_slugs: string[]
      /** Is anything audible under the gap? Measured by the status route. */
      audio?: 'silent' | 'sound'
      section_local_start_sec?: number
      section_local_end_sec?: number
    }>
  } | null
  completion?: {
    complete: boolean
    mode: 'per-section' | 'full-track' | 'none'
    expected_sections: string[]
    completed_sections: string[]
    missing_sections: string[]
    full_track_filename?: string
  }
  subtitles_dir: string
}
interface SectionRow { label: string; slug: string; audioReady?: boolean; quality?: AudioQualityEvidence }

let episodeSequence = 0
const route = useRoute()
const router = useRouter()
const slug = computed(() => route.params.slug as string)
const { get, post, del } = useApi()
const freshSubtitleAction = useFreshGenerationAction()
const { success, error: showError, info: showInfo } = useToast()
const { jobs } = useJobs()
const { project, episodesRoot } = useProject()

const initialEpisodeId = typeof route.query.episode_id === 'string' ? route.query.episode_id : ''
const episodeId = ref(initialEpisodeId)
const subtitleEpisodeTarget = computed(() => JSON.stringify([slug.value, episodeId.value]))
const subtitleRetryPending = computed(() => [...freshSubtitleAction.pending.value.keys()]
  .some(target => target.startsWith(`${subtitleEpisodeTarget.value}:`)))
const pendingSectionDeepLink = ref(typeof route.query.section === 'string' ? route.query.section : '')
const status = ref<SubtitleStatus | null>(null)
const sections = ref<SectionRow[]>([])
const selectedSubtitleSections = ref<string[]>([])
// Use current episode order, excluding stale selections and duplicate clicks.
const selectedSubtitleIds = computed(() => sections.value
  .filter(section => selectedSubtitleSections.value.includes(section.slug)).map(section => section.slug))
const subtitleSelectionUnavailable = computed(() => selectedSubtitleSections.value.some(id =>
  !sections.value.some(section => section.slug === id)))
const subtitleAttentionIds = computed(() => sections.value.filter(section =>
  !chapterHasCurrentSrt(section.slug) || chapterIsGarbled(section.slug)
  || (status.value?.timeline_integrity?.blocking_cue_gaps || []).some(gap => gap.section_slugs?.includes(section.slug)),
).map(section => section.slug))
function selectSubtitleAttention(): void {
  selectedSubtitleSections.value = [...subtitleAttentionIds.value]
}
const audioReview = ref<{ section: string; startSeconds: number } | null>(null)
const audioReviewPanel = ref<HTMLElement | null>(null)
const loading = ref(false)
// E-04 (DS-10) — a failed status read left `status` null, and the template's
// `!status?.has_chapter_audio` branch then told the customer "No chapter audio
// found for <episode>" — a claim the app had not established. AGENTS.md §6:
// "I could not work out the answer" must not render as "the answer is none".
const statusError = ref('')

const force = ref(false)
/** '' = transcribe (Khmer script-timed by default), 'script' = script-timed (2026-10-05). */
const subtitleMethod = ref<'' | 'script'>('')
const transcribing = ref(false)
/**
 * The chosen spoken language, or published auto-detect.
 *
 * Seeded to English because that is what this channel produces TODAY — a
 * default, not a hardcode. The customer can change it, it round-trips through
 * the subtitles preset, and nothing on the request path forces it: see
 * `transcriptionLanguageRequestFields`, which omits the field entirely for
 * auto-detect. When the owner adds more languages this line does not change.
 */
const language = ref(DEFAULT_TRANSCRIPTION_LANGUAGE)
const {
  modelId: genstudioModel,
  selectedModel: genstudioSelectedModel,
  options: genstudioModelOptions,
  loading: genstudioModelsLoading,
  error: genstudioModelsError,
  ready: genstudioModelReady,
  load: loadGenstudioModels,
} = useGenStudioTranscriptionModels()

const languageControl = computed(() => transcriptionLanguageControl(genstudioSelectedModel.value))

// A remembered choice is accepted only while the selected live model still
// publishes it. A stale auto-detect preset becomes a clear blocked state.
watch(genstudioSelectedModel, (model) => {
  if (!model) return
  if (!isTranscriptionLanguageUsable(language.value, model)) {
    language.value = defaultTranscriptionLanguage(model)
  }
})

const importPath = ref('')
const importing = ref(false)

// ── Subtitle preview (v1.0.494) — read a file's cues so accuracy can be
// verified in-app. Inline panel toggled per file. ─────────────────────────
interface SrtCuePreview { index: number; start_sec: number; end_sec: number; text: string }
interface SubtitleContent {
  filename: string; is_ass: boolean; cue_count: number; truncated: boolean;
  total_duration_sec: number; cues: SrtCuePreview[]; raw?: string
}
const previewFilename = ref('')
const previewCues = ref<SrtCuePreview[]>([])
const previewRaw = ref('')
const previewMeta = ref<SubtitleContent | null>(null)
const previewLoading = ref(false)

// The stitched timeline SRT (<code>_stitched.srt) as listed by the status
// endpoint — used for the dedicated preview in the Stitch section. Matched by
// suffix so episode-code casing doesn't matter.
const stitchedSrtFile = computed(() =>
  (status.value?.existing_srts || []).find(s => /_stitched\.srt$/i.test(s.filename))?.filename || '',
)
// Whether the open preview is the stitched file — decides which section renders
// the panel so it appears next to the button that opened it.
const isStitchedPreview = computed(() => /_stitched\.srt$/i.test(previewFilename.value))

function formatLastStitchedAt(value: string): string {
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return 'Unavailable'
  try {
    return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
  } catch {
    return at.toLocaleString()
  }
}

function nativeStitchTime(value: string): string {
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? 'Unavailable' : at.toString()
}

let previewSequence = 0
function closePreview(): void {
  previewSequence++
  previewFilename.value = ''
  previewCues.value = []
  previewRaw.value = ''
  previewMeta.value = null
  previewLoading.value = false
}

async function viewSrt(filename: string): Promise<void> {
  // Clicking the open file's eye toggles the panel closed.
  if (previewFilename.value === filename) { closePreview(); return }
  const request = ++previewSequence
  previewFilename.value = filename
  previewLoading.value = true
  previewCues.value = []
  previewRaw.value = ''
  previewMeta.value = null
  try {
    const r = await get<SubtitleContent>(
      `/projects/${slug.value}/video-editor/subtitles/content/${episodeId.value}/${encodeURIComponent(filename)}`,
    )
    // Guard against a fast toggle/episode-switch superseding this fetch.
    if (request !== previewSequence) return
    previewMeta.value = r
    previewCues.value = r.cues || []
    previewRaw.value = r.raw || ''
  } catch (e: any) {
    if (request !== previewSequence) return
    showError(e?.data?.detail || e?.message || 'Could not load subtitle content')
    closePreview()
  } finally {
    if (request === previewSequence) previewLoading.value = false
  }
}

const codeUpper = computed(() => episodeId.value.toUpperCase())
/** True when at least one transcript on disk predates word-timing collection. */
const anyTranscriptWithoutWordTimings = computed(() =>
  (status.value?.existing_srts || []).some(s => s.word_timings === 'none'))

const srtNames = computed(() => new Set((status.value?.existing_srts || []).map(s => s.filename.toLowerCase())))
function chapterHasSrt(secSlug: string): boolean {
  if (status.value?.completion?.mode === 'full-track') return true
  if (status.value?.completion) {
    const normalized = secSlug.toLowerCase().replace(/[^a-z0-9]/g, '')
    return status.value.completion.completed_sections.some(
      section => section.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized,
    )
  }
  return srtNames.value.has(`${codeUpper.value}_${secSlug}.srt`.toLowerCase())
}
const staleSubtitleSections = computed(() => new Set((status.value?.stale_sections || []).map(section =>
  section.toLowerCase().replace(/[^a-z0-9]/g, ''),
)))
const subtitleFreshnessUnavailable = computed(() => status.value?.freshness_unavailable === true)
function chapterIsStale(secSlug: string): boolean {
  return staleSubtitleSections.value.has(secSlug.toLowerCase().replace(/[^a-z0-9]/g, ''))
}
function chapterHasCurrentSrt(secSlug: string): boolean {
  if (status.value?.freshness_unavailable) return false
  return chapterHasSrt(secSlug) && !chapterIsStale(secSlug)
}
/** Quality report for a chapter's own transcript, if one is on disk. */
function chapterQuality(secSlug: string): SubtitleQualityReport | null {
  const wanted = `${codeUpper.value}_${secSlug}.srt`.toLowerCase()
  return (status.value?.existing_srts || [])
    .find(s => s.filename.toLowerCase() === wanted)?.quality ?? null
}
function chapterIsGarbled(secSlug: string): boolean {
  return hasQualityFindings(chapterQuality(secSlug))
}

const coverage = computed(() => {
  const total = sections.value.length
  const done = sections.value.filter(s => chapterHasCurrentSrt(s.slug)).length
  return { total, done }
})
const coveragePct = computed(() => coverage.value.total ? Math.round((coverage.value.done / coverage.value.total) * 100) : 0)
const subtitleTimelineIntegrity = computed(() => status.value?.timeline_integrity || null)
const planningSourceRevalidationRequired = computed(() => status.value?.planning_source_revalidation_required === true)
const subtitleTimelineComplete = computed(() =>
  !planningSourceRevalidationRequired.value && subtitleTimelineIntegrity.value?.complete === true,
)
const hasMeasuredCueGaps = computed(() => (subtitleTimelineIntegrity.value?.blocking_cue_gaps?.length || 0) > 0)
const captionGapPolicyMessage = computed(() => {
  if (subtitleTimelineIntegrity.value?.missing_sections?.length) return 'Downstream work stays paused until the incomplete timeline is fixed.'
  if (subtitleTimelineIntegrity.value?.caption_gap_mode === 'block') return 'This channel blocks downstream work until the gap is fixed.'
  if (subtitleTimelineIntegrity.value?.caption_gap_mode === 'warn') return 'Downstream work can continue and its job will carry a warning.'
  return 'Downstream work can continue and its job log will record the gap.'
})
const normalizedSectionSlug = (section: string) => section.toLowerCase().replace(/[^a-z0-9]/g, '')
/** Chapters whose narration skipped script sentences, in this page's own chapter order. */
const missingSentenceChapters = computed(() => {
  const rows = status.value?.missing_sentences || []
  return sections.value
    .map(section => rows.find(row => normalizedSectionSlug(row.slug) === normalizedSectionSlug(section.slug)))
    .filter((row): row is { slug: string; sentences: string[] } => !!row && row.sentences.length > 0)
})
/** Chapters with a gap inside (not missing outright): those lead with Re-narrate. */
const gapSections = computed(() => new Set(
  (subtitleTimelineIntegrity.value?.blocking_cue_gaps || []).flatMap(gap => gap.section_slugs)
    .map(section => sections.value.find(row => normalizedSectionSlug(row.slug) === normalizedSectionSlug(section))?.slug)
    .filter((section): section is string => !!section),
))
/** Every measured gap is silence: the voice skipped it, so say that outright. */
const allGapsSilent = computed(() => {
  const gaps = subtitleTimelineIntegrity.value?.blocking_cue_gaps || []
  return gaps.length > 0 && gaps.every(gap => gap.audio === 'silent')
})
const gapActionSections = computed(() => {
  const known = new Map(sections.value.map(section => [normalizedSectionSlug(section.slug), section.slug]))
  const fromGaps = subtitleTimelineIntegrity.value?.blocking_cue_gaps?.flatMap(gap => gap.section_slugs) || []
  const missing = subtitleTimelineIntegrity.value?.missing_sections || []
  return Array.from(new Set([...fromGaps, ...missing]))
    .map(section => known.get(normalizedSectionSlug(section)))
    .filter((section): section is string => typeof section === 'string')
})
function formatSeconds(value: number): string {
  const minutes = Math.floor(value / 60)
  const seconds = value - minutes * 60
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`
}
function audioSectionLink(section: string): string {
  return `/projects/${encodeURIComponent(slug.value)}/audio?episode_id=${encodeURIComponent(episodeId.value)}&section=${encodeURIComponent(section)}`
}
async function reviewChapterAudio(section: string, atGap = false): Promise<void> {
  const scope = episodeSequence
  const gap = atGap ? subtitleTimelineIntegrity.value?.blocking_cue_gaps?.find(gap =>
    gap.section_slugs.length === 1 && normalizedSectionSlug(gap.section_slugs[0] || '') === normalizedSectionSlug(section),
  ) : undefined
  audioReview.value = { section, startSeconds: Math.max(0, (gap?.section_local_start_sec || 0) - 2) }
  await nextTick()
  if (scope !== episodeSequence) return
  audioReviewPanel.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  audioReviewPanel.value?.focus({ preventScroll: true })
}
function subtitleSectionLink(section: string): string {
  return `/projects/${slug.value}/subtitles?episode_id=${encodeURIComponent(episodeId.value)}&section=${encodeURIComponent(section)}`
}
async function focusPendingSection(): Promise<void> {
  const section = pendingSectionDeepLink.value
  if (typeof document === 'undefined' || !section || !sections.value.some(row => row.slug === section)) return
  await nextTick()
  if (!document.getElementById(`sub-section-${section}`)) return
  const { section: _section, ...query } = route.query
  await router.replace({ query })
  await nextTick()
  const el = document.getElementById(`sub-section-${section}`)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.focus({ preventScroll: true })
  pendingSectionDeepLink.value = ''
}

const transcribeJobActive = computed(() =>
  (jobs.value as any[]).some(j =>
    j.type === 'subtitles_transcribe' && j.episode_id === episodeId.value &&
    j.project_slug === slug.value && (j.status === 'queued' || j.status === 'running'),
  ),
)

const transcribeLabel = computed(() => selectedSubtitleIds.value.length
  ? `Generate / regenerate selected (${selectedSubtitleIds.value.length})`
  : coverage.value.done && !force.value ? 'Transcribe missing or outdated chapters' : 'Transcribe chapters')

function canTranscribeScope(scope: string[]): boolean {
  if (!episodeId.value) return false
  const requested = scope.map(slug => sections.value.find(section => section.slug === slug))
  if (requested.some(section => !section || section.audioReady === false)) return false
  if (!status.value?.has_chapter_audio && (!scope.length || !requested.every(section => section?.audioReady === true))) return false
  if (!scope.length && !status.value?.audio_assembly_ready) return false
  if (status.value?.freshness_unavailable) return false
  if (subtitleSelectionUnavailable.value) return false
  if (transcribing.value || transcribeJobActive.value) return false
  if (subtitleMethod.value === 'script') return true
  return genstudioModelReady.value && isTranscriptionLanguageUsable(language.value, genstudioSelectedModel.value)
}
const canTranscribe = computed(() => canTranscribeScope(selectedSubtitleIds.value))
function canTranscribeChapter(slug: string): boolean { return canTranscribeScope([slug]) }
const transcribeDisabledReason = computed(() => {
  if (!episodeId.value) return 'Pick an episode first'
  if (!status.value?.has_chapter_audio && (status.value?.chapter_audio_present || 0) > 0) {
    return `${status.value?.chapter_audio_present} of ${status.value?.chapter_audio_expected} chapters narrated — finish the narration first`
  }
  if (!status.value?.has_chapter_audio) return 'No chapter audio — generate audio first'
  if (!selectedSubtitleIds.value.length && !status.value?.audio_assembly_ready) return 'Select a chapter to check its audio now, or run Audio Assembly for the full episode'
  if (status.value?.freshness_unavailable) return 'Subtitle source freshness is unavailable. Refresh status before transcribing.'
  if (subtitleSelectionUnavailable.value) return 'Selected chapters could not be verified. Refresh status or clear the selection.'
  if (subtitleMethod.value === 'script') return ''
  if (genstudioModelsLoading.value) return 'Loading transcription models'
  if (genstudioModelsError.value) return genstudioModelsError.value
  if (!genstudioModel.value) return 'No transcription model is available'
  if (!genstudioModelReady.value) return 'The selected transcription model is temporarily unavailable'
  if (!isTranscriptionLanguageUsable(language.value, genstudioSelectedModel.value)) {
    return 'Select a language published by this transcription model'
  }
  return ''
})

// v1.0.360 — race token so out-of-order responses from rapid episode switches
// can't clobber the current episode's status or leave `loading` stuck true
// (the "switch episode → still shows Checking subtitle status…" bug).
let loadToken = 0
async function loadStatus(): Promise<void> {
  const myToken = ++loadToken
  if (!episodeId.value) { status.value = null; sections.value = []; loading.value = false; statusError.value = ''; return }
  let loaded = false
  loading.value = true
  statusError.value = ''
  try {
    const [st, secs] = await Promise.all([
      get<SubtitleStatus>(`/projects/${slug.value}/video-editor/subtitles/status/${episodeId.value}`),
      get<{ sections: any[] }>(`/projects/${slug.value}/episodes/${episodeId.value}/audio-sections`).catch(() => ({ sections: [] })),
    ])
    if (myToken !== loadToken) return   // a newer load (episode switch) superseded this one
    status.value = st
    sections.value = (secs.sections || []).map((s: any) => ({ label: s.label, slug: s.slug,
      ...(Number(s.total_chunks) > 0 ? { audioReady: s.present_chunks === s.total_chunks } : {}),
      ...(s.quality ? { quality: s.quality } : {}) }))
    loaded = true
    void loadStitchStatus()
  } catch (e: any) {
    if (myToken === loadToken && !e?.__slugRace) {
      statusError.value = e?.data?.detail || e?.message || 'Could not load subtitle status'
      showError(statusError.value)
    }
  } finally {
    if (myToken === loadToken) loading.value = false
  }
  // Chapter rows render only after loading clears. Focus on the next tick so a
  // deep link scrolls and focuses the real row instead of racing the v-else.
  if (loaded && myToken === loadToken) await focusPendingSection()
}
// v1.0.360 — on episode switch, clear the transient queue flag so a slow/
// in-flight transcribe POST on the PREVIOUS episode doesn't leave the new
// episode's Transcribe button stuck on "Queuing…" / disabled.
watch(() => route.query.episode_id, (episode) => {
  if (typeof episode === 'string' && episode !== episodeId.value) episodeId.value = episode
})
watch(() => route.query.section, (section) => {
  if (typeof section === 'string') {
    pendingSectionDeepLink.value = section
    void focusPendingSection()
  }
})
watch([slug, episodeId], () => {
  episodeSequence++
  audioReview.value = null
  stitchStatus.value = null
  stitchError.value = ''
  stitching.value = false
  importing.value = false
  importPath.value = ''
  status.value = null
  sections.value = []
  selectedSubtitleSections.value = []
  transcribing.value = false
  closePreview()   // don't show the previous episode's cues under a new episode
  void loadStatus()
}, { flush: 'sync' })

// ── Stitch into the global timeline (v1.0.218 — moved here from Scene Plan
// so subtitle creation + stitching live in one workspace). Reads/writes the
// same stitched SRT the Scene Plan page consumes. ─────────────────────────
interface StitchedMeta { total_cues?: number; total_duration_sec?: number; gap_duration_s?: number; sections?: any[] }
interface StitchStatus {
  stitched_srt: { meta: StitchedMeta | null; drifts_from_current_merge: boolean } | null
  audio_merged: boolean
  audio_merge_gap_s: number | null
}
const stitchStatus = ref<StitchStatus | null>(null)
const stitching = ref(false)
const stitchError = ref('')

let stitchLoadSequence = 0
async function loadStitchStatus(): Promise<void> {
  const request = ++stitchLoadSequence
  const episode = episodeSequence
  const current = () => request === stitchLoadSequence && episode === episodeSequence
  if (!episodeId.value) { stitchStatus.value = null; return }
  try {
    const result = await get<StitchStatus>(`/projects/${slug.value}/scene-plan/${episodeId.value}`)
    if (current()) stitchStatus.value = result
  } catch { if (current()) stitchStatus.value = null }
}

async function stitchSubtitles(): Promise<void> {
  if (!episodeId.value || stitching.value) return
  const episode = episodeSequence
  stitching.value = true
  stitchError.value = ''
  try {
    const r = await post<{
      total_cues: number; total_duration_sec: number; lead_in_sec: number; sections: any[]
      lead_in?: { status: 'measured' | 'unmeasurable'; seconds: number; reason?: string; merged_filename?: string }
    }>(
      `/projects/${slug.value}/scene-plan/${episodeId.value}/stitch-subtitles`, {},
    )
    if (episode !== episodeSequence) return
    await loadStatus()
    if (episode !== episodeSequence) return
    const readiness = subtitleTimelineComplete.value
      ? ' — ready for Scene Plan.'
      : hasMeasuredCueGaps.value
        ? '. The refreshed timeline still has a subtitle coverage gap; re-stitching alone cannot add missing cues.'
        : '. Review the refreshed timeline status before Scene Plan.'
    const stitched = `Stitched ${r.total_cues} cue(s) across ${r.sections?.length ?? '?'} section(s)`
    // v1.3.4 — all three outcomes are stated. This used to append the offset
    // only when it was above zero, so "your episode has no intro" and "the
    // intro could not be worked out" both showed as a plain success — and the
    // second one silently produced a timeline early by the intro's length.
    if (r.lead_in?.status === 'unmeasurable') {
      showError(
        `${stitched}, but the intro offset could NOT be measured — ${r.lead_in.reason} `
        + 'The timeline starts at zero. If this episode opens with an intro, the captions will run '
        + 'ahead of the video by its length — re-merge in Audio Assembly, then stitch again.',
      )
    } else if (r.lead_in_sec > 0) {
      success(
        `${stitched}, offset by the ${r.lead_in_sec.toFixed(2)}s that plays before the narration`
        + `${r.lead_in?.merged_filename ? ` in ${r.lead_in.merged_filename}` : ''}${readiness}`,
      )
    } else {
      success(`${stitched}. Nothing plays before the narration, so the timeline starts at zero${readiness}`)
    }
  } catch (e: any) {
    // The stitcher now fails loudly with a diagnostic message (e.g. which
    // section slugs had no matching SRT) instead of writing a blank file.
    if (episode !== episodeSequence) return
    stitchError.value = e?.data?.detail || e?.message || 'Subtitle stitching failed'
    showError('Stitch failed — see the details under "Stitch into the timeline".')
  } finally {
    if (episode === episodeSequence) stitching.value = false
  }
}

function subtitleRequestPayload(sectionSlug?: string): Record<string, any> {
  const selected = sectionSlug ? [sectionSlug] : selectedSubtitleIds.value
  if (subtitleMethod.value === 'script') {
    return {
      per_chapter: true,
      engine: 'genstudio',
      method: 'script',
      force: selected.length ? true : force.value,
      ...(selected.length ? { sections: selected } : {}),
    }
  }
  return {
    per_chapter: true,
    engine: 'genstudio',
    model: genstudioModel.value,
    ...transcriptionLanguageRequestFields(language.value, genstudioSelectedModel.value),
    force: selected.length ? true : force.value,
    ...(selected.length ? { sections: selected } : {}),
  }
}

function subtitleActionTarget(sectionSlug?: string): string {
  return `${subtitleEpisodeTarget.value}:${JSON.stringify(sectionSlug ? [sectionSlug] : selectedSubtitleIds.value.length ? selectedSubtitleIds.value : 'bulk')}`
}

function subtitleActionLabel(sectionSlug: string | null, label: string): string {
  // Disabled buttons still render while the catalogue is loading or unavailable.
  if (subtitleMethod.value !== 'script' && !isTranscriptionLanguageUsable(language.value, genstudioSelectedModel.value)) return label
  const payload = subtitleRequestPayload(sectionSlug || undefined)
  return payload.force && freshSubtitleAction.isRetry(payload, subtitleActionTarget(sectionSlug || undefined)) ? 'Retry (same request)' : label
}

async function transcribe(): Promise<void> {
  if (!canTranscribe.value) return
  const episode = episodeSequence
  transcribing.value = true
  const payload = subtitleRequestPayload()
  const operationId = payload.force ? freshSubtitleAction.begin(payload, subtitleActionTarget()) : null
  if (operationId) payload.operation_id = operationId
  try {
    await post(`/projects/${slug.value}/video-editor/subtitles/transcribe/${episodeId.value}`, payload)
    if (operationId) freshSubtitleAction.complete(operationId)
    if (episode !== episodeSequence) return
    selectedSubtitleSections.value = []
    showInfo(payload.sections?.length
      ? `Transcription queued for ${payload.sections.length} selected chapters — progress shows in Jobs / the bell.`
      : 'Per-chapter transcription queued — progress shows in Jobs / the bell.')
  } catch (e: any) {
    if (episode !== episodeSequence) return
    showError(e?.data?.detail || e?.message || (operationId
      ? UNCONFIRMED_SUBMISSION
      : 'Could not start transcription'))
  } finally {
    if (episode === episodeSequence) transcribing.value = false
  }
}

/**
 * v1.2.2 — re-transcribe ONE chapter.
 *
 * Offered next to a garbled-text warning because re-transcription is the only
 * honest repair: a hallucinated word cannot be corrected without knowing what
 * was actually said, so the app never edits the file. Scoped to a single
 * chapter so fixing one bad chapter does not re-charge the other twelve.
 */
async function retranscribeChapter(sectionSlug: string): Promise<void> {
  if (!canTranscribeChapter(sectionSlug) || transcribing.value) return
  const episode = episodeSequence
  transcribing.value = true
  const payload = subtitleRequestPayload(sectionSlug)
  const operationId = freshSubtitleAction.begin(payload, subtitleActionTarget(sectionSlug))
  payload.operation_id = operationId
  try {
    await post(`/projects/${slug.value}/video-editor/subtitles/transcribe/${episodeId.value}`, payload)
    freshSubtitleAction.complete(operationId)
    if (episode !== episodeSequence) return
    showInfo(`Fresh transcription for ${sectionSlug} queued — progress shows in Jobs / the bell.`)
  } catch (e: any) {
    if (episode !== episodeSequence) return
    showError(e?.data?.detail || e?.message || 'Could not start re-transcription')
  } finally {
    if (episode === episodeSequence) transcribing.value = false
  }
}

// v1.0.360 — reload + toast ONLY when a transcribe job actually reaches 'done'
// for the current episode. The old `watch(transcribeJobActive)` fired on its
// true→false transition, which ALSO happens when you switch away from an
// episode whose job is still running — producing a false "Transcription
// finished" toast and an unnecessary reload. Tracking job ids keyed off a
// shallow signal (not a deep watch) avoids that and the UI-thread churn.
const seenDoneTranscribes = new Set<string>()
const transcribeJobSignal = computed(() =>
  (jobs.value as any[])
    .filter(j => j.type === 'subtitles_transcribe' && j.project_slug === slug.value)
    .map(j => `${j.job_id}:${j.status}`)
    .join('|'),
)
watch(transcribeJobSignal, () => {
  for (const j of jobs.value as any[]) {
    if (j.type === 'subtitles_transcribe' && j.status === 'done'
        && j.project_slug === slug.value && !seenDoneTranscribes.has(j.job_id)) {
      seenDoneTranscribes.add(j.job_id)
      if (j.episode_id === episodeId.value) {
        void loadStatus()
        success('Transcription finished — subtitle status updated.')
      }
    }
  }
})

async function importSrt(): Promise<void> {
  if (importing.value || !importPath.value || !episodeId.value) return
  const episode = episodeSequence
  importing.value = true
  try {
    const r = await post<{ cues: number }>(`/projects/${slug.value}/video-editor/subtitles/import/${episodeId.value}`, { source_path: importPath.value })
    if (episode !== episodeSequence) return
    success(`Imported subtitle (${r.cues} cue${r.cues === 1 ? '' : 's'}).`)
    importPath.value = ''
    await loadStatus()
  } catch (e: any) {
    if (episode !== episodeSequence) return
    showError(e?.data?.detail || e?.message || 'Import failed')
  } finally {
    if (episode === episodeSequence) importing.value = false
  }
}

async function deleteSrt(filename: string): Promise<void> {
  const episode = episodeSequence
  if (!await useConfirm().ask({ title: 'Remove subtitle file?', message: `Remove ${filename}? It moves to this project's _trash folder, so you can put it back from Finder.`, confirmLabel: 'Remove', danger: true })) return
  if (episode !== episodeSequence) return
  try {
    const r = await del<{ existing_srts: ExistingSrt[] }>(`/projects/${slug.value}/video-editor/subtitles/${episodeId.value}/${encodeURIComponent(filename)}`)
    if (episode !== episodeSequence) return
    // Reload the full status rather than adopting the DELETE response. That
    // response carries a NARROWER row than the status endpoint — only
    // `{ path, filename, mtime }`, without `word_timings` or `quality` — so
    // swapping it in stripped the "garbled text" tag, the quality panel, the
    // chapter-level garbled marker and the word-timings explainer from every
    // REMAINING file. That is a false "all clean" on the one signal that flags a
    // hallucinated transcript, and it lasted until a full reload. `r` is unused
    // now on purpose: the list it returns is not the list this page renders.
    void r
    await loadStatus()
    if (episode !== episodeSequence) return
    if (previewFilename.value === filename) closePreview()
    success(`Moved ${filename} to the project's _trash folder`)
  } catch (e: any) {
    if (episode !== episodeSequence) return
    showError(e?.data?.detail || e?.message || 'Delete failed')
  }
}

// ── Presets ─────────────────────────────────────────────────────────────────
// GenStudio model + re-run flag are saved as named presets via the top bar,
// same pattern as the other generator tabs — so the user's pick persists and
// is shareable, instead of a hidden per-machine localStorage value. Distinct
// configKey from Video Assembly's 'subtitles' (subtitle-STYLE) presets.
const subtitlesPresets = usePresets<{ model?: string; language?: string; force?: boolean; method?: 'script' }>({
  slug: slug.value,
  configKey: 'subtitles_generator',
  snapshot: () => ({ model: genstudioModel.value, language: language.value, force: force.value,
    ...(subtitleMethod.value === 'script' ? { method: 'script' as const } : {}) }),
  apply: (d) => {
    subtitleMethod.value = d?.method === 'script' ? 'script' : ''
    if (typeof d?.model === 'string' && d.model) genstudioModel.value = d.model
    // The language choice round-trips as-is, including the auto-detect
    // sentinel, so "let the model decide" survives a reload as a decision
    // rather than degrading into a blank field.
    if (typeof d?.language === 'string' && d.language) language.value = d.language
    if (typeof d?.force === 'boolean') force.value = d.force
  },
})

onMounted(async () => {
  // A deep link seeds episodeId before the watcher is registered, so the
  // selector may never emit a change. Load the selected episode once on mount
  // to populate completion and timeline-integrity status immediately.
  await loadStatus()
  // Auto-apply the model/re-run preset, then heal retired model IDs against the
  // authoritative GenStudio catalog.
  await subtitlesPresets.load()
  await loadGenstudioModels()
})
</script>

<style scoped>
.word-timing-tag {
  font-size: var(--font-xs);
  letter-spacing: 0.02em;
  padding: 1px 6px;
  border-radius: 999px;
  white-space: nowrap;
  flex: 0 0 auto;
}
.word-timing-tag:empty { display: none; }
.wt-banked { background: color-mix(in srgb, var(--accent) 22%, transparent); color: var(--text-primary); }
.wt-none { background: color-mix(in srgb, var(--text-secondary) 18%, transparent); color: var(--text-secondary); }
.wt-unknown { display: none; }

/* v1.2.2 — garbled-text marker. Same pill shape as the word-timing tags so it
   reads as one family of file facts, tinted with the shared warning token
   rather than a new colour invented for this feature. */
.garbled-tag {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--warning) 22%, transparent);
  color: var(--text-primary);
  font-size: var(--font-xs);
  white-space: nowrap;
}
.audio-quality-link {
  flex: 0 0 auto;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-weight: 650;
  text-decoration: none;
  white-space: nowrap;
}
.audio-quality-link.tone-info { color: var(--accent); }
.audio-quality-link.tone-success { color: rgb(22, 163, 74); }
.audio-quality-link.tone-warning { color: rgb(202, 138, 4); }
.audio-quality-link:hover { border-color: currentColor; }
.sub-file-quality { padding: 0 8px 10px; border-bottom: 1px solid var(--border); }
.sub-file-quality:last-child { border-bottom: none; }

.inline-link { color: var(--accent); text-decoration: underline; }
.inline-link:hover { text-decoration: none; }

.sub-coverage { display: flex; align-items: center; gap: 10px; }
.sub-coverage-bar { flex: 0 0 140px; height: 8px; border-radius: 999px; background: var(--bg-tertiary); overflow: hidden; }
.sub-coverage-fill { display: block; height: 100%; background: rgb(74, 222, 128); transition: width 0.2s; }

.sub-gap-notice :deep(.workspace-notice-actions) { grid-column: 2 / -1; flex-wrap: wrap; align-items: flex-start; }
.sub-gap-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.sub-gap-list strong { display: inline; }
.sub-gap-list { margin: 8px 0 0; padding-left: 18px; font-size: var(--font-xs); }
.sub-gap-audio { margin-top: 2px; font-weight: 600; }
.sub-gap-audio.is-silent { color: var(--error, var(--warning)); }
.sub-gap-hint { flex-basis: 100%; margin: 0; }
.sub-selection-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; position: sticky; top: 0; z-index: 2; padding: 12px 8px; background: var(--bg-secondary); border-bottom: 1px solid var(--border); }
.sub-chapter-row { flex-wrap: wrap; }
.sub-chapter-list, .sub-file-list { list-style: none; margin: 0; padding: 0; }
.sub-chapter-row, .sub-file-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-bottom: 1px solid var(--border); font-size: 13px; }
.sub-chapter-row:last-child, .sub-file-row:last-child { border-bottom: none; }
.sub-chapter-mark { width: 16px; text-align: center; color: var(--text-muted); }
.sub-chapter-mark.ok { color: rgb(34, 197, 94); }
.sub-chapter-mark.stale { color: rgb(202, 138, 4); font-weight: 700; }
.sub-chapter-name { flex: 1; color: var(--text-primary); }
.sub-chapter-action { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 6px; color: var(--text-muted); font-size: var(--font-xs); }

@media (max-width: 640px) {
  .sub-chapter-row { flex-wrap: wrap; }
  .sub-chapter-action { flex: 1 0 100%; justify-content: flex-start; padding-left: 26px; }
}

.sub-method { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 10px 0; border-top: 1px solid var(--border); }
.sub-method:first-of-type { border-top: none; }
.sub-method-import { flex: 1; }

.sub-file-name { flex: 1; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.sub-dir { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--font-xs); word-break: break-all; }

/* Subtitle cue preview (v1.0.494/495) — panel styles live in SubtitleCuePreview.vue. */
.btn-icon.active { color: var(--accent); }
.sub-missing-sentences { margin: 4px 0 6px 18px; font-size: 12px; line-height: 1.5; }
</style>
