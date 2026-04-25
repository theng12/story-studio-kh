/**
 * Crash-consistency tests for `migrateDescriptionToMetadata`.
 *
 * The invariant under test: project.json and the on-disk folder layout
 * must never disagree across a crash. Our migration achieves this by
 * updating project.json FIRST (atomically), then renaming folders.
 *
 * Each test seeds a legacy layout (02 Description on disk, subfolder_names
 * still points at 'description'), then either runs the migration normally,
 * simulates a mid-rename crash by monkey-patching fs.rename, or simulates
 * a project.json-write failure. After each scenario we assert that
 * project.json and disk reflect a consistent, known state.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let fm: typeof import('../services/folder-migration.js')
let mig: typeof import('../services/migration.js')
let projectsRoot: string

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  // Import after env var is set so PROJECTS_ROOT resolves under tempDir.
  fm = await import('../services/folder-migration.js')
  mig = await import('../services/migration.js')
  const pm = await import('../services/project-manager.js')
  projectsRoot = pm.PROJECTS_ROOT
})

after(async () => { await cleanup() })

beforeEach(async () => {
  // Reset filesystem state between tests. Also clear migrations.json so the
  // marker check doesn't short-circuit subsequent tests.
  await fs.rm(projectsRoot, { recursive: true, force: true })
  await fs.mkdir(projectsRoot, { recursive: true })
  await fs.rm(path.join(tempDir, 'migrations.json'), { force: true })
})

/**
 * Seed a project with N episodes, each containing a legacy "02 Description"
 * folder. project.json still points at 'description' in subfolder_names.
 * Uses an absolute output_root inside the project dir to keep the test
 * self-contained regardless of path-resolution rules.
 */
async function seedLegacyProject(slug: string, episodeCount: number): Promise<{
  projectDir: string
  metaPath: string
  episodesRoot: string
  episodeDirs: string[]
}> {
  const projectDir = path.join(projectsRoot, slug)
  const episodesRoot = path.join(projectDir, 'episodes')
  const seasonDir = path.join(episodesRoot, 'Season 01')
  await fs.mkdir(seasonDir, { recursive: true })

  const episodeDirs: string[] = []
  for (let i = 1; i <= episodeCount; i++) {
    const code = `TN${String(i).padStart(4, '0')}`
    const epDir = path.join(seasonDir, `${code} - Episode ${i}`)
    const descDir = path.join(epDir, `${code} - 02 Description`)
    await fs.mkdir(descDir, { recursive: true })
    episodeDirs.push(epDir)
  }

  const meta = {
    slug,
    name: slug,
    output_root: './episodes',
    subfolder_names: {
      description: '{code} - 02 Description',
      script: '{code} - 01 Script',
    },
  }
  const metaPath = path.join(projectDir, 'project.json')
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n')

  return { projectDir, metaPath, episodesRoot, episodeDirs }
}

async function readMeta(metaPath: string): Promise<any> {
  return JSON.parse(await fs.readFile(metaPath, 'utf-8'))
}

async function countFolders(parent: string, pattern: RegExp): Promise<number> {
  const entries = await fs.readdir(parent).catch(() => [] as string[])
  return entries.filter(e => pattern.test(e)).length
}

