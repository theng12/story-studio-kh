/**
 * The picker dialogs' opening focus handshake.
 *
 * ModelMenu and VoicePicker open a `PickerDialog`, which wraps the shared
 * `Modal`, which runs `useFocusTrap`. Two things race on open:
 *
 *   1. the focus trap focuses the dialog's FIRST focusable control — the
 *      header's close button — one tick after the dialog renders;
 *   2. the picker focuses its own search field.
 *
 * The picker's watcher is created before Modal's (the parent's setup runs
 * first), so its `nextTick` callback is queued FIRST and would be overwritten
 * by the trap. Both pickers therefore wait two ticks. This is invisible in the
 * source and trivially broken by a "simplification", so it is pinned here with
 * a real Vue mount rather than a source grep: the assertion below fails with a
 * single `nextTick` and passes with two.
 *
 * Runs under happy-dom (registered by __tests__/setup.ts).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, ref, computed, h, nextTick, defineComponent, type Component } from 'vue'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { useFocusTrap } from '../composables/useFocusTrap.js'
import { thumbnailVisionModelMenuOption } from '../utils/thumbnail-vision-model-menu.js'

const modelMenu = readFileSync(fileURLToPath(new URL('../components/ModelMenu.vue', import.meta.url)), 'utf8')

/**
 * Compiles the production SFC in-process so this regression exercises its real
 * event handlers without adding a component-test dependency. The only stubs
 * are PickerDialog/NuxtLink shells; neither owns ModelMenu's tab state.
 */
