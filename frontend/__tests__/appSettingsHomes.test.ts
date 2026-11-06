import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const componentPath = fileURLToPath(new URL('../components/ThisMacSettings.vue', import.meta.url))
const source = readFileSync(componentPath, 'utf8')

async function mount(section: string) {
  const { descriptor } = parse(source, { filename: componentPath })
  const script = compileScript(descriptor, { id: 'app-settings-homes' })
  const template = compileTemplate({ source: descriptor.template!.content, filename: componentPath, id: 'app-settings-homes', compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const vueUrl = import.meta.resolve('vue')
  const calls: string[] = []
  ;(globalThis as any).__appSettingsHomeApi = {
    get: async (path: string) => {
      calls.push(path)
      if (path === '/library') return { path: '/fixture/library' }
      if (path === '/app-settings/api-keys') return { providers: [] }
      if (path === '/app-settings/emoji') return { allow_emoji_in_generated_text: false }
      return { url: 'http://fixture.invalid', default_url: 'http://fixture.invalid' }
    },
  }
  const support = `import { ref, onMounted } from ${JSON.stringify(vueUrl)}
    const useApi = () => globalThis.__appSettingsHomeApi
    const useConnectionStatus = () => ({ connection: { tone: 'offline', label: 'Fixture' }, refresh() {} })
    const useConfirm = () => ({ ask: async () => false })
    const useTheme = () => ({ mode: ref('system'), setMode() {} })`
  const compiled = await transform(`${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render; export default __sfc__`, { loader: 'ts', format: 'esm' })
  const Component = (await import(`data:text/javascript;base64,${Buffer.from(compiled.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
  const host = document.createElement('div')
  const app = createApp(Component, { section })
  for (const name of ['DefaultModelsSettings', 'AppFilesSettings', 'BackupPanel', 'AppNotificationSettings', 'PerformanceSettings', 'DuplicateScreeningSettings', 'CostSettings', 'AdvancedDisclosure', 'ServerModeSettingsPanel', 'YouTubeConnectionSettings', 'SocialPublishingSettings', 'SceneAnalysisSettings', 'GenStudioCatalogSettings']) {
    app.component(name, defineComponent({ name, inheritAttrs: false, setup: (_, { slots }) => () => h('div', { 'data-home': name }, slots.default?.()) }))
  }
  app.mount(host)
  await nextTick(); await nextTick()
  return { host, calls, destroy: () => app.unmount() }
}

test('each added App Settings section opens its own controls without a channel', async () => {
  for (const [section, names] of [
    ['default-models', ['DefaultModelsSettings']],
    ['files', ['AppFilesSettings']],
    ['backup', ['BackupPanel']],
    ['appearance', ['AppNotificationSettings']],
    ['connections', ['YouTubeConnectionSettings', 'SocialPublishingSettings', 'SceneAnalysisSettings', 'GenStudioCatalogSettings']],
  ] as const) {
    const mounted = await mount(section)
    try {
      for (const name of names) assert.equal(mounted.host.querySelectorAll(`[data-home="${name}"]`).length, 1, `${section}: ${name}`)
      assert.ok(mounted.calls.every(path => !path.startsWith('/projects/')))
      if (['default-models', 'files'].includes(section)) assert.deepEqual(mounted.calls, [], 'unrelated connections are not loaded')
      if (section === 'backup') assert.deepEqual(mounted.calls, ['/library'])
    } finally { mounted.destroy() }
  }
})
