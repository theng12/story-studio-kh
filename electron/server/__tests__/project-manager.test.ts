/**
 * Tests for project-manager: CRUD, slug collision, config, standards.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
})

after(async () => { await cleanup() })

beforeEach(async () => {
  // Clean projects dir between tests
  const projectsDir = path.join(tempDir, 'projects')
  await fs.rm(projectsDir, { recursive: true, force: true })
  await fs.mkdir(projectsDir, { recursive: true })
})

describe('PROJECTS_ROOT path resolution', () => {
  test('uses STORY_STUDIO_DATA_DIR when set', () => {
    assert.ok(pm.PROJECTS_ROOT.startsWith(tempDir), `expected projects in temp dir, got: ${pm.PROJECTS_ROOT}`)
  })
})

describe('createProject / listProjects / getProject', () => {
  test('creates project with auto-slug from name', async () => {
    const p = await pm.createProject({ name: 'My New Project' })
    assert.equal(p.name, 'My New Project')
    assert.equal(p.slug, 'my-new-project')
    assert.equal(p.episode_prefix, 'EP')
  })

  test('auto-increments slug on collision', async () => {
    await pm.createProject({ name: 'Test' })
    const p2 = await pm.createProject({ name: 'Test' })
    assert.equal(p2.slug, 'test-2')
  })

  test('Windows reserved name "CON" is prefixed so mkdir works', async () => {
    // Before H5 fix: slug was "con", and on Windows mkdir failed with an
    // opaque error. macOS lets it through but we still normalise so slugs
    // stay portable across machines.
    const p = await pm.createProject({ name: 'CON' })
    assert.equal(p.slug, 'project-con')
    // Directory actually got written.
    const dir = path.join(tempDir, 'projects', p.slug)
    assert.ok(await fs.stat(dir).then(() => true, () => false),
      'project directory must exist on disk')
  })

  test('long project name is truncated to keep MAX_PATH headroom on Windows', async () => {
    const p = await pm.createProject({ name: 'A'.repeat(200) })
    assert.ok(p.slug.length <= 50,
      `slug should be capped at 50 chars, got ${p.slug.length}`)
  })

  test('slug collision is detected case-insensitively', async () => {
    // On APFS/HFS+/NTFS "Foo" and "foo" are the same directory, so if two
    // projects only differ in case one would silently clobber the other's
    // folder. sanitizeProjectSlug() already lowercases so the real
    // collision test is that the auto-increment picks `-2` rather than
    // reusing the existing directory.
    await pm.createProject({ name: 'Mixed Case' })
    const p2 = await pm.createProject({ name: 'MIXED case' })
    assert.equal(p2.slug, 'mixed-case-2')
  })

  test('honors custom episode_prefix and digits', async () => {
    const p = await pm.createProject({ name: 'X', episode_prefix: 'TN', episode_digits: 5 })
    assert.equal(p.episode_prefix, 'TN')
    assert.equal(p.episode_digits, 5)
  })

  test('listProjects returns all created projects', async () => {
    await pm.createProject({ name: 'Alpha' })
    await pm.createProject({ name: 'Beta' })
    const list = await pm.listProjects()
    const slugs = list.map((p) => p.slug)
    assert.ok(slugs.includes('alpha'))
    assert.ok(slugs.includes('beta'))
  })

  test('getProject returns null for non-existent slug', async () => {
    const p = await pm.getProject('does-not-exist')
    assert.equal(p, null)
  })

  test('creates config.json with defaults', async () => {
    const p = await pm.createProject({ name: 'ConfigTest' })
    const configPath = path.join(tempDir, 'projects', p.slug, 'config.json')
    const exists = await fs.stat(configPath).then(() => true, () => false)
    assert.ok(exists, 'config.json should be created')
  })
})

describe('updateProject / deleteProject', () => {
  test('updates project metadata', async () => {
    const p = await pm.createProject({ name: 'Original' })
    const updated = await pm.updateProject(p.slug, { name: 'Renamed', episode_prefix: 'NEW' })
    assert.equal(updated?.name, 'Renamed')
    assert.equal(updated?.episode_prefix, 'NEW')
  })

  test('returns null when updating non-existent project', async () => {
    const r = await pm.updateProject('ghost', { name: 'x' })
    assert.equal(r, null)
  })

  test('deleteProject soft-deletes (folder stays on disk, hidden from list)', async () => {
    // v1.0.19: Delete is non-destructive. The folder remains on disk so
    // the user can recover or manually clean up; listProjects filters it.
    // Hard delete is a separate explicit step via the soft-deleted-projects
    // route.
    const p = await pm.createProject({ name: 'ToDelete' })
    const dir = path.join(tempDir, 'projects', p.slug)
    const existsBefore = await fs.stat(dir).then(() => true, () => false)
    assert.ok(existsBefore)

    const result = await pm.deleteProject(p.slug)
    assert.equal(result.ok, true, 'deleteProject reports ok')
    assert.equal(result.disposition, 'soft_deleted', 'default-location → soft_deleted')
    assert.equal(result.orphan_path, dir, 'orphan_path is the original folder')
    assert.equal(result.name, 'ToDelete', 'name carries through from project.json')

    // Folder is UNTOUCHED — that's the whole point of soft delete.
    const existsAfter = await fs.stat(dir).then(() => true, () => false)
    assert.equal(existsAfter, true, 'folder still on disk after soft delete')

    // listProjects filters the slug out so the user no longer sees it
    // in the live list.
    const list = await pm.listProjects()
    assert.equal(list.some(x => x.slug === p.slug), false, 'soft-deleted slug is hidden from listProjects')
  })

  test('deleteProject returns ok:false when slug does not exist', async () => {
    const result = await pm.deleteProject('does-not-exist')
    assert.equal(result.ok, false)
  })

  test('createProject with the same name auto-clears a prior soft-delete tombstone', async () => {
    // The "I made a mistake, let me redo it" path. Create → delete →
    // create again should succeed and leave the slug visible.
    const first = await pm.createProject({ name: 'RedoMe' })
    await pm.deleteProject(first.slug)
    // listProjects hides it now…
    const hidden = await pm.listProjects()
    assert.equal(hidden.some(x => x.slug === first.slug), false)

    // …but creating again with the same name (which produces a unique
    // slug if the original folder still exists) should work, and the
    // resulting project should be visible in the list.
    const second = await pm.createProject({ name: 'RedoMe' })
    const visible = await pm.listProjects()
    assert.equal(visible.some(x => x.slug === second.slug), true,
      'fresh project shows in list')
  })
})

describe('getConfig / getSafeConfig / updateApiKeys', () => {
  test('getConfig returns null for non-existent project', async () => {
    const c = await pm.getConfig('ghost')
    assert.equal(c, null)
  })

  test('updateApiKeys persists keys; getConfig returns them', async () => {
    const p = await pm.createProject({ name: 'APITest' })
    await pm.updateApiKeys(p.slug, { openai_api_key: 'sk-test123' })
    const config = await pm.getConfig(p.slug)
    assert.equal(config?.openai_api_key, 'sk-test123')
  })

  test('getSafeConfig returns booleans for key presence, not values', async () => {
    const p = await pm.createProject({ name: 'SafeTest' })
    await pm.updateApiKeys(p.slug, { openai_api_key: 'sk-secret', kie_api_key: 'k-secret' })
    const safe = await pm.getSafeConfig(p.slug) as any
    // Should NOT contain actual keys
    assert.ok(!JSON.stringify(safe).includes('sk-secret'), 'safe config must not leak openai key')
    assert.ok(!JSON.stringify(safe).includes('k-secret'), 'safe config must not leak kie key')
  })
})

describe('Standards (production_standards.txt)', () => {
  test('getStandards returns null for missing project', async () => {
    const s = await pm.getStandards('ghost')
    assert.equal(s, null)
  })

  test('updateStandards / getStandards round-trip', async () => {
    const p = await pm.createProject({ name: 'StdTest' })
    const content = '## My production standards\n\nWrite in second person.'
    await pm.updateStandards(p.slug, content)
    const read = await pm.getStandards(p.slug)
    assert.equal(read, content)
  })
})

describe('Corrupt project.json handling (audit #4 / H2)', () => {
  test('updateProject REJECTS when project.json is corrupt (does not silently merge into {})', async () => {
    // Regression guard for audit-reports/08-persistence.md finding #4:
    // the old readJson swallowed parse errors and returned {}, so this
    // updateProject would merge-and-write `{ name: 'Renamed' }` as the
    // entire file, wiping slug/project_id/output_root/episode_prefix.
    const p = await pm.createProject({ name: 'Corruptible' })
    const metaPath = path.join(tempDir, 'projects', p.slug, 'project.json')

    // Simulate a mid-write crash that left project.json truncated.
    const corrupt = '{"name": "broken'
    await fs.writeFile(metaPath, corrupt)

    await assert.rejects(
      () => pm.updateProject(p.slug, { name: 'Renamed', episode_prefix: 'RN' }),
      (err: any) => err?.code === 'JSON_CORRUPT' || /corrupt/i.test(String(err?.message)),
    )

    // On-disk file must be untouched — NOT replaced with merged-into-empty data.
    const afterBytes = await fs.readFile(metaPath, 'utf-8')
    assert.equal(afterBytes, corrupt, 'updateProject must not rewrite a corrupt file')

    // And the "merged-into-empty" smoking-gun must not appear.
    assert.doesNotMatch(afterBytes, /"slug"\s*:\s*"corruptible"/)
  })

  test('getProject propagates JsonCorruptError (not a silent 404)', async () => {
    const p = await pm.createProject({ name: 'CorruptRead' })
    const metaPath = path.join(tempDir, 'projects', p.slug, 'project.json')
    await fs.writeFile(metaPath, 'not json at all')

    await assert.rejects(
      () => pm.getProject(p.slug),
      (err: any) => err?.code === 'JSON_CORRUPT',
    )
  })

  test('listProjects skips corrupt entries instead of failing', async () => {
    await pm.createProject({ name: 'Good' })
    const bad = await pm.createProject({ name: 'Bad' })
    const badMeta = path.join(tempDir, 'projects', bad.slug, 'project.json')
    await fs.writeFile(badMeta, '{ "name": ')

    // Must not reject — a single corrupt project shouldn't hide the rest.
    const list = await pm.listProjects()
    const slugs = list.map((p) => p.slug)
    assert.ok(slugs.includes('good'), 'healthy project still listed')
    assert.ok(!slugs.includes('bad'), 'corrupt project skipped')
  })

  test('updateConfig REJECTS when config.json is corrupt', async () => {
    const p = await pm.createProject({ name: 'CorruptCfg' })
    const cfgPath = path.join(tempDir, 'projects', p.slug, 'config.json')
    const corrupt = '{"voice_presets": [broken'
    await fs.writeFile(cfgPath, corrupt)

    await assert.rejects(
      () => pm.updateConfig(p.slug, { voice_presets: [] }),
      (err: any) => err?.code === 'JSON_CORRUPT' || /corrupt/i.test(String(err?.message)),
    )

    const afterBytes = await fs.readFile(cfgPath, 'utf-8')
    assert.equal(afterBytes, corrupt, 'updateConfig must not rewrite a corrupt file')
  })
})

describe('Subfolder template validation (via updateProject)', () => {
  test('accepts valid templates with {code} placeholder', async () => {
    const p = await pm.createProject({ name: 'SubTest' })
    const r = await pm.updateProject(p.slug, {
      subfolder_names: {
        script: '{code} - Script',
        metadata: '{code} - Metadata',
        scene_prompts: '{code} - Scene Prompts',
        thumb_prompts: '{code} - Thumb Prompts',
        images: '{code} - Images',
        thumbnails: '{code} - Thumbnails',
        audio: '{code} - Audio',
        merged_audio: '{code} - Merged',
        subtitles: '{code} - Subtitles',
        video: '{code} - Video',
      },
    })
    assert.equal(r?.subfolder_names.script, '{code} - Script')
  })
})
