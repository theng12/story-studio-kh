import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import {
  computed,
  createApp,
  defineComponent,
  h,
  nextTick,
  ref,
  type Component,
} from 'vue'

const modelPickerPath = fileURLToPath(new URL('../components/ImageModelPicker.vue', import.meta.url))
const outputPickerPath = fileURLToPath(new URL('../components/ImageOutputOptionPicker.vue', import.meta.url))

async function loadPicker(path: string, id: string): Promise<Component> {
  const source = readFileSync(path, 'utf8')
  const { descriptor } = parse(source, { filename: path })
  const script = compileScript(descriptor, { id, inlineTemplate: true })
  const vueUrl = await import.meta.resolve('vue')
  const replacements = new Map([
    ['../utils/live-genstudio-model-selection.js', await import.meta.resolve('../utils/live-genstudio-model-selection.ts')],
    ['../utils/genstudio-credit-cost.js', await import.meta.resolve('../utils/genstudio-credit-cost.ts')],
    ['../utils/genstudio-output-options.js', await import.meta.resolve('../utils/genstudio-output-options.ts')],
    ['../utils/genstudio-freshness.js', await import.meta.resolve('../utils/genstudio-freshness.ts')],
    ['../composables/useGenStudioImageModels.js', await import.meta.resolve('../composables/useGenStudioImageModels.ts')],
  ])
  let content = script.content
  for (const [from, to] of replacements) content = content.replaceAll(from, to)
  const support = `
    import { computed, onMounted, ref, watch } from ${JSON.stringify(vueUrl)}
    const useGenStudioImageModels = () => globalThis.__mountedImagePickerCatalog
  `
  const built = await transform(`${support}\n${content}`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    built.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

const ImageModelPicker = await loadPicker(modelPickerPath, 'image-model-picker-manual-redo')
const ImageOutputOptionPicker = await loadPicker(outputPickerPath, 'image-output-picker-manual-redo')

function model(id: string, options = [
  { resolution: '1K', aspect_ratio: '16:9', width: 1024, height: 576, is_default: true, credits_per_image: 3 },
  { resolution: '1K', aspect_ratio: '1:1', width: 1024, height: 1024, is_default: false, credits_per_image: 3 },
], legacyIds: string[] = []) {
  return {
    id,
    display_name: id === 'image-a' ? 'Image A' : 'Image B',
    provider_name: 'Mock',
    available: true,
    locked: false,
    legacy_ids: legacyIds,
    chargeable: true,
    credits_per_image: 3,
    aspect_ratios: ['16:9', '1:1'],
    default_aspect_ratio: '16:9',
    supports_seed: true,
    supports_reference_images: false,
    min_reference_images: 0,
    max_reference_images: 0,
    output_options: options,
  }
}

const ModelMenu = defineComponent({
  props: { modelValue: { type: String, default: '' }, options: { type: Array, default: () => [] } },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () => h('div', { class: 'model-menu-stub' }, (props.options as any[]).map(option =>
      h('button', { type: 'button', onClick: () => emit('update:modelValue', option.id) }, option.label)))
  },
})

const PriceDetails = defineComponent({ setup: () => () => null })

async function mountHarness(preserve: boolean) {
  const models = ref<any[]>([model('image-a'), model('image-b')])
  Object.assign(globalThis as any, {
    __mountedImagePickerCatalog: {
      models,
      loading: ref(false),
      error: ref(''),
      isStale: ref(false),
      isUsable: ref(true),
      lastFetchedAt: ref(null),
      refresh: async () => undefined,
    },
  })
  const chosenModel = ref('image-a')
  const chosenOutput = ref<any>({ resolution: '1K', aspect_ratio: '16:9' })
  const deliberate: string[] = []
  const selectedModel = computed(() => models.value.find(row => row.id === chosenModel.value) || null)
  const Harness = defineComponent({
    setup: () => () => h('div', [
      h(ImageModelPicker, {
        modelValue: chosenModel.value,
        projectSlug: 'image-project',
        preserveAutomaticSelection: preserve,
        'onUpdate:modelValue': (value: string) => { chosenModel.value = value },
        onSelected: () => { deliberate.push('model') },
      }),
      h(ImageOutputOptionPicker, {
        model: selectedModel.value,
        modelValue: chosenOutput.value,
        preserveAutomaticSelection: preserve,
        'onUpdate:modelValue': (value: any) => { chosenOutput.value = value },
        onSelected: () => { deliberate.push('output') },
      }),
    ]),
  })
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(Harness)
  app.component('ModelMenu', ModelMenu)
  app.component('PriceDetails', PriceDetails)
  app.mount(host)
  await nextTick()
  await nextTick()
  return {
    app, host, models, chosenModel, chosenOutput, deliberate,
    unmount: () => { app.unmount(); host.remove() },
  }
}

test('attempted manual Retry keeps raw model and output while real children reconcile the live catalog', async () => {
  const fixture = await mountHarness(true)
  try {
    fixture.models.value = [model('image-b', [
      { resolution: '2K', aspect_ratio: '1:1', width: 2048, height: 2048, is_default: true, credits_per_image: 5 },
    ], ['image-a'])]
    await nextTick()
    await nextTick()
    assert.equal(fixture.chosenModel.value, 'image-a', 'automatic model fallback must not rewrite an attempted Retry')
    assert.deepEqual(fixture.chosenOutput.value, { resolution: '1K', aspect_ratio: '16:9' },
      'automatic output reconciliation must not rewrite an attempted Retry')
  } finally {
    fixture.unmount()
  }
})

test('ordinary picker callers still receive automatic catalog fallback by default', async () => {
  const fixture = await mountHarness(false)
  try {
    fixture.models.value = [model('image-b', undefined, ['image-a'])]
    await nextTick()
    await nextTick()
    assert.equal(fixture.chosenModel.value, 'image-b')
    assert.deepEqual(fixture.chosenOutput.value, { resolution: '1K', aspect_ratio: '16:9' })
  } finally {
    fixture.unmount()
  }
})

test('real picker clicks identify deliberate edits even while automatic reconciliation is preserved', async () => {
  const fixture = await mountHarness(true)
  try {
    const modelButtons = [...fixture.host.querySelectorAll<HTMLButtonElement>('.model-menu-stub button')]
    modelButtons[1]!.click()
    await nextTick()
    assert.equal(fixture.chosenModel.value, 'image-b')
    assert.deepEqual(fixture.deliberate, ['model'])

    const outputButtons = [...fixture.host.querySelectorAll<HTMLButtonElement>('.output-row')]
    outputButtons[1]!.click()
    await nextTick()
    assert.deepEqual(fixture.chosenOutput.value, { resolution: '1K', aspect_ratio: '1:1' })
    assert.deepEqual(fixture.deliberate, ['model', 'output'])
  } finally {
    fixture.unmount()
  }
})
