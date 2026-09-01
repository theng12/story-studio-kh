import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { contentPackDocumentToNiche } from '../content-packs/legacy-adapters.js'
import { parseContentPackDocument } from '../content-packs/schemas.js'

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const FORMULA_ROOT = resolve(ROOT, 'content-packs/legacy-niche-conversion/formula')

const FORMULAS = [
  ['counted-explainer', 'com.storystudio.formula.counted-explainer'],
  ['build-under-constraints', 'com.storystudio.formula.build-under-constraints'],
  ['philosophy-real-problem', 'com.storystudio.formula.philosophy-real-problem'],
  ['pastoral-scripture', 'com.storystudio.formula.pastoral-scripture'],
  ['prayer', 'com.storystudio.formula.prayer'],
] as const

async function formula(slug: string) {
  const raw = JSON.parse(await readFile(resolve(FORMULA_ROOT, slug, 'content/series-formula.json'), 'utf8'))
  return parseContentPackDocument('series-formula', raw)
}

test('legacy Formula adapters project every strict source into the current Niche contract', async () => {
  for (const [slug, id] of FORMULAS) {
    const document = await formula(slug)
    if (document.kind !== 'series-formula') throw new Error(`${slug} is not a Formula`)
    const niche = contentPackDocumentToNiche(document)
    assert.equal(niche.id, id)
    assert.equal(niche.kind, 'series-formula')
    assert.equal(niche.builtin, true)
    assert.equal(niche.description, document.description)
    assert.equal(niche.tagline, document.tagline)
    assert.equal(niche.audienceHint, document.audience_hint ?? document.audience)
    assert.deepEqual(niche.compatibleTopicPackIds, document.compatible_topic_pack_ids)
    assert.deepEqual(niche.defaultTopicPackIds, document.default_topic_pack_ids)
    assert.deepEqual(niche.ideaAxes, document.idea_axes)
    assert.deepEqual(niche.vocabulary, document.vocabulary)
    assert.equal(niche.scriptContext, document.script_context)
    assert.equal(niche.scriptSystemPromptRole, document.script_system_prompt_role)
    assert.deepEqual(niche.titleShapeRules, document.title_shape_rules)
    assert.deepEqual(niche.titleLengthRange, document.title_length_range)
    assert.deepEqual(niche.narrativeQualityContract, {
      openingPolicy: document.narrative_quality_contract?.opening_policy,
      forbiddenPatterns: document.narrative_quality_contract?.forbidden_patterns,
      requiredHabits: document.narrative_quality_contract?.required_habits,
      closingPolicy: document.narrative_quality_contract?.closing_policy,
    })
    assert.deepEqual(niche.scriptStructure?.chapterCountRange, document.script_structure.chapter_count_range)
    assert.deepEqual(niche.scriptStructure?.lengthMinutesRange, document.script_structure.length_minutes_range)
    assert.equal(niche.scriptStructure?.chaptersIndependent, document.script_structure.chapters_independent)
  }
})

test('legacy Formula compatibility uses qualified authored or atomically reserved Topic identities', async () => {
  const registry = JSON.parse(await readFile(resolve(ROOT, 'content-packs/authoring-registry.json'), 'utf8'))
  const usableTopics = new Set(registry.records
    .filter((record: { kind: string; status: string }) => record.kind === 'topic-pack' && ['authored', 'reserved'].includes(record.status))
    .map((record: { item_id: string }) => record.item_id))
  for (const [slug] of FORMULAS) {
    const document = await formula(slug)
    if (document.kind !== 'series-formula') throw new Error(`${slug} is not a Formula`)
    for (const topicId of document.compatible_topic_pack_ids) {
      assert.match(topicId, /^com\.storystudio\.topic\./)
      assert.ok(usableTopics.has(topicId), `${slug} must not invent Topic identity ${topicId}`)
    }
  }
  assert.deepEqual((await formula('counted-explainer')).compatible_topic_pack_ids.slice(-3), [
    'com.storystudio.topic.natural-world-fungi',
    'com.storystudio.topic.natural-world-insects',
    'com.storystudio.topic.natural-world-plants',
  ])
  assert.deepEqual((await formula('pastoral-scripture')).compatible_topic_pack_ids, [
    'com.storystudio.topic.pastoral-daily-reflection',
    'com.storystudio.topic.pastoral-expository-teaching',
  ])
})
