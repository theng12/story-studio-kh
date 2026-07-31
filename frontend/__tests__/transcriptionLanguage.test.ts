/**
 * The transcription language control.
 *
 * THE DECISION THIS ENCODES: Story Studio's content is English **for now** —
 * the owner's words were "it's only english only for now. i might change my
 * mind tomorrow and support 20 more languages." So English is a DEFAULT and
 * nowhere a hardcode, and the control is built so that adding languages later
 * is a dropdown change rather than an engineering project.
 *
 * THE THREE STATES, WHICH MUST NOT COLLAPSE INTO EACH OTHER:
 *   - the model published a list          → a real picker
 *   - the model published "multilingual"  → auto-detect + UNVALIDATED free entry
 *   - the model published nothing at all  → same controls, different words
 * plus auto-detect, which is a deliberate choice and not any of the above.
 *
 * ZERO paid calls: every model below is a hand-written catalogue fixture.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  AUTO_DETECT_LANGUAGE,
  DEFAULT_TRANSCRIPTION_LANGUAGE,
  defaultTranscriptionLanguage,
  isTranscriptionLanguageUsable,
  publishedTranscriptionLanguages,
  transcriptionLanguageControl,
  transcriptionLanguageRequestFields,
} from '../utils/transcription-language'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

/** What GenStudio publishes today: one sentinel string, no list. */
const UNENUMERATED = { language: 'multilingual', supported_languages: [] }
/** What GenStudio publishes when it has said nothing at all. */
const UNPUBLISHED = { language: '', supported_languages: [] }
/** What the open handoff ask would produce once answered. */
const PUBLISHED = {
  language: 'multilingual',
  supported_languages: ['en', 'km', 'th', 'fr'],
  supports_language_auto_detect: true,
}

// ── A published list renders as a real picker ──────────────────────────────

test('a published list becomes the picker, with no release needed', () => {
  const control = transcriptionLanguageControl(PUBLISHED)
  assert.equal(control.mode, 'published')
  assert.deepEqual(control.options.map(o => o.value), [AUTO_DETECT_LANGUAGE, 'en', 'km', 'th', 'fr'])
  assert.equal(control.options[0]!.label, 'Auto-detect')
  assert.equal(control.autoDetectPublished, true)
})

test('a single concrete published language IS a list of one', () => {
  const control = transcriptionLanguageControl({ language: 'en' })
  assert.equal(control.mode, 'published')
  assert.deepEqual(control.options.map(o => o.value), [AUTO_DETECT_LANGUAGE, 'en'])
  assert.equal(control.allowsFreeEntry, false)
  assert.deepEqual(publishedTranscriptionLanguages({ language: 'en' }), ['en'])
})

test('sentinels are not mistaken for language codes', () => {
  for (const sentinel of ['multilingual', 'multi', 'auto', 'any', 'MULTILINGUAL']) {
    assert.deepEqual(
      publishedTranscriptionLanguages({ language: sentinel }),
      [],
      `"${sentinel}" was treated as a real language code`,
    )
  }
})

// ── Free entry appears only when nothing enumerable was published ──────────

test('free entry appears ONLY when no list is published, and vanishes when one is', () => {
  assert.equal(transcriptionLanguageControl(UNENUMERATED).allowsFreeEntry, true)
  assert.equal(transcriptionLanguageControl(UNPUBLISHED).allowsFreeEntry, true)
  // The moment GenStudio answers the open ask, the free-entry path disappears
  // on its own — no release, no code change.
  assert.equal(transcriptionLanguageControl(PUBLISHED).allowsFreeEntry, false)
})

test('the page marks the free-entry code as unvalidated in both fallback states', () => {
  const page = source('../pages/projects/[slug]/subtitles.vue')
  const unvalidated = page.match(/not validated/g) || []
  assert.ok(unvalidated.length >= 2, 'the unvalidated free-entry warning is missing a state')
  // And the picker is a real select once a list exists.
  assert.match(page, /v-if="languageControl\.mode === 'published'"/)
  assert.match(page, /v-for="option in languageControl\.options"/)
})

// ── Auto-detect and "nothing published" are different facts ────────────────

test('auto-detect and an unpublished language render differently', () => {
  const unenumerated = transcriptionLanguageControl(UNENUMERATED)
  const unpublished = transcriptionLanguageControl(UNPUBLISHED)
  assert.notEqual(unenumerated.mode, unpublished.mode)
  assert.equal(unenumerated.publishedLanguage, 'multilingual')
  assert.equal(unpublished.publishedLanguage, '')
  // "GenStudio did not say" is not "the model decides".
  assert.equal(unpublished.autoDetectPublished, null)

  const page = source('../pages/projects/[slug]/subtitles.vue')
  assert.match(page, /languageControl\.mode === 'unenumerated'/)
  assert.match(page, /no language information/)
  assert.match(page, /missing catalogue data, not/)
  // Auto-detect is described as a choice wherever it appears.
  assert.match(page, /Auto-detect<\/strong> sends no language/)
})

test('an unpublished language is never backfilled with a sentinel or a code', () => {
  // The backend used to default an absent `language` to "multilingual", which
  // made a gap in the catalogue look like a published capability.
  const client = source('../../electron/server/lib/genstudio-client.ts')
  assert.match(client, /language: typeof value\?\.language === 'string' \? value\.language\.trim\(\) : ''/)
  assert.doesNotMatch(client, /value\.language\.trim\(\) : 'multilingual'/)
})

