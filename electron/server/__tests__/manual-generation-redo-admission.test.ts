import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { stampFreshGenerationAction } from '../lib/fresh-generation-action.js'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

let isolated: Awaited<ReturnType<typeof useTempDataDir>>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  isolated = await useTempDataDir()
  ;[jq, pm] = await Promise.all([
    import('../services/job-queue.js'),
    import('../services/project-manager.js'),
  ])
})

after(async () => {
  await jq?._waitForJobPersistenceForTesting()
  await isolated?.cleanup()
})

function actionParams(sourceJobId: string, operationId: string, model = 'test-writer') {
  return stampFreshGenerationAction({
    model,
    auto_retry: false,
    manual_redo: {
      version: 1,
      intent: 'replace_unresolved',
      source_job_id: sourceJobId,
      requested_at: '2026-10-14T00:00:00.000Z',
      target_chapters: [1],
      selected_model_id: model,
    },
  }, operationId)
}

function criteria(
  sourceJobId: string,
  sourceType: 'idea_campaign' | 'research_run' | 'expand_chapters' = 'idea_campaign',
): import('../services/job-queue.js').ManualGenerationRedoSourceCriteria {
  return {
    sourceJobId,
    sourceType,
    operation: 'chat.response' as const,
    resource: { kind: 'episode' as const },
    sourceLabel: 'writing attempt',
    evidenceLabel: 'Gateway chat request',
    hasCurrentEvidence: (_source, entries) =>
      entries.some(entry => entry.state === 'running'),
  }
}

async function stoppedSource(
  projectSlug: string,
  episodeId: string,
  type: 'idea_campaign' | 'research_run' | 'expand_chapters' = 'idea_campaign',
) {
  const restore = jq._setExecutorForTesting(type, async job => {
    await jq.recordGenStudioJob(job.job_id, {
      id: `provider-${job.job_id}`,
      operation: 'chat.response',
      state: 'running',
      dispatch_state: 'dispatched',
      cancellable: true,
      updated_at: new Date().toISOString(),
    })
    throw new Error('intentional stopped source')
  })
  try {
    const job = jq.enqueuePreparedForTest({
      project_slug: projectSlug,
      type,
      episode_id: episodeId,
      title: 'stopped source',
      params: { auto_retry: false },
    })
    await waitFor(() => jq.getJob(job.job_id)?.status === 'error', { label: 'source job to stop' })
    return jq.getJob(job.job_id)!
  } finally {
    restore()
  }
}

function enqueueManualGenerationRedo() {
  const candidate = (jq as any).enqueueManualGenerationRedo
  assert.equal(typeof candidate, 'function', 'the queue must expose the shared manual-redo admission entry point')
  return candidate as (
    opts: import('../services/job-queue.js').EnqueueOptions,
    source: import('../services/job-queue.js').ManualGenerationRedoSourceCriteria,
  ) => Promise<import('../models/types.js').Job>
}

test('a fresh manual action abandons only its exact terminal source and preserves provider evidence', async () => {
  const project = await pm.createProject({ name: 'Manual redo exact source' })
  const episodeId = 'EP0001'
  const source = await stoppedSource(project.slug, episodeId)
  const evidence = structuredClone(source.genstudio_jobs)
  const restore = jq._setExecutorForTesting('idea_campaign', async () => {})
  try {
    const replacement = await enqueueManualGenerationRedo()({
      project_slug: project.slug,
      type: 'idea_campaign',
      episode_id: episodeId,
      title: 'fresh replacement',
      params: actionParams(source.job_id, '11111111-1111-4111-8111-111111111111'),
    }, criteria(source.job_id))

    assert.notEqual(replacement.job_id, source.job_id)
    const abandoned = jq.getJob(source.job_id)!
    assert.ok(abandoned.force_abandoned)
    assert.deepEqual(abandoned.genstudio_jobs, evidence, 'source evidence survives abandonment byte-for-byte')
  } finally {
    restore()
  }
})

test('the existing Chapter preparation wrapper keeps its unresolved-chat semantics', async () => {
  const project = await pm.createProject({ name: 'Manual redo Chapter compatibility' })
  const source = await stoppedSource(project.slug, 'EP0006', 'expand_chapters')

  const prepared = await jq.prepareUnresolvedChapterExpansionRedo(project.slug, 'EP0006', source.job_id)
  assert.ok(prepared.force_abandoned)
  assert.equal(prepared.genstudio_jobs?.[0]?.operation, 'chat.response')
  assert.equal(prepared.genstudio_jobs?.[0]?.state, 'running')
})

