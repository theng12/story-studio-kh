import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { nextTick, reactive, ref, type Component } from 'vue'
import { createRenderer } from '@vue/runtime-core'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/song-pool.vue', import.meta.url))
const source = readFileSync(pagePath, 'utf8')

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(source, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'song-pool-manual-redo-runtime' })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, onBeforeUnmount, onMounted, reactive, ref, watch } from ${JSON.stringify(vueUrl)}
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useRoute = () => globalThis.__songPoolManualRoute
    const useApi = () => globalThis.__songPoolManualApi
    const useFreshGenerationAction = () => globalThis.__songPoolManualFresh
    const useToast = () => globalThis.__songPoolManualToast
    const useConfirm = () => ({ ask: async () => true })
    const useManualGenerationRedoPreference = () => globalThis.__songPoolManualPreference
    const useConfirmation = () => globalThis.__songPoolManualConfirmation
    const useJobs = () => ({ jobs: globalThis.__songPoolManualJobs })
    const GenerateSongsDialog = {}
    const AddChip = {}
    const describeMusicUnitCost = model => ({ text: model ? String(model.credits_per_request) + ' credits / song request' : 'Price not reported' })
    const UNCONFIRMED_SUBMISSION = 'The result is not confirmed. Retry with the same action.'
  `
  const content = script.content
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const built = await transform(`${support}\n${content}\nconst __setup = __sfc__.setup
    __sfc__.setup = function (props, context) {
      const state = __setup(props, context)
      globalThis.__songPoolManualState = state
      return () => null
    }
    export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    built.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

const Page = await loadPage()
const renderer = createRenderer<any, any>({
  patchProp: () => undefined, insert: () => undefined, remove: () => undefined,
  createElement: () => ({}), createText: text => ({ text }), createComment: text => ({ text }),
  setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text },
  parentNode: () => null, nextSibling: () => null,
})

const sourceRow = (key = 'song-0') => ({
  source_job_id: 'stopped-song-pool-source', source_item_key: key,
  label: `Cedar ${key}`, eligible: true, reason: 'Unresolved Gateway music request',
})
const modelRow = () => ({
  id: 'mock-music-v1', display_name: 'Mock Music', chargeable: true,
  credits_per_request: 7, minimum_credits: 0, standard_credits: null, sale_credits: null,
  price_source: 'published', price_usd: {}, price_variants: [], price_version: 'music-price-v1',
  max_title_characters: 80,
  min_prompt_characters: 12, max_prompt_characters: 500, max_prompt_without_lyrics_characters: 120,
  min_lyrics_characters: 24, max_lyrics_characters: 5_000,
  min_duration_seconds: 20, max_duration_seconds: 240,
})

async function fixture(options: { deferredConfirmation?: boolean; deferredPosts?: boolean } = {}) {
  const route = reactive({ params: { slug: 'pool-project' }, query: {} as Record<string, unknown> })
  const jobs = ref<any[]>([])
  const preference = { enabled: ref(true), load: async () => true, reset: () => undefined }
  const posts: Array<{ path: string; body: any }> = []
  const actions: Array<{ label: string; run: () => void | Promise<void> }> = []
  const confirmations: any[] = []
  const confirmationResolvers: Array<(answer: boolean) => void> = []
  const postResolvers: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> = []
  let sourceRows = [sourceRow()]
  let modelRows = [modelRow()]
  let loseFirstPost = !options.deferredPosts
  let uuid = 0
  const pending = new Map<string, { id: string; scope: string }>()
  const api = {
    get: async (path: string) => {
      if (path.endsWith('/song-pool')) return { pool: { songs: [] }, stats: {}, formula: {}, episode_defaults: {}, window: [], active_batch: null }
      if (path.includes('music-models')) return { models: structuredClone(modelRows) }
      if (path.endsWith('/manual-redo-sources')) return { sources: structuredClone(sourceRows) }
      return {}
    },
    post: async (path: string, body: any) => {
      posts.push({ path, body: structuredClone(body) })
      if (options.deferredPosts && path.endsWith('/generate')) return new Promise((resolve, reject) => postResolvers.push({ resolve, reject }))
      if (path.endsWith('/generate') && loseFirstPost) { loseFirstPost = false; throw new Error('lost response') }
      return {}
    },
    patch: async () => ({}),
  }
  Object.assign(globalThis as any, {
    __songPoolManualRoute: route,
    __songPoolManualApi: api,
    __songPoolManualJobs: jobs,
    __songPoolManualPreference: preference,
    __songPoolManualFresh: {
      begin(scope: unknown, target = 'default') {
        const key = JSON.stringify(scope); const current = pending.get(target)
        if (current?.scope === key) return current.id
        const id = `76000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`
        pending.set(target, { id, scope: key }); return id
      },
      complete(id: string) { for (const [target, action] of pending) if (action.id === id) pending.delete(target) },
    },
    __songPoolManualConfirmation: {
      confirmGeneration: async (slug: string, type: string, body: any, context: any) => {
        confirmations.push({ slug, type, body: structuredClone(body), context })
        if (options.deferredConfirmation) return new Promise<boolean>(resolve => confirmationResolvers.push(resolve))
        return true
      },
    },
    __songPoolManualToast: {
      success: () => undefined, error: () => undefined,
      showAction: (_message: string, label: string, run: () => void | Promise<void>) => actions.push({ label, run }),
    },
  })
  renderer.createApp(Page).mount({})
  await nextTick()
  const state = (globalThis as any).__songPoolManualState
  await state.loadModels(); await state.loadManualSources(); await nextTick()
  return {
    state, route, jobs, posts, actions, confirmations,
    setSources(rows: any[]) { sourceRows = structuredClone(rows) },
    setModels(rows: any[]) { modelRows = structuredClone(rows) },
    resolveConfirmation(answer: boolean) { confirmationResolvers.shift()?.(answer) },
    resolvePost(index: number, value: unknown = {}) { postResolvers[index]?.resolve(value) },
  }
}

