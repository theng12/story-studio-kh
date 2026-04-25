/**
 * Tests for idea-manager: add, accept, dismiss, reset, episode code assignment.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let im: typeof import('../services/idea-manager.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
})

after(async () => { await cleanup() })

beforeEach(async () => {
  // Reset projects dir between tests
  const projectsDir = path.join(tempDir, 'projects')
  await fs.rm(projectsDir, { recursive: true, force: true })
  await fs.mkdir(projectsDir, { recursive: true })
})

/** Helper: create a project and return its meta */
async function setupProject(name = 'Test Series') {
  return pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
}

const sampleIdea = {
  title: 'The Lost Library',
  logline: 'A scholar finds an ancient hidden library.',
  themes: ['mystery', 'discovery'],
  suggested_chapters: 8,
  suggested_length: '45 min',
  mood: 'contemplative',
}

describe('addIdeas()', () => {
  test('stores ideas with status="new" and returns them', async () => {
    const proj = await setupProject()
    const added = await im.addIdeas(proj.slug, [sampleIdea], 'test-model')
    assert.equal(added.length, 1)
    assert.equal(added[0].status, 'new')
    assert.equal(added[0].title, sampleIdea.title)
    assert.equal(added[0].episode_code, null)
    assert.equal(added[0].model_used, 'test-model')
    assert.ok(added[0].id.startsWith('idea-'))
  })

  test('groups ideas by batch_id', async () => {
    const proj = await setupProject()
    const batch = await im.addIdeas(proj.slug, [sampleIdea, sampleIdea, sampleIdea], 'm')
    const batchIds = new Set(batch.map((i) => i.batch_id))
    assert.equal(batchIds.size, 1, 'all ideas in one call share a batch_id')
  })
})

describe('acceptIdea()', () => {
  test('assigns episode_code and creates folders', async () => {
    const proj = await setupProject()
    const [added] = await im.addIdeas(proj.slug, [sampleIdea], 'm')
    const result = await im.acceptIdea(proj.slug, added.id)

    assert.equal(result.episode_code, 'EP001')
    assert.equal(result.idea.status, 'accepted')
    assert.ok(result.idea.accepted_at)
    assert.ok(result.folders_created.length > 0, 'should create subfolders')

    // Folder actually exists
    const existsOnDisk = await fs.stat(result.episode_dir).then(() => true, () => false)
    assert.ok(existsOnDisk, 'episode folder should exist on disk')
  })

  test('increments episode number for subsequent accepts', async () => {
    const proj = await setupProject()
    const [a, b] = await im.addIdeas(proj.slug, [sampleIdea, sampleIdea], 'm')
    const r1 = await im.acceptIdea(proj.slug, a.id)
    const r2 = await im.acceptIdea(proj.slug, b.id)
    assert.equal(r1.episode_code, 'EP001')
    assert.equal(r2.episode_code, 'EP002')
  })

  test('throws for non-existent idea', async () => {
    const proj = await setupProject()
    await assert.rejects(() => im.acceptIdea(proj.slug, 'ghost-id'))
  })
})

describe('dismissIdea() / removeIdea()', () => {
  test('dismiss changes status but keeps idea', async () => {
    const proj = await setupProject()
    const [added] = await im.addIdeas(proj.slug, [sampleIdea], 'm')
    const ok = await im.dismissIdea(proj.slug, added.id)
    assert.equal(ok, true)

    const ideas = await im.getIdeas(proj.slug)
    const updated = ideas.find((i) => i.id === added.id)
    assert.equal(updated?.status, 'dismissed')
  })

  test('removeIdea deletes it entirely', async () => {
    const proj = await setupProject()
    const [added] = await im.addIdeas(proj.slug, [sampleIdea], 'm')
    const ok = await im.removeIdea(proj.slug, added.id)
    assert.equal(ok, true)

    const ideas = await im.getIdeas(proj.slug)
    assert.equal(ideas.find((i) => i.id === added.id), undefined)
  })
})

