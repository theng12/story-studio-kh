<template>
  <div class="dashboard-layout">
    <!-- Skip link for keyboard users — appears on focus, lets them jump past the sidebar nav -->
    <a href="#main-content" class="skip-link">Skip to main content</a>

    <!-- Top bar: draggable area reserving space for macOS traffic lights,
         with a no-drag actions cluster on the right for the notification
         bell. The drag region flexes to fill the gap so the window stays
         draggable everywhere except over the bell. -->
    <header class="top-bar">
      <!-- v1.0.366 — hamburger for narrow screens (iPad/phone). Hidden ≥900px via CSS. -->
      <button class="menu-toggle" aria-label="Open navigation" @click="mobileNavOpen = true">&#9776;</button>
      <div class="titlebar-drag"></div>
      <div class="top-bar-actions">
        <NotificationCenter v-if="slug" :slug="slug" />
      </div>
    </header>
    <FfmpegSetupDialog />
    <div class="layout-body">
    <div v-if="mobileNavOpen" class="sidebar-overlay" @click="mobileNavOpen = false" />
    <aside class="sidebar" :class="{ 'mobile-open': mobileNavOpen }">
      <div class="sidebar-brand">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="var(--accent)" stroke-width="1.5" />
          <path d="M15.5 12a5.5 5.5 0 01-9 4.24A7 7 0 0012 5a5.5 5.5 0 013.5 7z" fill="var(--accent)" opacity="0.6" />
        </svg>
        <div>
          <div class="brand-name">Story Studio KH</div>
          <div class="project-name">{{ project?.name || 'Loading...' }}</div>
        </div>
      </div>

      <nav class="sidebar-nav">
        <NuxtLink :to="`/projects/${slug}`" class="nav-item" exact-active-class="active">
          <span class="nav-icon">&#9776;</span> Dashboard
        </NuxtLink>
        <NuxtLink :to="`/projects/${slug}/ideas`" class="nav-item" active-class="active">
          <span class="nav-icon">&#10024;</span> Ideas Generator
        </NuxtLink>
        <NuxtLink :to="`/projects/${slug}/pipeline`" class="nav-item" active-class="active">
          <span class="nav-icon">&#9881;</span> Pipeline
        </NuxtLink>
        <!-- v1.0.341 — Production Board: episodes × steps status grid. The
             episode-centric overview ("where is EP0042?") to complement the
             tool-centric generator pages. -->
        <NuxtLink :to="`/projects/${slug}/board`" class="nav-item" active-class="active" title="Every episode × every pipeline step at a glance — see what's done, what's pending, and jump straight to any step for any episode.">
          <span class="nav-icon">&#9783;</span> Production Board
        </NuxtLink>

        <div class="nav-divider" />
        <div class="nav-section-label">Generators</div>
        <!-- v1.0.141+ — Research page comes BEFORE Script Generator
             for the timestamp-driven pipeline; it produces a citations
             sidecar the script generator can consume. Hidden for
             scene-images / broll pipelines (those don't have a
             research phase today). Real content lands in 1.0.142. -->
        <NuxtLink
          v-if="isTimestampDriven || isContinuityChain || isNarratedScenes"
          :to="`/projects/${slug}/research`"
          class="nav-item"
          active-class="active"
          title="Research + fact-checking phase. Produces a citations sidecar the script generator consumes. Optional — handy when the niche is factual."
        >
          <span class="nav-icon">&#128270;</span> Research
        </NuxtLink>
        <NuxtLink :to="`/projects/${slug}/cowriter`" class="nav-item" active-class="active" title="Chat with the app's LLM to develop an idea, outline, or full script — then send it straight into the pipeline.">
          <span class="nav-icon">&#128172;</span> Co-writer
        </NuxtLink>
        <NuxtLink :to="`/projects/${slug}/scripts`" class="nav-item" active-class="active">
          <span class="nav-icon">&#128221;</span> Script Generator <span v-if="scriptGenerating" class="nav-pulse" />
        </NuxtLink>
        <NuxtLink :to="`/projects/${slug}/metadata`" class="nav-item" active-class="active">
          <span class="nav-icon">&#128203;</span> Metadata Generator <span v-if="metaGenerating" class="nav-pulse" />
        </NuxtLink>
        <!-- v1.0.88+: prompt generation split into two sidebar entries that
             both open /image-prompts but pre-select the corresponding tab
             via ?tab=. Active highlighting is computed manually because
             NuxtLink's active-class matches paths, not query strings —
             two entries point at the same path with different query
             values, so we need to disambiguate. Default tab when no
             query is set is 'thumbnails' (matches the page's own default
             from v1.0.87). -->
        <NuxtLink
          :to="`/projects/${slug}/image-prompts?tab=thumbnails`"
          :class="['nav-item', { active: isImagePromptsActive('thumbnails') }]"
        >
          <span class="nav-icon">&#128173;</span> Thumbnail Prompts <span v-if="thumbPromptGenerating" class="nav-pulse" />
        </NuxtLink>
        <!-- Scene Prompts hidden for B-Roll-driven formats (prayer /
             devotional / narration-over-stock). Those formats render
             video from the B-Roll pool instead of per-scene AI stills,
             so this generator is irrelevant. -->
        <NuxtLink
          v-if="!hidesScenePages"
          :to="`/projects/${slug}/image-prompts?tab=scenes`"
          :class="['nav-item', { active: isImagePromptsActive('scenes') }]"
        >
          <span class="nav-icon">&#128172;</span> Scene Prompts <span v-if="promptGenerating" class="nav-pulse" />
        </NuxtLink>
        <NuxtLink
          :to="`/projects/${slug}/images?tab=thumbnails`"
          :class="['nav-item', { active: isImagesActive('thumbnails') }]"
        >
          <span class="nav-icon">&#128444;</span> Thumbnail Generator <span v-if="thumbImageGenerating" class="nav-pulse" />
        </NuxtLink>
        <NuxtLink
          v-if="!hidesScenePages"
          :to="`/projects/${slug}/images?tab=scenes`"
          :class="['nav-item', { active: isImagesActive('scenes') }]"
        >
          <span class="nav-icon">&#127912;</span> Scene Generator <span v-if="imageGenerating" class="nav-pulse" />
        </NuxtLink>
        <!-- Video Generator hidden for B-Roll formats — that pipeline
             generates AI video for scene images, and broll projects don't
             have scenes. v1.0.115+ moved B-Roll *Video Assembly* into the
             single Video Assembly entry below (with tabs). -->
        <NuxtLink
          v-if="!hidesScenePages"
          :to="`/projects/${slug}/video`"
          class="nav-item"
          active-class="active"
        >
          <span class="nav-icon">&#128249;</span> Video Generator <span v-if="videoGenerating" class="nav-pulse" />
        </NuxtLink>
        <NuxtLink :to="`/projects/${slug}/audio`" class="nav-item" active-class="active">
          <span class="nav-icon">&#127897;</span> Audio Generator <span v-if="audioGenerating" class="nav-pulse" />
        </NuxtLink>

        <div class="nav-divider" />
        <div class="nav-section-label">Assembly</div>
        <NuxtLink :to="`/projects/${slug}/audio-merge`" class="nav-item" active-class="active">
          <span class="nav-icon">&#128266;</span> Audio Assembly <span v-if="audioMergeGenerating" class="nav-pulse" />
        </NuxtLink>
        <!-- v1.0.216+ — Subtitles workshop. Creates the episode's subtitle
             track (per-chapter Whisper / from-chapters / import) from the
             chapter audio. Sits after Audio Assembly; Scene Plan stitches its
             per-chapter SRTs and Video Assembly burns them in. -->
        <NuxtLink :to="`/projects/${slug}/subtitles`" class="nav-item" active-class="active" title="Create the episode's subtitles (per-chapter Whisper, from chapters, or import). Built from chapter audio; consumed by Scene Plan + Video Assembly.">
          <span class="nav-icon">&#128292;</span> Subtitles
        </NuxtLink>
        <!-- v1.0.187+ — Character Sheet: continuity-chain (hard img2img lock)
             and (v1.0.301) narrated-scenes (OPTIONAL — guidance + prompt /
             negative-prompt control, not a hard lock). Drop in the anchor
             image (+ optional Characters) before planning/rendering scenes. -->
        <NuxtLink
          v-if="isContinuityChain || isNarratedScenes"
          :to="`/projects/${slug}/character-sheet`"
          class="nav-item"
          active-class="active"
          title="Drop in the character sheet that anchors every scene's look, plus any project Characters to keep on screen."
        >
          <span class="nav-icon">&#127917;</span> Character Sheet
        </NuxtLink>
        <!-- v1.0.141+ — Scene Plan + Scene Review sit between Audio
             Assembly (audio + stitched subtitle land here) and Video
             Assembly (final render). Both show for the audio-paced
             pipelines (timestamp-driven + continuity-chain, v1.0.187+);
             scene-images and broll skip straight to Video Assembly. -->
        <NuxtLink
          v-if="usesScenePlan"
          :to="`/projects/${slug}/scene-plan`"
          class="nav-item"
          active-class="active"
          title="Plan scenes against the stitched audio timeline — LLM picks natural beats from the script + merged subtitle."
        >
          <span class="nav-icon">&#128218;</span> Scene Plan
        </NuxtLink>
        <NuxtLink
          v-if="usesScenePlan"
          :to="`/projects/${slug}/scene-review`"
          class="nav-item"
          active-class="active"
          title="Per-scene preview against transcript + audio. Approve scenes before final assembly is allowed."
        >
          <span class="nav-icon">&#9989;</span> Scene Review
        </NuxtLink>
        <!-- v1.0.346 — Video Assembly always opens the full editor. Audio-paced
             projects can still use the fast timestamp renderer from the
             Timestamps tab inside the editor area, but the main nav should not
             strand them on the simplified assembler when they need timeline,
             effects, filters, and subtitle controls. -->
        <NuxtLink
          :to="`/projects/${slug}/video-assembly`"
          class="nav-item"
          active-class="active"
        >
          <span class="nav-icon">&#127902;</span> Video Assembly
        </NuxtLink>

        <div class="nav-divider" />
        <div class="nav-section-label">Upload Center</div>
        <NuxtLink :to="`/projects/${slug}/upload`" class="nav-item" active-class="active" title="YouTube Upload — connect a channel, queue episodes, schedule via publishAt.">
          <span class="nav-icon">&#9654;</span> YouTube Upload
        </NuxtLink>
        <!-- v1.0.163 — TikTok + Facebook upload entries removed.
             The pages were 41-line "Coming in v2" stubs cluttering the
             sidebar. When real work on either platform starts, add the
             entry back as part of that implementation task. -->

        <div class="nav-divider" />
        <div class="nav-section-label">Library</div>
        <NuxtLink :to="`/projects/${slug}/characters`" class="nav-item" active-class="active" title="Persistent cast for this project — episode-scoped or project-wide. Used by script + image generation to keep names and looks consistent.">
          <span class="nav-icon">&#128100;</span> Characters
        </NuxtLink>
        <NuxtLink :to="`/projects/${slug}/presets`" class="nav-item" active-class="active" title="Manage every saved preset in this project — rename, duplicate, export, delete.">
          <span class="nav-icon">&#128194;</span> Presets
        </NuxtLink>
        <NuxtLink :to="`/projects/${slug}/assets`" class="nav-item" active-class="active" title="Audit every episode's assets and one-click repair provider-completed jobs that didn't persist locally.">
          <span class="nav-icon">&#128193;</span> Assets
        </NuxtLink>

        <div class="nav-divider" />
        <NuxtLink :to="`/projects/${slug}/jobs`" class="nav-item" active-class="active">
          <span class="nav-icon">&#9881;</span> Jobs
          <span v-if="stats.running + stats.queued > 0" class="nav-badge">{{ stats.running + stats.queued }}</span>
        </NuxtLink>
        <NuxtLink :to="`/projects/${slug}/settings`" class="nav-item" active-class="active" title="Everything for this project AND this Mac — API keys, appearance, models, voices, folders. Grouped into ‘This Mac’ vs ‘This Project’ zones.">
          <span class="nav-icon">&#9881;</span> Settings
        </NuxtLink>
        <!-- v1.0.186 (S3) — the standalone "App Settings" button was retired.
             Its contents (API keys, appearance, server mode) now live in the
             Settings page under the "This Mac" zone, so a single "Settings"
             entry is the one front door. The modal still exists for the
             all-projects index, where no project Settings page is available. -->
        <NuxtLink to="/character-library" class="nav-item" active-class="active" title="App-level character library shared across all projects on this machine. Save characters here to reuse across channels.">
          <span class="nav-icon">&#127991;</span> Character Library
        </NuxtLink>
        <NuxtLink to="/broll-library" class="nav-item" active-class="active" title="App-level B-Roll pool library. Register a folder (typically your portable SSD) holding stock footage clips. Indexes, thumbnails, tags, and optional 1080p normalize for fast video assembly.">
          <span class="nav-icon">&#127909;</span> B-Roll Library
        </NuxtLink>
        <!-- v1.0.96+ — Niches sidebar link removed. The full niche library
             (browse / create custom / delete custom) now lives inside each
             project's Settings → Niche tab as a sub-tab. One place for
             niche stuff instead of two. -->
        <NuxtLink to="/" class="nav-item">
          <span class="nav-icon">&#8592;</span> All Projects
        </NuxtLink>
      </nav>

      <div class="sidebar-credits">
        <div class="credits-refresh-row" :title="`Balances auto-refresh every ${Math.round(pollIntervalMs / 1000)}s. Click ↻ to refresh now.`">
          <button
            type="button"
            class="refresh-btn"
            :class="{ spinning: isRefreshing }"
            :disabled="isRefreshing"
            aria-label="Refresh balances now"
            title="Refresh all provider balances now"
            @click="refreshNow"
          >↻</button>
          <span class="countdown-label">
            <template v-if="isRefreshing">refreshing…</template>
            <template v-else>refresh in {{ Math.max(1, Math.ceil(nextRefreshInMs / 1000)) }}s</template>
          </span>
        </div>
        <div
          class="network-status"
          :class="[networkOnline ? 'online' : 'offline', { 'queue-warn': networkQueueSyncFailed }]"
          :title="networkQueueSyncFailed
            ? 'Queue pause/resume command failed — backend may not have honoured the state. Retrying automatically.'
            : (networkOnline ? 'App engine reachable — jobs run normally' : 'Can\'t reach the app engine — new jobs will wait until it\'s back')"
        >
          <span class="network-dot" />
          <span class="network-label">{{ networkOnline ? 'Online' : 'Offline' }}</span>
          <span v-if="networkQueueSyncFailed" class="network-warn" aria-label="Queue state out of sync">⚠</span>
        </div>
        <div v-if="apiKeys.openai" class="credit-badge">
          <span class="credit-label">OpenAI</span>
          <span class="credit-value">~${{ openaiUsage.toFixed(2) }}</span>
        </div>
        <div v-if="apiKeys.kie" class="credit-badge">
          <span class="credit-label">kie.ai</span>
          <span class="credit-value">{{ kieCredits ?? '...' }}</span>
        </div>
        <div v-if="apiKeys.fal" class="credit-badge">
          <span class="credit-label">fal.ai</span>
          <span class="credit-value">{{ typeof falBalance === 'number' ? `$${falBalance.toFixed(2)}` : (falBalance ?? '...') }}</span>
        </div>
        <div v-if="apiKeys.elevenlabs" class="credit-badge" :title="elevenLabsBalance ? `${elevenLabsBalance.tier} — ${elevenLabsBalance.character_count.toLocaleString()} / ${elevenLabsBalance.character_limit.toLocaleString()} chars used` : undefined">
          <span class="credit-label">ElevenLabs</span>
          <span class="credit-value">{{ elevenLabsBalance ? `${formatChars(elevenLabsBalance.remaining)} left` : '...' }}</span>
        </div>
        <div v-if="apiKeys.genaipro" class="credit-badge" title="GenAIPro credits — used by TTS generation">
          <span class="credit-label">GenAIPro</span>
          <span class="credit-value">{{ genaiproBalance !== null ? genaiproBalance.toLocaleString() : '...' }}</span>
        </div>
        <!-- App version + build date — beta testers can quote this when
             reporting an issue. Click to copy. Read at frontend build time
             from the root package.json (see runtimeConfig in nuxt.config.ts).
             v1.0.77 — paired with a "What's new?" affordance that opens the
             changelog modal so users can review release notes on demand. -->
        <div class="version-row">
          <button
            type="button"
            class="version-badge"
            :title="`Story Studio KH v${appVersion} · built ${buildDate} — click to copy`"
            @click="copyVersion"
          >
            v{{ appVersion }}
            <span class="version-build">· {{ buildDate }}</span>
            <span v-if="versionCopied" class="version-copied" aria-live="polite">copied</span>
          </button>
          <button
            type="button"
            class="whats-new-link"
            title="What's new in this release?"
            @click="openWhatsNew"
          >What's new?</button>
        </div>
      </div>
    </aside>

    <main id="main-content" class="main-content" tabindex="-1">
      <!-- (Removed: foreign-provenance + decrypt-failed credential banners.
           API keys now live app-level (per-machine, never synced), so the
           cross-machine "credentials came from a different machine"
           condition can't arise. See app-secrets-store.ts. -->

      <!-- Asset-migration recovery banner — only fires when this
           project's metadata appears to live in iCloud (or somewhere
           syncable) but its `output_root` points at an external,
           non-syncing path. That's the half-migrated state from
           pre-v1.0.13 Storage moves: cross-Mac sync would carry the
           metadata but render against missing assets. The banner
           directs the operator to Settings → Project tab where the
           Move asset location button runs the per-project migrator. -->
      <div
        v-if="assetMigration.status.value && assetMigration.status.value.needed && assetMigration.isProbablyUnsynced()"
        class="foreign-secrets-banner asset-migration-banner"
        role="alert"
      >
        <span class="foreign-secrets-icon" aria-hidden="true">☁️</span>
        <span class="foreign-secrets-text">
          <strong>This project's assets weren't moved with the metadata.</strong>
          Metadata lives in the synced projects folder, but assets are still at
          <code class="inline-code">{{ assetMigration.status.value.current_output_root }}</code>
          — they won't sync to your other Mac.
          Open
          <NuxtLink :to="`/projects/${slug}/settings`" class="inline-link">Settings → Project</NuxtLink>
          and click <strong>Move asset location</strong> to co-locate them.
          ({{ formatBytes(assetMigration.status.value.estimated_bytes || 0) }} across
          {{ assetMigration.status.value.estimated_files || 0 }} file(s).)
        </span>
      </div>
      <!-- v1.0.100+ Auto-dismissing unclean-shutdown banner.
           Was a sticky banner that hung around until the user manually
           clicked ✕ on every launch following a crash; visible at the
           top of every navigation. Now: shows for 30 seconds with a
           visible countdown bar, then quietly persists the dismissal
           and disappears. Manual ✕ still works for immediate dismissal.
           If the app crashes AGAIN, a fresh unclean_shutdown flag is
           set and the banner returns — that's the only way it comes
           back. -->
      <div
        v-if="uncleanShutdown"
        class="unclean-shutdown-banner"
        role="status"
        aria-live="polite"
      >
        <span class="unclean-shutdown-icon" aria-hidden="true">⚠️</span>
        <span class="unclean-shutdown-text">
          <strong>Story Studio quit unexpectedly last time.</strong>
          Some jobs may not have finished — review them in
          <NuxtLink :to="`/projects/${slug}/jobs`" class="unclean-shutdown-link">Jobs</NuxtLink>.
        </span>
        <span
          class="unclean-shutdown-timer"
          :title="`Auto-dismissing in ${uncleanShutdownSecondsLeft}s`"
          aria-hidden="true"
        >{{ uncleanShutdownSecondsLeft }}s</span>
        <button
          type="button"
          class="unclean-shutdown-dismiss"
          title="Dismiss now"
          aria-label="Dismiss unclean-shutdown banner"
          @click="dismissUncleanShutdown"
        >✕</button>
        <div
          class="unclean-shutdown-progress"
          :style="{ width: `${uncleanShutdownProgressPct}%` }"
          aria-hidden="true"
        />
      </div>
      <div
        v-if="restoredChip"
        class="restored-chip"
        role="status"
        aria-live="polite"
      >
        <span class="restored-chip-icon" aria-hidden="true">↩</span>
        <span class="restored-chip-text">Resumed where you left off</span>
        <button
          type="button"
          class="restored-chip-action"
          @click="returnToProjectList"
        >Return to project list</button>
        <button
          type="button"
          class="restored-chip-dismiss"
          title="Dismiss"
          aria-label="Dismiss restored chip"
          @click="restoredChip = false"
        >✕</button>
      </div>
      <!-- v1.0.169 — Format-aware production flow ribbon. Renders the full
           creation chain for this project's format (resolved into
           `visualSource` above) with the current page highlighted, so the
           user always sees where they are + what's next. Only shows on
           project pages (slug present). -->
      <FlowRibbon v-if="slug" :slug="slug" :visual-source="visualSource" />
      <!-- v1.0.280+ — surface a clear prompt when a project has no niche, so
           the user doesn't get silently-generic output. Niche is now the
           primary content/voice layer. -->
      <NicheMissingBanner v-if="slug" :slug="slug" :niche-id="project?.niche_id" />
      <slot />
    </main>
    </div><!-- /.layout-body -->
  </div>
