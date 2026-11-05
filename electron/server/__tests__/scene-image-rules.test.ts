import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STARTING_SCENE_COMPLEXITIES,
  STARTING_SCENE_IMAGE_TYPES,
  SceneImageRulesValidationError,
  defaultSceneImageRules,
  parseSceneClassification,
  parseSceneImageRules,
  resolveSceneImageRule,
} from '../contracts/scene-image-rules.js'

describe('scene-image-rules defaults', () => {
  test('starting data: 13 types with the approved mapping, two complexities with the approved model selections', () => {
    const rules = defaultSceneImageRules()
    assert.equal(rules.scene_types.length, 13)
    assert.deepEqual(
      rules.scene_types.filter(type => type.complexity_id === 'simple').map(type => type.id),
      ['character_portrait', 'landscape', 'simple_map', 'closeup_object', 'mood_symbolic'],
    )
    assert.deepEqual(
      rules.scene_types.filter(type => type.complexity_id === 'detailed').map(type => type.id),
      ['character_in_place', 'group_crowd', 'event_action', 'interior', 'city_architecture', 'detailed_map', 'diagram_chart', 'document_writing'],
    )
    assert.deepEqual(
      rules.complexities.map(c => [c.id, c.model_id]),
      [
        ['simple', 'studio-hub::AITRADER/FLUX2-klein-4B-mlx-4bit'],
        ['detailed', 'studio-hub::mflux-community/qwen-image-2-1-turbo-mflux-q4'],
      ],
    )
    assert.equal(rules.allow_different_model, true)
    assert.deepEqual(parseSceneImageRules(rules), rules)
  })

  test('every call returns fresh arrays and objects — no shared mutable defaults', () => {
    const first = defaultSceneImageRules()
    first.scene_types.pop()
    first.scene_types[0]!.complexity_id = 'gone'
    first.complexities[0]!.model_id = 'mutated'
    first.allow_different_model = false
    const second = defaultSceneImageRules()
    assert.equal(second.scene_types.length, STARTING_SCENE_IMAGE_TYPES.length)
    assert.equal(second.scene_types[0]!.complexity_id, 'simple')
    assert.equal(second.complexities[0]!.model_id, STARTING_SCENE_COMPLEXITIES[0]!.model_id)
    assert.equal(second.allow_different_model, true)
  })
})

describe('parseSceneImageRules', () => {
  test('rejects unknown fields by name', () => {
    const input = { ...defaultSceneImageRules(), evil_field: 1 } as Record<string, unknown>
    assert.throws(
      () => parseSceneImageRules(input),
      (error: unknown) => {
        assert.ok(error instanceof SceneImageRulesValidationError)
        assert.equal(error.retryable, false)
        assert.match(error.message, /unknown field "evil_field"/)
        return true
      },
    )
  })

  test('rejects a prototype-pollution style key', () => {
    const input = JSON.parse('{"scene_types":[],"complexities":[],"__proto__":{"polluted":true}}') as object
    assert.throws(() => parseSceneImageRules(input), SceneImageRulesValidationError)
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
  })

  test('rejects duplicate type ids and duplicate complexity ids', () => {
    const dupType = defaultSceneImageRules()
    dupType.scene_types.push({ ...dupType.scene_types[0]! })
    assert.throws(() => parseSceneImageRules(dupType), /duplicate scene type id "character_portrait"/)

    const dupComplexity = defaultSceneImageRules()
    dupComplexity.complexities.push({ ...dupComplexity.complexities[0]! })
    assert.throws(() => parseSceneImageRules(dupComplexity), /duplicate complexity id "simple"/)
  })

  test('rejects a dangling type→complexity reference with a plain reassignment reason', () => {
    const rules = defaultSceneImageRules()
    rules.complexities = rules.complexities.filter(complexity => complexity.id !== 'simple')
    assert.throws(
      () => parseSceneImageRules(rules),
      /scene type "character_portrait" references unknown complexity "simple" — reassign the type to an existing complexity before removing one/,
    )
  })

  test('a custom third complexity sharing an existing selected model parses and resolves with no code change', () => {
    const rules = defaultSceneImageRules()
    // The owner's proof case: several levels may share one model — the custom
    // level maps to an already-selected id, not a new one.
    rules.complexities.push({
      id: 'ultra',
      label: 'Ultra',
      model_id: 'studio-hub::mflux-community/qwen-image-2-1-turbo-mflux-q4',
    })
    const custom = rules.scene_types.find(type => type.id === 'landscape')!
    custom.complexity_id = 'ultra'
    const parsed = parseSceneImageRules(rules)
    const viaCustom = resolveSceneImageRule(parsed, 'landscape')
    const viaExisting = resolveSceneImageRule(parsed, 'event_action')
    assert.deepEqual(viaCustom, {
      type_id: 'landscape',
      complexity_id: 'ultra',
      model_id: 'studio-hub::mflux-community/qwen-image-2-1-turbo-mflux-q4',
    })
    assert.equal(viaExisting?.complexity_id, 'detailed')
    assert.equal(viaCustom?.model_id, viaExisting?.model_id)
  })

  test('rejects invalid ids, invalid booleans and structurally empty model ids', () => {
    const badId = defaultSceneImageRules()
    badId.scene_types[0]!.id = 'Character Portrait'
    assert.throws(() => parseSceneImageRules(badId), /lowercase id/)

    const badBoolean = { ...defaultSceneImageRules(), allow_different_model: 'yes' }
    assert.throws(() => parseSceneImageRules(badBoolean), /allow_different_model/)

    const emptyModel = defaultSceneImageRules()
    emptyModel.complexities[0]!.model_id = ''
    assert.throws(() => parseSceneImageRules(emptyModel), /model_id/)
  })

  test('allow_different_model is optional on input and defaults to true', () => {
    const { allow_different_model: _omitted, ...rest } = defaultSceneImageRules()
    assert.equal(parseSceneImageRules(rest).allow_different_model, true)
  })

  test('bounds: oversized lists and overlong labels are refused', () => {
    const tooManyTypes = defaultSceneImageRules()
    tooManyTypes.scene_types = Array.from({ length: 201 }, (_, i) => ({
      id: `type_${i}`,
      label: `Type ${i}`,
      description: 'desc',
      complexity_id: 'simple',
    }))
    assert.throws(() => parseSceneImageRules(tooManyTypes), SceneImageRulesValidationError)

    const longLabel = defaultSceneImageRules()
    longLabel.complexities[0]!.label = 'x'.repeat(121)
    assert.throws(() => parseSceneImageRules(longLabel), /label/)
  })
})

