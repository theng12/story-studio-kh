import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

function source(relative: string): string {
  return fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

describe('stock and Sound & Labels boundary UI', () => {
  test('assets library presents manual import without provider submission controls', () => {
    const library = source('../pages/broll-library.vue')
    assert.match(library, /via Finder and click/)
    assert.doesNotMatch(library, /Add files|Searching stock-footage/)
    assert.doesNotMatch(library, /\/broll-fetch\/search|queueSelectedFetches|runFetchSearch/)
  })

  test('Sound & Labels retains local review but hides unavailable provider controls', () => {
    const page = source('../pages/projects/[slug]/sound-and-labels.vue')
    assert.match(page, /definePageMeta\(\{\s*layout: 'dashboard'/)
    assert.match(page, /useAppTitle\('Sound & Labels'\)/)
    assert.match(page, /choose a sound/)
    // Plain words: sounds come from the customer's own folders and the Gateway
    // library — and a failed Gateway search says so, rather than showing an
    // empty picker as if the customer had no sounds.
    assert.match(page, /Search Gateway library/)
    assert.match(page, /Your sound folders/)
    assert.match(page, /is unavailable/)
    assert.doesNotMatch(page, /qualified live Gateway capability|Phase 1 uses/)
    assert.doesNotMatch(page, /Freesound|ElevenLabs|Suno/)
  })

  test('Sound & Labels explains the purpose and audible effect of every mix control', () => {
    const page = source('../pages/projects/[slug]/sound-and-labels.vue')
    // v1.4.365 — "Sound density" is GONE: nothing read it. Every remaining
    // control below is one the mixer or the resolver actually honours, and the
    // test names each by the promise it makes to the customer.
    assert.doesNotMatch(page, /Sound density|settings\.density/, 'a control nothing reads must not survive')
    assert.match(page, /Maximum spots per minute/)
    assert.match(page, /Over this, the extra spots are left out of the mix and said so on the row/)
    assert.match(page, /Ambient bed level \(dB\)/)
    assert.match(page, /Spot effect level \(dB\)/)
    assert.match(page, /Bed ducking/)
    assert.match(page, /Gentle — light narration protection/)
    assert.match(page, /Sound mix settings/)
  })
})
