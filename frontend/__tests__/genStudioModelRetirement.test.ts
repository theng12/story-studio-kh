/**
 * A model that is GOING has to be visible before it has GONE.
 *
 * GenStudio publishes a full retirement schedule on every row of
 * `GET /v1/chat/models` — the warning flag, when it opened, the internal
 * target, the provider's own shutdown, the date the product stops being
 * available to customers, and a recorded successor. Story Studio read none of
 * it. The picker's one retirement message fires from `syncModelSelection`,
 * which runs when a saved model can no longer be selected — i.e. after it has
 * already stopped working, which is the single moment a warning is worth
 * nothing.
 *
 * What the warning says is deliberately narrow: the date, and how far away that
 * date is. Not what to switch to. The picker's existing message already
 * promises "Story Studio will not switch products automatically", and naming
 * one successor would quietly steer the choice it promises to leave alone.
 *
 * These tests RENDER the real templates — ModelSelector's for the panel,
 * ModelMenu's for the badge — rather than grepping for a variable name, so
 * "it is displayed" is demonstrated rather than asserted.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { parse } from '@vue/compiler-sfc'
import {
  describeModelRetirement,
  formatRetirementCountdown,
  formatRetirementDate,
  isRetiring,
  collectConfiguredModelIds,
  retiringConfiguredModels,
  type ChannelCatalogRow,
} from '../utils/genstudio-model-retirement.js'
import { thumbnailVisionModelMenuOption } from '../utils/thumbnail-vision-model-menu.js'

const selectorPath = new URL('../components/ModelSelector.vue', import.meta.url)
const selectorSource = readFileSync(selectorPath, 'utf8')
const selectorTemplate = parse(selectorSource).descriptor.template?.content
assert.ok(selectorTemplate, 'ModelSelector.vue must have a template')

const menuPath = new URL('../components/ModelMenu.vue', import.meta.url)
const menuSource = readFileSync(menuPath, 'utf8')
const menuTemplate = parse(menuSource).descriptor.template?.content
assert.ok(menuTemplate, 'ModelMenu.vue must have a template')

/** Render a component's OWN template against supplied state, children stubbed. */
async function render(
  template: string,
  data: Record<string, unknown>,
  stubs: Record<string, string[]> = {},
): Promise<string> {
  const app = createSSRApp({
    template,
    data: () => data,
    methods: new Proxy({}, { get: () => () => {}, has: () => true }) as any,
  })
  app.config.warnHandler = () => {}
  for (const [name, props] of Object.entries(stubs)) {
    app.component(name, {
      props,
      template: name === 'PickerDialog' ? '<div><slot /></div>' : '<div class="stub" />',
    })
  }
  return await renderToString(app)
}

function renderSelector(state: Record<string, unknown>): Promise<string> {
  return render(selectorTemplate as string, {
    label: 'LLM model',
    loading: false,
    loadError: '',
    menuOptions: [],
    modelValue: 'm1',
    selectedDataDisclosure: '',
    selectedRetirementNotice: '',
    ...state,
  }, { ModelMenu: ['modelValue', 'options', 'loading'] })
}

function renderMenu(items: unknown[]): Promise<string> {
  return render(menuTemplate as string, {
    modelValue: 'm1',
    options: items,
    groupedOptions: [{ label: 'Language models', items }],
    expanded: true,
    query: '',
    searching: false,
    mediaType: 'llm',
    kindLabel: 'AI',
    title: 'Choose LLM model',
    placeholder: 'Pick an LLM model…',
    searchPlaceholder: 'Search LLM models…',
    ariaLabel: 'LLM model options',
    loading: false,
    loadingLabel: 'Loading models…',
    disabled: false,
    catalogNotice: '',
    catalogNoticeHref: '',
    emptyResultLabel: 'No models match.',
    selectedOption: items[0] ?? null,
    selectedAccessBadges: [],
    listEl: null,
    searchEl: null,
  }, {
    PickerDialog: ['open', 'title'],
    NuxtLink: ['to'],
  })
}

