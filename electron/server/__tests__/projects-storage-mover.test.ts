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
 *   - a project's episodes travel with it (they are inside its own folder)
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

  test('a project’s episodes travel with it, because they are inside it', async () => {
    // This replaces a test for the co-location phase, which copied a project’s
    // episodes in from an external folder named by `output_root` and rewrote
    // the field. Episodes always live at `<projectDir>/episodes` now, so the
    // wholesale copy carries them and there is no second phase. What still has
    // to hold is that they actually arrive — and that a stale `output_root`
    // left in a project.json is neither honoured nor rewritten on the way.
    const projectDir = path.join(pm.projectsRoot(), 'legacy-proj')
    await fs.mkdir(path.join(projectDir, 'episodes', 'audio'), { recursive: true })
    await fs.writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({ slug: 'legacy-proj', output_root: '/Volumes/Gone/assets' }),
    )
    await fs.writeFile(path.join(projectDir, 'config.json'), '{}')
    await fs.writeFile(path.join(projectDir, 'episodes', 'final.mp4'), 'fake-video')
    await fs.writeFile(path.join(projectDir, 'episodes', 'audio', 'narration.mp3'), 'fake-audio')

    const target = path.join(tmp.dir, 'co-locate-target')
    await mover.migrateProjectsTo(target)

    assert.ok(existsSync(path.join(target, 'legacy-proj', 'project.json')))
    assert.ok(existsSync(path.join(target, 'legacy-proj', 'episodes', 'final.mp4')))
    assert.ok(existsSync(path.join(target, 'legacy-proj', 'episodes', 'audio', 'narration.mp3')))

    // Untouched, deliberately: the field is inert, and quietly rewriting a
    // person's project.json to tidy up after ourselves is its own defect.
    const newMeta = JSON.parse(
      await fs.readFile(path.join(target, 'legacy-proj', 'project.json'), 'utf-8'),
    )
    assert.equal(newMeta.output_root, '/Volumes/Gone/assets')

    // Copy + keep, unchanged.
    assert.ok(existsSync(path.join(projectDir, 'episodes', 'final.mp4')), 'source kept in place')
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
})