test('same action reuses one job, changed body conflicts, and a distinct action may name the abandoned source', async () => {
  const project = await pm.createProject({ name: 'Manual redo action identity' })
  const episodeId = 'EP0002'
  const source = await stoppedSource(project.slug, episodeId)
  const restore = jq._setExecutorForTesting('idea_campaign', async () => {})
  try {
    const actionId = '22222222-2222-4222-8222-222222222222'
    const opts = {
      project_slug: project.slug,
      type: 'idea_campaign' as const,
      episode_id: episodeId,
      title: 'fresh replacement',
      params: actionParams(source.job_id, actionId),
    }
    ;(opts.params.generation_action as any).manual_redo_binding = {
      version: 1,
      source_type: 'research_run',
      operation: 'image.generation',
      resource_kind: 'custom',
      resource_identity: 'caller-claim',
      destination_type: 'research_run',
      destination_episode_id: 'EP9999',
    }
    const enqueue = enqueueManualGenerationRedo()
    const first = await enqueue(opts, criteria(source.job_id))
    await waitFor(() => jq.getJob(first.job_id)?.status === 'done', { label: 'first replacement to finish' })
    assert.deepEqual(jq.getJob(first.job_id)?.params?.generation_action?.manual_redo_binding, {
      version: 1,
      source_type: 'idea_campaign',
      operation: 'chat.response',
      resource_kind: 'episode',
      resource_identity: episodeId,
      destination_type: 'idea_campaign',
      destination_episode_id: episodeId,
    }, 'server criteria overwrite an untrusted binding claim')
    const replay = await enqueue(opts, criteria(source.job_id))
    assert.equal(replay.job_id, first.job_id)

    const sourceBeforeRefusals = {
      force_abandoned: structuredClone(jq.getJob(source.job_id)?.force_abandoned),
      genstudio_jobs: structuredClone(jq.getJob(source.job_id)?.genstudio_jobs),
      output_lines: structuredClone(jq.getJob(source.job_id)?.output_lines),
    }
    await assert.rejects(
      enqueue({ ...opts, type: 'research_run' }, criteria(source.job_id)),
      (error: any) => error?.status === 409 && /destination/i.test(error.message),
    )
    await assert.rejects(
      enqueue({ ...opts, episode_id: 'EP9999' }, criteria(source.job_id)),
      (error: any) => error?.status === 409 && /destination/i.test(error.message),
    )
    await assert.rejects(
      enqueue(opts, {
        ...criteria(source.job_id),
        resource: { kind: 'custom', identity: 'wrong-resource', matches: () => false },
      }),
      (error: any) => error?.status === 409 && /binding|resource/i.test(error.message),
    )
    assert.deepEqual({
      force_abandoned: jq.getJob(source.job_id)?.force_abandoned,
      genstudio_jobs: jq.getJob(source.job_id)?.genstudio_jobs,
      output_lines: jq.getJob(source.job_id)?.output_lines,
    }, sourceBeforeRefusals, 'losing replay scopes cannot mutate the selected source')

    await assert.rejects(
      enqueue({ ...opts, params: actionParams(source.job_id, actionId, 'different-writer') }, criteria(source.job_id)),
      (error: any) => error?.status === 409 && /operation_id|action/i.test(error.message),
    )

    const distinct = await enqueue({
      ...opts,
      params: actionParams(source.job_id, '33333333-3333-4333-8333-333333333333'),
    }, criteria(source.job_id))
    assert.notEqual(distinct.job_id, first.job_id)
  } finally {
    restore()
  }
})

test('accepted replay survives source settlement and history removal without making another job', async () => {
  const project = await pm.createProject({ name: 'Manual redo immutable replay' })
  const episodeId = 'EP0009'
  const source = await stoppedSource(project.slug, episodeId)
  const restore = jq._setExecutorForTesting('idea_campaign', async () => {})
  try {
    const actionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const opts = {
      project_slug: project.slug,
      type: 'idea_campaign' as const,
      episode_id: episodeId,
      params: actionParams(source.job_id, actionId),
    }
    const enqueue = enqueueManualGenerationRedo()
    const accepted = await enqueue(opts, criteria(source.job_id))
    await waitFor(() => jq.getJob(accepted.job_id)?.status === 'done', { label: 'accepted replacement to finish' })

    await jq.recordGenStudioJob(source.job_id, {
      id: source.genstudio_jobs![0]!.id,
      operation: 'chat.response',
      state: 'succeeded',
      updated_at: new Date().toISOString(),
    })
    const settledReplay = await enqueue(opts, {
      ...criteria(source.job_id),
      hasCurrentEvidence: () => false,
    })
    assert.equal(settledReplay.job_id, accepted.job_id)

    assert.equal(jq.removeTerminalJob(project.slug, source.job_id), true)
    assert.equal(jq.getJob(source.job_id), null)
    const removedReplay = await enqueue(opts, {
      ...criteria(source.job_id),
      hasCurrentEvidence: () => false,
    })
    assert.equal(removedReplay.job_id, accepted.job_id)
    const actionJobs = await jq.findJobs(project.slug, job => job.params?.generation_action?.id === actionId)
    assert.equal(actionJobs.length, 1)
  } finally {
    restore()
  }
})

