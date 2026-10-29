/**
 * The Quote Shorts Formula (owner, 2026-10-27).
 *
 * The owner's channel is a vertical READING: one short reflective passage,
 * narrated, one sentence per picture, captions burned in, music underneath. The
 * honest finding from the audit is that this is the normal episode pipeline at
 * 9:16 with short sentence-scenes — not a new pipeline. So the Formula is where
 * almost all of it lives, and these tests pin the parts that are *rules* rather
 * than prose:
 *
 *   - the channel is vertical, and the shape reaches the one field the pages read
 *   - it is one chapter of roughly a minute, so "one unbroken thought" is what
 *     the writer is asked for
 *   - the hook requirement, the loop ending, and the anti-poster voice rules
 *     actually arrive in the SCRIPT PROMPT (a rule that only exists in the
 *     Formula file and never reaches a prompt is a comment, not a rule)
 *   - the scene rhythm is a STARTING value the owner can change, never a rule
 *
 * The Formula is a built-in niche (`electron/server/niches/quote-shorts.json`),
 * which is how every channel type ships, so the same loader path a customer
 * takes is what these tests exercise.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { useTempDataDir } from './_helpers.js'
import { loadNiche, _clearNicheCaches } from '../services/niche-loader.js'
import { getEffectiveFormatFor } from '../services/format-loader.js'
import { systemPrompt } from '../generators/episode.js'

const project = { slug: 'quote-shorts-test', format_id: 'continuity-chain', niche_id: 'quote-shorts' } as any

/**
 * Resolving a Formula reads the content-pack store, which refuses to touch the
 * developer's real Application Support directory. Claim a temp one first, the
 * same way every other loader test does.
 */
let temp: Awaited<ReturnType<typeof useTempDataDir>>
before(async () => { temp = await useTempDataDir() })
after(async () => { await temp.cleanup() })

async function effective() {
  // The loader caches a built-in niche for the life of the process. Another
  // suite in the same run may have read this file before it was finished, so a
  // stale copy would make every assertion below describe the wrong document —
  // and pass. Clearing is what makes these tests read the file on disk.
  _clearNicheCaches()
  return await getEffectiveFormatFor(project)
}

describe('Quote Shorts — the channel is vertical', () => {
  test('the Formula declares 9:16 and the loader folds it into the one aspect field', async () => {
    _clearNicheCaches()
    const niche = await loadNiche('quote-shorts')
    assert.equal((niche as any)?.aspectRatio, '9:16')
    const format = await effective()
    // Scene Review, the Image Pool and Video Assembly all read THIS field, so a
    // vertical channel renders portrait without a second control to keep in step.
    assert.equal(format.imagePrompts.recommendedAspect, '9:16')
  })

  test('it keeps the live production source the rest of the app expects', async () => {
    const format = await effective()
    assert.equal(format.visualSource, 'continuity-chain')
    assert.equal(format.sceneAlignment, 'sentence', 'one scene per sentence is the whole shape')
  })
})

describe('Quote Shorts — one unbroken thought, not an episode', () => {
  test('one chapter, about a minute', async () => {
    const format = await effective()
    assert.deepEqual(format.script.chapterCountRange, [1, 1])
    assert.deepEqual(format.script.lengthMinutesRange, [1, 1])
    assert.equal(format.script.defaultChapterCount, 1)
  })

  test('the scene rhythm is a starting value the owner can change', async () => {
    const format = await effective()
    const profile = format.script.visualPacingProfile
    assert.ok(profile, 'a Formula ships a starting rhythm')
    // Sentence-scale pictures: a short line is on screen for a few seconds.
    assert.ok(profile!.settled.max_sec <= 6, `settled max ${profile!.settled.max_sec}s stays sentence-scale`)
    assert.ok(profile!.settled.min_sec >= 2, 'and never so fast a caption cannot be read')
  })
})

describe('Quote Shorts — the writing rules reach the script prompt', () => {
  test('the first line is required to be a hook', async () => {
    const prompt = systemPrompt(await effective(), '')
    assert.match(prompt, /FIRST line is the hook/i)
  })

  test('the ending is required to loop back into the first line', async () => {
    const prompt = systemPrompt(await effective(), '')
    assert.match(prompt, /lead back into the first line/i)
  })

  test('the voice rules forbid poster phrasing, by name', async () => {
    const prompt = systemPrompt(await effective(), '')
    // A named list is what makes the rule testable; a vague "avoid clichés"
    // is what the owner has seen ignored.
    for (const banned of ['Good vibes only', 'Believe in yourself', "In today's world"]) {
      assert.ok(prompt.includes(banned), `the prompt names "${banned}" as forbidden`)
    }
    assert.match(prompt, /never write inspirational-poster phrasing/i)
  })

  test('the object-before-feeling and one-sentence-per-picture rules are present', async () => {
    const prompt = systemPrompt(await effective(), '')
    assert.match(prompt, /Name the object before the feeling/i)
    assert.match(prompt, /One sentence becomes one picture/i)
  })

  test('it asks for a Short, not an episode, and names the word count', async () => {
    const prompt = systemPrompt(await effective(), '')
    assert.match(prompt, /This Formula makes a SHORT/i)
    // 1.4.369: length belongs to the episode (a drawn 10–60 s starting range),
    // so the prompt states words at two ends of it instead of a fixed count.
    assert.match(prompt, /each new one starts from this channel's range/i)
    assert.match(prompt, /20 words for a 10-second Short and 90 words for a 45-second one/i)
  })
})

describe('Quote Shorts — the document itself is well formed', () => {
  test('every required built-in field is present and non-empty', async () => {
    const raw = JSON.parse(await readFile(new URL('../niches/quote-shorts.json', import.meta.url), 'utf8'))
    for (const key of ['id', 'name', 'description', 'perspectivePolicy', 'scriptSystemPromptRole']) {
      assert.ok(typeof raw[key] === 'string' && raw[key].trim(), `${key} is a non-empty string`)
    }
    assert.equal(raw.schemaVersion, 1)
    assert.ok(Array.isArray(raw.exampleTopics) && raw.exampleTopics.length >= 6)
    assert.ok(Array.isArray(raw.narratorStyles) && raw.narratorStyles.length >= 1)
    assert.ok(raw.narratorStyles.some((s: any) => s.id === raw.defaultNarratorStyleId))
  })

  test('its example topics are moments, not advice', async () => {
    const raw = JSON.parse(await readFile(new URL('../niches/quote-shorts.json', import.meta.url), 'utf8'))
    for (const topic of raw.exampleTopics as string[]) {
      assert.ok(!/^how to\b/i.test(topic), `"${topic}" is a how-to, not a moment`)
      assert.ok(!/\?$/.test(topic), `"${topic}" is a question, which the Formula forbids`)
    }
  })
})
