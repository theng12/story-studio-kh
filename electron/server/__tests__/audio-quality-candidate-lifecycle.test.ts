/**
 * Actual bounded repair flow: a local inspection is free, then the confirmed
 * candidate is the only TTS work. Its raw alternate-ASR proof and the local
 * assembly successor must finish before the action is Fixed.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const CHECK_ACTION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CANDIDATE_ACTION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RECOVERED_CANDIDATE_ACTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const FAILED_REMOTE_ACTION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const CANCELLED_REMOTE_ACTION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

void test('confirmed audio-quality candidate survives queue reload, preserves old bytes until promotion, then refreshes the selected subtitle timeline', async () => {
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
    const qualityStore = await import('../services/audio-quality-store.js')
    const { hashSubtitleAudioSources } = await import('../services/subtitle-completion.js')
    const { recordSubtitleSourceEvidence } = await import('../services/subtitle-recovery.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')

    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    const project = await pm.createProject({ name: 'Audio quality lifecycle', episode_prefix: 'EP', episode_digits: 4 })
    assert.equal(await pm.updateConfig(project.slug, {
      audio_quality: { mode: 'check_and_repair', alternate_transcription_model: 'mock-whisper-v1' },
    }), true)
    const [idea] = await ideas.addIdeas(project.slug, [{
      title: 'Two chapters, one reviewable', logline: 'Candidate repair integration.', themes: [], suggested_chapters: 2,
      suggested_length: 'short', mood: 'calm',
    }], 'mock-chat-v1')
    const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
    const episodeId = accepted.episode_code
    const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
    await Promise.all([paths.script_dir, paths.subtitles_dir].map(dir => fs.mkdir(dir, { recursive: true })))
    await fs.writeFile(paths.narration_docx,
      '# Narration\n\n## Chapter 01: Repair\n\nHello from the mock Gateway service.\n\n## Chapter 02: Preserve\n\nThe untouched chapter remains selected.\n')

    const terminal = async (jobId: string, label: string) => waitFor(() => {
      const status = jq.getJob(jobId)?.status
      return status === 'done' || status === 'error' || status === 'cancelled'
    }, { label, timeoutMs: 15_000 })
    const jobIdOf = (body: any): string => String(body.job_id || body.job?.job_id || '')

    const originalAudio = await request(app).post(`/api/projects/${project.slug}/generate/audio`).send({
      episode_id: episodeId, model: 'mock-tts-v1', voice: 'mock-voice', sections: 'all', speed: 1, force: false,
    })
    assert.equal(originalAudio.status, 201, JSON.stringify(originalAudio.body))
    const originalJobId = jobIdOf(originalAudio.body)
    await terminal(originalJobId, 'ordinary source audio')
    assert.equal(jq.getJob(originalJobId)?.status, 'done')

    const initialMerge = await request(app).post(`/api/projects/${project.slug}/generate/audio-merge`).send({
      episode_id: episodeId, chapters: [], gap_duration: 0, normalize_volume: false, narration_volume: 1,
    })
    assert.equal(initialMerge.status, 201, JSON.stringify(initialMerge.body))
    await terminal(jobIdOf(initialMerge.body), 'initial Audio Assembly')
    assert.equal(jq.getJob(jobIdOf(initialMerge.body))?.status, 'done')

    const activeFile = `${episodeId}_Chapter_01.mp3`
    const untouchedFile = `${episodeId}_Chapter_02.mp3`
    const oldBytes = await fs.readFile(path.join(paths.audio_dir, activeFile))
    const untouchedBytes = await fs.readFile(path.join(paths.audio_dir, untouchedFile))
    const activeSourceHash = await hashSubtitleAudioSources([path.join(paths.audio_dir, activeFile)])
    const untouchedSourceHash = await hashSubtitleAudioSources([path.join(paths.audio_dir, untouchedFile)])
    assert.ok(activeSourceHash)
    assert.ok(untouchedSourceHash)
    const untouchedSrt = '1\n00:00:00,000 --> 00:00:01,000\nThe untouched chapter remains selected.\n'
    await fs.writeFile(path.join(paths.subtitles_dir, `${episodeId}_Chapter_01.srt`),
      '1\n00:00:00,000 --> 00:00:01,000\nA deliberately unrelated old transcript.\n')
    await fs.writeFile(path.join(paths.subtitles_dir, `${episodeId}_Chapter_02.srt`), untouchedSrt)
    await recordSubtitleSourceEvidence(paths.subtitles_dir, `${episodeId}_Chapter_01.srt`, activeSourceHash, 'legacy-whisper')
    await recordSubtitleSourceEvidence(paths.subtitles_dir, `${episodeId}_Chapter_02.srt`, untouchedSourceHash, 'legacy-whisper')

    const check = await request(app)
      .post(`/api/projects/${project.slug}/episodes/${episodeId}/audio-quality/check`)
      .send({ operation_id: CHECK_ACTION, sections: ['Chapter_01'], candidate_audio: { model: 'mock-tts-v1', voice: 'mock-voice' } })
    assert.equal(check.status, 200, JSON.stringify(check.body))
    assert.equal(check.body.repair?.eligible, true)
    const actionId = String(check.body.action_id)
    assert.equal(actionId, CHECK_ACTION)

    const held = await request(app)
      .post(`/api/projects/${project.slug}/episodes/${episodeId}/audio-quality/confirm`)
      .send({ operation_id: actionId, confirm_repair: true, verification_credit_ceiling: 6,
        source_fingerprint: check.body.repair.source_fingerprint,
        candidate_audio: { model: 'mock-tts-v1', voice: 'mock-voice', speed: 1 } })
    assert.equal(held.status, 201, JSON.stringify(held.body))
    const heldJobId = jobIdOf(held.body)
    await terminal(heldJobId, 'above-ceiling candidate')
    assert.equal(jq.getJob(heldJobId)?.status, 'error')
    assert.equal(service.providerSubmissionCount('tts'), 3, 'candidate TTS was submitted once after the two ordinary source requests')
    assert.equal(service.providerSubmissionCount('transcription'), 0, 'above-ceiling alternate ASR quote was never confirmed')
    assert.deepEqual(await fs.readFile(path.join(paths.audio_dir, activeFile)), oldBytes, 'held candidate never overwrites active audio')

    await waitFor(async () => (
      (await qualityStore.readAudioQualityProvenance(paths.episode_dir)).actions?.[actionId]?.state === 'needs_approval'
    ), { label: 'held quality action to persist', timeoutMs: 2_000 })
    const heldAction = (await qualityStore.readAudioQualityProvenance(paths.episode_dir)).actions?.[actionId]
    assert.equal(heldAction?.state, 'needs_approval', JSON.stringify({
      action: heldAction,
      job: jq.getJob(heldJobId),
    }))
    assert.equal(heldAction?.candidate?.model_id, 'mock-tts-v1')
    assert.equal(heldAction?.candidate?.voice_id, 'mock-voice')

    // Simulate an app stop after the remote candidate TTS was accepted but
    // before this quality action reached its local ASR/refresh stage. Boot
    // must retain the server-stamped quality branch and reclaim it; it must
    // never fall through to ordinary active-audio generation.
    await jq._waitForJobPersistenceForTesting()
    const jobsFile = path.join(pm.getProjectDir(project.slug)!, 'jobs.json')
    const persisted = JSON.parse(await fs.readFile(jobsFile, 'utf8'))
    const restartJob = persisted.jobs.find((job: any) => job.job_id === heldJobId)
    assert.ok(restartJob?.params?.quality_repair?.action_id === actionId, JSON.stringify(restartJob))
    restartJob.status = 'running'
    restartJob.finished_at = null
    restartJob.local_execution_complete = false
    await fs.writeFile(jobsFile, JSON.stringify(persisted))
    await waitFor(() => {
      try {
        jq._forgetProjectPersistenceForTesting(project.slug)
        return true
      } catch {
        return false
      }
    }, { label: 'candidate job persistence to become idle before boot reload', timeoutMs: 2_000 })
    const { registerAllExecutors } = await import('../boot/executors.js')
    registerAllExecutors({ loadSettings: false })
    await jq.getJobs(project.slug)
    await waitFor(() => {
      const status = jq.getJob(heldJobId)?.status
      return status === 'error' || status === 'cancelled' || status === 'done'
    }, { label: 'boot-recovered quality candidate', timeoutMs: 15_000 })
    const bootRecovered = jq.getJob(heldJobId)
    assert.equal(bootRecovered?.params?.quality_repair?.action_id, actionId)
    assert.equal(service.providerSubmissionCount('tts'), 3,
      'boot recovery reclaims the candidate task instead of submitting ordinary active audio')
    assert.deepEqual(await fs.readFile(path.join(paths.audio_dir, activeFile)), oldBytes,
      'boot recovery cannot overwrite active audio before candidate promotion')

    const resumed = await request(app)
      .post(`/api/projects/${project.slug}/episodes/${episodeId}/audio-quality/confirm`)
      .send({ operation_id: actionId, confirm_repair: true, verification_credit_ceiling: 7,
        source_fingerprint: check.body.repair.source_fingerprint,
        candidate_audio: { model: 'mock-tts-v1', voice: 'mock-voice', speed: 1 } })
    assert.ok([200, 201].includes(resumed.status), JSON.stringify(resumed.body))
    const resumedJobId = jobIdOf(resumed.body)
    await terminal(resumedJobId, 'resumed candidate')
    const candidateJob = jq.getJob(resumedJobId)
    assert.equal(candidateJob?.status, 'done')
    const refreshJobId = String(candidateJob?.result?.quality_repair?.refresh_job_id || '')
    assert.ok(refreshJobId, JSON.stringify(candidateJob?.result))
    const promotedCheckpoint = (await qualityStore.readAudioQualityProvenance(paths.episode_dir)).actions?.[actionId]
    const promotedFiles = promotedCheckpoint?.candidate?.promoted_files?.Chapter_01
    assert.ok(promotedFiles?.length, JSON.stringify(promotedCheckpoint))
    assert.equal(await fs.stat(path.join(paths.audio_dir, promotedFiles[0]!)).then(stat => stat.isFile() && stat.size > 0).catch(() => false), true,
      JSON.stringify({ audioDir: paths.audio_dir, promotedFiles }))
    const promotedSidecar = JSON.parse(await fs.readFile(path.join(paths.episode_dir, 'audio_chapters.json'), 'utf8'))
    const selectedBeforeRefresh = promotedSidecar.sections?.find((section: any) => section.slug === 'Chapter_01')?.source_files
    assert.deepEqual(selectedBeforeRefresh, promotedFiles, JSON.stringify({ promotedCheckpoint, promotedSidecar }))
    await terminal(refreshJobId, 'candidate Audio Assembly refresh')
    assert.equal(jq.getJob(refreshJobId)?.status, 'done', JSON.stringify(jq.getJob(refreshJobId)))
    assert.equal(service.providerSubmissionCount('tts'), 3, 'raising only ASR allowance reuses staged candidate TTS')
    assert.equal(service.providerSubmissionCount('transcription'), 1, 'higher ceiling confirms exactly one alternate ASR task')

    const repaired = (await qualityStore.readAudioQualityProvenance(paths.episode_dir)).actions?.[actionId]
    assert.equal(repaired?.state, 'fixed')
    assert.equal(repaired?.candidate?.model_id, 'mock-tts-v1')
    assert.equal(repaired?.candidate?.voice_id, 'mock-voice')
    const sidecar = JSON.parse(await fs.readFile(path.join(paths.episode_dir, 'audio_chapters.json'), 'utf8'))
    const selected = sidecar.sections.find((section: any) => section.slug === 'Chapter_01').source_files
    assert.match(selected[0], /_v2\.mp3$/)
    assert.deepEqual(sidecar.sections.map((section: any) => section.slug), ['Chapter_01', 'Chapter_02'])
    assert.equal(sidecar.sections.length, 2)
    assert.equal(sidecar.sections.every((section: any) => Number(section.duration_s) > 0), true,
      'the refresh assembles the full selected episode timeline, not only the repaired chapter')
    assert.deepEqual(sidecar.sections.find((section: any) => section.slug === 'Chapter_02').source_files, [untouchedFile])
    assert.deepEqual(await fs.readFile(path.join(paths.audio_dir, untouchedFile)), untouchedBytes)
    assert.match(await fs.readFile(path.join(paths.subtitles_dir, `${episodeId}_Chapter_01.srt`), 'utf8'), /Hello from mock the Gateway/)
    assert.equal(await fs.readFile(path.join(paths.subtitles_dir, `${episodeId}_Chapter_02.srt`), 'utf8'), untouchedSrt)
    assert.equal((await jq.getJobs(project.slug)).some(job => job.job_id === refreshJobId
      && job.type === 'audio_merge' && job.params?.audio_quality_refresh?.action_id === actionId && job.status === 'done'), true,
    'the candidate queues and completes the server-only Audio Assembly/subtitle refresh')

    const ordinary = await request(app).post(`/api/projects/${project.slug}/generate/audio`).send({
      episode_id: episodeId, model: 'mock-tts-v1', voice: 'mock-voice', sections: 'Chapter_01', speed: 1, force: true,
      operation_id: CANDIDATE_ACTION,
    })
    assert.equal(ordinary.status, 201, JSON.stringify(ordinary.body))
    await terminal(jobIdOf(ordinary.body), 'ordinary explicit regeneration')
    const afterOrdinary = JSON.parse(await fs.readFile(path.join(paths.episode_dir, 'audio_chapters.json'), 'utf8'))
    assert.deepEqual(afterOrdinary.sections.find((section: any) => section.slug === 'Chapter_01').source_files, [activeFile],
      'a later ordinary forced regeneration intentionally retakes the active base mapping')
    assert.deepEqual(afterOrdinary.sections.find((section: any) => section.slug === 'Chapter_02').source_files, [untouchedFile],
      'a later ordinary regeneration leaves unrelated selected audio alone')
  } finally {
    const jq = await import('../services/job-queue.js').catch(() => null)
    await jq?._waitForJobPersistenceForTesting()
    await service.close()
    await isolated.cleanup()
  }
})

void test('boot reclaims an accepted candidate TTS task into private staging without replaying its POST or changing active sources', async () => {
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
    const qualityStore = await import('../services/audio-quality-store.js')
    const { hashSubtitleAudioSources } = await import('../services/subtitle-completion.js')
    const { recordSubtitleSourceEvidence } = await import('../services/subtitle-recovery.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const { parseNarrationDocx } = await import('../lib/docx-parser.js')
    const { normalizeSectionsForTts } = await import('../services/tts-request-plan.js')
    const { hashInput, recordTaskStrict } = await import('../services/task-manifest.js')

    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    const project = await pm.createProject({ name: 'Accepted candidate recovery', episode_prefix: 'RC', episode_digits: 4 })
    await pm.updateConfig(project.slug, { audio_quality: { mode: 'check_and_repair', alternate_transcription_model: 'mock-whisper-v1' } })
    const [idea] = await ideas.addIdeas(project.slug, [{
      title: 'Recover accepted candidate', logline: 'Fixture', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
    }], 'mock-chat-v1')
    const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
    const code = accepted.episode_code
    const paths = await resolveEpisodePathsByCode(project.slug, code)
    await Promise.all([paths.script_dir, paths.subtitles_dir].map(dir => fs.mkdir(dir, { recursive: true })))
    await fs.writeFile(paths.narration_docx, '# Narration\n\n## Chapter 01: Recover\n\nA provider-accepted candidate must be reclaimed.\n')
    const terminal = async (jobId: string, label: string) => waitFor(() => ['done', 'error', 'cancelled'].includes(jq.getJob(jobId)?.status || ''), { label, timeoutMs: 15_000 })
    const jobIdOf = (body: any) => String(body.job_id || body.job?.job_id || '')

    const base = await request(app).post(`/api/projects/${project.slug}/generate/audio`).send({
      episode_id: code, model: 'mock-tts-v1', voice: 'mock-voice', sections: 'all', speed: 1,
    })
    assert.equal(base.status, 201, JSON.stringify(base.body)); await terminal(jobIdOf(base.body), 'base narration')
    assert.equal(jq.getJob(jobIdOf(base.body))?.status, 'done')
    const merge = await request(app).post(`/api/projects/${project.slug}/generate/audio-merge`).send({
      episode_id: code, chapters: [], gap_duration: 0, normalize_volume: false, narration_volume: 1,
    })
    assert.equal(merge.status, 201, JSON.stringify(merge.body)); await terminal(jobIdOf(merge.body), 'base assembly')
    assert.equal(jq.getJob(jobIdOf(merge.body))?.status, 'done')

    const baseFile = `${code}_Chapter_01.mp3`
    const srtFile = `${code}_Chapter_01.srt`
    const originalAudio = await fs.readFile(path.join(paths.audio_dir, baseFile))
    const originalMap = await fs.readFile(path.join(paths.episode_dir, 'audio_chapters.json'), 'utf8')
    const originalSrt = '1\n00:00:00,000 --> 00:00:01,000\nA deliberately old transcript.\n'
    await fs.writeFile(path.join(paths.subtitles_dir, srtFile), originalSrt)
    const activeHash = await hashSubtitleAudioSources([path.join(paths.audio_dir, baseFile)])
    assert.ok(activeHash)
    await recordSubtitleSourceEvidence(paths.subtitles_dir, srtFile, activeHash, 'legacy-whisper')

    const checked = await request(app).post(`/api/projects/${project.slug}/episodes/${code}/audio-quality/check`).send({
      operation_id: RECOVERED_CANDIDATE_ACTION, sections: ['Chapter_01'], candidate_audio: { model: 'mock-tts-v1', voice: 'mock-voice' },
    })
    assert.equal(checked.status, 200, JSON.stringify(checked.body)); assert.equal(checked.body.repair?.eligible, true)

    await jq.setQueuePaused(true)
    let candidateJobId = ''
    try {
      const confirmed = await request(app).post(`/api/projects/${project.slug}/episodes/${code}/audio-quality/confirm`).send({
        operation_id: RECOVERED_CANDIDATE_ACTION, confirm_repair: true, verification_credit_ceiling: 6,
        source_fingerprint: checked.body.repair.source_fingerprint,
        candidate_audio: { model: 'mock-tts-v1', voice: 'mock-voice', speed: 1 },
      })
      assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body))
      candidateJobId = jobIdOf(confirmed.body)
      assert.equal(jq.getJob(candidateJobId)?.status, 'queued')

      const parsed = await parseNarrationDocx(paths.narration_docx)
      normalizeSectionsForTts(parsed)
      const section = parsed.find(row => row.slug === 'Chapter_01')
      assert.ok(section)
      const candidateDir = path.join(paths.episode_dir, '.audio-quality-candidates', RECOVERED_CANDIDATE_ACTION, 'audio')
      const candidateFile = `${code}_Chapter_01.mp3`
      const requestIdentity = `${project.slug}:${code.toUpperCase()}:audio:${candidateFile}:regenerate:${RECOVERED_CANDIDATE_ACTION}`
      const submission = client.buildGenStudioSubmission({
        text: section.text, voiceId: 'mock-voice', modelId: 'mock-tts-v1', speed: 1, maxInputCharacters: 15_000, requestIdentity,
      })
      const inputHash = hashInput(JSON.stringify({
        requestIdentity: `${project.slug}:${code.toUpperCase()}:audio:${candidateFile}`,
        text: section.text, voiceId: 'mock-voice', speed: 1, maxInputCharacters: 15_000,
      }))
      service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
      const remote = await fetch(`${service.baseUrl}/v1/audio/jobs`, {
        method: 'POST', headers: { Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': submission.idempotencyKey },
        body: JSON.stringify(submission.body),
      })
      assert.equal(remote.status, 202)
      const remoteTask = await remote.json() as { id?: string }
      assert.ok(remoteTask.id)
      await recordTaskStrict(candidateDir, candidateFile, {
        provider: 'genstudio', task_id: remoteTask.id!, submitted_at: new Date().toISOString(), input_hash: inputHash,
        idempotency_key: submission.idempotencyKey, operation: 'tts', last_state: 'accepted', request_scope: RECOVERED_CANDIDATE_ACTION,
      })
      assert.equal(await fs.stat(path.join(candidateDir, candidateFile)).then(() => true).catch(() => false), false,
        'the accepted provider task has no local candidate artifact before boot')
      await jq._waitForJobPersistenceForTesting()
      const jobsFile = path.join(pm.getProjectDir(project.slug)!, 'jobs.json')
      const persisted = JSON.parse(await fs.readFile(jobsFile, 'utf8'))
      const saved = persisted.jobs.find((job: any) => job.job_id === candidateJobId)
      assert.ok(saved?.params?.quality_repair?.action_id === RECOVERED_CANDIDATE_ACTION, JSON.stringify(saved))
      saved.status = 'running'; saved.finished_at = null; saved.local_execution_complete = false
      await fs.writeFile(jobsFile, JSON.stringify(persisted))
      jq._forgetProjectPersistenceForTesting(project.slug)
    } finally {
      await jq.setQueuePaused(false)
    }

    const physicalTtsPostsBeforeBoot = service.requests.filter(entry => entry.method === 'POST' && entry.path === '/v1/audio/jobs').length
    const { registerAllExecutors } = await import('../boot/executors.js')
    registerAllExecutors({ loadSettings: false })
    await jq.getJobs(project.slug)
    await terminal(candidateJobId, 'boot-recovered accepted candidate')
    const recovered = jq.getJob(candidateJobId)
    assert.equal(recovered?.params?.quality_repair?.action_id, RECOVERED_CANDIDATE_ACTION)
    assert.equal(recovered?.status, 'error', JSON.stringify(recovered))
    assert.equal(service.requests.filter(entry => entry.method === 'POST' && entry.path === '/v1/audio/jobs').length, physicalTtsPostsBeforeBoot,
      'boot reattaches to the accepted task instead of replaying a TTS POST')
    assert.equal(service.providerSubmissionCount('tts'), 2, 'only base narration and the pre-crash accepted candidate reached the provider')
    assert.equal(service.providerSubmissionCount('transcription'), 0, 'the held verification quote was not confirmed')
    assert.equal(await fs.stat(path.join(paths.episode_dir, '.audio-quality-candidates', RECOVERED_CANDIDATE_ACTION, 'audio', baseFile)).then(stat => stat.size > 0).catch(() => false), true,
      'recovery writes the provider artifact only into the action-private candidate directory')
    assert.deepEqual(await fs.readFile(path.join(paths.audio_dir, baseFile)), originalAudio)
    assert.equal(await fs.readFile(path.join(paths.episode_dir, 'audio_chapters.json'), 'utf8'), originalMap)
    assert.equal(await fs.readFile(path.join(paths.subtitles_dir, srtFile), 'utf8'), originalSrt)
    assert.equal((await qualityStore.readAudioQualityProvenance(paths.episode_dir)).actions?.[RECOVERED_CANDIDATE_ACTION]?.state, 'needs_approval')

    const assertTerminalRemotePreservesActive = async (actionId: string, remote: 'failed' | 'cancelled') => {
      const checkedTerminal = await request(app).post(`/api/projects/${project.slug}/episodes/${code}/audio-quality/check`).send({
        operation_id: actionId, sections: ['Chapter_01'], candidate_audio: { model: 'mock-tts-v1', voice: 'mock-voice' },
      })
      assert.equal(checkedTerminal.status, 200, JSON.stringify(checkedTerminal.body))
      await jq.setQueuePaused(true)
      let terminalJobId = ''
      try {
        const confirmedTerminal = await request(app).post(`/api/projects/${project.slug}/episodes/${code}/audio-quality/confirm`).send({
          operation_id: actionId, confirm_repair: true, verification_credit_ceiling: 6,
          source_fingerprint: checkedTerminal.body.repair.source_fingerprint,
          candidate_audio: { model: 'mock-tts-v1', voice: 'mock-voice', speed: 1 },
        })
        assert.equal(confirmedTerminal.status, 201, JSON.stringify(confirmedTerminal.body))
        terminalJobId = jobIdOf(confirmedTerminal.body)
        const parsed = await parseNarrationDocx(paths.narration_docx)
        normalizeSectionsForTts(parsed)
        const section = parsed.find(row => row.slug === 'Chapter_01')
        assert.ok(section)
        const candidateDir = path.join(paths.episode_dir, '.audio-quality-candidates', actionId, 'audio')
        const candidateFile = `${code}_Chapter_01.mp3`
        const requestIdentity = `${project.slug}:${code.toUpperCase()}:audio:${candidateFile}:regenerate:${actionId}`
        const submission = client.buildGenStudioSubmission({
          text: section.text, voiceId: 'mock-voice', modelId: 'mock-tts-v1', speed: 1, maxInputCharacters: 15_000, requestIdentity,
        })
        const inputHash = hashInput(JSON.stringify({
          requestIdentity: `${project.slug}:${code.toUpperCase()}:audio:${candidateFile}`,
          text: section.text, voiceId: 'mock-voice', speed: 1, maxInputCharacters: 15_000,
        }))
        service.queueScenario('tts', remote === 'failed' ? { states: ['failed'] } : { states: ['accepted', 'succeeded'] })
        const submitted = await fetch(`${service.baseUrl}/v1/audio/jobs`, {
          method: 'POST', headers: { Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': submission.idempotencyKey },
          body: JSON.stringify(submission.body),
        })
        assert.equal(submitted.status, 202)
        const providerTask = await submitted.json() as { id?: string }
        assert.ok(providerTask.id)
        if (remote === 'cancelled') {
          const cancelledProvider = await fetch(`${service.baseUrl}/v1/jobs/${providerTask.id}/cancel`, {
            method: 'POST', headers: { Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}` },
          })
          assert.equal(cancelledProvider.status, 200)
        }
        await recordTaskStrict(candidateDir, candidateFile, {
          provider: 'genstudio', task_id: providerTask.id!, submitted_at: new Date().toISOString(), input_hash: inputHash,
          idempotency_key: submission.idempotencyKey, operation: 'tts', last_state: 'accepted', request_scope: actionId,
        })
        await jq._waitForJobPersistenceForTesting()
        const jobsFile = path.join(pm.getProjectDir(project.slug)!, 'jobs.json')
        const persisted = JSON.parse(await fs.readFile(jobsFile, 'utf8'))
        const saved = persisted.jobs.find((job: any) => job.job_id === terminalJobId)
        assert.ok(saved?.params?.quality_repair?.action_id === actionId, JSON.stringify(saved))
        saved.status = 'running'; saved.finished_at = null; saved.local_execution_complete = false
        await fs.writeFile(jobsFile, JSON.stringify(persisted))
        jq._forgetProjectPersistenceForTesting(project.slug)
      } finally {
        await jq.setQueuePaused(false)
      }
      const physicalPostsBeforeBoot = service.requests.filter(entry => entry.method === 'POST' && entry.path === '/v1/audio/jobs').length
      const { registerAllExecutors } = await import('../boot/executors.js')
      registerAllExecutors({ loadSettings: false })
      await jq.getJobs(project.slug)
      await terminal(terminalJobId, `${remote} accepted candidate recovery`)
      assert.ok(['error', 'cancelled'].includes(jq.getJob(terminalJobId)?.status || ''), JSON.stringify(jq.getJob(terminalJobId)))
      assert.equal(service.requests.filter(entry => entry.method === 'POST' && entry.path === '/v1/audio/jobs').length, physicalPostsBeforeBoot,
        `${remote} provider evidence is terminal and must never start a replacement TTS request`)
      assert.equal(await fs.stat(path.join(paths.episode_dir, '.audio-quality-candidates', actionId, 'audio', baseFile)).then(() => true).catch(() => false), false,
        `${remote} remote task cannot write a candidate artifact`)
      assert.deepEqual(await fs.readFile(path.join(paths.audio_dir, baseFile)), originalAudio)
      assert.equal(await fs.readFile(path.join(paths.episode_dir, 'audio_chapters.json'), 'utf8'), originalMap)
      assert.equal(await fs.readFile(path.join(paths.subtitles_dir, srtFile), 'utf8'), originalSrt)
    }
    await assertTerminalRemotePreservesActive(FAILED_REMOTE_ACTION, 'failed')
    await assertTerminalRemotePreservesActive(CANCELLED_REMOTE_ACTION, 'cancelled')
  } finally {
    const jq = await import('../services/job-queue.js').catch(() => null)
    await jq?._waitForJobPersistenceForTesting()
    await jq?.setQueuePaused(false)
    await service.close()
    await isolated.cleanup()
  }
})
