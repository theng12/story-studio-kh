import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const CONCURRENCY_PATH = '/app-settings/concurrency'
const sceneImageLabel = 'Episodes making scene images at once'

async function loadThisMacSettings(): Promise<Component> {
  const filename = fileURLToPath(new URL('../components/ThisMacSettings.vue', import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'this-mac-settings-throughput' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename,
    id: 'this-mac-settings-throughput',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { ref, onMounted } from ${JSON.stringify(vueUrl)}
    const useApi = () => globalThis.__thisMacSettingsApi
    const useConfirm = () => ({ ask: async () => true })
    const useTheme = () => ({ mode: ref('system'), setMode: () => undefined })
  `
  const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

function concurrencyFixture() {
  return {
    subtitle_episode_concurrency: 2,
    llm_concurrency: 8,
    image_episode_concurrency: 3,
    image_fanout_per_episode: 'auto',
    thumbnail_episode_concurrency: 3,
    outline_chapter_headroom: 2,
    genstudio_language_timeout_minutes: 30,
    language_floor_tokens_per_second: 25,
    language_preferred_tokens_per_second: 50,
  }
}

async function flush(): Promise<void> {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

async function mountSettings() {
  const saves: any[] = []
  const concurrency = concurrencyFixture()
  ;(globalThis as any).__thisMacSettingsApi = {
    get: async (path: string) => {
      if (path === CONCURRENCY_PATH) return concurrency
      if (path === '/app-settings/genstudio') return { url: '', default_url: '' }
      if (path === '/app-settings/api-keys') return { providers: [] }
      if (path === '/app-settings/emoji') return { allow_emoji_in_generated_text: false }
      throw new Error(`unexpected GET ${path}`)
    },
    put: async (path: string, body: any) => {
      assert.equal(path, CONCURRENCY_PATH, 'throughput saves stay on the established settings endpoint')
      saves.push(body)
      Object.assign(concurrency, body)
      return concurrency
    },
    del: async () => undefined,
    post: async () => undefined,
  }
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(await loadThisMacSettings())
  app.component('ServerModeSettingsPanel', defineComponent({ setup: () => () => h('div') }))
  app.mount(host)
  await flush()
  return { host, saves, unmount: () => app.unmount() }
}

function sceneImageControls(host: HTMLElement) {
  const label = [...host.querySelectorAll('label')].find(candidate => candidate.querySelector('span')?.textContent === sceneImageLabel)
  assert.ok(label, 'scene-image field is rendered')
  const select = label.querySelector<HTMLSelectElement>('select')
  assert.ok(select, 'scene-image field has a preset selector')
  return { label, select }
}

async function saveCustom(host: HTMLElement, value: number): Promise<void> {
  const { label, select } = sceneImageControls(host)
  select.value = '__custom'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
  const input = label.querySelector<HTMLInputElement>(`.custom-value[aria-label="Custom value for ${sceneImageLabel}"]`)
  assert.ok(input, 'Custom keeps an editable numeric input visible even when the current value is a named preset')
  input.value = String(value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  host.querySelector<HTMLButtonElement>('section.concurrency button.btn-primary')!.click()
  await flush()
}

describe('This Mac throughput Custom editing', () => {
  test('Custom keeps the numeric scene-image editor visible and saves 2 plus both boundaries', async () => {
    const rendered = await mountSettings()
    try {
      const { label, select } = sceneImageControls(rendered.host)
      assert.equal(select.value, '3', 'the fixture starts at a named existing value')
      assert.equal(label.querySelector('.custom-value'), null, 'a named preset starts without the custom editor')
      assert.equal(
        [...select.options].find(option => option.value === '2')?.text,
        '2 — recommended',
        'the recommended scene-image value is visible in the rendered picker',
      )

      await saveCustom(rendered.host, 2)
      await saveCustom(rendered.host, 1)
      await saveCustom(rendered.host, 50)

      assert.deepEqual(
        rendered.saves.map(payload => payload.image_episode_concurrency),
        [2, 1, 50],
        'the mounted form sends Custom values through the established settings path',
      )
      const input = sceneImageControls(rendered.host).label.querySelector<HTMLInputElement>('.custom-value')
      assert.equal(input, null, 'a successful save returns the field to normal preset selection')
    } finally {
      rendered.unmount()
      delete (globalThis as any).__thisMacSettingsApi
    }
  })
})
