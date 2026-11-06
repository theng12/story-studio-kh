<template>
  <div class="app-files-settings">
    <!-- v1.4.249 — "Where your files are". Replaces the storage map, Your
         Library, Where finished videos go and Advanced: move uploaded videos
         ("this library and your storage map thing is so confusing"). -->
    <section class="card settings-panel files-where" aria-labelledby="files-where-title">
      <header class="settings-card-head">
        <h3 id="files-where-title">Where your files are</h3>
        <p>Two folders on this Mac. Choose a folder with the button — no paths to type.</p>
      </header>

      <div data-setting="library-folder">
        <FolderField
          :model-value="library?.path || ''"
          label="Library folder"
          hint="Every channel lives here, each with its own files. Choosing another folder copies everything there and restarts Story Studio; the old folder is left untouched."
          picker-title="Choose where to keep your Library"
          picker-button-label="Use This Folder"
          choose-label="Move Library..."
          :disabled="projectsRootBusy"
          @change="moveLibraryTo"
        >
          <template #badge>
            <span v-if="library && !library.exists" class="status-chip warn">Not found</span>
          </template>
        </FolderField>
        <p v-if="library && !library.exists" class="settings-warn">
          Story Studio looked here and the folder is not there. If it is on a drive that is not plugged in, reconnect it — nothing has been lost.
        </p>
        <p v-if="projectsRootStatus" :class="['settings-status', projectsRootStatusKind]">{{ projectsRootStatus }}</p>
      </div>

      <div data-setting="exports-folder">
        <FolderField
          :model-value="library?.exports_custom ? library.exports_dir : ''"
          label="Finished videos folder"
          placeholder="Each channel’s Exports folder"
          :hint="library?.exports_custom
            ? 'New finished videos are saved here. Videos made before you changed it stay where they are and are still found.'
            : 'Each channel saves its finished videos in its own Exports folder, so copying the channel folder takes them along. Choose another folder — another drive, say — to keep them separate.'"
          picker-title="Choose where finished videos go"
          picker-button-label="Use This Folder"
          :disabled="exportsBusy"
          :clearable="!!library?.exports_custom"
          clear-label="Use Library Folder"
          @change="chooseExportsFolder"
        />
        <p v-if="exportsStatus" :class="['settings-status', exportsStatusKind]">{{ exportsStatus }}</p>
      </div>

      <!-- v1.4.317 — the archive sweep moved here from Free up space, which now offers
           only the two all-channel actions ("too many options"). It is about where finished
           videos live, not a cleanup control. -->
      <details class="disclosure space-option" data-setting="move-uploaded" :open="archiveBusy || !!archivePreview || !!archiveResult">
        <summary><strong>Move uploaded videos to another drive</strong><small>Finished videos confirmed on YouTube, from every channel, are copied to a folder you choose and checked there before the original is removed. Everything else stays put.</small></summary>
        <div class="space-option-body">
        <div class="archive-flow">
          <FolderField
            v-model="archiveSource"
            label="Look for videos in"
            placeholder="Your finished videos folder"
            hint="Usually your finished videos folder. Choose another folder if your videos are somewhere else."
            picker-title="Where are your finished videos?"
            picker-button-label="Scan This Folder"
            :disabled="archiveBusy"
            @update:model-value="archivePreview = null"
          />
          <FolderField
            v-model="archiveDest"
            label="Move them to"
            placeholder="Choose a folder on the other drive"
            picker-title="Move finished videos into..."
            picker-button-label="Move Here"
            :disabled="archiveBusy"
          />
          <div class="flex gap-2 items-center">
            <button class="btn btn-secondary btn-sm" :disabled="archiveBusy" @click="loadArchivePreview">
              {{ archiveChecking ? 'Checking...' : 'Check What Would Move' }}
            </button>
            <button v-if="archivePreview?.complete && archivePreview?.ready_count" class="btn btn-primary btn-sm"
                    :disabled="archiveBusy || !archiveDest.trim()" @click="startArchive">
              Move {{ archivePreview.ready_count }} Video{{ archivePreview.ready_count === 1 ? '' : 's' }} · {{ formatBytes(archivePreview.ready_bytes) }}
            </button>
            <button v-if="archiveRunning || archiveChecking" class="btn btn-danger btn-sm" @click="stopArchive">Stop</button>
          </div>
    <div v-if="archivePreview" class="mt-2">
      <p v-if="!archivePreview.source_exists" class="validation-msg text-sm">
        Nothing to scan — <code>{{ archivePreview.source_root }}</code> is not there.
      </p>
      <template v-else>
        <p v-if="!archivePreview.complete" class="validation-msg text-sm">
          Check stopped early. Nothing can move until the folder has been checked completely.
        </p>
        <p class="text-sm">
          <strong>{{ archivePreview.ready_count }}</strong> video(s) ready
          ({{ formatBytes(archivePreview.ready_bytes) }} ready to move),
          <strong>{{ archivePreview.skipped_count }}</strong> skipped
          ({{ formatBytes(archivePreview.skipped_bytes) }} staying put).
        </p>
        <ul v-if="archivePreview.by_channel.length" class="archive-channels">
          <li v-for="c in archivePreview.by_channel" :key="c.slug">
            {{ c.slug }} — {{ c.count }} video(s), {{ formatBytes(c.bytes) }}
          </li>
        </ul>
        <details v-if="archivePreview.ready_count" class="mt-1 disclosure">
          <summary class="text-sm">Review {{ archivePreview.ready_count }} uploaded videos to move</summary>
          <ul class="archive-skipped">
            <li v-for="c in archiveReadyRows" :key="c.source_path">
              <strong>{{ c.slug }} · {{ c.code }}</strong> — <code>{{ c.filename }}</code>
              · {{ formatBytes(c.bytes) }}
              <a v-if="c.youtube_video_id" :href="`https://www.youtube.com/watch?v=${encodeURIComponent(c.youtube_video_id)}`"
                 target="_blank" rel="noopener noreferrer">Open recorded YouTube upload</a>
            </li>
          </ul>
        </details>
        <details v-if="archivePreview.skipped_count" class="mt-1 disclosure">
          <summary class="text-muted text-sm">Why {{ archivePreview.skipped_count }} were skipped</summary>
          <ul class="archive-skipped">
            <li v-for="c in archiveSkippedRows" :key="c.source_path">
              <code>{{ c.filename }}</code> — {{ c.reason }}
            </li>
          </ul>
        </details>
      </template>
    </div>

    <div v-if="archiveChecking || archiveRunning || archiveResult" class="mt-2">
      <p v-if="archiveChecking" class="text-sm">
        Checking {{ archiveProgress.checked }} video file{{ archiveProgress.checked === 1 ? '' : 's' }} —
        <code>{{ archiveProgress.current }}</code>
        <span v-if="archiveStopping"> · stopping after this file...</span>
      </p>
      <p v-else-if="archiveRunning" class="text-sm">
        {{ archiveStage === 'checking' ? 'Rechecking proof' : 'Moving' }} {{ archiveProgress.done }} / {{ archiveProgress.total }} —
        <code>{{ archiveProgress.current }}</code>
        <span v-if="archiveStopping"> · stopping after this file...</span>
      </p>
      <p v-if="archiveResult" class="text-sm">
        ✓ Moved {{ archiveResult.moved.length }} video(s), {{ formatBytes(archiveResult.bytes_moved) }} total.
        <span v-if="archiveResult.cancelled">Stopped early — everything not yet moved is untouched.</span>
        <span v-if="archiveResult.failed.length">
          {{ archiveResult.failed.length }} could not be verified and were left in both places.
        </span>
      </p>
      <ul v-if="archiveResult?.warnings?.length" class="archive-skipped">
        <li v-for="w in archiveResult.warnings" :key="w">{{ w }}</li>
      </ul>
    </div>
        </div>
        </div>
      </details>

    </section>

    <section class="card settings-panel settings-panel-embedded" data-setting="free-up-space">
      <MediaCleanupPanel />
    </section>

    <section class="card settings-panel" data-setting="self-contained-all">
      <SelfContainedPanel />
    </section>

    <section class="card settings-panel" data-setting="smaller-files">
      <GenerationCompressionPanel />
    </section>

    <!-- FFmpeg — plain status, one fix button; internals behind Advanced. -->
    <section id="ffmpeg-section" class="card settings-panel ffmpeg-card" data-setting="ffmpeg">
      <header class="settings-card-head">
        <h3>FFmpeg (video engine)</h3>
        <p>Joins narration, mixes music and makes the final MP4 for Audio Assembly and Video Assembly.</p>
      </header>
      <div class="ffmpeg-state" :class="ffmpegState.tone" role="status">
        <span class="ffmpeg-state-dot" aria-hidden="true" />
        <div>
          <strong>{{ ffmpegState.title }}</strong>
          <span v-if="ffmpegState.detail">{{ ffmpegState.detail }}</span>
        </div>
        <button v-if="ffmpegState.fix" class="btn btn-primary btn-sm" :disabled="ffmpegInstalling" @click="installFfmpeg">
          {{ ffmpegInstalling ? `${ffmpegInstallMessage || 'Installing...'} ${ffmpegInstallProgress}%` : ffmpegState.fix }}
        </button>
        <button class="btn btn-ghost btn-sm" :disabled="ffmpegStatusLoading" @click="refreshFfmpegStatus">{{ ffmpegStatusLoading ? 'Checking...' : 'Check Again' }}</button>
      </div>
      <p v-if="ffmpegInstallMessage && !ffmpegInstalling" class="settings-status" :class="ffmpegInstallError ? 'err' : 'ok'">{{ ffmpegInstallMessage }}</p>
      <div v-if="showFfmpegRestartPrompt" class="ffmpeg-restart-prompt">
        <span class="restart-msg"><strong>Install complete.</strong> Restart the app so Audio Assembly and Video Assembly use it.</span>
        <div class="flex gap-2 mt-1">
          <button class="btn btn-sm btn-primary" :disabled="restarting" @click="restartApp">{{ restarting ? 'Restarting...' : 'Restart Now' }}</button>
          <button class="btn btn-sm btn-secondary" @click="showFfmpegRestartPrompt = false">Later</button>
        </div>
      </div>
      <AdvancedDisclosure label="Advanced: FFmpeg details">
        <dl class="ffmpeg-details">
          <dt>Version</dt><dd>{{ ffmpegStatus?.version || '—' }}</dd>
          <dt>Copy in use</dt><dd>{{ ffmpegSourceLabel }}</dd>
          <dt>Location</dt><dd><code>{{ ffmpegStatus?.path || '—' }}</code></dd>
          <dt>Text overlays (drawtext)</dt><dd>{{ ffmpegStatus?.installed ? (ffmpegStatus.has_drawtext ? 'Yes' : 'No') : '—' }}</dd>
          <dt>Subtitle burn-in (libass)</dt><dd>{{ ffmpegStatus?.installed ? (ffmpegStatus.has_libass ? 'Yes' : 'No') : '—' }}</dd>
        </dl>
        <div v-if="ffmpegStatus?.installed && ffmpegStatus.source !== 'bundled' && !ffmpegState.fix" class="mt-2">
          <button class="btn btn-secondary btn-sm" :disabled="ffmpegInstalling" @click="installFfmpeg">Replace Recovery Copy</button>
          <span class="settings-hint"> Downloads the same pinned FFmpeg this app was tested with and checks it before use.</span>
        </div>
  <div v-if="ffmpegInstallError" class="ffmpeg-log-block mt-2">
    <div class="flex gap-2" style="align-items: center;">
      <button class="btn btn-sm btn-secondary" @click="loadInstallLog" :disabled="ffmpegLogLoading" title="Fetches the last hour of ffmpeg-install log entries">
        <span v-if="ffmpegLogLoading">Loading...</span>
        <span v-else-if="ffmpegInstallLog.length">Refresh Log</span>
        <span v-else>Show Install Log</span>
      </button>
      <button v-if="ffmpegInstallLog.length" class="btn btn-sm btn-primary" @click="copyInstallLog" title="Copies the log entries + your platform info to the clipboard so you can paste it into a bug report">
        Copy Log to Clipboard
      </button>
      <span v-if="ffmpegLogCopiedAt" class="text-muted" style="font-size: var(--font-xs);">Copied ✓</span>
    </div>
    <pre v-if="ffmpegInstallLog.length" class="ffmpeg-log-output mt-1">{{ ffmpegInstallLogText }}</pre>
    <p v-else-if="ffmpegInstallLogChecked" class="text-muted mt-1" style="font-size: var(--font-xs);">
      No ffmpeg-install entries in the last hour. The error may have happened before logging was wired up — try clicking Install again.
    </p>
  </div>
        <details v-if="ffmpegStatus && ffmpegStatus.source !== 'bundled'" class="ffmpeg-manual mt-2 disclosure">
          <summary>Install it yourself</summary>
          <p class="settings-hint">If the download is blocked, install FFmpeg with Homebrew (<code>brew install ffmpeg</code>), then press Check Again.</p>
        </details>
      </AdvancedDisclosure>
    </section>

    <section class="card settings-panel about-card" data-setting="about">
      <div>
        <h3>About Story Studio KH</h3>
        <p class="settings-hint">Version <strong>{{ appVersion }}</strong><template v-if="buildDate"> · built {{ buildDate }}</template>. Copy this when you report a problem.</p>
      </div>
      <button class="btn btn-secondary btn-sm" @click="copyVersionString">{{ versionCopied ? 'Copied' : 'Copy Version' }}</button>
    </section>
    <AppUpdatePanel />
  </div>
