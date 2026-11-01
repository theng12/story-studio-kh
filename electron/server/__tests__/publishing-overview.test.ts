/**
 * The global Publishing Overview's honesty rules.
 *
 * These tests exist because the feature's whole job is to NOT lie: a channel
 * with no plan must say so, a LOCAL plan must never clear a CONFIRMED coverage
 * gap, an empty slot in the MIDDLE of a schedule must be found (not just "after
 * the last date"), an unreadable store must be unknown (never a zero), and
 * nothing may invent a production ETA.
 *
 * Real temp filesystem, real readers — no mocked stores. The three time
 * concepts (confirmed / planned / readiness) are seeded and asserted separately
 * so a merge of any two would fail here.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import type { UploadSchedule } from '../services/upload-plans.js'

let pm: typeof import('../services/project-manager.js')
let svc: typeof import('../services/publishing-overview.js')
let plans: typeof import('../services/upload-plans.js')
let cadence: typeof import('../services/publish-cadence.js')
let connections: typeof import('../services/youtube-connection-store.js')
let im: typeof import('../services/idea-manager.js')
let pub: typeof import('../services/youtube-publication-cache.js')
let store: typeof import('../services/youtube-project-publishing-store.js')

let tmp: { dir: string; cleanup: () => Promise<void> }

before(async () => {
  pm = await import('../services/project-manager.js')
  svc = await import('../services/publishing-overview.js')
  plans = await import('../services/upload-plans.js')
  cadence = await import('../services/publish-cadence.js')
  connections = await import('../services/youtube-connection-store.js')
  im = await import('../services/idea-manager.js')
  pub = await import('../services/youtube-publication-cache.js')
  store = await import('../services/youtube-project-publishing-store.js')
})
beforeEach(async () => {
  await tmp?.cleanup()
  tmp = await useTempDataDir()
})
after(async () => { await tmp?.cleanup() })

/** A fixed Monday-anchored three-a-week cadence in UTC, so slots are deterministic. */
const SCHEDULE = { weekdays: [1, 3, 5], time_local: '18:00', timezone: 'UTC', start_date: '2020-01-06' }

const CHANNEL = 'UC-pub'

/**
 * A project whose publishing cadence is REALLY stored.
 *
 * `pm.createProject({ publish_cadence })` does NOT store it: that write sits
 * inside `if (!existsSync(configPath))`, and the blank template already ships a
 * config.json (`electron/templates/blank/config.json`), so the block is skipped
 * and the argument is silently dropped. Seeding that way made every
 * cadence-dependent assertion below read an absent plan ("Publishing plan not
 * set") — a fixture bug, not a product one: `POST /projects` validates with a
 * `.strict()` schema that has no `publish_cadence` key, so no product path can
 * supply one at creation either, and the owner's rhythm is stored by
 * `saveChannelSchedule` instead.
 *
 * So the cadence is seeded through the product's own writer, which is exactly
 * what `saveChannelSchedule` calls, and `readCadence` reads it back unchanged.
 */
async function projectWithCadence(name: string, prefix: string, schedule: UploadSchedule = SCHEDULE) {
  const created = await pm.createProject({ name, episode_prefix: prefix })
  await cadence.writeCadence(created.slug, {
    schedule,
    defaults: { privacy_status: 'private', made_for_kids: false },
  })
  return created
}

/**
 * A channel that is ASSIGNED and CONNECTED, so `resolveYouTubeCredential`
 * answers with a channel id and the confirmed (YouTube) half of the overview is
 * reachable at all.
 */
async function connectedProject(name: string, prefix: string, schedule: UploadSchedule = SCHEDULE) {
  const created = await projectWithCadence(name, prefix, schedule)
  await connections.configureYouTubeApplication({ client_id: 'po-client', client_secret: 'po-client-secret-value' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Publishing Channel', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'po-access', refresh_token: 'po-refresh', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: created.slug, channel_id: CHANNEL, expected_previous_channel_id: null,
  })
  return created
}

/** What YouTube reported: private videos with a publishAt. The real coverage. */
async function seedConfirmed(
  slug: string,
  entries: Array<{ video_id: string; scheduled_for: string; episode_code?: string; checked_at?: string }>,
  listing: { attempted_at?: string; outcome: 'complete' | 'partial' | 'failed' } = { outcome: 'complete' },
): Promise<void> {
  const now = new Date().toISOString()
  await pub.recordYouTubePublicationObservations({
    project_slug: slug,
    channel_id: CHANNEL,
    checks: entries.map(entry => ({
      video_id: entry.video_id,
      source: 'reconcile' as const,
      ...(entry.episode_code ? { episode_code: entry.episode_code } : {}),
      checked_at: entry.checked_at ?? now,
      privacy_status: 'private',
      scheduled_for: entry.scheduled_for,
      title: 'Scheduled episode',
    })),
    listing: { attempted_at: listing.attempted_at ?? now, outcome: listing.outcome },
  })
}

/** An accepted episode with a finished, admissible final video and no YouTube copy. */
async function acceptedEpisode(slug: string, code: string, title: string): Promise<void> {
  const [idea] = await im.addIdeas(slug, [{
    title, logline: 'l', themes: ['t'], suggested_chapters: 3, suggested_length: '10 min', mood: 'm',
  }], 'test-model')
  await im.promoteToAccepted(slug, idea!.id, { episode_code: code })
  const paths = await (await import('../services/utils.js')).resolveEpisodePaths(slug, code, title)
  await fs.mkdir(paths.video_dir, { recursive: true })
  await fs.writeFile(`${paths.video_dir}/${code}_final_video.mp4`, Buffer.alloc(2048, 1))
}

/**
 * An accepted episode with NO finished video — the purely LOCAL fact that means
 * "needs generating". Nothing about it depends on the YouTube link read.
 */
