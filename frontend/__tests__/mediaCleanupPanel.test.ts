import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const savedOperations = new Map<string, string>()
beforeEach(() => {
  savedOperations.clear()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => savedOperations.get(key) ?? null,
    setItem: (key: string, value: string) => savedOperations.set(key, value),
    removeItem: (key: string) => savedOperations.delete(key),
  } })
})

async function component() {
  const filename = new URL('../components/MediaCleanupPanel.vue', import.meta.url).pathname
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'cleanup' })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'cleanup', compilerOptions: { bindingMetadata: script.bindings } })
  const code = script.content.replace(/^import .* from ['"]~\/.*['"]\s*$/gm, '').replace('export default', 'const __sfc__ =')
  const support = `const useApi = () => globalThis.__cleanupApi; const useConfirm = () => ({ask: (...args) => globalThis.__cleanupAsk(...args)}); const pickFolder = async () => '/external/archive';`
  const transformed = await transform(`${support}\n${code}\n${template.code}\n__sfc__.render = render; export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(transformed.code.replaceAll('"vue"', JSON.stringify(await import.meta.resolve('vue')))).toString('base64')}`)).default
}
async function flush() { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
async function mount(api: any, ask: any = async () => true) {
  ;(globalThis as any).__cleanupApi = api
  ;(globalThis as any).__cleanupAsk = ask
  const props = ref({ slug: 'first' })
  const Comp = await component()
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(defineComponent({ setup: () => () => h(Comp, props.value) }))
  app.mount(host); await flush()
  return { host, props, close: () => { app.unmount(); host.remove() } }
}
function button(host: HTMLElement, label: string) {
  const node = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label)
  assert.ok(node, `button ${label} exists`); return node
}
function change(input: HTMLInputElement) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })) }
const listed = { episodes: [{ episode_code: 'EP0001', title: 'Uploaded episode', video_id: 'abc' }], blocked_reasons: [] }
const preview = { preview_id: 'review-1', project_slug: 'first', files: [{ path: '/episode/image.png', relative_path: 'image.png', category: 'images', bytes: 2048 }], total_bytes: 2048, blocked_reasons: [], episodes: [{ episode_code: 'EP0001', files: [{ path: '/episode/image.png', relative_path: 'image.png', category: 'images', bytes: 2048 }], blocked_reasons: [] }] }

test('cleanup ignores old project responses and resets all selection on project switch', async () => {
  const response = deferred<any>()
  const ui = await mount({ get: () => response.promise })
  try {
    button(ui.host, 'Find uploaded episodes').click(); await flush()
    ui.props.value = { slug: 'second' }; await flush()
    response.resolve(listed); await flush()
    assert.doesNotMatch(ui.host.textContent || '', /EP0001/)
    assert.equal(button(ui.host, 'Find uploaded episodes').disabled, false)
  } finally { ui.close() }
})

test('review uses selected scope, cancellation spends nothing, double confirm starts one exact reviewed operation', async () => {
  const calls: any[] = []
  const confirm = deferred<boolean>()
  let askCount = 0
  const ui = await mount({
    get: async (url: string) => url.endsWith('/episodes') ? listed : { id: 'preview-op', project_slug: 'first', kind: 'preview', status: 'completed', done: 1, total: 1, current: '', stage: null, preview },
    post: async (url: string, body: any) => { calls.push({ url, body }); return { operation_id: url.endsWith('/preview') ? 'preview-op' : 'run-op' } },
  }, () => { askCount++; return askCount === 1 ? Promise.resolve(false) : confirm.promise })
  try {
    button(ui.host, 'Find uploaded episodes').click(); await flush()
    button(ui.host, 'Select all uploaded').click(); await flush()
    const images = ui.host.querySelector<HTMLInputElement>('input[type=checkbox][value=images]')!
    change(images); await flush()
    button(ui.host, 'Review selected files').click(); await flush(); await flush()
    assert.deepEqual(calls[0], { url: '/projects/first/media-cleanup/preview', body: { episode_codes: ['EP0001'], categories: ['images'] } })
    change(ui.host.querySelector<HTMLInputElement>('input[type=radio][value=remove]')!); await flush()
    button(ui.host, 'Remove reviewed files').click(); await flush()
    assert.equal(calls.length, 1, 'declined confirmation must not run cleanup')
    const run = button(ui.host, 'Remove reviewed files'); run.click(); run.click(); await flush()
    assert.equal(askCount, 2, 'one pending confirmation despite repeated click')
    confirm.resolve(true); await flush()
    assert.equal(calls.filter(c => c.url.endsWith('/run')).length, 1)
    assert.deepEqual(calls[1].body, { preview_id: 'review-1', mode: 'remove' })
  } finally { ui.close() }
})

test('dismissed or changed selections cannot reuse a stale reviewed file list', async () => {
  const ui = await mount({ get: async (url: string) => url.endsWith('/episodes') ? listed : { id: 'preview-op', project_slug: 'first', kind: 'preview', status: 'completed', stage: null, done: 1, total: 1, current: '', preview }, post: async () => ({ operation_id: 'preview-op' }) })
  try {
    button(ui.host, 'Find uploaded episodes').click(); await flush()
    button(ui.host, 'Select all uploaded').click(); await flush()
    change(ui.host.querySelector<HTMLInputElement>('input[type=checkbox][value=images]')!); await flush()
    button(ui.host, 'Review selected files').click(); await flush(); await flush()
    assert.match(ui.host.textContent || '', /Review 1 files/)
    button(ui.host, 'Clear selection').click(); await flush()
    assert.doesNotMatch(ui.host.textContent || '', /Archive reviewed files/)
  } finally { ui.close() }
})


test('dismissed review stays dismissed after navigating away and returning', async () => {
  const api = { get: async () => ({ id: 'preview-op', project_slug: 'first', kind: 'preview', status: 'completed', stage: null, done: 1, total: 1, current: '', preview }) }
  savedOperations.set('media-cleanup:first', 'preview-op')
  const ui = await mount(api)
  try {
    assert.match(ui.host.textContent || '', /Archive reviewed files/)
    button(ui.host, 'Dismiss review').click(); await flush()
    assert.equal(savedOperations.has('media-cleanup:first'), false)
  } finally { ui.close() }
  const restored = await mount(api)
  try { assert.doesNotMatch(restored.host.textContent || '', /Archive reviewed files/) }
  finally { restored.close() }
})

test('stopped preview explains no files changed instead of claiming file outcomes exist', async () => {
  savedOperations.set('media-cleanup:first', 'preview-op')
  const ui = await mount({ get: async () => ({ id: 'preview-op', project_slug: 'first', kind: 'preview', status: 'stopped', stage: null, done: 1, total: 2, current: '' }) })
  try {
    assert.match(ui.host.textContent || '', /Scan stopped — no files changed/)
    assert.doesNotMatch(ui.host.textContent || '', /review the file outcomes/)
  } finally { ui.close() }
})

test('interrupted removals identify pending outcomes separately from skipped files', async () => {
  savedOperations.set('media-cleanup:first', 'run-op')
  const ui = await mount({ get: async () => ({ id: 'run-op', project_slug: 'first', kind: 'run', status: 'stopped', stage: null, done: 1, total: 2, current: '', result: { items: [{ path: 'one.png', outcome: 'removed' }, { path: 'two.png', outcome: 'pending' }], bytes_reclaimed: 2048 } }) })
  try {
    assert.match(ui.host.textContent || '', /1 files changed; 0 skipped/)
    assert.match(ui.host.textContent || '', /1 need review after interruption/)
  } finally { ui.close() }
})
