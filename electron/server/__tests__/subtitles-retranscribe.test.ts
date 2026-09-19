/**
 * Re-transcription must actually re-ask — v1.2.2
 *
 * Found while building the subtitle-quality warning, which offers
 * "re-transcribe this chapter" as the remedy for a corrupt transcript.
 *
 * `force` used to bypass only the local "this SRT already exists" skip.
 * Everything after that still matched the saved manifest task — same audio,
 * same model, same language — so the run reconnected to the completed GenStudio
 * task via `recoverTranscriptionWithGenStudio` and re-downloaded the identical
 * artifact. The checkbox promised a re-run and delivered a cache hit.
 *
 * That is invisible when nothing was wrong, and fatal to the one case that
 * matters: re-transcribing a chapter *because* Whisper hallucinated into it.
 * Replaying the same result is the single outcome that cannot help, and the
 * user would have waited (and possibly paid) to receive the same garbage.
 *
 * Ordinary Retry after a crash must still reconnect to accepted work rather
 * than paying twice, so the fresh identity is taken only on an explicit re-run
 * of a transcript that already exists.
 */

import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { resolveActiveSubtitleChapterSources, selectRequestedSections } from '../generators/subtitles.js'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import type { TestContext } from 'node:test'
import type { Job } from '../models/types.js'
import { stampFromCues } from '../lib/scene-plan-timeline.js'
import { parseSrt } from '../lib/subtitle-builder.js'
import { hashSubtitleAudioSources } from '../services/subtitle-completion.js'

async function createScopedSubtitleFixture(t: TestContext) {
  const isolated = await useTempDataDir()
  const mock = await startMockGenStudioService()
  t.after(async () => { await mock.close(); await isolated.cleanup() })

  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const utils = await import('../services/utils.js')
  const { generateSubtitlesTranscribe } = await import('../generators/subtitles.js')

  await settings.setGenStudioUrl(mock.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  client.clearGenStudioCatalogCache()
  const project = await pm.createProject({ name: 'Scoped subtitle fixture', episode_prefix: 'EP', episode_digits: 4 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Three chapters', logline: 'A fixture.', themes: [], suggested_chapters: 3,
    suggested_length: '3 minutes', mood: 'measured',
  }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  const code = accepted.episode_code
  const paths = await utils.resolveEpisodePathsByCode(project.slug, code)
  const sections = ['Chapter_01', 'Chapter_02', 'Chapter_03']

  await Promise.all([paths.script_dir, paths.audio_dir, paths.merged_audio_dir, paths.subtitles_dir].map(dir => fs.mkdir(dir, { recursive: true })))
  await fs.writeFile(paths.narration_docx, sections.map((section, index) => `## Chapter ${String(index + 1).padStart(2, '0')}: Fixture\n\nNarration for ${section}.`).join('\n\n'))
  await Promise.all(sections.map(section => fs.writeFile(path.join(paths.audio_dir, `${code}_${section}.mp3`), `audio-${section}`)))
  await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({
    gap_duration_s: 1,
    sections: sections.map(slug => ({ slug, duration_s: 1, source_file: `${code}_${slug}.mp3` })),
  }))
  await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio.mp3`), 'merged-audio')
  await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio.completion.json`), JSON.stringify({
    output_filename: `${code}_merged_audio.mp3`, opening: { lead_in_sec: 0, music_lead_in_sec: 0 },
  }))

  return {
    mock,
    code,
    paths,
    sections,
    generateSubtitlesTranscribe,
    makeJob: (jobId: string, params: Record<string, unknown> = {}): Job => ({
      job_id: jobId, project_slug: project.slug, episode_id: code,
      type: 'subtitles_transcribe', status: 'running', progress: 0, output_lines: [],
      params: {
        per_chapter: true, engine: 'genstudio', model: 'mock-whisper-v1', language: 'en',
        force: true, sections: ['Chapter_01'],
        ...params,
      },
    } as unknown as Job),
  }
}

