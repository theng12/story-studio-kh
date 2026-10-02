/**
 * B-Roll Picker runtime: the camera-move catalogue is fetched with the real
 * project slug, an episode switch never shows the previous episode's sequence,
 * the saved pick is read back, and one failing read doesn't blank the page.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, h, nextTick, ref, type Component } from 'vue'

const filename = fileURLToPath(new URL('../pages/projects/[slug]/broll.vue', import.meta.url))

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'broll-picker-runtime' })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, h, ref, reactive, watch, onMounted } from ${JSON.stringify(vueUrl)}
    const F = new Proxy({}, { get: (_, k) => globalThis.__brollFixture[k] })
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useRoute = () => F.route
    const useApi = () => ({ get: F.get, post: F.post, put: async () => ({}), del: async () => ({}) })
    const useToast = () => ({ success: () => undefined, error: (m) => F.errors.push(m) })
    const useConfirm = () => ({ ask: async () => true })
    const useProject = () => ({ project: ref(null), episodesRoot: ref('') })
    const useBrollPools = () => F.broll
    const usePresets = () => ({ load: async () => undefined })
    const useAutoSave = () => ({ scheduleSave: () => undefined })
    const useJobs = () => ({ isJobActiveFor: () => false })
    const useGenStudioTranscriptionModels = () => ({
      modelId: ref(''), selectedModel: ref(null), options: ref([]), loading: ref(false),
      error: ref(''), ready: ref(false), load: async () => undefined,
    })
    const defaultSubtitleStyle = () => ({})
    const normalizeSubtitleStyle = (s) => s
    const DEFAULT_TRANSCRIPTION_LANGUAGE = 'en'
    const defaultTranscriptionLanguage = () => 'en'
    const isTranscriptionLanguageUsable = () => true
    const transcriptionLanguageControl = () => ({ options: [] })
    const transcriptionLanguageRequestFields = () => ({})
  `
  const content = script.content
    .replace(/^import[\s\S]*?from [^\n]+\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const output = await transform(`${support}\n${content}\nconst setup = __sfc__.setup
    __sfc__.setup = (props, ctx) => {
      const state = setup(props, ctx)
      globalThis.__brollFixture.state = state
      return () => h('main')
    }
    export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    output.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) { await Promise.resolve(); await nextTick() }
}

function fixture(overrides: Partial<{ loadPools: () => Promise<void>; get: (p: string) => Promise<any> }> = {}) {
  const gets: string[] = []
  const f: any = {
    route: { params: { slug: 'proj-a' } },
    errors: [],
    gets,
    broll: {
      pools: ref([]),
      loading: ref(false),
      loadPools: overrides.loadPools || (async () => { f.broll.pools.value = [{ id: 'pool-1', name: 'P', folder_path: '/x', online: true }] }),
      listClips: async () => ({ clips: [], online: true }),
      thumbnailUrl: () => '',
    },
    post: async () => ({}),
    get: async (path: string) => {
      gets.push(path)
      if (overrides.get) {
        const r = await overrides.get(path)
        if (r !== undefined) return r
      }
      if (path.endsWith('/settings/config')) return { broll_pool_id: 'pool-1' }
      if (path.includes('/effects/catalog')) return { footage_motions: [{ id: 'zoom-in', name: 'Zoom in', description: 'Slow zoom' }] }
      if (path.includes('/broll/selection/EP0001')) {
        return { selection: [{ pool_id: 'pool-1', filename: 'a.mp4', target_duration: 5 }], target_duration: 60, segment_seconds: 6, generated_at: '2026-01-01T00:00:00Z' }
      }
      if (path.includes('/broll/selection/')) return { selection: null }
      if (path.includes('/subtitles/status/')) return { existing_srts: [{ filename: path.split('/').pop() + '.srt' }] }
      return {}
    },
  }
  ;(globalThis as any).__brollFixture = f
  return f
}

async function mount(f: any) {
  const app = createApp(await loadPage())
  const host = document.body.appendChild(document.createElement('div'))
  app.mount(host)
  await flush()
  return { state: f.state, unmount: () => { app.unmount(); host.remove() } }
}

test('the camera-move catalogue is fetched with the project slug, not "[object Object]"', async () => {
  const f = fixture()
  const { state, unmount } = await mount(f)
  try {
    assert.ok(f.gets.includes('/projects/proj-a/video-editor/effects/catalog'), f.gets.join('\n'))
    assert.deepEqual(state.motionOptions.value.map((m: any) => m.id), ['zoom-in'])
    assert.equal(state.motionCatalogueError.value, false)
  } finally { unmount() }
})

test('a failed catalogue keeps "Static" and says so', async () => {
  const f = fixture({ get: async (p) => { if (p.includes('/effects/catalog')) throw new Error('down') } })
  const { state, unmount } = await mount(f)
  try {
    assert.deepEqual(state.motionOptions.value.map((m: any) => m.id), ['static'])
    assert.equal(state.motionCatalogueError.value, true)
  } finally { unmount() }
})

test('switching episode drops the old sequence and loads the new episode own saved pick', async () => {
  const f = fixture()
  const { state, unmount } = await mount(f)
  try {
    state.form.episode_id = 'EP0001'
    await flush()
    assert.deepEqual(state.selection.value.map((s: any) => s.filename), ['a.mp4'])
    assert.equal(state.narrationTargetSec.value, 60)
    assert.equal(state.form.segment_seconds, 6, 'saved settings are restored')
    assert.equal(state.subtitlesStatus.value.existing_srts[0].filename, 'EP0001.srt')

    state.form.episode_id = 'EP0002'
    await flush()
    assert.deepEqual(state.selection.value, [], 'the previous episode sequence must not stay on screen')
    assert.equal(state.subtitlesStatus.value.existing_srts[0].filename, 'EP0002.srt')
  } finally { unmount() }
})

test('a failed subtitle read blanks the previous episode list and shows an error', async () => {
  let fail = false
  const f = fixture({ get: async (p) => { if (fail && p.includes('/subtitles/status/')) throw new Error('nope') } })
  const { state, unmount } = await mount(f)
  try {
    state.form.episode_id = 'EP0001'
    await flush()
    assert.ok(state.subtitlesStatus.value)
    fail = true
    state.form.episode_id = 'EP0002'
    await flush()
    assert.equal(state.subtitlesStatus.value, null)
    assert.match(state.subtitlesStatusError.value, /subtitle files/)
  } finally { unmount() }
})

test('a failed pool list shows an error but the rest of the page still loads', async () => {
  const f = fixture({ loadPools: async () => { throw new Error('server starting') } })
  const { state, unmount } = await mount(f)
  try {
    assert.match(state.loadError.value, /B-Roll pools \(server starting\)/)
    assert.ok(f.gets.some((p: string) => p.endsWith('/settings/config')), 'config still read')
    assert.equal(state.subscribedPoolId.value, 'pool-1')
  } finally { unmount() }
})

test('Pick explains why it is disabled', async () => {
  const f = fixture()
  const { state, unmount } = await mount(f)
  try {
    assert.equal(state.pickDisabledReason.value, 'Choose an episode first.')
    state.form.episode_id = 'EP0002'
    state.form.selection_mode = 'manual'
    await flush()
    assert.match(state.pickDisabledReason.value, /manual sequence/)
  } finally { unmount() }
})
