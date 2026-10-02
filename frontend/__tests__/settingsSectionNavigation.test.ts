import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const componentPath = fileURLToPath(new URL('../components/SettingsSectionNav.vue', import.meta.url))

async function loadComponent(): Promise<Component> {
  const { descriptor } = parse(readFileSync(componentPath, 'utf8'), { filename: componentPath })
  const script = compileScript(descriptor, { id: 'settings-section-nav' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: componentPath,
    id: 'settings-section-nav',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const code = `${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

const zones = [
  {
    id: 'machine', title: 'This Mac', scope: 'Stays on this Mac', sections: [
      { id: 'connections', label: 'Connections', description: 'The Gateway and YouTube accounts', keywords: 'api key oauth channel' },
      { id: 'performance', label: 'Performance & recovery', description: 'Local workload and retries', keywords: 'throughput failed image subtitles' },
    ],
  },
  {
    id: 'project', title: 'This Project', scope: 'Travels with project', sections: [
      { id: 'identity', label: 'Channel identity', description: 'Formula and topics', keywords: 'series topic packs' },
      { id: 'publishing', label: 'Publishing', description: 'YouTube assignment and cadence', keywords: 'channel upload schedule' },
    ],
  },
]

async function mountNav() {
  const Component = await loadComponent()
  const selected = ref('connections')
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(defineComponent({
    render: () => h(Component as any, {
      zones,
      modelValue: selected.value,
      'onUpdate:modelValue': (value: string) => { selected.value = value },
    }),
  }))
  app.mount(host)
  await nextTick()
  return { host, selected, destroy: () => { app.unmount(); host.remove() } }
}

describe('Settings section navigation', () => {
  test('searches labels, descriptions and keywords across both scopes', async () => {
    const mounted = await mountNav()
    try {
      const input = mounted.host.querySelector<HTMLInputElement>('input[type="search"]')!
      input.value = 'youtube'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await nextTick()

      const links = [...mounted.host.querySelectorAll<HTMLAnchorElement>('a')]
      assert.deepEqual(links.map(link => link.getAttribute('href')), ['#connections', '#publishing'])
      assert.equal(mounted.host.querySelectorAll('[data-settings-scope]').length, 2, 'both matching scopes stay named')
    } finally { mounted.destroy() }
  })

  test('uses addressable links, updates selection, and Escape clears search', async () => {
    const mounted = await mountNav()
    try {
      const publishing = mounted.host.querySelector<HTMLAnchorElement>('a[href="#publishing"]')!
      publishing.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await nextTick()
      assert.equal(mounted.selected.value, 'publishing')

      const input = mounted.host.querySelector<HTMLInputElement>('input[type="search"]')!
      input.value = 'nothing matches'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await nextTick()
      assert.match(mounted.host.textContent!, /No settings match/)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await nextTick()
      assert.equal(input.value, '')
      assert.equal(mounted.host.querySelectorAll('a').length, 4)
    } finally { mounted.destroy() }
  })
})