test('an explicitly selected subtitle succeeds while an unselected chapter is missing, without auto-stitching', async t => {
  const fixture = await createScopedSubtitleFixture(t)
  fixture.mock.queueScenario('transcription', { states: ['accepted', 'succeeded'] })
  const job = fixture.makeJob('scoped-subtitle-success')

  await fixture.generateSubtitlesTranscribe(job)

  assert.equal(job.result?.complete, true, 'the queued scoped job is complete for its requested section')
  assert.equal(job.result?.scope_complete, true)
  assert.equal(job.result?.episode_complete, false, 'episode completion remains false while Chapter_02 and Chapter_03 are absent')
  assert.equal(job.result?.stitch_complete, false)
  assert.deepEqual(job.result?.scoped_sections, ['Chapter_01'])
  assert.equal(job.result?.ready_sections, 1)
  assert.deepEqual(job.result?.missing_sections, ['Chapter_02', 'Chapter_03'])
  assert.match(await fs.readFile(path.join(fixture.paths.subtitles_dir, `${fixture.code}_Chapter_01.srt`), 'utf8'), /Hello from mock GenStudio/)
  await assert.rejects(
    fs.access(path.join(fixture.paths.subtitles_dir, `${fixture.code}_stitched.srt`)),
    /ENOENT/,
    'auto-stitch must wait for complete episode subtitle coverage',
  )
})

test('an explicitly selected subtitle failure still fails the scoped job', async t => {
  const fixture = await createScopedSubtitleFixture(t)
  fixture.mock.queueScenario('transcription', {
    states: ['accepted', 'failed'], failureCode: 'STT_PROVIDER_ERROR', reservedCredits: 7, finalCredits: 7,
  })
  const job = fixture.makeJob('scoped-subtitle-failure')

  await assert.rejects(
    fixture.generateSubtitlesTranscribe(job),
    /Chapter_01/,
    'a requested section failure must remain loud even when the request is scoped',
  )
  assert.equal(job.result?.complete, false)
  assert.equal(job.result?.scope_complete, false)
  assert.equal(job.result?.episode_complete, false)
  assert.ok(job.result?.missing_sections?.includes('Chapter_01'))
})


describe('re-transcribing one chapter does not re-charge the episode', () => {
  const sections = [
    { slug: 'Introduction' },
    { slug: 'Chapter_01' },
    { slug: 'Chapter_02' },
    { slug: 'Chapter_03' },
  ]

  test('no list means every chapter, as before', () => {
    assert.deepEqual(selectRequestedSections(sections, undefined), sections)
    assert.deepEqual(selectRequestedSections(sections, []), sections)
  })

  test('a list narrows the run to exactly those chapters', () => {
    const picked = selectRequestedSections(sections, ['Chapter_02'])
    assert.deepEqual(picked.map(s => s.slug), ['Chapter_02'])
  })

  test('several chapters can be named at once', () => {
    const picked = selectRequestedSections(sections, ['Introduction', 'Chapter_03'])
    assert.deepEqual(picked.map(s => s.slug), ['Introduction', 'Chapter_03'])
  })

  test('matching is case-insensitive and tolerates stray whitespace', () => {
    const picked = selectRequestedSections(sections, ['  chapter_01  '])
    assert.deepEqual(picked.map(s => s.slug), ['Chapter_01'])
  })

  test('a list that matches nothing throws instead of silently running everything', () => {
    // The failure mode this guards: asking for one chapter and being billed for
    // thirteen because a slug was wrong.
    assert.throws(
      () => selectRequestedSections(sections, ['Chapter_99']),
      /Requested chapters have no matching audio: chapter_99/,
    )
    assert.throws(() => selectRequestedSections(sections, ['Chapter_99']), /Available: .*Chapter_03/)
  })

  test('a mixed valid and unknown scope fails instead of dropping requested work', () => {
    assert.throws(() => selectRequestedSections(sections, ['Chapter_01', 'typo']), /no matching audio: typo/)
  })

  test('empty and blank entries are ignored rather than matching nothing', () => {
    assert.deepEqual(selectRequestedSections(sections, ['', '   ']), sections)
  })
})

