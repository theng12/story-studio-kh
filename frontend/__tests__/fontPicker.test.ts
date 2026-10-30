/**
 * The font fields became a visual choice.
 *
 * Owner, 2026-10-30: "everything that can be a visual option, must be a
 * visual option." Thumbnail Text, Thumbnail Template and Subtitle Style each
 * offered a font as a word in a native `<select>` — the same shape the cast
 * picker and the art-style picker already lost (see visualPickerFixes). All
 * three now open the one shared popup and draw every face in its own type.
 *
 * What is pinned here:
 *
 *   1. The popup renders each option's family, not its name in the UI font.
 *   2. A face this browser cannot draw says "No sample yet" — both when the
 *      option carries no family and when measurement proves the family is not
 *      there (AGENTS §6: a miss and a "could not tell" must not look alike,
 *      and neither may pass for a sample).
 *   3. Choosing emits the value and closes; nothing is written by the picker.
 *   4. All three screens pass a family per option and none keeps a font
 *      `<select>`.
 *
 * Runs under happy-dom (registered by __tests__/setup.ts). Canvas metrics are
 * stood in for: happy-dom has no 2D context, and a test that silently got
 * `null` could not tell a measured miss from a missing canvas.
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp, h, nextTick, defineComponent, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

/** Families this stand-in "has"; anything else measures exactly like the fallback. */
const INSTALLED = new Set(['Impact', 'Bebas Neue'])

let fontSampleAvailable!: (family: string | null | undefined) => boolean | null

