import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const ACTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

void test('ordinary Audio Assembly adopts one ready candidate when no prior merge settings exist', async () => {
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
    const project = await pm.createProject({ name: 'No prior merge', episode_prefix: 'NP', episode_digits: 4 })
    await pm.updateConfig(project.slug, { audio_quality: { mode: 'check_and_repair', alternate_transcription_model: 'mock-whisper-v1' } })
    const [idea] = await ideas.addIdeas(project.slug, [{ title: 'Two chapters', logline: 'Fixture', themes: [], suggested_chapters: 2, suggested_length: 'short', mood: 'calm' }], 'mock-chat-v1')
    const accepted = await ideas.acceptIdea(project.slug, idea!.id, false); const code = accepted.episode_code
    const paths = await resolveEpisodePathsByCode(project.slug, code)
    await Promise.all([paths.script_dir, paths.subtitles_dir].map(dir => fs.mkdir(dir, { recursive: true })));
    await fs.writeFile(paths.narration_docx, '# Narration\n\n## Chapter 01: Repair\n\nHello from mock GenStudio.\n\n## Chapter 02: Keep\n\nKeep this chapter.\n')
    const terminal = async (id: string) => waitFor(() => ['done', 'error', 'cancelled'].includes(jq.getJob(id)?.status || ''), { label: id, timeoutMs: 15_000 })
    const id = (body: any) => String(body.job_id || body.job?.job_id || '')
    const generated = await request(app).post(`/api/projects/${project.slug}/generate/audio`).send({ episode_id: code, model: 'mock-tts-v1', voice: 'mock-voice', sections: 'all', speed: 1 })
    assert.equal(generated.status, 201, JSON.stringify(generated.body)); await terminal(id(generated.body)); assert.equal(jq.getJob(id(generated.body))?.status, 'done')
    const one = `${code}_Chapter_01.mp3`, two = `${code}_Chapter_02.mp3`
    const twoBytes = await fs.readFile(path.join(paths.audio_dir, two))
    // A timing/source map exists from prior local audio preparation, but no audio_merge job or mix settings do.
    await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({ sections: [
      { slug: 'Chapter_01', duration_s: 1, source_file: one, source_files: [one] },
      { slug: 'Chapter_02', duration_s: 1, source_file: two, source_files: [two] },
    ] }))
    for (const [slug, file, text] of [['Chapter_01', one, 'Old transcript.'], ['Chapter_02', two, 'Keep this chapter.']] as const) {
      const srt = `${code}_${slug}.srt`; await fs.writeFile(path.join(paths.subtitles_dir, srt), `1\n00:00:00,000 --> 00:00:01,000\n${text}\n`)
      const hash = await hashSubtitleAudioSources([path.join(paths.audio_dir, file)]); assert.ok(hash); await recordSubtitleSourceEvidence(paths.subtitles_dir, srt, hash, 'legacy-whisper')
    }
    assert.equal((await jq.getJobs(project.slug)).some(job => job.type === 'audio_merge'), false)
    const check = await request(app).post(`/api/projects/${project.slug}/episodes/${code}/audio-quality/check`).send({ operation_id: ACTION, sections: ['Chapter_01'], candidate_audio: { model: 'mock-tts-v1', voice: 'mock-voice' } })
    assert.equal(check.status, 200, JSON.stringify(check.body)); assert.equal(check.body.repair?.eligible, true)
    const confirm = await request(app).post(`/api/projects/${project.slug}/episodes/${code}/audio-quality/confirm`).send({ operation_id: ACTION, confirm_repair: true, source_fingerprint: check.body.repair.source_fingerprint, verification_credit_ceiling: 7, candidate_audio: { model: 'mock-tts-v1', voice: 'mock-voice' } })
    assert.equal(confirm.status, 201, JSON.stringify(confirm.body)); await terminal(id(confirm.body)); assert.equal(jq.getJob(id(confirm.body))?.status, 'done')
    const ready = (await store.readAudioQualityProvenance(paths.episode_dir)).actions?.[ACTION]
    assert.equal(ready?.state, 'candidate_ready'); assert.ok(ready?.refresh_needed); assert.equal(jq.getJob(id(confirm.body))?.result?.quality_repair?.refresh_job_id, undefined)
    const merge = await request(app).post(`/api/projects/${project.slug}/generate/audio-merge`).send({ episode_id: code, chapters: [], gap_duration: 0, normalize_volume: false, narration_volume: 1 })
    assert.equal(merge.status, 201, JSON.stringify(merge.body)); await terminal(id(merge.body)); assert.equal(jq.getJob(id(merge.body))?.status, 'done', JSON.stringify(jq.getJob(id(merge.body))))
    assert.equal((await store.readAudioQualityProvenance(paths.episode_dir)).actions?.[ACTION]?.state, 'fixed')
    const sidecar = JSON.parse(await fs.readFile(path.join(paths.episode_dir, 'audio_chapters.json'), 'utf8'))
    assert.deepEqual(sidecar.sections.map((row: any) => row.slug), ['Chapter_01', 'Chapter_02']); assert.deepEqual(sidecar.sections[1].source_files, [two]); assert.deepEqual(await fs.readFile(path.join(paths.audio_dir, two)), twoBytes)
  } finally { await service.close(); await isolated.cleanup() }
})