describe('resetIdea() — recycled episode numbers', () => {
  test('reset clears episode_code and recycles the number', async () => {
    const proj = await setupProject()
    const [added] = await im.addIdeas(proj.slug, [sampleIdea], 'm')
    await im.acceptIdea(proj.slug, added.id)  // EP001

    const { deleted_folder } = await im.resetIdea(proj.slug, added.id)
    assert.ok(deleted_folder, 'should return path to deleted folder')

    // Folder is gone
    const exists = await fs.stat(deleted_folder!).then(() => true, () => false)
    assert.equal(exists, false, 'folder should be deleted')

    // Idea status reverts
    const ideas = await im.getIdeas(proj.slug)
    const updated = ideas.find((i) => i.id === added.id)
    assert.equal(updated?.status, 'new')
    assert.equal(updated?.episode_code, null)
  })

  test('recycled number is reused on next accept', async () => {
    const proj = await setupProject()
    const [a, b] = await im.addIdeas(proj.slug, [sampleIdea, sampleIdea], 'm')
    await im.acceptIdea(proj.slug, a.id)  // EP001
    await im.resetIdea(proj.slug, a.id)    // recycle 001

    const r = await im.acceptIdea(proj.slug, b.id)
    assert.equal(r.episode_code, 'EP001', 'should reuse the recycled number')
  })
})

describe('getIdeas() filtering', () => {
  test('filters by status', async () => {
    const proj = await setupProject()
    const [a, b, c] = await im.addIdeas(proj.slug, [sampleIdea, sampleIdea, sampleIdea], 'm')
    await im.acceptIdea(proj.slug, a.id)
    await im.dismissIdea(proj.slug, b.id)

    const newIdeas = await im.getIdeas(proj.slug, 'new')
    const accepted = await im.getIdeas(proj.slug, 'accepted')
    const dismissed = await im.getIdeas(proj.slug, 'dismissed')

    assert.equal(newIdeas.length, 1)
    assert.equal(newIdeas[0].id, c.id)
    assert.equal(accepted.length, 1)
    assert.equal(dismissed.length, 1)
  })
})

describe('concurrent writes — last-writer-wins protection', () => {
  // Regression test for audit finding 08-persistence #2: before the atomic +
  // locked write refactor, N parallel updateIdea() calls would race on bare
  // fs.writeFile and the last writer to finish would overwrite every other
  // patch. With per-path withLock + writeJsonAtomic, each call is serialised
  // and all patches persist.
  test('50 parallel updateIdea() calls all land in ideas.json', async () => {
    const proj = await setupProject()

    // Seed 50 ideas so we can patch a distinct one per call.
    const seeds = Array.from({ length: 50 }, (_, i) => ({
      ...sampleIdea,
      title: `seed-${i}`,
    }))
    const added = await im.addIdeas(proj.slug, seeds, 'm')
    assert.equal(added.length, 50)

    // Fire all 50 patches in parallel. Each patches a different idea so we can
    // verify every patch persisted — not just the last one to the same idea.
    await Promise.all(
      added.map((idea, i) =>
        im.updateIdea(proj.slug, idea.id, { title: `patched-${i}` }),
      ),
    )

    // Re-read from disk and confirm every patch persisted.
    const afterPatch = await im.getIdeas(proj.slug)
    assert.equal(afterPatch.length, 50, 'no ideas lost')
    for (let i = 0; i < 50; i++) {
      const hit = afterPatch.find((x) => x.id === added[i].id)
      assert.ok(hit, `idea ${i} still present`)
      assert.equal(
        hit!.title,
        `patched-${i}`,
        `idea ${i} patch not lost to last-writer-wins`,
      )
    }
  })

  // Same stress, but all 50 writes target the SAME idea. The final state
  // should reflect one of the 50 patches (any of them — ordering under the
  // lock is timing-dependent), not a corrupt merge or truncated file.
  test('50 parallel updates on the same idea leave the file consistent', async () => {
    const proj = await setupProject()
    const [idea] = await im.addIdeas(proj.slug, [sampleIdea], 'm')

    const patches = Array.from({ length: 50 }, (_, i) => `title-${i}`)
    await Promise.all(
      patches.map((t) => im.updateIdea(proj.slug, idea.id, { title: t })),
    )

    const final = await im.getIdeas(proj.slug)
    assert.equal(final.length, 1)
    assert.ok(
      patches.includes(final[0].title),
      `final title ${final[0].title} should be one of the 50 patches (file not corrupted)`,
    )
  })
})