</template>

<script setup lang="ts">
const { get, post, put } = useApi()
const { ask } = useConfirm()
const { success, error: showError } = useToast()

const { public: pubCfg } = useRuntimeConfig()
const appVersion = computed(() => (pubCfg.appVersion as string | undefined) || '0.0.0')
const buildDate = computed(() => (pubCfg.buildDate as string | undefined) || '')
const versionCopied = ref(false)
async function copyVersionString() {
  const txt = `Story Studio KH v${appVersion.value} · built ${buildDate.value}`
  try {
    await navigator.clipboard.writeText(txt)
    versionCopied.value = true
    setTimeout(() => { versionCopied.value = false }, 1400)
    success('Version copied')
  } catch {
    showError('Could not copy — your browser/OS blocked clipboard access.')
  }
}

/**
 * The Library — one location, replacing the projects-root override (v1.4.3).
 *
 * Changing it is a COPY, done by the same mover the old flow used, then a
 * restart: long-lived state (job queue, watchers, caches) still points at the
 * old place until the app comes back up. The old folder is deliberately left
 * behind — deleting someone's library after copying it is not a decision this
 * app makes.
 */
interface LibraryStatus {
  configured: boolean
  path: string
  exists: boolean
  writable: boolean
  suggested: string
  assets_dir: string
  exports_dir: string
  exports_custom?: boolean
  exports_previous?: string[]
}