async function pendingEpisode(slug: string, code: string): Promise<void> {
  const [idea] = await im.addIdeas(slug, [{
    title: `Pending ${code}`, logline: 'l', themes: ['t'], suggested_chapters: 3, suggested_length: '10 min', mood: 'm',
  }], 'test-model')
  await im.promoteToAccepted(slug, idea!.id, { episode_code: code })
}

/**
 * An accepted episode whose read FAILS: its code does not match the project's
 * episode prefix, so `resolveEpisodePaths` refuses it (`episodeNumber` throws)
 * exactly as a genuinely corrupt episode record would. Nothing can be said about
 * this episode — which is the point.
 */
async function unreadableEpisode(slug: string, code: string): Promise<void> {
  const [idea] = await im.addIdeas(slug, [{
    title: `Unreadable ${code}`, logline: 'l', themes: ['t'], suggested_chapters: 3, suggested_length: '10 min', mood: 'm',
  }], 'test-model')
  await im.promoteToAccepted(slug, idea!.id, { episode_code: code })
}

test('a channel with no cadence says "Publishing plan not set" — never a guessed rhythm', async () => {
  const now = Date.now()
  await pm.createProject({ name: 'No Plan Channel', episode_prefix: 'NP' })

  const overview = await svc.readPublishingOverview({ now })
  const channel = overview.channels[0]!

  assert.equal(channel.plan_set, false)
  assert.deepEqual(channel.planned.slots, [])
  assert.equal(channel.planned.next_uncovered_slot_at, null)
  assert.equal(channel.coverage.next_uncovered_slot, null)
  assert.equal(channel.coverage.at_risk, false)
  // No channel connected AND nothing ever checked: unknown, not a confident zero.
  assert.equal(channel.confirmed.freshness, 'unknown')
  assert.equal(channel.confirmed.error, 'no_channel_assigned')
  assert.equal(channel.confirmed.count, 0)
  // The next step still points somewhere real, and there is nothing concrete
  // to recommend yet.
  assert.equal(channel.next_action.url, `/projects/no-plan-channel/board`)
  assert.deepEqual(channel.recommendations, [])
})

test('a LOCAL plan never clears a CONFIRMED gap — the uncovered slot is the first', async () => {
  const now = Date.now()
  const created = await projectWithCadence('Gap Channel', 'GP')
  const expected = plans.computeSlots(SCHEDULE, svc.PLANNED_SLOT_HORIZON, { notBefore: new Date(now) })
  assert.ok(expected.length >= 4, 'fixture needs at least four slots')

  // A locally chosen date on the THIRD slot only, and NOTHING confirmed.
  await pm.updateConfig(created.slug, { upload_item_schedule: { 'import:covered': expected[2]! } } as any)

  const overview = await svc.readPublishingOverview({ now })
  const channel = overview.channels[0]!

  assert.equal(channel.plan_set, true)
  // The local plan does NOT cover the gap: the FIRST slot is still uncovered
  // because YouTube has confirmed nothing.
  assert.equal(channel.coverage.next_uncovered_slot, expected[0])
  assert.equal(channel.coverage.at_risk, true)
  // The slot really was seen as locally planned — otherwise the assertion above
  // could pass for the wrong reason (an unreadable schedule map).
  assert.equal(channel.planned.slots[2]!.planned, true)
  assert.equal(channel.planned.slots[2]!.confirmed, false)
  // And the local plan is visible as an event, with no invented episode identity
  // for a non-episode key.
  assert.equal(channel.coverage.planned_date_count, 1)
  assert.equal(channel.planned.assignments[0]!.at, expected[2])
  assert.equal(channel.planned.assignments[0]!.episode_code, undefined)
})

test('confirmed coverage is what clears a slot; a local plan alone does not', async () => {
  const now = Date.now()
  const created = await projectWithCadence('Both Channel', 'BP')
  const expected = plans.computeSlots(SCHEDULE, svc.PLANNED_SLOT_HORIZON, { notBefore: new Date(now) })
  assert.ok(expected.length >= 3)
  // Two locally planned dates, no confirmed schedules.
  await pm.updateConfig(created.slug, {
    upload_item_schedule: { 'import:a': expected[0]!, 'import:b': expected[1]! },
  } as any)

  const overview = await svc.readPublishingOverview({ now })
  const channel = overview.channels[0]!
  // Both planned slots still read as uncovered (nothing confirmed).
  assert.equal(channel.planned.slots[0]!.planned, true)
  assert.equal(channel.planned.slots[0]!.confirmed, false)
  assert.equal(channel.coverage.next_uncovered_slot, expected[0])
  assert.equal(channel.coverage.last_planned_date, expected[1]!.slice(0, 10))
  assert.equal(channel.coverage.last_confirmed_date, null)
  assert.equal(channel.coverage.scheduled_video_count, 0)
})

// ── The central rule, with a REAL confirmed schedule ─────────────────────
//
// Every test above seeds no confirmed schedule at all, which left the feature's
// whole point untested. These seed what YouTube actually reported and assert
// that it — and only it — covers a slot.