describe('resolveSceneImageRule', () => {
  test('resolves approved types and refuses an unknown type instead of inferring', () => {
    const rules = defaultSceneImageRules()
    assert.deepEqual(resolveSceneImageRule(rules, 'event_action'), {
      type_id: 'event_action',
      complexity_id: 'detailed',
      model_id: 'studio-hub::mflux-community/qwen-image-2-1-turbo-mflux-q4',
    })
    assert.equal(resolveSceneImageRule(rules, 'not_a_type'), null)
  })

  test('refuses a dangling reference rather than guessing a level', () => {
    const rules = defaultSceneImageRules()
    const orphan = rules.scene_types[0]!
    orphan.complexity_id = 'removed_level'
    assert.equal(resolveSceneImageRule(rules, orphan.id), null)
  })
})

describe('parseSceneClassification', () => {
  const rules = defaultSceneImageRules()

  test('an unclassified scene parses as an empty field set', () => {
    assert.deepEqual(parseSceneClassification({}, rules), {})
  })

  test('a valid custom-channel subject_kind and the other fields pass through', () => {
    const custom = defaultSceneImageRules()
    custom.scene_types.push({
      id: 'dream_vista',
      label: 'Dream vista',
      description: 'A surreal wide vista',
      complexity_id: 'detailed',
    })
    const fields = parseSceneClassification(
      {
        subject_kind: 'dream_vista',
        subject_kind_locked: true,
        classification_reason: 'The passage describes a strange horizon',
        image_model_id: 'studio-hub::some/override-model',
      },
      custom,
    )
    assert.equal(fields.subject_kind, 'dream_vista')
    assert.equal(fields.subject_kind_locked, true)
    assert.equal(fields.classification_reason, 'The passage describes a strange horizon')
    assert.equal(fields.image_model_id, 'studio-hub::some/override-model')
  })

  test('rejects a subject_kind missing from the channel taxonomy', () => {
    assert.throws(
      () => parseSceneClassification({ subject_kind: 'ghost_type' }, rules),
      /subject_kind "ghost_type" is not in this channel's scene types/,
    )
  })

  test('rejects unknown fields, bad booleans and empty model overrides', () => {
    assert.throws(
      () => parseSceneClassification({ complexity: 'simple' }, rules),
      /unknown field "complexity"/,
    )
    assert.throws(
      () => parseSceneClassification({ subject_kind_locked: 'locked' }, rules),
      /subject_kind_locked/,
    )
    assert.throws(
      () => parseSceneClassification({ image_model_id: '' }, rules),
      /image_model_id/,
    )
  })
})
