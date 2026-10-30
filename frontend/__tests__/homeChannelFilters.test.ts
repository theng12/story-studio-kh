/**
 * The start page's channel search, label chips, labelling and sort — wired, on
 * the real page (compiled from `pages/index.vue` and mounted with a fake API).
 *
 * `channelView.test.ts` pins the logic; this pins that the page is actually
 * connected to it, because that is where the defects live: a control that
 * writes to a ref nobody reads, a chip that filters the counts instead of the
 * grid, a remembered preference that is written and never read back.
 *
 * The label editor is the REAL `components/ChipInput.vue`, compiled the same
 * way, so the whole path is exercised — type a label, save, watch the card
 * change and the request carry the normalised list.
 *
 * What it cannot see: real CSS geometry, so the layout is checked by hand at
 * 1440 and 390 px (screenshots in the release evidence).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

/** Compile one real SFC for the test, with the Nuxt auto-imports it relies on. */
async function loadComponent(file: string, id: string, support: string) {
  const filename = fileURLToPath(new URL(file, import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id })
  const template = compileTemplate({
    source: descriptor.template!.content, filename, id,
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const util = (name: string) => JSON.stringify(new URL(`../utils/${name}.ts`, import.meta.url).href)
  const shared = (name: string) => JSON.stringify(new URL(`../../electron/server/contracts/${name}.ts`, import.meta.url).href)
  const scriptCode = script.content
    .replace("'~/utils/project-slug'", util('project-slug'))
    .replace("'~/utils/last-known-list'", util('last-known-list'))
    .replace("'~/utils/channel-view'", util('channel-view'))
    // `@shared/*` has no import map inside a data: module — point the page's
    // slug rule (the same module the server uses) at the real file.
    .replace("'@shared/project-slug'", shared('project-slug'))
    .replace('export default', 'const __sfc__ =')
  const code = `${support}\n${scriptCode}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
}

const VUE_RUNTIME = JSON.stringify(await import.meta.resolve('vue'))

let pageComponent: Promise<any> | undefined
function loadPage() {
  pageComponent ??= loadComponent('../pages/index.vue', 'home-filters-test', `
      import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from ${VUE_RUNTIME}
      const useApi = () => globalThis.__homeHarness.api
      const useAppSettingsModal = () => ({ open() {} })
      const useAppTitle = () => {}
      const useSoftDeletedProjects = () => globalThis.__homeHarness.hidden
      const navigateTo = async () => {}
    `)
  return pageComponent
}

let chipInputComponent: Promise<any> | undefined
function loadChipInput() {
  chipInputComponent ??= loadComponent('../components/ChipInput.vue', 'chip-input-test', `
      import { computed, onBeforeUnmount, onMounted, ref } from ${VUE_RUNTIME}
    `)
  return chipInputComponent
}

const NuxtLinkStub = defineComponent({
  props: { to: { type: String, default: '' } },
  setup(props, { slots, attrs }) { return () => h('a', { href: props.to, class: attrs.class }, slots.default?.()) },
})
/** Renders its slot only while visible, so "the dialog opened" is observable. */
const ModalStub = defineComponent({
  props: { visible: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () => props.visible ? h('div', { class: 'modal-dialog', role: 'dialog' }, slots.default?.()) : null
  },
})

const KHMER = 'ខ្មែរ'

const CHANNELS = [
  { slug: 'khmer-history', name: 'Khmer History', episode_prefix: 'KH', has_api_keys: true, output_root_exists: true,
    labels: ['Khmer', 'History'], content_language: 'km', created_at: '2026-01-02T00:00:00Z', last_worked_at: '2026-03-01T00:00:00Z' },
  { slug: 'sleep-stories', name: 'Sleep Stories', episode_prefix: 'SL', has_api_keys: true, output_root_exists: true,
    labels: ['Sleep'], content_language: 'en', created_at: '2026-02-02T00:00:00Z', last_worked_at: '2026-04-01T00:00:00Z' },
  { slug: 'khmer-sleep', name: 'Khmer Sleep', episode_prefix: 'KS', has_api_keys: true, output_root_exists: true,
    labels: ['Khmer', 'Sleep'], content_language: 'km', created_at: '2026-03-02T00:00:00Z', last_worked_at: '2026-02-01T00:00:00Z' },
  { slug: 'animals', name: 'Animals Explained', episode_prefix: 'AN', has_api_keys: true, output_root_exists: true,
    labels: [], created_at: '2025-12-02T00:00:00Z', last_worked_at: null },
]

/** Two channels, one of them named and labelled in Khmer script. */
const KHMER_CHANNELS = [
  { slug: 'khmer-folktales', name: 'រឿងនិទានខ្មែរ', episode_prefix: 'KF', has_api_keys: true, output_root_exists: true,
    labels: [KHMER], content_language: 'km', created_at: '2026-01-01T00:00:00Z', last_worked_at: '2026-01-01T00:00:00Z' },
  { slug: 'plain', name: 'Plain Channel', episode_prefix: 'PL', has_api_keys: true, output_root_exists: true,
    labels: [], created_at: '2026-01-01T00:00:00Z', last_worked_at: '2026-01-01T00:00:00Z' },
]

async function flush() {
  for (let i = 0; i < 4; i++) { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)) }
}

async function mountHome(
  list: any[] = CHANNELS,
  { put }: { put?: (path: string, body: any) => Promise<any> } = {},
) {
  const puts: Array<{ path: string; body: any }> = []
  // Own copy per mount: the page writes a saved label list back into its row, and
  // a shared fixture would carry one test's save into the next one's dialog.
  const rows = structuredClone(list)
  ;(globalThis as any).__homeHarness = {
    api: {
      get: (path: string) => {
        if (path === '/projects') return Promise.resolve(rows)
        // Counts and channel profiles are second reads; this page's business is
        // the list itself.
        return Promise.reject(new Error(`unexpected GET ${path}`))
      },
      post: async () => ({}),
      put: async (path: string, body: any) => {
        puts.push({ path, body })
        if (put) return put(path, body)
        return { labels: body?.labels ?? [] }
      },
      del: async () => ({}),
    },
    hidden: { items: ref([]), lastError: ref(''), refresh: async () => {}, restore: async () => true },
  }
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(await loadPage())
  app.component('NuxtLink', NuxtLinkStub)
  app.component('Modal', ModalStub)
  app.component('ChipInput', await loadChipInput())
  for (const name of ['NichePicker', 'LoadingSpinner']) {
    app.component(name, defineComponent({ setup(_p, { slots }) { return () => h('div', slots.default?.()) } }))
  }
  app.mount(host)
  await flush()

  const titles = () => [...host.querySelectorAll('.project-grid .project-card-wrap strong')].map(node => node.textContent)
  const input = () => host.querySelector('#channel-search') as HTMLInputElement
  const sortSelect = () => host.querySelector('#channel-sort') as HTMLSelectElement
  const chips = () => [...host.querySelectorAll('.channel-label-filter .label-chip')] as HTMLElement[]
  const chip = (label: string) => chips().find(node => node.textContent?.startsWith(label))!
  const type = async (value: string) => {
    const field = input()
    field.value = value
    field.dispatchEvent(new Event('input'))
    await flush()
  }
  const chooseSort = async (value: string) => {
    const select = sortSelect()
    select.value = value
    select.dispatchEvent(new Event('change'))
    await flush()
  }
  const labelsAction = (name: string) => [...host.querySelectorAll('.project-label-action')]
    .find(node => node.closest('.project-card-wrap')!.querySelector('strong')!.textContent === name) as HTMLElement
  const dialog = () => host.querySelector('.modal-dialog[role="dialog"]') as HTMLElement | null
  /** Type a label into the real ChipInput and press Enter, as a person would. */
  const addLabel = async (label: string) => {
    const field = dialog()!.querySelector('.chip-field') as HTMLInputElement
    field.value = label
    field.dispatchEvent(new Event('input'))
    await flush()
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flush()
  }
  const saveButton = () => [...dialog()!.querySelectorAll('button')]
    .find(node => /Save labels/.test(node.textContent || '')) as HTMLButtonElement
  const saveLabels = async () => {
    saveButton().click()
    await flush()
  }
  return {
    host, puts, titles, input, sortSelect, chips, chip, type, chooseSort,
    labelsAction, dialog, addLabel, saveButton, saveLabels,
  }
}

/** A channel list where each card carries the Formula the backend resolved. */
const FORMULA_CHANNELS = [
  { slug: 'daily-devotional', name: 'Daily Devotional', episode_prefix: 'DD', has_api_keys: true, output_root_exists: true,
    labels: [], created_at: '2026-01-01T00:00:00Z', last_worked_at: '2026-05-01T00:00:00Z',
    niche_id: 'devotional', formula_id: 'com.storystudio.formula.pastoral-scripture', formula_name: 'Pastoral Scripture' },
  { slug: 'quiet-rain', name: 'Quiet Rain', episode_prefix: 'QR', has_api_keys: true, output_root_exists: true,
    labels: [], created_at: '2026-01-02T00:00:00Z', last_worked_at: '2026-04-01T00:00:00Z',
    formula_choice: 'generic', formula_name: 'Generic — no Formula' },
  { slug: 'brand-new', name: 'Brand New', episode_prefix: 'BN', has_api_keys: true, output_root_exists: true,
    labels: [], created_at: '2026-01-03T00:00:00Z', last_worked_at: '2026-03-01T00:00:00Z',
    formula_name: 'No Formula chosen' },
  { slug: 'old-cache-row', name: 'Old Cache Row', episode_prefix: 'OC', has_api_keys: true, output_root_exists: true,
    labels: [], created_at: '2026-01-04T00:00:00Z', last_worked_at: '2026-02-01T00:00:00Z' },
]

describe('the Series Formula on a card, and what "recent" measures', () => {
  beforeEach(() => { localStorage.clear() })

  test('each card shows its Formula by name, and the two no-Formula answers stay distinct', async () => {
    const h = await mountHome(FORMULA_CHANNELS)
    const formulaTags = () => [...h.host.querySelectorAll('.project-tag[data-kind="formula"]')].map(node => node.textContent)
    assert.deepEqual(formulaTags(), ['Pastoral Scripture', 'Generic — no Formula', 'No Formula chosen'])

    // A row painted from an older cache carries no Formula name. Unknown is not
    // "No Formula chosen", so that card says nothing rather than guessing.
    const cached = [...h.host.querySelectorAll('.project-card-wrap')]
      .find(node => node.querySelector('strong')!.textContent === 'Old Cache Row')!
    assert.equal(cached.querySelector('.project-tag[data-kind="formula"]'), null)
  })

  test('typing the Formula name finds the channels that use it', async () => {
    const h = await mountHome(FORMULA_CHANNELS)
    await h.type('pastoral')
    assert.deepEqual(h.titles(), ['Daily Devotional'])

    await h.type('no formula')
    assert.deepEqual(h.titles(), ['Quiet Rain', 'Brand New'], 'both honest no-Formula states are findable by what they say')
  })

  test('the sort control says what "recently worked on" actually measures', async () => {
    const h = await mountHome(FORMULA_CHANNELS)
    assert.match(h.sortSelect().getAttribute('title') || '', /inside episodes/i,
      'the tooltip names the episode tree, because the label alone cannot say it')

    await h.chooseSort('newest')
    assert.match(h.sortSelect().getAttribute('title') || '', /created/i,
      'and it follows the chosen sort, so it is never describing the wrong one')
  })
})

describe('the channel list can be searched, filtered and sorted', () => {
  beforeEach(() => { localStorage.clear() })

  test('the list opens in the recently-worked-on order, and says so', async () => {
    const h = await mountHome()
    assert.equal(h.sortSelect().value, 'recent')
    assert.deepEqual(h.titles(), ['Sleep Stories', 'Khmer History', 'Khmer Sleep', 'Animals Explained'])
    assert.equal(h.titles()[3], 'Animals Explained', 'a channel with no readable time is last, never first')
  })

  test('typing filters the grid by name, and clearing brings everything back', async () => {
    const h = await mountHome()
    await h.type('sleep')
    assert.deepEqual(h.titles(), ['Sleep Stories', 'Khmer Sleep'])
    assert.match(h.host.querySelector('.channels-head')!.textContent!, /2 of 4 channels/)

    await h.type('')
    assert.equal(h.titles().length, 4)
    assert.match(h.host.querySelector('.channels-head')!.textContent!, /4 channels/)
  })

  test('KHMER text finds Khmer channels, with or without the zero-width characters a paste carries', async () => {
    const h = await mountHome(KHMER_CHANNELS)
    await h.type(KHMER)
    assert.deepEqual(h.titles(), ['រឿងនិទានខ្មែរ'], 'typed by hand, against a name and a label in Khmer')

    // The same search with a zero-width space inside it, which is what Khmer
    // text copied out of a document looks like. It must not make the match fail.
    await h.type(KHMER.replace('ខ', 'ខ​'))
    assert.deepEqual(h.titles(), ['រឿងនិទានខ្មែរ'])
  })

  test('the language a card shows is searchable, and is not repeated beside an identical label', async () => {
    const h = await mountHome()
    const languageTags = [...h.host.querySelectorAll('.project-tag[data-kind="language"]')].map(node => node.textContent)
    assert.deepEqual(languageTags, ['English'],
      'the Khmer channels are labelled "Khmer", so saying it twice would be noise — not a second fact')

    // It is still indexed: the language word finds the channel either way.
    await h.type('english')
    assert.deepEqual(h.titles(), ['Sleep Stories'])
    await h.type('khmer')
    assert.deepEqual(h.titles(), ['Khmer History', 'Khmer Sleep'])
  })

  test('label chips carry counts, and several at once mean ALL of them', async () => {
    const h = await mountHome()
    assert.deepEqual(h.chips().map(node => node.textContent?.replace(/\s+/g, ' ').trim()), [
      'History 1', 'Khmer 2', 'Sleep 2',
    ])

    h.chip('Khmer').click()
    await flush()
    assert.deepEqual(h.titles(), ['Khmer History', 'Khmer Sleep'])
    assert.equal(h.chip('Khmer').getAttribute('aria-pressed'), 'true')

    h.chip('Sleep').click()
    await flush()
    assert.deepEqual(h.titles(), ['Khmer Sleep'])

    // Clicking the selected chip again releases it.
    h.chip('Sleep').click()
    await flush()
    assert.deepEqual(h.titles(), ['Khmer History', 'Khmer Sleep'])
  })

  test('the chips count what the search leaves, so a chip cannot promise a channel the grid will not show', async () => {
    const h = await mountHome()
    await h.type('khmer')
    assert.deepEqual(h.chips().map(node => node.textContent?.replace(/\s+/g, ' ').trim()), [
      'History 1', 'Khmer 2', 'Sleep 1',
    ])
  })

  test('search and labels narrow together', async () => {
    const h = await mountHome()
    await h.type('khmer')
    h.chip('Sleep').click()
    await flush()
    assert.deepEqual(h.titles(), ['Khmer Sleep'])
  })

  test('no match is a state with a way out, not an empty grid', async () => {
    const h = await mountHome()
    await h.type('nothing like this')
    assert.equal(h.titles().length, 0)
    const noMatch = h.host.querySelector('.channel-no-match')!
    assert.match(noMatch.textContent!, /No channels match/)
    assert.match(noMatch.textContent!, /nothing like this/)

    ;(noMatch.querySelector('button') as HTMLElement).click()
    await flush()
    assert.equal(h.titles().length, 4, 'clearing the filters brings the list back')
    assert.equal(h.input().value, '')
  })

  test('the sort select reorders the same set, four ways', async () => {
    const h = await mountHome()
    await h.chooseSort('name')
    assert.deepEqual(h.titles(), ['Animals Explained', 'Khmer History', 'Khmer Sleep', 'Sleep Stories'])
    await h.chooseSort('newest')
    assert.deepEqual(h.titles(), ['Khmer Sleep', 'Sleep Stories', 'Khmer History', 'Animals Explained'])
    await h.chooseSort('oldest')
    assert.deepEqual(h.titles(), ['Animals Explained', 'Khmer History', 'Sleep Stories', 'Khmer Sleep'])
    await h.chooseSort('recent')
    assert.deepEqual(h.titles(), ['Sleep Stories', 'Khmer History', 'Khmer Sleep', 'Animals Explained'])
  })

  test('the sort and the label filter are remembered; the search is not', async () => {
    const first = await mountHome()
    await first.chooseSort('oldest')
    await first.type('khmer')
    first.chip('History').click()
    await flush()

    const stored = localStorage.getItem('story_studio_channel_view')!
    assert.match(stored, /oldest/)
    assert.match(stored, /History/)
    assert.doesNotMatch(stored, /khmer/, 'the search text is never stored')

    const second = await mountHome()
    assert.equal(second.sortSelect().value, 'oldest')
    assert.equal(second.chip('History').getAttribute('aria-pressed'), 'true')
    assert.equal(second.input().value, '', 'the search box starts empty every time')
    assert.deepEqual(second.titles(), ['Khmer History'])
  })

  test('a remembered filter for a label no channel has any more is still shown, and can be undone', async () => {
    localStorage.setItem('story_studio_channel_view', JSON.stringify({ sort: 'recent', labels: ['Retired'] }))
    const h = await mountHome()
    assert.equal(h.chip('Retired').getAttribute('aria-pressed'), 'true')
    assert.equal(h.chip('Retired').textContent?.replace(/\s+/g, ' ').trim(), 'Retired 0')
    assert.equal(h.titles().length, 0, 'no channel carries it, so nothing matches')

    h.chip('Retired').click()
    await flush()
    assert.equal(h.titles().length, 4)
  })

  test('"/" focuses the search, and is ignored while a person is typing', async () => {
    const h = await mountHome()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }))
    assert.equal(document.activeElement === h.input(), true, 'the search took focus')

    // From inside a text field, "/" is a character.
    const outside = document.body.appendChild(document.createElement('input'))
    outside.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }))
    assert.equal(document.activeElement === outside, true, 'typing was not interrupted')
    outside.remove()
  })
})

describe('labelling a channel from its card', () => {
  beforeEach(() => { localStorage.clear() })

  test('the card offers Labels, and says how many it has', async () => {
    const h = await mountHome()
    assert.equal(h.labelsAction('Animals Explained').textContent, 'Labels', 'no count while there are none')
    assert.equal(h.labelsAction('Khmer History').textContent, 'Labels · 2', 'a card with labels says how many')
    assert.equal(h.dialog(), null, 'nothing is open until it is asked for')
  })

  test('a label typed into the dialog is saved through the project, and the card changes at once', async () => {
    const h = await mountHome()
    h.labelsAction('Animals Explained').click()
    await flush()
    assert.match(h.dialog()!.textContent!, /Labels for Animals Explained/)
    assert.equal(h.chip('Khmer').getAttribute('aria-pressed'), 'false', 'the list is not filtered by opening a dialog')

    await h.addLabel('Animals')
    await h.saveLabels()

    assert.deepEqual(h.puts, [{ path: '/projects/animals', body: { labels: ['Animals'] } }])
    assert.equal(h.dialog(), null, 'the dialog closes on a save that landed')
    assert.equal(h.labelsAction('Animals Explained').textContent, 'Labels · 1')
    assert.match(h.labelsAction('Animals Explained').closest('.project-card-wrap')!.textContent!, /Animals/)
  })

  test('a second spelling of a label the channel already has is not a change, so it sends nothing', async () => {
    const h = await mountHome()
    h.labelsAction('Sleep Stories').click()
    await flush()
    await h.addLabel('sleep')

    // The chip was added, but the normalised list is the one already stored:
    // "Sleep" and "sleep" are one label, and the first spelling is the one kept.
    assert.equal(h.saveButton().disabled, true, 'there is nothing to save')
    await h.saveLabels()
    assert.deepEqual(h.puts, [], 'no request was made for a save that changes nothing')
  })

  test('a save the server refuses keeps the dialog open with the server\'s own words', async () => {
    const h = await mountHome(CHANNELS, {
      put: async () => {
        throw Object.assign(new Error('bad request'), { data: { detail: 'a label can be at most 40 characters' } })
      },
    })
    h.labelsAction('Animals Explained').click()
    await flush()
    await h.addLabel('Animals')
    await h.saveLabels()

    assert.match(h.dialog()!.textContent!, /a label can be at most 40 characters/)
    assert.equal(h.labelsAction('Animals Explained').textContent, 'Labels', 'nothing changed on the card')
  })

  test('the card stays one link, with Edit profile and Labels as its own action row', async () => {
    const h = await mountHome()
    const card = h.host.querySelector('a[href="/projects/khmer-history"]') as HTMLElement
    assert.equal(card.querySelectorAll('button, a').length, 0, 'a link inside a link is a trap')

    // v1.4.371 — the card body carries the Formula and (unless a label already
    // says it) the language; the labels themselves live in the card's action
    // row, where you label channels in a row and compare them.
    const facts = card.querySelector('.project-facts')!
    assert.ok(facts, 'the Formula and language sit on one line')
    assert.equal(card.querySelectorAll('.project-tag[data-kind="language"]').length, 0,
      'the Khmer channel is labelled "Khmer", so the language is not repeated')
    const wrap = card.closest('.project-card-wrap') as HTMLElement
    assert.match(wrap.querySelector('.project-card-actions')!.textContent || '', /Edit profile/)
    assert.equal(h.labelsAction('Khmer History').textContent, 'Labels · 2')
  })
})
