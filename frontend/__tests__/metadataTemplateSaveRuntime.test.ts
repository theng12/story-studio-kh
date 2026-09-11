import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, defineComponent, h, nextTick, reactive, type Component } from 'vue'

const filename = fileURLToPath(new URL('../pages/projects/[slug]/metadata-template.vue', import.meta.url))

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function loadPage(): Promise<Component> {
  const source = readFileSync(filename, 'utf8')
  const { descriptor } = parse(source, { filename })
  const script = compileScript(descriptor, { id: 'metadata-template-save-runtime' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename,
    id: 'metadata-template-save-runtime',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, h, reactive, ref, watch } from ${JSON.stringify(vueUrl)}
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useRoute = () => globalThis.__metadataTemplateFixture.route
    const useApi = () => ({ get: globalThis.__metadataTemplateFixture.get, put: globalThis.__metadataTemplateFixture.put })
    const useToast = () => ({ success: () => undefined, error: () => undefined })
    const WorkspaceHero = _defineComponent({ setup(_, { slots }) { return () => h('section', slots.default?.()) } })
    const WorkspaceNotice = _defineComponent({ setup(_, { slots }) { return () => h('section', slots.default?.()) } })
    const LoadingSpinner = _defineComponent({ setup: () => () => h('span') })
    const NuxtLink = _defineComponent({ setup(_, { slots }) { return () => h('a', slots.default?.()) } })
  `
  const content = script.content
    .replace(/^import[^\n]+\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const built = await transform(`${support}\n${content}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`, {
    loader: 'ts', format: 'esm',
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    built.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index++) {
    await Promise.resolve()
    await nextTick()
  }
}

async function mount(put: (path: string, body: unknown) => Promise<unknown>) {
  const route = reactive({ params: reactive({ slug: 'project-a' }) })
  const fixture: any = {
    route,
    put,
    get: async (path: string) => {
      if (path.endsWith('/metadata/formulas')) return { channel_default_id: '', formulas: [] }
      return path.includes('project-b')
        ? { metadata_template: { title: 'Project B', description: 'B copy', tags: ['b'] } }
        : { metadata_template: { title: 'Project A', description: 'A copy', tags: ['a'] } }
    },
  }
  ;(globalThis as any).__metadataTemplateFixture = fixture
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(defineComponent({ setup: () => () => h(awaitedPage as any) }))
  const slot = defineComponent({ setup(_, { slots }) { return () => h('section', slots.default?.()) } })
  app.component('WorkspaceHero', slot)
  app.component('WorkspaceNotice', slot)
  app.component('LoadingSpinner', defineComponent({ setup: () => () => h('span') }))
  app.component('NuxtLink', defineComponent({ setup(_, { slots }) { return () => h('a', slots.default?.()) } }))
  app.mount(host)
  await flush()
  return { fixture, host, app, dispose() { app.unmount(); host.remove(); delete (globalThis as any).__metadataTemplateFixture } }
}

let awaitedPage: Component

test('metadata save freezes the rendered fields and ignores a stale project response', async () => {
  awaitedPage = await loadPage()
  const save = deferred<unknown>()
  const calls: Array<{ path: string; body: any }> = []
  const mounted = await mount(async (path, body) => {
    calls.push({ path, body })
    return save.promise
  })
  try {
    const title = mounted.host.querySelector('input') as HTMLInputElement
    const saveButton = Array.from(mounted.host.querySelectorAll('button')).find(button => button.textContent?.includes('Save publishing profile')) as HTMLButtonElement
    title.value = 'Saved A title'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    saveButton.click()
    await flush()
    assert.equal(title.disabled, true)
    assert.equal((mounted.host.querySelector('select') as HTMLSelectElement).disabled, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].body.metadata_template.title, 'Saved A title')

    mounted.fixture.route.params.slug = 'project-b'
    await flush()
    assert.equal((mounted.host.querySelector('input') as HTMLInputElement).value, 'Project B')
    save.resolve({ ok: true })
    await flush()
    assert.equal((mounted.host.querySelector('input') as HTMLInputElement).value, 'Project B')
    assert.doesNotMatch(mounted.host.textContent || '', /Saved\. The next YouTube package/)
  } finally {
    mounted.dispose()
  }
})
