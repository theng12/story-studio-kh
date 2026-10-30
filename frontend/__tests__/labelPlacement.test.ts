import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp, nextTick, reactive } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

test('drag and keyboard move the label and its target on the scene', async () => {
  const filename = fileURLToPath(new URL('../components/LabelPlacement.vue', import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'placement' })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'placement', compilerOptions: { bindingMetadata: script.bindings } })
  const code = `const useApi = () => globalThis.__placementApi\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const output = await transform(code, { loader: 'ts', format: 'esm' })
  const vueUrl = await import.meta.resolve('vue')
  const contract = new URL('../../electron/server/contracts/contextual-cue-position.ts', import.meta.url)
  const contractOutput = await transform(readFileSync(contract, 'utf8'), { loader: 'ts', format: 'esm' })
  const contractUrl = `data:text/javascript;base64,${Buffer.from(contractOutput.code).toString('base64')}`
  const Component = (await import(`data:text/javascript;base64,${Buffer.from(output.code.replaceAll('"vue"', JSON.stringify(vueUrl)).replaceAll('"@shared/contextual-cue-position"', JSON.stringify(contractUrl))).toString('base64')}`)).default
  ;(globalThis as any).__placementApi = { post: async () => ({ image: 'data:image/png;base64,AA==', width: 300, height: 100, anchor: { x: .5, y: .5 }, pointing: true }) }
  const cue = reactive({ placement: 'top-left', template: 'label:test', title: 'Temple', position_x_pct: 30, position_y_pct: 30, target_x_pct: 50, target_y_pct: 50 })
  const host = document.body.appendChild(document.createElement('div'))
  let changes = 0
  const app = createApp(Component, { cue, imageUrl: '/scene.png', projectSlug: 'test', onChange: () => changes++ })
  try {
    app.mount(host)
    await new Promise(resolve => setTimeout(resolve, 0)); await nextTick()
    const frame = host.querySelector<HTMLElement>('.frame')!
    frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200 } as DOMRect)
    const label = host.querySelector<HTMLElement>('.label')!
    label.setPointerCapture = () => {}
    const pointer = (type: string, x: number, y: number) => { const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }); Object.defineProperty(event, 'pointerId', { value: 1 }); return event }
    label.dispatchEvent(pointer('pointerdown', 120, 60))
    label.dispatchEvent(pointer('pointermove', 200, 100))
    label.dispatchEvent(pointer('pointerup', 200, 100))
    assert.equal(cue.position_x_pct, 50); assert.equal(cue.position_y_pct, 50)
    const target = host.querySelector<HTMLElement>('.target')!
    target.setPointerCapture = () => {}
    target.dispatchEvent(pointer('pointerdown', 200, 100))
    target.dispatchEvent(pointer('pointermove', 280, 140))
    target.dispatchEvent(pointer('pointerup', 280, 140))
    assert.equal(cue.target_x_pct, 70); assert.equal(cue.target_y_pct, 70)
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    assert.equal(cue.target_x_pct, 69)
    assert.equal(changes, 3)
    assert.equal(host.querySelector('input'), null)
  } finally { app.unmount(); host.remove(); delete (globalThis as any).__placementApi }
})
