/**
 * Route-level tests for the upload PLAN scheduling routes.
 *
 * WHY THIS FILE EXISTS. Until v1.4.21 these routes had no tests at all.
 * `upload-plans-compute.test.ts` covers `computeSlots` with fifteen cases —
 * every weekday, interval, monthly and `minStartDate` shape — and nothing
 * covered the routes that call it. So the part that decides WHICH claims count
 * as claims, and which episodes must never be touched, was unprotected.
 *
 * The owner, on being told: *"i've schedules and upload for a while. no issues
 * whatsoever."* Quite right — nothing is broken here. That is exactly the state
 * worth locking down, because the next change to this code is the dangerous
 * one, and its blast radius is his real publish dates on a live channel.
 *
 * What is pinned here is the claim-walk and the public-video guard:
 *
 *   1. a PAST claim never pushes new episodes further out
 *   2. the LATEST future claim does
 *   3. episodes being scheduled are excluded from the scan (so re-running is
 *      idempotent rather than walking past their own slot)
 *   4. timestamps are PARSED, not string-matched — the v1.0.42 defect this
 *      scan replaced was a string Set that missed any YouTube-synced value
 *      whose ISO form lacked `.000Z`
 *   5. an episode already PUBLIC on YouTube is never written into the schedule
 *
 * (5) is the owner's own condition: *"what's already uploaded is not changed.
 * but only those that aren't live on youtube can be changed."*
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')
let store: typeof import('../services/upload-store.js')
let plans: typeof import('../services/upload-plans.js')
let sidecar: typeof import('../services/upload-sidecar.js')

let slug = ''
let accountId = ''
let planId = ''

/** Mon/Wed/Fri 22:00 — the owner's real Boundful cadence. */
const SCHEDULE = { weekdays: [1, 3, 5], time_local: '22:00', timezone: 'Asia/Phnom_Penh' }

const CODES = ['EP0001', 'EP0002', 'EP0003', 'EP0004']

async function seedAcceptedIdeas(): Promise<void> {
  // Written directly: `addIdeas` runs a generation pipeline this test does not
  // need, and the routes only ever read `status` + `episode_code` + `title`.
  const idsPath = path.join(tempDir, 'projects', slug, 'ideas.json')
  await fs.writeFile(idsPath, JSON.stringify({
    ideas: CODES.map((code, i) => ({
      id: `idea_${i}`, title: `Episode ${i + 1}`, logline: '', themes: [],
      status: 'accepted', episode_code: code,
      suggested_chapters: 5, suggested_length: '10', mood: '',
      created_at: new Date().toISOString(),
    })),
  }, null, 2))
}

/** The episode dir is resolved from code AND title, so the fixture must use
 *  the same title the route will read with, or the sidecar is written to one
 *  folder and looked for in another. */
function titleFor(code: string): string {
  return `Episode ${CODES.indexOf(code) + 1}`
}

async function writeSidecarFor(
  code: string,
  fields: { scheduled_for: string | null; privacy_status: 'private' | 'unlisted' | 'public'; video_id?: string },
): Promise<void> {
  await sidecar.writeSidecar(slug, code, titleFor(code), {
    platform: 'youtube',
    video_id: fields.video_id ?? '',
    account_id: accountId,
    channel_id: 'UC_test',
    uploaded_at: new Date().toISOString(),
    last_sync_at: new Date().toISOString(),
    scheduled_for: fields.scheduled_for,
    privacy_status: fields.privacy_status,
    title: '', description: '', tags: [], thumbnail_set: false,
  } as any)
}

/** Preview with an explicit target list — the path Apply mirrors. */
async function preview(codes: string[]): Promise<any> {
  const res = await request(app)
    .post(`/api/projects/${slug}/upload/plans/${planId}/preview`)
    .send({ episode_codes: codes })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body
}

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  pm = await import('../services/project-manager.js')
  store = await import('../services/upload-store.js')
  plans = await import('../services/upload-plans.js')
  sidecar = await import('../services/upload-sidecar.js')

  const project = await pm.createProject({ name: 'Plan Apply Routes' })
  slug = project.slug
  const account = await store.addAccount(slug, 'youtube', {
    label: 'test-channel', remote_id: 'UC_test', remote_title: 'test-channel',
  } as any)
  accountId = account.id
  const plan = await plans.upsertPlan(slug, {
    name: 'Test cadence', platform: 'youtube', account_id: accountId,
    schedule: SCHEDULE as any,
    defaults: { privacy_status: 'private', made_for_kids: false },
  })
  planId = plan.id
  await plans.setActivePlanId(slug, 'youtube', accountId, planId)
  await seedAcceptedIdeas()
})

after(async () => { await cleanup?.() })