const library = ref<LibraryStatus | null>(null)
const projectsRootBusy = ref(false)
const projectsRootStatus = ref('')
const projectsRootStatusKind = ref<'ok' | 'warn' | 'err'>('ok')
const exportsBusy = ref(false)
const exportsStatus = ref('')
const exportsStatusKind = ref<'ok' | 'warn' | 'err'>('ok')

async function loadLibrary() {
  try {
    library.value = await get<LibraryStatus>('/library')
  } catch (e: any) {
    projectsRootStatus.value = `Couldn't read your Library location: ${e?.data?.detail || e?.message}`
    projectsRootStatusKind.value = 'err'
  }
}

/**
 * Archive uploaded videos (v1.4.4) — Library-wide.
 *
 * Preview first, then move. The run is fire-and-poll rather than one long
 * request: 220 GB takes many minutes and any proxy in between would give up
 * long before the copy did.
 */
type ArchiveSkipReason =
  | 'no_code' | 'unknown_channel' | 'ambiguous_channel'
  | 'not_uploaded' | 'not_reviewed' | 'collision'
interface ArchivePreviewRow {
  source_path: string; filename: string; bytes: number; code: string
  slug?: string; youtube_video_id?: string
  status: 'ready' | 'skipped'; reason?: string; reason_code?: ArchiveSkipReason
}
interface ArchivePreviewResult {
  source_root: string; source_exists: boolean
  complete: boolean; cancelled: boolean
  candidates: ArchivePreviewRow[]
  ready_count: number; ready_bytes: number
  skipped_count: number; skipped_bytes: number
  by_channel: Array<{ slug: string; count: number; bytes: number }>
}

