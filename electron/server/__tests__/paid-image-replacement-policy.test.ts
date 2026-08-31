import assert from 'node:assert/strict'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import type { Job } from '../models/types.js'
import type { TaskManifestEntry } from '../services/task-manifest.js'

const temp = await useTempDataDir()
const settings = await import('../services/app-settings.js')
const client = await import('../lib/genstudio-client.js')

const selector = (overrides: Record<string, unknown> = {}) => ({
  resolution: '1K',
  aspect_ratio: '16:9',
  width: 1280,
  height: 720,
  reference_mode: 'normal' as const,
  ...overrides,
})

const imageModel = (overrides: Record<string, unknown> = {}) => ({
  id: 'image-paid-v1',
  display_name: 'Paid image',
  available: true,
  qualification_only: false,
  chargeable: true,
  credits_per_image: 3,
  price_version: 'model-normal-v1',
  base_credits_per_image: 3,
  minimum_credits: 0,
  aspect_ratios: ['16:9'],
  default_aspect_ratio: '16:9',
  supports_reference_images: true,
  max_reference_images: 2,
  reference_strength_mode: 'none',
  supported_reference_strengths: [],
  reference_generation_credits: 8,
  reference_generation_price_version: 'model-reference-v1',
  output_options: [
    {
      resolution: '1K', aspect_ratio: '16:9', width: 1280, height: 720, is_default: true,
      credits_per_image: 4, price_version: 'normal-v1',
      reference_generation_credits: 9, reference_generation_price_version: 'reference-v1',
    },
    // Deliberately similar: each selector field must participate independently.
    {
      resolution: '1K', aspect_ratio: '16:9', width: 1280, height: 576, is_default: false,
      credits_per_image: 5, price_version: 'normal-small-v1',
      reference_generation_credits: 10, reference_generation_price_version: 'reference-small-v1',
    },
  ],
  ...overrides,
})

void test('paid image rate resolution uses one exact output row and the selected price pair', async (suite) => {
  const policy = await import('../services/image-paid-replacement.js')
  const normal = selector()
  const guided = selector({ reference_mode: 'reference-guided' as const })
  const originalNormal = { selector: normal, references: [], referenceIdentityHash: policy.sha256CanonicalJson([]) }
  const originalGuidedReferences = [
    { role: 'episode-anchor', path: '/project/reference.png', sha256: 'a'.repeat(64) },
    { role: 'style', path: '/project/style.png', sha256: 'b'.repeat(64) },
  ]
  const originalGuided = {
    selector: guided,
    references: originalGuidedReferences,
    referenceIdentityHash: policy.sha256CanonicalJson(originalGuidedReferences),
  }

  await suite.test('uses the exact normal row and never its reference fields', () => {
    const rate = policy.resolvePaidImagePublishedRate({
      models: [imageModel()], modelId: 'image-paid-v1', original: originalNormal, request: originalNormal,
    })
    assert.deepEqual(rate, { credits: 4, priceVersion: 'normal-v1', basis: 'published-rate' })
  })

  await suite.test('uses the exact reference-guided row and never its normal fields', () => {
    const rate = policy.resolvePaidImagePublishedRate({
      models: [imageModel()], modelId: 'image-paid-v1', original: originalGuided, request: originalGuided,
    })
    assert.deepEqual(rate, { credits: 9, priceVersion: 'reference-v1', basis: 'published-rate' })
  })

  await suite.test('uses the model reference pair only when that row omits both fields', () => {
    const rows = imageModel().output_options as Array<Record<string, unknown>>
    delete rows[0]!.reference_generation_credits
    delete rows[0]!.reference_generation_price_version
    const rate = policy.resolvePaidImagePublishedRate({
      models: [imageModel({ output_options: rows })], modelId: 'image-paid-v1', original: originalGuided, request: originalGuided,
    })
    assert.deepEqual(rate, { credits: 8, priceVersion: 'model-reference-v1', basis: 'published-rate' })
  })

  for (const [label, model, candidate] of [
    ['a row with a half-published reference pair', imageModel({ output_options: [{ ...imageModel().output_options[0], reference_generation_price_version: undefined }] }), originalGuided],
    ['a model with a half-published reference fallback', imageModel({ output_options: [{ ...imageModel().output_options[0], reference_generation_credits: undefined, reference_generation_price_version: undefined }], reference_generation_price_version: undefined }), originalGuided],
    ['no matching dimensions', imageModel({ output_options: [{ ...imageModel().output_options[0], width: 1281 }] }), originalNormal],
    ['no matching height', imageModel({ output_options: [{ ...imageModel().output_options[0], height: 721 }] }), originalNormal],
    ['no matching aspect ratio', imageModel({ output_options: [{ ...imageModel().output_options[0], aspect_ratio: '1:1' }] }), originalNormal],
    ['no matching resolution', imageModel({ output_options: [{ ...imageModel().output_options[0], resolution: '2K' }] }), originalNormal],
    ['duplicate matching rows', imageModel({ output_options: [imageModel().output_options[0], { ...imageModel().output_options[0] }] }), originalNormal],
    ['a missing normal pair', imageModel({ output_options: [{ ...imageModel().output_options[0], price_version: undefined }] }), originalNormal],
    ['a non-finite normal credit value', imageModel({ output_options: [{ ...imageModel().output_options[0], credits_per_image: Number.NaN }] }), originalNormal],
    ['a removed model', imageModel({ id: 'other-image' }), originalNormal],
    ['a non-chargeable model', imageModel({ chargeable: false }), originalNormal],
    ['a model with unpublished chargeability', imageModel({ chargeable: undefined }), originalNormal],
  ] as const) {
    await suite.test(`blocks ${label}`, () => {
      assert.throws(() => policy.resolvePaidImagePublishedRate({
        models: [model], modelId: 'image-paid-v1', original: candidate, request: candidate,
      }))
    })
  }

  await suite.test('blocks any selector or ordered reference identity that differs from the original request', () => {
    assert.throws(() => policy.resolvePaidImagePublishedRate({
      models: [imageModel()], modelId: 'image-paid-v1', original: originalNormal,
      request: { ...originalNormal, selector: selector({ width: 1024 }) },
    }))
    assert.throws(() => policy.resolvePaidImagePublishedRate({
      models: [imageModel()], modelId: 'image-paid-v1', original: originalGuided,
      request: { ...originalGuided, references: [...originalGuided.references].reverse() },
    }))
  })
})

