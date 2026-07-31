/**
 * Tests for the per-project asset-migrator service.
 *
 * Coverage:
 *   - detectAssetMigrationStatus classifies relative / absolute-inside /
 *     absolute-external correctly
 *   - .icloud placeholder files turn into a blocker (refuse to migrate)
 *   - migrateProjectAssets happy path: copies bytes, rewrites
 *     project.json output_root → './episodes', keeps source by default
 *   - delete_source: true removes the old folder after a successful copy
 *   - refuses when not needed (already co-located)
 *   - refuses when destination already has content
 *   - file count invariant after copy
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let migrator: typeof import('../services/asset-migrator.js')
let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

/**
 * Seed a single project with a project.json + (optionally) populate
 * an external asset folder. Returns absolute paths for both so the
 * tests can manipulate them directly.
 */
async function seedProject(
  slug: string,
  outputRoot: string | undefined,
  externalSeed?: { files: Array<[string, string]> },
): Promise<{ projectDir: string; externalDir: string | null }> {
  const projectDir = path.join(pm.projectsRoot(), slug)
  await fs.mkdir(projectDir, { recursive: true })
  const meta: any = { slug, name: slug }
  if (outputRoot !== undefined) meta.output_root = outputRoot
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify(meta))
  let externalDir: string | null = null
  if (externalSeed) {
    if (!outputRoot || !path.isAbsolute(outputRoot)) {
      throw new Error('externalSeed requires an absolute outputRoot')
    }
    externalDir = outputRoot
    await fs.mkdir(externalDir, { recursive: true })
    for (const [rel, contents] of externalSeed.files) {
      const p = path.join(externalDir, rel)
      await fs.mkdir(path.dirname(p), { recursive: true })
      await fs.writeFile(p, contents)
    }
  }
  return { projectDir, externalDir }
}

