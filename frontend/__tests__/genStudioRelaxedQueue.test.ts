/**
 * The relaxed shelf, and the promise that opens it.
 *
 * GenStudio sells some language products twice: once on the direct queue, and
 * once — cheaper — on a slower one. Until now the only trace of that in Story
 * Studio was the words "(Relaxed Queue)" inside a display name, which is copy
 * the owner edits in Studio Control. A picker that grouped by searching for
 * that phrase would have regrouped itself, silently and on live, the next time
 * he reworded a product. `queue_class` makes the decision data.
 *
 * Three things are asserted here, and one of them matters more than the other
 * two:
 *
 *   1. The shelf renders as its own section, after the direct catalogue, with
 *      the discounted price beside the struck-through full price.
 *   2. GenStudio's own hint renders ONCE for the section, carrying its
 *      percentage, its threshold in dollars, and its sentence. None of the
 *      three exists in this app — not as a default, not as a fallback.
 *   3. The deployed API does NOT serve these fields yet. A catalogue without
 *      them must look EXACTLY as it does today: one section, no heading that
 *      was not there before, no note. That is the test that will fail first if
 *      any of this is built on a default rather than on what was published.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { parse } from '@vue/compiler-sfc'
import {
  RELAXED_QUEUE_GROUP_LABEL,
  describeRelaxedQueueHint,
  groupMenuOptions,
  isRelaxedQueue,
  queueClassGroupLabel,
} from '../utils/genstudio-relaxed-queue.js'
import { describeChatRate, describeVoiceRate } from '../utils/genstudio-credit-cost.js'
import { thumbnailVisionModelMenuOption } from '../utils/thumbnail-vision-model-menu.js'

const menuSource = readFileSync(new URL('../components/ModelMenu.vue', import.meta.url), 'utf8')
const menuTemplate = parse(menuSource).descriptor.template?.content
assert.ok(menuTemplate, 'ModelMenu.vue must have a template')
const selectorSource = readFileSync(new URL('../components/ModelSelector.vue', import.meta.url), 'utf8')
const researchSource = readFileSync(new URL('../pages/projects/[slug]/research.vue', import.meta.url), 'utf8')
const audioSource = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
const relaxedSource = readFileSync(new URL('../utils/genstudio-relaxed-queue.ts', import.meta.url), 'utf8')

/**
 * A hint exactly as GenStudio sends one. Every figure asserted below is
 * DERIVED from this object by the code under test — no percentage and no
 * dollar amount is written into an assertion as a literal, because a test that
 * pinned either would re-create the constant this whole change exists to
 * remove.
 */
const HINT = {
  discount_percent: 42.5,
  unlock_threshold_cents: 7_500,
  message: 'The owner’s own sentence about the slower queue, containing no figures of its own.',
}

function renderMenu(sections: unknown[]): Promise<string> {
  const app = createSSRApp({
    template: menuTemplate as string,
    data: () => ({
      modelValue: 'm1',
      options: sections.flatMap((section: any) => section.items),
      groupedOptions: sections,
      expanded: true,
      query: '',
      searching: false,
      tierMode: false,
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
      selectedOption: null,
      selectedAccessBadges: [],
      activeTier: 'economy',
      tierPanelId: 'model-menu-tier-results',
      activeTierTabId: 'tier-economy',
      listEl: null,
      searchEl: null,
      tierTabsEl: null,
    }),
    methods: new Proxy({}, { get: () => () => {}, has: () => true }) as any,
  })
  app.config.warnHandler = () => {}
  app.component('PickerDialog', { props: ['open', 'title'], template: '<div><slot /></div>' })
  app.component('NuxtLink', { props: ['to'], template: '<a><slot /></a>' })
  return renderToString(app)
}

