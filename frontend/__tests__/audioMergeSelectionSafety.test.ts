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
  // The merge builds its request through the page's one payload builder, so the
  // harness executes both — the preview and Generate can never drift apart.
  const payloadBuilder = page.slice(page.indexOf('function buildAudioAssemblyPayload'), page.indexOf('\nconst previewMixLoading'))
  const submit = page.slice(page.indexOf("async function generateMergedAudio(writeMode"), page.indexOf('\n/**', page.indexOf("async function generateMergedAudio(writeMode")))
  const state = {
    episodeId: ref('EP0001'), slug: ref('project'), generating: ref(false), scanning: ref(false),
    chapters: ref([{ path: '/first.mp3' }]), gapDuration: ref(5), normalizeVolume: ref(false), narrationVolume: ref(100), chunkSilenceSec: ref(0),
    intro: reactive({ enabled: false, file: '', volume: 100, gap_after: 2 }),
    music: reactive({ enabled: false, source: 'manual', volume: 10, post_narration_volume: 10, fade_in: 0, fade_out: 0, lead_in_enabled: false, lead_in_seconds: 0 }),
    selectedMusicFiles: ref<string[]>([]), poolPickedTrack: ref(''), poolPickedPath: ref(''),
    ambience: reactive({ enabled: false }), backgroundNoise: reactive({ enabled: false, mode: 'preset', preset: '', custom_file: '', volume: 0, fade_in: 0, fade_out: 0 }),
    ambientTracks: reactive<any[]>([]),
    effects: reactive({ enabled: false }), effectsTracks: reactive<any[]>([]),
    backgroundVoice: reactive({ enabled: false }), backgroundVoiceTracks: reactive<any[]>([]),
    audioMergeGenerating: ref(false), ffmpegStatus: ref({ installed: true }),
    normalizeAudioMergePathsInState: async () => undefined, success: () => undefined, showError: () => undefined,
    musicNotChosen: ref(false),
  }
  const posts: Array<ReturnType<typeof deferred<any>>> = []
  const post = () => { const request = deferred<any>(); posts.push(request); return request.promise }
  const code = await transform(`let audioScopeSequence = 0; let mergeSubmitSequence = 0; ${payloadBuilder}\n${submit}`, { loader: 'ts', format: 'esm' })
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

// Owner, 2026-10-27: music is OPTIONAL. This used to be a refusal — Music on
// with no track chosen blocked the merge — which turned a channel preference
// into an episode that could not be assembled at all. The rule is now a quiet
// NOTE, and the merge proceeds narration-only.
test('Background Music on with no track chosen is a note, not a block', async () => {
  // The page's own rule, evaluated against its real inputs.
  const start = page.indexOf('const musicNotChosen = computed(')
  const end = page.indexOf('\n\n', start)
  const rule = (await transform(page.slice(start, end), { loader: 'ts', format: 'esm' })).code
  const music = reactive({ enabled: true, source: 'manual' })
  const hasSelectedMusic = ref(false)
  const poolPeekLoading = ref(false)
  const note = new Function('computed', 'music', 'hasSelectedMusic', 'poolPeekLoading', `${rule}; return musicNotChosen`)(
    computed, music, hasSelectedMusic, poolPeekLoading)
  assert.equal(note.value, true, '"Choose for this episode" with an empty playlist')
  hasSelectedMusic.value = true
  assert.equal(note.value, false)
  hasSelectedMusic.value = false
  music.source = 'pool'
  poolPeekLoading.value = true
  assert.equal(note.value, false, 'a pool pick still loading is not "no music chosen"')
  poolPeekLoading.value = false
  assert.equal(note.value, true, 'a pool with nothing eligible is "no music chosen" too')
  music.enabled = false
  assert.equal(note.value, false, 'music off is a deliberate choice')

  // The merge is NOT gated on it: with music on and nothing chosen, the queue
  // request still goes out — narration-only, exactly as today.
  const { state, posts, generateMergedAudio } = await loadSubmit()
  state.music.enabled = true
  const merging = generateMergedAudio()
  // The submit path awaits path normalisation before queueing, so let the
  // microtasks run before looking for the request.
  for (let tick = 0; tick < 5 && !posts.length; tick++) await Promise.resolve()
  assert.equal(posts.length, 1, 'narration-only assembly is queued')
  posts[0]!.resolve({ ok: true })
  await merging
  assert.equal(state.audioMergeGenerating.value, true, 'the job was accepted')
})

test('the page never renders the old refusal and never disables Generate for music', () => {
  // The exact regression the owner asked to drop.
  assert.doesNotMatch(page, /musicChoiceMissing/, 'the blocking rule must be gone')
  assert.doesNotMatch(page, /Background Music is on, but no track is chosen/,
    'the refusal sentence must be gone')
  assert.match(page, /No music chosen for this episode; assembling narration only/,
    'the quiet note replaces it')
  const generateButton = page.slice(page.indexOf('@click="onGenerateClick"') - 400, page.indexOf('@click="onGenerateClick"'))
  assert.doesNotMatch(generateButton, /musicNotChosen/,
    'Generate must not be disabled by a missing music choice')
})
