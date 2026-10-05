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

const PUBLISHED_WITHOUT_AUTO_DETECT = {
  language: 'multilingual',
  supported_languages: ['en', 'km'],
  supports_language_auto_detect: false,
}

test('auto-detect is offered only when the selected model explicitly publishes it', () => {
  const control = transcriptionLanguageControl(PUBLISHED_WITHOUT_AUTO_DETECT)
  assert.deepEqual(control.options.map(option => option.value), ['en', 'km'])
  assert.equal(isTranscriptionLanguageUsable(AUTO_DETECT_LANGUAGE, PUBLISHED_WITHOUT_AUTO_DETECT), false)
  assert.throws(
    () => transcriptionLanguageRequestFields(AUTO_DETECT_LANGUAGE, PUBLISHED_WITHOUT_AUTO_DETECT),
    /has not published auto-detect/i,
  )
})

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
  assert.deepEqual(control.options.map(o => o.value), ['en'])
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

test('no unverified free-entry language can reach a transcription request', () => {
  assert.equal(transcriptionLanguageControl(UNENUMERATED).allowsFreeEntry, false)
  assert.equal(transcriptionLanguageControl(UNPUBLISHED).allowsFreeEntry, false)
  const page = source('../pages/projects/[slug]/subtitles.vue')
  assert.doesNotMatch(page, /Language code, e\.g\. en/)
  assert.match(page, /v-if="languageControl\.options\.length"/)
  assert.match(page, /v-for="option in languageControl\.options"/)
})

test('missing language metadata does not masquerade as auto-detect', () => {
  const unenumerated = transcriptionLanguageControl(UNENUMERATED)
  const unpublished = transcriptionLanguageControl(UNPUBLISHED)
  assert.notEqual(unenumerated.mode, unpublished.mode)
  assert.equal(unenumerated.publishedLanguage, 'multilingual')
  assert.equal(unpublished.publishedLanguage, '')
  assert.equal(unpublished.autoDetectPublished, null)
  assert.deepEqual(unenumerated.options, [])
  assert.deepEqual(unpublished.options, [])
})

test('an unpublished language is never backfilled with a sentinel or a code', () => {
  // The backend used to default an absent `language` to "multilingual", which
  // made a gap in the catalogue look like a published capability.
  const client = source('../../electron/server/lib/genstudio-client.ts')
  assert.match(client, /language: typeof value\?\.language === 'string' \? value\.language\.trim\(\) : ''/)
  assert.doesNotMatch(client, /value\.language\.trim\(\) : 'multilingual'/)
})

// ── Auto-detect is implemented by omission ─────────────────────────────────

test('published auto-detect omits the language field entirely', () => {
  assert.deepEqual(transcriptionLanguageRequestFields(AUTO_DETECT_LANGUAGE, PUBLISHED), {})
  assert.deepEqual(transcriptionLanguageRequestFields('', PUBLISHED), {})
  assert.deepEqual(transcriptionLanguageRequestFields('   ', PUBLISHED), {})
  // There is no "auto" value on the wire.
  assert.equal('language' in transcriptionLanguageRequestFields(AUTO_DETECT_LANGUAGE, PUBLISHED), false)
})

test('only a published language is sent', () => {
  assert.deepEqual(transcriptionLanguageRequestFields('en', PUBLISHED), { language: 'en' })
  assert.deepEqual(transcriptionLanguageRequestFields(' km ', PUBLISHED), { language: 'km' })
  assert.throws(() => transcriptionLanguageRequestFields('zz', PUBLISHED), /does not publish zz/i)
})

test('the page sends the field through that one function and no other path', () => {
  const page = source('../pages/projects/[slug]/subtitles.vue')
  assert.match(page, /\.\.\.transcriptionLanguageRequestFields\(language\.value, genstudioSelectedModel\.value\)/)
  assert.doesNotMatch(page, /language: 'en'/, "a hardcoded 'en' reached the request")
})

test('B-Roll uses the same published-language request contract', () => {
  const page = source('../pages/projects/[slug]/broll.vue')
  assert.match(page, /\.\.\.transcriptionLanguageRequestFields\(form\.transcription_language, brollGenstudioSelectedModel\.value\)/)
  assert.doesNotMatch(page, /language: 'en'/, "B-Roll must not force English onto a selected model")
  assert.match(page, /isTranscriptionLanguageUsable\(form\.transcription_language, brollGenstudioSelectedModel\.value\)/)
})

// ── English is a default, not a hardcode ───────────────────────────────────

test('English is the default, because that is the content today', () => {
  assert.equal(DEFAULT_TRANSCRIPTION_LANGUAGE, 'en')
  assert.equal(defaultTranscriptionLanguage(PUBLISHED), 'en')
  assert.equal(defaultTranscriptionLanguage(UNENUMERATED), '')
  assert.equal(defaultTranscriptionLanguage(UNPUBLISHED), '')
  assert.match(
    source('../pages/projects/[slug]/subtitles.vue'),
    /const language = ref\(DEFAULT_TRANSCRIPTION_LANGUAGE\)/,
  )
})

test('the default is overridable everywhere it is used', () => {
  // One named constant, injectable — changing the product decision is a
  // one-line change, not a hunt through types and schemas.
  assert.equal(defaultTranscriptionLanguage(PUBLISHED, 'km'), 'km')
  // And never invented: a model that did not publish English uses one of the
  // languages it did publish.
  assert.equal(
    defaultTranscriptionLanguage({ language: 'multilingual', supported_languages: ['km', 'th'] }),
    'km',
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
  assert.match(page, /usePresets<\{ model\?: string; language\?: string; force\?: boolean; method\?: 'script' \}>/)
  assert.match(page, /snapshot: \(\) => \(\{ model: genstudioModel\.value, language: language\.value/)
  assert.match(page, /if \(typeof d\?\.language === 'string' && d\.language\) language\.value = d\.language/)
  assert.deepEqual(transcriptionLanguageRequestFields(AUTO_DETECT_LANGUAGE, PUBLISHED), {})
  assert.equal(isTranscriptionLanguageUsable(AUTO_DETECT_LANGUAGE, PUBLISHED), true)
  assert.equal(isTranscriptionLanguageUsable(AUTO_DETECT_LANGUAGE, UNPUBLISHED), false)
})

test('a remembered code the new model cannot honour is replaced, not silently sent', () => {
  assert.equal(isTranscriptionLanguageUsable('km', PUBLISHED), true)
  assert.equal(isTranscriptionLanguageUsable('zz', PUBLISHED), false)
  assert.equal(isTranscriptionLanguageUsable('zz', UNENUMERATED), false)
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
