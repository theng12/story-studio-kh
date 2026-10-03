import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const settings = readFileSync(new URL('../pages/projects/[slug]/settings.vue', import.meta.url), 'utf8')

test('Settings offers final cleanup only as a verify-and-clear candidate action', () => {
  assert.match(settings, /e\.cleanup_eligible\s*&&\s*\(e\.bytes_final_video/)
  assert.match(settings, /v-if="row\.cleanup_eligible && \(row\.bytes_final_video > 0 \|\| row\.bytes_external_final_video > 0\)"/)
  assert.match(settings, /if \(!row\.cleanup_eligible\) return/)
  const cleanupRow = settings.slice(settings.indexOf('async function cleanupRow('), settings.indexOf('// v1.0.71: chunked-sidecar'))
  assert.ok(cleanupRow.startsWith('async function cleanupRow('))
  assert.doesNotMatch(cleanupRow, /\bforce\s*:/)
  assert.match(settings, /Verify & clear local video/)
  assert.match(settings, /Verify and clear local videos\?/)
  assert.match(settings, /SHA-256/)
  assert.match(settings, /Any file it cannot verify stays local and is reported below/)
  assert.match(settings, /row\.cleanup_reason/)
  assert.match(settings, /v-if="row\.cleanup_eligible" class="upload-badge ok"/)
  assert.match(settings, /v-else-if="row\.uploaded_to_youtube"/)
  assert.match(settings, /⚠ remains local/)
  assert.match(settings, /lastBulkCleanup\.items\.length/)
})

test('archive folders are chosen with the shared folder picker, single-flight and with failures reported', () => {
  // v1.4.249 — folder pickers everywhere: no typed paths.
  assert.match(settings, /<FolderField\s+v-model="archiveSource"[\s\S]{0,400}:disabled="archiveBusy"/)
  assert.match(settings, /<FolderField\s+v-model="archiveDest"[\s\S]{0,400}:disabled="archiveBusy"/)
  const field = readFileSync(new URL('../components/FolderField.vue', import.meta.url), 'utf8')
  assert.match(field, /if \(picking\.value \|\| props\.disabled\) return/)
  assert.match(field, /picking\.value = true/)
  assert.match(field, /message\.value = /)
  assert.match(field, /picking\.value = false/)
})

test('archive preview is treated as a background check, not a request that can silently time out', () => {
  assert.match(settings, /const archiveChecking = ref\(false\)/)
  assert.match(settings, /archivePreview\?\.complete && archivePreview\?\.ready_count/)
  assert.match(settings, /archiveChecking\.value = true/)
  assert.match(settings, /Checking .* video file/)
  assert.match(settings, /let archivePollInFlight = false/)
  assert.match(settings, /if \(archivePollInFlight\) return/)
  assert.match(settings, /async function restoreArchiveInFlight\(\)/)
  assert.match(settings, /function applyArchiveStatus\(st: any\): boolean/)
  assert.match(settings, /if \(!st\.running && !phase\) return false/)
})

test('archive run uses its reviewed source root, not a later edit to the input', () => {
  const start = settings.slice(settings.indexOf('async function startArchive('), settings.indexOf('async function pollArchive('))
  assert.match(start, /if \(archiveBusy\.value\) return/)
  assert.match(start, /source_root: preview\.source_root/)
})


test('concurrent archive reconnects create one poll and disposal cannot restart it', async () => {
  const body = settings.slice(settings.indexOf('async function restoreArchiveInFlight()'), settings.indexOf('onBeforeUnmount(() => {', settings.indexOf('async function restoreArchiveInFlight()')))
    .replace(/get<any>/g, 'get')
  let resolveStatus!: (status: any) => void
  let reads = 0
  let timers = 0
  const make = new Function('get', 'applyArchiveStatus', 'setInterval', `
    const archiveBusy = { value: false };
    let archivePoll = null, archiveRestoreInFlight = false, archivePanelDisposed = false;
    const pollArchive = () => {};
    ${body}
    return { restore: restoreArchiveInFlight, dispose: () => { archivePanelDisposed = true } };
  `)
  const makeFixture = () => make(
    () => { reads++; return new Promise(resolve => { resolveStatus = resolve }) },
    () => true,
    () => { timers++; return timers },
  )
  const first = makeFixture()
  const pending = first.restore()
  await first.restore()
  assert.equal(reads, 1)
  resolveStatus({ running: true, phase: 'preview' })
  await pending
  assert.equal(timers, 1)
  const disposed = makeFixture()
  const orphan = disposed.restore()
  disposed.dispose()
  resolveStatus({ running: true, phase: 'run' })
  await orphan
  assert.equal(timers, 1, 'unmounted settings must not start an orphan poll')
})


test('archive preview names only ready uploaded files and links their recorded upload', () => {
  assert.match(settings, /const archiveReadyRows = computed[\s\S]*?filter\(c => c\.status === 'ready'\)/)
  assert.match(settings, /v-for="c in archiveReadyRows"/)
  assert.match(settings, /Open recorded YouTube upload/)
  assert.match(settings, /encodeURIComponent\(c\.youtube_video_id\)/)
})

test('Free up space can clear the preview cache: shows its size, moves it to _trash, says it rebuilds', () => {
  assert.match(settings, /storage\.project_bytes_thumbnail_cache/)
  assert.match(settings, /@click="clearPreviewCache"/)
  assert.match(settings, /Clear preview cache \(\$\{formatBytes\(storage\.project_bytes_thumbnail_cache\)\}\)/)
  const fn = settings.slice(settings.indexOf('async function clearPreviewCache('), settings.indexOf('async function runBulkCleanup('))
  assert.match(fn, /storage\/clear-preview-cache/)
  assert.match(fn, /if \(previewCacheClearing\.value\) return/)
  assert.match(fn, /await loadStorageAudit\(\)/)
  assert.match(settings, /moved to this project's <code>_trash<\/code> folder/)
  assert.match(settings, /rebuilds automatically/)
})
