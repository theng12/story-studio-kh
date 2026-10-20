/**
 * Idea Campaign on a Topic-Pack channel whose own subjects are used up (Refinanced 40/40, 2026-10-20).
 *
 * The planner still reserves new STRUCTURAL tuples of the used subjects, so the "no unused subjects"
 * message never fired and the owner was told to press Retry for a run that could only repeat itself.
 * With every pack at 0 unused subjects the job now says so, and to add a Topic Pack.
 *
 * Cannot catch: how Jobs lays the message out.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setupPackCampaign } from './_idea-campaign-pack.js'

test('every pack at 0 unused subjects: the failure says the subjects are used up and to add a Topic Pack', async () => {
  const t = await setupPackCampaign()
  try {
    t.duplicateAnswers(await t.plan('subjects-used-up', 2), 2)
    const run = t.job('subjects-used-up', 2)
    await assert.rejects(() => t.generateIdeaCampaign(run), (error: any) => {
      assert.match(error.message, /^0 of 2 ideas were saved\./)
      assert.match(error.message, /subjects .* used up/i)
      assert.match(error.message, /Add another Topic Pack/)
      assert.doesNotMatch(error.message, /Press Retry to make the 2 missing/)
      return true
    })
    assert.ok(t.chatBodies().length > 0, 'the structural pool was large, so the run did ask the provider')
  } finally {
    await t.done()
  }
})

test('nothing plannable at all: ends with the Topic Pack reason and makes no provider call', async () => {
  const t = await setupPackCampaign({ maxSiblingsPerSubject: 1 })
  try {
    const run = t.job('nothing-plannable', 2)
    await assert.rejects(() => t.generateIdeaCampaign(run), /Add another Topic Pack/)
    assert.equal(t.chatBodies().length, 0)
  } finally {
    await t.done()
  }
})

test('a Topic Pack channel with unused subjects keeps the plain Retry message', async () => {
  const t = await setupPackCampaign()
  try {
    // Forget one subject's fingerprint so the pack has an unused subject left.
    const ideas = await t.im.getIdeas(t.project.slug)
    await t.im.removeIdea(t.project.slug, ideas[2]!.id)
    t.duplicateAnswers(await t.plan('subjects-left', 2), 2)
    const run = t.job('subjects-left', 2)
    await assert.rejects(() => t.generateIdeaCampaign(run), /Press Retry to make the 2 missing ones\./)
  } finally {
    await t.done()
  }
})
