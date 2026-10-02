/**
 * Account changes do not make an accepted provider task portable. Recovery
 * holds under the new account, then reuses the original task/key when its
 * account becomes available again; it never turns a read failure into a POST.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService, type MockGenStudioScope } from './fixtures/mock-genstudio-service.js'
import { hashInput, recordTaskStrict } from '../services/task-manifest.js'
import type { Job } from '../models/types.js'

const FULL_SCOPES: MockGenStudioScope[] = [
  'models:read', 'voices:read', 'tts:generate', 'audio:transcribe', 'images:generate',
  'chat:generate', 'video:generate', 'music:generate', 'usage:read', 'content:read', 'content:purchase',
]

function transcriptionModel(id: string) {
  return {
    id, display_name: `Mock ${id}`, provider: 'Gateway mock', language: 'multilingual',
    available: true, available_workers: 1, qualification_only: false,
    supported_languages: ['en'], supports_language_auto_detect: true,
    credits_per_second: 0.25, minimum_credits: 3, price_version: 'account-fixture-v1',
  }
}

void test('an accepted subtitle task remains held on an account/model change and recovers only under its original account', async () => {
  const isolated = await useTempDataDir()
  const service = await startMockGenStudioService()
  const accountA = MOCK_GENSTUDIO_FULL_KEY
  const accountB = 'gsk_mock_story_second_account'
  service.registerKey(accountB, FULL_SCOPES)
  const outDir = path.join(isolated.dir, 'subtitle-output')
  const audioPath = path.join(isolated.dir, 'source.wav')
  const manifestKey = 'EP0001_Chapter_01.srt'
  const inputHash = hashInput('account-owned subtitle source')
  const idempotencyKey = 'story-account-a-accepted-transcription'
  try {
    const settings = await import('../services/app-settings.js')
    const { runSubtitleTranscription } = await import('../services/subtitle-recovery.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await fs.mkdir(outDir, { recursive: true })
    await fs.writeFile(audioPath, 'RIFF-account-owned-audio')
    service.queueScenario('transcription', { states: ['accepted', 'succeeded'] })

    const form = new FormData()
    form.set('file', new Blob([new Uint8Array(await fs.readFile(audioPath))], { type: 'audio/wav' }), 'source.wav')
    form.set('model', 'mock-whisper-v1')
    form.set('language', 'en')
    form.set('word_timestamps', 'true')
    const accepted = await fetch(`${service.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accountA}`, 'Idempotency-Key': idempotencyKey },
      body: form,
    })
    assert.equal(accepted.status, 202)
    const taskId = String((await accepted.json() as { id: string }).id)
    await recordTaskStrict(outDir, manifestKey, {
      provider: 'genstudio', task_id: taskId, idempotency_key: idempotencyKey,
      input_hash: inputHash, submitted_at: new Date().toISOString(), operation: 'transcription', last_state: 'accepted',
    })

    const makeJob = (): Job => ({
      job_id: 'subtitle-account-change-restart', project_slug: '_account_fixture_', episode_id: 'EP0001',
      type: 'subtitles_transcribe', status: 'running', progress: 0, output_lines: [], params: {},
    } as unknown as Job)
    const run = (apiKey: string, job: Job) => runSubtitleTranscription({
      job, outDir, section: 'Chapter_01', manifestKey, inputHash, audioHash: 'sha256:account-owned-audio', apiKey,
      force: false,
      request: { audioPath, modelId: 'mock-whisper-v1', language: 'en', wordTimestamps: true, requestIdentity: 'EP0001:Chapter_01' },
    })

    const restartedUnderB = makeJob()
    const beforeB = service.submissions.length
    await assert.rejects(
      run(accountB, restartedUnderB),
      /not found with the current Gateway connection\/account/i,
      'the new account must hold this accepted task rather than replace it',
    )
    assert.equal(service.submissions.length, beforeB, 'an unavailable old-account task caused no new provider submission')
    assert.ok(service.requests.some(request => request.authorization === `Bearer ${accountB}` && request.path === `/v1/transcriptions/${taskId}`),
      'the new account receives only the account-scoped task lookup')
    const held = JSON.parse(await fs.readFile(path.join(outDir, '.task-manifest.json'), 'utf8'))
    assert.equal(held.tasks[manifestKey].task_id, taskId)
    assert.equal(held.tasks[manifestKey].idempotency_key, idempotencyKey)
    assert.equal(restartedUnderB.params.subtitle_recovery?.sections.Chapter_01.state, 'needs_attention')

    const restartedUnderA = makeJob()
    const recovered = await run(accountA, restartedUnderA)
    assert.match(recovered.srt, /Hello from mock GenStudio/)
    assert.equal(service.providerSubmissionCount('transcription'), 1, 'returning to the original account recovered the accepted task without another POST')
    assert.equal(restartedUnderA.params.genstudio_recovery.assets[manifestKey].idempotency_key, idempotencyKey)
  } finally {
    await service.close()
    await isolated.cleanup()
  }
})

void test('a new account has only its current catalog, balance, and Content Store account facts', async () => {
  const isolated = await useTempDataDir()
  const service = await startMockGenStudioService()
  const accountA = MOCK_GENSTUDIO_FULL_KEY
  const accountB = 'gsk_mock_story_catalog_account_b'
  try {
    const settings = await import('../services/app-settings.js')
    const catalog = await import('../lib/genstudio-client.js')
    const content = await import('../lib/genstudio-content-store.js')
    service.registerContentStoreKey(accountA, 'content-account-a', FULL_SCOPES)
    service.registerContentStoreKey(accountB, 'content-account-b', FULL_SCOPES)
    service.setTranscriptionModelsForKey(accountA, [transcriptionModel('mock-whisper-a')])
    service.setTranscriptionModelsForKey(accountB, [transcriptionModel('mock-whisper-b')])
    service.setAccountOverviewForKey(accountA, { credit_balance: 101 })
    service.setAccountOverviewForKey(accountB, { credit_balance: 202 })
    await settings.setGenStudioUrl(service.baseUrl)
    catalog.clearGenStudioCatalogCache()

    const selectedUnderA = 'mock-whisper-a'
    const modelsA = await catalog.listTranscriptionModelsSnapshot(accountA, { displayFallback: true })
    assert.deepEqual(modelsA.value.map(model => model.id), [selectedUnderA])
    const balanceA = await catalog.getGenStudioAccountOverviewSnapshot(accountA)
    assert.equal(balanceA.value.credit_balance, 101)
    const storeA = await content.getGenStudioContentAccount(accountA)
    assert.equal(storeA.contentAccountId, 'content-account-a')

    const modelsB = await catalog.listTranscriptionModelsSnapshot(accountB, { displayFallback: true })
    assert.deepEqual(modelsB.value.map(model => model.id), ['mock-whisper-b'])
    assert.equal(modelsB.value.some(model => model.id === selectedUnderA), false,
      'the selected A model is retired or unavailable for B and cannot be silently reused')
    const balanceB = await catalog.getGenStudioAccountOverviewSnapshot(accountB)
    assert.equal(balanceB.value.credit_balance, 202)
    const storeB = await content.getGenStudioContentAccount(accountB)
    assert.equal(storeB.contentAccountId, 'content-account-b')

    assert.ok(service.requests.some(request => request.authorization === `Bearer ${accountA}` && request.path === '/v1/transcription/models'))
    assert.ok(service.requests.some(request => request.authorization === `Bearer ${accountB}` && request.path === '/v1/transcription/models'))
    assert.notEqual(storeA.contentAccountId, storeB.contentAccountId)
  } finally {
    const catalog = await import('../lib/genstudio-client.js')
    catalog.clearGenStudioCatalogCache()
    await service.close()
    await isolated.cleanup()
  }
})
