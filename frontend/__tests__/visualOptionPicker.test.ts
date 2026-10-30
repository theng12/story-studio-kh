/**
 * The visual option picker's contract.
 *
 * Two things a source grep cannot show: that an option with a drawable shape
 * really draws one, and that an option we cannot draw honestly says so instead
 * of pretending (`fade-fast` and the inherit option are the standing cases).
 * Plus the value half — a card click must hand the page its own string back
 * and close, so a saved value can never be rewritten by the picker.
 *
 * Compiles the real SFCs in-process (same harness as pickerDialogFocus) rather
 * than re-implementing them, so what is asserted is what ships.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { describe } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, defineComponent, h, nextTick, type Component } from 'vue'

const loaded = new Map<string, Promise<Component>>()

async function load(relative: string, id: string): Promise<Component> {
  const cached = loaded.get(id)
  if (cached) return cached
  const promise = (async () => {
    const filename = fileURLToPath(new URL(relative, import.meta.url))
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
    const script = compileScript(descriptor, { id })
    const template = compileTemplate({
      source: descriptor.template!.content,
      filename,
      id,
      compilerOptions: { bindingMetadata: script.bindings },
    })
    assert.deepEqual(template.errors, [], `${relative} template must compile`)
    // `ref`/`computed` arrive through Nuxt auto-import in the app, so the
    // harness supplies the import the build would.
    const code = `import { computed, nextTick, ref } from 'vue'\n`
      + `${script.content.replace('export default', 'const __sfc__ =')}\n`
      + `${template.code}\n__sfc__.render = render\nexport default __sfc__`
    const { code: js } = await transform(code, { loader: 'ts', format: 'esm' })
    const vueUrl = await import.meta.resolve('vue')
    const url = `data:text/javascript;base64,${Buffer.from(
      js.replaceAll('"vue"', JSON.stringify(vueUrl)),
    ).toString('base64')}`
    return (await import(url)).default
  })()
  loaded.set(id, promise)
  return promise
}

async function renderSample(kind: string): Promise<HTMLElement> {
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(await load('../components/TransitionSample.vue', 'transition-sample'), { kind })
  app.mount(host)
  return host
}

describe('transition samples are drawn or honestly absent', () => {
  test('a wipe draws the boundary and the direction it travels', async () => {
    const host = await renderSample('wipe-left')
    const svg = host.querySelector('svg.ts-frame')
    assert.ok(svg, 'a drawable transition renders the frame')
    const points = svg!.querySelector('polygon')!.getAttribute('points')!
    assert.ok(points.split(' ').length >= 4, `the boundary needs a real polygon, got ${points}`)
    assert.ok(svg!.querySelector('line'), 'the arrow names the direction')
    assert.equal(host.textContent, '', 'no fallback wording next to a real drawing')
  })

  test('a crossfade shows B half over A', async () => {
    const host = await renderSample('crossfade')
    const blend = host.querySelector('rect[opacity="0.55"]')
    assert.ok(blend, 'the overlapping frame is drawn')
    assert.equal(blend!.getAttribute('x'), '55')
  })

  test('speed-only and inherited options say they have no sample', async () => {
    for (const kind of ['fade-fast', '']) {
      const host = await renderSample(kind)
      assert.equal(host.textContent, 'No sample yet', `${kind || '(inherit)'} must not fake a drawing`)
      assert.equal(host.querySelector('svg'), null)
    }
  })
})

const PickerDialogStub = defineComponent({
  props: { visible: Boolean, count: String },
  setup(props, { slots }) {
    return () => (props.visible ? h('div', { class: 'picker-stub' }, [h('span', props.count), slots.default?.()]) : null)
  },
})

const OPTIONS = [
  { value: '', label: 'Use main transition' },
  { value: 'crossfade', label: 'Crossfade' },
  { value: 'none', label: 'None' },
]

describe('the picker hands the page its own value back', () => {
  test('the trigger reads the current label; picking emits that option value', async () => {
    document.body.innerHTML = ''
    const host = document.body.appendChild(document.createElement('div'))
    let picked: string | undefined
    const app = createApp(await load('../components/VisualOptionPicker.vue', 'visual-option-picker'), {
      options: OPTIONS,
      modelValue: '',
      title: 'Transition type',
      'onUpdate:modelValue': (value: string) => { picked = value },
    })
    app.component('PickerDialog', PickerDialogStub)
    app.mount(host)

    const trigger = host.querySelector<HTMLButtonElement>('.vop-trigger')!
    assert.equal(trigger.querySelector('.vop-trigger-label')!.textContent, 'Use main transition')
    assert.equal(host.querySelector('.vop-card'), null, 'closed until asked')

    trigger.click()
    await nextTick()
    const cards = [...host.querySelectorAll<HTMLButtonElement>('.vop-card')]
    assert.equal(cards.length, OPTIONS.length, 'every option gets a card')
    assert.equal(cards[0]!.getAttribute('aria-pressed'), 'true', 'the saved value is marked')

    cards[2]!.click()
    await nextTick()
    assert.equal(picked, 'none', 'the value the page stored is the value it gets back')
    assert.equal(host.querySelector('.vop-card'), null, 'the dialog closes on a choice')
    app.unmount()
  })
})
