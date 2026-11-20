import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeResumeRedraws } from '../generators/continuity-render.js'

// A finished scene drawn again is the defect Production is living with; the verdict line is the only
// durable record of WHY, because the process dies mid-batch and takes its in-memory log with it.
test('names every reason a finished scene is drawn again, and says when it is silent', () => {
  assert.equal(describeResumeRedraws([]), null)
  assert.equal(
    describeResumeRedraws(['Scene 63: image was rendered from an outdated prompt']),
    'Resume verdict, before any paid work: 1 finished scene(s) will be drawn again — ' +
    'Scene 63: image was rendered from an outdated prompt',
  )
})

test('caps the list at ten and counts the rest instead of printing a wall of lines', () => {
  const reasons = Array.from({ length: 13 }, (_, i) => `Scene ${i + 1}: does not decode (0 MB)`)
  const line = describeResumeRedraws(reasons)
  assert.ok(line)
  assert.match(line, /13 finished scene\(s\) will be drawn again/)
  assert.match(line, /Scene 10: does not decode/)
  assert.doesNotMatch(line, /Scene 11:/)
  assert.match(line, /; and 3 more$/)
})

test('a resume keeps finished images however the batch selected them; only a deliberate re-render redraws', async () => {
  const { resumeSkipsFinishedImages } = await import('../generators/continuity-render.js')
  // The two Production cases: an exhausted episode and one still advancing. Both must stop redoing.
  assert.equal(resumeSkipsFinishedImages({ force: false, singleIndex: 0 }), true)
  assert.equal(resumeSkipsFinishedImages({ force: false, singleIndex: 0 }), true)
  // A person pressing Generate on selected scenes, or one scene re-rolled, still draws over them.
  assert.equal(resumeSkipsFinishedImages({ force: true, singleIndex: 0 }), false)
  assert.equal(resumeSkipsFinishedImages({ force: false, singleIndex: 5 }), false)
})
