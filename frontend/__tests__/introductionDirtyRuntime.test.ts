/**
 * The Introduction page, mounted.
 *
 * Pins three things a source scan cannot see:
 *  - right after load and right after Save the page has NO unsaved changes
 *    (a deep watch used to set `dirty` after load()/save() had cleared it);
 *  - openings that finished before the page opened are history: no toast, no
 *    red failure line. Only a job the page saw unfinished can settle, and the
 *    global job stream — not this page — toasts its end;
 *  - "Write this episode's opening" saves unsaved recipe edits first, because
 *    the server writes from the SAVED recipe.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, defineComponent, h, nextTick, onMounted, ref, watch, type Component } from 'vue'

import * as introWatch from '../composables/useIntroductionJobWatch.js'

const filename = fileURLToPath(new URL('../pages/projects/[slug]/introduction.vue', import.meta.url))

async function loadPage(): Promise<Component> {
  const source = readFileSync(filename, 'utf8')
  const { descriptor } = parse(source, { filename })
  const script = compileScript(descriptor, { id: 'introduction-dirty-runtime' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename,
    id: 'introduction-dirty-runtime',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, onMounted, reactive, ref, watch } from ${JSON.stringify(vueUrl)}
    const F = () => globalThis.__introFixture
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useRoute = () => ({ params: { slug: 'terra' } })
    const useApi = () => ({ get: (...a) => F().get(...a), put: (...a) => F().put(...a), post: (...a) => F().post(...a) })
    const useToast = () => ({ success: (m) => F().toasts.push(['success', m]), error: (m) => F().toasts.push(['error', m]) })
    const usePresets = () => ({ load: async () => undefined })
    const useJobs = () => ({ jobs: F().jobs })
    const useUnsavedGuard = (dirty) => { F().dirty = dirty }
    const useFreshGenerationAction = () => ({ begin: () => 'op-1', complete: () => undefined })
    const introductionInFlightFor = (...a) => F().watch.introductionInFlight(...a)
    const introductionJobSignalFor = (...a) => F().watch.introductionJobSignal(...a)
    const settleIntroductionJobs = (...a) => F().watch.settleIntroductionJobs(...a)
  `
  const content = script.content
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"]\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const built = await transform(`${support}\n${content}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`, {
    loader: 'ts', format: 'esm',
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    built.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve()
    await nextTick()
  }
}

const savedSegment = () => ({
  enabled: true,
  recipe: {
    host_name: 'Luna',
    word_target: 300,
    custom_opening_line: '',
    model: '',
    beats: [{ id: 'greeting', label: 'Greeting', enabled: true }],
  },
})

async function mount(jobs: any[] = []) {
  const fixture: any = {
    toasts: [] as Array<[string, string]>,
    calls: [] as string[],
    jobs: ref(jobs),
    watch: introWatch,
    refreshKeys: [] as number[],
    get: async () => ({
      segments: { introduction: savedSegment() },
      beat_library: [],
      opening_profile: null,
      word_target_min: 50,
      word_target_max: 600,
    }),
    put: async (path: string, body: any) => {
      fixture.calls.push(`PUT ${path}`)
      return { segments: { introduction: JSON.parse(JSON.stringify(body)) } }
    },
    post: async (path: string) => {
      fixture.calls.push(`POST ${path}`)
      return { job_id: 'new-job' }
    },
  }
  ;(globalThis as any).__introFixture = fixture
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(defineComponent({ setup: () => () => h(page as any) }))
  const slot = defineComponent({ setup(_, { slots }) { return () => h('section', slots.default?.()) } })
  const empty = defineComponent({ setup: () => () => h('span') })
  for (const name of ['WorkspaceHero', 'WorkspaceNotice', 'NuxtLink']) app.component(name, slot)
  for (const name of ['InheritedLlmLineupNotice', 'ModelSelector']) app.component(name, empty)
  app.component('TopActionBar', defineComponent({
    props: ['episodeId'],
    emits: ['update:episodeId', 'generate'],
    setup(_, { emit }) {
      fixture.generate = () => emit('generate')
      onMounted(() => emit('update:episodeId', 'EP0007'))
      return () => h('div')
    },
  }))
  app.component('IntroductionPreview', defineComponent({
    props: ['projectSlug', 'episodeId', 'refreshKey'],
    emits: ['script-readiness', 'saving-change'],
    setup(props, { emit }) {
      watch(() => props.refreshKey, key => fixture.refreshKeys.push(key))
      watch(() => props.episodeId, episodeId => emit('script-readiness', {
        projectSlug: props.projectSlug, episodeId, state: 'ready',
      }), { immediate: true })
      return () => h('div')
    },
  }))
  app.mount(host)
  await flush()
  return { fixture, host, dispose() { app.unmount(); host.remove(); delete (globalThis as any).__introFixture } }
}

let page: Component

const saveButton = (host: HTMLElement) => Array.from(host.querySelectorAll('button'))
  .find(button => button.textContent?.includes('Save for this channel')) as HTMLButtonElement

test('no unsaved changes right after load, after an edit there are, and none again after Save', async () => {
  page = await loadPage()
  const mounted = await mount()
  try {
    assert.equal(mounted.fixture.dirty.value, false, 'freshly loaded must not claim unsaved changes')
    assert.equal(saveButton(mounted.host).disabled, true)

    const host = mounted.host.querySelector('input.input') as HTMLInputElement
    host.value = 'Vincent'
    host.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    assert.equal(mounted.fixture.dirty.value, true)
    assert.equal(saveButton(mounted.host).disabled, false)

    saveButton(mounted.host).click()
    await flush()
    assert.deepEqual(mounted.fixture.calls, ['PUT /projects/terra/segments/introduction'])
    assert.equal(mounted.fixture.dirty.value, false, 'Save must leave the page clean')
    assert.equal(saveButton(mounted.host).disabled, true)
  } finally {
    mounted.dispose()
  }
})

test('openings that finished before the page opened are not replayed', async () => {
  const mounted = await mount([
    { job_id: 'old-error', type: 'introduction-only', status: 'error', error: 'provider 503', episode_id: 'EP0007', project_slug: 'terra' },
    { job_id: 'old-done', type: 'introduction-only', status: 'done', episode_id: 'EP0007', project_slug: 'terra' },
  ])
  try {
    assert.deepEqual(mounted.fixture.toasts, [])
    assert.doesNotMatch(mounted.host.textContent || '', /provider 503/)

    const keysBefore = mounted.fixture.refreshKeys.length
    mounted.fixture.jobs.value = [...mounted.fixture.jobs.value,
      { job_id: 'live', type: 'introduction-only', status: 'running', episode_id: 'EP0007', project_slug: 'terra' }]
    await flush()
    mounted.fixture.jobs.value = mounted.fixture.jobs.value.map((job: any) => job.job_id === 'live'
      ? { ...job, status: 'error', error: 'fresh failure' } : job)
    await flush()
    assert.match(mounted.host.textContent || '', /fresh failure/, 'a job seen running that fails says so inline')
    assert.deepEqual(mounted.fixture.toasts, [], 'the global job stream toasts the end; the page adds none')

    mounted.fixture.jobs.value = [...mounted.fixture.jobs.value,
      { job_id: 'live-2', type: 'introduction-only', status: 'running', episode_id: 'EP0007', project_slug: 'terra' }]
    await flush()
    mounted.fixture.jobs.value = mounted.fixture.jobs.value.map((job: any) => job.job_id === 'live-2'
      ? { ...job, status: 'done' } : job)
    await flush()
    assert.ok(mounted.fixture.refreshKeys.length > keysBefore, 'a finished opening refreshes the preview')
    assert.doesNotMatch(mounted.host.textContent || '', /fresh failure/)
  } finally {
    mounted.dispose()
  }
})

test('writing the opening saves unsaved recipe edits first', async () => {
  const mounted = await mount()
  try {
    const host = mounted.host.querySelector('input.input') as HTMLInputElement
    host.value = 'Vincent'
    host.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    mounted.fixture.generate()
    await flush()
    assert.deepEqual(mounted.fixture.calls, [
      'PUT /projects/terra/segments/introduction',
      'POST /projects/terra/generate/introduction-only',
    ])
  } finally {
    mounted.dispose()
  }
})
