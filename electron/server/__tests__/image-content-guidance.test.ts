/**
 * Tests for the shared image-prompt content guidance (lib/image-content-guidance.ts).
 *
 * Two things are being locked down:
 *
 *   1. The guidance says the substantive things it must say — aftermath over
 *      act, no explicit age markers, period-illustration framing, suffering via
 *      environment/posture, clothed period dress, medical via diagrams — AND
 *      that the historical substance must be preserved. Without that last
 *      clause the guidance blands the output, which is a worse failure than a
 *      provider refusal.
 *
 *   2. It lives in ONE place. Every path that asks an LLM to write an image
 *      prompt imports this module; none of them restates the paragraph. The
 *      test greps the real source files so a future copy-paste fails here.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  IMAGE_CONTENT_GUIDANCE,
  IMAGE_PROMPT_REWORD_DIRECTIVE,
  imageContentGuidanceBlock,
  imagePromptGuidanceBlock,
} from '../lib/image-content-guidance.js'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Every file expected to consume the shared guidance rather than restate it. */
const CONSUMERS = [
  'services/scene-planner.ts',
  'generators/scene-plan.ts',
  'generators/prompt-director.ts',
  'generators/image-prompts.ts',
  'routes/image-prompts-edit.ts',
]

describe('image content guidance — substance', () => {
  test('covers every steering rule the channel needs', () => {
    const text = IMAGE_CONTENT_GUIDANCE.toLowerCase()
    assert.match(text, /aftermath/, 'must steer toward the aftermath rather than the act')
    assert.match(text, /consequence/, 'must name the consequence as an alternative to the act')
    assert.match(text, /age marker/, 'must forbid explicit age markers on figures')
    assert.match(text, /period illustration/, 'must prefer period-illustration framing')
    assert.match(text, /photorealism/, 'must name photorealism as the thing to avoid for hard subjects')
    assert.match(text, /posture/, 'must convey suffering through posture')
    assert.match(text, /environment/, 'must convey suffering through environment')
    assert.match(text, /no wounds, no blood/, 'must rule out injury detail explicitly')
    assert.match(text, /period-accurate clothing/, 'must prefer clothed, formal period dress')
    assert.match(text, /nude/, 'must cover the nude-source-artwork case')
    assert.match(text, /apothecary|physician|instruments/, 'must redirect medical subjects to period settings')
  })

  test('explicitly protects the historical substance from being blanded away', () => {
    const text = IMAGE_CONTENT_GUIDANCE.toLowerCase()
    assert.match(
      text,
      /do not sanitise the era/,
      'the guidance must forbid sanitising the era, not just list safer phrasings',
    )
    assert.match(
      text,
      /the historical substance, the era, and the specificity must be preserved/,
      'the guidance must close by insisting the substance survives',
    )
    assert.match(text, /vivid, specific, and historically substantial/, 'must demand vivid, specific prompts')
  })

  test('the reword directive asks for a different angle, not a blander scene', () => {
    const text = IMAGE_PROMPT_REWORD_DIRECTIVE.toLowerCase()
    assert.match(text, /same narrative beat/, 'must keep the beat')
    assert.match(text, /another (moment|vantage)/, 'must ask for a genuinely different angle')
    assert.match(
      text,
      /do not retreat to a vaguer, emptier, or more generic scene/,
      'must forbid retreating to a blander scene',
    )
  })
})

describe('image content guidance — wiring', () => {
  test('the block helpers compose guidance and reword steering', () => {
    assert.equal(imageContentGuidanceBlock(false), '', 'opt-out yields nothing')
    assert.ok(imageContentGuidanceBlock().includes(IMAGE_CONTENT_GUIDANCE))

    const plain = imagePromptGuidanceBlock()
    assert.ok(plain.includes(IMAGE_CONTENT_GUIDANCE))
    assert.ok(!plain.includes(IMAGE_PROMPT_REWORD_DIRECTIVE), 'no reword steering unless asked for')

    const reworded = imagePromptGuidanceBlock({ reword: true })
    assert.ok(reworded.includes(IMAGE_CONTENT_GUIDANCE), 'a reword still carries the full guidance')
    assert.ok(reworded.includes(IMAGE_PROMPT_REWORD_DIRECTIVE))
  })

  test('every image-prompt writer imports the shared guidance', async () => {
    for (const rel of CONSUMERS) {
      const src = await fs.readFile(path.join(serverRoot, rel), 'utf-8')
      assert.match(
        src,
        /from '[^']*image-content-guidance\.js'/,
        `${rel} must import the shared guidance module`,
      )
      assert.match(
        src,
        /imagePromptGuidanceBlock\(/,
        `${rel} must actually splice the guidance into its prompt`,
      )
    }
  })

  test('no file restates the guidance instead of importing it', async () => {
    // A distinctive sentence from the guidance. If it appears anywhere outside
    // the shared module, someone pasted the paragraph rather than importing it.
    const fingerprint = 'abandoned shields in the churned mud'
    for (const rel of CONSUMERS) {
      const src = await fs.readFile(path.join(serverRoot, rel), 'utf-8')
      assert.ok(
        !src.includes(fingerprint),
        `${rel} restates the guidance text — import it from lib/image-content-guidance.ts instead`,
      )
    }
  })

  test('motion prompts are deliberately left out', async () => {
    // Motion prompts animate an already-approved still and introduce no
    // subject matter of their own, so they must not carry the guidance.
    const src = await fs.readFile(path.join(serverRoot, 'generators/scene-plan.ts'), 'utf-8')
    assert.match(
      src,
      /isMotion \? '' : imagePromptGuidanceBlock\(\)/,
      'the packed writer must gate the guidance on the visual (not motion) stage',
    )
  })

  test('the reword path is manual only — nothing infers a content refusal', async () => {
    const route = await fs.readFile(path.join(serverRoot, 'routes/scene-plan.ts'), 'utf-8')
    assert.match(route, /body\.reword_prompt === true/, 'reword comes from an explicit request flag')
    // No error-text pattern matching anywhere in the reword path.
    const guidance = await fs.readFile(path.join(serverRoot, 'lib/image-content-guidance.ts'), 'utf-8')
    assert.ok(
      !/content[_ ]?refus/i.test(IMAGE_CONTENT_GUIDANCE + IMAGE_PROMPT_REWORD_DIRECTIVE),
      'the prompt text must not discuss refusal codes',
    )
    assert.match(
      guidance,
      /content_refused/,
      'the module must document the pending GenStudio code so wiring it later is obvious',
    )
  })
})
