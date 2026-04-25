/**
 * Sanitization for YouTube upload metadata. `snippetFromMeta` is the single
 * chokepoint before LLM-produced title/description/tags hit the YouTube
 * Data API. These tests pin the defensive behavior documented in
 * audit-reports/06-providers.md §H3 — a compromised or misbehaving provider
 * can't smuggle control chars, promotional URLs, or oversize payloads past
 * this function.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { snippetFromMeta, __sanitize } from '../lib/upload-metadata.js'

const { stripControl, capLength, stripUrlsFromTitle, cleanTags } = __sanitize

describe('stripControl', () => {
  test('removes ASCII control chars but keeps \\n and \\t', () => {
    const input = 'hello\x00world\x01\x02\tkeep\nnewline\x1ftail'
    assert.equal(stripControl(input), 'helloworld\tkeep\nnewlinetail')
  })
  test('strips DEL (0x7f)', () => {
    assert.equal(stripControl('a\x7fb'), 'ab')
  })
  test('passes printable UTF-8 through', () => {
    assert.equal(stripControl('café — naïve 日本語'), 'café — naïve 日本語')
  })
})

describe('capLength', () => {
  test('no-op when within limit', () => {
    const logs: string[] = []
    assert.equal(capLength('short', 100, 'title', logs), 'short')
    assert.deepEqual(logs, [])
  })
  test('truncates with ellipsis and logs original length', () => {
    const logs: string[] = []
    const out = capLength('a'.repeat(120), 100, 'title', logs)
    assert.equal(out.length, 100)
    assert.ok(out.endsWith('…'))
    assert.deepEqual(logs, ['title truncated 120 → 100 chars'])
  })
  test('works without a logs array', () => {
    const out = capLength('x'.repeat(10), 5, 'desc')
    assert.equal(out.length, 5)
    assert.ok(out.endsWith('…'))
  })
})

describe('stripUrlsFromTitle', () => {
  test('strips http URL and warns', () => {
    const logs: string[] = []
    const out = stripUrlsFromTitle('Check out http://evil.example/x', logs)
    assert.equal(out, 'Check out')
    assert.equal(logs.length, 1)
    assert.ok(logs[0].includes('URL stripped'))
  })
  test('strips https URL and collapses whitespace', () => {
    const logs: string[] = []
    const out = stripUrlsFromTitle('prefix https://a.test/path?q=1 suffix', logs)
    assert.equal(out, 'prefix suffix')
    assert.equal(logs.length, 1)
  })
  test('no-op + no log on clean input', () => {
    const logs: string[] = []
    const out = stripUrlsFromTitle('ordinary title text', logs)
    assert.equal(out, 'ordinary title text')
    assert.deepEqual(logs, [])
  })
})

describe('cleanTags', () => {
  test('trims, drops empty, dedupes case-insensitively', () => {
    const logs: string[] = []
    const out = cleanTags(['  sleep ', 'Sleep', 'stories', '', '   ', 'STORIES'], logs)
    assert.deepEqual(out, ['sleep', 'stories'])
    assert.equal(logs.length, 1)
    assert.ok(logs[0].includes('dedupe'))
  })
  test('caps per-tag length at 30 chars', () => {
    const long = 'a'.repeat(50)
    const out = cleanTags([long])
    assert.equal(out[0].length, 30)
  })
  test('caps tag count at 15', () => {
    const tags = Array.from({ length: 25 }, (_, i) => `tag${i}`)
    const out = cleanTags(tags)
    assert.equal(out.length, 15)
  })
  test('caps total string length at 500 chars (budget-aware)', () => {
    // 25-char tag + 2-char overhead = 27 per tag; fits 18 but we also cap
    // at MAX_TAGS=15. Build a deliberately oversized set to confirm the
    // budget guard stops us before 500 chars are assembled.
    const big = Array.from({ length: 30 }, (_, i) => `${'x'.repeat(25)}${i}`)
    const out = cleanTags(big)
    const total = out.reduce((n, t) => n + t.length + (t.includes(' ') ? 4 : 2), 0)
    assert.ok(total <= 500, `total length ${total} should be ≤ 500`)
  })
  test('drops non-string entries', () => {
    const out = cleanTags(['ok', null as any, 42 as any, 'fine'])
    assert.deepEqual(out, ['ok', 'fine'])
  })
  test('strips control chars inside tags', () => {
    const out = cleanTags(['clean\x00tag'])
    assert.deepEqual(out, ['cleantag'])
  })
})

describe('snippetFromMeta — integration', () => {
  test('clean input passes through unchanged', () => {
    const logs: string[] = []
    const out = snippetFromMeta({
      title: 'A Sleep Story About the Ocean',
      description: 'Drift off to the sound of gentle waves.',
      tags: ['sleep', 'ocean', 'relax'],
      thumbnailPath: '',
    }, logs)
    assert.equal(out.title, 'A Sleep Story About the Ocean')
    assert.equal(out.description, 'Drift off to the sound of gentle waves.')
    assert.deepEqual(out.tags, ['sleep', 'ocean', 'relax'])
    assert.equal(out.categoryId, '22')
    assert.deepEqual(logs, [])
  })

  test('hostile input: newline + URL in title, null byte + oversize description, duplicate/oversize tags', () => {
    const logs: string[] = []
    const out = snippetFromMeta({
      title: 'Buy Now\nhttps://promo.evil/xx <spoof>',
      description: 'legit story\x00\x01 content\n' + 'x'.repeat(6000),
      tags: ['Sleep', ' sleep ', 'a'.repeat(100), '', 'nature', 'NATURE', 'quiet'],
      thumbnailPath: '',
    }, logs)

    // Title: URL stripped, <> stripped, null-byte/control chars gone, trimmed.
    assert.ok(!out.title.includes('http'), 'URL should be stripped')
    assert.ok(!out.title.includes('<'), '< should be stripped')
    assert.ok(!out.title.includes('>'), '> should be stripped')
    assert.ok(!out.title.includes('\x00'), 'null byte should be stripped')
    assert.ok(out.title.length <= 100, 'title within 100 chars')

    // Description: null byte gone, truncated to 5000 chars.
    assert.ok(out.description && !out.description.includes('\x00'), 'null byte stripped from description')
    assert.equal(out.description!.length, 5000, 'description capped to 5000 chars')
    assert.ok(out.description!.endsWith('…'), 'description ends with ellipsis')

    // Tags: deduped, per-tag capped, 100-char tag trimmed to 30.
    assert.ok(out.tags!.every(t => t.length <= 30), 'per-tag length ≤ 30')
    const seenLower = new Set(out.tags!.map(t => t.toLowerCase()))
    assert.equal(seenLower.size, out.tags!.length, 'tags are unique case-insensitively')

    // Logs: at least URL warning, description truncation warning.
    const joined = logs.join('\n')
    assert.ok(joined.includes('URL stripped'), 'URL warning logged')
    assert.ok(joined.includes('description truncated'), 'description truncation logged')
  })

  test('logs parameter is optional — sanitization still runs', () => {
    const out = snippetFromMeta({
      title: 'check http://x.test now',
      description: 'ok',
      tags: [],
      thumbnailPath: '',
    })
    assert.ok(!out.title.includes('http'))
  })

  test('preserves VideoSnippet shape with categoryId default', () => {
    const out = snippetFromMeta({ title: 't', description: 'd', tags: ['a'], thumbnailPath: '' })
    assert.equal(out.categoryId, '22')
    assert.equal(typeof out.title, 'string')
    assert.equal(typeof out.description, 'string')
    assert.ok(Array.isArray(out.tags))
  })
})
