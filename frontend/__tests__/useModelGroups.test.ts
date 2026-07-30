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
 *   - The label is the human-friendly PROVIDER_DISPLAY, falling back to
 *     the raw provider id when unknown.
 *   - `resolveAudioProvider` honours the explicit `.provider` field first,
 *     then legacy prefix sniffing for `eleven_*` / `genaipro-*`.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { groupModels, resolveAudioProvider, PROVIDER_DISPLAY } from '../composables/useModelGroups.js'

describe('groupModels()', () => {
  test('groups entries by provider and uses PROVIDER_DISPLAY for labels', () => {
    const models = {
      'eleven_v2':          { provider: 'elevenlabs' },
      'turbo-v2.5':         { provider: 'fal' },
      'genaipro-multiling': { provider: 'genaipro' },
    }
    const groups = groupModels(models, (_id, m) => m.provider)

    assert.equal(groups.length, 3)
    assert.deepEqual(groups.map(g => g.provider), ['elevenlabs', 'fal', 'genaipro'],
      'DEFAULT_ORDER puts elevenlabs before fal before genaipro')
    assert.equal(groups[0].label, PROVIDER_DISPLAY.elevenlabs)
    assert.equal(groups[1].label, PROVIDER_DISPLAY.fal)
    assert.equal(groups[2].label, PROVIDER_DISPLAY.genaipro)
    // Each group carries exactly its items.
    assert.equal(groups[0].items.length, 1)
    assert.equal(groups[0].items[0].id, 'eleven_v2')
  })

  test('providers outside DEFAULT_ORDER slot to the bottom alphabetically', () => {
    const models = {
      'eleven_v2':          { provider: 'elevenlabs' },
      'random-model':       { provider: 'zeta-vendor' },
      'another-unknown':    { provider: 'acme-ai' },
    }
    const groups = groupModels(models, (_id, m) => m.provider)
    const order = groups.map(g => g.provider)
    assert.equal(order[0], 'elevenlabs', 'known providers come first')
    assert.deepEqual(order.slice(1), ['acme-ai', 'zeta-vendor'],
      'unknown providers sorted alphabetically at the bottom')
  })

  test('falls back to the raw provider id when there is no PROVIDER_DISPLAY entry', () => {
    const models = { 'x': { provider: 'brand-new-provider' } }
    const groups = groupModels(models, (_id, m) => m.provider)
    assert.equal(groups[0].label, 'brand-new-provider')
  })

  test('null / undefined / empty input returns an empty array', () => {
    assert.deepEqual(groupModels(null, () => 'x'), [])
    assert.deepEqual(groupModels(undefined, () => 'x'), [])
    assert.deepEqual(groupModels({}, () => 'x'), [])
  })
})

describe('resolveAudioProvider()', () => {
  test('explicit .provider field wins over legacy prefix rules', () => {
    assert.equal(resolveAudioProvider('eleven_v2', { provider: 'fal' }), 'fal',
      'explicit provider overrides the `eleven_` prefix heuristic')
  })

  test('legacy eleven_ prefix → elevenlabs', () => {
    assert.equal(resolveAudioProvider('eleven_v2', {}), 'elevenlabs')
  })

  test('legacy genaipro- prefix → genaipro', () => {
    assert.equal(resolveAudioProvider('genaipro-multiling-v2', {}), 'genaipro')
  })

  test('unknown id with no provider field resolves to unknown, never a guessed provider', () => {
    // Guessing a retired direct provider for an unrecognized id contradicts the
    // GenStudio-only boundary; grouping must fall back to a neutral label instead.
    assert.equal(resolveAudioProvider('turbo-v2.5', {}), 'unknown')
  })
})
