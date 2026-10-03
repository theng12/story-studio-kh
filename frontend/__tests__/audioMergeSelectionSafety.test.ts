import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { transform } from 'esbuild'
import { ref, reactive, computed } from 'vue'

const page = readFileSync(new URL('../pages/projects/[slug]/audio-merge.vue', import.meta.url), 'utf8')
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function loadReads() {
  // Execute the page's real async readers with controlled network completion.
  const scan = page.slice(page.indexOf('async function scanAssets()'), page.indexOf('\nfunction setMusicSource'))
  const merge = page.slice(page.indexOf('async function refreshMergeStatus()'), page.indexOf('\n/**', page.indexOf('async function refreshMergeStatus()')))
  const state = {
    episodeId: ref('EP0001'), slug: ref('project'), scanning: ref(false), scannedAssets: ref<any>(null), chapters: ref<any[]>([]),
    mergeStatus: reactive({ loading: false, error: '', present: false, file: '' }),
    music: reactive({ source: 'pool' }), poolPickedTrack: ref(''), poolPickedPath: ref(''), poolPickedReason: ref(''), poolPeekLoading: ref(false),
    showError: () => undefined, collapseToPortablePath: async (path: string) => path, applyTrackOverrides: () => undefined,
  }
  const requests = new Map<string, ReturnType<typeof deferred<any>>>()
  const get = (path: string) => { const d = deferred<any>(); requests.set(path, d); return d.promise }
  const code = await transform(`let scanSequence = 0; let mergeStatusSequence = 0; let poolPeekSequence = 0; ${scan}\n${merge}`, { loader: 'ts', format: 'esm' })
  const functions = new Function(...Object.keys(state), 'get', `${code.code}; return { scanAssets, refreshMergeStatus, refreshPoolPeek }`)(...Object.values(state), get)
  return { state, requests, ...functions }
}

async function loadSubmit() {
  const submit = page.slice(page.indexOf("async function generateMergedAudio(writeMode"), page.indexOf('\n/**', page.indexOf("async function generateMergedAudio(writeMode")))
  const state = {
    episodeId: ref('EP0001'), slug: ref('project'), generating: ref(false), scanning: ref(false),
    chapters: ref([{ path: '/first.mp3' }]), gapDuration: ref(5), normalizeVolume: ref(false), narrationVolume: ref(100), chunkSilenceSec: ref(0),
    intro: reactive({ enabled: false, file: '', volume: 100, gap_after: 2 }),
    music: reactive({ enabled: false, source: 'manual', volume: 10, post_narration_volume: 10, fade_in: 0, fade_out: 0, lead_in_enabled: false, lead_in_seconds: 0 }),
    selectedMusicFiles: ref<string[]>([]), poolPickedTrack: ref(''), poolPickedPath: ref(''),
    backgroundNoise: reactive({ enabled: false, mode: 'preset', preset: '', custom_file: '', volume: 0, fade_in: 0, fade_out: 0 }),
    ambientTracks: reactive<any[]>([]), audioMergeGenerating: ref(false), ffmpegStatus: ref({ installed: true }),
    normalizeAudioMergePathsInState: async () => undefined, success: () => undefined, showError: () => undefined,
    musicChoiceMissing: ref(false),
  }
  const posts: Array<ReturnType<typeof deferred<any>>> = []
  const post = () => { const request = deferred<any>(); posts.push(request); return request.promise }
  const code = await transform(`let audioScopeSequence = 0; let mergeSubmitSequence = 0; ${submit}`, { loader: 'ts', format: 'esm' })
  const functions = new Function(...Object.keys(state), 'post', `${code.code}; return { generateMergedAudio, invalidate: () => { audioScopeSequence++ } }`)(...Object.values(state), post)
  return { state, posts, ...functions }
}

