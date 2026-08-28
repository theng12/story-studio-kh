/**
 * A pinned model that has LEFT the catalogue must say so, on both surfaces.
 *
 * `describeGenStudioSelectionGap` / `genStudioSelectionGapMessage` were written
 * and unit-tested, then imported by no component — so the case they exist for
 * stayed invisible in the product:
 *
 *   - `ModelSelector` only produced a message when the saved row was still
 *     PRESENT in the catalogue and merely disabled (it read `disabled_reason`
 *     off the row). A row that vanished entirely had no row to read, so the
 *     branch fell through in silence.
 *   - `ModelMenu`'s trigger printed the raw dead id as though it were the
 *     chosen model's name.
 *
 * That is exactly the shape a GenStudio catalogue dedupe produces, so these
 * mount the real SFCs rather than grepping their source: the wiring between
 * the gap function and what a user actually sees is the thing under test.
 *
 * The SFC-compiled-in-process technique is the house pattern established by
 * `pickerDialogFocus.test.ts` — no component-test dependency is added.
 * Runs under happy-dom (registered by __tests__/setup.ts).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, h, nextTick, defineComponent, type Component } from 'vue'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { genStudioSelectionGapMessage } from '../utils/live-genstudio-model-selection.ts'

/**
 * Compile a production SFC to a real Vue component.
 *
 * `extraImports` supplies the Nuxt auto-imports the SFC relies on (`ref`,
 * `computed`, `watch`, …), which are not written in the file itself.
 * `replaceSource` lets a caller neutralise an import that would drag Nuxt's
 * runtime in — `useApi` here — before compilation.
 */