describe('migrateDescriptionToMetadata — happy path', () => {
  test('renames all episode folders and updates project.json in one pass', async () => {
    const { metaPath, episodesRoot } = await seedLegacyProject('alpha', 3)

    await fm.migrateDescriptionToMetadata()

    // project.json updated
    const meta = await readMeta(metaPath)
    assert.equal(meta.subfolder_names.metadata, '{code} - 02 Metadata')
    assert.equal(meta.subfolder_names.description, undefined)

    // Every episode's legacy folder is gone, new folder present.
    const seasonDir = path.join(episodesRoot, 'Season 01')
    const episodes = await fs.readdir(seasonDir)
    for (const ep of episodes) {
      const oldCount = await countFolders(path.join(seasonDir, ep), /02 Description$/)
      const newCount = await countFolders(path.join(seasonDir, ep), /02 Metadata$/)
      assert.equal(oldCount, 0, `${ep}: legacy folder should be gone`)
      assert.equal(newCount, 1, `${ep}: new folder should exist`)
    }

    // Marker set — next run is a no-op.
    assert.equal(await mig.isDescriptionToMetadataDone(), true)
  })

  test('second call is a no-op (marker short-circuits the scan)', async () => {
    await seedLegacyProject('beta', 2)
    await fm.migrateDescriptionToMetadata()
    assert.equal(await mig.isDescriptionToMetadataDone(), true)

    // Re-seed a legacy folder AFTER the marker is set. The migration should
    // skip the scan entirely, leaving the new legacy untouched — proving
    // the marker actually short-circuits.
    const { episodesRoot } = await seedLegacyProject('beta', 2)
    await fm.migrateDescriptionToMetadata()

    const seasonDir = path.join(episodesRoot, 'Season 01')
    const episodes = await fs.readdir(seasonDir)
    for (const ep of episodes) {
      const oldCount = await countFolders(path.join(seasonDir, ep), /02 Description$/)
      assert.equal(oldCount, 1, `${ep}: marker should prevent re-scan`)
    }
  })
})

describe('migrateDescriptionToMetadata — crash mid-rename', () => {
  test('project.json is already updated; remaining legacy folders are renamed on retry', async () => {
    const { metaPath, episodesRoot } = await seedLegacyProject('gamma', 4)

    // Monkey-patch fs.rename to throw partway through — simulating a
    // crash mid-batch. `writeJsonAtomic` uses rename internally (tmp →
    // project.json), so we filter by destination pattern instead of by
    // call count: let the atomic project.json write through, let the
    // first episode-folder rename succeed, then fail the rest.
    const origRename = fs.rename.bind(fs)
    let folderRenames = 0
    ;(fs as any).rename = async (src: string, dest: string) => {
      const isFolderRename = typeof dest === 'string' && /02 Metadata$/.test(dest)
      if (isFolderRename) {
        folderRenames++
        if (folderRenames > 1) throw new Error('simulated crash mid-rename')
      }
      return origRename(src, dest)
    }

    try {
      await fm.migrateDescriptionToMetadata()
    } finally {
      ;(fs as any).rename = origRename
    }

    // project.json was updated FIRST — that invariant holds even though
    // only one episode was renamed on disk.
    const meta = await readMeta(metaPath)
    assert.equal(meta.subfolder_names.metadata, '{code} - 02 Metadata')
    assert.equal(meta.subfolder_names.description, undefined)

    // Disk: some renamed, some still legacy. Consistent with the "crash
    // mid-batch" scenario. We don't pin the exact split because readdir
    // ordering isn't guaranteed, only the batch-partial invariant.
    const seasonDir = path.join(episodesRoot, 'Season 01')
    const episodes = await fs.readdir(seasonDir)
    let renamedCount = 0
    let legacyCount = 0
    for (const ep of episodes) {
      renamedCount += await countFolders(path.join(seasonDir, ep), /02 Metadata$/)
      legacyCount += await countFolders(path.join(seasonDir, ep), /02 Description$/)
    }
    assert.equal(renamedCount + legacyCount, 4, 'every episode accounted for')
    assert.ok(renamedCount >= 1, 'at least one episode renamed before crash')
    assert.ok(legacyCount >= 1, 'at least one episode still legacy after crash')

    // Marker NOT set — next boot must retry.
    assert.equal(await mig.isDescriptionToMetadataDone(), false)

    // Simulate the next boot: rename works again, migration finishes.
    await fm.migrateDescriptionToMetadata()

    for (const ep of episodes) {
      const oldCount = await countFolders(path.join(seasonDir, ep), /02 Description$/)
      const newCount = await countFolders(path.join(seasonDir, ep), /02 Metadata$/)
      assert.equal(oldCount, 0, `${ep}: legacy should be gone after retry`)
      assert.equal(newCount, 1, `${ep}: metadata folder present after retry`)
    }
    assert.equal(await mig.isDescriptionToMetadataDone(), true)
  })
})

