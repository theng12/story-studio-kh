import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { computed, createApp, nextTick, reactive, ref, type Component } from 'vue'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { waitFor } from '../../electron/server/__tests__/_timing.js'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/image-pool.vue', import.meta.url))
const pageSource = readFileSync(pagePath, 'utf8')

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(pageSource, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'image-pool-manual-redo-runtime' })
  const vueUrl = await import.meta.resolve('vue')
  const outputOptionsUrl = await import.meta.resolve('../utils/genstudio-output-options.ts')
  const creditCostUrl = await import.meta.resolve('../utils/genstudio-credit-cost.ts')
  const support = `
    import { computed, defineComponent as _defineComponent, onMounted, onUnmounted, ref, watch } from ${JSON.stringify(vueUrl)}
    import { findOutputOption, isPublishedAspectRatio, outputOptionsForRatio, storyDefaultAspectRatio } from ${JSON.stringify(outputOptionsUrl)}
    import { CREDIT_BASIS_LABEL, describeImageBatchEstimate } from ${JSON.stringify(creditCostUrl)}
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useRoute = () => globalThis.__imagePoolRoute
    const useApi = () => globalThis.__imagePoolApi
    const useToast = () => globalThis.__imagePoolToast
    const useBrollPools = () => globalThis.__imagePoolBroll
    const useProject = () => globalThis.__imagePoolProject
    const useJobs = () => ({ jobs: globalThis.__imagePoolJobs })
    const useConfirm = () => ({ ask: globalThis.__imagePoolAsk })
    const useConfirmation = () => globalThis.__imagePoolConfirmation
    const useGenStudioImageModels = () => globalThis.__imagePoolCatalog
    const useManualGenerationRedoPreference = () => globalThis.__imagePoolPreference
    const UNCONFIRMED_SUBMISSION = 'unconfirmed submission'
    const useFreshGenerationAction = () => {
      const pending = ref(new Map())
      return {
        pending,
        hasPending: computed(() => pending.value.size > 0),
        begin(scope, target = 'default') {
          const key = JSON.stringify(scope)
          const current = pending.value.get(target)
          if (current?.scope === key) return current.id
          const id = '99999999-9999-4999-8999-' + String(++globalThis.__imagePoolUuid).padStart(12, '0')
          pending.value = new Map(pending.value).set(target, { id, scope: key })
          return id
        },
        complete(id) {
          const next = new Map(pending.value)
          for (const [target, action] of next) if (action.id === id) next.delete(target)
          pending.value = next
        },
        cancel(target) {
          if (!target) pending.value = new Map()
          else { const next = new Map(pending.value); next.delete(target); pending.value = next }
        },
      }
    }
  `
  const content = script.content
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const built = await transform(`${support}\n${content}\nconst __setup = __sfc__.setup
    __sfc__.setup = function (props, context) {
      const state = __setup(props, context)
      globalThis.__imagePoolState = state
      return () => null
    }
    export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    built.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

const Page = await loadPage()

type ConfirmationCall = {
  slug: string
  type: string
  body: Record<string, any>
  context: Record<string, any>
}

function sourceRows() {
  return [{
    source_job_id: 'stopped-image-pool-source',
    item_key: 'gen-source-run-0002.png',
    label: 'Prompt 2 · variant 1',
    finished_at: '2026-10-14T00:01:00.000Z',
  }]
}

async function mountFixture(options: {
  preference?: boolean
  deferredConfirmation?: boolean
  post?: (path: string, body: Record<string, any>) => Promise<any>
} = {}) {
  const route = reactive({ params: { slug: 'image-project' }, query: {} as Record<string, unknown> })
  const models = ref<any[]>([{
    id: 'mock-image-v1', display_name: 'Mock Image', available: true, qualification_only: false,
    chargeable: true, credits_per_image: 3, price_version: 'price-v1',
    aspect_ratios: ['16:9', '1:1'], default_aspect_ratio: '16:9', supports_seed: true,
    supports_reference_images: false, max_reference_images: 0, reference_strength_mode: '',
    supported_reference_strengths: [], output_options: [{
      resolution: '1K', aspect_ratio: '16:9', width: 1024, height: 576,
      is_default: true, credits_per_image: 3, price_version: 'row-v1',
    }, {
      resolution: '1K', aspect_ratio: '1:1', width: 1024, height: 1024,
      is_default: false, credits_per_image: 3, price_version: 'row-square-v1',
    }],
  }])
  const summaries = ref(sourceRows())
  const preferenceLoads: string[] = []
  let preferenceResets = 0
  const preference = {
    enabled: ref(options.preference ?? true),
    load: async (slug = '') => { preferenceLoads.push(slug); return preference.enabled.value },
    reset: () => { preferenceResets++; preference.enabled.value = false },
  }
  const pools = ref<any[]>([{
    id: 'pool-1', name: 'Still Pool', media: 'image', online: true,
    slideshow: { seconds_per_image: 8, dedup_lookback: 20 },
  }])
  const calls: ConfirmationCall[] = []
  const resolvers: Array<(value: boolean) => void> = []
  const confirmationState = reactive({ visible: false, type: '', always: false })
  const confirmation = {
    state: confirmationState,
    confirmGeneration: async (slug: string, type: string, body: Record<string, any>, context: Record<string, any>) => {
      calls.push({ slug, type, body: JSON.parse(JSON.stringify(body)), context: JSON.parse(JSON.stringify(context)) })
      confirmationState.visible = true
      confirmationState.type = type
      confirmationState.always = context?.always === true
      if (!options.deferredConfirmation) { confirmationState.visible = false; return true }
      return new Promise<boolean>(resolve => resolvers.push((value) => {
        confirmationState.visible = false
        resolve(value)
      }))
    },
    cancel: () => resolvers.shift()?.(false),
  }
  const asks: any[] = []
  const actions: Array<{ message: string; label: string; run: () => void | Promise<void> }> = []
  const errors: string[] = []
  const successes: string[] = []
  const infos: string[] = []
  const posts: Array<{ path: string; body: Record<string, any> }> = []
  const api = {
    get: async (url: string) => {
      if (url.includes('/manual-redo-sources')) return { sources: JSON.parse(JSON.stringify(summaries.value)) }
      return {}
    },
    put: async () => ({}),
    post: async (path: string, body: Record<string, any>) => {
      posts.push({ path, body: JSON.parse(JSON.stringify(body)) })
      return options.post?.(path, body) ?? { job_id: 'image-job' }
    },
  }
  const jobs = ref<any[]>([])
  Object.assign(globalThis as any, {
    __imagePoolRoute: route,
    __imagePoolApi: api,
    __imagePoolJobs: jobs,
    __imagePoolAsk: async (value: any) => { asks.push(JSON.parse(JSON.stringify(value))); return true },
    __imagePoolConfirmation: confirmation,
    __imagePoolCatalog: { models, refresh: async () => undefined },
    __imagePoolPreference: preference,
    __imagePoolProject: { config: ref({ image_pool_id: 'pool-1' }), refreshConfig: async () => undefined },
    __imagePoolBroll: {
      pools,
      loadPools: async () => undefined,
      listClips: async () => ({ clips: [] }),
    },
    __imagePoolToast: {
      success: (message: string) => successes.push(message),
      info: (message: string) => infos.push(message),
      error: (message: string) => errors.push(message),
      showAction: (message: string, label: string, run: () => void | Promise<void>) => actions.push({ message, label, run }),
    },
    __imagePoolUuid: 0,
  })
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(Page)
  app.mount(host)
  const state = (globalThis as any).__imagePoolState
  await nextTick()
  await nextTick()
  state.poolId.value = 'pool-1'
  state.showGrow.value = true
  state.genModel.value = 'mock-image-v1'
  state.genAspectRatio.value = '16:9'
  state.genOutputOption.value = { resolution: '1K', aspect_ratio: '16:9' }
  state.genSeed.value = 13
  state.genVariants.value = 2
  state.genPrompts.value = 'An ordinary unrelated prompt.'
  await state.loadManualRedoSources()
  state.selectedManualRedoSource.value = 'stopped-image-pool-source\u0000gen-source-run-0002.png'
  await nextTick()
  return {
    app, host, state, route, models, summaries, preference, calls, resolvers, confirmationState,
    preferenceLoads, preferenceResets: () => preferenceResets,
    asks, actions, errors, successes, infos, posts, jobs,
    unmount: () => { app.unmount(); host.remove() },
  }
}

test('a listed-but-rowless ratio is repaired to a renderable row and announced', async () => {
  // F3 regression: the ratio list still names 16:9, but its output row is gone.
  // The watcher must use the row contract, repair the form, and announce it.
  const fixture = await mountFixture()
  try {
    fixture.models.value = [{
      ...fixture.models.value[0]!,
      aspect_ratios: ['16:9', '1:1'],
      default_aspect_ratio: '1:1',
      output_options: [{
        resolution: '1K', aspect_ratio: '1:1', width: 1024, height: 1024,
        is_default: true, credits_per_image: 3, price_version: 'row-square-v1',
      }],
    }]
    await nextTick()
    assert.equal(fixture.state.genAspectRatio.value, '1:1',
      'the rowless 16:9 is repaired even while the ratio list still names it')
    assert.ok(fixture.infos.some(message =>
      /does not publish 16:9/.test(message) && /Switched to 1:1/.test(message)))
  } finally {
    fixture.unmount()
  }
})

test('preference off hides only the exceptional action and leaves ordinary Generate unchanged', async () => {
  const fixture = await mountFixture({ preference: false })
  try {
    assert.equal(fixture.state.manualImagePoolRedoEligible.value, false)
    await fixture.state.generateIntoPool()
    assert.equal(fixture.asks.length, 1, 'ordinary Generate keeps its existing explicit prompt')
    assert.equal(fixture.posts.length, 1)
    assert.equal(fixture.posts[0]!.body.manual_redo, undefined)
    assert.equal(fixture.posts[0]!.body.operation_id, undefined)
    assert.deepEqual(fixture.posts[0]!.body.prompts, ['An ordinary unrelated prompt.'])
  } finally {
    fixture.unmount()
  }
})

for (const [label, change] of [
  ['project', (fixture: any) => { fixture.route.params.slug = 'another-project' }],
  ['pool', (fixture: any) => { fixture.state.poolId.value = 'pool-2' }],
  ['model', (fixture: any) => { fixture.state.genModel.value = 'another-image-model' }],
  ['ratio', (fixture: any) => { fixture.state.genAspectRatio.value = '1:1' }],
  ['seed', (fixture: any) => { fixture.state.genSeed.value = 99 }],
  ['variants', (fixture: any) => { fixture.state.genVariants.value = 3 }],
  ['source item', (fixture: any) => { fixture.state.selectedManualRedoSource.value = 'other\u0000item' }],
  ['published price', (fixture: any) => { fixture.models.value[0].output_options[0].credits_per_image = 4 }],
] as const) {
  test(`manual Image Pool confirmation refuses a ${label} change before its first POST`, async () => {
    const fixture = await mountFixture({ deferredConfirmation: true })
    try {
      const request = fixture.state.generateSeparateImagePoolAttempt()
      await waitFor(() => fixture.calls.length === 1, { label: `${label} image confirmation` })
      const captured = fixture.calls[0]!
      assert.equal(captured.context.always, true, 'the exceptional paid image action always confirms')
      assert.equal(captured.body.manual_redo.source_job_id, 'stopped-image-pool-source')
      assert.equal(captured.body.source_item_key, 'gen-source-run-0002.png')
      assert.equal(captured.body.prompts, undefined, 'the renderer never claims the source prompt')
      assert.deepEqual(captured.body.manual_image_payment, {
        version: 1,
        model_id: 'mock-image-v1',
        model_price_version: 'price-v1',
        output_resolution: '1K',
        output_aspect_ratio: '16:9',
        output_price_version: 'row-v1',
        confirmed_paid_image: true,
      }, 'the immutable body binds explicit paid confirmation to the exact published model/output prices')
      assert.match(captured.context.details.at(-1).value, /3.*credit/i)
      assert.equal(
        fixture.state.confirmingManualImagePoolSubmission.value.operationId,
        '99999999-9999-4999-8999-000000000001',
        'the detached body and UUID exist before the confirmation await resolves',
      )
      change(fixture)
      await nextTick()
      fixture.resolvers.shift()?.(true)
      await request
      assert.equal(fixture.posts.length, 0)
    } finally {
      fixture.unmount()
    }
  })
}

test('source abandonment and catalog refresh before a lost reply preserve one exact Retry', async () => {
  let fixture: Awaited<ReturnType<typeof mountFixture>>
  let first = true
  fixture = await mountFixture({
    post: async () => {
      if (first) {
        first = false
        fixture.summaries.value = []
        fixture.models.value[0].output_options[0].credits_per_image = 8
        await fixture.state.loadManualRedoSources()
        await nextTick()
        throw new Error('HTTP response lost after admission')
      }
      return { job_id: 'accepted-image-destination', reused: true }
    },
  })
  try {
    await fixture.state.generateSeparateImagePoolAttempt()
    assert.equal(fixture.calls.length, 1)
    assert.equal(fixture.posts.length, 1)
    assert.equal(fixture.actions.length, 1)
    assert.equal(fixture.actions[0]!.label, 'Retry')
    const firstBody = fixture.posts[0]!.body
    assert.equal(fixture.state.pendingManualImagePoolSubmission.value.operationId, firstBody.operation_id)
    assert.equal(fixture.state.selectedManualRedoSource.value, 'stopped-image-pool-source\u0000gen-source-run-0002.png')

    await fixture.actions[0]!.run()
    assert.equal(fixture.calls.length, 1, 'accepted replay neither requotes nor reconfirms')
    assert.equal(fixture.posts.length, 2)
    assert.deepEqual(fixture.posts[1]!.body, firstBody, 'Retry adopts the exact captured body and UUID')
    assert.equal(fixture.successes.length, 1)
  } finally {
    fixture.unmount()
  }
})

test('catalog model disappearance after an unknown response preserves the raw 1:1 Retry body', async () => {
  let fixture: Awaited<ReturnType<typeof mountFixture>>
  let first = true
  fixture = await mountFixture({
    post: async () => {
      if (first) {
        first = false
        fixture.models.value = []
        await nextTick()
        throw new Error('response lost after acceptance')
      }
      return { job_id: 'adopted-square-image', reused: true }
    },
  })
  try {
    fixture.state.genAspectRatio.value = '1:1'
    fixture.state.genOutputOption.value = { resolution: '1K', aspect_ratio: '1:1' }
    await nextTick()
    await fixture.state.generateSeparateImagePoolAttempt()
    assert.equal(fixture.actions.length, 1)
    const captured = fixture.posts[0]!.body
    assert.equal(captured.aspect_ratio, '1:1')
    await fixture.actions[0]!.run()
    assert.equal(fixture.calls.length, 1, 'accepted replay does not reconfirm after automatic catalog disappearance')
    assert.equal(fixture.posts.length, 2)
    assert.deepEqual(fixture.posts[1]!.body, captured)
  } finally {
    fixture.unmount()
  }
})

test('automatic seed-capability refresh after an unknown response preserves the captured seed Retry', async () => {
  let fixture: Awaited<ReturnType<typeof mountFixture>>
  let first = true
  fixture = await mountFixture({
    post: async () => {
      if (first) {
        first = false
        fixture.models.value[0].supports_seed = false
        await nextTick()
        throw new Error('response lost after acceptance')
      }
      return { job_id: 'adopted-seeded-image', reused: true }
    },
  })
  try {
    await fixture.state.generateSeparateImagePoolAttempt()
    assert.equal(fixture.actions.length, 1)
    const captured = fixture.posts[0]!.body
    assert.equal(captured.seed, 13)
    await fixture.actions[0]!.run()
    assert.equal(fixture.calls.length, 1)
    assert.equal(fixture.posts.length, 2)
    assert.deepEqual(fixture.posts[1]!.body, captured)
  } finally {
    fixture.unmount()
  }
})

test('a genuine user scope edit after a lost response refuses the stale captured Retry', async () => {
  const fixture = await mountFixture({ post: async () => { throw new Error('response lost') } })
  try {
    await fixture.state.generateSeparateImagePoolAttempt()
    assert.equal(fixture.actions.length, 1)
    fixture.state.genSeed.value = 77
    await nextTick()
    await fixture.actions[0]!.run()
    assert.equal(fixture.posts.length, 1, 'wrong-scope Retry never posts again')
    assert.match(fixture.errors.at(-1) || '', /another current project, pool, model, output setting, or source item/i)
  } finally {
    fixture.unmount()
  }
})

test('a genuine seed round trip retires a deferred confirmation even when raw scope strings return', async () => {
  const fixture = await mountFixture({ deferredConfirmation: true })
  try {
    const request = fixture.state.generateSeparateImagePoolAttempt()
    await waitFor(() => fixture.calls.length === 1, { label: 'Image Pool round-trip confirmation' })
    fixture.state.genSeed.value = 77
    fixture.state.onManualImagePoolUserEdit()
    fixture.state.genSeed.value = 13
    await request
    assert.equal(fixture.posts.length, 0, 'returning to the same seed cannot revive an older paid confirmation')
    assert.equal(fixture.state.confirmingManualImagePoolSubmission.value, null)
    assert.equal(fixture.state.pendingManualImagePoolSubmission.value, null)
  } finally {
    for (const resolve of fixture.resolvers.splice(0)) resolve(false)
    fixture.unmount()
  }
})

for (const outcome of ['success', 'detail'] as const) {
  test(`a late ${outcome} from an older POST cannot clear a newer captured action`, async () => {
    let settle!: (value?: unknown) => void
    let reject!: (reason?: unknown) => void
    const delayed = new Promise((resolve, rejectPromise) => { settle = resolve; reject = rejectPromise })
    const fixture = await mountFixture({ post: async () => delayed })
    try {
      const oldRequest = fixture.state.generateSeparateImagePoolAttempt()
      await waitFor(() => fixture.posts.length === 1, { label: `old image ${outcome} POST` })
      const oldSubmission = fixture.state.pendingManualImagePoolSubmission.value
      assert.ok(oldSubmission)
      const newer = {
        ...oldSubmission,
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        body: { ...oldSubmission.body, seed: 77 },
        userScopeKey: `${oldSubmission.userScopeKey}:newer`,
      }
      fixture.state.pendingManualImagePoolSubmission.value = newer
      fixture.state.manualImagePoolRedoPosting.value = true
      if (outcome === 'success') settle({ job_id: 'old-admitted-job' })
      else reject({ data: { detail: 'Old request was refused.' } })
      await oldRequest
      assert.equal(fixture.state.pendingManualImagePoolSubmission.value.operationId, newer.operationId)
      assert.equal(fixture.state.manualImagePoolRedoPosting.value, true, 'old finally cannot clear the newer in-flight state')
      assert.equal(fixture.errors.includes('Old request was refused.'), false, 'stale detail cannot mutate the newer action UI')
    } finally {
      fixture.unmount()
    }
  })
}

for (const [scope, change] of [
  ['project', (fixture: any) => { fixture.route.params.slug = 'another-image-project' }],
  ['pool', (fixture: any) => { fixture.state.poolId.value = 'pool-2' }],
] as const) {
  for (const outcome of ['success', 'detail', 'unknown'] as const) {
    test(`a delayed ${outcome} from the old ${scope} cannot mutate the new view`, async () => {
      let resolvePost!: (value?: unknown) => void
      let rejectPost!: (reason?: unknown) => void
      const delayed = new Promise((resolve, reject) => { resolvePost = resolve; rejectPost = reject })
      const fixture = await mountFixture({ post: async () => delayed })
      try {
        const oldRequest = fixture.state.generateSeparateImagePoolAttempt()
        await waitFor(() => fixture.posts.length === 1, { label: `old ${scope} image POST` })
        change(fixture)
        await nextTick()
        await nextTick()
        if (outcome === 'success') resolvePost({ job_id: 'old-scope-job' })
        else if (outcome === 'detail') rejectPost({ data: { detail: 'Old scope refused.' } })
        else rejectPost(new Error('Old scope response was lost.'))
        await oldRequest
        assert.equal(fixture.state.pendingManualImagePoolSubmission.value, null)
        assert.equal(fixture.state.confirmingManualImagePoolSubmission.value, null)
        assert.equal(fixture.state.selectedManualRedoSource.value, '')
        assert.equal(fixture.successes.length, 0)
        assert.equal(fixture.errors.includes('Old scope refused.'), false)
        assert.equal(fixture.actions.length, 0)
        if (scope === 'project') {
          assert.ok(fixture.preferenceResets() >= 1)
          assert.ok(fixture.preferenceLoads.includes('another-image-project'))
        }
      } finally {
        fixture.unmount()
      }
    })
  }
}

test('project A to B to A during confirmation retires the old scope epoch', async () => {
  const fixture = await mountFixture({ deferredConfirmation: true })
  try {
    const request = fixture.state.generateSeparateImagePoolAttempt()
    await waitFor(() => fixture.calls.length === 1, { label: 'Image Pool A confirmation' })
    fixture.route.params.slug = 'image-project-b'
    await nextTick()
    fixture.route.params.slug = 'image-project'
    await nextTick()
    fixture.resolvers.shift()?.(true)
    await request
    assert.equal(fixture.posts.length, 0, 'returning to the same raw strings cannot revive an older scope epoch')
    assert.equal(fixture.state.pendingManualImagePoolSubmission.value, null)
  } finally {
    fixture.unmount()
  }
})

test('an older cancelled confirmation cannot cancel the newer captured action target', async () => {
  const fixture = await mountFixture({ deferredConfirmation: true })
  try {
    fixture.summaries.value = [...sourceRows(), {
      source_job_id: 'second-stopped-source',
      item_key: 'gen-second-run-0001.png',
      label: 'Prompt 1 · variant 1',
      finished_at: '2026-10-14T00:02:00.000Z',
    }]
    await fixture.state.loadManualRedoSources()
    const older = fixture.state.generateSeparateImagePoolAttempt()
    await waitFor(() => fixture.calls.length === 1, { label: 'older Image Pool confirmation' })
    fixture.state.selectedManualRedoSource.value = 'second-stopped-source\u0000gen-second-run-0001.png'
    await nextTick()
    const newer = fixture.state.generateSeparateImagePoolAttempt()
    await waitFor(() => fixture.calls.length === 2, { label: 'newer Image Pool confirmation' })
    const newerOperationId = fixture.state.confirmingManualImagePoolSubmission.value.operationId
    fixture.resolvers.shift()!(false)
    await older
    const currentTarget = fixture.state.freshImagePoolAction.pending.value.get('manual-image-pool-redo')
    assert.equal(currentTarget?.id, newerOperationId,
      'the older continuation can retire only the operation it allocated')
    fixture.resolvers.shift()!(false)
    await newer
  } finally {
    for (const resolve of fixture.resolvers.splice(0)) resolve(false)
    fixture.unmount()
  }
})
