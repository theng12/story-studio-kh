<template>
  <div class="dashboard-layout">
    <!-- Skip link for keyboard users — appears on focus, lets them jump past the sidebar nav -->
    <a href="#main-content" class="skip-link">Skip to main content</a>

    <!-- Top bar: draggable area reserving space for macOS traffic lights. -->
    <header class="top-bar">
      <div class="titlebar-drag"></div>
    </header>
    <FfmpegSetupDialog />
    <div class="layout-body">
    <aside class="sidebar">
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

        <div class="nav-divider" />
        <div class="nav-section-label">Generators</div>
        <NuxtLink :to="`/projects/${slug}/scripts`" class="nav-item" active-class="active">
          Script Generator <span v-if="scriptGenerating" class="nav-pulse" />
        </NuxtLink>
        <NuxtLink :to="`/projects/${slug}/metadata`" class="nav-item" active-class="active">
          Metadata Generator <span v-if="metaGenerating" class="nav-pulse" />
        </NuxtLink>
        <NuxtLink :to="`/projects/${slug}/image-prompts`" class="nav-item" active-class="active">
          Image Prompts <span v-if="promptGenerating || thumbPromptGenerating" class="nav-pulse" />
        </NuxtLink>
        <NuxtLink :to="`/projects/${slug}/images`" class="nav-item" active-class="active">
          Image Generator <span v-if="imageGenerating || thumbImageGenerating" class="nav-pulse" />
        </NuxtLink>
        <NuxtLink :to="`/projects/${slug}/video`" class="nav-item" active-class="active">
          Video Generator <span v-if="videoGenerating" class="nav-pulse" />
        </NuxtLink>
        <NuxtLink :to="`/projects/${slug}/audio`" class="nav-item" active-class="active">
          Audio Generator <span v-if="audioGenerating" class="nav-pulse" />
        </NuxtLink>

        <div class="nav-divider" />
        <div class="nav-section-label">Assembly</div>
        <NuxtLink :to="`/projects/${slug}/audio-merge`" class="nav-item" active-class="active">
          Audio Assembly <span v-if="audioMergeGenerating" class="nav-pulse" />
        </NuxtLink>
        <NuxtLink :to="`/projects/${slug}/video-assembly`" class="nav-item" active-class="active">
          Video Assembly
        </NuxtLink>

        <div class="nav-divider" />
        <div class="nav-section-label">Upload Center</div>
        <NuxtLink :to="`/projects/${slug}/upload`" class="nav-item" active-class="active" title="YouTube Upload — connect a channel, queue episodes, schedule via publishAt.">
          <span class="nav-icon">&#9654;</span> YouTube Upload
        </NuxtLink>
        <NuxtLink :to="`/projects/${slug}/tiktok-upload`" class="nav-item" active-class="active" title="TikTok Upload — Content Posting API integration planned for v2.">
          <span class="nav-icon">&#9673;</span> TikTok Upload
        </NuxtLink>
        <NuxtLink :to="`/projects/${slug}/facebook-upload`" class="nav-item" active-class="active" title="Facebook Upload — Graph API page-video publishing planned for v2.">
          <span class="nav-icon">&#119127;</span> Facebook Upload
        </NuxtLink>

        <div class="nav-divider" />
        <div class="nav-section-label">Library</div>
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
        <NuxtLink :to="`/projects/${slug}/settings`" class="nav-item" active-class="active">
          <span class="nav-icon">&#9881;</span> Settings
        </NuxtLink>
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
            ? 'Queue pause/resume command failed — backend may not have honoured the offline state. Retrying.'
            : (networkOnline ? 'Connected' : 'No internet — new jobs will wait for connection')"
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
      </div>
    </aside>

    <main id="main-content" class="main-content" tabindex="-1">
      <div
        v-if="showCloudSyncPausedBanner"
        class="cloud-sync-banner"
        role="status"
      >
        <span class="cloud-sync-icon" aria-hidden="true">🔒</span>
        <span class="cloud-sync-text">
          <strong>Cloud sync is paused.</strong>
          This project was created in multi-machine mode, but cloud-sync is temporarily
          disabled while we harden it. Your files remain local and nothing is lost — we'll
          resume syncing in a future update.
        </span>
        <button
          type="button"
          class="cloud-sync-dismiss"
          title="Dismiss — we won't show this again on this machine until next launch"
          @click="cloudSyncDismissed = true"
        >✕</button>
      </div>
      <div
        v-if="secretsForeign"
        class="foreign-secrets-banner"
        role="alert"
      >
        <span class="foreign-secrets-icon" aria-hidden="true">⚠️</span>
        <span class="foreign-secrets-text">
          <strong>This project's saved credentials came from a different machine.</strong>
          For your safety we're ignoring them on this device — nothing will upload or
          call a provider until you reconnect. Go to Settings → API Keys and
          Settings → Upload to reconnect on this machine, or clear the stale file
          to start fresh.
        </span>
        <button
          type="button"
          class="foreign-secrets-reset"
          :disabled="secretsResetting"
          @click="onResetForeignSecrets"
        >{{ secretsResetting ? 'Clearing…' : 'Clear and reset' }}</button>
      </div>
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
        <button
          type="button"
          class="unclean-shutdown-dismiss"
          title="Dismiss — we won't show this again until the next unexpected quit"
          aria-label="Dismiss unclean-shutdown banner"
          @click="dismissUncleanShutdown"
        >✕</button>
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
      <slot />
    </main>
    </div><!-- /.layout-body -->
    <MigrationDialog />
  </div>
