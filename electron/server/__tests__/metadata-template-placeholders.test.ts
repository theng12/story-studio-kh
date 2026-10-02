/**
 * Only documented placeholders are sent to the model.
 *
 * A typo such as `{topc}` used to be asked for too, and the model invented
 * text for it — while the publishing profile page promises that an unknown
 * placeholder is left empty.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPlaceholders, llmFillablePlaceholders, renderTemplate } from '../lib/metadata-template.js'

test('a misspelt placeholder is not sent to the model and renders empty', () => {
  const tpl = { title: 'The Story of {topc}', description: '{summary}\n\nAired {date}', tags: ['{topic_tag}', '{keyword}'] }
  const found = extractPlaceholders(tpl)
  assert.deepEqual(found.sort(), ['date', 'keyword', 'summary', 'topc', 'topic_tag'])
  assert.deepEqual(llmFillablePlaceholders(found).sort(), ['summary', 'topic_tag'])
  const rendered = renderTemplate(tpl, { summary: 'A tale.', topic_tag: 'castles', date: '2026-10-03' })
  assert.equal(rendered.title, 'The Story of')
  assert.deepEqual(rendered.tags, ['castles'])
})

test('every documented model-filled placeholder is still asked for', () => {
  assert.deepEqual(llmFillablePlaceholders(['topic', 'topic_tag', 'summary', 'keywords', 'episode_code', 'date', 'date_long']),
    ['topic', 'topic_tag', 'summary', 'keywords'])
})
