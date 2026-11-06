import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { SETTINGS_INDEX, SETTINGS_ZONES, searchSettings } from '../utils/settingsIndex.ts'

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
  const indexUrl = new URL('../utils/settingsIndex.ts', import.meta.url).href
  const code = `${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl)).replaceAll('"~/utils/settingsIndex"', JSON.stringify(indexUrl)),
  ).toString('base64')}`)).default
}

async function mountNav(zones = SETTINGS_ZONES) {
  const Component = await loadComponent()
  const selected = ref('connections')
  const gone: any[] = []
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(defineComponent({
    render: () => h(Component as any, {
      zones,
      modelValue: selected.value,
      'onUpdate:modelValue': (value: string) => { selected.value = value },
      onGo: (hit: any) => { gone.push(hit) },
    }),
  }))
  app.mount(host)
  await nextTick()
  return { host, selected, gone, destroy: () => { app.unmount(); host.remove() } }
}

describe('Settings section navigation', () => {
  test('search finds individual settings, not just section names', () => {
    // v1.4.249 — "the way settings are is a bit messy. it's hard to understand or navigate."
    const first = (q: string) => searchSettings(q)[0]
    assert.equal(first('telegram')?.section, 'appearance')
    assert.equal(first('time zone')?.anchor, 'upload-schedule')
    assert.equal(first('finished videos')?.anchor, 'exports-folder')
    assert.equal(first('ffmpeg')?.section, 'maintenance')
    assert.equal(first('credit limit')?.anchor, 'paid-replacement')
    assert.equal(first('concurrency')?.anchor, 'throughput')
    assert.equal(first('library')?.anchor, 'library-folder')
    assert.deepEqual(searchSettings('icloud'), [], 'retired iCloud features are not searchable')
    assert.deepEqual(searchSettings('   '), [])
  })

  test('every indexed setting points at a real section, and twelve sections exist (1.4.300 adds Safety checks; 2026-10-27 adds Default models)', () => {
    const sections = SETTINGS_ZONES.flatMap(zone => zone.sections.map(section => section.id))
    assert.equal(sections.length, 12)
    for (const entry of SETTINGS_INDEX) assert.ok(sections.includes(entry.section), `${entry.label} → ${entry.section}`)
    // Every anchor the index names is present in the page or one of its components.
    const sources = ['../pages/projects/[slug]/settings.vue', '../components/ThisMacSettings.vue', '../components/PerformanceSettings.vue', '../components/BackupPanel.vue', '../components/DefaultModelsSettings.vue', '../components/DuplicateScreeningSettings.vue', '../components/AppFilesSettings.vue', '../components/AppNotificationSettings.vue']
      .map(rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')).join('\n')
    for (const entry of SETTINGS_INDEX) {
      assert.match(sources, new RegExp(`data-setting="${entry.anchor}"`), `anchor ${entry.anchor} exists`)
    }
  })

  test('typing shows matching settings; choosing one opens its section and reports the anchor', async () => {
    const mounted = await mountNav()
    try {
      const input = mounted.host.querySelector<HTMLInputElement>('input[type="search"]')!
      input.value = 'schedule'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await nextTick()
      const hits = [...mounted.host.querySelectorAll<HTMLButtonElement>('.settings-search-hit')]
      assert.ok(hits.length >= 1)
      assert.match(hits[0]!.textContent || '', /Upload schedule[\s\S]*Publishing/)
      hits[0]!.click()
      await nextTick()
      assert.equal(mounted.selected.value, 'publishing')
      assert.equal(mounted.gone[0]?.anchor, 'upload-schedule')
      assert.equal(input.value, '', 'the search clears after jumping')
    } finally { mounted.destroy() }
  })

  test('channel-only navigation does not offer app settings through search', async () => {
    const mounted = await mountNav(SETTINGS_ZONES.filter(zone => zone.id === 'project'))
    try {
      const input = mounted.host.querySelector<HTMLInputElement>('input[type="search"]')!
      input.value = 'desktop alerts'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await nextTick()
      assert.equal(mounted.host.querySelectorAll('.settings-search-hit').length, 0)
      assert.match(mounted.host.textContent!, /Nothing matches/)
      input.value = 'schedule'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await nextTick()
      assert.ok(mounted.host.querySelectorAll('.settings-search-hit').length > 0)
      input.value = "What's using space"
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await nextTick()
      const storage = mounted.host.querySelector<HTMLButtonElement>('.settings-search-hit')!
      assert.ok(storage, 'the retained channel storage breakdown stays searchable')
      storage.click()
      await nextTick()
      assert.equal(mounted.selected.value, 'files')
      assert.equal(mounted.gone[0]?.anchor, 'episode-storage')
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
      assert.match(mounted.host.textContent!, /Nothing matches/)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await nextTick()
      assert.equal(input.value, '')
      assert.equal(mounted.host.querySelectorAll('a').length, 12)
    } finally { mounted.destroy() }
  })
})
