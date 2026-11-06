import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { useTempDataDir } from './_helpers.js'
import {
  RETRY_ATTEMPTS_DEFAULT,
  RETRY_ATTEMPTS_MAX,
  RETRY_ATTEMPTS_MIN,
  getImageRetrySetting,
  setImageRetrySetting,
  parseRetryFailedRequestsSetting,
} from '../services/app-settings.js'
import {
  decidePaidImageReplacement,
  buildPaidImageOriginalIdentity,
  sha256CanonicalJson,
} from '../services/image-paid-replacement.js'
import {
  resolveImageRetryScope,
  extractImageRetryOrdinal,
} from '../lib/manifest-recovery.js'
import type { Job } from '../models/types.js'
import type { TaskManifestEntry } from '../services/task-manifest.js'

void test('image retry settings defaults and bounds validation', async () => {
  // 1. Defaults off/3
  const defaultSetting = parseRetryFailedRequestsSetting(undefined, 'default', 'image')
  assert.deepEqual(defaultSetting, { enabled: false, retries: RETRY_ATTEMPTS_DEFAULT })
  assert.equal(RETRY_ATTEMPTS_DEFAULT, 3)
  assert.equal(RETRY_ATTEMPTS_MIN, 1)
  assert.equal(RETRY_ATTEMPTS_MAX, 10)

  // 2. Bound clamping / default on missing retries
  const enabledOnly = parseRetryFailedRequestsSetting({ enabled: true }, 'default', 'image')
  assert.deepEqual(enabledOnly, { enabled: true, retries: 3 })

  const validCustom = parseRetryFailedRequestsSetting({ enabled: true, retries: 5 }, 'throw', 'image')
  assert.deepEqual(validCustom, { enabled: true, retries: 5 })

  // 3. Validation errors
  assert.throws(
    () => parseRetryFailedRequestsSetting({ enabled: 'not-bool' }, 'throw', 'image'),
    /enabled as a boolean/,
  )
  assert.throws(
    () => parseRetryFailedRequestsSetting({ enabled: true, retries: 0 }, 'throw', 'image'),
    /Retries for image must be an integer between 1 and 10/,
  )
  assert.throws(
    () => parseRetryFailedRequestsSetting({ enabled: true, retries: 11 }, 'throw', 'image'),
    /Retries for image must be an integer between 1 and 10/,
  )
  assert.throws(
    () => parseRetryFailedRequestsSetting({ enabled: true, retries: 3.5 }, 'throw', 'image'),
    /Retries for image must be an integer between 1 and 10/,
  )
})

void test('image retry scope derivation and ordinal extraction', () => {
  assert.equal(extractImageRetryOrdinal('scene-001'), 0)
  assert.equal(extractImageRetryOrdinal('scene-001:retry:abc123def456'), 1)
  assert.equal(extractImageRetryOrdinal('scene-001:retry:1:abc123def456'), 1)
  assert.equal(extractImageRetryOrdinal('scene-001:retry:2:abc123def456'), 2)
  assert.equal(extractImageRetryOrdinal('scene-001:retry:5:abc123def456'), 5)

  const terminalEntry: TaskManifestEntry = {
    provider: 'genstudio',
    task_id: 'task-fail-1',
    submitted_at: '2026-11-02T00:00:00.000Z',
    last_state: 'failed',
    request_scope: 'scene-001',
  }
  const retry1 = resolveImageRetryScope(terminalEntry, 'scene-001', 1)
  assert.equal(retry1.isRetry, true)
  assert.match(retry1.scope, /^scene-001:retry:1:[0-9a-f]{12}$/)

  const retry2Entry: TaskManifestEntry = {
    ...terminalEntry,
    task_id: 'task-fail-2',
    request_scope: retry1.scope,
  }
  const retry2 = resolveImageRetryScope(retry2Entry, 'scene-001')
  assert.equal(retry2.isRetry, true)
  assert.match(retry2.scope, /^scene-001:retry:2:[0-9a-f]{12}$/)
})

