/**
 * ChapterTitleFontEditor — the chapter font field, from the DOM side.
 *
 * What is pinned here:
 *
 *   1. No selection shows and emits nothing: today's look stays today's look.
 *   2. The channel font-pool option appears ONLY when a pool is offered, and
 *      choosing it resolves ONCE via the shared `decideFont` into
 *      `resolved_font_id` — the stored id the render reads (stability across
 *      preview/retry is a property of that stored value).
 *   3. Appearance controls are disabled until a face is in force, and an
 *      explicit pick is what the FontPicker emits (the ONE shared chooser —
 *      this component draws no list of its own).
 *   4. The preview samples the real chapter heading text.
 *
 * Runs under happy-dom (registered by __tests__/setup.ts).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createApp, h, nextTick, reactive, toRaw, defineComponent, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { fontSampleAvailable } from '../utils/font-sample'

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

async function loadSfc(relative: string): Promise<Component> {
  const filename = fileURLToPath(new URL(relative, import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const id = relative.replace(/\W+/g, '-')
  const script = compileScript(descriptor, { id })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id, compilerOptions: { bindingMetadata: script.bindings } })
  const code = `${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  const rewritten = transformed.code
    .replaceAll('"vue"', JSON.stringify(import.meta.resolve('vue')))
    .replace(/"(\.\.\/(?:utils|composables)\/[\w-]+)"/g, (_m, spec: string) => JSON.stringify(new URL(`${spec}.ts`, import.meta.url).href))
    // `@shared/*` has no import map inside a data: module — point the pool rules
    // at the real file the server uses.
    .replace('"@shared/still-post-fonts"', JSON.stringify(pathToFileURL(fileURLToPath(new URL('../../electron/server/contracts/still-post-fonts.ts', import.meta.url))).href))
    .replace('"@shared/thumbnail-text"', JSON.stringify(pathToFileURL(fileURLToPath(new URL('../../electron/server/contracts/thumbnail-text.ts', import.meta.url))).href))
  return (await import(`data:text/javascript;base64,${Buffer.from(rewritten).toString('base64')}`)).default
}

/** The shared FontPicker stands in: one button that picks the first option. */
const FontPickerStub = defineComponent({
  props: { modelValue: String, options: Array, title: String, description: String, sample: String },
  emits: ['select'],
  setup(props, { emit }) {
    return () => h('div', { class: 'font-picker-stub' },
      h('button', {
        type: 'button',
        'data-testid': 'font-choice',
        onClick: () => emit('select', (props.options as any[])?.[0]?.value ?? 'inter'),
      }, `pick:${(props.options as any[])?.[0]?.label ?? 'none'}`))
  },
})

const settle = async () => { for (let i = 0; i < 4; i += 1) { await nextTick(); await new Promise(r => setTimeout(r, 0)) } }

const FONTS = [
  { id: 'inter', label: 'Inter', scripts: ['latn', 'cyrl'], weights: [400, 700], role: 'text', license: 'OFL', source: 'bundled' },
  { id: 'kantumruy-pro', label: 'Kantumruy Pro', scripts: ['khmr', 'latn'], weights: [400, 700], role: 'text', license: 'OFL', source: 'bundled' },
]

const POOL = { usage_mode: 'serial' as const, allow_repeat: false, fonts: [{ font_id: 'kantumruy-pro', weight: 1 }] }

async function mountEditor(props: Record<string, unknown>) {
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const emitted: any[] = []
  // A wrapper owns the live state, so an emit feeds back exactly as the host
  // page's v-model does (root props from createApp are not reactive).
  const Editor = await loadSfc('../components/ChapterTitleFontEditor.vue')
  const live = reactive({ fonts: FONTS, ...props }) as Record<string, any>
  const Wrapper = defineComponent({
    setup() {
      return () => h(Editor, {
        ...toRaw(live),
        modelValue: live.modelValue,
        fonts: live.fonts,
        pool: live.pool,
        poolCursor: live.poolCursor,
        sampleText: live.sampleText,
        'onUpdate:modelValue': (value: any) => { emitted.push(value); live.modelValue = value },
      })
    },
  })
  const app = createApp(Wrapper)
  app.component('FontPicker', FontPickerStub)
  app.mount(host)
  await settle()
  return { host, emitted, live, unmount: () => app.unmount() }
}

const click = async (el: Element | null) => {
  assert.ok(el, 'element to click')
  ;(el as HTMLElement).click()
  await settle()
}