void test('paid image original identity is ordered, content-addressed, and only reuses persisted prepared facts', async () => {
  const policy = await import('../services/image-paid-replacement.js')
  const root = path.join(temp.dir, 'paid-image-identity')
  const first = path.join(root, 'first.png')
  const second = path.join(root, 'second.png')
  await mkdir(root, { recursive: true })
  await writeFile(first, 'first reference')
  await writeFile(second, 'second reference')

  const references = policy.capturePaidImageReferenceIdentity(root, [
    { role: 'style', path: first },
    { role: 'character', path: second },
  ])
  const base = { prompt: 'A sunrise over Angkor Wat.', selector: selector({ reference_mode: 'reference-guided' as const }), references: references.inputs, baseScope: 'scene:42' }
  const identity = policy.buildPaidImageOriginalIdentity(base)
  assert.equal(identity.referenceIdentityHash, references.identity_hash)
  assert.match(identity.requestScope, new RegExp(references.identity_hash))
  const reorderedFacts = policy.buildPaidImageOriginalIdentity({
    prompt: base.prompt,
    baseScope: base.baseScope,
    selector: {
      height: base.selector.height,
      reference_mode: base.selector.reference_mode,
      width: base.selector.width,
      aspect_ratio: base.selector.aspect_ratio,
      resolution: base.selector.resolution,
    },
    references: references.inputs.map(reference => ({ sha256: reference.sha256, path: reference.path, role: reference.role })),
  })
  assert.deepEqual(reorderedFacts, identity, 'object key insertion order cannot alter durable identity')
  assert.equal(policy.buildPaidImageOriginalIdentity({ ...base, selector: selector({ width: 1024, reference_mode: 'reference-guided' as const }) }).inputHash === identity.inputHash, false)
  assert.equal(policy.buildPaidImageOriginalIdentity({ ...base, references: [...references.inputs].reverse() }).requestScope === identity.requestScope, false)
  assert.equal(policy.buildPaidImageOriginalIdentity({ ...base, references: [{ ...references.inputs[0]!, role: 'other' }, references.inputs[1]! ] }).inputHash === identity.inputHash, false)
  assert.equal(policy.buildPaidImageOriginalIdentity({ ...base, references: [{ ...references.inputs[0]!, path: second }, references.inputs[1]! ] }).requestScope === identity.requestScope, false)
  await writeFile(first, 'changed bytes')
  const changedReferences = policy.capturePaidImageReferenceIdentity(root, [
    { role: 'style', path: first },
    { role: 'character', path: second },
  ])
  const changedIdentity = policy.buildPaidImageOriginalIdentity({ ...base, references: changedReferences.inputs })
  assert.notEqual(changedIdentity.inputHash, identity.inputHash)
  assert.notEqual(changedIdentity.requestScope, identity.requestScope)
  await writeFile(first, 'first reference')

  const prepared = {
    provider: 'genstudio', task_id: '', submitted_at: '2026-08-31T00:00:00.000Z', operation: 'image' as const,
    last_state: 'prepared', input_hash: identity.inputHash, request_scope: identity.requestScope,
    original_output_selector: base.selector,
    original_reference_inputs: references.inputs,
    original_reference_identity_hash: references.identity_hash,
    original_output_path: path.join(root, 'out.png'),
  }
  const trustedOriginal = { prompt: base.prompt, baseScope: base.baseScope }
  const persisted = policy.readPaidImageOriginalRequest(prepared, root, trustedOriginal)
  assert.deepEqual(persisted.selector, base.selector)
  assert.deepEqual(persisted.references, references.inputs)
  assert.equal(persisted.outputPath, policy.revalidatePaidImageOutputPath(root, prepared.original_output_path))
  assert.equal(policy.capturePaidImageReferenceIdentity(root, []).identity_hash, policy.sha256CanonicalJson([]), 'normal work persists the canonical empty list')

  await writeFile(first, 'changed bytes')
  assert.throws(() => policy.readPaidImageOriginalRequest(prepared, root, trustedOriginal), /hash/i)
  await rm(second)
  assert.throws(() => policy.readPaidImageOriginalRequest(prepared, root, trustedOriginal), /missing/i)
  await assert.rejects(writeFile(path.join(temp.dir, 'outside.png'), 'outside').then(async () =>
    policy.capturePaidImageReferenceIdentity(root, [{ role: 'bad', path: path.join(temp.dir, 'outside.png') }]),
  ))

  await writeFile(second, 'second reference')
  await writeFile(first, 'first reference')
  const tamperedHash = { ...prepared, input_hash: 'sha256:0000000000000000' }
  assert.throws(() => policy.readPaidImageOriginalRequest(tamperedHash, root, trustedOriginal), /input hash/i)
  const tamperedScope = { ...prepared, request_scope: 'scene:forged' }
  assert.throws(() => policy.readPaidImageOriginalRequest(tamperedScope, root, trustedOriginal), /request scope/i)

  const outsideDir = path.join(temp.dir, 'outside-output')
  const linkedParent = path.join(root, 'linked-parent')
  await mkdir(outsideDir, { recursive: true })
  await symlink(outsideDir, linkedParent)
  const linkedOutput = { ...prepared, original_output_path: path.join(linkedParent, 'out.png') }
  assert.throws(() => policy.readPaidImageOriginalRequest(linkedOutput, root, trustedOriginal), /output path/i)
})

