import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const INSTALLED_FORMULA = {
  id: 'com.storystudio.formula.history-explained', name: 'History Explained', catalogName: 'History Explained',
  description: 'Evidence-led history with a clear causal arc.', builtin: false, schemaVersion: 1, formulaFamily: 'Explained History',
  audienceHint: 'Curious adults', titleShapeRules: ['Make the hidden cause concrete'], scriptContext: 'Open on the consequence, then trace the cause.',
  narratorStyles: [{ id: 'measured', label: 'Measured documentary' }], exampleTopics: ['The treaty that redrew a border'],
  scriptStructure: { lengthMinutesRange: [18, 24], chapterCountRange: [8, 12] },
  catalog: { source: 'signed-installed', pack_id: 'com.storystudio.pack.history-explained', version: '1.0.1' },
}
const LEGACY_FORMULA = {
  id: 'history-narration', name: 'History Explained', catalogName: 'History Explained',
  description: 'Legacy narration formula.', builtin: true, schemaVersion: 1, formulaFamily: 'Explained History', exampleTopics: [],
  catalog: { source: 'legacy-builtin' },
}
const OTHER_FORMULA = {
  id: 'other-formula', name: 'Other Formula', description: 'A different promise.', builtin: true, schemaVersion: 1,
  formulaFamily: 'Other', exampleTopics: [], catalog: { source: 'legacy-builtin' },
}
const HISTORY_PACK = {
  id: 'com.storystudio.topic.historical-wars-treaties-world-order', name: 'Wars, Treaties & World Order',
  description: 'Conflict, diplomacy, and political order.', builtin: false, schemaVersion: 1,
  compatibleNicheIds: [INSTALLED_FORMULA.id], subjects: Array.from({ length: 25 }, (_, index) => `Subject ${index + 1}`),
  tags: ['History'], maxSiblingsPerSubject: 1, coverageProfiles: [{ label: 'Core', tuples: [[1], [2]] }],
  catalog: { source: 'signed-installed', pack_id: 'com.storystudio.pack.historical-world-order', version: '1.0.0' },
}
const ARCHIVAL_PACK = {
  ...HISTORY_PACK,
  id: 'archival-ledger.wars-treaties-world-order',
  description: 'A separate archival ledger with the same public name.',
  catalog: { source: 'legacy-user-fork' },
}
const OTHER_PACK = {
  id: 'other-pack', name: 'Other Subjects', description: 'Only for the other Formula.', builtin: true, schemaVersion: 1,
  compatibleNicheIds: [OTHER_FORMULA.id], subjects: ['Elsewhere'], tags: ['Other'], catalog: { source: 'legacy-builtin' },
}

interface HarnessOptions {
  formulaId?: string
  topicIds?: string[]
  formulas?: any[]
  topics?: any[]
  failSave?: boolean
  formulaError?: Error | null
  afterFormulaRefresh?: any[]
  surface?: 'Ideas' | 'Settings'
  initialVisible?: boolean
  deferSave?: boolean
}

