import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkStylePack, formatSubjectFailures, scanText, loadSubjectConfig } from '../subject-check.mjs'

test('subject-check: blood/bone in a limit sentence fails', async () => {
  const config = await loadSubjectConfig()
  const doc = {
    kind: 'visual-style',
    id: 'test.blood-limit',
    style_bible: 'If blood appears, bones as white shapes in the background.',
  }
  const result = await checkStylePack([doc], 'test.pack')
  assert.ok(result.failures.length > 0, 'should find failures')
  assert.ok(result.failures.some(f => f.word === 'blood'), 'should flag blood')
  assert.ok(result.failures.some(f => f.word === 'bone'), 'should flag bone')
})

test('subject-check: cool blue shadow passes (compound)', async () => {
  const config = await loadSubjectConfig()
  const doc = {
    kind: 'visual-style',
    id: 'test.cool-blue',
    style_bible: 'Use cool blue shadow in the distance.',
  }
  const result = await checkStylePack([doc], 'test.pack')
  assert.equal(result.failures.length, 0, 'cool blue shadow should pass')
})

test('subject-check: bone white passes (compound)', async () => {
  const config = await loadSubjectConfig()
  const doc = {
    kind: 'visual-style',
    id: 'test.bone-white',
    style_bible: 'Paint the walls bone white with warm light.',
  }
  const result = await checkStylePack([doc], 'test.pack')
  assert.equal(result.failures.length, 0, 'bone white should pass')
})

test('subject-check: list after "such as" fails', async () => {
  const config = await loadSubjectConfig()
  const doc = {
    kind: 'visual-style',
    id: 'test.such-as',
    style_bible: 'Use medieval elements such as castle, sword, and shield.',
  }
  const result = await checkStylePack([doc], 'test.pack')
  assert.ok(result.failures.length > 0, 'should find failures')
  assert.ok(result.failures.some(f => f.word === 'medieval'), 'should flag medieval')
  assert.ok(result.failures.some(f => f.word === 'castle'), 'should flag castle')
  assert.ok(result.failures.some(f => f.word === 'sword'), 'should flag sword')
})

test('subject-check: medieval fantasy fails (genre)', async () => {
  const config = await loadSubjectConfig()
  const doc = {
    kind: 'visual-style',
    id: 'test.medieval-fantasy',
    style_bible: 'A medieval fantasy style with dramatic lighting.',
  }
  const result = await checkStylePack([doc], 'test.pack')
  assert.ok(result.failures.length > 0, 'should find failures')
  assert.ok(result.failures.some(f => f.word === 'medieval'), 'should flag medieval')
  assert.ok(result.failures.some(f => f.word === 'fantasy'), 'should flag fantasy')
})

test('subject-check: martial-arts fails (genre)', async () => {
  const config = await loadSubjectConfig()
  const doc = {
    kind: 'visual-style',
    id: 'test.martial-arts',
    style_bible: 'A martial-arts comic style with bold lines.',
  }
  const result = await checkStylePack([doc], 'test.pack')
  assert.ok(result.failures.length > 0, 'should find failures')
  assert.ok(result.failures.some(f => f.word === 'martial-arts'), 'should flag martial-arts')
})

test('subject-check: regal mood fails', async () => {
  const config = await loadSubjectConfig()
  const doc = {
    kind: 'visual-style',
    id: 'test.regal',
    style_bible: 'A regal style with gold accents.',
  }
  const result = await checkStylePack([doc], 'test.pack')
  assert.ok(result.failures.length > 0, 'should find failures')
  assert.ok(result.failures.some(f => f.word === 'regal'), 'should flag regal')
})

test('subject-check: exactly one animal fails (required class)', async () => {
  const config = await loadSubjectConfig()
  const doc = {
    kind: 'visual-style',
    id: 'test.one-animal',
    style_bible: 'Draw exactly one animal per frame.',
  }
  const result = await checkStylePack([doc], 'test.pack')
  assert.ok(result.failures.length > 0, 'should find failures')
  assert.ok(result.failures.some(f => f.word === 'animal'), 'should flag animal')
})

test('subject-check: texture on stone passes (technique)', async () => {
  const config = await loadSubjectConfig()
  const doc = {
    kind: 'visual-style',
    id: 'test.texture',
    style_bible: 'Show texture on stone surfaces with visible brushwork.',
  }
  const result = await checkStylePack([doc], 'test.pack')
  assert.equal(result.failures.length, 0, 'texture on stone should pass')
})