void test('force-live image catalogue reads supersede an older refresh and never fall back', async () => {
  const originalFetch = globalThis.fetch
  const apiKey = 'force-live-key'
  const pending: Array<{ resolve: (value: Response) => void; reject: (reason: unknown) => void }> = []
  let requests = 0
  const response = (credits: number, version: string) => Response.json([imageModel({ credits_per_image: credits, price_version: version })])
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    assert.match(url, /\/v1\/image\/models$/)
    requests++
    return new Promise<Response>((resolve, reject) => pending.push({ resolve, reject }))
  }) as typeof globalThis.fetch

  try {
    client.clearGenStudioCatalogCache()
    await settings.setGenStudioUrl('http://127.0.0.1:43123')
    const staleA = client.listImageModelsSnapshot(apiKey)
    while (requests < 1) await new Promise(resolve => setTimeout(resolve, 0))
    const forcedB = client.listImageModelsForceLive(apiKey)
    while (requests < 2) await new Promise(resolve => setTimeout(resolve, 0))
    pending[1]!.resolve(response(12, 'new-price'))
    const forced = await forcedB
    assert.equal(forced.freshness, 'live')
    assert.equal(forced.value[0]!.credits_per_image, 12)
    pending[0]!.resolve(response(4, 'old-price'))
    await staleA
    const later = await client.listImageModelsSnapshot(apiKey)
    assert.equal(later.value[0]!.credits_per_image, 12, 'late ordinary completion must not overwrite the forced live value')
    assert.equal(requests, 2)

    client.clearGenStudioCatalogCache()
    globalThis.fetch = (async () => response(13, 'latest-price')) as typeof globalThis.fetch
    const policy = await import('../services/image-paid-replacement.js')
    const original = { selector: selector(), references: [], referenceIdentityHash: policy.sha256CanonicalJson([]) }
    const rate = await policy.resolvePaidImageForceLivePublishedRate(apiKey, {
      modelId: 'image-paid-v1', original, request: original,
    })
    assert.deepEqual(rate, { credits: 4, priceVersion: 'normal-v1', basis: 'published-rate' })

    client.clearGenStudioCatalogCache()
    await client.listImageModelsSnapshot(apiKey)
    globalThis.fetch = (async () => Response.json({ detail: 'catalog unavailable' }, { status: 503 })) as typeof globalThis.fetch
    await assert.rejects(
      policy.resolvePaidImageForceLivePublishedRate(apiKey, { modelId: 'image-paid-v1', original, request: original }),
      /could not be refreshed|unavailable/i,
      'a failed forced read must not use the warm catalogue as a stale pricing fallback',
    )

    const forcePending: Array<{ resolve: (value: Response) => void }> = []
    client.clearGenStudioCatalogCache()
    globalThis.fetch = (() => new Promise<Response>(resolve => forcePending.push({ resolve }))) as typeof globalThis.fetch
    const forceB = client.listImageModelsForceLive(apiKey)
    while (forcePending.length < 1) await new Promise(resolve => setTimeout(resolve, 0))
    const forceC = client.listImageModelsForceLive(apiKey)
    while (forcePending.length < 2) await new Promise(resolve => setTimeout(resolve, 0))
    forcePending[0]!.resolve(response(11, 'force-b-price'))
    await assert.rejects(forceB, /superseded/i, 'forced B must not authorize after forced C starts')
    forcePending[1]!.resolve(response(14, 'force-c-price'))
    assert.equal((await forceC).value[0]!.credits_per_image, 14)
  } finally {
    globalThis.fetch = originalFetch
    client.clearGenStudioCatalogCache()
    await settings.setGenStudioUrl('')
  }
})