</template>

<script setup lang="ts">
const route = useRoute()
const slug = computed(() => route.params.slug as string)

const { project, loadProject } = useProject()
const { jobs, stats, startPolling: startJobPolling, stopPolling: stopJobPolling } = useJobs()

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

// Stage 5: watch for another computer syncing a newer manifest into the
// project folder. Only effective for multi-machine projects (portable=true);
// local-only projects skip polling inside the composable.
useManifestSync()

// Cross-machine folder-copy guard: if `secrets.json` was written by another
// machine (user copied the folder manually instead of using Import), show a
// banner with a one-click reset so stale tokens can't be silently reused.
const { foreign: secretsForeign, resetting: secretsResetting, resetSecrets } = useSecretsProvenance()
const { success: toastSuccess, error: toastError } = useToast()
async function onResetForeignSecrets() {
  const ok = await resetSecrets()
  if (ok) toastSuccess('Credentials cleared — reconnect in Settings → API Keys.')
  else toastError('Could not reset credentials — try again in a moment.')
}

// Cloud-sync-paused banner: show on existing portable projects while the
// feature flag is off. Dismissal is in-memory for the session — we don't
// persist it, so the user sees it once per run and that's enough reminder.
const { CLOUD_SYNC_ENABLED } = useFeatureFlags()
const cloudSyncDismissed = ref(false)
const showCloudSyncPausedBanner = computed(() =>
  !CLOUD_SYNC_ENABLED
  && (project.value as any)?.portable === true
  && !cloudSyncDismissed.value,
)

watch(slug, async (s) => {
  if (s) {
    await loadProject(s)
    startJobPolling(s)
    startCreditPolling(s)
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
  try {
    await apiPatch('/last-session', { unclean_shutdown_dismissed: true })
  } catch {
    // Fail-quiet — worst case the banner re-appears on the next reload.
  }
}

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
}

/* Draggable titlebar area — reserves space for macOS traffic lights and lets user drag window. */
.titlebar-drag {
  height: 38px;
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
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
}

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

.nav-badge { margin-left: auto; background: var(--accent); color: #0f1117; font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 8px; }

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
  padding-top: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.cloud-sync-banner {
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
}
.cloud-sync-icon { font-size: 15px; line-height: 1.2; flex-shrink: 0; }
.cloud-sync-text { flex: 1; line-height: 1.5; }
.cloud-sync-text strong { color: var(--text-primary); }
.cloud-sync-dismiss {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 13px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}
.cloud-sync-dismiss:hover { background: var(--bg-hover); color: var(--text-primary); }

/* Foreign-provenance secrets banner — louder than cloud-sync because stale
   OAuth tokens could upload to the wrong channel if reactivated. */
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

/* Unclean-shutdown banner — prior run died without firing before-quit
   (force-quit, OOM, hard crash). Same yellow accent as cloud-sync. */
.unclean-shutdown-banner {
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
}
.unclean-shutdown-icon { font-size: 15px; line-height: 1.2; flex-shrink: 0; }
.unclean-shutdown-text { flex: 1; line-height: 1.5; }
.unclean-shutdown-text strong { color: var(--text-primary); }
.unclean-shutdown-link { color: var(--accent); text-decoration: underline; }
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
