/**
 * Tests for the projects-storage-mover service.
 *
 * Coverage:
 *   - happy-path copy: files arrive at the target with correct count + bytes
 *   - source is NEVER deleted (user-locked "copy + keep" semantics)
 *   - validates target path: refuses same-as-source, refuses inside-source
 *   - refuses non-empty target without merge_into_existing
 *   - merge_into_existing accepts non-empty target
 *   - .DS_Store-only target is treated as effectively empty (not blocked)
 *   - empty source produces a warning but doesn't error
 *   - previewMigration returns the same file/byte tally
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let mover: typeof import('../services/projects-storage-mover.js')
let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

/**
 * Seed PROJECTS_ROOT with a couple of fake projects so the migration
 * has real files to copy. Returns the count + bytes that should land
 * at the target.
 */
async function seedProjects(): Promise<{ files: number; bytes: number }> {
  const a = path.join(pm.projectsRoot(), 'project-a')
  const b = path.join(pm.projectsRoot(), 'project-b')
  const aSub = path.join(a, 'episodes', 'Season 001')
  const bSub = path.join(b, 'episodes', 'Season 001', 'TN0001 - Demo')
  await fs.mkdir(aSub, { recursive: true })
  await fs.mkdir(bSub, { recursive: true })

  const files: Array<[string, string]> = [
    [path.join(a, 'project.json'), JSON.stringify({ slug: 'project-a' })],
    [path.join(a, 'config.json'), '{}'],
    [path.join(a, 'ideas.json'), '{"ideas":[]}'],
    [path.join(aSub, 'placeholder.txt'), 'a-season-marker'],
    [path.join(b, 'project.json'), JSON.stringify({ slug: 'project-b' })],
    [path.join(b, 'config.json'), '{}'],
    [path.join(bSub, 'episode_info.json'), '{}'],
  ]
  let bytes = 0
  for (const [p, contents] of files) {
    await fs.writeFile(p, contents)
    bytes += Buffer.byteLength(contents, 'utf-8')
  }
  return { files: files.length, bytes }
}