void test('image retry decision policy: off means zero retries, exact count enforcement, restart replay, hold & cancel refusal', async () => {
  const temp = await useTempDataDir()
  const root = path.join(temp.dir, 'test-assets')
  await mkdir(root, { recursive: true })

  const selector = () => ({ width: 1280, height: 720, aspect_ratio: '16:9' as const, resolution: '720p' as const, reference_mode: 'normal' as const })
  const original = { prompt: 'A calm river.', baseScope: 'scene-001' }
  const identity = buildPaidImageOriginalIdentity({ ...original, selector: selector(), references: [] })

  const manifestEntry = (scope = identity.requestScope, taskId = 'task-orig'): TaskManifestEntry => ({
    provider: 'genstudio',
    task_id: taskId,
    idempotency_key: 'idem-orig',
    submitted_at: '2026-11-02T00:00:00.000Z',
    operation: 'image',
    last_state: 'failed',
    input_hash: identity.inputHash,
    request_scope: scope,
    original_output_selector: selector(),
    original_reference_inputs: [],
    original_reference_identity_hash: sha256CanonicalJson([]),
    original_output_path: path.join(root, 'missing.png'),
  })

  const job = (): Job => ({
    job_id: 'job-1',
    project_slug: 'proj-1',
    type: 'thumb_images',
    episode_id: 'EP001',
    title: 'Retry test',
    status: 'running',
    created_at: '2026-11-02T00:00:00.000Z',
    started_at: '2026-11-02T00:00:00.000Z',
    finished_at: null,
    error: null,
    output_lines: [],
    params: {},
    // Legacy switch is intentionally set to enabled:true to verify it is ignored
    paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, snapshotted_at: '2026-11-02T00:00:00.000Z' },
  })

  const runDecision = async (opts: {
    setting?: { enabled: boolean; retries?: number }
    control?: Record<string, unknown>
    scope?: string
    taskId?: string
    jobStatus?: Job['status']
  }) => {
    const currentJob = job()
    if (opts.jobStatus) currentJob.status = opts.jobStatus
    const testBaseScope = opts.scope ?? original.baseScope
    const testOriginal = { ...original, baseScope: testBaseScope }
    const testIdentity = buildPaidImageOriginalIdentity({ ...testOriginal, selector: selector(), references: [] })
    const entry = manifestEntry(testIdentity.requestScope, opts.taskId)
    entry.input_hash = testIdentity.inputHash
    const manifests = new Map([[root, { schema_version: 1 as const, tasks: { 'missing.png': entry } }]])

    return decidePaidImageReplacement({
      job: currentJob,
      asset: {
        assetKey: 'scene:1',
        manifestDir: root,
        manifestKey: 'missing.png',
        outputPath: path.join(root, 'missing.png'),
        owningRoot: root,
        trustedOriginal: testOriginal,
        modelId: 'qwen-turbo',
        apiKey: 'test-key',
      },
      persistence: {
        readManifest: async (dir) => manifests.get(dir)!,
        inspectAuthoritativeJob: async (_slug, _id, inspect) => inspect(currentJob),
        loadAuthoritativeJob: async () => currentJob,
        writeAuthoritativeJob: async () => {},
        writeManifestStrict: async () => {},
      },
      dependencies: {
        readControl: async () => ({
          id: entry.task_id,
          state: 'failed',
          failure_code: 'IMAGE_FAILED',
          ...opts.control,
        }),
        artifactExists: async () => false,
        getSetting: async () => opts.setting ?? { enabled: false, retries: 3 },
      },
    })
  }

  // 1. Off means zero retries
  const offResult = await runDecision({ setting: { enabled: false, retries: 3 } })
  assert.equal(offResult.action, 'blocked')
  assert.equal(offResult.action === 'blocked' && offResult.public_reason, 'replacement_disabled')

  // 2. Cancellation refusal
  const cancelledResult = await runDecision({
    setting: { enabled: true, retries: 3 },
    control: { cancelled: true },
  })
  assert.equal(cancelledResult.action, 'blocked')
  assert.equal(cancelledResult.action === 'blocked' && cancelledResult.public_reason, 'original_failure_not_eligible')

  const jobCancelledResult = await runDecision({
    setting: { enabled: true, retries: 3 },
    jobStatus: 'cancelled',
  })
  assert.equal(jobCancelledResult.action, 'not-eligible')

  // 3. Active hold / unknown outcome refusal
  const activeHoldResult = await runDecision({
    setting: { enabled: true, retries: 3 },
    control: { recovery_required: true, recovery_state: 'unknown_outcome' },
  })
  assert.equal(activeHoldResult.action, 'blocked')

  const unconfirmedUnknownOutcome = await runDecision({
    setting: { enabled: true, retries: 3 },
    control: { failure_code: 'UNKNOWN_OUTCOME' },
  })
  assert.equal(unconfirmedUnknownOutcome.action, 'blocked')

  // Closed hold on UNKNOWN_OUTCOME with recovery_required: false is permitted
  const closedUnknownOutcome = await runDecision({
    setting: { enabled: true, retries: 3 },
    control: { failure_code: 'UNKNOWN_OUTCOME', recovery_required: false },
  })
  if (closedUnknownOutcome.action !== 'retry') console.log('closedUnknownOutcome:', closedUnknownOutcome)
  assert.equal(closedUnknownOutcome.action, 'retry')

  // 4. Exact configured count enforcement (retries: 2)
  // Attempt 1 from original scope: granted
  const retry1 = await runDecision({
    setting: { enabled: true, retries: 2 },
    scope: 'scene-001',
    taskId: 'task-orig',
  })
  assert.equal(retry1.action, 'retry')
  assert.match((retry1 as any).scope, /^scene-001:retry:1:[0-9a-f]{12}$/)

  // Restart replay of attempt 1 with same task id and attempt record on job
  const jobWithAttempt1 = job()
  jobWithAttempt1.paid_image_replacement_attempts = [{
    asset_key: 'scene:1',
    manifest_dir: root,
    manifest_key: 'missing.png',
    output_path: path.join(root, 'missing.png'),
    state: 'committed',
    original_task_id: 'task-orig',
    original_idempotency_key: 'idem-orig',
    input_hash: identity.inputHash,
    output_selector: selector(),
    reference_inputs: [],
    reference_identity_hash: sha256CanonicalJson([]),
    failure_code: 'IMAGE_FAILED',
    replacement_scope: (retry1 as any).scope,
    terminal_observed_at: '2026-11-02T00:00:00.000Z',
    eligible_at: '2026-11-02T00:30:00.000Z',
  }]
  const replayResult = await decidePaidImageReplacement({
    job: jobWithAttempt1,
    asset: {
      assetKey: 'scene:1',
      manifestDir: root,
      manifestKey: 'missing.png',
      outputPath: path.join(root, 'missing.png'),
      owningRoot: root,
      trustedOriginal: original,
      modelId: 'qwen-turbo',
      apiKey: 'test-key',
    },
    persistence: {
      readManifest: async () => ({ schema_version: 1, tasks: { 'missing.png': manifestEntry(identity.requestScope, 'task-orig') } }),
      inspectAuthoritativeJob: async (_slug, _id, inspect) => inspect(jobWithAttempt1),
      loadAuthoritativeJob: async () => jobWithAttempt1,
      writeAuthoritativeJob: async () => {},
      writeManifestStrict: async () => {},
    },
    dependencies: {
      readControl: async () => ({ id: 'task-orig', state: 'failed', failure_code: 'IMAGE_FAILED' }),
      artifactExists: async () => false,
      getSetting: async () => ({ enabled: true, retries: 2 }),
    },
  })
  assert.equal(replayResult.action, 'retry')
  assert.equal((replayResult as any).scope, (retry1 as any).scope)

  // Attempt 2 from retry:1 scope: granted
  const retry2 = await runDecision({
    setting: { enabled: true, retries: 2 },
    scope: (retry1 as any).scope,
    taskId: 'task-fail-1',
  })
  assert.equal(retry2.action, 'retry')
  assert.match((retry2 as any).scope, /^scene-001:retry:2:[0-9a-f]{12}$/)

  // Attempt 3 from retry:2 scope: BLOCKED because maxRetries is 2
  const retry3 = await runDecision({
    setting: { enabled: true, retries: 2 },
    scope: (retry2 as any).scope,
    taskId: 'task-fail-2',
  })
  assert.equal(retry3.action, 'blocked')
  assert.equal(retry3.action === 'blocked' && retry3.public_reason, 'original_failure_not_eligible')

  // 5. No financial fields checked: positive settlement or missing balance still grants retry
  const unmeteredResult = await runDecision({
    setting: { enabled: true, retries: 3 },
    control: { failure_code: 'IMAGE_FAILED', settled_credits: 50, reserved_credits: 50 },
  })
  assert.equal(unmeteredResult.action, 'retry')
})
