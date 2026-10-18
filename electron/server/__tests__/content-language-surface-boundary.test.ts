/**
 * Boundary guard: the audience-language directive belongs only in
 * audience-facing prompt builders. Image, scene, music, cue, research and
 * subtitle prompts must stay language-independent — their technical output is
 * not translated, and importing the boundary there would be a bug.
 *
 * This is a source-level assertion on purpose: it fails when a future change
 * wires the directive into a visual/technical generator, even if no prompt
 * snapshot test happens to cover that file.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'

const AUDIENCE_IMPORT_FILES = [
  'generators/episode.ts',
  'generators/metadata.ts',
  'routes/ideas.ts',
]

const TECHNICAL_FILES = [
  'generators/image-prompts.ts',
  'generators/images.ts',
  'generators/scene-plan.ts',
  'generators/scene-image.ts',
  'generators/image-pool-generate.ts',
  'generators/music-episode-build.ts',
  'generators/music-generate.ts',
  'generators/music-scene-polish.ts',
  'generators/music-video.ts',
  'generators/song-pool-generate.ts',
  'generators/contextual-cues.ts',
  'generators/research.ts',
  'generators/subtitles.ts',
  'generators/broll-autotag.ts',
  'generators/broll-normalize.ts',
  'generators/broll-select.ts',
]

function sourcePath(relative: string): URL {
  return new URL(`../${relative}`, import.meta.url)
}

describe('audience vs technical prompt boundary', () => {
  test('the audience builders import the shared boundary', async () => {
    for (const file of AUDIENCE_IMPORT_FILES) {
      const source = await fs.readFile(sourcePath(file), 'utf-8')
      assert.match(source, /content-language/, `${file} must use the shared language boundary`)
    }
    // The description builder is deliberately dependency-free: it receives the
    // directive as an argument rather than reading project state itself.
    const metadataSource = await fs.readFile(sourcePath('lib/metadata-prompt.ts'), 'utf-8')
    assert.match(metadataSource, /languageDirectiveText/)
  })

  test('visual, music, cue, research and subtitle builders never import it', async () => {
    for (const file of TECHNICAL_FILES) {
      const source = await fs.readFile(sourcePath(file), 'utf-8')
      assert.doesNotMatch(source, /content-language|languageDirective/,
        `${file} is technical/visual output and must stay language-independent`)
    }
  })
})
