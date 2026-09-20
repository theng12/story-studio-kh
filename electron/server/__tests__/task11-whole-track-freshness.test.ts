/**
 * Task 11 — whole-track subtitle completion follows the authoritative merge.
 *
 * A whole-track transcript may intentionally contain sparse timing, including
 * one usable cue. Completion therefore does not guess coverage from the cue's
 * end time. It proves that the usable transcript was written from the exact
 * Audio Assembly output selected for this episode.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test, { type TestContext } from 'node:test'

import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import type { Job } from '../models/types.js'
import { hashSubtitleAudioSources } from '../services/subtitle-completion.js'
import {
  readSubtitleSourceAudioHashes,
  recordSubtitleSourceEvidence,
} from '../services/subtitle-recovery.js'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

async function fixture(t: TestContext) {
  const isolated = await useTempDataDir()
  const mock = await startMockGenStudioService()
  t.after(async () => {
    await mock.close()
    await isolated.cleanup()
  })

  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const utils = await import('../services/utils.js')

  await settings.setGenStudioUrl(mock.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  client.clearGenStudioCatalogCache()

  const project = await pm.createProject({ name: 'Task 11 whole track', episode_prefix: 'EP', episode_digits: 4 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Whole track authority', logline: 'Fixture.', themes: [], suggested_chapters: 1,
    suggested_length: 'short', mood: 'measured',
  }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  const code = accepted.episode_code
  const paths = await utils.resolveEpisodePathsByCode(project.slug, code)
  const sourceName = `${code}_Chapter_01.mp3`
  await Promise.all([
    paths.script_dir, paths.audio_dir, paths.merged_audio_dir, paths.subtitles_dir,
  ].map(dir => fs.mkdir(dir, { recursive: true })))
  await fs.writeFile(paths.narration_docx, '## Chapter 01: Fixture\n\nNarration.\n')
  await fs.writeFile(path.join(paths.audio_dir, sourceName), 'stable selected chapter bytes')
  await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({
    gap_duration_s: 1,
    sections: [{ slug: 'Chapter_01', duration_s: 3, source_file: sourceName }],
  }))

  const merged = path.join(paths.merged_audio_dir, `${code}_merged_audio.mp3`)
  async function writeMerge(frequency: number): Promise<void> {
    await runFfmpeg([
      '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=3`,
      '-codec:a', 'libmp3lame', '-q:a', '9', merged,
    ])
    const stat = await fs.stat(merged)
    await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio.completion.json`), JSON.stringify({
      output_filename: path.basename(merged), bytes: stat.size, duration_sec: 3,
      opening: { lead_in_sec: 0, music_lead_in_sec: 0 },
    }))
  }

  return { mock, project, code, paths, sourceName, merged, writeMerge }
}

test('whole-track retry retranscribes when the authoritative merged bytes changed', async t => {
  const f = await fixture(t)
  await f.writeMerge(330)

  // One cue is a supported whole-track transcript. Its short timing is not a
  // defect: some imported/generated transcripts intentionally omit stretches.
  const cue = '1\n00:00:00,000 --> 00:00:00,250\nIntentional sparse transcript.\n\n'
  const chapterSrt = `${f.code}_Chapter_01.srt`
  const wholeSrt = `${f.code}_whisper.srt`
  await fs.writeFile(path.join(f.paths.subtitles_dir, chapterSrt), cue)
  await fs.writeFile(path.join(f.paths.subtitles_dir, wholeSrt), cue)

  const chapterHash = await hashSubtitleAudioSources([path.join(f.paths.audio_dir, f.sourceName)])
  const originalMergeHash = await hashSubtitleAudioSources([f.merged])
  assert.ok(chapterHash && originalMergeHash)
  await recordSubtitleSourceEvidence(f.paths.subtitles_dir, chapterSrt, chapterHash, 'mock-whisper-v1')
  await recordSubtitleSourceEvidence(f.paths.subtitles_dir, wholeSrt, originalMergeHash, 'mock-whisper-v1')

  // Audio Assembly replaces only its authoritative whole-track output. The
  // per-chapter input remains unchanged, so per-section freshness cannot prove
  // that the existing whole-track transcript still belongs to this merge.
  await f.writeMerge(660)
  const replacementHash = await hashSubtitleAudioSources([f.merged])
  assert.ok(replacementHash && replacementHash !== originalMergeHash)

  f.mock.queueScenario('transcription', { states: ['accepted', 'succeeded'] })
  const { generateSubtitlesTranscribe } = await import('../generators/subtitles.js')
  const job = {
    job_id: 'task11-whole-track-retry', project_slug: f.project.slug, episode_id: f.code,
    type: 'subtitles_transcribe', status: 'running', progress: 0, output_lines: [],
    params: {
      per_chapter: false, engine: 'genstudio', model: 'mock-whisper-v1', language: 'en', force: false,
    },
  } as unknown as Job

  let failure: unknown
  try {
    await generateSubtitlesTranscribe(job)
  } catch (error) {
    failure = error
  }
  assert.equal(
    f.mock.providerSubmissionCount('transcription'),
    1,
    `changed authoritative audio must reach transcription, not the stale skip path: ${String(failure || '')}`,
  )
  if (failure) throw failure
  assert.equal(job.result?.skipped, undefined)
  const recorded = await readSubtitleSourceAudioHashes(f.paths.subtitles_dir)
  assert.equal(recorded[wholeSrt], replacementHash, 'the successful SRT write records the merge bytes it transcribed')
})

test('whole-track legacy freshness fails closed on unexpected source stat errors', async t => {
  const f = await fixture(t)
  const wholeSrt = `${f.code}_whisper.srt`
  await fs.writeFile(
    path.join(f.paths.subtitles_dir, wholeSrt),
    '1\n00:00:00,000 --> 00:00:00,250\nLegacy transcript.\n\n',
  )

  // A regular file used as a parent makes stat fail deterministically with
  // ENOTDIR. That is an I/O failure, not evidence that audio changed; the skip
  // gate must stop before its caller can turn the ambiguity into a paid POST.
  const blocker = path.join(f.paths.merged_audio_dir, 'not-a-directory')
  await fs.writeFile(blocker, 'blocker')
  const { existingTranscriptIsCurrent } = await import('../generators/subtitles.js')
  await assert.rejects(
    () => existingTranscriptIsCurrent({
      projectSlug: f.project.slug,
      episodeId: f.code,
      code: f.code,
      outDir: f.paths.subtitles_dir,
      sourceAudio: path.join(blocker, 'merged.mp3'),
    }),
    /could not inspect authoritative merged audio.*ENOTDIR.*no transcription was submitted/i,
  )
  assert.equal(f.mock.providerSubmissionCount('transcription'), 0)
})
