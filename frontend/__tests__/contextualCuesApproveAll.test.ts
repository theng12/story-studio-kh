/**
 * v1.2.6 — "Approve all" on Contextual Cues.
 *
 * The owner was approving 12 cues one at a time. The bulk control he asked for
 * has exactly one way to go wrong quietly: sweeping up a cue he had already
 * excluded. That is the behaviour asserted first here.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { cuesAwaitingApproval } from '../utils/contextual-cues.js'

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/contextual-cues.vue', import.meta.url)),
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
  assert.match(page, /Approve all \{\{ proposedCount \}\}/)
  // Hidden entirely when there is nothing awaiting review.
  assert.match(page, /v-if="proposedCount"[\s\S]{0,320}?@click="approveAllProposed"/)
  // Reuses the shared boundary helper rather than re-filtering by hand.
  assert.match(page, /cuesAwaitingApproval\(timeline\.value\?\.cues \|\| \[\]\)/)
  // Local edit + dirty flag only. It must not write on its own.
  assert.match(page, /for \(const cue of pending\) setStatus\(cue, 'approved'\)/)
  assert.doesNotMatch(page, /function approveAllProposed[\s\S]{0,400}?await (put|post)\(/)
  // Approve-only: no unrequested bulk exclude was added alongside it.
  assert.doesNotMatch(page, /Exclude all/)
})
