import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createApp, defineComponent, h, nextTick, reactive, ref, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

// The page spreads `DEFAULT_EXCLUDE_KEYS` into its preset `excludeKeys`. This
// harness strips the page's imports and supplies each one by hand, so the real
// exported constant is injected by NAME from the module the page imports —
// never re-typed here, or the two lists drift (AGENTS.md §5).
import { DEFAULT_EXCLUDE_KEYS } from '../composables/usePresets.js'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url))
const source = readFileSync(pagePath, 'utf8')

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await nextTick()
}

async function loadScenePlan(): Promise<Component> {
  const { descriptor } = parse(source, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'scene-plan-loading' })
  const template = compileTemplate({
    id: 'scene-plan-loading',
    filename: pagePath,
    source: descriptor.template!.content,
    compilerOptions: { bindingMetadata: script.bindings },
  })
  assert.equal(template.errors.length, 0)
  const vueUrl = await import.meta.resolve('vue')
  // The prompt-length module is the REAL one. Stubbing it cost more than it
  // saved: a hand-written `promptLengthState` that returned only `{overCap}`
  // made the page's own counter badge crash on the fields the real function
  // always provides (`characters`), and the failure looked like a page defect.
  // Injecting the real module keeps the harness faithful and still lets the
  // catalogue itself be stubbed (no models are supplied).
  const capUrl = await import.meta.resolve('../utils/prompt-char-cap.js')
  const support = `
    import { computed, defineComponent as _defineComponent, h, nextTick, onMounted, onUnmounted, ref, shallowRef, unref, watch } from ${JSON.stringify(vueUrl)}
    import { normalizePromptCharCapSetting, promptCharCapAboveModel, promptCharCapOptions, promptLengthLabel, promptLengthState, promptLengthTone, publishedPromptCharCap, resolvePromptCharCap } from ${JSON.stringify(capUrl)}
    const availableInputTokens = () => 0
    const batchTimeoutWarning = () => ''
    const clampOutputAllowance = (_value, maximum) => maximum
    const contextWindowTokens = () => 0
    const formatTokenCount = value => String(value || 0)
    const isModelTokenLimitError = () => false
    const publishedMaxOutputTokens = () => 0
    const outputAllowanceOptions = () => []
    const readRememberedImageModelId = () => ''
    const pacingBandAt = () => ({ max_sec: Infinity })
    const resolveMotionScope = () => ({ scene_ids: [] })
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useRoute = () => globalThis.__scenePlanRoute
    const useApi = () => globalThis.__scenePlanApi
    const useFreshGenerationAction = () => ({ begin: () => 'operation', complete: () => undefined, cancel: () => undefined })
    const useToast = () => ({ success: () => undefined, error: message => globalThis.__scenePlanErrors.push(message), showAction: () => undefined })
    const useConfirm = () => ({ ask: async () => false })
    const useUnsavedGuard = () => undefined
    const useEpisodes = () => ({ episodes: globalThis.__scenePlanEpisodes, revalidate: async () => undefined })
    // The page lists this episode's own characters for the reference picker; these tests own no characters.
    const useCharacters = () => ({ listForEpisode: async () => [] })
    // The page's per-scene reference chips render only for character scenes; these plans own no characters.
    const sceneTakesCharacterReferences = () => true
    const useProject = () => ({ config: ref({}) })
    const useRememberedForm = () => undefined
    const usePresets = () => ({ load: async () => undefined, presets: ref([]), activeId: ref(''), activeData: ref(null), isDirty: ref(false) })
    const DEFAULT_EXCLUDE_KEYS = ${JSON.stringify(DEFAULT_EXCLUDE_KEYS)}
    const useGenStudioImageModels = () => ({ models: ref([]), refresh: async () => undefined })
    const useJobs = () => ({ isJobActiveFor: () => false })
    const useVisualStyleCatalog = () => ({ styles: ref([]), loading: ref(false), error: ref(null), refresh: async () => undefined })
    const customerSafeJobText = value => String(value || '')
  `
  const content = script.content
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const templateCode = template.code.replace('export function render', 'function render')
  const out = await transform(`${support}\n${content}\n${templateCode}\nconst __setup = __sfc__.setup
    __sfc__.setup = function (props, context) {
      const state = __setup(props, context)
      globalThis.__scenePlanState = state
      return state
    }
    __sfc__.render = render
    export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    out.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

type Request = { path: string; deferred: Deferred<any> }

async function mountScenePlan(initialEpisode = 'EP_A') {
  const route = reactive({ params: { slug: 'project-a' }, query: { episode_id: initialEpisode } })
  const requests: Request[] = []
  ;(globalThis as any).__scenePlanRoute = route
  ;(globalThis as any).__scenePlanEpisodes = ref([])
  ;(globalThis as any).__scenePlanErrors = []
  ;(globalThis as any).__scenePlanApi = {
    get: (path: string) => {
      if (path.includes('/scene-plan/')) {
        const pending = deferred<any>()
        requests.push({ path, deferred: pending })
        return pending.promise
      }
      if (path.includes('/continuity/')) return Promise.resolve({ exists: true, config: { pacing: { min_sec: 4, max_sec: 12 }, motion_scope: { mode: 'off' }, motion_level: 2 } })
      if (path.includes('/video-editor/visual-source/')) return Promise.resolve({ source: 'scene_plan' })
      if (path.endsWith('/scene-plan-opening')) return Promise.resolve({ seconds: 0, breakdown: '', unresolved: [] })
      return Promise.resolve({})
    },
    post: (path: string, body: unknown) => ((globalThis as any).__scenePlanPost || (async () => ({})))(path, body),
    put: async () => ({}),
    del: async () => ({}),
  }
  const Page = await loadScenePlan()
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(Page)
  const passthrough = defineComponent({
    inheritAttrs: false,
    setup: (_props, { slots }) => () => h('div', slots.default?.()),
  })
  for (const name of [
    'WorkspaceHero', 'TopActionBar', 'EpisodeVisualSource', 'VisualTimingMotion',
    'WorkspaceSection', 'SubtitleQualityWarning', 'ModelSelector', 'NuxtLink',
    'Popover', 'LoadingSpinner',
  ]) app.component(name, passthrough)
  app.config.warnHandler = () => undefined
  app.mount(host)
  await flush()
  return {
    route,
    requests,
    state: (globalThis as any).__scenePlanState,
    host,
    unmount: () => { app.unmount(); host.remove() },
  }
}

function scenePlanRequest(mounted: Awaited<ReturnType<typeof mountScenePlan>>, pathPart: string) {
  const request = mounted.requests.find(item => item.path.includes(pathPart))
  assert.ok(request, `expected Scene Plan request containing ${pathPart}`)
  return request!.deferred
}

test('mounted Scene Plan renders a safe empty state before an episode is selected', async () => {
  const mounted = await mountScenePlan('')
  assert.equal(mounted.requests.filter(item => item.path.includes('/scene-plan/')).length, 0)
  assert.match(mounted.host.textContent || '', /Pick an episode to check readiness/)
  assert.doesNotMatch(mounted.host.textContent || '', /Audio Assembly hasn't run/)
  mounted.unmount()
})

test('mounted Scene Plan starts a deep-linked status read while the episode list is unresolved', async () => {
  const mounted = await mountScenePlan('EP_A')
  const status = scenePlanRequest(mounted, '/projects/project-a/scene-plan/EP_A')
  assert.equal(mounted.state.episodeId.value, 'EP_A')
  assert.equal(mounted.state.episodeId.value, mounted.route.query.episode_id)
  assert.equal((globalThis as any).__scenePlanEpisodes.value.length, 0)
  assert.equal(mounted.state.statusLoading.value, true)
  assert.match(mounted.host.textContent || '', /Checking this episode's readiness/)
  assert.doesNotMatch(mounted.host.textContent || '', /Audio Assembly has not run/)
  status.resolve({ audio_merged: true, stitched_srt: null, scene_plan: null })
  await flush()
  mounted.unmount()
})

test('mounted Scene Plan discards a response from the old project and episode scope', async () => {
  const mounted = await mountScenePlan('EP_A')
  const oldStatus = scenePlanRequest(mounted, '/projects/project-a/scene-plan/EP_A')
  mounted.route.params.slug = 'project-b'
  mounted.route.query.episode_id = 'EP_B'
  await flush()
  const currentStatus = scenePlanRequest(mounted, '/projects/project-b/scene-plan/EP_B')
  oldStatus.resolve({ audio_merged: true, audio_merge_gap_s: 1, stitched_srt: null, scene_plan: null })
  await flush()
  assert.equal(mounted.state.status.value, null)
  assert.equal(mounted.state.statusLoading.value, true)
  currentStatus.resolve({ audio_merged: true, audio_merge_gap_s: 2, stitched_srt: null, scene_plan: null })
  await flush()
  assert.equal(mounted.state.status.value.audio_merge_gap_s, 2)
  assert.equal(mounted.state.statusLoading.value, false)
  mounted.unmount()
})

test('mounted Scene Plan keeps missing prerequisites hidden and exposes a retry state after status failure', async () => {
  const mounted = await mountScenePlan('EP_FAIL')
  const status = scenePlanRequest(mounted, '/projects/project-a/scene-plan/EP_FAIL')
  assert.match(mounted.host.textContent || '', /Checking this episode's readiness/)
  status.reject(new Error('backend unavailable'))
  await flush()
  assert.equal(mounted.state.statusLoading.value, false)
  assert.match(mounted.host.textContent || '', /Could not check this episode's readiness: backend unavailable/)
  assert.doesNotMatch(mounted.host.textContent || '', /Audio Assembly has not run/)
  assert.match(String(mounted.state.headerPrimaryStatus.value), /Could not load|Retry|unavailable/i)
  mounted.state.retryStatus()
  await flush()
  assert.equal(mounted.requests.filter(item => item.path.includes('/scene-plan/EP_FAIL')).length, 2)
  mounted.unmount()
})

const twoScenePlan = () => ({
  schema_version: 1, generated_at: '2026-09-01T00:00:00.000Z', total_duration_sec: 20, research_used: false,
  scenes: [
    { id: 'a', scene_index: 1, start_sec: 0, end_sec: 10, transcript_segment: 'First line.', visual_prompt: 'P1', approved: false },
    { id: 'b', scene_index: 2, start_sec: 10, end_sec: 20, transcript_segment: 'Second line.', visual_prompt: 'P2', approved: false },
  ],
})

async function mountWithPlan() {
  const mounted = await mountScenePlan('EP_PLAN')
  scenePlanRequest(mounted, '/projects/project-a/scene-plan/EP_PLAN')
    .resolve({ audio_merged: true, audio_merge_gap_s: 1, stitched_srt: null, scene_plan: twoScenePlan() })
  await flush()
  return mounted
}

test('Cancel on a prompt repair asks the queue to stop the job and reports a refusal instead of claiming success', async () => {
  const calls: string[] = []
  ;(globalThis as any).__scenePlanPost = async (path: string) => {
    calls.push(path)
    throw { data: { detail: 'Only running jobs can be cancelled.' } }
  }
  const mounted = await mountWithPlan()
  mounted.state.bulkReplan.value = { active: true, completed: 0, total: 2, currentSceneIndex: null, cancelRequested: false, jobId: 'job-1' }
  await mounted.state.cancelBulkReplan()
  assert.deepEqual(calls, ['/projects/project-a/jobs/job-1/cancel'])
  assert.match((globalThis as any).__scenePlanErrors.at(-1), /Only running jobs can be cancelled/)
  assert.equal(mounted.state.bulkReplan.value.cancelRequested, false, 'a refused cancel is not shown as stopping')
  ;(globalThis as any).__scenePlanPost = async (path: string) => { calls.push(path); return { ok: true } }
  await mounted.state.cancelBulkReplan()
  assert.equal(mounted.state.bulkReplan.value.cancelRequested, true)
  ;(globalThis as any).__scenePlanPost = undefined
  mounted.unmount()
})

test('split leaves the new half pending and merge keeps the first prompt as written', async () => {
  const mounted = await mountWithPlan()
  mounted.state.mergeScene(1)
  assert.equal(mounted.state.plan.value.scenes.length, 1)
  assert.equal(mounted.state.plan.value.scenes[0].visual_prompt, 'P1')
  mounted.state.splitScene(0)
  const added = mounted.state.plan.value.scenes[1]
  assert.equal(added.visual_prompt, '', 'a copied prompt would count as a duplicate')
  assert.equal(added.transcript_segment, '')
  mounted.unmount()
})

test('unsaved edits disable every action that reloads the plan, with a visible reason', async () => {
  const mounted = await mountWithPlan()
  mounted.state.markPlanDirty()
  await flush()
  assert.equal(mounted.state.headerPrimaryDisabled.value, true)
  assert.match(mounted.host.textContent || '', /You have unsaved edits/)
  mounted.unmount()
})
