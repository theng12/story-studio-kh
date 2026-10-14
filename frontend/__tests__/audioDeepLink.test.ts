import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createApp, computed, defineComponent, h, nextTick, reactive, ref, unref, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { waitFor } from '../../electron/server/__tests__/_timing.js'

const audioPath = fileURLToPath(new URL('../pages/projects/[slug]/audio.vue', import.meta.url))
const selectorPath = fileURLToPath(new URL('../components/AudioChapterSelector.vue', import.meta.url))
const audioSource = readFileSync(audioPath, 'utf8')
const selectorSource = readFileSync(selectorPath, 'utf8')

async function loadSelector(): Promise<Component> {
  const { descriptor } = parse(selectorSource, { filename: selectorPath })
  const script = compileScript(descriptor, { id: 'audio-deep-link-selector' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: selectorPath,
    id: 'audio-deep-link-selector',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const qualityUrl = await import.meta.resolve('../types/audio-quality.ts')
  const support = `
    import { computed, defineComponent as _defineComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from ${JSON.stringify(vueUrl)}
    import { audioQualityLabel, audioQualityTone } from ${JSON.stringify(qualityUrl)}
    const useApi = () => globalThis.__audioDeepLinkApi
    const useJobs = () => ({ jobs: ref([]) })
    const useToast = () => ({ error: () => undefined })
  `
  const code = `${support}\n${script.content
    .replace(/^import type \{ Job \} from '.+?'\n/m, '')
    .replace(/^import \{[\s\S]*?\} from '~\/types\/audio-quality'\n/m, '')
    .replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const built = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    built.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

async function loadAudioPage(): Promise<Component> {
  const { descriptor } = parse(audioSource, { filename: audioPath })
  const script = compileScript(descriptor, { id: 'audio-deep-link-page' })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, onMounted, onUnmounted, reactive, ref, watch } from ${JSON.stringify(vueUrl)}
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useRoute = () => globalThis.__audioDeepLinkRoute
    const useRouter = () => globalThis.__audioDeepLinkRouter
    const useApi = () => globalThis.__audioDeepLinkApi
    const useConfirm = () => ({ ask: async () => true })
    const useFreshGenerationAction = () => ({ hasPending: ref(false), begin: () => 'operation', complete: () => undefined, fail: () => undefined, cancel: () => undefined })
    const useProject = () => ({ project: ref(null), config: ref({ audio_quality: {} }), refreshConfig: async () => undefined })
    const useGenStudioVoices = () => ({ models: ref([]), modelsLoading: ref(false), modelsError: ref(''), modelsStale: ref(false), modelsLoadedAt: ref(null), loadModels: async () => undefined, quoteNarration: async () => ({}) })
    const useGenStudioTranscriptionModels = () => ({ models: ref([]), error: ref(''), isStale: ref(false), isUsable: ref(true), sourceFreshness: ref(null), load: async () => undefined })
    const genstudioStaleNote = () => ''
    const voiceIsGenerable = () => true
    const selectLiveGenStudioModel = value => value ? { id: value } : null
    const genStudioModelLockReason = () => ''
    const CREDIT_BASIS_LABEL = ''
    const describeVoiceRate = () => ({ text: '', title: '', notice: '' })
    const describeQuotedTotal = () => ''
    const formatCredits = value => String(value || 0)
    const describeRelaxedQueueHint = () => ''
    const isRelaxedQueue = () => false
    const queueClassGroupLabel = () => ''
    const defaultTtsControlValues = () => ({})
    const resolveTtsControlValues = (_controls, values) => values || {}
    const useToast = () => ({ success: () => undefined, info: () => undefined, error: () => undefined })
    const useGenerating = () => ({ audioGenerating: ref(false) })
    const useConfirmation = () => ({
      state: reactive({ visible: false, type: '' }),
      confirmGeneration: async () => true,
      cancel: () => undefined,
    })
    const useManualGenerationRedoPreference = () => ({ enabled: ref(false), load: async () => false, reset: () => undefined })
    const useJobDetails = () => ({ ensure: () => undefined, withDetail: job => job, stop: () => undefined })
    const useJobs = () => ({ jobs: ref([]) })
    const useRememberedForm = () => undefined
    const useEpisodeStatus = () => ({ selectedEpisode: ref(null), scriptReady: ref(true), statusKnown: ref(true), refetch: async () => undefined })
    const usePresets = () => ({ load: async () => undefined })
  `
  const content = script.content
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const built = await transform(`${support}\n${content}\nconst __setup = __sfc__.setup
    __sfc__.setup = function (props, context) {
      const state = __setup(props, context)
      globalThis.__audioDeepLinkState = state
      return () => null
    }
    export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    built.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

const NuxtLink = defineComponent({
  props: { to: { type: String, required: true } },
  setup(props, { slots }) { return () => h('a', { href: props.to }, slots.default?.()) },
})
const LoadingSpinner = defineComponent({ setup: () => () => h('span', 'Loading') })

function row(slug: string) {
  return {
    label: slug.replace('_', ' '), slug, total_chunks: 1, present_chunks: 0,
    word_count: 10, character_count: 50, status: 'not_generated', subtitles_stale: false,
  }
}

test('Audio Generator deep link waits for its episode, selects one requested chapter, focuses it, and consumes the query', async () => {
  const route = reactive({ params: { slug: 'deep-link-project' }, query: { episode_id: 'EP0001', section: 'Chapter_13' } })
  const replacements: any[] = []
  const calls: string[] = []
  ;(globalThis as any).__audioDeepLinkRoute = route
  ;(globalThis as any).__audioDeepLinkRouter = {
    replace: async ({ query }: any) => {
      replacements.push(query)
      Object.keys(route.query).forEach(key => { if (!(key in query)) delete (route.query as any)[key] })
      Object.assign(route.query, query)
    },
  }
  ;(globalThis as any).__audioDeepLinkApi = {
    get: async (path: string) => {
      calls.push(path)
      if (path.includes('/audio-sections')) return { sections: [row('Chapter_01'), row('Chapter_13')] }
      return {}
    },
    post: async () => ({}),
  }

  const Page = await loadAudioPage()
  const Selector = await loadSelector()
  const pageHost = document.body.appendChild(document.createElement('div'))
  const selectorHost = document.body.appendChild(document.createElement('div'))
  const page = createApp(Page)
  page.mount(pageHost)
  const state = (globalThis as any).__audioDeepLinkState
  assert.equal(state.form.episode_id, '', 'the page starts without an episode before the shared picker resolves the query')

  const selector = createApp(defineComponent({
    setup: () => () => h(Selector as any, {
      projectSlug: 'deep-link-project', episodeId: state.form.episode_id, selected: state.form.sections,
      requestedSection: unref(state.requestedAudioSectionForEpisode),
      'onUpdate:selected': (value: string) => { state.form.sections = value },
      onRequestedSectionSelected: state.onRequestedAudioSectionSelected,
      onRequestedSectionDismissed: state.dismissRequestedAudioSection,
    }),
  }))
  selector.component('NuxtLink', NuxtLink)
  selector.component('LoadingSpinner', LoadingSpinner)
  const originalScroll = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = () => undefined
  selector.mount(selectorHost)
  try {
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(calls.some(path => path.includes('/audio-sections')), false, 'no chapter fetch occurs before the episode is selected')
    state.form.episode_id = 'EP0001'
    await waitFor(() => state.form.sections === 'Chapter_13', { label: 'the requested chapter to replace the missing default' })
    assert.equal(document.activeElement?.id, 'audio-section-Chapter_13')
    assert.deepEqual(replacements, [{ episode_id: 'EP0001' }])
    assert.equal((route.query as any).section, undefined)
    assert.ok(calls.some(path => path.includes('/episodes/EP0001/audio-sections')))
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(document.activeElement?.id, 'audio-section-Chapter_13', 'consuming the query keeps the focused chapter in place')
    assert.equal(calls.filter(path => path.includes('/audio-sections')).length, 1, 'clearing a consumed target does not re-scan its selected chapter')
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScroll
    selector.unmount(); page.unmount(); selectorHost.remove(); pageHost.remove()
  }
})

test('Audio Generator keeps a pending target in its URL episode scope across A/B switches', async () => {
  const route = reactive({ params: { slug: 'deep-link-project' }, query: { episode_id: 'EP0001', section: 'Chapter_13' } })
  const first = Promise.withResolvers<any>()
  const calls: string[] = []
  ;(globalThis as any).__audioDeepLinkRoute = route
  ;(globalThis as any).__audioDeepLinkRouter = { replace: async ({ query }: any) => { Object.assign(route.query, query); delete (route.query as any).section } }
  ;(globalThis as any).__audioDeepLinkApi = {
    get: async (path: string) => {
      calls.push(path)
      if (path.includes('/episodes/EP0001/audio-sections')) return first.promise
      if (path.includes('/audio-sections')) return { sections: [row('Chapter_01'), row('Chapter_13')] }
      return {}
    },
    post: async () => ({}),
  }
  const Page = await loadAudioPage()
  const Selector = await loadSelector()
  const pageHost = document.body.appendChild(document.createElement('div'))
  const selectorHost = document.body.appendChild(document.createElement('div'))
  const page = createApp(Page)
  page.mount(pageHost)
  const state = (globalThis as any).__audioDeepLinkState
  const selector = createApp(defineComponent({
    setup: () => () => h(Selector as any, {
      projectSlug: 'deep-link-project', episodeId: state.form.episode_id, selected: state.form.sections,
      requestedSection: unref(state.requestedAudioSectionForEpisode),
      'onUpdate:selected': (value: string) => { state.form.sections = value },
      onRequestedSectionSelected: state.onRequestedAudioSectionSelected,
      onRequestedSectionDismissed: state.dismissRequestedAudioSection,
    }),
  }))
  selector.component('NuxtLink', NuxtLink)
  selector.component('LoadingSpinner', LoadingSpinner)
  const originalScroll = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = () => undefined
  selector.mount(selectorHost)
  try {
    state.form.episode_id = 'EP0001'
    await waitFor(() => calls.some(path => path.includes('/episodes/EP0001/audio-sections')), { label: 'the first episode request' })
    state.form.episode_id = 'EP0002'
    await waitFor(() => calls.some(path => path.includes('/episodes/EP0002/audio-sections')), { label: 'the second episode request' })
    first.resolve({ sections: [row('Chapter_13')] })
    await nextTick()
    assert.notEqual(state.form.sections, 'Chapter_13', 'the stale A response cannot apply its target after switching to B')

    Object.assign(route.query, { episode_id: 'EP0002', section: 'Chapter_13' })
    state.form.sections = ''
    await waitFor(() => state.form.sections === 'Chapter_13', { label: 'the B-scoped target to select its same-named chapter' })
    assert.equal(document.activeElement?.id, 'audio-section-Chapter_13')

    state.form.sections = 'Chapter_01,Chapter_13'
    Object.assign(route.query, { episode_id: 'EP0002', section: 'Chapter_99' })
    await waitFor(
      () => /Chapter_99 is not available for this episode/.test(selectorHost.textContent || ''),
      { label: 'the unavailable deep-link target notice' },
    )
    assert.equal(state.form.sections, '', 'an unavailable target must clear a broader inherited selection')
    assert.equal((route.query as any).section, 'Chapter_99', 'the target remains inspectable until the user chooses')
    ;(selectorHost.querySelector('input[aria-label="Select Chapter 01"]') as HTMLInputElement).click()
    await waitFor(() => (route.query as any).section === undefined, { label: 'manual selection to dismiss the unavailable target' })
    assert.equal(state.form.sections, 'Chapter_01')
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScroll
    selector.unmount(); page.unmount(); selectorHost.remove(); pageHost.remove()
  }
})