const archiveSource = ref('')
const archiveDest = ref('')
const archiveBusy = ref(false)
const archiveRunning = ref(false)
const archiveChecking = ref(false)
const archiveStopping = ref(false)
const archiveStage = ref<'checking' | 'moving' | null>(null)
const archivePreview = ref<ArchivePreviewResult | null>(null)
const archiveResult = ref<any>(null)
const archiveProgress = ref({ done: 0, total: 0, checked: 0, current: '' })
let archivePoll: ReturnType<typeof setInterval> | null = null
let archivePollInFlight = false
let archiveRestoreInFlight = false
let archivePanelDisposed = false

const archiveSkippedRows = computed(
  () => (archivePreview.value?.candidates || []).filter(c => c.status === 'skipped'),
)
const archiveReadyRows = computed(
  () => (archivePreview.value?.candidates || []).filter(c => c.status === 'ready'),
)

/**
 * What the skipped pile is actually made of, in his words.
 *
 * The confirm dialog used to describe every skip as "not confirmed uploaded".
 * That was wrong twice: files with no episode code at all were counted as
 * unproven uploads (his TerenceGaming folder is full of them), and until
 * v1.4.10 the sentence's promise — that nothing unproven would be touched —
 * was not true across channels. Say what is true instead.
 */
const archiveSkipSummary = computed(() => {
  const counts: Record<string, number> = {}
  for (const row of archiveSkippedRows.value) {
    const key = row.reason_code || 'other'
    counts[key] = (counts[key] || 0) + 1
  }
  const phrases: string[] = []
  const say = (key: string, one: string, many: string) => {
    const n = counts[key]
    if (n) phrases.push(`${n} ${n === 1 ? one : many}`)
  }
  say('not_uploaded', 'is not confirmed uploaded', 'are not confirmed uploaded')
  say('no_code', 'has no episode code', 'have no episode code')
  say('unknown_channel', 'cannot be tied to a channel', 'cannot be tied to a channel')
  say('ambiguous_channel', 'sits where more than one channel could own it',
    'sit where more than one channel could own them')
  say('other', 'is skipped for another reason', 'are skipped for other reasons')
  return phrases
})

async function loadArchivePreview() {
  if (archiveBusy.value) return
  archiveBusy.value = true
  archiveChecking.value = true
  archiveRunning.value = false
  archiveStopping.value = false
  archiveStage.value = 'checking'
  archiveProgress.value = { done: 0, total: 0, checked: 0, current: '' }
  archiveResult.value = null
  archivePreview.value = null
  try {
    await post('/library/archive/preview', {
      source_root: archiveSource.value.trim() || undefined,
    })
    if (archivePoll) clearInterval(archivePoll)
    archivePoll = setInterval(pollArchive, 1000)
    void pollArchive()
  } catch (e: any) {
    archiveChecking.value = false
    archiveStage.value = null
    archiveBusy.value = false
    showError(e?.data?.detail || e?.message || 'Could not check the folder')
  }
}