test('uses Audio Assembly’s exact selected sources, including a promoted version and mixed base-plus-parts', async t => {
  const episodeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-active-source-'))
  const audioDir = path.join(episodeDir, 'Audio')
  t.after(() => fs.rm(episodeDir, { recursive: true, force: true }))
  await fs.mkdir(audioDir)
  const chapter = 'EP0099_Chapter_08.mp3'
  const part = 'EP0099_Chapter_08_part1.mp3'
  const promoted = 'EP0099_Chapter_09_v2.mp3'
  await Promise.all([
    fs.writeFile(path.join(audioDir, chapter), 'base chapter bytes'),
    fs.writeFile(path.join(audioDir, part), 'continued chapter bytes'),
    fs.writeFile(path.join(audioDir, promoted), 'promoted chapter bytes'),
  ])
  await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({ sections: [
    { slug: 'Chapter_08', source_files: [chapter, part] },
    { slug: 'Chapter_09', source_file: promoted },
  ] }))

  assert.deepEqual(await resolveActiveSubtitleChapterSources(episodeDir, audioDir), [
    { slug: 'Chapter_08', files: [chapter, part] },
    { slug: 'Chapter_09', files: [promoted] },
  ], 'subtitle transcription must receive the Audio Assembly-selected bytes in their saved order')

  await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), '{not json')
  await assert.rejects(
    resolveActiveSubtitleChapterSources(episodeDir, audioDir),
    /active source map cannot be read.*Re-run Audio Assembly/i,
    'a malformed selected map must not silently fall back to different directory bytes',
  )
})

