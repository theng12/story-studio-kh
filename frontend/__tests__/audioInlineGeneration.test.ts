import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const audioPage = source('../pages/projects/[slug]/audio.vue')
const chapterSelector = source('../components/AudioChapterSelector.vue')

describe('Audio one-chapter generation', () => {
  test('exposes an explicit inline action for every chapter row', () => {
    assert.match(chapterSelector, /'generate-section': \[slug: string\]/)
    assert.match(chapterSelector, /emit\('generate-section', s\.slug\)/)
    assert.match(chapterSelector, /Send only .* to the selected TTS provider/)
  })

  test('submits the requested chapter instead of the batch selection', () => {
    assert.match(audioPage, /@generate-section="submitSection"/)
    assert.match(audioPage, /async function submitSection\(sectionSlug: string\)/)
    assert.match(audioPage, /await queueAudio\(sectionSlug\)/)
    assert.match(audioPage, /const sections = sectionOverride \|\| \(effectiveSections\.value\.length/)
    assert.match(audioPage, /const payload: any = \{ \.\.\.rest, sections, force, no_overwrite \}/)
  })

  test('shares normal validation and prevents duplicate episode audio jobs', () => {
    assert.match(audioPage, /async function queueAudio\(sectionOverride\?: string\)/)
    assert.match(audioPage, /if \(!await confirmGeneration\(slug\.value, 'audio', payload\)\) return/)
    assert.match(audioPage, /audioJobActiveForEpisode\.value/)
    assert.match(chapterSelector, /status === 'generated' && !allowDuplicatesLocal\.value/)
  })
})
