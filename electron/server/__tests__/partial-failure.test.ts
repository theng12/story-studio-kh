/**
 * Tests for the "partial failure → status=error, not done" invariant.
 *
 * Every generator (images, audio, ai-video) is expected to throw when ANY
 * item failed so the queue runner stamps the job as `error` instead of
 * `done`. Those generators build their logic on top of this job-queue
 * contract:
 *
 *   - executor resolves       → status = done
 *   - executor throws          → status = error, job.error = throw message
 *   - executor throws + cancel → status = cancelled (cancel wins)
 *
 * Locking this in at the queue level means a new generator automatically
 * inherits the correct UX as soon as it uses `throw` to signal failure —
 * we don't rely on every future author remembering to mutate `job.status`
 * by hand.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => { await cleanup() })

describe('partial-failure status contract', () => {
  test('executor throws → job.status = error, job.error carries the message', async () => {
    const proj = await pm.createProject({ name: 'PF_Throws' })

    jq.registerExecutor('script-only', async () => {
      throw new Error('2 item(s) failed: first failure; second failure')
    })

    const job = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'script-only', episode_id: 'PF_EP1',
      title: 't', params: {},
    })

    // Wait for the queue runner to execute + persist the terminal state.
    await new Promise((r) => setTimeout(r, 200))

    const after = jq.getJob(job.job_id)
    assert.ok(after, 'job should be readable after it finishes')
    assert.equal(after!.status, 'error',
      `expected error status; got ${after!.status}`)
    assert.match(after!.error || '', /item\(s\) failed/)
    assert.ok(
      (after!.output_lines || []).some(l => l.startsWith('Error:')),
      'generator error should appear in output_lines for the UI',
    )
  })

  test('executor resolves normally → job.status = done', async () => {
    const proj = await pm.createProject({ name: 'PF_Resolves' })

    jq.registerExecutor('script-only', async (j) => {
      // Simulate a successful run that pushed output lines but never threw.
      j.output_lines.push('All items generated successfully')
    })

    const job = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'script-only', episode_id: 'PF_EP2',
      title: 't', params: {},
    })
    await new Promise((r) => setTimeout(r, 200))

    const after = jq.getJob(job.job_id)
    assert.equal(after!.status, 'done')
    assert.equal(after!.error, null)
  })

  test('partial-failure throw also fires a terminal jobEvents.update', async () => {
    const proj = await pm.createProject({ name: 'PF_Event' })

    const updates: Array<{ status: string; error: string | null }> = []
    const onUpdate = (j: any) => {
      if (j.project_slug === proj.slug) {
        updates.push({ status: j.status, error: j.error })
      }
    }
    jq.jobEvents.on('update', onUpdate)

    try {
      jq.registerExecutor('script-only', async () => {
        throw new Error('3 clip(s) failed: clip 1; clip 2; clip 3')
      })

      jq.enqueuePreparedForTest({
        project_slug: proj.slug, type: 'script-only', episode_id: 'PF_EV_1',
        title: 't', params: {},
      })
      await new Promise((r) => setTimeout(r, 250))

      // The SSE stream relies on this terminal-error frame for the
      // "failed" toast in the UI — regressing this breaks the user-
      // visible signal that the generator collapsed.
      const terminal = updates.find(u => u.status === 'error')
      assert.ok(terminal, `expected terminal error event; got ${JSON.stringify(updates)}`)
      assert.match(terminal!.error || '', /clip\(s\) failed/)
    } finally {
      jq.jobEvents.off('update', onUpdate)
    }
  })
})
