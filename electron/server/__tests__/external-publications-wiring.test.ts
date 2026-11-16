/**
 * Publications made outside Story — storage, import, review and coverage (2026-11-16).
 *
 * Binding conditions proved here:
 *   - the per-project file is atomic and locked, and an absent file is an EMPTY list;
 *   - import accepts only a regular `.csv`/`.json` file, writes nothing when any row is refused, and
 *     never verifies a row;
 *   - dates are `YYYY-MM-DD` or a zoned ISO instant, and anything else is refused with its row;
 *   - only VERIFIED rows count, a day or episode is never covered twice, and an overlap with this
 *     channel's own schedule is reported rather than double-counted;
 *   - a channel with no such file gets the SAME overview payload as before.
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'

let pm: typeof import('../services/project-manager.js')
let store: typeof import('../services/external-publications-store.js')
let overview: typeof import('../services/publishing-overview.js')
let cadence: typeof import('../services/publish-cadence.js')
let tmp: { dir: string; cleanup: () => Promise<void> } | undefined
let fixtureNumber = 0

before(async () => {
  pm = await import('../services/project-manager.js')
  store = await import('../services/external-publications-store.js')
  overview = await import('../services/publishing-overview.js')
  cadence = await import('../services/publish-cadence.js')
})
beforeEach(async () => {
  await tmp?.cleanup()
  tmp = await useTempDataDir()
})
after(async () => { await tmp?.cleanup() })

async function project(name = `Outside ${++fixtureNumber}`) {
  return pm.createProject({ name, episode_prefix: 'OP' })
}

async function writeFile(dir: string, name: string, content: string): Promise<string> {
  const file = path.join(dir, name)
  await fs.writeFile(file, content)
  return file
}

const CSV = [
  'title,published_at,episode_code,video_id',
  'A Quiet Morning,2026-10-01,OP0001,vid-1',
  '"A Talk, with commas",2026-10-03,,vid-2',
  'Third Release,2026-10-05T09:30:00+07:00,,vid-3',
].join('\n')

// ── parsing ────────────────────────────────────────────────────────────────

test('CSV parsing keeps quoted commas and escapes quotes', () => {
  const rows = store.parseCsv('title,published_at\n"A Talk, with commas",2026-10-03\n"Say ""hi""",2026-10-04\n')
  assert.equal(rows.length, 2)
  assert.equal(rows[0]!.title, 'A Talk, with commas')
  assert.equal(rows[1]!.title, 'Say "hi"')
})

// ── the file ───────────────────────────────────────────────────────────────

test('an absent file is an empty list, never an error', async () => {
  const created = await project()
  const read = await store.readExternalPublications(created.slug)
  assert.equal(read.status, 'absent')
  assert.deepEqual(read.entries, [])
})

test('import writes every valid row, unlinked, in one file', async () => {
  const created = await project()
  const picked = await writeFile(tmp!.dir, 'releases.csv', CSV)
  const result = await store.importExternalPublications(created.slug, picked)
  assert.equal(result.refusals.length, 0)
  assert.equal(result.imported, 3)
  assert.ok(result.entries.every(entry => entry.state === 'unlinked'), 'import never verifies')
  assert.equal(result.entries[1]!.title, 'A Talk, with commas')
  assert.equal(result.entries[0]!.episode_code, 'OP0001')
  // The zoned instant is normalised, not guessed.
  assert.equal(result.entries[2]!.published_at, '2026-10-05T02:30:00.000Z')

  const reread = await store.readExternalPublications(created.slug)
  assert.equal(reread.status, 'ok')
  assert.equal(reread.entries.length, 3)
})

test('a refused row writes NOTHING and names its row', async () => {
  const created = await project()
  const bad = await writeFile(tmp!.dir, 'bad.csv', [
    'title,published_at',
    'Good,2026-10-01',
    'Bad date,2026-13-45',
    'No date,',
  ].join('\n'))
  const result = await store.importExternalPublications(created.slug, bad)
  assert.equal(result.imported, 0)
  assert.deepEqual(result.refusals.map(refusal => refusal.row), [2, 3])
  assert.match(result.refusals[0]!.reason, /2026-13-45/)
  assert.equal((await store.readExternalPublications(created.slug)).status, 'absent', 'a refusal leaves no file')
})

test('only a regular .csv/.json file is accepted', async () => {
  const created = await project()
  const text = await writeFile(tmp!.dir, 'releases.txt', CSV)
  await assert.rejects(() => store.importExternalPublications(created.slug, text), /\.csv or \.json/)
  await assert.rejects(() => store.importExternalPublications(created.slug, tmp!.dir), /\.csv or \.json/)
  await assert.rejects(
    () => store.importExternalPublications(created.slug, path.join(tmp!.dir, 'missing.csv')),
    /could not be read/,
  )
})

test('a duplicate row is refused rather than imported twice', async () => {
  const created = await project()
  const picked = await writeFile(tmp!.dir, 'releases.csv', CSV)
  await store.importExternalPublications(created.slug, picked)
  const again = await store.importExternalPublications(created.slug, picked)
  assert.equal(again.imported, 0)
  assert.equal(again.refusals.length, 3)
})

// ── review and coverage ────────────────────────────────────────────────────

test('only a verified row counts, and a second mark for the same day is refused', async () => {
  const created = await project()
  const picked = await writeFile(tmp!.dir, 'releases.csv', `${CSV}
Another Release,2026-10-01,,vid-4`)
  await store.importExternalPublications(created.slug, picked)

  const imported = (await store.readExternalPublications(created.slug)).entries
  const verified = await store.setExternalPublicationState(created.slug, imported[0]!.id, 'verified', 'owner')
  assert.equal(verified.state, 'verified')
  assert.equal(verified.verified_by, 'owner')

  const dismissed = await store.setExternalPublicationState(created.slug, imported[1]!.id, 'dismissed', 'owner')
  assert.equal(dismissed.state, 'dismissed')
  assert.equal(dismissed.verified_at, null)

  const coverage = await store.externalCoverageFor(created.slug, new Set())
  assert.equal(coverage.verified, 1)
  assert.deepEqual(coverage.days, ['2026-10-01'])

  // A second entry on the same day is a second coverage mark — refused with the reason.
  const sameDay = imported.find(entry => entry.title === 'Another Release')!
  await assert.rejects(
    () => store.setExternalPublicationState(created.slug, sameDay.id, 'verified', 'owner'),
    /second coverage mark|already covered/,
  )
})

test('verifying the same episode code twice is refused', async () => {
  const created = await project()
  const picked = await writeFile(tmp!.dir, 'releases.json', JSON.stringify([
    { title: 'First airing', published_at: '2026-10-01', episode_code: 'OP0009' },
    { title: 'Second airing', published_at: '2026-10-09', episode_code: 'OP0009' },
  ]))
  await store.importExternalPublications(created.slug, picked)
  const entries = (await store.readExternalPublications(created.slug)).entries
  await store.setExternalPublicationState(created.slug, entries[0]!.id, 'verified', 'owner')
  await assert.rejects(
    () => store.setExternalPublicationState(created.slug, entries[1]!.id, 'verified', 'owner'),
    /second coverage mark/,
  )
})

test('a day this channel already covers locally is refused and reported as an overlap', async () => {
  const created = await project()
  const im = await import('../services/idea-manager.js')
  const [idea] = await im.addIdeas(created.slug, [{
    title: 'A local episode', logline: 'l', themes: ['t'], suggested_chapters: 3, suggested_length: '10 min', mood: 'm',
  }], 'test-model')
  await im.promoteToAccepted(created.slug, idea!.id, { episode_code: 'OP0001' })
  const { writeItemSchedule } = await import('../services/upload-plans.js')
  await writeItemSchedule(created.slug, { OP0001: '2026-10-01T11:00:00.000Z' })
  const picked = await writeFile(tmp!.dir, 'releases.json', JSON.stringify([
    { title: 'Elsewhere that day', published_at: '2026-10-01' },
  ]))
  await store.importExternalPublications(created.slug, picked)
  const entries = (await store.readExternalPublications(created.slug)).entries
  await assert.rejects(
    () => store.setExternalPublicationState(created.slug, entries[0]!.id, 'verified', 'owner'),
    /already covered by this channel's own schedule/,
  )
})

// ── the overview ───────────────────────────────────────────────────────────

test('a channel with no outside file keeps the SAME overview payload', async () => {
  const now = Date.now()
  const created = await project('Plain Channel')
  await cadence.writeCadence(created.slug, {
    schedule: { weekdays: [1, 3, 5], time_local: '18:00', timezone: 'UTC' },
    defaults: { privacy_status: 'private', made_for_kids: false },
  })
  const payload = await overview.readPublishingOverview({ now })
  const channel = payload.channels.find(row => row.slug === created.slug)!
  assert.equal('external' in channel, false, 'no outside releases ⇒ no additive block')
  assert.equal(payload.calendar.some(entry => entry.kind === 'external'), false)
  assert.equal(channel.planned.slots.some(slot => slot.external), false)
})

test('a verified outside release covers its own local day and shows as its own calendar mark', async () => {
  const now = Date.parse('2026-09-28T00:00:00Z')
  const created = await project('Outside Coverage')
  await cadence.writeCadence(created.slug, {
    // A start date is what pins the walk; without one the plan starts from the real today.
    schedule: { weekdays: [1], time_local: '18:00', timezone: 'UTC', start_date: '2020-01-06' },
    defaults: { privacy_status: 'private', made_for_kids: false },
  })
  const picked = await writeFile(tmp!.dir, 'releases.json', JSON.stringify([
    // A Monday, one of the plan's expected days.
    { title: 'Made elsewhere', published_at: '2026-10-05' },
    { title: 'Needs review', published_at: '2026-10-12' },
  ]))
  await store.importExternalPublications(created.slug, picked)
  const entries = (await store.readExternalPublications(created.slug)).entries
  await store.setExternalPublicationState(created.slug, entries[0]!.id, 'verified', 'owner')

  const payload = await overview.readPublishingOverview({ now })
  const channel = payload.channels.find(row => row.slug === created.slug)!
  assert.equal(channel.external?.status, 'ok')
  assert.equal(channel.external?.verified_count, 1)
  assert.equal(channel.external?.imported_count, 2)
  assert.deepEqual(channel.external?.days, ['2026-10-05'])

  const covered = channel.planned.slots.find(slot => slot.at.startsWith('2026-10-05'))
  assert.ok(covered, 'the plan expected a slot that day')
  assert.equal(covered!.external, true)
  assert.equal(covered!.confirmed, false, 'external is never promoted to YouTube-confirmed')
  assert.notEqual(channel.planned.next_uncovered_slot_at?.slice(0, 10), '2026-10-05')

  const marks = payload.calendar.filter(entry => entry.channel_slug === created.slug && entry.kind === 'external')
  assert.deepEqual(marks.map(mark => mark.title), ['Made elsewhere'])
})
