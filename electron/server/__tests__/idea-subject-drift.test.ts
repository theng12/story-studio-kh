/**
 * MEASURED 2026-08-24 on the owner's own MineePod run. A thirteen-idea campaign
 * on the Animals Topic Pack lost six of its first ten slots to
 * "output drifted from assigned subject", kept refilling, and ended
 *
 *   Idea Campaign incomplete: 12/13 required item(s) verified.
 *
 * Nothing was wrong with the ideas. The drift check asked whether the SUBJECT'S
 * OWN WORDS appeared in the title or logline, and a Topic Pack subject is a
 * category — "mammals", "big cats", "corvids". A good episode title names the
 * animal, not the category, so a correct idea failed the check every time.
 *
 * These tests are written against the exported campaign module so they exercise
 * the real function rather than a copy of its logic.
 */
import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import { __ideaCampaignInternals } from '../generators/idea-campaign.js'

const { mentionsSubject } = __ideaCampaignInternals

function assignment(subject: string, episodeObject?: string) {
  return { idea_key: 'idea-1', dimensions: { subject, ...(episodeObject ? { 'episode-object': episodeObject } : {}) } } as never
}

describe('an idea has not drifted just because it is specific', () => {
  test('the exact case that failed: a category subject and a species title', () => {
    // "mammals" shares no token with this title, and the idea is perfect.
    const idea = { title: 'Why the Naked Mole-Rat Never Gets Cancer', logline: 'A rodent that ignores the rules of ageing.' }
    assert.equal(mentionsSubject(idea, assignment('mammals', 'a naked mole-rat colony')), true)
  })

  test('a big-cats assignment answered with a leopard', () => {
    const idea = { title: 'The Leopard That Drags Dinner Up a Tree', logline: 'Hauling a kill above the hyenas.' }
    assert.equal(mentionsSubject(idea, assignment('big cats', 'a leopard hauling a kill up a tree')), true)
  })

  test('matching the subject alone still counts, as it always did', () => {
    const idea = { title: 'How Migration Rebuilt a Bird Overnight', logline: 'Fuel, fat and a nine-day flight.' }
    assert.equal(mentionsSubject(idea, assignment('migration', 'a godwit fuelling flock')), true)
  })
})

describe('genuine drift is still caught', () => {
  test('an output about something else entirely is refused', () => {
    const idea = { title: 'The Bridge That Bankrupted a City', logline: 'Concrete, debt and a council vote.' }
    assert.equal(mentionsSubject(idea, assignment('big cats', 'a leopard hauling a kill up a tree')), false)
  })

  test('a stopword shared with the assignment is not a match', () => {
    // "the", "a" and "up" are dropped before comparison, so an unrelated idea
    // cannot pass on grammar alone -- which is what would make this check
    // useless rather than merely wrong.
    const idea = { title: 'A Study of the Thing in the Place', logline: 'It is what it is.' }
    assert.equal(mentionsSubject(idea, assignment('big cats', 'a leopard hauling a kill up a tree')), false)
  })

  test('an assignment with nothing to anchor on accepts, rather than rejecting blindly', () => {
    assert.equal(mentionsSubject({ title: 'Anything', logline: 'At all' }, assignment('')), true)
  })
})
