/**
 * The one measurement of "what precedes the scenes" (v1.3.1).
 *
 * Scene Plan reserves this number and the renderer composes to it. When they
 * were two independent sums they drifted, and every scene visual landed after
 * the narration it was planned against. These tests pin the shared function's
 * contract: which buckets count, what a missing probe does, and — the part
 * that actually prevents recurrence — that the input type names every bucket
 * so a new one cannot be added on one side only.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  OPENING_HEAD_ORDER,
  describeOpeningHead,
  emptyOpeningHead,
  measureOpeningSec,
  type OpeningHead,
} from '../lib/opening-duration.js'

const durations: Record<string, number> = {
  '/intro.mp4': 10,
  '/pre.mp4': 2.5,
  '/post.mp4': 1.25,
  '/title.png': 0,
  '/broken.mp4': 0,
}
const probe = async (p: string) => durations[p]

describe('opening duration', () => {
  test('nothing before the scenes measures zero', async () => {
    assert.equal(await measureOpeningSec(emptyOpeningHead(), probe), 0)
  })

  test('a lone intro reserves exactly its probed length', async () => {
    const head: OpeningHead = { ...emptyOpeningHead(), intro: { path: '/intro.mp4' } }
    assert.equal(await measureOpeningSec(head, probe), 10)
  })

  test('all four head buckets count, and tail content never reaches this function', async () => {
    // `after_scenes` / `after_outro` are not part of the type at all — that is
    // the guarantee. A caller cannot accidentally inflate the opening with
    // tail clips, because there is nowhere to put them.
    assert.deepEqual([...OPENING_HEAD_ORDER], ['before_intro', 'intro', 'title', 'after_intro'])
    const head: OpeningHead = {
      before_intro: [{ path: '/pre.mp4' }],
      intro: { path: '/intro.mp4' },
      title: { duration_sec: 5 },
      after_intro: [{ path: '/post.mp4' }],
    }
    assert.equal(await measureOpeningSec(head, probe), 18.75)
  })

  test('a known duration is trusted over the probe, so still cards need no file', async () => {
    const head: OpeningHead = { ...emptyOpeningHead(), title: { path: '/title.png', duration_sec: 7 } }
    assert.equal(await measureOpeningSec(head, probe), 7)
  })

  test('an unprobeable clip contributes its fallback, or nothing at all', async () => {
    // The renderer has always fallen back to 5s for an intro whose duration it
    // could not read; the plan has no such fallback, because reserving time for
    // a file it could not measure is how a plan and a render disagree.
    const rendererStyle: OpeningHead = { ...emptyOpeningHead(), intro: { path: '/broken.mp4', fallback_sec: 5 } }
    assert.equal(await measureOpeningSec(rendererStyle, probe), 5)
    const planStyle: OpeningHead = { ...emptyOpeningHead(), intro: { path: '/broken.mp4' } }
    assert.equal(await measureOpeningSec(planStyle, probe), 0)
  })

  test('a probe that throws is not fatal', async () => {
    const angry = async () => { throw new Error('ffprobe exploded') }
    const head: OpeningHead = { ...emptyOpeningHead(), intro: { path: '/intro.mp4', fallback_sec: 4 } }
    assert.equal(await measureOpeningSec(head, angry), 4)
  })

  test('the total is rounded to the millisecond so plan and render compare equal', async () => {
    const thirds = async () => 1 / 3
    const head: OpeningHead = {
      before_intro: [{ path: '/a' }, { path: '/b' }],
      intro: { path: '/c' },
      title: null,
      after_intro: [],
    }
    assert.equal(await measureOpeningSec(head, thirds), 1)
  })

  test('the breakdown names the parts, and says nothing when there are none', async () => {
    const head: OpeningHead = {
      before_intro: [{ path: '/pre.mp4', label: 'before_intro clip' }],
      intro: { path: '/intro.mp4', label: 'intro' },
      title: null,
      after_intro: [],
    }
    assert.equal(await describeOpeningHead(head, probe), 'before_intro clip 2.50s + intro 10.00s')
    assert.equal(await describeOpeningHead(emptyOpeningHead(), probe), '')
  })
})
