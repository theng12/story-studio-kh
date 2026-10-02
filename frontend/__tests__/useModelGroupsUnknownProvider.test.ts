/**
 * Regression coverage for the two rules that keep a provider name honest in
 * every model picker (frontend/composables/useModelGroups.ts):
 *
 *   1. A model with no PUBLISHED provider renders no provider. Not a
 *      placeholder vendor, not a guess derived from its id. `resolveAudioProvider`
 *      used to sniff the id — `eleven_*` → elevenlabs, `genaipro-*` → genaipro,
 *      anything unrecognized → a hardcoded `'fal'` — which both invented a fact
 *      and put an upstream routing identity on screen.
 *
 *   2. `PROVIDER_DISPLAY` is an ALLOWLIST, not a lookup table. It names the
 *      GenStudio gateway and Story Studio's own local features, and nothing
 *      else. `publicProviderLabel` returns '' for everything outside it, so a
 *      record written before the GenStudio-only migration (v1.0.669) cannot
 *      surface the aggregator or direct-vendor key it was routed through.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { PROVIDER_DISPLAY, publicProviderLabel, resolveAudioProvider } from '../composables/useModelGroups.js'

/** The identities that must never be nameable, whatever a record holds. */
const PRIVATE_ROUTING_IDENTITIES = [
  'kie', 'kie.ai', 'fal', 'fal.ai', 'openrouter', 'genaipro',
  'openai', 'anthropic', 'deepseek', 'elevenlabs', 'fishaudio',
]

describe('a model with no published provider shows no provider', () => {
  test('an id with no explicit provider resolves to the neutral bucket, never a vendor', () => {
    for (const id of ['turbo-v2.5', 'some-brand-new-engine-id', 'eleven_v2', 'genaipro-multiling-v2']) {
      assert.equal(resolveAudioProvider(id, {}), 'unknown',
        `"${id}" must not be attributed to a vendor by its name`)
    }
  })

  test('the neutral bucket has a neutral label, not a vendor name', () => {
    assert.equal(PROVIDER_DISPLAY.unknown, 'Other')
  })

  test('the published .provider field is the only thing honoured', () => {
    assert.equal(resolveAudioProvider('anything-at-all', { provider: 'genstudio' }), 'genstudio')
  })
})

describe('a historical record carrying a legacy provider string does not display it', () => {
  test('publicProviderLabel returns nothing for every private routing identity', () => {
    for (const legacy of PRIVATE_ROUTING_IDENTITIES) {
      assert.equal(publicProviderLabel(legacy), '',
        `"${legacy}" is upstream routing detail and must have no display name`)
      assert.equal(PROVIDER_DISPLAY[legacy], undefined,
        `"${legacy}" must not be an entry in the allowlist`)
    }
  })

  test('an unrecognised id is not echoed back as its own label', () => {
    // The old `PROVIDER_DISPLAY[id] || id` fallback printed whatever was on
    // disk. Anything unknown must resolve to '' so callers hide the field.
    assert.equal(publicProviderLabel('some-retired-gateway'), '')
    assert.equal(publicProviderLabel(''), '')
    assert.equal(publicProviderLabel(undefined), '')
    assert.equal(publicProviderLabel(null), '')
  })

  test('the gateway and Story Studio\'s own local features stay nameable', () => {
    assert.equal(publicProviderLabel('genstudio'), 'Gateway')
    for (const local of ['voicestudio', 'imagestudio', 'chatstudio', 'macos']) {
      assert.notEqual(publicProviderLabel(local), '',
        `"${local}" runs on the customer's own machine and stays nameable`)
    }
  })

  test('no label in the allowlist names a private routing identity', () => {
    for (const label of Object.values(PROVIDER_DISPLAY)) {
      for (const legacy of ['kie', 'fal.ai', 'openrouter', 'genaipro', 'elevenlabs']) {
        assert.equal(label.toLowerCase().includes(legacy), false,
          `display label "${label}" names "${legacy}"`)
      }
    }
  })
})
