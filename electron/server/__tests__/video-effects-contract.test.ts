import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLetterboxFilter, computeVignetteAngle } from '../generators/video.js'

test('vignette strength grows from a mild corner angle toward a strong one', () => {
  const weak = computeVignetteAngle(0)
  const medium = computeVignetteAngle(0.5)
  const strong = computeVignetteAngle(1)
  assert.ok(weak < medium && medium < strong)
  assert.ok(strong < Math.PI / 2, 'center-preserving range stays below the extreme lens angle')
})

test('letterbox draws bars without scaling or cropping the picture', () => {
  const filter = buildLetterboxFilter('[in]', '[out]', 1920, 1080, '2.35:1', 'black')
  assert.ok(filter)
  assert.match(filter!, /drawbox=x=0:y=0:w=iw:h=132/)
  assert.match(filter!, /drawbox=x=0:y=ih-132:w=iw:h=132/)
  assert.doesNotMatch(filter!, /scale=|crop=|pad=/)
})
