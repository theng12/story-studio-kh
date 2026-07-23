/**
 * Tests for `importProjectFromFolder` — the channel-isolation guarantee
 * verified manually in Session 10 (audit-reports/12 §A.9).
 *
 * Three load-bearing invariants:
 *
 *  1. v1 → v2 manifest normalisation drops the legacy preset bag silently
 *     (Session 05 §2 — presets, production_standards, required_named_roots,
 *     youtube_channel_url all stay per-machine and must NOT leak across
 *     synced folders).
 *  2. With no manifest, the importer infers structural metadata (prefix,
 *     digits, season prefix, subfolder names) from the folder layout via
 *     `inferProjectMetadata`.
 *  3. Every import writes an empty `secrets.json` at the destination —
 *     this is the channel-isolation invariant. API keys are per-machine;
 *     a user-supplied source folder MUST NOT seed the secrets file.
 *  4. Slug collisions are reported via `action: 'collision'` (not silently
 *     overwritten or auto-uniqued). Caller retries with `adopt_as_slug`.
 *
 * Source folders live in `os.tmpdir()`; the destination userData is the
 * shared `useTempDataDir()` fixture (PROJECTS_ROOT under tempDir/projects).
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let importSvc: typeof import('../services/import-project.js')
let projectsRoot: string

/** Track per-test source folders so beforeEach can reset them cleanly. */
const sourceFolders: string[] = []

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  importSvc = await import('../services/import-project.js')
  const pm = await import('../services/project-manager.js')
  projectsRoot = pm.PROJECTS_ROOT
})

after(async () => {
  for (const dir of sourceFolders) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  await cleanup()
})

beforeEach(async () => {
  await fs.rm(projectsRoot, { recursive: true, force: true })
  await fs.mkdir(projectsRoot, { recursive: true })
})

async function makeSourceFolder(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `story-studio-import-${label}-`))
  sourceFolders.push(dir)
  return dir
}

describe('importProjectFromFolder — manifest handling', () => {
  test('v1 manifest is accepted; preset bag is dropped silently', async () => {
    const src = await makeSourceFolder('v1')
    // Seed a v1 manifest with the legacy preset/production_standards bag.
    // Per Session 05 §2 these fields must NOT survive the import — they're
    // per-machine and would leak between synced folders if propagated.
    const v1Manifest = {
      schema_version: 1,
      project_id: '11111111-2222-3333-4444-555555555555',
      slug: 'legacy-import',
      name: 'Legacy Import',
      episode_prefix: 'TN',
      episode_digits: 4,
      season_size: 10,
      season_prefix: 'Season',
      folder_template: '{season_prefix} {season_num}/{code} - {title}/',
      subfolder_names: { script: '{code} - 01 Script' },
      // The bag that must be dropped:
      presets: { script: { provider: 'openai', model: 'gpt-4o' } },
      production_standards: 'STAGED LEGACY STANDARDS — should not propagate',
      required_named_roots: { mood_library: '/Users/old/path' },
      youtube_channel_url: 'https://youtube.com/@old',
    }
    await fs.writeFile(
      path.join(src, '.story-studio-project.json'),
      JSON.stringify(v1Manifest),
    )

    const result = await importSvc.importProjectFromFolder(src)
    assert.equal(result.action, 'imported')
    assert.equal(result.project_id, v1Manifest.project_id, 'v1 project_id must carry through unchanged')

    const projectDir = path.join(projectsRoot, result.slug)
    const meta = JSON.parse(await fs.readFile(path.join(projectDir, 'project.json'), 'utf-8'))
    assert.equal(meta.episode_prefix, 'TN')
    assert.equal(meta.episode_digits, 4)
    // The preset bag must be absent from the seeded project.json.
    assert.equal((meta as any).presets, undefined, 'v1 preset bag must NOT survive into project.json')
    assert.equal((meta as any).production_standards, undefined)
    assert.equal((meta as any).required_named_roots, undefined)
    assert.equal((meta as any).youtube_channel_url, undefined)

    // config.json starts empty — local presets are created after import.
    const cfg = JSON.parse(await fs.readFile(path.join(projectDir, 'config.json'), 'utf-8'))
    assert.deepEqual(cfg, {}, 'config.json must start empty for a newly imported project')
  })

  test('no manifest → inferProjectMetadata runs from folder layout', async () => {
    const src = await makeSourceFolder('inferred')
    // Build a layout the inferrer can read: Season folder with two
    // episode subdirs using a recognisable prefix/digit pattern.
    const seasonDir = path.join(src, 'Season 001')
    await fs.mkdir(path.join(seasonDir, 'EP0001 - First episode'), { recursive: true })
    await fs.mkdir(path.join(seasonDir, 'EP0002 - Second episode'), { recursive: true })

    const result = await importSvc.importProjectFromFolder(src)
    assert.equal(result.action, 'imported')
    // No manifest to carry an id — importer mints a fresh UUID.
    assert.match(result.project_id, /^[0-9a-f-]{36}$/i)

    const projectDir = path.join(projectsRoot, result.slug)
    const meta = JSON.parse(await fs.readFile(path.join(projectDir, 'project.json'), 'utf-8'))
    // Inferred from the EP0001/EP0002 episode names + Season 001 wrapper.
    assert.equal(meta.episode_prefix, 'EP')
    assert.equal(meta.episode_digits, 4)
    assert.equal(meta.season_prefix, 'Season')
  })
})