// Instants supplied the way GenStudio supplies them. Every date and every
// number this file asserts on is DERIVED from these two by the code under
// test — nothing here is a calendar date written into a string.
const NOW = Date.parse('2026-08-26T09:00:00Z')
const WITHDRAWN = '2026-10-15T00:00:00Z'
const EXPECTED_DAYS = Math.floor(Date.parse(WITHDRAWN) / 86_400_000) - Math.floor(NOW / 86_400_000)

const retiringRow = {
  id: 'm1',
  label: 'Catalog Row A',
  deprecation_warning: true,
  retires_at: WITHDRAWN,
  replacement_model_id: 'm2',
}
const healthyRow = { id: 'm2', label: 'Catalog Row B', deprecation_warning: false, retires_at: null }

// ── the panel ────────────────────────────────────────────────────────────

test('the warning renders in full beneath the selector for a retiring model', async () => {
  const notice = describeModelRetirement(retiringRow, NOW)
  const html = await renderSelector({ selectedRetirementNotice: notice })
  assert.match(html, /class="retirement-notice"/, 'the warning element is present')
  const text = html.replace(/<[^>]*>/g, '').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&')
  assert.ok(text.includes(notice), `the whole sentence reached the page: ${notice}`)
  assert.doesNotMatch(text, /…\s*$/, 'the warning must not be truncated')
})

test('the rendered warning carries the published date AND the distance to it', async () => {
  const html = await renderSelector({ selectedRetirementNotice: describeModelRetirement(retiringRow, NOW) })
  const text = html.replace(/<[^>]*>/g, '')
  // Both, derived from the served instant. A bare date makes the reader do the
  // arithmetic, and a reader who does not bother has learned nothing.
  assert.ok(text.includes(formatRetirementDate(Date.parse(WITHDRAWN))), 'the published date is on the page')
  assert.ok(text.includes(`${EXPECTED_DAYS} days from now`), 'so is how far away it is')
  assert.ok(EXPECTED_DAYS > 1, 'this fixture is a genuine future retirement')
})

test('the warning disappears for a model with no retirement', async () => {
  assert.equal(describeModelRetirement(healthyRow, NOW), '', 'nothing to say about a healthy product')
  const html = await renderSelector({ selectedRetirementNotice: describeModelRetirement(healthyRow, NOW) })
  assert.doesNotMatch(html, /retirement-notice/, 'it must not become permanent furniture')
})

test('the warning is body text and is never hidden behind a hover or a toggle', () => {
  const style = parse(selectorSource).descriptor.styles.map(block => block.content).join('\n')
  assert.match(style, /\.retirement-notice\s*\{[^}]*font-size:\s*var\(--font-md\)/, 'body size, not micro-copy')
  assert.doesNotMatch(style, /\.retirement-notice\s*\{[^}]*text-overflow:\s*ellipsis/)
  assert.doesNotMatch(style, /\.retirement-notice\s*\{[^}]*(-webkit-line-clamp|white-space:\s*nowrap)/)
  // A <p> in the flow, not a title= tooltip and not inside a <details>.
  assert.match(
    selectorTemplate as string,
    /<p v-if="selectedRetirementNotice" class="retirement-notice">\{\{ selectedRetirementNotice \}\}<\/p>/,
  )
})

// ── the badge ────────────────────────────────────────────────────────────

test('a retiring model is flagged in the list, before any row is opened', async () => {
  const html = await renderMenu([
    { ...retiringRow, badges: [{ label: 'Retiring', tone: 'warning', title: describeModelRetirement(retiringRow, NOW) }] },
  ])
  assert.match(html, /class="model-menu-badge"[^>]*data-tone="warning"/, 'the badge renders, in the warning tone')
  assert.match(html.replace(/<[^>]*>/g, ''), /Retiring/, 'and it says so in words')
})

