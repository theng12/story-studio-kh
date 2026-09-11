import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, h, nextTick, reactive, type Component } from 'vue'

const filename = fileURLToPath(new URL('../pages/projects/[slug]/thumbnail-templates.vue', import.meta.url))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'thumbnail-template-mutation-runtime' })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, h, ref, watch } from ${JSON.stringify(vueUrl)}
    const definePageMeta = () => undefined
    const useRoute = () => globalThis.__thumbnailTemplateFixture.route
    const useApi = () => ({ get: globalThis.__thumbnailTemplateFixture.get, put: globalThis.__thumbnailTemplateFixture.put })
    const useToast = () => ({ success: () => undefined, error: () => undefined })
  `
  const content = script.content
    .replace(/^import[^\n]+\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const output = await transform(`${support}\n${content}\nconst setup = __sfc__.setup
    __sfc__.setup = (props, ctx) => {
      const state = setup(props, ctx)
      globalThis.__thumbnailTemplateFixture.state = state
      return () => h('main')
    }
    export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    output.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index++) {
    await Promise.resolve()
    await nextTick()
  }
}

test('a deferred thumbnail choice cannot overwrite a newly selected project', async () => {
  const save = deferred<unknown>()
  const route = reactive({ params: reactive({ slug: 'project-a' }) })
  const puts: Array<{ path: string; body: any }> = []
  const fixture: any = {
    route,
    put: async (path: string, body: any) => {
      puts.push({ path, body })
      return save.promise
    },
    get: async (path: string) => {
      const isB = path.includes('project-b')
      if (path.endsWith('/effective-niche')) return { niche: null }
      if (path.endsWith('/effective-thumbnail-template')) return { template: { id: isB ? 'template-b' : 'template-a', name: isB ? 'B' : 'A' } }
      if (path.endsWith('/settings/config')) return { thumbnail_template_id: isB ? 'template-b' : 'template-a' }
      return { name: isB ? 'Project B' : 'Project A' }
    },
  }
  ;(globalThis as any).__thumbnailTemplateFixture = fixture
  const app = createApp(await loadPage())
  const host = document.body.appendChild(document.createElement('div'))
  app.mount(host)
  await flush()
  try {
    const first = fixture.state.onTemplateChange({ id: 'new-a', name: 'New A' })
    await fixture.state.onTemplateChange({ id: 'ignored-a', name: 'Ignored A' })
    assert.deepEqual(puts.map(call => call.body.thumbnail_template_id), ['new-a'])
    assert.equal(fixture.state.templateMutationBusy.value, true)

    route.params.slug = 'project-b'
    await flush()
    assert.equal(fixture.state.selectedId.value, 'template-b')
    assert.equal(fixture.state.templateMutationBusy.value, false)
    save.resolve({ ok: true })
    await first
    await flush()
    assert.equal(fixture.state.selectedId.value, 'template-b')
    assert.equal(fixture.state.templateMutationBusy.value, false)
  } finally {
    app.unmount()
    host.remove()
    delete (globalThis as any).__thumbnailTemplateFixture
  }
})
