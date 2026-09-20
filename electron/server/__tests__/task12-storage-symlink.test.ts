import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

interface MigrationFixture {
  sourceDir: string
  source: string
  destinationDir: string
  destination: string
  sourceBytes: Buffer
  migrate: () => Promise<{ files_moved: number; errors: Array<{ reason: string }> }>
}

async function seedMigration(
  filename: string,
  field: 'audio_dir' | 'video_dir',
  mediaRootFor = (tempDir: string): string => path.join(tempDir, 'external-media'),
): Promise<MigrationFixture> {
  const temporary = await useTempDataDir()
  const previousCleanup = cleanup
  cleanup = async () => {
    await temporary.cleanup()
    await previousCleanup?.()
  }
  const pm = await import('../services/project-manager.js')
  const im = await import('../services/idea-manager.js')
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { migrateMediaToExternal } = await import('../services/storage-audit.js')

  const project = await pm.createProject({ name: 'Task 12 storage symlinks' })
  const [idea] = await im.addIdeas(project.slug, [{
    title: 'Links Are Not Copies', logline: '', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: '',
  }], 'task12-test')
  const accepted = await im.acceptIdea(project.slug, idea!.id, false, { override_code: 'EP0001' })
  const sourcePaths = await resolveEpisodePaths(project.slug, 'EP0001', accepted.idea.title)
  const sourceDir = sourcePaths[field]
  const source = path.join(sourceDir, filename)
  const sourceBytes = Buffer.from(`authoritative-${field}-bytes`)
  await fs.mkdir(sourceDir, { recursive: true })
  await fs.writeFile(source, sourceBytes)

  const projectPath = path.join(pm.projectsRoot(), project.slug, 'project.json')
  const projectJson = JSON.parse(await fs.readFile(projectPath, 'utf8'))
  await fs.writeFile(projectPath, JSON.stringify({
    ...projectJson,
    media_root: mediaRootFor(temporary.dir),
  }))
  const destinationPaths = await resolveEpisodePaths(project.slug, 'EP0001', accepted.idea.title)
  const destinationDir = destinationPaths[field]
  const destination = path.join(destinationDir, filename)

  return {
    sourceDir,
    source,
    destinationDir,
    destination,
    sourceBytes,
    migrate: () => migrateMediaToExternal(project.slug),
  }
}

function assertRejectedLink(result: Awaited<ReturnType<MigrationFixture['migrate']>>): void {
  assert.equal(result.files_moved, 0)
  assert.match(result.errors.map(error => error.reason).join('\n'), /symbolic|link|unsafe/i)
}

for (const branch of ['generic', 'final'] as const) {
  test(`${branch} migration rejects a destination leaf symlink to its source`, async () => {
    // A destination symlink is not a second copy. Following it makes the hash
    // check pass against the source itself, after which deleting the source
    // leaves only a dangling link.
    const filename = branch === 'final' ? 'EP0001_final_video.mp4' : 'EP0001_Chapter01.wav'
    const field = branch === 'final' ? 'video_dir' : 'audio_dir'
    const fixture = await seedMigration(filename, field)
    await fs.mkdir(fixture.destinationDir, { recursive: true })
    await fs.symlink(fixture.source, fixture.destination)

    const result = await fixture.migrate()

    assert.deepEqual(await fs.readFile(fixture.source), fixture.sourceBytes, 'the only real copy must remain')
    assert.equal((await fs.lstat(fixture.destination)).isSymbolicLink(), true, 'the existing destination is untouched')
    assertRejectedLink(result)
  })
}

