/**
 * Tests for formatConcatFileLine — the helper that formats a single
 * `file '<path>'` line for an FFmpeg concat-demuxer list.
 *
 * The demuxer reads its list file line-by-line, so a filename containing
 * a literal newline / CR / NUL byte would escape the `file '...'` envelope
 * and inject a new directive on the next parsed line. Those bytes are
 * valid in POSIX filenames (AI-suggested names, bulk-rename scripts, and
 * copy-paste-from-editor flows can produce them), so this is a robustness
 * bug worth catching explicitly rather than silently stripping.
 *
 * Pinned invariants:
 *   - The single-quote escape is preserved (`foo's song` → `foo'\''s song`).
 *   - Newline / CR / NUL in the path throws, with the bad bytes visible in
 *     the message via JSON.stringify so log viewers don't eat them.
 *   - Normal paths pass through unchanged.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { formatConcatFileLine } from '../lib/ffmpeg-utils.js'

describe('formatConcatFileLine', () => {
  test('wraps a plain path in file \'...\'', () => {
    assert.equal(
      formatConcatFileLine('/tmp/chapter_01.mp3'),
      "file '/tmp/chapter_01.mp3'",
    )
  })

  test('escapes single quotes with the lenient \'\\\'\' form', () => {
    assert.equal(
      formatConcatFileLine("/tmp/foo's song.mp3"),
      "file '/tmp/foo'\\''s song.mp3'",
    )
  })

  test('throws on paths containing a newline', () => {
    assert.throws(
      () => formatConcatFileLine('/tmp/bad\nfile.mp3'),
      (err: Error) => {
        assert.match(err.message, /newline/)
        // JSON.stringify renders \n visibly rather than dropping it
        assert.match(err.message, /\\n/)
        return true
      },
    )
  })

  test('throws on paths containing a carriage return', () => {
    assert.throws(
      () => formatConcatFileLine('/tmp/bad\rfile.mp3'),
      /newline\/CR\/NUL/,
    )
  })

  test('throws on paths containing a NUL byte', () => {
    assert.throws(
      () => formatConcatFileLine('/tmp/bad\0file.mp3'),
      /newline\/CR\/NUL/,
    )
  })
})