test('a stamped fresh retry reuses its accepted Chapter_12 task instead of skipping an old SRT', async t => {
  const isolated = await useTempDataDir()
  const mock = await startMockGenStudioService()
  t.after(async () => { await mock.close(); await isolated.cleanup() })

  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const utils = await import('../services/utils.js')
  const { generateSubtitlesTranscribe } = await import('../generators/subtitles.js')

  await settings.setGenStudioUrl(mock.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  client.clearGenStudioCatalogCache()
  const project = await pm.createProject({ name: 'One subtitle section fixture', episode_prefix: 'EP', episode_digits: 4 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Sixteen chapters',
    logline: 'A fixture.',
    themes: [],
    suggested_chapters: 16,
    suggested_length: '16 minutes',
    mood: 'measured',
  }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  const code = accepted.episode_code
  const paths = await utils.resolveEpisodePathsByCode(project.slug, code)
  const sections = Array.from({ length: 16 }, (_, index) => `Chapter_${String(index + 1).padStart(2, '0')}`)

  await Promise.all([paths.script_dir, paths.audio_dir, paths.merged_audio_dir, paths.subtitles_dir].map(dir => fs.mkdir(dir, { recursive: true })))
  await fs.writeFile(paths.narration_docx, sections.map((section, index) => `## Chapter ${String(index + 1).padStart(2, '0')}: Fixture\n\nNarration for ${section}.`).join('\n\n'))
  await Promise.all(sections.map(section => fs.writeFile(path.join(paths.audio_dir, `${code}_${section}.mp3`), `audio-${section}`)))
  const selectedChapter = 'Chapter_12'
  const selectedAudio = `${code}_${selectedChapter}_v2.mp3`
  await fs.writeFile(path.join(paths.audio_dir, selectedAudio), 'selected chapter twelve audio')
  await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({ gap_duration_s: 1, sections: sections.map(slug => ({
    slug,
    duration_s: 1,
    source_file: slug === selectedChapter ? selectedAudio : `${code}_${slug}.mp3`,
  })) }))
  await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio.mp3`), 'merged-audio')
  await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio.completion.json`), JSON.stringify({ output_filename: `${code}_merged_audio.mp3`, opening: { lead_in_sec: 0, music_lead_in_sec: 0 } }))

  const preserved = new Map<string, Buffer>()
  for (const section of sections.filter(section => section !== 'Chapter_12')) {
    const file = path.join(paths.subtitles_dir, `${code}_${section}.srt`)
    const bytes = Buffer.from(`1\n00:00:00,000 --> 00:00:01,000\nExisting ${section}.\n`)
    preserved.set(file, bytes)
    await fs.writeFile(file, bytes)
  }

  const staleTarget = path.join(paths.subtitles_dir, `${code}_Chapter_12.srt`)
  await fs.writeFile(staleTarget, '1\n00:00:00,000 --> 00:00:01,000\nA stale caption that must not short-circuit the fresh action.\n')
  const actionId = 'fresh-subtitle-action-12'
  const job = {
    job_id: 'one-section-subtitle', project_slug: project.slug, episode_id: code,
    type: 'subtitles_transcribe', status: 'running', progress: 0, output_lines: [],
    params: { per_chapter: true, engine: 'genstudio', model: 'mock-whisper-v1', language: 'en', force: true,
      generation_action: { id: actionId, kind: 'fresh' }, sections: ['Chapter_12'] },
  } as unknown as Job
  await generateSubtitlesTranscribe(job)

  assert.equal(mock.providerSubmissionCount('transcription'), 1)
  assert.equal((job.result as any).generated_sections, 1)
  assert.equal((job.result as any).ready_sections, 16)
  assert.deepEqual((job.result as any).missing_sections, [])
  assert.match(await fs.readFile(path.join(paths.subtitles_dir, `${code}_Chapter_12.srt`), 'utf8'), /Hello from mock GenStudio/)
  const selectedHash = await hashSubtitleAudioSources([path.join(paths.audio_dir, selectedAudio)])
  assert.ok(selectedHash)
  const recovery = JSON.parse(await fs.readFile(path.join(paths.subtitles_dir, '.subtitle-recovery.json'), 'utf8'))
  assert.equal(recovery.sections[`${code}_${selectedChapter}.srt`].sourceAudioHash, selectedHash,
    'the regenerated subtitle must attest to Audio Assembly’s selected v2 bytes')
  assert.equal(recovery.sections[`${code}_${selectedChapter}.srt`].generationActionId, actionId)
  for (const [file, bytes] of preserved) assert.deepEqual(await fs.readFile(file), bytes, path.basename(file))

  const retry = {
    ...job, job_id: 'one-section-subtitle-retry', progress: 0, output_lines: [], result: undefined,
    params: { ...(job.params as any), force: false, subtitle_recovery: { sections: { Chapter_12: { state: 'needs_attention' } } } },
  } as unknown as Job
  await generateSubtitlesTranscribe(retry)
  assert.equal(mock.providerSubmissionCount('transcription'), 1,
    'Retry uses the same fresh action identity to recover its accepted task; it neither skips the old SRT nor posts a new task')
  assert.match(await fs.readFile(staleTarget, 'utf8'), /Hello from mock GenStudio/)
})

