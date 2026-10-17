/**
 * Character Sheet keeps the episode's saved visual setup safe: a failed read
 * never turns into a Save of the defaults, unsaved edits are tracked (and
 * guarded), and anchors of deleted characters are dropped out loud.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, nextTick, ref, type Component } from 'vue'

const filename = fileURLToPath(new URL('../pages/projects/[slug]/character-sheet.vue', import.meta.url))
const continuityUrl = pathToFileURL(fileURLToPath(new URL('../composables/useContinuityConfig.ts', import.meta.url))).href

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'character-sheet-draft-runtime' })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, h, ref, watch } from ${JSON.stringify(vueUrl)}
    import { CONTINUITY_PRESET_EXCLUDE_KEYS, applyContinuityPagePreset, continuityDefaults, normalizeContinuityConfig } from ${JSON.stringify(continuityUrl)}
    const F = new Proxy({}, { get: (_, k) => globalThis.__csFixture[k] })
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useRoute = () => F.route
    const useApi = () => ({ get: F.get, put: F.put, post: async () => ({}), del: async () => ({}) })
    const useToast = () => ({ success: () => undefined, error: () => undefined })
    const useCharacters = () => ({ listForEpisode: async () => F.characters })
    const usePresets = () => ({ load: async () => undefined })
    const useConfirm = () => ({ ask: async () => true })
    const useUnsavedGuard = (dirty) => { globalThis.__csFixture.guard = dirty }
    const useJobs = () => ({ jobs: F.jobs })
  `
  const content = script.content
    .replace(/^import[\s\S]*?from [^\n]+\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const output = await transform(`${support}\n${content}\nconst setup = __sfc__.setup
    __sfc__.setup = (props, ctx) => {
      const state = setup(props, ctx)
      globalThis.__csFixture.state = state
      return () => h('main')
    }
    export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    output.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) { await Promise.resolve(); await nextTick() }
}

async function mount(getImpl: (path: string) => Promise<any>) {
  const puts: any[] = []
  const f: any = {
    route: { params: { slug: 'proj' } },
    characters: [{ id: 'c1', name: 'Ana', references: { images: ['a.png'] } }],
    jobs: ref([]),
    get: getImpl,
    put: async (_path: string, body: any) => { puts.push(body); return { ok: true, config: body } },
  }
  ;(globalThis as any).__csFixture = f
  const app = createApp(await loadPage())
  const host = document.body.appendChild(document.createElement('div'))
  app.mount(host)
  await flush()
  f.state.episodeId.value = 'EP0001'
  await flush()
  return { f, state: f.state, puts, unmount: () => { app.unmount(); host.remove() } }
}

test('a failed read shows an error and Save refuses to overwrite the real setup', async () => {
  let fail = true
  const { state, puts, unmount } = await mount(async (path) => {
    if (path.includes('/continuity/')) {
      if (fail) throw new Error('server busy')
      return { exists: true, config: { anchor_character_ids: ['c1'] } }
    }
    return {}
  })
  try {
    assert.match(state.configLoadError.value, /server busy/)
    assert.equal(state.configLoaded.value, false)
    await state.saveConfig()
    assert.equal(puts.length, 0, 'no defaults may be written over the saved setup')

    fail = false
    await state.loadConfig()
    await flush()
    assert.equal(state.configLoadError.value, '')
    assert.deepEqual(state.config.value.anchor_character_ids, ['c1'])
    assert.equal(state.dirty.value, false)
  } finally { unmount() }
})

test('edits mark the page unsaved for the guard until saved', async () => {
  const { f, state, puts, unmount } = await mount(async (path) =>
    path.includes('/continuity/') ? { exists: true, config: { anchor_character_ids: [] } } : {})
  try {
    assert.equal(f.guard.value, false)
    state.toggleAnchor('c1')
    assert.equal(f.guard.value, true)
    assert.equal(state.saveStatus.value, 'Unsaved changes')
    await state.saveConfig()
    await flush()
    assert.equal(puts.length, 1)
    assert.equal(f.guard.value, false)
  } finally { unmount() }
})

test('anchors of deleted characters are dropped and announced', async () => {
  const { state, unmount } = await mount(async (path) =>
    path.includes('/continuity/') ? { exists: true, config: { anchor_character_ids: ['c1', 'gone'] } } : {})
  try {
    assert.deepEqual(state.config.value.anchor_character_ids, ['c1'])
    assert.match(state.droppedAnchorNotice.value, /1 selected character was deleted or unassigned/)
    assert.equal(state.dirty.value, true, 'the drop is a change the customer saves')
  } finally { unmount() }
})
