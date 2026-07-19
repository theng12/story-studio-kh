import assert from 'node:assert/strict'
import test from 'node:test'
import { parseStructuredJson } from '../lib/ai-client.js'

test('structured JSON accepts fences and harmless trailing commas', () => {
  const parsed = parseStructuredJson('```json\n{ "chapters": [{ "title": "One", }], }\n```') as any
  assert.deepEqual(parsed, { chapters: [{ title: 'One' }] })
})

test('structured JSON never turns an incomplete response into success', () => {
  assert.throws(
    () => parseStructuredJson('{ "chapters": [{ "title": "One" }'),
    SyntaxError,
  )
})
