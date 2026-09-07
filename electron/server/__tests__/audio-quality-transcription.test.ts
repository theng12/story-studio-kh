import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { readManifest } from '../services/task-manifest.js'
import {
  AudioQualityVerificationCreditCeilingError,
  verifyAudioQualityCandidateRawTranscript,
} from '../services/audio-quality-transcription.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { setApiKey } from '../services/app-secrets-store.js'
import { clearGenStudioCatalogCache } from '../lib/genstudio-client.js'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const job = { project_slug: 'audio-quality-test', episode_id: 'EP0001' }
const actionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

test('candidate alternate ASR is action-replayable, raw-only, and cannot confirm above its approved allowance', async t => {
  const temporary = await useTempDataDir()
  const service = await startMockGenStudioService()
  t.after(async () => {
    clearGenStudioCatalogCache()
    await service.close()
    await temporary.cleanup()
  })
  await setGenStudioUrl(service.baseUrl)
  await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  clearGenStudioCatalogCache()
  const activeDir = path.join(temporary.dir, 'active-subtitles')
  const candidateDir = path.join(temporary.dir, 'candidate-asr')
  const audioPath = path.join(temporary.dir, 'candidate.mp3')
  await fs.mkdir(activeDir, { recursive: true })
  await fs.writeFile(audioPath, 'candidate audio bytes')
  const activeSrt = path.join(activeDir, 'EP0001_Chapter_01.srt')
  await fs.writeFile(activeSrt, '1\n00:00:00,000 --> 00:00:01,000\nActive subtitle must remain unchanged.\n')

  const input = {
    job, actionId, section: 'Chapter_01', candidateAudioPath: audioPath, candidateOutDir: candidateDir,
    apiKey: MOCK_GENSTUDIO_FULL_KEY, transcription: { modelId: 'mock-whisper-v1', language: 'en' },
    verification_credit_ceiling: 7,
  }
  const first = await verifyAudioQualityCandidateRawTranscript(input)
  assert.match(first.srt, /Hello from mock GenStudio/)
  assert.ok(first.rawCues.length > 0)
  assert.ok(first.quote)
  assert.equal(first.quote.quoted_credit_cost, 7)
  assert.equal(service.providerSubmissionCount('transcription'), 1)
  assert.match(await fs.readFile(activeSrt, 'utf8'), /must remain unchanged/)
  const manifest = await readManifest(candidateDir)
  const entry = Object.values(manifest.tasks)[0]!
  assert.equal(entry.operation, 'transcription')
  assert.equal(entry.request_scope, actionId)
  assert.equal(entry.last_state, 'succeeded')
  assert.equal(await fs.readdir(candidateDir).then(files => files.some(file => file.endsWith('.corrected.srt'))), false,
    'candidate verification never rewrites a transcript to match the script')

  const replay = await verifyAudioQualityCandidateRawTranscript(input)
  assert.equal(replay.taskId, first.taskId)
  assert.equal(service.providerSubmissionCount('transcription'), 1, 'restart reattaches to the action-owned task')

  let committed = 0
  const reserve = async (quote: { id: string; quoted_credit_cost?: number; price_version?: string }) => {
    const cost = quote.quoted_credit_cost ?? Number.POSITIVE_INFINITY
    const remaining = 7 - committed
    if (cost > remaining) throw new AudioQualityVerificationCreditCeilingError(quote, remaining)
    committed += cost
  }
  await verifyAudioQualityCandidateRawTranscript({ ...input, actionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    section: 'Chapter_02', candidateOutDir: path.join(temporary.dir, 'shared-ceiling-one'), authorizeQuote: reserve })
  await assert.rejects(
    verifyAudioQualityCandidateRawTranscript({ ...input, actionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      section: 'Chapter_03', candidateOutDir: path.join(temporary.dir, 'shared-ceiling-two'), authorizeQuote: reserve }),
    error => error instanceof AudioQualityVerificationCreditCeilingError && error.remainingCredits === 0,
  )
  assert.equal(service.requests.filter(request => /^\/v1\/audio\/transcriptions\/quotes\/[^/]+\/confirm$/.test(request.path)).length, 2,
    'the action-level reservation permits one shared-ceiling confirmation only')

  const overCeilingDir = path.join(temporary.dir, 'over-ceiling')
  await assert.rejects(
    verifyAudioQualityCandidateRawTranscript({ ...input, actionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', candidateOutDir: overCeilingDir,
      verification_credit_ceiling: 6 }),
    error => error instanceof AudioQualityVerificationCreditCeilingError
      && error.quote.quoted_credit_cost === 7,
  )
  assert.equal(service.requests.filter(request => /^\/v1\/audio\/transcriptions\/quotes\/[^/]+\/confirm$/.test(request.path)).length, 2,
    'the above-ceiling path quotes but never confirms another candidate request')
  await assert.rejects(fs.access(path.join(overCeilingDir, 'EP0001_Chapter_01.srt')))
  assert.match(await fs.readFile(activeSrt, 'utf8'), /must remain unchanged/)
})