async function startArchive() {
  if (archiveBusy.value) return
  const preview = archivePreview.value
  if (!preview?.complete) return
  const approved = preview.candidates.filter(c => c.status === 'ready').map(c => c.source_path)
  const staying = archiveSkipSummary.value.length
    ? `${preview.skipped_count} video(s) stay where they are — ${archiveSkipSummary.value.join(', ')}.`
    : 'Nothing else in that folder is affected.'
  const ok = await ask({
    title: 'Move finished videos?',
    message: `${preview.ready_count} video(s) — ${formatBytes(preview.ready_bytes)} — will be COPIED to\n`
      + `  ${archiveDest.value}\n\n`
      + `Each one is checked at the destination before the original is removed, so nothing is lost `
      + `if the copy fails.\n\n`
      + `${staying}\n\n`
      + `Only the ${preview.ready_count} listed above will be moved — anything added to the folder `
      + `after this check is left alone.`,
    confirmLabel: 'Move Them',
  })
  if (!ok) return

  archiveBusy.value = true
  archiveRunning.value = true
  archiveChecking.value = false
  archiveStopping.value = false
  archiveStage.value = 'checking'
  archiveProgress.value = { done: 0, total: approved.length, checked: 0, current: '' }
  archiveResult.value = null
  try {
    await post('/library/archive/run', {
      destination: archiveDest.value.trim(),
      // Bind the move to the root that produced this bill. Editing the input
      // after a completed review must not substitute a different folder.
      source_root: preview.source_root,
      // The reviewed set. The server re-checks each one's upload proof and can
      // only get stricter, but it will not move anything outside this list.
      approved,
    })
    if (archivePoll) clearInterval(archivePoll)
    archivePoll = setInterval(pollArchive, 1000)
    void pollArchive()
  } catch (e: any) {
    archiveRunning.value = false
    archiveBusy.value = false
    archiveStage.value = null
    showError(e?.data?.detail || e?.message || 'Could not start the sweep')
  }
}

function applyArchiveStatus(st: any): boolean {
  const phase = st.phase === 'preview' || st.phase === 'run' ? st.phase : null
  // A fresh server has no archive operation to restore. Do not turn that into
  // an empty result or a fake stopped scan when Settings first opens.
  if (!st.running && !phase) return false

  archiveStage.value = st.stage || null
  archiveProgress.value = {
    done: st.done || 0, total: st.total || 0, checked: st.checked || 0, current: st.current || '',
  }
  archiveStopping.value = !!st.stopping
  archiveBusy.value = !!st.running
  archiveChecking.value = !!st.running && phase === 'preview'
  archiveRunning.value = !!st.running && phase === 'run'
  if (st.running) return true

  if (archivePoll) { clearInterval(archivePoll); archivePoll = null }
  archiveStage.value = null
  if (phase === 'preview') {
    archivePreview.value = st.result || null
    archiveResult.value = null
  } else {
    archiveResult.value = st.result
    archivePreview.value = null
  }
  if (st.error) showError(st.error)
  return true
}

async function pollArchive() {
  if (archivePollInFlight) return
  archivePollInFlight = true
  try {
    applyArchiveStatus(await get<any>('/library/archive/status'))
  } catch { /* transient — keep polling */ }
  finally { archivePollInFlight = false }
}

async function stopArchive() {
  archiveStopping.value = true
  try { await post('/library/archive/stop', {}) } catch { /* best effort */ }
}

async function restoreArchiveInFlight() {
  if (archiveBusy.value || archivePoll || archiveRestoreInFlight || archivePanelDisposed) return
  archiveRestoreInFlight = true
  try {
    const st = await get<any>('/library/archive/status')
    if (archivePanelDisposed || archiveBusy.value || archivePoll) return
    if (applyArchiveStatus(st) && st.running) archivePoll = setInterval(pollArchive, 1000)
  } catch { /* the archive panel remains idle until its next explicit action */ }
  finally { archiveRestoreInFlight = false }
}

