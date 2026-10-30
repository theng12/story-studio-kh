/**
 * Choosing a file from ANOTHER Mac (owner, 2026-10-30): "we do not use paths
 * anymore… change them all to pickers", and Story is often used through a
 * browser over Tailscale, where a native dialog would open on the mini.
 *
 * Three properties are pinned here:
 *  1. Every native pick from the app is rerouted to the in-app browser when the
 *     app is served to a remote browser (the useApi shim), so no dialog opens
 *     where nobody can see it.
 *  2. That browser offers "Upload from this Mac": the file on the customer's own
 *     machine cannot be opened by the server, so its bytes are sent and the
 *     server answers with a path of its own.
 *  3. A file field shows the file's NAME (with the full path on hover) and says
 *     so when the file is no longer there — never a raw path to read or edit.
 *
 * The visual proof is a render in
 * `_orchestra/app-closeout-20261021/story-371/sidebar/`; a test cannot see it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, h, nextTick, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

async function loadSfc(relative: string): Promise<Component> {
  const filename = fileURLToPath(new URL(relative, import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const id = relative.replace(/\W+/g, '-')
  const script = compileScript(descriptor, { id })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id, compilerOptions: { bindingMetadata: script.bindings } })
  const code = `${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  const vueUrl = import.meta.resolve('vue')
  const rewritten = transformed.code
    .replaceAll('"vue"', JSON.stringify(vueUrl))
    .replace(/"(\.\.\/(?:utils|composables)\/[\w-]+)"/g, (_m, spec: string) => JSON.stringify(new URL(`${spec}.ts`, import.meta.url).href))
  return (await import(`data:text/javascript;base64,${Buffer.from(rewritten).toString('base64')}`)).default
}

function mount(component: Component, props: Record<string, unknown>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(component, props) })
  app.mount(host)
  return { host, unmount: () => { app.unmount(); host.remove() } }
}

const settle = async () => { for (let i = 0; i < 4; i += 1) { await nextTick(); await new Promise(r => setTimeout(r, 0)) } }

describe('a remote browser can pick and upload', () => {
  test('the pick-* routes are rerouted to the in-app browser in server mode', () => {
    const api = source('../composables/useApi.ts')
    assert.match(api, /maybeServerModeNativePickerShim\(path, options\.body\)/)
    assert.match(api, /path\.startsWith\('\/system\/pick-'\)/, 'only the pick routes are rerouted')
    for (const route of ['pick-folder', 'pick-file', 'pick-files']) {
      assert.match(api, new RegExp(`/system/${route}`), `${route} is handled by the shim`)
    }
  })

  test('the in-app browser offers an upload from the customer\'s own Mac, and no path to type', () => {
    const modal = source('../components/FileBrowserModal.vue')
    assert.match(modal, /Upload from this Mac/)
    assert.match(modal, /\/api\/system\/upload-file\?filename=\$\{encodeURIComponent\(file\.name\)\}/)
    assert.match(modal, /body: file/, 'the bytes are sent, not a path the server cannot open')
    assert.doesNotMatch(modal, /v-model="manualPath"/, 'no typed path inside the picker')
    assert.doesNotMatch(modal, /Type or paste a path/, 'the instruction to type a path is gone')
  })

  test('the server keeps an uploaded file and answers with its own path', () => {
    const route = source('../../electron/server/routes/system.ts')
    assert.match(route, /router\.post\('\/system\/upload-file'/)
    assert.match(route, /express\.raw\(\{ type: 'application\/octet-stream'/, 'bytes are accepted without inflating them into JSON')
    assert.match(route, /res\.json\(\{ path: target, bytes: bytes\.length \}\)/, 'same answer shape as a native pick')
  })
})

describe('a file field', () => {
  test('shows the file by name with the full path on hover — never a raw path to edit', async () => {
    ;(globalThis as any).useApi = () => ({ post: async () => ({ valid: true }) })
    ;(globalThis as any).useToast = () => ({ error: () => {} })
    const Picker = await loadSfc('../components/FilePicker.vue')
    const { host, unmount } = mount(Picker, {
      modelValue: '/Users/theng/Documents/Story Studio KH/Library/kh/EP0001/assets/intro.mp3',
    })
    await settle()
    const name = host.querySelector('.file-picker-name') as HTMLElement
    assert.equal(name.textContent, 'intro.mp3')
    assert.equal(name.getAttribute('title'), '/Users/theng/Documents/Story Studio KH/Library/kh/EP0001/assets/intro.mp3')
    assert.equal(host.querySelector('input'), null, 'nothing here can be typed into')
    unmount()
  })

  test('says the file is not there, and does not claim it is missing when the check itself failed', async () => {
    let reply: () => Promise<unknown> = async () => ({ valid: false, reason: 'path does not exist' })
    ;(globalThis as any).useApi = () => ({ post: async () => await reply() })
    ;(globalThis as any).useToast = () => ({ error: () => {} })
    const Picker = await loadSfc('../components/FilePicker.vue')

    const gone = mount(Picker, { modelValue: '/Volumes/Gone/voice.mp3' })
    await settle()
    assert.equal(gone.host.querySelector('.file-picker-missing')?.textContent, 'File not found')
    gone.unmount()

    reply = async () => { throw new Error('offline') }
    const unknown = mount(Picker, { modelValue: '/Volumes/Gone/voice.mp3' })
    await settle()
    assert.equal(unknown.host.querySelector('.file-picker-missing'), null, 'could not check is not missing')
    unknown.unmount()
  })
})
