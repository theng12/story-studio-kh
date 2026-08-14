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
    const tierPolicyUrl = new URL('../utils/genstudio-cost-tier.ts', import.meta.url).href
    const componentUrl = `data:text/javascript;base64,${Buffer.from(
      transformed.code
        .replaceAll('"vue"', JSON.stringify(vueUrl))
        .replaceAll('"../utils/genstudio-cost-tier"', JSON.stringify(tierPolicyUrl)),
    ).toString('base64')}`
    return (await import(componentUrl)).default
  })()
  return modelMenuComponent
}

const PickerDialogStub = defineComponent({
  setup(_, { slots }) {
    return () => h('div', { class: 'picker-dialog-stub' }, slots.default?.())
  },
})

async function mountModelMenu() {
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(await loadModelMenu(), {
    modelValue: 'steady',
    options: [
      { id: 'fast', label: 'Fast', costTier: 'economy' },
      {
        id: 'steady',
        label: 'Steady',
        costTier: 'balanced',
        description: 'A balanced model for routine work.',
        price: '12 credits / 1M input tokens · 24 credits / 1M output tokens',
        priceTitle: 'GenStudio publishes this token rate. The final charge depends on actual usage.',
      },
      { id: 'flagship', label: 'Flagship', costTier: 'premium' },
    ],
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
  test('ModelMenu shows a dedicated published rate without hiding the model description', async () => {
    const { host, unmount } = await mountModelMenu()
    try {
      const price = host.querySelector<HTMLElement>('.model-menu-option-price')
      assert.equal(price?.textContent?.trim(), 'Published rate · 12 credits / 1M input tokens · 24 credits / 1M output tokens')
      assert.equal(price?.title, 'GenStudio publishes this token rate. The final charge depends on actual usage.')
      assert.equal(
        host.querySelector<HTMLElement>('.model-menu-option-description')?.textContent?.trim(),
        'A balanced model for routine work.',
      )
    } finally {
      unmount()
    }
  })

  test('ModelMenu keeps tab focus, selection, and roving tabindex synchronized for Home and End', async () => {
    // Catches Home/End calling setTier directly: selection changes but DOM focus
    // remains on the previous tab, so the next Arrow key starts from the wrong place.
    const { host, unmount } = await mountModelMenu()
    try {
      const tab = (tier: string) => host.querySelector<HTMLButtonElement>(`#model-menu-tier-${tier}`)!
      const assertActiveTier = (tier: string) => {
        for (const candidate of ['economy', 'balanced', 'premium']) {
          assert.equal(tab(candidate).getAttribute('aria-selected'), String(candidate === tier))
          assert.equal(tab(candidate).getAttribute('tabindex'), candidate === tier ? '0' : '-1')
        }
        assert.equal((document.activeElement as HTMLElement | null)?.id, tab(tier).id)
      }

      tab('premium').focus()
      tab('premium').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
      await nextTick()
      assertActiveTier('economy')

      tab('balanced').focus()
      tab('balanced').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      await nextTick()
      assertActiveTier('premium')
    } finally {
      unmount()
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
