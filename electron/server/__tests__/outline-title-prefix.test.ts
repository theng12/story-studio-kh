/**
 * A model-written outline title must not repeat the heading the app composes.
 *
 * 2026-10-30 (Khmer repair): Haiku returned titles like "Chapter 1 The Fall", so
 * the assembled heading read "## Chapter 01: Chapter 1 The Fall". Only a leading
 * section-label + number is stripped, at parse time; the rest of the title is kept
 * verbatim, a title without the prefix is untouched, and Khmer prose is never
 * mangled (a label word with no numeral is not a prefix, and Khmer numerals count).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { stripOutlineTitlePrefix } from '../lib/chunked-narration.js'

test('a leading "Chapter N" prefix is stripped, in every spelling', () => {
  assert.equal(stripOutlineTitlePrefix('Chapter 1 The Fall'), 'The Fall')
  assert.equal(stripOutlineTitlePrefix('Chapter 01: The Fall'), 'The Fall')
  assert.equal(stripOutlineTitlePrefix('chapter 7 - The Fall'), 'The Fall')
  assert.equal(stripOutlineTitlePrefix('CHAPTER 12 — The Fall'), 'The Fall')
  assert.equal(stripOutlineTitlePrefix('Chapter 3. The Fall'), 'The Fall')
  assert.equal(stripOutlineTitlePrefix('  Chapter 2:  The Fall  '), 'The Fall')
})

test('a format-specific label is stripped only when it is the label given', () => {
  assert.equal(stripOutlineTitlePrefix('Topic 3: Why Bridges Fall', 'Topic'), 'Why Bridges Fall')
  assert.equal(stripOutlineTitlePrefix('Reason 4 - Money', 'Reason'), 'Money')
  // The default is the generic word; a different label is not guessed at.
  assert.equal(stripOutlineTitlePrefix('Topic 3: Why Bridges Fall'), 'Topic 3: Why Bridges Fall')
})

test('a title without the prefix is left alone', () => {
  assert.equal(stripOutlineTitlePrefix('The Fall of Chapter 1'), 'The Fall of Chapter 1')
  assert.equal(stripOutlineTitlePrefix('Chapter One: The Beginning'), 'Chapter One: The Beginning')
  assert.equal(stripOutlineTitlePrefix('Chapter 1'), 'Chapter 1', 'nothing would be left, so nothing is removed')
  assert.equal(stripOutlineTitlePrefix('A Chapter in Time'), 'A Chapter in Time')
})

test('Khmer labels and Khmer numerals are handled without mangling Khmer prose', () => {
  assert.equal(stripOutlineTitlePrefix('ជំពូក ១៖ ការចាប់ផ្តើម'), 'ការចាប់ផ្តើម')
  assert.equal(stripOutlineTitlePrefix('ជំពូក 2: ការបន្ត'), 'ការបន្ត')
  assert.equal(stripOutlineTitlePrefix('ភាគ ៣ - ការបញ្ចប់'), 'ការបញ្ចប់')
  // A Khmer word with no numeral is prose, not a prefix.
  assert.equal(stripOutlineTitlePrefix('ជំពូកដំបូងនៃប្រវត្តិសាស្ត្រ'), 'ជំពូកដំបូងនៃប្រវត្តិសាស្ត្រ')
  assert.equal(stripOutlineTitlePrefix('ភាគដំបូង នៃរឿង'), 'ភាគដំបូង នៃរឿង')
  // A Khmer title that merely mentions the word later is untouched.
  assert.equal(stripOutlineTitlePrefix('រឿងជំពូក ១'), 'រឿងជំពូក ១')
})
