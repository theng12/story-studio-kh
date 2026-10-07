/**
 * Channel Characters: a failed image upload after a successful create must
 * not make the next Save create a duplicate; the role can be cleared; and the
 * portrait / delete controls for reference images work.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, nextTick, type Component } from 'vue'

const filename = fileURLToPath(new URL('../pages/character-library.vue', import.meta.url))
const source = readFileSync(filename, 'utf8')

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(source, { filename })
  const script = compileScript(descriptor, { id: 'character-library-save-runtime' })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, h, ref, reactive, watch, onMounted } from ${JSON.stringify(vueUrl)}
    const F = new Proxy({}, { get: (_, k) => globalThis.__clFixture[k] })
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useRoute = () => ({ query: {} })
    const useRouter = () => ({ replace: async () => undefined })
    const useCharacterLibrary = () => F.cl
    const useApi = () => ({ get: async () => [], post: async () => ({}), del: F.del })
    const useConfirm = () => ({ ask: async () => true })
    const useToast = () => ({ success: () => undefined, error: (m) => F.errors.push(m) })
  `
  const content = script.content
    .replace(/^import[\s\S]*?from [^\n]+\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const output = await transform(`${support}\n${content}\nconst setup = __sfc__.setup
    __sfc__.setup = (props, ctx) => {
      const state = setup(props, ctx)
      globalThis.__clFixture.state = state
      return () => h('main')
    }
    export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    output.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

async function flush() { for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick() } }

async function mount() {
  const calls: string[] = []
  const f: any = {
    errors: [],
    calls,
    cl: {
      list: async () => [],
      create: async (p: any) => { calls.push('create'); return { id: 'new-1', ...p, references: { images: [] } } },
      update: async (id: string, p: any) => { calls.push(`update:${id}:${JSON.stringify(p.archetype ?? p.references?.images)}`); return { id, name: 'X', description: 'd', ...p } },
      uploadReferenceImage: async () => { calls.push('upload'); throw new Error('Image is larger than 5 MB') },
      getOne: async (id: string) => ({ id, name: 'X', description: 'd' }),
    },
    del: async (path: string) => { calls.push(`del:${path}`); return { id: 'c1', name: 'X', description: 'd', references: { images: ['b.png'] } } },
  }
  ;(globalThis as any).__clFixture = f
  const app = createApp(await loadPage())
  const host = document.body.appendChild(document.createElement('div'))
  app.mount(host)
  await flush()
  return { f, state: f.state, calls, unmount: () => { app.unmount(); host.remove() } }
}

test('create succeeds, upload fails → the next Save updates the same record', async () => {
  const { f, state, calls, unmount } = await mount()
  try {
    state.openCreate()
    state.draft.name = 'Ana'
    state.draft.description = 'A guide'
    state.pendingReference.value = new File(['x'], 'big.png')
    await state.saveCharacter()
    assert.deepEqual(calls, ['create', 'upload'])
    assert.match(f.errors[0], /was saved, but the image could not be added: Image is larger than 5 MB/)
    assert.equal(state.editing.value?.id, 'new-1', 'the editor now points at the created record')
    assert.equal(state.editorOpen.value, true)

    state.pendingReference.value = null
    await state.saveCharacter()
    assert.equal(calls.filter(c => c === 'create').length, 1, 'no duplicate character')
    assert.ok(calls.some(c => c.startsWith('update:new-1')))
  } finally { unmount() }
})

test("clearing the role sends '' so the server clears it", async () => {
  const { state, calls, unmount } = await mount()
  try {
    state.openEdit({ id: 'c1', name: 'X', description: 'd', archetype: 'mentor' })
    state.draft.archetype = ''
    await state.saveCharacter()
    assert.ok(calls.includes('update:c1:""'), calls.join(' | '))
  } finally { unmount() }
})

test('reference images can be made the portrait or deleted', async () => {
  const { state, calls, unmount } = await mount()
  try {
    state.openEdit({ id: 'c1', name: 'X', description: 'd', references: { images: ['a.png', 'b.png'] } })
    await state.makePortrait('b.png')
    assert.ok(calls.includes('update:c1:["b.png","a.png"]'), calls.join(' | '))
    await state.removeReference('a.png')
    assert.ok(calls.includes('del:/character-library/c1/reference-image/a.png'))
    assert.deepEqual(state.editing.value.references.images, ['b.png'])
  } finally { unmount() }
})

test('the editor does not close on a stray backdrop click, and shows the size limit', () => {
  assert.match(source, /<Modal[^>]*:visible="editorOpen"[^>]*:close-on-backdrop="false"/)
  assert.match(source, /Max 5 MB/)
})

test('Escape closes the editor only while nothing has changed', async () => {
  const { state, unmount } = await mount()
  try {
    state.openEdit({ id: 'c1', name: 'X', description: 'd', projects: ['kh'] })
    await flush()
    assert.equal(state.editorDirty.value, false, 'opening (and rendering empty voice profiles) is not a change')
    state.profileFor('kh')
    assert.equal(state.editorDirty.value, false)
    state.draft.name = 'Y'
    assert.equal(state.editorDirty.value, true)
    state.closeEditor()
    state.openCreate()
    assert.equal(state.editorDirty.value, false)
  } finally { unmount() }
})
