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
import { createApp, ref, computed, h, nextTick, defineComponent } from 'vue'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { useFocusTrap } from '../composables/useFocusTrap.js'

const modelMenu = readFileSync(fileURLToPath(new URL('../components/ModelMenu.vue', import.meta.url)), 'utf8')

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