</template>

<script setup lang="ts">
import { normalizeVisualSource, type VisualSource } from '~/composables/useProjectFlow'

const route = useRoute()
const slug = computed(() => route.params.slug as string)

// v1.0.366 — mobile/touch: the sidebar becomes an off-canvas drawer below 900px.
// Closes on navigation so tapping a nav item doesn't leave the drawer open.
const mobileNavOpen = ref(false)
watch(() => route.fullPath, () => { mobileNavOpen.value = false })

// v1.0.88+: helpers for the four split image-prompts/images sidebar
// entries. Each pair points at the same URL path with a different
// ?tab= query value, so NuxtLink's path-based active-class can't
// disambiguate them. These helpers check both: the current route's
// path must match AND the tab query (defaulting to 'thumbnails' to
// match the pages' own defaults) must match the requested tab.
function isImagePromptsActive(tab: 'thumbnails' | 'scenes'): boolean {
  if (!route.path.endsWith('/image-prompts')) return false
  const q = String(route.query.tab || 'thumbnails')
  return q === tab
}
function isImagesActive(tab: 'thumbnails' | 'scenes'): boolean {
  if (!route.path.endsWith('/images')) return false
  const q = String(route.query.tab || 'thumbnails')
  return q === tab
}

const { project, loadProject } = useProject()
const { jobs, stats, startPolling: startJobPolling, stopPolling: stopJobPolling } = useJobs()
// Notification-center readiness checks (upload dest / API keys / FFmpeg).
// Refreshed per project below; the bell lives in the top bar.
const { refreshReadiness } = useNotifications()