async function loadSfc(
  relPath: string,
  id: string,
  extraImports: string,
  replaceSource: (source: string) => string = s => s,
): Promise<Component> {
  const filename = fileURLToPath(new URL(relPath, import.meta.url))
  const { descriptor } = parse(replaceSource(readFileSync(filename, 'utf8')), { filename })
  const script = compileScript(descriptor, { id })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename,
    id,
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const code = `${extraImports}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  const vueUrl = await import.meta.resolve('vue')
  // Imported from a `data:` URL, where a relative specifier has nothing to be
  // relative to. Rewrite every `../utils/…` (with or without a `.js` suffix)
  // to an absolute file URL so adding an import to a component under test does
  // not silently break this loader.
  const componentUrl = `data:text/javascript;base64,${Buffer.from(
    transformed.code
      .replaceAll('"vue"', JSON.stringify(vueUrl))
      .replace(/"(\.\.\/utils\/[\w-]+)(?:\.js)?"/g, (_m, specifier: string) => (
        JSON.stringify(new URL(`${specifier}.ts`, import.meta.url).href)
      )),
  ).toString('base64')}`
  return (await import(componentUrl)).default
}

const Stub = defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) })

// ---------------------------------------------------------------------------
// ModelMenu — the trigger must not present a dead id as a chosen model
// ---------------------------------------------------------------------------

let modelMenuComponent: Promise<Component> | undefined
function loadModelMenu(): Promise<Component> {
  modelMenuComponent ||= loadSfc(
    '../components/ModelMenu.vue',
    'model-menu-gap-test',
    `import { computed, nextTick, ref } from 'vue'`,
  )
  return modelMenuComponent
}

const liveOptions = [
  { id: 'writer-fast', label: 'Fast Writer' },
  { id: 'writer-steady', label: 'Steady Writer' },
]

async function mountModelMenu(props: Record<string, unknown>) {
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(await loadModelMenu(), { options: liveOptions, ...props })
  app.component('PickerDialog', Stub)
  app.component('NuxtLink', Stub)
  app.mount(host)
  await nextTick()
  return { host, unmount: () => app.unmount() }
}

describe('ModelMenu — a pinned model that left the catalogue', () => {
  test('the trigger shows the replacement prompt instead of the dead id', async () => {
    const { host, unmount } = await mountModelMenu({
      modelValue: 'deleted-by-dedupe',
      missingSelectionLabel: 'No longer offered',
    })
    const trigger = host.querySelector('.model-menu-current strong')!
    assert.equal(trigger.textContent, 'No longer offered')
    assert.doesNotMatch(
      trigger.textContent || '',
      /deleted-by-dedupe/,
      'the raw dead id must not be presented as the chosen model name',
    )
    // Still recoverable — the user has to be able to find out WHICH product went.
    assert.match(
      host.querySelector('.model-menu-trigger')!.getAttribute('title') || '',
      /deleted-by-dedupe/,
    )
    assert.ok(host.querySelector('.model-menu-current.missing'), 'the dead pin is marked, not styled as a settled choice')
    unmount()
  })

  test('the open menu carries the written gap sentence', async () => {
    const notice = genStudioSelectionGapMessage({ kind: 'vanished', savedModelId: 'deleted-by-dedupe' })!
    const { host, unmount } = await mountModelMenu({
      modelValue: 'deleted-by-dedupe',
      missingSelectionLabel: 'No longer offered',
      catalogNotice: notice,
    })
    host.querySelector<HTMLButtonElement>('.model-menu-trigger')!.click()
    await nextTick()
    await nextTick()
    const rendered = host.querySelector('.model-menu-catalog-notice')?.textContent || ''
    assert.match(rendered, /is no longer offered/)
    assert.match(rendered, /Choose a replacement/)
    unmount()
  })

  test('without the flag the trigger still echoes the id — a loading catalogue is not a dead pin', async () => {
    // Options are legitimately empty while the catalogue read is in flight. A
    // menu that called its own saved value dead on every open would cry wolf.
    const { host, unmount } = await mountModelMenu({
      modelValue: 'writer-steady',
      options: [],
      loading: true,
    })
    assert.equal(host.querySelector('.model-menu-current strong')!.textContent, 'writer-steady')
    assert.equal(host.querySelector('.model-menu-current.missing'), null)
    unmount()
  })

  test('a live selection is untouched', async () => {
    const { host, unmount } = await mountModelMenu({ modelValue: 'writer-steady' })
    assert.equal(host.querySelector('.model-menu-current strong')!.textContent, 'Steady Writer')
    assert.equal(host.querySelector('.model-menu-current.missing'), null)
    unmount()
  })
})

// ---------------------------------------------------------------------------
// ModelSelector — the surface that owns the decision
// ---------------------------------------------------------------------------

let modelSelectorComponent: Promise<Component> | undefined
function loadModelSelector(): Promise<Component> {
  modelSelectorComponent ||= loadSfc(
    '../components/ModelSelector.vue',
    'model-selector-gap-test',
    `import { computed, nextTick, ref, watch } from 'vue'`,
    // `useApi` is a Nuxt auto-import and `invalidateModelCatalogCache` lives in
    // the same composable; both would pull the Nuxt runtime into this process.
    // The catalogue itself is what this test varies, so it is injected instead.
    source => source.replace(
      `import { invalidateModelCatalogCache } from '../composables/useApi.js'`,
      `const invalidateModelCatalogCache = () => {}`,
    ),
  )
  return modelSelectorComponent
}

/** Records what ModelSelector hands down, so both surfaces are asserted. */
const menuProps: Record<string, unknown> = {}
const ModelMenuSpy = defineComponent({
  props: {
    modelValue: { type: String, default: '' },
    catalogNotice: { type: String, default: '' },
    missingSelectionLabel: { type: String, default: '' },
  },
  setup(props) {
    return () => {
      Object.assign(menuProps, { ...props })
      return h('div', { class: 'model-menu-spy' })
    }
  },
})

async function mountModelSelector(modelValue: string, catalog: unknown) {
  for (const key of Object.keys(menuProps)) delete menuProps[key]
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  // The SFC calls the auto-imported `useApi()` at setup; a global satisfies the
  // free identifier in the compiled module.
  ;(globalThis as any).useApi = () => ({
    get: async () => {
      if (catalog instanceof Error) throw catalog
      return catalog
    },
  })
  const app = createApp(await loadModelSelector(), { modelValue, projectSlug: 'demo' })
  app.component('ModelMenu', ModelMenuSpy)
  app.mount(host)
  // Settle the awaited catalogue read and the watchers it triggers.
  for (let i = 0; i < 6; i++) await nextTick()
  return { host, unmount: () => app.unmount() }
}

const catalogWithoutThePin = [
  { id: 'writer-fast', label: 'Fast Writer', provider: 'genstudio', available: true },
  { id: 'writer-steady', label: 'Steady Writer', provider: 'genstudio', available: true },
]

describe('ModelSelector — a pinned model that left the catalogue', () => {
  test('renders the written gap sentence under the field', async () => {
    const { host, unmount } = await mountModelSelector('deleted-by-dedupe', catalogWithoutThePin)
    const gap = host.querySelector('.selection-gap')
    assert.ok(gap, 'a vanished pin must produce a visible message, not silence')
    assert.match(gap!.textContent || '', /"deleted-by-dedupe" is no longer offered/)
    assert.match(gap!.textContent || '', /Choose a replacement/)
    unmount()
  })

  test('hands both surfaces what they need', async () => {
    const { unmount } = await mountModelSelector('deleted-by-dedupe', catalogWithoutThePin)
    assert.match(String(menuProps.catalogNotice), /is no longer offered/)
    assert.equal(menuProps.missingSelectionLabel, 'No longer offered')
    unmount()
  })

  test('present-but-disabled is UNCHANGED — its own wording, and no gap message', async () => {
    const { host, unmount } = await mountModelSelector('writer-paused', [
      ...catalogWithoutThePin,
      {
        id: 'writer-paused',
        label: 'Paused Writer',
        provider: 'genstudio',
        available: false,
        disabled_reason: 'Temporarily paused by GenStudio.',
      },
    ])
    assert.equal(
      host.querySelector('.catalog-message')?.textContent,
      'Temporarily paused by GenStudio.',
    )
    assert.equal(
      host.querySelector('.selection-gap'),
      null,
      'a still-listed product is not "no longer offered"; saying both would say it twice',
    )
    assert.equal(menuProps.missingSelectionLabel, '')
    unmount()
  })

  test('an unreachable catalogue is not reported as a dead pin', async () => {
    // Nothing has been seen, so "no longer offered" would be a claim about a
    // catalogue nobody read. That failure has its own message.
    const { host, unmount } = await mountModelSelector('writer-steady', new Error('offline'))
    assert.equal(host.querySelector('.selection-gap'), null)
    assert.ok(host.querySelector('.catalog-message'), 'the load failure still reports itself')
    unmount()
  })

  test('a live pin produces no message at all', async () => {
    const { host, unmount } = await mountModelSelector('writer-steady', catalogWithoutThePin)
    assert.equal(host.querySelector('.selection-gap'), null)
    assert.equal(menuProps.catalogNotice, '')
    unmount()
  })
})
