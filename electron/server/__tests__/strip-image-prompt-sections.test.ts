import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripImagePromptSections } from '../generators/episode.js'

// v1.0.335 regression — the default production_standards.txt template shipped
// with an "## Image Prompts" section whose example string ("watercolor style,
// soft palette") leaked into chunked-narration chapters as literal thumbnail
// prompts (EP0017/19/23). systemPrompt() now strips image/thumbnail H2
// sections from the standards before folding them into the script-writing
// system prompt. These pin that behaviour.

const STANDARDS = `# Production Standards

## Script / Narration
- Target word count: 5,000-8,000 words per episode
- Maintain a consistent narrative voice throughout

## Image Prompts
- Each prompt should describe a single scene clearly and concisely
- End every prompt with your preferred style tag (e.g., "watercolor style, soft palette")
- Generate 2-3 scene prompts per chapter, plus 3-5 thumbnail prompts

## Audio / Narration
- Maintain consistent pacing across chapters

## YouTube Metadata
- Include relevant keywords in title and description`

test('strips the ## Image Prompts section and its body', () => {
  const out = stripImagePromptSections(STANDARDS)
  assert.ok(!/Image Prompts/i.test(out), 'Image Prompts heading should be gone')
  assert.ok(!/watercolor style, soft palette/i.test(out), 'leaked example tag should be gone')
  assert.ok(!/thumbnail prompts/i.test(out), 'thumbnail-prompt line should be gone')
})

test('keeps the sibling narration / audio / metadata sections', () => {
  const out = stripImagePromptSections(STANDARDS)
  assert.ok(/## Script \/ Narration/.test(out), 'Script section kept')
  assert.ok(/consistent narrative voice/.test(out), 'Script body kept')
  assert.ok(/## Audio \/ Narration/.test(out), 'Audio section kept')
  assert.ok(/consistent pacing/.test(out), 'Audio body kept')
  assert.ok(/## YouTube Metadata/.test(out), 'Metadata section kept')
  assert.ok(/relevant keywords/.test(out), 'Metadata body kept')
})

test('strips a ## Thumbnail Prompts heading too (variant naming)', () => {
  const input = `## Script\n- write well\n\n## Thumbnail Prompts\n- 3-5 thumbnails, bold title\n\n## Audio\n- pace it`
  const out = stripImagePromptSections(input)
  assert.ok(!/Thumbnail Prompts/i.test(out), 'Thumbnail heading gone')
  assert.ok(!/bold title/.test(out), 'Thumbnail body gone')
  assert.ok(/## Script/.test(out) && /## Audio/.test(out), 'siblings kept')
})

test('case-insensitive + handles "image prompt" singular', () => {
  const input = `## image prompt rules\n- whatever\n\n## Narration\n- keep me`
  const out = stripImagePromptSections(input)
  assert.ok(!/image prompt rules/i.test(out), 'singular image-prompt heading gone')
  assert.ok(/## Narration/.test(out) && /keep me/.test(out), 'narration kept')
})

test('no image section → returned essentially unchanged', () => {
  const input = `## Script\n- one\n\n## Audio\n- two`
  const out = stripImagePromptSections(input)
  assert.ok(/## Script/.test(out) && /## Audio/.test(out))
  assert.ok(/one/.test(out) && /two/.test(out))
})

test('empty / whitespace input is passed through untouched', () => {
  assert.equal(stripImagePromptSections(''), '')
  assert.equal(stripImagePromptSections('   '), '   ')
})

test('does not over-collapse — no runs of 3+ newlines remain', () => {
  const out = stripImagePromptSections(STANDARDS)
  assert.ok(!/\n{3,}/.test(out), 'blank-line runs collapsed to at most 2')
})

test('a trailing image section (last in file) is fully removed', () => {
  const input = `## Narration\n- keep me\n\n## Image Prompts\n- drop me\n- and me`
  const out = stripImagePromptSections(input)
  assert.ok(/keep me/.test(out), 'narration kept')
  assert.ok(!/drop me/.test(out) && !/and me/.test(out), 'trailing image body fully removed')
})
