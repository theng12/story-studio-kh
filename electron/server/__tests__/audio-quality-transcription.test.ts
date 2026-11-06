import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { readManifest } from '../services/task-manifest.js'
import { verifyAudioQualityCandidateRawTranscript } from '../services/audio-quality-transcription.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { setApiKey } from '../services/app-secrets-store.js'
import { clearGenStudioCatalogCache } from '../lib/genstudio-client.js'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const job = { project_slug: 'audio-quality-test', episode_id: 'EP0001' }
const actionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

test('candidate alternate ASR is action-replayable, raw-only, and records the live quote it confirmed', async t => {
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
  }
  const first = await verifyAudioQualityCandidateRawTranscript(input)
  assert.match(first.srt, /Hello from mock the Gateway/)
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

  const seen: string[] = []
  await verifyAudioQualityCandidateRawTranscript({ ...input, actionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    section: 'Chapter_02', candidateOutDir: path.join(temporary.dir, 'second-action'),
    authorizeQuote: quote => { seen.push(String(quote.quoted_credit_cost)) } })
  assert.deepEqual(seen, ['7'], 'the owner-facing callback receives the Gateway\'s own figure')
  assert.equal(service.requests.filter(request => /^\/v1\/audio\/transcriptions\/quotes\/[^/]+\/confirm$/.test(request.path)).length, 2,
    'each confirmed candidate confirms exactly one quote')
  assert.match(await fs.readFile(activeSrt, 'utf8'), /must remain unchanged/)
})
