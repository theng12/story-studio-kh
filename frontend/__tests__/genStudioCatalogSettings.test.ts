import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const source = readFileSync(
  fileURLToPath(new URL('../components/GenStudioCatalogSettings.vue', import.meta.url)),
  'utf8',
)

describe('GenStudio catalog and access diagnostics', () => {
  test('shows account-owned access data without editable catalog controls', () => {
    assert.match(source, /GenStudio Catalog &amp; Access/)
    assert.match(source, /Connection/)
    assert.match(source, /Current plan/)
    assert.match(source, /Credits/)
    assert.match(source, /Last refresh/)
    assert.match(source, /View catalog details/)
    assert.doesNotMatch(source, /Save (?:catalog|pricing|model)/i)
  })

  test('loads every live catalog while keeping partial failures visible', () => {
    for (const endpoint of [
      'chat-models',
      'voices',
      'transcription-models',
    ]) {
      assert.match(source, new RegExp(endpoint))
    }
    assert.match(source, /useGenStudioImageModels\(\)/)
    assert.match(source, /useGenStudioMediaModels\(\)/)
    assert.match(source, /Promise\.allSettled/)
    assert.match(source, /combinedErrors/)
  })
})
