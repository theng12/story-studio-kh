import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, h, nextTick, reactive, ref, type Component } from 'vue'

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
    const projectSettingsSavePlan = () => ({})
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
