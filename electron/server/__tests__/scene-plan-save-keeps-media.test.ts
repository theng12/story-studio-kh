/**
 * Saving Scene Plan edits must not erase a render that finished while the
 * editor was open. The page sends the whole plan it loaded; the checkpoint
 * writer may have stamped image/clip fields on disk since then.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'

useTempDataDir()

test('on-disk image and clip fields win for scenes that still exist', async () => {
  const { keepSavedSceneMedia } = await import('../routes/scene-plan.js')
  const onDisk: any = {
    schema_version: 1,
    scenes: [
      { id: 'a', visual_prompt: 'old', image_path: '/img/a.png', image_version: 'v2', rendered_prompt: 'old', approved: true, motion_choice: 'pending' },
      { id: 'b', visual_prompt: 'b', clip_path: '/clip/b.mp4', clip_duration_seconds: 5 },
    ],
  }
  const incoming: any = {
    schema_version: 1,
    scenes: [
      // Stale editor copy: no image yet, user edited the prompt.
      { id: 'a', visual_prompt: 'edited', approved: false },
      // Stale copy still carries an image the disk no longer has.
      { id: 'b', visual_prompt: 'b2', image_path: '/img/stale.png', approved: true },
      // A brand-new split scene keeps exactly what the editor sent.
      { id: 'new', visual_prompt: '', approved: false },
    ],
  }
  const merged = keepSavedSceneMedia(incoming, onDisk)
  const [a, b, created] = merged.scenes as any[]
  assert.equal(a.visual_prompt, 'edited', 'the user edit is kept')
  assert.equal(a.image_path, '/img/a.png')
  assert.equal(a.image_version, 'v2')
  assert.equal(a.rendered_prompt, 'old', 'the image stays honestly stale against the edited prompt')
  assert.equal(a.approved, true)
  assert.equal(b.visual_prompt, 'b2')
  assert.equal(b.image_path, undefined, 'a stale image the disk dropped is not resurrected')
  assert.equal('approved' in b, false)
  assert.equal(b.clip_path, '/clip/b.mp4')
  assert.equal(b.clip_duration_seconds, 5)
  assert.deepEqual(created, { id: 'new', visual_prompt: '', approved: false })
})

test('a first save with nothing on disk is written as sent', async () => {
  const { keepSavedSceneMedia } = await import('../routes/scene-plan.js')
  const incoming: any = { schema_version: 1, scenes: [{ id: 'a', image_path: '/x.png' }] }
  assert.deepEqual(keepSavedSceneMedia(incoming, null), incoming)
})
