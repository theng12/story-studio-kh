/**
 * Job3 (1.4.384) — ChannelIntroAudioPicker: EXPLICIT selection only.
 *
 * The Developer approval condition lives in this component: with nothing
 * picked it emits nothing, so a host that sends no `channel_intro` renders
 * exactly as release/1.4.383. Browse returns the RAW picked path — no
 * episodes-root reaches FilePicker, so no adopt round-trip happens here —
 * and adoption belongs to the host's Apply call through the existing
 * `/system/resolve-asset-path` mode=adopt route. This component must never
 * adopt, save, or read a channel intro on its own.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp, defineComponent, h, nextTick, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

let pickerComponent: Promise<Component> | undefined
async function loadPicker(): Promise<Component> {
  if (pickerComponent) return pickerComponent
  pickerComponent = (async () => {
    const filename = fileURLToPath(new URL('../components/ChannelIntroAudioPicker.vue', import.meta.url))
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
    const script = compileScript(descriptor, { id: 'channel-intro-audio-picker-test' })
    const template = compileTemplate({
      source: descriptor.template!.content,
      filename,
      id: 'channel-intro-audio-picker-test',
      compilerOptions: { bindingMetadata: script.bindings },
    })
    const vueUrl = await import.meta.resolve('vue')
    const code = `${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
    const transformed = await transform(code, { loader: 'ts', format: 'esm' })
    return (await import(`data:text/javascript;base64,${Buffer.from(transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
  })()
  return pickerComponent
}

/** FilePicker stands in for the real one: Browse returns a raw path (or nothing on cancel); adoption is the host's Apply. */
const FilePickerStub = defineComponent({
  props: {
    modelValue: { type: String, default: '' },
    episodesRoot: { type: String, default: '' },
    placeholder: { type: String, default: '' },
    chooseLabel: { type: String, default: '' },
    filters: { type: Array, default: () => [] },
    clearable: { type: Boolean, default: false },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () => h('div', {
      class: 'file-picker-stub',
      'data-episodes-root': props.episodesRoot,
      'data-value': props.modelValue,
      'data-placeholder': props.placeholder,
      onClick: () => {
        const action = (globalThis as any).__channelIntroAction
        if (action === 'cancel') return // dialog closed with no file — no emit, nothing adopted
        emit('update:modelValue', action === 'clear' ? '' : (globalThis as any).__channelIntroPick ?? '')
      },
    })
  },
})

const SliderStub = defineComponent({
  props: {
    modelValue: { type: Number, default: 0 },
    min: { type: Number, default: 0 },
    max: { type: Number, default: 100 },
    step: { type: Number, default: 1 },
    suffix: { type: String, default: '' },
    decimals: { type: Number, default: 0 },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () => h('div', {
      class: 'slider-stub',
      'data-value': props.modelValue,
      onClick: () => emit('update:modelValue', (globalThis as any).__channelIntroSlider ?? props.modelValue),
    })
  },
})

async function mountPicker(initial: Record<string, unknown> = {}) {
  const Picker = await loadPicker()
  const emissions: any[] = []
  const host = document.body.appendChild(document.createElement('div'))
  const Wrapper = defineComponent({
    setup() {
      return () => h(Picker, {
        episodesRoot: '/library/chan/episodes',
        slug: 'chan',
        modelValue: null,
        'onUpdate:modelValue': (value: unknown) => emissions.push(value),
        ...initial,
      } as any)
    },
  })
  const app = createApp(Wrapper)
  app.component('FilePicker', FilePickerStub)
  app.component('SliderWithNumber', SliderStub)
  app.mount(host)
  const flush = async () => { await nextTick(); await nextTick() }
  const click = async (selector: string, index = 0) => {
    const nodes = [...host.querySelectorAll<HTMLElement>(selector)]
    assert.ok(nodes[index], `expected a ${selector} at index ${index}`)
    nodes[index]!.click()
    await flush()
  }
  return { host, emissions, click, flush, unmount: () => { app.unmount(); host.remove() } }
}

test('with nothing selected the picker emits nothing — output cannot change on its own', async () => {
  const mounted = await mountPicker()
  try {
    await mounted.flush()
    assert.equal(mounted.emissions.length, 0, 'mounting must not save or select anything')
    assert.equal(mounted.host.querySelector('.file-picker-stub')!.getAttribute('data-episodes-root'), '',
      'no episodes-root reaches FilePicker: Browse must return the raw picked path, never adopt it')
    assert.equal(mounted.host.querySelector('.file-picker-stub')!.getAttribute('data-value'), '')
    assert.equal(mounted.host.querySelector('.file-picker-stub')!.getAttribute('data-placeholder'), 'No channel intro chosen')
  } finally { mounted.unmount() }
})