test('a changed active chapter source is re-transcribed instead of reusing its old provider output', async t => {
  const isolated = await useTempDataDir()
  const mock = await startMockGenStudioService()
  t.after(async () => { await mock.close(); await isolated.cleanup() })

  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const utils = await import('../services/utils.js')
  const { recordSubtitleSourceEvidence } = await import('../services/subtitle-recovery.js')
  const { generateSubtitlesTranscribe } = await import('../generators/subtitles.js')

  await settings.setGenStudioUrl(mock.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  client.clearGenStudioCatalogCache()
  const project = await pm.createProject({ name: 'Stale subtitle source fixture', episode_prefix: 'EP', episode_digits: 4 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'One chapter', logline: 'A fixture.', themes: [], suggested_chapters: 1,
    suggested_length: 'short', mood: 'measured',
  }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  const code = accepted.episode_code
  const paths = await utils.resolveEpisodePathsByCode(project.slug, code)
  const section = 'Chapter_01'
  const sourceName = `${code}_${section}.mp3`
  const source = path.join(paths.audio_dir, sourceName)
  const srtName = `${code}_${section}.srt`
  const srtPath = path.join(paths.subtitles_dir, srtName)
  await Promise.all([paths.script_dir, paths.audio_dir, paths.merged_audio_dir, paths.subtitles_dir].map(dir => fs.mkdir(dir, { recursive: true })))
  await fs.writeFile(paths.narration_docx, '## Chapter 01: Fixture\n\nA short line for the mock audio request.\n')
  await fs.writeFile(source, 'old chapter bytes')
  await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({
    gap_duration_s: 1,
    sections: [{ slug: section, duration_s: 1, source_file: sourceName }],
  }))
  await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio.mp3`), 'merged-audio')
  await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio.completion.json`), JSON.stringify({
    output_filename: `${code}_merged_audio.mp3`, opening: { lead_in_sec: 0, music_lead_in_sec: 0 },
  }))
  await fs.writeFile(srtPath, '1\n00:00:00,000 --> 00:00:01,000\nOld captions must not be reused.\n')
  await recordSubtitleSourceEvidence(paths.subtitles_dir, srtName, (await hashSubtitleAudioSources([source]))!, 'mock-whisper-v1')

  await fs.writeFile(source, 'new chapter bytes')
  const job = {
    job_id: 'changed-source-subtitle', project_slug: project.slug, episode_id: code,
    type: 'subtitles_transcribe', status: 'running', progress: 0, output_lines: [],
    params: { per_chapter: true, engine: 'genstudio', model: 'mock-whisper-v1', language: 'en', force: false, sections: [section] },
  } as unknown as Job
  await generateSubtitlesTranscribe(job)

  assert.equal(mock.providerSubmissionCount('transcription'), 1, 'the changed source must make a fresh provider request')
  assert.equal((job.result as any).generated_sections, 1)
  assert.match(await fs.readFile(srtPath, 'utf8'), /Hello from mock GenStudio/)
  const recovery = JSON.parse(await fs.readFile(path.join(paths.subtitles_dir, '.subtitle-recovery.json'), 'utf8'))
  assert.equal(recovery.sections[srtName].sourceAudioHash, await hashSubtitleAudioSources([source]))
})

