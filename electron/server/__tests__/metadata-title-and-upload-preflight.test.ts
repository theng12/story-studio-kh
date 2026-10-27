/**
 * Three metadata defects the all-channel audit found, and the boundaries that
 * now stop them:
 *
 *   A. Pipeline's metadata step dropped the preset's `titleConfig` and
 *      hardcoded the platform, count and length.
 *   B. `prefix + title + suffix` was a bare concatenation: it doubled a suffix
 *      the title already ended with, and let a title past YouTube's limit.
 *   C. An upload could go out with an empty description (the title-only
 *      fallback) and no word that anything was missing.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'

import { resolveStepParams } from '../routes/pipeline.js'
import { composeChannelTitle } from '../lib/title-wrapping.js'
import { assertUploadMetadataComplete } from '../lib/upload-metadata.js'

describe('A: Pipeline forwards the preset title strategy', () => {
  test('count, max length, platform, mode, prefix, suffix and manual title all reach the generator', () => {
    const preset = {
      data: {
        sections: [{ id: 'hook' }],
        model: 'magpie::group/story-llm-free',
        titleConfig: {
          preset: 'Sleep Channel',
          maxLength: 70,
          count: 3,
          includeScriptContext: true,
          mode: 'use_idea_title',
          prefix: 'A World Before Us — ',
          suffix: ' For Sleep',
          manualTitle: 'A Typed Title',
        },
      },
    } as unknown as Parameters<typeof resolveStepParams>[3]

    const params = resolveStepParams('metadata', 'EP0001', 'The Entire History of China', preset, null)
    assert.equal(params.title_count, 3)
    assert.equal(params.title_max_length, 70)
    assert.equal(params.title_platform_preset, 'Sleep Channel')
    assert.equal(params.title_mode, 'use_idea_title')
    assert.equal(params.title_prefix, 'A World Before Us — ')
    assert.equal(params.title_suffix, ' For Sleep')
    assert.equal(params.manual_title, 'A Typed Title')
    assert.equal(params.model, 'magpie::group/story-llm-free')
  })

  test('an explicit empty prefix/suffix is forwarded, not replaced by a default', () => {
    const preset = {
      data: { sections: [], titleConfig: { mode: 'paraphrase', prefix: '', suffix: '' } },
    } as unknown as Parameters<typeof resolveStepParams>[3]
    const params = resolveStepParams('metadata', 'EP0002', 'Title', preset, null)
    assert.equal(params.title_prefix, '')
    assert.equal(params.title_suffix, '')
    assert.equal(params.title_mode, 'paraphrase')
  })

  test('an older preset with no titleConfig still gets the documented defaults', () => {
    const preset = { data: { sections: [] } } as unknown as Parameters<typeof resolveStepParams>[3]
    const params = resolveStepParams('metadata', 'EP0003', 'Title', preset, null)
    assert.equal(params.title_platform_preset, 'Universal')
    assert.equal(params.title_count, 5)
    assert.equal(params.title_max_length, 100)
    assert.equal('title_mode' in params, false, 'no invented mode — the generator resolves its own')
    assert.equal('title_prefix' in params, false)
    assert.equal('title_suffix' in params, false)
  })
})

describe('B: channel title wrapping is idempotent and refuses over-limit results', () => {
  test('a suffix already on the title is not appended again', () => {
    const once = composeChannelTitle('The Entire History of China', '', ' For Sleep')
    assert.equal(once, 'The Entire History of China For Sleep')
    assert.equal(composeChannelTitle(once, '', ' For Sleep'), once, 'a retry must not double the wording')
  })

  test('the comparison ignores case, spacing and punctuation', () => {
    assert.equal(
      composeChannelTitle('The Entire History of China—for sleep.', '', ' For Sleep'),
      'The Entire History of China—for sleep.',
    )
    assert.equal(
      composeChannelTitle('FOR SLEEP!', '', ' For Sleep'),
      'FOR SLEEP!',
    )
  })

  test('a prefix already on the title is not prepended again', () => {
    const once = composeChannelTitle('China', 'A World Before Us — ')
    assert.equal(once, 'A World Before Us — China')
    assert.equal(composeChannelTitle(once, 'A World Before Us — '), once)
  })

  test('prefix and suffix compose, and a genuinely new suffix still applies', () => {
    assert.equal(
      composeChannelTitle('China', 'A World Before Us — ', ' | A Cozy Sleep Story'),
      'A World Before Us — China | A Cozy Sleep Story',
    )
  })

  test('an over-limit composed title is REFUSED, naming the limit — never truncated', () => {
    const base = 'x'.repeat(100)
    assert.throws(
      () => composeChannelTitle(base, '', ' For Sleep', { context: 'EP0004' }),
      (error: any) => {
        assert.equal([...base].length + ' For Sleep'.length, 110)
        assert.match(error.message, /EP0004's title is 110 characters/)
        assert.match(error.message, /100-character title limit/)
        assert.match(error.message, /did not truncate/)
        assert.equal(error.statusCode, 400)
        return true
      },
    )
  })

  test('pass-through still enforces the limit (YouTube would reject it anyway)', () => {
    assert.equal(composeChannelTitle('A normal title'), 'A normal title')
    assert.throws(() => composeChannelTitle('x'.repeat(101)), /100-character title limit/)
    // Exactly at the limit is allowed.
    assert.equal([...composeChannelTitle('x'.repeat(100))].length, 100)
  })

  test('the metadata and idea-campaign generators use the shared helper, not their own concatenation', async () => {
    const metadata = await fs.readFile(path.join(import.meta.dirname, '..', 'generators', 'metadata.ts'), 'utf-8')
    const campaign = await fs.readFile(path.join(import.meta.dirname, '..', 'generators', 'idea-campaign.ts'), 'utf-8')
    assert.match(metadata, /composeChannelTitle\(s, title_prefix, title_suffix/)
    assert.match(campaign, /composeChannelTitle\(rawTitle, request\.title_prefix/)
    assert.match(campaign, /composeChannelTitle\(countAdjustedTitle, request\.title_prefix/)
    assert.doesNotMatch(campaign, /\$\{request\.title_prefix \|\| ''\}/, 'no bare concatenation remains')
  })
})

describe('C: an upload refuses an empty description instead of publishing a shell', () => {
  test('names the episode and the missing description', () => {
    assert.throws(
      () => assertUploadMetadataComplete({ title: 'A title', description: '' }, 'EP0007'),
      (error: any) => {
        assert.match(error.message, /EP0007 has no description/)
        assert.match(error.message, /nothing was uploaded/)
        assert.match(error.message, /Metadata page/)
        return true
      },
    )
    assert.throws(
      () => assertUploadMetadataComplete({ title: 'A title', description: '   \n  ' }, 'EP0008'),
      /EP0008 has no description/,
    )
  })

  test('names both fields when both are missing', () => {
    assert.throws(
      () => assertUploadMetadataComplete({ title: '', description: '' }, 'EP0009'),
      /EP0009 has no title and description/,
    )
  })

  test('complete metadata passes', () => {
    assert.doesNotThrow(() => assertUploadMetadataComplete({ title: 'A title', description: 'Real prose.' }, 'EP0010'))
  })

  test('the upload generator calls the guard before spending any quota', async () => {
    const generator = await fs.readFile(path.join(import.meta.dirname, '..', 'generators', 'youtube-upload.ts'), 'utf-8')
    const resolveAt = generator.indexOf('const meta = await resolveUploadMetadata({')
    const guardAt = generator.indexOf('assertUploadMetadataComplete(meta, episodeId)')
    assert.ok(resolveAt >= 0, 'the generator resolves metadata')
    assert.ok(guardAt > resolveAt, 'the guard runs after resolution')
    // It must be a THROW, not a safety gate that can be warned away — Pipeline
    // and one-click runs have to fail loudly (§8).
    assert.doesNotMatch(generator.slice(guardAt, guardAt + 200), /stopOrCarryOn|safetyGate/)
  })
})