void test('paid image replacement terminal and settlement gate is fail-closed before time', async (suite) => {
  const policy = await import('../services/image-paid-replacement.js')
  const root = path.join(temp.dir, 'paid-image-commit-gate')
  await mkdir(root, { recursive: true })
  const original = { prompt: 'A moonlit pagoda.', baseScope: 'scene:paid-gate' }
  const identity = policy.buildPaidImageOriginalIdentity({ ...original, selector: selector(), references: [] })
  const manifestEntry = () => ({
    provider: 'genstudio', task_id: 'original-task', idempotency_key: 'original-key', submitted_at: '2026-08-31T00:00:00.000Z',
    operation: 'image' as const, last_state: 'failed', input_hash: identity.inputHash, request_scope: identity.requestScope,
    original_output_selector: selector(), original_reference_inputs: [], original_reference_identity_hash: policy.sha256CanonicalJson([]),
    original_output_path: path.join(root, 'missing.png'),
  })
  const job = (): Job => ({
    job_id: 'paid-job', project_slug: 'paid-project', type: 'thumb_images', episode_id: 'EP0092', title: 'Paid gate',
    status: 'running', created_at: '2026-08-31T00:00:00.000Z', started_at: '2026-08-31T00:00:00.000Z', finished_at: null,
    error: null, output_lines: [], params: {},
    paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 8, snapshotted_at: '2026-08-31T00:00:00.000Z' },
  })
  const decision = async (overrides: Record<string, unknown> = {}) => {
    const current = job()
    const manifests = new Map<string, { schema_version: 1; tasks: Record<string, TaskManifestEntry> }>([[root, { schema_version: 1, tasks: { 'missing.png': manifestEntry() } }]])
    const jobs = new Map([[current.job_id, structuredClone(current)]])
    const writes: string[] = []
    const result = await policy.decidePaidImageReplacement({
      job: current,
      asset: { assetKey: 'thumbnail:1', manifestDir: root, manifestKey: 'missing.png', outputPath: path.join(root, 'missing.png'), owningRoot: root, trustedOriginal: original, modelId: 'image-paid-v1', apiKey: 'test-key' },
      now: () => new Date('2026-08-31T00:00:00.000Z'),
      persistence: {
        loadAuthoritativeJob: async (_project: string, id: string) => structuredClone(jobs.get(id) || null),
        writeAuthoritativeJob: async (next: Job) => { writes.push('job'); jobs.set(next.job_id, structuredClone(next)) },
        readManifest: async (dir: string) => structuredClone(manifests.get(dir)!),
        writeManifestStrict: async (dir: string, key: string, entry: TaskManifestEntry) => {
          writes.push('manifest')
          manifests.get(dir)!.tasks[key] = entry
        },
      },
      dependencies: {
        readControl: async () => ({ id: 'original-task', state: 'failed', failure_code: 'SITE_PLACEMENT_EXHAUSTED', reserved_credits: 9, settled_credits: 3, released_credits: 6 }),
        artifactExists: async () => false,
        getSetting: async () => ({ enabled: true, additional_credit_ceiling: 8 }),
        resolveRate: async () => ({ credits: 4, priceVersion: 'price-v1', basis: 'published-rate' as const }),
        refreshAdmission: async () => ({ capacity_verified: true, limitSource: 'account-overview', available_paid_slots: 2, queue_near_capacity: false, submissions_blocked: false, retry_after_ms: 0, credit_balance: 10, paid_concurrency_limit: 2, paid_active_jobs: 0, paid_queued_jobs: 0, max_queued_jobs: 10, generation_submissions_per_minute: 5 } as any),
      },
      ...overrides,
    })
    return { result, current, jobs, manifests, writes }
  }

  for (const [label, control, expected] of [
    ['running control', { id: 'original-task', state: 'running' }, 'recover-original'],
    ['unknown control state', { id: 'original-task', state: 'reconciling' }, 'recover-original'],
    ['uncertain submission', { id: 'original-task', state: 'failed', failure_code: 'CLOUD_SUBMISSION_UNCERTAIN', reserved_credits: 9, settled_credits: 3, released_credits: 6 }, 'blocked'],
    ['cancelled task', { id: 'original-task', state: 'failed', cancelled: true, failure_code: 'SITE_PLACEMENT_EXHAUSTED', reserved_credits: 9, settled_credits: 3, released_credits: 6 }, 'blocked'],
    ['billing refusal', { id: 'original-task', state: 'failed', failure_code: 'INSUFFICIENT_CREDITS', reserved_credits: 9, settled_credits: 0, released_credits: 9 }, 'blocked'],
    ['validation refusal before recoverable classification', { id: 'original-task', state: 'running', failure_code: 'VALIDATION_FAILED', reserved_credits: 9, settled_credits: 3, released_credits: 6 }, 'blocked'],
    ['authentication refusal before recoverable classification', { id: 'original-task', state: 'reconciling', failure_code: 'AUTH_FAILED', reserved_credits: 9, settled_credits: 3, released_credits: 6 }, 'blocked'],
    ['imbalanced settlement', { id: 'original-task', state: 'failed', failure_code: 'SITE_PLACEMENT_EXHAUSTED', reserved_credits: 9, settled_credits: 3, released_credits: 5 }, 'blocked'],
    ['missing settlement fields', { id: 'original-task', state: 'failed', failure_code: 'SITE_PLACEMENT_EXHAUSTED', reserved_credits: 9, released_credits: 6 }, 'blocked'],
    ['nonfinite settlement', { id: 'original-task', state: 'failed', failure_code: 'SITE_PLACEMENT_EXHAUSTED', reserved_credits: Number.NaN, settled_credits: 3, released_credits: 6 }, 'blocked'],
  ] as const) {
    await suite.test(`does not spend for ${label}`, async () => {
      const { result, writes } = await decision({ dependencies: {
        readControl: async () => control,
        artifactExists: async () => false,
        getSetting: async () => ({ enabled: true, additional_credit_ceiling: 8 }),
        resolveRate: async () => ({ credits: 4, priceVersion: 'price-v1', basis: 'published-rate' as const }),
        refreshAdmission: async () => ({ capacity_verified: true, limitSource: 'account-overview', available_paid_slots: 2, queue_near_capacity: false, submissions_blocked: false, retry_after_ms: 0, credit_balance: 10, paid_concurrency_limit: 2, paid_active_jobs: 0, paid_queued_jobs: 0, max_queued_jobs: 10, generation_submissions_per_minute: 5 } as any),
      } })
      assert.equal(result.action, expected)
      assert.deepEqual(writes, [])
    })
  }

  await suite.test('uses only the existing zero-settlement retry and persists immutable positive-settlement clocks', async () => {
    const zero = await decision({ dependencies: {
      readControl: async () => ({ id: 'original-task', state: 'failed', failure_code: 'SITE_PLACEMENT_EXHAUSTED', reserved_credits: 9, settled_credits: 0, released_credits: 9 }),
      artifactExists: async () => false, getSetting: async () => ({ enabled: true, additional_credit_ceiling: 8 }),
      resolveRate: async () => ({ credits: 4, priceVersion: 'price-v1', basis: 'published-rate' as const }),
      refreshAdmission: async () => ({ capacity_verified: true, limitSource: 'account-overview', available_paid_slots: 2, queue_near_capacity: false, submissions_blocked: false, retry_after_ms: 0, credit_balance: 10, paid_concurrency_limit: 2, paid_active_jobs: 0, paid_queued_jobs: 0, max_queued_jobs: 10, generation_submissions_per_minute: 5 }),
    } })
    assert.equal(zero.result.action, 'safe-zero-settlement-retry')
    const first = await decision()
    assert.equal(first.result.action, 'wait')
    const attempt = first.current.paid_image_replacement_attempts![0]!
    assert.equal(attempt.terminal_observed_at, '2026-08-31T00:00:00.000Z')
    assert.equal(attempt.eligible_at, '2026-08-31T00:30:00.000Z')
    const durable = structuredClone(first.current)
    const dueManifest: { schema_version: 1; tasks: Record<string, TaskManifestEntry> } = { schema_version: 1, tasks: { 'missing.png': manifestEntry() } }
    const second = await policy.decidePaidImageReplacement({
      job: first.current, asset: { assetKey: 'thumbnail:1', manifestDir: root, manifestKey: 'missing.png', outputPath: path.join(root, 'missing.png'), owningRoot: root, trustedOriginal: original, modelId: 'image-paid-v1', apiKey: 'test-key' },
      now: () => new Date('2026-09-01T00:00:00.000Z'), persistence: {
        loadAuthoritativeJob: async () => structuredClone(durable), writeAuthoritativeJob: async (next: Job) => { Object.assign(durable, structuredClone(next)) },
        readManifest: async () => structuredClone(dueManifest), writeManifestStrict: async (_dir: string, key: string, next: TaskManifestEntry) => { dueManifest.tasks[key] = next },
      }, dependencies: {
        readControl: async () => ({ id: 'original-task', state: 'failed', failure_code: 'SITE_PLACEMENT_EXHAUSTED', reserved_credits: 9, settled_credits: 3, released_credits: 6 }), artifactExists: async () => false,
        getSetting: async () => ({ enabled: true, additional_credit_ceiling: 8 }), resolveRate: async () => ({ credits: 4, priceVersion: 'price-v1', basis: 'published-rate' as const }),
        refreshAdmission: async () => ({ capacity_verified: true, limitSource: 'account-overview', available_paid_slots: 2, queue_near_capacity: false, submissions_blocked: false, retry_after_ms: 0, credit_balance: 10, paid_concurrency_limit: 2, paid_active_jobs: 0, paid_queued_jobs: 0, max_queued_jobs: 10, generation_submissions_per_minute: 5 } as any),
      },
    })
    assert.equal(second.action, 'commit', `${JSON.stringify(second)}: due time follows a fresh terminal re-read, never time alone`)
    assert.equal(first.current.paid_image_replacement_attempts![0]!.terminal_observed_at, attempt.terminal_observed_at)
    assert.equal(first.current.paid_image_replacement_attempts![0]!.eligible_at, attempt.eligible_at)
  })

  await suite.test('keeps the jobs-first commitment authoritative across both ordered write failures', async () => {
    const seeded = await decision()
    const durable = seeded.jobs
    const basePersistence = {
      loadAuthoritativeJob: async (_project: string, id: string) => structuredClone(durable.get(id) || null),
      readManifest: async (dir: string) => structuredClone(seeded.manifests.get(dir)!),
    }
    let manifestWriteCalls = 0
    const jobFailure = await decision({ job: seeded.current, now: () => new Date('2026-08-31T00:30:00.000Z'), persistence: {
      ...basePersistence,
      writeAuthoritativeJob: async () => { throw new Error('jobs.json write failed') },
      writeManifestStrict: async () => { manifestWriteCalls++ },
    } })
    assert.equal(jobFailure.result.action, 'blocked')
    assert.equal(manifestWriteCalls, 0, 'a failed jobs.json write must stop before the manifest')

    const seededManifestFailure = await decision()
    const durableManifestFailure = seededManifestFailure.jobs
    const manifestFailure = await decision({ job: seededManifestFailure.current, now: () => new Date('2026-08-31T00:30:00.000Z'), persistence: {
      loadAuthoritativeJob: async (_project: string, id: string) => structuredClone(durableManifestFailure.get(id) || null),
      writeAuthoritativeJob: async (next: Job) => { durableManifestFailure.set(next.job_id, structuredClone(next)) },
      readManifest: async (dir: string) => structuredClone(seededManifestFailure.manifests.get(dir)!),
      writeManifestStrict: async () => { throw new Error('manifest write failed') },
    } })
    assert.equal(manifestFailure.result.action, 'blocked')
    const retained = durableManifestFailure.get(seededManifestFailure.current.job_id)?.paid_image_replacement_attempts?.[0]
    assert.equal(retained?.state, 'committed')
    assert.equal(retained?.manifest_dir, root)
    assert.equal(retained?.manifest_key, 'missing.png')
    assert.equal(retained?.output_path, seededManifestFailure.current.paid_image_replacement_attempts?.[0]?.output_path)
    assert.equal(typeof retained?.replacement_scope, 'string')
    assert.equal(retained?.quoted_credits, 4)
    assert.equal(retained?.price_version, 'price-v1')
    assert.equal(retained?.replacement_committed_at, '2026-08-31T00:30:00.000Z')
  })

  await suite.test('never lets stale copies override the authoritative attempt, clock, capacity, or manifest identity', async () => {
    const seeded = await decision()
    const durable = seeded.jobs
    const persisted = durable.get(seeded.current.job_id)!
    const attempt = persisted.paid_image_replacement_attempts![0]!
    attempt.state = 'committed'
    attempt.quoted_credits = 4
    attempt.price_version = 'price-v1'
    durable.set(persisted.job_id, persisted)
    const stale = job()
    const staleOutcome = await decision({ job: stale, persistence: {
      loadAuthoritativeJob: async (_project: string, id: string) => structuredClone(durable.get(id) || null),
      writeAuthoritativeJob: async (next: Job) => { durable.set(next.job_id, structuredClone(next)) },
      readManifest: async (dir: string) => structuredClone(seeded.manifests.get(dir)!),
      writeManifestStrict: async () => {},
    } })
    assert.equal(staleOutcome.result.action, 'blocked')
    assert.equal(durable.get(persisted.job_id)?.paid_image_replacement_attempts?.[0]?.state, 'committed')

    const waiting = structuredClone(seeded.current)
    waiting.paid_image_replacement_attempts![0]!.eligible_at = '2026-08-31T00:30:00.000Z'
    const authoritative = structuredClone(waiting)
    authoritative.paid_image_replacement_attempts![0]!.eligible_at = '2026-08-31T01:00:00.000Z'
    const manifest = structuredClone(seeded.manifests.get(root)!)
    const due = await decision({ job: waiting, now: () => new Date('2026-08-31T00:30:00.000Z'), persistence: {
      loadAuthoritativeJob: async () => structuredClone(authoritative), writeAuthoritativeJob: async (next: Job) => { Object.assign(authoritative, structuredClone(next)) },
      readManifest: async () => structuredClone(manifest), writeManifestStrict: async (_dir: string, key: string, next: TaskManifestEntry) => { manifest.tasks[key] = next },
    }, dependencies: {
      readControl: async () => ({ id: 'original-task', state: 'failed', failure_code: 'SITE_PLACEMENT_EXHAUSTED', reserved_credits: 9, settled_credits: 3, released_credits: 6 }), artifactExists: async () => false,
      getSetting: async () => ({ enabled: true, additional_credit_ceiling: 8 }), resolveRate: async () => ({ credits: 4, priceVersion: 'price-v1', basis: 'published-rate' as const }),
      refreshAdmission: async () => ({ capacity_verified: true, limitSource: 'account-overview', available_paid_slots: 0, queue_near_capacity: false, submissions_blocked: false, retry_after_ms: 0, credit_balance: 10, paid_concurrency_limit: 2, paid_active_jobs: 2, paid_queued_jobs: 0, max_queued_jobs: 10, generation_submissions_per_minute: 5 }),
    } })
    assert.notEqual(due.result.action, 'commit')
    assert.equal(authoritative.paid_image_replacement_attempts![0]!.eligible_at, '2026-08-31T01:00:00.000Z')
  })
})