test('a confirmed schedule covers its slot: the gap moves past it and the channel is not at risk', async () => {
  const now = Date.now()
  const created = await connectedProject('Confirmed Channel', 'CF')
  const expected = plans.computeSlots(SCHEDULE, svc.PLANNED_SLOT_HORIZON, { notBefore: new Date(now) })
  assert.ok(expected.length >= 3, 'fixture needs at least three slots')
  await seedConfirmed(created.slug, [
    { video_id: 'vid-confirmed', scheduled_for: expected[0]!, episode_code: 'EP0001' },
  ], { outcome: 'complete' })

  const overview = await svc.readPublishingOverview({ now })
  const channel = overview.channels[0]!

  // The confirmed schedule sits on the FIRST slot and covers it.
  assert.equal(channel.planned.slots[0]!.confirmed, true)
  assert.equal(channel.planned.slots[0]!.planned, false)
  // So the earliest gap is the NEXT one, not the first slot.
  assert.equal(channel.coverage.next_uncovered_slot, expected[1])
  assert.equal(channel.planned.next_uncovered_slot_at, expected[1])
  // And the channel is NOT at risk: its very next slot is covered.
  assert.equal(channel.coverage.at_risk, false)
  assert.equal(channel.coverage.last_confirmed_date, expected[0]!.slice(0, 10))
  assert.equal(channel.coverage.scheduled_video_count, 1)
  assert.equal(channel.confirmed.next_at, expected[0])
  assert.equal(channel.confirmed.count, 1)

  // A complete, fully-observed listing is the only thing that earns "fresh".
  assert.equal(channel.confirmed.freshness, 'fresh')

  // The confirmed event is on the calendar, as its own kind, with its video id.
  const confirmedEvents = overview.calendar.filter(entry => entry.kind === 'confirmed')
  assert.equal(confirmedEvents.length, 1)
  assert.equal(confirmedEvents[0]!.at, expected[0])
  assert.equal(confirmedEvents[0]!.video_id, 'vid-confirmed')
  assert.equal(confirmedEvents[0]!.channel_slug, created.slug)
})

test('one video covers one slot: two confirmed videos on one day do not cover two slots', async () => {
  const now = Date.now()
  const created = await connectedProject('Double Channel', 'DB')
  const expected = plans.computeSlots(SCHEDULE, svc.PLANNED_SLOT_HORIZON, { notBefore: new Date(now) })
  assert.ok(expected.length >= 3)
  // Two videos, the SAME publishAt — a double upload on one day.
  await seedConfirmed(created.slug, [
    { video_id: 'vid-a', scheduled_for: expected[0]! },
    { video_id: 'vid-b', scheduled_for: expected[0]! },
  ], { outcome: 'complete' })

  const overview = await svc.readPublishingOverview({ now })
  const channel = overview.channels[0]!

  assert.equal(channel.coverage.scheduled_video_count, 2)
  // The day is covered once, and the second video does NOT spill onto the next
  // slot: two facts, not four.
  assert.equal(channel.planned.slots[0]!.confirmed, true)
  assert.equal(channel.planned.slots[1]!.confirmed, false)
  assert.equal(channel.coverage.next_uncovered_slot, expected[1])
  assert.equal(channel.coverage.at_risk, false)
})

test('next_unplanned_slot_at is the first slot with neither a confirmed schedule nor a local plan', async () => {
  const now = Date.now()
  const created = await connectedProject('Planned Channel', 'PC')
  const expected = plans.computeSlots(SCHEDULE, svc.PLANNED_SLOT_HORIZON, { notBefore: new Date(now) })
  assert.ok(expected.length >= 4)
  await seedConfirmed(created.slug, [{ video_id: 'vid-first', scheduled_for: expected[0]! }], { outcome: 'complete' })
  // A locally chosen date on the SECOND slot — planned, but NOT confirmed.
  await pm.updateConfig(created.slug, { upload_item_schedule: { 'import:local': expected[1]! } } as any)

  const overview = await svc.readPublishingOverview({ now })
  const channel = overview.channels[0]!

  assert.equal(channel.planned.slots[0]!.confirmed, true)
  assert.equal(channel.planned.slots[1]!.planned, true)
  assert.equal(channel.planned.slots[1]!.confirmed, false)
  // Uncovered = no CONFIRMED schedule, so the second slot is still the gap…
  assert.equal(channel.coverage.next_uncovered_slot, expected[1])
  // …but "unplanned" also requires no local intent, so it is the third.
  assert.equal(channel.planned.next_unplanned_slot_at, expected[2])
  assert.equal(channel.coverage.at_risk, false)
  // One confirmed event; the locally planned date carries its own marker (with
  // its identity absent for a non-episode key); and EVERY expected slot with
  // nothing on it gets an empty marker — not one marker for "the" empty slot.
  // The horizon is 12 slots, two of which are occupied here, so 12 − 2 = 10
  // empty markers plus the one local plan. Pinned as the rule rather than a
  // literal, because `expected.length >= 4` above already rules out a count of 2.
  assert.equal(overview.calendar.filter(e => e.kind === 'confirmed').length, 1)
  const planned = overview.calendar.filter(e => e.kind === 'planned')
  assert.equal(planned.length, 1 + (expected.length - 2))
  assert.equal(planned.filter(e => e.empty === true).length, expected.length - 2)
  assert.equal(planned.find(e => e.at === expected[1]!)!.empty, undefined)
  assert.equal(planned.find(e => e.at === expected[2]!)!.empty, true)
})

test('freshness is stale for a partial listing or a stale observation, never a confident fresh', async () => {
  const now = Date.now()
  const created = await connectedProject('Stale Channel', 'ST')
  const expected = plans.computeSlots(SCHEDULE, svc.PLANNED_SLOT_HORIZON, { notBefore: new Date(now) })

  // A truncated (partial) channel listing: we have not seen everything.
  await seedConfirmed(created.slug, [{ video_id: 'vid-partial', scheduled_for: expected[0]! }], { outcome: 'partial' })
  let overview = await svc.readPublishingOverview({ now })
  assert.equal(overview.channels[0]!.confirmed.freshness, 'stale')
  // The schedule itself is still real coverage — staleness is about trust.
  assert.equal(overview.channels[0]!.coverage.scheduled_video_count, 1)

  // Now a complete listing, but one observation older than the TTL.
  const old = new Date(now - pub.PUBLICATION_CACHE_TTL_MS * 2).toISOString()
  await seedConfirmed(created.slug, [{ video_id: 'vid-old', scheduled_for: expected[1]!, checked_at: old }], { outcome: 'complete' })
  overview = await svc.readPublishingOverview({ now })
  assert.equal(overview.channels[0]!.confirmed.freshness, 'stale')
})

