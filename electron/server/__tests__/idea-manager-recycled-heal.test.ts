/**
 * Regression tests for the bidirectional auto-heal of `recycled_numbers`
 * in idea-manager.ts (the "TN0001 gets reused after YouTube renumber-
 * adopt" bug).
 *
 * Setup: simulate the mid-renumber state where an external direct write
 * filled slots 1..N but recycled_numbers still claims those slots are
 * available. Each public mutator (addIdeas, acceptIdea, applyRenumberPatch)
 * goes through mutateStore which runs applyAutoHeal — so any of those
 * calls should clean recycled_numbers and stop handing out duplicate
 * codes.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let im: typeof import('../services/idea-manager.js')
let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'recycled-heal'

async function makeProject(): Promise<void> {
  const projDir = path.join(pm.projectsRoot(), SLUG)
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'Recycled Heal Test',
    episode_prefix: 'TN', episode_digits: 4, season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: {}, created_at: new Date().toISOString(),
  }))
}

/**
 * Write a corrupted ideas.json: every code 1..acceptedCount is in use,
 * BUT recycled_numbers also lists 1..acceptedCount. This is exactly the
 * shape the orphan-adopt flow was leaving on disk before the fix.
 */
async function writeCorruptedIdeas(acceptedCount: number, nextEpisodeNumber: number): Promise<void> {
  const ideas: any[] = []
  for (let i = 1; i <= acceptedCount; i++) {
    ideas.push({
      id: `i-${i}`, title: `Ep ${i}`, logline: 'l', themes: [],
      suggested_chapters: 0, suggested_length: '0 min', mood: '',
      status: 'accepted', episode_code: `TN${i.toString().padStart(4, '0')}`,
      generated_at: '2026-01-01T00:00:00Z', accepted_at: '2026-01-01T00:00:00Z',
      batch_id: 'orphan-adopt', model_used: 'orphan-adopt',
    })
  }
  const recycled = Array.from({ length: acceptedCount }, (_, i) => i + 1)
  const path_ = path.join(pm.projectsRoot(), SLUG, 'ideas.json')
  await fs.writeFile(path_, JSON.stringify({
    ideas,
    next_episode_number: nextEpisodeNumber,
    recycled_numbers: recycled,
  }))
}