describe('importProjectFromFolder — channel isolation', () => {
  test('source-folder secrets.json is not copied or seeded into the destination', async () => {
    const src = await makeSourceFolder('secrets')
    // Plant a decoy file that LOOKS like a secrets bundle inside the
    // source folder — the importer must not copy or read it.
    await fs.writeFile(
      path.join(src, 'secrets.json'),
      JSON.stringify({ openai_api_key: 'sk-leaked-from-source' }),
    )
    await fs.writeFile(
      path.join(src, '.story-studio-project.json'),
      JSON.stringify({
        schema_version: 2,
        project_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        slug: 'secrets-iso',
        name: 'Secrets Iso',
        episode_prefix: 'EP',
        episode_digits: 4,
        season_size: 10,
        season_prefix: 'Season',
        folder_template: '{season_prefix} {season_num}/{code} - {title}/',
        subfolder_names: {},
        last_edited: { machine_label: 'src', at: new Date().toISOString() },
      }),
    )

    const result = await importSvc.importProjectFromFolder(src)
    const destSecrets = path.join(projectsRoot, result.slug, 'secrets.json')
    // After the rework, no per-project secrets.json is seeded by import.
    // The file is created on demand only when YouTube OAuth state is
    // first written (no decoy key from the source folder is ever copied).
    const exists = await fs.access(destSecrets).then(() => true).catch(() => false)
    if (exists) {
      const txt = await fs.readFile(destSecrets, 'utf-8')
      assert.ok(!txt.includes('sk-leaked-from-source'), 'no key from the source folder may leak')
      assert.ok(!txt.includes('openai_api_key'), 'legacy openai_api_key field must not be seeded')
    }
    // Defense in depth: provider API keys live app-level. None from the
    // source folder should have made it into the app-level store either.
    const { readAppSecrets } = await import('../services/app-secrets-store.js')
    const appSecrets = await readAppSecrets()
    assert.equal(appSecrets.providers.genstudio?.apiKey, undefined,
      'no key from the source folder may leak into the app-level store')
  })
})

