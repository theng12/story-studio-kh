/**
 * Settings → Default models (owner, 2026-10-27).
 *
 * One picker per generation family, fed by the same live catalogues the generator pages use. What
 * this pins:
 *
 *  - a picker exists for every family GenStudio publishes, and only those;
 *  - the choices come from the LIVE catalogue — a model the Gateway does not publish cannot be
 *    chosen, and an unusable row is disabled rather than hidden;
 *  - saving writes the whole setting to `/app-settings/default-models`, with an unset family as
 *    `null` (never `''` and never a model);
 *  - a saved default that has left the catalogue is said plainly, in the same words the server
 *    refuses with, and nothing is substituted.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const COMPONENT = fileURLToPath(new URL('../components/DefaultModelsSettings.vue', import.meta.url))

async function loadComponent(): Promise<Component> {
  const { descriptor } = parse(readFileSync(COMPONENT, 'utf8'), { filename: COMPONENT })
  const script = compileScript(descriptor, { id: 'default-models-settings' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: COMPONENT,
    id: 'default-models-settings',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const defaultsUrl = new URL('../composables/useDefaultModels.ts', import.meta.url).href
  const utilUrl = new URL('../utils/live-genstudio-model-selection.ts', import.meta.url).href
  // The catalogue composables are the page's real ones; stubbing them keeps this test about the
  // settings surface (which ids it offers, what it saves) rather than about catalogue parsing.
  // Each import is swapped for a global-backed stand-in, so the component body itself is untouched.
  const composableStub: Record<string, string> = {
    '../composables/useGenStudioChatModels.js': 'useGenStudioChatModels',
    '../composables/useGenStudioImageModels.js': 'useGenStudioImageModels',
    '../composables/useGenStudioMediaModels.js': 'useGenStudioMediaModels',
    '../composables/useGenStudioTranscription.js': 'useGenStudioTranscriptionModels',
  }
  let body = script.content
  for (const [specifier, fn] of Object.entries(composableStub)) {
    const importLine = new RegExp(`import \\{[^}]*\\} from '${specifier.replace(/[.]/g, '\\.')}'\\n?`)
    assert.match(body, importLine, `expected an import from ${specifier}`)
    body = body.replace(importLine, `const ${fn} = () => (globalThis as any).__dmStubs.${fn}()\n`)
  }
  const code = `${body.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    out.code
      .replaceAll('"vue"', JSON.stringify(vueUrl))
      .replaceAll('"../composables/useDefaultModels.js"', JSON.stringify(defaultsUrl))
      .replaceAll('"../utils/live-genstudio-model-selection.js"', JSON.stringify(utilUrl)),
  ).toString('base64')}`)).default
}

/** A reactive-looking catalogue stub: `{ models, loading, error }` is all the component reads. */
function catalogue(rows: Array<{ id: string; display_name: string; [k: string]: unknown }> = []) {
  const models = rows
  return {
    models: { value: models },
    loading: { value: false },
    error: { value: '' },
    refresh: async () => {},
    // The transcription composable is the one with a `load()` rather than `refresh()`.
    load: async () => {},
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)) }
}

async function mount(options: {
  saved?: Record<string, string | null>
  chat?: ReturnType<typeof catalogue>
  image?: ReturnType<typeof catalogue>
  voice?: ReturnType<typeof catalogue>
  video?: ReturnType<typeof catalogue>
  transcription?: ReturnType<typeof catalogue>
  music?: Array<Record<string, unknown>>
} = {}) {
  const saves: Array<{ path: string; body: any }> = []
  const gets: string[] = []
  const chat = options.chat ?? catalogue()
  const images = options.image ?? catalogue()
  const media = {
    ...catalogue(),
    voiceModels: (options.voice ?? catalogue()).models,
    videoModels: (options.video ?? catalogue()).models,
  }
  const transcription = options.transcription ?? catalogue()
  ;(globalThis as any).__dmStubs = {
    useGenStudioChatModels: () => chat,
    useGenStudioImageModels: () => images,
    useGenStudioMediaModels: () => media,
    useGenStudioTranscriptionModels: () => transcription,
  }
  ;(globalThis as any).useApi = () => ({
    get: async (path: string) => {
      gets.push(path)
      if (path === '/app-settings/default-models') return options.saved ?? {}
      if (path === '/app-settings/genstudio/music-models') return { models: options.music ?? [] }
      throw new Error(`unexpected GET ${path}`)
    },
    put: async (path: string, body: any) => { saves.push({ path, body }); return body },
  })

  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(await loadComponent())
  // The real ModelMenu is a 576-line dialog; a select with one option per published row renders the
  // SAME decision the component makes (`options` + `disabled`), which is what these tests are about.
  app.component('ModelMenu', defineComponent({
    props: ['modelValue', 'options', 'mediaType', 'title', 'placeholder', 'loading', 'catalogNotice'],
    emits: ['update:modelValue'],
    setup(props, { emit }) {
      return () => h('select', {
        class: `model-menu-${props.mediaType}`,
        value: props.modelValue,
        onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLSelectElement).value),
      }, (props.options as any[]).map(option => h('option', {
        value: option.id,
        disabled: option.disabled === true,
        'data-disabled': option.disabled === true ? 'true' : 'false',
      }, option.label)))
    },
  }))
  app.mount(host)
  await flush()
  return {
    host,
    saves,
    gets,
    picker: (family: string) => host.querySelector<HTMLSelectElement>(`select.model-menu-${family}`),
    rows: (family: string) => [...host.querySelectorAll<HTMLSelectElement>(`select.model-menu-${family}`)],
    unmount: () => app.unmount(),
  }
}