let pickerComponent: Promise<Component> | undefined
async function loadPicker(): Promise<Component> {
  if (pickerComponent) return pickerComponent
  pickerComponent = (async () => {
    const filename = fileURLToPath(new URL('../components/ChannelIdentityPickerModal.vue', import.meta.url))
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
    const script = compileScript(descriptor, { id: 'channel-identity-picker-test' })
    const template = compileTemplate({
      source: descriptor.template!.content,
      filename,
      id: 'channel-identity-picker-test',
      compilerOptions: { bindingMetadata: script.bindings },
    })
    const vueUrl = await import.meta.resolve('vue')
    const support = `
      import { computed, nextTick, ref, watch } from ${JSON.stringify(vueUrl)}
      const useNiches = () => globalThis.__identityPickerHarness.niches()
      const useTopicPacks = () => globalThis.__identityPickerHarness.topics()
    `
    const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
    const transformed = await transform(code, { loader: 'ts', format: 'esm' })
    return (await import(`data:text/javascript;base64,${Buffer.from(transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
  })()
  return pickerComponent
}

const ModalStub = defineComponent({
  props: { visible: Boolean },
  emits: ['close'],
  setup(props, { slots }) { return () => props.visible ? h('div', { class: 'modal-stub' }, slots.default?.()) : null },
})

async function flush(): Promise<void> {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

async function mountPicker(options: HarnessOptions = {}) {
  const formulas = ref(options.formulas || [INSTALLED_FORMULA, LEGACY_FORMULA, OTHER_FORMULA])
  const topics = ref(options.topics || [HISTORY_PACK, ARCHIVAL_PACK, OTHER_PACK])
  const formulaLoading = ref(false)
  const topicLoading = ref(false)
  const formulaError = ref<unknown>(options.formulaError || null)
  const topicError = ref<unknown>(null)
  const puts: Array<{ slug: string; formulaId: string | null; topicIds: string[] }> = []
  let formulaRefreshes = 0
  let topicRefreshes = 0
  let releaseSave = () => {}
  const saveGate = options.deferSave ? new Promise<void>(resolve => { releaseSave = resolve }) : Promise.resolve()
  ;(globalThis as any).__identityPickerHarness = {
    niches: () => ({
      niches: formulas, isLoading: formulaLoading, error: formulaError,
      refresh: async () => { formulaRefreshes += 1; if (options.afterFormulaRefresh) formulas.value = options.afterFormulaRefresh },
      setProjectNiche: async (slug: string, formulaId: string | null, topicIds: string[]) => {
        puts.push({ slug, formulaId, topicIds: [...topicIds] })
        await saveGate
        if (options.failSave) throw new Error('disk is read-only')
      },
    }),
    topics: () => ({ topicPacks: topics, isLoading: topicLoading, error: topicError, refresh: async () => { topicRefreshes += 1 } }),
  }
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const visible = ref(!!options.initialVisible)
  const currentFormula = ref(options.formulaId ?? INSTALLED_FORMULA.id)
  const currentTopics = ref([...(options.topicIds ?? [HISTORY_PACK.id])])
  const savedEvents: Array<{ formulaId: string; topicPackIds: string[] }> = []
  const Wrapper = defineComponent({
    setup() {
      return () => h(awaitedPicker, {
        visible: visible.value,
        projectSlug: 'bounded-history',
        selectedFormulaId: currentFormula.value,
        selectedTopicPackIds: currentTopics.value,
        projectContentPackVersions: { 'com.storystudio.pack.history-explained': '1.0.0' },
        actionLabel: `Apply to ${options.surface || 'channel'}`,
        onClose: () => { visible.value = false },
        onSaved: (value: { formulaId: string; topicPackIds: string[] }) => {
          savedEvents.push(value)
          currentFormula.value = value.formulaId
          currentTopics.value = [...value.topicPackIds]
        },
      })
    },
  })
  const awaitedPicker = await loadPicker()
  const app = createApp(Wrapper)
  app.component('Modal', ModalStub)
  app.mount(host)
  visible.value = true
  await flush()
  return {
    host, puts, savedEvents, currentFormula, currentTopics,
    refreshCounts: () => ({ formula: formulaRefreshes, topic: topicRefreshes }),
    releaseSave,
    reopen: async () => { visible.value = true; await flush() },
    unmount: () => { app.unmount(); delete (globalThis as any).__identityPickerHarness },
  }
}

function button(host: HTMLElement, label: RegExp): HTMLButtonElement {
  const match = [...host.querySelectorAll<HTMLButtonElement>('button')].find(candidate => label.test(candidate.textContent || ''))
  assert.ok(match, `expected button ${label}`)
  return match
}

test('cancel keeps the parent identity untouched and sends no PUT', async () => {
  const mounted = await mountPicker()
  try {
    button(mounted.host, /All sources/).click(); await nextTick()
    button(mounted.host, /Choose Formula/).click(); await nextTick()
    button(mounted.host, /^Cancel$/).click(); await flush()
    assert.equal(mounted.puts.length, 0)
    assert.equal(mounted.currentFormula.value, INSTALLED_FORMULA.id)
    assert.deepEqual(mounted.currentTopics.value, [HISTORY_PACK.id])
  } finally { mounted.unmount() }
})

test('a failed save keeps the modal and its draft visible', async () => {
  const mounted = await mountPicker({ failSave: true })
  try {
    button(mounted.host, /Apply to channel/).click(); await flush()
    assert.equal(mounted.puts.length, 1)
    assert.ok(mounted.host.querySelector('.modal-stub'))
    assert.match(mounted.host.textContent || '', /disk is read-only/)
    assert.match(mounted.host.textContent || '', /History Explained · 1 Topic Pack/)
  } finally { mounted.unmount() }
})

test('a successful Apply updates either Ideas or Settings only after the PUT succeeds', async () => {
  for (const surface of ['Ideas', 'Settings'] as const) {
    const mounted = await mountPicker({ surface })
    try {
      button(mounted.host, /Topic Packs/).click(); await nextTick()
      button(mounted.host, /Remove Pack/).click(); await nextTick()
      assert.deepEqual(mounted.currentTopics.value, [HISTORY_PACK.id], `${surface} parent is still authoritative before save`)
      button(mounted.host, new RegExp(`Apply to ${surface}`)).click(); await flush()
      assert.deepEqual(mounted.puts[0]?.topicIds, [])
      assert.deepEqual(mounted.currentTopics.value, [])
      assert.equal(mounted.savedEvents.length, 1)
    } finally { mounted.unmount() }
  }
})

test('same-name IDs stay distinct, show truthful sources and expose project pin differences', async () => {
  const mounted = await mountPicker({ formulaId: LEGACY_FORMULA.id, topicIds: [ARCHIVAL_PACK.id] })
  try {
    const formulaCards = [...mounted.host.querySelectorAll('.identity-card')].filter(card => /History Explained/.test(card.textContent || ''))
    assert.equal(formulaCards.length, 2)
    assert.ok(formulaCards.some(card => /Installed/.test(card.textContent || '')))
    assert.ok(formulaCards.some(card => /Built in/.test(card.textContent || '')))
    button(mounted.host, /Topic Packs/).click(); await nextTick()
    button(mounted.host, /All Library/).click(); await nextTick()
    button(mounted.host, /All sources/).click(); await nextTick()
    const topicCards = [...mounted.host.querySelectorAll('.identity-card')].filter(card => /Wars, Treaties & World Order/.test(card.textContent || ''))
    assert.equal(topicCards.length, 2)
    assert.ok(topicCards.some(card => /Installed/.test(card.textContent || '')))
    assert.ok(topicCards.some(card => /Custom/.test(card.textContent || '')))
    assert.match(mounted.host.textContent || '', /Up to 1 episode per subject\. Available plans depend on coverage and saved history\./)
    button(mounted.host, /Formula/).click(); await nextTick()
    const installed = [...mounted.host.querySelectorAll<HTMLElement>('.identity-card')].find(card => /Installed/.test(card.textContent || ''))!
    button(installed, /View Details/).click(); await nextTick()
    assert.match(mounted.host.textContent || '', /Library has v1\.0\.1\. Project uses v1\.0\.0\./)
  } finally { mounted.unmount() }
})

test('only an explicit Formula change removes known incompatible packs and names them', async () => {
  const mounted = await mountPicker({ topicIds: [HISTORY_PACK.id, OTHER_PACK.id, 'missing-selected-pack'] })
  try {
    assert.doesNotMatch(mounted.host.textContent || '', /compatibility updated the draft/)
    assert.match(mounted.host.textContent || '', /3 selected/)
    button(mounted.host, /All sources/).click(); await nextTick()
    const other = [...mounted.host.querySelectorAll<HTMLElement>('.identity-card')].find(card => /Other Formula/.test(card.textContent || ''))!
    button(other, /Choose Formula/).click(); await nextTick()
    assert.match(mounted.host.textContent || '', /Removed Wars, Treaties & World Order/)
    assert.match(mounted.host.textContent || '', /2 selected/)
    button(mounted.host, /Apply to channel/).click(); await flush()
    assert.deepEqual(mounted.puts[0]?.topicIds.sort(), [OTHER_PACK.id, 'missing-selected-pack'].sort())
  } finally { mounted.unmount() }
})

test('No Formula explicitly clears Topic Packs and blocks adding packs until a Formula is chosen', async () => {
  const mounted = await mountPicker({ topicIds: [HISTORY_PACK.id, 'missing-saved-pack'] })
  try {
    button(mounted.host, /^No Formula/).click(); await nextTick()
    assert.match(mounted.host.textContent || '', /Removed Wars, Treaties & World Order, missing-saved-pack/)
    assert.match(mounted.host.textContent || '', /0 selected/)
    button(mounted.host, /Topic Packs/).click(); await nextTick()
    button(mounted.host, /All Library/).click(); await nextTick()
    const addButtons = [...mounted.host.querySelectorAll<HTMLButtonElement>('button')].filter(candidate => /Add Pack/.test(candidate.textContent || ''))
    assert.ok(addButtons.length > 0)
    assert.ok(addButtons.every(candidate => candidate.disabled))
    assert.match(mounted.host.textContent || '', /Choose a Formula before adding Topic Packs/)
  } finally { mounted.unmount() }
})

test('a selected unavailable Topic Pack can be removed without changing valid saved packs or writing on Cancel', async () => {
  const topicIds = [HISTORY_PACK.id, 'missing-saved-pack']
  const mounted = await mountPicker({ topicIds })
  try {
    button(mounted.host, /Topic Packs/).click(); await nextTick()
    const unavailableCard = [...mounted.host.querySelectorAll<HTMLElement>('.identity-card')]
      .find(card => /missing-saved-pack/.test(card.textContent || ''))!
    const removeUnavailable = button(unavailableCard, /Remove Pack/)
    assert.equal(removeUnavailable.disabled, false)
    removeUnavailable.click(); await nextTick()
    assert.match(mounted.host.textContent || '', /1 selected/)
    const validCard = [...mounted.host.querySelectorAll<HTMLElement>('.identity-card')]
      .find(card => /Wars, Treaties & World Order/.test(card.textContent || ''))!
    assert.match(validCard.textContent || '', /Remove Pack/)
    button(mounted.host, /^Cancel$/).click(); await flush()
    assert.equal(mounted.puts.length, 0)
    assert.deepEqual(mounted.currentTopics.value, topicIds)
  } finally { mounted.unmount() }
})

test('save snapshots the draft and locks selection until the request resolves', async () => {
  const mounted = await mountPicker({ deferSave: true })
  try {
    button(mounted.host, /Apply to channel/).click(); await nextTick()
    button(mounted.host, /^No Formula/).click(); await nextTick()
    assert.deepEqual(mounted.puts[0], { slug: 'bounded-history', formulaId: INSTALLED_FORMULA.id, topicIds: [HISTORY_PACK.id] })
    assert.equal(mounted.savedEvents.length, 0)
    mounted.releaseSave(); await flush()
    assert.deepEqual(mounted.savedEvents[0], { formulaId: INSTALLED_FORMULA.id, topicPackIds: [HISTORY_PACK.id] })
  } finally { mounted.unmount() }
})

test('open refreshes both catalogues, finds a newly installed Formula, and preserves unavailable selections', async () => {
  const mounted = await mountPicker({
    formulaId: 'missing-saved-formula', topicIds: ['missing-saved-pack'], formulas: [LEGACY_FORMULA], topics: [],
    formulaError: new Error('catalog temporarily offline'), afterFormulaRefresh: [LEGACY_FORMULA, INSTALLED_FORMULA],
  })
  try {
    assert.deepEqual(mounted.refreshCounts(), { formula: 1, topic: 1 })
    assert.match(mounted.host.textContent || '', /Unavailable saved selection/)
    assert.match(mounted.host.textContent || '', /missing-saved-formula/)
    assert.match(mounted.host.textContent || '', /Library refresh failed: catalog temporarily offline/)
    button(mounted.host, /Topic Packs/).click(); await nextTick()
    assert.match(mounted.host.textContent || '', /missing-saved-pack/)
    assert.match(mounted.host.textContent || '', /1 selected/)
    button(mounted.host, /Formula/).click(); await nextTick()
    assert.match(mounted.host.textContent || '', /History Explained/)
    assert.equal(mounted.puts.length, 0)
  } finally { mounted.unmount() }
})

test('an initially visible modal initializes and gives search an accessible name', async () => {
  const mounted = await mountPicker({ initialVisible: true, formulaId: LEGACY_FORMULA.id })
  try {
    assert.match(mounted.host.textContent || '', /History Explained/)
    assert.equal(mounted.host.querySelector<HTMLInputElement>('input[type="search"]')?.getAttribute('aria-label'), 'Search Formulas')
    assert.deepEqual(mounted.refreshCounts(), { formula: 1, topic: 1 })
  } finally { mounted.unmount() }
})

test('narrow catalogues scroll from a late card to details and back to choices', async () => {
  const originalMatchMedia = window.matchMedia
  const originalScroll = HTMLElement.prototype.scrollIntoView
  const scrolled: string[] = []
  window.matchMedia = (() => ({ matches: true })) as any
  HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.className) }
  const formulas = Array.from({ length: 36 }, (_, index) => ({
    ...INSTALLED_FORMULA,
    id: `installed-formula-${index + 1}`,
    name: `Formula ${String(index + 1).padStart(2, '0')}`,
    catalogName: `Formula ${String(index + 1).padStart(2, '0')}`,
  }))
  const mounted = await mountPicker({ formulaId: formulas[0].id, formulas })
  try {
    const lastCard = [...mounted.host.querySelectorAll<HTMLElement>('.identity-card')].at(-1)!
    const detailTrigger = button(lastCard, /View Details/)
    detailTrigger.click(); await flush()
    assert.ok(scrolled.some(value => value.includes('identity-detail')))
    assert.equal(document.activeElement, mounted.host.querySelector('.identity-detail'))
    button(mounted.host, /Back to Choices/).click(); await nextTick()
    assert.ok(scrolled.some(value => value.includes('btn-ghost')))
    assert.equal(document.activeElement, detailTrigger)
  } finally {
    mounted.unmount()
    window.matchMedia = originalMatchMedia
    HTMLElement.prototype.scrollIntoView = originalScroll
  }
})
