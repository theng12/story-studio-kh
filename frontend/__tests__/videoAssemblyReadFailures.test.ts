/**
 * DS-10 (E-04, E-05, E-07, E-08, E-09) — a failed read must not render as a
 * confident, specific, wrong answer.
 *
 * AGENTS.md §6: "a zero that means two things is a defect". Each of these five
 * surfaces used to collapse "I could not work out the answer" into "the answer
 * is none": Step 1 of Video Assembly rendered blank after a failed asset scan,
 * the transition picker sat on "Loading transitions…" forever, Step 5 announced
 * "No subtitle file for this episode yet" before (and after a failure of) the
 * status read, the Subtitles page claimed "No chapter audio found", and the
 * chapter selector claimed "No sections found. Generate the script first."
 *
 * The page halves are pinned by source analysis (they need the Nuxt runtime to
 * mount); the composable half — `scanError` — is exercised behaviourally.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { ref } from 'vue'

function page(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../pages/projects/[slug]/${name}`, import.meta.url)), 'utf8')
}

function component(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../components/${name}`, import.meta.url)), 'utf8')
}

// ── E-08 — Video Assembly Step 1 keeps a failed scan retryable ──────────────

test('E-08: Video Assembly keeps a failed asset scan visible with a retry', () => {
  const source = page('video-assembly.vue')
  assert.match(source, /scanError, generateVideo/, 'the page must consume the composable scan error')
  const banner = source.indexOf('v-if="scanError && !scanning"')
  assert.ok(banner >= 0, 'the failed-scan banner must exist')
  const overview = source.indexOf('v-if="scannedAssets && !scanning"')
  assert.ok(overview >= 0, 'the findings overview must still be gated on a real scan')
  assert.ok(banner < overview, 'the failed-scan banner must sit where the overview would have been')
  assert.match(source.slice(banner, overview), /@click="scanAssets"/, 'the failure must offer a retry')
})

test('E-08 (behaviour): a failed scan sets scanError, a later success clears it', async () => {
  ;(globalThis as any).$fetch = async () => ({ boot_complete: true })
  const { useVideoAssemblyIo } = await import('../composables/useVideoAssemblyIo.js')
  const state = {
    slug: ref('proj-x'),
    episodeId: ref('EP0001'),
    visualSource: ref<'scene_plan' | 'image_pool'>('scene_plan'),
    selectedEpisode: ref<any>({ title: 'One' }),
    ffmpegStatus: ref<any>(null),
    scannedAssets: ref<any>(null),
    scanning: ref(false),
    scenes: ref<any[]>([]),
    excludeIntroFromEffects: ref(false),
    logo: {}, intro: {}, outro: {},
    titleImage: { image_path: '' },
    timelineClips: ref<any[]>([]),
    sceneRecycling: {}, transition: {}, sceneAnimation: {}, postAudio: {},
    colorGrading: {}, vignette: {}, filmGrain: {}, agedArchiveFilm: {},
    letterbox: {}, chromaKey: {}, titleCard: { text: '' }, chapterTitles: {},
    outroCard: {}, exportSettings: {}, subtitles: {},
  }
  const io = useVideoAssemblyIo(state as any)

  ;(globalThis as any).$fetch = async () => {
    const err: any = new Error('backend down')
    err.data = { detail: 'Could not read the episode folder' }
    throw err
  }
  await io.scanAssets()
  assert.equal(io.scanError.value, 'Could not read the episode folder',
    'the failure detail must be retained so the page can state it')
  assert.equal(state.scannedAssets.value, null, 'a failed scan leaves no findings to display')
  assert.equal(state.scanning.value, false, 'the scan must not stay stuck in progress')

  ;(globalThis as any).$fetch = async (url: string) => url.includes('/health')
    ? { boot_complete: true, status: 'ok' }
    : { scenes: [{ source: 'scene_plan', path: '/one.png' }], thumbnails: [] }
  await io.scanAssets()
  assert.equal(io.scanError.value, '', 'a successful rescan must clear the failure')
  assert.ok(state.scannedAssets.value, 'the rescan must publish its findings')
})

test('E-08 (behaviour): a failure for an episode the customer left cannot label the new one', async () => {
  const { useVideoAssemblyIo } = await import('../composables/useVideoAssemblyIo.js')
  let firstReject: (e: any) => void = () => {}
  ;(globalThis as any).$fetch = async (url: string) => {
    if (url.includes('/health')) return { boot_complete: true, status: 'ok' }
    if (url.endsWith('/EP0001')) return await new Promise((_r, reject) => { firstReject = reject })
    return { scenes: [], thumbnails: [] }
  }
  const state = {
    slug: ref('proj-x'),
    episodeId: ref('EP0001'),
    visualSource: ref<'scene_plan' | 'image_pool'>('scene_plan'),
    selectedEpisode: ref<any>(null),
    ffmpegStatus: ref<any>(null),
    scannedAssets: ref<any>(null),
    scanning: ref(false),
    scenes: ref<any[]>([]),
    excludeIntroFromEffects: ref(false),
    logo: {}, intro: {}, outro: {},
    titleImage: { image_path: '' },
    timelineClips: ref<any[]>([]),
    sceneRecycling: {}, transition: {}, sceneAnimation: {}, postAudio: {},
    colorGrading: {}, vignette: {}, filmGrain: {}, agedArchiveFilm: {},
    letterbox: {}, chromaKey: {}, titleCard: { text: '' }, chapterTitles: {},
    outroCard: {}, exportSettings: {}, subtitles: {},
  }
  const io = useVideoAssemblyIo(state as any)
  const stale = io.scanAssets()
  state.episodeId.value = 'EP0002'
  const fresh = io.scanAssets()
  await fresh
  firstReject(Object.assign(new Error('late failure'), { data: { detail: 'old episode failed' } }))
  await stale
  assert.equal(io.scanError.value, '',
    'the superseded episode’s failure must not become the current episode’s error')
})

// ── E-07 — the transition catalogue distinguishes loading, failure, empty ───

test('E-07: Video Assembly states a failed transition-catalogue read and retries it', () => {
  const source = page('video-assembly.vue')
  assert.match(source, /const transitionsCatalogLoading = ref\(true\)/, 'the catalogue needs its own loading state')
  assert.match(source, /const transitionsCatalogError = ref\(''\)/, 'and its own failure state')
  const loader = source.slice(source.indexOf('async function loadTransitionsCatalog()'), source.indexOf('const transitionPresets'))
  assert.match(loader, /transitionsCatalogError\.value = e\?\.data\?\.detail/, 'the read catch must retain the failure')
  assert.match(loader, /transitionsCatalogError\.value = ''/, 'a successful read must clear it')
  assert.match(loader, /finally \{[\s\S]{0,120}transitionsCatalogLoading\.value = false/,
    'loading must clear on both paths, or the picker hangs on "Loading transitions…"')
  const loadingBranch = source.indexOf('v-if="transitionsCatalogLoading"')
  const errorBranch = source.indexOf('v-else-if="transitionsCatalogError"')
  assert.ok(loadingBranch >= 0 && errorBranch > loadingBranch,
    'the failure branch must be reachable, not hidden behind the loading branch')
  assert.match(source.slice(errorBranch, errorBranch + 600), /@click="loadTransitionsCatalog"/,
    'the failure must offer a retry')
})

// ── E-09 — Step 5 distinguishes "no transcript" from "could not read" ──────

test('E-09: Video Assembly does not claim "no subtitle file" before or after a failed read', () => {
  const source = page('video-assembly.vue')
  assert.match(source, /const subtitlesStatusLoading = ref\(false\)/)
  assert.match(source, /const subtitlesStatusError = ref\(''\)/)
  const loader = source.slice(source.indexOf('async function loadSubtitlesStatus()'), source.indexOf('async function pinSubtitle'))
  assert.match(loader, /subtitlesStatusLoading\.value = true/, 'the read must mark itself in flight')
  assert.match(loader, /subtitlesStatusError\.value = e\?\.data\?\.detail/, 'the read catch must retain the failure')
  assert.match(loader, /subtitlesStatusLoading\.value = false/, 'the read must clear the in-flight state')
  const emptyClaim = source.indexOf('No subtitle file for this episode yet')
  assert.ok(emptyClaim >= 0, 'the genuine empty case keeps its guidance')
  const guard = source.slice(source.lastIndexOf('<p v-else-if=', emptyClaim), emptyClaim)
  assert.match(guard, /episodeId && !burnView\.burning/,
    'the empty claim must be gated on a completed read for a real episode')
  const failureBranch = source.indexOf('v-else-if="subtitlesStatusError"')
  assert.ok(failureBranch >= 0 && failureBranch < emptyClaim, 'the failure branch must precede the empty claim')
  assert.match(source.slice(failureBranch, emptyClaim), /@click="loadSubtitlesStatus"/, 'the failure must offer a retry')
})

// ── E-04 — the Subtitles page distinguishes a failed read from no audio ────

test('E-04: Subtitles keeps a failed status read distinct from "No chapter audio found"', () => {
  const source = page('subtitles.vue')
  assert.match(source, /const statusError = ref\(''\)/, 'the page must track the status-read failure')
  const emptyClaim = source.indexOf('No chapter audio found for {{ episodeId }}')
  assert.ok(emptyClaim >= 0, 'the genuine missing-audio guidance must survive')
  const failureBranch = source.indexOf('v-if="statusError"')
  assert.ok(failureBranch >= 0, 'the failed-read branch must exist')
  assert.ok(failureBranch < emptyClaim, 'the failed-read branch must precede the missing-audio claim')
  assert.match(source.slice(failureBranch, emptyClaim), /@click="loadStatus"/, 'the failure must offer a retry')
  const loader = source.slice(source.indexOf('async function loadStatus()'), source.indexOf('watch(() => route.query.episode_id'))
  assert.match(loader, /statusError\.value = e\?\.data\?\.detail/, 'the read catch must retain the failure')
  assert.match(loader, /statusError\.value = ''/, 'a successful read must clear it')
})

// ── E-05 — the chapter selector distinguishes a failed scan from no script ─

test('E-05: AudioChapterSelector distinguishes a failed scan from "No sections found"', () => {
  const source = component('AudioChapterSelector.vue')
  assert.match(source, /const loadError = ref\(''\)/, 'the selector must track the scan failure')
  const emptyClaim = source.indexOf('No sections found. Generate the script first, then this selector will')
  assert.ok(emptyClaim >= 0, 'the genuine empty-script guidance must survive')
  const failureBranch = source.indexOf('v-else-if="loadError"')
  assert.ok(failureBranch >= 0, 'the failed-scan branch must exist')
  assert.ok(failureBranch < emptyClaim, 'the failed-scan branch must precede the empty-script claim')
  assert.match(source.slice(failureBranch, emptyClaim), /@click="refresh"/, 'the failure must offer a retry')
  const loader = source.slice(source.indexOf('async function refresh()'), source.indexOf('watch(\n  () => [props.projectSlug'))
  assert.match(loader, /loadError\.value = e\?\.data\?\.detail/, 'the scan catch must retain the failure')
  assert.match(loader, /loadError\.value = ''/, 'a successful scan must clear it')
})

// Dreamlands E2E (2026-10-03): with 4 of 12 chapters narrated, Subtitles said
// "No chapter audio found for EP0002" and "No chapter audio — generate audio first".
test('Subtitles says how many chapters are narrated instead of "none" while narration is still running', () => {
  const source = page('subtitles.vue')
  const partial = source.indexOf('chapters of {{ episodeId }} are narrated so far')
  const none = source.indexOf('No chapter audio found for {{ episodeId }}')
  assert.ok(partial >= 0 && partial < none, 'the partial branch precedes the "none" claim')
  assert.match(source, /chapters narrated — finish the narration first/)
})
