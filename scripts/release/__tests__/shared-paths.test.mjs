/**
 * A test lane must be unable to write into the owner's trash.
 *
 * The lane ran its children with a sandbox HOME but forced STORY_STUDIO_TRASH_DIR to the real
 * `~/Desktop/_trash/story-studio-kh`, so an install test put a replaced bundle there. The guard below
 * is the boundary, not the assertion that noticed afterwards: it refuses a trash path under the
 * owner's Desktop, the Mac's Trash or the checkout, before any child starts and before anything is
 * copied.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertSandboxedTrash, sandboxTrashRoot } from '../../shared-paths.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

test("a lane's trash may not resolve into the owner's Desktop, the Mac's Trash, or the checkout", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'story-trash-guard-'))
  try {
    const forbidden = [
      path.join(os.homedir(), 'Desktop', '_trash', 'story-studio-kh'),
      path.join(os.homedir(), '.Trash', 'story-studio-kh'),
      path.join(ROOT, '_trash', 'app'),
    ]
    for (const target of forbidden) {
      assert.throws(
        () => assertSandboxedTrash(target, { sandbox, checkout: ROOT }),
        /A test lane must never use the owner's trash/,
        target,
      )
    }
    // Nothing was created anywhere: the refusal happens before a child runs.
    assert.deepEqual(fs.readdirSync(sandbox), [], 'the guard must refuse before copying anything')
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('a lane trash outside the sandbox is refused too, and the lane default is inside it', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'story-trash-guard-'))
  try {
    // The checkout's own parent, not os.tmpdir(): the gate relocates TMPDIR *inside* the checkout, where
    // the checkout rule fires first — correctly refusing, but before this assertion sees the sandbox branch.
    assert.throws(
      () => assertSandboxedTrash(path.join(path.dirname(ROOT), 'somewhere-else'), { sandbox, checkout: ROOT }),
      /must live inside its sandbox/,
    )
    const laneDefault = sandboxTrashRoot(sandbox)
    assert.equal(laneDefault, path.join(sandbox, 'home', 'Desktop', '_trash', 'story-studio-kh'))
    assert.equal(assertSandboxedTrash(laneDefault, { sandbox, checkout: ROOT }), laneDefault)

    // The gate relocates TMPDIR under the checkout, so the lane's sandbox lands inside it. Its own trash
    // must still be handed out: the checkout rule is about the owner's trash, not ephemeral lane output.
    // Named, never created — the guard is path arithmetic, and the lane forbids writing into the checkout.
    const relocatedSandbox = path.join(ROOT, '.test-work', 'relocated-sandbox')
    const relocatedTrash = sandboxTrashRoot(relocatedSandbox)
    assert.equal(assertSandboxedTrash(relocatedTrash, { sandbox: relocatedSandbox, checkout: ROOT }), relocatedTrash)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