test('the confirmed half names the artifact that is old: the listing state, its date, and the stale checks', async () => {
  const now = Date.now()
  const created = await connectedProject('Provenance Channel', 'PV')
  const expected = plans.computeSlots(SCHEDULE, svc.PLANNED_SLOT_HORIZON, { notBefore: new Date(now) })
  const old = new Date(now - pub.PUBLICATION_CACHE_TTL_MS * 2).toISOString()
  // A listing that stopped early, and an observation from long ago.
  await seedConfirmed(created.slug, [{ video_id: 'vid-old', scheduled_for: expected[0]!, checked_at: old }], { outcome: 'partial' })

  let channel = (await svc.readPublishingOverview({ now })).channels[0]!
  assert.equal(channel.confirmed.listing?.state, 'partial')
  assert.equal(channel.confirmed.listing?.stale, true, 'a listing that stopped early has no complete listing to date')
  const partialAt = channel.confirmed.listing?.partial_at
  assert.ok(partialAt)
  assert.equal(channel.confirmed.listing?.complete_at, null)
  assert.equal(channel.confirmed.listing?.last_attempt?.outcome, 'partial')
  assert.equal(channel.confirmed.stale_videos, 1, 'the video past the TTL is counted, not left implicit')

  // A listing that could not be read: the attempt is recorded with its code,
  // and the last successful listing survives it.
  await pub.recordYouTubePublicationObservations({
    project_slug: created.slug, channel_id: CHANNEL,
    listing: { attempted_at: new Date().toISOString(), outcome: 'failed', error_code: 'provider_error' },
  })
  channel = (await svc.readPublishingOverview({ now })).channels[0]!
  assert.equal(channel.confirmed.listing?.last_attempt?.outcome, 'failed')
  assert.equal(channel.confirmed.listing?.last_attempt?.error_code, 'provider_error')
  assert.equal(channel.confirmed.listing?.partial_at, partialAt, 'the earlier listing is still dated')
})

test('a confirmed release on a day the plan does not expect is counted, and coverage is not changed', async () => {
  const now = Date.now()
  const created = await connectedProject('Off Cadence Channel', 'OC')
  const expected = plans.computeSlots(SCHEDULE, svc.PLANNED_SLOT_HORIZON, { notBefore: new Date(now) })
  // The plan expects Monday/Wednesday/Friday; this release lands the day after
  // the first slot — inside the horizon, on a day the plan never expects.
  const offDay = new Date(Date.parse(expected[0]!) + 24 * 60 * 60 * 1000).toISOString()
  await seedConfirmed(created.slug, [{ video_id: 'vid-off', scheduled_for: offDay }], { outcome: 'complete' })

  const channel = (await svc.readPublishingOverview({ now })).channels[0]!
  assert.equal(channel.cadence?.off_cadence_count, 1)
  assert.deepEqual(channel.cadence?.off_cadence_weekdays, [new Date(offDay).getUTCDay()])
  // It covers no slot: the gap is still the first expected one, and the plan
  // is not repaired to fit the release.
  assert.equal(channel.planned.slots[0]!.confirmed, false)
  assert.equal(channel.coverage.next_uncovered_slot, expected[0])
  assert.equal(channel.coverage.at_risk, true)
  assert.equal(channel.coverage.scheduled_video_count, 1, 'the release is real coverage of its own day')
})

test('the off-cadence count is against the ACTUAL expected days, not the plan’s weekdays', async () => {
  const now = Date.now()
  // A monthly plan: its expected days are the 15ths, and over twelve months
  // their weekdays run through every day of the week. A release on the 16th
  // lands on a weekday the plan uses — but on no day the plan expects.
  const monthly = { weekdays: [], monthly_day: 15, time_local: '18:00', timezone: 'UTC', start_date: '2020-01-15' } as UploadSchedule
  const created = await connectedProject('Monthly Channel', 'MO', monthly)
  const expected = plans.computeSlots(monthly, svc.PLANNED_SLOT_HORIZON, { notBefore: new Date(now) })
  assert.ok(expected.length >= 2, 'fixture needs at least two monthly slots')
  const offDay = new Date(Date.parse(expected[0]!) + 24 * 60 * 60 * 1000).toISOString()
  const planWeekdays = new Set(expected.map(slot => new Date(slot).getUTCDay()))
  assert.ok(planWeekdays.has(new Date(offDay).getUTCDay()), 'the release lands on a weekday the plan uses')
  await seedConfirmed(created.slug, [{ video_id: 'vid-off', scheduled_for: offDay }], { outcome: 'complete' })

  const channel = (await svc.readPublishingOverview({ now })).channels[0]!
  assert.equal(channel.cadence?.off_cadence_count, 1, 'counted against the days the plan expects, not its weekdays')
  assert.equal(channel.coverage.next_uncovered_slot, expected[0], 'coverage is unchanged')
})

test('a locally planned date never makes a channel look covered', async () => {
  const now = Date.now()
  const created = await connectedProject('Local Only Channel', 'LO')
  const expected = plans.computeSlots(SCHEDULE, svc.PLANNED_SLOT_HORIZON, { notBefore: new Date(now) })
  await pm.updateConfig(created.slug, {
    upload_item_schedule: { 'import:a': expected[0]!, 'import:b': expected[1]!, 'import:c': expected[2]! },
  } as any)

  const overview = await svc.readPublishingOverview({ now })
  const channel = overview.channels[0]!

  // Three local dates, zero YouTube confirmations: still the FIRST slot is the
  // gap, and the channel is at risk.
  assert.equal(channel.coverage.scheduled_video_count, 0)
  assert.equal(channel.coverage.last_confirmed_date, null)
  assert.equal(channel.coverage.next_uncovered_slot, expected[0])
  assert.equal(channel.coverage.at_risk, true)
  assert.equal(overview.calendar.filter(e => e.kind === 'confirmed').length, 0)
})

