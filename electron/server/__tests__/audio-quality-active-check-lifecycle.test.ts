import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const ACTION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const CANCEL_ACTION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const STALE_ACTION = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

void test('active-audio ASR check quotes, holds, resumes once, and never changes active assets', async () => {
  const isolated = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const service = await startMockGenStudioService()
  try {
    const app = (await import('../app.js')).app
    const jq = await import('../services/job-queue.js')
    const pm = await import('../services/project-manager.js')
    const ideas = await import('../services/idea-manager.js')
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const store = await import('../services/audio-quality-store.js')
    const { hashSubtitleAudioSources } = await import('../services/subtitle-completion.js')
    const { recordSubtitleSourceEvidence } = await import('../services/subtitle-recovery.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    await settings.setGenStudioUrl(service.baseUrl); await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY); client.clearGenStudioCatalogCache()
    const project = await pm.createProject({ name: 'Active ASR lifecycle', episode_prefix: 'AC', episode_digits: 4 })
    await pm.updateConfig(project.slug, { safety_checks: { silent_narration: 'off' }, audio_quality: { mode: 'check_and_repair', alternate_transcription_model: 'mock-whisper-v1' } })
    const [idea] = await ideas.addIdeas(project.slug, [{ title: 'One active chapter', logline: 'Fixture', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'mock-chat-v1')
    const accepted = await ideas.acceptIdea(project.slug, idea!.id, false); const code = accepted.episode_code
    const paths = await resolveEpisodePathsByCode(project.slug, code)
    await Promise.all([paths.script_dir, paths.subtitles_dir].map(dir => fs.mkdir(dir, { recursive: true })))
    await fs.writeFile(paths.narration_docx, '# Narration\n\n## Chapter 01: Verify\n\nHello from mock the Gateway.\n')
    const terminal = async (id: string) => waitFor(() => ['done', 'error', 'cancelled'].includes(jq.getJob(id)?.status || ''), { label: id, timeoutMs: 15_000 })
    const id = (body: any) => String(body.job_id || body.job?.job_id || '')
    const generated = await request(app).post(`/api/projects/${project.slug}/generate/audio`).send({ episode_id: code, model: 'mock-tts-v1', voice: 'mock-voice', sections: 'all', speed: 1 })
    assert.equal(generated.status, 201, JSON.stringify(generated.body)); await terminal(id(generated.body)); assert.equal(jq.getJob(id(generated.body))?.status, 'done')
    const merge = await request(app).post(`/api/projects/${project.slug}/generate/audio-merge`).send({ episode_id: code, chapters: [], gap_duration: 0, normalize_volume: false, narration_volume: 1 })
    assert.equal(merge.status, 201, JSON.stringify(merge.body)); await terminal(id(merge.body)); assert.equal(jq.getJob(id(merge.body))?.status, 'done')
    const filename = `${code}_Chapter_01.mp3`; const srtName = `${code}_Chapter_01.srt`
    const originalAudio = await fs.readFile(path.join(paths.audio_dir, filename))
    const originalMap = await fs.readFile(path.join(paths.episode_dir, 'audio_chapters.json'), 'utf8')
    const originalSrt = '1\n00:00:00,000 --> 00:00:01,000\nHello from mock the Gateway.\n'
    await fs.writeFile(path.join(paths.subtitles_dir, srtName), originalSrt)
    const activeHash = await hashSubtitleAudioSources([path.join(paths.audio_dir, filename)]); assert.ok(activeHash)
    await recordSubtitleSourceEvidence(paths.subtitles_dir, srtName, activeHash, 'legacy-whisper')
    const quoteRequest = () => request(app).post(`/api/projects/${project.slug}/episodes/${code}/audio-quality/active-check/quote`).send({ operation_id: ACTION, sections: ['Chapter_01'] })
    const [quoted, concurrentQuote] = await Promise.all([quoteRequest(), quoteRequest()])
    assert.equal(quoted.status, 200, JSON.stringify(quoted.body)); assert.equal(concurrentQuote.status, 200, JSON.stringify(concurrentQuote.body))
    assert.deepEqual(concurrentQuote.body, quoted.body, 'concurrent quote replay must return the first immutable checkpoint')
    assert.equal(service.requests.filter(entry => entry.method === 'POST' && entry.path === '/v1/audio/transcriptions/quotes').length, 1,
      'one active action may obtain only one provider quote')
    assert.equal(quoted.body.state, 'quoted'); assert.equal(quoted.body.model_id, 'mock-whisper-v1')
    const quoteReplay = await quoteRequest()
    assert.equal(quoteReplay.status, 200, JSON.stringify(quoteReplay.body))
    assert.deepEqual(quoteReplay.body, quoted.body, 'same quote action reuses its immutable checkpoint')
    const wrongFingerprint = await request(app).post(`/api/projects/${project.slug}/episodes/${code}/audio-quality/active-check/confirm`).send({ operation_id: ACTION, source_fingerprint: 'different-active-source', verification_credit_ceiling: 7 })
    assert.equal(wrongFingerprint.status, 409, JSON.stringify(wrongFingerprint.body))
    assert.equal((await store.readAudioQualityProvenance(paths.episode_dir)).actions?.[ACTION]?.active_check?.state, 'quoted')
    const held = await request(app).post(`/api/projects/${project.slug}/episodes/${code}/audio-quality/active-check/confirm`).send({ operation_id: ACTION, source_fingerprint: quoted.body.source_fingerprint, verification_credit_ceiling: 6 })
    assert.equal(held.status, 201, JSON.stringify(held.body)); await terminal(id(held.body)); assert.equal(jq.getJob(id(held.body))?.status, 'error')
    await waitFor(async () => (
      (await store.readAudioQualityProvenance(paths.episode_dir)).actions?.[ACTION]?.active_check?.state === 'needs_approval'
    ), { label: 'durable held active-ASR quote', timeoutMs: 2_000 }).catch(() => undefined)
    const heldAction = (await store.readAudioQualityProvenance(paths.episode_dir)).actions?.[ACTION]
    assert.equal(heldAction?.active_check?.state, 'needs_approval', JSON.stringify({
      job: jq.getJob(id(held.body)), activeCheck: heldAction?.active_check,
    })); assert.equal(service.providerSubmissionCount('transcription'), 0)
    const heldReplay = await request(app).post(`/api/projects/${project.slug}/episodes/${code}/audio-quality/active-check/confirm`).send({ operation_id: ACTION, source_fingerprint: quoted.body.source_fingerprint, verification_credit_ceiling: 6 })
    assert.equal(heldReplay.status, 200, JSON.stringify(heldReplay.body)); assert.equal(id(heldReplay.body), id(held.body))
    assert.equal(service.providerSubmissionCount('transcription'), 0, 'held action replay cannot confirm the quote')
    const resumed = await request(app).post(`/api/projects/${project.slug}/episodes/${code}/audio-quality/active-check/confirm`).send({ operation_id: ACTION, source_fingerprint: quoted.body.source_fingerprint, verification_credit_ceiling: 7 })
    assert.ok([200, 201].includes(resumed.status), JSON.stringify(resumed.body)); await terminal(id(resumed.body)); assert.equal(jq.getJob(id(resumed.body))?.status, 'done')
    assert.equal(service.providerSubmissionCount('tts'), 1, 'active check never submits TTS')
    assert.equal(service.providerSubmissionCount('transcription'), 1, 'raised ceiling confirms exactly one quoted ASR task')
    assert.deepEqual(await fs.readFile(path.join(paths.audio_dir, filename)), originalAudio)
    assert.equal(await fs.readFile(path.join(paths.episode_dir, 'audio_chapters.json'), 'utf8'), originalMap)
    assert.equal(await fs.readFile(path.join(paths.subtitles_dir, srtName), 'utf8'), originalSrt)
    const replay = await request(app).post(`/api/projects/${project.slug}/episodes/${code}/audio-quality/active-check/confirm`).send({ operation_id: ACTION, source_fingerprint: quoted.body.source_fingerprint, verification_credit_ceiling: 7 })
    assert.equal(replay.status, 200, JSON.stringify(replay.body)); assert.equal(id(replay.body), id(resumed.body)); assert.equal(service.providerSubmissionCount('transcription'), 1)

    // A cancellation before executor admission cannot confirm ASR or modify the
    // quoted active source. Queue-level pausing makes this deterministic.
    const cancelQuote = await request(app).post(`/api/projects/${project.slug}/episodes/${code}/audio-quality/active-check/quote`).send({ operation_id: CANCEL_ACTION, sections: ['Chapter_01'] })
    assert.equal(cancelQuote.status, 200, JSON.stringify(cancelQuote.body))
    await jq.setQueuePaused(true)
    try {
      const queued = await request(app).post(`/api/projects/${project.slug}/episodes/${code}/audio-quality/active-check/confirm`).send({ operation_id: CANCEL_ACTION, source_fingerprint: cancelQuote.body.source_fingerprint, verification_credit_ceiling: 7 })
      assert.equal(queued.status, 201, JSON.stringify(queued.body)); assert.equal(jq.getJob(id(queued.body))?.status, 'queued')
      const cancelled = await request(app).post(`/api/projects/${project.slug}/jobs/${id(queued.body)}/cancel`).send({})
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body)); assert.equal(cancelled.body.job.status, 'cancelled')
    } finally {
      await jq.setQueuePaused(false)
    }
    assert.equal(service.providerSubmissionCount('transcription'), 1, 'cancelled active check never confirms ASR')
    assert.deepEqual(await fs.readFile(path.join(paths.audio_dir, filename)), originalAudio)
    assert.equal(await fs.readFile(path.join(paths.episode_dir, 'audio_chapters.json'), 'utf8'), originalMap)
    assert.equal(await fs.readFile(path.join(paths.subtitles_dir, srtName), 'utf8'), originalSrt)

    // The executor rehashes the actual active source before confirming a quote;
    // a later source change turns the action into an error before provider work.
    const staleQuote = await request(app).post(`/api/projects/${project.slug}/episodes/${code}/audio-quality/active-check/quote`).send({ operation_id: STALE_ACTION, sections: ['Chapter_01'] })
    assert.equal(staleQuote.status, 200, JSON.stringify(staleQuote.body))
    const changedAudio = Buffer.concat([originalAudio, Buffer.from('fixture-source-change')])
    await fs.writeFile(path.join(paths.audio_dir, filename), changedAudio)
    const stale = await request(app).post(`/api/projects/${project.slug}/episodes/${code}/audio-quality/active-check/confirm`).send({ operation_id: STALE_ACTION, source_fingerprint: staleQuote.body.source_fingerprint, verification_credit_ceiling: 7 })
    assert.equal(stale.status, 201, JSON.stringify(stale.body)); await terminal(id(stale.body)); assert.equal(jq.getJob(id(stale.body))?.status, 'error')
    assert.equal(service.providerSubmissionCount('transcription'), 1, 'changed active source cannot spend the old quote')
    assert.deepEqual(await fs.readFile(path.join(paths.audio_dir, filename)), changedAudio, 'stale action never overwrites the newer active bytes')
    assert.equal(await fs.readFile(path.join(paths.episode_dir, 'audio_chapters.json'), 'utf8'), originalMap)
    assert.equal(await fs.readFile(path.join(paths.subtitles_dir, srtName), 'utf8'), originalSrt)
    const afterSourceChange = await request(app).get(`/api/projects/${project.slug}/episodes/${code}/audio-sections`)
    assert.equal(afterSourceChange.status, 200, JSON.stringify(afterSourceChange.body))
    const chapter = afterSourceChange.body.sections.find((section: { slug?: string }) => section.slug === 'Chapter_01')
    assert.ok(chapter, JSON.stringify(afterSourceChange.body))
    assert.equal(chapter.quality?.active_check, undefined, 'old active-ASR evidence is historical after a source change')
  } finally { await service.close(); await isolated.cleanup() }
})