// v1.0.89+: format-aware sidebar. B-Roll-driven formats (prayer /
// devotional / narration over stock footage) hide scene/thumbnail-prompt
// + scene/thumbnail-generator pages and surface a B-Roll Picker entry
// instead. Fetched lazily — the layout doesn't block on this; if it
// hasn't resolved yet we show the default set, which is correct for
// every existing format.
// Reuses the `apiGet` declared further down in this script-setup block
// (line ~423: const { get: apiGet, patch: apiPatch, del: apiDel } = useApi()).
// Vue script-setup hoists const declarations, so referencing it before
// its textual position is safe at runtime. A duplicate `const { get: apiGet } = useApi()`
// here passed tsx-watch but failed Vite's prod build with "Identifier
// already declared" — removed in v1.0.89.
// v1.0.141+ — `visualSource` now has three possible values. The
// timestamp-driven pipeline adds Research / Scene Plan / Scene Review
// pages and hides the same scene-prompts / scene-generator / video-
// generator entries that the broll pipeline hides (those don't apply
// when visuals are placed against the audio timeline rather than
// pre-planned). isBroll + isTimestampDriven are mutually exclusive
// flags driven off the same source so templates can branch cleanly.
// v1.0.280+ — the unified `scenes` format reports visualSource 'scene-images'
// and chooses its pacing via `sceneAlignment` ('sentence' → audio-paced flow).
// normalizeVisualSource() collapses (visualSource, sceneAlignment) onto the
// existing VS vocabulary so every isX flag below stays unchanged.
type VS = VisualSource
const visualSource = ref<VS>('scene-images')
async function loadVisualSource(): Promise<void> {
  if (!slug.value) return
  try {
    const f = await apiGet<{ visualSource?: string; sceneAlignment?: string }>(`/projects/${slug.value}/effective-format`)
    visualSource.value = normalizeVisualSource(f?.visualSource, f?.sceneAlignment)
  } catch { /* leave as default */ }
}
const isBroll = computed(() => visualSource.value === 'broll')
const isTimestampDriven = computed(() => visualSource.value === 'timestamp-driven')
// v1.0.187+ — continuity-chain extends the timestamp (audio-paced) pipeline:
// it shares Scene Plan / Scene Review / Timestamp Assemble and hides the
// scene-prompts/generator pages, but adds a Character Sheet step and has NO
// Research phase.
const isContinuityChain = computed(() => visualSource.value === 'continuity-chain')
// v1.0.300 — narrated-scenes: story/fiction on the audio-paced pipeline.
// Shares Scene Plan / Scene Review / Timestamp Assemble, but NO Research and
// NO Character Sheet (see usesScenePlan; Research + Character Sheet nav stay
// gated on their own flags below, which narrated-scenes deliberately fails).
const isNarratedScenes = computed(() => visualSource.value === 'narrated-scenes')
/** True when the active pipeline plans scenes against the actual audio
 *  timeline (timestamp-driven, continuity-chain, OR narrated-scenes) — these
 *  share the Scene Plan / Scene Review pages and route assembly to
 *  /timestamp-assemble. */
