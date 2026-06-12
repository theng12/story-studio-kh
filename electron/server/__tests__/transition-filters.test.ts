import test from 'node:test'
import assert from 'node:assert/strict'
import { buildVariableXfadeFilterComplex } from '../lib/transition-filters.js'

test('buildVariableXfadeFilterComplex accumulates offsets from real clip durations', () => {
  const filter = buildVariableXfadeFilterComplex({
    inputDurations: [5.0, 3.0, 8.0],
    transitionDuration: 0.7,
    xfadeKeywords: ['fade', 'dissolve'],
  })

  assert.match(filter, /xfade=transition=fade:duration=0\.7:offset=4\.300\[m0\]/)
  assert.match(filter, /xfade=transition=dissolve:duration=0\.7:offset=6\.600\[vout\]/)
})

test('buildVariableXfadeFilterComplex rejects transitions longer than the shortest clip', () => {
  assert.throws(
    () => buildVariableXfadeFilterComplex({
      inputDurations: [5.0, 0.8, 8.0],
      transitionDuration: 1.5,
      xfadeKeywords: ['fade', 'fade'],
    }),
    /must be shorter than shortest clip/,
  )
})
