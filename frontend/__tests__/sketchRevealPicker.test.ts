import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { setRevealCatalog, revealFromDraft, applyRevealPreset } from '../utils/sketch-reveal.js'

const filename = fileURLToPath(new URL('../components/SketchRevealPicker.vue', import.meta.url))
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
const script = compileScript(descriptor, { id: 'reveal-picker' })
const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'reveal-picker', compilerOptions: { bindingMetadata: script.bindings } })
assert.deepEqual(template.errors, [])
const { code } = await transform(`${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`, { loader: 'ts', format: 'esm' })
const Picker = (await import(`data:text/javascript;base64,${Buffer.from(code.replaceAll('"vue"', JSON.stringify(await import.meta.resolve('vue')))).toString('base64')}`)).default
const Dialog = defineComponent({ props: { visible: Boolean }, setup: (props, { slots }) => () => props.visible ? h('div', slots.default?.()) : null })

test('picker displays native samples and saves selected reveal and weight', async () => {
  const host = document.body.appendChild(document.createElement('div'))
  let picked = '', weight = ''
  const app = createApp(Picker, { modelValue: 'line', reveals: [{ id: 'line', label: 'Line' }, { id: 'new-engine-style', label: 'New style' }], weight: 'normal', label: 'Reveal', title: 'Reveal', onPick: (v: string) => { picked = v }, onWeight: (v: string) => { weight = v } })
  app.component('PickerDialog', Dialog)
  app.mount(host)
  host.querySelector<HTMLButtonElement>('.trigger')!.click()
  await nextTick()
  assert.equal(host.querySelectorAll('video[autoplay][loop][muted]').length, 2)
  const select = host.querySelector<HTMLSelectElement>('select')!
  select.value = 'bold'; select.dispatchEvent(new Event('change'))
  await nextTick()
  assert.match(host.querySelectorAll('video')[1].getAttribute('src')!, /new-engine-style\/sample\?weight=bold/)
  host.querySelectorAll<HTMLButtonElement>('.card')[1].click()
  assert.equal(picked, 'new-engine-style')
  assert.equal(weight, 'bold')
  app.unmount(); host.remove()
})

test('Mix picker keeps its draft until at least two styles are selected', async () => {
  const host = document.body.appendChild(document.createElement('div'))
  let chosen: string[] = []
  const app = createApp(Picker, { modelValue: 'mix', multiple: true, mix: ['line', 'bloom'], reveals: [{ id: 'line', label: 'Line' }, { id: 'bloom', label: 'Bloom' }, { id: 'new', label: 'New' }], weight: 'normal', label: 'Mix', title: 'Mix', onMix: (value: string[]) => { chosen = value } })
  app.component('PickerDialog', Dialog)
  app.mount(host)
  host.querySelector<HTMLButtonElement>('.trigger')!.click()
  await nextTick()
  host.querySelectorAll<HTMLButtonElement>('.card')[1].click()
  await nextTick()
  assert.equal(host.querySelector<HTMLButtonElement>('.btn-primary')!.disabled, true)
  assert.deepEqual(chosen, [])
  host.querySelectorAll<HTMLButtonElement>('.card')[2].click()
  await nextTick()
  host.querySelector<HTMLButtonElement>('.btn-primary')!.click()
  assert.deepEqual(chosen, ['line', 'new'])
  app.unmount(); host.remove()
})

test('new server choices work in a mix and presets preserve scene pins', () => {
  setRevealCatalog([{ id: 'line', label: 'Line' }, { id: 'new-style', label: 'New style' }])
  assert.deepEqual(revealFromDraft('mix', ['line', 'new-style']), { ok: true, reveal: { style: 'mix', mix: ['line', 'new-style'] } })
  assert.deepEqual(applyRevealPreset({ style: 'new-style', mix: [] }, { style: 'line', mix: [], overrides: { one: 'line' } }), { style: 'new-style', mix: [], overrides: { one: 'line' } })
})
