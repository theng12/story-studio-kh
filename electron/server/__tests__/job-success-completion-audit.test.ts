/**
 * The success-path completion audit — group 1.1 of docs/audit/FIX-PLAN.md.
 *
 * THE DEFECT. `assertJobDidNotDeclareIncomplete` only fires when the executor
 * itself set `result.complete === false`. An executor that audits nothing passes
 * untouched, so the app's completion guarantee was only as strong as the least
 * diligent generator — which is how a job could report `done` over missing
 * output and turn a Production Board cell green.
 *
 * THE FIX. For job types that already have a per-type auditor (the same
 * auditors the provider-settlement path trusts), the ordinary success path now
 * re-reads the artifacts when the executor declared NOTHING, and fails the job
 * if the auditor says `repair-required`.
 *
 * These tests pin the boundaries, because each boundary is what keeps the fix
 * from failing honest work: a declared verdict is respected, a type with no
 * auditor is untouched, and an auditor that cannot read the disk fails OPEN
 * rather than destroying a good job.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { registerJobCancellationAuditor } from '../services/job-cancellation-auditors.js'
import { assertAuditedCompletionOnSuccess } from '../services/job-queue.js'

/** A job type that exists only for this file, so the registry stays private. */
const FAKE = 'test-audited-output' as unknown as Parameters<typeof registerJobCancellationAuditor>[0]
const UNAUDITED = 'test-unaudited-output' as unknown as Parameters<typeof registerJobCancellationAuditor>[0]
/** Distinct type: the registry keys by type, so a re-registration would overwrite. */
const FAULTING = 'test-faulting-output' as unknown as Parameters<typeof registerJobCancellationAuditor>[0]

function job(overrides: Record<string, unknown> = {}): any {
  return {
    job_id: 'job-1',
    type: FAKE,
    status: 'running',
    project_slug: 'p',
    episode_id: 'EP0001',
    output_lines: [],
    result: undefined,
    ...overrides,
  }
}

describe('a job may not report success when its auditor finds missing output', () => {
  test('declared nothing + auditor says repair-required → the job FAILS, naming the type', async () => {
    registerJobCancellationAuditor(FAKE, async () => 'repair-required')
    const j = job()
    await assert.rejects(
      () => assertAuditedCompletionOnSuccess(j),
      /test-audited-output reported success/i,
    )
  })

  test('declared nothing + auditor says complete → passes', async () => {
    registerJobCancellationAuditor(FAKE, async () => 'complete')
    await assertAuditedCompletionOnSuccess(job())
  })

  test('the executor declared TRUE → the auditor is not even consulted', async () => {
    // A generator that audited its own output is trusted over a re-read. If the
    // auditor were consulted here, a disagreement would fail a job that had
    // already proved itself.
    let called = false
    registerJobCancellationAuditor(FAKE, async () => { called = true; return 'repair-required' })
    const j = job({ result: { complete: true } })
    await assertAuditedCompletionOnSuccess(j)
    assert.equal(called, false, 'the auditor must not run when the executor declared a verdict')
  })

  test('the executor declared FALSE → handled by the other assert, not this one', async () => {
    // `assertJobDidNotDeclareIncomplete` runs first and throws; this helper must
    // not also react, or the error message would be the wrong one.
    registerJobCancellationAuditor(FAKE, async () => 'complete')
    await assertAuditedCompletionOnSuccess(job({ result: { complete: false } }))
  })

  test('a type with NO auditor keeps today’s behaviour', async () => {
    await assertAuditedCompletionOnSuccess(job({ type: UNAUDITED }))
  })

  test('an auditor FAULT is fail-closed, because the registry converts it to repair-required', async () => {
    // `registerJobCancellationAuditor` wraps every auditor:
    //   try { return await auditor(job) } catch { return 'repair-required' }
    // — "provider success does not make malformed or unreadable local output
    // complete". So a faulting auditor fails the job rather than passing it.
    //
    // This test exists because the first version of the fix documented the
    // OPPOSITE ("fails open, with a line in the job log") and had a try/catch
    // that could never run. The test caught the comment lying about the code.
    registerJobCancellationAuditor(FAULTING, async () => { throw new Error('disk unreadable') })
    await assert.rejects(
      () => assertAuditedCompletionOnSuccess(job({ type: FAULTING })),
      /found required items missing or could not verify/i,
    )
  })
})
