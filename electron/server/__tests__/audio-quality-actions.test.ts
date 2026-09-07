import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { clearGenStudioCatalogCache } from '../lib/genstudio-client.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { setApiKey } from '../services/app-secrets-store.js'
import {
  promoteAudioQualityCandidate,
  readAudioQualityProvenance,
  writeAudioQualityProvenance,
} from '../services/audio-quality-store.js'
import {
  AudioQualityVerificationCreditCeilingError,
  verifyAudioQualityCandidateRawTranscript,
} from '../services/audio-quality-transcription.js'
import { hashSubtitleAudioSources } from '../services/subtitle-completion.js'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const CODE = 'EP0001'
const SECTION = 'Chapter_01'
const ACTION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const JOB = { project_slug: 'audio-quality-actions', episode_id: CODE }

type Fixture = Awaited<ReturnType<typeof fixture>>

async function fixture(root: string, name: string) {
  const episodeDir = path.join(root, name)
  const audioDir = path.join(episodeDir, 'audio')
  const candidateAudioDir = path.join(episodeDir, '.audio-quality-candidates', ACTION, 'audio')
  const candidateOutDir = path.join(episodeDir, '.audio-quality-candidates', ACTION, 'transcripts')
  await Promise.all([fs.mkdir(audioDir, { recursive: true }), fs.mkdir(candidateAudioDir, { recursive: true })])
  const activeFile = `${CODE}_${SECTION}.mp3`
  const candidateFile = activeFile
  await fs.writeFile(path.join(audioDir, activeFile), 'active audio bytes')
  await fs.writeFile(path.join(candidateAudioDir, candidateFile), 'staged candidate bytes')
  await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({
    sections: [{ slug: SECTION, source_file: activeFile, source_files: [activeFile], duration_s: 1 }],
  }))
  const sourceHash = await hashSubtitleAudioSources([path.join(audioDir, activeFile)])
  const candidateHash = await hashSubtitleAudioSources([path.join(candidateAudioDir, candidateFile)])
  assert.ok(sourceHash)
  assert.ok(candidateHash)
  await writeAudioQualityProvenance(episodeDir, {
    version: 1,
    chapters: {},
    actions: {
      [ACTION]: {
        action_id: ACTION,
        scope_fingerprint: 'scope-fingerprint',
        source_fingerprint: 'source-fingerprint',
        sections: [SECTION],
        source_files: { [SECTION]: [activeFile] },
        mode: 'check_and_repair',
        verification_credit_ceiling: 7,
        verification_committed_credits: 0,
        verification_model_id: 'mock-whisper-v1',
        state: 'needs_approval',
        created_at: '2026-09-08T00:00:00.000Z',
        candidate: {
          model_id: 'mock-tts-v1', voice_id: 'mock-voice', speed: 1,
          staging_dir: path.relative(episodeDir, candidateAudioDir),
          source_audio_hashes: { [SECTION]: sourceHash },
          candidate_files: { [SECTION]: [candidateFile] },
          candidate_audio_hashes: { [SECTION]: candidateHash },
        },
      },
    },
  })
  return { episodeDir, audioDir, candidateAudioDir, candidateOutDir, activeFile, candidateFile, sourceHash, candidateHash }
}

function promotionInput(value: Fixture) {
  return {
    episodeDir: value.episodeDir,
    audioDir: value.audioDir,
    candidateAudioDir: value.candidateAudioDir,
    actionId: ACTION,
    episodeCode: CODE,
    sections: [SECTION],
    expectedSourceHashes: { [SECTION]: value.sourceHash },
    expectedSourceFiles: { [SECTION]: [value.activeFile] },
    expectedCandidateFiles: { [SECTION]: [value.candidateFile] },
    expectedCandidateHashes: { [SECTION]: value.candidateHash },
  }
}

async function sourceMap(value: Fixture): Promise<string[]> {
  const sidecar = JSON.parse(await fs.readFile(path.join(value.episodeDir, 'audio_chapters.json'), 'utf8'))
  return sidecar.sections[0].source_files
}

