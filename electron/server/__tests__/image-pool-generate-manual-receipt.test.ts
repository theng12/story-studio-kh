import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

void test('the actual Image Pool generator leaves an accepted receipt the manual route can verify', async () => {
  const isolated = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  let jq: typeof import('../services/job-queue.js') | null = null
  let projectSlug = ''
  let restoreProvider: (() => void) | null = null
  try {
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init)
      if (String(input).startsWith(`${service.baseUrl}/v1/image/models`)
        && response.headers.get('content-type')?.includes('application/json')) {
        const rows = await response.clone().json() as Array<Record<string, any>>
        return Response.json(rows.map(row => ({
          ...row,
          chargeable: true,
          credits_per_image: 3,
          minimum_credits: 3,
          price_version: 'mock-image-model-price-v1',
          output_options: row.output_options.map((option: Record<string, unknown>) => ({
            ...option,
            credits_per_image: 3,
            price_version: 'mock-image-output-price-v1',
          })),
        })))
      }
      return response
    }
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const pm = await import('../services/project-manager.js')
    const pools = await import('../services/broll-pool-manager.js')
    const manifests = await import('../services/task-manifest.js')
    const compression = await import('../services/generation-compression.js')
    const registryModule = await import('../providers/registry.js')
    await import('../providers/image/genstudio.js')
    jq = await import('../services/job-queue.js')
    const app = (await import('../app.js')).app

    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    await compression.setGlobalCompression({ image_pool: true })
    client.clearGenStudioCatalogCache()
    await jq.setQueuePaused(true)

    const project = await pm.createProject({ name: 'Image Pool produced receipt' })
    projectSlug = project.slug
    const realProvider = registryModule.registry.getImageProvider('genstudio-image')!
    restoreProvider = () => registryModule.registry.registerImage(realProvider)
    let produced: ReturnType<typeof jq.getJob> = null
    let acceptedTaskId = ''
    registryModule.registry.registerImage({
      ...realProvider,
      generateImage: async providerRequest => {
        assert.ok(produced)
        const requestKey = providerRequest.idempotencyKey || ''
        assert.match(requestKey, /^story-image-/)
        assert.equal(providerRequest.outputFormat, 'jpeg', 'the actual producer submits the enabled nondefault output format')
        await providerRequest.onJobAccepted?.(acceptedTaskId, requestKey)
        produced.genstudio_jobs = [{
          id: acceptedTaskId,
          operation: 'image.generation',
          state: 'accepted',
          request_key: requestKey,
          updated_at: new Date().toISOString(),
        }]
        throw new Error('mock transport lost the response after provider acceptance')
      },
    })

    const { generateImagePoolImages } = await import('../generators/image-pool-generate.js')
    const produce = async (runId: string, resolution: string | undefined) => {
      const folder = path.join(isolated.dir, runId)
      await fs.mkdir(folder, { recursive: true })
      const pool = await pools.createPool({ name: runId, folder_path: folder, media: 'image' })
      const source = await jq!.enqueue({
        project_slug: project.slug,
        type: 'image_pool_generate',
        episode_id: pool.id,
        title: 'Image Pool lost acceptance response',
        params: {
          pool_id: pool.id,
          prompts: ['A lantern beside a rain-streaked archive window.'],
          model: 'mock-image-v1',
          aspect_ratio: '16:9',
          ...(resolution ? { resolution } : {}),
          seed: 17,
          variants: 1,
          run_id: runId,
        },
      })
      await jq!.pauseJob(source.job_id)
      produced = jq!.getJob(source.job_id)!
      produced.status = 'running'
      produced.started_at = new Date().toISOString()
      acceptedTaskId = `accepted-${runId}`

      await assert.rejects(generateImagePoolImages(produced), /incomplete/i)
      const itemKey = `gen-${runId}-0001.png`
      const manifest = await manifests.readManifestStrict(folder)
      assert.equal(manifest.tasks[itemKey]?.last_state, 'accepted')
      assert.equal(produced.params.genstudio_recovery?.assets?.[itemKey]?.state, 'accepted')
      const receipt = produced.params.image_pool_generation_receipts?.items?.[itemKey]
      assert.equal(receipt?.output_format, 'jpeg')
      assert.equal(receipt?.idempotency_key, manifest.tasks[itemKey]?.idempotency_key)
      assert.equal(receipt?.input_hash, manifest.tasks[itemKey]?.input_hash)

      await jq!.mutateAuthoritativeJob(project.slug, source.job_id, current => {
        current.status = 'error'
        current.error = 'The response was lost after provider acceptance.'
        current.finished_at = new Date().toISOString()
        current.params = structuredClone(produced!.params)
        current.genstudio_jobs = structuredClone(produced!.genstudio_jobs)
        return current
      })

      const summary = await request(app)
        .get(`/api/projects/${project.slug}/image-pool/manual-redo-sources`)
        .query({ pool_id: pool.id })
      assert.equal(summary.status, 200, JSON.stringify(summary.body))
      assert.deepEqual(summary.body.sources.map((row: any) => row.item_key), [itemKey],
        'the route accepts the exact receipt emitted by the real generator producer')
      return { pool, source, itemKey, receipt }
    }

    const explicit = await produce('produced-explicit-run', '1K')
    assert.equal(explicit.receipt?.resolution, '1K')
    const omitted = await produce('produced-default-run', undefined)
    assert.equal(omitted.receipt?.requested_resolution, undefined,
      'raw omission remains distinct from the resolved provider row')
    assert.equal(omitted.receipt?.resolution, '1K', 'the published default row is durable without a later catalogue read')

    const sourceSummary = async () => request(app)
      .get(`/api/projects/${project.slug}/image-pool/manual-redo-sources`)
      .query({ pool_id: omitted.pool.id })
    await jq.mutateAuthoritativeJob(project.slug, omitted.source.job_id, current => {
      current.params.resolution = '1K'
      return current
    })
    assert.deepEqual((await sourceSummary()).body.sources, [],
      'adding an explicit selector later cannot restate an originally omitted request')
    await jq.mutateAuthoritativeJob(project.slug, omitted.source.job_id, current => {
      delete current.params.resolution
      current.params.image_pool_generation_receipts.items[omitted.itemKey].resolution = '2K'
      return current
    })
    assert.deepEqual((await sourceSummary()).body.sources, [],
      'changing the durable effective provider row breaks the original request proof')
    await jq.mutateAuthoritativeJob(project.slug, omitted.source.job_id, current => {
      current.params.image_pool_generation_receipts.items[omitted.itemKey].resolution = '1K'
      return current
    })
    assert.deepEqual((await sourceSummary()).body.sources.map((row: any) => row.item_key), [omitted.itemKey])

    const models = await client.listImageModels(MOCK_GENSTUDIO_FULL_KEY)
    const model = models.find(candidate => candidate.id === 'mock-image-v1')!
    const row = model.output_options!.find(candidate => candidate.resolution === '1K' && candidate.aspect_ratio === '16:9')!
    const admitted = await request(app)
      .post(`/api/projects/${project.slug}/image-pool/generate`)
      .send({
        pool_id: omitted.pool.id,
        model: model.id,
        aspect_ratio: '16:9',
        resolution: '1K',
        seed: 17,
        variants: 1,
        operation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        source_item_key: omitted.itemKey,
        manual_redo: { intent: 'replace_unresolved', source_job_id: omitted.source.job_id },
        manual_image_payment: {
          version: 1,
          model_id: model.id,
          model_price_version: model.price_version,
          output_resolution: row.resolution,
          output_aspect_ratio: row.aspect_ratio,
          output_price_version: row.price_version,
          confirmed_paid_image: true,
        },
      })
    assert.equal(admitted.status, 201, JSON.stringify(admitted.body))
    assert.equal(service.providerSubmissionCount('image'), 0,
      'the stubbed acceptance boundary never calls the mock provider HTTP submit')
  } finally {
    restoreProvider?.()
    if (jq && projectSlug) {
      const jobs = await jq.findJobs(projectSlug, () => true).catch(() => [])
      for (const job of jobs) {
        if (job.status === 'queued' || job.status === 'running') await jq.pauseJob(job.job_id)
      }
      await jq._waitForJobPersistenceForTesting()
      await jq.setQueuePaused(false)
      await jq._waitForJobPersistenceForTesting()
    }
    globalThis.fetch = originalFetch
    await service.close()
    await isolated.cleanup()
  }
})
