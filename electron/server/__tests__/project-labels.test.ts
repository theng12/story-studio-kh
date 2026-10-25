/**
 * Channel labels — the owner's own words for what a channel is.
 *
 * Pinned here:
 *
 *   1. They round-trip through the project save path: PUT → project.json →
 *      GET /projects (the start page reads its labels from the list, so a
 *      label that only reached the file would be invisible where it matters).
 *   2. They are NORMALISED on the way in — trimmed, inner whitespace collapsed,
 *      blanks dropped, de-duplicated case-insensitively with the FIRST spelling
 *      kept, because "Sleep" and "sleep" are the one label the owner meant.
 *   3. The ceilings REFUSE (400) instead of quietly shortening a word or
 *      dropping the surplus.
 *   4. An UNRELATED save — renaming the channel — does not lose them. Labels
 *      ride on `ProjectMeta` next to a dozen other fields, and a merge that
 *      rebuilt the record from a field list would drop them silently.
 *   5. `last_worked_at` is read with the list row, and an unreadable folder
 *      reports UNKNOWN (null) rather than a zero that would sort as "the
 *      oldest channel in the Library".
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { MAX_PROJECT_LABELS, MAX_PROJECT_LABEL_LENGTH, normalizeProjectLabels } from '../contracts/project-labels.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let app: express.Express
let pm: typeof import('../services/project-manager.js')

const put = (slug: string) => request(app).put(`/api/projects/${slug}`)
const list = () => request(app).get('/api/projects')

async function storedLabels(slug: string): Promise<string[] | undefined> {
  const raw = JSON.parse(await fs.readFile(path.join(pm.getProjectDir(slug)!, 'project.json'), 'utf8'))
  return raw.labels
}

describe('channel labels', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    const { router } = await import('../routes/projects.js')
    app = express()
    app.use(express.json())
    app.use('/api', router)
  })
  after(async () => { await tmp.cleanup() })

  describe('the normaliser itself', () => {
    test('trims, collapses inner whitespace, drops blanks and de-duplicates case-insensitively', () => {
      assert.deepEqual(
        normalizeProjectLabels([' Khmer ', 'khmer', 'Sleep', '', '   ', 'Sleep', 'Khmer  History']),
        ['Khmer', 'Sleep', 'Khmer History'],
      )
    })

    test('the FIRST spelling wins, so a label is never re-cased behind the owner', () => {
      assert.deepEqual(normalizeProjectLabels(['sleep', 'Sleep', 'SLEEP']), ['sleep'])
      assert.deepEqual(normalizeProjectLabels(['Sleep', 'sleep']), ['Sleep'])
    })

    test('Khmer labels are kept exactly as written', () => {
      assert.deepEqual(normalizeProjectLabels([' ខ្មែរ ', 'ខ្មែរ']), ['ខ្មែរ'])
    })

    test('anything that is not an array of strings is not a label list', () => {
      assert.deepEqual(normalizeProjectLabels('Khmer'), [])
      assert.deepEqual(normalizeProjectLabels(null), [])
      assert.deepEqual(normalizeProjectLabels([1, 'Sleep', null, {}]), ['Sleep'])
    })

    test('the backstop drops an over-long label rather than truncating it into a different word', () => {
      assert.deepEqual(
        normalizeProjectLabels(['Sleep', 'x'.repeat(MAX_PROJECT_LABEL_LENGTH + 1), 'y'.repeat(MAX_PROJECT_LABEL_LENGTH)]),
        ['Sleep', 'y'.repeat(MAX_PROJECT_LABEL_LENGTH)],
      )
    })

    test('the backstop stops at the count ceiling', () => {
      const many = Array.from({ length: MAX_PROJECT_LABELS + 5 }, (_, i) => `label ${i}`)
      assert.equal(normalizeProjectLabels(many).length, MAX_PROJECT_LABELS)
    })
  })

  describe('through the project save path', () => {
    test('labels round-trip: PUT → project.json → the channel list', async () => {
      const { slug } = await pm.createProject({ name: 'Round Trip' })
      const saved = await put(slug).send({ labels: ['Khmer', 'Sleep'] }).expect(200)
      assert.deepEqual(saved.body.labels, ['Khmer', 'Sleep'])
      assert.deepEqual(await storedLabels(slug), ['Khmer', 'Sleep'], 'project.json carries them')

      const summary = (await list().expect(200)).body.find((row: any) => row.slug === slug)
      assert.deepEqual(summary.labels, ['Khmer', 'Sleep'], 'the start page list carries them')
    })

    test('a mixed bag is normalised on the way in, not stored as sent', async () => {
      const { slug } = await pm.createProject({ name: 'Normalised' })
      const saved = await put(slug).send({ labels: [' Khmer ', 'khmer', 'History', '   '] }).expect(200)
      assert.deepEqual(saved.body.labels, ['Khmer', 'History'])
      assert.deepEqual(await storedLabels(slug), ['Khmer', 'History'])
    })

    test('an empty list clears them — a real answer, not a missing one', async () => {
      const { slug } = await pm.createProject({ name: 'Cleared' })
      await put(slug).send({ labels: ['Khmer'] }).expect(200)
      const saved = await put(slug).send({ labels: [] }).expect(200)
      assert.deepEqual(saved.body.labels, [])
      assert.deepEqual(await storedLabels(slug), [])
    })

    test('a label over the length cap is refused, and nothing is changed', async () => {
      const { slug } = await pm.createProject({ name: 'Too Long' })
      await put(slug).send({ labels: ['Khmer'] }).expect(200)
      const refused = await put(slug).send({ labels: ['Khmer', 'z'.repeat(MAX_PROJECT_LABEL_LENGTH + 1)] }).expect(400)
      assert.match(refused.body.detail, new RegExp(`${MAX_PROJECT_LABEL_LENGTH}`))
      assert.deepEqual(await storedLabels(slug), ['Khmer'], 'the refused save wrote nothing')
    })

    test('more labels than the cap is refused, and nothing is changed', async () => {
      const { slug } = await pm.createProject({ name: 'Too Many' })
      const tooMany = Array.from({ length: MAX_PROJECT_LABELS + 1 }, (_, i) => `label ${i}`)
      const refused = await put(slug).send({ labels: tooMany }).expect(400)
      assert.match(refused.body.detail, new RegExp(`${MAX_PROJECT_LABELS}`))
      assert.equal(await storedLabels(slug), undefined, 'nothing was stored')
    })

    test('a blank entry is dropped, not refused — there is one thing it can mean', async () => {
      const { slug } = await pm.createProject({ name: 'Blank' })
      const saved = await put(slug).send({ labels: [' ', 'Khmer', ''] }).expect(200)
      assert.deepEqual(saved.body.labels, ['Khmer'])
      assert.deepEqual(await storedLabels(slug), ['Khmer'])
    })

    test('a non-list is refused', async () => {
      const { slug } = await pm.createProject({ name: 'Wrong Type' })
      await put(slug).send({ labels: 'Khmer' }).expect(400)
    })

    test('an unrelated save — renaming the channel — does not lose the labels', async () => {
      const { slug } = await pm.createProject({ name: 'Rename Me' })
      await put(slug).send({ labels: ['Khmer', 'Sleep'] }).expect(200)
      await put(slug).send({ name: 'Renamed' }).expect(200)
      assert.deepEqual(await storedLabels(slug), ['Khmer', 'Sleep'])
    })

    test('the direct writer normalises too, for callers that never see the schema', async () => {
      const { slug } = await pm.createProject({ name: 'Direct Writer' })
      const saved = await pm.updateProject(slug, { labels: [' Khmer ', 'khmer', 'x'.repeat(MAX_PROJECT_LABEL_LENGTH + 1)] })
      assert.deepEqual(saved?.labels, ['Khmer'])
    })
  })

  describe('last_worked_at', () => {
    test('the list row carries a real time, and it is read with the row', async () => {
      const { slug } = await pm.createProject({ name: 'Worked On' })
      const before = Date.now()
      const summary = (await list().expect(200)).body.find((row: any) => row.slug === slug)
      const stamp = Date.parse(summary.last_worked_at)
      assert.ok(Number.isFinite(stamp), `expected a real timestamp, got ${summary.last_worked_at}`)
      assert.ok(stamp >= before - 60_000, 'a channel just created is not reported as worked on long ago')
    })

    test('generating something moves it, because the queue rewrites jobs.json', async () => {
      const { slug } = await pm.createProject({ name: 'Queue Activity' })
      const first = (await list().expect(200)).body.find((row: any) => row.slug === slug).last_worked_at
      const later = new Date(Date.parse(first) + 60_000)
      await fs.utimes(path.join(pm.getProjectDir(slug)!, 'jobs.json'), later, later)
      const second = (await list().expect(200)).body.find((row: any) => row.slug === slug).last_worked_at
      assert.ok(Date.parse(second) > Date.parse(first), 'the newest marker wins')
    })

    // The only row that reports an UNKNOWN time is the one whose folder could
    // not be read at all (the 30-second READ_TIMEOUT branch): with no readable
    // project.json a folder is not a channel and never reaches the list. That
    // branch is asserted where it lives, and the SORT's treatment of an unknown
    // time — unknown goes last, never "oldest" — is pinned in
    // frontend/__tests__/channelView.test.ts.
  })
})