test('cancelling Browse adopts nothing and emits nothing', async () => {
  const mounted = await mountPicker()
  try {
    ;(globalThis as any).__channelIntroAction = 'cancel'
    await mounted.click('.file-picker-stub')
    assert.equal(mounted.emissions.length, 0, 'a cancelled Browse must not emit a selection')
    assert.equal(mounted.host.querySelector('.file-picker-stub')!.getAttribute('data-value'), '',
      'cancel must leave the field unselected — no adoption, no auto-save')
  } finally {
    delete (globalThis as any).__channelIntroAction
    mounted.unmount()
  }
})

test('an explicit pick emits a channel_intro selection with linear volume and the default gap', async () => {
  const mounted = await mountPicker()
  try {
    ;(globalThis as any).__channelIntroAction = 'pick'
    ;(globalThis as any).__channelIntroPick = '${CHANNEL}/assets/brand-intro.mp3'
    await mounted.click('.file-picker-stub')
    assert.equal(mounted.emissions.length, 1, 'one pick, one emission')
    assert.deepEqual(mounted.emissions[0], {
      file: '${CHANNEL}/assets/brand-intro.mp3',
      volume: 1,
      gap_after: 0,
    }, 'a NEW channel selection starts with no gap (0)')
    assert.match(mounted.host.textContent || '', /Volume \(100%\)/)
  } finally {
    delete (globalThis as any).__channelIntroAction
    delete (globalThis as any).__channelIntroPick
    mounted.unmount()
  }
})

test('clearing emits null again — back to the no-selection (release/1.4.383) path', async () => {
  const mounted = await mountPicker()
  try {
    ;(globalThis as any).__channelIntroAction = 'pick'
    ;(globalThis as any).__channelIntroPick = '${CHANNEL}/assets/brand-intro.mp3'
    await mounted.click('.file-picker-stub')
    ;(globalThis as any).__channelIntroAction = 'clear'
    await mounted.click('.file-picker-stub')
    assert.equal(mounted.emissions.at(-1), null, 'clear must emit null, not an empty selection')
  } finally {
    delete (globalThis as any).__channelIntroAction
    delete (globalThis as any).__channelIntroPick
    mounted.unmount()
  }
})

test('the percent sliders convert to the request units exactly once', async () => {
  const mounted = await mountPicker()
  try {
    ;(globalThis as any).__channelIntroAction = 'pick'
    ;(globalThis as any).__channelIntroPick = '${CHANNEL}/assets/brand-intro.mp3'
    await mounted.click('.file-picker-stub')

    ;(globalThis as any).__channelIntroSlider = 50
    await mounted.click('.slider-stub', 0) // volume
    assert.equal(mounted.emissions.at(-1).volume, 0.5, '50% must arrive as linear 0.5')
    assert.equal(mounted.emissions.at(-1).gap_after, 0, 'the new-channel default gap stays 0 until moved')

    ;(globalThis as any).__channelIntroSlider = 4
    await mounted.click('.slider-stub', 1) // gap
    assert.equal(mounted.emissions.at(-1).gap_after, 4)
    assert.equal(mounted.emissions.at(-1).volume, 0.5, 'the other control must not be re-decided')
  } finally {
    delete (globalThis as any).__channelIntroAction
    delete (globalThis as any).__channelIntroPick
    delete (globalThis as any).__channelIntroSlider
    mounted.unmount()
  }
})

test('opening and browsing a raw path make no registration request', async () => {
  const originalFetch = globalThis.fetch
  const requests: unknown[] = []
  globalThis.fetch = (async (...args: unknown[]) => {
    requests.push(args)
    throw new Error('Opening or browsing must not call the server')
  }) as typeof fetch
  let mounted: Awaited<ReturnType<typeof mountPicker>> | undefined
  try {
    mounted = await mountPicker()
    await mounted.flush()
    ;(globalThis as any).__channelIntroAction = 'pick'
    ;(globalThis as any).__channelIntroPick = '/temporary/raw-intro.wav'
    await mounted.click('.file-picker-stub')
    assert.equal(mounted.emissions.at(-1).file, '/temporary/raw-intro.wav')
    assert.deepEqual(requests, [], 'registration belongs to the host Apply')
  } finally {
    mounted?.unmount()
    globalThis.fetch = originalFetch
    delete (globalThis as any).__channelIntroAction
    delete (globalThis as any).__channelIntroPick
  }
})
