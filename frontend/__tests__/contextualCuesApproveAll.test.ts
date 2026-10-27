/**
 * v1.2.6 — "Approve all" on the label half of Sound & Labels.
 *
 * The owner was approving 12 cues one at a time. The bulk control he asked for
 * has exactly one way to go wrong quietly: sweeping up a cue he had already
 * excluded — or, since v1.4.365, sweeping up a SOUND, which is a clip nobody has
 * heard and a licence nobody has credited. Both are asserted here.
 *
 * The page is `sound-and-labels.vue` since the merge; the behaviour under test
 * is the same one, on the same list.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { cuesAwaitingApproval } from '../utils/contextual-cues.js'

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/sound-and-labels.vue', import.meta.url)),
  'utf8',
)

test('a cue the customer excluded survives Approve all untouched', () => {
  const cues = [
    { id: 'a', status: 'proposed' },
    { id: 'b', status: 'disabled' },
    { id: 'c', status: 'approved' },
    { id: 'd', status: 'proposed' },
  ]
  const pending = cuesAwaitingApproval(cues)

  assert.deepEqual(pending.map(cue => cue.id), ['a', 'd'])
  // Approve all only ever writes to what it selected.
  for (const cue of pending) cue.status = 'approved'
  assert.equal(cues.find(cue => cue.id === 'b')!.status, 'disabled')
  assert.equal(cues.find(cue => cue.id === 'c')!.status, 'approved')
})

test('nothing pending selects nothing, so the control has no work to offer', () => {
  assert.deepEqual(cuesAwaitingApproval([{ status: 'approved' }, { status: 'disabled' }]), [])
  assert.deepEqual(cuesAwaitingApproval([]), [])
})

test('Approve all names its count, hides itself when idle, and defers to Save changes', () => {
  // The count comes from the pending total, not a bare label.
  assert.match(page, /Approve all \{\{ proposedLabels\.length \}\} labels/)
  // Hidden entirely when there is nothing awaiting review.
  assert.match(page, /v-if="proposedLabels\.length"[\s\S]{0,400}?@click="approveAllLabels"/)
  // Local edit + dirty flag only. It must not write on its own.
  assert.match(page, /function approveAllLabels\(\): void \{[\s\S]{0,400}?markDirty\(\)/)
  assert.doesNotMatch(page, /function approveAllLabels[\s\S]{0,400}?await (put|post)\(/)
  // Approve-only on the LABEL half: a sound is never swept up by it, because
  // approving a clip nobody heard would put a licence into the publish record
  // nobody checked.
  assert.match(page, /const proposedLabels = computed\(\(\) => labels\.value\?\.cues\.filter/)
  assert.doesNotMatch(page, /Approve all[^<]{0,60}sounds/i)
  // Approve-only: no unrequested bulk exclude was added alongside it.
  assert.doesNotMatch(page, /Exclude all/)
})
