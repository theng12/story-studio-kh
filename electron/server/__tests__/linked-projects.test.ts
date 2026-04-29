/**
 * Tests for the linked-projects registry + the per-project mover.
 *
 * Coverage:
 *   - Registry CRUD: add validates project.json presence, add is
 *     idempotent, remove returns false for unknown paths
 *   - Sync slug → directory cache: invalidates after add/remove,
 *     handles missing project.json gracefully
 *   - listProjects (project-manager) merges default + linked, with
 *     default winning on slug conflict
 *   - moveProjectToFolder: happy path, delete_source on/off,
 *     rename-to-bak on default location, refuses populated dest,
 *     refuses .icloud placeholders, refuses self-recursive dest
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let lp: typeof import('../services/linked-projects.js')
let mover: typeof import('../services/project-mover.js')
let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

async function seedProject(
  parentDir: string,
  slug: string,
  extras: Array<[string, string]> = [],
): Promise<string> {
  const projDir = path.join(parentDir, slug)
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(
    path.join(projDir, 'project.json'),
    JSON.stringify({ slug, name: slug, episode_prefix: 'EP' }),
  )
  for (const [rel, contents] of extras) {
    const p = path.join(projDir, rel)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, contents)
  }
  return projDir
}

describe('linked-projects', () => {
  before(async () => {
    tmp = await useTempDataDir()
    lp = await import('../services/linked-projects.js')
    pm = await import('../services/project-manager.js')
    mover = await import('../services/project-mover.js')
    assert.equal(pm.PROJECTS_ROOT, path.join(tmp.dir, 'projects'))
  })

  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    // Reset every directory under tmp.dir so tests don't pollute each
    // other (linked-paths registry lives in app-settings.json which is
    // also under tmp.dir).
    const entries = await fs.readdir(tmp.dir).catch(() => [] as string[])
    for (const name of entries) {
      await fs.rm(path.join(tmp.dir, name), { recursive: true, force: true }).catch(() => {})
    }
    await fs.mkdir(pm.PROJECTS_ROOT, { recursive: true })
    lp.invalidateLinkedDirCache()
  })

  describe('registry CRUD', () => {
    test('addLinkedProject rejects a folder without project.json', async () => {
      const empty = path.join(tmp.dir, 'not-a-project')
      await fs.mkdir(empty, { recursive: true })
      await assert.rejects(
        () => lp.addLinkedProject(empty),
        (e: any) => e.statusCode === 400 && /project\.json/i.test(e.message),
      )
    })

    test('addLinkedProject succeeds + is idempotent', async () => {
      const linkedDir = await seedProject(path.join(tmp.dir, 'external'), 'foo')
      const r1 = await lp.addLinkedProject(linkedDir)
      assert.equal(r1.slug, 'foo')
      // Second add doesn't duplicate.
      await lp.addLinkedProject(linkedDir)
      const all = await lp.getLinkedProjectPaths()
      assert.equal(all.length, 1)
      assert.equal(all[0], path.resolve(linkedDir))
    })

    test('removeLinkedProject returns true once, false on subsequent calls', async () => {
      const linkedDir = await seedProject(path.join(tmp.dir, 'external'), 'foo')
      await lp.addLinkedProject(linkedDir)
      assert.equal(await lp.removeLinkedProject(linkedDir), true)
      assert.equal(await lp.removeLinkedProject(linkedDir), false)
    })

    test('listLinkedProjects flags non-existent paths as exists:false', async () => {
      const linkedDir = await seedProject(path.join(tmp.dir, 'external'), 'foo')
      await lp.addLinkedProject(linkedDir)
      // Now delete the folder out from under the registry.
      await fs.rm(linkedDir, { recursive: true, force: true })
      const list = await lp.listLinkedProjects()
      assert.equal(list.length, 1)
      assert.equal(list[0]!.exists, false)
    })

    test('addLinkedProject derives slug from folder name when project.json lacks slug field', async () => {
      const linkedDir = path.join(tmp.dir, 'external', 'no-slug-field')
      await fs.mkdir(linkedDir, { recursive: true })
      // project.json with no slug field — addLinkedProject should fall
      // back to basename ('no-slug-field').
      await fs.writeFile(path.join(linkedDir, 'project.json'), JSON.stringify({ name: 'Anonymous' }))
      const info = await lp.addLinkedProject(linkedDir)
      assert.equal(info.slug, 'no-slug-field')
    })
  })

  describe('getProjectDir + listProjects merging', () => {
    test('default-location project resolves via getProjectDir', async () => {
      await seedProject(pm.PROJECTS_ROOT, 'default-only')
      const dir = pm.getProjectDir('default-only')
      assert.ok(dir)
      assert.equal(dir, path.join(pm.PROJECTS_ROOT, 'default-only'))
    })

    test('linked-only project resolves via getProjectDir after add', async () => {
      const linkedDir = await seedProject(path.join(tmp.dir, 'external'), 'linked-only')
      await lp.addLinkedProject(linkedDir)
      const dir = pm.getProjectDir('linked-only')
      assert.ok(dir, 'linked project resolves by slug')
      assert.equal(dir, path.resolve(linkedDir))
    })

    test('default wins over linked on slug conflict', async () => {
      // Same slug at both locations.
      await seedProject(pm.PROJECTS_ROOT, 'shared-slug')
      const linkedDir = await seedProject(path.join(tmp.dir, 'external'), 'shared-slug')
      await lp.addLinkedProject(linkedDir)
      const dir = pm.getProjectDir('shared-slug')
      // Default-location entries always win over linked.
      assert.equal(dir, path.join(pm.PROJECTS_ROOT, 'shared-slug'))
    })

    test('listProjects merges default + linked into one list', async () => {
      await seedProject(pm.PROJECTS_ROOT, 'local')
      const linkedDir = await seedProject(path.join(tmp.dir, 'external'), 'remote')
      await lp.addLinkedProject(linkedDir)
      const all = await pm.listProjects()
      const slugs = all.map(p => p.slug).sort()
      assert.deepEqual(slugs, ['local', 'remote'])
    })

    test('listProjects skips *.bak-* folders left by Move this project to…', async () => {
      await seedProject(pm.PROJECTS_ROOT, 'live-project')
      // A residual backup folder from a prior move (delete_source: false).
      await fs.mkdir(path.join(pm.PROJECTS_ROOT, 'live-project.bak-2026-04-29T01-23-45-678Z'), { recursive: true })
      const all = await pm.listProjects()
      assert.equal(all.length, 1)
      assert.equal(all[0]!.slug, 'live-project')
    })
  })

  /**
   * Linked-aware read paths.
   *
   * Regression coverage for v1.0.16 — before this batch, services like
   * idea-manager / character-manager / job-queue / session-tracker /
   * upload-resume-sidecar / episode-status-cache / asset-status all
   * hardcoded `path.join(PROJECTS_ROOT, slug, …)` and so silently
   * returned empty data for linked (e.g. iCloud-synced) projects.
   * Each test below seeds the data INSIDE the linked folder, links it,
   * then asserts the corresponding service finds it.
   */
  describe('linked-aware service reads', () => {
    test('idea-manager reads ideas.json from a linked project folder', async () => {
      const linkedDir = await seedProject(path.join(tmp.dir, 'external'), 'idea-host')
      // Plant ideas.json in the linked folder (the iCloud reality).
      await fs.writeFile(
        path.join(linkedDir, 'ideas.json'),
        JSON.stringify({
          ideas: [{
            id: 'idea-1', title: 'Test', logline: 'lg', themes: [],
            suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
            status: 'new', episode_code: null, generated_at: '2026-01-01T00:00:00Z',
            accepted_at: null, batch_id: 'b1', model_used: 'test',
          }],
          next_episode_number: 1,
        }),
      )
      await lp.addLinkedProject(linkedDir)
      const im = await import('../services/idea-manager.js')
      const ideas = await im.getIdeas('idea-host')
      assert.equal(ideas.length, 1, 'idea-manager finds the seeded idea in the linked folder')
      assert.equal(ideas[0]!.title, 'Test')
    })

    test('idea-manager writes ideas to the linked project folder, not PROJECTS_ROOT', async () => {
      const linkedDir = await seedProject(path.join(tmp.dir, 'external'), 'idea-writer')
      await lp.addLinkedProject(linkedDir)
      const im = await import('../services/idea-manager.js')
      // addIdeas (the real public writer) takes the user-facing shape +
      // stamps id/status/etc. internally. We just need to know the file
      // landed in the right place.
      await im.addIdeas('idea-writer', [{
        title: 'Written', logline: 'lg', themes: [],
        suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
      }], 'test-model')
      assert.equal(existsSync(path.join(linkedDir, 'ideas.json')), true,
        'ideas.json should be at the linked location')
      assert.equal(existsSync(path.join(pm.PROJECTS_ROOT, 'idea-writer', 'ideas.json')), false,
        'ideas.json must NOT leak into PROJECTS_ROOT for a linked-only project')
    })

    test('utils.resolveEpisodePaths anchors relative output_root to the linked dir', async () => {
      // Project has output_root: './episodes' (the v1.0.15 co-located default).
      // For a linked project, episodes should resolve under the linked folder.
      const linkedDir = path.join(tmp.dir, 'external', 'ep-host')
      await fs.mkdir(linkedDir, { recursive: true })
      await fs.writeFile(
        path.join(linkedDir, 'project.json'),
        JSON.stringify({
          slug: 'ep-host',
          name: 'Ep Host',
          episode_prefix: 'EP',
          episode_digits: 4,
          season_size: 20,
          season_prefix: 'Season',
          folder_template: '{season_prefix} {season_num}/{code} - {title}/',
          output_root: './episodes',
        }),
      )
      await lp.addLinkedProject(linkedDir)
      const utils = await import('../services/utils.js')
      const paths = await utils.resolveEpisodePaths('ep-host', 'EP0001', 'Pilot')
      assert.equal(paths.output_root, path.join(linkedDir, 'episodes'),
        'relative output_root must anchor to the linked dir, not PROJECTS_ROOT')
      assert.ok(paths.episode_dir.startsWith(linkedDir),
        'episode_dir must live inside the linked folder')
    })

    test('character-manager points at the linked folder', async () => {
      const linkedDir = await seedProject(path.join(tmp.dir, 'external'), 'char-host')
      await lp.addLinkedProject(linkedDir)
      // Seed a character in the linked folder.
      const charsDir = path.join(linkedDir, 'characters', 'hero')
      await fs.mkdir(charsDir, { recursive: true })
      await fs.writeFile(
        path.join(charsDir, 'character.json'),
        JSON.stringify({
          id: 'hero', name: 'Hero', scope: 'project',
          schema_version: 1, created_at: '2026-01-01T00:00:00Z',
        }),
      )
      const cm = await import('../services/character-manager.js')
      const char = await cm.getCharacter('char-host', 'hero')
      assert.ok(char, 'character-manager finds the seeded character')
      assert.equal(char!.id, 'hero')
    })

    test('job-queue jobs.json lives next to the linked project', async () => {
      const linkedDir = await seedProject(path.join(tmp.dir, 'external'), 'job-host')
      await lp.addLinkedProject(linkedDir)
      // Plant a jobs.json in the linked folder so getJobsForProject reads it.
      const sampleJob = {
        id: 'j1', type: 'idea_generation', status: 'completed',
        project_slug: 'job-host', episode_id: '', episode_code: '',
        progress: 100, message: 'done', metadata: {},
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        cost: 0,
      }
      await fs.writeFile(
        path.join(linkedDir, 'jobs.json'),
        JSON.stringify({ jobs: [sampleJob] }),
      )
      const jq = await import('../services/job-queue.js')
      const jobs = await jq.getJobs('job-host')
      assert.equal(jobs.length, 1)
      assert.equal(jobs[0]!.id, 'j1')
    })
  })

  describe('moveProjectToFolder', () => {
    test('happy path: copies project, registers linked entry, renames source', async () => {
      const projDir = await seedProject(pm.PROJECTS_ROOT, 'mover-test', [
        ['scripts/script.txt', 'narration content'],
        ['episodes/EP001/audio.mp3', 'audio bytes'],
      ])
      const destParent = path.join(tmp.dir, 'destination')
      const result = await mover.moveProjectToFolder('mover-test', destParent)

      // New location populated.
      const newDir = path.join(destParent, 'mover-test')
      assert.ok(existsSync(path.join(newDir, 'project.json')))
      assert.ok(existsSync(path.join(newDir, 'scripts', 'script.txt')))
      assert.ok(existsSync(path.join(newDir, 'episodes', 'EP001', 'audio.mp3')))

      // Source renamed to *.bak-* (delete_source default off).
      assert.equal(existsSync(projDir), false, 'original folder renamed')
      assert.equal(result.source_disposition, 'renamed')
      assert.ok(result.renamed_source_path)
      assert.ok(existsSync(result.renamed_source_path!))

      // Linked entry registered.
      const linked = await lp.getLinkedProjectPaths()
      assert.ok(linked.includes(path.resolve(newDir)))

      // Project still resolves by slug.
      assert.equal(pm.getProjectDir('mover-test'), path.resolve(newDir))
    })

    test('delete_source: true removes the source after a successful move', async () => {
      await seedProject(pm.PROJECTS_ROOT, 'mover-delete', [['only.txt', 'x']])
      const destParent = path.join(tmp.dir, 'destination')
      const result = await mover.moveProjectToFolder('mover-delete', destParent, { delete_source: true })

      assert.equal(result.source_disposition, 'deleted')
      assert.equal(existsSync(path.join(pm.PROJECTS_ROOT, 'mover-delete')), false)
      assert.equal(existsSync(path.join(destParent, 'mover-delete')), true)
    })

    test('refuses move when destination already has content', async () => {
      await seedProject(pm.PROJECTS_ROOT, 'mover-blocked', [['x.txt', 'src']])
      const destParent = path.join(tmp.dir, 'destination')
      // Pre-populate target so the safety check fires.
      const newDir = path.join(destParent, 'mover-blocked')
      await fs.mkdir(newDir, { recursive: true })
      await fs.writeFile(path.join(newDir, 'preexisting.txt'), 'do-not-clobber')

      await assert.rejects(
        () => mover.moveProjectToFolder('mover-blocked', destParent),
        (e: any) => e.statusCode === 409 && /Destination already exists/i.test(e.message),
      )
      // Source intact on rejection.
      assert.equal(existsSync(path.join(pm.PROJECTS_ROOT, 'mover-blocked')), true)
    })

    test('refuses move when source has .icloud placeholders', async () => {
      const projDir = await seedProject(pm.PROJECTS_ROOT, 'mover-icloud', [
        ['real.txt', 'real'],
        ['.evicted.bin.icloud', 'stub'],
      ])
      const destParent = path.join(tmp.dir, 'destination')
      await assert.rejects(
        () => mover.moveProjectToFolder('mover-icloud', destParent),
        (e: any) => e.statusCode === 409 && /iCloud placeholders/i.test(e.message),
      )
      // Source intact.
      assert.ok(existsSync(projDir))
    })

    test('refuses destination inside source folder', async () => {
      const projDir = await seedProject(pm.PROJECTS_ROOT, 'mover-recursive', [['x.txt', 'x']])
      // Try to move INTO a subfolder of itself.
      const insideDest = path.join(projDir, 'subfolder')
      await assert.rejects(
        () => mover.moveProjectToFolder('mover-recursive', insideDest),
        (e: any) => e.statusCode === 400 && /Destination cannot be inside/i.test(e.message),
      )
    })

    test('moving an already-linked project re-links to new location', async () => {
      // First move a project from default to a linked location.
      await seedProject(pm.PROJECTS_ROOT, 'twice-moved', [['x.txt', 'first']])
      const dest1 = path.join(tmp.dir, 'first-destination')
      await mover.moveProjectToFolder('twice-moved', dest1, { delete_source: true })
      // Verify it's linked at dest1.
      assert.equal(pm.getProjectDir('twice-moved'), path.join(dest1, 'twice-moved'))

      // Now move it again to a different location. Since it's now a
      // linked project (not default-located), the source should be
      // de-registered, not renamed-to-bak.
      const dest2 = path.join(tmp.dir, 'second-destination')
      const result = await mover.moveProjectToFolder('twice-moved', dest2)
      assert.equal(result.source_disposition, 'kept_at_linked')
      // New location is the resolved one.
      assert.equal(pm.getProjectDir('twice-moved'), path.join(dest2, 'twice-moved'))
      // Old linked entry de-registered.
      const linked = await lp.getLinkedProjectPaths()
      assert.equal(linked.includes(path.join(dest1, 'twice-moved')), false)
      assert.equal(linked.includes(path.join(dest2, 'twice-moved')), true)
    })
  })
})