// ── Honesty: an unreadable read is not a smaller number ──────────────────

test('an episode whose read fails is UNKNOWN — the ready count is null, never silently short', async () => {
  const now = Date.now()
  const created = await connectedProject('Half Read Channel', 'HR')
  await acceptedEpisode(created.slug, 'HR0001', 'Ready One')
  // A code no resolver can read (not letters + digits). A foreign prefix such as
  // ZZ0002 is no longer unreadable: since 1.4.368 a stored code resolves by its
  // number whatever prefix it was accepted under (`storedEpisodeNumber`).
  await unreadableEpisode(created.slug, 'ZZ-0002')

  const overview = await svc.readPublishingOverview({ now })
  const channel = overview.channels[0]!

  // One episode really is ready; one could not be read. The answer is "unknown",
  // not "1" — a count short by its failures would mean two things at once.
  assert.equal(channel.readiness.ready_unknown, 1)
  assert.equal(channel.readiness.ready_to_publish, null)
  assert.equal(channel.coverage.ready_video_count, null)
  // The count is not claimed…
  assert.notEqual(channel.priority.reason, 'close_to_complete')
  // …but the concrete episode we COULD read is still offered, with its route.
  assert.equal(channel.recommendations[0]!.episode_code, 'HR0001')
  assert.equal(channel.recommendations[0]!.kind, 'ready_to_publish')
  assert.equal(channel.recommendations[0]!.url, `/projects/${created.slug}/upload/publish?episode_id=HR0001`)
  assert.equal(channel.next_action.episode_code, 'HR0001')
})

test('a clean sweep reports the real ready count and a recommendation from a real finished episode', async () => {
  const now = Date.now()
  const created = await connectedProject('Ready Channel', 'RD')
  await acceptedEpisode(created.slug, 'RD0001', 'Ready One')
  await acceptedEpisode(created.slug, 'RD0002', 'Ready Two')

  const overview = await svc.readPublishingOverview({ now })
  const channel = overview.channels[0]!

  assert.equal(channel.readiness.ready_unknown, 0)
  assert.equal(channel.readiness.ready_to_publish, 2)
  assert.equal(channel.coverage.ready_video_count, 2)
  // The episode is admitted by the SAME selector the upload route uses, so a
  // suggestion here is one the upload route would also accept.
  assert.deepEqual(channel.recommendations.map(r => r.episode_code), ['RD0001', 'RD0002'])
  assert.equal(channel.next_action.url, `/projects/${created.slug}/upload/publish?episode_id=RD0001`)
})

