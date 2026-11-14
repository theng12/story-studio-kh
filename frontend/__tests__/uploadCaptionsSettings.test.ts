/**
 * Unit tests for UploadCaptionsSettings.vue (Item 17).
 *
 * Verifies:
 * - OFF by default (enabled: false)
 * - Required accessibility attributes and semantic markup
 * - Language selection and custom language code fallback
 * - Deduplication mode options (skip_if_exists default, replace, upload_always)
 * - Subtitle source preference selector
 * - Clean honest status indicators
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const componentSrc = read('../components/UploadCaptionsSettings.vue')

test('UploadCaptionsSettings: starts OFF by default with clear user explanation', () => {
  // Contains data-setting hook for settings identification
  assert.match(componentSrc, /data-setting="upload-captions"/)

  // Eyebrow and heading
  assert.match(componentSrc, /<span class="eyebrow">Optional<\/span>/)
  assert.match(componentSrc, /<h4>Closed captions \(CC\) upload<\/h4>/)

  // Explicitly explains it is OFF by default and does not burn subtitles
  assert.match(componentSrc, /<strong>OFF by default\.<\/strong>/)
  assert.match(componentSrc, /Does not burn subtitles into video pixels/)

  // Toggle switch defaults to disabled/false
  assert.match(componentSrc, /v-model="draft\.enabled"/)
  assert.match(componentSrc, /enabled:\s*props\.modelValue\.enabled === true/)
})

test('UploadCaptionsSettings: provides full accessibility attributes', () => {
  // Check aria-labels on controls
  assert.match(componentSrc, /aria-label="Upload closed captions track"/)
  assert.match(componentSrc, /aria-label="Caption language"/)
  assert.match(componentSrc, /aria-label="Track title"/)
  assert.match(componentSrc, /aria-label="Subtitle source"/)
  assert.match(componentSrc, /aria-label="Deduplication behavior"/)
  assert.match(componentSrc, /role="radiogroup"/)

  // Semantic fieldset and legend for deduplication choices
  assert.match(componentSrc, /<fieldset class="field dedupe-group">/)
  assert.match(componentSrc, /<legend class="field-label">If captions in this language already exist<\/legend>/)
})

test('UploadCaptionsSettings: supports deduplication modes with skip_if_exists as default', () => {
  assert.match(componentSrc, /value="skip_if_exists"/)
  assert.match(componentSrc, /value="replace_existing"/)
  assert.match(componentSrc, /value="upload_always"/)
  assert.match(componentSrc, /dedupe_mode:\s*props\.modelValue\.dedupe_mode \|\| 'skip_if_exists'/)
})

test('UploadCaptionsSettings: supports subtitle source preferences and custom path', () => {
  assert.match(componentSrc, /value="auto"/)
  assert.match(componentSrc, /value="stitched"/)
  assert.match(componentSrc, /value="whisper"/)
  assert.match(componentSrc, /value="custom"/)
  assert.match(componentSrc, /v-if="draft\.preferred_source === 'custom'"/)
  assert.match(componentSrc, /<FilePicker/)
  assert.doesNotMatch(componentSrc, /v-model="draft\.custom_srt_path"/)
  assert.doesNotMatch(componentSrc, /type="text"[^>]*custom_srt_path/)
})

test('UploadCaptionsSettings: reflects honest subtitle availability states', () => {
  assert.match(componentSrc, /hasSubtitles === true/)
  assert.match(componentSrc, /hasSubtitles === false/)
  assert.match(componentSrc, /'Subtitle file available \(\.srt\)'/)
  assert.match(componentSrc, /'No subtitle file found for this episode'/)
  assert.match(componentSrc, /'Subtitle status will be verified at upload time'/)
})
