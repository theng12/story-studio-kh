import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

async function component() {
  const filename = new URL('../components/GenerationCompressionPanel.vue', import.meta.url).pathname
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'compression' })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'compression', compilerOptions: { bindingMetadata: script.bindings } })
  const code = script.content.replace(/^import .* from ['"]~\/.*['"]\s*$/gm, '').replace('export default', 'const __sfc__ =')
  const support = 'const useApi = () => globalThis.__compressionApi;'
  const transformed = await transform(`${support}\n${code}\n${template.code}\n__sfc__.render = render; export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(transformed.code.replaceAll('"vue"', JSON.stringify(await import.meta.resolve('vue')))).toString('base64')}`)).default
}
async function flush() { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
async function mount(api: any, slug?: string) {
  ;(globalThis as any).__compressionApi = api
  const props = ref<{ slug?: string }>({ slug })
  const Comp = await component()
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(defineComponent({ setup: () => () => h(Comp, props.value) }))
  app.mount(host); await flush(); await flush()
  return { host, props, close: () => { app.unmount(); host.remove() } }
}
const defaults = { music: true, narration: true, scene_images: true, image_pool: true, thumbnails: false }

test('app defaults: five plain-labelled toggles, thumbnails off, each change saves only that kind', async () => {
  const puts: any[] = []
  const ui = await mount({
    get: async (url: string) => { assert.equal(url, '/app-settings/generation-compression'); return { settings: defaults, defaults } },
    put: async (url: string, body: any) => { puts.push({ url, body }); return { settings: { ...defaults, ...body }, defaults } },
  })
  try {
    const text = ui.host.textContent || ''
    for (const label of [
      'Compress music (smaller files, AAC)',
      'Compress narration in transit (smaller transfer, AAC)',
      'Compress scene images (smaller files, JPEG)',
      'Compress image pool images (smaller files, JPEG)',
      'Compress thumbnails (smaller files, JPEG)',
    ]) assert.match(text, new RegExp(label.replace(/[()]/g, '\\$&')))
    const box = (kind: string) => ui.host.querySelector<HTMLInputElement>(`input[name="compress-${kind}"]`)!
    assert.deepEqual(['music', 'narration', 'scene_images', 'image_pool', 'thumbnails'].map(k => box(k).checked), [true, true, true, true, false])
    box('music').checked = false
    box('music').dispatchEvent(new Event('change', { bubbles: true })); await flush()
    assert.deepEqual(puts, [{ url: '/app-settings/generation-compression', body: { music: false } }])
    assert.equal(box('music').checked, false)
    assert.match(ui.host.textContent || '', /Saved\. Applies to the next thing you generate\./)
    assert.equal(ui.host.querySelector('select'), null, 'the app panel has no per-project selects')
  } finally { ui.close() }
})

test('project override: inherit / On / Off, inherit sends null so the app default applies again', async () => {
  const puts: any[] = []
  let override: Record<string, boolean> = { scene_images: false }
  const payload = () => ({ global: { ...defaults, music: false }, override, effective: { ...defaults, music: false, ...override } })
  const ui = await mount({
    get: async (url: string) => { assert.equal(url, '/projects/first/settings/generation-compression'); return payload() },
    put: async (url: string, body: any) => {
      puts.push({ url, body })
      for (const [k, v] of Object.entries(body)) { if (v === null) delete override[k]; else override[k] = v as boolean }
      return payload()
    },
  }, 'first')
  try {
    const sel = (kind: string) => ui.host.querySelector<HTMLSelectElement>(`select[name="compress-${kind}"]`)!
    assert.equal(sel('scene_images').value, 'off')
    assert.equal(sel('music').value, 'inherit')
    assert.match(sel('music').textContent || '', /Use app default \(Off\)/, 'shows what inherit means right now')
    sel('music').value = 'on'; sel('music').dispatchEvent(new Event('change', { bubbles: true })); await flush()
    sel('scene_images').value = 'inherit'; sel('scene_images').dispatchEvent(new Event('change', { bubbles: true })); await flush()
    assert.deepEqual(puts.map(p => p.body), [{ music: true }, { scene_images: null }])
    assert.equal(sel('music').value, 'on')
    assert.equal(sel('scene_images').value, 'inherit')
  } finally { ui.close() }
})

test('a failed load is stated and nothing is editable; a slow answer for the old project is ignored', async () => {
  const failing = await mount({ get: async () => { throw new Error('offline') }, put: async () => { throw new Error('no') } })
  try {
    assert.match(failing.host.textContent || '', /Could not load the smaller-files settings/)
    assert.equal(failing.host.querySelector('input[type=checkbox]'), null)
  } finally { failing.close() }

  const slow = deferred<any>()
  const ui = await mount({
    get: (url: string) => url.includes('/first/') ? slow.promise : Promise.resolve({ global: defaults, override: { music: false }, effective: defaults }),
    put: async () => ({}),
  }, 'first')
  try {
    ui.props.value = { slug: 'second' }; await flush()
    slow.resolve({ global: defaults, override: { narration: false }, effective: defaults }); await flush()
    const sel = (kind: string) => ui.host.querySelector<HTMLSelectElement>(`select[name="compress-${kind}"]`)!
    assert.equal(sel('music').value, 'off', 'the second project\'s own value is shown')
    assert.equal(sel('narration').value, 'inherit', 'the first project\'s late answer must not overwrite it')
  } finally { ui.close() }
})
