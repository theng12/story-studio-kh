/**
 * GenStudio's data disclosure has to reach the person choosing the model.
 *
 * GenStudio publishes `discount` and `discount_disclaimer` on every row of
 * `GET /v1/chat/models`. Story Studio read neither, so a notice that exists
 * only on the server reached nobody — and language models are offered only
 * inside this app, so there was no second place to see it.
 *
 * `sale_disclaimer` is NOT this: that is a price-promotion notice on a
 * different catalogue and means something else.
 *
 * These tests RENDER the component's real template rather than grepping it, so
 * "it is displayed" is demonstrated rather than asserted.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { parse } from '@vue/compiler-sfc'

const selectorPath = new URL('../components/ModelSelector.vue', import.meta.url)
const source = readFileSync(selectorPath, 'utf8')
const template = parse(source).descriptor.template?.content
assert.ok(template, 'ModelSelector.vue must have a template')

/**
 * Render the component's OWN template against supplied state. Child components
 * are stubbed to their tag name — this test is about what ModelSelector itself
 * puts on the page, not about the menu it delegates to.
 */
async function render(state: Record<string, unknown>): Promise<string> {
  const app = createSSRApp({
    template: template as string,
    data: () => ({ label: 'LLM model', loading: false, loadError: '', menuOptions: [], modelValue: 'm1', ...state }),
    methods: { selectModel() {} },
  })
  app.config.warnHandler = () => {}
  for (const stub of ['ModelMenu']) {
    app.component(stub, { props: ['modelValue', 'options', 'loading'], template: '<div class="stub" />' })
  }
  return await renderToString(app)
}

// The owner's revised wording, four sentences. Supplied the way GenStudio
// supplies it — this test never asserts Story Studio contains these words.
const PUBLISHED_DISCLOSURE = 'We offer some models at a reduced price. '
  + 'Data sent to these models may be retained, and may be used for training, by us or by our providers. '
  + "Capacity is provided by the model's host and is not guaranteed — a request may be refused, and you can "
  + 'pick another model and try again. Do not use these models if you do not consent to your data being used this way.'

test('the disclosure renders in full when the selected model publishes one', async () => {
  const html = await render({ selectedDataDisclosure: PUBLISHED_DISCLOSURE })
  assert.match(html, /class="data-disclosure"/, 'the notice element is present')
  // Every sentence, in full. Rendered text is escaped, so compare on text.
  const text = html.replace(/<[^>]*>/g, '').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&')
  for (const sentence of PUBLISHED_DISCLOSURE.split('. ')) {
    assert.ok(text.includes(sentence.trim().replace(/\.$/, '')), `missing: ${sentence.slice(0, 40)}…`)
  }
  assert.doesNotMatch(text, /…\s*$/, 'the notice must not be truncated')
})

test('the disclosure disappears for a model that publishes none', async () => {
  const html = await render({ selectedDataDisclosure: '' })
  assert.doesNotMatch(html, /data-disclosure/, 'it must not become permanent furniture')
})

test('the notice is body text and is never hidden behind a hover or a toggle', () => {
  const style = parse(source).descriptor.styles.map(block => block.content).join('\n')
  assert.match(style, /\.data-disclosure\s*\{[^}]*font-size:\s*var\(--font-md\)/, 'body size, not micro-copy')
  assert.doesNotMatch(style, /\.data-disclosure\s*\{[^}]*text-overflow:\s*ellipsis/)
  assert.doesNotMatch(style, /\.data-disclosure\s*\{[^}]*(-webkit-line-clamp|white-space:\s*nowrap)/)
  // A <p> in the flow, not a title= tooltip and not inside a <details>.
  assert.match(template as string, /<p v-if="selectedDataDisclosure" class="data-disclosure">\{\{ selectedDataDisclosure \}\}<\/p>/)
  assert.doesNotMatch(template as string, /<details/)
})

test('a model carrying a notice is flagged in the list before anything is opened', () => {
  // Matched on the CONDITION, not on the surrounding syntax. This assertion
  // used to read `badges: model.discount === true` and broke the moment a
  // second badge was added beside this one — a legitimate refactor failing a
  // test that was only ever checking punctuation.
  assert.match(source, /model\.discount === true\n?\s*\?\s*\[\{ label: 'Data notice'/)
})

test('the wording is never authored here — only the published field is read', () => {
  // One source of truth lives on the GenStudio side. A copy in this app would
  // drift, and a softened word changes what the customer agreed to.
  for (const file of ['../components/ModelSelector.vue', '../components/ModelMenu.vue']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /may be used for training/i, `${file} must not carry its own copy of the sentence`)
    assert.doesNotMatch(text, /do not consent to your data/i)
  }
  assert.match(source, /discount_disclaimer/, 'the published field is what gets rendered')
})