test('stamped pipeline repair transcribes only malformed and gap-mapped chapters', async t => {
  const isolated = await useTempDataDir()
  const mock = await startMockGenStudioService()
  t.after(async () => { await mock.close(); await isolated.cleanup() })

  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const utils = await import('../services/utils.js')
  const { generateSubtitlesTranscribe } = await import('../generators/subtitles.js')

  await settings.setGenStudioUrl(mock.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  client.clearGenStudioCatalogCache()
  const project = await pm.createProject({ name: 'Pipeline subtitle repair fixture', episode_prefix: 'EP', episode_digits: 4 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Three chapters', logline: 'A fixture.', themes: [], suggested_chapters: 3,
    suggested_length: '3 minutes', mood: 'measured',
  }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  const code = accepted.episode_code
  const paths = await utils.resolveEpisodePathsByCode(project.slug, code)
  const sections = ['Chapter_01', 'Chapter_02', 'Chapter_03']
  await Promise.all([paths.script_dir, paths.audio_dir, paths.merged_audio_dir, paths.subtitles_dir].map(dir => fs.mkdir(dir, { recursive: true })))
  await fs.writeFile(paths.narration_docx, sections.map((section, index) => `## Chapter ${String(index + 1).padStart(2, '0')}: Fixture\n\nNarration for ${section}.`).join('\n\n'))
  await Promise.all(sections.map(section => fs.writeFile(path.join(paths.audio_dir, `${code}_${section}.mp3`), `audio-${section}`)))
  await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({
    gap_duration_s: 1,
    sections: [{ slug: 'Chapter_01', duration_s: 2 }, { slug: 'Chapter_02', duration_s: 90 }, { slug: 'Chapter_03', duration_s: 2 }],
  }))
  await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio.mp3`), 'merged-audio')
  await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio.completion.json`), JSON.stringify({ output_filename: `${code}_merged_audio.mp3`, opening: { lead_in_sec: 0, music_lead_in_sec: 0 } }))

  const good = Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nGood chapter.\n')
  const gap = '1\n00:00:00,000 --> 00:00:01,000\nBefore gap.\n\n2\n00:00:38,580 --> 00:00:39,000\nAfter gap.\n'
  await fs.writeFile(path.join(paths.subtitles_dir, `${code}_Chapter_01.srt`), good)
  await fs.writeFile(path.join(paths.subtitles_dir, `${code}_Chapter_02.srt`), gap)
  await fs.writeFile(path.join(paths.subtitles_dir, `${code}_Chapter_03.srt`), 'not an SRT')
  const stitched = [
    '1', '00:00:00,000 --> 00:00:01,000', 'Good chapter.', '',
    '2', '00:00:03,000 --> 00:00:04,000', 'Before gap.', '',
    '3', '00:00:41,580 --> 00:00:42,000', 'After gap.', '',
  ].join('\n')
  const cues = parseSrt(stitched)
  await fs.writeFile(path.join(paths.subtitles_dir, `${code}_stitched.srt`), stitched)
  await fs.writeFile(path.join(paths.subtitles_dir, `${code}_stitched.srt.json`), JSON.stringify({
    complete: false, total_cues: cues.length, timeline: stampFromCues(cues), missing_sections: ['Chapter_03'],
    sections: [
      { slug: 'Chapter_01', source_srt: `${code}_Chapter_01.srt`, offset_sec: 0, duration_sec: 2, cues_added: 1 },
      { slug: 'Chapter_02', source_srt: `${code}_Chapter_02.srt`, offset_sec: 3, duration_sec: 90, cues_added: 2 },
      { slug: 'Chapter_03', source_srt: `${code}_Chapter_03.srt`, offset_sec: 94, duration_sec: 2, cues_added: 0 },
    ],
  }))

  const job = {
    job_id: 'pipeline-repair-subtitles', project_slug: project.slug, episode_id: code,
    type: 'subtitles_transcribe', status: 'running', progress: 0, output_lines: [],
    params: { per_chapter: true, engine: 'genstudio', model: 'mock-whisper-v1', language: 'en', force: false,
      pipeline_repair: { action_id: 'repair-ep0083' } },
  } as unknown as Job
  await generateSubtitlesTranscribe(job)

  assert.equal(mock.providerSubmissionCount('transcription'), 2)
  assert.deepEqual(await fs.readFile(path.join(paths.subtitles_dir, `${code}_Chapter_01.srt`)), good)
  assert.match(await fs.readFile(path.join(paths.subtitles_dir, `${code}_Chapter_02.srt`), 'utf8'), /Hello from mock GenStudio/)
  assert.match(await fs.readFile(path.join(paths.subtitles_dir, `${code}_Chapter_03.srt`), 'utf8'), /Hello from mock GenStudio/)
})


test('a scoped subtitle job with Pipeline continuation still requires complete episode coverage', async t => {
  const fixture = await createScopedSubtitleFixture(t)
  fixture.mock.queueScenario('transcription', { states: ['accepted', 'succeeded'] })
  const job = fixture.makeJob('scoped-subtitle-with-chain')
  job.params.pipeline_chain = [{ type: 'scene_plan_run', params: {} }]
  await assert.rejects(fixture.generateSubtitlesTranscribe(job), /Chapter_02/)
  assert.equal(job.result?.complete, false)
  assert.equal(job.result?.episode_complete, false)
  await assert.rejects(fs.access(path.join(fixture.paths.subtitles_dir, `${fixture.code}_stitched.srt`)), /ENOENT/)
})

