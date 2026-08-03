/**
 * Tests for `useModelGroups` — the provider-grouping helper every model
 * dropdown renders through.
 *
 * Pure functions, no Vue reactivity. These tests pin:
 *
 *   - Models grouped by provider id (the output shape every `<optgroup>`
 *     binding depends on).
 *   - DEFAULT_ORDER respected: providers appear in the curated order users
 *     see in the sidebar. Providers outside the list slot to the bottom
 *     alphabetically, so the dropdown is deterministic.
 *   - The label comes from PROVIDER_DISPLAY, which is an ALLOWLIST of the
 *     identities Story Studio may name. An id that is not in it gets a
 *     neutral heading — never the raw id, which is how an upstream
 *     aggregator's name used to reach the picker.
 *   - `resolveAudioProvider` returns the published `.provider` or nothing.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { groupModels, resolveAudioProvider, PROVIDER_DISPLAY } from '../composables/useModelGroups.js'

describe('groupModels()', () => {
  test('groups entries by provider and uses PROVIDER_DISPLAY for labels', () => {
    const models = {
      'genstudio-a':  { provider: 'genstudio' },
      'local-voice':  { provider: 'voicestudio' },
      'local-image':  { provider: 'imagestudio' },
    }
    const groups = groupModels(models, (_id, m) => m.provider)

    assert.equal(groups.length, 3)
    assert.deepEqual(groups.map(g => g.provider), ['genstudio', 'voicestudio', 'imagestudio'],
      'DEFAULT_ORDER puts the gateway first, then the local-only options')
    assert.equal(groups[0].label, PROVIDER_DISPLAY.genstudio)
    assert.equal(groups[1].label, PROVIDER_DISPLAY.voicestudio)
    assert.equal(groups[2].label, PROVIDER_DISPLAY.imagestudio)
    // Each group carries exactly its items.
    assert.equal(groups[0].items.length, 1)
    assert.equal(groups[0].items[0].id, 'genstudio-a')
  })

  test('providers outside DEFAULT_ORDER slot to the bottom alphabetically', () => {
    const models = {
      'gs':              { provider: 'genstudio' },
      'random-model':    { provider: 'zeta-vendor' },
      'another-unknown': { provider: 'acme-ai' },
    }
    const groups = groupModels(models, (_id, m) => m.provider)
    const order = groups.map(g => g.provider)
    assert.equal(order[0], 'genstudio', 'known providers come first')
    assert.deepEqual(order.slice(1), ['acme-ai', 'zeta-vendor'],
      'unknown providers sorted alphabetically at the bottom')
  })

  test('a provider with no PROVIDER_DISPLAY entry gets a neutral heading, not the raw id', () => {
    const models = { x: { provider: 'brand-new-provider' } }
    const groups = groupModels(models, (_id, m) => m.provider)
    assert.equal(groups[0].label, 'Models')
    assert.notEqual(groups[0].label, 'brand-new-provider',
      'echoing the id back is how a private routing identity reached the picker')
  })

  test('null / undefined / empty input returns an empty array', () => {
    assert.deepEqual(groupModels(null, () => 'x'), [])
    assert.deepEqual(groupModels(undefined, () => 'x'), [])
    assert.deepEqual(groupModels({}, () => 'x'), [])
  })
})

describe('resolveAudioProvider()', () => {
  test('returns the explicitly published .provider field', () => {
    assert.equal(resolveAudioProvider('eleven_v2', { provider: 'genstudio' }), 'genstudio')
  })

  test('no published provider resolves to unknown, never a guess from the id', () => {
    // Guessing a provider from a model id is exactly what AGENTS.md forbids:
    // an unpublished provider is unknown, never reconstructed from a name.
    assert.equal(resolveAudioProvider('turbo-v2.5', {}), 'unknown')
    assert.equal(resolveAudioProvider('eleven_v2', {}), 'unknown')
    assert.equal(resolveAudioProvider('genaipro-multiling-v2', {}), 'unknown')
  })
})
