import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createApp, nextTick } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

async function mount(get: (path: string) => Promise<any>) {
  const filename = '../components/AppVersionInfo.vue'
  const { descriptor } = parse(readFileSync(new URL(filename, import.meta.url), 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'version-info' })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'version-info', compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  let opened = 0
  ;(globalThis as any).__versionApi = { get }
  ;(globalThis as any).__versionWhatsNew = { open: () => { opened++ } }
  const vue = import.meta.resolve('vue')
  const support = `import { ref, onMounted, defineComponent as _defineComponent } from ${JSON.stringify(vue)}\nconst useApi = () => globalThis.__versionApi\nconst useWhatsNewModal = () => globalThis.__versionWhatsNew\n`
  const code = support + script.content.replace(/^import .*$/gm, '').replace('export default', 'const component =') + '\n' + template.code + '\ncomponent.render = render; export default component'
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  const component = (await import(`data:text/javascript;base64,${Buffer.from(out.code.replaceAll('"vue"', JSON.stringify(vue))).toString('base64')}`)).default
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(component)
  app.mount(host)
  await nextTick(); await nextTick()
  return { host, opened: () => opened, destroy: () => { app.unmount(); host.remove() } }
}

test('the version pill uses server-info and keeps What’s New without any update action', async () => {
  const reads: string[] = []
  const m = await mount(async path => { reads.push(path); return { version: '1.4.399' } })
  try {
    assert.deepEqual(reads, ['/server-info'])
    assert.equal(m.host.querySelector('button')?.textContent?.trim(), 'Story Studio KH 1.4.399')
    assert.match(m.host.textContent || '', /Updates are installed by Studio Launcher KH\./)
    m.host.querySelector('button')!.click()
    assert.equal(m.opened(), 1)
    assert.doesNotMatch(m.host.textContent || '', /Check Now|Trust|Open Studio Launcher|Install Now/)
  } finally { m.destroy() }
})

test('an unreadable installed version is reported without a guessed version', async () => {
  const m = await mount(async () => { throw new Error('offline') })
  try {
    assert.match(m.host.querySelector('[role="status"]')?.textContent || '', /installed version could not be read/)
    assert.doesNotMatch(m.host.textContent || '', /0\.0\.0|1\.4\./)
  } finally { m.destroy() }
})

test('the header, welcome, settings and dashboard have no updater mounts or requests', () => {
  for (const file of ['components/AppHeader.vue', 'components/AppFilesSettings.vue', 'layouts/dashboard.vue', 'pages/welcome.vue', 'pages/usage.vue']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /AppUpdate|\/app-update\/|checkForUpdates|updateAvailable/)
  }
})