const strip = (html: string): string => html
  .replace(/<[^>]*>/g, ' ')
  .replace(/&#39;|&#x27;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')

// ── 1. The shelf is data, never a phrase in a name ────────────────────────

test('only an explicit queue_class puts a product on the relaxed shelf', () => {
  assert.equal(isRelaxedQueue({ queue_class: 'relaxed' }), true)
  assert.equal(isRelaxedQueue({ queue_class: 'direct' }), false)
  // The display name is copy the owner edits. It must never decide a section.
  assert.equal(isRelaxedQueue({} as any), false)
  assert.equal(isRelaxedQueue(null), false)
  assert.equal(isRelaxedQueue({ queue_class: null }), false)
  assert.equal(isRelaxedQueue({ queue_class: 'RELAXED' } as any), false)
})

test('no picker reads the words "Relaxed Queue" out of anything the Gateway publishes', () => {
  for (const [name, source] of [
    ['ModelSelector.vue', selectorSource],
    ['research.vue', researchSource],
    ['audio.vue', audioSource],
    ['genstudio-relaxed-queue.ts', relaxedSource],
  ] as const) {
    assert.doesNotMatch(
      source,
      /(display_name|label|\.name)[^\n]*(includes|indexOf|match|startsWith|test)\(/,
      `${name} must not derive the shelf from a product's name`,
    )
  }
})

test('a direct row keeps whatever heading its picker already used', () => {
  assert.equal(queueClassGroupLabel({ queue_class: 'direct' }, 'Language models'), 'Language models')
  assert.equal(queueClassGroupLabel({}, 'Gateway · Vision only'), 'Gateway · Vision only')
  assert.equal(queueClassGroupLabel({ queue_class: 'relaxed' }, 'Language models'), RELAXED_QUEUE_GROUP_LABEL)
})

// ── 2. The hint states GenStudio's numbers and GenStudio's words ──────────

test('the hint carries the served percentage, the threshold in dollars, and the served sentence', () => {
  const note = describeRelaxedQueueHint(HINT)
  assert.ok(note.includes(String(HINT.discount_percent)), 'the served percentage is on the page')
  assert.ok(note.includes(`$${HINT.unlock_threshold_cents / 100}`), 'cents rendered as dollars')
  assert.ok(note.includes(HINT.message), 'the owner’s sentence, verbatim and whole')
  // Not interpolated INTO the sentence: he may reword it into a shape where
  // the numbers no longer fit, and a client that had spliced them in would
  // then be showing a sentence he never wrote.
  assert.ok(note.indexOf(HINT.message) > note.indexOf(String(HINT.discount_percent)))
})

test('a threshold with cents keeps them; a round one does not grow a ".00"', () => {
  assert.ok(describeRelaxedQueueHint({ ...HINT, unlock_threshold_cents: 10_000 }).includes('$100 '))
  assert.ok(describeRelaxedQueueHint({ ...HINT, unlock_threshold_cents: 1_234 }).includes('$12.34'))
  assert.ok(describeRelaxedQueueHint({ ...HINT, unlock_threshold_cents: 1_000_000 }).includes('$10,000'))
})

/** Script and template only — a stylesheet's `50%` is a keyframe, not a price. */
function logic(name: string, source: string): string {
  let body = source
  if (name.endsWith('.vue')) {
    const { descriptor } = parse(source)
    body = [descriptor.template?.content, descriptor.script?.content, descriptor.scriptSetup?.content]
      .filter(Boolean).join('\n')
    assert.ok(body.trim(), `${name} must have a template or a script to inspect`)
  }
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\*|<!--).*$/gm, '')
}

test('no percentage, threshold or offer copy is authored anywhere in the client', () => {
  for (const [name, source] of [
    ['genstudio-relaxed-queue.ts', relaxedSource],
    ['ModelSelector.vue', selectorSource],
    ['ModelMenu.vue', menuSource],
    ['research.vue', researchSource],
  ] as const) {
    const code = logic(name, source)
    assert.doesNotMatch(code, /\b50\s*%|\b'50'|\bpercent\s*[:=]\s*\d/, `${name} must not state a discount`)
    assert.doesNotMatch(code, /\$\s*\d/, `${name} must not state a threshold`)
    assert.doesNotMatch(code, /slower queue|top-?ups?\b|never expires/i, `${name} must not restate the offer`)
  }
})

test('an incomplete or absent hint renders nothing at all', () => {
  assert.equal(describeRelaxedQueueHint(null), '')
  assert.equal(describeRelaxedQueueHint(undefined), '')
  assert.equal(describeRelaxedQueueHint({ ...HINT, message: '   ' }), '')
  assert.equal(describeRelaxedQueueHint({ ...HINT, discount_percent: Number.NaN }), '')
  assert.equal(describeRelaxedQueueHint({ ...HINT, unlock_threshold_cents: undefined as any }), '')
})