async function moveLibraryTo(picked: string) {
  if (!picked || picked === library.value?.path) return
  const ok = await ask({
    title: 'Move your Library?',
    message: `To: ${picked}\n\nEvery channel, your shared assets and your exports are COPIED there. ` +
      'The current folder is left exactly as it is, so nothing can be lost — you can delete it yourself once you have checked the new one. ' +
      'Story Studio restarts afterwards.',
    confirmLabel: 'Copy and Restart',
  })
  if (!ok) return

  projectsRootBusy.value = true
  projectsRootStatus.value = 'Copying your Library...'
  projectsRootStatusKind.value = 'ok'
  try {
    await put('/library', { path: picked, move: true })
    projectsRootStatus.value = '✓ Moved. Restarting...'
    setTimeout(async () => {
      try { await post('/system/restart-app', {}) } catch (e: any) {
        if (e?.status === 503) {
          showError('App is in dev mode and can\'t auto-restart. Quit and start it again to use the new Library.')
        } else {
          showError(`Restart failed: ${e?.data?.detail || e?.message}. Quit and reopen manually.`)
        }
      }
    }, 600)
  } catch (e: any) {
    projectsRootStatus.value = `Move failed: ${e?.data?.detail || e?.message}`
    projectsRootStatusKind.value = 'err'
    projectsRootBusy.value = false
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

/** Choose where NEW finished videos go ('' = the Library's Exports folder). Moves nothing. */
async function chooseExportsFolder(picked: string) {
  const current = library.value?.exports_dir || ''
  if (picked && picked === current) return
  const ok = await ask({
    title: picked ? 'Save new finished videos here?' : 'Go back to the Library folder?',
    message: `${picked || 'The Exports folder inside your Library'}\n\nNew finished videos are saved there from now on. `
      + 'Videos you already made are NOT moved: they stay where they are and Story Studio still finds them.',
    confirmLabel: picked ? 'Use This Folder' : 'Use Library Folder',
  })
  if (!ok) return
  exportsBusy.value = true
  exportsStatus.value = ''
  try {
    library.value = await put<LibraryStatus>('/library/exports', { path: picked })
    exportsStatusKind.value = 'ok'
    exportsStatus.value = 'Saved. New finished videos go to this folder.'
  } catch (e: any) {
    exportsStatusKind.value = 'err'
    exportsStatus.value = e?.data?.detail || e?.message || 'Could not use that folder.'
  } finally {
    exportsBusy.value = false
  }
}

/**
 * FFmpeg (v1.4.x) — the video engine the app installs into its own
 * user-data directory. No brew / sudo / Terminal needed. Status is fetched
 * at GET /ffmpeg/status. Other generator pages link here via the URL hash
 * `#ffmpeg`.
 */
interface FfmpegStatus {
  installed: boolean
  version?: string
  source?: 'bundled' | 'app-data' | 'system' | 'not-found'
  has_drawtext?: boolean
  has_libass?: boolean
  path?: string
}
const ffmpegStatus = ref<FfmpegStatus | null>(null)
/** The FFmpeg card in one plain sentence, plus the one button that fixes it (v1.4.249). */
const ffmpegState = computed<{ tone: 'ok' | 'warn' | 'err' | 'idle'; title: string; detail: string; fix: string }>(() => {
  const st = ffmpegStatus.value
  if (ffmpegStatusError.value) return { tone: 'err', title: 'Could not check FFmpeg', detail: `${ffmpegStatusError.value} — this does not mean it is missing. Check again.`, fix: '' }
  if (!st) return { tone: 'idle', title: 'Checking FFmpeg...', detail: '', fix: '' }
  if (!st.installed) return { tone: 'err', title: 'FFmpeg is missing', detail: 'Audio Assembly and Video Assembly cannot run until it is installed.', fix: 'Install FFmpeg' }
  const missing = [!st.has_drawtext && 'text overlays', !st.has_libass && 'subtitle burn-in'].filter(Boolean) as string[]
  if (!missing.length) return { tone: 'ok', title: 'Ready — includes text overlays and subtitle burn-in', detail: st.source === 'bundled' ? 'The copy that ships with Story Studio.' : '', fix: '' }
  // A bundled copy is pinned to the app; it is never replaced from here.
  return {
    tone: 'warn',
    title: `Works, but missing ${missing.join(' and ')}`,
    detail: st.source === 'bundled' ? 'Update Story Studio to get the full version.' : 'Install the full version Story Studio was tested with.',
    fix: st.source === 'bundled' ? '' : 'Install Full Version',
  }
})
const ffmpegSourceLabel = computed(() => ({
  bundled: 'Bundled with Story Studio', 'app-data': 'Recovery copy', system: 'Installed on this Mac', 'not-found': 'None',
} as Record<string, string>)[ffmpegStatus.value?.source || ''] || '—')
const ffmpegStatusLoading = ref(false)
// F-04 (DS-11) — the FFmpeg card proposes an install/recovery download from
// `ffmpegStatus.installed === false`, and a failed status check used to be
// written as exactly that (`{ installed: false }`). "I could not check" must
// not become "not installed" (AGENTS.md §6), and no install action may be
// offered for a status that was never read. `null` status = unknown.
const ffmpegStatusError = ref('')
const ffmpegInstalling = ref(false)
const ffmpegInstallProgress = ref(0)
const ffmpegInstallMessage = ref('')
const ffmpegInstallError = ref(false)

// Install-log fetch state. Populated on demand (after a failed install
// the user clicks "Show install log") rather than auto-loaded so a
// successful run doesn't hit the log endpoint unnecessarily.
interface InstallLogEntry { ts: string; level: string; message: string; phase?: string; error?: string; code?: string; stack?: string; [k: string]: any }
const ffmpegInstallLog = ref<InstallLogEntry[]>([])
const ffmpegInstallLogChecked = ref(false)
const ffmpegLogLoading = ref(false)
const ffmpegLogCopiedAt = ref(0)

// Restart prompt — shown after the in-app installer succeeds OR after a
// Re-check status flips the badges from missing → installed. The renderer
// keeps a stale "ffmpeg not found" state for some pages until the whole
// app restarts; one explicit relaunch saves the user from "I installed
// it but it's still broken" confusion.
const showFfmpegRestartPrompt = ref(false)
const restarting = ref(false)
const ffmpegInstallLogText = computed(() => {
  // Render entries as one-line-per-event with phase + duration + key
  // fields, then a separate stack/error block when present. Format
  // chosen so the user can paste into a chat/issue without further
  // formatting, and the assistant can scan it quickly.
  return ffmpegInstallLog.value.map(e => {
    const ts = e.ts || '?'
    const phase = e.phase || (e.message.split(':').slice(1).join(':') || '?')
    const ms = typeof e.ms === 'number' ? ` (${e.ms}ms)` : ''
    const errBits: string[] = []
    if (e.code) errBits.push(`code=${e.code}`)
    if (e.error) errBits.push(`error="${e.error}"`)
    const head = `[${ts}] ${e.level.toUpperCase()} ${phase}${ms}${errBits.length ? ' · ' + errBits.join(' ') : ''}`
    return e.stack ? `${head}\n  ${e.stack.split('\n').slice(0, 6).join('\n  ')}` : head
  }).join('\n')
})

async function refreshFfmpegStatus() {
  // Capture the previous state so we can detect a "missing → installed"
  // flip after the user installed ffmpeg externally (brew, manual). When
  // that happens, surface the restart prompt automatically — same UX as
  // the in-app installer success path.
  const wasMissing = !!ffmpegStatus.value && !ffmpegStatus.value.installed
  ffmpegStatusLoading.value = true
  ffmpegStatusError.value = ''
  try {
    ffmpegStatus.value = await get<FfmpegStatus>('/ffmpeg/status')
    if (wasMissing && ffmpegStatus.value.installed) {
      showFfmpegRestartPrompt.value = true
    }
  } catch (e: any) {
    // Unknown, not missing. The card keeps the installer closed and shows the
    // failure with a Retry instead of inviting a download it cannot justify.
    ffmpegStatus.value = null
    ffmpegStatusError.value = e?.data?.detail || e?.message || 'Could not check FFmpeg'
  } finally {
    ffmpegStatusLoading.value = false
  }
}

async function installFfmpeg() {
  if (ffmpegInstalling.value) return
  if (ffmpegStatus.value?.installed && ffmpegStatus.value.source === 'bundled') {
    success('Bundled FFmpeg is already verified — no download is needed')
    return
  }
  ffmpegInstalling.value = true
  ffmpegInstallProgress.value = 0
  ffmpegInstallError.value = false
  ffmpegInstallMessage.value = 'Starting download...'

  // Poll the install-progress endpoint every second while the POST is in
  // flight. The POST is synchronous (waits for the whole download to
  // finish), so without polling the user sees a frozen progress bar for
  // up to 5 minutes. The polling endpoint reads the same in-memory state
  // that downloadFFmpeg writes to on every phase transition.
  let pollHandle: ReturnType<typeof setInterval> | null = null
  pollHandle = setInterval(async () => {
    try {
      const p = await get<{ status: string; phase?: string; percent: number; message: string; error?: string }>('/ffmpeg/install-progress')
      if (typeof p.percent === 'number') ffmpegInstallProgress.value = p.percent
      if (p.message) ffmpegInstallMessage.value = p.message
      if (p.status === 'done' || p.status === 'error' || p.status === 'idle') {
        if (pollHandle) { clearInterval(pollHandle); pollHandle = null }
      }
    } catch { /* polling is best-effort */ }
  }, 1000)

  try {
    const result = await post<{ ok: boolean; path: string; status: FfmpegStatus }>('/ffmpeg/install', {})
    ffmpegInstallProgress.value = 100
    ffmpegInstallMessage.value = `Installed to ${result.path}`
    ffmpegStatus.value = result.status
    showFfmpegRestartPrompt.value = true
    success('FFmpeg installed successfully')
  } catch (e: any) {
    ffmpegInstallError.value = true
    ffmpegInstallMessage.value = e?.data?.detail || e?.message || 'Install failed — see manual instructions below'
    showError('FFmpeg install failed')
  } finally {
    if (pollHandle) clearInterval(pollHandle)
    ffmpegInstalling.value = false
  }
}

async function restartApp() {
  if (restarting.value) return
  restarting.value = true
  try {
    // Backend responds with `{ ok: true }`, then triggers `app.relaunch()
    // + app.exit(0)` after a 200ms grace. The fetch resolves before the
    // process dies, then the renderer is killed by the relaunch — Nuxt
    // boots fresh on the new process and lands the user back on this
    // same page (the URL is preserved by Electron's restoreSession).
    await post('/app/restart', {})
    // Don't reset `restarting` — the page is about to be replaced, and
    // showing the spinner during the brief relaunch window is the
    // correct affordance.
  } catch (e: any) {
    restarting.value = false
    showError(e?.data?.detail || 'Restart failed — please quit and reopen the app manually.')
  }
}

async function loadInstallLog() {
  ffmpegLogLoading.value = true
  ffmpegInstallLogChecked.value = true
  try {
    const resp = await get<{ entries: InstallLogEntry[]; path: string; total?: number; message?: string }>('/ffmpeg/install-log')
    ffmpegInstallLog.value = resp.entries || []
  } catch (e: any) {
    showError('Could not load install log: ' + (e?.data?.detail || e?.message || 'unknown'))
    ffmpegInstallLog.value = []
  } finally {
    ffmpegLogLoading.value = false
  }
}

async function copyInstallLog() {
  // Bundle the log entries WITH platform info so a recipient (assistant
  // or support engineer) doesn't have to ask "what arch / OS / app
  // version?" as a follow-up. Browsing this clipboard payload should
  // be enough to triage 90% of install failures.
  const platformInfo = [
    `Platform: ${navigator.platform || 'unknown'}`,
    `User agent: ${navigator.userAgent || 'unknown'}`,
    `App URL: ${window.location.origin}`,
    `Captured at: ${new Date().toISOString()}`,
  ].join('\n')
  const body = `=== Story Studio FFmpeg install log ===\n${platformInfo}\n\n--- log entries (${ffmpegInstallLog.value.length}) ---\n${ffmpegInstallLogText.value}\n=== end ===`
  try {
    await navigator.clipboard.writeText(body)
    ffmpegLogCopiedAt.value = Date.now()
    setTimeout(() => { if (Date.now() - ffmpegLogCopiedAt.value >= 2500) ffmpegLogCopiedAt.value = 0 }, 2700)
  } catch {
    showError('Could not copy — select the text in the log box and copy manually.')
  }
}

onMounted(() => {
  void loadLibrary()
  if (!ffmpegStatus.value && !ffmpegStatusLoading.value) void refreshFfmpegStatus()
  void restoreArchiveInFlight()
})

onBeforeUnmount(() => {
  archivePanelDisposed = true
  if (archivePoll) clearInterval(archivePoll)
  archivePoll = null
})
</script>

<style scoped>
.app-files-settings {
  --settings-green: #58c692;
  display: grid;
  gap: 14px;
  min-width: 0;
}

.settings-panel {
  border-radius: 16px;
  border-color: color-mix(in srgb, var(--border) 88%, var(--settings-green));
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg-secondary) 96%, #17362a), var(--bg-secondary) 180px);
  box-shadow: 0 20px 45px rgba(0,0,0,.12), inset 0 1px rgba(255,255,255,.025);
}
.settings-card-head { margin-bottom: 12px; }
.settings-card-head h3 { margin: 0 0 4px; font-size: 16px; }
.settings-card-head p { margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.settings-hint { margin: 4px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.settings-warn { margin: 6px 0 0; color: var(--warning, #d97706); font-size: 12px; }
.settings-status { margin: 6px 0 0; font-size: 12px; }
.settings-status.ok { color: var(--success); }
.settings-status.warn { color: var(--warning, #d97706); }
.settings-status.err { color: var(--error); }
.status-chip { padding: 1px 8px; border-radius: 999px; font-size: var(--font-xs); font-weight: 600; }
.status-chip.warn { background: color-mix(in srgb, var(--warning, #d97706) 18%, transparent); color: var(--warning, #d97706); }

.files-where { display: grid; gap: 18px; }
/* Collapsible option rows (the archive sweep under "Where your files are") — the same rules as MediaCleanupPanel's own .space-option. */
.space-option { border-top: 1px solid var(--border); padding: 12px 0; }
.space-option > summary small { display: block; margin: 2px 0 0 18px; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.space-option-body { padding: 4px 0 0 18px; }
.archive-flow { display: grid; gap: 12px; }
.archive-channels, .archive-skipped { color: var(--text-secondary); margin: 6px 0; padding-left: 18px; }
.archive-skipped code { overflow-wrap: anywhere; }

.ffmpeg-manual a { color: var(--accent); text-decoration: underline; }
/* Restart prompt — visually distinct from the install block (green
   accent vs amber) so the success state reads as different from the
   "click to install" state. */
.ffmpeg-restart-prompt {
  padding: 10px 14px;
  background: rgba(46, 160, 67, 0.08);
  border-left: 3px solid var(--success, #3fb950);
  border-radius: var(--radius-sm);
  font-size: 13px;
}
.ffmpeg-restart-prompt .restart-msg { color: var(--text-primary); }

/* Install-log diagnostic block: surfaces only on failure. The <pre>
   keeps formatting (timestamps, indented stack lines) and lets the
   user select-copy fragments instead of the whole thing. */
.ffmpeg-log-block {
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}
.ffmpeg-log-output {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font-family: 'SF Mono', Monaco, monospace;
  font-size: var(--font-xs);
  line-height: 1.5;
  max-height: 280px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.ffmpeg-state { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-primary); }
.ffmpeg-state > div { display: grid; flex: 1 1 auto; gap: 2px; }
.ffmpeg-state strong { font-size: 13px; }
.ffmpeg-state span { color: var(--text-muted); font-size: 12px; }
.ffmpeg-state .btn { white-space: nowrap; }
.ffmpeg-state-dot { flex: 0 0 auto; width: 9px; height: 9px; border-radius: 50%; background: var(--text-muted); }
.ffmpeg-state.ok .ffmpeg-state-dot { background: var(--success); }
.ffmpeg-state.warn .ffmpeg-state-dot { background: var(--warning, #d97706); }
.ffmpeg-state.err .ffmpeg-state-dot { background: var(--error); }
.ffmpeg-details { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 16px; margin: 0; font-size: 12px; }
.ffmpeg-details dt { color: var(--text-muted); }
.ffmpeg-details dd { margin: 0; overflow-wrap: anywhere; }
.ffmpeg-manual summary { cursor: pointer; font-size: 12px; }

.about-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.about-card h3 { margin: 0; font-size: 14px; }
</style>
