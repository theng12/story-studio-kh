/**
 * Production 2026-11-17, ten episodes (EP0026, EP0028, EP0032, EP0039, EP0040, EP0061, EP0063,
 * EP0064, HMH0117, HMH0119): a recovery retry had no terminal outcome.
 *
 * Three separate controls failed on the same row, and each asserts here on its own:
 *   1. The by-key collect sat on "Checking the earlier prompt request" for 45 minutes. It was
 *      bounded by GENSTUDIO_LONG_JOB_TIMEOUT_MS — a week-long safety valve meant for a long render,
 *      never for re-reading a request Story had already lost.
 *   2. After Abandon, the row said "Retry on this row starts it fresh". Retry answered 202 and handed
 *      back the same already-cancelled recovery row, so the step could not be re-run from that row.
 *   3. Cancel answered 409 "already started and will finish" on a row that was going nowhere, and
 *      named no way out. The operator's sentence has to match what happened.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { useTempDataDir } from './_helpers.js'
import type { Job } from '../models/types.js'

const ORDER_COVERED = {
  audio_merge: true, subtitle_sections: true, subtitle_stitch: true,
  scene_plan_run: false, contextual_cues: true, continuity_render: true,
}

function recoveryRow(projectSlug: string, status: Job['status'], jobId: string, planId: string): Job {
  return {
    job_id: jobId, project_slug: projectSlug, episode_id: 'EP0026', type: 'scene_plan_run',
    status, title: 'Scene Plan',
    params: { episode_id: 'EP0026', episode_recovery_id: planId },
    created_at: '2026-11-17T18:06:00Z', started_at: '2026-11-17T18:06:05Z', finished_at: null,
    error: null, output_lines: [],
  }
}

test('the recovery collect has its own ceiling, not the week-long render valve', async () => {
  const temp = await useTempDataDir()
  try {
    const client = await import('../lib/genstudio-client.js')
    const settings = await import('../services/app-settings.js')
    // The owner's dial, at its default: one writing request's budget.
    const collect = await client.recoveryCollectTimeoutMs(0)
    const submission = await client.effectiveChatSubmitTimeoutMs(0)
    assert.equal(collect, submission,
      'a collect is bounded by one writing request, exactly as a submission is')
    assert.ok(collect < client.GENSTUDIO_LONG_JOB_TIMEOUT_MS,
      'the collect must not inherit the week-long valve a slow render is allowed')
    assert.equal(collect, (await settings.getLanguageTimeoutMinutes()) * 60_000)
  } finally { await temp.cleanup() }
})

test('the collect widens with the request\'s own computed allowance, never with the valve', async () => {
  const temp = await useTempDataDir()
  try {
    const client = await import('../lib/genstudio-client.js')
    // A long pack states a real allowance; the cap must follow it, as the socket budget does.
    const wide = await client.recoveryCollectTimeoutMs(90 * 60)
    assert.ok(wide >= 90 * 60_000, `a 90-minute allowance is admitted, got ${wide}`)
    assert.ok(wide <= 4 * 60 * 60_000, `capped at the Hub's four-hour ceiling, got ${wide}`)
  } finally { await temp.cleanup() }
})

test('Retry on an abandoned recovery row starts a genuinely new row, not the cancelled one', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Abandoned recovery retry' })
    await jq.setQueuePaused(true)
    const { recoverEpisode, createEpisodeRecoveryPlan, readEpisodeRecoveryPlans } = await import('../services/episode-recovery.js')

    // The row the owner abandoned: cancelled, with the plan's own identity on it.
    const plan = createEpisodeRecoveryPlan([recoveryRow(project.slug, 'error', 'source-plan', 'seed')])
    plan.steps.scene_plan_run!.job_id = 'recovery-cancelled-plan-scene_plan_run'
    plan.steps.scene_plan_run!.dispatched = true

    const cancelled = recoveryRow(project.slug, 'cancelled', 'recovery-cancelled-plan-scene_plan_run', plan.id)
    await jq.enqueueEpisodeRecoveryOnce(cancelled.job_id, {
      project_slug: project.slug, episode_id: 'EP0026', type: 'scene_plan_run',
      title: 'Scene Plan', params: cancelled.params,
    })
    // The owner's own exit: the real abandon path, not a hand-written status.
    await jq.forceAbandonJob(project.slug, cancelled.job_id)
    const abandoned = jq.getJob(cancelled.job_id)!
    assert.equal(abandoned.status, 'cancelled')

    // The owner's press of Retry, exactly as the row's own log promises.
    await recoverEpisode(project.slug, 'EP0026', true, [cancelled.job_id], [], true)
    const planAfter = (await readEpisodeRecoveryPlans(project.slug, 'EP0026'))!.plans.find(item => item.current)!
    const node = planAfter.steps.find(item => item.step === 'scene_plan_run')!

    assert.notEqual(node.job_id, cancelled.job_id,
      'the plan must not hand Retry back the cancelled row it just rebuilt')

    // And the edge it names can actually run: dispatching it queues a row.
    const { dispatchEpisodeRecoveryStep } = await import('../services/episode-recovery.js')
    const stored = (await import('../services/job-queue.js')).getJob(cancelled.job_id)!
    const facts = { verified: { ...ORDER_COVERED }, message: 'Retry after abandon' }
    const rebuilt = {
      version: 1 as const, id: planAfter.id, project_slug: project.slug, episode_id: 'EP0026',
      target: planAfter.target, steps: { scene_plan_run: { job_id: node.job_id, type: 'scene_plan_run',
        title: 'Scene Plan', params: {}, source_job_id: cancelled.job_id } },
      completed: [...planAfter.completed], first_unresolved: 'scene_plan_run' as const,
      message: '', owner_requested_at: planAfter.owner_requested_at ?? undefined,
      retry_source_job_ids: planAfter.retry_source_job_ids,
    }
    await dispatchEpisodeRecoveryStep(rebuilt as any, facts, [stored], [cancelled.job_id], 'owner')
    const rows = await jq.getJobs(project.slug)
    const queued = rows.find(row => row.job_id === rebuilt.steps.scene_plan_run!.job_id)
    assert.ok(queued, `the new edge queued a row — got ${rows.map(row => `${row.job_id}:${row.status}`).join(', ')}`)
    assert.notEqual(queued!.status, 'cancelled', 'and that row is not cancelled on arrival')
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('Retry on an abandoned recovery row refuses with the reason when it cannot run', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Abandoned recovery refusal is honest' })
    await jq.setQueuePaused(true)
    const { recoverEpisode } = await import('../services/episode-recovery.js')
    await jq.enqueueEpisodeRecoveryOnce('recovery-orphan-scene_plan_run', {
      project_slug: project.slug, episode_id: 'EP0026', type: 'scene_plan_run',
      title: 'Scene Plan', params: { episode_id: 'EP0026' },
    })
    const orphan = jq.getJob('recovery-orphan-scene_plan_run')!
    orphan.status = 'cancelled'
    orphan.force_abandoned = { at: '2026-11-17T18:51:54Z', unsettled: [] }

    await assert.rejects(
      recoverEpisode(project.slug, 'EP0026', true, [orphan.job_id], [], true),
      /Recovery source must be an owned failed or cancelled episode job|no recoverable/i,
      'an abandoned row with no owning plan is refused in words, never a silent 202',
    )
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('a cancel the Gateway cannot honour names the way out instead of ending at a wall', async () => {
  const temp = await useTempDataDir()
  try {
    const { classifyJobControl } = await import('../services/job-control.js')
    const row = recoveryRow('project', 'running', 'stuck-row', 'plan-1')
    row.genstudio_jobs = [{
      operation: 'chat.response', id: 'provider-1', state: 'running',
      dispatch_state: 'dispatched', cancellable: false,
    } as any]
    const control = classifyJobControl(row as any, {
      remoteCancellationAudited: true, localStopAvailable: false,
    } as any)

    assert.equal(control.code, 'PROVIDER_WORK_ALREADY_STARTED')
    assert.match(control.reason!, /Abandon/i,
      'the sentence must name the escape that works, because Cancel alone cannot end this row')
  } finally { await temp.cleanup() }
})

test('an owner retry of Scene Plan asks for a NEW request identity, not the dead one', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    await jq.setQueuePaused(true)
    const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep } = await import('../services/episode-recovery.js')
    const { freshGenerationRequestIdentity } = await import('../lib/fresh-generation-action.js')

    const project = await pm.createProject({ name: 'Fresh redo identity' })
    const source = recoveryRow(project.slug, 'error', 'dead-scene-plan', 'plan-fresh')
    // The dead hold this row is stuck on, exactly as Production's ten episodes carried it.
    source.genstudio_jobs = [{
      operation: 'chat.response', id: 'held-job', state: 'failed',
      recovery_state: 'unknown_outcome', request_key: 'story-chat-dead',
      request: { idempotency_key: 'story-chat-dead', messages: [], response_format: null },
    } as any]
    await jq.writeAuthoritativeJob(source as any)
    await jq.getJobs(project.slug)

    const plan = createEpisodeRecoveryPlan([source])
    plan.owner_requested_at = new Date().toISOString()
    plan.steps.scene_plan_run = {
      job_id: 'recovery-fresh-scene_plan_run', type: 'scene_plan_run', title: 'Scene Plan',
      params: { episode_id: 'EP0026' }, source_job_id: source.job_id,
    }
    plan.completed = ['audio_merge', 'subtitle_sections', 'subtitle_stitch']
    plan.first_unresolved = 'scene_plan_run'
    await dispatchEpisodeRecoveryStep(
      plan,
      { verified: { ...ORDER_COVERED }, message: 'Retry after a dead hold' },
      await jq.getJobs(project.slug),
      [source.job_id], 'owner',
    )

    const queued = jq.getJob('recovery-fresh-scene_plan_run')!
    assert.ok(queued, 'the owner retry queued its own row')
    const identity = freshGenerationRequestIdentity(queued as any, 'scene-plan-visual-pack')
    assert.ok(identity, 'the row carries a fresh generation action, so its request identity changes')
    assert.match(identity!, /:fresh:/, `a fresh identity is namespaced, got ${identity}`)
    assert.equal(queued.params?.generation_action?.kind, 'fresh',
      'the redo is recorded as a deliberate fresh action on the row itself')

    // THE ASSERTION THE PEER ASKED FOR: the KEY, not the plan. `request_identity` is only one
    // digest component, so assert the digest itself differs — otherwise this is the run-batch
    // mistake with a fresh coat of paint (a new plan whose key is byte-identical).
    const { buildGenStudioChatIdempotencyKey } = await import('../lib/genstudio-client.js')
    const deadKey = buildGenStudioChatIdempotencyKey({
      modelId: 'mock-chat-v1', system: 'sys', userMessage: 'the same scenes',
      temperature: 0.5, maxOutputTokens: 2048,
    })
    const redoneKey = buildGenStudioChatIdempotencyKey({
      modelId: 'mock-chat-v1', system: 'sys', userMessage: 'the same scenes',
      temperature: 0.5, maxOutputTokens: 2048, requestIdentity: identity!,
    })
    assert.notEqual(redoneKey, deadKey,
      'the redo must ask for a DIFFERENT key than the dead hold, or the Gateway replays it')

    // And the accepted answers are still collected first: the saved key rides along on the new row.
    const collected = (queued.params?.scene_prompt_recoveries || []).map((item: any) => item.idempotency_key)
    assert.ok(collected.includes('story-chat-dead'),
      `the saved request is collected by its key before any new work — got ${JSON.stringify(collected)}`)
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('Retry answers 202 only when it actually queued something', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const express = (await import('express')).default
    const { router } = await import('../routes/jobs.js')
    const request = (await import('supertest')).default
    const app = express().use(express.json()).use(router)
    const project = await pm.createProject({ name: 'Retry 202 honesty' })
    await jq.setQueuePaused(true)

    // A scene-plan row whose retry routes into recovery, with no narration to recover from: the
    // plan comes back blocked, so nothing was queued.
    const source = { ...recoveryRow(project.slug, 'error', 'recovery-honest-scene_plan_run', 'plan-honest') }
    source.created_at = '2026-11-17T18:06:00Z'
    await jq.writeAuthoritativeJob(source as any)
    await jq.getJobs(project.slug)
    const row = jq.getJob(source.job_id)!
    assert.equal(row.type, 'scene_plan_run')

    const response = await request(app).post(`/jobs/all/${row.job_id}/retry`).send({})
    assert.equal(response.status, 409,
      `a retry that queued nothing must not answer 202 — got ${response.status} ${JSON.stringify(response.body).slice(0, 200)}`)
    assert.match(response.body.detail, /Audio Assembly|narration|script/i,
      'and the refusal carries the plan\'s own reason, not a generic failure')
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})