// ── 3. The sections, and their order ──────────────────────────────────────

const directRow = { id: 'a', label: 'Direct Product', group: 'Language models' }
const relaxedRow = {
  id: 'b',
  label: 'Relaxed Product',
  group: RELAXED_QUEUE_GROUP_LABEL,
  groupNote: describeRelaxedQueueHint(HINT),
}

test('the relaxed shelf is its own section, and it comes after the direct catalogue', () => {
  // Relaxed FIRST in the incoming list — the order must not depend on it.
  const sections = groupMenuOptions([relaxedRow, directRow, { ...directRow, id: 'c' }])
  assert.deepEqual(sections.map(section => section.label), ['Language models', RELAXED_QUEUE_GROUP_LABEL])
  assert.equal(sections[0]!.items.length, 2)
  assert.equal(sections[1]!.items.length, 1)
})

test('the hint is said once for the section, not once per model', () => {
  const sections = groupMenuOptions([relaxedRow, { ...relaxedRow, id: 'c' }, { ...relaxedRow, id: 'd' }])
  assert.equal(sections.length, 1)
  assert.equal(sections[0]!.note, describeRelaxedQueueHint(HINT))
})

test('the section and its note reach the rendered menu', async () => {
  const html = await renderMenu(groupMenuOptions([directRow, relaxedRow]))
  assert.match(html, /class="model-menu-group-note"/, 'the note element is present')
  const text = strip(html)
  assert.ok(text.includes(RELAXED_QUEUE_GROUP_LABEL), 'the heading is on the page')
  assert.ok(text.includes(HINT.message), 'and the whole sentence with it')
  assert.equal(text.split(HINT.message).length - 1, 1, 'exactly once, however many rows the section holds')
  assert.ok(
    text.indexOf('Direct Product') < text.indexOf(RELAXED_QUEUE_GROUP_LABEL),
    'the direct catalogue is read first',
  )
})

test('the section note is body text and is never clamped or hidden', () => {
  const style = parse(menuSource).descriptor.styles.map(block => block.content).join('\n')
  assert.match(style, /\.model-menu-group-note\s*\{[^}]*font-size:\s*var\(--font-sm\)/, 'reading size, not micro-copy')
  assert.doesNotMatch(style, /\.model-menu-group-note\s*\{[^}]*text-overflow:\s*ellipsis/)
  assert.doesNotMatch(style, /\.model-menu-group-note\s*\{[^}]*(-webkit-line-clamp|white-space:\s*nowrap)/)
  // A <p> in the flow, not a title= tooltip and not inside a <details>.
  assert.match(menuTemplate as string, /<p v-if="group\.note" class="model-menu-group-note">\{\{ group\.note \}\}<\/p>/)
})

test('the published discount percentage keeps its hundredths', () => {
  const note = describeRelaxedQueueHint({ ...HINT, discount_percent: 42.55 })
  assert.match(note, /Discount 42\.55%/)
})

// ── 4. The price, with the full price struck through ──────────────────────

test('a relaxed rate shows what is charged with the undiscounted price beside it', () => {
  const display = describeChatRate({
    display_name: 'Relaxed Product',
    input_credits_per_million_tokens: 30,
    output_credits_per_million_tokens: 60,
    standard_input_credits_per_million_tokens: 60,
    standard_output_credits_per_million_tokens: 120,
  })
  assert.equal(display.basis, 'rate')
  assert.match(display.text, /30 credits \(was 60 credits\) \/ 1M input tokens/)
  assert.match(display.text, /60 credits \(was 120 credits\) \/ 1M output tokens/)
  assert.match(display.title, /undiscounted prices/, 'the tooltip says which figure is which')
})

test('no discount tag appears where there is no discount', () => {
  // Equal is the list price restated, not a sale. Lower would be nonsense.
  const restated = describeChatRate({
    input_credits_per_million_tokens: 30,
    output_credits_per_million_tokens: 60,
    standard_input_credits_per_million_tokens: 30,
    standard_output_credits_per_million_tokens: 20,
  })
  assert.doesNotMatch(restated.text, /was/)
  assert.doesNotMatch(restated.title, /undiscounted prices/)
  // And an account being quoted list gets no second figure invented for it.
  const unsold = describeChatRate({ input_credits_per_million_tokens: 30, output_credits_per_million_tokens: 60 })
  assert.equal(unsold.text, '30 credits / 1M input tokens · 60 credits / 1M output tokens')
})