describe('Settings → Default models', () => {
  test('one picker per family GenStudio publishes, and only those', async () => {
    const mounted = await mount()
    try {
      const labels = [...mounted.host.querySelectorAll('.default-model-row label')].map(node => node.textContent?.trim())
      assert.deepEqual(labels, [
        'Writing', 'Images', 'Video', 'Voice (narration)', 'Subtitles & transcription', 'Music',
      ])
      assert.equal(mounted.host.querySelectorAll('.default-model-row').length, 6)
    } finally { mounted.unmount() }
  })

  test('the choices are the live catalogue\'s — an unpublished model is not offered', async () => {
    const mounted = await mount({
      chat: catalogue([{ id: 'chat-a', display_name: 'Chat A' }, { id: 'chat-b', display_name: 'Chat B' }]),
    })
    try {
      const ids = [...mounted.picker('llm')!.options].map(option => option.value).filter(Boolean)
      assert.deepEqual(ids, ['chat-a', 'chat-b'])
      assert.equal(ids.includes('some-model-nobody-publishes'), false)
    } finally { mounted.unmount() }
  })

  test('an unusable row is offered but disabled — never silently filtered away', async () => {
    const mounted = await mount({
      image: catalogue([
        { id: 'img-live', display_name: 'Live', available: true },
        { id: 'img-locked', display_name: 'Locked', available: true, locked: true },
        { id: 'img-off', display_name: 'Off', available: false },
      ]),
    })
    try {
      const options = [...mounted.picker('image')!.options]
      const byId = (id: string) => options.find(option => option.value === id)!
      assert.equal(byId('img-live').disabled, false)
      assert.equal(byId('img-locked').disabled, true)
      assert.equal(byId('img-off').disabled, true)
    } finally { mounted.unmount() }
  })

  test('choosing a model saves the whole setting, with every unset family as null', async () => {
    const mounted = await mount({
      chat: catalogue([{ id: 'chat-a', display_name: 'Chat A' }]),
      saved: {},
    })
    try {
      const picker = mounted.picker('llm')!
      picker.value = 'chat-a'
      picker.dispatchEvent(new Event('change', { bubbles: true }))
      await flush()

      assert.equal(mounted.saves.length, 1)
      assert.equal(mounted.saves[0]!.path, '/app-settings/default-models')
      assert.deepEqual(mounted.saves[0]!.body, {
        writing: 'chat-a', image: null, video: null, audio: null, transcription: null, music: null,
      })
      assert.match(mounted.host.textContent || '', /Default models saved/)
    } finally { mounted.unmount() }
  })

  test('the saved value is what each picker shows on load', async () => {
    const mounted = await mount({
      saved: { writing: 'chat-a', image: 'img-a', transcription: null },
      chat: catalogue([{ id: 'chat-a', display_name: 'Chat A' }]),
      image: catalogue([{ id: 'img-a', display_name: 'Img A' }]),
    })
    try {
      assert.equal(mounted.picker('llm')!.value, 'chat-a')
      assert.equal(mounted.picker('image')!.value, 'img-a')
      assert.equal(mounted.picker('tts')!.value, '', 'an unset family opens with no selection')
    } finally { mounted.unmount() }
  })

  test('a saved default that has left the catalogue is said plainly, and nothing is substituted', async () => {
    const mounted = await mount({
      saved: { writing: 'retired-chat' },
      chat: catalogue([{ id: 'chat-a', display_name: 'Chat A' }]),
    })
    try {
      const notice = mounted.host.querySelector('.default-model-gone')
      assert.ok(notice, 'the gone default must be reported')
      assert.match(notice!.textContent || '', /Your default writing model "retired-chat" is no longer available — choose another/)
      assert.match(notice!.textContent || '', /did not switch to a different model/)
      assert.equal(mounted.picker('llm')!.value, '', 'the field is left empty, not filled with another model')
    } finally { mounted.unmount() }
  })

  test('a default that is merely DISABLED is also reported, not left looking fine', async () => {
    const mounted = await mount({
      saved: { image: 'img-locked' },
      image: catalogue([{ id: 'img-locked', display_name: 'Locked', available: true, locked: true }]),
    })
    try {
      assert.match(mounted.host.querySelector('.default-model-gone')?.textContent || '',
        /Your default image model "img-locked" is no longer available/)
    } finally { mounted.unmount() }
  })

  test('an empty catalogue claims nothing — no "gone" notice from a list nobody has read', async () => {
    const mounted = await mount({ saved: { writing: 'retired-chat' }, chat: catalogue([]) })
    try {
      assert.equal(mounted.host.querySelector('.default-model-gone'), null)
    } finally { mounted.unmount() }
  })
})
