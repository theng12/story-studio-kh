/**
 * Every Formula opens in its own voice — PROVEN THROUGH THE REAL CHAIN.
 *
 * v1.4.73. `DEFAULT_INTRODUCTION_BEATS` was a fixed seven-item list handed to
 * EVERY channel, and it is sleep-shaped: a breathing exercise in front of a
 * business explainer, a subscribe push before a prayer. The branch meant to
 * override it could not run — `canonicalFormatId()` folds every project onto
 * `continuity-chain`, `electron/server/formats/` holds that one file, and its
 * `script` block ships no `introDefaults`. So the override existed, was typed,
 * and was unreachable.
 *
 * Every assertion below runs through the SHIPPING objects: the real niche
 * JSON off disk, the real format file, the real `applyNicheToFormat()`, the
 * real `defaultSegmentRecipe()` and the real `beatLinesForPrompt()`. Nothing
 * about an opening is re-typed here, so a Formula whose opening is deleted, or
 * a bridge that stops carrying it, fails these tests rather than passing them
 * on a copy.
 *
 * The load-bearing test is the MUTATION at the end: it re-runs the identical
 * comparison with the bridge's contribution removed, and shows the two
 * openings collapsing back into the same seven beats. Without it, "a business
 * channel differs from a sleep channel" is a claim about wording somebody
 * typed, not about the mechanism.
 */

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before, describe } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import {
  BEAT_LIBRARY,
  DEFAULT_INTRODUCTION_BEATS,
  INTRODUCTION_SEGMENT_ID,
  WORD_TARGET_MAX,
  WORD_TARGET_MIN,
  beatLinesForPrompt,
  defaultSegmentRecipe,
  followsFormulaOpening,
  matchesLegacyDefaultOpening,
  normalizeChannelSegments,
} from '../lib/episode-segments.js'

const NICHE_DIR = resolve(fileURLToPath(new URL('../niches', import.meta.url)))

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let formatLoader: typeof import('../services/format-loader.js')
let nicheLoader: typeof import('../services/niche-loader.js')
let channelSegments: typeof import('../services/channel-segments.js')

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  formatLoader = await import('../services/format-loader.js')
  nicheLoader = await import('../services/niche-loader.js')
  channelSegments = await import('../services/channel-segments.js')
})
after(async () => { await cleanup() })

/** The shipping format shell, asserted present rather than assumed. */
async function shellFormat() {
  const base = await formatLoader.loadFormat('continuity-chain')
  assert.ok(base, 'the continuity-chain format file must load')
  return base!
}

/** Every built-in Formula id, read off disk rather than listed here. */
// A Short has no introduction by design: Quote Shorts' rules say "no introduction", the
// first line IS the hook, and automatic introductions are opt-in per channel anyway.
const FORMULAS_WITHOUT_AN_OPENING = new Set(['quote-shorts'])

async function builtInFormulaIds(): Promise<string[]> {
  const files = await readdir(NICHE_DIR)
  return files.filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''))
    .filter(id => !FORMULAS_WITHOUT_AN_OPENING.has(id)).sort()
}

/**
 * The opening one Formula produces, taken the whole way through the shipping
 * path: niche file → `applyNicheToFormat()` → `format.script.introDefaults`
 * → `defaultSegmentRecipe()` → the beat lines the prompt is built from.
 */
async function openingFor(formulaId: string) {
  const niche = await nicheLoader.loadNiche(formulaId)
  assert.ok(niche, `built-in Formula '${formulaId}' must load`)
  const base = await shellFormat()
  const format = formatLoader.applyNicheToFormat(base, niche!)
  const recipe = defaultSegmentRecipe(INTRODUCTION_SEGMENT_ID, format.script.introDefaults)
  return { niche: niche!, format, recipe, lines: beatLinesForPrompt(recipe) }
}

/** The numbered block `generateIntroductionOnly()` puts in the prompt. */
function promptBlock(lines: string[]): string {
  return lines.map((b, i) => `${i + 1}. ${b}`).join('\n')
}