void test('paid image replacement commits jobs first under an authoritative ceiling', async (suite) => {
  const policy = await import('../services/image-paid-replacement.js')
  const root = path.join(temp.dir, 'paid-image-commit-race')
  await mkdir(root, { recursive: true })
  const original = { prompt: 'A sunrise.', baseScope: 'paid-race' }
  const identity = policy.buildPaidImageOriginalIdentity({ ...original, selector: selector(), references: [] })
  const entry = (name: string) => ({ provider: 'genstudio', task_id: `task-${name}`, idempotency_key: `key-${name}`, submitted_at: '2026-08-31T00:00:00.000Z', operation: 'image' as const, last_state: 'failed', input_hash: identity.inputHash, request_scope: identity.requestScope, original_output_selector: selector(), original_reference_inputs: [], original_reference_identity_hash: policy.sha256CanonicalJson([]), original_output_path: path.join(root, `${name}.png`) })
  const job = (): Job => ({ job_id: 'race-job', project_slug: 'paid-project', type: 'thumb_images', episode_id: 'EP0092', title: '', status: 'running', created_at: '', started_at: '', finished_at: null, error: null, output_lines: [], params: {}, paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 4, snapshotted_at: '' } })
  const authoritative = job()
  const manifests = new Map<string, { schema_version: 1; tasks: Record<string, TaskManifestEntry> }>([[root, { schema_version: 1, tasks: { 'a.png': entry('a'), 'b.png': entry('b') } }]])
  let releaseBarrier!: () => void
  const barrier = new Promise<void>(resolve => { releaseBarrier = resolve })
  let prechecks = 0
  const shared = {
    loadAuthoritativeJob: async () => structuredClone(authoritative),
    writeAuthoritativeJob: async (next: Job) => { Object.assign(authoritative, structuredClone(next)) },
    readManifest: async () => structuredClone(manifests.get(root)!),
    writeManifestStrict: async (_dir: string, key: string, next: TaskManifestEntry) => { manifests.get(root)!.tasks[key] = next },
  }
  const decide = (current: Job, name: string, at = '2026-08-31T00:30:00.000Z', dependencyOverrides: Record<string, unknown> = {}) => policy.decidePaidImageReplacement({
    job: current, asset: { assetKey: name, manifestDir: root, manifestKey: `${name}.png`, outputPath: path.join(root, `${name}.png`), owningRoot: root, trustedOriginal: original, modelId: 'image-paid-v1', apiKey: 'key' },
    now: () => new Date(at), persistence: shared,
    dependencies: {
      readControl: async () => ({ id: `task-${name}`, state: 'failed', failure_code: 'SITE_PLACEMENT_EXHAUSTED', reserved_credits: 9, settled_credits: 3, released_credits: 6 }),
      artifactExists: async () => false, getSetting: async () => ({ enabled: true, additional_credit_ceiling: 4 }), resolveRate: async () => ({ credits: 4, priceVersion: 'price-v1', basis: 'published-rate' as const }),
      refreshAdmission: async () => { prechecks++; if (prechecks === 2) releaseBarrier(); await barrier; return { capacity_verified: true, limitSource: 'account-overview' as const, available_paid_slots: 2, queue_near_capacity: false, submissions_blocked: false, retry_after_ms: 0, credit_balance: 10, paid_concurrency_limit: 2, paid_active_jobs: 0, paid_queued_jobs: 0, max_queued_jobs: 10, generation_submissions_per_minute: 5 } as any },
      ...dependencyOverrides,
    },
  })
  await decide(job(), 'a', '2026-08-31T00:00:00.000Z')
  await decide(structuredClone(authoritative), 'b', '2026-08-31T00:00:00.000Z')
  const first = structuredClone(authoritative); const second = structuredClone(authoritative)
  const [one, two] = await Promise.all([decide(first, 'a'), decide(second, 'b')])
  assert.deepEqual([one.action, two.action].sort(), ['blocked', 'commit'])
  assert.equal(authoritative.paid_image_replacement_attempts?.filter(attempt => attempt.state === 'committed').length, 1, 'authoritative reload permits exactly one ceiling-safe commitment')

  await suite.test('blocks an artifact/current-off/price/balance and never permits a second attempt', async () => {
    const waitingAsset = authoritative.paid_image_replacement_attempts?.find(attempt => attempt.state === 'waiting')!.asset_key!
    const committedAsset = authoritative.paid_image_replacement_attempts?.find(attempt => attempt.state === 'committed')!.asset_key!
    for (const [label, dependencies] of [
      ['artifact', { artifactExists: async () => true }],
      ['off', { getSetting: async () => ({ enabled: false, additional_credit_ceiling: null }) }],
      ['price', { resolveRate: async () => ({ credits: 5, priceVersion: 'price-v1', basis: 'published-rate' as const }) }],
      ['balance', { refreshAdmission: async () => ({ capacity_verified: true, limitSource: 'account-overview', available_paid_slots: 2, queue_near_capacity: false, submissions_blocked: false, retry_after_ms: 0, credit_balance: 3, paid_concurrency_limit: 2, paid_active_jobs: 0, paid_queued_jobs: 0, max_queued_jobs: 10, generation_submissions_per_minute: 5 }) }],
    ] as const) {
      const result = await decide(structuredClone(authoritative), waitingAsset, '2026-08-31T00:30:00.000Z', dependencies).catch(error => { throw new Error(`${label}: ${error.message}`) })
      assert.notEqual(result.action, 'commit', label)
    }
    const repeat = await decide(structuredClone(authoritative), committedAsset)
    assert.equal(repeat.action, 'blocked')
  })

  await suite.test('leaves the job authoritative when either ordered write fails', async () => {
    let manifestWrites = 0
    const failedJob = await policy.decidePaidImageReplacement({
      job: job(), asset: { assetKey: 'write-a', manifestDir: root, manifestKey: 'a.png', outputPath: path.join(root, 'a.png'), owningRoot: root, trustedOriginal: original, modelId: 'image-paid-v1', apiKey: 'key' }, now: () => new Date('2026-08-31T00:30:00.000Z'),
      persistence: { ...shared, writeAuthoritativeJob: async () => { throw new Error('jobs disk full') }, writeManifestStrict: async () => { manifestWrites++ } },
      dependencies: { readControl: async () => ({ id: 'task-a', state: 'failed', failure_code: 'SITE_PLACEMENT_EXHAUSTED', reserved_credits: 9, settled_credits: 3, released_credits: 6 }), artifactExists: async () => false, getSetting: async () => ({ enabled: true, additional_credit_ceiling: 4 }), resolveRate: async () => ({ credits: 4, priceVersion: 'price-v1', basis: 'published-rate' as const }), refreshAdmission: async () => ({ capacity_verified: true, limitSource: 'account-overview', available_paid_slots: 2, queue_near_capacity: false, submissions_blocked: false, retry_after_ms: 0, credit_balance: 10, paid_concurrency_limit: 2, paid_active_jobs: 0, paid_queued_jobs: 0, max_queued_jobs: 10, generation_submissions_per_minute: 5 } as any) },
    })
    assert.equal(failedJob.action, 'blocked'); assert.equal(manifestWrites, 0)
  })
})