before(() => {
  ;(HTMLCanvasElement.prototype as any).getContext = function () {
    return {
      font: '',
      measureText(text: string) {
        const families = this.font.replace(/^\S+\s+[\d.]+px\s+/, '').split(',').map((f: string) => f.trim().replace(/['"]/g, ''))
        const installed = families.find((f: string) => INSTALLED.has(f))
        return { width: installed ? 1000 + text.length : text.length * 2 }
      },
    }
  }
})

/** Compile the production SFC in-process (no component-test dependency). */
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
  return (await import(`data:text/javascript;base64,${Buffer.from(rewritten).toString('base64')}`)).default
}

/** PickerDialog as the popup shell: the list exists only while it is open. */
const PickerDialogStub = defineComponent({
  props: { visible: Boolean, title: String },
  setup(props, { slots }) {
    return () => props.visible ? h('div', { class: 'picker-dialog-stub' }, slots.default?.()) : null
  },
})

const settle = async () => { for (let i = 0; i < 4; i += 1) { await nextTick(); await new Promise(r => setTimeout(r, 0)) } }

const OPTIONS = [
  { value: 'impact', label: 'Impact (tall, bold)', family: 'Impact' },
  { value: 'ghost', label: 'Ghost', family: 'No Such Face' },
  { value: 'custom', label: 'Custom…' },
]

async function mountPicker(props: Record<string, unknown>) {
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(await loadSfc('../components/FontPicker.vue'), props)
  app.component('PickerDialog', PickerDialogStub)
  app.mount(host)
  await settle()
  return { host, unmount: () => app.unmount() }
}

describe('fontSampleAvailable says which of three things it knows', () => {
  before(async () => { ({ fontSampleAvailable } = await import('../utils/font-sample.ts')) })

  test('a family the canvas resolves is a sample', () => {
    assert.equal(fontSampleAvailable('Impact, sans-serif'), true)
  })

  test('a family that measures like the fallback is a measured miss, not a sample', () => {
    assert.equal(fontSampleAvailable('No Such Face'), false)
  })

  test('only generics, or nothing at all, is a miss — there is no face to draw', () => {
    assert.equal(fontSampleAvailable('sans-serif'), false)
    assert.equal(fontSampleAvailable(''), false)
    assert.equal(fontSampleAvailable(null), false)
  })

  test('a stack samples when any named face in it is installed', () => {
    assert.equal(fontSampleAvailable("Impact, 'Arial Black', sans-serif"), true)
  })
})

describe('the shared popup draws every font in its own type', () => {
  test('an installed face is drawn as itself, not as the UI font', async () => {
    const { host, unmount } = await mountPicker({ options: OPTIONS, modelValue: 'impact', title: 'Choose a font' })
    try {
      host.querySelector<HTMLButtonElement>('.fp-trigger')!.click()
      await settle()
      const faces = [...host.querySelectorAll<HTMLElement>('.fp-face')]
      assert.equal(faces.length, 3, 'one drawn face per option')
      assert.equal(faces[0]!.style.fontFamily, 'Impact')
      assert.match(faces[0]!.textContent || '', /The quick brown fox/)
      assert.match(host.textContent || '', /Impact \(tall, bold\)/, 'the name stays, under the face')
    } finally { unmount() }
  })

  test('a face that is not installed says "No sample yet" instead of showing a fallback', async () => {
    const { host, unmount } = await mountPicker({ options: OPTIONS, title: 'Choose a font' })
    try {
      host.querySelector<HTMLButtonElement>('.fp-trigger')!.click()
      await settle()
      const faces = [...host.querySelectorAll<HTMLElement>('.fp-face')]
      assert.equal(faces[1]!.textContent?.trim(), 'No sample yet')
      assert.equal(faces[1]!.style.fontFamily, '', 'a measured miss must not claim a family')
      assert.equal(faces[2]!.textContent?.trim(), 'No sample yet', 'an option with no family has no sample either')
    } finally { unmount() }
  })

  test('the trigger shows the chosen face, and the list is closed until it is asked for', async () => {
    const { host, unmount } = await mountPicker({ options: OPTIONS, modelValue: 'impact', title: 'Choose a font' })
    try {
      assert.equal(host.querySelector('.picker-dialog-stub'), null, 'a picker that is closed shows no list')
      assert.equal(host.querySelector<HTMLElement>('.fp-trigger-name')!.style.fontFamily, 'Impact')
      host.querySelector<HTMLButtonElement>('.fp-trigger')!.click()
      await settle()
      assert.ok(host.querySelector('.picker-dialog-stub'), 'the trigger opens the shared popup')
      assert.equal(host.querySelectorAll('[aria-selected="true"]').length, 1, 'exactly one row is the saved value')
    } finally { unmount() }
  })

  test('choosing emits the value and closes; the picker writes nothing itself', async () => {
    document.body.innerHTML = ''
    const host = document.body.appendChild(document.createElement('div'))
    const chosen: string[] = []
    const app = createApp(await loadSfc('../components/FontPicker.vue'), {
      options: OPTIONS,
      modelValue: 'impact',
      title: 'Choose a font',
      onSelect: (value: string) => chosen.push(value),
    })
    app.component('PickerDialog', PickerDialogStub)
    app.mount(host)
    await settle()
    try {
      host.querySelector<HTMLButtonElement>('.fp-trigger')!.click()
      await settle()
      ;[...host.querySelectorAll<HTMLButtonElement>('.fp-option')][2]!.click()
      await settle()
      assert.deepEqual(chosen, ['custom'], 'the picker reports the choice and leaves the write to the page')
      assert.equal(host.querySelector('.picker-dialog-stub'), null, 'the popup closes on a choice')
    } finally { app.unmount(); host.remove() }
  })
})

describe('all three font fields open that popup', () => {
  const screens = [
    { name: 'Thumbnail Text', file: '../components/ThumbnailTextEditor.vue', sample: /:sample="text"/, oldList: /v-for="font in availableFonts"/ },
    { name: 'Thumbnail Template', file: '../components/ThumbnailTemplateEditor.vue', sample: /:sample="zoneSample"/, oldList: /v-for="f in FONT_CHOICES"/ },
    { name: 'Subtitle Style', file: '../components/SubtitleStylePicker.vue', sample: /title="Choose a caption font"/, oldList: /value="__custom__"/ },
  ]

  for (const screen of screens) {
    test(`${screen.name} offers each font with a family to draw, and keeps no font <select>`, () => {
      const text = source(screen.file)
      assert.match(text, /<FontPicker/, `${screen.name} does not open the shared popup`)
      assert.match(text, /fontOptions/, `${screen.name} builds its options`)
      assert.match(text, /family:/, `${screen.name} passes a family per option`)
      assert.match(text, screen.sample, `${screen.name} draws its own specimen`)
      assert.doesNotMatch(text, screen.oldList, `${screen.name} still lists fonts as text`)
    })
  }

  test('the popup component is the one that owns the face and the honest empty state', () => {
    const picker = source('../components/FontPicker.vue')
    assert.match(picker, /No sample yet/)
    assert.match(picker, /fontSampleAvailable/)
    assert.match(picker, /<PickerDialog/)
  })
})
