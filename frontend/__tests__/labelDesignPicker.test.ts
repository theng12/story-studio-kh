import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

test('label gallery filters samples and selects the existing cue value', async () => {
  const filename = fileURLToPath(new URL('../components/LabelDesignPicker.vue', import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'label-picker' })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'label-picker', compilerOptions: { bindingMetadata: script.bindings } })
  const code = `const useApi = () => globalThis.__labelPickerApi\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const output = await transform(code, { loader: 'ts', format: 'esm' })
  const vueUrl = await import.meta.resolve('vue')
  const Component = (await import(`data:text/javascript;base64,${Buffer.from(output.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
  ;(globalThis as any).__labelPickerApi = { get: async () => ({ designs: [
    { id: 'map-pin', name: 'Location pin', family: 'Classic', theme: 'Classic', sample_url: null },
    { id: 'label:location-pin', name: 'Map pin', family: 'Location pointers', theme: 'exploration', sample_url: '/sample.png' },
  ] }) }
  const host = document.body.appendChild(document.createElement('div'))
  let selected = ''
  const app = createApp(Component, { modelValue: 'map-pin', projectSlug: 'test', 'onUpdate:modelValue': (value: string) => { selected = value } })
  app.component('PickerDialog', defineComponent({ props: { visible: Boolean }, setup: (props, { slots }) => () => props.visible ? h('div', slots.default?.()) : null }))
  try {
    app.mount(host)
    host.querySelector<HTMLButtonElement>('.label-picker-trigger')!.click()
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
    assert.equal(host.querySelectorAll('.label-picker-card').length, 2)
    assert.match(host.textContent!, /No sample yet/)
    assert.equal(host.querySelector('img')?.getAttribute('src'), '/sample.png')
    const family = host.querySelectorAll('select')[0]!
    family.value = 'Location pointers'; family.dispatchEvent(new Event('change'))
    await nextTick()
    assert.equal(host.querySelectorAll('.label-picker-card').length, 1)
    const search = host.querySelector<HTMLInputElement>('input[type=search]')!
    search.value = 'missing'; search.dispatchEvent(new Event('input'))
    await nextTick()
    assert.match(host.textContent!, /No designs match/)
    search.value = 'map'; search.dispatchEvent(new Event('input'))
    await nextTick()
    host.querySelector<HTMLButtonElement>('.label-picker-card')!.click()
    assert.equal(selected, 'label:location-pin')
  } finally { app.unmount(); host.remove(); delete (globalThis as any).__labelPickerApi }
})