test('a model with no retirement carries no badge', async () => {
  const html = await renderMenu([{ ...healthyRow, id: 'm1', badges: [] }])
  assert.doesNotMatch(html, /model-menu-badge/, 'no badge element at all')
  assert.doesNotMatch(html.replace(/<[^>]*>/g, ''), /Retiring/)
})

test('the picker builds that badge from the published flag, not from a date it read', () => {
  assert.match(selectorSource, /isRetiring\(model\)/, 'the badge is gated on the Gateway\'s own flag')
  assert.match(selectorSource, /label: 'Retiring'/)
  assert.match(selectorSource, /title: describeModelRetirement\(model\)/, 'the badge carries the sentence')
  assert.match(
    selectorSource,
    /const selectedRetirementNotice = computed\(\(\) => describeModelRetirement\(/,
    'the panel is fed by the same function',
  )
})

// ── the countdown ────────────────────────────────────────────────────────

test('the countdown is whole days, and reads naturally at the boundaries', () => {
  const day = 86_400_000
  const at = (offsetDays: number) => formatRetirementCountdown(NOW + offsetDays * day, NOW)
  assert.equal(at(50), '50 days from now')
  assert.equal(at(1), 'tomorrow')
  assert.equal(at(0), 'today')
  assert.equal(at(-1), 'yesterday')
  assert.equal(at(-3), '3 days ago')
})

test('a date already past is described in the past tense', () => {
  const past = { ...retiringRow, retires_at: '2026-01-05T00:00:00Z' }
  const notice = describeModelRetirement(past, NOW)
  assert.match(notice, /stopped being available/, 'not "stops" — it already has')
  assert.match(notice, /days ago/)
})

test('an open warning window with no published date still warns, and invents nothing', () => {
  const notice = describeModelRetirement({ label: 'Catalog Row A', deprecation_warning: true, retires_at: null }, NOW)
  assert.match(notice, /scheduled for retirement/, 'the flag alone is a published fact worth saying')
  assert.match(notice, /has not published the date/, 'and the absence is stated, not filled in')
  assert.doesNotMatch(notice, /\d{4}/, 'no year, because no date was published')
})

test('the warning window is the Gateway\'s call — a date alone never opens it', () => {
  // How much notice a customer gets is GenStudio's decision. Re-deriving the
  // window from `retires_at` would be a second policy, and it would disagree
  // with GenStudio's the first time GenStudio moved a date.
  const quiet = { label: 'Catalog Row A', deprecation_warning: false, retires_at: WITHDRAWN }
  assert.equal(describeModelRetirement(quiet, NOW), '')
  assert.equal(isRetiring(quiet), false)
})

test('the published instant is rendered as the day the Gateway published, not the reader\'s', () => {
  // An instant near midnight UTC lands on the previous calendar day in any
  // western timezone. A withdrawal date that is a day out is worse than none.
  const lateNight = Date.parse('2026-10-15T23:30:00Z')
  assert.match(formatRetirementDate(lateNight), /15 October 2026/)
})

// ── what it deliberately does not say ────────────────────────────────────

test('no successor is ever named to the customer', () => {
  // The field is carried through the client and the /api/models whitelist on
  // purpose — dropping it at the transport layer is a separate decision, and a
  // change of mind should be a UI change rather than a plumbing change. But no
  // display reads it, because the picker promises not to steer the choice.
  const notice = describeModelRetirement(retiringRow, NOW)
  assert.doesNotMatch(notice, /replacement|successor|m2|Catalog Row B/i)
  const util = readFileSync(new URL('../utils/genstudio-model-retirement.ts', import.meta.url), 'utf8')
  const code = util.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
  assert.doesNotMatch(code, /replacement_model_id/, 'the display layer does not even read the field')
})

test('no date, id or countdown is written into the app — all of it is served', () => {
  for (const [name, text] of [['util', readFileSync(new URL('../utils/genstudio-model-retirement.ts', import.meta.url), 'utf8')], ['selector', selectorSource]] as const) {
    const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    assert.doesNotMatch(code, /20\d\d-\d\d-\d\d/, `${name} must not contain a calendar date`)
    assert.doesNotMatch(code, /October|November|December/i, `${name} must not name a month`)
  }
})

// ── where the consequence actually lands ─────────────────────────────────
//
// The picker warns whoever is choosing a model right now. A channel configured
// months ago is nobody's current choice, and its owner has no reason to reopen
// the picker before the date passes — so the same published schedule has to be
// checked against what the channel already saved.

const catalog: ChannelCatalogRow[] = [
  { id: 'm1', label: 'Catalog Row A', deprecation_warning: true, retires_at: WITHDRAWN },
  { id: 'm2', label: 'Catalog Row B', deprecation_warning: false, retires_at: null },
  { id: 'm3', label: 'Catalog Row C', deprecation_warning: true, retires_at: '2026-09-01T00:00:00Z' },
]

test('a model id is found wherever a channel happened to save it', () => {
  // Four real shapes, all in use at once: a bare scalar, a per-page remembered
  // id, `model` inside a saved preset, and `form.model` a level deeper. No page
  // agreed with any other page on where to put it.
  const config = {
    prompt_model: 'm1',
    idea_generator_last_model: 'm2',
    metadata_presets: [{ id: 'p1', name: 'Default', data: { model: 'm3' } }],
    script_presets: [{ id: 'p2', name: 'Long', data: { form: { model: 'm1', tone: 'calm' } } }],
  }
  const ids = collectConfiguredModelIds(config).sort()
  assert.deepEqual([...new Set(ids)], ['m1', 'm2', 'm3'])
})

test('the channel is warned about the models it already uses, soonest first', () => {
  const config = { prompt_model: 'm1', script_presets: [{ data: { form: { model: 'm3' } } }] }
  const hits = retiringConfiguredModels(config, catalog, NOW)
  assert.deepEqual(hits.map(hit => hit.id), ['m3', 'm1'], 'the nearer deadline is read first')
  assert.match(hits[0].notice, /Catalog Row C stops being available/)
  assert.match(hits[1].notice, new RegExp(`${EXPECTED_DAYS} days from now`))
})

test('one model saved in five places is one problem, not five', () => {
  const config = {
    prompt_model: 'm1',
    a_presets: [{ data: { model: 'm1' } }, { data: { form: { model: 'm1' } } }],
    b_presets: [{ data: { source_model: 'm1' } }],
    nested: { deeper: { thumbnail_model: 'm1' } },
  }
  assert.equal(retiringConfiguredModels(config, catalog, NOW).length, 1)
})

test('a channel using only healthy models is left alone', () => {
  assert.deepEqual(retiringConfiguredModels({ prompt_model: 'm2' }, catalog, NOW), [])
  assert.deepEqual(retiringConfiguredModels({}, catalog, NOW), [])
  assert.deepEqual(retiringConfiguredModels(null, catalog, NOW), [])
})

test('an id from another catalogue matches nothing, rather than warning wrongly', () => {
  // The walk is structural, so it also picks up image and voice ids. They match
  // no chat row and fall out — the check doing its job, not a gap.
  const config = { image_model: 'some-image-product', voice_model: 'some-voice-product' }
  assert.ok(collectConfiguredModelIds(config).length > 0, 'they are collected')
  assert.deepEqual(retiringConfiguredModels(config, catalog, NOW), [], 'and then matched away')
})

test('a legacy id saved before a rename still finds its row', () => {
  const renamed: ChannelCatalogRow[] = [
    { id: 'm9', label: 'Catalog Row D', legacy_ids: ['old-handle'], deprecation_warning: true, retires_at: WITHDRAWN },
  ]
  assert.equal(retiringConfiguredModels({ prompt_model: 'old-handle' }, renamed, NOW).length, 1)
})

test('a deeply nested config cannot hang the check', () => {
  let deep: any = { model: 'm1' }
  for (let i = 0; i < 200; i += 1) deep = { nest: deep }
  assert.deepEqual(collectConfiguredModelIds(deep), [], 'the walk is bounded')
})

test('the channel check reads the published flag, and nothing local', () => {
  const composable = readFileSync(new URL('../composables/useNotifications.js'.replace('.js', '.ts'), import.meta.url), 'utf8')
  assert.match(composable, /retiringConfiguredModels\(config, catalog\)/, 'it is wired into the readiness pass')
  assert.match(composable, /key: 'model-retirement'/)
  assert.match(composable, /removeItem\(slug, 'model-retirement'\)/, 'and it clears once the channel moves off')
  const code = composable.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
  assert.doesNotMatch(code, /20\d\d-\d\d-\d\d/, 'no date is written into the check')
})

test('listing several models says what to do once, not after every line', () => {
  // The picker warns about one model and ends with what to do about it. A
  // channel warning lists two or three, and repeating the advice after each
  // one turns the warning into a wall the reader skims — which costs exactly
  // the attention it exists to buy.
  const single = describeModelRetirement(retiringRow, NOW)
  assert.match(single, /Choose another model before then\./, 'the picker keeps its advice')
  const listed = retiringConfiguredModels({ prompt_model: 'm1' }, catalog, NOW)[0].notice
  assert.doesNotMatch(listed, /Choose another model/, 'the list drops it')
  // Both still carry the two facts that matter.
  for (const text of [single, listed]) {
    assert.ok(text.includes(formatRetirementDate(Date.parse(WITHDRAWN))))
    assert.ok(text.includes(`${EXPECTED_DAYS} days from now`))
  }
})

// ── the second picker ────────────────────────────────────────────────────
//
// The thumbnail-reference menu is a SECOND place a customer commits to a chat
// product, fed by its own route with its own field whitelist. A whitelist that
// forwards prices but not the withdrawal date is exactly how this went
// unnoticed for weeks the first time.

test('the thumbnail vision menu flags a retiring model too', () => {
  const option = thumbnailVisionModelMenuOption({
    id: 'm1',
    display_name: 'Catalog Row A',
    supported_detail_levels: ['auto'],
    max_input_images: 1,
    accepted_image_mime_types: ['image/png'],
    max_image_bytes: 1_000,
    max_image_dimension: 1_000,
    minimum_credits: 0,
    price_version: 'v1',
    deprecation_warning: true,
    retires_at: WITHDRAWN,
  }, { now: NOW })
  const badge = option.badges.find(entry => entry.label === 'Retiring')
  assert.ok(badge, 'the badge is offered alongside Vision and JSON')
  assert.ok(badge.title?.includes('Catalog Row A'), 'named by its display name')
  assert.ok(badge.title?.includes(`${EXPECTED_DAYS} days from now`), 'with the countdown')
})

test('the thumbnail vision menu leaves a healthy model unbadged', () => {
  const option = thumbnailVisionModelMenuOption({
    id: 'm2',
    display_name: 'Catalog Row B',
    supported_detail_levels: ['auto'],
    max_input_images: 1,
    accepted_image_mime_types: ['image/png'],
    max_image_bytes: 1_000,
    max_image_dimension: 1_000,
    minimum_credits: 0,
    price_version: 'v1',
  })
  assert.deepEqual(option.badges.map(entry => entry.label), ['Vision', 'JSON'])
})

test('a catalogue id never reaches the screen, even for an unnamed row', () => {
  // The label feeds the notification title. An id is an internal handle, and
  // the whole module refuses to print one — an unnamed row reads the same way
  // its sentence does rather than leaking `catalog-row-a` into a heading.
  const unnamed: ChannelCatalogRow[] = [{ id: 'internal-handle-xyz', deprecation_warning: true, retires_at: WITHDRAWN }]
  const [hit] = retiringConfiguredModels({ prompt_model: 'internal-handle-xyz' }, unnamed, NOW)
  assert.equal(hit.label, 'This model')
  assert.doesNotMatch(hit.label, /internal-handle/)
  assert.doesNotMatch(hit.notice, /internal-handle/)
})
