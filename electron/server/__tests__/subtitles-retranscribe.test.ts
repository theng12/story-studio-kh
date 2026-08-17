/**
 * Re-transcription must actually re-ask — v1.2.2
 *
 * Found while building the subtitle-quality warning, which offers
 * "re-transcribe this chapter" as the remedy for a corrupt transcript.
 *
 * `force` used to bypass only the local "this SRT already exists" skip.
 * Everything after that still matched the saved manifest task — same audio,
 * same model, same language — so the run reconnected to the completed GenStudio
 * task via `recoverTranscriptionWithGenStudio` and re-downloaded the identical
 * artifact. The checkbox promised a re-run and delivered a cache hit.
 *
 * That is invisible when nothing was wrong, and fatal to the one case that
 * matters: re-transcribing a chapter *because* Whisper hallucinated into it.
 * Replaying the same result is the single outcome that cannot help, and the
 * user would have waited (and possibly paid) to receive the same garbage.
 *
 * Ordinary Retry after a crash must still reconnect to accepted work rather
 * than paying twice, so the fresh identity is taken only on an explicit re-run
 * of a transcript that already exists.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test, describe } from 'node:test'
import { selectRequestedSections } from '../generators/subtitles.js'

const source = readFileSync(new URL('../generators/subtitles.ts', import.meta.url), 'utf8')

describe('an explicit re-run asks GenStudio again', () => {
  test('force + an existing saved task disables task reuse', () => {
    // Both transcription paths (merged audio and per-chapter) must guard.
    const guards = source.match(/const rerunRequested = req\.force === true && !!savedTask/g) || []
    assert.equal(guards.length, 2, 'both the merged-audio and per-chapter paths must guard re-runs')

    const disabled = source.match(/const reusableTask = !rerunRequested/g) || []
    assert.equal(disabled.length, 2, 'a re-run must not reuse the saved GenStudio task')
  })

  test('a re-run gets an identity GenStudio has not seen', () => {
    // Dropping reusableTask alone is not enough: the idempotency key is rebuilt
    // from the same requestIdentity, so GenStudio's own server-side dedupe
    // would hand back the very artifact we are trying to replace.
    const fresh = source.match(/const freshIdentity = terminalFailure \|\| rerunRequested/g) || []
    assert.equal(fresh.length, 2)
    assert.doesNotMatch(
      source,
      /requestIdentity: terminalFailure \? `\$\{requestIdentity\}:manual-retry/,
      'the key must vary on a re-run too, not on terminal failure alone',
    )
    const keyed = source.match(/requestIdentity: freshIdentity \? `\$\{requestIdentity\}:manual-retry:\$\{job\.job_id\}` : requestIdentity/g) || []
    assert.equal(keyed.length, 2)
  })

  test('the log says a fresh transcription was submitted', () => {
    // A silent behaviour change on a paid call is not auditable.
    assert.match(source, /re-run requested — submitting a fresh transcription instead of reusing the stored result/i)
  })

  test('a first run and an ordinary retry still reconnect rather than re-pay', () => {
    // rerunRequested requires BOTH force and a previously saved task, so a
    // first transcription and a crash-retry keep the original key.
    assert.match(source, /!!savedTask/)
    assert.doesNotMatch(source, /const rerunRequested = req\.force === true\s*$/m)
  })
})

describe('re-transcribing one chapter does not re-charge the episode', () => {
  const sections = [
    { slug: 'Introduction' },
    { slug: 'Chapter_01' },
    { slug: 'Chapter_02' },
    { slug: 'Chapter_03' },
  ]

  test('no list means every chapter, as before', () => {
    assert.deepEqual(selectRequestedSections(sections, undefined), sections)
    assert.deepEqual(selectRequestedSections(sections, []), sections)
  })

  test('a list narrows the run to exactly those chapters', () => {
    const picked = selectRequestedSections(sections, ['Chapter_02'])
    assert.deepEqual(picked.map(s => s.slug), ['Chapter_02'])
  })

  test('several chapters can be named at once', () => {
    const picked = selectRequestedSections(sections, ['Introduction', 'Chapter_03'])
    assert.deepEqual(picked.map(s => s.slug), ['Introduction', 'Chapter_03'])
  })

  test('matching is case-insensitive and tolerates stray whitespace', () => {
    const picked = selectRequestedSections(sections, ['  chapter_01  '])
    assert.deepEqual(picked.map(s => s.slug), ['Chapter_01'])
  })

  test('a list that matches nothing throws instead of silently running everything', () => {
    // The failure mode this guards: asking for one chapter and being billed for
    // thirteen because a slug was wrong.
    assert.throws(
      () => selectRequestedSections(sections, ['Chapter_99']),
      /None of the requested chapters have audio: chapter_99/,
    )
    assert.throws(() => selectRequestedSections(sections, ['Chapter_99']), /Available: .*Chapter_03/)
  })

  test('empty and blank entries are ignored rather than matching nothing', () => {
    assert.deepEqual(selectRequestedSections(sections, ['', '   ']), sections)
  })
})
