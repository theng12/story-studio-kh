import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const source = readFileSync(
  fileURLToPath(new URL('../pages/index.vue', import.meta.url)),
  'utf8',
)

describe('GenStudio-only project onboarding', () => {
  test('keeps service credentials out of channel creation', () => {
    assert.match(source, /appSettingsModal\.open\(\)/)
    assert.doesNotMatch(source, /KeyProvider|apiKeys|Scoped Gateway API Key/)

    for (const retired of [
      'OpenAI API Key',
      'Anthropic API Key',
      'kie.ai API Key',
      'fal.ai API Key',
      'GenAIPro API Key',
    ]) {
      assert.doesNotMatch(source, new RegExp(retired.replace('.', '\\.')))
    }
  })

  test('does not duplicate connectivity or credential APIs on the channel list', () => {
    assert.doesNotMatch(source, /app-settings\/api-keys|test-key|connectivity\/precheck/)
  })

  test('links to the Studio Library instead of embedding a shop in onboarding', () => {
    assert.match(source, /to="\/library"/)
    assert.doesNotMatch(source, /content-store\/quotes|purchase/i)
  })
})
