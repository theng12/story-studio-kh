/**
 * v1.4.47 — a <details> menu that closes when you click away.
 *
 * `<details>/<summary>` does not close on an outside click. That is the
 * element's specified behaviour, not a bug in it — but every other menu on the
 * platform does, so a menu built this way reads as stuck. The owner's words:
 * "i can't click off for dismiss. it's needs me to click More again to
 * dismiss. annoying."
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { describe } from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const composable = read('../composables/useDismissableDetails.ts')

describe('the dismiss behaviour', () => {
  test('an outside pointer press closes an open menu', () => {
    assert.match(composable, /document\.addEventListener\('pointerdown', onPointerDown, true\)/)
    assert.match(composable, /if \(node && element\.contains\(node\)\) continue/,
      'a press INSIDE the menu must not close it, or no item could ever be clicked')
  })

  test('Escape closes it too, so it is reachable without a mouse', () => {
    assert.match(composable, /event\.key !== 'Escape'/)
  })

  test('it only touches menus that are open', () => {
    assert.match(composable, /if \(!element\.open\) continue/)
  })

  test('the listeners are removed when the component goes away', () => {
    assert.match(composable, /onBeforeUnmount\(\(\) => \{[\s\S]{0,300}removeEventListener\('pointerdown'/)
    assert.match(composable, /removeEventListener\('keydown', onKeyDown\)/)
  })
})

describe('every menu built this way uses it', () => {
  // Selector-based and document-level on purpose: the same markup appears in
  // more than one component, and a fix that must be remembered at each call
  // site is a fix that will be missed at the next one.
  for (const rel of ['../components/PresetPicker.vue', '../components/TopActionBar.vue']) {
    test(`${rel.split('/').pop()} calls it`, () => {
      const source = read(rel)
      assert.match(source, /<details class="preset-more">/)
      assert.match(source, /useDismissableDetails\(\)/)
    })
  }
})

describe('the withdrawn iCloud feature is not still described on screen', () => {
  // Library linking and iCloud delivery were withdrawn; one folder is chosen
  // at first run. Copy that still explains an iCloud sync tells the owner to
  // wait for something that will never happen.
  for (const rel of [
    '../pages/projects/[slug]/audio.vue',
    '../pages/projects/[slug]/pipeline.vue',
    '../pages/projects/[slug]/image-prompts.vue',
    '../components/EpisodeSelector.vue',
    '../composables/useEpisodes.ts',
    '../composables/useEpisodeStatus.ts',
  ]) {
    test(`${rel.split('/').pop()} no longer mentions it`, () => {
      assert.doesNotMatch(read(rel), /iCloud/i)
    })
  }
})
