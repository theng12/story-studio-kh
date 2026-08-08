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
    assert.match(sound, /definePageMeta\(\{\s*layout: 'dashboard'/)
    assert.match(sound, /useAppTitle\('Sound Design'\)/)
    assert.match(sound, /choose a local sound asset/)
    assert.match(sound, /GenStudio sound generation/)
    assert.doesNotMatch(sound, /ModelSelector|Freesound|ElevenLabs|Suno/)
  })

  test('Sound Design explains the purpose and audible effect of every mix control', () => {
    const sound = source('../pages/projects/[slug]/sound-design.vue')
    assert.match(sound, /Sound density/)
    assert.match(sound, /How often ambience and effects appear/)
    assert.match(sound, /Maximum spots per minute/)
    assert.match(sound, /Start at 2–4 to avoid distracting from speech/)
    assert.match(sound, /Ambient bed level/)
    assert.match(sound, /More negative is quieter; −20 dB/)
    assert.match(sound, /Spot effect level/)
    assert.match(sound, /More negative is quieter; −12 dB/)
    assert.match(sound, /Bed ducking/)
    assert.match(sound, /Gentle preserves atmosphere; Strong prioritizes voice clarity/)
    assert.match(sound, /aria-describedby="sound-density-help"/)
    assert.match(sound, /title="Controls how frequently Sound Design suggests ambience/)
  })
})
