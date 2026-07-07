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

// v1.0.521 — the plan-strict anchored-xfade contract: when each input is the
// scene's planned WINDOW extended by the transition duration T (the tail the
// prepared clips physically carry), the accumulated offsets land exactly at
// the cumulative window starts — so every dissolve begins on a Scene Plan
// boundary and no scene's on-screen time is shortened.
//   windows D = [2.5, 6.0, 4.25], T = 0.5 → inputs d_i = D_i + T
//   offset_0 = d_0 − T = D_0            = 2.5
//   offset_1 = (d_0 + d_1 − T) − T = D_0 + D_1 = 8.5
test('plan-strict: window+T inputs anchor offsets at cumulative window starts', () => {
  const windows = [2.5, 6.0, 4.25]
  const T = 0.5
  const filter = buildVariableXfadeFilterComplex({
    inputDurations: windows.map(d => d + T),
    transitionDuration: T,
    xfadeKeywords: ['fade', 'fade'],
  })
  assert.match(filter, /xfade=transition=fade:duration=0\.5:offset=2\.500\[m0\]/)
  assert.match(filter, /xfade=transition=fade:duration=0\.5:offset=8\.500\[vout\]/)
})