describe('asset-migrator', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    migrator = await import('../services/asset-migrator.js')
    assert.equal(pm.projectsRoot(), path.join(tmp.dir, 'projects'))
  })

  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    // Wipe everything in tmp.dir except the dir itself — each test gets
    // a clean slate including any external asset folders previous tests
    // left behind. (A bug discovered while authoring these tests: two
    // tests sharing `tmp.dir/external-assets/proj-real` saw the second
    // test's source contaminated by the first's seed files.)
    const entries = await fs.readdir(tmp.dir).catch(() => [] as string[])
    for (const name of entries) {
      await fs.rm(path.join(tmp.dir, name), { recursive: true, force: true }).catch(() => {})
    }
    await fs.mkdir(pm.projectsRoot(), { recursive: true })
  })

  describe('detectAssetMigrationStatus', () => {
    test('relative output_root → needed:false (kind=relative)', async () => {
      await seedProject('proj', './episodes')
      const s = await migrator.detectAssetMigrationStatus('proj')
      assert.equal(s.needed, false, 'relative paths are already co-located')
      assert.equal(s.current_kind, 'relative')
      assert.match(s.projected_target, /\/proj\/episodes$/)
    })

    test('default (missing) output_root → needed:false (kind=relative)', async () => {
      await seedProject('proj', undefined)
      const s = await migrator.detectAssetMigrationStatus('proj')
      assert.equal(s.needed, false)
      assert.equal(s.current_kind, 'relative')
    })

    test('absolute path INSIDE project dir → needed:false (kind=absolute_inside_project_dir)', async () => {
      const projectDir = path.join(pm.projectsRoot(), 'proj')
      await fs.mkdir(projectDir, { recursive: true })
      // Absolute path that resolves inside the project dir — atypical but
      // possible if someone hand-edited project.json. Still no migration
      // needed since the bytes are already co-located.
      const inside = path.join(projectDir, 'episodes')
      await fs.writeFile(
        path.join(projectDir, 'project.json'),
        JSON.stringify({ output_root: inside }),
      )
      const s = await migrator.detectAssetMigrationStatus('proj')
      assert.equal(s.needed, false)
      assert.equal(s.current_kind, 'absolute_inside_project_dir')
    })

    test('absolute external output_root → needed:true with size estimate', async () => {
      const externalDir = path.join(tmp.dir, 'external-assets', 'proj-real')
      await seedProject('proj', externalDir, {
        files: [
          ['scripts/script.txt', 'hello'],
          ['audio/narration.mp3', 'fake-audio-bytes'],
          ['video/final.mp4', 'fake-video-bytes-larger-payload'],
        ],
      })
      const s = await migrator.detectAssetMigrationStatus('proj')
      assert.equal(s.needed, true)
      assert.equal(s.current_kind, 'absolute_external')
      assert.equal(s.current_output_root, externalDir)
      assert.equal(s.estimated_files, 3)
      assert.ok((s.estimated_bytes || 0) > 0, 'size estimate populated')
      assert.deepEqual(s.blockers, [], 'no blockers on a clean external folder')
    })

    test('.icloud placeholder file in source → blocker reported', async () => {
      const externalDir = path.join(tmp.dir, 'external-with-placeholder')
      await seedProject('proj', externalDir, {
        files: [
          ['regular.txt', 'present'],
          // Simulated iCloud placeholder: filename starts with '.' and ends
          // with '.icloud'. macOS represents non-downloaded synced files
          // this way.
          ['.evicted.mp4.icloud', 'stub-bytes'],
        ],
      })
      const s = await migrator.detectAssetMigrationStatus('proj')
      assert.equal(s.needed, true, 'still needed; just blocked')
      assert.equal(s.blockers.length, 1, 'one blocker for the placeholder')
      assert.match(s.blockers[0]!, /iCloud placeholders/)
      assert.match(s.blockers[0]!, /evicted\.mp4/, 'visible filename in the message')
    })
  })

  describe('migrateProjectAssets', () => {
    test('happy path: copies external assets, rewrites project.json, keeps source', async () => {
      const externalDir = path.join(tmp.dir, 'external-assets', 'proj-real')
      const { projectDir } = await seedProject('proj', externalDir, {
        files: [
          ['scripts/script.txt', 'narration content'],
          ['audio/clip.mp3', 'clip-bytes'],
          ['video/final.mp4', 'video-bytes'],
        ],
      })

      const result = await migrator.migrateProjectAssets('proj')

      // Bytes ended up at the new co-located path.
      assert.ok(existsSync(path.join(projectDir, 'episodes', 'scripts', 'script.txt')),
        'script copied to <projectDir>/episodes/...')
      assert.ok(existsSync(path.join(projectDir, 'episodes', 'video', 'final.mp4')))

      // project.json now points at './episodes' relative.
      const meta = JSON.parse(await fs.readFile(path.join(projectDir, 'project.json'), 'utf-8'))
      assert.equal(meta.output_root, './episodes')

      // Source folder kept by default.
      assert.ok(existsSync(externalDir), 'source preserved (delete_source default false)')
      assert.equal(result.source_kept_at, externalDir)
      assert.equal(result.new_output_root_field, './episodes')
      assert.equal(result.copied_files, 3)
    })

    test('delete_source: true removes the old folder after success', async () => {
      const externalDir = path.join(tmp.dir, 'external-delete-after')
      await seedProject('proj', externalDir, {
        files: [['only.txt', 'present']],
      })
      const result = await migrator.migrateProjectAssets('proj', { delete_source: true })
      assert.equal(existsSync(externalDir), false, 'source removed after delete_source: true')
      assert.equal(result.source_kept_at, null, 'result.source_kept_at is null when deleted')
    })

    test('subsequent detect on a migrated project reports needed:false', async () => {
      const externalDir = path.join(tmp.dir, 'external-second-pass')
      await seedProject('proj', externalDir, { files: [['x.txt', 'x']] })
      await migrator.migrateProjectAssets('proj')
      const s = await migrator.detectAssetMigrationStatus('proj')
      assert.equal(s.needed, false, 'after migration, no further work needed')
      assert.equal(s.current_kind, 'relative', 'output_root is now relative')
    })

    test('refuses when migration is not needed (already co-located)', async () => {
      await seedProject('proj', './episodes')
      await assert.rejects(
        () => migrator.migrateProjectAssets('proj'),
        (e: any) => e.statusCode === 400 && /already co-located/i.test(e.message),
        'rejects with 400 when not needed',
      )
    })

    test('refuses when destination already has content', async () => {
      const externalDir = path.join(tmp.dir, 'external-blocked-dest')
      const { projectDir } = await seedProject('proj', externalDir, {
        files: [['from-source.txt', 'src']],
      })
      // Pre-populate the projected destination so the safety check fires.
      const dest = path.join(projectDir, 'episodes')
      await fs.mkdir(dest, { recursive: true })
      await fs.writeFile(path.join(dest, 'preexisting.mp4'), 'do-not-clobber')

      await assert.rejects(
        () => migrator.migrateProjectAssets('proj'),
        (e: any) => e.statusCode === 409 && /Destination already exists/i.test(e.message),
        'rejects with 409 when destination is occupied',
      )
      // Source untouched.
      assert.ok(existsSync(externalDir), 'source preserved on rejection')
    })

    test('refuses when source has .icloud placeholders', async () => {
      const externalDir = path.join(tmp.dir, 'external-blocked-by-icloud')
      await seedProject('proj', externalDir, {
        files: [
          ['real.txt', 'real'],
          ['.placeholder.bin.icloud', 'stub'],
        ],
      })
      await assert.rejects(
        () => migrator.migrateProjectAssets('proj'),
        (e: any) => e.statusCode === 409 && /iCloud placeholders/i.test(e.message),
        'rejects with 409 when iCloud placeholder is present',
      )
    })
  })
})
