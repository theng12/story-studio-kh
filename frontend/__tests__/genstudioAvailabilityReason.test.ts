import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { describeGenStudioAvailability } from '../utils/genstudio-availability.ts'

describe('GenStudio availability reasons', () => {
  test('explains depleted daily capacity with a localized return time', () => {
    const message = describeGenStudioAvailability({
      available: false,
      availability_reason: 'daily_quota_depleted',
      available_again_at: '2027-01-02T12:00:00.000Z',
    }, Date.parse('2027-01-01T12:00:00.000Z'), 'en-US')

    assert.match(message, /daily capacity is currently depleted/i)
    assert.match(message, /Jan 2, 2027/)
  })

  test('explains temporary backpressure without inventing a reset', () => {
    const message = describeGenStudioAvailability({
      available: false,
      availability_reason: 'temporary_backpressure',
      available_again_at: null,
    }, Date.parse('2027-01-01T12:00:00.000Z'), 'en-US')

    assert.match(message, /temporarily unavailable/i)
    assert.match(message, /refresh to check availability/i)
    assert.doesNotMatch(message, /daily|reset|quota/i)
  })

  test('keeps legacy and malformed rows on generic wording, and refreshes stale rows', () => {
    assert.equal(describeGenStudioAvailability({ available: true }), '')
    assert.equal(describeGenStudioAvailability({ available: false }), '')
    assert.equal(describeGenStudioAvailability({
      available: false,
      availability_reason: 'provider_outage' as never,
      available_again_at: 'not-a-date',
    }), '')
    assert.match(describeGenStudioAvailability({
      available: false,
      availability_reason: 'daily_quota_depleted',
      available_again_at: '2026-12-31T12:00:00.000Z',
    }, Date.parse('2027-01-01T12:00:00.000Z'), 'en-US'), /refresh to check availability/i)
  })
})