test('subject-check: description warnings only', async () => {
  const config = await loadSubjectConfig()
  const doc = {
    kind: 'visual-style',
    id: 'test.desc-warning',
    style_bible: 'Use warm light and cool shadows.',
    description: 'A medieval fantasy style.',
  }
  const result = await checkStylePack([doc], 'test.pack')
  assert.equal(result.failures.length, 0, 'style_bible should pass')
  assert.ok(result.warnings.length > 0, 'description should warn')
  assert.ok(result.warnings.some(w => w.word === 'medieval'), 'should warn about medieval in description')
  assert.ok(result.warnings.some(w => w.word === 'fantasy'), 'should warn about fantasy in description')
})

test('subject-check: per-pack allow entry suppresses failure', async () => {
  const config = await loadSubjectConfig()
  // Temporarily add an allow entry
  const originalAllows = config.allows || []
  config.allows = [
    ...originalAllows,
    { pack_id: 'allowed.pack', word: 'blood', reason: 'safety limit for gory content' }
  ]
  const doc = {
    kind: 'visual-style',
    id: 'test.allowed',
    style_bible: 'If blood appears, keep it minimal.',
  }
  const result = await checkStylePack([doc], 'allowed.pack')
  assert.equal(result.failures.length, 0, 'allow entry should suppress failure')
  // Restore
  config.allows = originalAllows
})

test('subject-check: formatSubjectFailures includes word and sentence', () => {
  const failures = [
    { styleId: 'test.style', field: 'style_bible', word: 'blood', kind: 'subject', sentence: 'If blood appears.' }
  ]
  const message = formatSubjectFailures(failures)
  assert.ok(message.includes('blood'), 'message should include word')
  assert.ok(message.includes('If blood appears.'), 'message should include sentence')
  assert.ok(message.includes('test.style'), 'message should include style id')
})

test('subject-check: scanText masks compounds before scanning', async () => {
  const config = await loadSubjectConfig()
  const findings = scanText('The walls are bone white.', config)
  assert.equal(findings.length, 0, 'bone white compound should be masked')
})

test('subject-check: scanText finds words on word boundaries', async () => {
  const config = await loadSubjectConfig()
  const findings = scanText('Draw a dog with a cat.', config)
  assert.ok(findings.some(f => f.word === 'dog'), 'should find dog')
  assert.ok(findings.some(f => f.word === 'cat'), 'should find cat')
})

test('subject-check: scanText does not match partial words', async () => {
  const config = await loadSubjectConfig()
  const findings = scanText('The cathedral has a dogma.', config)
  // 'dogma' contains 'dog' but should not match on word boundary
  const dogFindings = findings.filter(f => f.word === 'dog')
  assert.equal(dogFindings.length, 0, 'dog should not match inside dogma')
})

test('subject-check: bare palette colour passes, named subject fails', async () => {
  const config = await loadSubjectConfig()
  // Bare colour swatch in a palette list — passes.
  const palette = await checkStylePack([{
    kind: 'visual-style',
    id: 'test.palette',
    style_bible: 'Palette: ochre, umber, warm earth red, bone and charcoal.',
  }], 'test.pack')
  assert.equal(palette.failures.length, 0, 'bare bone in a palette list should pass')
  // The same word naming an object — fails.
  const named = await checkStylePack([{
    kind: 'visual-style',
    id: 'test.named',
    style_bible: 'The bone of the leg is drawn as a white shape.',
  }], 'test.pack')
  assert.ok(named.failures.some(f => f.word === 'bone'), 'bone as an object should fail')
})

test('subject-check: non-visual-style documents are skipped', async () => {
  const config = await loadSubjectConfig()
  const doc = {
    kind: 'thumbnail-recipe',
    id: 'test.thumbnail',
    style_bible: 'A castle with a dragon.',
  }
  const result = await checkStylePack([doc], 'test.pack')
  assert.equal(result.failures.length, 0, 'non-visual-style should be skipped')
})

test('subject-check: the leaks seen in test drawings fail', () => {
  const config = JSON.parse(readFileSync(new URL('../subject-words.json', import.meta.url), 'utf8'))
  const words = text => scanText(text, config).map(f => f.word)
  assert.ok(words('supplied by a practical light such as a lamp, a window, a fire or a lantern.').includes('lantern'))
  assert.ok(words('Historical people have period-appropriate dress.').includes('historical'))
  assert.deepEqual(words('warm earth red, bone and charcoal; slate green, bone, ochre.'), [])
  assert.ok(words('a bone, a knife').includes('bone'))
  assert.ok(words('bone and the skull').includes('bone'))
})