test('migration rejects a symlinked source directory chain', async () => {
  const fixture = await seedMigration('EP0001_Chapter01.wav', 'audio_dir')
  const linkedSourceDir = path.join(path.dirname(fixture.sourceDir), 'linked-source-audio')
  const linkedSource = path.join(linkedSourceDir, path.basename(fixture.source))
  await fs.rm(fixture.sourceDir, { recursive: true, force: true })
  await fs.mkdir(linkedSourceDir, { recursive: true })
  await fs.writeFile(linkedSource, fixture.sourceBytes)
  await fs.symlink(linkedSourceDir, fixture.sourceDir, 'dir')

  const result = await fixture.migrate()

  assert.deepEqual(await fs.readFile(linkedSource), fixture.sourceBytes, 'a file reached through a source link must not be deleted')
  await assert.rejects(fs.lstat(fixture.destination), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
  assertRejectedLink(result)
})

test('migration rejects a symlinked destination directory chain', async () => {
  const fixture = await seedMigration('EP0001_Chapter01.wav', 'audio_dir')
  const linkedDestinationDir = path.join(path.dirname(path.dirname(fixture.destinationDir)), 'linked-destination-audio')
  const linkedDestination = path.join(linkedDestinationDir, path.basename(fixture.destination))
  await fs.mkdir(path.dirname(fixture.destinationDir), { recursive: true })
  await fs.mkdir(linkedDestinationDir, { recursive: true })
  await fs.symlink(linkedDestinationDir, fixture.destinationDir, 'dir')

  const result = await fixture.migrate()

  assert.deepEqual(await fs.readFile(fixture.source), fixture.sourceBytes, 'the source must remain until a private destination is proven')
  await assert.rejects(fs.lstat(linkedDestination), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
  assertRejectedLink(result)
})

test('migration keeps the source when destination sync fails', async () => {
  const fixture = await seedMigration('EP0001_Chapter01.wav', 'audio_dir')
  const realOpen = fs.open
  let syncAttempted = false
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args)
    if (path.resolve(String(args[0])) === path.resolve(fixture.destination)) {
      handle.sync = async () => {
        syncAttempted = true
        throw new Error('injected destination sync failure')
      }
    }
    return handle
  }
  let result: Awaited<ReturnType<MigrationFixture['migrate']>>
  try {
    result = await fixture.migrate()
  } finally {
    fs.open = realOpen
  }

  assert.equal(syncAttempted, true, 'the destination must be flushed before source removal')
  assert.deepEqual(await fs.readFile(fixture.source), fixture.sourceBytes)
  assert.deepEqual(await fs.readFile(fixture.destination), fixture.sourceBytes, 'the verified copy is retained for retry')
  assert.equal(result.files_moved, 0)
  assert.match(result.errors.map(error => error.reason).join('\n'), /destination sync failure/i)
})

test('migration keeps the source when destination directory sync fails', async t => {
  if (process.platform === 'win32') {
    t.skip('Windows has no destination-directory fsync contract')
    return
  }
  const fixture = await seedMigration('EP0001_Chapter01.wav', 'audio_dir')
  const realOpen = fs.open
  let directorySyncAttempted = false
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args)
    if (path.resolve(String(args[0])) === path.resolve(fixture.destinationDir)) {
      handle.sync = async () => {
        directorySyncAttempted = true
        throw new Error('injected destination directory sync failure')
      }
    }
    return handle
  }
  let result: Awaited<ReturnType<MigrationFixture['migrate']>>
  try {
    result = await fixture.migrate()
  } finally {
    fs.open = realOpen
  }

  assert.equal(directorySyncAttempted, true, 'the destination directory entry must be flushed before source removal')
  assert.deepEqual(await fs.readFile(fixture.source).catch(() => null), fixture.sourceBytes)
  assert.deepEqual(await fs.readFile(fixture.destination), fixture.sourceBytes, 'the copied destination is retained for retry')
  assert.equal(result.files_moved, 0)
  assert.match(result.errors.map(error => error.reason).join('\n'), /destination directory sync failure/i)
})

test('migration allows the macOS /var alias of the canonical /private/var platform root', async t => {
  if (process.platform !== 'darwin') {
    t.skip('the /var -> /private/var alias is macOS-specific')
    return
  }
  const harnessRoot = process.env.STORY_STUDIO_TEST_HARNESS_ROOT
  if (!harnessRoot) {
    t.skip('the backend harness did not publish its disposable root')
    return
  }
  const canonicalHarnessRoot = await fs.realpath(harnessRoot)
  let aliasRoot = ''
  const fixture = await seedMigration(
    'EP0001_Chapter01.wav',
    'audio_dir',
    tempDir => {
      const resolved = path.resolve(tempDir)
      aliasRoot = resolved.startsWith('/private/var/')
        ? resolved.slice('/private'.length)
        : resolved.startsWith('/var/')
          ? resolved
          : ''
      return path.join(aliasRoot || resolved, 'external-media-alias')
    },
  )
  if (!aliasRoot) {
    t.skip('the harness disposable root is not under the macOS /var alias')
    return
  }
  const canonicalAliasRoot = await fs.realpath(aliasRoot)
  const relativeToHarness = path.relative(canonicalHarnessRoot, canonicalAliasRoot)
  if (relativeToHarness === '..' || relativeToHarness.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToHarness)) {
    throw new Error('the /var alias fixture escaped the backend harness root')
  }

  const result = await fixture.migrate()

  assert.deepEqual(await fs.readFile(fixture.destination), fixture.sourceBytes)
  await assert.rejects(fs.lstat(fixture.source), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
  assert.equal(result.files_moved, 1)
  assert.deepEqual(result.errors, [])
})
