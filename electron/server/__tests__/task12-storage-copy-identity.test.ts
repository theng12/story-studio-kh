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

test('media migration keeps a same-size different-byte source instead of treating it as copied', async () => {
  // Break caught: the generic media branch compares only byte length before
  // deleting the source. A stale destination with equal length therefore wins.
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  const pm = await import('../services/project-manager.js')
  const im = await import('../services/idea-manager.js')
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { migrateMediaToExternal } = await import('../services/storage-audit.js')

  const project = await pm.createProject({ name: 'Task 12 media identity' })
  const [idea] = await im.addIdeas(project.slug, [{
    title: 'Same Size Is Not Identity', logline: '', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: '',
  }], 'task12-test')
  const accepted = await im.acceptIdea(project.slug, idea!.id, false, { override_code: 'EP0001' })
  const sourcePaths = await resolveEpisodePaths(project.slug, 'EP0001', accepted.idea.title)
  await fs.mkdir(sourcePaths.audio_dir, { recursive: true })
  const filename = 'EP0001_Chapter01.wav'
  const source = path.join(sourcePaths.audio_dir, filename)
  const sourceBytes = Buffer.from('source-audio-bytes')
  const destinationBytes = Buffer.from('stale-audio--bytes')
  assert.equal(sourceBytes.byteLength, destinationBytes.byteLength, 'fixture must collide by size')
  await fs.writeFile(source, sourceBytes)

  const mediaRoot = path.join(temporary.dir, 'external-media')
  const projectPath = path.join(pm.projectsRoot(), project.slug, 'project.json')
  const projectJson = JSON.parse(await fs.readFile(projectPath, 'utf8'))
  await fs.writeFile(projectPath, JSON.stringify({ ...projectJson, media_root: mediaRoot }))
  const destinationPaths = await resolveEpisodePaths(project.slug, 'EP0001', accepted.idea.title)
  const destination = path.join(destinationPaths.audio_dir, filename)
  await fs.mkdir(destinationPaths.audio_dir, { recursive: true })
  await fs.writeFile(destination, destinationBytes)

  const result = await migrateMediaToExternal(project.slug)

  assert.deepEqual(await fs.readFile(source), sourceBytes, 'unproven source bytes must remain')
  assert.deepEqual(await fs.readFile(destination), destinationBytes, 'an existing destination is never overwritten')
  assert.equal(result.files_moved, 0)
  assert.match(result.errors[0]?.reason || '', /different|match|checksum|identity/i)
})

for (const mutation of ['rewrite', 'replace'] as const) {
test(`media migration keeps a source changed by ${mutation} after copying`, async () => {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  const pm = await import('../services/project-manager.js')
  const im = await import('../services/idea-manager.js')
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { migrateMediaToExternal } = await import('../services/storage-audit.js')

  const project = await pm.createProject({ name: 'Task 12 source rewrite' })
  const [idea] = await im.addIdeas(project.slug, [{
    title: 'Rewrite During Copy', logline: '', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: '',
  }], 'task12-test')
  const accepted = await im.acceptIdea(project.slug, idea!.id, false, { override_code: 'EP0001' })
  const sourcePaths = await resolveEpisodePaths(project.slug, 'EP0001', accepted.idea.title)
  await fs.mkdir(sourcePaths.audio_dir, { recursive: true })
  const filename = 'EP0001_Chapter01.wav'
  const source = path.join(sourcePaths.audio_dir, filename)
  const copiedBytes = Buffer.from('source-audio-bytes')
  const replacementBytes = mutation === 'replace' ? copiedBytes : Buffer.from('new---audio--bytes')
  assert.equal(copiedBytes.byteLength, replacementBytes.byteLength)
  await fs.writeFile(source, copiedBytes)

  const mediaRoot = path.join(temporary.dir, 'external-media')
  const projectPath = path.join(pm.projectsRoot(), project.slug, 'project.json')
  const projectJson = JSON.parse(await fs.readFile(projectPath, 'utf8'))
  await fs.writeFile(projectPath, JSON.stringify({ ...projectJson, media_root: mediaRoot }))
  const destinationPaths = await resolveEpisodePaths(project.slug, 'EP0001', accepted.idea.title)
  const destination = path.join(destinationPaths.audio_dir, filename)

  const realCopy = fs.copyFile
  let mutationApplied = false
  fs.copyFile = async (...args: Parameters<typeof fs.copyFile>) => {
    await realCopy(...args)
    if (String(args[0]) !== source) return
    if (mutation === 'replace') {
      const replacement = path.join(sourcePaths.audio_dir, 'replacement.wav')
      await fs.writeFile(replacement, replacementBytes)
      await fs.rename(replacement, source)
    } else {
      await fs.writeFile(source, replacementBytes)
    }
    mutationApplied = true
  }
  let result: Awaited<ReturnType<typeof migrateMediaToExternal>>
  try {
    result = await migrateMediaToExternal(project.slug)
  } finally {
    fs.copyFile = realCopy
  }

  assert.equal(mutationApplied, true, 'the fixture must exercise a change after the copy')
  assert.deepEqual(await fs.readFile(source), replacementBytes, 'the rewritten source remains authoritative')
  assert.deepEqual(await fs.readFile(destination), copiedBytes, 'the verified copy is retained for review')
  assert.equal(result.files_moved, 0)
  assert.match(result.errors[0]?.reason || '', /changed during migration/i)
})
}