void test('paid image commitment strict manifest updates preserve authority', async () => {
  const manifests = await import('../services/task-manifest.js')
  const root = path.join(temp.dir, 'paid-image-strict-manifest')
  await mkdir(root, { recursive: true })
  const original = (task: string, output: string): TaskManifestEntry => ({
    provider: 'genstudio', task_id: task, idempotency_key: `${task}-key`, submitted_at: '2026-08-31T00:00:00.000Z',
    operation: 'image', last_state: 'failed', input_hash: `${task}-input`, request_scope: `${task}-scope`,
    original_output_selector: selector(), original_reference_inputs: [], original_reference_identity_hash: 'identity',
    original_output_path: output,
  })
  const a = original('a', path.join(root, 'a.png'))
  const b = original('b', path.join(root, 'b.png'))
  await writeFile(path.join(root, '.task-manifest.json'), JSON.stringify({ schema_version: 1, tasks: { 'a.png': a, 'b.png': b } }))
  await Promise.all([
    manifests.recordPaidImageReplacementStrict(root, 'a.png', { ...a, replacement_scope: 'scope-a', replacement_of_task_id: 'a', replacement_quoted_credits: 4, replacement_price_version: 'price-a', replacement_committed_at: '2026-08-31T00:30:00.000Z' }),
    manifests.recordPaidImageReplacementStrict(root, 'b.png', { ...b, replacement_scope: 'scope-b', replacement_of_task_id: 'b', replacement_quoted_credits: 5, replacement_price_version: 'price-b', replacement_committed_at: '2026-08-31T00:30:00.000Z' }),
  ])
  const merged = await manifests.readManifest(root)
  assert.equal(merged.tasks['a.png']?.replacement_scope, 'scope-a')
  assert.equal(merged.tasks['b.png']?.replacement_scope, 'scope-b')
  assert.equal(merged.tasks['a.png']?.original_output_path, a.original_output_path)
  await writeFile(path.join(root, '.task-manifest.json'), '{not json')
  await assert.rejects(() => manifests.recordPaidImageReplacementStrict(root, 'a.png', { ...a, replacement_scope: 'unsafe' }), SyntaxError)
  assert.equal(await readFile(path.join(root, '.task-manifest.json'), 'utf8'), '{not json')
})

