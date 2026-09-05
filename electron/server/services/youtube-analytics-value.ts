/**
 * One metric, and which of four things it is.
 *
 * A number on an analytics screen is read as a fact about the creator's work.
 * So "YouTube said 0", "we never asked", "YouTube does not offer this here" and
 * "YouTube answered and had nothing" must never collapse into the same `0` or
 * the same dash. They are four different sentences with four different next
 * actions, and this type is what stops downstream code representing a metric as
 * a bare number.
 *
 * `fetched_at` rides along with every state that came from an answer: a figure
 * whose age is unknown cannot be judged. `not_fetched` carries none, because
 * there is nothing to date.
 */

export type MetricValue =
  | { state: 'value', value: number, fetched_at: string }
  | { state: 'not_fetched' }
  | { state: 'not_available', reason: string, fetched_at: string }
  | { state: 'no_data', fetched_at: string }

export const metricValue = (value: number, fetchedAt: string): MetricValue =>
  ({ state: 'value', value, fetched_at: fetchedAt })

export const metricNotFetched = (): MetricValue => ({ state: 'not_fetched' })

/** `reason` is required: "we cannot show this" always arrives with why. */
export const metricNotAvailable = (reason: string, fetchedAt: string): MetricValue =>
  ({ state: 'not_available', reason, fetched_at: fetchedAt })

export const metricNoData = (fetchedAt: string): MetricValue =>
  ({ state: 'no_data', fetched_at: fetchedAt })

// `describeMetric` and `metricFetchedAt` lived here: exported, tested, and
// never called. Rendering is the page's job, and the page has its own
// `describe()` whose output is asserted at the DOM level, which is where the
// four states actually have to be distinguishable. Two renderers for one rule,
// only one of them reachable, is the drift the `viewsFor`/`filterInbox`
// deletion already taught this branch once (tell 4).