describe('the claim-walk that decides where the next episode lands', () => {
  test('a claim in the PAST does not push new episodes out', async () => {
    // A video that went live last week must not shove the next one a week
    // later. Without this the schedule drifts forward every time an old
    // episode is looked at.
    await writeSidecarFor('EP0004', {
      scheduled_for: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      privacy_status: 'private',
    })
    const body = await preview(['EP0001'])
    assert.equal(body.latest_existing_claim, null,
      'a past claim was counted as a claim, so every future schedule is pushed out by it')
    assert.equal(body.slots.length, 1)
  })

  test('the LATEST future claim advances the walk past itself', async () => {
    const near = new Date(Date.now() + 3 * 86_400_000).toISOString()
    const far = new Date(Date.now() + 40 * 86_400_000).toISOString()
    await writeSidecarFor('EP0003', { scheduled_for: near, privacy_status: 'private' })
    await writeSidecarFor('EP0004', { scheduled_for: far, privacy_status: 'private' })

    const body = await preview(['EP0001'])
    assert.equal(body.latest_existing_claim, far,
      'the walk resumed from the nearer claim, so the new episode would double-book a later one')
    assert.ok(Date.parse(body.slots[0]) > Date.parse(far),
      `${body.slots[0]} must fall after the last claimed slot ${far}`)
  })

  test('an episode being scheduled is excluded from the scan of its own claims', async () => {
    // Re-applying to the same episode must reuse its position rather than walk
    // past its own slot — otherwise every re-run pushes it further out.
    const mine = new Date(Date.now() + 90 * 86_400_000).toISOString()
    await writeSidecarFor('EP0002', { scheduled_for: mine, privacy_status: 'private' })

    const includingItself = await preview(['EP0002'])
    assert.notEqual(includingItself.latest_existing_claim, mine,
      "an episode's own claim was counted against it, so re-applying walks it forward every time")

    // Same claim, different target: now it MUST count.
    const otherEpisode = await preview(['EP0001'])
    assert.equal(otherEpisode.latest_existing_claim, mine)
    await writeSidecarFor('EP0002', { scheduled_for: null, privacy_status: 'private' })
  })

  test('a YouTube-synced timestamp without milliseconds still counts as a claim', async () => {
    // The v1.0.42 defect: claims were held in a Set<string> and compared by
    // text, so any value YouTube returned without `.000Z` was invisible and
    // the slot got double-booked. Parsing is what fixed it.
    const noMillis = new Date(Date.now() + 20 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    assert.ok(!noMillis.includes('.'), 'fixture must not contain milliseconds')
    await writeSidecarFor('EP0003', { scheduled_for: noMillis, privacy_status: 'private' })
    await writeSidecarFor('EP0004', { scheduled_for: null, privacy_status: 'private' })

    const body = await preview(['EP0001'])
    assert.ok(body.latest_existing_claim,
      'a millisecond-less timestamp was ignored, so this slot can be double-booked')
    assert.equal(Date.parse(body.latest_existing_claim), Date.parse(noMillis))
  })
})

describe('videos that are already live are never rescheduled', () => {
  test('preview reports public episodes as skipped rather than schedulable', async () => {
    // The owner's condition, verbatim: "what's already uploaded is not changed.
    // but only those that aren't live on youtube can be changed."
    await writeSidecarFor('EP0002', {
      scheduled_for: null, privacy_status: 'public', video_id: 'vid_live',
    })
    const body = await preview(['EP0001', 'EP0002'])
    assert.deepEqual(body.public_skip_codes, ['EP0002'])
    assert.equal(body.public_skip_count, 1)
  })

  test('apply does not write a publish time for a public episode', async () => {
    const before = await plans.readItemSchedule(slug)
    assert.equal(before['EP0002'], undefined)

    const res = await request(app)
      .post(`/api/projects/${slug}/upload/plans/${planId}/apply`)
      .send({ episode_codes: ['EP0002'] })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.skipped_public.map((s: any) => s.episode_code), ['EP0002'])

    const after = await plans.readItemSchedule(slug)
    assert.equal(after['EP0002'], undefined,
      'a live video was written into the local schedule — the queue would claim a publish time '
      + 'that YouTube never accepted')
  })

  test('apply writes a publish time for an episode that is not live', async () => {
    const res = await request(app)
      .post(`/api/projects/${slug}/upload/plans/${planId}/apply`)
      .send({ episode_codes: ['EP0001'] })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const map = await plans.readItemSchedule(slug)
    assert.ok(map['EP0001'], 'the ordinary case must still schedule')
    assert.ok(Date.parse(map['EP0001']!) > Date.now())
  })
})

describe('a plan that cannot cover the request says so', () => {
  test('too few slots is a 400 naming the plan, not a partial apply', async () => {
    const shortPlan = await plans.upsertPlan(slug, {
      name: 'Ends Tomorrow', platform: 'youtube', account_id: accountId,
      schedule: { ...SCHEDULE, end_date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) } as any,
      defaults: { privacy_status: 'private', made_for_kids: false },
    })
    const res = await request(app)
      .post(`/api/projects/${slug}/upload/plans/${shortPlan.id}/apply`)
      .send({ episode_codes: CODES })
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /Ends Tomorrow/)
    assert.match(res.body.detail, /slot/i)
  })

  test('an empty episode list is refused rather than treated as "all"', async () => {
    const res = await request(app)
      .post(`/api/projects/${slug}/upload/plans/${planId}/apply`)
      .send({ episode_codes: [] })
    assert.equal(res.status, 400)
  })
})