test('media migration rechecks both leaves after its final directory-chain check', async () => {
  // Break caught: both open leaves can change after their current final
  // identity checks while the helper performs its directory-chain walks. A
  // path-based source delete must not proceed on that stale proof.
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  const pm = await import('../services/project-manager.js')
  const im = await import('../services/idea-manager.js')
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { migrateMediaToExternal } = await import('../services/storage-audit.js')

  const project = await pm.createProject({ name: 'Task 12 late leaf identity' })
  const [idea] = await im.addIdeas(project.slug, [{
    title: 'Proof Must Stay Current', logline: '', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: '',
  }], 'task12-test')
  const accepted = await im.acceptIdea(project.slug, idea!.id, false, { override_code: 'EP0001' })
  const sourcePaths = await resolveEpisodePaths(project.slug, 'EP0001', accepted.idea.title)
  await fs.mkdir(sourcePaths.audio_dir, { recursive: true })
  const filename = 'EP0001_Chapter01.wav'
  const source = path.join(sourcePaths.audio_dir, filename)
  const originalBytes = Buffer.from('original-audio-bytes')
  const lateBytes = Buffer.from('late-new-audio-bytes')
  assert.equal(originalBytes.byteLength, lateBytes.byteLength)
  await fs.writeFile(source, originalBytes)

  const mediaRoot = path.join(temporary.dir, 'external-media')
  const projectPath = path.join(pm.projectsRoot(), project.slug, 'project.json')
  const projectJson = JSON.parse(await fs.readFile(projectPath, 'utf8'))
  await fs.writeFile(projectPath, JSON.stringify({ ...projectJson, media_root: mediaRoot }))
  const destinationPaths = await resolveEpisodePaths(project.slug, 'EP0001', accepted.idea.title)
  const destination = path.join(destinationPaths.audio_dir, filename)
  // snapshotMigrationDirectoryChain() canonicalizes the trusted root before
  // walking descendants. On macOS a fixture rooted at /tmp is therefore seen
  // by the injected lstat seam under /private/tmp.
  const canonicalTemporary = await fs.realpath(temporary.dir)
  const canonicalDestinationDir = path.resolve(
    canonicalTemporary,
    path.relative(path.resolve(temporary.dir), path.resolve(destinationPaths.audio_dir)),
  )
  const destinationLeafPaths = new Set([
    path.resolve(destination),
    path.join(canonicalDestinationDir, filename),
  ])
  const destinationDirectoryPaths = new Set([
    path.resolve(destinationPaths.audio_dir),
    canonicalDestinationDir,
  ])

  const realLstat = fs.lstat
  let destinationLeafChecks = 0
  let mutationApplied = false
  fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
    const candidate = path.resolve(String(args[0]))
    if (destinationLeafPaths.has(candidate)) destinationLeafChecks++
    if (!mutationApplied
      && destinationLeafChecks >= 3
      && destinationDirectoryPaths.has(candidate)) {
      await Promise.all([
        fs.writeFile(source, lateBytes),
        fs.writeFile(destination, lateBytes),
      ])
      mutationApplied = true
    }
    return realLstat(...args)
  }) as typeof fs.lstat
  let result: Awaited<ReturnType<typeof migrateMediaToExternal>>
  try {
    result = await migrateMediaToExternal(project.slug)
  } finally {
    fs.lstat = realLstat
  }

  assert.equal(mutationApplied, true, 'the fixture must mutate both leaves after their current final proof')
  const retainedSource = await fs.readFile(source).catch(() => null)
  assert.deepEqual(retainedSource, lateBytes, 'late authoritative source bytes must not be removed on stale proof')
  assert.deepEqual(await fs.readFile(destination), lateBytes, 'the changed destination remains available for review')
  assert.equal(result.files_moved, 0)
  assert.match(result.errors[0]?.reason || '', /changed during migration/i)
})
