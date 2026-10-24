/**
 * Narration in a language the chosen voice model does not list is refused before anything is sent.
 *
 * Owner, 2026-10-24: Khmer channels preset to Breeze TTS (English/Chinese only) babbled and failed
 * their quality check four times each. The model's own `supported_languages` decides; an empty list
 * is "unstated" and is never refused; Latin text is never judged by its script.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { dominantScript, narrationLanguageRefusal } from '../services/tts-language-guard.js'

const KHMER = 'មុនពេលមានស្រែចម្ការ មនុស្សរស់នៅដោយបរបាញ់ និងប្រមូលអាហារពីធម្មជាតិ។'
const ENGLISH = 'Clement walked back to the hearth table to finish the last few drops of his tea.'

test('Khmer narration on an English/Chinese model is refused, and says what to choose', () => {
  const reason = narrationLanguageRefusal([KHMER, KHMER], ['en', 'zh'], 'Breeze TTS 2 4-bit')
  assert.ok(reason)
  assert.match(reason, /Breeze TTS 2 4-bit cannot speak this narration/)
  assert.match(reason, /Khmer script/)
  assert.match(reason, /lists only en, zh/)
  assert.match(reason, /lists km/)
})

test('what the model lists, Latin text and unstated lists all pass', () => {
  assert.equal(narrationLanguageRefusal([KHMER], ['en', 'km', 'zh'], 'VoxCPM2 4-bit'), null)
  assert.equal(narrationLanguageRefusal([KHMER], ['km-KH'], 'Khmer TTS'), null)
  assert.equal(narrationLanguageRefusal([ENGLISH], ['en', 'zh'], 'Breeze TTS 2 4-bit'), null)
  assert.equal(narrationLanguageRefusal([KHMER], [], 'Fish S2'), null, 'an unstated list is never a refusal')
  assert.equal(narrationLanguageRefusal([KHMER], null, 'Fish S2'), null)
})

test('a few foreign words do not flip the language of a script', () => {
  assert.equal(dominantScript(`${ENGLISH} ${ENGLISH} ស្រែ`), null)
  assert.equal(dominantScript(`${KHMER} Komsan Studio`)?.name, 'Khmer')
  assert.equal(dominantScript('สวัสดีครับ')?.name, 'Thai')
})

test('the generator refuses before planning any request', () => {
  const source = readFileSync(new URL('../generators/audio.ts', import.meta.url), 'utf8')
  const guard = source.indexOf('narrationLanguageRefusal(sections.map')
  const firstSubmit = source.indexOf('for (const [sectionIndex, section] of sections.entries())')
  assert.ok(guard > 0 && guard < firstSubmit, 'the language check runs before the first section is sent')
})

test('the Audio page can ask which script an episode is written in, without generating anything', () => {
  const routes = readFileSync(new URL('../routes/audio.ts', import.meta.url), 'utf8')
  assert.match(routes, /router\.get\('\/projects\/:slug\/episodes\/:code\/narration-language'/)
})
