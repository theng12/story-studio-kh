import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, h, nextTick, reactive, ref, type Component } from 'vue'
import { projectSettingsSavePlan } from '../utils/projectSettingsSave.ts'

const filename = fileURLToPath(new URL('../pages/projects/[slug]/settings.vue', import.meta.url))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'settings-project-load-runtime' })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, h, reactive, ref, watch } from ${JSON.stringify(vueUrl)}
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const onMounted = () => undefined
    const onBeforeUnmount = () => undefined
    const useRoute = () => globalThis.__settingsFixture.route
    const useApi = () => globalThis.__settingsFixture.api
    const useProject = () => globalThis.__settingsFixture.projectState
    const useToast = () => ({ success: () => undefined, error: () => undefined, info: () => undefined })
    const useConfirm = () => ({ ask: async () => false })
    const useConfirmSkip = () => ({ askSkippable: async () => false })
    const useVisualStyleCatalog = () => ({ styles: ref([]), loading: ref(false), error: ref(''), refresh: async () => undefined })
    const useGenStudioTranscriptionModels = () => ({ modelId: ref(''), options: ref([]), loading: ref(false), error: ref(''), isStale: ref(false), sourceFreshness: ref(null), load: async () => undefined })
    const useNiches = () => ({ find: () => null, niches: ref([]), isLoading: ref(false), error: ref(''), createNiche: async () => undefined, deleteNiche: async () => undefined, refresh: async () => undefined })
    const useTopicPacks = () => ({ topicPacks: ref([]) })
    const useRuntimeConfig = () => ({ public: {} })
    const pickFolderShared = async () => undefined
    const resolveSettingsSectionHash = () => null
    const settingsAnchorTargetIds = () => []
    const projectSettingsSavePlan = (...args) => (globalThis.__settingsFixture.savePlan || (() => ({})))(...args)
    const genstudioStaleNote = () => ''
  `
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

    // Saving writes BOTH records: the project meta and the config that owns the category.
    await fixture.state.saveProject('publishing')
    await flush()
    const projectWrite = puts.find(entry => entry.path === '/projects/project-a')
    const configWrite = puts.find(entry => entry.path === '/projects/project-a/settings/config')
    assert.ok(projectWrite, 'the Publishing save must still write the project record')
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

test('entering the FFmpeg tab reads the real status, and a failed check is unknown rather than "not installed"', async () => {
  const route = reactive({ params: reactive({ slug: 'project-a' }), hash: '', query: {} })
  const gets: string[] = []
  let ffmpegCheck: 'ok' | 'fail' = 'ok'
  const fixture: any = {
    route,
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
    projectState: {
      project: ref(null), config: ref(null),
      refreshConfig: async () => undefined, loadProject: async () => undefined,
    },
  }
  ;(globalThis as any).__settingsFixture = fixture
  const app = createApp(await loadPage())
  const host = document.body.appendChild(document.createElement('div'))
  app.mount(host)
  await flush()
  try {
    assert.equal(gets.includes('/ffmpeg/status'), false,
      'mounting Settings must not probe FFmpeg for a tab the customer has not opened')

    fixture.state.activeTab.value = 'maintenance'
    await flush()
    assert.ok(gets.includes('/ffmpeg/status'),
      'entering the tab that owns the card must fetch the real status before any repair action is offered')
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

// The card's template branches cannot be reached by the headless harness (it
// renders `h('main')`), so the wiring that keeps an unknown status from opening
// the installer is pinned at the source level.
test('the FFmpeg installer and manual fallback stay closed while the status is unknown', () => {
  const source = readFileSync(filename, 'utf8')
  assert.match(source, /<details\s+v-else-if="ffmpegStatus"/,
    'the recovery installer must require a real status, not merely "not bundled"')
  assert.match(source, /<details v-if="ffmpegStatus && ffmpegStatus\.source !== 'bundled'"/,
    'the manual-install fallback must not appear for a status that was never read')
  assert.match(source, /v-if="ffmpegStatusError"[\s\S]{0,700}@click="refreshFfmpegStatus"/,
    'a failed check must be stated with a retry')
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
