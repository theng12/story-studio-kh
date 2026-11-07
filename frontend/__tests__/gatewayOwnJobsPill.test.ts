/**
 * The header Gateway pill counts THIS Story instance's jobs.
 *
 * It used to read the Gateway overview's `paid_active_jobs` — every job the
 * Gateway runs behind one key, on every Mac — so a single Story showed the
 * whole fleet's work as its own. The count now comes from the local
 * `/jobs/all` stream, which is scoped to this install's projects, and the
 * line never claims fleet capacity it cannot compute from that count.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const strip = readFileSync(
  new URL('../components/GenStudioStandingStrip.vue', import.meta.url),
  'utf8',
)
const queue = readFileSync(
  new URL('../composables/useAllJobs.ts', import.meta.url),
  'utf8',
)

test('the pill reads this Story instance\'s queue, never the Gateway fleet figure', () => {
  assert.match(strip, /useAllJobs\(\)/)
  assert.match(strip, /gatewayOwnJobs/)
  assert.match(strip, /gatewayJobsLine\(gatewayOwnJobs\.value, null\)/)
  // No fleet-wide figure may reach the pill: the overview's job counts stay
  // out of this component entirely.
  assert.doesNotMatch(strip, /genstudioActiveLanes|genstudioLaneLimit|paid_active_jobs/)
  // The local stream is the existing authoritative path — server-counted
  // stats for this install's scopes, kept live between snapshots.
  assert.match(queue, /new EventSource\('\/api\/jobs\/all\/stream'\)/)
  assert.match(queue, /stats: readonly\(stats\)/)
})

test('the pill leases account standing and the local queue together, and unread is not zero', () => {
  assert.match(strip, /startPolling\(\)/)
  assert.match(strip, /releasePolling\?\.\(\)/)
  assert.match(strip, /startOwnJobs\(\)/)
  assert.match(strip, /stopOwnJobs\(\)/)
  // Before the first snapshot the count is null, not 0: "could not read yet"
  // must not render as "measured none".
  assert.match(strip, /ownJobsLoading\.value \? null : ownJobStats\.value\.running/)
})

test('the job line says nothing for zero and for unknown, and states room only with a limit', async () => {
  const { gatewayJobsLine } = await import('../utils/genstudio-freshness.js')
  assert.equal(gatewayJobsLine(0, null), '', 'measured idle shows nothing')
  assert.equal(gatewayJobsLine(null, null), '', 'unread shows nothing, never a zero')
  assert.equal(gatewayJobsLine(1, null), '1 job running')
  assert.equal(gatewayJobsLine(2, null), '2 jobs running')
  // A caller that owns a capacity limit for the same scope still gets room.
  assert.equal(gatewayJobsLine(1, 4), '1 job running · room for 3 more')
})
