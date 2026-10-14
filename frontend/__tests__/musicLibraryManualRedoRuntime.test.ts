import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { nextTick, reactive, ref, type Component } from 'vue'
import { createRenderer } from '@vue/runtime-core'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/music.vue', import.meta.url))
const source = readFileSync(pagePath, 'utf8')

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(source, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'music-library-manual-redo-runtime' })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, onMounted, ref, watch } from ${JSON.stringify(vueUrl)}
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useRoute = () => globalThis.__musicManualRoute
    const useApi = () => globalThis.__musicManualApi
    const useFreshGenerationAction = () => globalThis.__musicManualFresh
    const useToast = () => globalThis.__musicManualToast
    const useConfirm = () => ({ ask: async () => true })
    const useManualGenerationRedoPreference = () => globalThis.__musicManualPreference
    const useConfirmation = () => globalThis.__musicManualConfirmation
    const useJobs = () => ({ jobs: globalThis.__musicManualJobs })
    const CREDIT_BASIS_LABEL = { rate: 'Published rate', free: 'Published rate', unpublished: 'Price not reported' }
    const describeMusicUnitCost = model => ({
      basis: Number(model?.credits_per_request) === 0 ? 'free' : 'rate',
      text: model ? String(model.credits_per_request) + ' credits / song request' : 'Price not reported',
      title: '',
    })
    const pickDefaultMusicModel = models => models[0] || null
    const UNCONFIRMED_SUBMISSION = 'The result is not confirmed. Retry with the same action.'
  `
  const content = script.content
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const built = await transform(`${support}\n${content}\nconst __setup = __sfc__.setup
    __sfc__.setup = function (props, context) {
      const state = __setup(props, context)
      globalThis.__musicManualState = state
      return () => null
    }
    export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    built.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

const Page = await loadPage()
const renderer = createRenderer<any, any>({
  patchProp: () => undefined,
  insert: () => undefined,
  remove: () => undefined,
  createElement: () => ({}),
  createText: text => ({ text }),
  createComment: text => ({ text }),
  setText: (node, text) => { node.text = text },
  setElementText: (node, text) => { node.text = text },
  parentNode: () => null,
  nextSibling: () => null,
})

function sourceSummary(itemKey = 'track-0') {
  return {
    source_job_id: 'stopped-library-source',
    source_item_key: itemKey,
    label: 'Rain on Cedar',
    eligible: true,
    reason: 'Unresolved Gateway music request',
  }
}