describe('auto-heal: recycled_numbers stays consistent with accepted codes', () => {
  before(async () => {
    tmp = await useTempDataDir()
    im = await import('../services/idea-manager.js')
    pm = await import('../services/project-manager.js')
    assert.equal(pm.projectsRoot(), path.join(tmp.dir, 'projects'))
  })

  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    await fs.rm(pm.projectsRoot(), { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.projectsRoot(), { recursive: true })
    await makeProject()
  })

  test('addIdeas removes stale entries from recycled_numbers (in-use codes)', async () => {
    // 5 ideas accepted at codes 1..5, but recycled_numbers also claims 1..5
    // are free — exactly what adoptBulkRenumber + bypass-mutateStore writes
    // produced before the fix.
    await writeCorruptedIdeas(5, 6)

    // Adding a new idea triggers mutateStore → applyAutoHeal.
    await im.addIdeas(SLUG, [{
      title: 'fresh', logline: 'l', themes: [],
      suggested_chapters: 0, suggested_length: '0 min', mood: '',
    }], 'gpt-4o')

    const raw = await fs.readFile(path.join(pm.projectsRoot(), SLUG, 'ideas.json'), 'utf-8')
    const data = JSON.parse(raw)
    assert.deepEqual(data.recycled_numbers, [],
      'every recycled number was in use → all should have been removed')
  })

  test('acceptIdea picks next_episode_number after auto-heal cleans recycled', async () => {
    // Same corruption, but the test exercises the full accept flow:
    // BEFORE the fix this would have assigned TN0001 (popped from recycled)
    // and collided with the existing accepted TN0001.
    await writeCorruptedIdeas(10, 11)
    const [fresh] = await im.addIdeas(SLUG, [{
      title: 'fresh', logline: 'l', themes: [],
      suggested_chapters: 0, suggested_length: '0 min', mood: '',
    }], 'gpt-4o')

    const result = await im.acceptIdea(SLUG, fresh.id)
    assert.equal(result.episode_code, 'TN0011',
      'must use next_episode_number, not a stale recycled entry')

    const ideas = await im.getIdeas(SLUG, 'accepted')
    const codes = ideas.map(i => i.episode_code).sort()
    const unique = new Set(codes)
    assert.equal(unique.size, codes.length, 'no duplicate episode codes assigned')
  })

  test('legitimate gap is preserved in recycled_numbers (forward heal)', async () => {
    // Slots 1, 2, 3, 5, 6 used; 4 is a true gap. Auto-heal should ADD
    // 4 to recycled_numbers (not strip it), so the next acceptIdea
    // fills the gap.
    const ideas = [
      [1, 'Ep1'], [2, 'Ep2'], [3, 'Ep3'], [5, 'Ep5'], [6, 'Ep6'],
    ].map(([n, title]) => ({
      id: `i-${n}`, title, logline: 'l', themes: [],
      suggested_chapters: 0, suggested_length: '0 min', mood: '',
      status: 'accepted', episode_code: `TN000${n}`,
      generated_at: '2026-01-01T00:00:00Z', accepted_at: '2026-01-01T00:00:00Z',
      batch_id: 'b', model_used: 'm',
    }))
    await fs.writeFile(path.join(pm.projectsRoot(), SLUG, 'ideas.json'), JSON.stringify({
      ideas, next_episode_number: 7, recycled_numbers: [],
    }))

    await im.addIdeas(SLUG, [{
      title: 'fresh', logline: 'l', themes: [],
      suggested_chapters: 0, suggested_length: '0 min', mood: '',
    }], 'gpt-4o')

    const raw = await fs.readFile(path.join(pm.projectsRoot(), SLUG, 'ideas.json'), 'utf-8')
    const data = JSON.parse(raw)
    assert.deepEqual(data.recycled_numbers, [4], 'true gap survives auto-heal')
  })

  test('applyRenumberPatch shifts codes + bumps next + heals recycled atomically', async () => {
    // Three accepted ideas at TN0001..TN0003. Apply a patch that shifts
    // each forward by 5. Verify the file ends up consistent.
    const ideas = [1, 2, 3].map(n => ({
      id: `i-${n}`, title: `Ep ${n}`, logline: 'l', themes: [],
      suggested_chapters: 0, suggested_length: '0 min', mood: '',
      status: 'accepted', episode_code: `TN000${n}`,
      generated_at: '2026-01-01T00:00:00Z', accepted_at: '2026-01-01T00:00:00Z',
      batch_id: 'b', model_used: 'm',
    }))
    await fs.writeFile(path.join(pm.projectsRoot(), SLUG, 'ideas.json'), JSON.stringify({
      ideas, next_episode_number: 4, recycled_numbers: [],
    }))

    const r = await im.applyRenumberPatch(SLUG, {
      renames: [
        { idea_id: 'i-3', new_code: 'TN0008' },
        { idea_id: 'i-2', new_code: 'TN0007' },
        { idea_id: 'i-1', new_code: 'TN0006' },
      ],
      advance_next_to: 9,
    })
    assert.equal(r.applied, 3)
    assert.deepEqual(r.missing, [])

    const data = JSON.parse(await fs.readFile(path.join(pm.projectsRoot(), SLUG, 'ideas.json'), 'utf-8'))
    const codes = data.ideas.map((i: any) => i.episode_code).sort()
    assert.deepEqual(codes, ['TN0006', 'TN0007', 'TN0008'])
    assert.equal(data.next_episode_number, 9)
    // Auto-heal should mark the freshly-vacated 1..5 slots as recyclable
    // (they're below maxNum=8, below next=9, and not in use).
    assert.deepEqual(data.recycled_numbers, [1, 2, 3, 4, 5])
  })

  test('applyRenumberPatch reports missing idea IDs without throwing', async () => {
    await fs.writeFile(path.join(pm.projectsRoot(), SLUG, 'ideas.json'), JSON.stringify({
      ideas: [], next_episode_number: 1, recycled_numbers: [],
    }))
    const r = await im.applyRenumberPatch(SLUG, {
      renames: [{ idea_id: 'i-does-not-exist', new_code: 'TN0001' }],
      advance_next_to: 2,
    })
    assert.equal(r.applied, 0)
    assert.deepEqual(r.missing, ['i-does-not-exist'])
  })
})
