/**
 * The Jobs page's 1 s clock and 5 s queue poll must stop while the window is hidden and catch up when
 * it is shown again. What this cannot catch: that jobs.vue wires them (pinned by the source check).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mock, test } from 'node:test'
import { createVisibleInterval } from '../composables/useVisibleInterval.js'

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

test('ticks while visible, stops while hidden, resumes with an immediate catch-up', () => {
  mock.timers.enable({ apis: ['setInterval'] })
  setVisibility('visible')
  let ticks = 0
  let resumes = 0
  const interval = createVisibleInterval(() => { ticks++ }, 1000, () => { resumes++ })
  try {
    interval.start()
    mock.timers.tick(3000)
    assert.equal(ticks, 3)
    setVisibility('hidden')
    mock.timers.tick(60_000)
    assert.equal(ticks, 3, 'no ticks while hidden')
    setVisibility('visible')
    assert.equal(resumes, 1, 'catches up at once when shown')
    mock.timers.tick(2000)
    assert.equal(ticks, 5)
  } finally {
    interval.stop()
    mock.timers.reset()
    setVisibility('visible')
  }
})

test('starting while hidden arms nothing until shown, and stop() leaves no listener behind', () => {
  mock.timers.enable({ apis: ['setInterval'] })
  setVisibility('hidden')
  let ticks = 0
  const interval = createVisibleInterval(() => { ticks++ }, 1000)
  try {
    interval.start()
    mock.timers.tick(5000)
    assert.equal(ticks, 0)
    interval.stop()
    setVisibility('visible')
    mock.timers.tick(5000)
    assert.equal(ticks, 0, 'a stopped interval never restarts')
  } finally {
    mock.timers.reset()
  }
})

test('the Jobs page uses it for its clock and queue poll', () => {
  const source = readFileSync(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url), 'utf8')
  assert.match(source, /createVisibleInterval\(\(\) => \{ now\.value = Date\.now\(\) \}, 1000\)/)
  assert.match(source, /createVisibleInterval\(\(\) => \{ void checkQueuePaused\(\) \}, 5000\)/)
  assert.doesNotMatch(source, /setInterval\(\(\) => now\.value/)
})
