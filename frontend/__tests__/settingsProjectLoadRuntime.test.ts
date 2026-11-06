import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, h, nextTick, reactive, ref, type Component } from 'vue'
import { projectSettingsSavePlan } from '../utils/projectSettingsSave.ts'

const filename = fileURLToPath(new URL('../pages/projects/[slug]/settings.vue', import.meta.url))
const appFilesName = fileURLToPath(new URL('../components/AppFilesSettings.vue', import.meta.url))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function loadComponent(componentFilename: string, compileId: string, support: string): Promise<Component> {
  const { descriptor } = parse(readFileSync(componentFilename, 'utf8'), { filename: componentFilename })
  const script = compileScript(descriptor, { id: compileId })
  const vueUrl = await import.meta.resolve('vue')
  const content = script.content
    .replace(/^import[^\n]+\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const output = await transform(`${support}\n${content}\nconst setup = __sfc__.setup
    __sfc__.setup = (props, ctx) => {
      const state = setup(props, ctx)
      globalThis.__settingsFixture.state = state
      return () => h('main')
    }
    export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    output.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

async function loadPage(): Promise<Component> {
  return loadComponent(filename, 'settings-project-load-runtime', `
    import { computed, defineComponent as _defineComponent, h, reactive, ref, watch } from ${JSON.stringify(await import.meta.resolve('vue'))}
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const onMounted = () => undefined
    const onBeforeUnmount = () => undefined
    const useRoute = () => globalThis.__settingsFixture.route
    // The app-level hashes (ffmpeg, maintenance, about...) now belong to the
    // /settings page; the channel page only redirects them there.
    const useRouter = () => globalThis.__settingsFixture.router || { replace: async () => undefined }
    const useApi = () => globalThis.__settingsFixture.api
    const useProject = () => globalThis.__settingsFixture.projectState
    const useToast = () => ({ success: () => undefined, error: () => undefined, info: () => undefined })
    const useConfirm = () => ({ ask: async () => false })
    const useConfirmSkip = () => ({ askSkippable: async () => false })
    const useVisualStyleCatalog = () => ({ styles: ref([]), loading: ref(false), error: ref(''), refresh: async () => undefined })
    // The channel page reads the installed Content Pack catalog for the project pin selector.
    const useContentStore = () => ({ planPinMove: async () => ({}), applyPinMove: async () => ({}) })
    const useGenStudioTranscriptionModels = () => ({ modelId: ref(''), options: ref([]), loading: ref(false), error: ref(''), isStale: ref(false), sourceFreshness: ref(null), load: async () => undefined })
    const useNiches = () => ({ find: () => null, niches: ref([]), isLoading: ref(false), error: ref(''), createNiche: async () => undefined, deleteNiche: async () => undefined, refresh: async () => undefined, selectionId: (id) => id, ensureListed: async () => undefined })
    const useTopicPacks = () => ({ topicPacks: ref([]), find: () => null, selectionId: (id) => id, ensureListed: async () => undefined })
    const useRuntimeConfig = () => ({ public: {} })
    const pickFolderShared = async () => undefined
    const resolveSettingsSectionHash = () => null
    const settingsAnchorTargetIds = () => []
    const projectSettingsSavePlan = (...args) => (globalThis.__settingsFixture.savePlan || (() => ({})))(...args)
    const genstudioStaleNote = () => ''
    const CONTENT_LANGUAGE_OPTIONS = []
    // The channel page shows only the project zone.
    const SETTINGS_ZONES = [{ id: 'project', title: 'This Channel', scope: 'project', sections: [{ id: 'writing', label: 'Writing & style', description: '' }, { id: 'publishing', label: 'Publishing', description: '' }] }]
  `)
}

// The app-level Files & maintenance panel (library, archive, FFmpeg, version)
// lives in its own component; its runtime cases run against that source. The
// mounted hooks must be REAL so the component's own mount-time status read runs.
async function loadAppFiles(): Promise<Component> {
  return loadComponent(appFilesName, 'app-files-settings-load-runtime', `
    import { computed, defineComponent as _defineComponent, h, onBeforeUnmount, onMounted, reactive, ref, watch } from ${JSON.stringify(await import.meta.resolve('vue'))}
    const useApi = () => globalThis.__settingsFixture.api
    const useConfirm = () => ({ ask: async () => false })
    const useToast = () => ({ success: () => undefined, error: () => undefined, info: () => undefined })
    const useRuntimeConfig = () => globalThis.__settingsFixture.runtimeConfig || { public: {} }
  `)
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index++) {
    await Promise.resolve()
    await nextTick()
  }
}

test('a stale project standards load cannot restore A drafts after switching to B', async () => {
  const aStandards = deferred<{ content: string }>()
  const route = reactive({ params: reactive({ slug: 'project-a' }), hash: '', query: {} })
  const config = ref<any>({
    standards_presets: [{ id: 'a-preset', name: 'A preset', content: 'A' }],
    intro_presets: [{ id: 'a-intro', name: 'A intro', content: 'A intro' }],
    intro_standards: 'A intro rules',
  })
  const fixture: any = {
    route,
    api: {
      get: async (path: string) => path.includes('project-a') ? aStandards.promise : { content: 'B instructions' },
      post: async () => ({}), put: async () => ({}), patch: async () => ({}), del: async () => ({}),
    },
    projectState: {
      project: ref(null), config,
      refreshConfig: async () => undefined, loadProject: async () => undefined,
    },
  }
  ;(globalThis as any).__settingsFixture = fixture
  const app = createApp(await loadPage())
  const host = document.body.appendChild(document.createElement('div'))
  app.mount(host)
  await flush()
  try {
    fixture.state.activeTab.value = 'writing'
    await flush()

    route.params.slug = 'project-b'
    config.value = null
    await flush()
    assert.notEqual(fixture.state.standards.value, 'A instructions')
    assert.notEqual(fixture.state.introStandards.value, 'A intro rules')
    assert.equal(fixture.state.standardsPresets.value.some((preset: any) => preset.id === 'a-preset'), false)
    assert.equal(fixture.state.writingControlsDisabled.value, true)

    config.value = {
      standards_presets: [{ id: 'b-preset', name: 'B preset', content: 'B' }],
      intro_presets: [{ id: 'b-intro', name: 'B intro', content: 'B intro' }],
      intro_standards: 'B intro rules',
    }
    await flush()
    assert.equal(fixture.state.standards.value, 'B instructions')
    assert.equal(fixture.state.introStandards.value, 'B intro rules')
    assert.deepEqual(fixture.state.standardsPresets.value.map((preset: any) => preset.id), ['b-preset'])

    aStandards.resolve({ content: 'A instructions' })
    await flush()
    assert.equal(fixture.state.standards.value, 'B instructions')
    assert.equal(fixture.state.introStandards.value, 'B intro rules')
  } finally {
    app.unmount()
    host.remove()
    delete (globalThis as any).__settingsFixture
  }
})

// ── DS-11 (F-05) — the two competing category writers ──────────────────────

test('a project refresh cannot blank the hydrated YouTube category, and a deliberate change survives it', async () => {
  const route = reactive({ params: reactive({ slug: 'project-a' }), hash: '', query: {} })
  const project = ref<any>({ name: 'A', episode_prefix: 'EP' })
  const config = ref<any>({ category_id: 27, mark_as_ai_generated: false })
  const puts: Array<{ path: string; body: any }> = []
  const fixture: any = {
    route,
    savePlan: projectSettingsSavePlan,
    api: {
      get: async () => ({}),
      post: async () => ({}),
      put: async (path: string, body: any) => { puts.push({ path, body }); return {} },
      patch: async () => ({}),
      del: async () => ({}),
    },
    projectState: {
      project, config,
      refreshConfig: async () => undefined, loadProject: async () => undefined,
    },
  }
  ;(globalThis as any).__settingsFixture = fixture
  const app = createApp(await loadPage())
  const host = document.body.appendChild(document.createElement('div'))
  app.mount(host)
  await flush()
  try {
    assert.equal(fixture.state.projectForm.category_id, 27, 'the saved category must hydrate from ProjectConfig')

    // `loadProject()` fetches project meta and config IN PARALLEL, so meta can
    // resolve after config. Replacing the project ref must not blank the field:
    // the old code reset `category_id = undefined` here, and the next Publishing
    // save then persisted that silent clear.
    project.value = { name: 'A renamed', episode_prefix: 'EP' }
    await flush()
    assert.equal(fixture.state.projectForm.category_id, 27,
      'a later project-meta load must not wipe this project’s own saved category')

    // A deliberate choice the customer has not saved yet must survive the same event.
    fixture.state.projectForm.category_id = 31
    project.value = { name: 'A renamed again', episode_prefix: 'EP' }
    await flush()
    assert.equal(fixture.state.projectForm.category_id, 31,
      'an unsaved deliberate change must survive a project refresh')

    // Saving writes the config that owns the category. v1.4.249: Publishing owns no
    // project.json field any more (youtube_channel_url is gone), so that file is left alone.
    await fixture.state.saveProject('publishing')
    await flush()
    const projectWrite = puts.find(entry => entry.path === '/projects/project-a')
    const configWrite = puts.find(entry => entry.path === '/projects/project-a/settings/config')
    assert.equal(projectWrite, undefined, 'the Publishing save must not rewrite the project record')
    assert.ok(configWrite, 'the category belongs to ProjectConfig and must be written there')
    assert.equal(configWrite.body.category_id, 31, 'the customer’s deliberate category must persist')

    // Switching project blanks the previous project’s Publishing values…
    route.params.slug = 'project-b'
    config.value = null
    await flush()
    assert.equal(fixture.state.projectForm.category_id, undefined,
      'another project must not inherit the previous project’s category')
    // …then hydrates this project’s own.
    config.value = { category_id: 10 }
    await flush()
    assert.equal(fixture.state.projectForm.category_id, 10, 'the new project’s saved category must hydrate')
  } finally {
    app.unmount()
    host.remove()
    delete (globalThis as any).__settingsFixture
  }
})

// ── DS-11 (F-04) — the FFmpeg card fetches its status before proposing repairs ──
// The card moved into <AppFilesSettings>, which owns the whole Files & maintenance
// panel, so the card's status read happens on THAT component's mount rather than
// when a channel tab is opened. The guard stays the same: no install action may be
// offered for a status that was never read, and a failed check is unknown, not
// "not installed" (§6).

test('the app Files panel reads the FFmpeg status on mount, and a failed check is unknown rather than "not installed"', async () => {
  let ffmpegCheck: 'ok' | 'fail' = 'ok'
  const gets: string[] = []
  const fixture: any = {
    api: {
      get: async (path: string) => {
        gets.push(path)
        if (path === '/ffmpeg/status') {
          if (ffmpegCheck === 'fail') {
            const err: any = new Error('backend unreachable')
            err.data = { detail: 'Backend unreachable' }
            throw err
          }
          return { installed: true, source: 'bundled', has_drawtext: true, has_libass: true, version: '7.1' }
        }
        return {}
      },
      post: async () => ({}), put: async () => ({}), patch: async () => ({}), del: async () => ({}),
    },
  }
  ;(globalThis as any).__settingsFixture = fixture
  const app = createApp(await loadAppFiles())
  const host = document.body.appendChild(document.createElement('div'))
  app.mount(host)
  await flush()
  try {
    assert.ok(gets.includes('/ffmpeg/status'),
      'mounting the Files panel must fetch the real status before any repair action is offered')
    assert.equal(fixture.state.ffmpegStatus.value?.installed, true, 'a successful check stores the real status')
    assert.equal(fixture.state.ffmpegStatusError.value, '')

    // A failed re-check is its own state. Rendering it as `{ installed: false }`
    // is what made the card invite a replacement download it could not justify.
    ffmpegCheck = 'fail'
    await fixture.state.refreshFfmpegStatus()
    await flush()
    assert.equal(fixture.state.ffmpegStatus.value, null, 'a failed check leaves the status unknown')
    assert.equal(fixture.state.ffmpegStatusError.value, 'Backend unreachable',
      'the failure must be stated so the card can explain it and offer Retry')

    // And a later success clears the failure.
    ffmpegCheck = 'ok'
    await fixture.state.refreshFfmpegStatus()
    await flush()
    assert.equal(fixture.state.ffmpegStatus.value?.installed, true)
    assert.equal(fixture.state.ffmpegStatusError.value, '')
  } finally {
    app.unmount()
    host.remove()
    delete (globalThis as any).__settingsFixture
  }
})

// v1.4.249 — the FFmpeg card is one plain sentence plus at most one fix button,
// computed in `ffmpegState`. The fix button (a download) is never offered for a
// status that was never read, a failed check, or a bundled copy. The card now
// lives in <AppFilesSettings>.
test('the FFmpeg card offers a download only for a real, fixable status', async () => {
  const fixture: any = {
    api: { get: async () => ({}), post: async () => ({}), put: async () => ({}), patch: async () => ({}), del: async () => ({}) },
  }
  ;(globalThis as any).__settingsFixture = fixture
  const app = createApp(await loadAppFiles())
  const host = document.body.appendChild(document.createElement('div'))
  app.mount(host)
  await flush()
  try {
    const st = fixture.state
    st.ffmpegStatus.value = null
    assert.equal(st.ffmpegState.value.fix, '', 'unknown status: no download offered')
    st.ffmpegStatusError.value = 'Backend unreachable'
    assert.match(st.ffmpegState.value.title, /Could not check/)
    assert.equal(st.ffmpegState.value.fix, '', 'a failed check is not "missing"')
    st.ffmpegStatusError.value = ''
    st.ffmpegStatus.value = { installed: true, source: 'bundled', has_drawtext: true, has_libass: true }
    assert.equal(st.ffmpegState.value.title, 'Ready — includes text overlays and subtitle burn-in')
    assert.equal(st.ffmpegState.value.fix, '')
    st.ffmpegStatus.value = { installed: true, source: 'bundled', has_drawtext: false, has_libass: true }
    assert.equal(st.ffmpegState.value.fix, '', 'a bundled copy is pinned and never replaced from Settings')
    st.ffmpegStatus.value = { installed: true, source: 'system', has_drawtext: false, has_libass: false }
    assert.match(st.ffmpegState.value.title, /missing text overlays and subtitle burn-in/)
    assert.equal(st.ffmpegState.value.fix, 'Install Full Version')
    st.ffmpegStatus.value = { installed: false, source: 'not-found' }
    assert.equal(st.ffmpegState.value.fix, 'Install FFmpeg')
  } finally {
    app.unmount()
    host.remove()
    delete (globalThis as any).__settingsFixture
  }
})

test('the FFmpeg internals sit behind Advanced', () => {
  const appFiles = readFileSync(appFilesName, 'utf8')
  assert.match(appFiles, /<AdvancedDisclosure label="Advanced: FFmpeg details">[\s\S]{0,400}ffmpegStatus\?\.path/,
    'the resolved path lives behind Advanced, not on the card')
  assert.match(appFiles, /<details v-if="ffmpegStatus && ffmpegStatus\.source !== 'bundled'"/,
    'the manual-install fallback must not appear for a status that was never read')
})

// ── Shell audit 2026-10-03 — a backfill never runs on values that failed to save ──

test('YouTube backfill stops when saving the Publishing form fails, so old saved values are never applied to every video', async () => {
  const route = reactive({ params: reactive({ slug: 'project-a' }), hash: '', query: {} })
  const posts: string[] = []
  const fixture: any = {
    route,
    savePlan: projectSettingsSavePlan,
    api: {
      get: async () => ({}),
      post: async (path: string) => { posts.push(path); return { updated: 3, skipped: 0, items: [] } },
      put: async () => { throw Object.assign(new Error('save failed'), { data: { detail: 'Disk is read-only.' } }) },
      patch: async () => ({}),
      del: async () => ({}),
    },
    projectState: {
      project: ref<any>({ name: 'A', episode_prefix: 'EP' }), config: ref<any>({ category_id: 27, mark_as_ai_generated: true }),
      refreshConfig: async () => undefined, loadProject: async () => undefined,
    },
  }
  ;(globalThis as any).__settingsFixture = fixture
  const app = createApp(await loadPage())
  const host = document.body.appendChild(document.createElement('div'))
  app.mount(host)
  await flush()
  try {
    assert.equal(await fixture.state.saveProject('publishing'), false, 'a failed save says so')
    await fixture.state.runYoutubeBackfill(false)
    await fixture.state.runYoutubeBackfill(true)
    assert.deepEqual(posts.filter(path => path.includes('youtube-backfill')), [])
  } finally {
    app.unmount()
    host.remove()
    delete (globalThis as any).__settingsFixture
  }
})

test('a config refresh (art style or guide slider saved) keeps unsaved drafts, and still updates untouched fields', async () => {
  const route = reactive({ params: reactive({ slug: 'project-a' }), hash: '', query: {} })
  const config = ref<any>({ intro_standards: 'Saved intro', category_id: 27, mark_as_ai_generated: false })
  const fixture: any = {
    route,
    api: { get: async () => ({ content: '' }), post: async () => ({}), put: async () => ({}), patch: async () => ({}), del: async () => ({}) },
    projectState: { project: ref<any>({ name: 'A', episode_prefix: 'EP' }), config, refreshConfig: async () => undefined, loadProject: async () => undefined },
  }
  ;(globalThis as any).__settingsFixture = fixture
  const app = createApp(await loadPage())
  const host = document.body.appendChild(document.createElement('div'))
  app.mount(host)
  await flush()
  try {
    assert.equal(fixture.state.introStandards.value, 'Saved intro')
    fixture.state.introStandards.value = 'Half-typed new intro'
    fixture.state.projectForm.category_id = 31
    // Saving the art style refreshes the whole config object.
    config.value = { intro_standards: 'Saved intro', category_id: 27, mark_as_ai_generated: true }
    await flush()
    assert.equal(fixture.state.introStandards.value, 'Half-typed new intro', 'unsaved intro text survives')
    assert.equal(fixture.state.projectForm.category_id, 31, 'unsaved category survives')
    assert.equal(fixture.state.projectForm.mark_as_ai_generated, true, 'an untouched field takes the fresh value')
  } finally {
    app.unmount()
    host.remove()
    delete (globalThis as any).__settingsFixture
  }
})
