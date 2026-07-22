import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

function source(relative: string): string {
  return fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

describe('stock and SFX GenStudio boundary UI', () => {
  test('assets library presents manual import without provider submission controls', () => {
    const library = source('../pages/broll-library.vue')
    assert.match(library, /Add files locally/)
    assert.doesNotMatch(library, /\/broll-fetch\/search|queueSelectedFetches|runFetchSearch/)
  })

  test('SFX and scripted B-Roll components retain local editing but hide automation', () => {
    const sfx = source('../components/SfxSoundSection.vue')
    const scripted = source('../components/ScriptedBrollSection.vue')
    assert.match(sfx, /Re-match local pool/)
    assert.doesNotMatch(sfx, /api\.generate\(|auto_fetch:\s*true|ModelSelector/)
    assert.match(scripted, /Existing resolved plans/)
    assert.doesNotMatch(scripted, /api\.(generate|resolve|search|swapBeat|requeryBeat)\(|ModelSelector|ImageModelPicker/)
    assert.match(scripted, /api\.assemble\(/)
  })
})
