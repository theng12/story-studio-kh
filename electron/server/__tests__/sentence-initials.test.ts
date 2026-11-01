/**
 * A name's initial is not a sentence (owner, 2026-11-01).
 *
 * "K. Theron published what is widely cited." was split into "K." and
 * "Theron published what is widely cited.", and the one-scene-per-sentence
 * planner then made a 0.125-SECOND SCENE out of "K." — a real scene for a
 * name's initial.
 *
 * The rule is about the word BEFORE the period, so:
 *  - an initial ("K. Theron") and an abbreviation ("Dr. Smith", "U.S.") do
 *    not end a sentence;
 *  - a real sentence that ENDS in a capital-letter word ("... the Senate.")
 *    still does;
 *  - a Khmer ។ and a CJK stop are untouched — those scripts write no space
 *    after their stop, so there is no word before it to be an abbreviation.
 *
 * Existing plans are not rewritten: this changes what a NEW split produces.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

const { splitSentences } = await import('../lib/sentence-ends.js')
const { splitIntoSentences } = await import('../lib/sentence-timing.js')
const { splitScenesBySentence } = await import('../services/scene-planner.js')
const { buildSentenceSidecar } = await import('../lib/sentence-timing.js')

describe('a name\'s initial does not end a sentence', () => {
  test('an initial stays with the name it belongs to', () => {
    assert.deepEqual(
      splitSentences('K. Theron published what is widely cited. He was right about it.'),
      ['K. Theron published what is widely cited. ', 'He was right about it.'],
    )
    assert.deepEqual(
      splitIntoSentences('K. Theron published what is widely cited. He was right about it.'),
      ['K. Theron published what is widely cited.', 'He was right about it.'],
    )
    // A run of initials is one name, not three sentences.
    assert.deepEqual(
      splitSentences('J. R. R. Tolkien wrote it. Yes.'),
      ['J. R. R. Tolkien wrote it. ', 'Yes.'],
    )
  })

  test('the common abbreviations do not end a sentence either', () => {
    assert.deepEqual(
      splitSentences('Dr. Smith arrived. He was late.'),
      ['Dr. Smith arrived. ', 'He was late.'],
    )
    assert.deepEqual(
      splitSentences('Prof. Jones spoke. Then he left.'),
      ['Prof. Jones spoke. ', 'Then he left.'],
    )
    // A dotted abbreviation, and a run of them.
    assert.deepEqual(
      splitSentences('The U.S. Army marched. It was long.'),
      ['The U.S. Army marched. ', 'It was long.'],
    )
    assert.deepEqual(
      splitSentences('A.B.C. Corp. reported. Yes.'),
      ['A.B.C. Corp. reported. ', 'Yes.'],
    )
    assert.deepEqual(
      splitSentences('Vol. 2 of the set. Next.'),
      ['Vol. 2 of the set. ', 'Next.'],
    )
  })

  test('a real sentence that ends in a capital-letter word still ends there', () => {
    assert.deepEqual(
      splitSentences('He went to the Senate. Then home.'),
      ['He went to the Senate. ', 'Then home.'],
    )
    assert.deepEqual(
      splitSentences('A sentence that ends in a capital word. Then another.'),
      ['A sentence that ends in a capital word. ', 'Then another.'],
    )
  })

  test('a number is not an abbreviation, and the other stops are untouched', () => {
    assert.deepEqual(
      splitSentences('It is 3.5 km away. Yes.'),
      ['It is 3.5 km away. ', 'Yes.'],
    )
    assert.deepEqual(
      splitSentences('One. Two!  Three? It is 3.5 ok.'),
      ['One. ', 'Two! ', 'Three? ', 'It is 3.5 ok.'],
    )
    // Khmer and CJK stops write no space after themselves, so there is no
    // word before them to be an abbreviation.
    assert.deepEqual(splitSentences('ហើយ។ ភ្នំខ្ពស់។'), ['ហើយ។ ', 'ភ្នំខ្ពស់។'])
    assert.deepEqual(splitSentences('今日は晴れ。明日は雨？はい！'), ['今日は晴れ。', '明日は雨？', 'はい！'])
  })

  test('a word that only LOOKS like an abbreviation still ends its sentence', () => {
    // The list is deliberately short. A word that happens to be spelled like
    // an abbreviation but reads as an ordinary word must not swallow the
    // sentence after it.
    for (const text of ['The answer was no. Then he left.', 'The value was min. Then he left.', 'The result was max. Then he left.']) {
      assert.deepEqual(splitSentences(text), [`${text.split('.')[0]}. `, 'Then he left.'], text)
    }
  })

  test('the pieces still rebuild the text', () => {
    for (const text of [
      'K. Theron published what is widely cited. He was right about it.',
      'Dr. Smith arrived. He was late.',
      'A.B.C. Corp. reported. Yes.',
      'It is 3.5 km away. Yes.',
      'He went to the Senate. Then home.',
    ]) {
      assert.equal(
        splitSentences(text).join('').replace(/\s+/g, ' ').trim(),
        text.replace(/\s+/g, ' ').trim(),
        text,
      )
    }
  })

  test('the one-scene-per-sentence planner no longer makes a scene out of an initial', () => {
    // The reported shape: a narration whose first "sentence" was an initial.
    // Before the fix the plan had a 0.125s scene for "K."; now it has one
    // scene for the whole sentence.
    const narration = 'K. Theron published what is widely cited. He was right about it.'
    const chapters = { sections: [{ slug: 'a', duration_s: 8 }], gap_duration_s: 0 }
    const sidecar = { schemaVersion: 1, ...buildSentenceSidecar(chapters.sections, [{ slug: 'a', text: narration }]) }
    const timeline = { complete: true, sections: [{ slug: 'a', duration_sec: 8, offset_sec: 0 }] }
    const scenes = splitScenesBySentence({
      chapters, narration: [{ slug: 'a', text: narration }], sidecar, timeline,
      opening_sec: 0, idGen: (i: number) => String(i),
    })
    assert.equal(scenes.length, 2, 'two sentences, two scenes')
    assert.equal(scenes[0]!.transcript_segment, 'K. Theron published what is widely cited.')
    assert.ok(
      scenes.every(scene => scene.end_sec - scene.start_sec >= 0.5),
      `no scene is shorter than the renderable floor: ${JSON.stringify(scenes.map(s => [s.start_sec, s.end_sec]))}`,
    )
  })
})
