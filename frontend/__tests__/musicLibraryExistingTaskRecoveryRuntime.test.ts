/**
 * 2026-10-16 — "Recover existing result" on the Music Library page: a free read of a song the
 * Gateway already accepted. It must stay separate from the paid "Start separate attempt" flow and
 * never reach the generation endpoint.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { nextTick, reactive, ref, type Component } from 'vue'
import { createRenderer } from '@vue/runtime-core'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/music.vue', import.meta.url))

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(readFileSync(pagePath, 'utf8'), { filename: pagePath })
  const script = compileScript(descriptor, { id: 'music-library-existing-task-recovery-runtime' })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useRoute = () => globalThis.__musicRecoverRoute
    const useApi = () => globalThis.__musicRecoverApi
    const useFreshGenerationAction = () => ({ begin: () => 'unused', complete: () => undefined, cancel: () => undefined })
    const useToast = () => globalThis.__musicRecoverToast
    const useConfirm = () => ({ ask: async () => true })
    const useManualGenerationRedoPreference = () => globalThis.__musicRecoverPreference
    const useConfirmation = () => ({ state: {}, confirmGeneration: async () => true, cancel: () => undefined })
    const useJobs = () => ({ jobs: globalThis.__musicRecoverJobs })
    const CREDIT_BASIS_LABEL = { rate: 'Published rate', free: 'Published rate', unpublished: 'Price not reported' }
    const describeMusicUnitCost = () => ({ basis: 'rate', text: '', title: '' })
    const pickDefaultMusicModel = models => models[0] || null
    const UNCONFIRMED_SUBMISSION = 'The result is not confirmed. Retry with the same action.'
  `
  const content = script.content
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const built = await transform(`import { computed, defineComponent as _defineComponent, onMounted, ref, watch } from "vue"
    ${support}\n${content}\nconst __setup = __sfc__.setup
    __sfc__.setup = function (props, context) {
      const state = __setup(props, context)
      globalThis.__musicRecoverState = state
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

const source = {
  source_job_id: '571ec142',
  source_item_key: 'track-3',
  label: 'Night-Woven Wool',
  eligible: false,
  reason: 'No exact unresolved Gateway music evidence remains for this item.',
  recovery: 'ready',
  recovery_reason: 'The Gateway finished this song but it never reached the library (delivery failed).',
}

async function fixture(post: (path: string, body: any) => Promise<unknown>) {
  const gets: string[] = []
  const posts: Array<{ path: string; body: any }> = []
  const errors: string[] = []
  Object.assign(globalThis as any, {
    __musicRecoverRoute: reactive({ params: { slug: 'dreamlands' }, query: {} }),
    __musicRecoverJobs: ref([]),
    // The paid manual-redo preference is OFF: recovery must not depend on it.
    __musicRecoverPreference: { enabled: ref(false), load: async () => true, reset: () => undefined },
    __musicRecoverToast: { success: () => undefined, error: (message: string) => errors.push(message), showAction: () => undefined },
    __musicRecoverApi: {
      get: async (path: string) => {
        gets.push(path)
        if (path.endsWith('/manual-redo-sources')) return { sources: [structuredClone(source)] }
        if (path.endsWith('/music-library')) return { tracks: [], folder: '', available_seconds: 0, unmeasured_enabled_tracks: 0 }
        return {}
      },
      post: async (path: string, body: any) => {
        posts.push({ path, body: JSON.parse(JSON.stringify(body)) })
        return post(path, body)
      },
      patch: async () => ({}),
      del: async () => ({}),
    },
  })
  renderer.createApp(Page).mount({})
  await nextTick()
  const state = (globalThis as any).__musicRecoverState
  await state.loadManualRedoSources()
  await nextTick()
  return { state, gets, posts, errors }
}

test('recovery is distinct from manual redo and does not depend on its preference', async () => {
  const fx = await fixture(async () => ({}))
  assert.equal(fx.state.manualRedoPreference.enabled.value, false)
  assert.equal(fx.state.eligibleManualRedoSources.value.length, 0, 'the paid separate attempt is not offered')
  assert.deepEqual(fx.state.recoverableSources.value.map((s: any) => s.source_item_key), ['track-3'])
})

test('the POST body has exactly the two saved selectors, double-click is fenced, success refreshes library/source rows, and failure never calls the generation endpoint', async () => {
  let resolve!: (value: unknown) => void
  const fx = await fixture(() => new Promise(done => { resolve = done }))
  const row = fx.state.recoverableSources.value[0]
  const first = fx.state.recoverExistingResult(row)
  const second = fx.state.recoverExistingResult(row)
  await second
  assert.equal(fx.posts.length, 1, 'a second click while in flight sends nothing')
  assert.equal(fx.state.recoveringSource.value, '571ec142::track-3')
  assert.deepEqual(fx.posts[0], {
    path: '/projects/dreamlands/music-library/recover-existing-task',
    body: { source_job_id: '571ec142', source_item_key: 'track-3' },
  })
  const getsBefore = fx.gets.length
  resolve({ reused: false })
  await first
  assert.equal(fx.state.recoveringSource.value, '')
  const refreshed = fx.gets.slice(getsBefore)
  assert.ok(refreshed.includes('/projects/dreamlands/music-library'), 'the library reloads')
  assert.ok(refreshed.includes('/projects/dreamlands/music-library/manual-redo-sources'), 'the source rows reload')

  const failing = await fixture(async () => { throw Object.assign(new Error('409'), { data: { detail: 'The Gateway is still checking this music result; nothing was run twice.' } }) })
  await failing.state.recoverExistingResult(failing.state.recoverableSources.value[0])
  assert.deepEqual(failing.errors, ['The Gateway is still checking this music result; nothing was run twice.'])
  assert.equal(failing.state.recoveringSource.value, '')
  for (const fx2 of [fx, failing]) {
    assert.ok(fx2.posts.every(p => p.path.endsWith('/recover-existing-task')), 'never the generation endpoint')
  }
})