async function fixture(options: {
  deferredConfirmation?: boolean
  deferredPosts?: boolean
  models?: any[]
} = {}) {
  const route = reactive({ params: { slug: 'music-project' }, query: {} as Record<string, unknown> })
  const jobs = ref<any[]>([{ job_id: 'stopped-library-source', status: 'error' }])
  const preference = { enabled: ref(true), load: async () => true, reset: () => { preference.enabled.value = false } }
  const posts: Array<{ path: string; body: any }> = []
  const actions: Array<{ label: string; run: () => void | Promise<void> }> = []
  const confirmations: any[] = []
  const errors: string[] = []
  const confirmationResolvers: Array<(answer: boolean) => void> = []
  const postResolvers: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> = []
  let sourceRows = [sourceSummary()]
  let modelRows = options.models || [{
    id: 'mock-music-v1', display_name: 'Mock Music', credits_per_request: 13,
    price_version: 'mock-music-price-v1', supports_instrumental: true, requires_lyrics: false,
  }]
  let firstPost = true
  let uuid = 0
  const pending = ref(new Map<string, { id: string; scope: string }>())
  const fresh = {
    begin(scope: unknown, target = 'default') {
      const key = JSON.stringify(scope)
      const current = pending.value.get(target)
      if (current?.scope === key) return current.id
      const id = `61000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`
      pending.value = new Map(pending.value).set(target, { id, scope: key })
      return id
    },
    complete(id: string) {
      const next = new Map(pending.value)
      for (const [target, action] of next) if (action.id === id) next.delete(target)
      pending.value = next
    },
    cancel(target?: string) {
      if (!target) pending.value = new Map()
      else { const next = new Map(pending.value); next.delete(target); pending.value = next }
    },
  }
  const api = {
    get: async (path: string) => {
      if (path.endsWith('/music-library')) return { tracks: [], folder: '', available_seconds: 0, unmeasured_enabled_tracks: 0 }
      if (path.includes('music-models')) return { models: structuredClone(modelRows) }
      if (path.endsWith('/manual-redo-sources')) return { sources: sourceRows }
      return {}
    },
    post: async (path: string, body: any) => {
      posts.push({ path, body: JSON.parse(JSON.stringify(body)) })
      if (options.deferredPosts && path.endsWith('/generate')) {
        return new Promise((resolve, reject) => postResolvers.push({ resolve, reject }))
      }
      if (path.endsWith('/generate') && firstPost) {
        firstPost = false
        sourceRows = []
        ;(globalThis as any).__musicManualState.applyManualMusicSources([])
        throw new Error('lost response')
      }
      return {}
    },
    patch: async () => ({}),
    del: async () => ({}),
  }
  Object.assign(globalThis as any, {
    __musicManualRoute: route,
    __musicManualApi: api,
    __musicManualJobs: jobs,
    __musicManualPreference: preference,
    __musicManualFresh: fresh,
    __musicManualConfirmation: {
      state: reactive({ visible: false, type: '' }),
      confirmGeneration: async (slug: string, type: string, body: any, context: any) => {
        confirmations.push({ slug, type, body: JSON.parse(JSON.stringify(body)), context })
        if (options.deferredConfirmation) {
          return new Promise<boolean>(resolve => confirmationResolvers.push(resolve))
        }
        return true
      },
      cancel: () => undefined,
    },
    __musicManualToast: {
      success: () => undefined,
      error: (message: string) => errors.push(message),
      showAction: (_message: string, label: string, run: () => void | Promise<void>) => actions.push({ label, run }),
    },
  })
  const app = renderer.createApp(Page)
  app.mount({})
  await nextTick()
  const state = (globalThis as any).__musicManualState
  await state.loadMusicModels()
  await state.loadManualRedoSources()
  await nextTick()
  return {
    state, route, posts, actions, confirmations, errors, sourceRows: () => sourceRows,
    setMusicModels: (rows: any[]) => { modelRows = structuredClone(rows) },
    resolveConfirmation: (answer: boolean) => confirmationResolvers.shift()?.(answer),
    resolvePost: (index: number, value: unknown = {}) => postResolvers[index]?.resolve(value),
    rejectPost: (index: number, error: unknown) => postResolvers[index]?.reject(error),
  }
}

test('paid exact-item retry keeps its captured body and UUID across automatic source disappearance', async () => {
  const fx = await fixture()
  assert.equal(fx.state.manualRedoPreference.enabled.value, true)
  assert.equal(fx.state.manualRedoSources.value.length, 1)
  fx.state.manualSourceChoice.value = 'stopped-library-source::track-0'
  fx.state.manualMusicModelId.value = 'mock-music-v1'
  fx.state.manualRedoChecked.value = true
  await fx.state.beginManualMusicRedo()

  assert.equal(fx.confirmations.length, 1)
  assert.equal(fx.confirmations[0].type, 'music')
  assert.equal(fx.confirmations[0].context.always, true)
  assert.equal(fx.posts.length, 1)
  assert.equal(fx.state.manualRedoChecked.value, false, 'automatic eligibility loss clears only a new choice')
  assert.ok(fx.state.pendingManualMusicSubmission.value, 'accepted transport identity survives source removal')
  fx.setMusicModels([])
  await fx.state.loadMusicModels()
  await nextTick()
  assert.equal(fx.state.musicModels.value.length, 0, 'the current catalogue still controls availability')
  assert.equal(fx.state.manualMusicModel.value, null, 'the removed row is not treated as currently available')
  assert.equal(fx.state.manualMusicModelId.value, 'mock-music-v1', 'automatic disappearance preserves the attempted identity')
  assert.ok(fx.state.pendingManualMusicSubmission.value, 'catalogue disappearance keeps the accepted unknown transport identity')
  assert.equal(fx.actions.at(-1)?.label, 'Retry')

  await fx.actions.at(-1)!.run()
  assert.equal(fx.posts.length, 2)
  assert.deepEqual(fx.posts[1]!.body, fx.posts[0]!.body)
  assert.equal(fx.posts[1]!.body.operation_id, fx.posts[0]!.body.operation_id)
  assert.equal(fx.posts[0]!.body.manual_music_payment.confirmed_paid_music, true)
  assert.equal(fx.posts[0]!.body.manual_music_payment.price_version, 'mock-music-price-v1')
  assert.equal(fx.posts[0]!.body.manual_redo.source_job_id, 'stopped-library-source')
  assert.equal(fx.posts[0]!.body.source_item_key, 'track-0')

  await fx.state.loadMusicModels()
  await nextTick()
  assert.equal(fx.state.manualMusicModelId.value, '', 'after resolution the current empty catalogue heals the selection')
})

