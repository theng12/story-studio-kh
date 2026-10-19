/**
 * Regression for RETRY-METADATA-REJECTED-PAGE-ACTION.
 *
 * BUG. `retryReplacementParams` (electron/server/routes/jobs.ts:280-307) mints a
 * fresh provider request identity for a metadata Retry only when the saved
 * `generation_action` is ABSENT or was itself minted by a retry
 * (`existingAction.origin === 'retry'`, line 287). The `chat_answer_rejected`
 * override that exists to break the rejected-answer loop
 * (`holdsEarlierChatAnswer`, jobs.ts:269-277, returns false when
 * `job.result.chat_answer_rejected === true`) is reached only INSIDE that same
 * branch (line 292). A metadata job whose `generation_action` was stamped by the
 * YouTube-finalization page (`frontend/pages/projects/[slug]/metadata.vue:1031`
 * via `useFreshGenerationAction`) or by the Pipeline
 * (`routes/pipeline.ts:2879`, `generation_action: { id, kind: 'fresh' }`) carries
 * `kind: 'fresh'` and NO `origin`, so line 287 is false and the function returns
 * `undefined` (line 306) — the saved action is reused verbatim, whatever
 * `chat_answer_rejected` says.
 *
 * The metadata generator derives its Gateway request identity from that action id
 * (`generators/metadata.ts` -> `freshGenerationRequestIdentity(job, purpose)`,
 * `lib/fresh-generation-action.ts:130-135`), so the SAME action id gives the SAME
 * idempotency key. The Gateway replays the same answer it already gave
 * (`store.submit` returns the existing row for a repeated key), Story's audit
 * rejects that same short answer again (`generators/metadata.ts:688-690` sets
 * `chat_answer_rejected`), and the job fails identically while its own terminal
 * hint reads "Retry to generate the missing fields" (metadata.ts:697). The
 * customer is in exactly the loop the NEW-14 fix was written to break — it was
 * applied to the no-action and retry-origin cases but not to the page-stamped one.
 *
 * TRIGGER. A metadata job carrying a page/pipeline-stamped `generation_action`
 * (`kind: 'fresh'`, no `origin`) whose answer Story rejected
 * (`job.result.chat_answer_rejected === true`), then POST Retry.
 * WRONG STATE. The retried job keeps the SAME `generation_action.id` and
 * `generation_action_fingerprint`, so its request identity (and Gateway
 * idempotency key) is unchanged and the rejected answer is replayed.
 *
 * EXPECTED (owner contract). A proven-rejected answer must force a fresh action
 * on Retry regardless of the action's origin, exactly as it does when the action
 * is absent or retry-minted — the marker means "the saved answer is proven
 * unusable". Case B pins the deliberate exception: a page-stamped action whose
 * answer was NOT rejected is still preserved (EP0113 — do not re-pay for an
 * answer the Gateway already holds).
 *
 * HARNESS. This drives the REAL route + queue: the actual metadata Retry route
 * (`/api/projects/:slug/jobs/:jobId/retry`), `retryReplacementParams`,
 * `retryTerminalJob`, `enqueuePreparedForTest`, and `recordGenStudioJob`. No
 * generator logic is copied. Only the per-type executor is stubbed (the same seam
 * the existing `job-retry-route-contract.test.ts` uses), because the point under
 * test is the route's retry params, not the generator.
 *
 * RUNNER. The backend lane: this file belongs at
 * `electron/server/__tests__/metadata-retry-rejected-page-action.test.ts`.
 * On the current (pre-fix) code Case A FAILS at its assertion — that is the point.
 * Run filtered:
 *   node scripts/testing/run-backend-tests.mjs --only metadata-retry-rejected-page-action
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

async function waitForTerminal(
  jq: typeof import('../services/job-queue.js'),
  jobId: string,
  label: string,
): Promise<void> {
  await waitFor(() => {
    const status = jq.getJob(jobId)?.status
    return (status === 'error' || status === 'cancelled' || status === 'done')
      && !jq._isJobWorkerActiveForTesting(jobId)
  }, { label, timeoutMs: 2_000 })
}

void test('metadata Retry mints a fresh action for a rejected answer even when the saved action is page-stamped', async () => {
  const temp = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const app = (await import('../app.js')).app
    const jq = await import('../services/job-queue.js')
    const pm = await import('../services/project-manager.js')

    // A page/pipeline-stamped action: `kind: 'fresh'` with NO `origin` (this is
    // exactly what stampFreshGenerationAction produces).
    const pageStampedAction = { id: '44444444-4444-4444-8444-444444444444', kind: 'fresh' as const }
    const baseParams = {
      episode_id: 'EP0200',
      title: 'Rejected page action',
      model: 'saved-metadata-model',
      force: true,
      auto_retry: false,
      generation_action: pageStampedAction,
      generation_action_fingerprint: 'a'.repeat(64),
    }

    // ── Case A — the rejected answer. ────────────────────────────────────────
    const rejectedProject = await pm.createProject({ name: 'Retry metadata rejected page action' })
    jq.registerExecutor('metadata', async job => {
      // A Gateway answer Story received and found unusable (empty/short fields).
      await jq.recordGenStudioJob(job.job_id, {
        id: 'chat-rejected', operation: 'chat.response', state: 'succeeded',
        model_id: 'saved-metadata-model', updated_at: new Date().toISOString(),
        request: {
          method: 'POST', path: '/v1/chat/responses',
          idempotency_key: 'story-chat-page-stamped-key',
          captured_at: new Date().toISOString(),
        },
      } as any)
      job.result = { ...(job.result || {}), chat_answer_rejected: true }
      throw new Error('metadata finished without usable fields')
    })
    const rejected = jq.enqueuePreparedForTest({
      project_slug: rejectedProject.slug,
      type: 'metadata',
      episode_id: 'EP0200',
      title: 'Rejected page action',
      params: structuredClone(baseParams),
    })
    await waitForTerminal(jq, rejected.job_id, 'rejected metadata original failure')
    assert.equal(jq.getJob(rejected.job_id)?.status, 'error')

    let rejectedRetryParams: Record<string, any> | undefined
    jq.registerExecutor('metadata', async job => { rejectedRetryParams = structuredClone(job.params) })
    const rejectedRetry = await request(app)
      .post(`/api/projects/${rejectedProject.slug}/jobs/${rejected.job_id}/retry`).send({})
    assert.equal(rejectedRetry.status, 202, JSON.stringify(rejectedRetry.body))
    await waitForTerminal(jq, rejectedRetry.body.job.job_id, 'rejected metadata retry')
    assert.ok(rejectedRetryParams, 'the retried metadata job ran')
    assert.notEqual(
      rejectedRetryParams!.generation_action?.id,
      pageStampedAction.id,
      'a proven-rejected answer must mint a fresh action even when the saved action is page-stamped',
    )
    assert.equal(
      rejectedRetryParams!.generation_action?.origin,
      'retry',
      'the minted action records that a retry made it',
    )

    // ── Case B — the deliberate exception (control). ─────────────────────────
    // A page-stamped action whose answer was NOT rejected is preserved, so a
    // fix for Case A must not start re-paying for an answer the Gateway holds.
    const heldProject = await pm.createProject({ name: 'Retry metadata held page action' })
    jq.registerExecutor('metadata', async job => {
      await jq.recordGenStudioJob(job.job_id, {
        id: 'chat-held', operation: 'chat.response', state: 'succeeded',
        model_id: 'saved-metadata-model', updated_at: new Date().toISOString(),
        request: {
          method: 'POST', path: '/v1/chat/responses',
          idempotency_key: 'story-chat-held-page-key',
          captured_at: new Date().toISOString(),
        },
      } as any)
      throw new Error('metadata failed for an unrelated reason')
    })
    const held = jq.enqueuePreparedForTest({
      project_slug: heldProject.slug,
      type: 'metadata',
      episode_id: 'EP0200',
      title: 'Held page action',
      params: structuredClone(baseParams),
    })
    await waitForTerminal(jq, held.job_id, 'held metadata original failure')

    let heldRetryParams: Record<string, any> | undefined
    jq.registerExecutor('metadata', async job => { heldRetryParams = structuredClone(job.params) })
    const heldRetry = await request(app)
      .post(`/api/projects/${heldProject.slug}/jobs/${held.job_id}/retry`).send({})
    assert.equal(heldRetry.status, 202, JSON.stringify(heldRetry.body))
    await waitForTerminal(jq, heldRetry.body.job.job_id, 'held metadata retry')
    assert.ok(heldRetryParams, 'the retried metadata job ran')
    assert.deepEqual(
      heldRetryParams!.generation_action,
      pageStampedAction,
      'a page-stamped action whose answer was not rejected is still preserved (EP0113)',
    )
    assert.equal(heldRetryParams!.generation_action_fingerprint, baseParams.generation_action_fingerprint)
  } finally {
    const jq = await import('../services/job-queue.js').catch(() => null)
    await jq?._waitForJobPersistenceForTesting()
    await temp.cleanup()
  }
})