const usesScenePlan = computed(() => isTimestampDriven.value || isContinuityChain.value || isNarratedScenes.value)
/** True when the active pipeline plans scenes against the actual
 *  audio timeline OR pulls them from a B-Roll pool — i.e. NOT the
 *  classic scene-images pipeline. Used by sidebar entries that the
 *  same way for both alternative pipelines (Scene Prompts / Scene
 *  Generator / Video Generator are all hidden when this is true). */
const hidesScenePages = computed(() => isBroll.value || isTimestampDriven.value || isContinuityChain.value || isNarratedScenes.value)
watch(slug, () => { void loadVisualSource() }, { immediate: true })
// v1.0.146+ — also re-fetch the effective format when the project's
// format_id / brand_id / niche_id changes, even while staying on the
// same slug. Without this, switching the project to a different format
// in Settings → Format (or Ideas → Format Overrides) updates the
// merged format on disk but the sidebar stays stuck on whatever the
// visualSource was when the layout first mounted, because the slug
// watcher above only fires on slug change. The Settings tab calls
// loadProject() after saving, so project.value.format_id is reactive
// here; watching it covers every format-mutating UI path.
watch(
  () => [project.value?.format_id, project.value?.brand_id, project.value?.niche_id] as const,
  () => { void loadVisualSource() },
)

