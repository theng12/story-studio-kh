import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { composeNicheWithTopicPacks, listNiches, loadNiche } from '../services/niche-loader.js'
import { planIdeaAssignments } from '../services/idea-campaign-planner.js'
import { listTopicPacks } from '../services/topic-pack-loader.js'
import { useTempDataDir } from './_helpers.js'
/**
 * Claim an isolated data dir before anything runs.
 *
 * These are pure-logic tests, but the loaders they exercise (niche,
 * topic-pack, format) look for user overrides under
 * `${projectsRoot()}/.niches` and friends. With no data dir claimed that
 * resolves to the machine owner's REAL projects folder, so results would
 * depend on what they happen to have installed there. Reads only today —
 * the owner's folder has no override directories — but it is the same
 * isolation leak the projects-root refactor exists to close.
 */
const isolatedDataDir = await useTempDataDir()
after(() => isolatedDataDir.cleanup())

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

  test('Hidden Mechanics of History keeps five default lanes and reserves a thousand causal investigations', async () => {
    const formula = await loadNiche('hidden-mechanics-history')
    assert.ok(formula, 'Hidden Mechanics of History Formula must ship')
    assert.deepEqual(formula!.defaultTopicPackIds, [
      'historical-states-revolutions-collapse',
      'historical-money-debt-financial-institutions',
      'historical-empires-trade-extraction',
      'historical-wars-treaties-world-order',
      'historical-infrastructure-commodities-corporate-power',
    ])

    const composed = await composeNicheWithTopicPacks(formula!, [
      ...formula!.defaultTopicPackIds!,
      'economics-ancient-civilizations',
    ])
    assert.equal(composed.activeTopicPacks?.length, 6,
      'Ancient Civilizations & Empires remains a reusable sixth lane')
    assert.ok(composed.activeTopicPacks?.some(pack => pack.id === 'economics-ancient-civilizations'))

    const assignments = planIdeaAssignments({
      niche: composed,
      count: 1000,
      seed: 'hidden-mechanics-thousand',
    }).slice(0, 1000)
    assert.equal(assignments.length, 1000)
    assert.equal(new Set(assignments.map(item => item.fingerprint)).size, 1000)
    assert.equal(new Set(assignments.map(item => item.idea_key)).size, 1000)
    assert.ok(new Set(assignments.map(item => item.topic_pack_id)).size >= 6,
      'large campaigns should distribute across every compatible lane')
    assert.ok(assignments.every(item => item.dimensions['causal-mechanism']))
    assert.ok(assignments.every(item => item.dimensions['evidence-posture']))
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

  test('topic-owned per-subject profiles rotate whole coherent tuples before sibling reservations', () => {
    const values = Array.from({ length: 8 }, (_, index) => String(index + 1))
    const pack = {
      id: 'tuple-pack', name: 'Tuple Pack', description: 'A deterministic tuple fixture.', builtin: true, schemaVersion: 1 as const,
      compatibleNicheIds: ['tuple-formula'], subjects: values.map(value => `subject-${value}`), maxSiblingsPerSubject: 1,
      ideaAxes: [
        { id: 'episode-object', label: 'Episode object', values: values.map(value => `object-${value}`) },
        { id: 'time-place-scope', label: 'Time and place', values: values.map(value => `place-${value}`) },
        { id: 'mechanism', label: 'Mechanism', values: values.map(value => `mechanism-${value}`) },
        { id: 'evidence-lens', label: 'Evidence lens', values: values.map(value => `evidence-${value}`) },
      ],
      coverageProfiles: values.map(value => ({
        subject: `subject-${value}`,
        tuples: [
          { episodeObject: `object-${value}`, timePlaceScope: `place-${value}`, mechanism: `mechanism-${value}`, evidenceLens: `evidence-${value}` },
          { episodeObject: `object-${value}-next`, timePlaceScope: `place-${value}-next`, mechanism: `mechanism-${value}-next`, evidenceLens: `evidence-${value}-next` },
        ],
      })),
    }
    const niche = {
      id: 'tuple-formula', name: 'Tuple Formula', description: 'A deterministic tuple fixture.', builtin: true, schemaVersion: 1 as const,
      exampleTopics: [],
      activeTopicPacks: [pack],
    }
    const first = planIdeaAssignments({ niche, count: 8, seed: 'tuple-coverage' }).slice(0, 8)
    assert.deepEqual(first.map(item => item.dimensions.subject), values.map(value => `subject-${value}`))
    assert.deepEqual(first.map(item => item.dimensions['episode-object']), values.map(value => `object-${value}`))
    assert.deepEqual(first.map(item => item.dimensions['time-place-scope']), values.map(value => `place-${value}`))
    assert.deepEqual(first.map(item => item.dimensions.mechanism), values.map(value => `mechanism-${value}`))
    assert.deepEqual(first.map(item => item.dimensions['evidence-lens']), values.map(value => `evidence-${value}`))
    for (const index of [0, 4, 7]) {
      const value = values[index]!
      const dimensions = first[index]!.dimensions
      assert.deepEqual(Object.fromEntries([
        'subject', 'episode-object', 'time-place-scope', 'mechanism', 'evidence-lens',
      ].map(key => [key, dimensions[key]])), {
        subject: `subject-${value}`,
        'episode-object': `object-${value}`,
        'time-place-scope': `place-${value}`,
        mechanism: `mechanism-${value}`,
        'evidence-lens': `evidence-${value}`,
      })
    }
    const reserved = planIdeaAssignments({
      niche, count: 8, seed: 'tuple-coverage-next', usedFingerprints: first.map(item => item.fingerprint),
    }).slice(0, 8)
    assert.equal(reserved.length, 8)
    assert.ok(reserved.every(item => !new Set(first.map(firstItem => firstItem.fingerprint)).has(item.fingerprint)))
    const firstBySubject = new Map(first.map(item => [item.dimensions.subject, item.dimensions]))
    for (const assignment of reserved) {
      const prior = firstBySubject.get(assignment.dimensions.subject)
      assert.ok(prior)
      assert.notEqual(assignment.dimensions['episode-object'], prior['episode-object'])
      assert.notEqual(assignment.dimensions.mechanism, prior.mechanism)
    }
  })

  test('a Topic profile remains atomic when the Formula declares identically named structural axes', () => {
    const niche = {
      id: 'profile-formula', name: 'Profile Formula', description: 'Formula axes must not overwrite profile records.', builtin: true, schemaVersion: 1 as const,
      exampleTopics: [],
      ideaAxes: [
        { id: 'episode-object', label: 'Formula object', values: ['wrong Formula object'] },
        { id: 'time-place-scope', label: 'Formula time', values: ['wrong Formula time'] },
        { id: 'mechanism', label: 'Formula mechanism', values: ['wrong Formula mechanism'] },
        { id: 'evidence-lens', label: 'Formula evidence', values: ['wrong Formula evidence'] },
      ],
      activeTopicPacks: [{
        id: 'profile-pack', name: 'Profile Pack', description: 'Atomic profile fixture.', builtin: true, schemaVersion: 1 as const,
        compatibleNicheIds: ['profile-formula'], subjects: ['a subject'], maxSiblingsPerSubject: 1,
        coverageProfiles: [{ subject: 'a subject', tuples: [
          { episodeObject: 'authored object', timePlaceScope: 'authored time', mechanism: 'authored mechanism', evidenceLens: 'authored evidence' },
          { episodeObject: 'next object', timePlaceScope: 'next time', mechanism: 'next mechanism', evidenceLens: 'next evidence' },
        ] }],
      }],
    }
    const assignment = planIdeaAssignments({ niche, count: 1, seed: 'profile-formula' })[0]
    assert.deepEqual(Object.fromEntries(['subject', 'episode-object', 'time-place-scope', 'mechanism', 'evidence-lens'].map(key => [key, assignment?.dimensions[key]])), {
      subject: 'a subject', 'episode-object': 'authored object', 'time-place-scope': 'authored time', mechanism: 'authored mechanism', 'evidence-lens': 'authored evidence',
    })
  })

  test('a schema-valid legacy Topic without coverage groups or idea axes still plans generically', () => {
    const niche = {
      id: 'legacy-topic-formula', name: 'Legacy Topic Formula', description: 'Compatibility fixture.', builtin: true, schemaVersion: 1 as const,
      exampleTopics: [],
      activeTopicPacks: [{
        id: 'legacy-topic', name: 'Legacy Topic', description: 'No authored tuple fields.', builtin: true, schemaVersion: 1 as const,
        compatibleNicheIds: ['legacy-topic-formula'], subjects: ['a ledger'], maxSiblingsPerSubject: 1,
      }],
    }
    const assignments = planIdeaAssignments({ niche, count: 1, seed: 'legacy-topic' })
    assert.equal(assignments.length, 1)
    assert.equal(assignments[0]?.dimensions.subject, 'a ledger')
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
