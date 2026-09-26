/**
 * HUB-20, Story Studio's half — a limit's author travels with the limit.
 *
 * The gateway labels every published limit with where it came from, and the two
 * producers use overlapping vocabularies on purpose: a cloud row says `provider`,
 * `curated` or `gateway`; a Studio Hub row says `model`, `worker_default`, `curated`
 * or `unknown`. Story Studio read none of it, so a Studio Hub model whose checkpoint
 * ships no `generation_config.json` published the Hub's own 16,384 fallback — measured
 * live on the owner's Mac, 2026-09-26 — and every surface printed it as the model's
 * own ceiling.
 *
 * This pins the ingestion half: the label is read, kept verbatim, and an absent or
 * unknown label stays null. Folding null into `provider` is the defect this file
 * exists to prevent: "we were not told" is not "the model said so".
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  readPublishedLimitSource,
  type GenStudioLimitSource,
} from '../lib/genstudio-client.js'

describe('a limit’s provenance is read, never assumed', () => {
  test('every label the gateway can publish is kept verbatim', () => {
    const labels: GenStudioLimitSource[] = [
      'provider', 'model', 'curated', 'gateway', 'worker_default', 'unknown',
    ]
    for (const label of labels) {
      assert.equal(readPublishedLimitSource(label), label)
    }
  })

  test('case and surrounding whitespace do not lose the label', () => {
    assert.equal(readPublishedLimitSource('  Worker_Default '), 'worker_default')
    assert.equal(readPublishedLimitSource('MODEL'), 'model')
  })

  test('an absent or unrecognised label stays null — never provider', () => {
    for (const value of [undefined, null, '', '   ', 42, {}, [], 'stated', 'provider-ish']) {
      assert.equal(readPublishedLimitSource(value), null,
        `${JSON.stringify(value)} must not become a source`)
    }
  })

  test('the two producers’ vocabularies are both reachable', () => {
    // A cloud row's labels …
    assert.equal(readPublishedLimitSource('gateway'), 'gateway')
    // … and a Studio Hub row's, which is what the local lane publishes today.
    assert.equal(readPublishedLimitSource('worker_default'), 'worker_default')
  })
})