describe('migrateDescriptionToMetadata — project.json write fails', () => {
  test('aborts before any folder renames; disk untouched', async () => {
    const { metaPath, episodesRoot } = await seedLegacyProject('delta', 2)

    // Break the atomic writer by denying directory writes. The simplest
    // portable sabotage is to monkey-patch fs.rename (used BOTH by
    // writeJsonAtomic to promote the tmp file AND by folder renames) with
    // a filter: fail when the destination looks like a project.json path,
    // succeed otherwise. This proves that when step 1 (project.json
    // update) fails, step 2 (folder renames) is entirely skipped.
    const origRename = fs.rename.bind(fs)
    ;(fs as any).rename = async (src: string, dest: string) => {
      if (typeof dest === 'string' && dest.endsWith('project.json')) {
        throw new Error('simulated project.json write failure')
      }
      return origRename(src, dest)
    }

    try {
      await fm.migrateDescriptionToMetadata()
    } finally {
      ;(fs as any).rename = origRename
    }

    // project.json untouched (still has the legacy 'description' key).
    const meta = await readMeta(metaPath)
    assert.equal(meta.subfolder_names.description, '{code} - 02 Description')
    assert.equal(meta.subfolder_names.metadata, undefined)

    // Disk untouched — every episode still has its legacy folder.
    const seasonDir = path.join(episodesRoot, 'Season 01')
    const episodes = await fs.readdir(seasonDir)
    for (const ep of episodes) {
      const oldCount = await countFolders(path.join(seasonDir, ep), /02 Description$/)
      const newCount = await countFolders(path.join(seasonDir, ep), /02 Metadata$/)
      assert.equal(oldCount, 1, `${ep}: legacy preserved when project.json write fails`)
      assert.equal(newCount, 0, `${ep}: no rename attempted when project.json write fails`)
    }

    // Marker NOT set.
    assert.equal(await mig.isDescriptionToMetadataDone(), false)
  })
})

describe('migrateDescriptionToMetadata — per-episode idempotency', () => {
  test('tolerates "new folder already exists, no legacy" (prior partial run)', async () => {
    // Seed a project where project.json already has 'metadata' (step 1
    // completed on a previous run) and on disk we have a mix: one episode
    // fully migrated (only 02 Metadata), one still legacy (only 02 Description).
    const slug = 'epsilon'
    const projectDir = path.join(projectsRoot, slug)
    const episodesRoot = path.join(projectDir, 'episodes')
    const seasonDir = path.join(episodesRoot, 'Season 01')
    await fs.mkdir(seasonDir, { recursive: true })

    const migratedEp = path.join(seasonDir, 'TN0001 - A')
    await fs.mkdir(path.join(migratedEp, 'TN0001 - 02 Metadata'), { recursive: true })

    const legacyEp = path.join(seasonDir, 'TN0002 - B')
    await fs.mkdir(path.join(legacyEp, 'TN0002 - 02 Description'), { recursive: true })

    const meta = {
      slug,
      name: slug,
      output_root: './episodes',
      subfolder_names: {
        metadata: '{code} - 02 Metadata',
        script: '{code} - 01 Script',
      },
    }
    const metaPath = path.join(projectDir, 'project.json')
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n')

    await fm.migrateDescriptionToMetadata()

    // Both episodes end in the migrated state.
    assert.equal(await countFolders(migratedEp, /02 Metadata$/), 1)
    assert.equal(await countFolders(migratedEp, /02 Description$/), 0)
    assert.equal(await countFolders(legacyEp, /02 Metadata$/), 1)
    assert.equal(await countFolders(legacyEp, /02 Description$/), 0)

    // Marker set — the whole run was clean.
    assert.equal(await mig.isDescriptionToMetadataDone(), true)
  })
})