describe('ChapterTitleFontEditor', () => {
  test('no selection: today’s look is what shows and what emits', async () => {
    const { host, emitted, unmount } = await mountEditor({})
    assert.match(host.textContent || '', /No font — today's look/)
    assert.match(host.textContent || '', /Chapter One — The Quiet Harbor/, 'the preview samples a real chapter heading')
    assert.equal(emitted.length, 0, 'merely opening the field writes nothing')
    await click(host.querySelector('button.ctfe-choice'))
    assert.equal(emitted.length, 1)
    assert.deepEqual(emitted[0], { channel_look: false },
      'today’s look is stored as a deliberate marker, so the automatic pool binding cannot quietly put a face back')
    unmount()
  })

  test('with a pool and no choice yet, the field binds the channel font pool and says so out loud', async () => {
    const { host, emitted, unmount } = await mountEditor({ pool: POOL, poolCursor: null })
    const bound = emitted.at(-1)
    assert.equal(bound?.channel_look, true, 'an unchosen episode is bound to the channel pool')
    assert.equal(bound?.resolved_font_id, 'kantumruy-pro', 'the serial pool resolves its first face once')
    assert.equal(bound?.font_id, undefined, 'no explicit face was picked')
    assert.match(host.textContent || '', /bound automatically/, 'the customer is told the binding is automatic')
    assert.match(host.textContent || '', /Kantumruy Pro/, 'and which face it bound')

    // The deliberate "today's look" survives the binding.
    const defaultButton = [...host.querySelectorAll('button.ctfe-choice')].find(button => button.textContent?.includes("No font"))!
    await click(defaultButton)
    assert.deepEqual(emitted.at(-1), { channel_look: false })
    unmount()
  })

  test('the channel font-pool option exists only when a pool is offered, and resolves once into resolved_font_id', async () => {
    const bare = await mountEditor({})
    assert.equal(bare.host.querySelector('button.ctfe-choice:nth-of-type(2)')?.textContent?.includes('Channel font pool'), false,
      'no pool, no pool option')
    bare.unmount()

    const { host, emitted, unmount } = await mountEditor({ pool: POOL, poolCursor: null })
    const poolButton = [...host.querySelectorAll('button.ctfe-choice')].find(button => button.textContent?.includes('Channel font pool'))
    assert.ok(poolButton, 'with a pool the option is offered')
    await click(poolButton!)
    const last = emitted.at(-1)
    assert.equal(last.channel_look, true)
    assert.equal(last.resolved_font_id, 'kantumruy-pro', 'the serial pool resolves its first face')
    assert.equal(last.font_id, undefined, 'the pool choice names no explicit face')
    unmount()
  })

  test('appearance is disabled until a face is in force; the shared FontPicker is the chooser', async () => {
    const { host, emitted, unmount } = await mountEditor({})
    const fieldset = host.querySelector('fieldset.ctfe-appearance') as HTMLFieldSetElement
    assert.ok(fieldset.disabled, 'no face, no appearance changes')

    const chooseButton = [...host.querySelectorAll('button.ctfe-choice')].find(button => button.textContent?.includes('Choose a font'))!
    await click(chooseButton)
    const picker = host.querySelector('[data-testid="font-choice"]')
    assert.ok(picker, 'choosing a font opens the shared FontPicker — no second list here')
    await click(picker)
    const picked = emitted.at(-1)
    assert.equal(picked.font_id, 'inter', 'the first covered option is what the picker emits')
    await settle()
    const enabled = host.querySelector('fieldset.ctfe-appearance') as HTMLFieldSetElement
    assert.equal(enabled.disabled, false, 'with a face the appearance controls open')

    const color = host.querySelector('input.ctfe-color') as HTMLInputElement
    color.value = '#ff0000'
    color.dispatchEvent(new Event('input'))
    await settle()
    assert.equal(emitted.at(-1)?.appearance?.color, '#ff0000')
    unmount()
  })

  test('the preview carries the chosen face when the browser has it, and never claims one it does not', async () => {
    const { host, unmount } = await mountEditor({ modelValue: { font_id: 'kantumruy-pro', appearance: { color: '#ff0000' } } })
    const sample = host.querySelector('.ctfe-sample') as HTMLElement
    assert.match(host.textContent || '', /Approximate preview/, 'the preview says out loud that it is an approximation')
    if (fontSampleAvailable('Kantumruy Pro') === true) {
      assert.match(sample.style.fontFamily, /Kantumruy Pro/, 'the preview draws in the chosen family when the browser resolves it')
    } else {
      assert.equal(sample.style.fontFamily, '', 'a face this browser cannot resolve must not be claimed')
    }
    assert.match(sample.style.color, /#ff0000|rgb\(255,\s*0,\s*0\)/, 'the preview shows the picked colour')
    unmount()

    // A face no browser has is never drawn as if it were the chosen one.
    const ghost = { id: 'ghost-face', label: 'Zzz No Such Chapter Face', scripts: ['latn'], weights: [400], role: 'text', license: 'OFL', source: 'bundled' }
    const bare = await mountEditor({ modelValue: { font_id: 'ghost-face' }, fonts: [...FONTS, ghost] })
    assert.equal((bare.host.querySelector('.ctfe-sample') as HTMLElement).style.fontFamily, '')
    bare.unmount()
  })

  test('the saved face stays in the picker options even when the sample does not cover it', async () => {
    // This Khmer-only sample excludes Inter from the coverage list; the saved
    // Inter must still be the option the picker trigger shows, not a raw id.
    const { host, unmount } = await mountEditor({ modelValue: { font_id: 'inter' }, sampleText: 'សួស្តី' })
    const trigger = host.querySelector('[data-testid="font-choice"]')
    assert.ok(trigger, 'the shared picker is open on the saved face')
    assert.equal(trigger!.textContent, 'pick:Inter')
    unmount()
  })
})
