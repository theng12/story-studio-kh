/**
 * `GenStudio Unavailable` must mean unavailable.
 *
 * The header badge used to say it whenever one poll of `/v1/account/overview`
 * came back empty — no retry, no memory of the balance it had a second ago —
 * so a service blip announced an outage next to a narration job that was
 * generating normally. Three states now, and they are genuinely different:
 * a current balance, a last-known balance marked stale, and nothing at all.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  GENSTUDIO_STALE_CEILING_MS,
  formatGenStudioAge,
  genstudioStaleNote,
  keepStandingAfterFailedRefresh,
} from '../utils/genstudio-freshness.js'

const NOW = 1_760_000_000_000

test('a transient failure keeps the balance on screen instead of reporting an outage', () => {
  // Loaded seconds ago; one poll just failed. This is the owner's case.
  assert.equal(keepStandingAfterFailedRefresh(4_210, NOW - 5_000, undefined, NOW), true)
  // Still true well inside the ceiling — a several-minute interruption is not
  // an outage either.
  assert.equal(keepStandingAfterFailedRefresh(4_210, NOW - 10 * 60_000, undefined, NOW), true)
})

test('a sustained failure eventually does report unavailable', () => {
  assert.equal(
    keepStandingAfterFailedRefresh(4_210, NOW - GENSTUDIO_STALE_CEILING_MS - 1, undefined, NOW),
    false,
    'past the ceiling, "last known" is misleading rather than informative',
  )
  assert.equal(
    keepStandingAfterFailedRefresh(null, null, undefined, NOW),
    false,
    'with no balance ever loaded there is nothing to keep showing',
  )
})

test('a scope failure is definitive and never answered from the last known balance', () => {
  assert.equal(
    keepStandingAfterFailedRefresh(4_210, NOW - 5_000, 'GENSTUDIO_USAGE_SCOPE_UNAVAILABLE', NOW),
    false,
  )
})

test('a stale value renders as stale, and a current one renders no marker at all', () => {
  assert.equal(genstudioStaleNote(false, NOW - 9 * 60_000), '', 'nothing on the happy path')
  assert.equal(genstudioStaleNote(true, Date.now() - 9 * 60_000), 'Last known · 9 minutes ago')
  assert.equal(formatGenStudioAge(null), 'never fetched')
  assert.equal(formatGenStudioAge(Date.now()), 'just now')
  assert.equal(formatGenStudioAge(Date.now() - 60_000), '1 minute ago')
  assert.equal(formatGenStudioAge(Date.now() - 2 * 3_600_000), '2 hours ago')
})

test('the standing strip keeps live status without a balance or its staleness marker', () => {
  const strip = readFileSync(new URL('../components/GenStudioStandingStrip.vue', import.meta.url), 'utf8')
  // Owner removed price and credit display; the strip still carries the tier
  // and live job count from the same overview read.
  assert.doesNotMatch(strip, /stalenessNote|freshness-badge|creditSummary/)
  assert.match(strip, /standingSummary/)
  assert.match(strip, /genstudioTier/)
  assert.match(strip, /gatewayJobsLine\(/)
})

test('the audio generator marks its published figures when they are stale', () => {
  const page = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  assert.match(page, /ttsCatalogStaleNote/)
  assert.match(page, /genstudioStaleNote\(ttsModelsStale\.value, ttsModelsLoadedAt\.value\)/)
  // Beside the rate/minimum line AND the cost block, the two places this page
  // states GenStudio's own figures as fact.
  assert.equal((page.match(/<em v-if="ttsCatalogStaleNote" class="freshness-badge"/g) || []).length, 2)
  assert.match(page, /\{\{ ttsCatalogStaleNote \}\} · display only\./)
  assert.match(page, /@click="loadTtsModels">Retry/)
})
