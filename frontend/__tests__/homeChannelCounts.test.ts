/**
 * The home page's channel cards say how many episodes each channel has.
 *
 * The page is compiled from the real pages/index.vue and mounted with a fake
 * API, so these tests exercise the actual template and loader. What they cannot
 * see: real CSS geometry (the card layout is checked by hand at 1280/1920 px).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const healthy = (slug: string) => ({ slug, name: slug.toUpperCase(), episode_prefix: 'EP', has_api_keys: true, output_root_exists: true })
const FULL = { episodes: 312, on_youtube: 280, in_progress: 18, needs_attention: 4 }

let pageComponent: Promise<any> | undefined
async function loadPage() {
  pageComponent ??= (async () => {
    const filename = fileURLToPath(new URL('../pages/index.vue', import.meta.url))
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
    const script = compileScript(descriptor, { id: 'home-counts-test' })
    const template = compileTemplate({
      source: descriptor.template!.content, filename, id: 'home-counts-test',
      compilerOptions: { bindingMetadata: script.bindings },
    })
    const vueUrl = await import.meta.resolve('vue')
    const util = (name: string) => JSON.stringify(new URL(`../utils/${name}.ts`, import.meta.url).href)
    const support = `
      import { computed, nextTick, onMounted, reactive, ref, watch } from ${JSON.stringify(vueUrl)}
      const useApi = () => globalThis.__homeHarness.api
      const useAppSettingsModal = () => ({ open() {} })
      const useAppTitle = () => {}
      const useSoftDeletedProjects = () => globalThis.__homeHarness.hidden
      const navigateTo = async () => {}
    `
    const scriptCode = script.content
      .replace("'~/utils/project-slug'", util('project-slug'))
      .replace("'~/utils/last-known-list'", util('last-known-list'))
      .replace('export default', 'const __sfc__ =')
    const code = `${support}\n${scriptCode}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
    const transformed = await transform(code, { loader: 'ts', format: 'esm' })
    return (await import(`data:text/javascript;base64,${Buffer.from(transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
  })()
  return pageComponent
}

const NuxtLinkStub = defineComponent({
  props: { to: { type: String, default: '' } },
  setup(props, { slots, attrs }) { return () => h('a', { href: props.to, class: attrs.class }, slots.default?.()) },
})
const Passthrough = defineComponent({ setup(_p, { slots }) { return () => h('div', slots.default?.()) } })

interface PendingCount { slug: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }

async function flush() {
  for (let i = 0; i < 4; i++) { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)) }
}

/** `lists` are the successive answers of GET /projects. Counts stay pending until the test settles them. */
async function mountHome(lists: any[][], hiddenSlugs: string[] = []) {
  localStorage.clear()
  const queue = [...lists]
  const countCalls: PendingCount[] = []
  const requested: string[] = []
  ;(globalThis as any).__homeHarness = {
    api: {
      get: (path: string) => {
        requested.push(path)
        if (path === '/projects') return Promise.resolve(queue.shift() ?? [])
        if (path === '/library/notices') return Promise.resolve({ notices: [] })
        const m = /^\/projects\/([^/]+)\/channel-counts$/.exec(path)
        if (m) return new Promise((resolve, reject) => countCalls.push({ slug: m[1], resolve, reject }))
        return Promise.reject(new Error(`unexpected GET ${path}`))
      },
      post: async () => ({}), del: async () => ({}),
    },
    hidden: {
      items: ref(hiddenSlugs.map(slug => ({ slug, name: slug, path: `/x/${slug}`, exists: true }))),
      lastError: ref(''), refresh: async () => {}, restore: async () => true,
    },
  }
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(await loadPage())
  app.component('NuxtLink', NuxtLinkStub)
  for (const name of ['Modal', 'NichePicker', 'LoadingSpinner']) app.component(name, Passthrough)
  app.mount(host)
  await flush()
  const card = (slug: string) => host.querySelector(`a[href="/projects/${slug}"]`) as HTMLElement
  const line = (slug: string) => card(slug)?.querySelector('.project-counts') as HTMLElement | null
  return { host, countCalls, requested, card, line, text: (slug: string) => line(slug)?.textContent?.replace(/\s+/g, ' ').trim() ?? null }
}

