/**
 * DELETING a scene plan is a writer, and must take the same lock as the rest.
 *
 * v1.4.72 serialised every writer of `scene_plan.json` — twenty-four of them —
 * and missed this one, because a delete removes the document rather than
 * editing it and so reads like the single case that cannot lose an update.
 *
 * It is in fact the worst of them. `writeJsonAtomic` writes a temp file and
 * renames it, creating parent directories on the way and never checking whether
 * the target still exists. So a job that is holding the lock mid
 * read-modify-write RECREATES the file when it finishes. An unlocked `unlink`
 * lands in that gap: the user deletes the plan, the job completes a moment
 * later, and the plan is back — carrying only what that job knew about. The
 * user reloads and finds a document they deleted, with edits missing.
 *
 * This test reproduces exactly that interleaving against the real primitive:
 * a writer takes the lock and is held open, a delete is issued while it is
 * held, and the writer then finishes and writes. If the delete does not queue
 * behind the writer, the file exists at the end. It must not.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'

let dir: string
let planPath: string

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sskh-plan-delete-'))
  planPath = path.join(dir, 'scene_plan.json')
})

after(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** The delete exactly as routes/scene-plan.ts performs it. */
async function deletePlan(): Promise<void> {
  await withLock(planPath, async () => {
    try {
      await fs.unlink(planPath)
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e
    }
  })
}

async function exists(p: string): Promise<boolean> {
  return await fs.access(p).then(() => true, () => false)
}

test('a delete issued mid-write does not leave the plan resurrected', async () => {
  await writeJsonAtomic(planPath, { schema_version: 1, scenes: [{ id: 's1' }] })
  assert.equal(await exists(planPath), true, 'the plan starts on disk')

  // A job takes the lock and is held open, standing in for the read-modify-write
  // window during which the old code allowed the unlink to slip through.
  let releaseWriter: () => void = () => {}
  let writerHasLock: () => void = () => {}
  const lockTaken = new Promise<void>(resolve => { writerHasLock = resolve })
  const gate = new Promise<void>(resolve => { releaseWriter = resolve })
  // The writer's promise is KEPT and awaited below. An earlier version of this
  // test fired it with `void` and asserted as soon as the delete resolved — so
  // the writer had not yet recreated the file and the test passed even with the
  // lock removed. A concurrency test that survives the bug it guards is worse
  // than none, so the write is awaited to completion before anything is checked.
  const writer = withLock(planPath, async () => {
    writerHasLock()
    await gate
    // The job finishes and writes its result — recreating the file.
    await writeJsonAtomic(planPath, { schema_version: 1, scenes: [{ id: 's1', image_path: 'a.png' }] })
  })
  await lockTaken

  // The user presses Delete while that job is still running.
  const deleting = deletePlan()

  // Give the delete every chance to run ahead of the writer. If it is unlocked
  // it completes here, the writer then recreates the file, and the assertion
  // at the end fails — which is precisely the bug.
  await new Promise(resolve => setTimeout(resolve, 200))

  releaseWriter()
  await writer      // let the job finish its write — this is what resurrects the file
  await deleting    // and only then can the delete have run, if it was queued

  assert.equal(
    await exists(planPath),
    false,
    'the delete must run AFTER the in-flight writer, so the plan is gone and stays gone',
  )
})

test('deleting a plan that is not there is still not an error', async () => {
  await fs.rm(planPath, { force: true })
  await deletePlan()
  assert.equal(await exists(planPath), false)
})
