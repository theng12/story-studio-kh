import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  API_PROVIDER_GROUPS,
  API_PROVIDER_META,
  apiProvidersFor,
} from '../utils/api-provider-groups.js'

describe('API provider settings groups', () => {
  test('keeps the requested category order', () => {
    assert.deepEqual(
      API_PROVIDER_GROUPS.map(group => group.id),
      ['llm', 'audio', 'image', 'video', 'mix'],
    )
  })

  test('shows every provider in exactly one non-empty category', () => {
    const groupedIds = API_PROVIDER_GROUPS.flatMap(group => (
      apiProvidersFor(group.id).map(provider => provider.id)
    ))

    assert.equal(new Set(groupedIds).size, API_PROVIDER_META.length)
    assert.deepEqual(new Set(groupedIds), new Set(API_PROVIDER_META.map(provider => provider.id)))
    for (const group of API_PROVIDER_GROUPS) {
      assert.ok(apiProvidersFor(group.id).length > 0, `${group.label} should not be empty`)
    }
  })
})
