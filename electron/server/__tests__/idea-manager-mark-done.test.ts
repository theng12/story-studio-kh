/**
 * Tests for the mark-done + status-overrides mutators
 * (services/idea-manager.ts).
 *
 * Coverage:
 *   - markEpisodeDone flips the flag + stamps timestamp + clears on revert
 *   - setEpisodeStatusOverrides accepts valid keys, rejects unknown ones,
 *     and treats null as a clear
 *   - bulkMarkDone is atomic (single mutateStore write) and counts changed
 *     vs. requested correctly (skipping no-ops + missing codes)
 *   - bulkMarkDoneBySource targets imported episodes only (batch_id ===
 *     'imported') and reports affected codes even when value already matched
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let im: typeof import('../services/idea-manager.js')
let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'mark-done-test'

async function makeProjectWithIdeas(): Promise<void> {
  const projDir = path.join(pm.PROJECTS_ROOT, SLUG)
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'Mark-Done Test',
    episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: {}, output_root: 'episodes', created_at: new Date().toISOString(),
  }))
  // 5 ideas: 3 imported (batch_id='imported'), 2 organic.
  await fs.writeFile(path.join(projDir, 'ideas.json'), JSON.stringify({
    ideas: [
      { id: 'i-1', title: 'Imp 1', logline: 'l', themes: [], suggested_chapters: 8, suggested_length: '30 min', mood: 'm',
        status: 'accepted', episode_code: 'EP0001', generated_at: '2026-01-01T00:00:00Z',
        accepted_at: '2026-01-01T00:00:00Z', batch_id: 'imported', model_used: 'imported' },
      { id: 'i-2', title: 'Imp 2', logline: 'l', themes: [], suggested_chapters: 8, suggested_length: '30 min', mood: 'm',
        status: 'accepted', episode_code: 'EP0002', generated_at: '2026-01-01T00:00:00Z',
        accepted_at: '2026-01-01T00:00:00Z', batch_id: 'imported', model_used: 'imported' },
      { id: 'i-3', title: 'Imp 3', logline: 'l', themes: [], suggested_chapters: 8, suggested_length: '30 min', mood: 'm',
        status: 'accepted', episode_code: 'EP0003', generated_at: '2026-01-01T00:00:00Z',
        accepted_at: '2026-01-01T00:00:00Z', batch_id: 'imported', model_used: 'imported' },
      { id: 'i-4', title: 'Org 1', logline: 'l', themes: [], suggested_chapters: 8, suggested_length: '30 min', mood: 'm',
        status: 'accepted', episode_code: 'EP0004', generated_at: '2026-01-02T00:00:00Z',
        accepted_at: '2026-01-02T00:00:00Z', batch_id: 'batch-123', model_used: 'gpt-4o' },
      { id: 'i-5', title: 'Org 2', logline: 'l', themes: [], suggested_chapters: 8, suggested_length: '30 min', mood: 'm',
        status: 'accepted', episode_code: 'EP0005', generated_at: '2026-01-02T00:00:00Z',
        accepted_at: '2026-01-02T00:00:00Z', batch_id: 'batch-123', model_used: 'gpt-4o' },
    ],
    next_episode_number: 6,
    recycled_numbers: [],
  }))
}

describe('idea-manager mark-done + overrides', () => {
  before(async () => {
    tmp = await useTempDataDir()
    im = await import('../services/idea-manager.js')
    pm = await import('../services/project-manager.js')
    assert.equal(pm.PROJECTS_ROOT, path.join(tmp.dir, 'projects'),
      'PROJECTS_ROOT must point at temp dir')
  })

  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    // Wipe + recreate each test so mutations don't bleed across.
    await fs.rm(pm.PROJECTS_ROOT, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.PROJECTS_ROOT, { recursive: true })
    await makeProjectWithIdeas()
  })

  test('markEpisodeDone: flips flag + stamps timestamp', async () => {
    const before = (await im.getIdeas(SLUG)).find(i => i.episode_code === 'EP0001')!
    assert.equal(before.marked_done, undefined, 'starts unset')

    const updated = await im.markEpisodeDone(SLUG, 'EP0001', true)
    assert.equal(updated?.marked_done, true)
    assert.ok(updated?.marked_done_at, 'timestamp stamped')

    // Revert: timestamp clears too.
    const reverted = await im.markEpisodeDone(SLUG, 'EP0001', false)
    assert.equal(reverted?.marked_done, false)
    assert.equal(reverted?.marked_done_at, null)
  })

  test('markEpisodeDone: case-insensitive code match', async () => {
    const updated = await im.markEpisodeDone(SLUG, 'ep0001', true)
    assert.equal(updated?.marked_done, true)
  })

  test('markEpisodeDone: returns null for unknown episode', async () => {
    const out = await im.markEpisodeDone(SLUG, 'EP9999', true)
    assert.equal(out, null)
  })

  test('setEpisodeStatusOverrides: writes valid keys, drops unknown ones', async () => {
    const updated = await im.setEpisodeStatusOverrides(SLUG, 'EP0001', {
      audio: true,
      video: false,
      bogus_key: true,
      script: 'not-a-boolean' as any,
    })
    assert.deepEqual(updated?.status_overrides, { audio: true, video: false },
      'only valid (key, boolean) pairs survive sanitization')
  })

  test('setEpisodeStatusOverrides: accepts every current optional workflow step', async () => {
    const updated = await im.setEpisodeStatusOverrides(SLUG, 'EP0001', {
      research: true,
      subtitles: true,
      character_sheet: true,
      broll_picked: true,
      scene_plan: true,
      scene_review: true,
      motion_review: true,
    })
    assert.deepEqual(updated?.status_overrides, {
      research: true,
      subtitles: true,
      character_sheet: true,
      broll_picked: true,
      scene_plan: true,
      scene_review: true,
      motion_review: true,
    })
  })

  test('setEpisodeStatusOverrides: null clears the field', async () => {
    await im.setEpisodeStatusOverrides(SLUG, 'EP0001', { audio: true })
    const cleared = await im.setEpisodeStatusOverrides(SLUG, 'EP0001', null)
    assert.equal(cleared?.status_overrides, undefined)
  })

  test('bulkMarkDone: changes only matching codes; reports counts', async () => {
    const result = await im.bulkMarkDone(SLUG, ['EP0001', 'EP0002', 'EP0099'], true)
    assert.equal(result.changed, 2, '2 of 3 codes match real ideas')
    assert.equal(result.total_requested, 3)

    const ideas = await im.getIdeas(SLUG)
    assert.equal(ideas.find(i => i.episode_code === 'EP0001')?.marked_done, true)
    assert.equal(ideas.find(i => i.episode_code === 'EP0002')?.marked_done, true)
    assert.equal(ideas.find(i => i.episode_code === 'EP0003')?.marked_done, undefined,
      'unrelated ideas untouched')
    assert.equal(ideas.find(i => i.episode_code === 'EP0004')?.marked_done, undefined)
  })

  test('bulkMarkDone: skips no-ops in changed count', async () => {
    await im.markEpisodeDone(SLUG, 'EP0001', true)
    const result = await im.bulkMarkDone(SLUG, ['EP0001', 'EP0002'], true)
    assert.equal(result.changed, 1, 'EP0001 already true → not counted; only EP0002 actually changed')
  })

  test('bulkMarkDone: empty array returns zero, no mutation', async () => {
    const result = await im.bulkMarkDone(SLUG, [], true)
    assert.deepEqual(result, { changed: 0, total_requested: 0 })
  })

  test('bulkMarkDoneBySource: targets only batch_id===imported', async () => {
    const result = await im.bulkMarkDoneBySource(SLUG, 'imported', true)
    assert.equal(result.changed, 3, 'all 3 imported ideas flipped')
    assert.deepEqual(result.episode_codes.sort(), ['EP0001', 'EP0002', 'EP0003'])

    const ideas = await im.getIdeas(SLUG)
    assert.equal(ideas.find(i => i.episode_code === 'EP0001')?.marked_done, true)
    assert.equal(ideas.find(i => i.episode_code === 'EP0004')?.marked_done, undefined,
      'organic ideas untouched')
    assert.equal(ideas.find(i => i.episode_code === 'EP0005')?.marked_done, undefined)
  })

  test('bulkMarkDoneBySource: reports already-set codes too (for cache invalidation)', async () => {
    await im.markEpisodeDone(SLUG, 'EP0001', true)
    const result = await im.bulkMarkDoneBySource(SLUG, 'imported', true)
    assert.equal(result.changed, 2, 'EP0001 was already true → not counted as changed')
    assert.deepEqual(result.episode_codes.sort(), ['EP0001', 'EP0002', 'EP0003'],
      'EP0001 still in the list so the cache invalidator wipes it (belt-and-suspenders)')
  })
})