test('accepted custom-resource replay uses its stable key, not its mutable matcher or evidence predicate', async () => {
  const project = await pm.createProject({ name: 'Manual redo custom replay binding' })
  const episodeId = 'EP0010'
  const source = await stoppedSource(project.slug, episodeId)
  const restore = jq._setExecutorForTesting('idea_campaign', async () => {})
  try {
    const actionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const opts = {
      project_slug: project.slug,
      type: 'idea_campaign' as const,
      episode_id: episodeId,
      params: actionParams(source.job_id, actionId),
    }
    const acceptedCriteria: import('../services/job-queue.js').ManualGenerationRedoSourceCriteria = {
      ...criteria(source.job_id),
      resource: { kind: 'custom', identity: 'scene:12', matches: () => true },
    }
    const enqueue = enqueueManualGenerationRedo()
    const accepted = await enqueue(opts, acceptedCriteria)
    await waitFor(() => jq.getJob(accepted.job_id)?.status === 'done', { label: 'custom replacement to finish' })
    assert.deepEqual(jq.getJob(accepted.job_id)?.params?.generation_action?.manual_redo_binding, {
      version: 1,
      source_type: 'idea_campaign',
      operation: 'chat.response',
      resource_kind: 'custom',
      resource_identity: 'scene:12',
      destination_type: 'idea_campaign',
      destination_episode_id: episodeId,
    }, 'the accepted job stores its trusted custom-resource binding')

    const replay = await enqueue(opts, {
      ...acceptedCriteria,
      resource: { kind: 'custom', identity: 'scene:12', matches: () => false },
      hasCurrentEvidence: () => false,
    })
    assert.equal(replay.job_id, accepted.job_id)

    await assert.rejects(enqueue(opts, {
      ...acceptedCriteria,
      resource: { kind: 'custom', identity: 'scene:13', matches: () => true },
    }), (error: any) => error?.status === 409 && /resource|binding|action/i.test(error.message))
    const actionJobs = await jq.findJobs(project.slug, job => job.params?.generation_action?.id === actionId)
    assert.equal(actionJobs.length, 1)
  } finally {
    restore()
  }
})

test('missing or mismatched fresh linkage is refused before the source changes', async () => {
  const project = await pm.createProject({ name: 'Manual redo trusted linkage' })
  const episodeId = 'EP0003'
  const source = await stoppedSource(project.slug, episodeId)
  const base = {
    project_slug: project.slug,
    type: 'idea_campaign' as const,
    episode_id: episodeId,
    title: 'invalid replacement',
  }
  const enqueue = enqueueManualGenerationRedo()

  await assert.rejects(enqueue({ ...base, params: {} }, criteria(source.job_id)), /fresh generation action/i)
  await assert.rejects(enqueue({
    ...base,
    params: actionParams('different-source', '44444444-4444-4444-8444-444444444444'),
  }, criteria(source.job_id)), /source job/i)
  assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined)
})

