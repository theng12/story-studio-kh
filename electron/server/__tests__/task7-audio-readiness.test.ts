import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import type { Job } from '../models/types.js'
import { inspectAudioAssemblyReadiness } from '../services/audio-workflow-readiness.js'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

async function createAudioFixture(t: TestContext, withProvider = false) {
  const isolated = await useTempDataDir()
  const mock = withProvider ? await startMockGenStudioService() : null
  t.after(async () => {
    if (mock) await mock.close()
    await isolated.cleanup()
  })

  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const utils = await import('../services/utils.js')
  const project = await pm.createProject({ name: 'Task 7 audio readiness', episode_prefix: 'EP', episode_digits: 4 })
  const [idea] = await ideas.addIdeas(project.slug, [{ title: 'Audio fixture', logline: 'Fixture.', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'measured' }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  const code = accepted.episode_code
  const paths = await utils.resolveEpisodePathsByCode(project.slug, code)
  const sourceName = `${code}_Chapter_01.mp3`
  await Promise.all([paths.script_dir, paths.audio_dir, paths.merged_audio_dir, paths.subtitles_dir].map(dir => fs.mkdir(dir, { recursive: true })))
  await fs.writeFile(paths.narration_docx, '## Chapter 01: Fixture\n\nNarration.\n')
  await fs.writeFile(path.join(paths.audio_dir, sourceName), 'chapter-audio')
  await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({
    gap_duration_s: 1,
    sections: [{ slug: 'Chapter_01', duration_s: 1, source_file: sourceName }],
  }))

  if (mock) {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    await settings.setGenStudioUrl(mock.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
  }

  async function resetMerged(): Promise<void> {
    await fs.rm(paths.merged_audio_dir, { recursive: true, force: true })
    await fs.mkdir(paths.merged_audio_dir, { recursive: true })
  }

  async function writeValidMerge(filename = `${code}_merged_audio.mp3`): Promise<string> {
    const target = path.join(paths.merged_audio_dir, filename)
    await runFfmpeg([
      '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25',
      '-codec:a', 'libmp3lame', '-q:a', '9', target,
    ])
    const stat = await fs.stat(target)
    await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio.completion.json`), JSON.stringify({
      output_filename: filename,
      bytes: stat.size,
      duration_sec: 0.25,
      opening: { lead_in_sec: 0, music_lead_in_sec: 0 },
    }))
    return target
  }

  return { mock, project, code, paths, resetMerged, writeValidMerge }
}

test('audio readiness accepts only the current canonical decodable merge', async t => {
  const fixture = await createAudioFixture(t)
  const canonical = `${fixture.code}_merged_audio.mp3`

  await fs.writeFile(path.join(fixture.paths.merged_audio_dir, 'unrelated.mp3'), 'not a merge')
  let readiness = await inspectAudioAssemblyReadiness(fixture.project.slug, fixture.code)
  assert.equal(readiness.audio_assembly_ready, false, 'an unrelated nonempty audio file is not Audio Assembly output')
  assert.equal(readiness.merged_audio_path, null)

  await fixture.resetMerged()
  await fs.writeFile(path.join(fixture.paths.merged_audio_dir, canonical), 'not decodable audio')
  readiness = await inspectAudioAssemblyReadiness(fixture.project.slug, fixture.code)
  assert.equal(readiness.audio_assembly_ready, false, 'a canonical-looking malformed file is not usable audio')

  await fixture.resetMerged()
  await fs.writeFile(path.join(fixture.paths.merged_audio_dir, canonical), '')
  readiness = await inspectAudioAssemblyReadiness(fixture.project.slug, fixture.code)
  assert.equal(readiness.audio_assembly_ready, false, 'an empty canonical file is incomplete')

  await fixture.resetMerged()
  const unreadable = path.join(fixture.paths.merged_audio_dir, canonical)
  await fs.writeFile(unreadable, 'not readable')
  await fs.chmod(unreadable, 0o000)
  try {
    readiness = await inspectAudioAssemblyReadiness(fixture.project.slug, fixture.code)
    assert.equal(readiness.audio_assembly_ready, false, 'an unreadable canonical file is not usable audio')
  } finally {
    await fs.chmod(unreadable, 0o600)
  }

  await fixture.resetMerged()
  const stale = await fixture.writeValidMerge()
  const old = new Date(Date.now() - 10_000)
  await fs.utimes(stale, old, old)
  readiness = await inspectAudioAssemblyReadiness(fixture.project.slug, fixture.code)
  assert.equal(readiness.audio_assembly_ready, false, 'a merge older than its selected chapter source is stale')

  await fixture.resetMerged()
  const current = await fixture.writeValidMerge()
  readiness = await inspectAudioAssemblyReadiness(fixture.project.slug, fixture.code)
  assert.equal(readiness.audio_assembly_ready, true)
  assert.equal(readiness.merged_audio_path, current)
})

test('whole-track admission refuses a superseded override before provider work', async t => {
  const fixture = await createAudioFixture(t, true)
  const base = await fixture.writeValidMerge()
  const selected = await fixture.writeValidMerge(`${fixture.code}_merged_audio_v2.mp3`)
  const { generateSubtitlesTranscribe } = await import('../generators/subtitles.js')
  const job = {
    job_id: 'task7-superseded-override', project_slug: fixture.project.slug, episode_id: fixture.code,
    type: 'subtitles_transcribe', status: 'running', progress: 0, output_lines: [],
    params: { per_chapter: false, engine: 'genstudio', model: 'mock-whisper-v1', language: 'en', audio_path: base },
  } as unknown as Job

  await assert.rejects(generateSubtitlesTranscribe(job), /not .*authoritative output/i)
  assert.equal(fixture.mock!.providerSubmissionCount('transcription'), 0)
  const readiness = await inspectAudioAssemblyReadiness(fixture.project.slug, fixture.code)
  assert.equal(readiness.merged_audio_path, selected)

  fixture.mock!.queueScenario('transcription', { states: ['accepted', 'succeeded'] })
  const selectedJob = {
    ...job,
    job_id: 'task7-authoritative-version',
    output_lines: [],
    params: {
      per_chapter: false, engine: 'genstudio', model: 'mock-whisper-v1', language: 'en', force: true,
      generation_action: { id: 'task7-authoritative-version', kind: 'fresh' },
    },
  } as unknown as Job
  await generateSubtitlesTranscribe(selectedJob)
  assert.equal(fixture.mock!.providerSubmissionCount('transcription'), 1)
  assert.match(selectedJob.output_lines.join('\n'), new RegExp(`Source: ${path.basename(selected)}`))
})

test('repairing invalid audio submits once and retries reuse the paid transcription', async t => {
  const fixture = await createAudioFixture(t, true)
  await fs.writeFile(path.join(fixture.paths.merged_audio_dir, 'unrelated.mp3'), 'unrelated bytes')
  const { generateSubtitlesTranscribe } = await import('../generators/subtitles.js')
  const job = {
    job_id: 'task7-repair-retry', project_slug: fixture.project.slug, episode_id: fixture.code,
    type: 'subtitles_transcribe', status: 'running', progress: 0, output_lines: [],
    params: {
      per_chapter: false, engine: 'genstudio', model: 'mock-whisper-v1', language: 'en', force: true,
      generation_action: { id: 'task7-same-action', kind: 'fresh' },
    },
  } as unknown as Job

  await assert.rejects(generateSubtitlesTranscribe(job), /Audio Assembly is complete/i)
  assert.equal(fixture.mock!.providerSubmissionCount('transcription'), 0)

  await fixture.resetMerged()
  const current = await fixture.writeValidMerge()
  fixture.mock!.queueScenario('transcription', { states: ['accepted', 'succeeded'] })
  await generateSubtitlesTranscribe(job)
  assert.equal(fixture.mock!.providerSubmissionCount('transcription'), 1)
  assert.match(job.output_lines.join('\n'), new RegExp(`Source: ${path.basename(current)}`))

  await generateSubtitlesTranscribe(job)
  assert.equal(fixture.mock!.providerSubmissionCount('transcription'), 1, 'the accepted paid task is reused')
})