// ─────────────────────────────────────────────────────────────────────────
describe('the bridge that was missing', () => {
  test('the one format file still ships no introDefaults of its own', async () => {
    // If this ever stops being true the fix has a second, competing source and
    // the two can disagree about what a channel opens with.
    const base = await shellFormat()
    assert.equal(base.script.introDefaults, undefined,
      'the format shell must stay silent about openings — the Formula owns them')
  })

  test('applyNicheToFormat carries the Formula\u2019s opening onto the format', async () => {
    const niche = await nicheLoader.loadNiche('business-economics')
    const base = await shellFormat()
    assert.equal(base.script.introDefaults, undefined)
    const merged = formatLoader.applyNicheToFormat(base, niche!)
    assert.ok(merged.script.introDefaults?.beats?.length,
      'the field defaultSegmentRecipe() reads has to arrive populated')
    assert.notEqual(merged.script.introDefaults, base.script.introDefaults)
    // And the input objects are untouched — formats are cached across requests.
    assert.equal(base.script.introDefaults, undefined, 'applyNicheToFormat must not mutate its input')
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('all twenty-two built-in Formulas ship an opening', () => {
  test('every one of them, with beats the catalogue can explain', async () => {
    const ids = await builtInFormulaIds()
    assert.equal(ids.length, 22, `expected 22 built-in Formulas, found ${ids.length}`)
    // The exemption names a real Formula that really declares none, so it cannot hide a regression.
    for (const id of FORMULAS_WITHOUT_AN_OPENING) {
      const raw = JSON.parse(await readFile(resolve(NICHE_DIR, `${id}.json`), 'utf8'))
      assert.equal(raw.introDefaults, undefined, `${id} now declares an opening; take it off the exemption`)
    }
    for (const id of ids) {
      const raw = JSON.parse(await readFile(resolve(NICHE_DIR, `${id}.json`), 'utf8'))
      const intro = raw.introDefaults
      assert.ok(intro, `${id} must ship an opening`)
      assert.ok(Array.isArray(intro.beats) && intro.beats.length >= 3,
        `${id} must ship at least three beats; got ${intro.beats?.length}`)
      assert.ok(intro.wordTarget >= WORD_TARGET_MIN && intro.wordTarget <= WORD_TARGET_MAX,
        `${id} word target ${intro.wordTarget} is outside ${WORD_TARGET_MIN}\u2013${WORD_TARGET_MAX}`)
      for (const beat of intro.beats) {
        assert.ok(BEAT_LIBRARY[beat.id],
          `${id} names a beat the catalogue cannot explain: '${beat.id}'`)
        assert.ok((beat.custom_text || '').trim().length > 0,
          `${id}'s '${beat.id}' must say what it covers IN THIS CHANNEL'S VOICE \u2014 `
          + 'a bare label is the generic opening this change exists to end')
      }
    }
  })

  test('none of them is still the old sleep-shaped seven', async () => {
    for (const id of await builtInFormulaIds()) {
      const { recipe } = await openingFor(id)
      assert.equal(matchesLegacyDefaultOpening(recipe), false,
        `${id} still produces the pre-v1.4.73 default \u2014 its opening did not reach the recipe`)
      assert.equal(followsFormulaOpening(recipe, (await openingFor(id)).format.script.introDefaults), true,
        `${id}'s derived recipe must match its own Formula's declaration`)
    }
  })

  test('a breathing exercise now appears only where it belongs', async () => {
    const withRelaxation: string[] = []
    for (const id of await builtInFormulaIds()) {
      const { recipe } = await openingFor(id)
      if (recipe.beats.some(b => b.id === 'relaxation' && b.enabled)) withRelaxation.push(id)
    }
    // Before this change the answer was all twenty-two.
    assert.deepEqual(withRelaxation.sort(), ['mindfulness', 'sleep'])
  })

  test('nothing pushes a subscribe before a prayer or a meditation settles', async () => {
    for (const id of ['prayer', 'mindfulness', 'devotional', 'deep-time-documentary']) {
      const { recipe } = await openingFor(id)
      assert.ok(!recipe.beats.some(b => b.id === 'subscribe_cta' && b.enabled),
        `${id} must not open with a subscribe push`)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('a business channel and a sleep channel do not open the same way', () => {
  test('the beat lines the prompt is built from are different, and each sounds like its channel', async () => {
    const business = await openingFor('business-economics')
    const sleep = await openingFor('sleep')

    const businessBlock = promptBlock(business.lines)
    const sleepBlock = promptBlock(sleep.lines)
    assert.notEqual(businessBlock, sleepBlock)

    // Each carries the other's disqualifying instruction and not its own.
    assert.match(businessBlock, /not investment advice/i)
    assert.doesNotMatch(businessBlock, /breaths/i)
    assert.match(sleepBlock, /three slow breaths/i)
    assert.doesNotMatch(sleepBlock, /investment advice/i)

    // And the lengths are the Formulas', not one shared number.
    assert.equal(sleep.recipe.word_target, 350)
    assert.equal(business.recipe.word_target, 140)
  })

  test('MUTATION \u2014 remove the bridge\u2019s contribution and the two collapse into one opening', async () => {
    // Exactly the comparison above, with `format.script.introDefaults` taken
    // away: this is the state every channel was in before v1.4.73. If the two
    // still differed here, the difference above would be coming from somewhere
    // other than the Formula and this whole file would be proving nothing.
    const businessUnbridged = defaultSegmentRecipe(INTRODUCTION_SEGMENT_ID, null)
    const sleepUnbridged = defaultSegmentRecipe(INTRODUCTION_SEGMENT_ID, null)
    assert.equal(promptBlock(beatLinesForPrompt(businessUnbridged)),
      promptBlock(beatLinesForPrompt(sleepUnbridged)),
      'without the bridge every channel gets the identical opening \u2014 the defect')
    assert.equal(businessUnbridged.word_target, sleepUnbridged.word_target)
    assert.equal(matchesLegacyDefaultOpening(businessUnbridged), true)
    assert.deepEqual(businessUnbridged.beats.map(b => b.id),
      DEFAULT_INTRODUCTION_BEATS.map(b => b.id))
  })

  test('MUTATION \u2014 a Formula that declares no opening still falls back cleanly', async () => {
    const base = await shellFormat()
    const niche = await nicheLoader.loadNiche('sleep')
    const stripped = { ...niche!, introDefaults: undefined }
    const merged = formatLoader.applyNicheToFormat(base, stripped as typeof niche & object)
    const recipe = defaultSegmentRecipe(INTRODUCTION_SEGMENT_ID, merged.script.introDefaults)
    assert.equal(matchesLegacyDefaultOpening(recipe), true,
      'a Formula with no opening gets the long-form default, exactly as before')
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('a channel that was never asked is re-seeded; one that was edited is not', () => {
  test('an untouched channel is handed its Formula\u2019s opening', async () => {
    const project = await pm.createProject({ name: 'Untouched Money', niche_id: 'business-economics' })
    // Exactly what every channel carries from before v1.4.73.
    const legacy = normalizeChannelSegments({}, null)
    legacy[INTRODUCTION_SEGMENT_ID].enabled = true
    assert.equal(matchesLegacyDefaultOpening(legacy[INTRODUCTION_SEGMENT_ID].recipe), true)
    await pm.updateConfig(project.slug, { episode_segments: legacy } as never)

    const read = await channelSegments.getChannelSegments(project.slug)
    const recipe = read[INTRODUCTION_SEGMENT_ID].recipe
    assert.equal(read[INTRODUCTION_SEGMENT_ID].enabled, true, 're-seeding must not disturb the on/off answer')
    assert.equal(matchesLegacyDefaultOpening(recipe), false, 'the sleep-shaped seven must be gone')
    assert.ok(!recipe.beats.some(b => b.id === 'relaxation'),
      'a business channel must not open with a breathing exercise')
    assert.equal(recipe.word_target, 140)
    assert.equal(await channelSegments.openingFollowsFormula(project.slug), true)
  })

  test('an EDITED channel keeps every word of what its owner wrote', async () => {
    const project = await pm.createProject({ name: 'Edited Money', niche_id: 'business-economics' })
    const edited = normalizeChannelSegments({
      introduction: {
        enabled: true,
        recipe: {
          host_name: 'Vincent',
          word_target: 275,
          custom_opening_line: 'Right. Let us talk about the money.',
          beats: [
            { id: 'welcome', enabled: true, custom_text: 'say hello the way I actually say it' },
            { id: 'community_question', enabled: true },
            { id: 'transition', enabled: true },
          ],
          model: '',
        },
      },
    }, null)
    await pm.updateConfig(project.slug, { episode_segments: edited } as never)

    const recipe = (await channelSegments.getChannelSegments(project.slug))[INTRODUCTION_SEGMENT_ID].recipe
    assert.equal(recipe.word_target, 275, 'an edited length must survive')
    assert.deepEqual(recipe.beats.map(b => b.id), ['welcome', 'community_question', 'transition'])
    assert.equal(recipe.beats[0].custom_text, 'say hello the way I actually say it')
    assert.equal(recipe.host_name, 'Vincent')
    assert.equal(recipe.custom_opening_line, 'Right. Let us talk about the money.')
    assert.equal(await channelSegments.openingFollowsFormula(project.slug), false,
      'and the page must be told this one is its own, not the Formula\u2019s')
  })

  test('MUTATION \u2014 the same channel, un-edited, IS re-seeded', async () => {
    // The previous test proves an edit survives. On its own that is also what
    // a re-seeder that never runs would produce. This is the same project,
    // same Formula, differing only in whether the recipe was touched.
    const project = await pm.createProject({ name: 'Control Money', niche_id: 'business-economics' })
    const untouched = normalizeChannelSegments({ introduction: { enabled: true } }, null)
    await pm.updateConfig(project.slug, { episode_segments: untouched } as never)
    const recipe = (await channelSegments.getChannelSegments(project.slug))[INTRODUCTION_SEGMENT_ID].recipe
    assert.equal(recipe.word_target, 140)
    assert.notDeepEqual(recipe.beats.map(b => b.id), DEFAULT_INTRODUCTION_BEATS.map(b => b.id))
  })

  test('a channel with no Formula at all is left on the long-form default', async () => {
    const project = await pm.createProject({ name: 'No Formula Here' })
    const recipe = (await channelSegments.getChannelSegments(project.slug))[INTRODUCTION_SEGMENT_ID].recipe
    assert.equal(matchesLegacyDefaultOpening(recipe), true)
    assert.equal(await channelSegments.openingFollowsFormula(project.slug), true,
      'and it is following that default rather than carrying an edit')
  })

  test('re-seeding is derived, not written \u2014 the stored config is left alone', async () => {
    const project = await pm.createProject({ name: 'Storage Check', niche_id: 'sleep' })
    const legacy = normalizeChannelSegments({ introduction: { enabled: true } }, null)
    await pm.updateConfig(project.slug, { episode_segments: legacy } as never)
    await channelSegments.getChannelSegments(project.slug)
    const stored = (await pm.getConfig(project.slug) as Record<string, any>).episode_segments
    assert.deepEqual(
      stored.introduction.recipe.beats.map((b: { id: string }) => b.id),
      DEFAULT_INTRODUCTION_BEATS.map(b => b.id),
      'reading must not rewrite the channel\u2019s file \u2014 a migration has to be right first time, '
      + 'and a derived answer improves whenever the Formula does',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('the opening the Formula wrote is what the prompt receives', () => {
  test('a Formula\u2019s wording survives into the beat line verbatim', async () => {
    const { lines } = await openingFor('prayer')
    const invitation = lines.find(l => l.startsWith('Invitation to pray'))
    assert.ok(invitation, 'the prayer Formula opens by inviting somebody to pray')
    assert.match(invitation!, /specifically cover: invite them, wherever they are, to stop and pray along/)
  })
})
