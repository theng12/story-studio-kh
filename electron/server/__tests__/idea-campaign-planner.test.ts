import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { composeNicheWithTopicPacks, listNiches, loadNiche } from '../services/niche-loader.js'
import { planIdeaAssignments } from '../services/idea-campaign-planner.js'
import { listTopicPacks } from '../services/topic-pack-loader.js'

describe('Series Formula + Topic Pack campaign planning', () => {
  test('legacy and new niches load as Series Formulas without a project migration', async () => {
    const niches = await listNiches()
    assert.ok(niches.length > 0)
    assert.ok(niches.every(niche => niche.kind === 'series-formula'))
  })

  test('Business Economics defaults to the business pack and can compose with ancient civilizations', async () => {
    const formula = await loadNiche('business-economics')
    assert.ok(formula)

    const defaults = await composeNicheWithTopicPacks(formula!)
    assert.deepEqual(defaults.activeTopicPacks?.map(pack => pack.id), ['economics-businesses'])

    const civilizations = await composeNicheWithTopicPacks(formula!, ['economics-ancient-civilizations'])
    assert.deepEqual(civilizations.activeTopicPacks?.map(pack => pack.id), ['economics-ancient-civilizations'])
    assert.ok(civilizations.exampleTopics.some(topic => /Roman Empire/i.test(topic)))
  })

  test('a 100-idea campaign reserves 100 unique structured fingerprints', async () => {
    const formula = await loadNiche('business-economics')
    const composed = await composeNicheWithTopicPacks(formula!, [
      'economics-businesses',
      'economics-ancient-civilizations',
    ])
    const first = planIdeaAssignments({
      niche: composed,
      count: 100,
      seed: 'campaign-one',
    }).slice(0, 100)

    assert.equal(first.length, 100)
    assert.equal(new Set(first.map(item => item.fingerprint)).size, 100)
    assert.equal(new Set(first.map(item => item.idea_key)).size, 100)

    const second = planIdeaAssignments({
      niche: composed,
      count: 100,
      usedFingerprints: first.map(item => item.fingerprint),
      seed: 'campaign-two',
    }).slice(0, 100)
    const firstFingerprints = new Set(first.map(item => item.fingerprint))
    assert.equal(second.length, 100)
    assert.ok(second.every(item => !firstFingerprints.has(item.fingerprint)))
  })

  test('a generic formula can still reserve 100 conceptual slots', () => {
    const generic = planIdeaAssignments({
      niche: {
        id: 'generic',
        name: 'Generic',
        description: 'Open exploration',
        builtin: true,
        schemaVersion: 1,
        exampleTopics: ['open topic'],
      },
      count: 100,
      seed: 'generic-campaign',
    }).slice(0, 100)
    assert.equal(generic.length, 100)
    assert.equal(new Set(generic.map(item => item.fingerprint)).size, 100)
  })

  test('all three requested formula families have compatible built-in packs', async () => {
    const packs = await listTopicPacks()
    const compatible = (formulaId: string) =>
      packs.filter(pack => pack.compatibleNicheIds.includes(formulaId))

    assert.ok(compatible('business-economics').length >= 2)
    assert.ok(compatible('ancient-humans').length >= 4)
    assert.ok(compatible('pov-life').length >= 3)
  })

  test('Deep Time Documentary can reserve a thousand non-overlapping idea assignments', async () => {
    const formula = await loadNiche('deep-time-documentary')
    assert.ok(formula, 'deep-time documentary Formula must ship')
    const composed = await composeNicheWithTopicPacks(formula!)
    assert.equal(composed.activeTopicPacks?.length, 5, 'all five deep-time packs are active by default')

    const assignments = planIdeaAssignments({
      niche: composed,
      count: 1000,
      seed: 'deep-time-thousand',
    }).slice(0, 1000)

    assert.equal(assignments.length, 1000)
    assert.equal(new Set(assignments.map(item => item.fingerprint)).size, 1000)
    assert.equal(new Set(assignments.map(item => item.idea_key)).size, 1000)
    assert.ok(new Set(assignments.map(item => item.topic_pack_id)).size >= 5,
      'the catalog should distribute across every deep-time topic pack')
    const oceanAssignment = assignments.find(item => item.topic_pack_id === 'deep-time-deep-ocean')
    assert.ok(oceanAssignment, 'the ocean pack should contribute ideas')
    assert.ok('ocean-zone' in oceanAssignment.dimensions)
    assert.ok(!('human-context' in oceanAssignment.dimensions),
      'specialized axes must stay with their own Topic Pack subjects')
    assert.deepEqual(
      new Set(assignments.map(item => item.dimensions['episode-profile'])),
      new Set(['deep rest documentary', 'immersive documentary']),
      'the Formula must balance both saved episode profiles without a per-run picker',
    )
    assert.match(formula!.ideaGuidanceText || '', /Documentary for Sleep/)
  })
})