// Cross-tab batch-completion signals (toast + title badge). The Electron
// main process owns the native-OS notification path via job-notifier.ts;
// this composable covers the in-window case where the operator is focused
// but on a page other than /jobs. Skipped on /jobs — the banner is the
// durable summary there.
useBatchCompletionSignals(() => jobs.value as any)
const { online: networkOnline, queueSyncFailed: networkQueueSyncFailed } = useNetworkStatus()
const {
  kieCredits, falBalance, elevenLabsBalance, genaiproBalance, openaiUsage, apiKeys,
  isRefreshing, nextRefreshInMs, pollIntervalMs,
  startPolling: startCreditPolling, stopPolling: stopCreditPolling, refreshNow,
} = useCredits()

const charFormatter = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
function formatChars(n: number) {
  return charFormatter.format(n)
}
const {
  scriptGenerating, promptGenerating, thumbPromptGenerating,
  imageGenerating, thumbImageGenerating,
  audioGenerating, audioMergeGenerating, metaGenerating, videoGenerating,
} = useGenerating()

// Cross-machine credential warnings are retired — API keys live app-level
// now, so the "credentials came from a different machine" condition can't
// arise. (See app-secrets-store.ts.)
const assetMigration = useAssetMigration()

/**
 * Compact byte formatter for the recovery banner copy. Mirrors the
 * backend's lib/disk.ts:formatBytes shape so the user reads the same
 * units in both places (e.g. "274 GB" not "274.34 GB"). Defined inline
 * because the layout doesn't otherwise pull in lib/disk.
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  const decimals = i >= 2 ? (value < 10 ? 2 : 0) : 0
  return `${value.toFixed(decimals)} ${units[i]}`
}

watch(slug, async (s) => {
  if (s) {
    await loadProject(s)
    startJobPolling(s)
    startCreditPolling(s)
    // Fire the readiness probes for the notification center. Fail-quiet
    // inside the composable; never blocks project load.
    void refreshReadiness(s)
  }
}, { immediate: true })

// ── Restore-session UI ────────────────────────────────────────────────────
// `restoredChip`: true when we landed here via auto-restore from the home
// page (signalled via sessionStorage in pages/index.vue's onMounted). Local
// to this run — clearing it just hides the chip; it doesn't affect the
// last-session record on disk.
//
// `uncleanShutdown`: read once from /api/last-session on mount. Persists
// across reloads via the dismissed flag on the same record so a refresh
// during the same boot doesn't re-fire the banner.
const { get: apiGet, patch: apiPatch, del: apiDel } = useApi()
const restoredChip = ref(false)
const uncleanShutdown = ref(false)

async function loadSessionUiState() {
  if (typeof sessionStorage !== 'undefined') {
    restoredChip.value = sessionStorage.getItem('story-studio:restored') === '1'
  }
  try {
    const last = await apiGet<{
      unclean_shutdown?: boolean; unclean_shutdown_dismissed?: boolean;
    }>('/last-session')
    uncleanShutdown.value = !!last?.unclean_shutdown && !last?.unclean_shutdown_dismissed
  } catch {
    uncleanShutdown.value = false
  }
}

async function dismissUncleanShutdown() {
  uncleanShutdown.value = false
  if (uncleanShutdownTimer) { clearInterval(uncleanShutdownTimer); uncleanShutdownTimer = null }
  try {
    await apiPatch('/last-session', { unclean_shutdown_dismissed: true })
  } catch {
    // Fail-quiet — worst case the banner re-appears on the next reload.
  }
}

// v1.0.100+ — 30-second auto-dismiss with a visible countdown so the
// banner stops being visually noisy after the initial heads-up. We
// persist the dismissal on auto-fade too (same semantics as the manual
// ✕) so navigating between pages doesn't re-show the banner within the
// same crash-recovery session. A fresh crash sets a new
// unclean_shutdown flag and the banner returns.
const UNCLEAN_SHUTDOWN_AUTO_DISMISS_SECONDS = 30
const uncleanShutdownSecondsLeft = ref(UNCLEAN_SHUTDOWN_AUTO_DISMISS_SECONDS)
const uncleanShutdownProgressPct = computed(() =>
  Math.max(0, Math.min(100, (uncleanShutdownSecondsLeft.value / UNCLEAN_SHUTDOWN_AUTO_DISMISS_SECONDS) * 100)),
)
let uncleanShutdownTimer: ReturnType<typeof setInterval> | null = null

watch(uncleanShutdown, (showing) => {
  // Start the countdown only on the transition false → true. When the
  // banner is dismissed (manually or auto), tear the timer down.
  if (!showing) {
    if (uncleanShutdownTimer) { clearInterval(uncleanShutdownTimer); uncleanShutdownTimer = null }
    return
  }
  uncleanShutdownSecondsLeft.value = UNCLEAN_SHUTDOWN_AUTO_DISMISS_SECONDS
  if (uncleanShutdownTimer) clearInterval(uncleanShutdownTimer)
  uncleanShutdownTimer = setInterval(() => {
    uncleanShutdownSecondsLeft.value -= 1
    if (uncleanShutdownSecondsLeft.value <= 0) {
      // Auto-dismiss: same persistence semantics as the manual ✕.
      void dismissUncleanShutdown()
    }
  }, 1000)
})

onBeforeUnmount(() => {
  if (uncleanShutdownTimer) { clearInterval(uncleanShutdownTimer); uncleanShutdownTimer = null }
})

async function returnToProjectList() {
  restoredChip.value = false
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.removeItem('story-studio:restored')
  }
  try {
    await apiDel('/last-session')
  } catch { /* fail-quiet */ }
  await navigateTo('/')
}