test('project, type, episode, resource, terminal state, operation, and current evidence are all mandatory', async () => {
  const project = await pm.createProject({ name: 'Manual redo source criteria' })
  const otherProject = await pm.createProject({ name: 'Manual redo wrong project' })
  const episodeId = 'EP0007'
  const source = await stoppedSource(project.slug, episodeId)
  const enqueue = enqueueManualGenerationRedo()
  const actionIds = [
    '77777777-7777-4777-8777-777777777777',
    '88888888-8888-4888-8888-888888888888',
    '99999999-9999-4999-8999-999999999999',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  ]
  const attempt = (
    projectSlug: string,
    destinationEpisode: string,
    sourceCriteria: import('../services/job-queue.js').ManualGenerationRedoSourceCriteria,
  ) => enqueue({
    project_slug: projectSlug,
    type: 'idea_campaign',
    episode_id: destinationEpisode,
    params: actionParams(source.job_id, actionIds.shift()!),
  }, sourceCriteria)

  await assert.rejects(attempt(otherProject.slug, episodeId, criteria(source.job_id)), /not found in this project/i)
  await assert.rejects(attempt(project.slug, episodeId, criteria(source.job_id, 'research_run')), /same episode and resource/i)
  await assert.rejects(attempt(project.slug, 'EP9999', criteria(source.job_id)), /same episode and resource/i)
  await assert.rejects(attempt(project.slug, episodeId, {
    ...criteria(source.job_id),
    resource: { kind: 'custom', identity: 'never-matches', matches: () => false },
  }), /same episode and resource/i)
  await assert.rejects(attempt(project.slug, episodeId, {
    ...criteria(source.job_id),
    operation: 'image.generation',
  }), /no unresolved Gateway chat request/i)
  await assert.rejects(attempt(project.slug, episodeId, {
    ...criteria(source.job_id),
    hasCurrentEvidence: () => false,
  }), /no unresolved Gateway chat request/i)
  assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined)

  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const restore = jq._setExecutorForTesting('research_run', async job => {
    await jq.recordGenStudioJob(job.job_id, {
      id: `provider-${job.job_id}`,
      operation: 'chat.response',
      state: 'running',
      updated_at: new Date().toISOString(),
    })
    await held
  })
  let runningId = ''
  try {
    const running = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'research_run',
      episode_id: 'EP0008',
      params: { auto_retry: false },
    })
    runningId = running.job_id
    await waitFor(() => jq.getJob(running.job_id)?.genstudio_jobs?.length === 1, { label: 'running source evidence' })
    await assert.rejects(enqueue({
      project_slug: project.slug,
      type: 'idea_campaign',
      episode_id: 'EP0008',
      params: actionParams(running.job_id, '99999999-9999-4999-8999-999999999999'),
    }, criteria(running.job_id, 'research_run')), /must be a stopped/i)
  } finally {
    release()
    if (runningId) await waitFor(() => !jq._isJobWorkerActiveForTesting(runningId), { label: 'running source to finish' })
    restore()
  }
})

test('an occupied destination and an unwinding source both lose without mutating source evidence', async () => {
  const project = await pm.createProject({ name: 'Manual redo losing admission' })
  const episodeId = 'EP0004'
  const source = await stoppedSource(project.slug, episodeId, 'research_run')
  let releaseBlocker!: () => void
  const blocker = new Promise<void>(resolve => { releaseBlocker = resolve })
  const restoreDestination = jq._setExecutorForTesting('idea_campaign', async () => blocker)
  let occupyingJobId = ''
  try {
    const occupying = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'idea_campaign',
      episode_id: episodeId,
      title: 'active destination',
      params: { auto_retry: false },
    })
    occupyingJobId = occupying.job_id
    await waitFor(() => jq.getJob(occupying.job_id)?.status === 'running', { label: 'destination blocker to start' })
    await assert.rejects(enqueueManualGenerationRedo()({
      project_slug: project.slug,
      type: 'idea_campaign',
      episode_id: episodeId,
      params: actionParams(source.job_id, '55555555-5555-4555-8555-555555555555'),
    }, criteria(source.job_id, 'research_run')), /already|queued|running/i)
    assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined)
  } finally {
    releaseBlocker()
    if (occupyingJobId) await waitFor(() => !jq._isJobWorkerActiveForTesting(occupyingJobId), {
      label: 'destination blocker to unwind',
    })
    restoreDestination()
  }

  const activeEpisode = 'EP0005'
  let releaseSource!: () => void
  const heldSource = new Promise<void>(resolve => { releaseSource = resolve })
  const restoreSource = jq._setExecutorForTesting('research_run', async job => {
    await jq.recordGenStudioJob(job.job_id, {
      id: `provider-${job.job_id}`,
      operation: 'chat.response',
      state: 'running',
      dispatch_state: 'dispatched',
      cancellable: true,
      updated_at: new Date().toISOString(),
    })
    job.status = 'error'
    job.error = 'stopped but executor is unwinding'
    await heldSource
  })
  const restoreReplacement = jq._setExecutorForTesting('idea_campaign', async () => {})
  let activeSourceJobId = ''
  try {
    const active = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'research_run',
      episode_id: activeEpisode,
      params: { auto_retry: false },
    })
    activeSourceJobId = active.job_id
    await waitFor(() => jq.getJob(active.job_id)?.status === 'error' && jq._isJobWorkerActiveForTesting(active.job_id), {
      label: 'source to reach terminal status while its worker unwinds',
    })
    await assert.rejects(enqueueManualGenerationRedo()({
      project_slug: project.slug,
      type: 'idea_campaign',
      episode_id: activeEpisode,
      params: actionParams(active.job_id, '66666666-6666-4666-8666-666666666666'),
    }, criteria(active.job_id, 'research_run')), /still finishing|releases/i)
    assert.equal(jq.getJob(active.job_id)?.force_abandoned, undefined)
  } finally {
    releaseSource()
    if (activeSourceJobId) await waitFor(() => !jq._isJobWorkerActiveForTesting(activeSourceJobId), {
      label: 'source worker to finish unwinding',
    })
    restoreSource()
    restoreReplacement()
  }
})
