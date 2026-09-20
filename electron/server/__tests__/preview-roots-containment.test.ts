/**
 * Preview containment — the owner's decision, 2026-09-19.
 *
 * Four routes served a file named by `?path=` and one read a `source_path` from
 * a request body, passing it to `resolveAssetPath` — which returns a plain
 * absolute path UNCHANGED — and then checking only the file extension. Any file
 * on the machine with a matching extension could be streamed back, and
 * `thumbnail-reference/analyze` would upload it to GenStudio. The in-code
 * comment justifying this was "this backend binds localhost, so the risk surface
 * is the UI itself", which is false in server mode (it binds 0.0.0.0) and
 * desktop mode has no auth while a cross-site fetch to 127.0.0.1 passes the Host
 * guard.
 *
 * The rule: a preview may read the Library, or a folder the owner deliberately
 * configured as a media location. Nothing else. A file picked from elsewhere by
 * native dialog is no longer previewable — that is the accepted cost.
 *
 * The symlink case is the one worth pinning: a purely lexical check would pass a
 * link planted INSIDE an allowed root that points outside it.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let roots: typeof import('../lib/preview-roots.js')
let pm: typeof import('../services/project-manager.js')
let outsideDir = ''

const SLUG = 'preview-roots-project'

before(async () => {
  tmp = await useTempDataDir()
  roots = await import('../lib/preview-roots.js')
  pm = await import('../services/project-manager.js')
  await pm.createProject({ name: 'Preview Roots Project' })

  // Deliberately OUTSIDE the temp data dir — i.e. outside the Library.
  outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-outside-'))
  await fs.writeFile(path.join(outsideDir, 'private.mp3'), 'not yours')
  await fs.writeFile(path.join(outsideDir, 'private.png'), 'not yours either')
})

after(async () => {
  await tmp?.cleanup()
  if (outsideDir) await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => {})
})

describe('a preview may read the Library', () => {
  test('a file inside the Library is allowed', async () => {
    const inside = path.join(tmp.dir, 'projects', SLUG, 'music', 'track.mp3')
    await fs.mkdir(path.dirname(inside), { recursive: true })
    await fs.writeFile(inside, 'a real track')
    assert.equal(await roots.isPreviewablePath(inside, SLUG), true)
  })

  test('a file inside the project tree is allowed', async () => {
    const inside = path.join(tmp.dir, 'projects', SLUG, 'project.json')
    assert.equal(await roots.isPreviewablePath(inside, SLUG), true)
  })

  test('an unresolvable pool does not hide a later healthy pool', async () => {
    const pools = await import('../services/broll-pool-manager.js')
    const badPool = path.join(outsideDir, 'bad-pool')
    const validPool = path.join(outsideDir, 'valid-pool')
    await fs.mkdir(badPool)
    await pools.createPool({ name: 'Bad Preview Pool', folder_path: badPool })
    await fs.rm(badPool, { recursive: true })
    await fs.symlink(path.join(outsideDir, 'not-mounted-pool'), badPool)

    await fs.mkdir(validPool)
    await pools.createPool({ name: 'Valid Preview Pool', folder_path: validPool })
    const validFile = path.join(validPool, 'clip.mp4')
    await fs.writeFile(validFile, 'healthy pool clip')

    assert.equal(await roots.isPreviewablePath(validFile, SLUG), true)
  })
})

describe('a preview may not read outside it', () => {
  test('a file outside the Library is refused', async () => {
    assert.equal(await roots.isPreviewablePath(path.join(outsideDir, 'private.mp3'), SLUG), false)
    assert.equal(await roots.isPreviewablePath(path.join(outsideDir, 'private.png'), SLUG), false)
  })

  test('a system path is refused', async () => {
    assert.equal(await roots.isPreviewablePath('/etc/hosts', SLUG), false)
    assert.equal(await roots.isPreviewablePath('/Users', SLUG), false)
  })

  test('traversal out of the Library is refused', async () => {
    const escape = path.join(tmp.dir, 'projects', SLUG, '..', '..', '..', '..', 'etc', 'hosts')
    assert.equal(await roots.isPreviewablePath(escape, SLUG), false)
  })

  test('a SYMLINK inside the Library pointing out is refused', async () => {
    // The case a lexical string compare gets wrong: the link itself sits in an
    // allowed root, and only `realpath` reveals where it actually leads.
    const link = path.join(tmp.dir, 'projects', SLUG, 'sneaky.mp3')
    await fs.symlink(path.join(outsideDir, 'private.mp3'), link)
    assert.equal(await roots.isPreviewablePath(link, SLUG), false)
  })

  test('a dangling symlink inside the Library pointing out is refused', async () => {
    const link = path.join(tmp.dir, 'projects', SLUG, 'dangling')
    await fs.symlink(path.join(outsideDir, 'not-mounted'), link)

    assert.equal(await roots.isPreviewablePath(path.join(link, 'private.mp3'), SLUG), false)
  })

  test('an empty or non-string path is refused rather than throwing', async () => {
    assert.equal(await roots.isPreviewablePath('', SLUG), false)
    assert.equal(await roots.isPreviewablePath(undefined as unknown as string, SLUG), false)
  })

  test('the allowed roots include the Library and never the whole filesystem', async () => {
    const allowed = await roots.allowedPreviewRoots(SLUG)
    assert.ok(allowed.length >= 1, 'the Library must be an allowed root')
    for (const root of allowed) {
      assert.notEqual(root, path.sep, 'the filesystem root must never be allowed')
      assert.notEqual(root, path.resolve(os.homedir()), 'the home directory must never be allowed')
    }
  })
})