/**
 * The skip path must still stitch — v1.4.191
 *
 * `existingTranscriptIsCurrent` answers "is the transcript on disk still the
 * right consequence of this episode's audio?" Publishing that answer as
 * `{ skipped: true, complete: true }` is correct for the TRANSCRIPT and was
 * wrong for the JOB, because the job also owes Scene Plan a stitched timeline.
 *
 * The skip path returned before the stitch, so an episode whose stitched
 * timeline was missing — the exact state the stitch error names — reported
 * itself finished. Worse, the message the customer was shown said "Retry the
 * local subtitle stitch before Scene Plan", and the Retry took this same branch
 * and returned again without stitching. **The Retry could not perform the
 * repair its own error named.**
 *
 * Every other subtitle test drives `per_chapter: true`, which routes BEFORE
 * this branch — so the whole suite could stay green while this path did
 * nothing. These two tests are the only ones that enter it.
 */
async function seedMergedTranscriptFixture(fixture: Awaited<ReturnType<typeof createScopedSubtitleFixture>>) {
  const { code, paths } = fixture
  const cue = (text: string) => `1\n00:00:00,000 --> 00:00:02,000\n${text}\n\n`
  await Promise.all(fixture.sections.map(section =>
    fs.writeFile(path.join(paths.subtitles_dir, `${code}_${section}.srt`), cue(`Narration for ${section}.`)),
  ))
  await fs.writeFile(path.join(paths.subtitles_dir, `${code}_whisper.srt`), cue('Whole-track transcript.'))
  // Record the byte identity of each chapter's audio, which is what makes the
  // transcript on disk count as current rather than stale.
  const recorded: Record<string, { sourceAudioHash: string }> = {}
  for (const section of fixture.sections) {
    const hash = await hashSubtitleAudioSources([path.join(paths.audio_dir, `${code}_${section}.mp3`)])
    assert.ok(hash, `the fixture must be able to hash ${section}'s audio`)
    recorded[`${code}_${section}.srt`] = { sourceAudioHash: hash }
  }
  await fs.writeFile(
    path.join(paths.subtitles_dir, '.subtitle-recovery.json'),
    JSON.stringify({ sections: recorded }),
  )
}

test('a current whole-track transcript still stitches a missing timeline on the merged path', async t => {
  const fixture = await createScopedSubtitleFixture(t)
  await seedMergedTranscriptFixture(fixture)
  const stitched = path.join(fixture.paths.subtitles_dir, `${fixture.code}_stitched.srt`)
  await assert.rejects(fs.access(stitched), /ENOENT/, 'the fixture starts with no stitched timeline')

  const job = fixture.makeJob('merged-skip-restitch', { per_chapter: false, force: false })
  await fixture.generateSubtitlesTranscribe(job)

  assert.equal(job.result?.skipped, true, 'the verified transcript is still skipped, not re-transcribed')
  assert.equal(fixture.mock.providerSubmissionCount('transcription'), 0, 'repairing a local file must not cost a transcription')
  await fs.access(stitched)
  assert.equal(job.result?.stitch_complete, true)
  assert.equal(job.result?.complete, true)
})

test('the skip path does not rebuild a stitched timeline that is already current', async t => {
  const fixture = await createScopedSubtitleFixture(t)
  await seedMergedTranscriptFixture(fixture)
  const stitched = path.join(fixture.paths.subtitles_dir, `${fixture.code}_stitched.srt`)

  await fixture.generateSubtitlesTranscribe(fixture.makeJob('merged-skip-first', { per_chapter: false, force: false }))
  const first = await fs.stat(stitched)

  const second = fixture.makeJob('merged-skip-second', { per_chapter: false, force: false })
  await fixture.generateSubtitlesTranscribe(second)

  assert.equal(second.result?.skipped, true)
  assert.equal((await fs.stat(stitched)).mtimeMs, first.mtimeMs, 'a current stitch must be left exactly as it is')
  assert.equal(fixture.mock.providerSubmissionCount('transcription'), 0)
})
