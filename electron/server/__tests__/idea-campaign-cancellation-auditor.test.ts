/**
 * Idea Campaign cancellation auditor — source-level regression.
 *
 * The auditor is the generator's own completion proof, reused by the queue's
 * cancellation reconciler and the success-path re-audit. Three properties matter:
 *
 *  1. it counts only the EXACT campaign, at the same clamped wanted count the
 *     generator uses (idea-campaign.ts:312,339);
 *  2. an empty, partial or unreadable store is never "complete"
 *     (AGENTS.md §6 and §8);
 *  3. it is READ-ONLY — the paid batch record keeps its idempotency key, so a
 *     later Retry collects the accepted request without a second POST.
 *
 * The control-classification half pins the boundary the auditor must not cross:
 * uncertain submission stays `return-later` / CANCELLATION_STATUS_UNKNOWN, and
 * only accepted, cancellable provider evidence offers `request-remote-cancel`.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'

const CAMPAIGN = 'auditor-campaign'
const MODEL = 'mock-chat-v1'

let cleanup: () => Promise<void>
let projectSlug: string
let im: typeof import('../services/idea-manager.js')
let auditor: (job: any) => Promise<import('../services/job-cancellation-auditors.js').JobCancellationAudit>

function job(params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): any {
  return {
    job_id: 'idea-auditor-job',
    project_slug: projectSlug,
    type: 'idea_campaign',
    episode_id: 'ideas',
    title: 'Idea campaign auditor fixture',
    status: 'running',
    created_at: new Date().toISOString(),
    output_lines: [],
    params: { campaign_id: CAMPAIGN, count: 2, model: MODEL, ...params },
    ...extra,
  }
}

function idea(title: string, campaignId: string) {
  return {
    title,
    logline: `${title} is examined through a concrete historical turning point.`,
    themes: ['history', title],
    suggested_chapters: 8,
    suggested_length: '40 min',
    mood: 'measured',
    campaign_id: campaignId,
  }
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  // Auditors are registered at boot; a test process must do the same or it is
  // asserting against an empty registry.
  const { registerAllExecutors } = await import('../boot/executors.js')
  registerAllExecutors({ loadSettings: false })
  const { getJobCancellationAuditor } = await import('../services/job-cancellation-auditors.js')
  auditor = getJobCancellationAuditor('idea_campaign')!
  const pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
  projectSlug = (await pm.createProject({ name: 'Idea campaign cancellation auditor' })).slug
})

after(async () => { await cleanup() })

test('idea_campaign registers a cancellation auditor', async () => {
  const { hasJobCancellationAuditor } = await import('../services/job-cancellation-auditors.js')
  assert.equal(hasJobCancellationAuditor('idea_campaign'), true)
})

test('a missing or blank campaign id is repair-required: never a guess at "all ideas"', async () => {
  assert.equal(await auditor(job({ campaign_id: '' })), 'repair-required')
  assert.equal(await auditor(job({ campaign_id: '   ' })), 'repair-required')
  assert.equal(await auditor(job({ campaign_id: undefined })), 'repair-required')
})

test('the auditor counts only the exact campaign and clamps wanted exactly like the generator', async () => {
  // count 0 and a non-numeric count both clamp to 1. Nothing stored yet → not complete.
  assert.equal(await auditor(job({ count: 0 })), 'repair-required')
  assert.equal(await auditor(job({ count: 'not-a-number' })), 'repair-required')

  await im.addIdeas(projectSlug, [idea('Exact campaign one', CAMPAIGN)], MODEL, 'batch-exact-one')
  assert.equal(await auditor(job({ count: 0 })), 'complete', 'count clamps to 1, and one exact row exists')
  assert.equal(await auditor(job({ count: 'not-a-number' })), 'complete', 'Number(… ) || 0 clamps to 1')

  // A row under another campaign never fills this campaign's quota.
  await im.addIdeas(projectSlug, [idea('Other campaign one', 'other-campaign')], MODEL, 'batch-other-one')
  assert.equal(await auditor(job({ count: 2 })), 'repair-required')
  assert.equal(await auditor(job({ count: '2' })), 'repair-required', 'numeric strings follow the generator clamp')
  await im.addIdeas(projectSlug, [idea('Exact campaign two', CAMPAIGN)], MODEL, 'batch-exact-two')
  assert.equal(await auditor(job({ count: '2' })), 'complete')

  // The generator caps wanted at 100. With more than 100 exact rows, an
  // unclamped 10,000 would stay repair-required; the clamped audit is complete.
  await im.addIdeas(projectSlug,
    Array.from({ length: 100 }, (_, index) => idea(`Capped idea ${index}`, CAMPAIGN)),
    MODEL, 'batch-capped')
  assert.equal(await auditor(job({ count: 10_000 })), 'complete', 'count clamps to 100, not 10,000')
})

test('an unreadable idea store is repair-required, never a green audit', async () => {
  const pm = await import('../services/project-manager.js')
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const other = await pm.createProject({ name: 'Unreadable idea store' })
  const dir = pm.getProjectDir(other.slug)!
  await fs.writeFile(path.join(dir, 'ideas.json'), '{ this is not valid JSON')
  assert.equal(await auditor(job({ count: 1 }, { project_slug: other.slug })), 'repair-required')
})

test('the audit never touches the paid batch record or its idempotency key', async () => {
  const record = {
    ordinal: 1,
    prompt: 'captured body',
    count: 2,
    model: MODEL,
    request_identity: `${projectSlug}:${CAMPAIGN}:ideas:1`,
    idempotency_key: 'story-chat-auditor-key',
    slots: [],
    keys: ['a', 'b'],
  }
  const run = job({ idea_batch: record })
  const before = structuredClone(run.params)
  const verdict = await auditor(run)
  assert.ok(verdict === 'complete' || verdict === 'repair-required')
  assert.deepEqual(run.params, before, 'the auditor is read-only')
  assert.equal(run.params.idea_batch.idempotency_key, 'story-chat-auditor-key',
    'a later Retry still collects by the key the provider accepted')
})

test('a submitting campaign offers the local Stop; another type keeps return-later; accepted evidence still offers remote cancellation', async () => {
  const { classifyJobControl } = await import('../services/job-control.js')
  const audited = { remoteCancellationAudited: true }
  const submittingOnly = [{
    operation: 'chat.response', id: 'provider-job-1', state: 'submitting', queue_state: 'submitting',
  }]

  const stoppable = classifyJobControl(job({}, { genstudio_jobs: submittingOnly }), audited)
  assert.equal(stoppable.action, 'stop-local', 'the campaign can stop its local batch loop')
  assert.equal(stoppable.enabled, true)
  assert.equal(stoppable.code, 'READY')
  assert.equal(stoppable.financial_effect, 'provider-work-may-settle',
    'the copy must not claim a request already sent was stopped')

  const otherType = classifyJobControl(job({}, { type: 'audio', genstudio_jobs: submittingOnly }), audited)
  assert.equal(otherType.action, 'return-later', 'the local Stop is narrowly scoped to idea_campaign')
  assert.equal(otherType.code, 'CANCELLATION_STATUS_UNKNOWN')

  const acceptedEvidence = [{
    operation: 'chat.response', id: 'provider-job-1', state: 'accepted', queue_state: 'accepted',
    dispatch_state: 'dispatched', cancellable: true,
  }]
  const offered = classifyJobControl(job({}, { genstudio_jobs: acceptedEvidence }), audited)
  assert.equal(offered.action, 'request-remote-cancel')
  assert.equal(offered.enabled, true)
  assert.deepEqual(offered.targets, [{ operation: 'chat.response', provider_job_id: 'provider-job-1' }])

  const unaudited = classifyJobControl(job({}, { genstudio_jobs: acceptedEvidence }), { remoteCancellationAudited: false })
  assert.equal(unaudited.action, 'return-later')
  assert.equal(unaudited.code, 'REMOTE_CANCELLATION_NOT_SUPPORTED')
})