function choose(state: any, key = 'song-0') {
  state.manualSourceChoice.value = `stopped-song-pool-source::${key}`
  state.manualMusicModelId.value = 'mock-music-v1'
  state.manualRedoChecked.value = true
}

test('lost response retries the exact body and UUID after source and catalogue disappearance', async () => {
  const fx = await fixture()
  choose(fx.state)
  await fx.state.beginManualSongRedo()
  assert.equal(fx.confirmations.length, 1)
  assert.equal(fx.confirmations[0].type, 'music')
  assert.equal(fx.confirmations[0].context.always, true)
  assert.match(fx.state.manualMusicLimits.value, /title up to 80 characters/)
  assert.equal(fx.actions.at(-1)?.label, 'Retry')
  fx.setSources([]); fx.jobs.value = [{ job_id: 'stopped-song-pool-source', status: 'done', force_abandoned: true }]
  await nextTick(); await nextTick()
  fx.setModels([]); await fx.state.loadModels(); await nextTick()
  assert.ok(fx.state.pendingManualSong.value)
  assert.equal(fx.state.manualMusicModelId.value, 'mock-music-v1')
  await fx.actions.at(-1)!.run()
  assert.equal(fx.posts.length, 2)
  assert.deepEqual(fx.posts[1]!.body, fx.posts[0]!.body)
  assert.equal(fx.posts[0]!.body.manual_redo.source_job_id, 'stopped-song-pool-source')
  assert.equal(fx.posts[0]!.body.source_item_key, 'song-0')
})

test('missing, undefined, or null minimum price stays unknown instead of becoming locally free', async () => {
  const base = {
    display_name: 'Unpriced Music', credits_per_request: 0,
    standard_credits: 0, sale_credits: null,
    price_source: 'local', price_usd: {}, price_variants: [], price_version: 'unpriced-v1',
    supports_instrumental: true, requires_lyrics: false,
  }
  const fx = await fixture()
  fx.setModels([
    { ...base, id: 'missing-minimum' },
    { ...base, id: 'undefined-minimum', minimum_credits: undefined },
    { ...base, id: 'null-minimum', minimum_credits: null },
    { ...base, id: 'published-zero', minimum_credits: 0 },
    { ...base, id: 'positive-despite-free-flag', minimum_credits: 0, chargeable: false, sale_credits: 4 },
  ])
  await fx.state.loadModels()

  for (const modelId of ['missing-minimum', 'undefined-minimum', 'null-minimum']) {
    fx.state.manualMusicModelId.value = modelId
    await nextTick()
    assert.equal(fx.state.manualMusicPriceClass.value, 'unknown', `${modelId} must fail closed`)
  }
  fx.state.manualMusicModelId.value = 'published-zero'
  await nextTick()
  assert.equal(fx.state.manualMusicPriceClass.value, 'free', 'an explicit published zero remains free')
  fx.state.manualMusicModelId.value = 'positive-despite-free-flag'
  await nextTick()
  assert.equal(fx.state.manualMusicPriceClass.value, 'paid', 'positive published price evidence wins')

  fx.state.manualMusicModelId.value = 'null-minimum'
  await nextTick()
  fx.state.manualSourceChoice.value = 'stopped-song-pool-source::song-0'
  fx.state.manualRedoChecked.value = true
  await fx.state.beginManualSongRedo()
  assert.equal(fx.confirmations.length, 0)
  assert.equal(fx.posts.length, 0)
})

test('project, source, or model change while paid confirmation is open blocks the first POST', async () => {
  const fx = await fixture({ deferredConfirmation: true })
  choose(fx.state)
  const starting = fx.state.beginManualSongRedo()
  await nextTick()
  assert.ok(fx.state.pendingManualSong.value, 'body and UUID are captured before confirmation')
  fx.route.params.slug = 'another-project'
  await nextTick()
  fx.resolveConfirmation(true)
  await starting
  assert.equal(fx.posts.length, 0)
})

test('a late response cannot clear a newer exact-item action', async () => {
  const fx = await fixture({ deferredPosts: true })
  fx.setSources([sourceRow(), sourceRow('song-1')]); await fx.state.loadManualSources()
  choose(fx.state)
  const first = fx.state.beginManualSongRedo(); await nextTick()
  const firstId = fx.state.pendingManualSong.value.operationId
  fx.state.cancelPendingManualSong(); choose(fx.state, 'song-1')
  const second = fx.state.beginManualSongRedo(); await nextTick()
  const secondId = fx.state.pendingManualSong.value.operationId
  assert.notEqual(secondId, firstId)
  fx.resolvePost(0); await first; await nextTick()
  assert.equal(fx.state.pendingManualSong.value.operationId, secondId)
  fx.resolvePost(1); await second
})