test('the TTS picker uses Gateway queue metadata and shows the published full price', () => {
  assert.match(audioSource, /queueClassGroupLabel\(model, model\.provider_name \|\| 'Voice models'\)/)
  assert.match(
    audioSource,
    /groupNote: isRelaxedQueue\(model\) \? describeRelaxedQueueHint\(model\.relaxed_queue_hint\) : ''/,
  )

  const display = describeVoiceRate({
    display_name: 'Fish Audio S2.1 Pro (Relaxed Queue)',
    credits_per_1000_characters: 24,
    standard_credits: 48,
    sale_credits: 24,
    sale_disclaimer: 'The Gateway publishes this sale disclaimer.',
  })
  assert.match(display.text, /24 credits \/ 1,000 characters \(was 48 credits\)/)
  assert.match(display.title, /GenStudio publishes this sale disclaimer\./)
  assert.match(display.notice || '', /GenStudio publishes this sale disclaimer\./)
  assert.match(
    menuTemplate as string,
    /<small v-if="option\.priceNote" class="model-menu-option-price-note">\{\{ option\.priceNote \}\}<\/small>/,
    'sale disclosure is visible in the picker instead of existing only in a title tooltip',
  )
  assert.match(audioSource, /priceNote: rate\.notice/)
})

// ── 5. GRACEFUL DEGRADATION — the deployed API serves none of this yet ────

test('a catalogue with no queue_class at all renders exactly as it does today', async () => {
  // Rows built the way every picker builds them, from a payload that has never
  // heard of the two new fields.
  const legacy = [
    { id: 'a', label: 'Product A', group: 'Language models', groupNote: '' },
    { id: 'b', label: 'Product B', group: 'Language models', groupNote: '' },
  ]
  const sections = groupMenuOptions(legacy)
  assert.deepEqual(sections.map(section => section.label), ['Language models'], 'one section, the one that was there')
  assert.equal(sections[0]!.note, '', 'and nothing under its heading')

  const html = await renderMenu(sections)
  assert.doesNotMatch(html, /model-menu-group-note/, 'no note element is emitted at all')
  assert.ok(!strip(html).includes(RELAXED_QUEUE_GROUP_LABEL), 'no heading a customer has never seen before')
})

test('a relaxed product whose hint is absent gets its section and no invented note', () => {
  // A GenStudio that publishes `queue_class` but no hint — or one where the
  // sale has ended. The shelf is still real; the offer is not this app's to
  // state, so nothing is stated.
  const row = {
    id: 'b',
    label: 'Relaxed Product',
    group: queueClassGroupLabel({ queue_class: 'relaxed' }, 'Language models'),
    groupNote: describeRelaxedQueueHint(null),
  }
  const sections = groupMenuOptions([directRow, row])
  assert.equal(sections[1]!.label, RELAXED_QUEUE_GROUP_LABEL)
  assert.equal(sections[1]!.note, '')
})

test('the vision menu sections a legacy row the same way, and a relaxed one too', () => {
  const base = {
    display_name: 'Vision Product',
    supported_detail_levels: ['auto' as const],
    max_input_images: 1,
    accepted_image_mime_types: ['image/png'],
    max_image_bytes: 1,
    max_image_dimension: 1,
    minimum_credits: 0,
    price_version: 'v1',
  }
  const legacy = thumbnailVisionModelMenuOption({ ...base, id: 'v1' })
  assert.equal(legacy.group, 'Gateway · Vision only', 'unchanged for a payload without the field')
  assert.equal(legacy.groupNote, '')

  const relaxed = thumbnailVisionModelMenuOption({
    ...base, id: 'v2', queue_class: 'relaxed', relaxed_queue_hint: HINT,
  })
  assert.equal(relaxed.group, RELAXED_QUEUE_GROUP_LABEL)
  assert.ok(relaxed.groupNote.includes(HINT.message))
})
