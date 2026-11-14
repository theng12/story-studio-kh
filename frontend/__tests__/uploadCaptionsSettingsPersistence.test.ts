/**
 * Focused regressions for the captions settings panel's persistence
 * (Story 386 Item 17).
 *
 * Proves the panel's persistence contract:
 * - it reads this channel's stored `caption_settings` and hands the choice to
 *   the upload page through v-model;
 * - a save writes ONLY `caption_settings` through the existing generic config
 *   PUT, then reads the value back;
 * - a setting changed elsewhere since the panel loaded is never overwritten.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const componentPath = fileURLToPath(new URL('../components/UploadCaptionsSettings.vue', import.meta.url))
const source = readFileSync(componentPath, 'utf8')

type Call = { method: 'get' | 'put'; path: string; body?: unknown }

async function mount(options: {
  /** Successive GET responses; the last one repeats. */
  configs: Array<Record<string, unknown>>
  /** What a PUT leaves for the readback; defaults to the body it was sent. */
  readback?: Record<string, unknown>
}): Promise<{ host: HTMLElement; calls: Call[]; emitted: any[]; destroy: () => void }> {
  const { descriptor } = parse(source, { filename: componentPath })
  const script = compileScript(descriptor, { id: 'upload-captions-settings' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: componentPath,
    id: 'upload-captions-settings',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  assert.deepEqual(template.errors, [])

  const calls: Call[] = []
  let getIndex = 0
  let saved: Record<string, unknown> | null = null
  ;(globalThis as any).__uploadCaptionsApi = {
    get: async (path: string) => {
      calls.push({ method: 'get', path })
      if (saved) return saved
      return options.configs[Math.min(getIndex++, options.configs.length - 1)]
    },
    put: async (path: string, body: any) => {
      calls.push({ method: 'put', path, body })
      saved = options.readback ?? body
      return { ok: true }
    },
  }
  ;(globalThis as any).__uploadCaptionsRoute = { params: { slug: 'caption-project' } }

  const vueUrl = import.meta.resolve('vue')
  const support = `const useApi = () => globalThis.__uploadCaptionsApi
    const useRoute = () => globalThis.__uploadCaptionsRoute
    const FilePicker = { name: 'FilePicker', props: ['modelValue'], emits: ['update:modelValue'], render() { return null } }`
  const scriptWithoutApiImport = script.content
    .replace(/import \{ useApi \} from '~\/composables\/useApi'\n?/, '')
    .replace(/import FilePicker from '[^']*FilePicker\.vue'\n?/, '')
    .replace('export default', 'const __sfc__ =')
  const compiled = await transform(
    `${support}\n${scriptWithoutApiImport}\n${template.code}\n__sfc__.render = render; export default __sfc__`,
    { loader: 'ts', format: 'esm' },
  )
  const Component = (await import(
    `data:text/javascript;base64,${Buffer.from(compiled.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`
  )).default

  const emitted: any[] = []
  const host = document.createElement('div')
  const app = createApp(defineComponent({
    render: () => h(Component, { 'onUpdate:modelValue': (value: any) => emitted.push(value) }),
  }))
  app.mount(host)
  for (let index = 0; index < 6; index++) await nextTick()
  return { host, calls, emitted, destroy: () => app.unmount() }
}

const storedSettings = {
  enabled: true,
  language: 'km',
  track_name: 'Khmer',
  is_draft: false,
  dedupe_mode: 'skip_if_exists',
  preferred_source: 'auto',
}

test('reads stored caption settings and hands them to the upload page', async () => {
  const mounted = await mount({ configs: [{ caption_settings: storedSettings }] })
  try {
    assert.ok(mounted.calls.some(call => call.method === 'get'
      && call.path === '/projects/caption-project/settings/config'))
    const last = mounted.emitted.at(-1)
    assert.equal(last?.enabled, true)
    assert.equal(last?.language, 'km')
    assert.equal(last?.track_name, 'Khmer')
    assert.ok(mounted.host.querySelector('[data-setting="upload-captions"]'))
  } finally {
    mounted.destroy()
  }
})

test('saving writes only caption_settings and reads the value back', async () => {
  const mounted = await mount({ configs: [{ caption_settings: storedSettings }] })
  try {
    const button = mounted.host.querySelector('.btn-save') as HTMLButtonElement
    assert.ok(button, 'the panel offers a save')
    button.click()
    for (let index = 0; index < 8; index++) await nextTick()

    const put = mounted.calls.find(call => call.method === 'put')
    assert.ok(put, 'a save reaches the generic config route')
    assert.equal(put!.path, '/projects/caption-project/settings/config')
    assert.deepEqual(Object.keys(put!.body as object), ['caption_settings'], 'no other setting is rewritten')
    assert.equal((put!.body as any).caption_settings.language, 'km')
    assert.ok(mounted.host.textContent?.includes('Captions settings saved'), 'the save reports what happened')
  } finally {
    mounted.destroy()
  }
})

test('a setting changed elsewhere since the panel loaded is not overwritten', async () => {
  const mounted = await mount({
    configs: [
      { caption_settings: storedSettings },
      { caption_settings: { ...storedSettings, language: 'es', track_name: 'Spanish' } },
    ],
  })
  try {
    const button = mounted.host.querySelector('.btn-save') as HTMLButtonElement
    button.click()
    for (let index = 0; index < 8; index++) await nextTick()

    assert.equal(mounted.calls.some(call => call.method === 'put'), false, 'no stale write is sent')
    assert.ok(mounted.host.textContent?.includes('changed elsewhere'), 'the panel says why it refused')
  } finally {
    mounted.destroy()
  }
})
