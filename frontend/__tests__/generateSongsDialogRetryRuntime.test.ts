import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { nextTick, type Component } from 'vue'
import { createRenderer } from '@vue/runtime-core'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const path = fileURLToPath(new URL('../components/music/GenerateSongsDialog.vue', import.meta.url))
const source = readFileSync(path, 'utf8')

async function loadDialog(): Promise<Component> {
  const { descriptor } = parse(source, { filename: path })
  const script = compileScript(descriptor, { id: 'song-pool-dialog-retry' })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, ref, watch } from ${JSON.stringify(vueUrl)}
    const describeMusicUnitCost = model => ({ text: model ? String(model.credits_per_request) + ' credits / request' : 'Price not reported' })
    const UNCONFIRMED_SUBMISSION = 'The result is not confirmed. Retry with the same action.'
    const useApi = () => globalThis.__songDialogApi
    const useFreshGenerationAction = () => globalThis.__songDialogFresh
    const useToast = () => globalThis.__songDialogToast
    const emptyDefaultModels = () => ({ writing: null, image: null, video: null, audio: null, transcription: null, music: null })
    const normalizeDefaultModels = () => emptyDefaultModels()
    const resolveEffectiveModel = (_family, selected) => ({ model: selected || '', defaultModel: '', goneNotice: '' })
  `
  const content = script.content
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const built = await transform(`${support}\n${content}\nconst __setup = __sfc__.setup
    __sfc__.setup = function (props, context) {
      const state = __setup(props, context)
      globalThis.__songDialogState = state
      return () => null
    }
    export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    built.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

const Dialog = await loadDialog()
const renderer = createRenderer<any, any>({
  patchProp: () => undefined, insert: () => undefined, remove: () => undefined,
  createElement: () => ({}), createText: text => ({ text }), createComment: text => ({ text }),
  setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text },
  parentNode: () => null, nextSibling: () => null,
})

test('ordinary lost response retries one detached body and operation UUID', async () => {
  const posts: any[] = []
  const actions: Array<() => void | Promise<void>> = []
  let first = true
  let catalogPresent = true
  let id = 0
  const scopes = new Map<string, { key: string; id: string }>()
  Object.assign(globalThis as any, {
    __songDialogApi: {
      get: async (requestPath: string) => requestPath.includes('music-models')
        ? { models: catalogPresent ? [{ id: 'mock-music-v1', display_name: 'Mock Music', price_source: 'local', max_duration_seconds: 240 }] : [] }
        : requestPath.includes('admission') ? { max_queued_jobs: 8 } : { models: [] },
      post: async (requestPath: string, body: any) => {
        if (requestPath.endsWith('/plan')) return { first: [], count: 1, new_combinations: 1, by_mood: {}, by_tempo_band: {} }
        posts.push(structuredClone(body))
        if (first) { first = false; throw new Error('lost response') }
        return { job_id: 'accepted' }
      },
    },
    __songDialogFresh: {
      begin(scope: unknown, target = 'default') {
        const key = JSON.stringify(scope); const prior = scopes.get(target)
        if (prior?.key === key) return prior.id
        const operationId = `77000000-0000-4000-8000-${String(++id).padStart(12, '0')}`
        scopes.set(target, { key, id: operationId }); return operationId
      },
      complete(operationId: string) { for (const [target, value] of scopes) if (value.id === operationId) scopes.delete(target) },
    },
    __songDialogToast: { showAction: (_message: string, _label: string, run: () => void | Promise<void>) => actions.push(run) },
  })
  renderer.createApp(Dialog, {
    visible: true, slug: 'pool-project', mode: 'new', initialCount: 2,
    songFormula: { length_s: { min: 60, max: 61 }, lyrics: { enabled: false }, ensembles: [], moods: [], tempo_bands: [], keys: [], structures: [] },
  }).mount({})
  await nextTick(); await nextTick()
  const state = (globalThis as any).__songDialogState
  state.writerModel.value = 'mock-chat-v1'
  state.musicModelId.value = 'mock-music-v1'
  await state.start()
  assert.equal(actions.length, 1)
  assert.ok(state.pendingSongPoolSubmission.value)
  catalogPresent = false
  await state.loadModels()
  assert.ok(state.pendingSongPoolSubmission.value, 'automatic catalogue disappearance retains the exact attempted Retry')
  await actions[0]!()
  assert.equal(posts.length, 2)
  assert.deepEqual(posts[1], posts[0])
  assert.equal(posts[1].operation_id, posts[0].operation_id)
  assert.equal(state.starting.value, false, 'the completing POST owner clears busy after its retry record resolves')
  assert.equal(state.pendingSongPoolSubmission.value, null)
})

test('terminal cleanup and project scope changes cannot leave or clear the wrong posting owner', async () => {
  const posts: any[] = []
  const completions: Array<(value: unknown) => void> = []
  const started: any[] = []
  let definitive = true
  let id = 0
  Object.assign(globalThis as any, {
    __songDialogApi: {
      get: async (requestPath: string) => requestPath.includes('music-models')
        ? { models: [{ id: 'mock-music-v1', display_name: 'Mock Music', price_source: 'local', max_duration_seconds: 240 }] }
        : requestPath.includes('admission') ? { max_queued_jobs: 8 } : { models: [] },
      post: async (requestPath: string, body: any) => {
        if (requestPath.endsWith('/plan')) return { first: [], count: 1, new_combinations: 1, by_mood: {}, by_tempo_band: {} }
        posts.push(structuredClone(body))
        if (definitive) throw { data: { detail: 'Definitive refusal' } }
        return new Promise(resolve => completions.push(resolve))
      },
    },
    __songDialogFresh: {
      begin: () => `78000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
      complete: () => undefined,
    },
    __songDialogToast: { showAction: () => undefined },
  })
  const app = renderer.createApp(Dialog, {
    visible: true, slug: 'pool-a', mode: 'new', initialCount: 2,
    songFormula: { length_s: { min: 60, max: 61 }, lyrics: { enabled: false }, ensembles: [], moods: [], tempo_bands: [], keys: [], structures: [] },
    onStarted: (job: unknown) => started.push(job),
  })
  app.mount({})
  await nextTick(); await nextTick()
  const state = (globalThis as any).__songDialogState
  state.writerModel.value = 'mock-chat-v1'; state.musicModelId.value = 'mock-music-v1'
  await state.start()
  assert.equal(state.starting.value, false, 'a definitive error leaves Start usable')
  assert.equal(state.pendingSongPoolSubmission.value, null)

  definitive = false
  const old = state.start(); await nextTick()
  assert.equal(state.starting.value, true)
  state.cancelPendingSongPoolSubmission()
  state.count.value = 3
  const newer = state.start(); await nextTick()
  const newerId = state.pendingSongPoolSubmission.value.operationId
  completions[0]!({ job_id: 'old' }); await old; await nextTick()
  assert.equal(state.starting.value, true, 'an older finally cannot clear the newer posting owner')
  assert.equal(state.pendingSongPoolSubmission.value.operationId, newerId)

  ;(app as any)._instance.props.slug = 'pool-b'
  await nextTick()
  assert.equal(state.pendingSongPoolSubmission.value, null, 'navigation retires the captured request')
  assert.equal(state.starting.value, false)
  completions[1]!({ job_id: 'newer' }); await newer; await nextTick()
  assert.equal(started.length, 0, 'a response from the old project cannot emit into the new project')
})
