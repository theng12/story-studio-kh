/**
 * The Audio Generator renders whatever the selected model publishes — and it
 * has never heard of any of it.
 *
 * Every control below is FABRICATED: the names, the ranges, the steps and the
 * defaults exist nowhere in the catalogue and nowhere in Story Studio. They
 * must still produce correct render descriptors and correct submitted values
 * with no change to the page, the panel or these helpers. That is the whole
 * deliverable; if this file ever needed a matching line of application code,
 * the feature would be built wrong.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  coerceTtsControlValue,
  defaultTtsControlValues,
  describeTtsControls,
  isRenderableTtsControl,
  resolveTtsControlValues,
  ttsControlDecimals,
  type GenStudioTtsControl,
} from '../utils/tts-controls'

/** A control row shaped exactly like `TTSModelResponse.controls[]` publishes. */
function control(overrides: Partial<GenStudioTtsControl> & { name: string; type: string }): GenStudioTtsControl {
  return {
    label: overrides.name,
    minimum: null,
    maximum: null,
    default: 0,
    step: null,
    max_length: null,
    description: '',
    ...overrides,
  }
}

/** One model publishing one control of each renderable type — all invented. */
const FABRICATED: GenStudioTtsControl[] = [
  control({
    name: 'zephyr_bias',
    label: 'Zephyr bias',
    type: 'number',
    minimum: -4,
    maximum: 7.5,
    default: 1.25,
    step: 0.25,
    description: 'How far the reading leans windward.',
  }),
  control({
    name: 'lantern_mode',
    label: 'Lantern mode',
    type: 'boolean',
    default: true,
    description: 'Whether the narrator carries a lantern.',
  }),
  control({
    name: 'quay_directive',
    label: 'Quay directive',
    type: 'text',
    default: 'Read as if from a harbour wall.',
    max_length: 40,
    description: 'Plain-language delivery note.',
  }),
]

describe('published TTS controls', () => {
  test('a never-before-seen control set produces correct render descriptors', () => {
    const fields = describeTtsControls(FABRICATED, {})
    assert.equal(fields.length, 3)

    // A number field carries the model's own bounds and step, unchanged.
    assert.deepEqual(fields[0], {
      name: 'zephyr_bias',
      label: 'Zephyr bias',
      description: 'How far the reading leans windward.',
      kind: 'number',
      minimum: -4,
      maximum: 7.5,
      step: 0.25,
      maxLength: null,
      value: 1.25,
    })
    // Precision follows the published step, so the catalogue decides display.
    assert.equal(ttsControlDecimals(fields[0]!.step), 2)
    assert.equal(ttsControlDecimals(null), 0)
    assert.equal(ttsControlDecimals(1), 0)

    // A boolean field is a toggle defaulting to the published default.
    assert.equal(fields[1]!.kind, 'boolean')
    assert.equal(fields[1]!.value, true)

    // A text field is bounded by the published `max_length`.
    assert.equal(fields[2]!.kind, 'text')
    assert.equal(fields[2]!.maxLength, 40)
    assert.equal(fields[2]!.value, 'Read as if from a harbour wall.')

    // Labels and descriptions are shown as published — never rewritten.
    assert.deepEqual(fields.map(field => field.label), ['Zephyr bias', 'Lantern mode', 'Quay directive'])
    assert.equal(fields[1]!.description, 'Whether the narrator carries a lantern.')
  })

  test('a model publishing an empty list renders no control section at all', () => {
    assert.deepEqual(describeTtsControls([], {}), [])
    assert.deepEqual(describeTtsControls(undefined, { zephyr_bias: 3 }), [])
    assert.deepEqual(resolveTtsControlValues([], { zephyr_bias: 3 }), {})
  })

  test('a published type this build cannot draw is skipped, not fatal', () => {
    const withUnknown = [
      ...FABRICATED,
      control({ name: 'tide_curve', label: 'Tide curve', type: 'polyline', default: '0,0 1,1' }),
    ]
    assert.equal(isRenderableTtsControl(withUnknown[3]!), false)
    const fields = describeTtsControls(withUnknown, { tide_curve: '9,9' })
    assert.deepEqual(fields.map(field => field.name), ['zephyr_bias', 'lantern_mode', 'quay_directive'])
    // It is not rendered, and it is not sent either.
    assert.equal('tide_curve' in resolveTtsControlValues(withUnknown, { tide_curve: '9,9' }), false)
  })

  test('values submitted are always inside what the model published', () => {
    assert.equal(resolveTtsControlValues(FABRICATED, { zephyr_bias: 900 }).zephyr_bias, 7.5)
    assert.equal(resolveTtsControlValues(FABRICATED, { zephyr_bias: -900 }).zephyr_bias, -4)
    assert.equal(String(resolveTtsControlValues(FABRICATED, { quay_directive: 'y'.repeat(99) }).quay_directive).length, 40)
    // A wrongly-shaped value falls back to the published default rather than
    // being coerced into something the model never offered.
    assert.equal(resolveTtsControlValues(FABRICATED, { lantern_mode: 'true' }).lantern_mode, true)
    assert.equal(coerceTtsControlValue(FABRICATED[0]!, ''), undefined)
    assert.equal(coerceTtsControlValue(FABRICATED[1]!, 1), undefined)
  })

  test('changing model drops every value the new model does not publish', () => {
    const other = [control({ name: 'gantry_pitch', type: 'number', minimum: 10, maximum: 20, default: 12, step: 1 })]
    const tuned = resolveTtsControlValues(FABRICATED, { zephyr_bias: 6, lantern_mode: false })

    // The page resets to the new model's own defaults on a model change…
    assert.deepEqual(defaultTtsControlValues(other), { gantry_pitch: 12 })
    // …and even a reconciliation that keeps chosen values drops the foreign
    // ones outright rather than clamping them into the new ranges.
    assert.deepEqual(resolveTtsControlValues(other, tuned), { gantry_pitch: 12 })
    assert.deepEqual(defaultTtsControlValues([]), {})
  })

  test('a persisted map is reconciled, not resurrected', () => {
    // What a reload restores from the remembered form: values for this model,
    // plus leftovers from a model that is no longer selected.
    const persisted = { zephyr_bias: 2.5, harbour_glow: 0.9, gantry_pitch: 15 }
    const resolved = resolveTtsControlValues(FABRICATED, persisted)
    assert.equal(resolved.zephyr_bias, 2.5, 'a still-published value survives the reload')
    assert.deepEqual(Object.keys(resolved).sort(), ['lantern_mode', 'quay_directive', 'zephyr_bias'])
  })
})