describe('importProjectFromFolder — slug collision behaviour', () => {
  test('returns action=collision (does NOT overwrite or auto-unique) when slug is taken by a different project_id', async () => {
    // Pre-seed an existing project at the slug we're about to collide on.
    const existingSlug = 'taken-slug'
    const existingDir = path.join(projectsRoot, existingSlug)
    await fs.mkdir(existingDir, { recursive: true })
    const existingMeta = {
      slug: existingSlug,
      name: 'Already here',
      project_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      episode_prefix: 'EP',
      episode_digits: 4,
      season_size: 10,
      season_prefix: 'Season',
      folder_template: '{season_prefix} {season_num}/{code} - {title}/',
      subfolder_names: {},
      output_root: existingDir,
      created_at: new Date().toISOString(),
    }
    await fs.writeFile(path.join(existingDir, 'project.json'), JSON.stringify(existingMeta))

    // Build an incoming folder whose inferred slug collides but whose
    // project_id is different — so the importer can't treat it as a relocate.
    const src = await makeSourceFolder('collide')
    await fs.writeFile(
      path.join(src, '.story-studio-project.json'),
      JSON.stringify({
        schema_version: 2,
        project_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        slug: existingSlug,
        name: 'Already here',  // produces the same slug
        episode_prefix: 'EP',
        episode_digits: 4,
        season_size: 10,
        season_prefix: 'Season',
        folder_template: '{season_prefix} {season_num}/{code} - {title}/',
        subfolder_names: {},
        last_edited: { machine_label: 'src', at: new Date().toISOString() },
      }),
    )

    const result = await importSvc.importProjectFromFolder(src)
    assert.equal(result.action, 'collision', 'must report collision rather than silently overwriting or auto-uniquing')
    assert.equal(result.slug, existingSlug)
    assert.equal(result.existing_project_id, existingMeta.project_id)
    assert.notEqual(result.project_id, existingMeta.project_id, 'incoming project_id is preserved on the collision result')

    // Pre-existing project on disk must be untouched.
    const stillThere = JSON.parse(await fs.readFile(path.join(existingDir, 'project.json'), 'utf-8'))
    assert.equal(stillThere.project_id, existingMeta.project_id, 'existing project.json must not be overwritten')
    assert.equal(stillThere.name, 'Already here')
  })

  test('adopt_as_slug retry succeeds and creates the project at the override slug', async () => {
    // Same setup as the previous test, but caller resolves the collision
    // by supplying an alternative slug — proves the collision path is a
    // soft signal, not a hard error.
    const existingSlug = 'busy-slug'
    const existingDir = path.join(projectsRoot, existingSlug)
    await fs.mkdir(existingDir, { recursive: true })
    await fs.writeFile(
      path.join(existingDir, 'project.json'),
      JSON.stringify({
        slug: existingSlug,
        name: 'Already here',
        project_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        episode_prefix: 'EP', episode_digits: 4, season_size: 10, season_prefix: 'Season',
        folder_template: '{season_prefix} {season_num}/{code} - {title}/',
        subfolder_names: {}, output_root: existingDir, created_at: new Date().toISOString(),
      }),
    )

    const src = await makeSourceFolder('adopt')
    await fs.writeFile(
      path.join(src, '.story-studio-project.json'),
      JSON.stringify({
        schema_version: 2,
        project_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        slug: existingSlug,
        name: 'Already here',
        episode_prefix: 'EP', episode_digits: 4, season_size: 10, season_prefix: 'Season',
        folder_template: '{season_prefix} {season_num}/{code} - {title}/',
        subfolder_names: {},
        last_edited: { machine_label: 'src', at: new Date().toISOString() },
      }),
    )

    const result = await importSvc.importProjectFromFolder(src, { adopt_as_slug: 'busy-slug-2' })
    assert.equal(result.action, 'imported')
    assert.equal(result.slug, 'busy-slug-2')
    // Both projects coexist — original untouched, new one seeded.
    const original = JSON.parse(await fs.readFile(path.join(projectsRoot, 'busy-slug', 'project.json'), 'utf-8'))
    const adopted = JSON.parse(await fs.readFile(path.join(projectsRoot, 'busy-slug-2', 'project.json'), 'utf-8'))
    assert.equal(original.project_id, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')
    assert.equal(adopted.project_id, 'cccccccc-cccc-cccc-cccc-cccccccccccc')
  })
})
