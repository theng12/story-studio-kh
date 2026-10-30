/**
 * The labels half of a one-click run choosing its own labels (2026-10-30).
 *
 * Four promises, one per line the owner set:
 *  - a preset may name label themes and motions, and an empty preset behaves
 *    exactly as it did before those fields existed;
 *  - a design id or motion outside the allowed list is DROPPED with its
 *    reason, never substituted;
 *  - `point_at` reaches the cue;
 *  - the four old templates still produce the old output unchanged.
 *
 * The design ids are read from the live `label-designs` catalogue here too, so
 * these tests fail loudly if the catalogue and the preset ever disagree about
 * what a theme is called.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  accountCueCandidates,
  cueSystemPrompt,
  resolveCueChoiceAllowlist,
} from '../generators/contextual-cues.js'
import { normalizeContextualCueProposalSettings } from '../services/contextual-cues.js'
import { CONTEXTUAL_CUES_OUTPUT_CONTRACT } from '../lib/story-output-contracts.js'
import { validateStructuredOutput } from '../lib/json-output-contract.js'

const plan = {
  total_duration_sec: 600,
  scenes: [
    { id: 's1', start_sec: 0, end_sec: 30 },
    { id: 's2', start_sec: 100, end_sec: 130 },
  ],
} as any

const NOW = '2026-10-30T00:00:00.000Z'

type Allow = Awaited<ReturnType<typeof resolveCueChoiceAllowlist>>

/** One accounting pass, with the run's allowlist resolved the same way a run resolves it. */
const account = async (
  candidates: Parameters<typeof accountCueCandidates>[0],
  preset: Record<string, unknown> = {},
  allow?: Allow,
) => accountCueCandidates(
  candidates,
  plan,
  normalizeContextualCueProposalSettings(preset),
  NOW,
  new Set(),
  allow ?? await resolveCueChoiceAllowlist(normalizeContextualCueProposalSettings({})),
)

