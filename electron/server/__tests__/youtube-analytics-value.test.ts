import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  metricNoData,
  metricNotAvailable,
  metricNotFetched,
  metricValue,
  type MetricValue,
} from '../services/youtube-analytics-value.js'

const AT = '2026-09-03T10:00:00.000Z'

/**
 * The RENDERING tests for the four states live with the page, in
 * frontend/__tests__/uploadCenterAnalytics.test.ts, asserted at the DOM level
 * against `data-state` and the visible text. They were here too, over a
 * `describeMetric` nothing called — two renderers for one rule, only one of
 * them reachable. What remains here is the shape of the states themselves.
 */
describe('the four metric states', () => {
  test('each constructor produces its own state, and only that state', () => {
    const built: Array<[string, MetricValue]> = [
      ['value', metricValue(0, AT)],
      ['not_fetched', metricNotFetched()],
      ['not_available', metricNotAvailable('Retention needs 1,000 views.', AT)],
      ['no_data', metricNoData(AT)],
    ]
    assert.deepEqual(built.map(([, m]) => m.state), ['value', 'not_fetched', 'not_available', 'no_data'])
    // Four distinct states, so none can be silently substituted for another.
    assert.equal(new Set(built.map(([, m]) => m.state)).size, 4)
  })

  test('a real zero is a value carrying a number, not an absence', () => {
    const zero = metricValue(0, AT)
    assert.equal(zero.state === 'value' && zero.value, 0)
    assert.equal(zero.state === 'value' && typeof zero.value, 'number')
  })

  test('every state from an answer carries its age; not_fetched carries none', () => {
    // `not_fetched` has NO `fetched_at` field at all — there is nothing to
    // date, and an optional-but-present field would invite a reader to format
    // an empty string as a time.
    assert.equal('fetched_at' in metricNotFetched(), false)
    for (const metric of [metricValue(1, AT), metricNotAvailable('why', AT), metricNoData(AT)]) {
      assert.equal(metric.state === 'not_fetched' ? null : metric.fetched_at, AT)
    }
  })

  test('not_available always carries a reason', () => {
    const metric = metricNotAvailable('Retention needs 1,000 views.', AT)
    assert.equal(metric.state === 'not_available' && metric.reason, 'Retention needs 1,000 views.')
  })
})
