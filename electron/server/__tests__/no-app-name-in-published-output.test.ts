/**
 * The application must never sign its own name into the customer's product.
 *
 * MEASURED 2026-08-25 on the owner's Night Tales channel. The YouTube
 * Finalizer for DK0052 ("The Girl Who Followed the Hare") saved a v1 whose
 * description read
 *
 *   In this episode of Story Studio, we follow Maren through the familiar
 *   bends of a lane she knows like an old song...
 *
 * and whose hashtag block opened `#StoryStudio #FolkTale #SlowStory`. His
 * channel is "Sleep Story". Story Studio is the tool.
 *
 * No prompt template ever contained that sentence. The model was TOLD the
 * tool's name: `buildNarrationDocx` stamped `Story Studio • Episode {code}`
 * as the second line of every unified narration file, and every story-context
 * reader (`readArtifactRawText`, `narrationDocxToMarkdown`) hands that file
 * to the model verbatim as the episode's own context. The model reasonably
 * read it as the series name.
 *
 * The rule these tests pin: a generation prompt carries the CHANNEL's
 * identity, never the software's — and no generated artifact that reaches
 * the public carries it either. There is no setting for this; it is never
 * wanted.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

import { buildNarrationDocx, buildImagePromptsDocx } from '../lib/docx-builder.js'
import { readArtifactRawText, stripToolIdentityStamp } from '../lib/episode-artifacts.js'
import { narrationDocxToMarkdown } from '../lib/docx-parser.js'
import { buildDescriptionPrompt } from '../lib/metadata-prompt.js'

/** "Story Studio", "StoryStudio", "story-studio", "story_studio", any casing. */
const APP_NAME = /story[\s\-_]*studio/i

const CODE = 'DK0052'
const TITLE = 'The Girl Who Followed the Hare'
const BODY = [
  '# The Girl Who Followed the Hare — Narration',
  '',
  '## Chapter 01: The Lane Behind the Mill',
  '',
  'Maren stepped out of her cottage into the cool morning air.',
].join('\n')

/** A narration file exactly as releases up to v1.4.66 wrote it. */
const LEGACY_STAMPED = `${TITLE}\nStory Studio • Episode ${CODE}\n\n${BODY}\n`

async function tmpFile(name: string, contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-name-leak-'))
  const file = path.join(dir, name)
  await fs.writeFile(file, contents, 'utf8')
  return file
}

describe('the app never names itself in generated artifacts', () => {
  test('the unified narration file carries no application name', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-name-leak-'))
    const out = path.join(dir, `${CODE}_Script_Narration.md`)
    await buildNarrationDocx(BODY, CODE, TITLE, out)
    const written = await fs.readFile(out, 'utf8')

    assert.ok(!APP_NAME.test(written), `narration file names the app:\n${written}`)
    // The episode's own identity is still there — only the tool's is gone.
    assert.ok(written.startsWith(TITLE), 'episode title must survive')
    assert.ok(written.includes(`Episode ${CODE}`), 'episode code must survive')
  })

  test('the image-prompts file carries no application name', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-name-leak-'))
    const out = path.join(dir, `${CODE}_Scene_Prompts.md`)
    await buildImagePromptsDocx('## Scene 1\n\nA hare in a lane.', CODE, TITLE, out)
    const written = await fs.readFile(out, 'utf8')

    assert.ok(!APP_NAME.test(written), `image-prompts file names the app:\n${written}`)
    assert.ok(written.includes(`Episode ${CODE}`), 'episode code must survive')
  })
})

describe('the app never teaches a model its own name', () => {
  test('raw story context drops the legacy stamp and keeps the story', async () => {
    const file = await tmpFile(`${CODE}_Script_Narration.md`, LEGACY_STAMPED)
    const context = await readArtifactRawText(file)

    assert.ok(!APP_NAME.test(context), `story context names the app:\n${context}`)
    assert.ok(context.includes('Maren stepped out of her cottage'), 'story body must survive')
    assert.ok(context.includes(TITLE), 'episode title must survive')
  })

  test('the markdown round-trip drops the legacy stamp', async () => {
    const file = await tmpFile(`${CODE}_Script_Narration.md`, LEGACY_STAMPED)
    const markdown = await narrationDocxToMarkdown(file)

    assert.ok(!APP_NAME.test(markdown), `round-tripped context names the app:\n${markdown}`)
    assert.ok(markdown.includes('## Chapter 01: The Lane Behind the Mill'), 'chapters must survive')
  })

  test('the YouTube description prompt never contains the application name', async () => {
    const file = await tmpFile(`${CODE}_Script_Narration.md`, LEGACY_STAMPED)
    const storyContext = await readArtifactRawText(file)

    const prompt = buildDescriptionPrompt(CODE, TITLE, storyContext, [
      { id: 'hook', label: 'Hook', enabled: true, config: { characters: 220 } },
      { id: 'hashtags', label: 'Hashtags', enabled: true, config: { count: 12 } },
    ], 4000, null)

    // This is the whole defect: the model wrote "In this episode of Story
    // Studio" and "#StoryStudio" because this prompt handed it the name.
    assert.ok(!APP_NAME.test(prompt), `description prompt names the app:\n${prompt}`)
  })

  test('the stamp matcher removes only the stamp line, never prose', () => {
    assert.equal(stripToolIdentityStamp('Story Studio • Episode DK0052'), '')
    assert.equal(stripToolIdentityStamp('*Story Studio • Episode DK0052*'), '')
    assert.equal(stripToolIdentityStamp('Story Studio KH - Episode DK0052'), '')
    // A sentence that merely mentions the words is prose, and prose is data.
    const prose = 'She read the sign: Story Studio was closed for the winter.'
    assert.equal(stripToolIdentityStamp(prose), prose)
  })
})