describe('Contextual Cues label choices', () => {
  test('a preset\'s themes and motions are read live into the allowlist and the prompt; empty means today', async () => {
    const empty = normalizeContextualCueProposalSettings({})
    assert.equal(empty.label_themes, undefined, 'a preset that named nothing stays key-less')
    assert.equal(empty.label_motions, undefined)
    const legacy = await resolveCueChoiceAllowlist(empty)
    assert.deepEqual([...legacy.templates].sort(), [
      'archival-caption', 'chapter-plate', 'documentary-label', 'map-pin',
    ])
    assert.equal(legacy.motions.size, 0)
    assert.equal(legacy.designs.length, 0)
    const legacyPrompt = cueSystemPrompt(legacy)
    assert.match(legacyPrompt, /archival-caption/)
    assert.ok(!legacyPrompt.includes('label:'), 'no design id is offered when no theme was set')

    const preset = normalizeContextualCueProposalSettings({ label_themes: ['comedy'], label_motions: ['slide', 'slide', ' '] })
    assert.deepEqual(preset.label_themes, ['comedy'])
    assert.deepEqual(preset.label_motions, ['slide'], 'duplicates and blanks never reach a preset')
    const allow = await resolveCueChoiceAllowlist(preset)
    assert.ok(allow.templates.has('label:comic-burst'), 'the comedy design is offered by its real id')
    assert.ok(!allow.templates.has('label:location-pin'), 'an exploration design is not, whatever the model prefers')
    assert.deepEqual([...allow.motions], ['slide'])
    const prompt = cueSystemPrompt(allow)
    assert.match(prompt, /label:comic-burst/)
    assert.match(prompt, /motion MUST be one of: slide/)
    assert.ok(!prompt.includes('archival-caption'), 'the four old templates are not offered when themes are set')

    // A choice this app cannot draw is refused before any request is made.
    await assert.rejects(
      resolveCueChoiceAllowlist(normalizeContextualCueProposalSettings({ label_themes: ['no-such-theme'] })),
      /No visible label design carries any of this preset's label_themes/,
    )
    await assert.rejects(
      resolveCueChoiceAllowlist(normalizeContextualCueProposalSettings({ label_motions: ['bounce'] })),
      /not a cue motion/,
    )
  })

  test('hidden designs are excluded from themed and classic automatic choices', async () => {
    const themed = normalizeContextualCueProposalSettings({ label_themes: ['exploration'] })
    const visible = await resolveCueChoiceAllowlist(themed, ['label:location-pin'])
    assert.ok(!visible.templates.has('label:location-pin'))
    assert.ok(visible.templates.size > 0)
    assert.ok(!cueSystemPrompt(visible).includes('label:location-pin'))
    const classic = await resolveCueChoiceAllowlist(normalizeContextualCueProposalSettings({}), ['map-pin'])
    assert.ok(!classic.templates.has('map-pin'))
    assert.ok(!cueSystemPrompt(classic).includes('map-pin'))
    await assert.rejects(resolveCueChoiceAllowlist(normalizeContextualCueProposalSettings({}), ['map-pin', 'chapter-plate', 'archival-caption', 'documentary-label']), /Restore one/)
  })

  test('a design id or motion outside the allowed list is dropped with its reason, never substituted', async () => {
    const allow = await resolveCueChoiceAllowlist(
      normalizeContextualCueProposalSettings({ label_themes: ['comedy'], label_motions: ['slide'] }),
    )
    const { proposed, dropped } = await account([
      { scene_id: 's1', title: 'Wrong theme', template: 'label:location-pin' },
      { scene_id: 's1', title: 'Motion not allowed', template: 'label:comic-burst', motion: 'bounce' },
      { scene_id: 's2', title: 'Allowed on both counts', template: 'label:comic-burst', motion: 'slide' },
    ], { label_themes: ['comedy'], label_motions: ['slide'] }, allow)
    assert.deepEqual(proposed.map(cue => cue.title), ['Allowed on both counts'])
    assert.equal(proposed[0]!.template, 'label:comic-burst')
    assert.equal(proposed[0]!.entrance, 'slide')
    assert.deepEqual(dropped.map(drop => drop.title), ['Wrong theme', 'Motion not allowed'])
    assert.match(dropped[0]!.reason, /its label design "label:location-pin" is not one of this run's allowed label designs/)
    assert.match(dropped[1]!.reason, /its motion "bounce" is not one of this run's allowed motions/)
  })

  test('point_at is stored on the cue, and the contract accepts the new fields', async () => {
    const { proposed, dropped } = await account([
      { scene_id: 's1', title: 'The cracked bell', kind: 'historical_context', point_at: '  the   cracked   tower ' },
    ])
    assert.deepEqual(dropped, [])
    assert.equal(proposed[0]!.point_at, 'the cracked tower')
    assert.equal(
      proposed[0]!.entrance,
      'fade',
      'a motion the model volunteers while no label_motions is set changes nothing',
    )
    assert.doesNotThrow(() => validateStructuredOutput(JSON.stringify({
      cues: [{
        scene_id: 's1', title: 'The cracked bell', template: 'label:comic-burst',
        motion: 'slide', point_at: 'the tower', kind: 'historical_context', anchor_word: 'the cracked bell',
      }],
    }), CONTEXTUAL_CUES_OUTPUT_CONTRACT), 'a real design id, a motion and point_at all pass the schema')
  })

  test('with no fields set the cue is exactly what it was before', async () => {
    const { proposed, dropped } = await account([{
      scene_id: 's1',
      title: 'Harbour of Ostia',
      subtitle: 'Ostia, 42 AD',
      kind: 'location_date',
      anchor_word: 'the harbour at Ostia',
      anchor_offset_sec: 0.4,
    }], { placement: 'bottom-left', position_x_pct: 10, position_y_pct: 20 })
    assert.deepEqual(dropped, [])
    assert.deepEqual(proposed, [{
      id: 'cue-s1',
      scene_id: 's1',
      anchor_word: 'the harbour at Ostia',
      anchor_offset_sec: 0.4,
      start_sec: 0.4,
      end_sec: 3.9,
      title: 'Harbour of Ostia',
      subtitle: 'Ostia, 42 AD',
      kind: 'location_date',
      placement: 'bottom-left',
      position_x_pct: 10,
      position_y_pct: 20,
      template: 'map-pin',
      entrance: 'fade',
      exit: 'dissolve',
      status: 'proposed',
      created_at: NOW,
      updated_at: NOW,
    }])
    // The old text templates still stand, and nothing new appears on the cue.
    const old = (await account([{ scene_id: 's2', title: 'Rome, 64 AD', template: 'documentary-label' }])).proposed[0]!
    assert.equal(old.template, 'documentary-label')
    assert.ok(!('point_at' in old))
  })
})