let modelMenuComponent: Promise<Component> | undefined
function loadModelMenu(): Promise<Component> {
  if (modelMenuComponent) return modelMenuComponent
  modelMenuComponent = (async () => {
    const filename = fileURLToPath(new URL('../components/ModelMenu.vue', import.meta.url))
    const { descriptor } = parse(modelMenu, { filename })
    const script = compileScript(descriptor, { id: 'model-menu-test' })
    const template = compileTemplate({
      source: descriptor.template!.content,
      filename,
      id: 'model-menu-test',
      compilerOptions: { bindingMetadata: script.bindings },
    })
    const code = `import { computed, nextTick, ref } from 'vue'\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
    const transformed = await transform(code, { loader: 'ts', format: 'esm' })
    const vueUrl = await import.meta.resolve('vue')
    // The compiled module is imported from a `data:` URL, and a relative
    // specifier has nothing to be relative TO from there — the loader throws
    // `ERR_INVALID_URL` rather than reporting a missing file, which reads like
    // a broken test rather than an unrewritten import. Every `../utils/…` the
    // component imports is rewritten to an absolute file URL, so adding one to
    // ModelMenu no longer requires editing this test to keep it loadable.
    const componentUrl = `data:text/javascript;base64,${Buffer.from(
      transformed.code
        .replaceAll('"vue"', JSON.stringify(vueUrl))
        .replace(/"(\.\.\/utils\/[\w-]+)"/g, (_match, specifier: string) => (
          JSON.stringify(new URL(`${specifier}.ts`, import.meta.url).href)
        )),
    ).toString('base64')}`
    return (await import(componentUrl)).default
  })()
  return modelMenuComponent
}

const PickerDialogStub = defineComponent({
  props: { count: String },
  setup(props, { slots }) {
    return () => h('div', { class: 'picker-dialog-stub' }, [
      h('span', { class: 'pd-count-stub' }, props.count),
      slots.default?.(),
    ])
  },
})

const defaultModelMenuOptions = [
  { id: 'fast', label: 'Fast' },
  {
    id: 'steady',
    label: 'Steady',
    description: 'A balanced model for routine work.',
    price: '12 credits / 1M input tokens · 24 credits / 1M output tokens',
    priceTitle: 'The Gateway publishes this token rate. The final charge depends on actual usage.',
  },
  { id: 'flagship', label: 'Flagship' },
]

async function mountModelMenu(
  options = defaultModelMenuOptions,
  modelValue = 'steady',
  mediaType: 'llm' | 'image' = 'llm',
  extra: Record<string, unknown> = {},
) {
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(await loadModelMenu(), {
    modelValue,
    options,
    mediaType,
    ...extra,
  })
  app.component('PickerDialog', PickerDialogStub)
  app.component('NuxtLink', PickerDialogStub)
  app.mount(host)
  const trigger = host.querySelector<HTMLButtonElement>('.model-menu-trigger')!
  trigger.click()
  await nextTick()
  await nextTick()
  return { host, unmount: () => app.unmount() }
}

/** Stands in for Modal: mounted for the parent's whole life, renders on `visible`. */
const Dialog = defineComponent({
  props: { visible: Boolean },
  setup(props, { slots }) {
    const dialogRef = ref<HTMLElement | null>(null)
    const visibleRef = computed(() => props.visible)
    useFocusTrap(dialogRef, visibleRef, () => {})
    return () => props.visible
      // Header close button first, then the caller's search field — the DOM
      // order PickerDialog produces.
      ? h('div', { ref: dialogRef }, [h('button', { id: 'close' }, 'x'), slots.default?.()])
      : null
  },
})

function mountPicker(ticks: number) {
  let open!: () => Promise<void>
  const Picker = defineComponent({
    setup() {
      const expanded = ref(false)
      const searchEl = ref<HTMLInputElement | null>(null)
      open = async () => {
        expanded.value = true
        for (let i = 0; i < ticks; i += 1) await nextTick()
        searchEl.value?.focus({ preventScroll: true })
      }
      return () => h(Dialog, { visible: expanded.value }, {
        default: () => h('input', { ref: searchEl, id: 'search', type: 'search' }),
      })
    },
  })

  document.body.innerHTML = ''
  const trigger = document.createElement('button')
  trigger.id = 'trigger'
  document.body.appendChild(trigger)
  trigger.focus()

  const host = document.createElement('div')
  document.body.appendChild(host)
  createApp(Picker).mount(host)
  return { open }
}

describe('picker dialog opening focus', () => {
  test('ModelMenu renders no published rate and keeps the model description', async () => {
    const { host, unmount } = await mountModelMenu()
    try {
      assert.equal(host.querySelector('.model-menu-option-price'), null)
      assert.equal(
        host.querySelector<HTMLElement>('.model-menu-option-description')?.textContent?.trim(),
        'A balanced model for routine work.',
      )
    } finally {
      unmount()
    }
  })

  test('thumbnail vision selection renders no price row and keeps its vision metadata', async () => {
    const option = thumbnailVisionModelMenuOption({
      id: 'vision-live-v1',
      display_name: 'Live Vision',
      supported_detail_levels: ['high'],
      max_input_images: 1,
      accepted_image_mime_types: ['image/png'],
      max_image_bytes: 4_000_000,
      max_image_dimension: 2_048,
      input_credits_per_million_tokens: 12,
      output_credits_per_million_tokens: 24,
      minimum_credits: 3,
      price_version: 'vision-price-v1',
    })
    const { host, unmount } = await mountModelMenu([option], option.id)
    try {
      assert.equal(host.querySelector('.model-menu-option-price'), null)
      assert.equal(
        host.querySelector<HTMLElement>('.model-menu-option-meta')?.textContent?.trim(),
        '1 image · high detail',
      )
      const badges = [...host.querySelectorAll<HTMLElement>('.model-menu-badge')]
        .map(badge => badge.textContent?.trim())
      assert.deepEqual(badges, ['Vision', 'JSON'])
    } finally {
      unmount()
    }
  })

  test('the header counts the whole catalogue, never the search results', async () => {
    const { host, unmount } = await mountModelMenu()
    try {
      assert.equal(host.querySelector('.pd-count-stub')?.textContent, '3 available')
      const search = host.querySelector<HTMLInputElement>('.model-menu-search')!
      search.value = 'flagship'
      search.dispatchEvent(new Event('input'))
      await nextTick()
      assert.equal(host.querySelectorAll('.model-menu-option').length, 1)
      assert.equal(host.querySelector('.pd-count-stub')?.textContent, '3 available',
        'the figure answers "how many models are there", not "how many matched"')
    } finally {
      unmount()
    }
  })

  test('an empty catalogue shows no count, and names a failed read honestly', async () => {
    const empty = await mountModelMenu([], '')
    try {
      assert.equal(empty.host.querySelector('.model-menu-empty')?.textContent?.trim(), 'No models are currently available.')
      assert.equal(empty.host.querySelector('.pd-count-stub')?.textContent, '', 'no zero that claims the Gateway publishes nothing')
    } finally {
      empty.unmount()
    }

    const failed = await mountModelMenu([], '', 'llm', { catalogueError: 'Gateway catalog unavailable.' })
    try {
      assert.equal(failed.host.querySelector('.model-menu-empty')?.textContent?.trim(), 'Gateway catalog unavailable.',
        'a failed read is not reported as an empty catalogue (§6)')
    } finally {
      failed.unmount()
    }
  })

  test('ModelMenu retains the two-tick dialog focus handshake', () => {
    // Catches reducing ModelMenu to one tick, letting the shared focus trap steal search focus.
    assert.match(modelMenu, /await nextTick\(\)\s*await nextTick\(\)\s*searchEl\.value\?\.focus/)
  })

  test('the search field ends up with focus, not the trap-selected close button', async () => {
    const { open } = mountPicker(2)
    await open()
    await new Promise(resolve => setTimeout(resolve, 20))

    assert.equal((document.activeElement as HTMLElement)?.id, 'search',
      'opening a picker must put the caret in its search field')
  })

  test('one tick is not enough — this is why both pickers wait for two', async () => {
    const { open } = mountPicker(1)
    await open()
    await new Promise(resolve => setTimeout(resolve, 20))

    assert.equal((document.activeElement as HTMLElement)?.id, 'close',
      'the focus trap wins on a single tick; the two-tick wait in ModelMenu '
      + 'and VoicePicker is load-bearing, not defensive padding')
  })
})

test('ModelMenu keeps an unavailable row visibly disabled and unselectable', async () => {
  let selected = 'active'
  let selectionHandlerCalls = 0
  const options = [{
    id: 'paused',
    label: 'Paused',
    disabled: true,
    disabledReason: 'Daily capacity is currently depleted. Available again at Jan 2, 2027, 7:00 AM.',
  }]
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(await loadModelMenu(), {
    modelValue: selected,
    options,
    'onUpdate:modelValue': (value: string) => {
      selectionHandlerCalls += 1
      selected = value
    },
  })
  app.component('PickerDialog', PickerDialogStub)
  app.component('NuxtLink', PickerDialogStub)
  app.mount(host)
  host.querySelector<HTMLButtonElement>('.model-menu-trigger')!.click()
  await nextTick()
  await nextTick()

  const row = host.querySelector<HTMLButtonElement>('.model-menu-option')!
  assert.equal(row.classList.contains('disabled'), true)
  assert.equal(row.getAttribute('aria-disabled'), 'true')
  assert.match(row.textContent || '', /daily capacity is currently depleted/i)
  row.click()
  assert.equal(selectionHandlerCalls, 0, 'disabled rows do not emit a selection update')
  assert.equal(selected, 'active')
  app.unmount()
})