onMounted(loadSessionUiState)

onUnmounted(() => { stopJobPolling(); stopCreditPolling() })

// ── App version + build date ────────────────────────────────────────────
// Read at frontend build time from the root package.json (see
// nuxt.config.ts → runtimeConfig.public). Surfaced in the sidebar footer
// so beta testers can quote a precise version when reporting an issue.
const { public: pubCfg } = useRuntimeConfig()
const appVersion = computed(() => (pubCfg.appVersion as string | undefined) || '0.0.0')
const buildDate = computed(() => (pubCfg.buildDate as string | undefined) || '')
const versionCopied = ref(false)
async function copyVersion() {
  const txt = `Story Studio KH v${appVersion.value} · built ${buildDate.value}`
  try {
    await navigator.clipboard.writeText(txt)
    versionCopied.value = true
    setTimeout(() => { versionCopied.value = false }, 1400)
  } catch {
    // Clipboard API unavailable (rare in Electron renderer); fail-quiet.
  }
}

// v1.0.77 — open the WhatsNewModal on demand from the sidebar link.
import { useWhatsNewModal } from '~/composables/useWhatsNewModal'
const _whatsNew = useWhatsNewModal()
function openWhatsNew() { _whatsNew.open() }
</script>

<style scoped>
/* Vertical flex column: top-bar (titlebar + banner) stacked above layout-body (sidebar + main).
   This makes the banner push content down NATURALLY — no more fixed-position overlap. */
/* Lock the dashboard to viewport height so the page itself never scrolls.
   Only the .main-content pane scrolls its contents — the sidebar stays put. */
.dashboard-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

/* Top bar: sticky so it stays at the top while main area scrolls.
   Holds the draggable titlebar that reserves space for macOS traffic lights. */
.top-bar {
  position: sticky;
  top: 0;
  z-index: 200;
  background: var(--bg-secondary);
  flex-shrink: 0;
  display: flex;
  align-items: stretch;
}

/* Draggable titlebar area — reserves space for macOS traffic lights and lets
   user drag window. Flexes to fill all space left of the actions cluster. */
.titlebar-drag {
  flex: 1;
  height: 38px;
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
}

/* Right-aligned, non-draggable cluster holding the notification bell. */
.top-bar-actions {
  display: flex;
  align-items: center;
  height: 38px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  -webkit-app-region: no-drag;
}

/* v1.0.366 — hamburger + off-canvas sidebar for narrow screens (iPad/phone).
   Desktop (≥900px) is unchanged; the toggle + overlay only appear below it. */
