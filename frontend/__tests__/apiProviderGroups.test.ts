import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  API_PROVIDER_GROUPS,
  API_PROVIDER_META,
  apiProvidersFor,
} from '../utils/api-provider-groups.js'

describe('API provider settings groups', () => {
  test('exposes only the GenStudio mixed-capability connection group', () => {
    assert.deepEqual(
      API_PROVIDER_GROUPS.map(group => group.id),
      ['mix'],
    )
    assert.deepEqual(API_PROVIDER_META.map(provider => provider.id), ['genstudio'])
    assert.deepEqual(apiProvidersFor('mix').map(provider => provider.id), ['genstudio'])
    assert.match(API_PROVIDER_GROUPS[0]!.description, /sole catalog, job, and credit boundary/i)
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
