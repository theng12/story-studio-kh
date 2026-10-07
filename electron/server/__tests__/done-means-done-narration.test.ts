/**
 * Owner decisions 2026-10-07 ("done means done"):
 *  - chapter-only / introduction-only get completeness checks: non-empty, not
 *    cut off mid-sentence, a plausible length against the target;
 *  - expand_chapters must not count a chapter file left over from an older
 *    outline as done.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { auditNarrationSection, countNarrationWords } from '../lib/narration-section-audit.js'
import {
  inspectChunkedScriptCompletion,
  readSidecar,
  writeImportedOutline,
} from '../lib/chunked-narration.js'

describe('narration section audit', () => {
  test('a complete section passes', () => {
    assert.deepEqual(auditNarrationSection('The tide came in. The harbour slept.', 5), [])
    assert.deepEqual(auditNarrationSection('“Rest now,” she said.”', 3), [])
  })

  test('empty, cut off and implausibly short sections are named', () => {
    assert.deepEqual(auditNarrationSection('   '), ['it is empty'])
    assert.match(auditNarrationSection('The tide came in and the', 3).join(), /stops mid-sentence/)
    assert.match(auditNarrationSection('Too short.', 550).join(), /has 2 words against a target of about 550/)
  })

  test('Khmer counts real words and ends at a khan', () => {
    const khmer = 'នៅពេលព្រឹកព្រលឹមមានខ្យល់បក់ពីសមុទ្រមកដល់ភូមិតូចមួយ។'
    assert.equal(countNarrationWords(khmer), 9, 'dictionary segmentation, not whitespace')
    assert.deepEqual(auditNarrationSection(khmer, 10), [])
    assert.match(auditNarrationSection(khmer.slice(0, -1), 10).join(), /stops mid-sentence/)
  })
})

describe('chapter files belong to one outline', () => {
  let dir = ''
  before(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'outline-stamps-')) })
  after(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  const chapter = (n: number) => path.join(dir, `EP0001_Chapter_${String(n).padStart(2, '0')}.md`)

  test('files from a previous outline are not counted for a new one', async () => {
    await fs.writeFile(path.join(dir, 'EP0001_Script_Narration.md'), '## Chapter 1\n\nOld.')
    await fs.writeFile(chapter(1), '## Chapter 1: Old\n\nOld text.')
    await fs.writeFile(chapter(2), '## Chapter 2: Old\n\nOld text.')
    const anHourAgo = new Date(Date.now() - 3_600_000)
    await fs.utimes(chapter(1), anHourAgo, anHourAgo)
    await fs.utimes(chapter(2), anHourAgo, anHourAgo)
    await writeImportedOutline(dir, 'EP0001', [{ title: 'New one' }, { title: 'New two' }])

    const fresh = await inspectChunkedScriptCompletion(dir, 'EP0001')
    assert.equal(fresh.complete, false, 'two stale files are not a finished new outline')
    assert.deepEqual(fresh.missing, [1, 2])

    // A chapter written for THIS outline counts.
    await fs.writeFile(chapter(1), '## Chapter 1: New one\n\nNew text.')
    const one = await inspectChunkedScriptCompletion(dir, 'EP0001')
    assert.deepEqual(one.missing, [2])
  })

  test('editing the outline does not invalidate chapters written for it', async () => {
    await fs.writeFile(chapter(2), '## Chapter 2: New two\n\nNew text.')
    const sidecarFile = (await fs.readdir(dir)).find(name => name.endsWith('.json'))!
    const current = JSON.parse(await fs.readFile(path.join(dir, sidecarFile), 'utf8'))
    current.outline[0].title = 'Renamed'
    current.outline_edited_at = new Date().toISOString()
    await fs.writeFile(path.join(dir, sidecarFile), JSON.stringify(current))
    assert.deepEqual((await inspectChunkedScriptCompletion(dir, 'EP0001')).missing, [])
    assert.equal((await readSidecar(dir, 'EP0001'))?.outline[0]?.title, 'Renamed')
  })
})

describe('contextual cue proposals report real counts', () => {
  test('saved N of M, with every dropped candidate and its reason', async () => {
    const { accountCueCandidates } = await import('../generators/contextual-cues.js')
    const { normalizeContextualCueProposalSettings } = await import('../services/contextual-cues.js')
    const plan = {
      total_duration_sec: 600,
      scenes: [
        { id: 's1', start_sec: 0, end_sec: 20 },
        { id: 's2', start_sec: 20, end_sec: 20.5 },
        { id: 's3', start_sec: 300, end_sec: 330 },
      ],
    } as any
    const settings = normalizeContextualCueProposalSettings({ density: 'standard' })
    const result = accountCueCandidates([
      { scene_id: 's1', title: 'Harbour of Ostia' },
      { scene_id: 's2', title: 'Too short a scene' },
      { scene_id: 'ghost', title: 'No such scene' },
      { scene_id: 's3', title: '   ' },
      { scene_id: 's3', title: 'Rome, 64 AD' },
    ], plan, settings, new Date().toISOString(), new Set())
    assert.deepEqual(result.proposed.map(cue => cue.title), ['Harbour of Ostia', 'Rome, 64 AD'])
    assert.deepEqual(result.dropped.map(drop => drop.scene_id), ['s2', 'ghost', 's3'])
    assert.equal(result.dropped.length, 3)
    assert.match(result.dropped[0]!.reason, /shorter than/)
    assert.equal(result.dropped[1]!.reason, 'its scene is not in the Scene Plan')
    assert.equal(result.dropped[2]!.reason, 'it has no title')
  })
})