test('published chargeable truth requires the separate paid music confirmation even at a local zero rate', async () => {
  const fx = await fixture({
    models: [{
      id: 'mock-music-v1', display_name: 'Mock Music', chargeable: true,
      credits_per_request: 0, minimum_credits: 0, standard_credits: 0, sale_credits: null,
      price_source: 'local', price_usd: {}, price_version: 'mock-music-price-v1',
      supports_instrumental: true, requires_lyrics: false,
      max_title_characters: 80, max_prompt_characters: 500,
      max_prompt_without_lyrics_characters: 120, min_prompt_characters: 12,
      max_lyrics_characters: 5_000, min_lyrics_characters: 24,
    }],
  })
  fx.state.manualSourceChoice.value = 'stopped-library-source::track-0'
  fx.state.manualMusicModelId.value = 'mock-music-v1'
  fx.state.manualRedoChecked.value = true
  await fx.state.beginManualMusicRedo()

  assert.equal(fx.confirmations.length, 1)
  assert.equal(fx.confirmations[0].context.always, true)
  assert.equal(fx.posts[0]?.body.manual_music_payment.confirmed_paid_music, true)
  assert.equal(fx.state.manualMusicLimits.value,
    'Published limits: title up to 80 characters · prompt 12–500 characters · prompt without lyrics 12–120 characters · lyrics 24–5,000 characters.')

  fx.setMusicModels([{
    id: 'mock-music-v1', display_name: 'Mock Music', chargeable: true,
    credits_per_request: 0, minimum_credits: 0, standard_credits: 0, sale_credits: null,
    price_source: 'local', price_usd: {}, price_version: 'mock-music-price-v1',
    supports_instrumental: true, requires_lyrics: false,
    max_title_characters: 80, max_prompt_characters: 500,
    max_prompt_without_lyrics_characters: 120, min_prompt_characters: null,
    max_lyrics_characters: 5_000, min_lyrics_characters: null,
  }])
  await fx.state.loadMusicModels()
  assert.equal(fx.state.manualMusicLimits.value,
    'Published limits: title up to 80 characters · prompt up to 500 characters · prompt without lyrics up to 120 characters · lyrics up to 5,000 characters.')
})

test('scope changes while paid confirmation is open retire the captured action before its first POST', async () => {
  const fx = await fixture({ deferredConfirmation: true })
  fx.state.manualSourceChoice.value = 'stopped-library-source::track-0'
  fx.state.manualMusicModelId.value = 'mock-music-v1'
  fx.state.manualRedoChecked.value = true
  const starting = fx.state.beginManualMusicRedo()
  await nextTick()
  const captured = fx.state.pendingManualMusicSubmission.value
  assert.ok(captured, 'body and UUID are captured before the paid confirmation wait')

  fx.state.trackMinutes.value = 5
  await nextTick()
  assert.equal(fx.state.pendingManualMusicSubmission.value, null)
  fx.resolveConfirmation(true)
  await starting
  assert.equal(fx.posts.length, 0, 'confirming an old option scope cannot make its first POST')
})

