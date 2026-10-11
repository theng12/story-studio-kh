/**
 * 1.4.280 — Brain Wise EP0040/EP0041: narrated and merged in 8 chapters before the channel had an
 * Introduction. A later intro script made Subtitles demand `Introduction.mp3`, and a stray intro
 * narrated in another voice sat on disk unactivated. Audio Assembly's active selection is the episode:
 * no Introduction row means no Introduction, and the stray file is never used.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { inspectAudioAssemblyReadiness, timelineOmitsIntroduction } from '../services/audio-workflow-readiness.js'
import { useTempDataDir } from './_helpers.js'

test('an episode assembled without an Introduction is ready for Subtitles, and the stray intro is ignored', async t => {
  const isolated = await useTempDataDir()
  t.after(() => isolated.cleanup())
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const utils = await import('../services/utils.js')
  const project = await pm.createProject({ name: 'Intro-less episode', episode_prefix: 'EP', episode_digits: 4 })
  const [idea] = await ideas.addIdeas(project.slug, [{ title: 'Old episode', logline: 'x', themes: [], suggested_chapters: 2, suggested_length: 'short', mood: 'calm' }], 'mock-chat-v1')
  const code = (await ideas.acceptIdea(project.slug, idea!.id, false)).episode_code
  const paths = await utils.resolveEpisodePathsByCode(project.slug, code)
  await Promise.all([paths.script_dir, paths.audio_dir, paths.merged_audio_dir].map(dir => fs.mkdir(dir, { recursive: true })))
  // The script gained an Introduction after the episode was narrated and merged.
  await fs.writeFile(paths.narration_docx, '# Introduction\n\nWelcome.\n\n## Chapter 01: One\n\nFirst.\n\n## Chapter 02: Two\n\nSecond.\n')
  for (const slug of ['Chapter_01', 'Chapter_02']) await fs.writeFile(path.join(paths.audio_dir, `${code}_${slug}.mp3`), 'chapter-audio')
  const manifest = {
    gap_duration_s: 1,
    sections: [
      { slug: 'Chapter_01', duration_s: 1, source_file: `${code}_Chapter_01.mp3` },
      { slug: 'Chapter_02', duration_s: 1, source_file: `${code}_Chapter_02.mp3` },
    ],
  }
  await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify(manifest))
  const merged = path.join(paths.merged_audio_dir, `${code}_merged_audio.mp3`)
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25', '-codec:a', 'libmp3lame', '-q:a', '9', merged])
  await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio.completion.json`), JSON.stringify({
    output_filename: path.basename(merged), bytes: (await fs.stat(merged)).size, duration_sec: 0.25,
    opening: { lead_in_sec: 0, music_lead_in_sec: 0 },
  }))

  assert.equal(timelineOmitsIntroduction(manifest), true)
  let readiness = await inspectAudioAssemblyReadiness(project.slug, code)
  assert.equal(readiness.audio_assembly_ready, true, readiness.issues.join(' '))
  assert.deepEqual(readiness.expected_sections, ['Chapter_01', 'Chapter_02'])
  assert.equal(readiness.missing_files.length, 0)

  // A stray intro narrated in another voice and never activated changes nothing.
  await fs.writeFile(path.join(paths.audio_dir, `${code}_Introduction.mp3`), 'other-voice')
  readiness = await inspectAudioAssemblyReadiness(project.slug, code)
  assert.equal(readiness.audio_assembly_ready, true)
  const { resolveSubtitleChapterSources } = await import('../generators/subtitles.js')
  const sources = await resolveSubtitleChapterSources(project.slug, code)
  assert.deepEqual(sources.allSections.map(section => section.slug), ['Chapter_01', 'Chapter_02'])

  // A timeline that does include the Introduction still requires it.
  await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({
    ...manifest, sections: [{ slug: 'Introduction', duration_s: 1, source_file: `${code}_Introduction.mp3` }, ...manifest.sections],
  }))
  assert.equal(timelineOmitsIntroduction({ sections: [{ slug: 'Introduction' }] }), false)
  await fs.rm(path.join(paths.audio_dir, `${code}_Introduction.mp3`))
  readiness = await inspectAudioAssemblyReadiness(project.slug, code)
  assert.equal(readiness.audio_assembly_ready, false)
})

test('a legacy duration-only timeline without an Introduction does not transcribe a stray intro file', async t => {
  const isolated = await useTempDataDir()
  t.after(() => isolated.cleanup())
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const utils = await import('../services/utils.js')
  const project = await pm.createProject({ name: 'Legacy intro-less', episode_prefix: 'EP', episode_digits: 4 })
  const [idea] = await ideas.addIdeas(project.slug, [{ title: 'Legacy', logline: 'x', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'mock-chat-v1')
  const code = (await ideas.acceptIdea(project.slug, idea!.id, false)).episode_code
  const paths = await utils.resolveEpisodePathsByCode(project.slug, code)
  await Promise.all([paths.script_dir, paths.audio_dir].map(dir => fs.mkdir(dir, { recursive: true })))
  await fs.writeFile(paths.narration_docx, '# Introduction\n\nWelcome.\n\n## Chapter 01: One\n\nFirst.\n')
  await fs.writeFile(path.join(paths.audio_dir, `${code}_Chapter_01.mp3`), 'chapter-audio')
  await fs.writeFile(path.join(paths.audio_dir, `${code}_Introduction.mp3`), 'other-voice')
  await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({ sections: [{ slug: 'Chapter_01', duration_s: 1 }] }))
  const { resolveSubtitleChapterSources } = await import('../generators/subtitles.js')
  const sources = await resolveSubtitleChapterSources(project.slug, code)
  assert.deepEqual(sources.allSections.map(section => section.slug), ['Chapter_01'])
})
