import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { evaluateAudioTimelineManifest } from '../services/audio-workflow-readiness.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverRoot = path.resolve(here, '..')

test('audio timeline manifest accepts every required section with positive duration', () => {
  const result = evaluateAudioTimelineManifest(
    [
      'EP0021_Introduction.mp3',
      'EP0021_Chapter_01.mp3',
      'EP0021_Chapter_02_part1.mp3',
      'EP0021_Chapter_02_part2.mp3',
    ],
    'EP0021',
    {
      sections: [
        { slug: 'Introduction', duration_s: 12.5 },
        { slug: 'Chapter_01', duration_s: 38 },
        { slug: 'Chapter_02', duration_s: 42 },
      ],
    },
  )

  assert.equal(result.ready, true)
  assert.deepEqual(result.expected_sections, ['Introduction', 'Chapter_01', 'Chapter_02'])
  assert.deepEqual(result.missing_timeline_sections, [])
})

test('audio timeline manifest blocks missing and zero-duration sections', () => {
  const result = evaluateAudioTimelineManifest(
    ['EP0021_Chapter_01.mp3', 'EP0021_Chapter_02.mp3', 'EP0021_Chapter_03.mp3'],
    'EP0021',
    {
      sections: [
        { slug: 'Chapter_01', duration_s: 30 },
        { slug: 'Chapter_02', duration_s: 0 },
      ],
    },
  )

  assert.equal(result.ready, false)
  assert.deepEqual(result.timeline_sections, ['Chapter_01'])
  assert.deepEqual(result.missing_timeline_sections, ['Chapter_02', 'Chapter_03'])
})

test('audio assembly and transcription enforce their authoritative prerequisite gates', async () => {
  const audioMergeRoute = await readFile(path.join(serverRoot, 'routes/audio-merge.ts'), 'utf-8')
  const audioMergeGenerator = await readFile(path.join(serverRoot, 'generators/audio-merge.ts'), 'utf-8')
  const subtitleRoute = await readFile(path.join(serverRoot, 'routes/video.ts'), 'utf-8')
  const subtitleGenerator = await readFile(path.join(serverRoot, 'generators/subtitles.ts'), 'utf-8')
  const subtitlePage = await readFile(
    path.resolve(serverRoot, '../../frontend/pages/projects/[slug]/subtitles.vue'),
    'utf-8',
  )
  const audioMergePage = await readFile(
    path.resolve(serverRoot, '../../frontend/pages/projects/[slug]/audio-merge.vue'),
    'utf-8',
  )

  assert.match(audioMergeRoute, /await requireChapterAudioReady\(slug, episode_id\)/)
  assert.match(audioMergeGenerator, /await requireChapterAudioReady\(project_slug, code\)/)
  assert.match(audioMergePage, /:disabled="!chapterAudioReady \|\| mergeStatus\.loading \|\| !!mergeStatus\.error \|\| generating \|\| mergeJobActiveForEpisode"/)
  assert.match(subtitleRoute, /await requireAudioAssemblyReady\(slug, episodeId\)/)
  assert.match(subtitleGenerator, /await requireAudioAssemblyReady\(project_slug, code\)/)
  assert.match(subtitlePage, /status\.value\?\.audio_assembly_ready/)
})
