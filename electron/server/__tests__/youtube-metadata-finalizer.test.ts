import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let finalizer: typeof import('../services/youtube-metadata-finalizer.js')
let pm: typeof import('../services/project-manager.js')
let cleanup: () => Promise<void>

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  await fs.mkdir(path.join(temp.dir, 'projects'), { recursive: true })
  finalizer = await import('../services/youtube-metadata-finalizer.js')
  pm = await import('../services/project-manager.js')
})

after(async () => {
  await cleanup()
})

describe('YouTube metadata finalizer', () => {
  test('managed blocks refresh without overwriting edited description prose', () => {
    const prose = 'A hand-edited opening paragraph.\n\nA second paragraph worth preserving.'
    let description = finalizer.refreshManagedBlock(
      prose,
      finalizer.CHAPTERS_BEGIN,
      finalizer.CHAPTERS_END,
      'CHAPTERS\n0:00 — First version',
    )
    description = finalizer.refreshManagedBlock(
      description,
      finalizer.SOURCES_BEGIN,
      finalizer.SOURCES_END,
      'SOURCES & FURTHER READING\n• Real source — https://example.com/source',
    )
    description = finalizer.refreshManagedBlock(
      description,
      finalizer.CHAPTERS_BEGIN,
      finalizer.CHAPTERS_END,
      'CHAPTERS\n0:00 — Approved opening\n8:15 — Approved evidence',
    )

    assert.match(description, /A hand-edited opening paragraph/)
    assert.match(description, /A second paragraph worth preserving/)
    assert.match(description, /0:00 — Approved opening/)
    assert.doesNotMatch(description, /First version/)
    assert.equal(description.match(/youtube:chapters:start/g)?.length, 1)
    assert.equal(description.match(/youtube:sources:start/g)?.length, 1)
  })

  test('an empty managed section is removed cleanly', () => {
    const withSources = finalizer.refreshManagedBlock(
      'Editorial description',
      finalizer.SOURCES_BEGIN,
      finalizer.SOURCES_END,
      'SOURCES & FURTHER READING\n• Source — https://example.com',
    )
    const withoutSources = finalizer.refreshManagedBlock(
      withSources,
      finalizer.SOURCES_BEGIN,
      finalizer.SOURCES_END,
      '',
    )
    assert.equal(withoutSources, 'Editorial description')
  })

  test('approved outline titles replace audio slugs and measured timing keeps the lead-in', () => {
    const chapters = finalizer.buildYouTubeChapters({
      sections: [
        { slug: 'Chapter_01', duration_sec: 120 },
        { slug: 'Chapter_02', duration_sec: 180 },
      ],
      outline: [
        { n: 1, title: 'The Door in the Mountain' },
        { n: 2, title: 'A Continent Set Adrift' },
      ],
      gapSec: 2,
      leadInSec: 15,
    })

    assert.deepEqual(
      chapters.map(chapter => ({ title: chapter.title, start_sec: chapter.start_sec })),
      [
        { title: 'Opening', start_sec: 0 },
        { title: 'The Door in the Mountain', start_sec: 15 },
        { title: 'A Continent Set Adrift', start_sec: 137 },
      ],
    )
  })

  test('missing outline titles fall back to readable chapter labels', () => {
    const chapters = finalizer.buildYouTubeChapters({
      sections: [{ slug: 'chapter_003', duration_sec: 90 }],
      outline: [],
    })
    assert.equal(chapters[0]?.title, 'Chapter 3')
    assert.equal(chapters[0]?.start_sec, 0)
  })

  test('finalizes complete Audio Assembly with approved titles, selected sources, and subtitle warnings', async () => {
    const project = await pm.createProject({ name: 'YouTube Finalizer Integration' })
    const ideas = await import('../services/idea-manager.js')
    const created = await ideas.addIdeas(project.slug, [{
      title: 'A Continent Set Adrift',
      logline: '',
      themes: [],
      suggested_chapters: 3,
      suggested_length: '20 min',
      mood: 'calm',
    }], 'test-model')
    await ideas.acceptIdea(project.slug, created[0]!.id)
    const episodeId = (await ideas.getIdeas(project.slug, 'accepted'))[0]!.episode_code!
    const { resolveEpisodePaths } = await import('../services/utils.js')
    const paths = await resolveEpisodePaths(project.slug, episodeId, 'A Continent Set Adrift')

    await Promise.all([
      fs.mkdir(paths.script_dir, { recursive: true }),
      fs.mkdir(paths.audio_dir, { recursive: true }),
      fs.mkdir(paths.merged_audio_dir, { recursive: true }),
      fs.mkdir(paths.subtitles_dir, { recursive: true }),
    ])
    await fs.writeFile(path.join(paths.script_dir, `${episodeId}_Script_Narration.md`), [
      '## Chapter 01: Draft One', '',
      'Measured narration for the first chapter.', '',
      '## Chapter 02: Draft Two', '',
      'Measured narration for the second chapter.', '',
      '## Chapter 03: Draft Three', '',
      'Measured narration for the third chapter.',
    ].join('\n'))
    for (let n = 1; n <= 3; n++) {
      await fs.writeFile(
        path.join(paths.audio_dir, `${episodeId}_Chapter_${String(n).padStart(2, '0')}.mp3`),
        Buffer.from(`audio-${n}`),
      )
    }
    await fs.writeFile(path.join(paths.merged_audio_dir, `${episodeId}_merged_audio.mp3`), Buffer.from('merged'))
    await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({
      gap_duration_s: 2,
      sections: [
        { slug: 'Chapter_01', duration_s: 120 },
        { slug: 'Chapter_02', duration_s: 180 },
        { slug: 'Chapter_03', duration_s: 90 },
      ],
    }))
    const { writeImportedOutline } = await import('../lib/chunked-narration.js')
    await writeImportedOutline(paths.script_dir, episodeId, [
      { title: 'The Door in the Mountain' },
      { title: 'A Continent Set Adrift' },
      { title: 'The Collision Beneath Your Feet' },
    ])
    await fs.writeFile(
      path.join(paths.subtitles_dir, `${episodeId}_Chapter_01.srt`),
      '1\n00:00:00,000 --> 00:00:02,000\nhello\n',
    )
    const { resolveResearchPaths } = await import('../lib/research-paths.js')
    const researchPaths = await resolveResearchPaths(paths.episode_dir, episodeId)
    await fs.mkdir(researchPaths.dir, { recursive: true })
    await fs.writeFile(researchPaths.jsonPath, JSON.stringify({
      schema_version: 1,
      source_provider: 'llm-only',
      generated_at: new Date().toISOString(),
      topic: 'continental drift',
      claims: [],
      citations: [
        { title: 'Selected evidence', url: 'https://example.com/selected', include_in_description: true },
        { title: 'Operator excluded this', url: 'https://example.com/excluded', include_in_description: false },
      ],
    }))

    const result = await finalizer.finalizeYouTubeDescription({
      slug: project.slug,
      episodeId,
      description: 'Hand-edited description prose.',
      includeSources: true,
    })

    assert.equal(result.audio_assembly_ready, true)
    assert.equal(result.subtitle_complete, false, 'subtitle coverage is warning-only')
    assert.match(result.warnings.join(' '), /Subtitle coverage is incomplete/)
    assert.match(result.description, /Hand-edited description prose/)
    assert.match(result.description, /0:00 The Door in the Mountain/)
    assert.match(result.description, /2:02 A Continent Set Adrift/)
    assert.match(result.description, /Selected evidence — https:\/\/example\.com\/selected/)
    assert.doesNotMatch(result.description, /Operator excluded this/)

    const withoutSources = await finalizer.finalizeYouTubeDescription({
      slug: project.slug,
      episodeId,
      description: result.description,
      includeSources: false,
    })
    assert.match(withoutSources.description, /Hand-edited description prose/)
    assert.match(withoutSources.description, /The Door in the Mountain/)
    assert.doesNotMatch(withoutSources.description, /youtube:sources:start/)
    assert.doesNotMatch(withoutSources.description, /Selected evidence/)
  })
})
