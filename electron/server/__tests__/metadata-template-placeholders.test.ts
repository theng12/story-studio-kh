/**
 * Which placeholders the model is asked to fill.
 *
 * Only the three fixed ones (episode code and the two dates) are filled
 * without the model. Every other token — the documented four, and any a
 * channel's saved template uses such as {title} or {focus} — is sent to the
 * model, so an existing template never publishes a silent blank. A typo such as
 * {topc} therefore gets invented text; the publishing profile page warns about
 * unrecognised tokens before Save instead.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPlaceholders, llmFillablePlaceholders } from '../lib/metadata-template.js'

test('every non-fixed placeholder is sent to the model, including channel-specific ones', () => {
  const tpl = { title: '{title}: {focus}', description: '{summary}\n\nAired {date} · {episode_code}', tags: ['{topic_tag}', '{topc}'] }
  const found = extractPlaceholders(tpl)
  assert.deepEqual(llmFillablePlaceholders(found).sort(), ['focus', 'summary', 'title', 'topc', 'topic_tag'])
})

test('the fixed placeholders are never sent to the model', () => {
  assert.deepEqual(llmFillablePlaceholders(['episode_code', 'date', 'date_long']), [])
})