test('late Audio Assembly scans and integrity checks cannot replace another episode', async () => {
  const { state, requests, scanAssets, refreshMergeStatus } = await loadReads()
  state.music.source = 'manual'
  const first = scanAssets()
  const oldIntegrity = refreshMergeStatus()
  state.episodeId.value = 'EP0002'
  const second = scanAssets()
  const newIntegrity = refreshMergeStatus()
  requests.get('/projects/project/audio-editor/scan/EP0002')!.resolve({ chapters: [{ path: '/second.mp3' }] })
  requests.get('/projects/project/episodes/EP0002/audio-merge-status')!.resolve({ present: true, file: '/second-merge.mp3' })
  await Promise.all([second, newIntegrity])
  requests.get('/projects/project/audio-editor/scan/EP0001')!.resolve({ chapters: [{ path: '/first.mp3' }] })
  requests.get('/projects/project/episodes/EP0001/audio-merge-status')!.resolve({ present: true, file: '/first-merge.mp3' })
  await Promise.all([first, oldIntegrity])
  assert.equal(state.chapters.value[0].path, '/second.mp3')
  assert.equal(state.mergeStatus.file, '/second-merge.mp3')
})

test('a late Music Pool read does not reapply the pool after choosing manual music', async () => {
  const { state, requests, refreshPoolPeek } = await loadReads()
  const pending = refreshPoolPeek()
  state.music.source = 'manual'
  requests.get('/projects/project/music-pool/peek-next?episode_code=EP0001')!.resolve({ track: { path: '/pool.mp3', filename: 'pool.mp3' }, reason: 'next' })
  await pending
  assert.equal(state.poolPickedPath.value, '')
  assert.equal(state.poolPickedTrack.value, '')
  assert.equal(state.poolPeekLoading.value, false)
})

test('a stale failed merge submission cannot clear a newer submission pulse', async () => {
  const { state, posts, generateMergedAudio, invalidate } = await loadSubmit()
  const first = generateMergedAudio()
  await Promise.resolve()
  assert.equal(posts.length, 1)
  state.episodeId.value = 'EP0002'
  invalidate()
  state.generating.value = false // mirrors the page's episode watcher
  const second = generateMergedAudio()
  await Promise.resolve()
  assert.equal(posts.length, 2)
  posts[0]!.reject(new Error('first request failed'))
  await first
  assert.equal(state.audioMergeGenerating.value, true)
  posts[1]!.reject(new Error('second request failed'))
  await second
  assert.equal(state.audioMergeGenerating.value, false)
})

test('Background Music on with no track chosen is refused instead of merging without a bed', async () => {
  // The page's own rule, evaluated against its real inputs.
  const start = page.indexOf('const musicChoiceMissing = computed(')
  const end = page.indexOf('\n\n', start)
  const rule = (await transform(page.slice(start, end), { loader: 'ts', format: 'esm' })).code
  const music = reactive({ enabled: true, source: 'manual' })
  const hasSelectedMusic = ref(false)
  const poolPeekLoading = ref(false)
  const missing = new Function('computed', 'music', 'hasSelectedMusic', 'poolPeekLoading', `${rule}; return musicChoiceMissing`)(
    computed, music, hasSelectedMusic, poolPeekLoading)
  assert.equal(missing.value, true, '"Choose for this episode" with an empty playlist')
  hasSelectedMusic.value = true
  assert.equal(missing.value, false)
  hasSelectedMusic.value = false
  music.source = 'pool'
  poolPeekLoading.value = true
  assert.equal(missing.value, false, 'a pool pick still loading is not a missing choice')
  poolPeekLoading.value = false
  assert.equal(missing.value, true, 'a pool with nothing eligible is a missing choice too')
  music.enabled = false
  assert.equal(missing.value, false, 'music off is a deliberate choice')

  const { state, posts, generateMergedAudio } = await loadSubmit()
  state.music.enabled = true
  state.musicChoiceMissing.value = true
  await generateMergedAudio()
  assert.equal(posts.length, 0, 'nothing is merged')
})