test('a late response cannot clear or report over a newer captured action', async () => {
  const fx = await fixture({ deferredPosts: true })
  fx.state.applyManualMusicSources([sourceSummary(), sourceSummary('track-1')])
  fx.state.manualSourceChoice.value = 'stopped-library-source::track-0'
  fx.state.manualMusicModelId.value = 'mock-music-v1'
  fx.state.manualRedoChecked.value = true
  const first = fx.state.beginManualMusicRedo()
  await nextTick()
  assert.equal(fx.posts.length, 1)

  fx.state.manualSourceChoice.value = 'stopped-library-source::track-1'
  fx.state.onManualSourceChoiceChanged()
  fx.state.manualRedoChecked.value = true
  const second = fx.state.beginManualMusicRedo()
  await nextTick()
  assert.equal(fx.posts.length, 2)
  const newer = fx.state.pendingManualMusicSubmission.value
  assert.ok(newer)

  fx.resolvePost(0)
  await first
  assert.equal(fx.state.pendingManualMusicSubmission.value?.operationId, newer.operationId)
  assert.equal(fx.state.manualRedoPosting.value, true)

  fx.resolvePost(1)
  await second
  assert.equal(fx.state.pendingManualMusicSubmission.value, null)
  assert.equal(fx.state.manualRedoPosting.value, false)
  assert.deepEqual(fx.errors, [])
})

test('a late definite error cannot clear or report over a newer captured action', async () => {
  const fx = await fixture({ deferredPosts: true })
  fx.state.applyManualMusicSources([sourceSummary(), sourceSummary('track-1')])
  fx.state.manualSourceChoice.value = 'stopped-library-source::track-0'
  fx.state.manualMusicModelId.value = 'mock-music-v1'
  fx.state.manualRedoChecked.value = true
  const first = fx.state.beginManualMusicRedo()
  await nextTick()

  fx.state.manualSourceChoice.value = 'stopped-library-source::track-1'
  fx.state.onManualSourceChoiceChanged()
  fx.state.manualRedoChecked.value = true
  const second = fx.state.beginManualMusicRedo()
  await nextTick()
  const newer = fx.state.pendingManualMusicSubmission.value
  assert.ok(newer)

  fx.rejectPost(0, { data: { detail: 'stale first request failed' } })
  await first
  assert.equal(fx.state.pendingManualMusicSubmission.value?.operationId, newer.operationId)
  assert.deepEqual(fx.errors, [])

  fx.resolvePost(1)
  await second
})

test('real project, model, and explicit item changes retire an unsubmitted or unknown action', async () => {
  const fx = await fixture()
  fx.state.manualSourceChoice.value = 'stopped-library-source::track-0'
  fx.state.manualMusicModelId.value = 'mock-music-v1'
  fx.state.manualRedoChecked.value = true
  await fx.state.beginManualMusicRedo()
  assert.ok(fx.state.pendingManualMusicSubmission.value)

  fx.state.manualMusicModelId.value = 'another-model'
  await nextTick()
  assert.equal(fx.state.pendingManualMusicSubmission.value, null)
  const before = fx.posts.length
  await fx.actions.at(-1)!.run()
  assert.equal(fx.posts.length, before, 'a retry from the old model scope cannot POST')

  fx.state.applyManualMusicSources([sourceSummary(), sourceSummary('track-1')])
  fx.state.manualSourceChoice.value = 'stopped-library-source::track-1'
  fx.state.onManualSourceChoiceChanged()
  assert.equal(fx.state.manualRedoChecked.value, false)

  fx.route.params.slug = 'other-project'
  await nextTick()
  assert.equal(fx.state.pendingManualMusicSubmission.value, null)
})