.menu-toggle {
  display: none;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 38px;
  flex-shrink: 0;
  font-size: 20px;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border);
  color: var(--text, inherit);
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.sidebar-overlay { display: none; }
@media (max-width: 900px) {
  .menu-toggle { display: inline-flex; }
  .sidebar {
    position: fixed;
    top: 0; left: 0; bottom: 0;
    width: 264px;
    max-width: 82vw;
    transform: translateX(-100%);
    transition: transform 0.22s ease;
    z-index: 300;
  }
  .sidebar.mobile-open { transform: translateX(0); box-shadow: 0 0 40px rgba(0, 0, 0, 0.5); }
  .sidebar-overlay {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 250;
  }
  .main-content { padding: 16px; }
}

/* Body takes remaining space below top-bar, holds sidebar + main content side-by-side. */
.layout-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* Sidebar is a fixed-height flex column:
   - brand (fixed) at top
   - nav (scrollable, flex: 1) in the middle — this is the ONLY scrolling region
   - credits (fixed) pinned at the bottom
   The `min-height: 0` on .sidebar-nav is what lets overflow:auto take effect inside a flex child. */
.sidebar {
  width: 220px;
  flex-shrink: 0;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  align-self: stretch;
}

.sidebar-brand {
  flex-shrink: 0;
  display: flex; align-items: center; gap: 12px;
  padding: 16px;
  border-bottom: 1px solid var(--border);
}
.brand-name { font-size: 14px; font-weight: 600; color: var(--accent); }
.project-name { font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; }

.sidebar-nav {
  flex: 1;
  padding: 6px;
  /* The two properties the comment block above describes but were never
     actually applied. min-height: 0 lets a flex child shrink below its
     content size; overflow-y: auto then engages a scrollbar instead of
     pushing sidebar-credits off the bottom of the window. Without
     min-height: 0, flex children default to min-content height — which
     is why the whole sidebar grew taller than the window before. */
  min-height: 0;
  overflow-y: auto;
  /* Subtler scrollbar so it doesn't fight the sidebar's flat aesthetic. */
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.sidebar-nav::-webkit-scrollbar { width: 8px; }
.sidebar-nav::-webkit-scrollbar-track { background: transparent; }
.sidebar-nav::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
.sidebar-nav::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

.nav-item {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; border-radius: var(--radius-sm);
  color: var(--text-secondary); font-size: 12.5px;
  transition: all 0.15s; text-decoration: none;
}
.nav-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.nav-item.active { background: var(--accent-dim); color: var(--accent); }
.nav-icon { width: 16px; text-align: center; font-size: 13px; }

.nav-divider-label,
.nav-section-label {
  padding: 10px 10px 4px;
  font-size: 10px; font-weight: 600;
  color: var(--text-muted); text-transform: uppercase;
  letter-spacing: 0.5px;
}

.nav-divider { height: 1px; background: var(--border); margin: 6px 10px; }

.nav-pulse { margin-left: auto; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: pulse 1.2s infinite; }
@keyframes pulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:0.4; transform:scale(0.8); } }

.nav-badge { margin-left: auto; background: var(--accent); color: var(--accent-on); font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 8px; }

.sidebar-credits {
  flex-shrink: 0;                   /* stay pinned at the bottom — never shrinks or scrolls off */
  padding: 10px;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);  /* opaque so nav content behind it never bleeds through */
  display: flex; flex-direction: column; gap: 4px;
}
.credit-badge { display: flex; justify-content: space-between; font-size: 10px; }
.credit-label { color: var(--text-muted); }
.credit-value { color: var(--accent); font-weight: 500; }

/* Version badge — last item in the sidebar credits column.
   Click to copy "Story Studio KH v1.0.11 · built 2026-04-27" so beta
   testers can paste it into a bug report. Always visible. */
.version-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 0 0;
  margin-top: 2px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 10px;
  text-align: left;
  cursor: pointer;
  border-top: 1px dashed var(--border);
  width: 100%;
}
.version-badge:hover { color: var(--text-secondary); }
.version-build { opacity: 0.7; }
.version-copied {
  margin-left: auto;
  color: var(--accent);
  font-weight: 500;
}

/* v1.0.77 — paired version badge + What's-new link. */
.version-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border-top: 1px dashed var(--border);
}
.version-row .version-badge { border-top: none; flex: 1; }
.whats-new-link {
  background: transparent;
  border: none;
  color: var(--accent);
  font-family: inherit;
  font-size: 10px;
  cursor: pointer;
  padding: 4px 0 0;
  text-decoration: none;
  white-space: nowrap;
}
.whats-new-link:hover { color: var(--accent-hover); text-decoration: underline; }

.credits-refresh-row {
  display: flex; align-items: center; gap: 6px;
  font-size: 10px;
  margin-bottom: 4px;
}
.refresh-btn {
  width: 18px; height: 18px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px; line-height: 1;
  padding: 0;
  transition: color 0.15s, background 0.15s;
}
.refresh-btn:hover:not(:disabled) { color: var(--accent); background: var(--bg-hover); }
.refresh-btn:disabled { cursor: default; opacity: 0.7; }
.refresh-btn.spinning { animation: creditSpin 0.7s linear infinite; }
@keyframes creditSpin { to { transform: rotate(360deg); } }
.countdown-label {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.network-status {
  display: flex; align-items: center; gap: 6px;
  font-size: 10px; padding: 2px 0; margin-bottom: 4px;
}
.network-dot {
  width: 8px; height: 8px; border-radius: 50%;
  transition: background 0.2s;
}
.network-status.online .network-dot {
  background: #22c55e;
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.6);
}
.network-status.offline .network-dot {
  background: #f87171;
  animation: networkPulse 1.5s ease-in-out infinite;
}
.network-status.online .network-label { color: #22c55e; }
.network-status.offline .network-label { color: #f87171; font-weight: 600; }
.network-status .network-warn {
  margin-left: 4px;
  font-size: 11px;
  color: #fbbf24;
}
@keyframes networkPulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 4px rgba(248, 113, 113, 0.5); }
  50% { opacity: 0.5; box-shadow: 0 0 10px rgba(248, 113, 113, 0.8); }
}

