/**
 * Idea Campaign: a rejected assignment is not planned again for that campaign (2026-10-20).
 *
 * Rejected candidates are never saved, and the planner is seeded by the campaign id, so every attempt
 * and every Retry of a small-remaining campaign reserved the SAME first assignments (BrainWise
 * 3b980c16: 8 single-idea requests, four titles recurring). A content rejection (drift, missing
 * title or logline, duplicate) now records the assignment's fingerprint in the job's params, which
 * Retry copies forward, and the planner skips it exactly as it skips a used fingerprint.
 *
 * Cannot catch: how a real model words a retried assignment.
 */
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createHash } from 'node:crypto'
import type { Niche } from '../models/types.js'
import { planIdeaAssignments } from '../services/idea-campaign-planner.js'
import { useTempDataDir } from './_helpers.js'
import { setupPackCampaign, storyIdea } from './_idea-campaign-pack.js'

const isolatedDataDir = await useTempDataDir()
after(() => isolatedDataDir.cleanup())

/** Hermetic: a synthetic formula and pack, so a bundled content change can never move the golden. */
const niche = {
  id: 'golden-formula', name: 'Golden', description: '', builtin: true, schemaVersion: 1, kind: 'series-formula', exampleTopics: [],
  activeTopicPacks: [{
    id: 'golden-pack', name: 'Golden pack', description: '', builtin: false, schemaVersion: 1, compatibleNicheIds: [], maxSiblingsPerSubject: 3,
    subjects: ['Tea', 'Coffee', 'Mead', 'Bread', 'Rice', 'Salt'],
  }],
} as unknown as Niche

const digest = (rows: unknown) => createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16)

test('a run with no rejections plans byte-identically to before', async () => {
  const used = planIdeaAssignments({ niche, count: 12, seed: 'earlier' }).slice(0, 12).map(row => row.fingerprint)
  const plain = planIdeaAssignments({ niche, count: 20, usedFingerprints: used, seed: 'golden' })
  // Golden: the plan as 1.4.338 produced it, taken before the exclusion option existed.
  assert.equal(digest(plain), 'b7d7d2df6db543b8')
  assert.deepEqual(planIdeaAssignments({ niche, count: 20, usedFingerprints: used, seed: 'golden', excludeFingerprints: [] }), plain)
})

test('excluded fingerprints are skipped the way used ones are; the rest keep their order', async () => {
  const plain = planIdeaAssignments({ niche, count: 10, seed: 'c' })
  const excluded = plain.slice(0, 4).map(row => row.fingerprint)
  const next = planIdeaAssignments({ niche, count: 10, seed: 'c', excludeFingerprints: excluded })
  assert.equal(next.some(row => excluded.includes(row.fingerprint)), false)
  // The pack's sibling limit can reshuffle the tail, so only the head is pinned.
  assert.deepEqual(next.slice(0, 5).map(row => row.fingerprint), plain.slice(4, 9).map(row => row.fingerprint))
})

const fingerprintsOf = (bodies: string[]) => bodies.flatMap(body => [...body.matchAll(/idea_key=\\"(idea-[0-9a-f]+)\\"/g)].map(match => match[1]!))

test('attempt 2 does not re-plan the assignments attempt 1 had rejected, and Retry carries them forward', async () => {
  const t = await setupPackCampaign()
  try {
    const first = await t.plan('shape', 1)
    const firstFour = first.slice(0, 4)
    t.duplicateAnswers(first, 1)
    const run = t.job('shape', 1)
    await assert.rejects(() => t.generateIdeaCampaign(run), /0 of 1 ideas were saved/)
    assert.deepEqual(fingerprintsOf(t.chatBodies()), firstFour.map(row => row.idea_key), 'attempt 1 asked for the first four')
    assert.deepEqual(run.params.rejected_assignments, firstFour.map(row => row.fingerprint), 'each content rejection is recorded on the job')

    // A Retry: the saved params copied forward onto a fresh job id.
    const retry = t.job('shape-retry', 1, structuredClone(run.params))
    const second = await t.plan('shape', 1, firstFour.map(row => row.fingerprint))
    assert.equal(second.some(row => firstFour.some(old => old.fingerprint === row.fingerprint)), false)
    t.duplicateAnswers(second, 1)
    const before = t.chatBodies().length
    await assert.rejects(() => t.generateIdeaCampaign(retry), /0 of 1 ideas were saved/)
    const secondKeys = fingerprintsOf(t.chatBodies().slice(before))
    assert.equal(secondKeys.length, 4)
    assert.equal(secondKeys.some(key => firstFour.some(old => old.idea_key === key)), false, 'no assignment attempt 1 rejected is reserved again')
    assert.equal(retry.params.rejected_assignments.length, 8, 'the record grows across attempts')
  } finally {
    await t.done()
  }
})

test('drift and a missing title are content rejections and are recorded', async () => {
  const t = await setupPackCampaign()
  try {
    const planned = await t.plan('content', 1)
    t.duplicateAnswers(planned, 1, 1, assignment => ({ ...storyIdea('Penguins of the Antarctic Ice', 'Nothing about the assigned subject.'), idea_key: assignment.idea_key }))
    t.duplicateAnswers(planned.slice(1), 1, 1, assignment => ({ ...storyIdea(' ', ' '), idea_key: assignment.idea_key }))
    const run = t.job('content', 1)
    await assert.rejects(() => t.generateIdeaCampaign(run))
    assert.ok(run.params.rejected_assignments.includes(planned[0]!.fingerprint), 'drift')
    assert.ok(run.params.rejected_assignments.includes(planned[1]!.fingerprint), 'missing title and logline')
  } finally {
    await t.done()
  }
})

test('a provider or parse failure records nothing', async () => {
  const t = await setupPackCampaign()
  try {
    t.service.queueScenario('chat', { outputText: 'NOT JSON AT ALL — no array here.' })
    const run = t.job('provider-failure', 1)
    await assert.rejects(() => t.generateIdeaCampaign(run))
    assert.equal('rejected_assignments' in run.params, false)
  } finally {
    await t.done()
  }
})