// ── Auto-detect is implemented by omission ─────────────────────────────────

test('auto-detect omits the language field entirely', () => {
  assert.deepEqual(transcriptionLanguageRequestFields(AUTO_DETECT_LANGUAGE), {})
  assert.deepEqual(transcriptionLanguageRequestFields(''), {})
  assert.deepEqual(transcriptionLanguageRequestFields('   '), {})
  // There is no "auto" value on the wire.
  assert.equal('language' in transcriptionLanguageRequestFields(AUTO_DETECT_LANGUAGE), false)
})

test('any other choice is sent verbatim', () => {
  assert.deepEqual(transcriptionLanguageRequestFields('en'), { language: 'en' })
  assert.deepEqual(transcriptionLanguageRequestFields(' km '), { language: 'km' })
})

test('the page sends the field through that one function and no other path', () => {
  const page = source('../pages/projects/[slug]/subtitles.vue')
  assert.match(page, /\.\.\.transcriptionLanguageRequestFields\(language\.value\)/)
  assert.doesNotMatch(page, /language: 'en'/, "a hardcoded 'en' reached the request")
})

// ── English is a default, not a hardcode ───────────────────────────────────

test('English is the default, because that is the content today', () => {
  assert.equal(DEFAULT_TRANSCRIPTION_LANGUAGE, 'en')
  assert.equal(defaultTranscriptionLanguage(PUBLISHED), 'en')
  assert.equal(defaultTranscriptionLanguage(UNENUMERATED), 'en')
  assert.equal(defaultTranscriptionLanguage(UNPUBLISHED), 'en')
  assert.match(
    source('../pages/projects/[slug]/subtitles.vue'),
    /const language = ref\(DEFAULT_TRANSCRIPTION_LANGUAGE\)/,
  )
})

test('the default is overridable everywhere it is used', () => {
  // One named constant, injectable — changing the product decision is a
  // one-line change, not a hunt through types and schemas.
  assert.equal(defaultTranscriptionLanguage(PUBLISHED, 'km'), 'km')
  // And never invented: a model that did not publish English falls back to
  // auto-detect rather than sending a code the model never claimed.
  assert.equal(
    defaultTranscriptionLanguage({ language: 'multilingual', supported_languages: ['km', 'th'] }),
    AUTO_DETECT_LANGUAGE,
  )
})

test("no 'en' is baked into a type, a schema, or a non-overridable path", () => {
  const client = source('../../electron/server/lib/genstudio-client.ts')
  assert.doesNotMatch(client, /language\??: string = 'en'/)
  assert.doesNotMatch(client, /language: 'en'/)
  const composable = source('../composables/useGenStudioTranscription.ts')
  assert.doesNotMatch(composable, /'en'/)
  // One named constant is the ONLY executable place the code appears.
  const util = source('../utils/transcription-language.ts')
  const code = util.split('\n').filter(line => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n')
  const occurrences = code.match(/'en'/g) || []
  assert.equal(occurrences.length, 1, `'en' appears ${occurrences.length} times in code; it must appear once`)
  assert.match(code, /export const DEFAULT_TRANSCRIPTION_LANGUAGE = 'en'/)
})

// ── The choice survives a preset and a model switch ────────────────────────

test('the choice round-trips through the subtitles preset', () => {
  const page = source('../pages/projects/[slug]/subtitles.vue')
  assert.match(page, /usePresets<\{ model\?: string; language\?: string; force\?: boolean \}>/)
  assert.match(page, /snapshot: \(\) => \(\{ model: genstudioModel\.value, language: language\.value/)
  assert.match(page, /if \(typeof d\?\.language === 'string' && d\.language\) language\.value = d\.language/)
  // Auto-detect is a real stored value, so "let the model decide" survives a
  // reload as a decision rather than degrading into a blank field.
  assert.deepEqual(transcriptionLanguageRequestFields(AUTO_DETECT_LANGUAGE), {})
  assert.equal(isTranscriptionLanguageUsable(AUTO_DETECT_LANGUAGE, PUBLISHED), true)
  assert.equal(isTranscriptionLanguageUsable(AUTO_DETECT_LANGUAGE, UNPUBLISHED), true)
})

test('a remembered code the new model cannot honour is replaced, not silently sent', () => {
  assert.equal(isTranscriptionLanguageUsable('km', PUBLISHED), true)
  assert.equal(isTranscriptionLanguageUsable('zz', PUBLISHED), false)
  // Nothing published validates nothing, so a typed code survives a switch.
  assert.equal(isTranscriptionLanguageUsable('zz', UNENUMERATED), true)
  assert.equal(isTranscriptionLanguageUsable('', PUBLISHED), false)
  assert.match(
    source('../pages/projects/[slug]/subtitles.vue'),
    /if \(!isTranscriptionLanguageUsable\(language\.value, model\)\)/,
  )
})

// ── The catalogue carries the fields the picker will need ─────────────────

test('the backend carries supported_languages through, empty until published', () => {
  const client = source('../../electron/server/lib/genstudio-client.ts')
  assert.match(client, /supported_languages: Array\.isArray\(value\?\.supported_languages\)/)
  assert.match(client, /supports_language_auto_detect/)
  // Empty means "not published", never "supports nothing".
  assert.deepEqual(publishedTranscriptionLanguages({ language: 'multilingual', supported_languages: [] }), [])
})
