import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const source = readFileSync(
  fileURLToPath(new URL('../pages/index.vue', import.meta.url)),
  'utf8',
)

describe('GenStudio-only project onboarding', () => {
  test('offers one scoped GenStudio credential and no retired provider keys', () => {
    assert.match(source, /Scoped GenStudio API key/)
    assert.match(source, /type KeyProvider = 'genstudio'/)
    assert.match(source, /\['genstudio', apiKeys\.genstudio\]/)

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

  test('tests the GenStudio scopes through the app-settings boundary', () => {
    assert.match(source, /\/app-settings\/api-keys\/\$\{provider\}\/test/)
    assert.doesNotMatch(source, /\/test-key\/\$\{provider\}/)
    assert.doesNotMatch(source, /\/connectivity\/precheck/)
  })
})
