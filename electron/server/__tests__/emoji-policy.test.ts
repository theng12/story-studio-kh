/**
 * The house rule about emoji (v1.4.12).
 *
 * *"about the emojis. i think to make sure we don't generate emojis when we
 * don't have to. it's unprofessional"*
 *
 * The mechanics of REMOVING an emoji safely are tested in
 * well-formed-text.test.ts, next to the surrogate tests they belong with. What
 * is tested here is the POLICY: when it applies, when it must not, and that the
 * places which write his published text actually consult it.
 *
 * Three things could go wrong, in descending order of how annoyed he would be:
 *
 *   1. Stripping an emoji HE typed. His script, his title, his niche rules.
 *   2. Stripping the prayer channel's 🙏 — `niches/prayer.json` asks for
 *      exactly one, deliberately, and that is an owner decision written down.
 *   3. Stripping a description he has already edited, because the strip ran on
 *      the assembled field instead of on the generated block.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { useTempDataDir } from './_helpers.js'

let policy: typeof import('../lib/emoji-policy.js')
let settings: typeof import('../services/app-settings.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => fs.readFile(path.join(serverRoot, rel), 'utf-8')

before(async () => {
  policy = await import('../lib/emoji-policy.js')
  settings = await import('../services/app-settings.js')
})
beforeEach(async () => {
  await tmp?.cleanup()
  tmp = await useTempDataDir()
})
after(async () => { await tmp?.cleanup() })

const BRAIN = '\u{1F9E0}'
const PRAY = '\u{1F64F}'

describe('the policy, and the switch that governs it', () => {
  test('off by default — he does not have to go and turn it on', async () => {
    assert.equal(await policy.emojiAllowed(), false)
    assert.equal(await policy.applyEmojiPolicy(`Ancient Rome ${BRAIN}`), 'Ancient Rome')
    assert.match(await policy.noEmojiDirective(), /Do not use emoji/)
  })

  test('turning it on stops both layers, not just one', async () => {
    await settings.setAppSetting(policy.EMOJI_SETTING_KEY, true)
    assert.equal(await policy.emojiAllowed(), true)
    assert.equal(await policy.applyEmojiPolicy(`Ancient Rome ${BRAIN}`), `Ancient Rome ${BRAIN}`)
    assert.equal(
      await policy.noEmojiDirective(),
      '',
      'the prompt instruction must go too — leaving it in would tell the model one thing and the setting another',
    )
    await settings.setAppSetting(policy.EMOJI_SETTING_KEY, false)
    assert.equal(await policy.applyEmojiPolicy(`Ancient Rome ${BRAIN}`), 'Ancient Rome')
  })

  test('a list is cleaned item by item', async () => {
    assert.deepEqual(
      await policy.applyEmojiPolicyToAll([`roman history ${BRAIN}`, 'ancient rome', `${BRAIN}`]),
      ['roman history', 'ancient rome', ''],
    )
  })
})

describe('his own emoji are his', () => {
  test('one emoji anywhere in the source text and nothing is cleaned', async () => {
    const generated = `Ten Quiet Places ${BRAIN}`
    assert.equal(
      await policy.applyEmojiPolicy(generated, [`My script ${BRAIN} as I wrote it`]),
      generated,
    )
    assert.equal(await policy.applyEmojiPolicy(generated, ['My script as I wrote it']), 'Ten Quiet Places')
  })

  test('the prayer channel’s deliberate 🙏 survives', async () => {
    // niches/prayer.json asks for EXACTLY ONE 🙏 at the start of the CTA
    // paragraph. That is a decision he wrote down, and it reaches the model
    // inside the description prompt — so the prompt is the source that
    // protects it. Read the real niche file rather than a stand-in: if the
    // rule is ever reworded, this test must still be testing the real thing.
    const prayer = await read(path.join('niches', 'prayer.json'))
    assert.ok(prayer.includes(PRAY), 'the prayer niche is expected to ask for one 🙏')

    const promptWithNicheRules = `Write a description.\nVOICE: ${JSON.parse(prayer).descriptionShapeRules?.join('\n') || prayer}`
    const generated = `A prayer for the evening.\n\n${PRAY} Subscribe for more.`
    assert.equal(
      await policy.applyEmojiPolicy(generated, [promptWithNicheRules]),
      generated,
      'the app must not strip the emoji its own niche instructed the model to add',
    )
  })
})

describe('the surfaces that publish his text consult the policy', () => {
  // Source-level, deliberately. What is being guarded is that a CALL EXISTS at
  // each place text is generated — a behavioural test would need a paid model
  // call per surface, and would still pass if a new surface were added without
  // one.
  const surfaces: Array<[string, RegExp[]]> = [
    ['generators/metadata.ts', [/applyEmojiPolicy\(descRaw/, /applyEmojiPolicyToAll\(rawTitles/, /noEmojiDirective\(\)/]],
    ['generators/idea-campaign.ts', [/applyEmojiPolicy\(String\(item\.title/, /NO_EMOJI_DIRECTIVE/]],
    ['generators/contextual-cues.ts', [/applyEmojiPolicy\(candidate\.title/, /noEmojiDirective\(\)/]],
  ]

  for (const [rel, patterns] of surfaces) {
    test(`${rel} instructs the model AND cleans what comes back`, async () => {
      const src = await read(rel)
      for (const pattern of patterns) {
        assert.match(src, pattern, `${rel} is missing ${pattern}`)
      }
    })
  }

  test('every generated string is cleaned with the prompt that produced it', async () => {
    // The prompt is the right source because it CONTAINS everything of his
    // that fed the generation — his story context, his title, his custom
    // section labels and the niche's own voice rules. Enumerating those by
    // hand is what would eventually miss one.
    const src = await read('generators/metadata.ts')
    assert.match(src, /applyEmojiPolicy\(descRaw\.trim\(\), \[descPrompt\]\)/)
    assert.match(src, /applyEmojiPolicyToAll\(rawTitles, \[titlePromptWithAvoidance\]\)/)
  })

  test('an image prompt is told not to carry an emoji into the picture', async () => {
    const src = await read('lib/image-content-guidance.ts')
    assert.match(
      src,
      /Never write an emoji or a decorative symbol into a prompt/,
      'an image model treats an emoji as a thing to depict',
    )
  })
})

describe('what must never be cleaned', () => {
  test('the description finalizer does not strip — by then his prose is in it', async () => {
    // finalizeYouTubeDescription splices generated chapter and source blocks
    // into a description that may be entirely his own edited prose. Cleaning
    // there cannot tell the two apart, so it must not happen there at all.
    const src = await read('services/youtube-metadata-finalizer.ts')
    assert.ok(
      !/applyEmojiPolicy|stripEmoji/.test(src),
      'the finalizer sees a MIXED field; the generated block is cleaned before it arrives',
    )
  })

  test('a cue the reviewer edited is left alone', async () => {
    // Cues are cleaned at proposal. The save route receives whatever a human
    // typed or approved on the review screen, and that is his.
    const src = await read('routes/contextual-cues.ts')
    assert.ok(
      !/applyEmojiPolicy|stripEmoji/.test(src),
      'the cue-save route must never strip — it carries human edits',
    )
  })

  test('a description he already edited is preserved, not regenerated and cleaned', async () => {
    const src = await read('generators/metadata.ts')
    assert.match(
      src,
      /description = existingPackage!\.description!\.trim\(\)/,
      'the preserve-existing branch must stay a plain copy of his edited text',
    )
  })
})