describe('channel cards show episode counts', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  test('while counting: "Counting episodes…"; unreadable or missing folders are skipped entirely', async () => {
    const h = await mountHome([[
      healthy('alpha'),
      { ...healthy('stuck'), status: 'downloading', has_api_keys: false },
      { ...healthy('gone'), output_root_exists: false },
    ]])
    assert.equal(h.text('alpha'), 'Counting episodes…')
    assert.equal(h.line('stuck'), null)
    assert.equal(h.line('gone'), null)
    assert.deepEqual(h.countCalls.map(c => c.slug), ['alpha'], 'no read is made for a folder that cannot be read')
  })

  test('success: the full line, with need-attention flagged as a warning', async () => {
    const h = await mountHome([[healthy('alpha')]])
    h.countCalls[0].resolve(FULL)
    await flush()
    assert.equal(h.text('alpha'), '312 episodes · 280 on YouTube · 18 being made now · 4 need attention')
    const warn = h.line('alpha')!.querySelector('.project-counts-warn')
    assert.equal(warn?.textContent, '4 need attention')
    assert.equal(h.line('alpha')!.querySelectorAll('.project-counts-warn').length, 1, 'only the attention part is a warning')
  })

  test('zero being made / zero needing attention are left out; 1 reads naturally; a real 0 on YouTube is shown', async () => {
    const h = await mountHome([[healthy('a'), healthy('b')]])
    h.countCalls.find(c => c.slug === 'a')!.resolve({ episodes: 1, on_youtube: 0, in_progress: 0, needs_attention: 0 })
    h.countCalls.find(c => c.slug === 'b')!.resolve({ episodes: 5, on_youtube: 2, in_progress: 0, needs_attention: 1 })
    await flush()
    assert.equal(h.text('a'), '1 episode · 0 on YouTube')
    assert.equal(h.text('b'), '5 episodes · 2 on YouTube · 1 needs attention')
  })

  test('an unknown YouTube count is said to be unknown, never drawn as 0', async () => {
    const h = await mountHome([[healthy('alpha')]])
    h.countCalls[0].resolve({ episodes: 7, on_youtube: null, in_progress: 0, needs_attention: 0 })
    await flush()
    assert.equal(h.text('alpha'), '7 episodes · YouTube count unavailable')
    assert.doesNotMatch(h.text('alpha')!, /0 on YouTube/)
  })

  test('an empty channel says so', async () => {
    const h = await mountHome([[healthy('alpha')]])
    h.countCalls[0].resolve({ episodes: 0, on_youtube: 0, in_progress: 0, needs_attention: 0 })
    await flush()
    assert.equal(h.text('alpha'), 'No episodes yet')
  })

  test('an error shows a short plain sentence on that card only, with no raw error text', async () => {
    const h = await mountHome([[healthy('a'), healthy('b')]])
    h.countCalls.find(c => c.slug === 'a')!.reject(Object.assign(new Error('ECONNRESET at /x/y.ts:12'), { data: { detail: 'Traceback boom' } }))
    h.countCalls.find(c => c.slug === 'b')!.resolve(FULL)
    await flush()
    assert.equal(h.text('a'), 'Episode counts unavailable right now')
    assert.doesNotMatch(h.card('a').textContent!, /ECONNRESET|Traceback/)
    assert.equal(h.text('b'), '312 episodes · 280 on YouTube · 18 being made now · 4 need attention')
  })

  test('the card stays one link with no button inside it', async () => {
    const h = await mountHome([[healthy('alpha')]])
    h.countCalls[0].resolve(FULL)
    await flush()
    assert.equal(h.card('alpha').querySelectorAll('button, a').length, 0)
  })

  test('a refresh forgets old answers: a gone channel shows nothing, and a late answer from the old list cannot overwrite the new one', async () => {
    const h = await mountHome([[healthy('alpha'), healthy('beta')], [healthy('alpha')]], ['restored'])
    const firstAlpha = h.countCalls.find(c => c.slug === 'alpha')!
    // Reload the list the way the page does after "Restore".
    ;(h.host.querySelector('.hidden-projects-chip') as HTMLElement).click()
    await flush()
    ;(h.host.querySelector('.hidden-project-actions button') as HTMLElement).click()
    await flush()
    assert.equal(h.card('beta'), null, 'the channel that disappeared is gone')
    assert.equal(h.text('alpha'), 'Counting episodes…', 'the new list starts counting from scratch')
    const secondAlpha = h.countCalls.filter(c => c.slug === 'alpha')[1]
    secondAlpha.resolve({ episodes: 5, on_youtube: 1, in_progress: 0, needs_attention: 0 })
    await flush()
    firstAlpha.resolve({ episodes: 999, on_youtube: 999, in_progress: 0, needs_attention: 0 })
    await flush()
    assert.equal(h.text('alpha'), '5 episodes · 1 on YouTube')
  })
})