describe('projects-storage-mover', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    mover = await import('../services/projects-storage-mover.js')
    assert.equal(pm.projectsRoot(), path.join(tmp.dir, 'projects'))
  })

  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    await fs.rm(pm.projectsRoot(), { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.projectsRoot(), { recursive: true })
  })

  test('happy path: copies files to a fresh target + keeps source intact', async () => {
    const seeded = await seedProjects()
    const target = path.join(tmp.dir, 'destination')
    const r = await mover.migrateProjectsTo(target)

    assert.equal(r.target_path, target)
    assert.equal(r.kept_old_at, pm.projectsRoot())
    assert.equal(r.copied_files, seeded.files, 'file count matches seeded')
    assert.equal(r.copied_bytes, seeded.bytes, 'byte count matches seeded')

    // Source still on disk — copy + keep semantics.
    assert.ok(existsSync(path.join(pm.projectsRoot(), 'project-a', 'project.json')),
      'source project-a survives the copy')
    assert.ok(existsSync(path.join(pm.projectsRoot(), 'project-b', 'config.json')),
      'source project-b survives the copy')

    // Target has the same tree.
    assert.ok(existsSync(path.join(target, 'project-a', 'project.json')))
    assert.ok(existsSync(path.join(target, 'project-b', 'episodes', 'Season 001', 'TN0001 - Demo', 'episode_info.json')))
  })

  test('preview returns matching file/byte tally', async () => {
    const seeded = await seedProjects()
    const r = await mover.previewMigration()
    assert.equal(r.source_path, pm.projectsRoot())
    assert.equal(r.files, seeded.files)
    assert.equal(r.bytes, seeded.bytes)
    // No external output_roots in the basic seed → asset breakdown zero.
    assert.equal(r.asset_files, 0)
    assert.equal(r.asset_bytes, 0)
    assert.equal(r.projects_with_external_assets, 0)
  })

  test('bulk move co-locates external output_root assets + rewrites project.json', async () => {
    // Seed one project whose project.json has an absolute `output_root`
    // pointing at an external folder (the user's actual setup before
    // 2026-04-29). The migration should copy the metadata to the new
    // target AND copy the external asset folder into <newProjectDir>/
    // episodes/, then rewrite the new project.json to './episodes'.
    const projectDir = path.join(pm.projectsRoot(), 'external-proj')
    await fs.mkdir(projectDir, { recursive: true })
    const externalDir = path.join(tmp.dir, 'external-storage', 'external-proj-assets')
    await fs.mkdir(externalDir, { recursive: true })
    await fs.writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({ slug: 'external-proj', output_root: externalDir }),
    )
    await fs.writeFile(path.join(projectDir, 'config.json'), '{}')
    // Seed external assets — the bytes that should follow the move.
    await fs.mkdir(path.join(externalDir, 'audio'), { recursive: true })
    await fs.writeFile(path.join(externalDir, 'audio', 'narration.mp3'), 'fake-audio')
    await fs.writeFile(path.join(externalDir, 'final.mp4'), 'fake-video')

    const target = path.join(tmp.dir, 'co-locate-target')
    const r = await mover.migrateProjectsTo(target)

    // Metadata moved.
    assert.ok(existsSync(path.join(target, 'external-proj', 'project.json')))
    // Assets co-located inside the new project dir's episodes/ folder.
    assert.ok(
      existsSync(path.join(target, 'external-proj', 'episodes', 'final.mp4')),
      'external asset copied into co-located episodes folder',
    )
    assert.ok(
      existsSync(path.join(target, 'external-proj', 'episodes', 'audio', 'narration.mp3')),
      'nested asset copied',
    )
    // project.json rewritten to relative './episodes'.
    const newMeta = JSON.parse(
      await fs.readFile(path.join(target, 'external-proj', 'project.json'), 'utf-8'),
    )
    assert.equal(newMeta.output_root, './episodes')
    // Source preserved at the original external location (copy + keep).
    assert.ok(existsSync(externalDir), 'external source kept in place')
    // Result reports the asset bytes separately.
    assert.equal(r.assets_copied_files, 2)
    assert.ok(r.assets_copied_bytes > 0)
    assert.deepEqual(r.per_project_asset_warnings, [], 'no per-project warnings on the happy path')
  })

  test('refuses target == source (no-op)', async () => {
    await seedProjects()
    let caught: any = null
    try {
      await mover.migrateProjectsTo(pm.projectsRoot())
    } catch (e) { caught = e }
    assert.ok(caught, 'should throw')
    assert.equal((caught as any).statusCode, 400)
    assert.match((caught as Error).message, /same as the current/)
  })

  test('refuses target inside source (would recurse)', async () => {
    await seedProjects()
    const inside = path.join(pm.projectsRoot(), 'project-a', 'inside')
    let caught: any = null
    try {
      await mover.migrateProjectsTo(inside)
    } catch (e) { caught = e }
    assert.ok(caught)
    assert.equal((caught as any).statusCode, 400)
    assert.match((caught as Error).message, /cannot be inside/)
  })

  test('sibling-prefixed target is allowed (not "inside")', async () => {
    // `/tmp/.../projects` and `/tmp/.../projects-new` share a prefix
    // but neither is inside the other. The validator must let this
    // through (path.relative would otherwise mis-flag it).
    await seedProjects()
    const sibling = pm.projectsRoot() + '-new'
    const r = await mover.migrateProjectsTo(sibling)
    assert.equal(r.target_path, sibling)
    await fs.rm(sibling, { recursive: true, force: true })
  })

  test('relative target is rejected', async () => {
    await seedProjects()
    let caught: any = null
    try {
      await mover.migrateProjectsTo('relative/path')
    } catch (e) { caught = e }
    assert.ok(caught)
    assert.equal((caught as any).statusCode, 400)
    assert.match((caught as Error).message, /absolute path/)
  })

  test('refuses non-empty target without merge_into_existing', async () => {
    await seedProjects()
    const target = path.join(tmp.dir, 'occupied')
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, 'something.txt'), 'pre-existing')
    let caught: any = null
    try {
      await mover.migrateProjectsTo(target)
    } catch (e) { caught = e }
    assert.ok(caught)
    assert.equal((caught as any).statusCode, 409, 'distinct status for "non-empty target"')
    assert.match((caught as Error).message, /already contains files/)
  })

  test('non-empty target IS allowed with merge_into_existing', async () => {
    await seedProjects()
    const target = path.join(tmp.dir, 'merge-into')
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, 'preexisting.txt'), 'lives on')
    const r = await mover.migrateProjectsTo(target, { merge_into_existing: true })
    assert.ok(r.target_path)
    assert.ok(existsSync(path.join(target, 'preexisting.txt')), 'pre-existing file survives')
    assert.ok(existsSync(path.join(target, 'project-a', 'project.json')), 'merged content lands')
  })

  test('target with only .DS_Store is treated as empty', async () => {
    // macOS sprinkles .DS_Store into every folder you've ever opened
    // in Finder. The validator must NOT flag a folder whose only
    // entry is .DS_Store as "non-empty" — that's a UX trap.
    await seedProjects()
    const target = path.join(tmp.dir, 'finder-touched')
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, '.DS_Store'), Buffer.alloc(6148))
    const r = await mover.migrateProjectsTo(target)
    assert.ok(r.target_path)
  })

  test('empty source produces a warning but completes', async () => {
    // Don't seed — PROJECTS_ROOT is empty (just the dir itself).
    const target = path.join(tmp.dir, 'empty-src-dest')
    const r = await mover.migrateProjectsTo(target)
    assert.equal(r.copied_files, 0)
    assert.equal(r.copied_bytes, 0)
    assert.ok(r.warnings.some(w => /Source projects directory is empty/i.test(w)),
      `expected an empty-source warning; got: ${JSON.stringify(r.warnings)}`)
  })

  // ── inspectTargetForExistingProjects ──────────────────────────────
  // The "use existing folder (no copy)" flow on a second machine: the
  // iCloud-synced folder already has projects from machine A; we just
  // need to point this app at it. The inspect helper drives the
  // confirmation dialog ("Found N projects at this path — use it?").

  test('inspect: missing target returns exists:false', async () => {
    const r = await mover.inspectTargetForExistingProjects(path.join(tmp.dir, 'nope'))
    assert.equal(r.exists, false)
    assert.equal(r.project_count, 0)
    assert.deepEqual(r.sample_slugs, [])
  })

  test('inspect: empty existing dir returns exists:true + 0 projects', async () => {
    const dir = path.join(tmp.dir, 'empty-existing')
    await fs.mkdir(dir, { recursive: true })
    const r = await mover.inspectTargetForExistingProjects(dir)
    assert.equal(r.exists, true)
    assert.equal(r.project_count, 0)
  })

  test('inspect: counts subfolders that contain project.json', async () => {
    // Mimic a synced cloud folder with projects already in it.
    const dir = path.join(tmp.dir, 'has-projects')
    await fs.mkdir(path.join(dir, 'project-a'), { recursive: true })
    await fs.writeFile(path.join(dir, 'project-a', 'project.json'), '{}')
    await fs.mkdir(path.join(dir, 'project-b'), { recursive: true })
    await fs.writeFile(path.join(dir, 'project-b', 'project.json'), '{}')
    // Decoy folder — no project.json, must be excluded.
    await fs.mkdir(path.join(dir, 'not-a-project'), { recursive: true })
    await fs.writeFile(path.join(dir, 'not-a-project', 'random.txt'), 'noise')
    // Hidden dir (cloud metadata, .DS_Store dirs, etc) — must be excluded.
    await fs.mkdir(path.join(dir, '.Trashes'), { recursive: true })

    const r = await mover.inspectTargetForExistingProjects(dir)
    assert.equal(r.project_count, 2)
    assert.deepEqual(r.sample_slugs.sort(), ['project-a', 'project-b'])
  })

  test('inspect: caps sample_slugs at 10 even when more exist', async () => {
    const dir = path.join(tmp.dir, 'many-projects')
    await fs.mkdir(dir, { recursive: true })
    for (let i = 0; i < 15; i++) {
      const sub = path.join(dir, `project-${String(i).padStart(2, '0')}`)
      await fs.mkdir(sub, { recursive: true })
      await fs.writeFile(path.join(sub, 'project.json'), '{}')
    }
    const r = await mover.inspectTargetForExistingProjects(dir)
    assert.equal(r.project_count, 15)
    assert.equal(r.sample_slugs.length, 10, 'sample capped at 10')
  })

  test('inspect: rejects non-absolute target', async () => {
    let caught: any = null
    try {
      await mover.inspectTargetForExistingProjects('relative/path')
    } catch (e) { caught = e }
    assert.ok(caught)
    assert.equal((caught as any).statusCode, 400)
  })
})