void test('audio-quality store and raw-ASR helper fence staged promotion and held-action verification', async t => {
  const temporary = await useTempDataDir()
  const service = await startMockGenStudioService()
  await setGenStudioUrl(service.baseUrl)
  await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  clearGenStudioCatalogCache()
  t.after(async () => {
    clearGenStudioCatalogCache()
    await service.close()
    await temporary.cleanup()
  })

  await t.test('a candidate modified after raw ASR is not promoted', async () => {
    const value = await fixture(temporary.dir, 'candidate-mutated')
    await fs.writeFile(path.join(value.candidateAudioDir, value.candidateFile), 'tampered after ASR')
    await assert.rejects(promoteAudioQualityCandidate(promotionInput(value)), /changed after ASR/)
    assert.deepEqual(await sourceMap(value), [value.activeFile])
    assert.equal(await fs.readFile(path.join(value.audioDir, value.activeFile), 'utf8'), 'active audio bytes')
  })

  await t.test('an active filename-map change rejects promotion even when replacement bytes match', async () => {
    const value = await fixture(temporary.dir, 'active-map-mutated')
    const replacement = `${CODE}_${SECTION}_manual.mp3`
    await fs.copyFile(path.join(value.audioDir, value.activeFile), path.join(value.audioDir, replacement))
    await fs.writeFile(path.join(value.episodeDir, 'audio_chapters.json'), JSON.stringify({
      sections: [{ slug: SECTION, source_file: replacement, source_files: [replacement], duration_s: 1 }],
    }))
    await assert.rejects(promoteAudioQualityCandidate(promotionInput(value)), /changed while the candidate was being verified/)
    assert.deepEqual(await sourceMap(value), [replacement])
  })

  await t.test('a higher ceiling resumes the same staged action once, preserves its candidate choice, and promotes it', async () => {
    const value = await fixture(temporary.dir, 'higher-ceiling')
    const transcriptInput = {
      job: JOB, actionId: ACTION, section: SECTION,
      candidateAudioPath: path.join(value.candidateAudioDir, value.candidateFile),
      candidateOutDir: value.candidateOutDir,
      apiKey: MOCK_GENSTUDIO_FULL_KEY,
      transcription: { modelId: 'mock-whisper-v1', language: 'en' },
    }
    await assert.rejects(
      verifyAudioQualityCandidateRawTranscript({ ...transcriptInput, verification_credit_ceiling: 6 }),
      error => error instanceof AudioQualityVerificationCreditCeilingError && error.quote.quoted_credit_cost === 7,
    )
    assert.equal(service.providerSubmissionCount('transcription'), 0, 'an above-ceiling quote never confirms ASR')
    assert.equal(service.providerSubmissionCount('tts'), 0, 'a held candidate never regenerates TTS')

    const held = await readAudioQualityProvenance(value.episodeDir)
    held.actions![ACTION]!.verification_credit_ceiling = 7
    await writeAudioQualityProvenance(value.episodeDir, held)
    let reservations = 0
    await verifyAudioQualityCandidateRawTranscript({
      ...transcriptInput,
      verification_credit_ceiling: 7,
      authorizeQuote: async quote => {
        assert.equal(quote.quoted_credit_cost, 7)
        reservations++
        await updateCommitted(value.episodeDir, quote.quoted_credit_cost || 0)
      },
    })
    assert.equal(reservations, 1)
    assert.equal(service.providerSubmissionCount('transcription'), 1)
    assert.equal(service.providerSubmissionCount('tts'), 0, 'raising only ASR allowance never mints another TTS request')

    const promoted = await promoteAudioQualityCandidate(promotionInput(value))
    assert.deepEqual(await sourceMap(value), promoted[SECTION])
    const action = (await readAudioQualityProvenance(value.episodeDir)).actions![ACTION]!
    assert.equal(action.candidate?.model_id, 'mock-tts-v1')
    assert.equal(action.candidate?.voice_id, 'mock-voice')
    assert.equal(action.candidate?.source_audio_hashes[SECTION], value.sourceHash)
  })

  await t.test('restart replays only the action-owned candidate ASR and leaves the active map untouched before promotion', async () => {
    const value = await fixture(temporary.dir, 'restart-before-promotion')
    const before = service.providerSubmissionCount('transcription')
    const input = {
      job: { ...JOB, project_slug: 'audio-quality-actions-restart' }, actionId: ACTION, section: SECTION,
      candidateAudioPath: path.join(value.candidateAudioDir, value.candidateFile), candidateOutDir: value.candidateOutDir,
      apiKey: MOCK_GENSTUDIO_FULL_KEY, transcription: { modelId: 'mock-whisper-v1', language: 'en' },
      verification_credit_ceiling: 7,
    }
    await verifyAudioQualityCandidateRawTranscript(input)
    await verifyAudioQualityCandidateRawTranscript(input)
    assert.equal(service.providerSubmissionCount('transcription'), before + 1,
      'restart rejoined this action-owned candidate task rather than issuing another request')
    assert.equal(service.providerSubmissionCount('tts'), 0)
    assert.deepEqual(await sourceMap(value), [value.activeFile], 'only promotion changes the active selection')
    assert.equal(await fs.readFile(path.join(value.audioDir, value.activeFile), 'utf8'), 'active audio bytes')
  })
})

async function updateCommitted(episodeDir: string, cost: number): Promise<void> {
  const current = await readAudioQualityProvenance(episodeDir)
  const action = current.actions?.[ACTION]
  assert.ok(action)
  action.verification_committed_credits = (action.verification_committed_credits || 0) + cost
  await writeAudioQualityProvenance(episodeDir, current)
}
