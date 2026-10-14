import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import { once } from 'node:events'
import path from 'node:path'
import test from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY } from './fixtures/mock-genstudio-service.js'

void test('Image Pool replaces one exact unresolved item in a fresh server-owned namespace', async t => {
  const isolated = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  let providerPosts = 0
  let modelPriceVersion = 'model-price-v1'
  let rowPriceVersion = 'row-price-v1'
  let maxPromptCharacters = 4_800
  let minReferenceImages = 0
  let catalogBarrier: { entered: () => void; wait: Promise<void> } | null = null
  const catalogServer = http.createServer(async (catalogRequest, response) => {
    if (catalogRequest.method === 'GET' && catalogRequest.url === '/v1/image/models') {
      const barrier = catalogBarrier as { entered: () => void; wait: Promise<void> } | null
      barrier?.entered()
      if (barrier) await barrier.wait
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify([{
        id: 'mock-image-v1', display_name: 'Mock Image', available: true, qualification_only: false,
        chargeable: true, credits_per_image: 3, minimum_credits: 3, price_version: modelPriceVersion,
        price_source: 'local', price_usd: { image: 0.03 },
        aspect_ratios: ['16:9'], default_aspect_ratio: '16:9', default_resolution: '1K',
        output_options: [{
          resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, is_default: true,
          credits_per_image: 3, price_version: rowPriceVersion,
        }],
        supports_seed: true, supports_reference_images: false, max_reference_images: 0,
        min_reference_images: minReferenceImages, max_prompt_characters: maxPromptCharacters,
        reference_strength_mode: 'none', supported_reference_strengths: [], operations: ['image.generation'],
      }]))
      return
    }
    if (catalogRequest.method === 'POST') providerPosts += 1
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ detail: 'Unexpected mock route' }))
  })
  catalogServer.listen(0, '127.0.0.1')
  await once(catalogServer, 'listening')
  const address = catalogServer.address()
  assert.ok(address && typeof address !== 'string')
  const catalogBaseUrl = `http://127.0.0.1:${address.port}`
  let cleanupQueue: typeof import('../services/job-queue.js') | null = null
  let projectSlug = ''
  try {
    const jq = await import('../services/job-queue.js')
    cleanupQueue = jq
    const app = (await import('../app.js')).app
    const pm = await import('../services/project-manager.js')
    const bp = await import('../services/broll-pool-manager.js')
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const manifests = await import('../services/task-manifest.js')
    const client = await import('../lib/genstudio-client.js')
    const paidImages = await import('../services/image-paid-replacement.js')
    const imagePoolGenerator = await import('../generators/image-pool-generate.js')

    await settings.setGenStudioUrl(catalogBaseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await jq.setQueuePaused(true)

    const project = await pm.createProject({ name: 'Image Pool manual redo fixture' })
    projectSlug = project.slug
    const poolFolder = path.join(isolated.dir, 'manual-redo-image-pool')
    await fs.mkdir(poolFolder, { recursive: true })
    const pool = await bp.createPool({ name: 'Manual redo stills', folder_path: poolFolder, media: 'image' })
    const retainedPath = path.join(poolFolder, 'customer-rated-existing.png')
    await fs.writeFile(retainedPath, 'existing image bytes stay untouched')

    const sourceRunId = 'source-run'
    const sourcePrompts = ['First unresolved prompt.', 'Second unresolved prompt.']
    const source = await jq.enqueue({
      project_slug: project.slug,
      type: 'image_pool_generate',
      episode_id: pool.id,
      title: 'Stopped source Image Pool run',
      params: {
        pool_id: pool.id,
        prompts: [...sourcePrompts],
        model: 'mock-image-v1',
        aspect_ratio: '16:9',
        resolution: '1K',
        seed: 91,
        variants: 1,
        run_id: sourceRunId,
      },
    })
    await jq.pauseJob(source.job_id)

    const itemKeys = sourcePrompts.map((_, index) => `gen-${sourceRunId}-${String(index + 1).padStart(4, '0')}.png`)
    const taskIds = ['source-image-task-1', 'source-image-task-2']
    const selector = {
      resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, reference_mode: 'normal' as const,
    }
    const identities = sourcePrompts.map(prompt => paidImages.buildPaidImageOriginalIdentity({
      prompt, selector, references: [], baseScope: `run:${sourceRunId}`,
    }))
    const inputHashes = identities.map(identity => identity.inputHash)
    const requestKeys = sourcePrompts.map((prompt, index) => client.buildGenStudioImageIdempotencyKey({
      prompt,
      modelId: 'mock-image-v1',
      aspectRatio: '16:9',
      resolution: '1K',
      seed: 91,
      requestIdentity: `image-pool:${pool.id}:${sourceRunId}:${itemKeys[index]}:${identities[index]!.requestScope}`,
    }))
    const preparedReceipts = Object.fromEntries(sourcePrompts.map((prompt, index) => [itemKeys[index]!,
      imagePoolGenerator.buildImagePoolPreparedReceipt({
        itemKey: itemKeys[index]!,
        promptIndex: index,
        variantIndex: 0,
        runId: sourceRunId,
        variants: 1,
        model: 'mock-image-v1',
        providerModelId: 'mock-image-v1',
        prompt,
        aspectRatio: '16:9',
        requestedResolution: '1K',
        resolution: '1K',
        seed: 91,
        selector,
        baseScope: `run:${sourceRunId}`,
        generationIdentity: `image-pool:${pool.id}:${sourceRunId}`,
      }),
    ]))
    for (let index = 0; index < itemKeys.length; index += 1) {
      await manifests.recordTaskStrict(poolFolder, itemKeys[index]!, {
        provider: 'mock-image',
        task_id: taskIds[index]!,
        submitted_at: '2026-10-14T00:00:00.000Z',
        input_hash: inputHashes[index],
        idempotency_key: requestKeys[index],
        request_scope: identities[index]!.requestScope,
        operation: 'image',
        last_state: 'accepted',
        original_output_selector: selector,
        original_reference_inputs: [],
        original_reference_identity_hash: identities[index]!.referenceIdentityHash,
        original_output_path: path.join(poolFolder, itemKeys[index]!),
      })
    }
    await jq.mutateAuthoritativeJob(project.slug, source.job_id, current => {
      current.status = 'error'
      current.error = 'The local process stopped before either accepted image settled.'
      current.finished_at = '2026-10-14T00:01:00.000Z'
      current.params.genstudio_recovery = {
        version: 1,
        route: 'genstudio',
        assets: Object.fromEntries(itemKeys.map((itemKey, index) => [itemKey, {
          operation: 'image',
          job_id: taskIds[index],
          idempotency_key: requestKeys[index],
          input_hash: inputHashes[index],
          output_path: path.join(poolFolder, itemKey),
          state: 'accepted',
          updated_at: '2026-10-14T00:00:30.000Z',
        }])),
      }
      current.params.image_pool_generation_receipts = { version: 1, items: preparedReceipts }
      current.genstudio_jobs = taskIds.map((taskId, index) => ({
        id: taskId,
        operation: 'image.generation' as const,
        state: 'accepted',
        request_key: requestKeys[index],
        updated_at: '2026-10-14T00:00:30.000Z',
      }))
      return current
    })

    const summary = await request(app)
      .get(`/api/projects/${project.slug}/image-pool/manual-redo-sources`)
      .query({ pool_id: pool.id })
    assert.equal(summary.status, 200, JSON.stringify(summary.body))
    assert.equal(summary.body.sources.length, 2, 'both unresolved items remain separately recoverable')
    assert.deepEqual(
      summary.body.sources.map((candidate: any) => candidate.item_key).sort(),
      [...itemKeys].sort(),
    )
    const publicSummary = JSON.stringify(summary.body)
    for (const privateValue of [...taskIds, ...requestKeys, ...inputHashes, ...sourcePrompts, poolFolder]) {
      assert.doesNotMatch(publicSummary, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }

    const manualBody = (operationId: string, itemKey = itemKeys[0]!) => ({
      pool_id: pool.id,
      model: 'mock-image-v1',
      aspect_ratio: '16:9',
      resolution: '1K',
      seed: 13,
      variants: 2,
      run_id: sourceRunId,
      operation_id: operationId,
      source_item_key: itemKey,
      manual_redo: { intent: 'replace_unresolved', source_job_id: source.job_id },
      manual_image_payment: {
        version: 1,
        model_id: 'mock-image-v1',
        model_price_version: 'model-price-v1',
        output_resolution: '1K',
        output_aspect_ratio: '16:9',
        output_price_version: 'row-price-v1',
        confirmed_paid_image: true,
      },
    })

    const settleUnexpectedAdmission = async (operationId: string): Promise<void> => {
      const admitted = (await jq.findJobs(project.slug,
        job => job.params?.generation_action?.id === operationId))[0]
      if (!admitted) return
      await jq.pauseJob(admitted.job_id)
      await jq.mutateAuthoritativeJob(project.slug, admitted.job_id, current => {
        current.status = 'done'
        current.finished_at = new Date().toISOString()
        return current
      })
    }

    for (const [label, mutate] of [
      ['prompt', (params: any) => { params.prompts[0] = 'A different prompt that owns no saved receipt.' }],
      ['model', (params: any) => { params.model = 'another-image-model' }],
      ['ratio', (params: any) => { params.aspect_ratio = '1:1' }],
      ['resolution', (params: any) => { params.resolution = '2K' }],
      ['seed', (params: any) => { params.seed = 92 }],
    ] as const) {
      await t.test(`saved ${label} must still reproduce the original provider receipt`, async () => {
        await jq.mutateAuthoritativeJob(project.slug, source.job_id, current => {
          mutate(current.params)
          return current
        })
        try {
          const response = await request(app)
            .get(`/api/projects/${project.slug}/image-pool/manual-redo-sources`)
            .query({ pool_id: pool.id })
          assert.equal(response.status, 200)
          assert.equal(response.body.sources.some((candidate: any) => candidate.item_key === itemKeys[0]), false,
            `a changed ${label} cannot be linked to the original paid request`)
        } finally {
          await jq.mutateAuthoritativeJob(project.slug, source.job_id, current => {
            current.params.prompts = [...sourcePrompts]
            current.params.model = 'mock-image-v1'
            current.params.aspect_ratio = '16:9'
            current.params.resolution = '1K'
            current.params.seed = 91
            return current
          })
        }
      })
    }

    await t.test('legacy evidence without reconstructible original request facts is ineligible', async () => {
      const manifestPath = path.join(poolFolder, '.task-manifest.json')
      const original = await fs.readFile(manifestPath, 'utf8')
      const legacy = JSON.parse(original)
      delete legacy.tasks[itemKeys[0]].original_output_selector
      delete legacy.tasks[itemKeys[0]].original_reference_inputs
      delete legacy.tasks[itemKeys[0]].original_reference_identity_hash
      delete legacy.tasks[itemKeys[0]].original_output_path
      await fs.writeFile(manifestPath, JSON.stringify(legacy))
      try {
        const response = await request(app)
          .get(`/api/projects/${project.slug}/image-pool/manual-redo-sources`)
          .query({ pool_id: pool.id })
        assert.equal(response.status, 200)
        assert.equal(response.body.sources.some((candidate: any) => candidate.item_key === itemKeys[0]), false)
      } finally {
        await fs.writeFile(manifestPath, original)
      }
    })

    await t.test('paid Image confirmation receipt is mandatory before source abandonment', async () => {
      const operationId = '44444444-4444-4444-8444-444444444444'
      try {
        const body: any = manualBody(operationId)
        delete body.manual_image_payment
        const response = await request(app)
          .post(`/api/projects/${project.slug}/image-pool/generate`)
          .send(body)
        assert.equal(response.status, 409, JSON.stringify(response.body))
        assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined)
      } finally {
        await settleUnexpectedAdmission(operationId)
      }
    })

    await t.test('server refuses a model or output-row price version newer than the detached confirmation', async () => {
      for (const [field, next] of [['model', 'model-price-v2'], ['row', 'row-price-v2']] as const) {
        const operationId = field === 'model'
          ? '55555555-5555-4555-8555-555555555555'
          : '66666666-6666-4666-8666-666666666666'
        if (field === 'model') modelPriceVersion = next
        else rowPriceVersion = next
        client.clearGenStudioCatalogCache()
        try {
          const response = await request(app)
            .post(`/api/projects/${project.slug}/image-pool/generate`)
            .send(manualBody(operationId))
          assert.equal(response.status, 409, `${field}: ${JSON.stringify(response.body)}`)
        } finally {
          await settleUnexpectedAdmission(operationId)
          modelPriceVersion = 'model-price-v1'
          rowPriceVersion = 'row-price-v1'
          client.clearGenStudioCatalogCache()
        }
      }
    })

    await t.test('selected model prompt cap refuses the copied prompt before source abandonment', async () => {
      const operationId = '88888888-8888-4888-8888-888888888888'
      maxPromptCharacters = sourcePrompts[0]!.trim().length - 1
      client.clearGenStudioCatalogCache()
      try {
        const response = await request(app)
          .post(`/api/projects/${project.slug}/image-pool/generate`)
          .send(manualBody(operationId))
        assert.equal(response.status, 409, JSON.stringify(response.body))
        assert.match(response.body.detail, /prompt.*character/i)
        assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined)
        assert.equal((await jq.findJobs(project.slug, job => job.params?.generation_action?.id === operationId)).length, 0)
        assert.equal(providerPosts, 0)
      } finally {
        maxPromptCharacters = 4_800
        client.clearGenStudioCatalogCache()
        await settleUnexpectedAdmission(operationId)
      }
    })

    await t.test('a reference-required selected model refuses the no-reference lane before abandonment', async () => {
      const operationId = '99999999-9999-4999-8999-999999999999'
      minReferenceImages = 1
      client.clearGenStudioCatalogCache()
      try {
        const response = await request(app)
          .post(`/api/projects/${project.slug}/image-pool/generate`)
          .send(manualBody(operationId))
        assert.equal(response.status, 409, JSON.stringify(response.body))
        assert.match(response.body.detail, /reference image/i)
        assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined)
        assert.equal((await jq.findJobs(project.slug, job => job.params?.generation_action?.id === operationId)).length, 0)
        assert.equal(providerPosts, 0)
      } finally {
        minReferenceImages = 0
        client.clearGenStudioCatalogCache()
        await settleUnexpectedAdmission(operationId)
      }
    })

    const ambiguous = await request(app)
      .post(`/api/projects/${project.slug}/image-pool/generate`)
      .send({ ...manualBody('11111111-1111-4111-8111-111111111111'), source_item_key: undefined })
    assert.equal(ambiguous.status, 409, JSON.stringify(ambiguous.body))
    assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined)

    const manifestBefore = await manifests.readManifestStrict(poolFolder)
    const firstAction = '22222222-2222-4222-8222-222222222222'
    const [first, replay] = await Promise.all([
      request(app).post(`/api/projects/${project.slug}/image-pool/generate`).send(manualBody(firstAction)),
      request(app).post(`/api/projects/${project.slug}/image-pool/generate`).send(manualBody(firstAction)),
    ])
    assert.deepEqual([first.status, replay.status].sort(), [200, 201], `${JSON.stringify(first.body)} ${JSON.stringify(replay.body)}`)
    assert.equal(first.body.job_id, replay.body.job_id, 'same action admits one destination')

    const replacement = jq.getJob(first.body.job_id)!
    assert.equal(replacement.params.run_id, `manual-${firstAction}`)
    assert.notEqual(replacement.params.run_id, sourceRunId, 'caller/source namespace cannot be reused')
    assert.deepEqual(replacement.params.prompts, [sourcePrompts[0]], 'server copies only the selected source item prompt')
    assert.equal(replacement.params.variants, 2, 'current explicitly confirmed variant count remains in the new namespace')
    assert.equal(replacement.params.manual_redo.source_job_id, source.job_id)
    assert.equal(replacement.params.manual_redo.source_item_key, itemKeys[0])
    assert.equal(JSON.stringify(replacement.params.manual_redo).includes(requestKeys[0]!), false, 'provider request key stays private')
    assert.deepEqual(replacement.params.manual_redo.published_price, {
      model_id: 'mock-image-v1',
      model_price_version: 'model-price-v1',
      model_credits_per_image: 3,
      output_price_version: 'row-price-v1',
      output_credits_per_image: 3,
    }, 'the real catalogue parser carries the published charge and selected output-row price into admission')

    const retainedSource = jq.getJob(source.job_id)!
    assert.ok(retainedSource.force_abandoned, 'source changes only after the replacement wins admission')
    assert.deepEqual(retainedSource.genstudio_jobs?.map(entry => entry.id), taskIds, 'all source provider evidence remains')
    assert.deepEqual(await manifests.readManifestStrict(poolFolder), manifestBefore, 'all source item manifests remain')
    assert.equal(await fs.readFile(retainedPath, 'utf8'), 'existing image bytes stay untouched')

    const sourcesAfterAdmission = await request(app)
      .get(`/api/projects/${project.slug}/image-pool/manual-redo-sources`)
      .query({ pool_id: pool.id })
    assert.equal(sourcesAfterAdmission.status, 200, JSON.stringify(sourcesAfterAdmission.body))
    assert.deepEqual(
      sourcesAfterAdmission.body.sources.map((candidate: any) => candidate.item_key).sort(),
      [...itemKeys].sort(),
      'force-abandon keeps both the selected item and its sibling eligible while their exact source evidence remains unresolved',
    )

    const changedItem = await request(app)
      .post(`/api/projects/${project.slug}/image-pool/generate`)
      .send(manualBody(firstAction, itemKeys[1]))
    assert.equal(changedItem.status, 409, JSON.stringify(changedItem.body))

    await jq.pauseJob(replacement.job_id)
    await jq.mutateAuthoritativeJob(project.slug, replacement.job_id, current => {
      current.status = 'done'
      current.progress = 100
      current.finished_at = '2026-10-14T00:02:00.000Z'
      return current
    })
    const laterExplicitAction = '33333333-3333-4333-8333-333333333333'
    const sameItemLater = await request(app)
      .post(`/api/projects/${project.slug}/image-pool/generate`)
      .send(manualBody(laterExplicitAction, itemKeys[0]))
    assert.equal(sameItemLater.status, 201, JSON.stringify(sameItemLater.body))
    assert.notEqual(sameItemLater.body.job_id, first.body.job_id, 'a new UUID is a new explicit action after the prior replacement settles')
    assert.equal(jq.getJob(sameItemLater.body.job_id)?.params.run_id, `manual-${laterExplicitAction}`)

    await t.test('a contradictory task/key row arriving during catalog validation blocks admission', async () => {
      const operationId = '77777777-7777-4777-8777-777777777777'
      let enteredCatalog!: () => void
      let releaseCatalog!: () => void
      const entered = new Promise<void>(resolve => { enteredCatalog = resolve })
      const wait = new Promise<void>(resolve => { releaseCatalog = resolve })
      catalogBarrier = { entered: enteredCatalog, wait }
      client.clearGenStudioCatalogCache()
      const posting = request(app)
        .post(`/api/projects/${project.slug}/image-pool/generate`)
        .send(manualBody(operationId))
        .then(response => response)
      try {
        let timeout: ReturnType<typeof setTimeout> | undefined
        await Promise.race([entered, new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('manual Image Pool catalog barrier was not reached')), 2_000)
        })]).finally(() => { if (timeout) clearTimeout(timeout) })
        await jq.mutateAuthoritativeJob(project.slug, source.job_id, current => {
          current.genstudio_jobs = [...(current.genstudio_jobs || []), {
            id: 'contradictory-task-for-same-key',
            operation: 'image.generation',
            state: 'accepted',
            request_key: requestKeys[0],
            updated_at: new Date().toISOString(),
          }]
          return current
        })
        releaseCatalog()
        const response = await posting
        assert.equal(response.status, 409, JSON.stringify(response.body))
      } finally {
        releaseCatalog()
        catalogBarrier = null
        await settleUnexpectedAdmission(operationId)
      }
    })

    await fs.writeFile(path.join(poolFolder, '.task-manifest.json'), '{corrupt after accepted admission')
    await secrets.setApiKey('genstudio', '')
    const adopted = await request(app)
      .post(`/api/projects/${project.slug}/image-pool/generate`)
      .send(manualBody(firstAction))
    assert.equal(adopted.status, 200, JSON.stringify(adopted.body))
    assert.equal(adopted.body.job_id, first.body.job_id, 'accepted replay bypasses mutable source, manifest and catalog reads')
    assert.equal(providerPosts, 0, 'route proof never dispatches paid image work while the queue is paused')
  } finally {
    if (cleanupQueue && projectSlug) {
      const jobs = await cleanupQueue.findJobs(projectSlug, () => true).catch(() => [])
      for (const job of jobs) {
        if (job.status === 'queued' || job.status === 'running') await cleanupQueue.pauseJob(job.job_id)
      }
      await cleanupQueue._waitForJobPersistenceForTesting()
      await cleanupQueue.setQueuePaused(false)
      await cleanupQueue._waitForJobPersistenceForTesting()
    }
    catalogServer.close()
    await once(catalogServer, 'close')
    await isolated.cleanup()
  }
})
