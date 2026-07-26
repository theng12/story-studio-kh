import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

function source(relative: string): string {
  return fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

describe('stock and Sound Design boundary UI', () => {
  test('assets library presents manual import without provider submission controls', () => {
    const library = source('../pages/broll-library.vue')
    assert.match(library, /Add files locally/)
    assert.doesNotMatch(library, /\/broll-fetch\/search|queueSelectedFetches|runFetchSearch/)
  })

  test('Sound Design retains local review but hides unavailable provider controls', () => {
    const sound = source('../pages/projects/[slug]/sound-design.vue')
    const scripted = source('../components/ScriptedBrollSection.vue')
    assert.match(sound, /definePageMeta\(\{\s*layout: 'dashboard'/)
    assert.match(sound, /useAppTitle\('Sound Design'\)/)
    assert.match(sound, /choose a local sound asset/)
    assert.match(sound, /GenStudio sound generation/)
    assert.doesNotMatch(sound, /ModelSelector|Freesound|ElevenLabs|Suno/)
    assert.match(scripted, /Existing resolved plans/)
    assert.doesNotMatch(scripted, /api\.(generate|resolve|search|swapBeat|requeryBeat)\(|ModelSelector|ImageModelPicker/)
    assert.match(scripted, /api\.assemble\(/)
  })
})
