import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAgedArchiveFilmFilters, buildLetterboxFilter, computeVignetteAngle } from '../lib/video-effects.js'

test('vignette strength grows from a mild corner angle toward a strong one', () => {
  const weak = computeVignetteAngle(0)
  const medium = computeVignetteAngle(0.5)
  const strong = computeVignetteAngle(1)
  assert.ok(weak < medium && medium < strong)
  assert.ok(strong < Math.PI / 2, 'center-preserving range stays below the extreme lens angle')
})

test('letterbox (default fit) shrinks the whole picture between the bars and keeps the frame size', () => {
  const filter = buildLetterboxFilter('[in]', '[out]', 1920, 1080, '2.35:1', 'black')
  // 1080 - 2 × 132 = 816 high; 1920 × 816 / 1080 = 1450.67 → 1450 wide, side bars of 235.
  assert.equal(filter, '[in]scale=1450:816,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[out]')
  assert.doesNotMatch(filter!, /crop=|drawbox=/)
})

test('letterbox in cover mode draws bars over the picture, the look before 1.4.282', () => {
  const filter = buildLetterboxFilter('[in]', '[out]', 1920, 1080, '2.35:1', 'black', 'cover')
  assert.ok(filter)
  assert.match(filter!, /drawbox=x=0:y=0:w=iw:h=132/)
  assert.match(filter!, /drawbox=x=0:y=ih-132:w=iw:h=132/)
  assert.doesNotMatch(filter!, /scale=|crop=|pad=/)
})

test('aged archive film is an asset-free, gated treatment with dust, scratches, flicker, and gate weave', () => {
  const filters = buildAgedArchiveFilmFilters({
    input: '[in]', output: '[out]', grade: '[grade]', noise: '[noise]', marked: '[marked]',
    base: '[base]', weave: '[weave]', shifted: '[shifted]', width: 1920, height: 1080,
    strength: 45, gateSuffix: ":enable='between(t,2.00,12.00)'",
  }).join(';')
  assert.match(filters, /brightness='0\.014\*sin\(2\*PI\*t\*8\)'/)
  assert.match(filters, /noise=alls=13:allf=t\+u/)
  assert.match(filters, /drawbox=.*drawbox=.*drawbox=/)
  assert.match(filters, /split=2\[base\]\[weave\]/)
  assert.match(filters, /crop=w=iw-18:h=ih-18/)
  assert.match(filters, /overlay=0:0:enable='between\(t,2\.00,12\.00\)'/)
})
