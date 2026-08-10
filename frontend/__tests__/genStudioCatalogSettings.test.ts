import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const source = readFileSync(
  fileURLToPath(new URL('../components/GenStudioCatalogSettings.vue', import.meta.url)),
  'utf8',
)

describe('GenStudio catalog diagnostics', () => {
  test('shows live catalog health without reviving retired access controls', () => {
    assert.match(source, /GenStudio Catalog/)
    assert.match(source, /Connection/)
    assert.match(source, /Last refresh/)
    assert.match(source, /View catalog details/)
    assert.match(source, /Credits &amp; settlement/)
    assert.doesNotMatch(source, /GenStudio Catalog &amp; Access/)
    assert.doesNotMatch(source, /useGenStudioAccess|relaxed_concurrency|Unlimited Relaxed/)
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