.main-content {
  flex: 1;
  width: 100%;
  padding: 32px;
  /* v1.0.103+ — was `padding-top: 0` which let any first-child banner
     (asset-migration, unclean-shutdown, restored-chip) sit at y=0,
     where the Electron `titleBarStyle: 'hiddenInset'` traffic lights
     overlap content. The unclean-shutdown banner in particular got
     its top edge clipped because `margin-top: 16px` put it at y=16 —
     right under the traffic-light row (which sits at y=16 per
     `trafficLightPosition` in electron/main.ts).
     16px clears the traffic-light row (≈22px bottom edge) plus the
     banner's own 16px margin-top = banner at y=32, with ~10px of
     breathing room. Page titles without a leading banner also get
     a slight +16px nudge down, which reads better aesthetically
     against the chrome anyway. */
  padding-top: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

/* Foreign-provenance secrets banner — surfaces when secrets.json was
   encrypted on a different machine (user copied the project folder
   manually). Stale OAuth tokens could upload to the wrong channel if
   reactivated, so the banner is louder than informational. */
.foreign-secrets-banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 16px 0 8px;
  padding: 12px 14px;
  background: var(--bg-secondary);
  border: 1px solid #dc2626;
  border-left: 3px solid #dc2626;
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-secondary);
}
.foreign-secrets-icon { font-size: 15px; line-height: 1.2; flex-shrink: 0; }
.foreign-secrets-text { flex: 1; line-height: 1.5; }
.foreign-secrets-text strong { color: var(--text-primary); display: block; margin-bottom: 2px; }
.foreign-secrets-reset {
  background: #dc2626;
  border: none;
  color: #fff;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}
.foreign-secrets-reset:hover:not(:disabled) { background: #b91c1c; }
.foreign-secrets-reset:disabled { opacity: 0.6; cursor: wait; }

/* Decrypt-failed banner reuses the foreign banner's layout but in a calmer
   amber palette — this is recoverable (just re-enter keys) rather than a
   security-critical "different machine" warning. */
.secrets-decrypt-banner {
  background: rgba(245, 158, 11, 0.10);
  border-color: rgba(245, 158, 11, 0.4);
}
.secrets-decrypt-banner .foreign-secrets-icon { color: rgb(180, 83, 9); }
.inline-link { color: var(--accent); text-decoration: underline; }
.inline-link:hover { text-decoration: none; }

/* Asset-migration recovery banner — sky-blue accent so the user reads
   it as "iCloud-sync issue" distinct from the keys-related amber and
   the security-red foreign-machine variants. */
.asset-migration-banner {
  background: rgba(56, 189, 248, 0.08);
  border-color: rgba(56, 189, 248, 0.4);
}
.asset-migration-banner .foreign-secrets-icon { color: rgb(14, 165, 233); }
.inline-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.06);
  word-break: break-all;
}

/* Unclean-shutdown banner — prior run died without firing before-quit
   (force-quit, OOM, hard crash). Soft yellow accent. */
.unclean-shutdown-banner {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 16px 0 8px;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-left: 3px solid #eab308;
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
}
.unclean-shutdown-icon { font-size: 15px; line-height: 1.2; flex-shrink: 0; }
.unclean-shutdown-text { flex: 1; line-height: 1.5; }
.unclean-shutdown-text strong { color: var(--text-primary); }
.unclean-shutdown-link { color: var(--accent); text-decoration: underline; }
/* v1.0.100+ — visible countdown chip so the user knows the banner is
   on a timer and isn't going to nag forever. Tabular-nums keeps it from
   jittering as the count ticks down. */
.unclean-shutdown-timer {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  padding: 1px 7px;
  background: var(--bg-tertiary);
  border-radius: 999px;
  flex-shrink: 0;
  line-height: 1.4;
}
.unclean-shutdown-dismiss {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 13px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}
.unclean-shutdown-dismiss:hover { background: var(--bg-hover); color: var(--text-primary); }
/* Bottom progress bar mirrors the timer chip — shrinks from 100% → 0%
   over the auto-dismiss window. CSS transition softens the per-second
   tick so it reads as a smooth fade rather than a stuttery countdown. */
.unclean-shutdown-progress {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  background: #eab308;
  transition: width 1s linear;
}

/* Restored-where-you-left-off chip — quieter than the banners; informs the
   operator the page didn't open by their click but offers a fast escape. */
.restored-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 4px;
  padding: 6px 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 12px;
  color: var(--text-secondary);
}
.restored-chip-icon { color: var(--accent); font-weight: 600; }
.restored-chip-text { line-height: 1.3; }
.restored-chip-action {
  background: none;
  border: 1px solid var(--border);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 11.5px;
  padding: 3px 10px;
  border-radius: 999px;
}
.restored-chip-action:hover { background: var(--bg-hover); border-color: var(--accent); color: var(--accent); }
.restored-chip-dismiss {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 0 4px;
  border-radius: var(--radius-sm);
}
.restored-chip-dismiss:hover { color: var(--text-primary); }

/* Content wrapper inside main-content applies max-width constraint
   without affecting scroll container position. Each page wraps its
   content in this for consistent centering behavior. */
.main-content > * {
  /* Default: let content take full available width */
  width: 100%;
}

/* Optional: apply max-width via padding/flexbox if needed per page,
   but the scroll container (main-content) always goes edge-to-edge. */
.main-content:focus { outline: none; }  /* focused via skip link, not visible */

/* Skip-to-main link — visible only when focused (keyboard users) */
.skip-link {
  position: absolute;
  top: -9999px;
  left: 0;
  z-index: 9999;
  padding: 10px 18px;
  background: var(--accent);
  color: #0f1117;
  font-weight: 600;
  text-decoration: none;
  border-radius: 0 0 var(--radius-sm) 0;
}
.skip-link:focus {
  top: 0;
  outline: 2px solid #0f1117;
  outline-offset: -4px;
}
</style>