void test('paid image commitment rechecks immutable evidence and every durable refusal seam', async (suite) => {
  const policy = await import('../services/image-paid-replacement.js')
  const root = path.join(temp.dir, 'paid-image-commit-round-two')
  await mkdir(root, { recursive: true })
  const original = { prompt: 'A lantern in rain.', baseScope: 'round-two' }
  const identity = policy.buildPaidImageOriginalIdentity({ ...original, selector: selector(), references: [] })
  const entry = (): TaskManifestEntry => ({ provider: 'genstudio', task_id: 'task-round-two', idempotency_key: 'key-round-two', submitted_at: '2026-08-31T00:00:00.000Z', operation: 'image', last_state: 'failed', input_hash: identity.inputHash, request_scope: identity.requestScope, original_output_selector: selector(), original_reference_inputs: [], original_reference_identity_hash: policy.sha256CanonicalJson([]), original_output_path: path.join(root, 'missing.png') })
  const job = (): Job => ({ job_id: 'round-two-job', project_slug: 'paid-project', type: 'thumb_images', episode_id: 'EP0092', title: '', status: 'running', created_at: '', started_at: '', finished_at: null, error: null, output_lines: [], params: {}, paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 4, snapshotted_at: '' } })
  const goodControl = { id: 'task-round-two', state: 'failed', failure_code: 'SITE_PLACEMENT_EXHAUSTED', reserved_credits: 9, settled_credits: 3, released_credits: 6 }
  const admission = (overrides: Record<string, unknown> = {}) => ({ capacity_verified: true, limitSource: 'account-overview', available_paid_slots: 1, queue_near_capacity: false, submissions_blocked: false, retry_after_ms: 0, credit_balance: 10, paid_concurrency_limit: 2, paid_active_jobs: 0, paid_queued_jobs: 0, max_queued_jobs: 10, generation_submissions_per_minute: 5, local_waiting: 0, submitting: 0, submissions_in_window: 0, submission_block_reason: null, refreshed_at: '2026-08-31T00:30:00.000Z', ...overrides } as any)
  const make = () => {
    const durable = job()
    const manifest: { schema_version: 1; tasks: Record<string, TaskManifestEntry> } = { schema_version: 1, tasks: { 'missing.png': entry() } }
    const decide = async (overrides: Record<string, unknown> = {}) => policy.decidePaidImageReplacement({
      job: durable, asset: { assetKey: 'asset-round-two', manifestDir: root, manifestKey: 'missing.png', outputPath: path.join(root, 'missing.png'), owningRoot: root, trustedOriginal: original, modelId: 'image-paid-v1', apiKey: 'key' }, now: () => new Date('2026-08-31T00:00:00.000Z'),
      persistence: { loadAuthoritativeJob: async () => structuredClone(durable), writeAuthoritativeJob: async (next: Job) => { Object.assign(durable, structuredClone(next)) }, readManifest: async () => structuredClone(manifest), writeManifestStrict: async (_dir: string, key: string, next: TaskManifestEntry) => { manifest.tasks[key] = next } },
      dependencies: { readControl: async () => goodControl, artifactExists: async () => false, getSetting: async () => ({ enabled: true, additional_credit_ceiling: 4 }), resolveRate: async () => ({ credits: 1, priceVersion: 'price-v1', basis: 'published-rate' as const }), refreshAdmission: async () => admission() },
      ...overrides,
    })
    return { durable, manifest, decide }
  }
  const due = (fixture: ReturnType<typeof make>, overrides: Record<string, unknown> = {}) => fixture.decide({ now: () => new Date('2026-08-31T00:30:00.000Z'), ...overrides })

  await suite.test('blocks changed but balanced terminal evidence and an erroring artifact audit before commitment', async () => {
    for (const changed of [
      { ...goodControl, failure_code: 'SITE_CAPACITY_UNAVAILABLE' },
      { ...goodControl, settled_credits: 4, released_credits: 5 },
    ]) {
      const fixture = make(); await fixture.decide()
      const result = await due(fixture, { dependencies: { readControl: async () => changed, artifactExists: async () => false, getSetting: async () => ({ enabled: true, additional_credit_ceiling: 4 }), resolveRate: async () => ({ credits: 1, priceVersion: 'price-v1', basis: 'published-rate' as const }), refreshAdmission: async () => admission() } })
      assert.equal(result.action, 'blocked')
      assert.equal(fixture.durable.paid_image_replacement_attempts?.[0]?.state, 'waiting')
    }
    const fixture = make(); await fixture.decide()
    const result = await due(fixture, { dependencies: { readControl: async () => goodControl, artifactExists: async () => { throw new Error('audit unavailable') }, getSetting: async () => ({ enabled: true, additional_credit_ceiling: 4 }), resolveRate: async () => ({ credits: 1, priceVersion: 'price-v1', basis: 'published-rate' as const }), refreshAdmission: async () => admission() } })
    assert.equal(result.action, 'blocked')
  })

  await suite.test('counts every conservative quote state and blocks absent quotes or a second failed attempt', async () => {
    for (const state of ['committed', 'submitted', 'succeeded', 'failed'] as const) {
      const fixture = make(); await fixture.decide()
      fixture.durable.paid_image_replacement_attempts!.push({ ...fixture.durable.paid_image_replacement_attempts![0]!, asset_key: `other-${state}`, state, quoted_credits: 4, replacement_scope: `scope-${state}`, price_version: 'price-v1', replacement_committed_at: '2026-08-31T00:01:00.000Z' })
      assert.equal((await due(fixture)).action, 'blocked', state)
    }
    const missing = make(); await missing.decide()
    missing.durable.paid_image_replacement_attempts!.push({ ...missing.durable.paid_image_replacement_attempts![0]!, asset_key: 'other-missing', state: 'failed', replacement_scope: 'scope-missing', replacement_committed_at: '2026-08-31T00:01:00.000Z' })
    assert.equal((await due(missing)).action, 'blocked')
    const failed = make(); await failed.decide()
    failed.durable.paid_image_replacement_attempts![0]!.state = 'failed'
    assert.equal((await due(failed)).action, 'blocked')
    assert.equal(failed.durable.paid_image_replacement_attempts?.length, 1)
  })

  await suite.test('blocks every material capacity fact and returns deterministic scopes without POST permission', async () => {
    for (const capacity of [
      { available_paid_slots: 0 }, { limitSource: 'fallback' }, { capacity_verified: false },
      { queue_near_capacity: true }, { submissions_blocked: true }, { retry_after_ms: 1 },
    ]) {
      const fixture = make(); await fixture.decide()
      assert.equal((await due(fixture, { dependencies: { readControl: async () => goodControl, artifactExists: async () => false, getSetting: async () => ({ enabled: true, additional_credit_ceiling: 4 }), resolveRate: async () => ({ credits: 1, priceVersion: 'price-v1', basis: 'published-rate' as const }), refreshAdmission: async () => admission(capacity) } })).action, 'blocked')
    }
    const first = make(); const second = make(); await first.decide(); await second.decide()
    const [one, two] = await Promise.all([due(first), due(second)])
    assert.equal(one.action, 'commit'); assert.equal(two.action, 'commit')
    if (one.action === 'commit' && two.action === 'commit') assert.equal(one.scope, two.scope)
  })

  await suite.test('reread errors and identity/timestamp mismatches return no commitment permission', async () => {
    for (const mode of ['identity', 'timestamp', 'error'] as const) {
      const fixture = make(); await fixture.decide()
      let reads = 0
      const result = await due(fixture, { persistence: {
        loadAuthoritativeJob: async () => structuredClone(fixture.durable), writeAuthoritativeJob: async (next: Job) => { Object.assign(fixture.durable, structuredClone(next)) },
        readManifest: async () => { reads++; if (reads > 1 && mode === 'error') throw new Error('reread failed'); const next = structuredClone(fixture.manifest); if (reads > 1 && mode === 'identity') next.tasks['missing.png']!.input_hash = 'mismatch'; if (reads > 1 && mode === 'timestamp') next.tasks['missing.png']!.replacement_committed_at = 'wrong'; return next },
        writeManifestStrict: async (_dir: string, key: string, next: TaskManifestEntry) => { fixture.manifest.tasks[key] = next },
      } })
      assert.equal(result.action, 'blocked', mode)
    }
  })

  await suite.test('the decision boundary grants no POST and blocked results grant no permission', async () => {
    const originalFetch = globalThis.fetch
    let postCalls = 0
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') postCalls++
      throw new Error('decision must not call fetch')
    }) as typeof globalThis.fetch
    try {
      const fixture = make(); await fixture.decide()
      const blocked = await due(fixture, { dependencies: { readControl: async () => goodControl, artifactExists: async () => false, getSetting: async () => ({ enabled: true, additional_credit_ceiling: 4 }), resolveRate: async () => ({ credits: 5, priceVersion: 'price-v1', basis: 'published-rate' as const }), refreshAdmission: async () => admission() } })
      assert.equal(blocked.action, 'blocked')
      assert.equal(postCalls, 0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