test('a corrupt idea store is UNKNOWN, a genuinely empty one a real 0 — both pinned apart', async () => {
  const now = Date.now()
  const created = await connectedProject('Idea Store Channel', 'IS')
  const expected = plans.computeSlots(SCHEDULE, svc.PLANNED_SLOT_HORIZON, { notBefore: new Date(now) })
  assert.ok(expected.length >= 1, 'fixture needs at least one slot')
  // One locally chosen date on a key that names no episode, so the identity
  // question is asked of the SAME key in both halves below.
  await pm.updateConfig(created.slug, { upload_item_schedule: { 'import:local': expected[0]! } } as any)

  // (a) READABLE and genuinely empty: every count over the episode list is a
  // real 0, and the channel can say so.
  let overview = await svc.readPublishingOverview({ now })
  let channel = overview.channels[0]!
  assert.equal(channel.readiness.episodes, 0)
  assert.equal(channel.readiness.episodes_with_code, 0)
  assert.equal(channel.readiness.ready_to_publish, 0)
  assert.equal(channel.readiness.ready_unknown, 0)
  assert.equal(channel.readiness.on_youtube, 0)
  assert.equal(channel.readiness.in_progress, 0)
  assert.equal(channel.readiness.needs_attention, 0)
  assert.equal(channel.readiness.error, undefined)
  assert.equal(channel.coverage.ready_video_count, 0)
  // An absent episode_code on a NON-episode key means "this key names no
  // episode" — the other answer, spelled the other way.
  assert.equal(channel.planned.assignments[0]!.episode_code, undefined)
  assert.equal(channel.planned.assignments[0]!.identity_unknown, undefined)

  // (b) The same store, now present but UNPARSEABLE. `getIdeas`'s own reader
  // degrades a corrupt ideas.json to an EMPTY store, so without the probe this
  // half would report the same confident 0s as (a).
  await fs.writeFile(`${pm.projectsRoot()}/${created.slug}/ideas.json`, '{ this is not json')
  overview = await svc.readPublishingOverview({ now })
  channel = overview.channels[0]!

  assert.equal(channel.readiness.episodes, null)
  assert.equal(channel.readiness.episodes_with_code, null)
  assert.equal(channel.readiness.ready_to_publish, null)
  assert.equal(channel.readiness.on_youtube, null)
  assert.equal(channel.readiness.in_progress, null)
  assert.equal(channel.readiness.needs_attention, null)
  assert.equal(channel.coverage.ready_video_count, null)
  assert.equal(typeof channel.readiness.error, 'string')
  assert.match(channel.readiness.error!, /could not read this channel's ideas/)

  // The SAME planned key now means "unknown", never "not an episode", and no
  // episode link may be invented for it.
  assert.equal(channel.planned.assignments[0]!.episode_code, undefined)
  assert.equal(channel.planned.assignments[0]!.identity_unknown, true)
  const plannedEntry = overview.calendar.find(e => e.kind === 'planned' && e.at === expected[0]!)!
  assert.equal(plannedEntry.identity_unknown, true)
  assert.equal(plannedEntry.episode_code, undefined)
  // Nothing is recommended from a store that could not be read, and no count is
  // presented as complete.
  assert.deepEqual(channel.recommendations, [])
  assert.equal(channel.next_action.kind, 'none')
  assert.notEqual(channel.priority.reason, 'close_to_complete')
})

test('a failed YouTube link read leaves the ready count unknown and never claims "not on YouTube yet"', async () => {
  const now = Date.now()
  const created = await connectedProject('Link Read Channel', 'LR')
  // Two finished episodes, and one accepted episode with no finished video.
  await acceptedEpisode(created.slug, 'LR0001', 'Already On YouTube')
  await acceptedEpisode(created.slug, 'LR0002', 'Finished Locally')
  await pendingEpisode(created.slug, 'LR0003')
  // LR0001 really is on YouTube. LR0002 is a finished local video with no copy.
  await store.linkYouTubeEpisodeVideo({
    project_slug: created.slug,
    episode_code: 'LR0001',
    channel_id: CHANNEL,
    video_id: 'vid-linked',
    source: 'upload',
    decided_at: new Date(now).toISOString(),
  })

  // Baseline: the linked episode is NOT suggested, the unlinked finished one IS,
  // and the missing-video one is offered for generation — a purely LOCAL fact.
  let overview = await svc.readPublishingOverview({ now })
  let channel = overview.channels[0]!
  assert.equal(channel.readiness.on_youtube, 1)
  assert.equal(channel.readiness.ready_to_publish, 1)
  assert.equal(channel.coverage.ready_video_count, 1)
  assert.deepEqual(channel.recommendations.map(r => r.episode_code), ['LR0002', 'LR0003'])
  assert.equal(channel.recommendations[0]!.kind, 'ready_to_publish')
  assert.equal(channel.recommendations[0]!.reason, 'Finished video, not on YouTube yet.')
  assert.equal(channel.recommendations[1]!.kind, 'needs_generation')
  // The linked episode is not in the list at all — that is what the link read
  // bought us, and what a failed read must not silently un-buy.
  assert.equal(channel.recommendations.some(r => r.episode_code === 'LR0001'), false)

  // Now the link read FAILS. We can no longer tell which finished episode is
  // already on YouTube, so "finished AND not already published" cannot be
  // decided: the count is unknown and no publish claim may be made.
  await fs.writeFile(`${pm.projectsRoot()}/${created.slug}/youtube/project-state.json`, '{ this is not json')
  overview = await svc.readPublishingOverview({ now })
  channel = overview.channels[0]!

  assert.equal(channel.readiness.on_youtube, null)
  assert.equal(channel.readiness.ready_to_publish, null)
  assert.equal(channel.coverage.ready_video_count, null)
  // The per-episode reads SUCCEEDED — it is the link read that failed, and the
  // reason says exactly that rather than blaming the sweep.
  assert.equal(channel.readiness.ready_unknown, 0)
  assert.match(channel.readiness.error!, /could not read which episodes are already on YouTube/)

  // The harm: LR0001 IS on YouTube, and LR0002 might be. No "not on YouTube yet"
  // may survive the failure — not as a recommendation, not as a next step.
  assert.deepEqual(channel.recommendations.filter(r => r.kind === 'ready_to_publish'), [])
  assert.equal(JSON.stringify(channel.recommendations).includes('not on YouTube yet'), false)
  assert.notEqual(channel.next_action.kind, 'ready_to_publish')
  // The needs-generation suggestion is kept — its reason is a verified LOCAL
  // fact (no finished video), which the failed link read does not touch.
  assert.deepEqual(channel.recommendations.map(r => r.episode_code), ['LR0003'])
  assert.equal(channel.recommendations[0]!.kind, 'needs_generation')
  assert.equal(channel.recommendations[0]!.reason, 'Accepted, no finished video yet.')
  assert.equal(channel.next_action.kind, 'needs_generation')
  assert.notEqual(channel.priority.reason, 'close_to_complete')
})

test('an unreadable plan is "could not read", not "not set"', async () => {
  const now = Date.now()
  const created = await pm.createProject({ name: 'Corrupt Plan Channel', episode_prefix: 'CP' })
  // A config.json that cannot be parsed: `pm.getConfig` throws JsonCorruptError,
  // so the cadence read fails. That is NOT the same answer as "there is none".
  await fs.writeFile(`${pm.projectsRoot()}/${created.slug}/config.json`, '{ this is not json')

  const overview = await svc.readPublishingOverview({ now })
  const channel = overview.channels[0]!

  assert.equal(channel.plan_set, null)
  assert.equal(typeof channel.plan_error, 'string')
  assert.ok(channel.plan_error!.length > 0)
  // And nothing is invented from the failure: no slots, no risk, no gap.
  assert.deepEqual(channel.planned.slots, [])
  assert.equal(channel.coverage.next_uncovered_slot, null)
  assert.equal(channel.coverage.at_risk, false)
})

test('a cadence that cannot produce a slot is treated as no plan', async () => {
  const now = Date.now()
  const created = await pm.createProject({ name: 'Empty Rhythm', episode_prefix: 'ER' })
  // The record IS stored and IS unusable — a cadence that can never produce a
  // slot is worse than none, because it looks configured. Written through the
  // config directly because `writeCadence` (correctly) refuses this shape.
  await pm.updateConfig(created.slug, {
    publish_cadence: { schedule: { weekdays: [], time_local: '18:00', timezone: 'UTC' } },
  } as any)

  const overview = await svc.readPublishingOverview({ now })
  // Readable, and genuinely empty: false, not null.
  assert.equal(overview.channels[0]!.plan_set, false)
  assert.equal(overview.channels[0]!.plan_error, undefined)
  assert.deepEqual(overview.channels[0]!.planned.slots, [])
})

test('channels are ordered by earliest confirmed gap, then closest to finished', async () => {
  const now = Date.now()
  await pm.createProject({ name: 'Zeta No Plan', episode_prefix: 'ZP' })
  await projectWithCadence('Alpha Plan', 'AP')

  const overview = await svc.readPublishingOverview({ now })

  const first = overview.channels[0]!
  assert.equal(first.slug, 'alpha-plan')
  assert.equal(first.priority.reason, 'earliest_uncovered_slot')
  assert.ok(first.priority.at)

  const last = overview.channels.at(-1)!
  assert.equal(last.slug, 'zeta-no-plan')
  assert.equal(last.priority.reason, 'none')
})

test('no production ETA is invented anywhere in the payload', async () => {
  const now = Date.now()
  await projectWithCadence('Shape Channel', 'SP')

  const overview = await svc.readPublishingOverview({ now })
  const serialized = JSON.stringify(overview).toLowerCase()
  for (const forbidden of ['"eta"', 'eta_seconds', 'estimated_finish', 'finish_at', 'runway', 'estimated_publish']) {
    assert.equal(serialized.includes(forbidden), false, `payload must not carry ${forbidden}`)
  }
  // The three time concepts are present as separate fields, not collapsed.
  const channel = overview.channels[0]!
  assert.ok('confirmed' in channel && 'planned' in channel && 'readiness' in channel)
  // And the next action is a real, existing route.
  assert.match(channel.next_action.url, /^\/projects\/shape-channel\//)
})

// ── Brief A: the owner-set channel status label, and the two new figures ────

test('an absent channel_status is Unclassified, an unknown word is refused, and clearing lands on absent', async () => {
  const now = Date.now()
  const created = await projectWithCadence('Status Channel', 'SC')

  // New channels start unlabelled. Nothing infers a label from the cadence
  // they were given or from anything else on the payload.
  let channel = (await svc.readPublishingOverview({ now })).channels[0]!
  assert.equal(channel.channel_status, null)

  const { UpdateProjectSchema, CreateProjectSchema } = await import('../contracts/index.js')
  assert.equal(UpdateProjectSchema.parse({ channel_status: 'testing' }).channel_status, 'testing')
  assert.equal(UpdateProjectSchema.parse({ channel_status: null }).channel_status, null)
  // A word outside the vocabulary is a typo, not a label: refused at the
  // boundary rather than stored as a chip the page cannot name.
  assert.throws(() => UpdateProjectSchema.parse({ channel_status: 'live-ish' }), /Invalid enum value/)
  // And it is not a creation-time field: a new channel cannot be born labelled.
  assert.throws(() => CreateProjectSchema.parse({ name: 'x', channel_status: 'live' }))

  await pm.updateProject(created.slug, { channel_status: 'testing' })
  channel = (await svc.readPublishingOverview({ now })).channels[0]!
  assert.equal(channel.channel_status, 'testing', 'Komsan-style day-one marking works for any channel')

  // Reversible: null clears it, and the cleared state is the absent state.
  await pm.updateProject(created.slug, { channel_status: null })
  channel = (await svc.readPublishingOverview({ now })).channels[0]!
  assert.equal(channel.channel_status, null)
})

test('setting a label changes nothing in upload or publishing', async () => {
  const now = Date.now()
  const created = await connectedProject('Unchanged Channel', 'UC')
  const expected = plans.computeSlots(SCHEDULE, svc.PLANNED_SLOT_HORIZON, { notBefore: new Date(now) })
  await seedConfirmed(created.slug, [
    { video_id: 'vid-uc', scheduled_for: expected[0]!, episode_code: 'UC0001', checked_at: new Date(now - 60_000).toISOString() },
  ])
  await pm.updateConfig(created.slug, { upload_item_schedule: { 'import:local': expected[2]! } } as any)
  await acceptedEpisode(created.slug, 'UC0001', 'Ready One')

  const before = await svc.readPublishingOverview({ now })
  const withoutLabel = (response: typeof before) => response.channels.map(({ channel_status: _dropped, ...rest }) => rest)

  await pm.updateProject(created.slug, { channel_status: 'live' })
  const after = await svc.readPublishingOverview({ now })

  assert.equal(after.channels[0]!.channel_status, 'live')
  assert.deepEqual(withoutLabel(after), withoutLabel(before),
    'the label is the ONLY fact that changed — schedule, coverage, readiness, priority and calendar are identical')

  // …and clearing it puts the whole payload back exactly where it started.
  await pm.updateProject(created.slug, { channel_status: null })
  assert.deepEqual(await svc.readPublishingOverview({ now }), before)
})

test('only the settings write path and the overview read channel_status — no upload or publishing code', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const allowed = new Set([
    'electron/server/contracts/index.ts',
    'electron/server/contracts/publishing-overview.ts',
    'electron/server/models/types.ts',
    'electron/server/services/publishing-overview.ts',
    'frontend/pages/publishing.vue',
  ])
  const skip = new Set(['node_modules', '__tests__', '.nuxt', 'dist', '_trash', '.git'])
  const found = new Set<string>()

  for (const tree of ['electron/server', 'frontend']) {
    const base = path.join(root, tree)
    const entries = await fs.readdir(base, { recursive: true, withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const full = path.join(entry.parentPath ?? entry.path, entry.name)
      const relative = path.relative(root, full).split(path.sep).join('/')
      if ([...skip].some(part => relative.includes(`/${part}/`))) continue
      if (!/\.(ts|vue|mjs|js)$/.test(entry.name)) continue
      const text = await fs.readFile(full, 'utf-8')
      if (text.includes('channel_status')) found.add(relative)
    }
  }

  assert.deepEqual(
    [...found].sort(),
    [...allowed].sort(),
    'a status label must not be read by any upload, schedule or publish path — '
    + 'it is the settings write and the Overview read, nothing else',
  )
})

test('missing slots are counted at the channel’s OWN cadence — a real 0, and unknown when it cannot be known', async () => {
  const now = Date.now()
  const created = await connectedProject('Window Channel', 'WC')
  const expected = plans.computeSlots(SCHEDULE, svc.PLANNED_SLOT_HORIZON, { notBefore: new Date(now) })
  // The four-week window for this cadence: the next twelve slots, all of them
  // inside 28 days. Computed here from the public planner so the assertion does
  // not restate the service's own walk.
  const windowSlots = expected.filter(at => Date.parse(at) < now + 28 * 24 * 60 * 60 * 1000)
  assert.ok(windowSlots.length >= 3, 'fixture needs slots inside the window')

  // No plan yet: there is no cadence of its own to count against, so this is
  // unknown — not 0, which would read as "every slot is covered".
  let channel = (await svc.readPublishingOverview({ now })).channels[0]!
  assert.equal(channel.plan_set, true, 'the cadence is stored')
  await seedConfirmed(created.slug, [{ video_id: 'vid-wc-0', scheduled_for: windowSlots[0]! }], { outcome: 'complete' })
  channel = (await svc.readPublishingOverview({ now })).channels[0]!
  assert.equal(channel.confirmed.freshness, 'fresh')
  assert.equal(channel.coverage.missing_slots_4w, windowSlots.length - 1,
    'one confirmed slot leaves the rest of the window missing')

  // Every slot in the window confirmed: a real 0, kept apart from every unknown above.
  await seedConfirmed(created.slug, windowSlots.map((at, index) => ({
    video_id: `vid-wc-all-${index}`, scheduled_for: at,
  })), { outcome: 'complete' })
  channel = (await svc.readPublishingOverview({ now })).channels[0]!
  assert.equal(channel.coverage.missing_slots_4w, 0, 'every slot in the window is confirmed')
  assert.notEqual(channel.coverage.missing_slots_4w, null)
})

test('missing slots are unknown while coverage is stale or was never checked — never a number', async () => {
  const now = Date.now()
  const created = await connectedProject('Stale Window Channel', 'SW')
  const expected = plans.computeSlots(SCHEDULE, svc.PLANNED_SLOT_HORIZON, { notBefore: new Date(now) })
  const old = new Date(now - pub.PUBLICATION_CACHE_TTL_MS * 2).toISOString()

  // A complete listing whose only observation is past the TTL: the count would
  // be built on an answer we no longer trust, so it is unknown.
  await seedConfirmed(created.slug, [
    { video_id: 'vid-sw', scheduled_for: expected[0]!, checked_at: old },
  ], { outcome: 'complete' })
  let channel = (await svc.readPublishingOverview({ now })).channels[0]!
  assert.equal(channel.confirmed.freshness, 'stale')
  assert.equal(channel.coverage.missing_slots_4w, null, 'stale coverage is unknown, never 0')

  // And a channel with no plan has no cadence of its own to count at.
  const unplanned = await projectWithCadence('No Cadence Window', 'NC')
  await pm.updateConfig(unplanned.slug, { publish_cadence: null } as any)
  const unplannedChannel = (await svc.readPublishingOverview({ now }))
    .channels.find(entry => entry.slug === unplanned.slug)!
  assert.equal(unplannedChannel.plan_set, false)
  assert.equal(unplannedChannel.coverage.missing_slots_4w, null, 'no plan is no answer, not 0')
})

test('the oldest checked time is the OLDEST observation, and is unknown when it is absent or stale', async () => {
  const now = Date.now()
  const created = await connectedProject('Oldest Channel', 'OC2')
  const expected = plans.computeSlots(SCHEDULE, svc.PLANNED_SLOT_HORIZON, { notBefore: new Date(now) })
  const older = new Date(now - 6 * 60 * 60 * 1000).toISOString()
  const newer = new Date(now - 60_000).toISOString()

  // Two observations with different ages: the page must see the OLD one, not
  // the newest — the newest is the one that hides how long this has been true.
  await seedConfirmed(created.slug, [
    { video_id: 'vid-older', scheduled_for: expected[0]!, checked_at: older },
    { video_id: 'vid-newer', scheduled_for: expected[1]!, checked_at: newer },
  ], { outcome: 'complete' })
  let channel = (await svc.readPublishingOverview({ now })).channels[0]!
  assert.equal(channel.coverage.oldest_checked_at, older)
  assert.equal(channel.coverage.oldest_checked_stale, false)
  assert.notEqual(channel.coverage.oldest_checked_at, channel.confirmed.last_checked_at,
    'the newest check is a different fact from the oldest one')

  // No schedule carrying a check time: unknown, never "checked never" and never 0.
  const unchecked = await projectWithCadence('Unchecked Channel', 'UC2')
  const uncheckedChannel = (await svc.readPublishingOverview({ now }))
    .channels.find(entry => entry.slug === unchecked.slug)!
  assert.equal(uncheckedChannel.coverage.oldest_checked_at, null)
  assert.equal(uncheckedChannel.coverage.oldest_checked_stale, false)

  // A stale oldest observation is reported as stale, so the page can refuse to
  // present it as a confident date.
  const staleOld = new Date(now - pub.PUBLICATION_CACHE_TTL_MS * 2).toISOString()
  await seedConfirmed(created.slug, [
    { video_id: 'vid-stale-old', scheduled_for: expected[2]!, checked_at: staleOld },
    { video_id: 'vid-fresh-new', scheduled_for: expected[3]!, checked_at: newer },
  ], { outcome: 'complete' })
  channel = (await svc.readPublishingOverview({ now })).channels.find(entry => entry.slug === created.slug)!
  assert.equal(channel.coverage.oldest_checked_at, staleOld)
  assert.equal(channel.coverage.oldest_checked_stale, true)
})
